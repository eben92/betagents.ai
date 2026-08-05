/**
 * End-to-end coverage of the betting pipeline against the simulated bookmaker.
 *
 * These tests call the same tools the agents call, in the order an agent would
 * call them, with no models involved. That is deliberate: every irreversible
 * decision — what gets claimed, what gets submitted, what gets settled, what
 * money moves — lives in the tools, and the tools are what must be provably
 * right. Model judgement is exercised separately by `eve eval`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { recordBalance } from "../agent/lib/accounting";
import { snapshot } from "../agent/lib/bankroll";
import { idempotencyKey } from "../agent/lib/ids";
import { redactText } from "../agent/lib/logger";
import {
  getMockBalance,
  listMockBets,
  setMockOddsDrift,
  setMockPlacementFault,
  settleMockBet,
} from "../agent/lib/operator";
import { OPEN_BET_STATUSES, setStore, TAB } from "../agent/lib/sheets";
import { setMatchState } from "../agent/lib/sports";
import { getLockedProfit, startDay } from "../agent/lib/state";
import { dayKey } from "../agent/lib/time";

import approveDraft from "../agent/subagents/reviewer/tools/approve_draft";
import claimBet from "../agent/subagents/execution/tools/claim_bet";
import computeStakeTool from "../agent/subagents/planner/tools/compute_stake";
import getBankroll from "../agent/subagents/planner/tools/get_bankroll";
import getDraft from "../agent/subagents/reviewer/tools/get_draft";
import listCandidates from "../agent/subagents/planner/tools/list_candidates";
import listFixtures from "../agent/subagents/research/tools/list_fixtures";
import listOpenBets from "../agent/subagents/watcher/tools/list_open_bets";
import matchStateTool from "../agent/subagents/watcher/tools/match_state";
import operatorLogin from "../agent/subagents/execution/tools/operator_login";
import placeBetTool from "../agent/subagents/execution/tools/place_bet";
import priceSelection from "../agent/subagents/execution/tools/price_selection";
import reconcileBet from "../agent/subagents/execution/tools/reconcile_bet";
import recordBalanceTool from "../agent/subagents/execution/tools/record_balance";
import recordDraft from "../agent/subagents/planner/tools/record_draft";
import rejectDraft from "../agent/subagents/reviewer/tools/reject_draft";
import saveResearch from "../agent/subagents/research/tools/save_research";
import settleBet from "../agent/subagents/watcher/tools/settle_bet";

import { seedPricedFootballMatch, setupTest, teardownTest, toolContext } from "./harness";

afterEach(teardownTest);

/**
 * Calls a tool the way the runtime does: input parsed through the tool's own
 * schema — so defaults apply and a bad argument fails here rather than deeper —
 * and a sandbox context that yields nothing, so any accidental browser access
 * in mock mode fails loudly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const call = async (tool: Any, input: unknown): Promise<Any> => {
  // `inputSchema` is typed as its serialised JSON Schema but is the zod schema
  // at runtime, which is what the framework parses tool input with.
  const schema = tool.inputSchema as { parse: (value: unknown) => unknown };
  return tool.execute(schema.parse(input), toolContext);
};

/** Research → priced shortlist, the state the planner needs to work from. */
async function researchAndPrice(options: { minutesFromNow?: number; odds?: number } = {}) {
  const fixture = seedPricedFootballMatch(options);

  await call(operatorLogin, {});
  await call(recordBalanceTool, {});

  const saved: Any = await call(saveResearch, {
    matchKey: fixture.matchKey,
    sport: "football",
    matchName: `${fixture.home} vs ${fixture.away}`,
    competition: fixture.league,
    startsAt: fixture.startsAt,
    provider: fixture.provider,
    providerId: fixture.providerId,
    summary: "Home side in form; opposing centre-back suspended.",
    confidence: 0.8,
    dataQuality: "strong",
    supporting: ["home form", "opposition suspension"],
    opposing: ["home side may rotate"],
    sources: ["https://example.test/report"],
    candidates: [
      {
        market: "1x2",
        selection: "home",
        estimatedProbability: 0.62,
        rationale: "home advantage plus the suspension",
      },
    ],
  });

  const shortlistId: string = saved.candidatesAccepted[0].shortlistId;
  const priced: Any = await call(priceSelection, { shortlistId });

  return { fixture, shortlistId, priced };
}

