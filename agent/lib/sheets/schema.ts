/**
 * Tab definitions and record shapes for the spreadsheet used as the datastore.
 *
 * Every tab is created on demand with its header row. Column order in
 * `TAB_SCHEMAS` is the wire format: append columns at the end so existing
 * spreadsheets keep working.
 */

import type { Sport } from "../config";

export type ColumnType = "string" | "number" | "boolean" | "json";

export interface ColumnSchema {
  name: string;
  type: ColumnType;
}

export interface TabSchema {
  /** Sheet tab title. */
  name: string;
  columns: ColumnSchema[];
  /**
   * Column holding a natural key. Writes through `appendUnique` refuse to add a
   * second row with the same value, which is how duplicate research, duplicate
   * drafts and duplicate bet execution are prevented.
   */
  uniqueBy?: string;
}

export type BetStatus =
  | "placing"
  | "placed"
  | "unknown"
  | "failed"
  | "settled"
  | "void"
  | "cancelled";

export type DraftStatus = "pending" | "approved" | "rejected" | "expired" | "executed";
export type ApprovedStatus = "ready" | "executing" | "executed" | "failed" | "cancelled";
export type BetResult = "won" | "lost" | "void" | "unknown";

export interface ResearchRecord {
  id: string;
  cycleId: string;
  createdAt: string;
  sport: Sport;
  matchKey: string;
  matchName: string;
  league: string;
  startsAt: string;
  summary: string;
  confidence: number;
  supporting: string[];
  opposing: string[];
  sources: string[];
  /** What other people were predicting for this match, and whether we agree. */
  consensus: ResearchConsensus;
  candidateMarkets: CandidateMarket[];
}

export interface ResearchConsensus {
  found: boolean;
  leaning: string;
  sampled: number;
  agreesWithYou: boolean;
}

export interface CandidateMarket {
  market: string;
  selection: string;
  estimatedProbability: number;
  note: string;
}

/**
 * One fixture read off the operator's own card.
 *
 * This is the answer to "what can we actually bet on", which a public score
 * feed cannot give: it lists matches the bookmaker does not price, and misses
 * competitions the bookmaker does. Discovery therefore comes from here, while
 * scores and settlement still come from the public feed — joined by
 * `matchKey`, which is adopted from the score feed whenever the two agree on a
 * fixture.
 */
export interface OperatorFixtureRecord {
  id: string;
  createdAt: string;
  operator: string;
  sport: Sport;
  matchKey: string;
  /** The operator's own handle for the event, reused when pricing it. */
  eventRef: string;
  home: string;
  away: string;
  competition: string;
  startsAt: string;
  /** Score-feed provider and id, when this fixture was tied to one. */
  provider: string;
  providerId: string;
  /**
   * The markets and prices the catalogue was showing for this fixture.
   *
   * Research reads these so it chooses among outcomes that are actually
   * offered, and sees the price it is arguing against while it argues. They are
   * a snapshot, not an authority: the staking account re-reads the price
   * immediately before anything is placed.
   */
  offers: OfferedMarket[];
}

export interface OfferedMarket {
  market: string;
  selection: string;
  odds: number;
}

export interface ShortlistRecord {
  id: string;
  cycleId: string;
  createdAt: string;
  researchId: string;
  matchKey: string;
  sport: Sport;
  matchName: string;
  startsAt: string;
  provider: string;
  providerId: string;
  market: string;
  selection: string;
  estimatedProbability: number;
  confidence: number;
  rationale: string;
  /** Operator's price, filled in by the Account & Execution agent. 0 until priced. */
  odds: number;
  /** Operator's handle for the event, reused at placement time. */
  eventRef: string;
  pricedAt: string;
}

export interface DraftRecord {
  id: string;
  cycleId: string;
  createdAt: string;
  updatedAt: string;
  researchId: string;
  matchKey: string;
  sport: Sport;
  matchName: string;
  startsAt: string;
  provider: string;
  providerId: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  estimatedProbability: number;
  confidence: number;
  edge: number;
  expectedProfit: number;
  potentialReturn: number;
  /** Earliest time this draft may be refreshed, re-reviewed and executed. */
  executeAfter: string;
  status: DraftStatus;
  notes: string;
}

