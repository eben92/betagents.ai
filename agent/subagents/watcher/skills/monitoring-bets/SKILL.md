---
description: Use when monitoring matches with open bets — what counts as a meaningful event worth reporting, when to look again, and when a result is final enough to settle.
---

# Monitoring bets

## When to look again

Checking constantly costs money and tells you nothing new. Match the interval to
how fast the bet's outcome can actually change.

| Situation | Look again |
| --- | --- |
| Kickoff is more than an hour away | At kickoff |
| Match in play, bet not close to resolving | 20–30 minutes |
| Match in play, the bet is on a knife edge | 10 minutes |
| Match should have finished | 10 minutes, until a final result appears |
| No source recognises the match any more | 30 minutes, then report it |

"On a knife edge" means one event flips the bet: a total sitting exactly on the
line, a one-goal lead on a win bet, a tie-break in the deciding set.

## What is worth reporting

Report an event when it **changes whether the bet is likely to win**:

- A goal, wicket or set that puts the bet ahead or behind
- A red card, an injury to a key player, or a change that alters the game
- The total crossing the line the bet depends on
- A match suspended, abandoned or postponed after the bet was placed
- The final result and the settlement

Do not report: kickoff, half time, possession, a goal in a match where the bet
was already decided, or "still 0-0 after 20 minutes". A person reading these
should be able to trust that a message means something happened.

## When a result is final

Settle only on a genuinely finished match:

- The source reports the match as final or completed
- The score is not going to change

Not final: stoppage time, extra time, a penalty shootout in progress, an innings
still to come, a match suspended for weather, an abandoned match.

An abandoned or postponed match is not a loss. Report it and leave the bet open
— the operator decides whether it voids, and settling it yourself would be a
guess about someone else's rules.

## When sources disagree

Do not average them and do not pick the one you like. Report the disagreement
and leave the bet open. Wait and look again: one of them is usually stale, and
in twenty minutes they will agree.

## Settling

`settle_bet` works out won, lost or void from the selection and the final score
— you supply the result, not the verdict. If it returns `unknown`, the selection
could not be judged against that score. Report that rather than forcing an
answer.
