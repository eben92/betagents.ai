import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertReader } from "../lib/authz";
import { getConfig } from "../lib/config";
import { formatMoney } from "../lib/money";
import { getTodayActivity } from "../lib/overview";

export default defineTool({
  description:
    "Everything the system did today: matches researched, bets drafted, bets placed, results settled, and the day's profit or loss.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    assertReader(ctx, "read today's activity");

    const currency = getConfig().strategy.currency;
    const activity = await getTodayActivity();

    return {
      day: activity.day,
      researched: activity.research.map((entry) => ({
        match: entry.matchName,
        sport: entry.sport,
        confidence: entry.confidence,
        summary: entry.summary.slice(0, 300),
      })),
      drafted: activity.drafts.map((entry) => ({
        match: entry.matchName,
        selection: `${entry.market} / ${entry.selection}`,
        odds: entry.odds,
        stake: formatMoney(entry.stake, currency),
        status: entry.status,
      })),
      placed: activity.bets.map((entry) => ({
        match: entry.matchName,
        selection: `${entry.market} / ${entry.selection}`,
        odds: entry.odds,
        stake: formatMoney(entry.stake, currency),
        status: entry.status,
        result: entry.result || null,
      })),
      settled: activity.settlements.map((entry) => ({
        match: entry.matchName,
        result: entry.result,
        finalScore: entry.finalScore,
        profit: formatMoney(entry.profit, currency),
      })),
      totals: {
        staked: formatMoney(activity.staked, currency),
        returned: formatMoney(activity.returned, currency),
        profit: formatMoney(activity.profit, currency),
      },
    };
  },
});
