/**
 * The betting cycle: its identity, its passes, and everything it declined.
 *
 * A cycle used to be an idea in the orchestrator's head. It is a record here
 * instead, for three reasons.
 *
 * **A cycle that backs nothing must be able to try again.** One sweep over a
 * handful of fixtures finding nothing is not evidence that today has nothing —
 * it is evidence about those fixtures. So a cycle runs in passes: each pass
 * looks at matches the earlier passes did not, and the cycle only gives up when
 * it runs out of passes or out of fixtures.
 *
 * **Every rejection has to survive.** Most of what this system does is decline
 * things, and the reason lived only in a model's final message, which nothing
 * kept. Recording rejections is what lets the operator be told why each game was
 * passed over, and what stops the next pass re-examining the same match.
 *
 * **The report has to be assembled from records, not narrated.** A digest built
 * here is organised the same way every time, however verbose the model felt.
 */

import { snapshot } from "./bankroll";
import { getConfig, usesRealFixtureSource, type Sport } from "./config";
import { newId } from "./ids";
import { createLogger, errorMessage } from "./logger";
import { formatMoney } from "./money";
import {
  getStore,
  OPEN_BET_STATUSES,
  TAB,
  type BetRecord,
  type DraftRecord,
  type RejectionRecord,
  type RejectionStage,
} from "./sheets";
import { listFixtures, operatorCardIsFresh } from "./sports";
import { getStatus } from "./state";
import { formatInZone, isoNow, minutesBetween, parseIso } from "./time";

const log = createLogger("cycle");

/** Key in `system_state` holding the JSON cycle record. */
const CYCLE_KEY = "cycle";

/**
 * How long an unclosed cycle stays resumable. Past this, a wake-up starts a
 * fresh one rather than inheriting passes from a run that died hours ago.
 */
const RESUME_WINDOW_MINUTES = 6 * 60;

export interface CycleState {
  id: string;
  trigger: string;
  startedAt: string;
  updatedAt: string;
  /** 1-based. Incremented by `advancePass`. */
  pass: number;
  /** Empty while the cycle is open. */
  closedAt: string;
  closeReason: string;
}

export interface RejectionInput {
  stage: RejectionStage;
  matchKey: string;
  matchName: string;
  sport: string;
  startsAt?: string;
  market?: string;
  selection?: string;
  odds?: number;
  code: string;
  reason: string;
  /** True when a different price, market or moment could still make this a bet. */
  fixable?: boolean;
}

async function readCycle(): Promise<CycleState | null> {
  const store = await getStore();
  const raw = await store.getValue(TAB.state, CYCLE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CycleState>;
    if (!parsed.id) return null;
    return {
      id: parsed.id,
      trigger: parsed.trigger ?? "",
      startedAt: parsed.startedAt ?? "",
      updatedAt: parsed.updatedAt ?? parsed.startedAt ?? "",
      pass: Number(parsed.pass) || 1,
      closedAt: parsed.closedAt ?? "",
      closeReason: parsed.closeReason ?? "",
    };
  } catch {
    return null;
  }
}

async function writeCycle(state: CycleState): Promise<void> {
  const store = await getStore();
  await store.setValue(TAB.state, CYCLE_KEY, JSON.stringify(state));
}

/** The open cycle, or null when the last one closed. */
export async function currentCycle(): Promise<CycleState | null> {
  const state = await readCycle();
  if (!state || state.closedAt) return null;
  return state;
}

/**
 * The id every record written during this cycle is stamped with. Empty outside
 * a cycle — a Telegram conversation is not a cycle, and its records should not
 * be attributed to one.
 */
export async function currentCycleId(): Promise<string> {
  try {
    return (await currentCycle())?.id ?? "";
  } catch (error) {
    log.debug("could not read the current cycle", { error: errorMessage(error) });
    return "";
  }
}

export async function currentPass(): Promise<number> {
  return (await currentCycle())?.pass ?? 1;
}

