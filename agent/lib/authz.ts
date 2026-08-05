/**
 * Authorisation for the control tools.
 *
 * The Telegram channel already rejects unknown users, but the same tools are
 * reachable from the HTTP channel, so control actions are checked again here.
 * Read-only tools use `assertReader`; anything that changes system behaviour
 * uses `assertOperator`.
 */

import type { SessionContext } from "eve/context";

import { createLogger } from "./logger";

const log = createLogger("authz");

export class NotAuthorisedError extends Error {
  constructor(action: string) {
    super(`Not authorised to ${action}.`);
    this.name = "NotAuthorisedError";
  }
}

function isAppPrincipal(ctx: SessionContext): boolean {
  const auth = ctx.session.auth.current;
  return (
    auth?.authenticator === "app" &&
    auth.principalId === "eve:app" &&
    auth.principalType === "runtime"
  );
}

function isOperator(ctx: SessionContext): boolean {
  return ctx.session.auth.current?.attributes.operator === "true";
}

/**
 * The synthetic principal eve mints for `eve dev`. It is a property of the
 * process, not of the request — no header can produce it, and `eve start` never
 * mints it — so trusting it grants nothing beyond what a shell on the dev
 * machine already has. Without it the TUI and the eval suite cannot exercise a
 * single control tool.
 */
function isLocalDevPrincipal(ctx: SessionContext): boolean {
  const auth = ctx.session.auth.current;
  return auth?.authenticator === "local-dev" && auth.principalType === "local-dev";
}

/** Allows the system itself and any principal marked as an operator. */
export function assertOperator(ctx: SessionContext, action: string): void {
  if (isAppPrincipal(ctx) || isOperator(ctx) || isLocalDevPrincipal(ctx)) return;
  log.warn("blocked an unauthorised control action", {
    action,
    principal: ctx.session.auth.current?.principalId ?? "anonymous",
  });
  throw new NotAuthorisedError(action);
}

/**
 * Read access. Local development sessions are allowed so `eve dev` is usable;
 * production HTTP access is governed by the channel's auth policy.
 */
export function assertReader(ctx: SessionContext, action: string): void {
  if (isAppPrincipal(ctx) || isOperator(ctx)) return;
  if (ctx.session.auth.current !== null) return;
  throw new NotAuthorisedError(action);
}
