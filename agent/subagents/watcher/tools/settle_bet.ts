import { defineTool } from "eve/tools";
import { z } from "zod";

import { updateProfitHistory } from "../../../lib/accounting";
import { lockedProfitAfter, snapshot } from "../../../lib/bankroll";
import { getConfig } from "../../../lib/config";
import { newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import { roundMoney } from "../../../lib/money";
import { settleSelection, toSelection } from "../../../lib/markets";
import { getStore, TAB, type SettlementRecord } from "../../../lib/sheets";
import { getLockedProfit, setLockedProfit } from "../../../lib/state";
import { report } from "../../../lib/telegram/notify";
import { dayKey, isoNow } from "../../../lib/time";

const log = createLogger("tool:settle_bet");

/**
 * Turns a final result into money.
 *
 * The verdict is computed from the selection and the score rather than supplied,
 * so a bet cannot be settled the way anyone hoped it went. A selection that
 * cannot be judged against the score returns `unknown` and settles nothing.
 *
 * The settlements tab is keyed on the bet, so replaying this — after a restart,
 * a duplicate wake-up, a retried cycle — cannot double-count a result.
 */
export default defineTool({
  description:
    "Settle a bet from the final score. You supply the result; won, lost or void is worked out from your selection. Only call this once the match is genuinely final.",
  inputSchema: z.object({
    betId: z.string(),
    homeScore: z.number().int().min(0),
    awayScore: z.number().int().min(0),
    finalScore: z.string().describe("As displayed, for the record and the report."),
    source: z.string().default("").describe("Which score source you used."),
  }),

  async execute(input) {
    const config = getConfig();
    const store = await getStore();

    const bet = (await store.list(TAB.bets)).find((entry) => entry.id === input.betId);
    if (!bet) return { settled: false, detail: `no bet with id ${input.betId}` };
    if (bet.status === "settled") {
      return { settled: false, detail: "this bet is already settled" };
    }
    if (bet.status === "unknown") {
      return {
        settled: false,
        detail: "this bet's placement was never confirmed; it must be reconciled before settling",
      };
    }

    const selection = toSelection(bet.market, bet.selection);
    if (!selection) {
      return { settled: false, detail: `cannot interpret the selection ${bet.market}/${bet.selection}` };
    }

    const result = settleSelection(selection, {
      matchKey: bet.matchKey,
      status: "final",
      homeScore: input.homeScore,
      awayScore: input.awayScore,
      displayScore: input.finalScore,
      clock: "",
      winner:
        input.homeScore > input.awayScore
          ? "home"
          : input.awayScore > input.homeScore
            ? "away"
            : "draw",
      provider: input.source,
      completed: true,
    });

    if (result === "unknown") {
      return {
        settled: false,
        detail: `${bet.market}/${bet.selection} cannot be judged against ${input.finalScore}. Report this rather than forcing a result.`,
      };
    }

    const returned =
      result === "won" ? roundMoney(bet.stake * bet.odds) : result === "void" ? bet.stake : 0;
    const profit = roundMoney(returned - bet.stake);
    const now = isoNow();

    const settlement: SettlementRecord = {
      id: newId("stl"),
      betId: bet.id,
      createdAt: now,
      matchKey: bet.matchKey,
      matchName: bet.matchName,
      market: bet.market,
      selection: bet.selection,
      result,
      finalScore: input.finalScore,
      stake: bet.stake,
      returned,
      profit,
      source: input.source,
    };

    // Keyed on betId: a replayed settlement returns the existing row.
    const written = await store.appendUnique(TAB.settlements, settlement);
    if (!written.created) {
      return { settled: false, detail: "this bet was already settled", result: written.record.result };
    }

    await store.update(TAB.bets, bet.id, {
      status: result === "void" ? "void" : "settled",
      updatedAt: now,
      settledAt: now,
      result,
      profit,
    });

    const active = (await store.list(TAB.activeBets)).find((entry) => entry.betId === bet.id);
    if (active) {
      await store.update(TAB.activeBets, active.id, {
        status: result === "void" ? "void" : "settled",
        liveScore: input.finalScore,
        lastCheckedAt: now,
      });
    }

    // Only a realised win adds to the protected pool, and only the share that
    // is not released back into the betting bankroll.
    const locked = lockedProfitAfter(await getLockedProfit(), profit);
    await setLockedProfit(locked);

    const bank = await snapshot(
      (await store.list(TAB.balances)).at(-1)?.balance ?? bet.stake + returned,
    );
    await updateProfitHistory(dayKey(new Date(), config.strategy.timezone), bank.bankroll, locked);

    await report({
      kind: "settlement",
      title: `${result === "won" ? "Won" : result === "void" ? "Void" : "Lost"}: ${bet.matchName}`,
      lines: [
        `${bet.market} / ${bet.selection}`,
        `Final score ${input.finalScore}`,
        `Stake ${bet.stake} at ${bet.odds}`,
        `${profit >= 0 ? "Profit" : "Loss"} ${Math.abs(profit)}`,
      ],
    });

    log.info("bet settled", { betId: bet.id, result, profit });

    return {
      settled: true,
      betId: bet.id,
      result,
      returned,
      profit,
      lockedProfit: locked,
      matchName: bet.matchName,
    };
  },
});
