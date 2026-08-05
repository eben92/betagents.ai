/**
 * Application-managed wake-ups.
 *
 * One eve schedule ticks every minute and asks this module whether anything is
 * due. The answer is almost always no, and answering it costs nothing: the next
 * due time is cached in memory and only re-read from the spreadsheet when it
 * passes or goes stale. That is what keeps a minute-resolution scheduler from
 * turning into minute-resolution polling.
 */

import { newId } from "./ids";
import { createLogger } from "./logger";
import { getStore, TAB, type WakeupRecord } from "./sheets";

const log = createLogger("wakeups");

/** How long a cached "nothing due until" answer is trusted. */
const CACHE_TTL_MS = 10 * 60 * 1000;

let nextDue: Date | null = null;
let cachedAt = 0;

export type WakeupKind =
  | "daily"
  | "draft_review"
  | "pre_match"
  | "monitor"
  | "reconcile"
  | "opportunity"
  | "manual";

/**
 * Schedules a wake-up. Repeated calls for the same kind and minute collapse
 * into one row, so a cycle that re-derives its plan does not accumulate work.
 */
export async function schedule(input: {
  kind: WakeupKind;
  dueAt: Date;
  reason: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const store = await getStore();
  const dueAtIso = input.dueAt.toISOString();
  const minuteBucket = dueAtIso.slice(0, 16);

  const existing = (await store.list(TAB.wakeups)).find(
    (entry) =>
      entry.status === "pending" &&
      entry.kind === input.kind &&
      entry.dueAt.slice(0, 16) === minuteBucket,
  );
  if (existing) return;

  const record: WakeupRecord = {
    id: newId("wak"),
    createdAt: new Date().toISOString(),
    dueAt: dueAtIso,
    kind: input.kind,
    reason: input.reason,
    payload: input.payload ?? {},
    status: "pending",
    leaseUntil: "",
    attempts: 0,
  };

  await store.append(TAB.wakeups, record);

  if (!nextDue || input.dueAt < nextDue) {
    nextDue = input.dueAt;
    cachedAt = Date.now();
  }
  log.debug("wake-up scheduled", { kind: input.kind, dueAt: dueAtIso, reason: input.reason });
}

/**
 * Cheap check for the minute tick. Returns false without any network call when
 * the cached next-due time is still in the future.
 */
export async function anythingDue(now = new Date()): Promise<boolean> {
  const cacheFresh = Date.now() - cachedAt < CACHE_TTL_MS;
  if (cacheFresh && nextDue && now < nextDue) return false;

  const store = await getStore();
  const pending = (await store.list(TAB.wakeups)).filter((entry) => entry.status === "pending");

  cachedAt = Date.now();
  if (pending.length === 0) {
    nextDue = null;
    return false;
  }

  const soonest = pending
    .map((entry) => new Date(entry.dueAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  nextDue = soonest ?? null;
  return Boolean(soonest && soonest <= now);
}

/** Claims every due wake-up under a lease, so a crash releases them. */
export async function claimDue(now = new Date(), leaseMs = 15 * 60_000): Promise<WakeupRecord[]> {
  const store = await getStore();
  const rows = await store.list(TAB.wakeups);

  const due = rows.filter((entry) => {
    if (entry.status === "done" || entry.status === "failed") return false;
    if (new Date(entry.dueAt) > now) return false;
    if (entry.status === "claimed") {
      const lease = new Date(entry.leaseUntil).getTime();
      return !Number.isFinite(lease) || lease < now.getTime();
    }
    return true;
  });

  const claimed: WakeupRecord[] = [];
  for (const entry of due) {
    const updated = await store.update(TAB.wakeups, entry.id, {
      status: "claimed",
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      attempts: entry.attempts + 1,
    });
    if (updated) claimed.push(updated);
  }

  // Force the next `anythingDue` to re-read.
  cachedAt = 0;
  return claimed;
}

export async function complete(ids: string[], status: "done" | "failed" = "done"): Promise<void> {
  if (ids.length === 0) return;
  const store = await getStore();
  for (const id of ids) {
    await store.update(TAB.wakeups, id, { status, leaseUntil: "" });
  }
  cachedAt = 0;
}

/** Drops resolved wake-ups so the tab does not grow without bound. */
export async function prune(keep = 200): Promise<void> {
  const store = await getStore();
  const rows = await store.list(TAB.wakeups);
  const resolved = rows.filter((entry) => entry.status === "done" || entry.status === "failed");
  if (resolved.length <= keep) return;

  const pending = rows.filter((entry) => entry.status !== "done" && entry.status !== "failed");
  const recent = resolved.sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(-keep);
  await store.replaceAll(TAB.wakeups, [...pending, ...recent]);
  cachedAt = 0;
}

export async function pendingWakeups(): Promise<WakeupRecord[]> {
  const store = await getStore();
  return (await store.list(TAB.wakeups))
    .filter((entry) => entry.status === "pending" || entry.status === "claimed")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/**
 * Books an immediate wake-up when the schedule is completely empty.
 *
 * Without this a fresh deployment would tick forever with nothing to do, since
 * every wake-up is created by a previous cycle.
 */
export async function ensureSeeded(): Promise<boolean> {
  const pending = await pendingWakeups();
  if (pending.length > 0) return false;
  await schedule({ kind: "opportunity", dueAt: new Date(), reason: "first run after start-up" });
  log.info("scheduler seeded with an initial wake-up");
  return true;
}

/** Clears the in-memory cache. Used by tests and after a manual change. */
export function invalidateCache(): void {
  nextDue = null;
  cachedAt = 0;
}
