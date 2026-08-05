import { defineTool } from "eve/tools";
import { z } from "zod";

import { ALL_SPORTS, getConfig, type Sport } from "../../../lib/config";
import { getStore, OPEN_BET_STATUSES, TAB } from "../../../lib/sheets";
import { listFixtures } from "../../../lib/sports";
import { minutesBetween } from "../../../lib/time";

/**
 * Real scheduled fixtures from the free public score providers.
 *
 * Matches that already carry a bet or a live draft are excluded, so research
 * budget is never spent twice on the same fixture.
 */
export default defineTool({
  description:
    "Discover real scheduled fixtures for a sport within a time window, from free public score data. Excludes matches the system already has a bet or a live draft on. Start here rather than guessing what is on today.",
  inputSchema: z.object({
    sport: z.enum(ALL_SPORTS as unknown as [Sport, ...Sport[]]),
    withinHours: z
      .number()
      .min(1)
      .max(72)
      .default(36)
      .describe("How far ahead to look. Matches starting too soon to research are dropped."),
  }),

  async execute({ sport, withinHours }) {
    const config = getConfig();
    const now = new Date();

    const fixtures = await listFixtures(sport, {
      from: new Date(now.getTime() + config.strategy.minMinutesToKickoff * 60_000),
      to: new Date(now.getTime() + withinHours * 60 * 60 * 1000),
    });

    const store = await getStore();
    const [drafts, bets] = await Promise.all([store.list(TAB.drafts), store.list(TAB.bets)]);

    const busy = new Set<string>([
      ...drafts
        .filter((draft) => draft.status === "pending" || draft.status === "approved")
        .map((draft) => draft.matchKey),
      ...bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status)).map((bet) => bet.matchKey),
    ]);

    const available = fixtures.filter(
      (fixture) => fixture.status === "scheduled" && !busy.has(fixture.matchKey),
    );

    return {
      sport,
      count: available.length,
      alreadyCommitted: fixtures.length - available.length,
      fixtures: available.map((fixture) => ({
        matchKey: fixture.matchKey,
        match: `${fixture.home} vs ${fixture.away}`,
        home: fixture.home,
        away: fixture.away,
        competition: fixture.league,
        startsAt: fixture.startsAt,
        startsInMinutes: Math.round(minutesBetween(now, new Date(fixture.startsAt))),
        provider: fixture.provider,
        providerId: fixture.providerId,
      })),
    };
  },
});
