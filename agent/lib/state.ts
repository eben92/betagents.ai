/**
 * System state held in the `system_state` tab.
 *
 * This is the small amount of information that has to survive a restart:
 * whether the system is running, how much profit is locked away, where the
 * betting day started, and who currently holds the cycle lock.
 */

import { getStore, TAB } from "./sheets";
import { createLogger } from "./logger";

const log = createLogger("state");

export type SystemStatus = "running" | "paused" | "stopped";

const KEYS = {
  status: "status",
  lockedProfit: "locked_profit",
  dayKey: "day_key",
  dayStartBankroll: "day_start_bankroll",
  lossStreak: "loss_streak",
  lastDailyRun: "last_daily_run",
  lastCycleAt: "last_cycle_at",
  cycleLockUntil: "cycle_lock_until",
  cycleLockOwner: "cycle_lock_owner",
  haltReason: "halt_reason",
} as const;

async function read(key: string): Promise<string | null> {
  const store = await getStore();
  return store.getValue(TAB.state, key);
}

async function write(key: string, value: string): Promise<void> {
  const store = await getStore();
  await store.setValue(TAB.state, key, value);
}

async function readNumber(key: string, fallback: number): Promise<number> {
  const raw = await read(key);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export async function getStatus(): Promise<SystemStatus> {
  const raw = (await read(KEYS.status)) as SystemStatus | null;
  return raw === "paused" || raw === "stopped" ? raw : "running";
}

export async function setStatus(status: SystemStatus): Promise<void> {
  await write(KEYS.status, status);
  log.info("system status changed", { status });
}

export function getLockedProfit(): Promise<number> {
  return readNumber(KEYS.lockedProfit, 0);
}

export async function setLockedProfit(value: number): Promise<void> {
  await write(KEYS.lockedProfit, String(Math.max(0, value)));
}

export async function getDayKey(): Promise<string | null> {
  return read(KEYS.dayKey);
}

export function getDayStartBankroll(): Promise<number> {
  return readNumber(KEYS.dayStartBankroll, 0);
}

/** Records the start of a new betting day and resets the daily guards. */
export async function startDay(dayKey: string, bankroll: number): Promise<void> {
  await write(KEYS.dayKey, dayKey);
  await write(KEYS.dayStartBankroll, String(bankroll));
  await write(KEYS.lossStreak, "0");
  await write(KEYS.haltReason, "");
  log.info("betting day started", { dayKey, bankroll });
}

export function getLossStreak(): Promise<number> {
  return readNumber(KEYS.lossStreak, 0);
}

export async function recordSettlementStreak(won: boolean): Promise<number> {
  const next = won ? 0 : (await getLossStreak()) + 1;
  await write(KEYS.lossStreak, String(next));
  return next;
}

export async function getHaltReason(): Promise<string | null> {
  const raw = await read(KEYS.haltReason);
  return raw && raw.trim() ? raw : null;
}

export async function setHaltReason(reason: string | null): Promise<void> {
  await write(KEYS.haltReason, reason ?? "");
}

export async function getLastDailyRun(): Promise<string | null> {
  return read(KEYS.lastDailyRun);
}

export async function setLastDailyRun(iso: string): Promise<void> {
  await write(KEYS.lastDailyRun, iso);
}

export async function getLastCycleAt(): Promise<string | null> {
  return read(KEYS.lastCycleAt);
}

export async function setLastCycleAt(iso: string): Promise<void> {
  await write(KEYS.lastCycleAt, iso);
}

/**
 * In-process holder of the cycle lock.
 *
 * The persisted lease alone is not enough: reading it and writing it are two
 * awaits, so two cycles started in the same process can both observe a free
 * lock. This flag is checked and set in one synchronous step, which makes that
 * interleaving impossible. The persisted lease then covers the other case — a
 * process that died holding the lock — by expiring on its own.
 */
let localHolder: string | null = null;

/**
 * Leased cycle lock. A crashed cycle releases automatically when its lease
 * expires, so the system recovers without manual cleanup.
 */
export async function acquireCycleLock(owner: string, leaseMs: number): Promise<boolean> {
  // Synchronous claim: no await may appear between the check and the set.
  if (localHolder !== null && localHolder !== owner) {
    log.debug("cycle lock held by another run in this process", { holder: localHolder });
    return false;
  }
  localHolder = owner;

  try {
    const until = await read(KEYS.cycleLockUntil);
    if (until) {
      const expiry = new Date(until).getTime();
      const holder = await read(KEYS.cycleLockOwner);
      if (Number.isFinite(expiry) && expiry > Date.now() && holder !== owner) {
        log.debug("cycle lock held by another run", { holder, until });
        localHolder = null;
        return false;
      }
    }
    await write(KEYS.cycleLockUntil, new Date(Date.now() + leaseMs).toISOString());
    await write(KEYS.cycleLockOwner, owner);
    return true;
  } catch (error) {
    localHolder = null;
    throw error;
  }
}

export async function releaseCycleLock(owner: string): Promise<void> {
  if (localHolder === owner) localHolder = null;
  const holder = await read(KEYS.cycleLockOwner);
  if (holder && holder !== owner) return;
  await write(KEYS.cycleLockUntil, "");
  await write(KEYS.cycleLockOwner, "");
}

/** Clears the in-process lock. Used by tests between runs. */
export function resetCycleLock(): void {
  localHolder = null;
}
