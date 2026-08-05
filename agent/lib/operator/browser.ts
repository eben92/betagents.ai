/**
 * Browser-driven operator access, backed by agent-browser inside the sandbox.
 *
 * There are no per-bookmaker selectors here. agent-browser locates elements
 * semantically — by ARIA role, label or visible text — so the same code drives
 * SportyBet, Betway or anything else. Where a page genuinely cannot be read
 * generically, the Execution agent reads it and passes the value back; it never
 * gets to choose a stake or a price, only to report what it saw.
 *
 * Protections are never circumvented. A CAPTCHA, an MFA prompt or an account
 * restriction stops the run and escalates to a person. There is deliberately no
 * code path that attempts to satisfy one.
 */

import {
  installAgentBrowser,
  runAgentBrowser,
  type EveToolContext,
} from "@agent-browser/eve/sandbox";

import { getConfig } from "../config";
import { createLogger, errorMessage } from "../logger";
import { OperatorError } from "./types";

const log = createLogger("operator:browser");

/** One long-lived browser session so a login survives across tool calls. */
const SESSION = "operator";

/**
 * No browser command may run forever. Without a deadline a wedged VM or a page
 * that never settles blocks the tool call, which blocks the agent, which blocks
 * the cycle — and a cycle that never ends never books its next wake-up.
 */
const COMMAND_TIMEOUT_MS = Number(process.env.BROWSER_COMMAND_TIMEOUT_MS ?? 120_000);

/**
 * How long the browser may sit idle inside the sandbox before it is closed.
 *
 * Chromium is what actually costs memory; the idle VM shell is small. Closing
 * it on a timer means a forgotten `release_browser` cannot leak a browser for
 * the rest of the session.
 */
const IDLE_CLOSE_MS = Number(process.env.BROWSER_IDLE_CLOSE_MS ?? 3 * 60_000);

/** Sandbox ids known to have agent-browser installed, so we install once. */
const installed = new Set<string>();

let idleTimer: NodeJS.Timeout | null = null;
let idleContext: BrowserContext | null = null;

function armIdleClose(ctx: BrowserContext): void {
  idleContext = ctx;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const target = idleContext;
    idleTimer = null;
    idleContext = null;
    if (target) void close(target).catch(() => undefined);
  }, IDLE_CLOSE_MS);
  // Never hold the process open just to keep a browser warm.
  idleTimer.unref?.();
}

function disarmIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  idleContext = null;
}

async function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new OperatorError(
                `${label} did not finish within ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s. The browser sandbox may be starting or wedged.`,
              ),
            ),
          COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Makes sure agent-browser exists in whichever sandbox we are talking to now.
 *
 * A sandbox can be replaced under a running session — it crashed, the host
 * restarted, the definition changed. The replacement is a fresh machine with a
 * fresh id and no agent-browser on it, so this both revives the tooling and
 * detects the swap.
 */
async function ensureInstalled(ctx: BrowserContext): Promise<void> {
  const sandbox = await withDeadline(
    Promise.resolve(ctx.getSandbox()),
    "Acquiring the browser sandbox",
  );
  if (!sandbox) {
    throw new OperatorError(
      "No browser sandbox is available. The Account & Execution agent requires one; check that microsandbox is installed on this host.",
    );
  }
  if (installed.has(sandbox.id)) return;

  const probe = await sandbox.run({ command: "command -v agent-browser >/dev/null 2>&1" });
  if ((probe.exitCode ?? 1) !== 0) {
    log.info("installing agent-browser in a new sandbox", { sandboxId: sandbox.id });
    await withDeadline(installAgentBrowser(sandbox), "Installing agent-browser");
  }
  installed.add(sandbox.id);
}

export type BrowserContext = EveToolContext;

export interface PageText {
  url: string;
  title: string;
  text: string;
}

/**
 * Markers that mean a human is required. Matched against visible page text
 * rather than selectors, so they work on any site. Erring towards stopping is
 * correct: a false stop costs a cycle, a missed CAPTCHA costs an account.
 */
