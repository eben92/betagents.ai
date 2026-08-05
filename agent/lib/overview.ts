/**
 * Read models shared by the control tools and the dashboard.
 *
 * Both surfaces answer the same questions, so the shaping lives here once
 * rather than being duplicated in a tool and a route.
 */

import { snapshot, type BankrollSnapshot } from "./bankroll";
import { getConfig } from "./config";
import { createLogger, errorMessage } from "./logger";
import { roundMoney } from "./money";
import {
  getStore,
  OPEN_BET_STATUSES,
  TAB,
  type BetRecord,
  type DraftRecord,
  type ErrorRecord,
  type ReportRecord,
  type ResearchRecord,
  type SettlementRecord,
} from "./sheets";
import { getHaltReason, getLastCycleAt, getStatus, type SystemStatus } from "./state";
import { dayKey } from "./time";
import { pendingWakeups } from "./wakeups";

const log = createLogger("overview");

export interface SystemOverview {
  status: SystemStatus;
  mode: string;
  operator: string;
  currency: string;
  timezone: string;
  day: string;
  lastCycleAt: string | null;
  nextWakeAt: string | null;
  haltReason: string | null;
  bankroll: BankrollSnapshot | null;
  bankrollError: string | null;
  /** When the balance behind `bankroll` was read from the operator. */
  bankrollAsOf: string | null;
  openBets: BetRecord[];
  liveDrafts: DraftRecord[];
  todaysSettlements: SettlementRecord[];
  todaysProfit: number;
  dailyObjective: { targetProfit: number; expectedBets: number; reasoning: string } | null;
}

/**
 * Bankroll from the last balance the Account & Execution agent recorded.
 *
 * Reading it from the spreadsheet rather than the operator keeps the dashboard
 * and the Telegram commands cheap and instant: answering `/balance` should not
 * boot a browser. A stale figure is labelled with its timestamp so nobody
 * mistakes it for live.
 */
async function readBankroll(): Promise<{
  bankroll: BankrollSnapshot | null;
  error: string | null;
  asOf: string | null;
}> {
  try {
    const store = await getStore();
    const balances = await store.list(TAB.balances);
    const latest = balances.at(-1);
    if (!latest) {
      return { bankroll: null, error: "no balance has been recorded yet", asOf: null };
    }
    return { bankroll: await snapshot(latest.balance), error: null, asOf: latest.createdAt };
  } catch (error) {
    const message = errorMessage(error);
    log.warn("could not read the recorded balance", { error: message });
    return { bankroll: null, error: message, asOf: null };
  }
}

export async function getOverview(options: { withBalance?: boolean } = {}): Promise<SystemOverview> {
  const config = getConfig();
  const store = await getStore();
  const today = dayKey(new Date(), config.strategy.timezone);

  const [bets, drafts, settlements, wakeups, status, lastCycleAt, haltReason] = await Promise.all([
    store.list(TAB.bets),
    store.list(TAB.drafts),
    store.list(TAB.settlements),
    pendingWakeups(),
    getStatus(),
    getLastCycleAt(),
    getHaltReason(),
  ]);

  const { bankroll, error, asOf } =
    options.withBalance === false
      ? { bankroll: null, error: null, asOf: null }
      : await readBankroll();

  const todaysSettlements = settlements.filter(
    (entry) => dayKey(new Date(entry.createdAt), config.strategy.timezone) === today,
  );

  let dailyObjective: SystemOverview["dailyObjective"] = null;
  const rawObjective = await store.getValue(TAB.state, "daily_objective");
  if (rawObjective) {
    try {
      dailyObjective = JSON.parse(rawObjective);
    } catch {
      dailyObjective = null;
    }
  }

  return {
    status,
    mode: config.mode,
    operator: config.operator.name,
    currency: config.strategy.currency,
    timezone: config.strategy.timezone,
    day: today,
    lastCycleAt,
    nextWakeAt: wakeups[0]?.dueAt ?? null,
    haltReason: haltReason ?? bankroll?.haltReason ?? null,
    bankroll,
    bankrollError: error,
    bankrollAsOf: asOf,
    openBets: bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status)),
    liveDrafts: drafts.filter((draft) => draft.status === "pending" || draft.status === "approved"),
    todaysSettlements,
    todaysProfit: roundMoney(todaysSettlements.reduce((total, entry) => total + entry.profit, 0)),
    dailyObjective,
  };
}

export interface TodayActivity {
  day: string;
  research: ResearchRecord[];
  drafts: DraftRecord[];
  bets: BetRecord[];
  settlements: SettlementRecord[];
  staked: number;
  returned: number;
  profit: number;
}

export async function getTodayActivity(): Promise<TodayActivity> {
  const config = getConfig();
  const store = await getStore();
  const today = dayKey(new Date(), config.strategy.timezone);
  const isToday = (iso: string): boolean =>
    Boolean(iso) && dayKey(new Date(iso), config.strategy.timezone) === today;

  const [research, drafts, bets, settlements] = await Promise.all([
    store.list(TAB.research),
    store.list(TAB.drafts),
    store.list(TAB.bets),
    store.list(TAB.settlements),
  ]);

  const todaysSettlements = settlements.filter((entry) => isToday(entry.createdAt));
  const staked = roundMoney(todaysSettlements.reduce((total, entry) => total + entry.stake, 0));
  const returned = roundMoney(todaysSettlements.reduce((total, entry) => total + entry.returned, 0));

  return {
    day: today,
    research: research.filter((entry) => isToday(entry.createdAt)),
    drafts: drafts.filter((entry) => isToday(entry.createdAt)),
    bets: bets.filter((entry) => isToday(entry.createdAt)),
    settlements: todaysSettlements,
    staked,
    returned,
    profit: roundMoney(returned - staked),
  };
}

export async function getLatestReports(limit = 10): Promise<ReportRecord[]> {
  const store = await getStore();
  return (await store.list(TAB.reports)).slice(-limit).reverse();
}

export async function getRecentErrors(limit = 10): Promise<ErrorRecord[]> {
  const store = await getStore();
  return (await store.list(TAB.errors))
    .filter((entry) => !entry.resolved)
    .slice(-limit)
    .reverse();
}
