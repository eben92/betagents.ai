/**
 * The only scheduled task in the system.
 *
 * It fires every minute and almost always does nothing: `anythingDue` answers
 * from an in-memory cache without touching the spreadsheet. When work is
 * actually due it claims the wake-ups and hands one brief to the root agent,
 * which orchestrates the cycle through its subagents, books its own next
 * wake-up and stops. Nothing here decides what happens in a cycle.
 *
 * Cron runs in UTC on every host, which is why the midnight roll-over is a
 * wake-up computed in the configured timezone rather than a cron expression.
 */

import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram";
import { getConfig } from "../lib/config";
import { createLogger, errorMessage } from "../lib/logger";
import { getStatus } from "../lib/state";
import { nextMidnight } from "../lib/time";
import { anythingDue, claimDue, complete, ensureSeeded, schedule } from "../lib/wakeups";

const log = createLogger("schedule:tick");

/** Guards against a slow cycle overlapping the next tick within one process. */
let running = false;
let seeded = false;

/**
 * Books the next midnight in the configured timezone. Idempotent: `schedule`
 * collapses repeated calls for the same kind and minute into one row.
 */
async function bookTheDayBoundary(now: Date): Promise<void> {
  await schedule({
    kind: "daily",
    dueAt: nextMidnight(now, getConfig().strategy.timezone),
    reason: "start of the betting day",
  });
}

/** The brief handed to the root agent. The cycle skill supplies the procedure. */
function brief(trigger: string, reasons: string[]): string {
  return [
    `Scheduled wake-up: ${trigger}.`,
    reasons.length > 0 ? `Reasons: ${reasons.join("; ")}.` : null,
    "Run one cycle by following the running-a-cycle skill, then book the next wake-up and stop.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

export default defineSchedule({
  cron: "* * * * *",

  async run({ receive, waitUntil, appAuth }) {
    if (running) return;

    waitUntil(
      (async () => {
        running = true;
        try {
          if ((await getStatus()) === "stopped") return;

          if (!seeded) {
            await ensureSeeded();
            seeded = true;
          }

          const now = new Date();
          if (!(await anythingDue(now))) return;

          const claimed = await claimDue(now);
          if (claimed.length === 0) {
            await bookTheDayBoundary(now);
            return;
          }

          const trigger = [...new Set(claimed.map((entry) => entry.kind))].join("+");
          log.info("wake-ups claimed", { count: claimed.length, trigger });

          try {
            const chatId = getConfig().telegram?.chatId;
            if (!chatId) {
              throw new Error(
                "TELEGRAM_CHAT_ID must be set: a cycle reports to that chat, and there is nowhere else to run it.",
              );
            }

            await receive(telegram, {
              message: brief(
                trigger,
                claimed.map((entry) => entry.reason).filter(Boolean),
              ),
              target: { chatId },
              auth: appAuth,
            });
            await complete(
              claimed.map((entry) => entry.id),
              "done",
            );
          } catch (error) {
            // The wake-ups stay failed rather than pending: a cycle that threw
            // must not be replayed blindly, and the next daily wake-up will
            // pick the work up with fresh state.
            await complete(
              claimed.map((entry) => entry.id),
              "failed",
            );
            throw error;
          } finally {
            // Whatever the cycle did — booked its own wake-ups, threw, or parked
            // on a question nobody will answer — the day boundary is booked here.
            //
            // Without this the system's continued existence depends on the model
            // remembering to call `schedule_wakeup`. One forgotten call and there
            // are no pending wake-ups, `anythingDue` answers false forever, and
            // the system stops trading in perfect silence: no error, no report,
            // nothing to notice. `schedule` collapses duplicates, so booking it
            // again when the cycle already did costs nothing.
            await bookTheDayBoundary(new Date());
          }
        } catch (error) {
          log.error("scheduled tick failed", { error: errorMessage(error) });
        } finally {
          running = false;
        }
      })(),
    );
  },
});
