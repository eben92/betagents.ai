import { defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { quote } from "../../../lib/operator";
import { getStore, TAB } from "../../../lib/sheets";
import { isoNow } from "../../../lib/time";

/**
 * Attaches the operator's price to a researched candidate.
 *
 * Until this runs, a candidate is an opinion. Afterwards it is an opportunity
 * the Planner can size. The price is range-checked before it is stored — a
 * misread page producing an absurd number would otherwise flow straight into a
 * stake calculation.
 */
export default defineTool({
  description:
    "Record the operator's price for one researched candidate. Pass the decimal odds exactly as shown and the URL of the event page. If the operator does not offer the match or the selection, say so with `unavailable` instead of guessing a price.",
  inputSchema: z.object({
    shortlistId: z.string(),
    odds: z.number().optional().describe("Decimal odds as displayed. Omit when unavailable."),
    eventRef: z
      .string()
      .optional()
      .describe("URL of the event page, so the bet can be placed there later."),
    unavailable: z
      .string()
      .optional()
      .describe("Why there is no price: match not offered, market missing, selection suspended."),
  }),

  async execute(input, ctx) {
    const store = await getStore();
    const candidate = (await store.list(TAB.shortlist)).find(
      (entry) => entry.id === input.shortlistId,
    );
    if (!candidate) return { priced: false, detail: `no candidate with id ${input.shortlistId}` };

    if (input.unavailable) {
      return {
        priced: false,
        shortlistId: candidate.id,
        matchName: candidate.matchName,
        detail: input.unavailable,
      };
    }

    try {
      const [home = "", away = ""] = candidate.matchName.split(/\s+v(?:s\.?)?\s+/i);
      const priced = await quote(
        ctx,
        {
          matchName: candidate.matchName,
          home,
          away,
          market: candidate.market,
          selection: candidate.selection,
          startsAt: candidate.startsAt,
        },
        input.odds !== undefined && input.eventRef !== undefined
          ? { odds: input.odds, eventRef: input.eventRef }
          : undefined,
      );

      if (!priced) {
        return { priced: false, shortlistId: candidate.id, detail: "no price could be established" };
      }

      await store.update(TAB.shortlist, candidate.id, {
        odds: priced.odds,
        eventRef: priced.eventRef,
        pricedAt: isoNow(),
      });

      return {
        priced: true,
        shortlistId: candidate.id,
        matchName: candidate.matchName,
        selection: `${candidate.market}/${candidate.selection}`,
        odds: priced.odds,
        yourResearchProbability: candidate.estimatedProbability,
      };
    } catch (error) {
      return { priced: false, shortlistId: candidate.id, detail: errorMessage(error) };
    }
  },
});
