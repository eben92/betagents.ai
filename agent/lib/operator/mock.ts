/**
 * Simulated betting operator.
 *
 * This is the mock betting environment: a complete in-memory bookmaker with a
 * balance, a price catalogue, a bet history and settlement. It implements the
 * same `OperatorClient` the browser-driven operator does, so the whole pipeline
 * — staking, placement, reconciliation, settlement, accounting — runs end to
 * end with no network and no real money.
 *
 * It can also be told to misbehave, which is how the duplicate-execution and
 * restart-recovery tests reproduce the cases that matter.
 */

import { sha256 } from "../ids";
import { createLogger } from "../logger";
import { roundMoney } from "../money";
import type {
  OperatorBet,
  OperatorBetStatus,
  PlaceOutcome,
  PlaceRequest,
  Quote,
  QuoteRequest,
} from "./types";

const log = createLogger("operator:mock");

export type PlacementFault = "unknown" | "rejected" | "needs_human" | "odds_drift" | null;

interface MockState {
  balance: number;
  loggedIn: boolean;
  bets: OperatorBet[];
  catalogue: Map<string, number>;
  fault: PlacementFault;
  /** Prices the operator will report on the next quote, overriding the catalogue. */
  driftedOdds: Map<string, number>;
}

const state: MockState = {
  balance: 1000,
  loggedIn: false,
  bets: [],
  catalogue: new Map(),
  fault: null,
  driftedOdds: new Map(),
};

function key(request: Pick<QuoteRequest, "matchName" | "market" | "selection">): string {
  return `${request.matchName}|${request.market}|${request.selection}`.toLowerCase();
}

/** Stable pseudo-random price so mock mode has a market without seeding. */
function syntheticOdds(seed: string): number {
  const digest = sha256(seed);
  const scaled = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  return roundMoney(1.45 + scaled * 2.4);
}

export function resetMockOperator(balance = 1000): void {
  state.balance = balance;
  state.loggedIn = false;
  state.bets = [];
  state.catalogue.clear();
  state.driftedOdds.clear();
  state.fault = null;
}

export function setMockBalance(balance: number): void {
  state.balance = roundMoney(balance);
}

export function getMockBalance(): number {
  return state.balance;
}

export function setMockOdds(
  match: Pick<QuoteRequest, "matchName" | "market" | "selection">,
  odds: number,
): void {
  state.catalogue.set(key(match), odds);
}

/** Makes the next quote report a different price than the catalogue. */
export function setMockOddsDrift(
  match: Pick<QuoteRequest, "matchName" | "market" | "selection">,
  odds: number,
): void {
  state.driftedOdds.set(key(match), odds);
}

/** Forces the next placement attempt to take a specific failure path. */
export function setMockPlacementFault(fault: PlacementFault): void {
  state.fault = fault;
}

export function listMockBets(): OperatorBet[] {
  return state.bets.map((bet) => ({ ...bet }));
}

/** Settles a bet the way the operator eventually would, adjusting the balance. */
export function settleMockBet(reference: string, status: OperatorBetStatus): void {
  const bet = state.bets.find((entry) => entry.reference === reference);
  if (!bet || bet.status !== "open") return;
  bet.status = status;
  if (status === "won") state.balance = roundMoney(state.balance + bet.stake * bet.odds);
  else if (status === "void") state.balance = roundMoney(state.balance + bet.stake);
}

export async function mockLogin(): Promise<void> {
  state.loggedIn = true;
}

export async function mockBalance(): Promise<number> {
  if (!state.loggedIn) throw new Error("mock operator: not logged in");
  return state.balance;
}

export async function mockListBets(): Promise<OperatorBet[]> {
  return listMockBets();
}

export async function mockQuote(request: QuoteRequest): Promise<Quote | null> {
  const id = key(request);
  const odds = state.driftedOdds.get(id) ?? state.catalogue.get(id) ?? syntheticOdds(id);
  return {
    eventRef: `mock-event-${sha256(request.matchName).slice(0, 10)}`,
    matchName: request.matchName,
    market: request.market,
    selection: request.selection,
    odds,
  };
}

export async function mockPlaceBet(request: PlaceRequest): Promise<PlaceOutcome> {
  if (!state.loggedIn) await mockLogin();

  const fault = state.fault;
  state.fault = null;

  if (fault === "needs_human") {
    return { status: "needs_human", detail: "simulated verification challenge" };
  }
  if (fault === "rejected") {
    return { status: "rejected", detail: "simulated operator rejection" };
  }

  const id = key(request);
  const odds = state.driftedOdds.get(id) ?? state.catalogue.get(id) ?? syntheticOdds(id);

  if (fault === "odds_drift" || odds < request.minOdds) {
    return {
      status: "rejected",
      detail: `price moved to ${odds}, below the accepted minimum ${request.minOdds}`,
    };
  }
  if (request.stake > state.balance) {
    return { status: "rejected", detail: "insufficient balance" };
  }

  const reference = `MOCK-${sha256(request.idempotencyKey).slice(0, 12).toUpperCase()}`;
  state.balance = roundMoney(state.balance - request.stake);
  state.bets.push({
    reference,
    event: request.matchName,
    selection: request.selection,
    market: request.market,
    odds,
    stake: request.stake,
    status: "open",
    placedAt: new Date().toISOString(),
  });

  // The dangerous real-world case: the bet landed but the confirmation was
  // lost. Reconciliation must find it in history instead of re-placing.
  if (fault === "unknown") {
    log.warn("mock placement recorded but reporting an unknown outcome", { reference });
    return { status: "unknown", detail: "simulated lost confirmation" };
  }

  return { status: "placed", reference, odds, stake: request.stake };
}
