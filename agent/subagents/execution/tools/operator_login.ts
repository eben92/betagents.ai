import { defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";
import { isMock, login, operatorName, OperatorError } from "../../../lib/operator";

/**
 * The credential boundary.
 *
 * The username and password are read from configuration inside this tool and
 * handed straight to the browser. They are never returned, never logged, never
 * put in a prompt and never written to the spreadsheet. The agent calls this
 * with no arguments because it has nothing to supply.
 */
export default defineTool({
  description:
    "Log in to the betting operator. Takes no arguments — the credentials are held by the system and are never shown to you. Call this before anything else that needs an account.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    try {
      await login(ctx);
      return { loggedIn: true, operator: operatorName(), simulated: isMock() };
    } catch (error) {
      if (error instanceof OperatorError && error.needsHuman) {
        return { loggedIn: false, needsHuman: true, detail: error.message };
      }
      return { loggedIn: false, needsHuman: false, detail: errorMessage(error) };
    }
  },
});
