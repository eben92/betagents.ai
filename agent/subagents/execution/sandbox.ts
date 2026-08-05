/**
 * The Execution agent's own browser VM.
 *
 * It is the only agent that touches the betting site, so it is the only one
 * that needs a sandbox. agent-browser is installed during bootstrap rather than
 * on first use, so a placement never waits on an install, and the revalidation
 * key ties the cached VM image to the agent-browser version — bump the package
 * and the image is rebuilt automatically.
 */

import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";

export default defineSandbox({
  backend: microsandbox({ memoryMiB: 2048 }),
  revalidationKey: () => agentBrowserRevalidationKey(),
  async bootstrap({ use }) {
    const sandbox = await use();
    await installAgentBrowser(sandbox);
  },
});
