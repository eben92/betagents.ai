/**
 * Matching one bookmaker's name for a team against a score provider's.
 *
 * The operator says what is bettable; the public score feed says what happened.
 * Those are different databases with different spellings — "Man Utd" and
 * "Manchester United", "Wolves" and "Wolverhampton Wanderers", "Inter" and
 * "Internazionale" — so a fixture discovered on the operator's card has to be
 * tied to a scoreboard event before it can ever be settled.
 *
 * The failure that matters is not a missed match. An unmatched fixture settles
 * as `unknown` and is escalated to a person, which is merely inconvenient. A
 * *wrong* match settles a real bet against a different game and quietly
 * corrupts the ledger. Everything here is therefore biased towards refusing:
 * both sides must agree, and a disagreement on the part of a name that
 * distinguishes local rivals is fatal however well the rest matches.
 *
 * Nothing here is specific to a bookmaker.
 */

/** Club-name furniture that carries no identifying information. */
const NOISE = new Set([
  "fc", "afc", "cf", "sc", "ac", "as", "ss", "sv", "vfl", "vfb", "bsc",
  "club", "cd", "ud", "rc", "fk", "nk", "if", "ff", "bk",
  "the", "de", "of", "and",
]);

/**
 * Words shared by clubs in the same place — the ones that separate Manchester
 * United from Manchester City, and Sheffield United from Sheffield Wednesday.
 *
 * They count for little on their own, because "United" matching "United" says
 * nothing. But when both names carry one of these and they disagree, that is
 * the whole difference between two clubs, so it vetoes the match outright.
 */
const DISTINGUISHING = new Set([
  "united", "utd", "city", "town", "athletic", "rovers", "wanderers", "county",
  "wednesday", "albion", "forest", "villa", "hotspur", "rangers", "celtic",
]);

/**
 * Words that name a *different team of the same club*: the women's side, the
 * reserves, an age group.
 *
 * These are not part of a club's name, they are a qualifier on it, so the rule
 * is stricter than for `DISTINGUISHING`. "Brighton" and "Brighton & Hove
 * Albion" are the same team written two ways, and both should match. "Arsenal"
 * and "Arsenal Women" are two teams playing two different matches, and a bet on
 * one settled against the other is simply wrong. So a qualifier present on only
 * one side is a mismatch, not a shorter spelling.
 */
const TEAM_QUALIFIER = new Set([
  "women", "w", "ladies", "femenino", "feminine",
  "b", "ii", "reserves", "youth", "academy",
  "u17", "u18", "u19", "u20", "u21", "u23",
]);

export function normaliseTeam(raw: string): string[] {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NOISE.has(token));
}

function commonPrefix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/** Whether `short` appears inside `long` in order — how "utd" reaches "united". */
function isSubsequence(short: string, long: string): boolean {
  let index = 0;
  for (const character of long) {
    if (character === short[index]) index += 1;
    if (index === short.length) return true;
  }
  return false;
}

/**
 * Whether two name tokens refer to the same word.
 *
 * Three ways in, each targeting a real abbreviation style: a shared opening
 * ("wolves"/"wolverhampton", "inter"/"internazionale"), a contraction that
 * keeps its letters in order ("utd"/"united", "sthmptn"/"southampton"), and
 * plain equality.
 */
export function tokensAgree(left: string, right: string): boolean {
  if (left === right) return true;

  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length < 3) return false;

  if (commonPrefix(short, long) >= Math.min(4, short.length)) return true;

  // A contraction must keep the first letter, or "ton" would reach "Everton".
  return short[0] === long[0] && isSubsequence(short, long);
}

/** The distinguishing words in a name, e.g. `united` in `Manchester United`. */
function distinguishing(tokens: string[]): string[] {
  return tokens.filter((token) => DISTINGUISHING.has(token));
}

/**
 * How strongly two team names agree, from 0 to 1.
 *
 * Scored against the shorter name, so an operator's "Brighton" still matches a
 * feed's "Brighton & Hove Albion" — dropping words is the normal way these two
 * sources differ. Returns 0 when the distinguishing words conflict.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = normaliseTeam(left);
  const b = normaliseTeam(right);
  if (a.length === 0 || b.length === 0) return 0;

  // A qualifier on one side and not the other means two different teams.
  const qualifiersA = a.filter((token) => TEAM_QUALIFIER.has(token)).sort();
  const qualifiersB = b.filter((token) => TEAM_QUALIFIER.has(token)).sort();
  if (qualifiersA.join(" ") !== qualifiersB.join(" ")) return 0;

  const marksA = distinguishing(a);
  const marksB = distinguishing(b);
  // Both names claim to be a particular one of the clubs in their town, and
  // they claim different ones. Nothing else about the name can rescue that.
  if (marksA.length > 0 && marksB.length > 0) {
    const agree = marksA.some((mark) => marksB.some((other) => tokensAgree(mark, other)));
    if (!agree) return 0;
  }

  const weigh = (token: string): number => (DISTINGUISHING.has(token) ? 0.3 : 1);

  const score = (from: string[], to: string[]): number => {
    const total = from.reduce((sum, token) => sum + weigh(token), 0);
    if (total === 0) return 0;
    const remaining = [...to];
    let shared = 0;
    for (const token of from) {
      const index = remaining.findIndex((other) => tokensAgree(token, other));
      if (index !== -1) {
        shared += weigh(token);
        remaining.splice(index, 1);
      }
    }
    return shared / total;
  };

  // The shorter name is the one that has to be fully accounted for.
  return Math.max(score(a, b), score(b, a));
}

/** Both sides must agree this well before two fixtures are called the same game. */
const MATCH_THRESHOLD = 0.6;

export interface Sided {
  home: string;
  away: string;
  startsAt: string;
}

/**
 * The candidate that is the same fixture, or null.
 *
 * Both teams must match and the kickoff must be within a few hours — bookmakers
 * and score feeds disagree about times more often than you would like, but not
 * by half a day.
 */
export function findSameFixture<T extends Sided>(
  target: Sided,
  candidates: readonly T[],
  toleranceHours = 6,
): T | null {
  const targetStart = Date.parse(target.startsAt);
  let best: { candidate: T; score: number } | null = null;

  for (const candidate of candidates) {
    const start = Date.parse(candidate.startsAt);
    if (Number.isFinite(targetStart) && Number.isFinite(start)) {
      if (Math.abs(start - targetStart) > toleranceHours * 60 * 60 * 1000) continue;
    }

    const home = nameSimilarity(target.home, candidate.home);
    const away = nameSimilarity(target.away, candidate.away);
    if (home < MATCH_THRESHOLD || away < MATCH_THRESHOLD) continue;

    const score = home + away;
    if (!best || score > best.score) best = { candidate, score };
  }

  return best?.candidate ?? null;
}
