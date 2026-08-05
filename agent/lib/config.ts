/**
 * Environment-backed configuration.
 *
 * Everything the system needs comes from `process.env`. Values are read lazily
 * so tests can mutate the environment before the first access, and validated
 * once so a misconfigured deployment fails at startup instead of mid-bet.
 */

export type Sport = "football" | "basketball" | "cricket" | "tennis";

export const ALL_SPORTS: readonly Sport[] = ["football", "basketball", "cricket", "tennis"];

export type BettingMode = "mock" | "live";

/**
 * `sandbox` drives a real browser through agent-browser inside the configured
 * eve sandbox. `mock` uses the in-process simulated operator and never opens a
 * browser at all, which is what lets the whole pipeline run offline.
 */
export type BrowserDriverName = "mock" | "sandbox";

export interface StrategyConfig {
  /** IANA timezone that defines the betting day and the midnight wake-up. */
  timezone: string;
  currency: string;
  /** Fraction of peak bankroll that may never be staked. */
  reserveFraction: number;
  /** Share of realised profit that returns to the betting pool; the rest locks. */
  profitReleaseFraction: number;
  /** Hard cap on a single stake, as a fraction of available bankroll. */
  maxStakeFraction: number;
  /** Fractional-Kelly multiplier. 1 is full Kelly; lower is safer. */
  kellyMultiplier: number;
  minStake: number;
  /** Minimum modelled edge (`p * odds - 1`) before a bet is considered. */
  minEdge: number;
  minConfidence: number;
  maxActiveBets: number;
  /** Trading halts for the day once losses reach this fraction of day-start bankroll. */
  maxDailyLossFraction: number;
  /** Consecutive losses that trigger a cooldown for the rest of the day. */
  lossStreakCooldown: number;
  sports: Sport[];
  /** How long before kickoff a draft is refreshed and executed. */
  executeBeforeKickoffMinutes: number;
  /** Research is not trusted for a match starting sooner than this. */
  minMinutesToKickoff: number;
}

export interface SheetsConfig {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUserIds: string[];
  botUsername?: string;
}

/**
 * Everything site-specific about an operator lives here rather than in code, so
 * adding a bookmaker is configuration and not a new module. The labels are
 * matched semantically by agent-browser (accessible name, label text,
 * placeholder), never as CSS selectors.
 */
export interface OperatorConfig {
  name: string;
  username: string;
  password: string;
  baseUrl: string;
  loginPath: string;
  myBetsPath: string;
  /** `{query}` is replaced with the URL-encoded search term. */
  searchPath: string;
  usernameLabel: string;
  passwordLabel: string;
  loginButtonLabel: string;
  /** Regex source matched against page text to confirm an authenticated session. */
  loggedInMarker: string;
}

export interface AppConfig {
  mode: BettingMode;
  browserDriver: BrowserDriverName;
  strategy: StrategyConfig;
  sheets: SheetsConfig | null;
  telegram: TelegramConfig | null;
  operator: OperatorConfig;
  dashboardToken: string | null;
  /** Cap on research depth per cycle, to bound token spend. */
  maxResearchMatches: number;
  maxShortlist: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function str(key: string, fallback?: string): string {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`Missing required environment variable ${key}`);
}

function optional(key: string): string | undefined {
  const raw = process.env[key]?.trim();
  return raw ? raw : undefined;
}

function num(key: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a number, got ${raw}`);
  if (min !== undefined && value < min) throw new ConfigError(`${key} must be >= ${min}`);
  if (max !== undefined && value > max) throw new ConfigError(`${key} must be <= ${max}`);
  return value;
}

function int(key: string, fallback: number, min = 0): number {
  const value = num(key, fallback, min);
  if (!Number.isInteger(value)) throw new ConfigError(`${key} must be a whole number`);
  return value;
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(", ")}, got ${raw}`);
  }
  return raw as T;
}