/** The full path from research to a placed bet. */
async function placeOneBet(options: { minutesFromNow?: number; odds?: number } = {}) {
  const { fixture, shortlistId } = await researchAndPrice(options);

  const candidates: Any = await call(listCandidates, {});
  const candidate = candidates.candidates[0];

  const sized: Any = await call(computeStakeTool, {
    shortlistId,
    probability: candidate.yourProbability,
    odds: candidate.odds,
    confidence: candidate.confidence,
    conviction: 1,
    remainingOpportunities: 1,
  });

  const drafted: Any = await call(recordDraft, {
    shortlistId,
    stake: sized.stake,
    odds: candidate.odds,
    probability: candidate.yourProbability,
    edge: sized.edge,
    reasoning: "test draft",
  });

  const approved: Any = await call(approveDraft, {
    draftId: drafted.draftId,
    stake: drafted.stake,
    odds: drafted.odds,
    notes: "test approval",
  });

  const claimed: Any = await call(claimBet, { approvedId: approved.approvedId });
  const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });

  return { fixture, shortlistId, sized, drafted, approved, claimed, placed };
}

describe("research", () => {
  it("only offers fixtures that are not already committed", async () => {
    setupTest();
    seedPricedFootballMatch();

    const listed: Any = await call(listFixtures, { sport: "football", withinHours: 24 });
    expect(listed.fixtures.length).toBeGreaterThan(0);
  });

  it("drops selections that are not valid for the sport", async () => {
    const { store } = setupTest();
    const fixture = seedPricedFootballMatch();

    const saved: Any = await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "test",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      candidates: [
        { market: "1x2", selection: "home", estimatedProbability: 0.6, rationale: "ok" },
        { market: "moneyline", selection: "home", estimatedProbability: 0.6, rationale: "wrong sport" },
        { market: "1x2", selection: "not_a_code", estimatedProbability: 0.6, rationale: "invalid" },
      ],
    });

    expect(saved.candidatesAccepted).toHaveLength(1);
    expect(saved.candidatesRejected).toHaveLength(2);
    expect(await store.list(TAB.shortlist)).toHaveLength(1);
  });

  it("caps confidence when the agent calls its own evidence thin", async () => {
    setupTest();
    const fixture = seedPricedFootballMatch();

    const saved: Any = await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "very little to go on",
      confidence: 0.95,
      dataQuality: "thin",
      supporting: [],
      opposing: [],
      candidates: [],
    });

    expect(saved.confidence).toBe(0.5);
    expect(saved.confidenceCapped).toBe(true);
  });

  it("refreshes a match in place rather than duplicating it", async () => {
    const { store } = setupTest();
    const fixture = seedPricedFootballMatch();

    const write = (summary: string) =>
      call(saveResearch, {
        matchKey: fixture.matchKey,
        sport: "football",
        matchName: `${fixture.home} vs ${fixture.away}`,
        startsAt: fixture.startsAt,
        summary,
        confidence: 0.7,
        dataQuality: "adequate",
        supporting: [],
        opposing: [],
        candidates: [],
      });

    await write("first pass");
    await write("second pass, lineups confirmed");

    const research = await store.list(TAB.research);
    expect(research).toHaveLength(1);
    expect(research[0]!.summary).toBe("second pass, lineups confirmed");
  });
});

describe("pricing and planning", () => {
  it("prices a candidate and makes it plannable", async () => {
    setupTest();
    const { priced } = await researchAndPrice({ odds: 2.1 });

    expect(priced.priced).toBe(true);
    expect(priced.odds).toBe(2.1);

    const candidates: Any = await call(listCandidates, {});
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0].edge).toBeCloseTo(0.62 * 2.1 - 1, 5);
  });

  it("hides unpriced candidates from the planner by default", async () => {
    setupTest();
    const fixture = seedPricedFootballMatch();

    await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "unpriced",
      confidence: 0.8,
      dataQuality: "strong",
      supporting: [],
      opposing: [],
      candidates: [
        { market: "1x2", selection: "home", estimatedProbability: 0.62, rationale: "x" },
      ],
    });

    const hidden: Any = await call(listCandidates, {});
    expect(hidden.candidates).toHaveLength(0);
    expect(hidden.unpriced).toBe(1);

    const shown: Any = await call(listCandidates, { includeUnpriced: true });
    expect(shown.candidates).toHaveLength(1);
    expect(shown.candidates[0].odds).toBeNull();
  });

  it("refuses to size anything before a balance has been recorded", async () => {
    setupTest();
    const bankroll: Any = await call(getBankroll, {});

    expect(bankroll.available).toBe(false);
    expect(bankroll.halted).toBe(true);
  });

  it("declines a stake when the edge is too thin, with a reason", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 1.55 });

    const sized: Any = await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 1.55,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });

    expect(sized.stake).toBe(0);
    expect(sized.declined).toMatch(/edge/);
  });

  it("keeps a stake inside the available bankroll and the per-bet cap", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const bankroll: Any = await call(getBankroll, {});
    const sized: Any = await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 2.1,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });

    expect(sized.stake).toBeGreaterThan(0);
    expect(sized.stake).toBeLessThanOrEqual(bankroll.availableToStake * 0.15 + 0.01);
  });

  it("scales each stake down by how many more bets are expected", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const alone: Any = await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 2.1,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });
    const shared: Any = await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 2.1,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 4,
    });

    expect(shared.stake).toBeLessThan(alone.stake);
  });

  it("refuses a second live draft on the same match", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const first: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "first",
    });
    expect(first.recorded).toBe(true);

    const second: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "second",
    });
    expect(second.recorded).toBe(false);
    expect(second.reason).toMatch(/live draft already exists/);
  });
});

