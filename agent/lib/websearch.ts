/**
 * Web search for models whose provider does not run it for them.
 *
 * eve's built-in `web_search` has no local executor — the model provider runs
 * the search. Only Anthropic, OpenAI and Google implement it, so an agent on
 * DeepSeek, Kimi, Groq or anything reached as an OpenAI-compatible endpoint is
 * simply not offered the tool. Research then has no way to discover a source,
 * which in practice means it invents URLs and collects 404s.
 *
 * This module backs a replacement for exactly those providers, with two search
 * modes because research needs two different things and one of them cannot be
 * answered by news:
 *
 * - **News** for what happened to a team in the last few days: injuries,
 *   lineups, postponements.
 * - **The open web** for what other people are predicting about a fixture —
 *   preview sites, tipsters, forum threads. None of that is news, so a news
 *   index cannot find it, and searching news for `"x vs y" prediction reddit`
 *   returns nothing useful however the query is worded.
 *
 * Neither needs an API key, an account or a vendor.
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

    const url = unwrapRedirect(field(item, "link"));
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
 * Search engines hand back tracking redirects rather than the publisher's URL:
 * DuckDuckGo carries the real address in `uddg`, Bing News in `url`.
 *
 * Unwrapping here is what makes a result directly fetchable. Left wrapped, each
 * one costs `web_fetch` a redirect round-trip that the agent has to notice and
 * repeat — and a run of them trips a bot check, which is exactly what happened:
 * ten of ten fetch failures in one cycle were redirect hops, one of them landing
 * on a captcha page.
 */
const REDIRECT_PARAMS = ["uddg", "url", "u"];

export function unwrapRedirect(href: string): string {
  const raw = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    for (const param of REDIRECT_PARAMS) {
      const target = url.searchParams.get(param);
      if (target && /^https?:\/\//i.test(decodeURIComponent(target))) {
        return decodeURIComponent(target);
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** Results out of a DuckDuckGo HTML page. */
export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const anchor = /<a[^>]+class="[^"]*result-link|<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = match[1];
    const title = toPlainText(match[2] ?? "");
    if (!href || !title) continue;

    const url = unwrapRedirect(decodeEntities(href));
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }

    results.push({ title, url, source: host, publishedAt: "", snippet: "" });
    if (results.length >= limit) break;
  }

  return results;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
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
 * General web search, returning links that can be fetched directly.
 *
 * DuckDuckGo's keyless HTML endpoints, lite first because it is smaller and
 * changes shape less often. This is the mode that reaches prediction sites,
 * tipster pages and forum threads.
 */
export async function searchWeb(query: string, limit = 8): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query.trim());
  if (!encoded) return [];

  const endpoints = [
    `https://lite.duckduckgo.com/lite/?q=${encoded}`,
    `https://html.duckduckgo.com/html/?q=${encoded}`,
  ];

  for (const endpoint of endpoints) {
    const html = await fetchPage(endpoint);
    if (!html) continue;
    const results = parseDuckDuckGo(html, limit);
    if (results.length > 0) return results;
  }

  return [];
}

/**
 * Searches recent news for a query.
 *
 * Bing News RSS only, then the open web. Google News is deliberately absent:
 * its RSS `<link>` is an opaque `news.google.com/rss/articles/<base64>` wrapper
 * that cannot be resolved without fetching it, so every result costs `web_fetch`
 * a redirect the agent has to notice and repeat — and a run of them lands on a
 * captcha page. Bing's RSS carries the publisher's own URL, and the web search
 * below returns direct links, so nothing is lost by dropping it.
 */
export async function searchNews(query: string, limit = 8): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query.trim());
  if (!encoded) return [];

  const xml = await fetchRss(`https://www.bing.com/news/search?q=${encoded}&format=RSS`);
  const results = xml ? parseRss(xml, limit) : [];
  if (results.length > 0) return results;

  return searchWeb(query, limit);
}
