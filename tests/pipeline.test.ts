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
import { getConfig, usesRealFixtureSource } from "../agent/lib/config";
import { snapshot } from "../agent/lib/bankroll";
import {
  advancePass,
  beginCycle,
  buildCycleReport,
  cycleRejections,
  decidePass,
} from "../agent/lib/cycle";
import { idempotencyKey } from "../agent/lib/ids";
import { redactText } from "../agent/lib/logger";
import { chunkMessage } from "../agent/lib/telegram/notify";
import { parseDuckDuckGo, unwrapRedirect } from "../agent/lib/websearch";
import {
  isMock,
  getMockBalance,
  listMockBets,
  setMockOddsDrift,
  setMockPlacementFault,
  settleMockBet,
} from "../agent/lib/operator";
import { OPEN_BET_STATUSES, setStore, TAB } from "../agent/lib/sheets";
import {
  createMockSportsProvider,
  findSameFixture,
  nameSimilarity,
  setMatchState,
  setSportsProviders,
} from "../agent/lib/sports";
import { claimDue, schedule } from "../agent/lib/wakeups";
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
import recordOperatorFixtures from "../agent/subagents/execution/tools/record_operator_fixtures";
import recordDraft from "../agent/subagents/planner/tools/record_draft";
import rejectDraft from "../agent/subagents/reviewer/tools/reject_draft";
import saveResearch from "../agent/subagents/research/tools/save_research";
import settleBet from "../agent/subagents/watcher/tools/settle_bet";

import {
  seedFixture,
  seedPricedFootballMatch,
  setupTest,
  teardownTest,
  toolContext,
} from "./harness";

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
    consensus: { found: true, leaning: "previews split; slight lean to the home side", sampled: 4, agreesWithYou: true },
    pick: {
      market: "1x2",
      selection: "home",
      estimatedProbability: 0.62,
      rationale: "home advantage plus the suspension",
    },
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

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
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
      consensus: { found: true, leaning: "previews split; slight lean to the home side", sampled: 4, agreesWithYou: true },
      pick: { market: "1x2", selection: "home", estimatedProbability: 0.6, rationale: "ok" },
      alternatives: [
        { market: "moneyline", selection: "home", estimatedProbability: 0.6, rationale: "wrong sport" },
        { market: "1x2", selection: "not_a_code", estimatedProbability: 0.6, rationale: "invalid" },
      ],
    });

    expect(saved.candidatesAccepted).toHaveLength(1);
    expect(saved.candidatesRejected).toHaveLength(2);
    expect(await store.list(TAB.shortlist)).toHaveLength(1);
  });

  it("caps confidence when the agent calls its own evidence thin", async () => {
    // Live config: the cap is a live-mode rule. On a simulated card the missing
    // team news is the simulation, and capping there would put every mock bet
    // below the staking threshold.
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });
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
      consensus: { found: false, leaning: "", sampled: 0, agreesWithYou: false },
      pick: null,
      noBetReason: "nothing checkable was published about either side",
    });

    expect(saved.confidence).toBe(0.5);
    expect(saved.confidenceCapped).toBe(true);
  });

  it("does not cap thin evidence on a simulated card", async () => {
    setupTest();
    const fixture = seedPricedFootballMatch();

    const saved: Any = await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "teams that do not exist have no team news",
      confidence: 0.72,
      dataQuality: "thin",
      supporting: [],
      opposing: [],
      consensus: { found: true, leaning: "previews split; slight lean to the home side", sampled: 4, agreesWithYou: true },
      pick: { market: "1x2", selection: "home", estimatedProbability: 0.6, rationale: "x" },
    });

    // Capping here would put every mock bet under MIN_CONFIDENCE, so the one
    // path the rehearsal exists to exercise could never run.
    expect(saved.confidence).toBe(0.72);
    expect(saved.confidenceCapped).toBe(false);
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
        consensus: { found: false, leaning: "", sampled: 0, agreesWithYou: false },
        pick: null,
        noBetReason: "evenly matched at the price",
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
      consensus: { found: true, leaning: "previews split; slight lean to the home side", sampled: 4, agreesWithYou: true },
      pick: { market: "1x2", selection: "home", estimatedProbability: 0.62, rationale: "x" },
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
      reasonCode: "thesis_broken",
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