function parseSports(): Sport[] {
  const raw = list("SPORTS", [...ALL_SPORTS]).map((entry) => entry.toLowerCase());
  const sports = raw.filter((entry): entry is Sport =>
    (ALL_SPORTS as readonly string[]).includes(entry),
  );
  const unknown = raw.filter((entry) => !(ALL_SPORTS as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new ConfigError(
      `SPORTS contains unsupported values: ${unknown.join(", ")}. Supported: ${ALL_SPORTS.join(", ")}`,
    );
  }
  if (sports.length === 0) throw new ConfigError("SPORTS must list at least one sport");
  return sports;
}

/**
 * Google's key material is usually pasted with literal `\n` escapes. Normalise
 * both forms so either survives a `.env` round-trip.
 */
function normalisePrivateKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function readSheets(): SheetsConfig | null {
  const spreadsheetId = optional("GOOGLE_SHEETS_SPREADSHEET_ID");
  const clientEmail = optional("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = optional("GOOGLE_PRIVATE_KEY");
  if (!spreadsheetId && !clientEmail && !privateKey) return null;
  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new ConfigError(
      "Google Sheets needs GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY together",
    );
  }
  return { spreadsheetId, clientEmail, privateKey: normalisePrivateKey(privateKey) };
}

function readTelegram(): TelegramConfig | null {
  const botToken = optional("TELEGRAM_BOT_TOKEN");
  const chatId = optional("TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return null;
  return {
    botToken,
    chatId,
    allowedUserIds: list("TELEGRAM_ALLOWED_USER_IDS", []),
    botUsername: optional("TELEGRAM_BOT_USERNAME"),
  };
}

function build(): AppConfig {
  const mode = oneOf("BETTING_MODE", ["mock", "live"] as const, "mock");
  const defaultDriver: BrowserDriverName = mode === "mock" ? "mock" : "sandbox";
  const operatorName = str("OPERATOR", mode === "mock" ? "mock" : "sportybet").toLowerCase();

  const config: AppConfig = {
    mode,
    browserDriver: oneOf("BROWSER_DRIVER", ["mock", "sandbox"] as const, defaultDriver),
    strategy: {
      timezone: str("TIMEZONE", "UTC"),
      currency: str("CURRENCY", "USD"),
      reserveFraction: num("BANKROLL_RESERVE_FRACTION", 0.4, 0, 0.95),
      profitReleaseFraction: num("PROFIT_RELEASE_FRACTION", 0.5, 0, 1),
      maxStakeFraction: num("MAX_STAKE_FRACTION", 0.15, 0.001, 1),
      kellyMultiplier: num("KELLY_MULTIPLIER", 0.25, 0.01, 1),
      minStake: num("MIN_STAKE", 5, 0.01),
      minEdge: num("MIN_EDGE", 0.05, 0),
      minConfidence: num("MIN_CONFIDENCE", 0.6, 0, 1),
      maxActiveBets: int("MAX_ACTIVE_BETS", 5, 1),
      maxDailyLossFraction: num("MAX_DAILY_LOSS_FRACTION", 0.2, 0.01, 1),
      lossStreakCooldown: int("LOSS_STREAK_COOLDOWN", 3, 1),
      sports: parseSports(),
      executeBeforeKickoffMinutes: int("EXECUTE_BEFORE_KICKOFF_MINUTES", 25, 1),
      minMinutesToKickoff: int("MIN_MINUTES_TO_KICKOFF", 20, 1),
    },
    sheets: readSheets(),
    telegram: readTelegram(),
    operator: {
      name: operatorName,
      username: optional("OPERATOR_USERNAME") ?? "",
      password: optional("OPERATOR_PASSWORD") ?? "",
      baseUrl: optional("OPERATOR_BASE_URL") ?? "",
      loginPath: str("OPERATOR_LOGIN_PATH", "/login"),
      myBetsPath: str("OPERATOR_MY_BETS_PATH", "/my-bets"),
      searchPath: str("OPERATOR_SEARCH_PATH", "/search?query={query}"),
      usernameLabel: str("OPERATOR_USERNAME_LABEL", "Username"),
      passwordLabel: str("OPERATOR_PASSWORD_LABEL", "Password"),
      loginButtonLabel: str("OPERATOR_LOGIN_BUTTON", "Log in"),
      loggedInMarker: str("OPERATOR_LOGGED_IN_MARKER", "log ?out|my account|my bets"),
    },
    dashboardToken: optional("DASHBOARD_TOKEN") ?? null,
    maxResearchMatches: int("MAX_RESEARCH_MATCHES", 6, 1),
    maxShortlist: int("MAX_SHORTLIST", 3, 1),
  };

  if (config.mode === "live") {
    if (config.browserDriver === "mock") {
      throw new ConfigError("BETTING_MODE=live cannot run with BROWSER_DRIVER=mock");
    }
    if (config.operator.name === "mock") {
      throw new ConfigError("BETTING_MODE=live requires a real OPERATOR");
    }
    if (!config.operator.username || !config.operator.password) {
      throw new ConfigError("BETTING_MODE=live requires OPERATOR_USERNAME and OPERATOR_PASSWORD");
    }
    if (!config.sheets) {
      throw new ConfigError("BETTING_MODE=live requires Google Sheets credentials");
    }
    if (!config.operator.baseUrl) {
      throw new ConfigError("BETTING_MODE=live requires OPERATOR_BASE_URL");
    }
  }

  if (config.strategy.reserveFraction + config.strategy.maxStakeFraction >= 1) {
    throw new ConfigError(
      "BANKROLL_RESERVE_FRACTION + MAX_STAKE_FRACTION must stay below 1 so a stake can never consume the reserve",
    );
  }

  return config;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= build();
  return cached;
}

/** Drops the memoised config. Used by tests that rewrite the environment. */
export function resetConfig(): void {
  cached = null;
}
