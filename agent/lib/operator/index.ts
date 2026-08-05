/**
 * The operator surface the rest of the system uses.
 *
 * Two modes sit behind one set of functions. `mock` runs the simulated
 * bookmaker entirely in memory, which is what lets the whole pipeline — staking,
 * placement, reconciliation, settlement, accounting — be tested offline.
 * `sandbox` drives a real site through agent-browser.
 *
 * The money-critical steps stay in code in both modes: the stake and the
 * minimum acceptable price come from the approved record, never from a model,
 * and placement is refused unless a claim row already authorises it.
 */

import { getConfig } from "../config";
import { createLogger, errorMessage } from "../logger";
import { parseOdds, roundMoney } from "../money";
import * as browser from "./browser";
import {
  mockBalance,
  mockListBets,
  mockLogin,
  mockPlaceBet,
  mockQuote,
} from "./mock";
import {
  OperatorError,
  type OperatorBet,
  type PlaceOutcome,
  type PlaceRequest,
  type Quote,
  type QuoteRequest,
} from "./types";

export * from "./types";
export {
  getMockBalance,
  listMockBets,
  resetMockOperator,
  setMockBalance,
  setMockOdds,
  setMockOddsDrift,
  setMockPlacementFault,
  settleMockBet,
  type PlacementFault,
} from "./mock";
export type { BrowserContext, PageText } from "./browser";

const log = createLogger("operator");

export function isMock(): boolean {
  const config = getConfig();
  return config.browserDriver === "mock" || config.operator.name === "mock";
}

export function operatorName(): string {
  return getConfig().operator.name;
}

/** Prices a real site can plausibly quote. Anything outside is a misread page. */
const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;

export function assertPlausibleOdds(odds: number, source: string): number {
  if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) {
    throw new OperatorError(
      `${source} reported a price of ${odds}, which is outside the plausible range ${MIN_ODDS}–${MAX_ODDS}. Re-read the page.`,
    );
  }
  return roundMoney(odds);
}

export async function login(ctx: browser.BrowserContext): Promise<void> {
  if (isMock()) return mockLogin();
  return browser.login(ctx);
}

/**
 * Current cash balance.
 *
 * In mock mode the simulated bookmaker is the source of truth. On a real site
 * the balance is displayed differently everywhere, so the Execution agent reads
 * it from the page and passes it here, where it is range-checked before being
 * trusted with anything.
 */
export async function readBalance(
  ctx: browser.BrowserContext,
  reported?: number,
): Promise<number> {
  if (isMock()) return mockBalance();

  if (reported === undefined || !Number.isFinite(reported) || reported < 0) {
    const page = await browser.readPage(ctx);
    browser.assertNoBlockers(page, "balance check");
    throw new OperatorError(
      "A balance must be read from the operator page and passed in. Open the account page, read the figure, and call again with it.",
    );
  }
  return roundMoney(reported);
}

export async function listBets(ctx: browser.BrowserContext): Promise<OperatorBet[]> {
  if (isMock()) return mockListBets();

  const config = getConfig();
  const page = await browser.open(ctx, config.operator.myBetsPath);
  browser.assertNoBlockers(page, "bet history");
  // A real history page is read by the Execution agent, which knows the layout
  // it is looking at. This path exists so reconciliation can still confirm the
  // page loaded and was not a challenge.
  return [];
}

export async function quote(
  ctx: browser.BrowserContext,
  request: QuoteRequest,
  reported?: { odds: number; eventRef: string },
): Promise<Quote | null> {
  if (isMock()) return mockQuote(request);

  if (!reported) {
    throw new OperatorError(
      "A price must be read from the operator page and passed in. Search for the event, open it, read the price for this selection, and call again with it.",
    );
  }
  return {
    eventRef: reported.eventRef,
    matchName: request.matchName,
    market: request.market,
    selection: request.selection,
    odds: assertPlausibleOdds(reported.odds, "the Execution agent"),
  };
}

/**
 * Submits one bet.
 *
 * On a real site the betslip sequence runs here rather than in the model: the
 * stake comes from the approved record, the live price is re-read and compared
 * against the approved minimum, and the stake field is verified before anything
 * is committed. An exception after submission is reported as `unknown` — never
 * as a failure — so the caller reconciles instead of placing again.
 */
export async function placeBet(
  ctx: browser.BrowserContext,
  request: PlaceRequest,
): Promise<PlaceOutcome> {
  if (isMock()) return mockPlaceBet(request);

  try {
    const page = await browser.readPage(ctx);
    browser.assertNoBlockers(page, "betslip");

    const slipOdds = parseOdds(
      (await browser.find(ctx, { by: "testid", query: "betslip-odds", action: "text" })) ??
        (await browser.find(ctx, { by: "label", query: "Odds", action: "text" })) ??
        "",
    );
    if (slipOdds === null) {
      return {
        status: "rejected",
        detail: "could not read a price from the betslip; nothing was submitted",
      };
    }
    if (slipOdds < request.minOdds) {
      return {
        status: "rejected",
        detail: `price moved to ${slipOdds}, below the approved minimum ${request.minOdds}`,
      };
    }

    const stakeText = request.stake.toFixed(2);
    const filled = await browser.tryFind(ctx, {
      by: "label",
      query: "Stake",
      action: "fill",
      value: stakeText,
    });
    if (!filled) {
      return { status: "rejected", detail: "could not find the stake field; nothing was submitted" };
    }

    browser.assertNoBlockers(await browser.readPage(ctx), "before placement");

    const submitted = await browser.tryFind(ctx, {
      by: "role",
      query: "button",
      name: "Place bet",
      action: "click",
    });
    if (!submitted) {
      return { status: "rejected", detail: "could not find the place-bet button" };
    }

    // Past this line the bet may already exist. Nothing here may report failure.
    const receipt = await browser.readPage(ctx);
    const reference = receipt.text.match(/\b(?:bet|ticket|ref(?:erence)?)\s*(?:id|no\.?|#)?\s*[:#]?\s*([A-Z0-9-]{6,})/i);

    if (reference) {
      return {
        status: "placed",
        reference: reference[1],
        odds: slipOdds,
        stake: request.stake,
      };
    }

    return {
      status: "unknown",
      detail: "submitted but no bet reference was found on the page; reconcile against bet history",
    };
  } catch (error) {
    if (error instanceof OperatorError && error.needsHuman) {
      return { status: "needs_human", detail: error.message };
    }
    // An exception after submission cannot prove the bet did not land.
    log.warn("placement ended in an unknown state", { error: errorMessage(error) });
    return { status: "unknown", detail: errorMessage(error) };
  }
}

export async function close(ctx: browser.BrowserContext): Promise<void> {
  if (isMock()) return;
  await browser.close(ctx);
}
