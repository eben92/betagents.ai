---
description: Use when deciding how much to stake — what the bankroll numbers mean, how conviction maps to a multiplier, and the situations that call for a much smaller bet or none at all.
---

# Staking

## What the bankroll numbers mean

`get_bankroll` returns these. Read them before you look at a single price.

| Field | Meaning |
| --- | --- |
| `balance` | Cash at the operator right now |
| `exposure` | Money already riding on unsettled bets |
| `bankroll` | `balance + exposure` — the whole position |
| `reserve` | A fixed fraction of the bankroll that is never stakeable |
| `lockedProfit` | Winnings withheld from the betting pool |
| `availableToStake` | `balance − reserve − lockedProfit`. **This is the only money you can use.** |

`available` is already net of everything protected. Never reason about staking a
fraction of `balance` or `bankroll` — they are larger numbers that include money
you are not allowed to touch.

## Sizing

Call `compute_stake` with your probability, the operator's price, the research
confidence, and a conviction multiplier. It applies fractional Kelly, scales for
confidence and for how many more bets you expect today, and caps the result.

You supply **conviction**, a number from 0 to 1. It only ever scales the stake
down.

| Conviction | When |
| --- | --- |
| 0.8 – 1.0 | Confirmed lineups, a concrete reason the price is wrong, strong research |
| 0.4 – 0.7 | A real edge but incomplete information, or a price that has already moved toward you |
| 0.1 – 0.3 | Worth a token position; you mostly want to be on it |
| 0 | Do not bet |

Use the low end freely. Most bets that feel like 0.9 are 0.5.

`compute_stake` can return a zero stake with a reason — a thin edge, low
confidence, a halted book. That is an answer, not an error. Do not try to route
around it by re-calling with different numbers; if you disagree, say so in your
report and move on.

## Spreading across the day

Tell `compute_stake` how many more bets you expect today via
`remainingOpportunities`. Simultaneous bets share one bankroll, so each is sized
down accordingly. Be honest about this number — inflating it starves good bets,
deflating it overstakes them.

## Bet smaller, or not at all, when

- The price moved **against** you since research. The market saw something you did not.
- Your probability is far from the implied probability and the research is `thin`.
- The match is far out and the selection depends on a lineup you do not have.
- You are already exposed on the same match, the same competition, or a
  correlated outcome.
- The day has been bad. Do not size up to recover — that is how a bad day
  becomes a bad month.

## Never

- Do not stake to reach the daily objective.
- Do not increase a stake because the last bet lost.
- Do not stake anything the bankroll rules declined.