/**
 * Starts a cycle, or resumes the one already running.
 *
 * Resuming matters after a crash or a restart: the pass count and everything
 * already examined survive, so recovery continues the cycle instead of
 * restarting it and re-researching the same matches.
 */
export async function beginCycle(trigger: string): Promise<{ cycle: CycleState; resumed: boolean }> {
  const existing = await currentCycle();
  if (existing) {
    const startedAt = parseIso(existing.startedAt);
    const fresh = startedAt !== null && minutesBetween(startedAt, new Date()) < RESUME_WINDOW_MINUTES;
    if (fresh) {
      const resumed = { ...existing, updatedAt: isoNow() };
      await writeCycle(resumed);
      return { cycle: resumed, resumed: true };
    }
    await closeCycle("superseded by a new cycle");
  }

  const now = isoNow();
  const cycle: CycleState = {
    id: newId("cyc"),
    trigger,
    startedAt: now,
    updatedAt: now,
    pass: 1,
    closedAt: "",
    closeReason: "",
  };
  await writeCycle(cycle);
  log.info("cycle started", { cycleId: cycle.id, trigger });
  return { cycle, resumed: false };
}

export async function advancePass(): Promise<CycleState | null> {
  const cycle = await currentCycle();
  if (!cycle) return null;
  const next: CycleState = { ...cycle, pass: cycle.pass + 1, updatedAt: isoNow() };
  await writeCycle(next);
  log.info("cycle advanced to a new pass", { cycleId: next.id, pass: next.pass });
  return next;
}

export async function closeCycle(reason: string): Promise<CycleState | null> {
  const state = await readCycle();
  if (!state || state.closedAt) return null;
  const closed: CycleState = { ...state, closedAt: isoNow(), updatedAt: isoNow(), closeReason: reason };
  await writeCycle(closed);
  log.info("cycle closed", { cycleId: closed.id, pass: closed.pass, reason });
  return closed;
}

/** One rejection per stage per selection: a re-decision replaces the old reason. */
function subjectKey(input: RejectionInput, cycleId: string): string {
  return [cycleId, input.stage, input.matchKey, input.market ?? "", input.selection ?? ""].join("|");
}

/**
 * Records one declined match or selection.
 *
 * Never throws. A rejection that cannot be written is a lost line in a report;
 * a rejection that throws would abort the agent that was doing the right thing
 * by declining.
 */
export async function recordRejection(input: RejectionInput): Promise<void> {
  try {
    const cycle = await currentCycle();
    const cycleId = cycle?.id ?? "";
    const store = await getStore();

    const patch = {
      pass: cycle?.pass ?? 0,
      createdAt: isoNow(),
      startsAt: input.startsAt ?? "",
      odds: input.odds ?? 0,
      code: input.code,
      reason: input.reason.slice(0, 600),
      fixable: input.fixable ?? false,
      active: true,
    };

    // `appendUnique` is the only write that is atomic against a concurrent one:
    // it runs inside the store's write queue and bypasses the read cache. Doing
    // this as list-then-append instead lets two candidates declined in the same
    // moment both append, and the report names the match twice.
    const written = await store.appendUnique(TAB.rejections, {
      id: newId("rej"),
      subject: subjectKey(input, cycleId),
      cycleId,
      stage: input.stage,
      matchKey: input.matchKey,
      matchName: input.matchName,
      sport: input.sport,
      market: input.market ?? "",
      selection: input.selection ?? "",
      ...patch,
    });

    // Already declined for a different reason, or declined again after being
    // reconsidered: the latest reason is the true one.
    if (!written.created) {
      await store.update(TAB.rejections, written.record.id, patch);
    }
  } catch (error) {
    log.warn("could not record a rejection", {
      stage: input.stage,
      matchKey: input.matchKey,
      error: errorMessage(error),
    });
  }
}

