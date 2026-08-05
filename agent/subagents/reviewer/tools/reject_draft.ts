import { defineTool } from "eve/tools";
import { z } from "zod";

import { recordRejection } from "../../../lib/cycle";
import { getStore, TAB } from "../../../lib/sheets";
import { isoNow } from "../../../lib/time";

/**
 * A rejection is recorded on the draft rather than deleting it, so the reason
 * survives and the same match can still be reconsidered later from fresh
 * research. It is also written to the rejection ledger, which is what the
 * operator's cycle report is built from — a match declined here is reported by
 * name, with this reason.
 *
 * `reasonCode` is not decoration. It is what tells the cycle whether the
 * rejection was about this bet (a price that moved, and might move back) or
 * about the match (a postponement, a thesis that is simply wrong), and
 * therefore whether another pass is worth running.
 */
export default defineTool({
  description:
    "Reject a draft so it is never placed. Before rejecting, check whether the bet can be fixed instead: a lower stake, a safer market, or approving at the current price if the edge survives it. Reject when it cannot.",
  inputSchema: z.object({
    draftId: z.string(),
    reasonCode: z
      .enum([
        "price_moved",
        "thesis_broken",
        "unverifiable",
        "fixture_changed",
        "too_close_to_kickoff",
        "already_exposed",
        "other",
      ])
      .describe("The category of what went wrong. Use price_moved only when the price is the problem."),
    reason: z.string().max(600).describe("What you found, or what you could not confirm."),
    consideredInstead: z
      .string()
      .max(300)
      .default("")
      .describe(
        "The fix you considered and why it does not work — a lower stake, a safer market, the current price. Required when reasonCode is price_moved.",
      ),
  }),

  async execute({ draftId, reasonCode, reason, consideredInstead }) {
    if (reasonCode === "price_moved" && !consideredInstead.trim()) {
      return {
        rejected: false,
        detail:
          "A price that moved is often fixable. Say in `consideredInstead` what you tried — approving at the current price, a lower stake, a safer market — and why it does not work.",
      };
    }

    const store = await getStore();
    const draft = (await store.list(TAB.drafts)).find((entry) => entry.id === draftId);
    if (!draft) return { rejected: false, detail: `no draft with id ${draftId}` };

    if (draft.status !== "pending") {
      return { rejected: false, detail: `draft is ${draft.status}, not pending` };
    }

    const note = consideredInstead.trim() ? `${reason} (considered: ${consideredInstead})` : reason;

    await store.update(TAB.drafts, draftId, {
      status: "rejected",
      updatedAt: isoNow(),
      notes: `${draft.notes}\nREJECTED (${reasonCode}): ${note}`.trim(),
    });

    await recordRejection({
      stage: "reviewer",
      matchKey: draft.matchKey,
      matchName: draft.matchName,
      sport: draft.sport,
      startsAt: draft.startsAt,
      market: draft.market,
      selection: draft.selection,
      odds: draft.odds,
      code: reasonCode,
      reason: note,
      // Only a price can come back. A broken thesis or a moved fixture cannot.
      fixable: reasonCode === "price_moved",
    });

    return { rejected: true, draftId, matchName: draft.matchName, reasonCode, reason: note };
  },
});
