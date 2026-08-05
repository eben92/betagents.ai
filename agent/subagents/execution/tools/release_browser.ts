import { defineTool } from "eve/tools";
import { z } from "zod";

import { close, isMock } from "../../../lib/operator";

/**
 * Frees the browser when the work is done.
 *
 * Chromium is what actually costs memory in the sandbox — hundreds of
 * megabytes, held for as long as the session lives. eve keys a sandbox to a
 * durable session and gives authored code no way to stop one, so releasing the
 * browser inside it is the lever that exists, and it is the one that matters on
 * a small VPS.
 *
 * This is belt and braces rather than the only guard: the browser also closes
 * itself after `BROWSER_IDLE_CLOSE_MS` without a command, so forgetting to call
 * this costs a few idle minutes, not the rest of the session.
 */
export default defineTool({
  description:
    "Close the browser and free its memory. Call this as your final step, once you have finished every piece of work you were given and are about to report back. Opening a page afterwards works fine — it just starts a fresh browser.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    if (isMock()) return { released: true, simulated: true };
    await close(ctx);
    return { released: true };
  },
});
