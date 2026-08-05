import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertReader } from "../lib/authz";
import { getConfig } from "../lib/config";
import { getLatestReports, getRecentErrors } from "../lib/overview";
import { formatInZone } from "../lib/time";

export default defineTool({
  description:
    "The most recent reports the system produced, newest first, and any unresolved errors. Use this to answer 'what happened' or 'show me the latest reports'.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(30).default(10),
    includeErrors: z.boolean().default(true),
  }),

  async execute({ limit, includeErrors }, ctx) {
    assertReader(ctx, "read reports");

    const timezone = getConfig().strategy.timezone;
    const reports = await getLatestReports(limit);
    const errors = includeErrors ? await getRecentErrors(5) : [];

    return {
      reports: reports.map((entry) => ({
        at: formatInZone(new Date(entry.createdAt), timezone),
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        deliveredToTelegram: entry.delivered,
      })),
      unresolvedErrors: errors.map((entry) => ({
        at: formatInZone(new Date(entry.createdAt), timezone),
        scope: entry.scope,
        message: entry.message,
      })),
    };
  },
});
