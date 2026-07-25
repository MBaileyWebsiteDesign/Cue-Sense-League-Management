# The Ultimate Pool League

A self-hosted pool league management platform: admins create leagues, divisions and
players (or spin up a whole season in one guided wizard); the app schedules fixtures
(round robin or knockout); captains or admins record match results frame-by-frame;
standings update automatically.

## Running it locally

Requires Node.js 18+.

```bash
# 1. Install and seed the API
cd server
npm install
npm run seed      # creates "Top Spin Singles" (6 divisions + demo data) and the admin account
npm start         # http://localhost:4000

# 2. In a second terminal, build the client
cd client
npm install
npm run build      # produces client/dist, served automatically by the Express server

# Open http://localhost:4000 - the whole app is served from one port.
```

For frontend development with hot reload, run `npm run dev` in `client/`
(http://localhost:5173) instead of `npm run build`; it proxies `/api` to the server on
port 4000, so run both at once.

### Login credentials (seeded data)

| Account | Email | Password |
|---|---|---|
| Admin | `admin@example.com` | `Admin12!@` |
| Any of the 84 seeded players | `<firstname>.<lastname>@example.com` (e.g. `suraj.singh.rathor@example.com`) | `Test12!@` |

**Change or remove these before deploying anywhere real people can reach it** - they're
checked into this repo and are not secrets. Also set `SESSION_SECRET` (used to sign
login tokens, `server/src/userAuth.js`) to a random string in production.

## Features

- **Single login, two flags** - every account signs in through one form; `isAdmin` and
  `isCaptain` are independent booleans on the account rather than separate account
  types, so one person can be both. After login, an admin lands on the Admin Portal
  (`/admin`); everyone else lands on the Player Portal (`/account`) - a deep link that
  required login takes priority over both.
- **Leagues & divisions** - a league has a configurable format (match type, race-to-N,
  default scheduling); each division independently picks an **entry type** (`singles`,
  `teams`, or `doubles`/triples via named `Pairing`s) and a **scheduling** method
  (round robin, single-elimination, or double-elimination knockout).
- **Season Setup Wizard** - a 5-step guided flow (Admin Portal → "+ New Season") to name
  a season, choose how many divisions and roughly how many players, add players by
  CSV/Excel or manually, set dates, and generate every division's fixtures at once.
- **Frame-by-frame scoring** with a submit → confirm/dispute handshake: reaching the
  race target unlocks "Submit for Confirmation"; the away side (or an admin) then
  confirms (finalizes, updates standings/bracket) or disputes (locks the fixture until
  an admin resolves it - a reason is required and shown to whoever resolves it). Team
  fixtures score the same way per-leg (best-of-N legs, each a nominated player vs.
  player mini-match).
- **Manage Fixtures (round visibility)** - admins release a division's fixtures round by
  round (Admin Portal → "Manage Fixtures" → pick a league, then a division). Until a
  round is released it's invisible to players everywhere (My Fixtures, Needs Your
  Confirmation, the division page, direct fixture URLs) and none of its scoring routes
  work for a non-admin. Admins always see the whole season. Divisions that already had
  fixtures generated before this shipped keep everything visible; new divisions start
  with nothing released.
- **Player Portal ("My Account")** - every account's home base: edit your profile,
  change your password, see upcoming/recent fixtures, and a **"Needs Your
  Confirmation"** panel for results an opponent submitted that are waiting on you.
- **Captain Portal** - landing page for captain-flagged accounts (currently just a
  fixtures view; team-management tools are on the roadmap).
- **Admin tools** - Manage Users (search, edit, grant/revoke admin/captain, suspend,
  force-reset or send a password-reset link, bulk CSV/Excel import), Manage Venues
  (approve/reject player-submitted venues), Game Adjustments (a "Needs Attention" feed
  of every disputed/pending result, plus search-and-override any fixture), an audit log
  of every admin action, and per-fixture score override (bypasses frame-by-frame play;
  blocked only if it would silently overwrite a bracket result that's already
  progressed).