/**
 * Retires the rejections on a match that has since been backed, so the report
 * cannot list the same game as both declined and drafted.
 */
export async function clearRejections(matchKey: string): Promise<void> {
  try {
    const store = await getStore();
    const stale = (await store.list(TAB.rejections)).filter(
      (record) => record.matchKey === matchKey && record.active,
    );
    for (const record of stale) {
      await store.update(TAB.rejections, record.id, { active: false });
    }
  } catch (error) {
    log.warn("could not clear rejections", { matchKey, error: errorMessage(error) });
  }
}

export async function cycleRejections(cycleId: string): Promise<RejectionRecord[]> {
  const store = await getStore();
  const all = (await store.list(TAB.rejections)).filter((entry) => entry.active);
  return cycleId ? all.filter((entry) => entry.cycleId === cycleId) : all;
}

/** Matches this cycle has already assessed, in any pass and at any stage. */
export async function coveredMatchKeys(cycleId: string): Promise<string[]> {
  if (!cycleId) return [];
  const store = await getStore();
  const [research, rejections] = await Promise.all([
    store.list(TAB.research),
    cycleRejections(cycleId),
  ]);

  const keys = new Set<string>();
  for (const entry of research) if (entry.cycleId === cycleId) keys.add(entry.matchKey);
  for (const entry of rejections) if (entry.matchKey) keys.add(entry.matchKey);
  return [...keys];
}

export interface CycleOutcome {
  placed: BetRecord[];
  awaitingExecution: number;
  liveDrafts: DraftRecord[];
}

/**
 * What this cycle actually produced.
 *
 * Bets carry no cycle of their own; they are reached through the approval and
 * the draft that authorised them, which is the only chain that cannot
 * mis-attribute a bet placed by a different cycle on the same day.
 */
export async function cycleOutcome(cycleId: string): Promise<CycleOutcome> {
  const store = await getStore();
  const [drafts, approvals, bets] = await Promise.all([
    store.list(TAB.drafts),
    store.list(TAB.approved),
    store.list(TAB.bets),
  ]);

  const mine = drafts.filter((draft) => draft.cycleId === cycleId);
  const myDraftIds = new Set(mine.map((draft) => draft.id));
  const myApprovals = approvals.filter((entry) => myDraftIds.has(entry.draftId));
  const myApprovalIds = new Set(myApprovals.map((entry) => entry.id));

  return {
    placed: bets.filter(
      (bet) => myApprovalIds.has(bet.approvedId) && (bet.status === "placed" || bet.status === "settled"),
    ),
    awaitingExecution: myApprovals.filter((entry) => entry.status === "ready").length,
    liveDrafts: mine.filter((draft) => draft.status === "pending" || draft.status === "approved"),
  };
}

export interface PassDecision {
  cycleId: string;
  pass: number;
  maxPasses: number;
  placed: number;
  awaitingExecution: number;
  liveDrafts: number;
  rejectedThisPass: number;
  /** Fixtures still on the card that no pass of this cycle has looked at. */
  fixturesUnexamined: number;
  retry: boolean;
  reason: string;
  /** Pass these to `list_fixtures` so the next pass sees different matches. */
  excludeMatchKeys: string[];
}

/** Fixtures across the configured sports that this cycle has not yet assessed. */
async function unexaminedFixtures(covered: Set<string>): Promise<number> {
  const config = getConfig();
  const now = new Date();
  const window = {
    from: new Date(now.getTime() + config.strategy.minMinutesToKickoff * 60_000),
    to: new Date(now.getTime() + 36 * 60 * 60 * 1000),
  };

  const counts = await Promise.all(
    config.strategy.sports.map(async (sport: Sport) => {
      try {
        const fixtures = await listFixtures(sport, window);
        return fixtures.filter(
          (fixture) => fixture.status === "scheduled" && !covered.has(fixture.matchKey),
        ).length;
      } catch (error) {
        log.warn("could not count remaining fixtures", { sport, error: errorMessage(error) });
        return 0;
      }
    }),
  );

  return counts.reduce((total, count) => total + count, 0);
}

