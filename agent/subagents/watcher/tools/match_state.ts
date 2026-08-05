import { defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { getStore, TAB } from "../../../lib/sheets";
import { getMatchState } from "../../../lib/sports";
import { isoNow } from "../../../lib/time";

/**
 * Reads one match from the free public score providers. The last seen score is
 * cached on the active-bet row so a report can quote it without another fetch.
 */
export default defineTool({
  description:
    "Read the current state of one match with an open bet: score, clock, and whether the result is final. Uses free public score sources. Returns nothing when no source recognises the fixture.",
  inputSchema: z.object({
    betId: z.string(),
  }),

  async execute({ betId }) {
    const store = await getStore();
    const bet = (await store.list(TAB.bets)).find((entry) => entry.id === betId);
    if (!bet) return { found: false, detail: `no bet with id ${betId}` };

    try {
      const state = await getMatchState({
        sport: bet.sport,
        matchKey: bet.matchKey,
        provider: bet.provider,
        providerId: bet.providerId,
      });

      if (!state) {
        return {
          found: false,
          matchName: bet.matchName,
          detail: "no score source recognises this fixture right now",
        };
      }

      const active = (await store.list(TAB.activeBets)).find((entry) => entry.betId === bet.id);
      if (active) {
        await store.update(TAB.activeBets, active.id, {
          liveScore: state.displayScore,
          lastCheckedAt: isoNow(),
        });
      }

      return {
        found: true,
        matchName: bet.matchName,
        yourSelection: `${bet.market} / ${bet.selection}`,
        status: state.status,
        score: state.displayScore,
        homeScore: state.homeScore,
        awayScore: state.awayScore,
        clock: state.clock,
        winner: state.winner,
        final: state.completed,
        source: state.provider,
      };
    } catch (error) {
      return { found: false, matchName: bet.matchName, detail: errorMessage(error) };
    }
  },
});
