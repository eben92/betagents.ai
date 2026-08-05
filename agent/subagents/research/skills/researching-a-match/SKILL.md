---
description: Use when assessing a specific fixture — the evidence-gathering order, how to weigh conflicting sources, how to set confidence, and when to return no candidate at all.
---

# Researching a match

## 1. Screen before you spend

Call `list_fixtures` for every sport you were asked about, in one call. On a
normal day it comes back with a hundred or more matches grouped by competition,
and your research budget is a dozen. Screening is therefore the first real
decision, and doing it badly is the most common reason a day produces no bets.

Work down from the competitions, not up from the fixtures:

1. **Coverage.** Pick competitions where team news actually gets published.
   Top divisions, national cups, continental competitions, the major leagues in
   any country. A third-tier fixture nobody writes about cannot be researched.
2. **Timing.** Prefer matches far enough out that team news exists but close
   enough that it is current. Six to thirty hours is the sweet spot.
3. **Shape.** Prefer matches with something to say about them — a gap in form, a
   known absence, a team with nothing to play for. A coin flip between two even
   sides has no angle at any price.

Then take your budget's worth from the top of that list and research them
properly. Do not spread thinly across forty matches; do not spend the whole
budget on two.

If a whole sport's card is unusable, say so and move on to the next one rather
than returning nothing.

## 2. Gather the facts

Search in this order and stop when the picture stops changing:

1. `"<home> vs <away>" team news injuries suspensions lineup`
2. `"<home> vs <away>" preview` — for the tactical read
3. `<home> recent form` and `<away> recent form` — check the results yourself rather than trusting a summary
4. Conditions, where the sport cares: weather and pitch for football and cricket, surface for tennis, rest days and travel for basketball

Fetch the two or three most substantive pages.

## 3. Find out what everyone else thinks

This step is not optional and it is not a formality. Your own read of a fixture
is one opinion; the point of this step is to put it against the opinions of
people who follow these teams every week, before you commit to anything.

Search for the match specifically:

- `"<home> vs <away>" prediction`
- `"<home> vs <away>" tips` and `... betting preview`
- `"<home> vs <away>" reddit` — and the sport's own communities, where the
  arguments are better than the conclusions
- `<competition> predictions <date>` — round-ups covering several matches at once

Read several, not one. What you are after is:

- **Where they agree.** Six previews all tipping the home win is a real signal
  about how this match is seen, whatever it is worth.
- **Where they split, and why.** A disagreement usually names the thing that
  actually decides the match — a fitness call, a rotation, a tactical mismatch.
  That reason is the most valuable thing on the page.
- **What they are reasoning from.** A tip with a checkable reason is worth ten
  with none. Sites that produce a prediction for every fixture on earth are
  producing them mechanically; weight them accordingly.

### Never adopt a tip. Test it.

This step exists to challenge your read, not to replace it. A tipster's pick is
a claim, and the only thing you do with a claim is check it.

**Form your own view first**, from the facts in step 2. Then read what others
say and ask what it changes:

- **A reason you can verify** — "the first-choice keeper is out" — is worth
  checking against a real source. If it holds, it is now *your* evidence, and it
  counts because you confirmed it, not because someone published it.
- **A reason you cannot verify** changes nothing. Note it as unconfirmed.
- **No reason at all** is worth nothing at any volume. Twenty sites agreeing,
  none of them saying why, is one opinion copied twenty times — most prediction
  pages are generated for every fixture on earth and have looked at none of them.

So agreement does not raise your confidence. Only evidence you checked yourself
does. If your own research is thin and the crowd is confident, the honest output
is a low confidence or a null pick — not their pick borrowed at their
confidence. Backing something because other people like it, without being able
to say why it wins, is the failure this whole step is designed to prevent.

**Disagreement is the more useful case.** If the weight of opinion is against
you, either you have found something they missed and can name it, or you are
wrong. Say which in your reasoning. Going against a strong consensus without
being able to name what you know that they do not is the most reliable way to
lose money here.

