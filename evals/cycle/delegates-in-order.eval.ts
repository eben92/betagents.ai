import { defineEval } from "eve/evals";

/**
 * The orchestration contract: a scheduled wake-up loads the cycle skill, reads
 * the account before planning anything, and books its next wake-up before
 * stopping.
 */
export default defineEval({
  description: "A scheduled wake-up runs a cycle through the subagents and goes back to sleep.",
  async test(t) {
    await t.send(
      "Scheduled wake-up: daily. Reasons: start of the betting day. Run one cycle by following the running-a-cycle skill, then book the next wake-up and stop.",
    );

    t.succeeded();
    t.loadedSkill("running-a-cycle");

    // The account is read before anything is planned: the planner has no
    // browser and cannot size a stake against a balance nobody fetched.
    t.calledTool("system_status");
    t.calledSubagent("execution");
    t.toolOrder(["system_status", "schedule_wakeup"]);

    // A cycle ends asleep. Polling is the failure mode this guards against.
    t.calledTool("schedule_wakeup");
    t.noFailedActions();
  },
});
