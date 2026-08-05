import { defineTool } from "eve/tools";
import { z } from "zod";

import { ALL_SPORTS, getConfig, type Sport } from "../../../lib/config";
import { coveredMatchKeys, currentCycleId } from "../../../lib/cycle";
import { getStore, OPEN_BET_STATUSES, TAB } from "../../../lib/sheets";
import { discoverFixtures } from "../../../lib/sports";
import { minutesBetween } from "../../../lib/time";

/**
 * Real scheduled fixtures from the free public score providers.
 *
 * Three filters run here rather than in the agent's head. Matches already
 * carrying a bet or a live draft are dropped, so research budget is never spent
 * twice on the same fixture. Matches this cycle has already assessed are
 * dropped too, which is what makes a second pass look at *different* games
 * instead of re-deriving the same verdict. And the competition breakdown comes
 * back alongside the fixtures, because on a full card the first real decision
 * is which competitions are worth reading about at all.
 */
export default defineTool({
  description:
    "Discover real scheduled fixtures from free public score data. Ask for several sports at once. Excludes matches the system already has a bet or a live draft on, and matches this cycle has already assessed — so calling it again on a later pass returns fixtures you have not seen.",
  inputSchema: z.object({
    sports: z
      .array(z.enum(ALL_SPORTS as unknown as [Sport, ...Sport[]]))
      .min(1)
      .max(4)
      .describe("Sports to search. Ask for all the ones in play in a single call."),
    withinHours: z
      .number()
      .min(1)
      .max(72)
      .default(36)
      .describe("How far ahead to look. Matches starting too soon to research are dropped."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(60)
      .describe("Most fixtures to return, soonest first. The full count is reported either way."),
    includeAssessed: z
      .boolean()
      .default(false)
      .describe("Include matches this cycle already assessed. Leave false unless re-checking one."),
  }),

  async execute({ sports, withinHours, limit, includeAssessed }) {
    const config = getConfig();
    const now = new Date();
    const window = {
      from: new Date(now.getTime() + config.strategy.minMinutesToKickoff * 60_000),
      to: new Date(now.getTime() + withinHours * 60 * 60 * 1000),
    };

    const discovered = await Promise.all(
      sports.map(async (sport) => discoverFixtures(sport, window)),
    );
    const perSport = discovered.map((entry) => entry.fixtures);
    // One source of truth per cycle: if any sport answered from the operator's
    // own card, say so, because that changes what "no fixtures" means.
    const fromOperator = discovered.some((entry) => entry.source === "operator");
    const cardStale = discovered.some((entry) => entry.cardStale);

    const store = await getStore();
    const cycleId = await currentCycleId();
    const [drafts, bets, assessed] = await Promise.all([
      store.list(TAB.drafts),
      store.list(TAB.bets),
      includeAssessed ? Promise.resolve<string[]>([]) : coveredMatchKeys(cycleId),
    ]);

    const busy = new Set<string>([
      ...drafts
        .filter((draft) => draft.status === "pending" || draft.status === "approved")
        .map((draft) => draft.matchKey),
      ...bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status)).map((bet) => bet.matchKey),
    ]);
    const seen = new Set(assessed);

    const scheduled = perSport.flat().filter((fixture) => fixture.status === "scheduled");
    const available = scheduled
      .filter((fixture) => !busy.has(fixture.matchKey) && !seen.has(fixture.matchKey))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    const byCompetition = new Map<string, number>();
    for (const fixture of available) {
      byCompetition.set(fixture.league, (byCompetition.get(fixture.league) ?? 0) + 1);
    }

    // In mock mode the feed itself is the simulator, so say so rather than
    // leaving the agent to infer it from `provider: "mock"` and reject the whole
    // card as synthetic — which is exactly what it did, and was right to, until
    // it was told the difference.
    const simulated = config.mode === "mock";

    return {
      sports,
      count: available.length,
      returned: Math.min(available.length, limit),
      alreadyCommitted: scheduled.filter((fixture) => busy.has(fixture.matchKey)).length,
      alreadyAssessedThisCycle: scheduled.filter((fixture) => seen.has(fixture.matchKey)).length,
      researchBudget: config.maxResearchMatches,
      source: fromOperator ? "operator" : "public",
      cardReadAt: discovered.find((entry) => entry.cardReadAt)?.cardReadAt ?? null,
      cardStale,
      sourceNote: cardStale
        ? "No fixtures because the card has not been read. A real bookmaker's catalogue is configured, and researching anything else would spend your budget on matches it may not offer. Report this: the orchestrator must send the execution agent to read the card before research can run."
        : fromOperator
          ? "These are the fixtures this bookmaker is actually offering, read from its own card. Every one of them can be priced and backed, and `offered` lists the markets it is showing."
          : "No catalogue is configured, so this is a public schedule. Some of these matches may not be offered by a bookmaker, and some it offers are missing.",
      competitions: [...byCompetition.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([competition, fixtures]) => ({ competition, fixtures })),
      simulated,
      ...(simulated
        ? {
            note: "Simulated feed: the system is in mock mode, so these fixtures stand in for a real card and no real money can be staked against them. Assess them as you would real matches. This is not the virtual-games exclusion, which is about products a real bookmaker offers alongside real sport.",
          }
        : {}),
      fixtures: available.slice(0, limit).map((fixture) => ({
        matchKey: fixture.matchKey,
        sport: fixture.sport,
        match: `${fixture.home} vs ${fixture.away}`,
        home: fixture.home,
        away: fixture.away,
        competition: fixture.league,
        startsAt: fixture.startsAt,
        startsInMinutes: Math.round(minutesBetween(now, new Date(fixture.startsAt))),
        provider: fixture.provider,
        providerId: fixture.providerId,
        // What the catalogue was offering on this match. Choose from these:
        // an outcome nobody prices cannot become a bet.
        offered: fixture.offers ?? [],
      })),
    };
  },
});