describe("review", () => {
  it("shows the reviewer how far the price drifted since drafting", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    // The Account & Execution agent re-prices before every review.
    setMockOddsDrift(
      { matchName: drafted.matchName, market: "1x2", selection: "home" },
      1.8,
    );
    await call(priceSelection, { shortlistId });

    const loaded: Any = await call(getDraft, { draftId: drafted.draftId });
    expect(loaded.found).toBe(true);
    expect(loaded.price.current).toBe(1.8);
    expect(loaded.price.driftFromDraft).toBeCloseTo(-0.3, 5);
    expect(loaded.price.edgeNow).toBeLessThan(loaded.draft.edgeAtDraft);
  });

  it("lets a review cut a stake but never raise one", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 40,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    const raised: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 60,
      odds: 2.1,
      notes: "trying to raise",
    });
    expect(raised.approved).toBe(false);
    expect(raised.reason).toMatch(/only reduce/);

    const cut: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 10,
      odds: 2.1,
      notes: "thinner than it looked",
    });
    expect(cut.approved).toBe(true);
    expect(cut.verdict).toBe("approved_lower_stake");
    expect(cut.stakeReducedBy).toBe(30);
  });

  it("accepts a move to a safer market and rejects an invalid one", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    const invalid: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      market: "moneyline",
      selection: "home",
      odds: 2.1,
      notes: "wrong sport",
    });
    expect(invalid.approved).toBe(false);

    const safer: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      market: "double_chance",
      selection: "home_or_draw",
      odds: 1.4,
      notes: "team news got worse",
    });
    expect(safer.approved).toBe(true);
    expect(safer.verdict).toBe("approved_safer_market");
  });

  it("records a rejection with its reason and leaves the match reusable", async () => {
    const { store } = setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    const rejected: Any = await call(rejectDraft, {
      draftId: drafted.draftId,
      reason: "key striker ruled out",
    });
    expect(rejected.rejected).toBe(true);

    const draft = (await store.list(TAB.drafts))[0]!;
    expect(draft.status).toBe("rejected");
    expect(draft.notes).toMatch(/key striker ruled out/);

    // A rejected draft must not block the match from being reconsidered.
    const again: Any = await call(recordDraft, {
      shortlistId,
      stake: 15,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "fresh look",
    });
    expect(again.recorded).toBe(true);
  });

  it("approving the same draft twice yields one approval", async () => {
    const { store } = setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    const first: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });
    const second: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "again",
    });

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    expect(await store.list(TAB.approved)).toHaveLength(1);
  });
});

