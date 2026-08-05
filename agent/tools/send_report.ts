import { defineTool } from "eve/tools";
import { z } from "zod";

import { report } from "../lib/telegram/notify";

/**
 * Reports are persisted before delivery and redacted on the way out, so a
 * Telegram outage loses nothing and a credential can never leave this way.
 */
export default defineTool({
  description:
    "Send a report to the operator's Telegram chat and record it. Use for meaningful events only: bets placed, settlements, blockers needing a person, the daily summary. Routine progress is noise.",
  inputSchema: z.object({
    kind: z.enum([
      "system",
      "cycle_completed",
      "research_completed",
      "planner_completed",
      "reviewer_approved",
      "reviewer_rejected",
      "balance",
      "bet_drafted",
      "bet_placed",
      "bet_rejected",
      "live_update",
      "settlement",
      "daily_summary",
      "error",
      "needs_human",
    ]),
    title: z.string().max(120),
    lines: z.array(z.string().max(400)).max(20).default([]),
  }),

  async execute({ kind, title, lines }) {
    await report({ kind, title, lines });
    return { sent: true };
  },
});
