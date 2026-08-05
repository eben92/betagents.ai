/**
 * Canonical betting markets.
 *
 * Agents choose from this fixed vocabulary rather than free text. That buys two
 * things: settlement is computed from the final score instead of guessed, and
 * the operator profile only has to translate a known set of labels into the
 * site's own wording.
 */

import type { Sport } from "./config";
import type { MatchState } from "./sports/types";

export type MarketId = "1x2" | "double_chance" | "over_under" | "btts" | "moneyline" | "handicap";

export interface MarketSelection {
  market: MarketId;
  /** Machine code, e.g. `home`, `over_2.5`, `home_-1.5`. */
  code: string;
}

/** Markets that can be priced and settled for each sport. */
export const MARKETS_BY_SPORT: Record<Sport, MarketId[]> = {
  football: ["1x2", "double_chance", "over_under", "btts"],
  basketball: ["moneyline", "over_under", "handicap"],
  cricket: ["moneyline"],
  tennis: ["moneyline"],
};

export function marketsFor(sport: Sport): MarketId[] {
  return MARKETS_BY_SPORT[sport];
}

function parseLine(code: string, prefix: string): number | null {
  if (!code.startsWith(`${prefix}_`)) return null;
  const value = Number(code.slice(prefix.length + 1));
  return Number.isFinite(value) ? value : null;
}

function parseHandicap(code: string): { side: "home" | "away"; line: number } | null {
  const match = code.match(/^(home|away)_(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return { side: match[1] as "home" | "away", line: Number(match[2]) };
}

/** Validates a selection code against its market. */
export function isValidSelection(selection: MarketSelection): boolean {
  const { market, code } = selection;
  switch (market) {
    case "1x2":
      return ["home", "draw", "away"].includes(code);
    case "double_chance":
      return ["home_or_draw", "away_or_draw", "home_or_away"].includes(code);
    case "moneyline":
      return ["home", "away"].includes(code);
    case "btts":
      return ["yes", "no"].includes(code);
    case "over_under":
      return parseLine(code, "over") !== null || parseLine(code, "under") !== null;
    case "handicap":
      return parseHandicap(code) !== null;
    default:
      return false;
  }
}

/**
 * Human label used in reports and to locate the selection on the operator site.
 * Team names make the label unambiguous where the market has sides.
 */
export function describeSelection(
  selection: MarketSelection,
  teams: { home: string; away: string },
): string {
  const { market, code } = selection;
  switch (market) {
    case "1x2":
    case "moneyline":
      if (code === "home") return `${teams.home} to win`;
      if (code === "away") return `${teams.away} to win`;
      return "Draw";
    case "double_chance":
      if (code === "home_or_draw") return `${teams.home} or Draw`;
      if (code === "away_or_draw") return `${teams.away} or Draw`;
      return `${teams.home} or ${teams.away}`;
    case "btts":
      return code === "yes" ? "Both teams to score - Yes" : "Both teams to score - No";
    case "over_under": {
      const over = parseLine(code, "over");
      if (over !== null) return `Over ${over}`;
      return `Under ${parseLine(code, "under")}`;
    }
    case "handicap": {
      const handicap = parseHandicap(code);
      if (!handicap) return code;
      const team = handicap.side === "home" ? teams.home : teams.away;
      const sign = handicap.line > 0 ? `+${handicap.line}` : String(handicap.line);
      return `${team} ${sign}`;
    }
    default:
      return code;
  }
}

export type SettlementResult = "won" | "lost" | "void" | "unknown";

/**
 * Settles a selection against a completed match.
 *
 * Returns `unknown` whenever the score is insufficient rather than guessing —
 * an unknown settlement is escalated, a wrong one silently corrupts the ledger.
 */
export function settleSelection(selection: MarketSelection, state: MatchState): SettlementResult {
  if (state.status === "postponed") return "void";
  if (!state.completed) return "unknown";

  const home = state.homeScore;
  const away = state.awayScore;
  if (home === null || away === null) return "unknown";

  const { market, code } = selection;

  switch (market) {
    case "1x2":
    case "moneyline": {
      const winner = state.winner ?? (home > away ? "home" : away > home ? "away" : "draw");
      if (market === "moneyline" && winner === "draw") return "void";
      return winner === code ? "won" : "lost";
    }

    case "double_chance": {
      const winner = state.winner ?? (home > away ? "home" : away > home ? "away" : "draw");
      const allowed: Record<string, string[]> = {
        home_or_draw: ["home", "draw"],
        away_or_draw: ["away", "draw"],
        home_or_away: ["home", "away"],
      };
      return allowed[code]?.includes(winner) ? "won" : "lost";
    }

    case "btts":
      return (home > 0 && away > 0) === (code === "yes") ? "won" : "lost";

    case "over_under": {
      const total = home + away;
      const over = parseLine(code, "over");
      if (over !== null) {
        if (total === over) return "void";
        return total > over ? "won" : "lost";
      }
      const under = parseLine(code, "under");
      if (under === null) return "unknown";
      if (total === under) return "void";
      return total < under ? "won" : "lost";
    }

    case "handicap": {
      const handicap = parseHandicap(code);
      if (!handicap) return "unknown";
      const margin =
        handicap.side === "home" ? home - away + handicap.line : away - home + handicap.line;
      if (margin === 0) return "void";
      return margin > 0 ? "won" : "lost";
    }

    default:
      return "unknown";
  }
}

/** Splits a stored `market/code` pair back into a selection. */
export function toSelection(market: string, code: string): MarketSelection | null {
  const selection = { market: market as MarketId, code };
  return isValidSelection(selection) ? selection : null;
}