export interface ApprovedRecord {
  id: string;
  draftId: string;
  createdAt: string;
  updatedAt: string;
  matchKey: string;
  sport: Sport;
  matchName: string;
  startsAt: string;
  provider: string;
  providerId: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  estimatedProbability: number;
  confidence: number;
  status: ApprovedStatus;
  reviewerVerdict: string;
  reviewerNotes: string;
}

export interface BetRecord {
  id: string;
  /** Stable key derived from the approved bet; the duplicate-execution guard. */
  idempotencyKey: string;
  approvedId: string;
  createdAt: string;
  updatedAt: string;
  operator: string;
  matchKey: string;
  sport: Sport;
  matchName: string;
  startsAt: string;
  provider: string;
  providerId: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  potentialReturn: number;
  status: BetStatus;
  operatorRef: string;
  placedAt: string;
  settledAt: string;
  result: BetResult | "";
  profit: number;
  notes: string;
}

export interface ActiveBetRecord {
  id: string;
  betId: string;
  matchKey: string;
  sport: Sport;
  matchName: string;
  startsAt: string;
  provider: string;
  providerId: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  potentialReturn: number;
  status: BetStatus;
  liveScore: string;
  lastCheckedAt: string;
}

export interface SettlementRecord {
  id: string;
  betId: string;
  createdAt: string;
  matchKey: string;
  matchName: string;
  market: string;
  selection: string;
  result: BetResult;
  finalScore: string;
  stake: number;
  returned: number;
  profit: number;
  source: string;
}

export interface BalanceRecord {
  id: string;
  createdAt: string;
  operator: string;
  balance: number;
  exposure: number;
  /** Balance plus money currently riding on unsettled bets. */
  bankroll: number;
  lockedProfit: number;
  available: number;
  source: string;
}

export interface ProfitRecord {
  id: string;
  day: string;
  updatedAt: string;
  betCount: number;
  staked: number;
  returned: number;
  profit: number;
  bankrollEnd: number;
  lockedProfit: number;
}

/**
 * One match, or one selection on a match, that did not become a bet — and the
 * agent that declined it.
 *
 * Rejections are the bulk of what the system does, so they are recorded rather
 * than left in a model's final message. Two things depend on that: the operator
 * gets a report saying why each game was passed over, and a cycle that backed
 * nothing can decide whether another pass over different fixtures is worth
 * running.
 */
export interface RejectionRecord {
  id: string;
  /**
   * Natural key: one rejection per stage per selection per cycle.
   *
   * Composite because that is the thing being deduplicated, and it lives in a
   * column because `appendUnique` is the only write that is atomic against a
   * concurrent one. Two candidates declined at the same moment would otherwise
   * both read an empty tab and both append, and the operator's report would
   * name the same match twice.
   */
  subject: string;
  cycleId: string;
  pass: number;
  createdAt: string;
  stage: RejectionStage;
  matchKey: string;
  matchName: string;
  sport: string;
  startsAt: string;
  market: string;
  selection: string;
  odds: number;
  code: string;
  reason: string;
  /** Whether a different price, market or moment could still make this a bet. */
  fixable: boolean;
  /**
   * False once the rejection stopped being true — a later pass priced the
   * selection, or drafted it after all. Sheets has no delete, and a report that
   * lists a match as both backed and declined is worse than one extra column.
   */
  active: boolean;
}

export type RejectionStage = "research" | "planner" | "reviewer" | "execution";

export interface ReportRecord {
  id: string;
  createdAt: string;
  kind: string;
  title: string;
  body: string;
  delivered: boolean;
}

export interface ErrorRecord {
  id: string;
  createdAt: string;
  scope: string;
  message: string;
  detail: string;
  resolved: boolean;
}

export interface WakeupRecord {
  id: string;
  createdAt: string;
  dueAt: string;
  kind: string;
  reason: string;
  payload: Record<string, unknown>;
  status: "pending" | "claimed" | "done" | "failed";
  leaseUntil: string;
  attempts: number;
}

export interface KeyValueRecord {
  key: string;
  value: string;
  updatedAt: string;
}

const KEY_VALUE_COLUMNS: ColumnSchema[] = [
  { name: "key", type: "string" },
  { name: "value", type: "string" },
  { name: "updatedAt", type: "string" },
];