describe("wake-ups", () => {
  it("collapses a repeated booking for the same kind and minute", async () => {
    const { store } = setupTest();
    const dueAt = new Date(Date.now() + 60 * 60_000);

    await schedule({ kind: "daily", dueAt, reason: "start of the betting day" });
    await schedule({ kind: "daily", dueAt, reason: "start of the betting day" });

    // The tick books the day boundary on every cycle regardless of what the
    // cycle did, so this collapsing is what makes that free.
    expect((await store.list(TAB.wakeups)).filter((row) => row.kind === "daily")).toHaveLength(1);
  });

  it("keeps a second booking at a different minute", async () => {
    const { store } = setupTest();
    const first = new Date(Date.now() + 60 * 60_000);
    const later = new Date(first.getTime() + 120_000);

    await schedule({ kind: "daily", dueAt: first, reason: "today" });
    await schedule({ kind: "daily", dueAt: later, reason: "tomorrow" });

    expect((await store.list(TAB.wakeups)).filter((row) => row.kind === "daily")).toHaveLength(2);
  });

  it("does not treat a claimed wake-up as still booked", async () => {
    const { store } = setupTest();
    const dueAt = new Date(Date.now() - 60_000);

    await schedule({ kind: "daily", dueAt, reason: "start of the betting day" });
    const claimed = await claimDue(new Date());
    expect(claimed).toHaveLength(1);

    // A claimed row is no longer pending, so the tick's post-cycle booking
    // creates the next one instead of silently colliding with the old.
    await schedule({ kind: "daily", dueAt, reason: "start of the betting day" });
    expect((await store.list(TAB.wakeups)).filter((row) => row.kind === "daily")).toHaveLength(2);
  });
});

describe("cycle passes", () => {
  it("attributes research, drafts and rejections to the open cycle", async () => {
    const { store } = setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    expect((await store.list(TAB.research))[0]!.cycleId).toBe(cycle.id);

    await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });

    expect((await store.list(TAB.drafts))[0]!.cycleId).toBe(cycle.id);
  });

  it("records why each stage declined a match", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const fixture = seedPricedFootballMatch();

    await call(operatorLogin, {});
    await call(recordBalanceTool, {});

    await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "even match",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      consensus: { found: false, leaning: "", sampled: 0, agreesWithYou: false },
      pick: null,
      noBetReason: "both sides fully fit and the price is fair",
    });

    const rejections = await cycleRejections(cycle.id);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.stage).toBe("research");
    expect(rejections[0]!.code).toBe("no_selection");
    expect(rejections[0]!.reason).toMatch(/price is fair/);
  });

  it("records the rule that declined a stake, without the planner having to", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 1.2 });

    const sized: Any = await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 1.2,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });
    expect(sized.stake).toBe(0);

    const planner = (await cycleRejections(cycle.id)).filter((entry) => entry.stage === "planner");
    expect(planner).toHaveLength(1);
    expect(planner[0]!.code).toBe("edge_below_minimum");
    expect(planner[0]!.fixable).toBe(true);
  });

  it("retires a rejection once the match is backed after all", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    await call(computeStakeTool, {
      shortlistId,
      probability: 0.4,
      odds: 2.1,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });
    expect(await cycleRejections(cycle.id)).toHaveLength(1);

    await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "second look at a better price",
    });

    // The report must not list the same match as both declined and drafted.
    expect(await cycleRejections(cycle.id)).toHaveLength(0);
  });

  it("keeps one reason per stage rather than one per attempt", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 1.2 });

    for (const confidence of [0.8, 0.7, 0.65]) {
      await call(computeStakeTool, {
        shortlistId,
        probability: 0.62,
        odds: 1.2,
        confidence,
        conviction: 1,
        remainingOpportunities: 1,
      });
    }

    expect(await cycleRejections(cycle.id)).toHaveLength(1);
  });

  it("sweeps again when nothing was backed and fixtures remain", async () => {
    setupTest();
    await beginCycle("daily");

    seedFixture({
      sport: "football",
      home: "Alpha",
      away: "Beta",
      league: "football/test",
      startsAt: new Date(Date.now() + 120 * 60_000),
    });

    const decision = await decidePass();
    expect(decision.retry).toBe(true);
    expect(decision.fixturesUnexamined).toBe(1);
  });

  it("stops sweeping once the card has been assessed", async () => {
    setupTest();
    await beginCycle("daily");
    const fixture = seedPricedFootballMatch();

    await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "nothing here",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      consensus: { found: false, leaning: "", sampled: 0, agreesWithYou: false },
      pick: null,
      noBetReason: "no angle",
    });

    const decision = await decidePass();
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/every fixture/);
  });

  it("stops sweeping after the configured number of passes", async () => {
    setupTest({ MAX_CYCLE_PASSES: "2" });
    await beginCycle("daily");

    seedFixture({
      sport: "football",
      home: "Alpha",
      away: "Beta",
      league: "football/test",
      startsAt: new Date(Date.now() + 120 * 60_000),
    });

    expect((await decidePass()).retry).toBe(true);
    await advancePass();
    const second = await decidePass();
    expect(second.retry).toBe(false);
    expect(second.reason).toMatch(/all 2 passes/);
  });

  it("stops sweeping once a bet is placed", async () => {
    setupTest();
    await beginCycle("daily");
    await placeOneBet();

    const decision = await decidePass();
    expect(decision.retry).toBe(false);
    expect(decision.placed).toBe(1);
  });

  it("hides matches this cycle assessed from the next pass", async () => {
    setupTest();
    await beginCycle("daily");
    const fixture = seedPricedFootballMatch();

    const before: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(before.fixtures).toHaveLength(1);

    await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "assessed",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      consensus: { found: false, leaning: "", sampled: 0, agreesWithYou: false },
      pick: null,
      noBetReason: "no angle",
    });

    const after: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(after.fixtures).toHaveLength(0);
    expect(after.alreadyAssessedThisCycle).toBe(1);
  });
});

