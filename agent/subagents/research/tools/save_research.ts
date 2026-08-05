import { defineTool } from "eve/tools";
import { z } from "zod";

import { ALL_SPORTS, type Sport } from "../../../lib/config";
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

/**
 * Records one match assessment and its candidate selections.
 *
 * Selections outside the system's market vocabulary are dropped rather than
 * stored — a market nobody can settle is worse than no market. The tool reports
 * what it dropped so the agent can correct itself.
 */
export default defineTool({
  description:
    "Record your finished assessment of one match, with any candidate selections. Call this once per match you assessed, including matches you rejected (pass an empty candidates list and say why in the summary).",
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
    candidates: z
      .array(
        z.object({
          market: z.string(),
          selection: z.string(),
          estimatedProbability: z.number().min(0).max(1),
          rationale: z.string().max(400),
        }),
      )
      .max(4)
      .default([]),
  }),

  async execute(input) {
    const allowed = marketsFor(input.sport);
    const kept: typeof input.candidates = [];
    const rejected: string[] = [];

    for (const candidate of input.candidates) {
      const selection = { market: candidate.market as MarketId, code: candidate.selection };
      if (!allowed.includes(selection.market)) {
        rejected.push(`${candidate.market}/${candidate.selection}: not a ${input.sport} market`);
        continue;
      }
      if (!isValidSelection(selection)) {
        rejected.push(`${candidate.market}/${candidate.selection}: not a valid selection code`);
        continue;
      }
      kept.push(candidate);
    }

    // Evidence the agent itself called thin cannot carry high confidence.
    const confidence =
      input.dataQuality === "thin" ? Math.min(input.confidence, 0.5) : input.confidence;

    const now = new Date().toISOString();
    const research: ResearchRecord = {
      id: newId("res"),
      cycleId: "",
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
        createdAt: now,
        summary: research.summary,
        confidence: research.confidence,
        supporting: research.supporting,
        opposing: research.opposing,
        sources: research.sources,
        candidateMarkets: research.candidateMarkets,
      });
    }

    const shortlist: ShortlistRecord[] = kept.map((candidate) => ({
      id: newId("sl"),
      cycleId: "",
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
