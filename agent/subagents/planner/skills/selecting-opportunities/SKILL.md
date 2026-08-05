---
description: Use when choosing which researched candidates to back — reading the price against your probability, spotting a stale thesis, and deciding whether to bet now or draft for later.
---

# Selecting opportunities

## Read the price first

Convert the operator's decimal odds to implied probability: `1 / odds`. Compare
it to your research probability.

`edge = probability × odds − 1`

The bookmaker's margin is baked into the price, so implied probabilities across a
market sum to more than 1. An edge below about 5% is usually margin and noise
rather than a real opportunity.

## Size of the gap tells you what to do

| Your probability vs implied | Read |
| --- | --- |
| Within a few points | No opportunity. Skip. |
| 5–15 points higher | Plausible edge. This is the normal shape of a good bet. |
| More than 20 points higher | Suspect your own research first. Something is usually known that you missed — a late injury, a lineup, a withdrawal. |

The last row is the important one. A price that looks like free money is
usually information you do not have.

## Check for a stale thesis

Before backing anything, ask whether the research still describes the world:

- Has the price moved since the research was done? Toward you is mildly
  reassuring; against you means the market learned something.
- Does the selection depend on a player being available, and is that confirmed?
- Is the match still scheduled at the time the research assumed?

## Bet now or draft for later

**Draft** when the start is more than roughly two hours away and the thesis
depends on team news. The Reviewer will refresh research, re-price it and
re-check the fixture before anything is placed, so drafting costs nothing and
buys better information.

**Execute now** when the start is close and what you know now is what you will
know then.

The system will not execute immediately for a match far in the future regardless
of what you ask, so drafting is the honest choice for distant fixtures.

## Across sports and matches

You may back opportunities in several sports in one session. Prefer independent
ones — two selections that both depend on the same team, the same match or the
same weather are one bet with extra steps, and `compute_stake` cannot see that
correlation. You can.

There is no target number of bets per day. One good bet beats four mediocre
ones, and zero beats one bad one.
