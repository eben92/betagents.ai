/**
 * Bankroll accounting and stake sizing.
 *
 * The models influence stake through a single multiplier in [0,1]; the actual
 * amount is computed here. That split is deliberate — a model cannot talk the
 * system into a stake the bankroll rules forbid, because it never gets to name
 * a number.
 *
 * Protection has two layers: a reserve that is always a fraction of the current
 * bankroll, and locked profit that accumulates as winnings are realised. Only
 * what remains after both is stakeable.
 */

import { getConfig } from "./config";
import { createLogger } from "./logger";
import { clamp, edge as computeEdge, floorMoney, kellyFraction, roundMoney } from "./money";
import { getStore, OPEN_BET_STATUSES, TAB, type BetRecord } from "./sheets";
import { getDayStartBankroll, getHaltReason, getLockedProfit, getLossStreak } from "./state";
import { dayKey } from "./time";

const log = createLogger("bankroll");

export interface BankrollSnapshot {
  /** Cash at the operator. */
  balance: number;
  /** Stake riding on unsettled bets. */
  exposure: number;
  /** balance + exposure. */
  bankroll: number;
  /** Untouchable fraction of the current bankroll. */
  reserve: number;
  /** Realised profit withheld from the betting pool. */
  lockedProfit: number;
  /** What may actually be staked right now. */
  available: number;
  activeBets: number;
  dayStartBankroll: number;
  dayProfit: number;
  lossStreak: number;
  /** True when no new bet may be placed today, with the reason. */
  halted: boolean;
  haltReason: string | null;
}

export async function openBets(): Promise<BetRecord[]> {
  const store = await getStore();
  const bets = await store.list(TAB.bets);
  return bets.filter((bet) => OPEN_BET_STATUSES.includes(bet.status));
}

/** Profit realised inside the current betting day. */
async function todaysProfit(): Promise<number> {
  const config = getConfig();
  const store = await getStore();
  const today = dayKey(new Date(), config.strategy.timezone);

  const settlements = await store.list(TAB.settlements);
  return roundMoney(
    settlements
      .filter((entry) => dayKey(new Date(entry.createdAt), config.strategy.timezone) === today)
      .reduce((total, entry) => total + entry.profit, 0),
  );
}

export async function snapshot(balance: number): Promise<BankrollSnapshot> {
  const config = getConfig();
  const strategy = config.strategy;

  const active = await openBets();
  const exposure = roundMoney(active.reduce((total, bet) => total + bet.stake, 0));
  const bankroll = roundMoney(balance + exposure);

  const lockedProfit = await getLockedProfit();
  const reserve = roundMoney(bankroll * strategy.reserveFraction);
  const available = Math.max(0, floorMoney(balance - reserve - lockedProfit));

  const dayStartBankroll = (await getDayStartBankroll()) || bankroll;
  const dayProfit = await todaysProfit();
  const lossStreak = await getLossStreak();

  let haltReason = await getHaltReason();

  if (!haltReason && active.length >= strategy.maxActiveBets) {
    haltReason = `at the ${strategy.maxActiveBets}-bet exposure limit`;
  }
  if (!haltReason && dayProfit < 0 && Math.abs(dayProfit) >= dayStartBankroll * strategy.maxDailyLossFraction) {
    haltReason = `daily loss limit reached (${roundMoney(dayProfit)})`;
  }
  if (!haltReason && lossStreak >= strategy.lossStreakCooldown) {
    haltReason = `${lossStreak} consecutive losses; cooling down`;
  }
  if (!haltReason && available < strategy.minStake) {
    haltReason = `available bankroll below the minimum stake`;
  }

  return {
    balance: roundMoney(balance),
    exposure,
    bankroll,
    reserve,
    lockedProfit: roundMoney(lockedProfit),
    available,
    activeBets: active.length,
    dayStartBankroll: roundMoney(dayStartBankroll),
    dayProfit,
    lossStreak,
    halted: haltReason !== null,
    haltReason,
  };
}

export interface StakeInput {
  snapshot: BankrollSnapshot;
  /** Modelled win probability for the selection. */
  probability: number;
  odds: number;
  /** Agent confidence in the research behind the probability, 0-1. */
  confidence: number;
  /** Planner's sizing preference, 0-1. Scales down only; never up. */
  multiplier: number;
  /** How many more bets the planner expects today; splits the budget. */
  remainingOpportunities: number;
}

export interface StakeDecision {
  stake: number;
  edge: number;
  kelly: number;
  potentialReturn: number;
  expectedProfit: number;
  /** Set when the stake is 0, explaining which rule declined the bet. */
  declined: string | null;
}

/**
 * Fractional-Kelly stake, scaled by confidence and the planner's multiplier,
 * then capped by the per-bet limit and split across the day's remaining
 * opportunities. Returns a zero stake with a reason rather than throwing.
 */
export function computeStake(input: StakeInput): StakeDecision {
  const strategy = getConfig().strategy;
  const { snapshot: bank, odds } = input;

  const probability = clamp(input.probability, 0, 1);
  const confidence = clamp(input.confidence, 0, 1);
  const multiplier = clamp(input.multiplier, 0, 1);

  const edge = roundMoney(computeEdge(probability, odds) * 100) / 100;
  const kelly = kellyFraction(probability, odds);

  const empty = (declined: string): StakeDecision => ({
    stake: 0,
    edge,
    kelly,
    potentialReturn: 0,
    expectedProfit: 0,
    declined,
  });

  if (bank.halted) return empty(bank.haltReason ?? "trading halted");
  if (odds <= 1) return empty("odds do not offer a return");
  if (edge < strategy.minEdge) return empty(`edge ${edge.toFixed(3)} below the ${strategy.minEdge} minimum`);
  if (confidence < strategy.minConfidence) {
    return empty(`confidence ${confidence.toFixed(2)} below the ${strategy.minConfidence} minimum`);
  }
  if (kelly <= 0) return empty("Kelly criterion declines this price");

  // Simultaneous bets share one bankroll, so each is scaled down by how many
  // more the Planner expects today — not merely capped by that share.
  const share = 1 / Math.max(1, Math.round(input.remainingOpportunities));
  const perBetCap = bank.available * strategy.maxStakeFraction;

  const sized = bank.available * kelly * strategy.kellyMultiplier * confidence * multiplier * share;
  const stake = floorMoney(Math.min(sized, perBetCap, bank.available));

  if (stake < strategy.minStake) {
    return empty(`sized stake ${stake.toFixed(2)} below the ${strategy.minStake} minimum`);
  }

  const potentialReturn = roundMoney(stake * odds);
  const expectedProfit = roundMoney(probability * (potentialReturn - stake) - (1 - probability) * stake);

  log.debug("stake sized", { stake, edge, kelly, odds, probability, confidence, multiplier });

  return { stake, edge, kelly, potentialReturn, expectedProfit, declined: null };
}

/**
 * Applies a settled result to the protected-profit pool. A win locks away the
 * share of profit that is not released back into the betting bankroll.
 */
export function lockedProfitAfter(current: number, profit: number): number {
  const { profitReleaseFraction } = getConfig().strategy;
  if (profit <= 0) return current;
  return roundMoney(current + profit * (1 - profitReleaseFraction));
}
