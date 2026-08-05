import { defineTool } from "eve/tools";
import { z } from "zod";

import { computeStake, snapshot } from "../../../lib/bankroll";
import { getConfig } from "../../../lib/config";
import { recordRejection } from "../../../lib/cycle";
import { getStore, TAB } from "../../../lib/sheets";

/** Maps a declined stake onto the rejection code that report readers scan for. */
function declineCode(declined: string): { code: string; fixable: boolean } {
  if (declined.includes("edge")) return { code: "edge_below_minimum", fixable: true };
  if (declined.includes("confidence")) return { code: "confidence_below_minimum", fixable: false };
  if (declined.includes("Kelly")) return { code: "price_too_short", fixable: true };
  if (declined.includes("below the")) return { code: "stake_below_minimum", fixable: false };
  if (declined.includes("odds")) return { code: "no_price", fixable: true };
  return { code: "bankroll_halted", fixable: false };
}

/**
 * Sizing lives in code, not in the model.
 *
 * A zero stake with a reason is a valid answer, not an error. The rules that
 * produce it — minimum edge, minimum confidence, the per-bet cap, the reserve,
 * a trading halt — exist precisely to override enthusiasm.
 */
export default defineTool({
  description:
    "Size one bet against the bankroll rules. Returns the stake, the edge, and — when the stake is zero — which rule declined it. A zero stake is an answer; do not re-call with different numbers to get a different one.",
  inputSchema: z.object({
    shortlistId: z.string(),
    probability: z.number().min(0).max(1).describe("Your final probability, after weighing the price."),
    odds: z.number().gt(1).describe("The operator's price for this selection."),
    confidence: z.number().min(0).max(1).describe("Confidence in the research behind the probability."),
    conviction: z
      .number()
      .min(0)
      .max(1)
      .describe("Your sizing preference. Scales the stake down only, never up."),
    remainingOpportunities: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("How many more bets you expect to place today, including this one."),
  }),

  async execute(input) {
    const config = getConfig();
    const store = await getStore();
    const latest = (await store.list(TAB.balances)).at(-1);

    if (!latest) {
      return {
        stake: 0,
        declined: "no balance has been recorded yet; nothing can be sized",
      };
    }

    const bank = await snapshot(latest.balance);
    const decision = computeStake({
      snapshot: bank,
      probability: input.probability,
      odds: input.odds,
      confidence: input.confidence,
      multiplier: input.conviction,
      remainingOpportunities: input.remainingOpportunities,
    });

    // A declined stake is a rejection of that selection, recorded here rather
    // than left to the planner to remember. The operator's report is built from
    // these rows, and the reason is exact at this point and vague later.
    if (decision.declined) {
      const candidate = (await store.list(TAB.shortlist)).find(
        (entry) => entry.id === input.shortlistId,
      );
      if (candidate) {
        const { code, fixable } = declineCode(decision.declined);
        await recordRejection({
          stage: "planner",
          matchKey: candidate.matchKey,
          matchName: candidate.matchName,
          sport: candidate.sport,
          startsAt: candidate.startsAt,
          market: candidate.market,
          selection: candidate.selection,
          odds: input.odds,
          code,
          reason: decision.declined,
          fixable,
        });
      }
    }

    return {
      shortlistId: input.shortlistId,
      currency: config.strategy.currency,
      stake: decision.stake,
      edge: decision.edge,
      kellyFraction: decision.kelly,
      potentialReturn: decision.potentialReturn,
      expectedProfit: decision.expectedProfit,
      declined: decision.declined,
      availableToStake: bank.available,
    };
  },
});