/**
 * Whether this cycle should sweep again over fixtures it has not yet seen.
 *
 * The whole point is that "nothing worth backing" is a statement about the
 * matches examined, not about the day. But retrying is only honest when there
 * is something new to look at and nothing already in flight, so every one of
 * these conditions is a reason to stop instead.
 */
export async function decidePass(): Promise<PassDecision> {
  const config = getConfig();
  const cycle = await currentCycle();

  if (!cycle) {
    return {
      cycleId: "",
      pass: 0,
      maxPasses: config.maxCyclePasses,
      placed: 0,
      awaitingExecution: 0,
      liveDrafts: 0,
      rejectedThisPass: 0,
      fixturesUnexamined: 0,
      retry: false,
      reason: "no cycle is open; call begin_cycle at the start of a cycle",
      excludeMatchKeys: [],
    };
  }

  const [outcome, rejections, covered, status, bankroll] = await Promise.all([
    cycleOutcome(cycle.id),
    cycleRejections(cycle.id),
    coveredMatchKeys(cycle.id),
    getStatus(),
    latestBankroll(),
  ]);

  const rejectedThisPass = rejections.filter((entry) => entry.pass === cycle.pass).length;
  const coveredSet = new Set(covered);

  const base = {
    cycleId: cycle.id,
    pass: cycle.pass,
    maxPasses: config.maxCyclePasses,
    placed: outcome.placed.length,
    awaitingExecution: outcome.awaitingExecution,
    liveDrafts: outcome.liveDrafts.length,
    rejectedThisPass,
    excludeMatchKeys: covered,
  };

  const stop = (reason: string): PassDecision => ({
    ...base,
    fixturesUnexamined: 0,
    retry: false,
    reason,
  });

  if (status !== "running") return stop(`the system is ${status}`);
  if (bankroll?.halted) return stop(bankroll.haltReason ?? "trading is halted");
  if (outcome.placed.length > 0) return stop(`${outcome.placed.length} bet(s) placed this cycle`);
  if (outcome.liveDrafts.length > 0 || outcome.awaitingExecution > 0) {
    return stop("work is already in flight: a draft is live or an approval is waiting to execute");
  }
  if (cycle.pass >= config.maxCyclePasses) {
    return stop(`all ${config.maxCyclePasses} passes are used; nothing was worth backing`);
  }

  // Another sweep cannot help when there is nothing to sweep. A configured
  // catalogue that has not been read means the card step failed — blocked,
  // unreachable, or never run — and repeating research four more times against
  // an empty fixture list burns the cycle's passes to reach the same place.
  if (usesRealFixtureSource() && !(await operatorCardIsFresh())) {
    return stop(
      "the fixture card has not been read, so there is nothing to research. Send the execution agent to read it, or report the blocker — more passes cannot help",
    );
  }

  const fixturesUnexamined = await unexaminedFixtures(coveredSet);
  if (fixturesUnexamined === 0) {
    return { ...stop("every fixture on the card has been assessed"), fixturesUnexamined: 0 };
  }

  return {
    ...base,
    fixturesUnexamined,
    retry: true,
    reason: `nothing was backed and ${fixturesUnexamined} fixture(s) have not been assessed yet`,
  };
}

async function latestBankroll() {
  try {
    const store = await getStore();
    const latest = (await store.list(TAB.balances)).at(-1);
    return latest ? await snapshot(latest.balance) : null;
  } catch (error) {
    log.debug("could not read the bankroll", { error: errorMessage(error) });
    return null;
  }
}

const STAGE_LABEL: Record<RejectionStage, string> = {
  research: "Research",
  planner: "Planner",
  reviewer: "Reviewer",
  execution: "Execution",
};

