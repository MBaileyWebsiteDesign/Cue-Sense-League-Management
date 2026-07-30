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
  leagues expand — see the roadmap.
- **Admin Management Portal**: a dashboard linking to every admin tool — the Season
  Setup Wizard, user management, and the audit log. Any account with `isAdmin` set gets
  a link to it in the header.
- **Admin user management**: admins get a searchable list of every registered user,
  clickable through to an edit screen where they can update any profile field,
  grant/revoke admin rights, mark/unmark someone as captain, suspend/reactivate the
  account, and force-set a new password without knowing the old one.
- **Admin score override**: admins can directly correct a fixture's final score at any
  time, bypassing frame-by-frame play — useful for fixing a scoring mistake after the
  fact. It's blocked only when changing the *winner* would silently corrupt a knockout
  bracket that's already progressed past that result; pure score corrections (same
  winner) are always allowed.
- **Mid-season player substitution** (singles divisions): if a player drops out, an
  admin can swap them for a replacement from the division's page. Every fixture of
  theirs that hasn't been played yet moves to the replacement; anything already
  completed - or already partway through - is left exactly as it was, so history and
  standings for the games actually played never change. See **Player substitution**
  below.
- **Audit log**: every admin action that changes something on someone else's behalf
  (score overrides, profile edits, permission/status changes, forced password resets) is
  recorded with who did it and when, visible to admins from the Admin Portal.
- **Stream overlay (OBS Browser Source)**: a standalone, unauthenticated page at
  `/overlay/:fixtureId` showing a live-updating scoreboard for one fixture - entrant
  names, score, race-to/best-of-N target, and status - on a transparent background
  designed to be keyed over video in OBS (or any other streaming software with a
  browser-source layer). Works for singles, teams, and doubles/triples fixtures alike.
  See **Stream overlay** below.
- **Admin: edit a player's account from their profile page**: above a player's Career
  stats, an admin sees an "Account Details" panel to edit the registered account linked
  to that player - name, email, phone, team name, classification - plus a
  read-only list of the league(s)/division(s) they're currently registered in, and a
  "Send Password Reset Link" button in place of setting a new password directly. See
  **Password reset links** below.
- **Score confirmation workflow**: recording frames no longer finishes a match by
  itself. Once a side reaches the race target, whoever's been entering scores clicks
  "Submit for Confirmation"; the other side (or an admin) then either confirms it -
  finalizing the result exactly as before - or disputes it, which locks the fixture
  until an admin resolves it. See **Score confirmation** below.
- **Game Adjustments**: an admin page (Admin Portal → "Game Adjustments") that opens on
  a "Needs Attention" list of every disputed/pending-confirmation result across every
  league - no need to search for the player first - plus a player search to find and
  directly override or reopen any other result. The tool the score-confirmation
  workflow's "disputed" banner points admins at.

## What's deliberately out of scope for v1

Handicaps, online entry/payment, tablet-specific UI, shot/match timers, table booking,
and mini-knockout/mixed formats (double elimination and doubles/triples are now
implemented - see **Knockout / double-elimination format** and **Doubles / triples
format** above; a stream overlay is also now implemented - see **Stream overlay**
below). Team-specific captain tools (roster management, leg nominations from the
Captain Portal) are also deferred until team leagues are actively in use — the
`isCaptain` flag exists now so accounts are ready ahead of that. Mid-season player
substitution (see **Player substitution** below) is singles-only for now - swapping a
player out of a doubles/triples pairing, or a team roster, isn't covered yet.

## Accounts & login

There is exactly one way to sign in: email + password, at "Login" in the header. What an
account can see and do is controlled by two independent boolean flags, not a single
role:

- **`isAdmin`** — unlocks the Admin Portal (season wizard, user management, audit log)
  and the score-override control on every fixture.
- **`isCaptain`** — unlocks the Captain Portal. Currently just a flag with a fixtures
  view; it's in place ahead of team-league captain tools.

An account can be neither, either, or both at once — a league organizer who also plays
can have both flags set on the same login. Every request re-checks these flags against
the database fresh, so granting or revoking either one takes effect immediately, even
for a session that's already logged in.

A seeded admin account is created the first time you run `npm run seed`:

- Email: `admin@example.com`
- Password: `Admin12!@`

**Change this password (or delete/rebuild that account) before deploying anywhere real
people can reach it** — it's checked into this repo and is not a secret. Set
`SESSION_SECRET` to a random string in production too; it's the key used to sign login
tokens (`server/src/userAuth.js`), and the checked-in default is only safe for local use.

Anyone can self-register a regular player account from "Login" → "Create one".
Registration collects:

- First name, last name, email, password (required)
- Phone (optional)
- Team name (required)
- Classification, A through D (optional)

Passwords are salted and hashed with Node's built-in `crypto.scrypt` (never stored in
plaintext), and login issues an HMAC-signed token (24-hour expiry) stored in the
browser's `localStorage`. Every account — self-registered or admin-created via the
Season Setup Wizard's CSV/Excel import — lives in the same `db.users` table and is
auto-linked (by matching name) to a `Player` roster entry where one exists, powering the
"view my stats" link on the account page and letting admins add them to a division or
team roster.

