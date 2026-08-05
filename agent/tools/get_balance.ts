import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertReader } from "../lib/authz";
import { getConfig } from "../lib/config";
import { formatMoney } from "../lib/money";
import { getOverview } from "../lib/overview";

/**
 * Answers from the last balance the Account & Execution agent recorded rather
 * than opening a browser, so `/balance` is instant. Delegate to that agent when
 * a genuinely live figure is needed.
 */
export default defineTool({
  description:
    "Report the last recorded balance and the full bankroll breakdown: what is at risk, what is protected and what is actually available to stake. This is the last figure read from the operator, not a live read.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    assertReader(ctx, "read the balance");

    const currency = getConfig().strategy.currency;
    const overview = await getOverview();
    const bankroll = overview.bankroll;

    if (!bankroll) {
      return {
        available: false,
        reason: overview.bankrollError ?? "no balance has been recorded yet",
      };
    }

    return {
      available: true,
      asOf: overview.bankrollAsOf,
      balance: formatMoney(bankroll.balance, currency),
      onOpenBets: formatMoney(bankroll.exposure, currency),
      totalBankroll: formatMoney(bankroll.bankroll, currency),
      protectedReserve: formatMoney(bankroll.reserve, currency),
      lockedProfit: formatMoney(bankroll.lockedProfit, currency),
      availableToStake: formatMoney(bankroll.available, currency),
      openBets: bankroll.activeBets,
      profitToday: formatMoney(bankroll.dayProfit, currency),
      lossStreak: bankroll.lossStreak,
      notBettingBecause: bankroll.haltReason,
    };
  },
});
