import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { modelSpecFor, toolOutputBudgetFor } from "../../../lib/model";
import { providerHasNativeWebSearch, searchNews } from "../../../lib/websearch";

/**
 * `web_search`, but only when the model cannot search for itself.
 *
 * eve's built-in has no local executor: the provider runs the search, and only
 * Anthropic, OpenAI and Google implement it. On DeepSeek — or Kimi, Groq, or
 * anything reached as an OpenAI-compatible endpoint — the tool is never
 * offered, and this agent's entire job is finding evidence on the open web.
 * Without it, it guesses URLs.
 *
 * So this resolves per session against whatever `MODEL_RESEARCH` names:
 *
 * - provider searches natively → return `null`, contribute no tool, and let
 *   eve's built-in stand. It is the better search and it stays in place.
 * - provider does not → supply this one.
 *
 * Swapping `MODEL_RESEARCH` between providers therefore needs no code change,
 * which is the whole point of `lib/model.ts`.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      if (providerHasNativeWebSearch(modelSpecFor("RESEARCH"))) return null;

      return defineTool({
        description:
          "Search recent news for a query and get back headlines, sources, dates and links. Use it to find sources worth reading, then read them with web_fetch. Search for the specific thing you need — a team's injury news, a confirmed lineup, a postponement — not the fixture in general.",
        inputSchema: z.object({
          query: z.string().describe("What to search for, as you would type it."),
          limit: z.number().int().min(1).max(20).optional().describe("How many results. Defaults to 8."),
        }),

        async execute(input) {
          try {
            const results = await searchNews(input.query, input.limit ?? 8);

            if (results.length === 0) {
              return {
                results: [],
                note: "No results. Try different wording — a club's full name, or the specific event you are checking — rather than the same query again.",
              };
            }

            // Bounded like every other tool output, so one broad search cannot
            // eat the headroom a small-context model needs for the assessment.
            const budget = toolOutputBudgetFor("RESEARCH");
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
