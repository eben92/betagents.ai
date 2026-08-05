/**
 * Sports-data provider selection and fan-out.
 *
 * Fixtures are merged across every registered provider that supports the sport,
 * keyed by `matchKey`, so adding a second free source widens coverage without
 * creating duplicate matches.
 */

import { getConfig, type Sport } from "../config";
import { createLogger, errorMessage } from "../logger";
import { createEspnProvider } from "./espn";
import { createMockSportsProvider } from "./mock";
import type { Fixture, FixtureWindow, MatchState, SportsProvider } from "./types";

export * from "./types";
export { resetMockWorld, seedFixture, setMatchState, listMockFixtures } from "./mock";

const log = createLogger("sports");

let providers: SportsProvider[] | null = null;

function resolveProviders(): SportsProvider[] {
  if (providers) return providers;
  providers =
    getConfig().mode === "mock" ? [createMockSportsProvider()] : [createEspnProvider()];
  return providers;
}

/** Replaces the provider list. Used by tests and by custom deployments. */
export function setSportsProviders(next: SportsProvider[] | null): void {
  providers = next;
}

export async function listFixtures(sport: Sport, window: FixtureWindow): Promise<Fixture[]> {
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

  return [...merged.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
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
