---
description: Use when reviewing a drafted bet before placement — what to re-check, how to read price drift, and when to cut the stake, switch market or reject outright.
---

# Reviewing a draft

## Check these, in this order

**Is the match still happening, at the time we think?** A postponement,
abandonment or rescheduling makes everything else irrelevant. Check first
because it is cheap and it is fatal.

**Is the thesis still true?** Read the research's `supporting` points. Each one
is a claim about the world. The ones that name a player, a lineup or a fitness
situation are the ones that decay. Search for those specifically.

**What did the price do?** `get_draft` reports the drift from the drafted price.

**Are we already exposed?** If a bet was placed on the same match or a
correlated outcome since drafting, the combined position is bigger than either
bet was sized for.

## Reading price drift

| Drift | Read |
| --- | --- |
| Drifted out (price rose) | The market likes it less than it did. Sometimes noise, sometimes news you have not found. Search before deciding it is noise. |
| Shortened (price fell) | The market agrees with us. Confirming — but the edge is smaller than the Planner sized for. |
| Shortened past our probability | The edge is gone. Reject; there is nothing left to bet on. |
| Moved sharply near kickoff | Something is known. Do not approve until you find out what. |

A price that has moved a long way against us is the single most reliable signal
in this whole procedure. Treat it as information, not as a discount.

## Cutting the stake

Cut when the thesis holds but is thinner than it was:

- A supporting point you cannot confirm, and the rest still stands
- The price shortened, so the edge is real but smaller
- Team news is partial — a lineup is out but a key fitness call is unclear

Cut to somewhere between a quarter and three quarters of the drafted stake and
say why. Do not cut to a token amount as a way of avoiding the decision: if the
bet is not worth real money, reject it.

## Moving to a safer market

Only when the direction is confirmed but the specific selection is now too fine.
The usual case is a favourite whose thesis holds but whose team news got worse:
`1x2/home` becomes `double_chance/home_draw`.

The safer market must be genuinely safer — a shorter price for a wider outcome.
Moving from `over_under/over_2.5` to `over_under/over_1.5` is safer. Moving to a
different match is not a review, it is a new bet you are not authorised to make.

## Rejecting

Reject without hesitation when:

- A player the thesis depends on is out or doubtful
- The match moved, was postponed or has already started
- The price shortened past your probability
- The research is `thin` and you could not confirm any of it
- You cannot establish what changed in the time you have

A rejection costs one opportunity. A bad approval costs the stake and several
good days undoing it.
