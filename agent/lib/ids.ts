/**
 * Identifier and natural-key generation.
 *
 * Match keys and idempotency keys are deterministic: the same match researched
 * in two cycles produces the same key, which is what makes duplicate detection
 * in the spreadsheet work.
 */

import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Stable key for a fixture. Uses the kickoff date rather than the full
 * timestamp so a rescheduled start time of a few minutes does not create a
 * second record for the same match.
 */
export function matchKey(input: {
  sport: string;
  home: string;
  away: string;
  startsAt: string;
}): string {
  const day = input.startsAt.slice(0, 10);
  return `${input.sport}:${slug(input.home)}:${slug(input.away)}:${day}`;
}

/**
 * Key that guarantees one execution per approved bet. Derived only from the
 * approval id, so a retry after an unknown outcome reuses it and is rejected by
 * the store's uniqueness guard.
 */
export function idempotencyKey(approvedId: string): string {
  return sha256(`bet:${approvedId}`).slice(0, 32);
}
