/**
 * Typed record store over a spreadsheet.
 *
 * Tabs are created on demand with their header row. Reads are cached briefly so
 * one cycle does not re-read the same tab a dozen times, and all writes are
 * serialised through a single queue.
 *
 * This assumes a single application instance owns the spreadsheet. Sheets has no
 * transactions, so two concurrent processes could interleave an append; the
 * cycle lock in `system_state` narrows that to a startup race, and the
 * `idempotencyKey` guard on `bets` makes duplicate execution impossible even if
 * one slips through.
 */

import { createLogger, errorMessage } from "../logger";
import type { CellValue, SheetsApi } from "./api";
import {
  ALL_TABS,
  TAB,
  TAB_SCHEMAS,
  type TabName,
  type TabRecords,
  type TabSchema,
} from "./schema";

const log = createLogger("sheets:store");
const CACHE_TTL_MS = 15_000;

export interface Store {
  /** Creates any missing tabs and header rows. Safe to call repeatedly. */
  init(): Promise<void>;
  list<T extends TabName>(tab: T): Promise<TabRecords[T][]>;
  find<T extends TabName>(
    tab: T,
    predicate: (record: TabRecords[T]) => boolean,
  ): Promise<TabRecords[T] | null>;
  append<T extends TabName>(tab: T, record: TabRecords[T]): Promise<TabRecords[T]>;
  /**
   * Appends only when no existing row shares the tab's `uniqueBy` value.
   * Returns `created: false` with the existing row otherwise.
   */
  appendUnique<T extends TabName>(
    tab: T,
    record: TabRecords[T],
  ): Promise<{ created: boolean; record: TabRecords[T] }>;
  update<T extends TabName>(
    tab: T,
    id: string,
    patch: Partial<TabRecords[T]>,
  ): Promise<TabRecords[T] | null>;
  /** Overwrites every data row. Used for tabs that are materialised views. */
  replaceAll<T extends TabName>(tab: T, records: TabRecords[T][]): Promise<void>;
  getValue(tab: typeof TAB.state | typeof TAB.settings, key: string): Promise<string | null>;
  setValue(tab: typeof TAB.state | typeof TAB.settings, key: string, value: string): Promise<void>;
  invalidate(tab?: TabName): void;
}

function columnLetter(index: number): string {
  let remaining = index + 1;
  let letters = "";
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + modulo) + letters;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return letters;
}

