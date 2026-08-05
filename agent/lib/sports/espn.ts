/**
 * Fixtures and live scores from ESPN's public scoreboard endpoints.
 *
 * These are free and need no key. They are also undocumented, so every field is
 * read defensively and a malformed or moved endpoint degrades to "no fixtures"
 * rather than throwing into the cycle.
 *
 * League coverage is data, not code: override `ESPN_LEAGUES_<SPORT>` to follow
 * different competitions without a redeploy.
 */

import type { Sport } from "../config";
import { matchKey as buildMatchKey } from "../ids";
import { createLogger, errorMessage } from "../logger";
import type { Fixture, FixtureWindow, MatchState, MatchStatus, SportsProvider } from "./types";

const log = createLogger("sports:espn");
const BASE = "https://site.api.espn.com/apis/site/v2/sports";
const TIMEOUT_MS = 12_000;

/** `<espn sport path>/<league slug>` pairs queried for each supported sport. */
const DEFAULT_LEAGUES: Record<Sport, string[]> = {
  football: [
    "soccer/eng.1",
    "soccer/esp.1",
    "soccer/ger.1",
    "soccer/ita.1",
    "soccer/fra.1",
    "soccer/uefa.champions",
    "soccer/uefa.europa",
  ],
  basketball: ["basketball/nba", "basketball/wnba", "basketball/nba-development"],
  cricket: ["cricket/8039", "cricket/8048"],
  tennis: ["tennis/atp", "tennis/wta"],
};

