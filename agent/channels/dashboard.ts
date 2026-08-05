/**
 * Read-only dashboard.
 *
 * Two routes: the page itself and the JSON it polls. Nothing here can change
 * state — the dashboard is for looking at the system, and the controls live on
 * Telegram where the operator is already authenticated.
 *
 * Access is gated by `DASHBOARD_TOKEN`. When that is unset the dashboard is
 * disabled rather than public, because these pages expose bankroll and bet data.
 */

import { defineChannel, GET } from "eve/channels";

import { getConfig } from "../lib/config";
import { DASHBOARD_HTML } from "../lib/dashboard-page";
import { createLogger, errorMessage } from "../lib/logger";
import { modelSpecFor } from "../lib/model";
import { formatMoney } from "../lib/money";
import { getLatestReports, getOverview, getRecentErrors, getTodayActivity } from "../lib/overview";
import { getStore, TAB } from "../lib/sheets";
import { formatInZone } from "../lib/time";

const log = createLogger("channel:dashboard");

/** Constant-time-ish comparison so the token is not guessable by timing. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function authorise(request: Request): Response | null {
  const expected = getConfig().dashboardToken;
  if (!expected) {
    return new Response("Dashboard is disabled. Set DASHBOARD_TOKEN to enable it.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  const provided =
    url.searchParams.get("token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (!tokenMatches(provided, expected)) {
    return new Response("Not authorised.", { status: 401 });
  }
  return null;
}

export default defineChannel({
  routes: [
    GET("/dashboard", async (request) => {
      const denied = authorise(request);
      if (denied) return denied;

      return new Response(DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // The page is entirely self-contained; forbid everything external.
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          "referrer-policy": "no-referrer",
        },
      });
    }),

    GET("/dashboard/state", async (request) => {
      const denied = authorise(request);
      if (denied) return denied;

      try {
        const config = getConfig();
        const timezone = config.strategy.timezone;
        const currency = config.strategy.currency;

        const [overview, activity, reports, errors, store] = await Promise.all([
          getOverview(),
          getTodayActivity(),
          getLatestReports(12),
          getRecentErrors(8),
          getStore(),
        ]);

        const activeView = await store.list(TAB.activeBets);
        const liveScores = new Map(activeView.map((entry) => [entry.betId, entry.liveScore]));
        const at = (iso: string): string => (iso ? formatInZone(new Date(iso), timezone) : "");

        return Response.json(
          {
            status: overview.status,
            mode: overview.mode,
            operator: overview.operator,
            timezone,
            day: overview.day,
            haltReason: overview.haltReason,
            bankrollError: overview.bankrollError,
            bankrollAsOf: overview.bankrollAsOf ? at(overview.bankrollAsOf) : null,
            lastCycleAt: overview.lastCycleAt ? at(overview.lastCycleAt) : null,
            nextWakeAt: overview.nextWakeAt ? at(overview.nextWakeAt) : null,

            bankroll: overview.bankroll
              ? {
                  bankroll: formatMoney(overview.bankroll.bankroll, currency),
                  balance: formatMoney(overview.bankroll.balance, currency),
                  exposure: formatMoney(overview.bankroll.exposure, currency),
                  reserve: formatMoney(overview.bankroll.reserve, currency),
                  lockedProfit: formatMoney(overview.bankroll.lockedProfit, currency),
                  available: formatMoney(overview.bankroll.available, currency),
                }
              : null,

            today: {
              profit: formatMoney(activity.profit, currency),
              profitValue: activity.profit,
              staked: formatMoney(activity.staked, currency),
              returned: formatMoney(activity.returned, currency),
              settledCount: activity.settlements.length,
            },

            objective: overview.dailyObjective
              ? {
                  target: formatMoney(overview.dailyObjective.targetProfit, currency),
                  expectedBets: overview.dailyObjective.expectedBets,
                }
              : null,

            // The spec, not a resolved client: this must never reveal a key.
            agents: [
              { name: "orchestrator", model: modelSpecFor("CONTROL") },
              { name: "research", model: modelSpecFor("RESEARCH") },
              { name: "planner", model: modelSpecFor("PLANNER") },
              { name: "reviewer", model: modelSpecFor("REVIEWER") },
              { name: "execution", model: modelSpecFor("EXECUTION") },
              { name: "watcher", model: modelSpecFor("WATCHER") },
            ],

            activeBets: overview.openBets.map((bet) => ({
              match: bet.matchName,
              selection: `${bet.market} / ${bet.selection}`,
              odds: bet.odds,
              stake: formatMoney(bet.stake, currency),
              potentialReturn: formatMoney(bet.potentialReturn, currency),
              liveScore: liveScores.get(bet.id) ?? "",
              status: bet.status,
            })),

            drafts: overview.liveDrafts.map((draft) => ({
              match: draft.matchName,
              kickoff: at(draft.startsAt),
              selection: `${draft.market} / ${draft.selection}`,
              odds: draft.odds,
              stake: formatMoney(draft.stake, currency),
              reviewAt: at(draft.executeAfter),
              status: draft.status,
            })),

            settlements: activity.settlements.map((entry) => ({
              match: entry.matchName,
              selection: `${entry.market} / ${entry.selection}`,
              result: entry.result,
              finalScore: entry.finalScore,
              stake: formatMoney(entry.stake, currency),
              returned: formatMoney(entry.returned, currency),
              profit: formatMoney(entry.profit, currency),
            })),

            research: activity.research.map((entry) => ({
              match: entry.matchName,
              sport: entry.sport,
              kickoff: at(entry.startsAt),
              confidence: entry.confidence.toFixed(2),
              summary: entry.summary.slice(0, 220),
            })),

            reports: reports.map((entry) => ({
              at: at(entry.createdAt),
              kind: entry.kind,
              title: entry.title,
              delivered: entry.delivered,
            })),

            errors: errors.map((entry) => ({
              at: at(entry.createdAt),
              scope: entry.scope,
              message: entry.message,
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        log.error("dashboard state failed", { error: errorMessage(error) });
        return Response.json({ error: errorMessage(error) }, { status: 500 });
      }
    }),
  ],
});
