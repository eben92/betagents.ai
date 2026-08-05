/**
 * The Execution agent's own browser VM.
 *
 * It is the only agent that touches the betting site, so it is the only one
 * that needs a sandbox. Everything is installed during bootstrap rather than on
 * first use, so a placement never waits on a download, and the revalidation key
 * ties the cached VM image to what was installed — change either and the image
 * is rebuilt automatically.
 *
 * The browser is Playwright's Chromium rather than the Chrome for Testing build
 * agent-browser vendors by default. Chrome for Testing publishes no Linux ARM64
 * build, and a microsandbox VM on Apple Silicon is Linux ARM64, so the default
 * bootstrap fails outright on a Mac. Playwright publishes both architectures,
 * which gives development and the server the same browser instead of two.
 */

import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";

/** Everything the browser needs lives here, on disk rather than in tmpfs. */
const BROWSER_ROOT = "/opt/browser";

/**
 * A stable path to the browser. Playwright installs under a revision-numbered
 * directory that changes with every release, so bootstrap links the binary here
 * and nothing else has to know the revision.
 */
const EXECUTABLE_PATH = `${BROWSER_ROOT}/chrome`;

/**
 * `/tmp` in the VM is a 128 MiB tmpfs, and the Chromium archive alone is
 * ~195 MiB, so an install that unpacks through `/tmp` fails with ENOSPC. The
 * browser is happier here at runtime too — downloads and crash dumps have room.
 */
const TMPDIR = `${BROWSER_ROOT}/tmp`;

const PLAYWRIGHT_BROWSERS_PATH = `${BROWSER_ROOT}/playwright`;

/** Bumped when the script below changes, to force a rebuild of cached images. */
const BROWSER_INSTALL_REVISION = "1";

const INSTALL_CHROMIUM = [
  "set -e",
  `sudo mkdir -p ${TMPDIR} ${PLAYWRIGHT_BROWSERS_PATH}`,
  `sudo chmod -R 777 ${BROWSER_ROOT}`,
  `export TMPDIR=${TMPDIR} PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}`,
  // `--with-deps` installs the system libraries this Chromium build was linked
  // against, which is a shorter path than guessing package names per release.
  "npx --yes playwright-core@1 install --with-deps chromium",
  `chrome=$(find ${PLAYWRIGHT_BROWSERS_PATH} -type f -name chrome | head -1)`,
  '[ -n "$chrome" ] || { echo "playwright installed no chromium binary" >&2; exit 1; }',
  `sudo ln -sf "$chrome" ${EXECUTABLE_PATH}`,
  `${EXECUTABLE_PATH} --version`,
].join("\n");

export default defineSandbox({
  backend: microsandbox({
    memoryMiB: 2048,
    env: {
      AGENT_BROWSER_EXECUTABLE_PATH: EXECUTABLE_PATH,
      PLAYWRIGHT_BROWSERS_PATH,
      TMPDIR,
    },
  }),

  revalidationKey: () =>
    [
      agentBrowserRevalidationKey({ installBrowser: false }),
      `playwright-chromium-${BROWSER_INSTALL_REVISION}`,
    ].join(":"),

  async bootstrap({ use }) {
    const sandbox = await use();

    // agent-browser itself, plus the Chromium system libraries eve knows about.
    // Not its browser: that is the download with no ARM64 build.
    await installAgentBrowser(sandbox, { installBrowser: false });

    const result = await sandbox.run({ command: INSTALL_CHROMIUM });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not install Chromium in the execution sandbox (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
  },
});
