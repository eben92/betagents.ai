import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertOperator } from "../lib/authz";
import { createLogger } from "../lib/logger";
import { getStatus, setHaltReason, setStatus } from "../lib/state";
import { report } from "../lib/telegram/notify";
import { invalidateCache, schedule } from "../lib/wakeups";

const log = createLogger("tool:system_control");

/**
 * `pause` keeps monitoring and settling existing bets but places no new ones.
 * `stop` halts every cycle, including monitoring, until the system is started
 * again — open bets are left untouched at the operator.
 */
export default defineTool({
  description:
    "Start, stop, pause or resume the betting system. Pause keeps monitoring open bets but places no new bets; stop halts all cycles. Use for the /start, /stop, /pause and /resume commands.",
  inputSchema: z.object({
    action: z.enum(["start", "stop", "pause", "resume"]),
    reason: z.string().max(300).optional(),
  }),

  async execute({ action, reason }, ctx) {
    assertOperator(ctx, `${action} the betting system`);

    const before = await getStatus();
    const next = action === "stop" ? "stopped" : action === "pause" ? "paused" : "running";

    await setStatus(next);

    if (next === "running") {
      // Clear any manual halt and wake immediately so the operator sees action.
      await setHaltReason(null);
      await schedule({
        kind: "manual",
        dueAt: new Date(),
        reason: reason ?? `${action} requested by an operator`,
      });
      invalidateCache();
    }

    log.info("system control action", { action, before, next });

    await report({
      kind: "system",
      title: `System ${next}`,
      lines: [
        `Requested: ${action}`,
        `Previous state: ${before}`,
        reason ?? null,
        next === "paused" ? "Open bets are still monitored and settled." : null,
        next === "stopped" ? "All cycles halted. Open bets remain at the operator." : null,
      ].filter((line): line is string => line !== null),
    });

    return { previousStatus: before, status: next };
  },
});