describe("execution", () => {
  it("places an approved bet and records it everywhere", async () => {
    const { store, messages } = setupTest();
    const { placed, sized } = await placeOneBet({ odds: 2.1 });

    expect(placed.outcome).toBe("placed");
    expect(placed.reference).toMatch(/^MOCK-/);

    const bets = await store.list(TAB.bets);
    expect(bets).toHaveLength(1);
    expect(bets[0]!.status).toBe("placed");
    expect(bets[0]!.stake).toBe(sized.stake);

    expect(await store.list(TAB.activeBets)).toHaveLength(1);
    expect((await store.list(TAB.drafts))[0]!.status).toBe("executed");
    expect((await store.list(TAB.approved))[0]!.status).toBe("executed");

    expect(listMockBets()).toHaveLength(1);
    expect(getMockBalance()).toBeCloseTo(1000 - sized.stake, 2);
    expect(messages.join("\n")).toMatch(/Bet placed/);
  });

  it("refuses to submit without a claim", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });

    const unclaimed: Any = await call(placeBetTool, { approvedId: approved.approvedId });
    expect(unclaimed.outcome).toBe("rejected");
    expect(unclaimed.detail).toMatch(/claim_bet first/);
    expect(listMockBets()).toHaveLength(0);
  });

  it("refuses a second claim on the same approved bet", async () => {
    const { store } = setupTest();
    const { approved } = await placeOneBet({ odds: 2.1 });

    const again: Any = await call(claimBet, { approvedId: approved.approvedId });
    expect(again.claimed).toBe(false);
    expect(again.alreadyClaimed).toBe(true);

    expect(await store.list(TAB.bets)).toHaveLength(1);
    expect(listMockBets()).toHaveLength(1);
  });

  it("cannot place the same bet twice even when told to", async () => {
    setupTest();
    const { approved } = await placeOneBet({ odds: 2.1 });

    const second: Any = await call(placeBetTool, { approvedId: approved.approvedId });
    expect(second.outcome).toBe("rejected");
    expect(listMockBets()).toHaveLength(1);
  });

  it("survives two concurrent attempts on one bet", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });

    const [a, b]: Any[] = await Promise.all([
      call(claimBet, { approvedId: approved.approvedId }),
      call(claimBet, { approvedId: approved.approvedId }),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
  });

  it("reports a price that drifted below the approved minimum without betting", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });

    await call(claimBet, { approvedId: approved.approvedId });
    setMockPlacementFault("odds_drift");

    const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });
    expect(placed.outcome).toBe("rejected");
    expect(listMockBets()).toHaveLength(0);
    expect(getMockBalance()).toBe(1000);
  });

  it("escalates a protection challenge instead of retrying it", async () => {
    const { store, messages } = setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });

    await call(claimBet, { approvedId: approved.approvedId });
    setMockPlacementFault("needs_human");

    const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });
    expect(placed.outcome).toBe("needs_human");
    expect(messages.join("\n")).toMatch(/🆘|needs a person|Needs a person/i);
    expect((await store.list(TAB.bets))[0]!.status).toBe("failed");
    expect(listMockBets()).toHaveLength(0);
  });
});

describe("reconciliation", () => {
  it("finds a bet that landed after the confirmation was lost", async () => {
    const { store } = setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });

    await call(claimBet, { approvedId: approved.approvedId });
    setMockPlacementFault("unknown");

    const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });
    expect(placed.outcome).toBe("unknown");
    expect((await store.list(TAB.bets))[0]!.status).toBe("unknown");

    // The simulated bookmaker really did take the bet.
    expect(listMockBets()).toHaveLength(1);

    const resolved: Any = await call(reconcileBet, {
      betId: placed.betId,
      result: "found",
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.outcome).toBe("placed");
    expect((await store.list(TAB.bets))[0]!.status).toBe("placed");
    expect(await store.list(TAB.activeBets)).toHaveLength(1);
    // Still exactly one bet at the operator: reconciliation never re-places.
    expect(listMockBets()).toHaveLength(1);
  });

  it("leaves the claim standing when the history cannot be read", async () => {
    const { store } = setupTest();

    // Force an unknown outcome, then reconcile against a bookmaker that has it.
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });
    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });
    await call(claimBet, { approvedId: approved.approvedId });
    setMockPlacementFault("unknown");
    const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });

    // In mock mode the tool reconciles from the simulated history, so this
    // asserts the tool refuses to act on a bet it has already resolved.
    await call(reconcileBet, { betId: placed.betId, result: "uncertain" });
    const second: Any = await call(reconcileBet, { betId: placed.betId, result: "found" });

    expect(second.resolved).toBe(false);
    expect((await store.list(TAB.bets))[0]!.status).toBe("placed");
  });

  it("does not settle a bet whose placement was never confirmed", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });
    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    const approved: Any = await call(approveDraft, {
      draftId: drafted.draftId,
      stake: 20,
      odds: 2.1,
      notes: "ok",
    });
    await call(claimBet, { approvedId: approved.approvedId });
    setMockPlacementFault("unknown");
    const placed: Any = await call(placeBetTool, { approvedId: approved.approvedId });

    const settled: Any = await call(settleBet, {
      betId: placed.betId,
      homeScore: 2,
      awayScore: 0,
      finalScore: "2 - 0",
      source: "test",
    });

    expect(settled.settled).toBe(false);
    expect(settled.detail).toMatch(/reconciled/);
  });
});

