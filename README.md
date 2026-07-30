# The Ultimate Pool League

Live on GitHub: https://github.com/MBaileyWebsiteDesign/the-ultimate-pool-league

A self-hosted pool league management platform: admins create leagues, divisions and
players (or spin up a whole new season in one guided wizard); the app schedules
fixtures per division (round robin or knockout); captains or admins record match
results frame-by-frame; standings update automatically. Built to give a pool league the
full-featured competition management that Wix has no built-in system for.

## What's implemented

- **Single unified login**: every account — admin, player, captain, or any combination —
  signs in through the same one form. There's no more separate "admin login" vs. "player
  login"; who you are and what you can do is just a pair of flags (`isAdmin`,
  `isCaptain`) on your account, checked fresh on every request. See **Accounts & login**
  below.
- **Leagues** with a configurable format (match type, race-to-N frames, default
  scheduling method).
- **Divisions** within a league (unlimited), each independently configured along two
  axes:
  - **Entry type** — `singles` (one player vs. one player), `teams` (team vs. team), or
    `doubles` (a named 2-3 player `Pairing` vs. `Pairing`, alternate-shot - see
    **Doubles / triples format** below).
  - **Scheduling** — `round_robin_single` (Round Robin - Single: everyone/every team
    plays everyone/every team else exactly once), `round_robin_double` (Round Robin -
    Double: everyone/every team plays everyone/every team else twice, a home leg and
    an away leg with sides swapped), `knockout_single_elim` (single-elimination
    bracket), or `knockout_double_elim` (double-elimination: winners bracket + losers
    bracket + Grand Final, with a bracket-reset decider if needed - see below).
  These are independent choices, so e.g. a knockout team cup and a round-robin singles
  division can coexist in the same league.
- **Season Setup Wizard**: a 5-step guided flow for standing up a brand-new season
  (Admin Portal → "+ New Season") — name it, choose how many leagues and roughly how
  many players each, add the players (CSV/Excel upload with a downloadable template, or
  add them one at a time), set the season's start/end dates, then generate every
  league's fixtures in one click with the games spaced out automatically. See
  **Season Setup Wizard** below for the full walkthrough.
- **Team leagues**: teams are rosters of players; a team fixture is a best-of-N "legs"
  match (N = `legsPerMatch`, admin-configurable per division), each leg a nominated
  player vs. nominated player mini-match scored exactly like a singles frame race. The
  team match is decided the moment one side has an unreachable majority of legs (mirrors
  the singles race-to-N "stop once it's decided" behaviour); an even `legsPerMatch` can
  end level, recorded as a drawn team match (2/1/0 league points for win/draw/loss). Use
  an odd `legsPerMatch` for knockout team divisions so every match has a winner to
  advance. A player can be flagged as a **captain** (see below) ready for when team
  leagues get their own captain-only tools.
- **Knockout / single-elimination format**: standard bracket seeding with byes for
  non-power-of-2 entrant counts (see `server/src/services/bracket.js`), automatic bye
  resolution (a bye winner advances without a match, but two bye-advanced entrants
  meeting in a later round always play a real match — a slot merely waiting on an
  earlier round is never confused with a genuine bye), winner propagation into the next
  round's fixture, and an undo-lock: once a result has advanced a player/team to the
  next round, that frame/leg can't be undone from the completed fixture (it would
  silently corrupt the bracket) — the fixture detail page shows "TBD" for slots that
  haven't been decided yet.