export const TAB = {
  operatorFixtures: "operator_fixtures",
  research: "research",
  shortlist: "shortlist",
  drafts: "drafts",
  approved: "approved",
  bets: "bets",
  activeBets: "active_bets",
  settlements: "settlements",
  balances: "balances",
  profit: "profit_history",
  rejections: "rejections",
  reports: "reports",
  errors: "errors",
  wakeups: "wakeups",
  state: "system_state",
  settings: "settings",
} as const;

export type TabName = (typeof TAB)[keyof typeof TAB];

export const TAB_SCHEMAS: Record<TabName, TabSchema> = {
  [TAB.operatorFixtures]: {
    name: TAB.operatorFixtures,
    uniqueBy: "matchKey",
    columns: [
      { name: "id", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "operator", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "eventRef", type: "string" },
      { name: "home", type: "string" },
      { name: "away", type: "string" },
      { name: "competition", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "offers", type: "json" },
    ],
  },
  [TAB.research]: {
    name: TAB.research,
    uniqueBy: "matchKey",
    columns: [
      { name: "id", type: "string" },
      { name: "cycleId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "matchName", type: "string" },
      { name: "league", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "summary", type: "string" },
      { name: "confidence", type: "number" },
      { name: "supporting", type: "json" },
      { name: "opposing", type: "json" },
      { name: "sources", type: "json" },
      { name: "candidateMarkets", type: "json" },
      { name: "consensus", type: "json" },
    ],
  },
  [TAB.shortlist]: {
    name: TAB.shortlist,
    columns: [
      { name: "id", type: "string" },
      { name: "cycleId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "researchId", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchName", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "estimatedProbability", type: "number" },
      { name: "confidence", type: "number" },
      { name: "rationale", type: "string" },
      { name: "odds", type: "number" },
      { name: "eventRef", type: "string" },
      { name: "pricedAt", type: "string" },
    ],
  },
  [TAB.drafts]: {
    // Not keyed on matchKey: a rejected or expired draft must not block the
    // same match from being reconsidered later. The Planner enforces "at most
    // one live draft per match" in code instead.
    name: TAB.drafts,
    columns: [
      { name: "id", type: "string" },
      { name: "cycleId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "updatedAt", type: "string" },
      { name: "researchId", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchName", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "odds", type: "number" },
      { name: "stake", type: "number" },
      { name: "estimatedProbability", type: "number" },
      { name: "confidence", type: "number" },
      { name: "edge", type: "number" },
      { name: "expectedProfit", type: "number" },
      { name: "potentialReturn", type: "number" },
      { name: "executeAfter", type: "string" },
      { name: "status", type: "string" },
      { name: "notes", type: "string" },
    ],
  },
  [TAB.approved]: {
    name: TAB.approved,
    uniqueBy: "draftId",
    columns: [
      { name: "id", type: "string" },
      { name: "draftId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "updatedAt", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchName", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "odds", type: "number" },
      { name: "stake", type: "number" },
      { name: "estimatedProbability", type: "number" },
      { name: "confidence", type: "number" },
      { name: "status", type: "string" },
      { name: "reviewerVerdict", type: "string" },
      { name: "reviewerNotes", type: "string" },
    ],
  },
  [TAB.bets]: {
    name: TAB.bets,
    uniqueBy: "idempotencyKey",
    columns: [
      { name: "id", type: "string" },
      { name: "idempotencyKey", type: "string" },
      { name: "approvedId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "updatedAt", type: "string" },
      { name: "operator", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchName", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "odds", type: "number" },
      { name: "stake", type: "number" },
      { name: "potentialReturn", type: "number" },
      { name: "status", type: "string" },
      { name: "operatorRef", type: "string" },
      { name: "placedAt", type: "string" },
      { name: "settledAt", type: "string" },
      { name: "result", type: "string" },
      { name: "profit", type: "number" },
      { name: "notes", type: "string" },
    ],
  },
  [TAB.activeBets]: {
    name: TAB.activeBets,
    columns: [
      { name: "id", type: "string" },
      { name: "betId", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "sport", type: "string" },
      { name: "matchName", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "provider", type: "string" },
      { name: "providerId", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "odds", type: "number" },
      { name: "stake", type: "number" },
      { name: "potentialReturn", type: "number" },
      { name: "status", type: "string" },
      { name: "liveScore", type: "string" },
      { name: "lastCheckedAt", type: "string" },
    ],
  },
  [TAB.settlements]: {
    name: TAB.settlements,
    uniqueBy: "betId",
    columns: [
      { name: "id", type: "string" },
      { name: "betId", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "matchName", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "result", type: "string" },
      { name: "finalScore", type: "string" },
      { name: "stake", type: "number" },
      { name: "returned", type: "number" },
      { name: "profit", type: "number" },
      { name: "source", type: "string" },
    ],
  },
  [TAB.balances]: {
    name: TAB.balances,
    columns: [
      { name: "id", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "operator", type: "string" },
      { name: "balance", type: "number" },
      { name: "exposure", type: "number" },
      { name: "bankroll", type: "number" },
      { name: "lockedProfit", type: "number" },
      { name: "available", type: "number" },
      { name: "source", type: "string" },
    ],
  },
  [TAB.profit]: {
    name: TAB.profit,
    uniqueBy: "day",
    columns: [
      { name: "id", type: "string" },
      { name: "day", type: "string" },
      { name: "updatedAt", type: "string" },
      { name: "betCount", type: "number" },
      { name: "staked", type: "number" },
      { name: "returned", type: "number" },
      { name: "profit", type: "number" },
      { name: "bankrollEnd", type: "number" },
      { name: "lockedProfit", type: "number" },
    ],
  },
  [TAB.rejections]: {
    name: TAB.rejections,
    uniqueBy: "subject",
    columns: [
      { name: "id", type: "string" },
      { name: "subject", type: "string" },
      { name: "cycleId", type: "string" },
      { name: "pass", type: "number" },
      { name: "createdAt", type: "string" },
      { name: "stage", type: "string" },
      { name: "matchKey", type: "string" },
      { name: "matchName", type: "string" },
      { name: "sport", type: "string" },
      { name: "startsAt", type: "string" },
      { name: "market", type: "string" },
      { name: "selection", type: "string" },
      { name: "odds", type: "number" },
      { name: "code", type: "string" },
      { name: "reason", type: "string" },
      { name: "fixable", type: "boolean" },
      { name: "active", type: "boolean" },
    ],
  },
  [TAB.reports]: {
    name: TAB.reports,
    columns: [
      { name: "id", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "kind", type: "string" },
      { name: "title", type: "string" },
      { name: "body", type: "string" },
      { name: "delivered", type: "boolean" },
    ],
  },
  [TAB.errors]: {
    name: TAB.errors,
    columns: [
      { name: "id", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "scope", type: "string" },
      { name: "message", type: "string" },
      { name: "detail", type: "string" },
      { name: "resolved", type: "boolean" },
    ],
  },
  [TAB.wakeups]: {
    name: TAB.wakeups,
    columns: [
      { name: "id", type: "string" },
      { name: "createdAt", type: "string" },
      { name: "dueAt", type: "string" },
      { name: "kind", type: "string" },
      { name: "reason", type: "string" },
      { name: "payload", type: "json" },
      { name: "status", type: "string" },
      { name: "leaseUntil", type: "string" },
      { name: "attempts", type: "number" },
    ],
  },
  [TAB.state]: { name: TAB.state, uniqueBy: "key", columns: KEY_VALUE_COLUMNS },
  [TAB.settings]: { name: TAB.settings, uniqueBy: "key", columns: KEY_VALUE_COLUMNS },
};

/** Maps a tab name to its record type for the typed store helpers. */
export interface TabRecords {
  [TAB.operatorFixtures]: OperatorFixtureRecord;
  [TAB.research]: ResearchRecord;
  [TAB.shortlist]: ShortlistRecord;
  [TAB.drafts]: DraftRecord;
  [TAB.approved]: ApprovedRecord;
  [TAB.bets]: BetRecord;
  [TAB.activeBets]: ActiveBetRecord;
  [TAB.settlements]: SettlementRecord;
  [TAB.balances]: BalanceRecord;
  [TAB.profit]: ProfitRecord;
  [TAB.rejections]: RejectionRecord;
  [TAB.reports]: ReportRecord;
  [TAB.errors]: ErrorRecord;
  [TAB.wakeups]: WakeupRecord;
  [TAB.state]: KeyValueRecord;
  [TAB.settings]: KeyValueRecord;
}

export const ALL_TABS = Object.values(TAB) as TabName[];

/** Bets that still carry risk and must be reconciled or watched. */
export const OPEN_BET_STATUSES: BetStatus[] = ["placing", "placed", "unknown"];
