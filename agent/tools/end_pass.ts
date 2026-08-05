import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertOperator } from "../lib/authz";
import { advancePass, cycleRejections, decidePass } from "../lib/cycle";

/**
 * Decides whether the cycle sweeps again.
 *
 * A pass that backed nothing is not a day with nothing to back — it is a
 * verdict on the handful of matches that pass happened to look at. On a hundred
 * fixtures, stopping after one sweep is how a working system sits idle. So the
 * cycle keeps going over fixtures it has not yet assessed until it places
 * something, runs out of passes, or runs out of card.
 *
 * The decision is computed rather than judged, because the failure mode it
 * exists to prevent is precisely a model concluding "nothing today" and going
 * back to sleep.
 */
export default defineTool({
  description:
    "Close the current pass and find out whether to run another. Call this after review and execution, before scheduling anything. When it returns retry: true, go back to research — list_fixtures will return matches this cycle has not seen.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    assertOperator(ctx, "end a cycle pass");

    const decision = await decidePass();
    if (decision.retry) await advancePass();

    const rejections = await cycleRejections(decision.cycleId);
    const thisPass = rejections.filter((entry) => entry.pass === decision.pass);

    return {
      cycleId: decision.cycleId,
      pass: decision.pass,
      maxPasses: decision.maxPasses,
      placed: decision.placed,
      liveDrafts: decision.liveDrafts,
      awaitingExecution: decision.awaitingExecution,
      fixturesUnexamined: decision.fixturesUnexamined,
      retry: decision.retry,
      reason: decision.reason,
      rejectedThisPass: thisPass.map((entry) => ({
        stage: entry.stage,
        match: entry.matchName,
        selection: entry.market ? `${entry.market}/${entry.selection}` : "",
        code: entry.code,
        reason: entry.reason,
        fixable: entry.fixable,
      })),
      nextStep: decision.retry
        ? `Run pass ${decision.pass + 1}: send research back out for different fixtures, then price, plan and review as before. Do not schedule or report yet.`
        : "The cycle is finished. Call send_cycle_report, then schedule_wakeup, then stop.",
    };
  },
});
