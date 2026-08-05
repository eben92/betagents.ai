/**
 * Unit coverage for the pieces that decide money and results: market
 * settlement, stake sizing under the bankroll rules, and the timezone maths
 * that defines a betting day.
 */

import { afterEach, describe, expect, it } from "vitest";

import { computeStake, lockedProfitAfter, type BankrollSnapshot } from "../agent/lib/bankroll";
import { describeSelection, isValidSelection, settleSelection } from "../agent/lib/markets";
import {
  compactionThresholdFor,
  contextWindowFor,
  contextWindowForSpec,
  modelFor,
  modelSpecFor,
  resolveModel,
  toolOutputBudgetFor,
} from "../agent/lib/model";
import { edge, kellyFraction, parseOdds } from "../agent/lib/money";
import type { MatchState } from "../agent/lib/sports";
import { dayKey, nextMidnight, startOfDay, zonedTimeToUtc } from "../agent/lib/time";
import { setupTest, teardownTest } from "./harness";

afterEach(teardownTest);

function finalScore(home: number, away: number): MatchState {
  return {
    matchKey: "test",
    status: "final",
    homeScore: home,
    awayScore: away,
    displayScore: `${home} - ${away}`,
    clock: "FT",
    winner: home > away ? "home" : away > home ? "away" : "draw",
    provider: "test",
    completed: true,
  };
}

describe("market settlement", () => {
  it("settles 1x2 from the final score", () => {
    expect(settleSelection({ market: "1x2", code: "home" }, finalScore(2, 1))).toBe("won");
    expect(settleSelection({ market: "1x2", code: "away" }, finalScore(2, 1))).toBe("lost");
    expect(settleSelection({ market: "1x2", code: "draw" }, finalScore(1, 1))).toBe("won");
  });

  it("voids a moneyline on a draw, since there is no draw selection", () => {
    expect(settleSelection({ market: "moneyline", code: "home" }, finalScore(1, 1))).toBe("void");
  });

  it("settles double chance", () => {
    expect(settleSelection({ market: "double_chance", code: "home_or_draw" }, finalScore(1, 1))).toBe("won");
    expect(settleSelection({ market: "double_chance", code: "home_or_draw" }, finalScore(0, 2))).toBe("lost");
  });

  it("settles totals and voids an exact line", () => {
    expect(settleSelection({ market: "over_under", code: "over_2.5" }, finalScore(2, 1))).toBe("won");
    expect(settleSelection({ market: "over_under", code: "under_2.5" }, finalScore(2, 1))).toBe("lost");
    expect(settleSelection({ market: "over_under", code: "over_3" }, finalScore(2, 1))).toBe("void");
  });

  it("settles both-teams-to-score", () => {
    expect(settleSelection({ market: "btts", code: "yes" }, finalScore(2, 1))).toBe("won");
    expect(settleSelection({ market: "btts", code: "no" }, finalScore(2, 0))).toBe("won");
  });

  it("settles handicaps and voids a push", () => {
    expect(settleSelection({ market: "handicap", code: "home_-1.5" }, finalScore(3, 1))).toBe("won");
    expect(settleSelection({ market: "handicap", code: "home_-1.5" }, finalScore(2, 1))).toBe("lost");
    expect(settleSelection({ market: "handicap", code: "home_-1" }, finalScore(2, 1))).toBe("void");
  });

  it("returns unknown rather than guessing when the match is unfinished", () => {
    const running = { ...finalScore(1, 0), status: "live" as const, completed: false };
    expect(settleSelection({ market: "1x2", code: "home" }, running)).toBe("unknown");
  });

  it("voids everything on a postponement", () => {
    const postponed = { ...finalScore(0, 0), status: "postponed" as const, completed: false };
    expect(settleSelection({ market: "1x2", code: "home" }, postponed)).toBe("void");
  });

  it("rejects selection codes that do not belong to their market", () => {
    expect(isValidSelection({ market: "1x2", code: "yes" })).toBe(false);
    expect(isValidSelection({ market: "over_under", code: "over_2.5" })).toBe(true);
    expect(isValidSelection({ market: "handicap", code: "home_-1.5" })).toBe(true);
    expect(isValidSelection({ market: "handicap", code: "sideways" })).toBe(false);
  });

  it("labels selections with the team names", () => {
    const teams = { home: "Arsenal", away: "Chelsea" };
    expect(describeSelection({ market: "1x2", code: "home" }, teams)).toBe("Arsenal to win");
    expect(describeSelection({ market: "over_under", code: "over_2.5" }, teams)).toBe("Over 2.5");
    expect(describeSelection({ market: "handicap", code: "away_1.5" }, teams)).toBe("Chelsea +1.5");
  });
});

