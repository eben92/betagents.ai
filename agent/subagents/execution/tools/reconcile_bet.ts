import { defineTool } from "eve/tools";
import { z } from "zod";

import { newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import { potentialReturn } from "../../../lib/money";
import { isMock, listBets as listOperatorBets } from "../../../lib/operator";
import { getStore, TAB, type ActiveBetRecord } from "../../../lib/sheets";
import { report } from "../../../lib/telegram/notify";
import { isoNow } from "../../../lib/time";
import { schedule } from "../../../lib/wakeups";
import { addMinutes } from "../../../lib/time";

const log = createLogger("tool:reconcile_bet");

/**
 * Resolves a bet whose submission outcome was never confirmed.
 *
 * This is the only path that can release a claim, and it is deliberately the
 * only one: an unresolved claim blocks a bet forever, which is safe, while a
 * wrongly released one produces a second bet on the same match, which is not.
 * When the agent cannot read the history, nothing is decided and the claim
 * stands.
 */
export default defineTool({
  description:
    "Resolve a bet whose outcome was unknown, using what you found in the operator's bet history. Say found only when you actually saw the bet. If you could not read the history, use uncertain — the claim stays and it will be retried.",
  inputSchema: z.object({
    betId: z.string(),
    result: z
      .enum(["found", "not_found", "uncertain"])
      .describe("found: the bet exists at the operator. not_found: it definitely does not."),
    operatorRef: z.string().optional().describe("The bet reference, when found."),
    odds: z.number().optional().describe("The price the operator recorded, when found."),
    stake: z.number().optional().describe("The stake the operator recorded, when found."),
    detail: z.string().max(400).default(""),
  }),

  async execute(input, ctx) {
    const store = await getStore();
    const bet = (await store.list(TAB.bets)).find((entry) => entry.id === input.betId);
    if (!bet) return { resolved: false, detail: `no bet with id ${input.betId}` };
    if (bet.status !== "unknown") {
      return { resolved: false, detail: `bet is ${bet.status}, not unknown; nothing to reconcile` };
    }

    const now = isoNow();

    // The simulated operator has a real history, so mock mode reconciles for
    // itself rather than trusting a reported answer.
    let result = input.result;
    let operatorRef = input.operatorRef;
    let odds = input.odds;
    let stake = input.stake;

    if (isMock()) {
      const history = await listOperatorBets(ctx);
      const match = history.find(
        (entry) =>
          entry.event === bet.matchName &&
          entry.selection === bet.selection &&
          Math.abs(entry.stake - bet.stake) < 0.01,
      );
      result = match ? "found" : "not_found";
      operatorRef = match?.reference;
      odds = match?.odds;
      stake = match?.stake;
    }

    if (result === "uncertain") {
      await schedule({
        kind: "reconcile",
        dueAt: addMinutes(new Date(), 10),
        reason: `retry reconciling ${bet.matchName}`,
      });
      return {
        resolved: false,
        detail: "left unresolved; the claim stands and reconciliation will be retried",
      };
    }

    if (result === "found") {
      const finalOdds = odds && odds > 1 ? odds : bet.odds;
      const finalStake = stake && stake > 0 ? stake : bet.stake;

      await store.update(TAB.bets, bet.id, {
        status: "placed",
        updatedAt: now,
        placedAt: bet.placedAt || now,
        odds: finalOdds,
        stake: finalStake,
        potentialReturn: potentialReturn(finalStake, finalOdds),
        operatorRef: operatorRef ?? "",
        notes: `reconciled from bet history. ${input.detail}`.trim(),
      });
      await store.update(TAB.approved, bet.approvedId, { status: "executed", updatedAt: now });

      const active: ActiveBetRecord = {
        id: newId("act"),
        betId: bet.id,
        matchKey: bet.matchKey,
        sport: bet.sport,
        matchName: bet.matchName,
        startsAt: bet.startsAt,
        provider: bet.provider,
        providerId: bet.providerId,
        market: bet.market,
        selection: bet.selection,
        odds: finalOdds,
        stake: finalStake,
        potentialReturn: potentialReturn(finalStake, finalOdds),
        status: "placed",
        liveScore: "",
        lastCheckedAt: "",
      };
      await store.append(TAB.activeBets, active);

      await report({
        kind: "bet_placed",
        title: `Bet confirmed after an unclear submission: ${bet.matchName}`,
        lines: [
          `${bet.market} / ${bet.selection}`,
          `Stake ${finalStake} at ${finalOdds}`,
          operatorRef ? `Reference ${operatorRef}` : null,
        ],
      });

      log.info("reconciled: bet exists", { betId: bet.id, operatorRef });
      return { resolved: true, outcome: "placed", betId: bet.id, operatorRef };
    }

    // Definitively absent: release the claim so the opportunity is not lost.
    // The row stays for the audit trail, but its key is voided — otherwise the
    // uniqueness that protects against duplicates would also block the retry.
    await store.update(TAB.bets, bet.id, {
      status: "cancelled",
      updatedAt: now,
      idempotencyKey: `voided:${bet.idempotencyKey}:${now}`,
      notes: `not found in bet history; never placed. ${input.detail}`.trim(),
    });
    await store.update(TAB.approved, bet.approvedId, { status: "ready", updatedAt: now });

    log.info("reconciled: bet does not exist", { betId: bet.id });
    return {
      resolved: true,
      outcome: "not_placed",
      betId: bet.id,
      detail: "the bet was never placed; the approval is available to execute again",
    };
  },
});
