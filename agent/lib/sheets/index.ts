/**
 * Store construction and process-wide singleton.
 *
 * Falls back to the in-memory store when Google credentials are absent, so
 * `eve dev` and the test suite run without any external setup.
 */

import { getConfig } from "../config";
import { createLogger } from "../logger";
import { createSheetsApi } from "./api";
import { createTokenProvider } from "./auth";
import { createMemoryStore, createSheetsStore, type Store } from "./store";

export * from "./schema";
export { type Store, tolerate } from "./store";

const log = createLogger("sheets");

let instance: Store | null = null;
let initPromise: Promise<Store> | null = null;

function build(): Store {
  const config = getConfig();
  if (!config.sheets) {
    log.warn("no Google Sheets credentials; using the in-memory store (data is not persisted)");
    return createMemoryStore();
  }
  const tokens = createTokenProvider(config.sheets);
  return createSheetsStore(createSheetsApi(config.sheets.spreadsheetId, tokens));
}

/** Returns the shared store, creating tabs on first use. */
export function getStore(): Promise<Store> {
  initPromise ??= (async () => {
    const store = build();
    await store.init();
    instance = store;
    return store;
  })().catch((error) => {
    // Let the next caller retry rather than caching a failed initialisation.
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/** Replaces the shared store. Used by the test harness. */
export function setStore(store: Store | null): void {
  instance = store;
  initPromise = store ? Promise.resolve(store) : null;
}

export function peekStore(): Store | null {
  return instance;
}