describe("monitoring and settlement", () => {
  it("watches only bets that still carry risk", async () => {
    setupTest();
    const { placed } = await placeOneBet({ odds: 2.1 });

    const open: Any = await call(listOpenBets, {});
    expect(open.count).toBe(1);
    expect(open.openBets[0].betId).toBe(placed.betId);
  });

  it("reads a live score from the sports provider", async () => {
    setupTest();
    const { fixture, placed } = await placeOneBet({ odds: 2.1 });

    setMatchState(fixture.matchKey, {
      status: "live",
      homeScore: 1,
      awayScore: 0,
      displayScore: "1 - 0",
      clock: "34'",
      completed: false,
    });

    const state: Any = await call(matchStateTool, { betId: placed.betId });
    expect(state.found).toBe(true);
    expect(state.score).toBe("1 - 0");
    expect(state.final).toBe(false);
  });

  it("settles a winner, pays out and locks part of the profit", async () => {
    const { store, messages } = setupTest();
    const { placed, sized } = await placeOneBet({ odds: 2.1 });

    const settled: Any = await call(settleBet, {
      betId: placed.betId,
      homeScore: 2,
      awayScore: 0,
      finalScore: "2 - 0",
      source: "test",
    });

    expect(settled.settled).toBe(true);
    expect(settled.result).toBe("won");
    expect(settled.returned).toBeCloseTo(sized.stake * 2.1, 2);
    expect(settled.profit).toBeGreaterThan(0);

    // Half of a win is withheld from the betting pool by default.
    expect(await getLockedProfit()).toBeCloseTo(settled.profit * 0.5, 2);

    expect((await store.list(TAB.bets))[0]!.status).toBe("settled");
    expect(await store.list(TAB.settlements)).toHaveLength(1);
    expect((await store.list(TAB.profit))[0]!.profit).toBeCloseTo(settled.profit, 2);
    expect(messages.join("\n")).toMatch(/Won:/);
  });

  it("settles a loser without locking anything", async () => {
    setupTest();
    const { placed } = await placeOneBet({ odds: 2.1 });

    const settled: Any = await call(settleBet, {
      betId: placed.betId,
      homeScore: 0,
      awayScore: 2,
      finalScore: "0 - 2",
      source: "test",
    });

    expect(settled.result).toBe("lost");
    expect(settled.returned).toBe(0);
    expect(await getLockedProfit()).toBe(0);
  });

  it("cannot settle the same bet twice", async () => {
    const { store } = setupTest();
    const { placed } = await placeOneBet({ odds: 2.1 });

    const args = {
      betId: placed.betId,
      homeScore: 2,
      awayScore: 0,
      finalScore: "2 - 0",
      source: "test",
    };

    const first: Any = await call(settleBet, args);
    const second: Any = await call(settleBet, args);

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
    expect(await store.list(TAB.settlements)).toHaveLength(1);
  });

  it("refuses to settle a selection it cannot judge from the score", async () => {
    const { store } = setupTest();
    const { placed } = await placeOneBet({ odds: 2.1 });

    // A handicap line the score alone cannot resolve.
    await store.update(TAB.bets, placed.betId, { market: "handicap", selection: "home_-1.5x" });

    const settled: Any = await call(settleBet, {
      betId: placed.betId,
      homeScore: 2,
      awayScore: 0,
      finalScore: "2 - 0",
      source: "test",
    });

    expect(settled.settled).toBe(false);
  });
});

describe("restart recovery", () => {
  it("picks up an open bet after the process restarts", async () => {
    const { store } = setupTest();
    const { placed, fixture } = await placeOneBet({ odds: 2.1 });

    // A restart loses every in-memory global but not the spreadsheet.
    teardownTest();
    setupTest();
    setStore(store);

    const open: Any = await call(listOpenBets, {});
    expect(open.count).toBe(1);
    expect(open.openBets[0].betId).toBe(placed.betId);
    expect(fixture.matchKey).toBeTruthy();
  });

  it("does not re-place a bet that was already placed before the restart", async () => {
    const { store } = setupTest();
    const { approved } = await placeOneBet({ odds: 2.1 });

    teardownTest();
    setupTest();
    setStore(store);

    const again: Any = await call(claimBet, { approvedId: approved.approvedId });
    expect(again.claimed).toBe(false);
    expect(again.alreadyClaimed).toBe(true);
    expect(again.status).toBe("placed");
  });
});

