import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { modelSpecFor, toolOutputBudgetFor } from "../../../lib/model";
import { providerHasNativeWebSearch, searchNews, searchWeb } from "../../../lib/websearch";

/**
 * The Research agent's `web_search`, for the same reason and on the same terms
 * — see `subagents/research/tools/web_search.ts`.
 *
 * The Reviewer needs it just as much: its job is to re-check a draft against
 * what is true *now*, minutes before the bet is placed. A reviewer that cannot
 * search cannot find the late injury or the postponement that should stop the
 * bet, and would approve on the strength of research done hours earlier — which
 * is the one thing the review exists to prevent.
 *
 * Resolved against `MODEL_REVIEWER`, independently of what Research runs on.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      if (providerHasNativeWebSearch(modelSpecFor("REVIEWER"))) return null;

      return defineTool({
        description:
          "Search recent news for a query and get back headlines, sources, dates and links. Use it to re-check the specific thing this draft depends on — a fitness doubt, a confirmed lineup, a postponement — then read what matters with web_fetch.",
        inputSchema: z.object({
          query: z.string().describe("What to search for, as you would type it."),
          kind: z
            .enum(["web", "news"])
            .default("news")
            .describe(
              "news searches recent reporting, which is where a late injury or a postponement shows up. web searches the open internet.",
            ),
          limit: z.number().int().min(1).max(20).optional().describe("How many results. Defaults to 8."),
        }),

        async execute(input) {
          try {
            const limit = input.limit ?? 8;
            let results =
              input.kind === "web"
                ? await searchWeb(input.query, limit)
                : await searchNews(input.query, limit);
            if (results.length === 0) {
              results =
                input.kind === "web"
                  ? await searchNews(input.query, limit)
                  : await searchWeb(input.query, limit);
            }

            if (results.length === 0) {
              return {
                results: [],
                note: "No results. Try different wording rather than the same query again. Evidence you could not find is a reason to be careful, not a reason to assume nothing changed.",
              };
            }

            const budget = toolOutputBudgetFor("REVIEWER");
            let spent = 0;
            const trimmed = [];
            for (const result of results) {
              spent += result.title.length + result.snippet.length + result.url.length;
              if (spent > budget) break;
              trimmed.push(result);
            }

            return { results: trimmed.length > 0 ? trimmed : results.slice(0, 1) };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
      });
    },
  },
});
