import { defineTool } from "eve/tools";
import { z } from "zod";

import { getConfig } from "../lib/config";
import { nextMidnight } from "../lib/time";
import { invalidateCache, pendingWakeups, schedule } from "../lib/wakeups";

/**
 * How the system stays idle instead of polling: a cycle ends by booking the one
 * moment it next needs to be awake. Wake-ups for the same kind and minute
 * collapse into one row, so re-planning never accumulates work.
 */
export default defineTool({
  description:
    "Book the next time the system should wake up, and see what is already booked. Call this at the end of every cycle. Booking nothing means the system sleeps until the next midnight, which is only right when there is genuinely no pending work.",
  inputSchema: z.object({
    wakeups: z
      .array(
        z.object({
          kind: z.enum([
            "daily",
            "draft_review",
            "pre_match",
            "monitor",
            "reconcile",
            "opportunity",
            "manual",
          ]),
          dueAt: z.string().describe("ISO-8601 timestamp."),
          reason: z.string().max(200),
        }),
      )
      .max(12)
      .default([]),
    /** Kept explicit so a cycle cannot silently forget the day boundary. */
    includeNextMidnight: z.boolean().default(true),
  }),

  async execute({ wakeups, includeNextMidnight }) {
    const config = getConfig();
    const now = new Date();
    const booked: string[] = [];

    for (const wakeup of wakeups) {
      const dueAt = new Date(wakeup.dueAt);
      if (Number.isNaN(dueAt.getTime())) continue;
      await schedule({ kind: wakeup.kind, dueAt, reason: wakeup.reason });
      booked.push(`${wakeup.kind} at ${dueAt.toISOString()}`);
    }

    if (includeNextMidnight) {
      const midnight = nextMidnight(now, config.strategy.timezone);
      await schedule({
        kind: "daily",
        dueAt: midnight,
        reason: "start of the betting day",
      });
      booked.push(`daily at ${midnight.toISOString()}`);
    }

    invalidateCache();
    const pending = await pendingWakeups();

    return {
      booked,
      nextWakeAt: pending[0]?.dueAt ?? null,
      pending: pending.slice(0, 8).map((entry) => ({
        kind: entry.kind,
        dueAt: entry.dueAt,
        reason: entry.reason,
      })),
    };
  },
});