Logged-in users manage their own account from "My Account" (click their name, top
right) — the Player Management Portal described above.

### Admin permission management

From the Admin Portal → "Manage Users", an admin can:

- Search all registered users and click through to edit any of their profile fields.
- Grant or revoke `isAdmin` on any account.
- Mark or unmark any account as a captain (`isCaptain`).
- Suspend an account (blocks that account's login immediately) or reactivate it.
- Force-set a new password for a user without needing their current one, or send them a
  reset link instead (see **Password reset links** below) so they choose their own.
- **Bulk-add users** ("Bulk Add Users" panel, top of the page) — download a CSV or
  Excel template, fill in a row per player, and upload it back; or add players one at a
  time with the same fields. This creates accounts only, with no season/division
  attached (add them to a specific roster afterwards from that division's page) - for
  standing up a whole new season (leagues + rosters + fixtures) in one guided flow, use
  the Season Setup Wizard instead. Each new account gets a random temporary password,
  shown once in the result so it can be handed to that player; a row whose email
  already has an account is skipped rather than duplicated or overwritten.
- Review the audit log of every admin action taken (who did what, and when).

## Season Setup Wizard

From the Admin Portal → "+ New Season", a 5-step guided flow walks an admin through
standing up an entire season:

1. **Name the season** — e.g. "Autumn 2026". This becomes a `League`.
2. **How many leagues, and how many players in each** — each "league" the admin
   describes becomes its own `Division` inside that season (its own round-robin,
   standings and fixture list). The player count is just a target used to build the
   CSV/Excel template's row count; it doesn't limit how many can actually be added.
3. **Add players** — either:
   - **Upload CSV or Excel**: download a template (pre-filled with one example row per
     league name, so the `division` column's valid values are obvious), fill in a row
     per player, and upload it back. Parsing happens entirely in the browser
     (`papaparse` for `.csv`, `xlsx`/SheetJS for `.xlsx`/`.xls`) — the server only ever
     receives plain JSON rows, regardless of which format was uploaded.
   - **Add players manually**, one at a time, via a form with the same fields.
   Either path creates a full account for each new player (with a random temporary
   password, shown once in the result so it can be handed to that player) and adds them
   to the named division; a row whose email already has an account links the existing
   account into that division instead of creating a duplicate. Rows with missing
   required fields or an unrecognized division name are skipped with a per-row reason,
   without failing the whole batch.
4. **Season start and end dates.**
5. **Generate fixtures** — choose the number of days between rounds, and every league
   (division) with at least 2 players gets its full round-robin fixture list generated,
   spaced out from the start date by that gap. If the last round would fall after the
   season's end date, that division is flagged in the result so the admin can adjust
   before publishing schedules. This step can also be skipped to generate fixtures later
   from the division page itself.

The wizard doesn't introduce a new data type — a "season" is just a `League`, and each
of its "leagues" is a `Division` (singles, round-robin) — so everything built by the
wizard immediately gets the same standings, fixtures and scoring UI as a league built by
hand.

## Player substitution

Real leagues lose players mid-season for two different reasons, and this feature treats
them differently: someone might just be missing a stretch of games (**temporary
cover**), or someone might be leaving the league for good (**retiring**). From a singles
division's page (once fixtures have been generated), an admin sees a "Substitute a
Player" panel: pick who's leaving, who's replacing them, and which of the two reasons
applies, then:

- Every fixture of the outgoing player's that's still `scheduled` (nobody has played it
  yet) gets handed to the incoming player - same round, same opponent, just a new name
  on that side. This happens identically either way.
- Anything already `completed` is left completely untouched - the outgoing player's
  record for the games they actually played stays exactly as it was, permanently,
  regardless of which reason was chosen.
- Anything `in_progress` (some frames already recorded, but not finished) is also left
  alone rather than guessed at - it's reported back separately so the admin knows it
  still needs the outgoing player to finish it out, or an admin score override, before
  it can be reassigned too.
- **Temporary cover** leaves the outgoing player on the division's roster - their
  standings row keeps showing whatever they'd already played, it just stops growing. The
  incoming player is added alongside them and starts accumulating their own record from
  that point on.
- **Retiring** additionally removes the outgoing player from the division's roster, so
  their row disappears from the League Table from that point on. Their already-completed
  matches aren't touched, so nothing about their opponents' won/lost/frame counts
  changes - the standings calculation builds each row purely from that player's own
  fixtures, so removing one player's row can't affect anyone else's numbers. Their full
  match history is still visible on their own player profile page; they just no longer
  show up in this division's live table.
- Every substitution is recorded (who was swapped for whom, when, by which admin, how
  many fixtures moved, and whether it was temporary cover or a retirement) both in the
  division's own history (shown right under the panel) and in the general admin audit
  log.

There's currently no "wipe the score and start the replacement from zero" option - if
that's ever needed, it should be built as its own explicit feature rather than folded
into this one, since it would mean deciding what happens to frames/results that already
count toward someone's record. Team-division substitution isn't covered yet either
(rosters can already be edited directly before fixtures are generated; mid-season team
swaps would need their own design since team fixtures don't reference individual
players directly the way singles ones do).

## Stream overlay

Every fixture has a matching scoreboard page at `/overlay/:fixtureId` (the same
`:fixtureId` as its normal `/fixtures/:fixtureId` page - an admin can copy the link
directly from a "Copy link" button on the fixture page's Admin-only "Stream overlay"
panel). Add that URL as an OBS **Browser Source** (or the equivalent in other streaming
software) to key a live scoreboard over a table camera or commentary feed:

- Shows both entrant names (plus, for a doubles/triples pairing, a smaller sub-line of
  its member names), the live score, a status pill (Upcoming/Live/Final), and the
  race-to or best-of-N-legs target.
- Polls the score every 5 seconds rather than opening a websocket - "close enough to
  live" for a pool match, with no extra server infrastructure required.
- Deliberately **outside** the normal app shell and login: no header, no breadcrumbs,
  transparent background, and backed by a public, unauthenticated endpoint
  (`GET /api/overlay/fixtures/:id`) rather than the regular (login-required)
  `GET /api/fixtures/:id`, since OBS's Browser Source has no way to supply a login
  token. That endpoint deliberately returns only what a scoreboard graphic needs
  (entrant names/scores/status), not the full fixture record (frame history, ids,
  admin-override metadata) the authenticated endpoint exposes.
- Works identically for singles, teams, and doubles/triples fixtures - the endpoint
  normalizes all three into the same `{ home, away }` shape server-side, so the overlay
  page itself never needs to branch on the division's `entryType`.

## Password reset links

From a player's profile page (`/players/:playerId`), an admin sees an "Account Details"
panel above Career with the same editable fields as Manage Users (name, email, phone,
team, classification), plus a read-only list of the league(s)/division(s) that
player is currently registered in. Instead of a "type a new password" field, there's a
**Send Password Reset Link** button: it generates a single-use, 1-hour token and shows
the admin a link (`/reset-password?token=...`) to relay to the player however they'd
like (text, email, WhatsApp, in person).

**This is not wired up to a real email provider yet** - this is a self-hosted v1 with no
SMTP configuration (see the roadmap). The link is displayed to the admin and also
printed to the server's console log as a fallback, but nothing is actually emailed.
Visiting the link takes the player to a public "Reset Password" page where they choose
their own new password; the token is rejected if it's already been used or has expired.

## Score confirmation

Recording frames (or leg frames, for a team match) no longer finishes a match by
itself. Once a side's score reaches the race target, the fixture stays `in_progress`
and a **Submit for Confirmation** button appears - clicking it moves the result to
`pending_confirmation` without yet touching standings or bracket propagation (both only
ever count a fixture once its status is `completed`). From there:

- The **away side** (or an admin) sees **Confirm Result** / **Dispute Result** buttons.
  For a doubles/triples pairing, any player in that pairing can confirm/dispute; for a
  team leg, the away side's nominated player for that leg.
- **Confirm** finalizes the match exactly the way automatic completion used to -
  standings update, and a knockout winner/loser propagates into the next round.
- **Dispute** locks the fixture as `disputed` - no more frames can be recorded or
  undone until an admin steps in, either by overriding the score directly or by
  reopening the fixture back to `in_progress` (unlocking frame entry again, without
  setting a score) from the fixture page or **Game Adjustments** (see below).

This intentionally adds friction to reduce mis-recorded results and one-sided score
entry: a result can't count until the person on the other side of the table has agreed
to it (or an admin has stepped in).

## Game Adjustments

From the Admin Portal → "Game Adjustments", the page opens straight onto a **Needs
Attention** list - every result across every league that's currently `disputed` or
`pending_confirmation`, pulled from `GET /api/admin/fixtures/needs-attention` - so an
admin doesn't have to know (or search for) which player is involved just to find
something that needs resolving. Clicking a singles/doubles item jumps straight to step 3
below to override or reopen it; a disputed/pending team-fixture *leg* links out to that
fixture's own page instead, since leg-level resolution isn't something the Override form
here handles (see **Score confirmation** - `LegRow`'s own Confirm/Dispute/Reopen
controls cover that).

Below that, an admin can also search for a player by name, pick one of their fixtures
(every status is shown, not just upcoming ones), and either override the final score
directly (same underlying action as the per-fixture Admin Override panel) or, for a
pending/disputed result, reopen it for further scoring instead. This is the tool the
score-confirmation workflow's "Result disputed" banner links admins to.

## Architecture

```
pool-league/
  server/            Node.js + Express REST API
    src/
      index.js          Routes, static hosting of the built client, season wizard
                         endpoints, fixture date scheduling
      db.js              JSON-file 