/**
 * Web search for models whose provider does not run it for them.
 *
 * eve's built-in `web_search` has no local executor — the model provider runs
 * the search. Only Anthropic, OpenAI and Google implement it, so an agent on
 * DeepSeek, Kimi, Groq or anything reached as an OpenAI-compatible endpoint is
 * simply not offered the tool. Research then has no way to discover a source,
 * which in practice means it invents URLs and collects 404s.
 *
 * This module backs a replacement for exactly those providers. It queries news
 * RSS, which suits the question this system asks — what happened to this team in
 * the last few days — better than general web search, and needs no API key,
 * no account and no vendor.
 */

import { createLogger, errorMessage } from "./logger";

const log = createLogger("websearch");

const TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 15_000);

/**
 * RSS is served to browsers. Without a browser agent Google answers 302 to a
 * consent page and Bing answers nothing at all.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Providers that run `web_search` themselves, from eve's own implementations
 * (`WEB_SEARCH_{ANTHROPIC,OPENAI,GOOGLE}_OUTPUT_SCHEMA`). For these the built-in
 * is better than anything here — it is the model's native, ranked search — so
 * this module stands aside.
 */
const NATIVE_WEB_SEARCH_PROVIDERS = new Set(["anthropic", "openai", "google"]);

/** True when `provider:model-id` names a provider that searches for itself. */
export function providerHasNativeWebSearch(spec: string): boolean {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  const separator = colon > 0 ? colon : trimmed.indexOf("/");
  if (separator <= 0) return false;
  return NATIVE_WEB_SEARCH_PROVIDERS.has(trimmed.slice(0, separator).toLowerCase());
}

export interface SearchResult {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  snippet: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Strips the markup news feeds put in `<description>`. */
function toPlainText(value: string): string {
  return decodeEntities(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function field(item: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(item);
  return match?.[1] ? decodeEntities(match[1]).trim() : "";
}

function parseRss(xml: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    if (!item) continue;

    const url = field(item, "link");
    const title = toPlainText(field(item, "title"));
    if (!url || !title) continue;

    results.push({
      title,
      url,
      source: toPlainText(field(item, "source")),
      publishedAt: field(item, "pubDate"),
      snippet: toPlainText(field(item, "description")).slice(0, 400),
    });

    if (results.length >= limit) break;
  }

  return results;
}

async function fetchRss(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      log.debug("search endpoint refused", { url, status: response.status });
      return null;
    }
    return await response.text();
  } catch (error) {
    log.debug("search endpoint failed", { url, error: errorMessage(error) });
    return null;
  }
}

/**
 * Searches recent news for a query.
 *
 * Google News first, Bing News second. Two independent providers because this
 * is the Research agent's only route to evidence: one of them rate-limiting or
 * changing shape should cost result quality, not the whole capability.
 */
export async function searchNews(query: string, limit = 8): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query.trim());
  if (!encoded) return [];

  const endpoints = [
    `https://news.google.com/rss/search?q=${encoded}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://www.bing.com/news/search?q=${encoded}&format=RSS`,
  ];

  for (const endpoint of endpoints) {
    const xml = await fetchRss(endpoint);
    if (!xml) continue;

    const results = parseRss(xml, limit);
    if (results.length > 0) return results;
  }

  return [];
}