const BLOCKER_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /\b(captcha|recaptcha|hcaptcha|i'?m not a robot|verify you are human)\b/i, kind: "CAPTCHA" },
  { pattern: /\b(two[- ]factor|2fa|multi[- ]factor|one[- ]time (code|password)|otp|authenticator app|verification code)\b/i, kind: "multi-factor prompt" },
  {
    pattern: /\b(account (is )?(suspended|restricted|locked|closed|blocked)|self[- ]exclu|temporarily unavailable in your region|verify your identity|kyc)\b/i,
    kind: "account restriction",
  },
];

/**
 * Runs one agent-browser verb and returns its unwrapped JSON payload.
 *
 * Every call is deadlined and, if the sandbox turns out to have been replaced,
 * retried exactly once against the new one. Once — not in a loop: a command
 * that fails twice is a real failure, and this path is one step away from
 * placing money.
 */
async function run<T>(ctx: BrowserContext, args: readonly string[]): Promise<T | null> {
  const attempt = async (): Promise<T | null> => {
    await ensureInstalled(ctx);

    const result = await withDeadline(
      runAgentBrowser<{ success?: boolean; data?: T; error?: string }>(ctx, args, {
        session: SESSION,
      }),
      `agent-browser ${args[0]}`,
    );

    const envelope = result.json;
    if (envelope && envelope.success === false) {
      throw new OperatorError(`agent-browser ${args[0]}: ${envelope.error ?? "unknown error"}`);
    }
    if (result.exitCode !== 0) {
      throw new OperatorError(
        `agent-browser ${args[0]} exited ${result.exitCode}: ${result.stderr}`,
      );
    }
    return envelope?.data ?? null;
  };

  try {
    const value = await attempt();
    armIdleClose(ctx);
    return value;
  } catch (error) {
    // A sandbox that died takes agent-browser with it. Forget what we believed
    // about every sandbox, which forces a reinstall probe on the retry.
    installed.clear();
    log.warn("browser command failed; retrying once against a fresh sandbox", {
      command: args[0],
      error: errorMessage(error),
    });

    const value = await attempt();
    armIdleClose(ctx);
    return value;
  }
}