None of it tells you anything about price. A tipster's "great value at 2.50" is
about odds you are not being offered.

Record it in `consensus`: what you found, how many predictions you actually
read, and whether they point the same way you do. `found: false` is fine for an
obscure fixture nobody covers — it is not fine as a habit.

## 4. Weigh

When two sources disagree, say which you trust and why — recency, proximity to
the club, and track record, in that order. A beat reporter's team-sheet from
this morning beats a preview written on Monday.

Watch for these specifically:

- **A star name that is out.** Confirm it in a second source before you lean on it.
- **A lineup that is predicted, not confirmed.** Say which you have.
- **Motivation.** A team already promoted, already safe, or resting before a
  cup tie is a different team.
- **Stale news.** An injury report from two weeks ago tells you nothing.

## 5. Set confidence honestly

| Evidence you actually have | dataQuality | Confidence ceiling |
| --- | --- | --- |
| Confirmed lineups, several recent independent sources, and a consensus you have read | `strong` | up to 0.9 |
| Reliable team news, no confirmed lineup, some published views | `adequate` | around 0.7 |
| Only previews or aggregators, nothing recent, or no view but your own | `thin` | 0.5 or below |

A pick you formed without reading anybody else's is `thin`, however good the
team news was. And a pick resting on other people's agreement rather than on
evidence you verified is also `thin`, however many of them there were —
consensus is a check on your reasoning, never a substitute for it.

If you could not retrieve real team news, that is `thin`, whatever your instinct
about the match says.

**A simulated card is the exception, and you do not have to manage it.** When
`list_fixtures` reported `simulated: true`, the teams do not exist and no amount
of searching will produce news about them — the absence is the simulation, not
weak evidence. Call the `dataQuality` what it honestly is, including `thin`, and
set the confidence your reading of the fixture supports. `save_research` does
not apply the ceiling on a simulated card, because doing so would put every mock
bet under the staking threshold and the rehearsal would never reach a placement.
Say in your reasoning that the evidence is simulated.

## 6. Name the side

Every assessment ends with a `pick`: one market and one selection, the bet you
would place on this match. Whichever side your evidence points at — home, away,
draw, a total, a handicap.

Pick from the markets the card is actually offering — `list_fixtures` gives you
`offered` for each fixture, with the prices beside them. An outcome nobody
prices cannot become a bet.

Pick the outcome your research supports, at the probability your research
supports. You are not choosing the likeliest winner and you are not choosing the
biggest price; you are naming the outcome whose true probability you believe is
higher than a fair price would suggest, and saying what that probability is.

**Pass a null pick when the honest answer is no bet**, with `noBetReason` saying
what you found: the sides are even, the price is right, the evidence never
arrived. That is recorded and reported by name, so a null pick is a result, not
a silence.

What a null pick is not: a way to avoid committing. If you read the sources and
came away thinking one side is underrated, that is a pick. Say it.

Use `alternatives` for a second selection worth pricing if your pick turns out
to be unavailable — at most three, and only ones you would genuinely back.

Use only the codes the system understands:

| Market | Selection codes |
| --- | --- |
| `1x2` | `home`, `draw`, `away` |
| `moneyline` | `home`, `away` |
| `double_chance` | `home_or_draw`, `away_or_draw`, `home_or_away` |
| `btts` | `yes`, `no` |
| `over_under` | `over_<line>`, `under_<line>` — e.g. `over_2.5` |
| `handicap` | `home_<line>`, `away_<line>` — e.g. `home_-1.5` |

Football allows `1x2`, `double_chance`, `over_under`, `btts`. Basketball allows
`moneyline`, `over_under`, `handicap`. Cricket and tennis allow `moneyline`.
Anything else is discarded by the system, so do not invent one.

## 7. Record

Call `save_research` for every match you assessed, whether or not it produced a
pick. Include the sources you actually read, not every URL you saw.
