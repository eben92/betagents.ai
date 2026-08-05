/**
 * The dashboard page.
 *
 * One self-contained HTML string: no build step, no bundle, no external
 * requests. It polls the JSON route beside it and re-renders. Layout is a
 * responsive grid so it is usable on a phone, which is where an operator
 * actually checks on a system like this.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Betting system</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card: #ffffff;
    --line: #e3e6ea;
    --text: #14181d;
    --muted: #667080;
    --good: #0f7a3d;
    --bad: #b3261e;
    --warn: #9a6200;
    --accent: #2d5bd7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216;
      --card: #171b21;
      --line: #262c35;
      --text: #e8ecf1;
      --muted: #97a2b2;
      --good: #4ade80;
      --bad: #f87171;
      --warn: #fbbf24;
      --accent: #7aa2ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 16px;
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; }
  .pill {
    font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .pill.running { color: var(--good); border-color: currentColor; }
  .pill.paused { color: var(--warn); border-color: currentColor; }
  .pill.stopped { color: var(--bad); border-color: currentColor; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px;
  }
  .card h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 10px; font-weight: 650;
  }
  .stat { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; }
  .stat span:first-child { color: var(--muted); }
  .stat span:last-child { font-variant-numeric: tabular-nums; text-align: right; }
  .big { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .good { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .wide { grid-column: 1 / -1; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 520px; }
  th, td { text-align: left; padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
  .empty { color: var(--muted); font-style: italic; padding: 6px 0; }
  .banner {
    border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; font-size: 14px;
    border: 1px solid currentColor;
  }
  .banner.bad { color: var(--bad); } .banner.warn { color: var(--warn); }
  footer { color: var(--muted); font-size: 12px; margin-top: 16px; }
  .agents { display: flex; flex-wrap: wrap; gap: 6px; }
  .agent { font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; color: var(--muted); }
  .agent b { color: var(--text); font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>Betting system</h1>
  <span class="pill" id="status">loading</span>
  <span class="pill" id="mode"></span>
  <span class="pill" id="operator"></span>
</header>

<div id="banners"></div>

<div class="grid">
  <div class="card">
    <h2>Bankroll</h2>
    <div class="big" id="bankroll">—</div>
    <div class="stat"><span>Balance</span><span id="balance">—</span></div>
    <div class="stat"><span>On open bets</span><span id="exposure">—</span></div>
    <div class="stat"><span>Protected reserve</span><span id="reserve">—</span></div>
    <div class="stat"><span>Locked profit</span><span id="locked">—</span></div>
    <div class="stat"><span>Available to stake</span><span id="available">—</span></div>
  </div>

  <div class="card">
    <h2>Today</h2>
    <div class="big" id="profit">—</div>
    <div class="stat"><span>Bets settled</span><span id="settledCount">—</span></div>
    <div class="stat"><span>Staked</span><span id="staked">—</span></div>
    <div class="stat"><span>Returned</span><span id="returned">—</span></div>
    <div class="stat"><span>Objective</span><span id="objective">—</span></div>
  </div>

  <div class="card">
    <h2>Cycle</h2>
    <div class="stat"><span>Last cycle</span><span id="lastCycle">—</span></div>
    <div class="stat"><span>Next wake-up</span><span id="nextWake">—</span></div>
    <div class="stat"><span>Open bets</span><span id="openCount">—</span></div>
    <div class="stat"><span>Live drafts</span><span id="draftCount">—</span></div>
    <h2 style="margin-top:14px">Agents</h2>
    <div class="agents" id="agents"></div>
  </div>

  <div class="card wide">
    <h2>Active bets</h2>
    <div class="scroll"><table id="activeTable"></table></div>
  </div>

  <div class="card wide">
    <h2>Drafted bets</h2>
    <div class="scroll"><table id="draftTable"></table></div>
  </div>

  <div class="card wide">
    <h2>Settlements today</h2>
    <div class="scroll"><table id="settleTable"></table></div>
  </div>

  <div class="card wide">
    <h2>Research</h2>
    <div class="scroll"><table id="researchTable"></table></div>
  </div>

  <div class="card wide">
    <h2>Recent reports</h2>
    <div class="scroll"><table id="reportTable"></table></div>
  </div>

  <div class="card wide">
    <h2>Unresolved errors</h2>
    <div class="scroll"><table id="errorTable"></table></div>
  </div>
</div>

<footer id="footer">Refreshing every 20 seconds.</footer>

<script>
  var token = new URLSearchParams(location.search).get("token") || "";

  function text(value) {
    return String(value === null || value === undefined || value === "" ? "—" : value);
  }
  function set(id, value, className) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text(value);
    if (className !== undefined) el.className = className;
  }
  function signClass(value) {
    if (typeof value !== "number" || value === 0) return "";
    return value > 0 ? "good" : "bad";
  }
  function table(id, columns, rows, numeric) {
    var el = document.getElementById(id);
    if (!rows || rows.length === 0) {
      el.outerHTML = '<table id="' + id + '"><tr><td class="empty">Nothing yet.</td></tr></table>';
      return;
    }
    var head = "<tr>" + columns.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr>";
    var body = rows.map(function (row) {
      return "<tr>" + row.map(function (cell, index) {
        var cls = numeric && numeric.indexOf(index) !== -1 ? ' class="num"' : "";
        var div = document.createElement("div");
        div.textContent = text(cell);
        return "<td" + cls + ">" + div.innerHTML + "</td>";
      }).join("") + "</tr>";
    }).join("");
    el.outerHTML = '<table id="' + id + '">' + head + body + "</table>";
  }

  function render(d) {
    set("status", d.status, "pill " + d.status);
    set("mode", d.mode === "mock" ? "mock mode" : "live", "pill");
    set("operator", d.operator, "pill");

    var banners = "";
    if (d.mode === "mock") {
      banners += '<div class="banner warn">Mock mode — no real money is at stake.</div>';
    }
    if (d.haltReason) {
      banners += '<div class="banner warn">Not placing new bets: ' + text(d.haltReason) + "</div>";
    }
    if (d.bankrollError) {
      banners += '<div class="banner bad">No bankroll figure: ' + text(d.bankrollError) + "</div>";
    } else if (d.bankrollAsOf) {
      // The balance is whatever was last read from the operator, not live.
      banners += '<div class="banner">Balance as of ' + text(d.bankrollAsOf) + "</div>";
    }
    document.getElementById("banners").innerHTML = banners;

    var b = d.bankroll;
    set("bankroll", b ? b.bankroll : "—");
    set("balance", b ? b.balance : "—");
    set("exposure", b ? b.exposure : "—");
    set("reserve", b ? b.reserve : "—");
    set("locked", b ? b.lockedProfit : "—");
    set("available", b ? b.available : "—");

    set("profit", d.today.profit, "big " + signClass(d.today.profitValue));
    set("settledCount", d.today.settledCount);
    set("staked", d.today.staked);
    set("returned", d.today.returned);
    set("objective", d.objective ? d.objective.target + " / ~" + d.objective.expectedBets + " bets" : "not set");

    set("lastCycle", d.lastCycleAt);
    set("nextWake", d.nextWakeAt);
    set("openCount", d.activeBets.length);
    set("draftCount", d.drafts.length);

    document.getElementById("agents").innerHTML = d.agents.map(function (a) {
      return '<span class="agent"><b>' + a.name + "</b> · " + a.model + "</span>";
    }).join("");

    table("activeTable",
      ["Match", "Selection", "Odds", "Stake", "To return", "Score", "Status"],
      d.activeBets.map(function (r) {
        return [r.match, r.selection, r.odds, r.stake, r.potentialReturn, r.liveScore, r.status];
      }), [2, 3, 4]);

    table("draftTable",
      ["Match", "Kickoff", "Selection", "Odds", "Stake", "Review at", "Status"],
      d.drafts.map(function (r) {
        return [r.match, r.kickoff, r.selection, r.odds, r.stake, r.reviewAt, r.status];
      }), [3, 4]);

    table("settleTable",
      ["Match", "Selection", "Result", "Score", "Stake", "Return", "Profit"],
      d.settlements.map(function (r) {
        return [r.match, r.selection, r.result, r.finalScore, r.stake, r.returned, r.profit];
      }), [4, 5, 6]);

    table("researchTable",
      ["Match", "Sport", "Kickoff", "Confidence", "Summary"],
      d.research.map(function (r) {
        return [r.match, r.sport, r.kickoff, r.confidence, r.summary];
      }), [3]);

    table("reportTable",
      ["When", "Kind", "Title", "Sent"],
      d.reports.map(function (r) {
        return [r.at, r.kind, r.title, r.delivered ? "yes" : "no"];
      }));

    table("errorTable",
      ["When", "Scope", "Message"],
      d.errors.map(function (r) { return [r.at, r.scope, r.message]; }));

    document.getElementById("footer").textContent =
      "Updated " + new Date().toLocaleTimeString() + " · timezone " + d.timezone + " · refreshing every 20s";
  }

  function load() {
    fetch("/dashboard/state" + (token ? "?token=" + encodeURIComponent(token) : ""), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 401) throw new Error("Not authorised. Append ?token=… to the URL.");
        if (!r.ok) throw new Error("Request failed: " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function (error) {
        document.getElementById("banners").innerHTML =
          '<div class="banner bad">' + text(error.message) + "</div>";
      });
  }

  load();
  setInterval(load, 20000);
</script>
</body>
</html>`;
