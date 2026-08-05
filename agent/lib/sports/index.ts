/**
 * Sports-data provider selection and fan-out.
 *
 * Fixtures are merged across every registered provider that supports the sport,
 * keyed by `matchKey`, so adding a second free source widens coverage without
 * creating duplicate matches.
 */

import { getConfig, usesRealFixtureSource, type Sport } from "../config";
import { createLogger, errorMessage } from "../logger";
import { createEspnProvider } from "./espn";
import { createMockSportsProvider } from "./mock";
import type { OfferedMarket } from "../sheets";
import { readOperatorCard } from "./operator-card";
import type { Fixture, FixtureWindow, MatchState, SportsProvider } from "./types";

export * from "./types";
export {
  createMockSportsProvider,
  listMockFixtures,
  resetMockWorld,
  seedFixture,
  setMatchState,
} from "./mock";
export { operatorCardIsFresh, readOperatorCard } from "./operator-card";
export { findSameFixture, nameSimilarity, normaliseTeam } from "./matching";

const log = createLogger("sports");

let providers: SportsProvider[] | null = null;

function resolveProviders(): SportsProvider[] {
  if (providers) return providers;
  // Real fixtures need a real score feed, whatever the betting mode: a card read
  // off a bookmaker cannot be settled against a simulated world.
  const simulated = getConfig().mode === "mock" && !usesRealFixtureSource();
  providers = simulated ? [createMockSportsProvider()] : [createEspnProvider()];
  return providers;
}

/**
 * Fixture lists are cached briefly.
 *
 * A cycle now sweeps several times over the card, and each sweep asks for
 * fixtures twice — once to research, once to decide whether anything is left.
 * With forty competitions per sport that is hundreds of identical scoreboard
 * requests inside a few minutes. The card does not change on that timescale.
 */
const FIXTURE_CACHE_TTL_MS = 5 * 60_000;

interface CachedFixtures {
  fixtures: Fixture[];
  loadedAt: number;
}

const fixtureCache = new Map<string, CachedFixtures>();

/** Windows within the same minute share a cache entry. */
function cacheKey(sport: Sport, window: FixtureWindow): string {
  const minute = (date: Date): number => Math.floor(date.getTime() / 60_000);
  return `${sport}:${minute(window.from)}:${minute(window.to)}`;
}

/** Replaces the provider list. Used by tests and by custom deployments. */
export function setSportsProviders(next: SportsProvider[] | null): void {
  providers = next;
  fixtureCache.clear();
}

export interface DiscoveredFixtures {
  fixtures: (Fixture & { offers?: OfferedMarket[] })[];
  /** `operator` when the bookmaker's own card answered; `public` otherwise. */
  source: "operator" | "public";
  /** When the operator's card was last read, if there is one. */
  cardReadAt: string | null;
  /** True when a real catalogue is configured but has not been read recently. */
  cardStale: boolean;
}

/**
 * Fixtures to research, and where they came from.
 *
 * The operator's card wins whenever it is fresh: it is the only source that
 * says what can actually be backed, and researching anything else produces
 * candidates the bookmaker never priced. The public feed is the fallback for a
 * cycle that has not read the card yet — better a slightly wrong list than no
 * betting at all.
 */
export async function discoverFixtures(
  sport: Sport,
  window: FixtureWindow,
): Promise<DiscoveredFixtures> {
  // The card wins whenever there is a fresh one, in any mode. Mock mode governs
  // whether money moves, not where the fixtures come from.
  const card = await readOperatorCard(sport, window);
  if (card.fresh && card.fixtures.length > 0) {
    return { fixtures: card.fixtures, source: "operator", cardReadAt: card.readAt, cardStale: false };
  }

  // A real catalogue is configured and nobody has read it. Returning a
  // simulated or public list here is worse than returning nothing: research
  // spends its budget on matches this bookmaker may not offer, and the cycle
  // looks like it worked. Answer empty and say what is missing instead.
  if (usesRealFixtureSource()) {
    return { fixtures: [], source: "operator", cardReadAt: card.readAt, cardStale: true };
  }

  return {
    fixtures: await listFixtures(sport, window),
    source: "public",
    cardReadAt: card.readAt,
    cardStale: false,
  };
}

export async function listFixtures(sport: Sport, window: FixtureWindow): Promise<Fixture[]> {
  // The simulated feed is in-process and free, and caching it would hide a
  // fixture seeded a moment ago — which is exactly what tests do.
  const cacheable = getConfig().mode !== "mock" || usesRealFixtureSource();
  const key = cacheKey(sport, window);

  if (cacheable) {
    const cached = fixtureCache.get(key);
    if (cached && Date.now() - cached.loadedAt < FIXTURE_CACHE_TTL_MS) return cached.fixtures;
  }

  const merged = new Map<string, Fixture>();

  await Promise.all(
    resolveProviders()
      .filter((provider) => provider.supports(sport))
      .map(async (provider) => {
        try {
          for (const fixture of await provider.listFixtures(sport, window)) {
            if (!merged.has(fixture.matchKey)) merged.set(fixture.matchKey, fixture);
          }
        } catch (error) {
          log.warn("provider failed to list fixtures", {
            provider: provider.name,
            sport,
            error: errorMessage(error),
          });
        }
      }),
  );

  const fixtures = [...merged.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (cacheable) fixtureCache.set(key, { fixtures, loadedAt: Date.now() });
  return fixtures;
}

/** First provider that still recognises the fixture wins. */
export async function getMatchState(
  fixture: Pick<Fixture, "sport" | "providerId" | "matchKey" | "provider">,
): Promise<MatchState | null> {
  const ordered = [
    ...resolveProviders().filter((provider) => provider.name === fixture.provider),
    ...resolveProviders().filter((provider) => provider.name !== fixture.provider),
  ];

  for (const provider of ordered) {
    if (!provider.supports(fixture.sport)) continue;
    try {
      const state = await provider.getMatchState(fixture);
      if (state) return state;
    } catch (error) {
      log.warn("provider failed to read match state", {
        provider: provider.name,
        matchKey: fixture.matchKey,
        error: errorMessage(error),
      });
    }
  }
  return null;
}
