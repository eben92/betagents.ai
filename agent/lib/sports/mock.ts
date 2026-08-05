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

export function createMockSportsProvider(): SportsProvider {
  return {
    name: "mock",

    supports() {
      return true;
    },

    async listFixtures(sport, window) {
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