function encodeCell(value: unknown, type: TabSchema["columns"][number]["type"]): CellValue {
  if (value === undefined || value === null) return type === "number" ? 0 : "";
  switch (type) {
    case "number": {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "boolean":
      return value === true || value === "true" || value === "TRUE";
    case "json":
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    default:
      return String(value);
  }
}

function decodeCell(cell: CellValue | undefined, type: TabSchema["columns"][number]["type"]): unknown {
  switch (type) {
    case "number": {
      if (typeof cell === "number") return cell;
      const parsed = Number(cell ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "boolean":
      return cell === true || cell === "TRUE" || cell === "true";
    case "json": {
      if (typeof cell !== "string" || cell.trim() === "") return null;
      try {
        return JSON.parse(cell);
      } catch {
        return null;
      }
    }
    default:
      return cell === null || cell === undefined ? "" : String(cell);
  }
}

function encodeRow(schema: TabSchema, record: Record<string, unknown>): CellValue[] {
  return schema.columns.map((column) => encodeCell(record[column.name], column.type));
}

function decodeRow(schema: TabSchema, row: CellValue[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  schema.columns.forEach((column, index) => {
    record[column.name] = decodeCell(row[index], column.type);
  });
  return record;
}

/** The column a row is addressed by for updates: always the first column. */
function idColumn(schema: TabSchema): string {
  return schema.columns[0]!.name;
}

/**
 * Record types are closed interfaces, so they do not structurally satisfy an
 * index signature. These two casts are the single place that boundary is
 * crossed; the codec above is what actually guarantees the shape.
 */
function asRow(record: unknown): Record<string, unknown> {
  return record as Record<string, unknown>;
}

function asRecord<T>(row: Record<string, unknown>): T {
  return row as unknown as T;
}

interface CachedTab {
  records: Record<string, unknown>[];
  /** 1-based spreadsheet row number for each record, parallel to `records`. */
  rowNumbers: number[];
  loadedAt: number;
}

export function createSheetsStore(api: SheetsApi): Store {
  const cache = new Map<TabName, CachedTab>();
  let writeQueue: Promise<unknown> = Promise.resolve();
  let initialised = false;

  /** Serialises writes so two appends cannot target the same spreadsheet row. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => undefined);
    return result;
  }

  async function load(tab: TabName): Promise<CachedTab> {
    const cached = cache.get(tab);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

    const schema = TAB_SCHEMAS[tab];
    const lastColumn = columnLetter(schema.columns.length - 1);
    const rows = await api.getValues(`${tab}!A1:${lastColumn}`);

    const records: Record<string, unknown>[] = [];
    const rowNumbers: number[] = [];
    // Row 1 is the header.
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.every((cell) => cell === null || cell === undefined || cell === "")) continue;
      records.push(decodeRow(schema, row));
      rowNumbers.push(index + 1);
    }

    const fresh: CachedTab = { records, rowNumbers, loadedAt: Date.now() };
    cache.set(tab, fresh);
    return fresh;
  }

  return {
    async init() {
      if (initialised) return;
      const existing = new Set(await api.listTabs());
      const missing = ALL_TABS.filter((tab) => !existing.has(tab));

      if (missing.length > 0) {
        log.info("creating missing spreadsheet tabs", { tabs: missing });
        await api.createTabs(missing);
      }

      // Write header rows for tabs that are new or empty.
      for (const tab of ALL_TABS) {
        const schema = TAB_SCHEMAS[tab];
        const lastColumn = columnLetter(schema.columns.length - 1);
        const header = await api.getValues(`${tab}!A1:${lastColumn}1`);
        const headerRow = header[0] ?? [];
        const expected = schema.columns.map((column) => column.name);
        const matches =
          headerRow.length >= expected.length &&
          expected.every((name, index) => String(headerRow[index] ?? "") === name);
        if (!matches) {
          await api.updateValues(`${tab}!A1:${lastColumn}1`, [expected]);
          cache.delete(tab);
        }
      }

      initialised = true;
    },

    async list(tab) {
      const cached = await load(tab);
      return cached.records.map((record) => asRecord<TabRecords[typeof tab]>({ ...record }));
    },

    async find(tab, predicate) {
      const records = await this.list(tab);
      return records.find(predicate) ?? null;
    },

    append(tab, record) {
      return enqueue(async () => {
        const schema = TAB_SCHEMAS[tab];
        await api.appendRows(`${tab}!A1`, [encodeRow(schema, asRow(record))]);
        cache.delete(tab);
        return record;
      });
    },

    appendUnique(tab, record) {
      return enqueue(async () => {
        const schema = TAB_SCHEMAS[tab];
        const key = schema.uniqueBy;
        if (key) {
          // Bypass the cache: a stale read here would allow a duplicate bet.
          cache.delete(tab);
          const existing = await load(tab);
          const wanted = String(asRow(record)[key] ?? "");
          const match = existing.records.find((row) => String(row[key] ?? "") === wanted);
          if (match) {
            return { created: false, record: asRecord<TabRecords[typeof tab]>({ ...match }) };
          }
        }
        await api.appendRows(`${tab}!A1`, [encodeRow(schema, asRow(record))]);
        cache.delete(tab);
        return { created: true, record };
      });
    },

    update(tab, id, patch) {
      return enqueue(async () => {
        const schema = TAB_SCHEMAS[tab];
        cache.delete(tab);
        const cached = await load(tab);
        const column = idColumn(schema);
        const index = cached.records.findIndex((row) => String(row[column] ?? "") === id);
        if (index === -1) {
          log.warn("update target not found", { tab, id });
          return null;
        }

        const merged: Record<string, unknown> = { ...cached.records[index], ...asRow(patch) };
        const rowNumber = cached.rowNumbers[index]!;
        const lastColumn = columnLetter(schema.columns.length - 1);
        await api.updateValues(`${tab}!A${rowNumber}:${lastColumn}${rowNumber}`, [
          encodeRow(schema, merged),
        ]);
        cache.delete(tab);
        return asRecord<TabRecords[typeof tab]>(merged);
      });
    },

    replaceAll(tab, records) {
      return enqueue(async () => {
        const schema = TAB_SCHEMAS[tab];
        const lastColumn = columnLetter(schema.columns.length - 1);
        await api.clearRange(`${tab}!A2:${lastColumn}`);
        if (records.length > 0) {
          await api.appendRows(
            `${tab}!A1`,
            records.map((record) => encodeRow(schema, asRow(record))),
          );
        }
        cache.delete(tab);
      });
    },

    async getValue(tab, key) {
      const rows = await this.list(tab);
      const match = rows.find((row) => row.key === key);
      return match ? match.value : null;
    },

    async setValue(tab, key, value) {
      const updatedAt = new Date().toISOString();
      const result = await this.appendUnique(tab, { key, value, updatedAt });
      if (!result.created) await this.update(tab, key, { value, updatedAt });
    },

    invalidate(tab) {
      if (tab) cache.delete(tab);
      else cache.clear();
    },
  };
}

/**
 * In-memory store with identical semantics. Backs the end-to-end tests and lets
 * the app boot before Google credentials are configured.
 */
export function createMemoryStore(): Store {
  const tables = new Map<TabName, Record<string, unknown>[]>();

  function table(tab: TabName): Record<string, unknown>[] {
    let rows = tables.get(tab);
    if (!rows) {
      rows = [];
      tables.set(tab, rows);
    }
    return rows;
  }

  /** Round-trips through the codec so tests see the same coercions as Sheets. */
  function normalise(tab: TabName, record: Record<string, unknown>): Record<string, unknown> {
    const schema = TAB_SCHEMAS[tab];
    return decodeRow(schema, encodeRow(schema, record));
  }

  const store: Store = {
    async init() {
      for (const tab of ALL_TABS) table(tab);
    },

    async list(tab) {
      return table(tab).map((record) => asRecord<TabRecords[typeof tab]>({ ...record }));
    },

    async find(tab, predicate) {
      const records = await store.list(tab);
      return records.find(predicate) ?? null;
    },

    async append(tab, record) {
      table(tab).push(normalise(tab, asRow(record)));
      return record;
    },

    async appendUnique(tab, record) {
      const schema = TAB_SCHEMAS[tab];
      const key = schema.uniqueBy;
      if (key) {
        const wanted = String(asRow(record)[key] ?? "");
        const match = table(tab).find((row) => String(row[key] ?? "") === wanted);
        if (match) return { created: false, record: asRecord<TabRecords[typeof tab]>({ ...match }) };
      }
      table(tab).push(normalise(tab, asRow(record)));
      return { created: true, record };
    },

    async update(tab, id, patch) {
      const schema = TAB_SCHEMAS[tab];
      const column = idColumn(schema);
      const rows = table(tab);
      const index = rows.findIndex((row) => String(row[column] ?? "") === id);
      if (index === -1) return null;
      const merged = normalise(tab, { ...rows[index], ...asRow(patch) });
      rows[index] = merged;
      return asRecord<TabRecords[typeof tab]>(merged);
    },

    async replaceAll(tab, records) {
      tables.set(
        tab,
        records.map((record) => normalise(tab, asRow(record))),
      );
    },

    async getValue(tab, key) {
      const match = table(tab).find((row) => row.key === key);
      return match ? String(match.value ?? "") : null;
    },

    async setValue(tab, key, value) {
      const updatedAt = new Date().toISOString();
      const rows = table(tab);
      const index = rows.findIndex((row) => row.key === key);
      if (index === -1) rows.push({ key, value, updatedAt });
      else rows[index] = { key, value, updatedAt };
    },

    invalidate() {
      // Nothing is cached in memory.
    },
  };

  return store;
}

/** Wraps a store operation so a Sheets outage degrades instead of crashing. */
export async function tolerate<T>(operation: () => Promise<T>, fallback: T, scope: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    log.error("storage operation failed", { scope, error: errorMessage(error) });
    return fallback;
  }
}
