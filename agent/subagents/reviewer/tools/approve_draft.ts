import { defineTool } from "eve/tools";
import { z } from "zod";

import { snapshot } from "../../../lib/bankroll";
import { newId } from "../../../lib/ids";
import { isValidSelection, marketsFor, toSelection } from "../../../lib/markets";
import { getStore, TAB, type ApprovedRecord } from "../../../lib/sheets";
import { isoNow, minutesBetween, parseIso } from "../../../lib/time";

/**
 * Turns a reviewed draft into the one record the Account & Execution agent is
 * allowed to act on.
 *
 * Two rules are enforced here rather than trusted to judgement: a review may
 * only ever reduce a stake, and an approved stake may never exceed what the
 * bankroll currently allows. Everything else is the Reviewer's call.
 */
export default defineTool({
  description:
    "Approve a draft for placement, optionally at a lower stake or on a safer market. Only approved bets can be executed. You cannot raise a stake — if you think it deserves more, approve as drafted and say so.",
  inputSchema: z.object({
    draftId: z.string(),
    stake: z
      .number()
      .gt(0)
      .describe("The stake to place. Must be at or below the drafted stake."),
    market: z.string().optional().describe("Only when moving to a safer market."),
    selection: z.string().optional().describe("Only when moving to a safer market."),
    odds: z
      .number()
      .gt(1)
      .describe("The current price you are approving against. Placement aborts if it drifts below this."),
    notes: z.string().max(600).describe("What you checked and what decided it."),
  }),

  async execute(input) {
    const store = await getStore();
    const draft = (await store.list(TAB.drafts)).find((entry) => entry.id === input.draftId);
    if (!draft) return { approved: false, reason: `no draft with id ${input.draftId}` };
    if (draft.status !== "pending") {
      return { approved: false, reason: `draft is ${draft.status}, not pending` };
    }

    const startsAt = parseIso(draft.startsAt);
    if (!startsAt || minutesBetween(new Date(), startsAt) <= 0) {
      await store.update(TAB.drafts, draft.id, { status: "expired", updatedAt: isoNow() });
      return { approved: false, reason: "the match has already started" };
    }

    // A review may cut a stake. It may never add to one.
    if (input.stake > draft.stake + 0.005) {
      return {
        approved: false,
        reason: `stake ${input.stake} exceeds the drafted ${draft.stake}; a review can only reduce it`,
      };
    }

    const market = input.market ?? draft.market;
    const selection = input.selection ?? draft.selection;

    if (market !== draft.market || selection !== draft.selection) {
      const parsed = toSelection(market, selection);
      if (!parsed || !isValidSelection(parsed) || !marketsFor(draft.sport).includes(parsed.market)) {
        return {
          approved: false,
          reason: `${market}/${selection} is not a valid selection for ${draft.sport}`,
        };
      }
    }

    const latestBalance = (await store.list(TAB.balances)).at(-1);
    if (latestBalance) {
      const bank = await snapshot(latestBalance.balance);
      if (bank.halted) {
        return { approved: false, reason: bank.haltReason ?? "trading is halted" };
      }
      if (input.stake > bank.available) {
        return {
          approved: false,
          reason: `stake ${input.stake} exceeds the ${bank.available} currently available to stake`,
        };
      }
    }

    const now = isoNow();
    const approved: ApprovedRecord = {
      id: newId("apr"),
      draftId: draft.id,
      createdAt: now,
      updatedAt: now,
      matchKey: draft.matchKey,
      sport: draft.sport,
      matchName: draft.matchName,
      startsAt: draft.startsAt,
      provider: draft.provider,
      providerId: draft.providerId,
      market,
      selection,
      odds: input.odds,
      stake: input.stake,
      estimatedProbability: draft.estimatedProbability,
      confidence: draft.confidence,
      status: "ready",
      reviewerVerdict:
        input.stake < draft.stake - 0.005
          ? "approved_lower_stake"
          : market !== draft.market || selection !== draft.selection
            ? "approved_safer_market"
            : "approved",
      reviewerNotes: input.notes,
    };

    // Keyed on draftId, so a second approval of the same draft returns the
    // first one instead of creating a second placeable bet.
    const written = await store.appendUnique(TAB.approved, approved);
    if (!written.created) {
      return {
        approved: true,
        alreadyApproved: true,
        approvedId: written.record.id,
        reason: "this draft was already approved; the existing approval stands",
      };
    }

    await store.update(TAB.drafts, draft.id, { status: "approved", updatedAt: now });

    return {
      approved: true,
      approvedId: approved.id,
      verdict: approved.reviewerVerdict,
      matchName: approved.matchName,
      selection: `${approved.market}/${approved.selection}`,
      stake: approved.stake,
      minimumOdds: approved.odds,
      stakeReducedBy: Math.max(0, draft.stake - approved.stake),
    };
  },
});
