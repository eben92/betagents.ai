---
description: Use when placing an approved bet — the exact order of operations, what the claim guarantees, and how to report each possible outcome.
---

# Placing a bet

This is the only irreversible thing the system does. Follow the order.

## The order

**1. Claim it.** `claim_bet` with the approved id. It returns the instruction:
match, market, selection, stake and the minimum acceptable price.

If it comes back already claimed, **stop**. Someone or something already
attempted this bet. Report what the claim says about it and do nothing else. Do
not investigate by placing it again.

**2. Find the event.** `browse` to search the site for the match, then open it.
Confirm it is the right fixture — the same two teams, the same date. A same-name
fixture in a different competition is a different bet.

**3. Find the selection.** Locate the market from the instruction and the exact
selection within it. `snapshot` shows you what is on the page. Click the
selection so it enters the betslip.

If the market is not offered, or the selection is unavailable or suspended,
stop. Report it as `rejected` with that reason. Do not substitute a similar
market — you are not authorised to choose one.

**4. Check the price before you commit.** Compare the price on the betslip with
the minimum in the instruction. If it is lower, stop and report `rejected` with
both numbers. The review approved a bet at that price; below it, the bet no
longer has the edge it was approved for.

**5. Place it.** `place_bet` with the approved id. It enters the stake, verifies
the field took the value, re-checks the price and submits.

**6. Release the browser.** `release_browser`, then report.

**7. Report the outcome.** Exactly one of:

| Outcome | Means |
| --- | --- |
| `placed` | Confirmed, with a reference from the operator |
| `rejected` | Refused before anything was submitted; no money moved |
| `unknown` | Submitted, but the result could not be confirmed |
| `needs_human` | A protection challenge stopped it |

## What the claim guarantees

The claim row is written before anything touches the site and is keyed so a
second one cannot exist. That is what makes duplicate placement impossible — not
your care, not a check you remember to do.

It only works if you claim first, every time. A claim taken after a submission
guarantees nothing at all.

## When the outcome is unknown

This is the case the whole design is built around. The bet may exist. It may
not. You cannot tell, and neither can anyone else without looking at the
operator's own records.

Do exactly this: report `unknown`, and stop. Reconciliation will search the bet
history. Do not go looking yourself in the same breath — the page state you are
in is the one that just confused you.

## Reconciling

When sent to reconcile, `browse` to the bet history and look for a bet matching
the match, selection and stake, placed around the time of the attempt. Then call
`reconcile_bet` with what you found.

Found means the bet exists and becomes a real placed bet. Not found means the
claim is released and the bet may be attempted again later. Say which, and be
sure — this is the one moment where a wrong answer produces either a lost bet or
a double bet.

If the history has not loaded, is empty, or you cannot read it, say that instead
of guessing. An unresolved claim is safe; a wrong one is not.
