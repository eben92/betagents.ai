import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertOperator } from "../lib/authz";
import { buildCycleReport, closeCycle, currentCycle } from "../lib/cycle";
import { report } from "../lib/telegram/notify";

/**
 * The cycle's report to the operator, assembled from records.
 *
 * It takes almost no arguments on purpose. A report written by a model is a
 * different shape every time and omits whatever that run found uninteresting —
 * usually the rejections, which are the bulk of the work and the part the
 * operator most needs to see. Built from the ledger instead, it always has the
 * same sections in the same order: what was placed, what is waiting, and every
 * game that was not backed, grouped by the agent that declined it, each with
 * its reason.
 */
export default defineTool({
  description:
    "Send the operator the cycle's report: bets placed, drafts waiting, and every match that was not backed with the agent that declined it and why. Built from the record — you do not compose it. Call this once, after end_pass says the cycle is finished.",
  inputSchema: z.object({
    note: z
      .string()
      .max(400)
      .default("")
      .describe("One line of context only if something needs saying that the records do not show."),
  }),

  async execute({ note }, ctx) {
    assertOperator(ctx, "send the cycle report");

    const cycle = await currentCycle();
    if (!cycle) {
      return { sent: false, reason: "no cycle is open; call begin_cycle at the start of a cycle" };
    }

    const digest = await buildCycleReport(cycle.id);
    const lines = note.trim() ? [...digest.lines, "", note.trim()] : digest.lines;

    await report({
      kind: digest.placed > 0 ? "bet_placed" : "cycle_completed",
      title: digest.title,
      lines,
    });

    await closeCycle(digest.placed > 0 ? "bets placed" : "nothing met the bar");

    return {
      sent: true,
      cycleId: cycle.id,
      passes: cycle.pass,
      placed: digest.placed,
      rejected: digest.rejected,
    };
  },
});
