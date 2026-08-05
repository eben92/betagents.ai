import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStore, TAB } from "../../../lib/sheets";
import { isoNow } from "../../../lib/time";

/**
 * A rejection is recorded on the draft rather than deleting it, so the reason
 * survives and the same match can still be reconsidered later from fresh
 * research.
 */
export default defineTool({
  description:
    "Reject a draft so it is never placed. Rejecting is cheap and correct whenever you cannot confirm the thesis still holds.",
  inputSchema: z.object({
    draftId: z.string(),
    reason: z.string().max(600).describe("What you found, or what you could not confirm."),
  }),

  async execute({ draftId, reason }) {
    const store = await getStore();
    const draft = (await store.list(TAB.drafts)).find((entry) => entry.id === draftId);
    if (!draft) return { rejected: false, detail: `no draft with id ${draftId}` };

    if (draft.status !== "pending") {
      return { rejected: false, detail: `draft is ${draft.status}, not pending` };
    }

    await store.update(TAB.drafts, draftId, {
      status: "rejected",
      updatedAt: isoNow(),
      notes: `${draft.notes}\nREJECTED: ${reason}`.trim(),
    });

    return { rejected: true, draftId, matchName: draft.matchName, reason };
  },
});
