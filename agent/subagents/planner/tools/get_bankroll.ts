import { defineTool } from "eve/tools";
import { z } from "zod";

import { snapshot } from "../../../lib/bankroll";
import { getConfig } from "../../../lib/config";
import { getStore, TAB } from "../../../lib/sheets";

/**
 * The planner's view of the money. It reads the balance the Account & Execution
 * agent recorded rather than opening a browser, which is why pricing runs
 * before planning in a cycle.
 */
export default defineTool({
  description:
    "Read the bankroll: balance, exposure, protected reserve, locked profit and — the only number you may stake against — what is available. Also reports whether trading is halted. Call this before looking at any price.",
  inputSchema: z.object({}),

  async execute() {
    const config = getConfig();
    const store = await getStore();
    const balances = await store.list(TAB.balances);
    const latest = balances.at(-1);

    if (!latest) {
      return {
        available: false,
        halted: true,
        haltReason:
          "no balance has been recorded yet — the Account & Execution agent must read the operator balance first",
      };
    }

    const bankroll = await snapshot(latest.balance);

    return {
      available: true,
      asOf: latest.createdAt,
      currency: config.strategy.currency,
      balance: bankroll.balance,
      exposure: bankroll.exposure,
      bankroll: bankroll.bankroll,
      reserve: bankroll.reserve,
      lockedProfit: bankroll.lockedProfit,
      availableToStake: bankroll.available,
      openBets: bankroll.activeBets,
      maxActiveBets: config.strategy.maxActiveBets,
      profitToday: bankroll.dayProfit,
      lossStreak: bankroll.lossStreak,
      halted: bankroll.halted,
      haltReason: bankroll.haltReason,
    };
  },
});
