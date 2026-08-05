/**
 * Betting-operator contracts.
 *
 * These shapes are what the rest of the system depends on, so the simulated
 * operator and a real bookmaker's website are interchangeable. Nothing here
 * knows about a particular site.
 */

export type OperatorBetStatus = "open" | "won" | "lost" | "void" | "unknown";

export interface OperatorBet {
  reference: string;
  /** Operator's own description of the event, used for fuzzy matching. */
  event: string;
  selection: string;
  market: string;
  odds: number;
  stake: number;
  status: OperatorBetStatus;
  placedAt: string;
}

export interface QuoteRequest {
  matchName: string;
  home: string;
  away: string;
  market: string;
  selection: string;
  startsAt: string;
}

export interface Quote {
  /** Operator's identifier for the event, reused at placement time. */
  eventRef: string;
  matchName: string;
  market: string;
  selection: string;
  odds: number;
}

export interface PlaceRequest extends QuoteRequest {
  eventRef: string;
  stake: number;
  /** Placement aborts if the live price drifts below this. */
  minOdds: number;
  /** Ties the attempt to the one claim row that authorises it. */
  idempotencyKey: string;
}

export type PlaceOutcome =
  | { status: "placed"; reference: string; odds: number; stake: number }
  /** Submitted but the result could not be confirmed. Never retried blindly. */
  | { status: "unknown"; detail: string }
  | { status: "rejected"; detail: string }
  /** CAPTCHA, MFA or an account restriction. Requires a person. */
  | { status: "needs_human"; detail: string };

export class OperatorError extends Error {
  /** Set when a person must intervene: CAPTCHA, MFA, locked account. */
  readonly needsHuman: boolean;

  constructor(message: string, needsHuman = false) {
    super(message);
    this.name = "OperatorError";
    this.needsHuman = needsHuman;
  }
}
