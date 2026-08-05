import { defineEval } from "eve/evals";

/**
 * The orchestration contract: a scheduled wake-up loads the cycle skill, reads
 * the account before planning anything, and books its next wake-up before
 * stopping.
 *
 * This dispatches the real schedule rather than sending itself a message that
 * looks like one. The difference is not cosmetic: eve grants `requestInput` only
 * to conversation sessions, so a scheduled run cannot see `ask_question` at all,
 * while a simulated one can — and did, parking the cycle on a question nobody
 * was there to answer. Driving the wrong session shape tests an agent that does
 * not exist in production, and hides the one that does.
 */
export default defineEval({
  description: "A scheduled wake-up runs a cycle through the subagents and goes back to sleep.",
  async test(t) {
    const { sessionIds } = await t.target.dispatchSchedule("tick");
    const [sessionId] = sessionIds;
    if (!sessionId) throw new Error("the tick schedule started no session");

    const session = await t.target.attachSession(sessionId);

    session.succeeded();
    session.loadedSkill("running-a-cycle");

    // The cycle is opened before anything is delegated. Without it nothing is
    // attributed to the cycle, so neither the retry decision nor the report has
    // anything to work from.
    session.calledTool("begin_cycle");

    // The account is read before anything is planned: the planner has no
    // browser and cannot size a stake against a balance nobody fetched.
    session.calledTool("system_status");
    session.calledSubagent("execution");

    // The pass is closed deliberately rather than the cycle just petering out.
    // This is what decides whether a sweep that backed nothing sweeps again,
    // and it is the guard against a model concluding "nothing today" from one
    // look at a dozen of the day's hundred fixtures.
    session.calledTool("end_pass");

    // Every match declined is reported by name, from the ledger rather than
    // from whatever the model remembered.
    session.calledTool("send_cycle_report");

    // A cycle ends asleep. Polling is the failure mode this guards against.
    session.calledTool("schedule_wakeup");
    session.toolOrder(["begin_cycle", "system_status", "end_pass", "send_cycle_report", "schedule_wakeup"]);

    // Nobody is on the other end of a cron tick. eve withholds the tool here, so
    // a call would mean the cycle is being dispatched down the wrong path — not
    // that the model chose badly.
    session.notCalledTool("ask_question");

    t.noFailedActions();
  },
});
