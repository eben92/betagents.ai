import { defineTool } from "eve/tools";
import { z } from "zod";

import { getConfig } from "../../../lib/config";
import { clearRejections, currentCycleId } from "../../../lib/cycle";
import { newId } from "../../../lib/ids";
import { potentialReturn } from "../../../lib/money";
import { getStore, OPEN_BET_STATUSES, TAB, type DraftRecord } from "../../../lib/sheets";
import { addMinutes, isoNow, parseIso } from "../../../lib/time";

/**
 * Commits one intention to bet.
 *
 * A draft is not a bet. It is refreshed, re-priced and re-reviewed before
 * anything is placed, which is what makes drafting a distant fixture safe.
 *
 * The one-live-draft-per-match rule is enforced here rather than by a unique
 * key on the tab, because a rejected or expired draft must not block the same
 * match from being reconsidered later.
 */
export default defineTool({
  description:
    "Record a bet you intend to place. Supply the stake exactly as compute_stake returned it. The draft is refreshed and independently reviewed before execution, so drafting a match hours away costs nothing.",
  inputSchema: z.object({
    shortlistId: z.string(),
    stake: z.number().gt(0).describe("Exactly the stake compute_stake returned."),
    odds: z.number().gt(1),
    probability: z.number().min(0).max(1),
    edge: z.number(),
    reasoning: z.string().max(600).describe("Why this bet, in a sentence or two."),
  }),

  async execute(input) {
    const config = getConfig();
    const store = await getStore();

    const candidate = (await store.list(TAB.shortlist)).find(
      (entry) => entry.id === input.shortlistId,
    );
    if (!candidate) {
      return { recorded: false, reason: `no candidate with id ${input.shortlistId}` };
    }

    const [drafts, bets] = await Promise.all([store.list(TAB.drafts), store.list(TAB.bets)]);

    const live = drafts.find(
      (draft) =>
        draft.matchKey === candidate.matchKey &&
        (draft.status === "pending" || draft.status === "approved"),
    );
    if (live) {
      return {
        recorded: false,
        reason: `a live draft already exists on ${candidate.matchName} (${live.id})`,
      };
    }

    const open = bets.find(
      (bet) => bet.matchKey === candidate.matchKey && OPEN_BET_STATUSES.includes(bet.status),
    );
    if (open) {
      return {
        recorded: false,
        reason: `a bet is already open on ${candidate.matchName} (${open.id})`,
      };
    }

    const startsAt = parseIso(candidate.startsAt);
    if (!startsAt) {
      return { recorded: false, reason: `candidate ${input.shortlistId} has no usable start time` };
    }

    // Refresh-and-review happens shortly before kickoff, never at draft time.
    const executeAfter = addMinutes(startsAt, -config.strategy.executeBeforeKickoffMinutes);
    const now = isoNow();

    const draft: DraftRecord = {
      id: newId("dft"),
      cycleId: await currentCycleId(),
      createdAt: now,
      updatedAt: now,
      researchId: candidate.researchId,
      matchKey: candidate.matchKey,
      sport: candidate.sport,
      matchName: candidate.matchName,
      startsAt: candidate.startsAt,
      provider: candidate.provider,
      providerId: candidate.providerId,
      market: candidate.market,
      selection: candidate.selection,
      odds: input.odds,
      stake: input.stake,
      estimatedProbability: input.probability,
      confidence: candidate.confidence,
      edge: input.edge,
      expectedProfit:
        input.probability * (potentialReturn(input.stake, input.odds) - input.stake) -
        (1 - input.probability) * input.stake,
      potentialReturn: potentialReturn(input.stake, input.odds),
      executeAfter: executeAfter.toISOString(),
      status: "pending",
      notes: input.reasoning,
    };

    await store.append(TAB.drafts, draft);

    // This match is backed after all: any earlier "not worth it" on it is no
    // longer true and must not appear in the cycle report beside the draft.
    await clearRejections(draft.matchKey);

    return {
      recorded: true,
      draftId: draft.id,
      matchName: draft.matchName,
      selection: `${draft.market}/${draft.selection}`,
      stake: draft.stake,
      odds: draft.odds,
      potentialReturn: draft.potentialReturn,
      reviewAndExecuteAfter: draft.executeAfter,
    };
  },
});