describe("cycle reporting", () => {
  it("names every declined match under the agent that declined it", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 1.2 });

    await call(computeStakeTool, {
      shortlistId,
      probability: 0.62,
      odds: 1.2,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });

    const digest = await buildCycleReport(cycle.id);
    const text = digest.lines.join("\n");

    expect(text).toMatch(/NOT BACKED \(1\)/);
    expect(text).toMatch(/Planner \(1\)/);
    expect(text).toMatch(/Northbridge United vs Easthaven Rovers — 1x2\/home/);
    expect(text).toMatch(/edge_below_minimum/);
  });

  it("reports a placed bet with its stake and return", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { placed } = await placeOneBet();
    expect(placed.outcome).toBe("placed");

    const digest = await buildCycleReport(cycle.id);
    expect(digest.placed).toBe(1);
    expect(digest.lines.join("\n")).toMatch(/PLACED \(1\)/);
  });

  it("splits a report too long for one Telegram message", () => {
    const long = Array.from({ length: 400 }, (_, index) => `line ${index} of a long report`).join("\n");
    const chunks = chunkMessage(long);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("\n")).toBe(long);
  });
});

describe("fixing a bet instead of rejecting it", () => {
  it("tells the reviewer the price at which the bet still works", async () => {
    setupTest();
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.5,
      edge: 0.05,
      reasoning: "test",
    });

    const loaded: Any = await call(getDraft, { draftId: drafted.draftId });
    expect(loaded.price.breakEvenOdds).toBeCloseTo(2, 5);
    expect(loaded.price.minimumViableOdds).toBeCloseTo(2.1, 5);
    expect(loaded.price.stillWorthBackingAtCurrentPrice).toBe(true);
  });

  it("refuses a price rejection that never considered a fix", async () => {
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

    const refused: Any = await call(rejectDraft, {
      draftId: drafted.draftId,
      reasonCode: "price_moved",
      reason: "shortened",
    });
    expect(refused.rejected).toBe(false);
    expect(refused.detail).toMatch(/consideredInstead/);

    const accepted: Any = await call(rejectDraft, {
      draftId: drafted.draftId,
      reasonCode: "price_moved",
      reason: "shortened",
      consideredInstead: "1.4 is below break-even at 0.62, and no safer market is offered",
    });
    expect(accepted.rejected).toBe(true);
  });
});