- **Knockout / double-elimination format**: a losing entrant isn't out immediately -
  they drop into a losers bracket and keep going until they lose a second time.
  Structurally this is a winners bracket (identical to single elimination) plus a
  losers bracket that interleaves each round's fresh losers with the losers bracket's
  own survivors, finishing in a Grand Final between the two brackets' champions. Because
  the losers-bracket entrant already has one loss and the winners-bracket entrant has
  none, winning the Grand Final isn't enough for the losers-bracket entrant on its
  own — beating the winners-bracket champion there only draws them level, so a single
  **bracket-reset decider** is automatically created and must be won too; if the
  winners-bracket champion wins the Grand Final outright, the tournament ends there.
  The Fixtures list on the division page groups fixtures into "Winners Bracket",
  "Losers Bracket", "Grand Final" and (if triggered) "Grand Final — Bracket Reset"
  sections rather than one flat round list. **v1 scope**: requires an exact
  power-of-two entrant count (4, 8, 16, 32...) - the interleaving arithmetic only lines
  up cleanly with no byes anywhere in the winners bracket; a non-power-of-two count gets
  a clear error asking you to add/remove an entrant or use single elimination instead.
  See `server/src/services/bracket.js` (`buildDoubleElimBracket`) for the full seeding
  design notes.
- **Doubles / triples format**: a `Pairing` is 2 (doubles) or 3 (triples) named
  registered players (`pairingSize`, set per division) who register together and play
  alternate-shot as one side. Structurally a Pairing is just a named group of players
  like a Team, but its fixtures are scored exactly like a singles fixture - one
  continuous frame race, no legs - since alternate-shot doesn't split a match into
  separate player-vs-player mini-matches the way a team leg does; recording a frame
  just records which pairing won it. This works with every scheduling method (round
  robin, single or double elimination) with no special-casing, since a doubles/triples
  fixture is literally a singles fixture whose `homePlayerId`/`awayPlayerId` happen to
  hold a Pairing id instead of a Player id. Every pairing needs exactly `pairingSize`
  players before fixtures can be generated for the division. Individual players inside
  a pairing don't get personal career stats from doubles play (their profile page only
  tracks singles fixtures and team legs) - the Pairing itself is the entrant standings
  and results are tracked against, shown on the division page rather than a dedicated
  profile.
- **Player registration** per division (singles), per team (teams), or per pairing
  (doubles/triples), picked from the list of people who've actually created an account
  (see **Accounts & login** below) - rosters can't be padded with made-up names. Rosters
  lock once fixtures are generated, which mirrors how real leagues avoid re-shuffling a
  season that's already started.
- **Automatic fixture generation**: circle-method round-robin (handling odd counts via
  a bye) or knockout bracket generation, depending on the division's `scheduling`, with
  optional automatic date scheduling (a start date plus a "days between rounds" gap —
  see **Season Setup Wizard**).
- **Frame-by-frame scoring**: each frame is recorded as a single winner; the match ends
  automatically the moment either side reaches the race target (e.g. race to 6 ends
  at 6–5, 6–0, 6–3, etc. — never plays on past the target), with the last frame
  reversible for corrections (unless that result already advanced a bracket).
- **Live standings**: singles and doubles/triples divisions rank by points (2 for a
  win)/frames for/against/difference (a doubles/triples table ranks Pairings, not
  individual players); team divisions rank by points (2/1/0 for win/draw/loss)/legs
  for/against/difference — all computed automatically from completed results.
- **Player stats & profiles**: every player has a profile page showing career record
  (played/won/lost, frames for/against, frame difference) aggregated across both singles
  fixtures and legs played inside team fixtures, plus a head-to-head breakdown per
  opponent and a full match history linking back to each fixture.
- **Breadcrumb navigation**: every page below the home list shows a trail back to the
  home page (League › Division › Round N, etc.), rendered as a bar under the header.
- **Player Management Portal** ("My Account"): every logged-in account's home base —
  update your own profile fields, change your password, and see a personal list of your
  upcoming fixtures and recent results across every division/team you're registered in,
  plus a link to your full stats/history if your account is linked to a `Player` roster
  entry.
- **Captain Management Portal**: a dedicated landing page for accounts flagged as
  captain, currently showing the captain's own upcoming matches plus a placeholder for
  the team-management tools (roster management, leg nominations) planned once team
  leagues expand — see the roadma