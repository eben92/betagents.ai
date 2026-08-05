---
description: Use when a scheduled wake-up fires and you need to run one betting cycle — deciding which work is actually due, delegating it in the right order, retrying over fresh fixtures when nothing was backed, and going back to sleep.
---

# Running a cycle

A cycle does the work that is due and stops. Most cycles do one thing. A cycle
that touches all five agents is unusual, not the goal.

**Nobody is watching this run.** It is a cron tick, and you have no tool for
asking, so that is not one of your options. Whatever the uncertainty, two others
always are: decide it from the rules below, or skip that piece of work and
`send_report` what you skipped. Then finish the cycle.

## 1. Open the cycle

Call `begin_cycle` with what woke you, then `system_status`.

`begin_cycle` gives you the cycle id, the pass number, and what this cycle has
already assessed — which is how a run that was interrupted continues instead of
starting the card again. Everything recorded from here is attributed to this
cycle, and that attribution is what the report and the retry decision are built
from. Nothing else works properly if you skip it.

`system_status` tells you the system state, the `mode`, what is booked, open
bets, live drafts and the day's profit.

`mode: mock` changes nothing about how you run this cycle. The card is
simulated and so is the bookmaker, which is exactly why the cycle should go all
the way to a placed bet: that is the only thing that proves the path works
before it is pointed at real money. Brief the specialists as you would on live
and do not pass on that the fixtures are simulated as a reason to skip them.

Stop immediately if:

- **stopped** — do nothing at all, book no wake-up, say nothing.
- **paused** — settle and monitor open bets only. Place nothing, draft nothing.
- **a halt reason is set** — the daily loss limit or a loss streak has tripped.
  Monitoring and settlement continue; new bets do not.

## 2. Work out what is due

Match the wake-up kind to the work. Do only what the trigger asks for.

| Trigger | Work |
| --- | --- |
| `daily` | Close out yesterday, then look for today's opportunities |
| `opportunity` | Research and planning |
| `draft_review` / `pre_match` | Refresh and execute a specific draft |
| `monitor` | Watch matches in play |
| `reconcile` | Resolve bets whose outcome is unknown |
| `manual` | Whatever the operator asked for |

Settlement of a finished match and reconciliation of an `unknown` bet are always
due, whatever woke you. Money that is unaccounted for gets dealt with first.

## 3. Do the work

Always in this order, skipping what is not due.

**Reconcile first.** Any bet in `unknown` — send `execution` to search the
operator's bet history for it. It either exists, and becomes a placed bet, or it
does not, and it is released. Nothing else runs until this is clean, because
every other step reasons about exposure.

**Settle and monitor.** Send `watcher` the open bets. It checks scores, settles
what has finished and tells you when the next check is worth making.

**Read the account and the card.** Send `execution` for two things in one brief:
the current balance, and the card for the sports in play.

The card is the point, and it is not optional. When a catalogue is configured,
`list_fixtures` returns **nothing** until the card has been read — it will not
substitute a public schedule, because researching matches the bookmaker may not
offer spends the whole budget on candidates nobody can back. If research reports
`cardStale`, you skipped this step: send `execution` to read the card, then
research again.

The card stays good for a few hours, so on a later pass this step is only the
balance.

The card may be a different site from the account that takes the bets. Reading
one is not betting on it, and nothing is ever placed anywhere but the configured
operator, against an approved record.

Both come before research, because everything downstream depends on them.

**Research.** Send `research` every sport in play, in one brief, and tell it to
come back with a named selection per match — the side it would actually back.
Its `list_fixtures` already excludes anything this cycle has assessed, so on a
later pass it sees different matches without you listing them.

**Price the candidates.** Send `execution` the shortlist. A candidate without an
operator price cannot be planned.

**Plan.** Send `planner` the priced shortlist. It returns drafts, or nothing.

**Review, then execute.** For every draft whose time has come, send `reviewer`
first. It refreshes the research, re-checks the price and the fixture, and
approves, cuts the stake, moves the bet or rejects it. Only then send
`execution` the approved bet. Never skip the review because the draft looks
fine — that is precisely when a stale draft gets placed.

## 4. Close the pass, and go round again if nothing was backed

Call `end_pass`.

A pass that backed nothing has not established that today has nothing worth
backing. It has established that about the handful of matches it looked at.
There are usually a hundred fixtures a day, and `end_pass` knows how many this
cycle has not touched.

**When it returns `retry: true`, go back to the research step and run the whole
sequence again** — research, price, plan, review, execute — on fixtures this
cycle has not seen. Do not report, do not schedule, do not stop. Then call
`end_pass` again. Up to five passes.

**When it returns `retry: false`, the cycle is over.** It stops for a reason,
and the reason is in the response: something was placed, a draft is already in
flight, the card is exhausted, the passes are used up, or trading is halted.

Zero bets after five passes over a full card is a real answer. Zero bets after
one pass over six matches is not an answer, it is a sample.

## 5. Report

Call `send_cycle_report`. It builds the operator's message from the record: what
was placed, what is waiting for kickoff, and every match that was not backed —
grouped by the agent that declined it, each with its reason.

You do not compose this report and you do not summarise it into `send_report`
instead. The rejections are the bulk of the cycle's work and the part most
easily lost, which is exactly why the tool assembles them rather than you.

## 6. Book the next wake-up and stop

Call `schedule_wakeup` with the earliest moments that actually need you:

- a draft that must be refreshed and executed before kickoff
- a match in play that needs its next check
- an `unknown` bet to retry reconciling in a few minutes
- nothing at all, when nothing is pending — the daily wake-up covers it

Then end your turn. Do not loop, do not poll, do not "check once more" — the
looping this cycle is allowed to do is the pass loop in step 4, and `end_pass`
decides that, not you.

## When something fails

One agent failing does not fail the cycle. Finish everything that did not depend
on it, report the failure, and book a wake-up to retry.

A protection challenge — CAPTCHA, MFA, a restricted account — is not a failure
to retry. Report it with `needs_human` and leave it alone.
