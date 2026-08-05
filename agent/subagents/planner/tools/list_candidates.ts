import { defineTool } from "eve/tools";
import { z } from "zod";

import { getConfig } from "../../../lib/config";
import { impliedProbability } from "../../../lib/money";
import { getStore, OPEN_BET_STATUSES, TAB } from "../../../lib/sheets";
import { minutesBetween, parseIso } from "../../../lib/time";

/**
 * Candidates the planner may still act on.
 *
 * Matches already carrying a bet or a live draft are filtered out here rather
 * than left to judgement — accidentally doubling up on one fixture is the
 * easiest way to take twice the risk you meant to.
 */
export default defineTool({
  description:
    "List researched candidates that are still actionable, with the operator's price where one has been read. Unpriced candidates cannot be backed. Matches you already hold a bet or a live draft on are excluded.",
  inputSchema: z.object({
    includeUnpriced: z
      .boolean()
      .default(false)
      .describe("Include candidates with no operator price yet, so you can see what is missing."),
  }),

  async execute({ includeUnpriced }) {
    const config = getConfig();
    const store = await getStore();
    const now = new Date();

    const [shortlist, research, drafts, bets] = await Promise.all([
      store.list(TAB.shortlist),
      store.list(TAB.research),
      store.list(TAB.drafts),
      store.list(TAB.bets),
    ]);

    const blocked = new Set<string>([
      ...bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status)).map((bet) => bet.matchKey),
      ...drafts
        .filter((draft) => draft.status === "pending" || draft.status === "approved")
        .map((draft) => draft.matchKey),
    ]);

    const researchById = new Map(research.map((entry) => [entry.id, entry]));

    const candidates = shortlist
      .filter((entry) => !blocked.has(entry.matchKey))
      .filter((entry) => {
        const startsAt = parseIso(entry.startsAt);
        if (!startsAt) return false;
        // Too close to kickoff for research to still describe the match.
        return minutesBetween(now, startsAt) >= config.strategy.minMinutesToKickoff;
      })
      .filter((entry) => includeUnpriced || entry.odds > 1)
      .map((entry) => {
        const source = researchById.get(entry.researchId);
        const priced = entry.odds > 1;
        return {
          shortlistId: entry.id,
          matchKey: entry.matchKey,
          matchName: entry.matchName,
          sport: entry.sport,
          startsAt: entry.startsAt,
          minutesToStart: Math.round(minutesBetween(now, parseIso(entry.startsAt) ?? now)),
          market: entry.market,
          selection: entry.selection,
          yourProbability: entry.estimatedProbability,
          confidence: entry.confidence,
          rationale: entry.rationale,
          odds: priced ? entry.odds : null,
          impliedProbability: priced ? impliedProbability(entry.odds) : null,
          edge: priced ? entry.estimatedProbability * entry.odds - 1 : null,
          researchSummary: source?.summary ?? "",
          opposing: source?.opposing ?? [],
        };
      })
      .sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1));

    return {
      candidates,
      unpriced: shortlist.filter((entry) => entry.odds <= 1 && !blocked.has(entry.matchKey)).length,
      excludedForExistingExposure: blocked.size,
      minEdge: config.strategy.minEdge,
      minConfidence: config.strategy.minConfidence,
    };
  },
});
