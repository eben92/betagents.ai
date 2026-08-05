---
description: Use when asked to read the card — finding the sport's listings, reading fixtures and the prices beside them accurately, and getting the kickoff times right.
---

# Reading the card

The card is the day's fixtures and the markets on offer for them. It is the
answer to "what can we bet on today", and nothing else in the system can answer
it: a public schedule lists matches nobody prices and misses ones that are.
Everything downstream — research, planning, placement — works from what you
record here.

**Reading a card is not betting on it.** The catalogue may be a different site
from the account you stake with, and it is configured separately for exactly
that reason. You are browsing a public listing: do not log in to it, do not
open a betslip on it, do not place anything there. Read what is published and
record it.

## 1. Find the listings

Open the sport's page with `browse` and **`site: "catalogue"`** — that is what
resolves a relative path against the listing site rather than the account you
stake with. Getting this wrong reads the wrong site's card.

If the path in your brief does not land on a list of matches, do not guess a
URL: open the catalogue's home page, `snapshot` it, find the navigation link for
that sport by its visible name, and click it.

You want the page that lists upcoming matches with prices beside them. Not a
results page, not a live-now page, not an outright/futures page.

## 2. Read what is listed

Work down the page. For each match, take:

- **Both sides**, exactly as written. Do not expand "Man Utd" to "Manchester
  United" or tidy a spelling — the system does that matching itself, and it does
  it better with the original.
- **The competition heading** the match sits under.
- **The kickoff time**, converted to a full ISO timestamp.
- **The event's own link or id**, if the page shows one.
- **The markets and prices shown beside it.** A listing normally shows the main
  ones inline — home/draw/away, sometimes a total or both-teams-to-score. Take
  those as `offers`. You do not need to open each event to collect every market;
  the inline ones are what research needs to see what its options are.

Use the system's own codes for markets: `1x2` with `home`/`draw`/`away`,
`double_chance` with `home_or_draw`, `over_under` with `over_2.5`, `btts` with
`yes`/`no`, `moneyline`, `handicap` with `home_-1.5`. Anything else is dropped,
which costs research an option it could have had.

Prices are a snapshot for research to argue against, not an authority. The
account that takes the bet re-reads the price immediately before placing.

If the list is paginated or lazy-loads, read what is on screen, record it, then
continue. A partial card recorded is worth more than a complete one lost to a
timeout.

## 3. Get the dates right

This is where a card gets silently corrupted. The site shows "20:45" or
"Tomorrow 15:00" and you have to turn that into a date.

- Establish today's date from the page itself — the date headings on the card —
  rather than assuming.
- A time with no date under a "Today" heading is today. Under "Tomorrow", the
  next day. A bare weekday is the next occurrence of that weekday.
- Times are in the site's timezone. If the page states one, use it. If not, say
  in your report which timezone you assumed.

`record_operator_fixtures` rejects anything that lands outside the current card,
and it tells you what it dropped and why. A rejected date is a date you read
wrong; go back and re-read the heading rather than adjusting the timestamp until
it is accepted.

## 4. Record, sport by sport

Call `record_operator_fixtures` once per sport, with everything you read for it,
markets included.

It reports how many fixtures it could tie to a public scoreboard event. That
number matters: a fixture it could not tie is still backable, but its bet will
have to be settled by hand, so mention it if a lot of them fail.

## 5. Virtual and simulated products

Bookmakers list computer-generated matches alongside real ones — a "match" every
three minutes, instant results, no real teams. Those are out of scope. Skip any
section labelled virtual, instant, simulated or similar, along with esports and
casino products. If you are unsure whether a section is real sport, leave it out
and say so.
