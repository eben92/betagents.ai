import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { modelSpecFor, toolOutputBudgetFor } from "../../../lib/model";
import { providerHasNativeWebSearch, searchNews, searchWeb } from "../../../lib/websearch";

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
          "Search the web for a query and get back titles, sources and links to read with web_fetch. Use kind: \"news\" for what happened in the last few days — injuries, lineups, a postponement. Use the default web search for everything else, including what other people are predicting about a fixture.",
        inputSchema: z.object({
          query: z.string().describe("What to search for, as you would type it."),
          kind: z
            .enum(["web", "news"])
            .default("web")
            .describe(
              "web searches the open internet, which is where preview, tipster and forum pages live. news searches recent reporting, which is where team news lives.",
            ),
          limit: z.number().int().min(1).max(20).optional().describe("How many results. Defaults to 8."),
        }),

        async execute(input) {
          try {
            const limit = input.limit ?? 8;
            // Fall back across modes rather than returning nothing: an empty
            // search sends this agent back to inventing URLs.
            let results =
              input.kind === "news"
                ? await searchNews(input.query, limit)
                : await searchWeb(input.query, limit);
            if (results.length === 0) {
              results =
                input.kind === "news"
                  ? await searchWeb(input.query, limit)
                  : await searchNews(input.query, limit);
            }

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
