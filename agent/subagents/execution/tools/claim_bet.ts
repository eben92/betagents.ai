import { defineTool } from "eve/tools";
import { z } from "zod";

import { idempotencyKey, newId } from "../../../lib/ids";
import { createLogger } from "../../../lib/logger";
import { potentialReturn } from "../../../lib/money";
import { operatorName } from "../../../lib/operator";
import { getStore, TAB, type BetRecord } from "../../../lib/sheets";
import { isoNow, minutesBetween, parseIso } from "../../../lib/time";

const log = createLogger("tool:claim_bet");

/**
 * The duplicate-execution guard.
 *
 * A claim row is written before anything touches the betting site, keyed on an
 * idempotency key derived from the approved bet. The spreadsheet refuses a
 * second row with that key, so a second attempt — from a retry, a restart, a
 * concurrent cycle, or an agent that lost track — cannot become a second bet.
 *
 * This is the one guarantee in the system that does not depend on any agent
 * behaving correctly.
 */
export default defineTool({
  description:
    "Claim an approved bet before placing it. Returns the exact instruction: match, selection, stake and minimum price. If it reports the bet is already claimed, stop — it has already been attempted and must never be submitted again.",
  inputSchema: z.object({
    approvedId: z.string(),
  }),

  async execute({ approvedId }) {
    const store = await getStore();
    const approved = (await store.list(TAB.approved)).find((entry) => entry.id === approvedId);
    if (!approved) return { claimed: false, detail: `no approved bet with id ${approvedId}` };

    if (approved.status === "cancelled") {
      return { claimed: false, detail: "this approval was cancelled" };
    }

    const startsAt = parseIso(approved.startsAt);
    if (!startsAt || minutesBetween(new Date(), startsAt) <= 0) {
      await store.update(TAB.approved, approved.id, { status: "cancelled", updatedAt: isoNow() });
      return { claimed: false, detail: "the match has already started" };
    }

    const key = idempotencyKey(approved.id);
    const now = isoNow();

    const claim: BetRecord = {
      id: newId("bet"),
      idempotencyKey: key,
      approvedId: approved.id,
      createdAt: now,
      updatedAt: now,
      operator: operatorName(),
      matchKey: approved.matchKey,
      sport: approved.sport,
      matchName: approved.matchName,
      startsAt: approved.startsAt,
      provider: approved.provider,
      providerId: approved.providerId,
      market: approved.market,
      selection: approved.selection,
      odds: approved.odds,
      stake: approved.stake,
      potentialReturn: potentialReturn(approved.stake, approved.odds),
      status: "placing",
      operatorRef: "",
      placedAt: "",
      settledAt: "",
      result: "",
      profit: 0,
      notes: "",
    };

    const written = await store.appendUnique(TAB.bets, claim);

    if (!written.created) {
      const existing = written.record;
      log.warn("placement refused: this bet is already claimed", {
        approvedId,
        betId: existing.id,
        status: existing.status,
      });
      return {
        claimed: false,
        alreadyClaimed: true,
        betId: existing.id,
        status: existing.status,
        operatorRef: existing.operatorRef || null,
        detail:
          existing.status === "unknown"
            ? "This bet was already attempted and its outcome is unknown. It must be reconciled against the operator's bet history, never re-placed."
            : `This bet was already attempted and is ${existing.status}. Do not submit it again.`,
      };
    }

    await store.update(TAB.approved, approved.id, { status: "executing", updatedAt: now });

    return {
      claimed: true,
      betId: claim.id,
      instruction: {
        approvedId: approved.id,
        matchName: approved.matchName,
        sport: approved.sport,
        startsAt: approved.startsAt,
        eventRef: await eventRefFor(approved.matchKey, approved.market, approved.selection),
        market: approved.market,
        selection: approved.selection,
        stake: approved.stake,
        minimumOdds: approved.odds,
      },
    };
  },
});

/** The event page recorded when this selection was priced, if there was one. */
async function eventRefFor(
  matchKey: string,
  market: string,
  selection: string,
): Promise<string | null> {
  const store = await getStore();
  const priced = (await store.list(TAB.shortlist)).find(
    (entry) =>
      entry.matchKey === matchKey && entry.market === market && entry.selection === selection,
  );
  return priced?.eventRef || null;
}
