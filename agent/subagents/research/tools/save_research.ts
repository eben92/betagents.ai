import { defineTool } from "eve/tools";
import { z } from "zod";

import { ALL_SPORTS, getConfig, type Sport } from "../../../lib/config";
import { currentCycleId, recordRejection } from "../../../lib/cycle";
import { newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import { isValidSelection, marketsFor, type MarketId } from "../../../lib/markets";
import {
  getStore,
  TAB,
  type ResearchRecord,
  type ShortlistRecord,
} from "../../../lib/sheets";

const log = createLogger("tool:save_research");

const selection = z.object({
  market: z.string().describe("One of the market codes for this sport."),
  selection: z.string().describe("The selection code, e.g. home, away, over_2.5."),
  estimatedProbability: z.number().min(0).max(1).describe("Your probability that this wins."),
  rationale: z.string().max(400).describe("What makes this the side to be on."),
});

/**
 * Records one match assessment, the selection it points to, and — when it points
 * to nothing — why.
 *
 * The pick is a required field rather than an optional list because deciding
 * *which* side to back is research's job, not the planner's. Handing on "this
 * match looks interesting" forces the next agent to redo the analysis without
 * the sources, and it is one of the ways a full card turns into no bets:
 * everyone downstream declines something nobody upstream committed to.
 *
 * A null pick is a legitimate answer and is recorded as a rejection with its
 * reason, so the operator is told why each game was passed over and the cycle
 * knows this match has been dealt with.
 *
 * Selections outside the system's market vocabulary are dropped rather than
 * stored — a market nobody can settle is worse than no market.
 */
export default defineTool({
  description:
    "Record your finished assessment of one match. Call this once per match you assessed, including matches you would not back. `pick` is the one selection you would put money on; pass null with `noBetReason` when the answer is no bet.",
  inputSchema: z.object({
    matchKey: z.string().describe("Exactly as returned by list_fixtures."),
    sport: z.enum(ALL_SPORTS as unknown as [Sport, ...Sport[]]),
    matchName: z.string(),
    competition: z.string().default(""),
    startsAt: z.string(),
    provider: z.string().default(""),
    providerId: z.string().default(""),
    summary: z.string().max(2000).describe("What you concluded and why."),
    confidence: z.number().min(0).max(1),
    dataQuality: z.enum(["thin", "adequate", "strong"]),
    supporting: z.array(z.string().max(300)).max(8),
    opposing: z.array(z.string().max(300)).max(8),
    sources: z.array(z.string()).max(20).default([]),
    consensus: z
      .object({
        found: z
          .boolean()
          .describe("Whether you found any published prediction for this specific match."),
        leaning: z
          .string()
          .max(200)
          .default("")
          .describe("What other people are predicting, e.g. 'most tip the home win, two tip over 2.5'."),
        sampled: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(0)
          .describe("How many separate predictions you actually read."),
        agreesWithYou: z
          .boolean()
          .default(false)
          .describe("Whether the weight of those predictions points the same way as your pick."),
      })
      .describe(
        "What the rest of the internet thinks about this match. Required: search for it before you decide, and say so honestly when nothing exists.",
      ),
    pick: selection
      .nullable()
      .describe(
        "The single selection you would back — home, away, draw, over_2.5 and so on. This is your decision to make; do not leave it to the planner. Null only when you would back nothing on this match.",
      ),
    noBetReason: z
      .string()
      .max(400)
      .default("")
      .describe("Required when pick is null: why this match is not worth backing."),
    alternatives: selection
      .array()
      .max(3)
      .default([])
      .describe("Other selections worth pricing if your pick turns out to be unavailable."),
  }),

  async execute(input) {
    // A pick made without having looked at what anyone else thinks is the
    // failure this field exists to catch: it is fast, it feels like analysis,
    // and it is one model's opinion of a football match.
    if (input.pick && input.consensus.found && input.consensus.sampled === 0) {
      return {
        recorded: false,
        error:
          "consensus.found is true but sampled is 0. Say how many predictions you actually read, or set found to false.",
      };
    }

    if (!input.pick && !input.noBetReason.trim()) {
      return {
        recorded: false,
        error:
          "A null pick needs `noBetReason`. Say what you found that makes this match not worth backing.",
      };
    }

    const allowed = marketsFor(input.sport);
    const proposed = [...(input.pick ? [input.pick] : []), ...input.alternatives];
    const kept: typeof proposed = [];
    const rejected: string[] = [];

    for (const candidate of proposed) {
      const parsed = { market: candidate.market as MarketId, code: candidate.selection };
      if (!allowed.includes(parsed.market)) {
        rejected.push(`${candidate.market}/${candidate.selection}: not a ${input.sport} market`);
        continue;
      }
      if (!isValidSelection(parsed)) {
        rejected.push(`${candidate.market}/${candidate.selection}: not a valid selection code`);
        continue;
      }
      kept.push(candidate);
    }

    // Evidence the agent itself called thin cannot carry high confidence.
    //
    // Except on a simulated card, where the thinness *is* the simulation. Teams
    // that do not exist have no team news, so an honest agent calls the evidence
    // thin, the cap drops confidence to 0.5, the staking rules require 0.6, and
    // mock mode can never place a bet — which makes the rehearsal worthless at
    // exactly the step it exists to rehearse. The instructions asked the agent
    // to judge simulated fixtures differently; it kept answering honestly, which
    // is the right instinct to have and the wrong thing to argue with.
    const simulated = getConfig().mode === "mock";
    const confidence =
      input.dataQuality === "thin" && !simulated
        ? Math.min(input.confidence, 0.5)
        : input.confidence;

    const now = new Date().toISOString();
    const cycleId = await currentCycleId();

    const research: ResearchRecord = {
      id: newId("res"),
      cycleId,
      createdAt: now,
      sport: input.sport,
      matchKey: input.matchKey,
      matchName: input.matchName,
      league: input.competition,
      startsAt: input.startsAt,
      summary: input.summary,
      confidence,
      supporting: input.supporting,
      opposing: input.opposing,
      sources: input.sources,
      consensus: input.consensus,
      candidateMarkets: kept.map((candidate) => ({
        market: candidate.market,
        selection: candidate.selection,
        estimatedProbability: candidate.estimatedProbability,
        note: candidate.rationale,
      })),
    };

    const store = await getStore();

    // One research row per match, refreshed in place.
    const written = await store.appendUnique(TAB.research, research);
    const researchId = written.created ? research.id : written.record.id;
    if (!written.created) {
      await store.update(TAB.research, researchId, {
        cycleId,
        createdAt: now,
        summary: research.summary,
        confidence: research.confidence,
        supporting: research.supporting,
        opposing: research.opposing,
        sources: research.sources,
        consensus: research.consensus,
        candidateMarkets: research.candidateMarkets,
      });
    }

    const shortlist: ShortlistRecord[] = kept.map((candidate) => ({
      id: newId("sl"),
      cycleId,
      createdAt: now,
      researchId,
      matchKey: input.matchKey,
      sport: input.sport,
      matchName: input.matchName,
      startsAt: input.startsAt,
      provider: input.provider,
      providerId: input.providerId,
      market: candidate.market,
      selection: candidate.selection,
      estimatedProbability: candidate.estimatedProbability,
      confidence,
      rationale: candidate.rationale,
      odds: 0,
      eventRef: "",
      pricedAt: "",
    }));

    for (const record of shortlist) await store.append(TAB.shortlist, record);

    const context = {
      stage: "research" as const,
      matchKey: input.matchKey,
      matchName: input.matchName,
      sport: input.sport,
      startsAt: input.startsAt,
    };

    if (!input.pick) {
      await recordRejection({
        ...context,
        code: "no_selection",
        reason: input.noBetReason,
        fixable: false,
      });
    } else if (kept.length === 0) {
      // The agent did decide, but named a market this system cannot settle.
      await recordRejection({
        ...context,
        market: input.pick.market,
        selection: input.pick.selection,
        code: "invalid_market",
        reason: rejected.join("; ") || "the selection is not one this system can settle",
        fixable: true,
      });
    }

    if (rejected.length > 0) {
      log.warn("dropped invalid candidate selections", {
        matchKey: input.matchKey,
        rejected,
      });
    }

    return {
      researchId,
      recorded: true,
      confidence,
      confidenceCapped: confidence !== input.confidence,
      pickAccepted: input.pick !== null && kept.length > 0,
      consensusChecked: input.consensus.found,
      againstConsensus: Boolean(input.pick) && input.consensus.found && !input.consensus.agreesWithYou,
      candidatesAccepted: shortlist.map((entry) => ({
        shortlistId: entry.id,
        market: entry.market,
        selection: entry.selection,
        estimatedProbability: entry.estimatedProbability,
      })),
      candidatesRejected: rejected,
    };
  },
});