- **Player stats & profiles** - career record, frame difference, and head-to-head per
  opponent, aggregated across singles fixtures and team legs.
- **Mid-season player substitution** (singles only) - swap a player out for a
  replacement; not-yet-played fixtures move to the replacement, completed ones are
  untouched. "Temporary cover" keeps the outgoing player on the table; "retiring"
  removes them from it.
- **Stream overlay** - a public, unauthenticated scoreboard page at
  `/overlay/:fixtureId` for OBS Browser Source, polling every 5s.
- **Venues** - a shared, admin-approved list; a new venue typed at registration/profile
  edit is auto-queued for approval rather than requiring a separate step.

## Data model (summary)

- `League`: format (match type, race-to-N, default scheduling).
- `Division`: `leagueId`, `entryType`, `scheduling`, roster ids (`playerIds`/`teamIds`/
  `pairingIds`), `legsPerMatch`/`pairingSize`, `fixturesGenerated`, `visibleRounds[]`
  (round numbers released to players), `startDate`/`endDate`/`gapDays`.
- `Player`: just `id, name` - the roster entry, distinct from the login (`User`).
- `Team` / `Pairing`: named group of players (`playerIds[]`); a pairing's fixtures are
  scored like singles (no legs), a team's are best-of-N legs.
- `Fixture` (singles/doubles): `homePlayerId`/`awayPlayerId` (a `Pairing` id on doubles
  divisions), `frames[]`, scores, `status` (`scheduled → in_progress →
  pending_confirmation → disputed|completed`), `disputeReason`, bracket-linking fields
  (`nextFixtureId`, `bracketRole`, etc. - double-elim only), `scheduledDate`.
- `Fixture` (teams): same shape, plus `legs[]` (each leg is itself fixture-shaped).
- `User`: `firstName/lastName/email/passwordHash`, `isAdmin`, `isCaptain`, `status`,
  `playerId` (linked `Player`, auto-matched by name).
- `AuditLog`, `Venue`, `PasswordReset` - as named.

Data is a single JSON file (`server/src/db.js`) read/written by every route - no DB
server to provision. Swapping in Postgres later is a contained change to that one file.