function absolute(path: string): string {
  const base = getConfig().operator.baseUrl.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${path.replace(/^\/+/, "")}`;
}

export async function open(ctx: BrowserContext, url: string): Promise<PageText> {
  await run(ctx, ["open", absolute(url)]);
  return readPage(ctx);
}

export async function readPage(ctx: BrowserContext): Promise<PageText> {
  const data = await run<{ url?: string; title?: string; text?: string; content?: string }>(ctx, [
    "read",
  ]);
  return {
    url: data?.url ?? "",
    title: data?.title ?? "",
    text: data?.text ?? data?.content ?? "",
  };
}

export async function back(ctx: BrowserContext): Promise<void> {
  await run(ctx, ["back"]);
}

export async function snapshot(ctx: BrowserContext, options: { interactive?: boolean } = {}) {
  const args = ["snapshot", "--compact"];
  if (options.interactive !== false) args.push("--interactive");
  return run<unknown>(ctx, args);
}

/**
 * Finds an element semantically and acts on it.
 *
 * `value` is never logged — this is the path a password travels.
 */
export async function find(
  ctx: BrowserContext,
  input: {
    by: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testid" | "first" | "last";
    query: string;
    action: "click" | "fill" | "check" | "hover" | "text";
    value?: string;
    name?: string;
    exact?: boolean;
  },
): Promise<string | null> {
  const args: string[] = ["find", input.by, input.query, input.action];
  if (input.value !== undefined) args.push(input.value);
  if (input.name !== undefined) args.push("--name", input.name);
  if (input.exact) args.push("--exact");

  const data = await run<{ text?: string } | string>(ctx, args);
  if (typeof data === "string") return data;
  return data?.text ?? null;
}

/** True when the element could be acted on; false instead of throwing. */
export async function tryFind(
  ctx: BrowserContext,
  input: Parameters<typeof find>[1],
): Promise<boolean> {
  try {
    await find(ctx, input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops the run when the page shows a protection challenge.
 *
 * This is a hard stop by design. The system escalates to a person and never
 * attempts to answer the challenge itself.
 */
export function assertNoBlockers(page: PageText, stage: string): void {
  const haystack = `${page.title}\n${page.text}`;
  for (const { pattern, kind } of BLOCKER_PATTERNS) {
    if (pattern.test(haystack)) {
      throw new OperatorError(`${kind} presented at ${stage}; a person must handle it.`, true);
    }
  }
}

/**
 * Logs in using credentials read straight from configuration.
 *
 * The username and password never enter a model prompt, a tool result, a log
 * line, the spreadsheet or Telegram — they travel from `getConfig()` into the
 * sandbox command and nowhere else.
 */
export async function login(ctx: BrowserContext): Promise<void> {
  const config = getConfig();
  const page = await open(ctx, config.operator.loginPath);
  assertNoBlockers(page, "login page");

  // Cookie and promo dialogs sit on top of the form on most operators.
  for (const label of ["Accept", "Accept all", "I agree", "Got it", "Close", "Continue"]) {
    await tryFind(ctx, { by: "role", query: "button", name: label, action: "click" });
  }

  if (await isLoggedIn(ctx)) {
    log.info("existing operator session reused");
    return;
  }

  const filledUser =
    (await tryFind(ctx, {
      by: "label",
      query: config.operator.usernameLabel,
      action: "fill",
      value: config.operator.username,
    })) ||
    (await tryFind(ctx, {
      by: "placeholder",
      query: config.operator.usernameLabel,
      action: "fill",
      value: config.operator.username,
    }));
  if (!filledUser) {
    throw new OperatorError(
      `Could not find a field labelled "${config.operator.usernameLabel}" on the login page. Set OPERATOR_USERNAME_LABEL to match the site.`,
    );
  }

  const filledPassword =
    (await tryFind(ctx, {
      by: "label",
      query: config.operator.passwordLabel,
      action: "fill",
      value: config.operator.password,
    })) ||
    (await tryFind(ctx, {
      by: "placeholder",
      query: config.operator.passwordLabel,
      action: "fill",
      value: config.operator.password,
    }));
  if (!filledPassword) {
    throw new OperatorError(
      `Could not find a field labelled "${config.operator.passwordLabel}" on the login page. Set OPERATOR_PASSWORD_LABEL to match the site.`,
    );
  }

  const submitted = await tryFind(ctx, {
    by: "role",
    query: "button",
    name: config.operator.loginButtonLabel,
    action: "click",
  });
  if (!submitted) {
    throw new OperatorError(
      `Could not find a "${config.operator.loginButtonLabel}" button. Set OPERATOR_LOGIN_BUTTON to match the site.`,
    );
  }

  // Challenges frequently appear only after the form is submitted.
  const after = await readPage(ctx);
  assertNoBlockers(after, "login submission");

  if (!(await isLoggedIn(ctx))) {
    throw new OperatorError("Login did not complete; the logged-in marker never appeared.");
  }
  log.info("logged in to operator", { operator: config.operator.name });
}

/** Presence of the configured logged-in marker text on the page. */
export async function isLoggedIn(ctx: BrowserContext): Promise<boolean> {
  const marker = getConfig().operator.loggedInMarker;
  try {
    const page = await readPage(ctx);
    return new RegExp(marker, "i").test(`${page.title}\n${page.text}`);
  } catch (error) {
    log.debug("logged-in probe failed", { error: errorMessage(error) });
    return false;
  }
}

/**
 * Closes the browser and frees what it was holding.
 *
 * Called explicitly when an agent finishes, and automatically on the idle
 * timer. Failure is logged and swallowed: a browser that cannot be closed is
 * not a reason to fail work that already succeeded, and the idle timer will try
 * again.
 */
export async function close(ctx: BrowserContext): Promise<void> {
  disarmIdleClose();
  try {
    // Deliberately not through `run`: closing must not arm the idle timer, and
    // a failed close must not trigger a sandbox-revival retry.
    await withDeadline(
      runAgentBrowser(ctx, ["close"], { session: SESSION }),
      "agent-browser close",
    );
    log.info("browser closed");
  } catch (error) {
    log.debug("browser close skipped", { error: errorMessage(error) });
  }
}
