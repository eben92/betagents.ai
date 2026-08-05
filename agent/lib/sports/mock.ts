/**
 * Deterministic sports provider backing mock mode and the end-to-end tests.
 *
 * The world is mutable so a test can seed a fixture, run a cycle, push the
 * match to full time and run the next cycle — exactly the sequence the live
 * system goes through, with no network involved.
 */

import type { Sport } from "../config";
import { matchKey as buildMatchKey } from "../ids";
import type { Fixture, MatchState, SportsProvider } from "./types";

interface MockWorld {
  fixtures: Map<string, Fixture>;
  states: Map<string, MatchState>;
}

const world: MockWorld = { fixtures: new Map(), states: new Map() };

export function resetMockWorld(): void {
  world.fixtures.clear();
  world.states.clear();
}

export interface SeedFixtureInput {
  sport: Sport;
  home: string;
  away: string;
  league?: string;
  startsAt: Date;
}

export function seedFixture(input: SeedFixtureInput): Fixture {
  const startsAt = input.startsAt.toISOString();
  const key = buildMatchKey({ sport: input.sport, home: input.home, away: input.away, startsAt });
  const fixture: Fixture = {
    sport: input.sport,
    matchKey: key,
    home: input.home,
    away: input.away,
    league: input.league ?? `${input.sport}/mock`,
    startsAt,
    status: "scheduled",
    provider: "mock",
    providerId: `mock#${key}`,
  };
  world.fixtures.set(key, fixture);
  world.states.set(key, {
    matchKey: key,
    status: "scheduled",
    homeScore: null,
    awayScore: null,
    displayScore: "",
    clock: "",
    winner: null,
    provider: "mock",
    completed: false,
  });
  return fixture;
}

export function setMatchState(matchKey: string, patch: Partial<MatchState>): void {
  const current = world.states.get(matchKey);
  if (!current) return;
  const next = { ...current, ...patch };
  if (next.homeScore !== null && next.awayScore !== null) {
    next.displayScore = `${next.homeScore} - ${next.awayScore}`;
    if (next.completed) {
      if (next.homeScore > next.awayScore) next.winner = "home";
      else if (next.awayScore > next.homeScore) next.winner = "away";
      else next.winner = "draw";
    }
  }
  world.states.set(matchKey, next);

  const fixture = world.fixtures.get(matchKey);
  if (fixture) world.fixtures.set(matchKey, { ...fixture, status: next.status });
}

export function listMockFixtures(): Fixture[] {
  return [...world.fixtures.values()];
}

/**
 * The slate an empty mock world fills itself with, as offsets from now.
 *
 * Deliberately spread either side of the execution window: one match close
 * enough to kick off soon, several later today, and one tomorrow. A slate that
 * was entirely hours away would never reach `place_bet`, and one entirely
 * imminent would never produce a draft that waits.
 */
const MOCK_SLATE: ReadonlyArray<{
  sport: Sport;
  home: string;
  away: string;
  league: string;
  minutesFromNow: number;
}> = [
  { sport: "football", home: "Northbridge United", away: "Easthaven Rovers", league: "football/mock-premier", minutesFromNow: 40 },
  { sport: "football", home: "Kingsport Athletic", away: "Marlowe Town", league: "football/mock-premier", minutesFromNow: 180 },
  { sport: "football", home: "Ridgeway City", away: "Portvale Wanderers", league: "football/mock-championship", minutesFromNow: 360 },
  { sport: "basketball", home: "Harbour Falcons", away: "Summit Grizzlies", league: "basketball/mock-league", minutesFromNow: 120 },
  { sport: "basketball", home: "Delta Chargers", away: "Ironside Kings", league: "basketball/mock-league", minutesFromNow: 1_500 },
  { sport: "tennis", home: "A. Marchetti", away: "J. Okonkwo", league: "tennis/mock-open", minutesFromNow: 90 },
  { sport: "cricket", home: "Cape Mariners", away: "Fenwick Invitational", league: "cricket/mock-series", minutesFromNow: 300 },
];

/**
 * Fills an empty world with {@link MOCK_SLATE}.
 *
 * On unless `MOCK_AUTO_SEED=false`, because mock mode is meant to be a working
 * simulated bookmaker: with no fixtures the only outcome a cycle can reach is
 * "nothing on today", and the placement path — the one that has to be right
 * before a real operator is connected — is never exercised.
 *
 * The tests turn it off. They seed the exact fixtures their assertions depend
 * on, and a surprise slate underneath would make "no candidates" untestable.
 */
function seedSlateIfEmpty(): void {
  if (process.env.MOCK_AUTO_SEED === "false") return;
  if (world.fixtures.size > 0) return;

  const now = Date.now();
  for (const entry of MOCK_SLATE) {
    seedFixture({
      sport: entry.sport,
      home: entry.home,
      away: entry.away,
      league: entry.league,
      startsAt: new Date(now + entry.minutesFromNow * 60_000),
    });
  }
}

export function createMockSportsProvider(): SportsProvider {
  return {
    name: "mock",

    supports() {
      return true;
    },

    async listFixtures(sport, window) {
      seedSlateIfEmpty();

      return [...world.fixtures.values()]
        .filter((fixture) => fixture.sport === sport)
        .filter((fixture) => {
          const startsAt = new Date(fixture.startsAt).getTime();
          return startsAt >= window.from.getTime() && startsAt <= window.to.getTime();
        })
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },

    async getMatchState(fixture) {
      return world.states.get(fixture.matchKey) ?? null;
    },
  };
}