## API reference (summary)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Login (any account) |
| POST | `/api/users/register` | Self-register a player account |
| POST | `/api/auth/reset-password/:token` | Consume a password-reset link |
| GET/PATCH | `/api/users/me` | Get / update your own profile |
| POST | `/api/users/me/change-password` | Change your own password |
| GET | `/api/users/me/fixtures` | Your upcoming/recent fixtures |
| GET | `/api/users/me/pending-confirmations` | Results awaiting your confirmation |
| GET/PATCH/POST | `/api/admin/users...` | List/search, edit, set permissions/status, reset password, send reset link, bulk import (admin) |
| GET | `/api/admin/audit-log` | Recent admin actions (admin) |
| GET | `/api/admin/players/:playerId/fixtures` | Any player's fixtures, any status (admin) |
| GET | `/api/admin/fixtures/needs-attention` | Every disputed/pending result (admin) |
| POST | `/api/admin/seasons...` | Season Setup Wizard steps (admin) |
| GET/POST | `/api/leagues`, `/api/leagues/:id` | List/create leagues, get one with its divisions |
| POST | `/api/leagues/:leagueId/divisions` | Add a division (admin) |
| GET | `/api/divisions/:id` | Division + roster, fixtures, standings (fixtures filtered to released rounds for non-admins) |
| GET | `/api/registered-players` | Registered users available to add to a roster |
| POST/DELETE | `/api/divisions/:id/players`, `/teams`, `/pairings`, `/teams/:id/players`, `/pairings/:id/players` | Roster management (pre-fixtures only) |
| POST | `/api/divisions/:id/generate-fixtures` | Generate the fixture list |
| POST | `/api/divisions/:id/rounds/:round/visibility` | Release/hide a round to/from players - `{ visible }` (admin) |
| POST | `/api/divisions/:id/substitute-player` | Swap a player out mid-season (admin) |
| GET | `/api/fixtures/:id` | Fixture detail (404 for a non-admin if its round isn't released) |
| GET | `/api/overlay/fixtures/:id` | Public scoreboard summary (stream overlay) |
| POST/DELETE | `/api/fixtures/:id/frames`, `/frames/last` | Record / undo a frame |
| POST | `/api/fixtures/:id/submit-result`, `/confirm-result`, `/dispute-result` | Submit → confirm/dispute a result (`dispute-result` requires `{ reason }`) |
| POST | `/api/fixtures/:id/reopen` | Reopen a pending/disputed result (admin) |
| POST | `/api/fixtures/:id/override` | Directly set a fixture's final score (admin) |
| POST/DELETE | `/api/fixtures/:id/legs/:legNumber/...` | Same submit/confirm/dispute/reopen + frame routes, scoped to one team leg |
| GET | `/api/players/:id` | Player profile: career record, head-to-head, history |
| GET/POST | `/api/venues`, `/api/admin/venues...` | Approved venues / admin approve-reject |

## Architecture

```
pool-league/
  server/            Node.js + Express REST API
    src/
      index.js          Routes, static hosting of the built client
      db.js              JSON-file persistence layer
      userAuth.js        Accounts: registration/login, hashing, requireAuth/requireAdmin
      services/          roundRobin, bracket, standings, teamStandings, playerProfile,
                          auditLog, seed
  client/            React (Vite) single-page app
    src/
      pages/             LeagueList, LeagueDetail, DivisionDetail, FixtureDetail,
                         PlayerProfile, Login, Register, ResetPassword, PlayerPortal,
                         CaptainPortal, AdminPortal, AdminSeasonWizard, AdminUsers,
                         AdminUserEdit, AdminAuditLog, AdminVenues, GameAdjustments,
                         ManageFixtures, StreamOverlay (standalone, no app shell)
      demo/              Static-demo mirror of the whole API (see below)
      api.js             Fetch wrapper for the REST API
```

Admin/captain-only pages (and the Season Wizard/Manage Users' `xlsx`/`papaparse`
dependencies) are `React.lazy()`-loaded, so a regular player's first-load bundle doesn't
pay for code they'll never use.

## GitHub Pages: static demo build

`npm run build:demo` in `client/` (used by `.github/workflows/deploy-demo.yml` on every
push to `main`) builds a version wired to `client/src/demo/demoApi.js` - a drop-in stand-in
for `api.js` that runs the same route logic against an in-memory copy of the seeded data
instead of a live server, persisting a visitor's own changes to their browser's
`localStorage`. A visitor lands already "logged in" as the seeded admin - there's no
password to check in a static bundle. This is a demo, not a deployment: to run this app
for real, host `server/` somewhere that keeps `server/src/data/db.json` around between
requests (Render, Railway, Fly.io, a VPS, etc.).

## Roadmap

1. Swap the JSON file store for Postgres.
2. Team-league captain tools (roster management, leg nominations) scoped to the team(s)
   a captain actually captains.
3. Real email delivery for password-reset links (currently shown to the admin to relay
   manually) and email verification at registration.
4. More scheduling methods (home/away double round robin, mini-knockouts, mixed formats
   within one competition) and seeded/ranked knockout brackets.
5. Deeper player statistics (form guides, a cross-season trophy cabinet) and
   handicaps.
6. Tablet-optimized live scoring and shot/match timers.

## Seeded demo data

`npm run seed` creates **Top Spin Singles**: 6 divisions (Premier League, Division 1-5),
each with a real 14-player roster and a full round-robin fixture list (91 fixtures)
generated up front but unplayed, 5 pre-approved venues, and the admin account. Every
seeded player also gets a real `User` login (see credentials table above) so the app is
fully testable without hand-registering 84 accounts.