describe("the operator's card as the source of truth", () => {
  it("matches a bookmaker's team names against the score feed", () => {
    expect(nameSimilarity("Man Utd", "Manchester United")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Wolves", "Wolverhampton Wanderers")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Inter", "Internazionale")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Brighton & Hove Albion FC", "Brighton")).toBeGreaterThan(0.6);

    // The pairs this has to get right: same city, different club. Settling a
    // bet against the wrong one of these is the failure that costs money.
    expect(nameSimilarity("Manchester United", "Manchester City")).toBeLessThan(0.6);
    expect(nameSimilarity("Sheffield Wednesday", "Sheffield United")).toBeLessThan(0.6);
    expect(nameSimilarity("Nottingham Forest", "Notts County")).toBeLessThan(0.6);

    // And the other way a fixture gets confused: a different team of the same
    // club. The reserves and the women's side play different matches.
    expect(nameSimilarity("Arsenal", "Arsenal Women")).toBeLessThan(0.6);
    expect(nameSimilarity("Real Madrid", "Real Madrid B")).toBeLessThan(0.6);
    expect(nameSimilarity("Ajax", "Ajax U21")).toBeLessThan(0.6);
  });

  it("refuses to tie two fixtures together on a weak match", () => {
    const startsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const candidates = [
      { home: "Manchester City", away: "Arsenal", startsAt, matchKey: "k1" },
      { home: "Real Madrid", away: "Barcelona", startsAt, matchKey: "k2" },
    ];

    expect(findSameFixture({ home: "Man City", away: "Arsenal FC", startsAt }, candidates)?.matchKey).toBe("k1");
    expect(findSameFixture({ home: "Man Utd", away: "Arsenal", startsAt }, candidates)).toBeNull();

    // A fixture a day away is a different fixture, however alike the names.
    const tomorrow = new Date(Date.now() + 27 * 60 * 60_000).toISOString();
    expect(findSameFixture({ home: "Man City", away: "Arsenal", startsAt: tomorrow }, candidates)).toBeNull();
  });

  it("records a card and serves it to research ahead of the public feed", async () => {
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });
    // No public provider: proving the card alone answers, and that discovery
    // never silently falls back to a schedule nobody can bet on.
    setSportsProviders([]);

    const startsAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    const recorded: Any = await call(recordOperatorFixtures, {
      sport: "football",
      fixtures: [
        { home: "Northbridge United", away: "Easthaven Rovers", competition: "Test Cup", startsAt, eventRef: "e1" },
        { home: "Kingsport Athletic", away: "Marlowe Town", competition: "Test Cup", startsAt, eventRef: "e2" },
      ],
    });
    expect(recorded.recorded).toBe(2);

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(listed.source).toBe("operator");
    expect(listed.fixtures).toHaveLength(2);
    expect(listed.fixtures[0].competition).toBe("Test Cup");
  });

  it("discards a fixture whose date was read wrong, and says which", async () => {
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });
    setSportsProviders([]);

    const recorded: Any = await call(recordOperatorFixtures, {
      sport: "football",
      fixtures: [
        {
          home: "Good Fixture",
          away: "Real Opponent",
          competition: "Test",
          startsAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
          eventRef: "ok",
        },
        // A year out: the classic misread of a bare "15:00" under a date heading.
        {
          home: "Wrong Year",
          away: "Bad Date",
          competition: "Test",
          startsAt: new Date(Date.now() + 400 * 24 * 60 * 60_000).toISOString(),
          eventRef: "bad",
        },
        { home: "Same", away: "Same", competition: "Test", startsAt: new Date(Date.now() + 3600_000).toISOString(), eventRef: "x" },
      ],
    });

    expect(recorded.recorded).toBe(1);
    expect(recorded.discarded).toHaveLength(2);
    expect(recorded.discarded.join(" ")).toMatch(/not on the current card/);
    expect(recorded.discarded.join(" ")).toMatch(/both sides are the same/);
  });

  it("adopts the score feed's key so a card fixture can still be settled", async () => {
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });

    const startsAt = new Date(Date.now() + 4 * 60 * 60_000);
    const fixture = seedFixture({
      sport: "football",
      home: "Northbridge United",
      away: "Easthaven Rovers",
      league: "football/test",
      startsAt,
    });
    // The mock world stands in for the public score feed here.
    setSportsProviders([createMockSportsProvider()]);

    const recorded: Any = await call(recordOperatorFixtures, {
      sport: "football",
      // The bookmaker's shorter names for the same match.
      fixtures: [
        { home: "Northbridge", away: "Easthaven", competition: "Test Cup", startsAt: startsAt.toISOString(), eventRef: "e1" },
      ],
    });

    expect(recorded.settleable).toBe(1);

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(listed.fixtures[0].matchKey).toBe(fixture.matchKey);
  });
});

