import { defineTool } from "eve/tools";
import { z } from "zod";

import * as browser from "../../../lib/operator/browser";
import { getConfig, usesRealFixtureSource } from "../../../lib/config";
import { toolOutputBudgetFor } from "../../../lib/model";
import { isMock } from "../../../lib/operator";
import { errorMessage } from "../../../lib/logger";

/**
 * Navigation, deliberately generic.
 *
 * Elements are located semantically — by role, label, visible text — so nothing
 * here is specific to one bookmaker. Adding an operator is configuration, not a
 * new module of selectors.
 *
 * `fill` refuses to touch a password field: credentials only ever travel
 * through `operator_login`, which never exposes them.
 */
export default defineTool({
  description:
    "Move around the operator's site: open a page, read its text, snapshot what is interactive, or find an element by role/label/text and click, type into or read it. Use snapshot to see what is on the page and read to get its text.",
  inputSchema: z.object({
    action: z.enum(["open", "read", "snapshot", "find", "back"]),
    url: z.string().optional().describe("For open. Relative paths resolve against the chosen site."),
    site: z
      .enum(["operator", "catalogue"])
      .default("operator")
      .describe(
        "Which site a relative url belongs to. `catalogue` is the fixture listing you read the card from; `operator` is the account that takes bets. They can be different sites.",
      ),
    by: z
      .enum(["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last"])
      .optional()
      .describe("For find: how to match the element."),
    query: z.string().optional().describe("For find: the role name, text, label or selector."),
    on: z
      .enum(["click", "fill", "check", "hover", "text"])
      .optional()
      .describe("For find: what to do with the element once found."),
    value: z.string().optional().describe("For find with fill: the text to type."),
    name: z.string().optional().describe("For find by role: the element's accessible name."),
  }),

  async execute(input, ctx) {
    // Scaled to this agent's context window: one greedy page must not eat the
    // headroom a 64K model needs for the rest of the placement.
    const budget = toolOutputBudgetFor("EXECUTION");

    // The catalogue is reachable even when the bookmaker is simulated: reading a
    // real card while staking pretend money is the rehearsal worth running, and
    // nothing on a listing page can move money.
    const catalogue = input.site === "catalogue" && usesRealFixtureSource();

    if (isMock() && !catalogue) {
      return {
        simulated: true,
        note: usesRealFixtureSource()
          ? "The simulated bookmaker has no pages to browse. Use price_selection and place_bet directly. The fixture catalogue is real — reach it with site: \"catalogue\"."
          : "The simulated operator has no pages to browse. Use price_selection and place_bet directly.",
      };
    }

    if (catalogue && getConfig().browserDriver !== "sandbox") {
      return {
        error:
          "Reading the catalogue needs a real browser. Set BROWSER_DRIVER=sandbox; the bookmaker can stay simulated.",
      };
    }

    try {
      switch (input.action) {
        case "open": {
          if (!input.url) return { error: "open needs a url" };
          const page = await browser.open(ctx, input.url, input.site);
          browser.assertNoBlockers(page, `opening ${input.url}`);
          return { url: page.url, title: page.title, text: page.text.slice(0, budget) };
        }

        case "read": {
          const page = await browser.readPage(ctx);
          browser.assertNoBlockers(page, "reading the page");
          return { url: page.url, title: page.title, text: page.text.slice(0, budget) };
        }

        case "snapshot":
          return { snapshot: await browser.snapshot(ctx, { interactive: true }) };

        case "back":
          await browser.back(ctx);
          return { ok: true };

        case "find": {
          if (!input.by || !input.query || !input.on) {
            return { error: "find needs by, query and on" };
          }
          if (input.on === "fill" && /pass(word|code)|pin|secret/i.test(input.query)) {
            return {
              error:
                "Password fields are handled by operator_login and cannot be filled here. Credentials are never available to you.",
            };
          }
          const text = await browser.find(ctx, {
            by: input.by,
            query: input.query,
            action: input.on,
            value: input.value,
            name: input.name,
          });
          return { ok: true, text };
        }
      }
    } catch (error) {
      return { error: errorMessage(error) };
    }
  },
});
