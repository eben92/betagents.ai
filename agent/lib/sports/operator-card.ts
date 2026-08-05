/**
 * The operator's own card, as a fixture source.
 *
 * When the Account & Execution agent has read the bookmaker's sports pages
 * recently, that card is what the system researches. It is the only source that
 * answers the question research actually needs answered — what can we place a
 * bet on — and it removes a whole class of wasted work: a match researched from
 * a public feed that the bookmaker never priced.
 *
 * The public score feed does not go away. It still supplies live scores and
 * final results, because a bookmaker's page is a poor and late source for those
 * and settlement must not depend on the counterparty's own reporting.
 */

import type { Sport } from "../config";
import { createLogger, errorMessage } from "../logger";
import { getStore, TAB } from "../sheets";
import type { OfferedMarket } from "../sheets";
import type { Fixture, FixtureWindow } from "./types";

const log = createLogger("sports:operator-card");

/**
 * How long a card stays authoritative.
 *
 * Long enough to cover a cycle's passes without re-reading the site, short
 * enough that yesterday's card is never mistaken for today's.
 */
const CARD_TTL_MS = 6 * 60 * 60 * 1000;

/** A fixture plus the markets the catalogue was showing beside it. */
export type CardFixture = Fixture & { offers: OfferedMarket[] };

export interface OperatorCard {
  fixtures: CardFixture[];
  /** When the card was last read from the site. */
  readAt: string | null;
  fresh: boolean;
}

/** Fixtures the operator offers for one sport inside a window. */
export async function readOperatorCard(
  sport: Sport,
  window: FixtureWindow,
): Promise<OperatorCard> {
  try {
    const store = await getStore();
    const rows = (await store.list(TAB.operatorFixtures)).filter((row) => row.sport === sport);
    if (rows.length === 0) return { fixtures: [], readAt: null, fresh: false };

    const newest = rows
      .map((row) => Date.parse(row.createdAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];

    const readAt = newest ? new Date(newest).toISOString() : null;
    const fresh = newest !== undefined && Date.now() - newest < CARD_TTL_MS;

    const fixtures = rows
      .filter((row) => {
        const startsAt = Date.parse(row.startsAt);
        return (
          Number.isFinite(startsAt) &&
          startsAt >= window.from.getTime() &&
          startsAt <= window.to.getTime()
        );
      })
      .map<CardFixture>((row) => ({
        sport: row.sport,
        matchKey: row.matchKey,
        home: row.home,
        away: row.away,
        league: row.competition,
        startsAt: row.startsAt,
        status: "scheduled",
        // The score-feed handle when the fixture was tied to one, so the watcher
        // can settle it. Empty means settlement will have to match by name.
        provider: row.provider || "operator",
        providerId: row.providerId,
        offers: row.offers ?? [],
      }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    return { fixtures, readAt, fresh };
  } catch (error) {
    log.warn("could not read the operator card", { sport, error: errorMessage(error) });
    return { fixtures: [], readAt: null, fresh: false };
  }
}

/** Whether any sport has a card recent enough to research from. */
export async function operatorCardIsFresh(): Promise<boolean> {
  try {
    const store = await getStore();
    const rows = await store.list(TAB.operatorFixtures);
    return rows.some((row) => {
      const at = Date.parse(row.createdAt);
      return Number.isFinite(at) && Date.now() - at < CARD_TTL_MS;
    });
  } catch {
    return false;
  }
}
