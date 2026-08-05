import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertReader } from "../lib/authz";
import { getConfig } from "../lib/config";
import { formatMoney } from "../lib/money";
import { getStore, OPEN_BET_STATUSES, TAB } from "../lib/sheets";
import { formatInZone } from "../lib/time";

export default defineTool({
  description:
    "List bets. 'active' shows open bets with money at risk, 'drafts' shows planned bets awaiting review, 'settled' shows recent results, 'all' shows everything recent.",
  inputSchema: z.object({
    scope: z.enum(["active", "drafts", "settled", "all"]).default("active"),
    limit: z.number().int().min(1).max(50).default(20),
  }),

  async execute({ scope, limit }, ctx) {
    assertReader(ctx, "list bets");

    const config = getConfig();
    const currency = config.strategy.currency;
    const timezone = config.strategy.timezone;
    const store = await getStore();

    const bets = await store.list(TAB.bets);
    const drafts = await store.list(TAB.drafts);
    const activeView = await store.list(TAB.activeBets);
    const liveScores = new Map(activeView.map((entry) => [entry.betId, entry.liveScore]));

    const showBets = scope === "active" || scope === "settled" || scope === "all";
    const showDrafts = scope === "drafts" || scope === "all";

    const selectedBets = !showBets
      ? []
      : bets
          .filter((bet) =>
            scope === "active"
              ? OPEN_BET_STATUSES.includes(bet.status)
              : scope === "settled"
                ? bet.status === "settled" || bet.status === "void"
                : true,
          )
          .slice(-limit)
          .reverse();

    return {
      scope,
      bets: selectedBets.map((bet) => ({
        match: bet.matchName,
        sport: bet.sport,
        kickoff: formatInZone(new Date(bet.startsAt), timezone),
        selection: `${bet.market} / ${bet.selection}`,
        odds: bet.odds,
        stake: formatMoney(bet.stake, currency),
        potentialReturn: formatMoney(bet.potentialReturn, currency),
        status: bet.status,
        result: bet.result || null,
        profit: bet.status === "settled" ? formatMoney(bet.profit, currency) : null,
        liveScore: liveScores.get(bet.id) || null,
        reference: bet.operatorRef || null,
      })),
      drafts: !showDrafts
        ? []
        : drafts
            .filter((draft) => draft.status === "pending" || draft.status === "approved")
            .slice(-limit)
            .reverse()
            .map((draft) => ({
              match: draft.matchName,
              sport: draft.sport,
              kickoff: formatInZone(new Date(draft.startsAt), timezone),
              selection: `${draft.market} / ${draft.selection}`,
              odds: draft.odds,
              stake: formatMoney(draft.stake, currency),
              status: draft.status,
              reviewAt: formatInZone(new Date(draft.executeAfter), timezone),
              reasoning: draft.notes,
            })),
    };
  },
});
