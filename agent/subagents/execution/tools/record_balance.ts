import { defineTool } from "eve/tools";
import { z } from "zod";

import { recordBalance } from "../../../lib/accounting";
import { snapshot } from "../../../lib/bankroll";
import { getConfig } from "../../../lib/config";
import { errorMessage } from "../../../lib/logger";
import { isMock, readBalance } from "../../../lib/operator";

/**
 * The balance every other agent reasons about.
 *
 * On a real site the figure is displayed differently everywhere, so the agent
 * reads it and passes it here, where it is range-checked and turned into the
 * full bankroll picture — reserve, locked profit, and what is actually
 * stakeable. In mock mode the simulated bookmaker is the source of truth and
 * whatever is passed is ignored.
 */
export default defineTool({
  description:
    "Record the account balance you read from the operator. Pass the figure exactly as shown, with no currency symbol. Returns the full bankroll breakdown the rest of the system uses.",
  inputSchema: z.object({
    balance: z
      .number()
      .min(0)
      .optional()
      .describe("The balance shown on the page. Not needed in simulated mode."),
  }),

  async execute({ balance }, ctx) {
    try {
      const value = await readBalance(ctx, balance);
      const bank = await snapshot(value);
      await recordBalance(bank, isMock() ? "simulated" : "operator");

      return {
        recorded: true,
        currency: getConfig().strategy.currency,
        balance: bank.balance,
        exposure: bank.exposure,
        bankroll: bank.bankroll,
        reserve: bank.reserve,
        lockedProfit: bank.lockedProfit,
        availableToStake: bank.available,
        openBets: bank.activeBets,
        halted: bank.halted,
        haltReason: bank.haltReason,
      };
    } catch (error) {
      return { recorded: false, detail: errorMessage(error) };
    }
  },
});