/** Stages in the order a candidate travels through them. */
const STAGE_ORDER: RejectionStage[] = ["research", "planner", "reviewer", "execution"];

function selectionLabel(entry: { market: string; selection: string; odds: number }): string {
  if (!entry.market && !entry.selection) return "";
  const price = entry.odds > 1 ? ` @ ${entry.odds}` : "";
  return ` — ${entry.market}/${entry.selection}${price}`;
}

export interface CycleReport {
  title: string;
  lines: string[];
  placed: number;
  rejected: number;
}

/**
 * The cycle's Telegram digest, built from records rather than written by a
 * model: one section per outcome, rejections grouped by the agent that made
 * them, and every game named with its reason.
 */
export async function buildCycleReport(cycleId: string): Promise<CycleReport> {
  const config = getConfig();
  const zone = config.strategy.timezone;
  const currency = config.strategy.currency;

  const store = await getStore();
  const [cycle, outcome, rejections, bankroll, bets] = await Promise.all([
    readCycle(),
    cycleOutcome(cycleId),
    cycleRejections(cycleId),
    latestBankroll(),
    store.list(TAB.bets),
  ]);

  const at = (iso: string): string => {
    const date = parseIso(iso);
    return date ? formatInZone(date, zone) : "";
  };

  const lines: string[] = [];
  const passes = cycle?.pass ?? 1;
  lines.push(`Pass ${passes} of ${config.maxCyclePasses} · ${cycle?.trigger || "cycle"} · ${config.mode} mode`);

  if (outcome.placed.length > 0) {
    lines.push("", `PLACED (${outcome.placed.length})`);
    for (const bet of outcome.placed) {
      lines.push(`• ${bet.matchName} — ${bet.market}/${bet.selection} @ ${bet.odds}`);
      lines.push(
        `  ${formatMoney(bet.stake, currency)} to return ${formatMoney(bet.potentialReturn, currency)} · starts ${at(bet.startsAt)}`,
      );
    }
  }

  if (outcome.liveDrafts.length > 0) {
    lines.push("", `WAITING FOR KICKOFF (${outcome.liveDrafts.length})`);
    for (const draft of outcome.liveDrafts) {
      lines.push(`• ${draft.matchName} — ${draft.market}/${draft.selection} @ ${draft.odds}`);
      lines.push(
        `  ${formatMoney(draft.stake, currency)} · reviewed and placed from ${at(draft.executeAfter)}`,
      );
    }
  }

  if (rejections.length > 0) {
    lines.push("", `NOT BACKED (${rejections.length})`);
    for (const stage of STAGE_ORDER) {
      const forStage = rejections.filter((entry) => entry.stage === stage);
      if (forStage.length === 0) continue;
      lines.push("", `${STAGE_LABEL[stage]} (${forStage.length})`);
      for (const entry of forStage) {
        lines.push(`• ${entry.matchName || entry.matchKey}${selectionLabel(entry)}`);
        lines.push(`  ${entry.code}: ${entry.reason}`);
      }
    }
  }

  if (outcome.placed.length === 0 && outcome.liveDrafts.length === 0 && rejections.length === 0) {
    lines.push("", "Nothing was assessed this cycle.");
  }

  if (bankroll) {
    lines.push(
      "",
      `Bankroll ${formatMoney(bankroll.bankroll, currency)} · available ${formatMoney(bankroll.available, currency)} · protected ${formatMoney(bankroll.reserve + bankroll.lockedProfit, currency)}`,
    );
    if (bankroll.halted) lines.push(`Trading halted: ${bankroll.haltReason}`);
  }

  const openCount = bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status)).length;
  lines.push(`Open bets ${openCount} · today ${formatMoney(bankroll?.dayProfit ?? 0, currency)}`);

  return {
    title: `Cycle report — ${formatInZone(new Date(), zone)}`,
    lines,
    placed: outcome.placed.length,
    rejected: rejections.length,
  };
}
