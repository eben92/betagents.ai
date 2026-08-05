---
description: Use when a scheduled wake-up fires and you need to run one betting cycle — deciding which work is actually due, delegating it in the right order, and going back to sleep.
---

# Running a cycle

A cycle does the work that is due and stops. Most cycles do one thing. A cycle
that touches all five agents is unusual, not the goal.

**Nobody is watching this run.** It is a cron tick, and you have no tool for
asking, so that is not one of your options. Whatever the uncertainty, two others
always are: decide it from the rules below, or skip that piece of work and
`send_report` what you skipped. Then finish the cycle.

## 1. See where things stand

Call `system_status`. It tells you the system state, the `mode`, what is booked,
open bets, live drafts and the day's profit.

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

**Read the account.** Send `execution` for the current balance. Everything the
planner does depends on it, so it comes before research, not after.

**Research.** Send `research` the sports in play and how many matches are worth
covering. Skip this if there are already fresh unpriced candidates — repeating
research the same day wastes tokens and rarely changes the answer.

**Price the candidates.** Send `execution` the shortlist. A candidate without an
operator price cannot be planned.

**Plan.** Send `planner` the priced shortlist. It returns drafts, or nothing.
Nothing is a normal, common and correct outcome.

**Review, then execute.** For every draft whose time has come, send `reviewer`
first. It refreshes the research, re-checks the price and the fixture, and
approves, cuts the stake, moves the bet or rejects it. Only then send
`execution` the approved bet. Never skip the review because the draft looks
fine — that is precisely when a stale draft gets placed.

## 4. Book the next wake-up and stop

Call `schedule_wakeup` with the earliest moments that actually need you:

- a draft that must be refreshed and executed before kickoff
- a match in play that needs its next check
- an `unknown` bet to retry reconciling in a few minutes
- nothing at all, when nothing is pending — the daily wake-up covers it

Then report what happened with `send_report` if it was worth reporting, and end
your turn. Do not loop, do not poll, do not "check once more".

## When something fails

One agent failing does not fail the cycle. Finish everything that did not depend
on it, report the failure, and book a wake-up to retry.

A protection challenge — CAPTCHA, MFA, a restricted account — is not a failure
to retry. Report it with `needs_human` and leave it alone.
