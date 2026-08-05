/**
 * Minimal Google Sheets v4 REST client.
 *
 * Only the handful of calls this system needs, with retry on the transient
 * failures Sheets actually returns (429 quota, 5xx backend).
 */

import { createLogger } from "../logger";
import type { TokenProvider } from "./auth";

const BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_ATTEMPTS = 5;

const log = createLogger("sheets:api");

export class SheetsApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SheetsApiError";
    this.status = status;
    this.retryable = status === 429 || status === 408 || status >= 500;
  }
}

export type CellValue = string | number | boolean | null;

export interface SheetsApi {
  listTabs(): Promise<string[]>;
  createTabs(titles: string[]): Promise<void>;
  getValues(range: string): Promise<CellValue[][]>;
  appendRows(range: string, rows: CellValue[][]): Promise<void>;
  updateValues(range: string, rows: CellValue[][]): Promise<void>;
  clearRange(range: string): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSheetsApi(spreadsheetId: string, tokens: TokenProvider): SheetsApi {
  async function request<T>(
    path: string,
    init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${BASE_URL}/${spreadsheetId}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let lastError: SheetsApiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const token = await tokens.getAccessToken();
      const response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const text = await response.text().catch(() => "");
      const error = new SheetsApiError(
        `Sheets ${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`,
        response.status,
      );

      if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;

      lastError = error;
      const backoff = Math.min(2 ** attempt * 250, 8000) + Math.random() * 250;
      log.warn("retrying Sheets request", { path, status: response.status, attempt, backoff });
      await delay(backoff);
    }

    throw lastError ?? new SheetsApiError(`Sheets request to ${path} failed`, 500);
  }

  return {
    async listTabs() {
      const body = await request<{ sheets?: { properties?: { title?: string } }[] }>("", {
        query: { fields: "sheets.properties.title" },
      });
      return (body.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => typeof title === "string");
    },

    async createTabs(titles) {
      if (titles.length === 0) return;
      await request(":batchUpdate", {
        method: "POST",
        body: {
          requests: titles.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    },

    async getValues(range) {
      const body = await request<{ values?: CellValue[][] }>(
        `/values/${encodeURIComponent(range)}`,
        { query: { valueRenderOption: "UNFORMATTED_VALUE" } },
      );
      return body.values ?? [];
    },

    async appendRows(range, rows) {
      if (rows.length === 0) return;
      await request(`/values/${encodeURIComponent(range)}:append`, {
        method: "POST",
        query: {
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
        },
        body: { values: rows },
      });
    },

    async updateValues(range, rows) {
      await request(`/values/${encodeURIComponent(range)}`, {
        method: "PUT",
        query: { valueInputOption: "RAW" },
        body: { values: rows },
      });
    },

    async clearRange(range) {
      await request(`/values/${encodeURIComponent(range)}:clear`, { method: "POST", body: {} });
    },
  };
}