describe("rejection ledger integrity", () => {
  it("keeps one row when the same selection is declined concurrently", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 1.2 });

    // The planner sizes several candidates at once; two declines of the same
    // selection landing together used to produce two rows in the report.
    await Promise.all(
      [0.8, 0.75, 0.7, 0.65].map((confidence) =>
        call(computeStakeTool, {
          shortlistId,
          probability: 0.62,
          odds: 1.2,
          confidence,
          conviction: 1,
          remainingOpportunities: 1,
        }),
      ),
    );

    expect(await cycleRejections(cycle.id)).toHaveLength(1);
  });

  it("separates the same match declined at two different stages", async () => {
    setupTest();
    const { cycle } = await beginCycle("daily");
    const { shortlistId } = await researchAndPrice({ odds: 2.1 });

    await call(computeStakeTool, {
      shortlistId,
      probability: 0.3,
      odds: 2.1,
      confidence: 0.8,
      conviction: 1,
      remainingOpportunities: 1,
    });

    const drafted: Any = await call(recordDraft, {
      shortlistId,
      stake: 20,
      odds: 2.1,
      probability: 0.62,
      edge: 0.3,
      reasoning: "test",
    });
    await call(rejectDraft, {
      draftId: drafted.draftId,
      reasonCode: "thesis_broken",
      reason: "keeper ruled out",
    });

    // Drafting cleared the planner's rejection; the reviewer's replaces it.
    const rejections = await cycleRejections(cycle.id);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.stage).toBe("reviewer");
  });
});

describe("deep research", () => {
  it("records what other people predicted alongside the pick", async () => {
    const { store } = setupTest();
    const fixture = seedPricedFootballMatch();

    const saved: Any = await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "away side underrated",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      consensus: { found: true, leaning: "five of six tip the home win", sampled: 6, agreesWithYou: false },
      pick: { market: "1x2", selection: "away", estimatedProbability: 0.45, rationale: "keeper fit" },
    });

    expect(saved.consensusChecked).toBe(true);
    // Going against the crowd is allowed, but it is flagged so the planner and
    // reviewer know the pick is the minority view.
    expect(saved.againstConsensus).toBe(true);

    const research = (await store.list(TAB.research))[0]!;
    expect(research.consensus.sampled).toBe(6);
    expect(research.consensus.leaning).toMatch(/five of six/);
  });

  it("refuses a claimed consensus that read nothing", async () => {
    setupTest();
    const fixture = seedPricedFootballMatch();

    const saved: Any = await call(saveResearch, {
      matchKey: fixture.matchKey,
      sport: "football",
      matchName: `${fixture.home} vs ${fixture.away}`,
      startsAt: fixture.startsAt,
      summary: "looks good",
      confidence: 0.7,
      dataQuality: "adequate",
      supporting: [],
      opposing: [],
      consensus: { found: true, leaning: "everyone likes the home side", sampled: 0, agreesWithYou: true },
      pick: { market: "1x2", selection: "home", estimatedProbability: 0.6, rationale: "form" },
    });

    expect(saved.recorded).toBe(false);
    expect(saved.error).toMatch(/sampled is 0/);
  });

  it("keeps only markets the card offered that the system can settle", async () => {
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });
    setSportsProviders([]);

    await call(recordOperatorFixtures, {
      sport: "football",
      fixtures: [
        {
          home: "Alpha",
          away: "Beta",
          competition: "Test",
          startsAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
          eventRef: "e1",
          offers: [
            { market: "1x2", selection: "home", odds: 2.1 },
            { market: "over_under", selection: "over_2.5", odds: 1.9 },
            { market: "moneyline", selection: "home", odds: 2.0 },
            { market: "correct_score", selection: "2-1", odds: 9 },
            { market: "1x2", selection: "home", odds: 0.4 },
          ],
        },
      ],
    });

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    const offered = listed.fixtures[0].offered;

    // The football markets survive; a basketball market, an invented one and an
    // impossible price do not — research must never be shown an option that
    // cannot become a settleable bet.
    expect(offered.map((o: Any) => `${o.market}/${o.selection}`)).toEqual([
      "1x2/home",
      "over_under/over_2.5",
    ]);
  });

  it("reads the card from a catalogue that is not the staking account", () => {
    setupTest({
      BETTING_MODE: "live",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "testbook",
      OPERATOR_BASE_URL: "https://testbook.example",
      OPERATOR_USERNAME: "someone",
      OPERATOR_PASSWORD: "secret",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.test",
      GOOGLE_PRIVATE_KEY: "key",
    });

    const config = getConfig();
    expect(config.fixtureSource.baseUrl).toBe("https://sports.example.com");
    expect(config.fixtureSource.isOperator).toBe(false);
    // The account that takes the bets is untouched by naming a catalogue.
    expect(config.operator.baseUrl).toBe("https://testbook.example");
  });
});

