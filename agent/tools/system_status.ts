import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertReader } from "../lib/authz";
import { getOverview } from "../lib/overview";
import { formatMoney } from "../lib/money";
import { formatInZone } from "../lib/time";

export default defineTool({
  description:
    "Current state of the betting system: running/paused/stopped, bankroll, open bets, live drafts, today's profit and when it next wakes up. Use this for any 'status' or 'how are we doing' question.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    assertReader(ctx, "read system status");
    const overview = await getOverview();
    const currency = overview.currency;

    return {
      status: overview.status,
      mode: overview.mode,
      operator: overview.operator,
      notBettingBecause: overview.haltReason,
      bankroll: overview.bankroll
        ? {
            balance: formatMoney(overview.bankroll.balance, currency),
            onOpenBets: formatMoney(overview.bankroll.exposure, currency),
            total: formatMoney(overview.bankroll.bankroll, currency),
            protectedReserve: formatMoney(overview.bankroll.reserve, currency),
            lockedProfit: formatMoney(overview.bankroll.lockedProfit, currency),
            availableToStake: formatMoney(overview.bankroll.available, currency),
          }
        : null,
      bankrollError: overview.bankrollError,
      openBets: overview.openBets.length,
      liveDrafts: overview.liveDrafts.length,
      settledToday: overview.todaysSettlements.length,
      profitToday: formatMoney(overview.todaysProfit, currency),
      dailyObjective: overview.dailyObjective,
      lastCycleAt: overview.lastCycleAt
        ? formatInZone(new Date(overview.lastCycleAt), overview.timezone)
        : null,
      nextWakeAt: overview.nextWakeAt
        ? formatInZone(new Date(overview.nextWakeAt), overview.timezone)
        : null,
      timezone: overview.timezone,
    };
  },
});
