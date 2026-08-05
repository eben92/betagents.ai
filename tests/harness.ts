/**
 * Test harness.
 *
 * Puts the whole system into a deterministic mode: in-memory storage, the
 * simulated bookmaker, a scripted sports world and a captured Telegram
 * transport. Everything else is the real code — the same tools the agents call,
 * the same staking rules, the same idempotency guard, the same settlement
 * maths.
 *
 * What is *not* exercised here is the models' judgement. Orchestration is
 * model-driven, so a full agentic run needs real model calls; these tests drive
 * the tools directly instead, which is where every irreversible decision
 * actually lives.
 */

import { resetConfig } from "../agent/lib/config";
import { resetMockOperator, setMockOdds } from "../agent/lib/operator";
import { setStore } from "../agent/lib/sheets";
import { createMemoryStore, type Store } from "../agent/lib/sheets/store";
import { resetMockWorld, seedFixture, setSportsProviders } from "../agent/lib/sports";
import { resetCycleLock } from "../agent/lib/state";
import { setTelegramTransport } from "../agent/lib/telegram/notify";
import { invalidateCache } from "../agent/lib/wakeups";

export interface TestContext {
  store: Store;
  /** Every report the system tried to deliver, newest last. */
  messages: string[];
}

/**
 * What a tool receives as its second argument. In mock mode no tool reaches for
 * a sandbox, so returning null here proves that: any code path that tried to
 * open a browser in a test would fail loudly rather than silently work.
 */
export const toolContext = {
  async getSandbox() {
    return null;
  },
} as never;

const BASE_ENV: Record<string, string> = {
  BETTING_MODE: "mock",
  BROWSER_DRIVER: "mock",
  OPERATOR: "mock",
  TIMEZONE: "UTC",
  CURRENCY: "USD",
  LOG_LEVEL: "error",
  SPORTS: "football,basketball",
  BANKROLL_RESERVE_FRACTION: "0.4",
  PROFIT_RELEASE_FRACTION: "0.5",
  MAX_STAKE_FRACTION: "0.15",
  KELLY_MULTIPLIER: "0.5",
  MIN_STAKE: "5",
  MIN_EDGE: "0.05",
  MIN_CONFIDENCE: "0.6",
  MAX_ACTIVE_BETS: "5",
  MAX_DAILY_LOSS_FRACTION: "0.25",
  LOSS_STREAK_COOLDOWN: "3",
  MIN_MINUTES_TO_KICKOFF: "20",
  EXECUTE_BEFORE_KICKOFF_MINUTES: "25",
  MAX_RESEARCH_MATCHES: "6",
};

const OWNED_KEYS = [
  ...Object.keys(BASE_ENV),
  "GOOGLE_SHEETS_SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ALLOWED_USER_IDS",
  "DASHBOARD_TOKEN",
  "OPERATOR_BASE_URL",
  "OPERATOR_USERNAME",
  "OPERATOR_PASSWORD",
];

/** Resets every global the system keeps and returns a fresh context. */
export function setupTest(overrides: Record<string, string> = {}): TestContext {
  for (const key of OWNED_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    process.env[key] = value;
  }

  resetConfig();
  resetMockWorld();
  resetMockOperator(1000);
  setSportsProviders(null);
  invalidateCache();
  resetCycleLock();

  const store = createMemoryStore();
  setStore(store);

  const messages: string[] = [];
  setTelegramTransport(async (text) => {
    messages.push(text);
    return true;
  });

  return { store, messages };
}

export function teardownTest(): void {
  setTelegramTransport(null);
  setStore(null);
  setSportsProviders(null);
}

/**
 * Seeds one football fixture inside the research window and prices the home win
 * at the simulated bookmaker.
 */
export function seedPricedFootballMatch(
  options: { minutesFromNow?: number; odds?: number } = {},
) {
  const minutes = options.minutesFromNow ?? 45;
  const fixture = seedFixture({
    sport: "football",
    home: "Northbridge United",
    away: "Easthaven Rovers",
    league: "football/test",
    startsAt: new Date(Date.now() + minutes * 60_000),
  });

  setMockOdds(
    {
      matchName: `${fixture.home} vs ${fixture.away}`,
      market: "1x2",
      selection: "home",
    },
    options.odds ?? 2.1,
  );

  return fixture;
}

export { seedFixture, setMockOdds };
