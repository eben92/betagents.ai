/**
 * Shared shapes for fixture discovery and live score tracking.
 *
 * Providers are free, public, key-less sources. Adding one means implementing
 * `SportsProvider` and registering it; nothing else in the system changes.
 */

import type { Sport } from "../config";

export type MatchStatus = "scheduled" | "live" | "final" | "postponed" | "unknown";

export interface Fixture {
  sport: Sport;
  matchKey: string;
  home: string;
  away: string;
  league: string;
  /** ISO 8601 kickoff/start time. */
  startsAt: string;
  status: MatchStatus;
  provider: string;
  providerId: string;
}

export interface MatchState {
  matchKey: string;
  status: MatchStatus;
  homeScore: number | null;
  awayScore: number | null;
  /** Human-readable score for reports, e.g. `2 - 1`. */
  displayScore: string;
  clock: string;
  winner: "home" | "away" | "draw" | null;
  provider: string;
  /** True once the result is final and safe to settle against. */
  completed: boolean;
}

export interface FixtureWindow {
  from: Date;
  to: Date;
}

export interface SportsProvider {
  name: string;
  supports(sport: Sport): boolean;
  listFixtures(sport: Sport, window: FixtureWindow): Promise<Fixture[]>;
  /** Current state of a known fixture, or null when the provider loses it. */
  getMatchState(fixture: Pick<Fixture, "sport" | "providerId" | "matchKey">): Promise<MatchState | null>;
}