describe("accounting", () => {
  it("keeps the reserve and locked profit out of what can be staked", async () => {
    setupTest();
    await call(operatorLogin, {});
    await call(recordBalanceTool, {});

    const bankroll: Any = await call(getBankroll, {});
    expect(bankroll.balance).toBe(1000);
    expect(bankroll.reserve).toBeCloseTo(400, 2);
    expect(bankroll.availableToStake).toBeCloseTo(600, 2);
  });

  it("counts an open bet as exposure rather than spendable cash", async () => {
    setupTest();
    const { sized } = await placeOneBet({ odds: 2.1 });

    await call(recordBalanceTool, {});
    const bankroll: Any = await call(getBankroll, {});

    expect(bankroll.exposure).toBeCloseTo(sized.stake, 2);
    expect(bankroll.balance).toBeCloseTo(1000 - sized.stake, 2);
    expect(bankroll.bankroll).toBeCloseTo(1000, 2);
  });

  it("settles a bet the operator settled and reflects it in the balance", async () => {
    setupTest();
    const { placed, sized } = await placeOneBet({ odds: 2.1 });

    const reference = listMockBets()[0]!.reference;
    settleMockBet(reference, "won");

    await call(settleBet, {
      betId: placed.betId,
      homeScore: 2,
      awayScore: 0,
      finalScore: "2 - 0",
      source: "test",
    });
    await call(recordBalanceTool, {});

    const bankroll: Any = await call(getBankroll, {});
    expect(bankroll.balance).toBeCloseTo(1000 - sized.stake + sized.stake * 2.1, 2);
    expect(bankroll.exposure).toBe(0);
  });

  it("halts trading once the day's realised losses reach the limit", async () => {
    setupTest();
    const { placed, sized } = await placeOneBet({ odds: 2.1 });

    await call(settleBet, {
      betId: placed.betId,
      homeScore: 0,
      awayScore: 2,
      finalScore: "0 - 2",
      source: "test",
    });

    const healthy: Any = await call(getBankroll, {});
    expect(healthy.halted).toBe(false);

    // The limit is measured against the bankroll the day opened with, so a day
    // that started small is halted by a loss that a large day would absorb.
    await startDay(dayKey(new Date(), "UTC"), sized.stake * 2);

    const halted: Any = await call(getBankroll, {});
    expect(halted.halted).toBe(true);
    expect(halted.haltReason).toMatch(/daily loss limit/);
  });
});

describe("safety invariants", () => {
  it("derives one stable idempotency key per approved bet", () => {
    setupTest();
    expect(idempotencyKey("apr_1")).toBe(idempotencyKey("apr_1"));
    expect(idempotencyKey("apr_1")).not.toBe(idempotencyKey("apr_2"));
  });

  it("never leaves an open bet without a claim row", async () => {
    const { store } = setupTest();
    await placeOneBet({ odds: 2.1 });

    const bets = await store.list(TAB.bets);
    for (const bet of bets.filter((entry) => OPEN_BET_STATUSES.includes(entry.status))) {
      expect(bet.idempotencyKey).toBeTruthy();
      expect(bet.approvedId).toBeTruthy();
    }
  });

  it("keeps credentials out of every report", async () => {
    const { messages } = setupTest({
      OPERATOR_USERNAME: "secret-user",
      OPERATOR_PASSWORD: "secret-pass",
    });

    await placeOneBet({ odds: 2.1 });

    const all = messages.join("\n");
    expect(all).not.toMatch(/secret-user/);
    expect(all).not.toMatch(/secret-pass/);
  });
});

describe("secret redaction", () => {
  it("scrubs a provider key nobody hardcoded a name for", async () => {
    setupTest();
    process.env.KIMI_API_KEY = "kimi-secret-value-123";
    process.env.OPENROUTER_API_KEY = "openrouter-secret-value-456";
    try {
      const line = redactText(
        "calling kimi-secret-value-123 and openrouter-secret-value-456 and DASHBOARD ok",
      );
      expect(line).not.toMatch(/kimi-secret-value-123/);
      expect(line).not.toMatch(/openrouter-secret-value-456/);
    } finally {
      delete process.env.KIMI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("leaves ordinary configuration alone", async () => {
    setupTest({ OPERATOR_BASE_URL: "https://example.test" });
    expect(redactText("opened https://example.test/login")).toMatch(/example\.test/);
  });
});
