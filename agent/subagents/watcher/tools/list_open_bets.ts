import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStore, OPEN_BET_STATUSES, TAB } from "../../../lib/sheets";
import { minutesBetween, parseIso } from "../../../lib/time";

/**
 * The watch list, and nothing else. Only bets still carrying risk appear here,
 * which is what keeps monitoring cheap.
 */
export default defineTool({
  description:
    "List every bet still carrying risk, with its match, selection, start time and whether the match should have finished by now. This is your entire watch list.",
  inputSchema: z.object({}),

  async execute() {
    const store = await getStore();
    const bets = await store.list(TAB.bets);
    const now = new Date();

    const open = bets
      .filter((bet) => OPEN_BET_STATUSES.includes(bet.status))
      .map((bet) => {
        const startsAt = parseIso(bet.startsAt);
        const minutesSinceStart = startsAt ? Math.round(minutesBetween(startsAt, now)) : null;
        return {
          betId: bet.id,
          status: bet.status,
          matchKey: bet.matchKey,
          matchName: bet.matchName,
          sport: bet.sport,
          provider: bet.provider,
          providerId: bet.providerId,
          startsAt: bet.startsAt,
          market: bet.market,
          selection: bet.selection,
          stake: bet.stake,
          odds: bet.odds,
          potentialReturn: bet.potentialReturn,
          started: minutesSinceStart !== null && minutesSinceStart >= 0,
          minutesSinceStart,
        };
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    return {
      openBets: open,
      count: open.length,
      awaitingReconciliation: open.filter((bet) => bet.status === "unknown").length,
    };
  },
});
