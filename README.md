# betagents

An autonomous sports betting system: it researches real fixtures, prices them at
a bookmaker, sizes and reviews a bet, places it through a browser, watches the
match, settles it, and reports everything to Telegram. All state lives in a
Google Sheet.

It runs as an [eve](https://eve.dev) agent — one Node process, no database, no
cloud-specific services.

> **Read this first.** Automated stake placement almost certainly breaches the
> terms of service of SportyBet, Betway and most other bookmakers, which can mean
> a closed account and forfeited funds. No research pipeline reliably beats a
> bookmaker's margin; expect the expected value to be negative over time. The
> system ships in mock mode and stays there until you deliberately change it.

---

## How it works

Nothing runs continuously. A schedule ticks once a minute and almost always does
nothing — it answers "is any work due?" from memory. When work *is* due it runs
one **cycle**, which inspects the world, does what is due, books its own next
wake-up, and exits.

A cycle, in order — skipping whatever is not due:

1. **Reconcile** any bet whose outcome is unknown, against the operator's own bet history.
2. **Watch and settle** open bets.
3. **Read the balance** and compute the bankroll position.
4. **Research** new fixtures, then **price** the candidates at the operator.
5. **Plan** stakes and draft bets — if there is room and appetite.
6. **Review** drafts whose execution window has opened, then place the approved ones.
7. **Schedule** the next wake-up and stop.

### The six agents

A root orchestrator delegates to five specialists. Each has its own
instructions, its own skills, its own tools, and its own model.

| Agent | Model env var | What it does | Browser |
| --- | --- | --- | --- |
| Orchestrator | `MODEL_CONTROL` | Decides which specialist runs, in what order; also the Telegram interface | no |
| Research | `MODEL_RESEARCH` | Finds fixtures, gathers evidence from free public sources, estimates probabilities | no |
| Picker & Planner | `MODEL_PLANNER` | Chooses what to back, with what conviction, now or later | no |
| Reviewer | `MODEL_REVIEWER` | Re-checks a draft against refreshed research and the current price | no |
| Account & Execution | `MODEL_EXECUTION` | Owns the account: login, balance, prices, placement, bet history | **yes** |
| Match Watcher | `MODEL_WATCHER` | Follows matches with open bets and settles them | no |

### Choosing models

One variable per agent, written `provider:model-id`. Providers mix freely:

```bash
MODEL_PLANNER=anthropic:claude-opus-4-5
MODEL_RESEARCH=deepseek:deepseek-reasoner
MODEL_WATCHER=google:gemini-2.0-flash
MODEL_EXECUTION=openai:gpt-5
```

`anthropic`, `openai`, `google` and `deepseek` are wired directly and read
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` and
`DEEPSEEK_API_KEY`. **Any other name** is treated as an OpenAI-compatible
endpoint described by two more variables — which covers Kimi, Groq, OpenRouter,
Together, Fireworks and a self-hosted vLLM without touching the code:

```bash
MODEL_REVIEWER=kimi:kimi-k2-0905-preview
KIMI_BASE_URL=https://api.moonshot.ai/v1
KIMI_API_KEY=...
```

Nothing routes through a hosted gateway; each provider is called directly with
its own key. Resolution lives in
[`agent/lib/model.ts`](agent/lib/model.ts) and is the only place that knows a
provider exists.

### Context windows are declared, not looked up

Each agent's context window is declared in `lib/model.ts` alongside its
provider. This is not optional bookkeeping: given a direct provider model, eve
otherwise resolves the window by querying the **Vercel AI Gateway catalogue over
the network**, and fails the build outright for any model not in it — which is
every model reached through an OpenAI-compatible endpoint. Declaring them is
what makes the build offline, reproducible and genuinely gateway-free.

Two things follow automatically from the declared window:

- **Compaction fires earlier on a smaller model.** 60% for a 64K window, 85% for
  a million. The fixed cost of instructions, skills and tool schemas is the same
  either way, so it eats a much larger share of a small window, and what is left
  must still absorb a whole tool result at once.
- **Tool output is capped proportionally.** A page read is truncated to about an
  eighth of the window, so one long betting page cannot consume the headroom a
  64K model needs to finish placing the bet.

DeepSeek's own models differ sharply — `deepseek-v4-flash` is a 1M-token model
while `deepseek-chat` and `deepseek-reasoner` are 128K — so they are sized
individually rather than lumped together. An unrecognised `deepseek:*` id falls
back to 64K, and an unrecognised model from any provider to 32K. Wrong-low costs
an early compaction; wrong-high overflows mid-cycle and loses the bet in flight.

Override any of it without touching code:

```bash
MODEL_RESEARCH=deepseek:deepseek-chat
MODEL_RESEARCH_CONTEXT=128000
```

`provider/model-id` is accepted as well as `provider:model-id`, since that is
how model ids are written nearly everywhere else. A colon wins when both appear,
so `openrouter:qwen/qwen-2.5-72b-instruct` keeps the slash in its model id.

### Each agent has its own workspace

Every agent gets a sandbox — a persistent `/workspace` with `bash`,
`read_file`, `write_file`, `glob` and `grep` — and each one is told to use it as
a notebook: Research writes per-match notes and re-reads them before committing
an assessment, the Planner lays the day out in one file before sizing anything,
the Reviewer keeps a checklist per draft, the Watcher keeps last-seen scores so
it can answer *what changed*, and Execution keeps a placement journal so a lost
page never becomes a guess about whether it already pressed the button.

Only Execution needs real binaries, so it runs a microsandbox VM. The other five
are pinned to `justbash` — a real filesystem with no daemon and no container, so
five agents cost a small VPS nothing. Both are one-line definitions; see
[`agent/lib/notebook-sandbox.ts`](agent/lib/notebook-sandbox.ts).

### Keeping the browser from leaking or hanging

The VM is the only heavyweight thing in the system, and Chromium inside it is
what actually costs memory. Three mechanisms keep that bounded:

- **Explicit release.** The Execution agent calls `release_browser` as its final
  step, before reporting back — required by its instructions and by the
  `placing-a-bet` skill, including when the work failed.
- **An idle close.** The browser shuts itself after `BROWSER_IDLE_CLOSE_MS`
  (3 minutes) without a command, so a forgotten release costs minutes rather
  than the rest of the session.
- **A deadline on every command.** `BROWSER_COMMAND_TIMEOUT_MS` (2 minutes)
  bounds every browser call. A wedged VM fails one tool call instead of hanging
  the agent, the cycle, and the wake-up the cycle was supposed to book.

If the sandbox is replaced under a running session — it crashed, the host
restarted — the next command notices agent-browser is missing, reinstalls it and
**retries exactly once**. Once, not in a loop: this path is one step from
placing money, and a command that fails twice is a real failure that should be
reported rather than hammered.

One limitation worth stating plainly: eve keys a sandbox to a durable session
and exposes no API for authored code to stop one, so the VM itself is reclaimed
by the framework at session end or server shutdown, not the moment an agent
finishes. Releasing the browser inside it is the lever that exists, and it is
the one that accounts for nearly all the memory.

### How many VMs a host ends up with

The two levers that decide this are both in
[`agent/agent.ts`](agent/agent.ts), and eve's defaults are wrong for a system
that runs on a schedule forever.

`experimental.subagentPersistentSessions: true` reuses each specialist's session
across delegations. Unset — eve's default — *"delegated children run as one-shot
tasks"*: one cycle asks Execution for a balance, then for prices, then to place a
bet, and that is three sessions and three separate VMs. Reuse is also the better
behaviour, since Execution keeps its logged-in browser and its placement journal
between delegations instead of starting over.

`limits.sessionTimeoutMs` is 24 hours here, down from eve's 30-day default. A
sandbox lives as long as its session, so this is the ceiling on how long a VM can
sit on the host. Nothing of record is lost when a session ends: the spreadsheet
is the state, and `/workspace` only ever holds a working notebook.

With both set, a full three-eval run holds **three** VMs. Note that a killed
process — `kill -9`, a crash, a closed laptop — never reaches eve's shutdown
path, so it strands VMs that nothing later reclaims. `msb list` shows them and
`msb rm -f` clears them.

Orchestration is model-driven; the **irreversible steps are not**. Every
decision that moves money lives in a tool, in ordinary TypeScript:

- **A model never names a stake.** The Planner supplies a conviction between 0
  and 1; `lib/bankroll.ts` computes the amount under the bankroll rules. A model
  can only ever scale a stake *down*, and a review can only ever cut one.
- **A model never settles a bet.** Settlement is computed from the final score
  against a fixed market vocabulary (`lib/markets.ts`).
- **A model cannot place an unclaimed bet.** `place_bet` refuses without a claim
  row, and the claim is unique per approved bet.
- **A model never sees a credential.** `operator_login` reads them from the
  environment and hands them to the browser; nothing returns them.

### Money protection

```
bankroll   = operator balance + stakes on open bets
reserve    = bankroll × BANKROLL_RESERVE_FRACTION     (never stakeable)
locked     = accumulated (1 − PROFIT_RELEASE_FRACTION) × each win
available  = balance − reserve − locked
```

Each stake is fractional Kelly, scaled by research confidence, by the Planner's
conviction, and by how many more bets it expects today — then capped at
`MAX_STAKE_FRACTION` of what is available. Trading halts for the day on the
daily loss limit, a losing streak, or the open-bet cap.

### Never placing the same bet twice

Before any browser work, a row is written to the `bets` tab with an
`idempotencyKey` derived from the approval id. The store rejects a second row
with that key. So:

- A replayed cycle finds the claim and does nothing.
- A crash mid-placement leaves a claim behind; the next cycle **reconciles** it
  against the operator's bet history rather than placing again.
- A submission whose result is unknown is *never* retried blindly. It stays
  `unknown` until the operator's history confirms it landed or enough time
  passes to conclude it did not.

### Things it will not do

CAPTCHA, two-factor prompts and account restrictions stop the run and escalate
to you on Telegram. The system is built to wait for a person, not to get past
the check. That is enforced in two places: the Execution agent's
`handling-blockers` skill tells it to stop and never look for another route, and
`assertNoBlockers` throws before any page interaction regardless of what the
model decides.

---

## Run it locally

```bash
npm install
cp .env.example .env.local     # in mock mode you only need one provider key
npm run dev
```

That starts the dev server and the terminal UI. `eve dev` never fires schedules,
so trigger a cycle by hand:

```bash
curl -X POST http://localhost:2000/eve/v1/dev/schedules/tick
```

With no Google credentials the system uses an in-memory store and tells you so.
That is fine for a first look; nothing persists across restarts.

### Tests

Two layers, because two different things can be wrong.

```bash
npm test        # 73 tests, no network, no model spend
npm run check   # typecheck + tests
```

The offline suite drives the **real tools** — the same ones the agents call, in
the order an agent would call them — against the simulated bookmaker and a
scripted score feed. It covers research, pricing, staking, review, placement,
duplicate prevention, reconciliation, monitoring, settlement, accounting,
restart recovery and credential redaction. Every step that moves money is in
here, and none of it needs a model.

```bash
npm run eval    # needs a provider key; costs model spend
```

The evals cover what the offline suite structurally cannot: whether the
orchestrator delegates in the right order, refuses to skip a review, and stops
when told to. They run against the simulated bookmaker, so they cannot move real
money either.

The judge borrows `MODEL_CONTROL` unless `MODEL_JUDGE` names something else, so
running them needs one provider key rather than two.

Delete `.eve/` between runs when you have changed a sandbox definition. eve keeps
a source snapshot per build, and a stale one will happily bootstrap a second VM
from the code you just replaced, alongside the new one.

---

## Self-host on a VPS

A small box is enough (1 vCPU / 1 GB for mock and API-only work; 2 GB if you run
Chromium locally).

```bash
git clone <your repo> && cd betagents.ai
npm ci
cp .env.example .env.local && $EDITOR .env.local

npm run build
PORT=3000 npm start -- --host 0.0.0.0
```

`eve start` serves the built output **and starts the schedule runner**, which is
what makes the system autonomous. Run it under systemd, Docker, or whatever you
already use.

Behind a reverse proxy, forward all three prefixes without rewriting them:

- `/eve/` — sessions, the Telegram webhook, health
- `/.well-known/workflow/` — workflow callbacks (sessions stall without it)
- `/dashboard` — the dashboard and its JSON route

Workflow state is written to `.eve/.workflow-data`. Put it on persistent storage
so runs survive a container replacement.

For live betting the Execution agent needs a browser VM. It runs
[agent-browser](https://agent-browser.dev) inside
[microsandbox](https://microsandbox.dev), which requires **Linux with KVM** or
macOS on Apple Silicon. Install microsandbox on the host; the VM image, Chromium
and agent-browser are provisioned automatically on first use and cached against
what was installed.

The browser is **Playwright's Chromium**, not the Chrome for Testing build
agent-browser vendors by default. Chrome for Testing publishes no Linux ARM64
build, and a microsandbox VM on Apple Silicon is Linux ARM64, so the stock
bootstrap cannot work on a Mac at all. Playwright publishes both architectures,
which also means development and the server run the same browser rather than two.
See [`agent/subagents/execution/sandbox.ts`](agent/subagents/execution/sandbox.ts).

Keep the microsandbox npm package and the installed `msb` runtime on the **same
version**. They share a database, and a mismatch fails every sandbox with
`Migration file of version ... is missing`. Check with `msb --version`.

Mock mode needs none of this — no browser, no VM, no KVM.

### Node

**Node 24.19.0 or newer**, pinned in `.nvmrc`. Not a preference: 24.18.0 carries
a V8 bug that aborts the process outright —
`Check failed: static_cast<int64_t>(amount_before) >= -delta` in
`Heap::OldArrayBufferBytes` — which killed long agent runs mid-cycle.

---

## Configure Google Sheets

1. Create a spreadsheet. Its id is the long string in the URL between `/d/` and `/edit`.
2. In Google Cloud: create a project, enable the **Google Sheets API**, create a
   **service account**, and add a **JSON key**.
3. Share the spreadsheet with the service account's email address, as **Editor**.
4. Set `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
   `GOOGLE_PRIVATE_KEY` (the whole PEM block; literal `\n` escapes are fine).

### Where the credentials come from

Step 2 produces the JSON key file. Three of its fields become environment
variables — the rest are unused:

```json
{
  "client_email": "betagents@your-project.iam.gserviceaccount.com",  ← GOOGLE_SERVICE_ACCOUNT_EMAIL
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"  ← GOOGLE_PRIVATE_KEY
}
```

`GOOGLE_SHEETS_SPREADSHEET_ID` is not in that file — it comes from the
spreadsheet URL:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit#gid=0
                                       └── this ──┘
```

Paste `private_key` exactly as it appears, `\n` escapes and all. Keep the JSON
file out of the repository; `.env.local` is already ignored.

If sharing failed, every read returns a 403 — the service account is a separate
identity from your Google account and cannot see the sheet until you share it.

### The tabs

All 14 are created with their headers on first run, so an empty spreadsheet is a
valid starting point. To start from one that is already correct:

```bash
npm run spreadsheet          # writes betagents-spreadsheet.xlsx
```

That is **one file with every tab in it**. In Google Sheets:

> **File → Import → Upload**, pick the `.xlsx`, choose **Replace spreadsheet**.

All 14 tabs arrive together with their headers, frozen and filtered, plus a
`_readme` tab documenting every column and its type. Delete `_readme` if you
like — the app ignores tabs it does not own.

To check a workbook you generated earlier still matches the code:

```bash
npm run spreadsheet:verify
```

Column order is the wire format: columns are matched by name, so appending one
is safe and reordering is not. Four uniqueness keys carry real guarantees —
`bets.idempotencyKey` prevents duplicate placement, `approved.draftId` prevents
double approval, `settlements.betId` prevents double-counting a result, and
`research.matchKey` keeps one row per match. Do not remove them.

---

## Configure Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather); keep the token.
2. Get your numeric user id from [@userinfobot](https://t.me/userinfobot).
3. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` and
   a `TELEGRAM_WEBHOOK_SECRET_TOKEN` of your choosing.
4. Point Telegram at your deployment:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-host/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

**`TELEGRAM_ALLOWED_USER_IDS` is the authorisation boundary for the whole
system.** An empty list denies everyone, deliberately.

`TELEGRAM_CHAT_ID` is where **reports go**, and it may be a channel. It is not
where commands must come from: Telegram delivers channel posts without a sender,
and eve never dispatches them to an agent, so a channel can only ever receive.
**Command the bot in a direct message.** A group or supergroup works too, but
only the one `TELEGRAM_CHAT_ID` names, so an allowed user cannot be talked into
driving the system from a group full of strangers.

Commands: `/status`, `/balance`, `/bets`, `/drafts`, `/today`, `/reports`,
`/start`, `/stop`, `/pause`, `/resume`, and "run a cycle now". Plain questions
work too — it is an agent, not a command parser.

`pause` keeps monitoring and settling open bets but places nothing new. `stop`
halts every cycle; open bets are left alone at the operator.

---

## Configure a betting operator

There are **no per-bookmaker selectors anywhere in the codebase**. The Execution
agent finds things the way a person does — by visible label, accessible name and
role — so adding a bookmaker is configuration, not code:

```bash
OPERATOR=sportybet
OPERATOR_BASE_URL=https://www.sportybet.com/gh
OPERATOR_LOGIN_PATH=/login
OPERATOR_MY_BETS_PATH=/my-bets
OPERATOR_SEARCH_PATH="/search?query={query}"
OPERATOR_USERNAME_LABEL="Mobile Number"   # whatever the site actually shows
OPERATOR_PASSWORD_LABEL=Password
OPERATOR_LOGIN_BUTTON="Log in"
OPERATOR_LOGGED_IN_MARKER="log ?out|my account|my bets"
```

Going live, in order:

1. Run several **mock** cycles and read the Telegram reports until the behaviour
   is familiar.
2. Install microsandbox and set `BROWSER_DRIVER=sandbox`.
3. Set `OPERATOR`, `OPERATOR_BASE_URL`, credentials and the labels above, then
   confirm the login flow works — see the caveat below.
4. Fund the account with an amount you are willing to lose entirely.
5. Set `BETTING_MODE=live`.

Live mode refuses to start without a real operator, credentials, a base URL and
Google Sheets configured.

### Browser drivers

| `BROWSER_DRIVER` | What it does |
| --- | --- |
| `mock` | In-process simulated bookmaker. No browser at all. |
| `sandbox` | A real browser, driven by agent-browser inside the microsandbox VM. |

The sandbox is declared in
[`agent/subagents/execution/sandbox.ts`](agent/subagents/execution/sandbox.ts)
and nothing else references it, so swapping microsandbox for another eve sandbox
backend is a one-file change. Only the Execution agent has a browser; the
orchestrator and the other four specialists have none, which is why a Telegram
question never boots a VM.

---

## Dashboard

Set `DASHBOARD_TOKEN`, then open `https://your-host/dashboard?token=<token>`.
It is read-only, works on a phone, and shows system and agent status, bankroll,
active and drafted bets, research, settlements, reports and errors. Without the
token it is disabled, not public — these pages expose bankroll and bet data.

---

## What still needs verifying against a real bookmaker

Everything above the operator boundary is tested. **Nothing below it has been
run against a real bookmaker** — this was built without access to a live
account. Before `BETTING_MODE=live`, confirm each of these yourself:

- **The login labels.** `OPERATOR_USERNAME_LABEL` and friends default to generic
  English. SportyBet uses a phone number, not a username. If a label is wrong,
  login fails cleanly and tells you what it could not find.
- **`OPERATOR_LOGGED_IN_MARKER`.** It decides whether a session is
  authenticated. A marker that matches a signed-out page makes the system think
  it is logged in when it is not.
- **The betslip.** `placeBet` in `lib/operator/index.ts` looks for a stake field
  labelled "Stake", a "Place bet" button, and a bet reference in the receipt
  text. These are the least portable assumptions in the codebase.
- **The bet reference pattern.** The regex that reads a reference off the receipt
  is what distinguishes `placed` from `unknown`. If it never matches, every bet
  goes to reconciliation — safe, but slow and noisy.
- **The blocker patterns** in `lib/operator/browser.ts`. These are the guards
  that stop the system at a CAPTCHA or an MFA prompt. A pattern that never
  matches is a guard that never fires. Err towards adding phrases.
- **The bet-history page**, which is what reconciliation reads.

Also unverified, and worth a look:

- **ESPN league paths.** The cricket defaults in `lib/sports/espn.ts` are the
  least certain; override with `ESPN_LEAGUES_CRICKET`. A path that 404s is
  skipped silently, so check that fixtures actually appear.
- **Timing.** `EXECUTE_BEFORE_KICKOFF_MINUTES` assumes lineups are out by then.
- **Market availability.** Whether your operator offers `double_chance` and
  `btts` under those concepts at all.

One structural note: the system assumes a **single instance** owns the
spreadsheet. Sheets has no transactions. The in-process cycle lock and its
persisted lease cover restarts, and the `idempotencyKey` guard makes duplicate
placement impossible regardless — but do not run two copies against one sheet.

---

## All settings

`.env.example` carries only what you have to think about. Everything below has a
working default and is listed here so you never need to read `config.ts` to find
a knob.

### Strategy

| Variable | Default | What it does |
| --- | --- | --- |
| `BANKROLL_RESERVE_FRACTION` | `0.4` | Fraction of bankroll that may never be staked |
| `PROFIT_RELEASE_FRACTION` | `0.5` | Share of each win returned to the betting pool; the rest locks away |
| `MAX_STAKE_FRACTION` | `0.15` | Hard cap on one stake, as a fraction of what is available |
| `KELLY_MULTIPLIER` | `0.25` | Fractional Kelly. 1 is full Kelly; lower is safer |
| `MIN_STAKE` | `5` | Below this a bet is not worth placing |
| `MIN_EDGE` | `0.05` | Minimum modelled edge before a bet is considered |
| `MIN_CONFIDENCE` | `0.6` | Minimum research confidence |
| `MAX_ACTIVE_BETS` | `5` | Open-bet cap; halts new bets when reached |
| `MAX_DAILY_LOSS_FRACTION` | `0.2` | Trading stops for the day at this realised loss |
| `LOSS_STREAK_COOLDOWN` | `3` | Consecutive losses that trigger a cooldown until tomorrow |

`BANKROLL_RESERVE_FRACTION + MAX_STAKE_FRACTION` must stay below 1, or startup
fails — otherwise a single stake could reach into the reserve.

### Scope and timing

| Variable | Default | What it does |
| --- | --- | --- |
| `SPORTS` | all four | Any of `football,basketball,cricket,tennis` |
| `EXECUTE_BEFORE_KICKOFF_MINUTES` | `25` | How long before kickoff a draft is refreshed, reviewed and placed |
| `MIN_MINUTES_TO_KICKOFF` | `20` | Matches starting sooner than this are ignored |
| `MAX_RESEARCH_MATCHES` | `6` | Caps research spend per cycle |
| `MAX_SHORTLIST` | `3` | Caps candidates carried into planning |
| `ESPN_LEAGUES_FOOTBALL` | built-in list | Which competitions to follow |
| `ESPN_LEAGUES_BASKETBALL` | built-in list | Same, per sport. Also `_CRICKET`, `_TENNIS` |

### Models

| Variable | Default | What it does |
| --- | --- | --- |
| `MODEL_<AGENT>_CONTEXT` | from `lib/model.ts` | Override a model's context window in tokens |
| `MODEL_JUDGE` | `MODEL_CONTROL` | Grades `npm run eval` only |
| `<NAME>_BASE_URL` | — | OpenAI-compatible endpoint for a provider named `<NAME>` |
| `<NAME>_API_KEY` | — | Its key. Redacted from logs automatically |

### Operator, when running live

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_DRIVER` | `sandbox` in live | `mock` or `sandbox` |
| `OPERATOR_LOGIN_PATH` | `/login` | Relative to `OPERATOR_BASE_URL` |
| `OPERATOR_MY_BETS_PATH` | `/my-bets` | Where reconciliation reads bet history |
| `OPERATOR_SEARCH_PATH` | `/search?query={query}` | `{query}` is URL-encoded in |
| `OPERATOR_USERNAME_LABEL` | `Username` | The label the site actually shows |
| `OPERATOR_PASSWORD_LABEL` | `Password` | Same |
| `OPERATOR_LOGIN_BUTTON` | `Log in` | Accessible name of the submit button |
| `OPERATOR_LOGGED_IN_MARKER` | `log ?out\|my account\|my bets` | Regex confirming a signed-in page |
| `BROWSER_COMMAND_TIMEOUT_MS` | `120000` | Deadline on every browser command |
| `BROWSER_IDLE_CLOSE_MS` | `180000` | Idle time before the browser closes itself |

### Diagnostics

| Variable | Default | What it does |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `TELEGRAM_VERBOSE` | `false` | Also send a notice when each stage starts |
| `TELEGRAM_BOT_USERNAME` | — | Without the `@`. Needed only for group chats |

---

## Layout

```
agent/
  agent.ts            root orchestrator
  instructions.md
  skills/             running-a-cycle
  channels/           telegram (control), dashboard (read-only), eve (HTTP)
  schedules/tick.ts   the only schedule; starts a cycle when work is due
  tools/              status, control, balance, bets, activity, reports, wake-ups
  subagents/
    research/         instructions, skills, list_fixtures, save_research
    planner/          instructions, skills, bankroll, candidates, staking, drafts
    reviewer/         instructions, skills, get/approve/reject a draft
    execution/        instructions, skills, sandbox.ts, login/price/claim/place/reconcile
    watcher/          instructions, skills, open bets, match state, settlement
  lib/                shared by every agent
    bankroll.ts       staking and protection
    markets.ts        market vocabulary and settlement
    operator/         browser access, simulated bookmaker, mode dispatch
    sheets/           auth, REST client, schema, typed store
    sports/           free public fixture and score providers
    telegram/         outbound reporting
evals/                agentic orchestration checks (needs a model key)
tests/                unit and pipeline suites (offline)
```

Each subagent inherits nothing from the root — its instructions, skills and
tools are its own. Everything they share goes through `agent/lib/`.