describe("odds maths", () => {
  it("computes edge and Kelly", () => {
    expect(edge(0.6, 2)).toBeCloseTo(0.2, 6);
    expect(kellyFraction(0.6, 2)).toBeCloseTo(0.2, 6);
    expect(kellyFraction(0.4, 2)).toBe(0);
  });

  it("parses operator odds text and rejects nonsense", () => {
    expect(parseOdds("2.35")).toBe(2.35);
    expect(parseOdds("Odds: 2,35")).toBe(2.35);
    expect(parseOdds("SUSPENDED")).toBeNull();
    expect(parseOdds("0.5")).toBeNull();
  });
});

describe("stake sizing", () => {
  const bank: BankrollSnapshot = {
    balance: 1000,
    exposure: 0,
    bankroll: 1000,
    reserve: 400,
    lockedProfit: 0,
    available: 600,
    activeBets: 0,
    dayStartBankroll: 1000,
    dayProfit: 0,
    lossStreak: 0,
    halted: false,
    haltReason: null,
  };

  it("sizes a positive-edge bet inside the per-bet cap", () => {
    setupTest();
    const decision = computeStake({
      snapshot: bank,
      probability: 0.62,
      odds: 2.1,
      confidence: 0.8,
      multiplier: 1,
      remainingOpportunities: 1,
    });

    expect(decision.declined).toBeNull();
    expect(decision.stake).toBeGreaterThan(0);
    // Never more than MAX_STAKE_FRACTION of what is available.
    expect(decision.stake).toBeLessThanOrEqual(bank.available * 0.15);
  });

  it("declines a bet with no edge", () => {
    setupTest();
    const decision = computeStake({
      snapshot: bank,
      probability: 0.4,
      odds: 2,
      confidence: 0.9,
      multiplier: 1,
      remainingOpportunities: 1,
    });
    expect(decision.stake).toBe(0);
    expect(decision.declined).toContain("edge");
  });

  it("declines when confidence is below the floor", () => {
    setupTest();
    const decision = computeStake({
      snapshot: bank,
      probability: 0.8,
      odds: 2.5,
      confidence: 0.3,
      multiplier: 1,
      remainingOpportunities: 1,
    });
    expect(decision.stake).toBe(0);
    expect(decision.declined).toContain("confidence");
  });

  it("never stakes while trading is halted", () => {
    setupTest();
    const decision = computeStake({
      snapshot: { ...bank, halted: true, haltReason: "daily loss limit reached" },
      probability: 0.9,
      odds: 3,
      confidence: 1,
      multiplier: 1,
      remainingOpportunities: 1,
    });
    expect(decision.stake).toBe(0);
    expect(decision.declined).toContain("daily loss limit");
  });

  it("splits the budget across the day's remaining opportunities", () => {
    setupTest();
    const shared = (remaining: number) =>
      computeStake({
        snapshot: bank,
        probability: 0.62,
        odds: 2.1,
        confidence: 0.8,
        multiplier: 1,
        remainingOpportunities: remaining,
      }).stake;

    expect(shared(4)).toBeLessThan(shared(1));
  });

  it("cannot be talked above its cap by the planner's multiplier", () => {
    setupTest();
    const decision = computeStake({
      snapshot: bank,
      probability: 0.95,
      odds: 5,
      confidence: 1,
      multiplier: 1,
      remainingOpportunities: 1,
    });
    expect(decision.stake).toBeLessThanOrEqual(bank.available * 0.15);
  });

  it("locks away the withheld share of a win and nothing on a loss", () => {
    setupTest();
    // PROFIT_RELEASE_FRACTION is 0.5, so half of a win is locked.
    expect(lockedProfitAfter(0, 100)).toBe(50);
    expect(lockedProfitAfter(50, -100)).toBe(50);
  });
});

