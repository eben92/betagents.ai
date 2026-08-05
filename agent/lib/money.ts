/**
 * Money rounding and odds arithmetic.
 *
 * Stakes are rounded down to two decimals so the system can never ask an
 * operator for more than the bankroll maths allowed.
 */

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rounds toward zero, so a stake never exceeds its computed cap. */
export function floorMoney(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** Implied probability of decimal odds, ignoring the bookmaker margin. */
export function impliedProbability(decimalOdds: number): number {
  if (decimalOdds <= 1) return 1;
  return 1 / decimalOdds;
}

/**
 * Expected value per unit staked. Positive means the modelled probability
 * beats the price on offer.
 */
export function edge(probability: number, decimalOdds: number): number {
  return probability * decimalOdds - 1;
}

/**
 * Kelly stake as a fraction of bankroll for a binary outcome at decimal odds.
 * Returns 0 when the bet has no edge.
 */
export function kellyFraction(probability: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const fraction = (probability * b - (1 - probability)) / b;
  return fraction > 0 ? fraction : 0;
}

export function potentialReturn(stake: number, decimalOdds: number): number {
  return roundMoney(stake * decimalOdds);
}

export function profitIfWon(stake: number, decimalOdds: number): number {
  return roundMoney(stake * decimalOdds - stake);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function formatMoney(value: number, currency: string): string {
  return `${currency} ${roundMoney(value).toFixed(2)}`;
}

/** Parses odds from operator text such as `2.35`, `2,35` or `Odds: 2.35`. */
export function parseOdds(raw: string): number | null {
  const match = raw.replace(/,/g, ".").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value <= 1 || value > 1000) return null;
  return value;
}