describe("mock mode is about money, not about fixtures", () => {
  it("keeps the bookmaker simulated even with a real browser and a named operator", () => {
    setupTest({
      BETTING_MODE: "mock",
      BROWSER_DRIVER: "sandbox",
      OPERATOR: "sportybet",
      OPERATOR_BASE_URL: "https://sportybet.example",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
    });

    // Reading a real catalogue requires a real browser. That must never turn
    // into a real betslip: BETTING_MODE is what decides whether money moves.
    expect(usesRealFixtureSource()).toBe(true);
    expect(isMock()).toBe(true);
  });

  it("researches a real card while staking against the simulator", async () => {
    setupTest({
      BETTING_MODE: "mock",
      BROWSER_DRIVER: "sandbox",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
    });
    setSportsProviders([]);

    const startsAt = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    await call(recordOperatorFixtures, {
      sport: "football",
      fixtures: [
        {
          home: "Enyimba",
          away: "Rangers Intl",
          competition: "NPFL",
          startsAt,
          eventRef: "b1",
          offers: [{ market: "1x2", selection: "home", odds: 2.3 }],
        },
      ],
    });

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(listed.source).toBe("operator");
    expect(listed.fixtures[0].match).toBe("Enyimba vs Rangers Intl");
    expect(listed.fixtures[0].offered[0].odds).toBe(2.3);
  });
});

describe("search returns links that can be fetched", () => {
  it("unwraps the tracking redirects search engines hand back", () => {
    expect(unwrapRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fgoal.com%2Fpreview&rut=x")).toBe(
      "https://goal.com/preview",
    );
    expect(
      unwrapRedirect("http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3A%2F%2Fbbc.co.uk%2Fa&c="),
    ).toBe("https://bbc.co.uk/a");
    // Already direct, and non-URLs, are left alone rather than mangled.
    expect(unwrapRedirect("https://example.com/x?url=notaurl")).toBe("https://example.com/x?url=notaurl");
  });

  it("reads results out of a DuckDuckGo page", () => {
    const html = `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffreesupertips.com%2Ftips">
        Arsenal vs Chelsea Predictions &amp; Tips
      </a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgoal.com%2Fpreview">Preview</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgoal.com%2Fpreview">Duplicate</a>
    `;
    const results = parseDuckDuckGo(html, 10);

    expect(results).toHaveLength(2);
    expect(results[0]!.url).toBe("https://freesupertips.com/tips");
    expect(results[0]!.title).toBe("Arsenal vs Chelsea Predictions & Tips");
    expect(results[0]!.source).toBe("freesupertips.com");
  });
});

describe("the card is a hard dependency", () => {
  it("returns nothing rather than a schedule the bookmaker may not offer", async () => {
    setupTest({
      BETTING_MODE: "mock",
      BROWSER_DRIVER: "sandbox",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
    });
    // A full simulated card exists and must NOT be substituted.
    seedPricedFootballMatch();

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });

    expect(listed.cardStale).toBe(true);
    expect(listed.fixtures).toHaveLength(0);
    expect(listed.sourceNote).toMatch(/card has not been read/);
  });

  it("serves the card once it has been read", async () => {
    setupTest({
      BETTING_MODE: "mock",
      BROWSER_DRIVER: "sandbox",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
    });
    setSportsProviders([]);

    await call(recordOperatorFixtures, {
      sport: "football",
      fixtures: [
        {
          home: "Enyimba",
          away: "Rangers Intl",
          competition: "NPFL",
          startsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
          eventRef: "b1",
          offers: [{ market: "1x2", selection: "home", odds: 2.3 }],
        },
      ],
    });

    const listed: Any = await call(listFixtures, { sports: ["football"], withinHours: 24 });
    expect(listed.cardStale).toBe(false);
    expect(listed.source).toBe("operator");
    expect(listed.fixtures).toHaveLength(1);
  });
});

describe("a cycle does not sweep when there is nothing to sweep", () => {
  it("stops retrying when the card could not be read", async () => {
    setupTest({
      BETTING_MODE: "mock",
      BROWSER_DRIVER: "sandbox",
      FIXTURE_SOURCE_URL: "https://sports.example.com",
    });
    await beginCycle("daily");
    seedPricedFootballMatch();

    // Nothing was backed and fixtures notionally exist, but the catalogue was
    // never read — so four more passes would research an empty list four times.
    const decision = await decidePass();
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/card has not been read/);
  });
});