function leaguesFor(sport: Sport): string[] {
  const override = process.env[`ESPN_LEAGUES_${sport.toUpperCase()}`]?.trim();
  if (!override) return DEFAULT_LEAGUES[sport];
  return override
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "betagents/1.0" },
    });
    if (!response.ok) {
      log.debug("scoreboard request rejected", { url, status: response.status });
      return null;
    }
    return await response.json();
  } catch (error) {
    log.debug("scoreboard request failed", { url, error: errorMessage(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStatus(event: Record<string, unknown>): { status: MatchStatus; completed: boolean; clock: string } {
  const status = asRecord(event.status);
  const type = asRecord(status?.type);
  const state = String(type?.state ?? "").toLowerCase();
  const completed = type?.completed === true;
  const clock = String(type?.shortDetail ?? type?.description ?? "");

  let mapped: MatchStatus = "unknown";
  if (state === "pre") mapped = "scheduled";
  else if (state === "in") mapped = "live";
  else if (state === "post") mapped = completed ? "final" : "postponed";

  const description = String(type?.description ?? "").toLowerCase();
  if (description.includes("postponed") || description.includes("canceled")) mapped = "postponed";

  return { status: mapped, completed, clock };
}

/** Competitor naming differs between team sports and tennis. */
function competitorName(competitor: Record<string, unknown>): string {
  const team = asRecord(competitor.team);
  if (team) {
    return String(team.displayName ?? team.name ?? team.shortDisplayName ?? "").trim();
  }
  const athlete = asRecord(competitor.athlete);
  if (athlete) {
    return String(athlete.displayName ?? athlete.shortName ?? "").trim();
  }
  const roster = asArray(competitor.roster)
    .map((entry) => {
      const record = asRecord(entry);
      const athleteEntry = asRecord(record?.athlete);
      return String(athleteEntry?.displayName ?? "").trim();
    })
    .filter(Boolean);
  return roster.join(" / ");
}

function competitorScore(competitor: Record<string, unknown>): number | null {
  const raw = competitor.score;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    // Cricket scores arrive as strings such as "245/6".
    const parsed = Number(raw.split("/")[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const nested = asRecord(raw);
  if (nested) {
    const parsed = Number(nested.value ?? nested.displayValue);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function displayScore(competitor: Record<string, unknown>): string {
  const raw = competitor.score;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (typeof raw === "number") return String(raw);
  const nested = asRecord(raw);
  if (nested) return String(nested.displayValue ?? nested.value ?? "");
  return "";
}

interface ParsedEvent {
  fixture: Fixture;
  state: MatchState;
}

function parseEvent(sport: Sport, leaguePath: string, raw: unknown): ParsedEvent | null {
  const event = asRecord(raw);
  if (!event) return null;

  const competition = asRecord(asArray(event.competitions)[0]);
  const competitors = asArray(competition?.competitors)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (competitors.length < 2) return null;

  const home =
    competitors.find((entry) => String(entry.homeAway ?? "") === "home") ?? competitors[0]!;
  const away =
    competitors.find((entry) => String(entry.homeAway ?? "") === "away") ?? competitors[1]!;

  const homeName = competitorName(home);
  const awayName = competitorName(away);
  if (!homeName || !awayName) return null;

  const startsAtRaw = String(event.date ?? competition?.date ?? "");
  const startsAt = new Date(startsAtRaw);
  if (Number.isNaN(startsAt.getTime())) return null;

  const { status, completed, clock } = readStatus(event);
  const providerId = `${leaguePath}#${String(event.id ?? "")}`;
  const key = buildMatchKey({
    sport,
    home: homeName,
    away: awayName,
    startsAt: startsAt.toISOString(),
  });

  const homeScore = competitorScore(home);
  const awayScore = competitorScore(away);

  let winner: MatchState["winner"] = null;
  if (completed) {
    if (home.winner === true) winner = "home";
    else if (away.winner === true) winner = "away";
    else if (homeScore !== null && awayScore !== null) {
      if (homeScore > awayScore) winner = "home";
      else if (awayScore > homeScore) winner = "away";
      else winner = "draw";
    }
  }

  const homeDisplay = displayScore(home);
  const awayDisplay = displayScore(away);

  return {
    fixture: {
      sport,
      matchKey: key,
      home: homeName,
      away: awayName,
      league: leaguePath,
      startsAt: startsAt.toISOString(),
      status,
      provider: "espn",
      providerId,
    },
    state: {
      matchKey: key,
      status,
      homeScore,
      awayScore,
      displayScore: homeDisplay || awayDisplay ? `${homeDisplay || 0} - ${awayDisplay || 0}` : "",
      clock,
      winner,
      provider: "espn",
      completed,
    },
  };
}

async function fetchLeague(sport: Sport, leaguePath: string, date: Date): Promise<ParsedEvent[]> {
  const url = `${BASE}/${leaguePath}/scoreboard?dates=${yyyymmdd(date)}`;
  const body = asRecord(await getJson(url));
  if (!body) return [];
  return asArray(body.events)
    .map((event) => parseEvent(sport, leaguePath, event))
    .filter((entry): entry is ParsedEvent => entry !== null);
}

/** Days covered by the window, capped so a wide range cannot fan out unbounded. */
function daysIn(window: FixtureWindow): Date[] {
  const days: Date[] = [];
  const cursor = new Date(
    Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), window.from.getUTCDate()),
  );
  while (cursor.getTime() <= window.to.getTime() && days.length < 4) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function createEspnProvider(): SportsProvider {
  return {
    name: "espn",

    supports() {
      return true;
    },

    async listFixtures(sport, window) {
      const leagues = leaguesFor(sport);
      const days = daysIn(window);
      const requests = leagues.flatMap((league) =>
        days.map((day) => fetchLeague(sport, league, day)),
      );

      const settled = await Promise.all(requests);
      const seen = new Map<string, Fixture>();

      for (const parsed of settled.flat()) {
        const startsAt = new Date(parsed.fixture.startsAt).getTime();
        if (startsAt < window.from.getTime() || startsAt > window.to.getTime()) continue;
        if (!seen.has(parsed.fixture.matchKey)) seen.set(parsed.fixture.matchKey, parsed.fixture);
      }

      const fixtures = [...seen.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      log.debug("fixtures discovered", { sport, count: fixtures.length, leagues: leagues.length });
      return fixtures;
    },

    async getMatchState(fixture) {
      const [leaguePath, eventId] = fixture.providerId.split("#");
      if (!leaguePath || !eventId) return null;

      const body = asRecord(await getJson(`${BASE}/${leaguePath}/scoreboard/${eventId}`));
      const events = body ? asArray(body.events) : [];
      const direct = events.length > 0 ? parseEvent(fixture.sport, leaguePath, events[0]) : null;
      if (direct) return direct.state;

      // The per-event route is not available for every league; fall back to
      // scanning the scoreboard for the day the fixture belongs to.
      const summary = asRecord(await getJson(`${BASE}/${leaguePath}/scoreboard`));
      for (const event of asArray(summary?.events)) {
        const parsed = parseEvent(fixture.sport, leaguePath, event);
        if (parsed?.fixture.matchKey === fixture.matchKey) return parsed.state;
      }
      return null;
    },
  };
}