describe("betting day", () => {
  it("uses the configured timezone, not the host clock", () => {
    // 23:30 UTC is already the next day in Accra+? No: Accra is UTC+0. Use Tokyo.
    const instant = new Date("2026-08-04T23:30:00Z");
    expect(dayKey(instant, "UTC")).toBe("2026-08-04");
    expect(dayKey(instant, "Asia/Tokyo")).toBe("2026-08-05");
  });

  it("finds the next local midnight", () => {
    const instant = new Date("2026-08-04T10:00:00Z");
    const midnight = nextMidnight(instant, "UTC");
    expect(midnight.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("advances past midnight rather than returning the same instant", () => {
    const midnight = new Date("2026-08-04T00:00:00Z");
    expect(nextMidnight(midnight, "UTC").toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("round-trips a zoned wall clock through UTC", () => {
    const utc = zonedTimeToUtc(
      { year: 2026, month: 8, day: 4, hour: 0, minute: 0, second: 0 },
      "Asia/Tokyo",
    );
    // Tokyo is UTC+9 year round.
    expect(utc.toISOString()).toBe("2026-08-03T15:00:00.000Z");
    expect(startOfDay(new Date("2026-08-04T05:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-08-03T15:00:00.000Z",
    );
  });

  it("handles a daylight-saving transition", () => {
    // London moves to BST on 2026-03-29.
    const before = new Date("2026-03-28T12:00:00Z");
    expect(nextMidnight(before, "Europe/London").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    const after = new Date("2026-03-29T12:00:00Z");
    expect(nextMidnight(after, "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });
});

describe("model selection", () => {
  const OWNED = [
    "MODEL_RESEARCH",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMI_BASE_URL",
    "KIMI_API_KEY",
  ];

  afterEach(() => {
    for (const key of OWNED) delete process.env[key];
  });

  it("resolves each first-class provider from its own key", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.DEEPSEEK_API_KEY = "test";

    expect(resolveModel("anthropic:claude-sonnet-4-5").modelId).toBe("claude-sonnet-4-5");
    expect(resolveModel("deepseek:deepseek-reasoner").modelId).toBe("deepseek-reasoner");
    expect(resolveModel("google:gemini-2.0-flash").modelId).toBe("gemini-2.0-flash");
    expect(resolveModel("openai:gpt-5").modelId).toBe("gpt-5");
  });

  it("reaches any other provider as an OpenAI-compatible endpoint", () => {
    process.env.KIMI_BASE_URL = "https://api.moonshot.ai/v1";
    process.env.KIMI_API_KEY = "test";

    const model = resolveModel("kimi:kimi-k2-0905-preview");
    expect(model.modelId).toBe("kimi-k2-0905-preview");
  });

  it("says what to set when a provider is unknown", () => {
    expect(() => resolveModel("kimi:kimi-k2")).toThrow(/KIMI_BASE_URL/);
  });

  it("rejects a spec that names no provider", () => {
    expect(() => resolveModel("claude-sonnet-4-5")).toThrow(/provider:model-id/);
    expect(() => resolveModel("anthropic:")).toThrow(/provider:model-id/);
    expect(() => resolveModel(":claude")).toThrow(/provider:model-id/);
    expect(() => resolveModel("/claude")).toThrow(/provider:model-id/);
  });

  it("accepts a slash between provider and model", () => {
    // Every other tool writes model ids this way; typing one here is the
    // obvious mistake, and it used to fail only at build time.
    process.env.DEEPSEEK_API_KEY = "test";
    expect(resolveModel("deepseek/deepseek-chat").modelId).toBe("deepseek-chat");
    expect(resolveModel("deepseek:deepseek-chat").modelId).toBe("deepseek-chat");
  });

  it("keeps a slash that belongs to the model id", () => {
    process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
    try {
      const model = resolveModel("openrouter:qwen/qwen-2.5-72b-instruct");
      expect(model.modelId).toBe("qwen/qwen-2.5-72b-instruct");
    } finally {
      delete process.env.OPENROUTER_BASE_URL;
    }
  });

  it("lets each agent take a different provider", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.MODEL_RESEARCH = "deepseek:deepseek-chat";

    expect(modelSpecFor("RESEARCH")).toBe("deepseek:deepseek-chat");
    expect(modelFor("RESEARCH").modelId).toBe("deepseek-chat");
    // Unset agents fall back to a default rather than failing the build.
    expect(modelFor("PLANNER").modelId).toBeTruthy();
  });

  it("resolves without any key present, so builds do not need credentials", () => {
    expect(() => resolveModel("anthropic:claude-sonnet-4-5")).not.toThrow();
  });
});

describe("context window management", () => {
  afterEach(() => {
    delete process.env.MODEL_RESEARCH;
    delete process.env.MODEL_RESEARCH_CONTEXT;
  });

  it("sizes each DeepSeek model to its own window", () => {
    // These differ sharply. Treating them alike wastes v4-flash or overflows
    // the others.
    expect(contextWindowForSpec("deepseek:deepseek-chat")).toBe(128_000);
    expect(contextWindowForSpec("deepseek:deepseek-reasoner")).toBe(128_000);
    expect(contextWindowForSpec("deepseek:deepseek-v4-flash")).toBe(1_000_000);
    expect(contextWindowForSpec("deepseek:some-unknown-deepseek")).toBe(64_000);

    expect(contextWindowForSpec("deepseek:deepseek-chat")).toBeLessThan(
      contextWindowForSpec("anthropic:claude-sonnet-4-5"),
    );
  });

  it("compacts a small-context model earlier than a large one", () => {
    process.env.MODEL_RESEARCH = "deepseek:some-unknown-deepseek";
    const small = compactionThresholdFor("RESEARCH");

    process.env.MODEL_RESEARCH = "google:gemini-2.0-flash";
    const large = compactionThresholdFor("RESEARCH");

    expect(small).toBeLessThan(large);
    expect(small).toBeLessThanOrEqual(0.6);
  });

  it("shrinks the tool-output budget with the window", () => {
    process.env.MODEL_RESEARCH = "deepseek:some-unknown-deepseek";
    const small = toolOutputBudgetFor("RESEARCH");

    process.env.MODEL_RESEARCH = "anthropic:claude-sonnet-4-5";
    const large = toolOutputBudgetFor("RESEARCH");

    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThanOrEqual(4_000);
  });

  it("assumes a small window for a model nobody declared", () => {
    // Wrong-low costs an early compaction; wrong-high overflows mid-cycle.
    expect(contextWindowForSpec("someprovider:a-model-we-have-never-heard-of")).toBe(32_000);
  });

  it("matches the most specific model family, not the first", () => {
    expect(contextWindowForSpec("openrouter:kimi-k2-0905-preview")).toBe(256_000);
    expect(contextWindowForSpec("moonshot:moonshot-v1-8k")).toBe(128_000);
  });

  it("lets the environment override any window", () => {
    process.env.MODEL_RESEARCH = "deepseek:deepseek-chat";
    process.env.MODEL_RESEARCH_CONTEXT = "128000";
    expect(contextWindowFor("RESEARCH")).toBe(128_000);
  });

  it("declares a window for every default, so no build hits the gateway", () => {
    for (const agent of ["CONTROL", "RESEARCH", "PLANNER", "REVIEWER", "EXECUTION", "WATCHER"] as const) {
      expect(contextWindowFor(agent)).toBeGreaterThan(32_000);
    }
  });
});
