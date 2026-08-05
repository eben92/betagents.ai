/**
 * Balance and profit bookkeeping.
 *
 * Both tabs are written from settled facts only: a balance row records what the
 * operator reported, and the profit row for a day is recomputed from that day's
 * settlements rather than incremented, so a replayed cycle cannot double-count.
 */

import type { BankrollSnapshot } from "./bankroll";
import { getConfig } from "./config";
import { newId } from "./ids";
import { createLogger } from "./logger";
import { roundMoney } from "./money";
import { getStore, TAB, type BalanceRecord, type ProfitRecord } from "./sheets";
import { dayKey } from "./time";

const log = createLogger("accounting");

export async function recordBalance(
  snapshot: BankrollSnapshot,
  source: string,
): Promise<BalanceRecord> {
  const config = getConfig();
  const store = await getStore();

  const record: BalanceRecord = {
    id: newId("bal"),
    createdAt: new Date().toISOString(),
    operator: config.operator.name,
    balance: snapshot.balance,
    exposure: snapshot.exposure,
    bankroll: snapshot.bankroll,
    lockedProfit: snapshot.lockedProfit,
    available: snapshot.available,
    source,
  };

  await store.append(TAB.balances, record);
  return record;
}

/**
 * Recomputes the profit row for a day from its settlements. Idempotent by
 * construction: running it twice produces the same row.
 */
export async function updateProfitHistory(day: string, bankrollEnd: number, lockedProfit: number): Promise<ProfitRecord> {
  const config = getConfig();
  const store = await getStore();

  const settlements = (await store.list(TAB.settlements)).filter(
    (entry) => dayKey(new Date(entry.createdAt), config.strategy.timezone) === day,
  );

  const staked = roundMoney(settlements.reduce((total, entry) => total + entry.stake, 0));
  const returned = roundMoney(settlements.reduce((total, entry) => total + entry.returned, 0));

  const record: ProfitRecord = {
    id: newId("pft"),
    day,
    updatedAt: new Date().toISOString(),
    betCount: settlements.length,
    staked,
    returned,
    profit: roundMoney(returned - staked),
    bankrollEnd: roundMoney(bankrollEnd),
    lockedProfit: roundMoney(lockedProfit),
  };

  const written = await store.appendUnique(TAB.profit, record);
  if (!written.created) {
    await store.update(TAB.profit, written.record.id, {
      updatedAt: record.updatedAt,
      betCount: record.betCount,
      staked: record.staked,
      returned: record.returned,
      profit: record.profit,
      bankrollEnd: record.bankrollEnd,
      lockedProfit: record.lockedProfit,
    });
  }

  log.debug("profit history updated", { day, profit: record.profit, bets: record.betCount });
  return record;
}
