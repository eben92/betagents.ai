import { defineTool } from "eve/tools";
import { z } from "zod";

import { clearRejections, recordRejection } from "../../../lib/cycle";
import { idempotencyKey, newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import { potentialReturn } from "../../../lib/money";
import { placeBet } from "../../../lib/operator";
import { getStore, TAB, type ActiveBetRecord } from "../../../lib/sheets";
import { report, reportNeedsHuman } from "../../../lib/telegram/notify";
import { addMinutes, isoNow } from "../../../lib/time";
import { schedule } from "../../../lib/wakeups";

const log = createLogger("tool:place_bet");

/**
 * Submits the claimed bet.
 *
 * The stake and the minimum acceptable price come from the approved record, not
 * from the caller — there is no argument that can change how much money moves.
 * Placement is refused outright unless a claim in `placing` state exists.
 *
 * An outcome that cannot be confirmed is recorded as `unknown` and a
 * reconciliation wake-up is booked. It is never recorded as a failure, because
 * a failure would invite a retry and the bet may already exist.
 */
export default defineTool({
  description:
    "Submit the bet you claimed. The stake and minimum price come from the approval — you cannot change them. Call this only after claim_bet succeeded and you have the selection in the betslip.",
  inputSchema: z.object({
    approvedId: z.string(),
  }),

  async execute({ approvedId }, ctx) {
    const store = await getStore();
    const approved = (await store.list(TAB.approved)).find((entry) => entry.id === approvedId);
    if (!approved) return { outcome: "rejected", detail: `no approved bet with id ${approvedId}` };

    const key = idempotencyKey(approvedId);
    const claim = (await store.list(TAB.bets)).find((bet) => bet.idempotencyKey === key);

    if (!claim) {
      return {
        outcome: "rejected",
        detail: "no claim exists for this bet. Call claim_bet first; placement without a claim is refused.",
      };
    }
    if (claim.status !== "placing") {
      return {
        outcome: "rejected",
        detail: `this bet is already ${claim.status} and must not be submitted again`,
      };
    }

    const [home = "", away = ""] = approved.matchName.split(/\s+v(?:s\.?)?\s+/i);
    const outcome = await placeBet(ctx, {
      matchName: approved.matchName,
      home,
      away,
      market: approved.market,
      selection: approved.selection,
      startsAt: approved.startsAt,
      eventRef: "",
      stake: approved.stake,
      minOdds: approved.odds,
      idempotencyKey: key,
    });

    const now = isoNow();

    if (outcome.status === "placed") {
      await store.update(TAB.bets, claim.id, {
        status: "placed",
        updatedAt: now,
        placedAt: now,
        odds: outcome.odds,
        stake: outcome.stake,
        potentialReturn: potentialReturn(outcome.stake, outcome.odds),
        operatorRef: outcome.reference,
      });
      await store.update(TAB.approved, approvedId, { status: "executed", updatedAt: now });
      await store.update(TAB.drafts, approved.draftId, { status: "executed", updatedAt: now });

      const active: ActiveBetRecord = {
        id: newId("act"),
        betId: claim.id,
        matchKey: approved.matchKey,
        sport: approved.sport,
        matchName: approved.matchName,
        startsAt: approved.startsAt,
        provider: approved.provider,
        providerId: approved.providerId,
        market: approved.market,
        selection: approved.selection,
        odds: outcome.odds,
        stake: outcome.stake,
        potentialReturn: potentialReturn(outcome.stake, outcome.odds),
        status: "placed",
        liveScore: "",
        lastCheckedAt: "",
      };
      await store.append(TAB.activeBets, active);
      await clearRejections(approved.matchKey);

      await schedule({
        kind: "monitor",
        dueAt: new Date(approved.startsAt),
        reason: `watch ${approved.matchName}`,
      });

      await report({
        kind: "bet_placed",
        title: `Bet placed: ${approved.matchName}`,
        lines: [
          `${approved.market} / ${approved.selection}`,
          `Stake ${outcome.stake} at ${outcome.odds}`,
          `Returns ${potentialReturn(outcome.stake, outcome.odds)} if it wins`,
          `Reference ${outcome.reference}`,
        ],
      });

      log.info("bet placed", { betId: claim.id, reference: outcome.reference });
      return {
        outcome: "placed",
        betId: claim.id,
        reference: outcome.reference,
        odds: outcome.odds,
        stake: outcome.stake,
      };
    }

    if (outcome.status === "unknown") {
      // The bet may exist. Nothing here may mark it failed or free the claim.
      await store.update(TAB.bets, claim.id, {
        status: "unknown",
        updatedAt: now,
        notes: outcome.detail,
      });
      await schedule({
        kind: "reconcile",
        dueAt: addMinutes(new Date(), 3),
        reason: `confirm whether ${approved.matchName} was placed`,
      });

      log.warn("placement outcome unknown", { betId: claim.id, detail: outcome.detail });
      return {
        outcome: "unknown",
        betId: claim.id,
        detail: outcome.detail,
        nextStep:
          "Do not submit again. Reconciliation will search the operator's bet history for this bet.",
      };
    }

    if (outcome.status === "needs_human") {
      await store.update(TAB.bets, claim.id, {
        status: "failed",
        updatedAt: now,
        notes: `needs human: ${outcome.detail}`,
      });
      await store.update(TAB.approved, approvedId, { status: "failed", updatedAt: now });
      await reportNeedsHuman("execution", `${approved.matchName}: ${outcome.detail}`);
      await recordRejection({
        stage: "execution",
        matchKey: approved.matchKey,
        matchName: approved.matchName,
        sport: approved.sport,
        startsAt: approved.startsAt,
        market: approved.market,
        selection: approved.selection,
        odds: approved.odds,
        code: "needs_human",
        reason: outcome.detail,
        fixable: false,
      });

      return { outcome: "needs_human", betId: claim.id, detail: outcome.detail };
    }

    await store.update(TAB.bets, claim.id, {
      status: "failed",
      updatedAt: now,
      notes: outcome.detail,
    });
    await store.update(TAB.approved, approvedId, { status: "failed", updatedAt: now });
    await store.update(TAB.drafts, approved.draftId, { status: "expired", updatedAt: now });

    // The operator refused it — a price that drifted below the approved minimum
    // is the usual cause, and it is fixable: a later pass may find it back.
    await recordRejection({
      stage: "execution",
      matchKey: approved.matchKey,
      matchName: approved.matchName,
      sport: approved.sport,
      startsAt: approved.startsAt,
      market: approved.market,
      selection: approved.selection,
      odds: approved.odds,
      code: "placement_refused",
      reason: outcome.detail,
      fixable: true,
    });

    return { outcome: "rejected", betId: claim.id, detail: outcome.detail };
  },
});
