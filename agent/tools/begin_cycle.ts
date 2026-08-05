import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertOperator } from "../lib/authz";
import { beginCycle, coveredMatchKeys, cycleRejections } from "../lib/cycle";
import { getConfig } from "../lib/config";
import { getStatus } from "../lib/state";

/**
 * Opens the cycle, or picks up the one already running.
 *
 * Everything a cycle produces is stamped with its id, which is what makes two
 * later things possible: a report that covers exactly this cycle, and a second
 * pass that knows which matches the first one already looked at.
 *
 * Resuming matters more than starting. A crash, a restart or a lost connection
 * mid-cycle used to mean beginning again from an empty card; now the pass count
 * and everything assessed survive, so recovery continues rather than repeats.
 */
export default defineTool({
  description:
    "Open the betting cycle, or resume the one already in progress. Call this once at the start of every scheduled cycle, before delegating anything. It returns the pass number and the matches this cycle has already assessed.",
  inputSchema: z.object({
    trigger: z
      .string()
      .max(60)
      .describe("What woke you: daily, opportunity, draft_review, monitor, reconcile or manual."),
  }),

  async execute({ trigger }, ctx) {
    assertOperator(ctx, "start a betting cycle");

    // A stopped system does nothing at all, and opening a cycle would leave one
    // hanging for the next wake-up to resume.
    const status = await getStatus();
    if (status === "stopped") {
      return { started: false, status, guidance: "The system is stopped. Do no work and book nothing." };
    }

    const config = getConfig();
    const { cycle, resumed } = await beginCycle(trigger);
    const [covered, rejections] = await Promise.all([
      coveredMatchKeys(cycle.id),
      cycleRejections(cycle.id),
    ]);

    return {
      cycleId: cycle.id,
      pass: cycle.pass,
      maxPasses: config.maxCyclePasses,
      resumed,
      startedAt: cycle.startedAt,
      trigger: cycle.trigger,
      alreadyAssessed: covered.length,
      rejectionsSoFar: rejections.map((entry) => ({
        stage: entry.stage,
        match: entry.matchName,
        selection: entry.market ? `${entry.market}/${entry.selection}` : "",
        code: entry.code,
        reason: entry.reason,
        fixable: entry.fixable,
      })),
      guidance: resumed
        ? "This cycle was already running. Continue it — do not re-research matches it has assessed."
        : "New cycle. list_fixtures will exclude anything this cycle assesses, so later passes see different matches.",
    };
  },
});
