import { defineTool } from "eve/tools";
import { z } from "zod";

import { snapshot } from "../../../lib/bankroll";
import { impliedProbability, roundMoney } from "../../../lib/money";
import { getStore, OPEN_BET_STATUSES, TAB } from "../../../lib/sheets";
import { minutesBetween, parseIso } from "../../../lib/time";

/**
 * Everything needed to re-judge one draft, assembled in one call so the review
 * cannot accidentally be done against a subset of the facts.
 */
export default defineTool({
  description:
    "Load a draft with the research behind it, the operator's latest price and how far it drifted, the time to kickoff, and the exposure already carried. Start every review here.",
  inputSchema: z.object({
    draftId: z.string(),
  }),

  async execute({ draftId }) {
    const store = await getStore();
    const draft = (await store.list(TAB.drafts)).find((entry) => entry.id === draftId);
    if (!draft) return { found: false, reason: `no draft with id ${draftId}` };

    const [research, shortlist, bets, balances] = await Promise.all([
      store.list(TAB.research),
      store.list(TAB.shortlist),
      store.list(TAB.bets),
      store.list(TAB.balances),
    ]);

    const source = research.find((entry) => entry.id === draft.researchId);

    // The Account & Execution agent re-prices before a review, so the shortlist
    // row carries the current price while the draft carries the drafted one.
    const priced = shortlist.find(
      (entry) =>
        entry.matchKey === draft.matchKey &&
        entry.market === draft.market &&
        entry.selection === draft.selection,
    );
    const currentOdds = priced && priced.odds > 1 ? priced.odds : null;

    const startsAt = parseIso(draft.startsAt);
    const minutesToStart = startsAt ? Math.round(minutesBetween(new Date(), startsAt)) : null;

    const sameMatchExposure = bets.filter(
      (bet) => bet.matchKey === draft.matchKey && OPEN_BET_STATUSES.includes(bet.status),
    );

    const latestBalance = balances.at(-1);
    const bank = latestBalance ? await snapshot(latestBalance.balance) : null;

    return {
      found: true,
      draft: {
        id: draft.id,
        status: draft.status,
        matchName: draft.matchName,
        sport: draft.sport,
        startsAt: draft.startsAt,
        minutesToStart,
        market: draft.market,
        selection: draft.selection,
        draftedOdds: draft.odds,
        stake: draft.stake,
        probability: draft.estimatedProbability,
        confidence: draft.confidence,
        edgeAtDraft: draft.edge,
        reasoning: draft.notes,
        draftedAt: draft.createdAt,
      },
      research: source
        ? {
            summary: source.summary,
            confidence: source.confidence,
            supporting: source.supporting,
            opposing: source.opposing,
            sources: source.sources,
            researchedAt: source.createdAt,
          }
        : null,
      price: {
        current: currentOdds,
        pricedAt: priced?.pricedAt || null,
        driftFromDraft: currentOdds ? roundMoney(currentOdds - draft.odds) : null,
        currentImpliedProbability: currentOdds ? impliedProbability(currentOdds) : null,
        edgeNow: currentOdds
          ? roundMoney(draft.estimatedProbability * currentOdds - 1)
          : null,
      },
      exposure: {
        openBetsOnThisMatch: sameMatchExposure.map((bet) => ({
          market: bet.market,
          selection: bet.selection,
          stake: bet.stake,
        })),
        availableToStake: bank?.available ?? null,
        halted: bank?.halted ?? null,
        haltReason: bank?.haltReason ?? null,
      },
    };
  },
});
