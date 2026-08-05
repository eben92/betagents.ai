---
description: Use when assessing a specific fixture — the evidence-gathering order, how to weigh conflicting sources, how to set confidence, and when to return no candidate at all.
---

# Researching a match

## 1. Screen before you spend

Discover fixtures with `list_fixtures`, then decide which are worth real work.
Research the ones where public information is genuinely checkable: established
competitions, well-covered teams, and enough time before the start for team news
to exist.

Skip a fixture when you cannot tell what competition it is, when coverage is
likely to be thin, or when the result looks like a coin flip with no angle. You
are looking for a mispriced market, not a winner.

## 2. Gather

Search in this order and stop when the picture stops changing:

1. `"<home> vs <away>" team news injuries suspensions lineup`
2. `"<home> vs <away>" preview` — for the tactical read
3. `<home> recent form` and `<away> recent form` — check the results yourself rather than trusting a summary
4. Conditions, where the sport cares: weather and pitch for football and cricket, surface for tennis, rest days and travel for basketball

Fetch the two or three most substantive pages. A page that is mostly ads and a
prediction widget is not a source.

## 3. Weigh

When two sources disagree, say which you trust and why — recency, proximity to
the club, and track record, in that order. A beat reporter's team-sheet from
this morning beats a preview written on Monday.

Watch for these specifically:

- **A star name that is out.** Confirm it in a second source before you lean on it.
- **A lineup that is predicted, not confirmed.** Say which you have.
- **Motivation.** A team already promoted, already safe, or resting before a
  cup tie is a different team.
- **Stale news.** An injury report from two weeks ago tells you nothing.

## 4. Set confidence honestly

| Evidence you actually have | dataQuality | Confidence ceiling |
| --- | --- | --- |
| Confirmed lineups, multiple recent independent sources | `strong` | up to 0.9 |
| Reliable team news, no confirmed lineup | `adequate` | around 0.7 |
| Only previews, aggregators, or nothing recent | `thin` | 0.5 or below |

If you could not retrieve real team news, that is `thin`, whatever your instinct
about the match says.

**A simulated card is the exception.** When `list_fixtures` reported
`simulated: true`, the teams do not exist and no amount of searching will
produce news about them — the absence is the simulation, not weak evidence.
Applying the ceiling above would cap every confidence below the threshold a
stake needs, so mock mode could never place a bet and would never test the one
path that matters. Judge those fixtures on what you do have — the competition,
the fixture, the prices when they arrive — call the dataQuality `adequate`, and
say in your reasoning that the evidence is simulated. This applies only when the
tool told you the feed is simulated; never infer it from a name you do not
recognise.

## 5. Nominate markets, or do not

Only propose a selection when your probability differs from a fair price by
enough to matter, and when the reason is something concrete you found — not a
feeling about form.

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

Propose at most four selections per match. Propose none when nothing is
mispriced — that is the common case and it is not a failure.

## 6. Record

Call `save_research` for every match you assessed. Include the sources you
actually read, not every URL you saw.
