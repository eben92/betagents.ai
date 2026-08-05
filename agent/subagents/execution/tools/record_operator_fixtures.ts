import { defineTool } from "eve/tools";
import { z } from "zod";

import { ALL_SPORTS, getConfig, type Sport } from "../../../lib/config";
import { isValidSelection, marketsFor, type MarketId } from "../../../lib/markets";
import { matchKey as buildMatchKey, newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import {
  getStore,
  TAB,
  type OfferedMarket,
  type OperatorFixtureRecord,
} from "../../../lib/sheets";
import { listFixtures as listPublicFixtures } from "../../../lib/sports";
import { findSameFixture } from "../../../lib/sports/matching";
import { isoNow, minutesBetween, parseIso } from "../../../lib/time";

const log = createLogger("tool:record_operator_fixtures");

/**
 * Records the fixtures the agent read off the operator's own card.
 *
 * The operator is the source of truth for what can be bet on. A public score
 * feed answers a different question — what is being played — and the two
 * disagree in both directions: it lists competitions the bookmaker does not
 * price, and misses ones it does. Researching from the score feed therefore
 * produces candidates nobody can back, and hides ones we could.
 *
 * Reading the card is the agent's job rather than a parser's, for the same
 * reason reading a balance is: every bookmaker lays its pages out differently,
 * and a set of selectors for one site is the site-specific coupling this system
 * is built to avoid. What the agent may do is report what it saw. Everything
 * that follows — plausibility, deduplication, and the tie to a scoreboard event
 * — happens here in code.
 */
export default defineTool({
  description:
    "Record the fixtures you read from the operator's own sports card, so research works from what this bookmaker actually offers. Open the sport's page, read the listed matches, and pass them here exactly as shown.",
  inputSchema: z.object({
    sport: z.enum(ALL_SPORTS as unknown as [Sport, ...Sport[]]),
    fixtures: z
      .array(
        z.object({
          home: z.string().min(1).describe("Home team or player, exactly as the site shows it."),
          away: z.string().min(1).describe("Away team or player, exactly as the site shows it."),
          competition: z.string().default("").describe("The league or tournament heading it sits under."),
          startsAt: z
            .string()
            .describe("Kickoff as an ISO timestamp. Convert the site's local time; do not guess a date."),
          eventRef: z
            .string()
            .default("")
            .describe("The catalogue's own handle for the event — an id or the link — if you can see one."),
          offers: z
            .array(
              z.object({
                market: z.string().describe("1x2, double_chance, over_under, btts, moneyline, handicap."),
                selection: z.string().describe("home, away, draw, over_2.5, home_-1.5 and so on."),
                odds: z.number().describe("The decimal price shown beside it."),
              }),
            )
            .max(12)
            .default([])
            .describe(
              "The markets and prices listed beside this match. Take the ones on the card; you do not need to open each event.",
            ),
        }),
      )
      .min(1)
      .max(120),
  }),

  async execute({ sport, fixtures }) {
    const config = getConfig();
    const now = new Date();

    const kept: OperatorFixtureRecord[] = [];
    const discarded: string[] = [];
    const seen = new Set<string>();

    // Public fixtures for the same sport, used only to adopt a settlement
    // handle. Discovery is the operator's; scores are never its job.
    let publicFixtures: Awaited<ReturnType<typeof listPublicFixtures>> = [];
    try {
      publicFixtures = await listPublicFixtures(sport, {
        from: new Date(now.getTime() - 6 * 60 * 60 * 1000),
        to: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      });
    } catch (error) {
      log.warn("could not load public fixtures to match against", { sport, error: String(error) });
    }

    for (const fixture of fixtures) {
      const startsAt = parseIso(fixture.startsAt);
      if (!startsAt) {
        discarded.push(`${fixture.home} vs ${fixture.away}: "${fixture.startsAt}" is not a timestamp`);
        continue;
      }
      // A card shows today and the next few days. Anything outside that is a
      // misread date, and a misread date silently produces an unbackable
      // candidate or a bet on the wrong day.
      const minutes = minutesBetween(now, startsAt);
      if (minutes < -180 || minutes > 8 * 24 * 60) {
        discarded.push(
          `${fixture.home} vs ${fixture.away}: ${startsAt.toISOString()} is not on the current card`,
        );
        continue;
      }
      if (fixture.home.trim().toLowerCase() === fixture.away.trim().toLowerCase()) {
        discarded.push(`${fixture.home} vs ${fixture.away}: both sides are the same`);
        continue;
      }

      const home = fixture.home.trim();
      const away = fixture.away.trim();
      const paired = findSameFixture(
        { home, away, startsAt: startsAt.toISOString() },
        publicFixtures,
      );

      // Adopt the score feed's key when the two agree, so the watcher can settle
      // this bet later. Without a pairing the bet is still placeable; it just
      // settles as `unknown` and is escalated, which is the safe direction.
      const key =
        paired?.matchKey ??
        buildMatchKey({ sport, home, away, startsAt: startsAt.toISOString() });

      if (seen.has(key)) continue;
      seen.add(key);

      // Only markets this system can price and settle. A market it cannot
      // settle is worse than no market, and research should never be shown an
      // option that cannot become a bet.
      const allowed = marketsFor(sport);
      const offers: OfferedMarket[] = [];
      for (const offer of fixture.offers) {
        const parsed = { market: offer.market as MarketId, code: offer.selection };
        if (!allowed.includes(parsed.market) || !isValidSelection(parsed)) continue;
        if (!Number.isFinite(offer.odds) || offer.odds <= 1 || offer.odds > 1000) continue;
        offers.push({ market: offer.market, selection: offer.selection, odds: offer.odds });
      }

      kept.push({
        id: newId("ofx"),
        createdAt: isoNow(),
        operator: config.fixtureSource.name,
        sport,
        matchKey: key,
        eventRef: fixture.eventRef,
        home,
        away,
        competition: fixture.competition,
        startsAt: startsAt.toISOString(),
        provider: paired?.provider ?? "",
        providerId: paired?.providerId ?? "",
        offers,
      });
    }

    const store = await getStore();
    let added = 0;
    for (const record of kept) {
      const written = await store.appendUnique(TAB.operatorFixtures, record);
      if (written.created) added += 1;
      else {
        await store.update(TAB.operatorFixtures, written.record.id, {
          createdAt: record.createdAt,
          eventRef: record.eventRef || written.record.eventRef,
          competition: record.competition || written.record.competition,
          startsAt: record.startsAt,
          provider: record.provider || written.record.provider,
          providerId: record.providerId || written.record.providerId,
          offers: record.offers.length > 0 ? record.offers : written.record.offers,
        });
      }
    }

    log.info("operator card recorded", {
      sport,
      offered: fixtures.length,
      kept: kept.length,
      added,
      discarded: discarded.length,
    });

    return {
      recorded: kept.length,
      newFixtures: added,
      refreshed: kept.length - added,
      settleable: kept.filter((entry) => entry.provider !== "").length,
      withMarkets: kept.filter((entry) => entry.offers.length > 0).length,
      discarded,
      note:
        kept.length > 0
          ? "Research will work from this card. Read the other sports in play before handing back."
          : "Nothing usable was recorded — check the dates you read.",
    };
  },
});
