// Lightweight JSON-file persistence layer.
//
// Why not a real database engine for v1?
// This MVP prioritizes zero external dependencies (no native bindings, no
// DB server to provision) so the whole app can be cloned and run with
// `npm install && npm start`. The data-access API below (readDb/writeDb via
// the exported `db` object) is the seam where a production build would swap
// this out for Postgres/Prisma without touching route or service code -
// every route goes through this module, never the filesystem directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On a host with a persistent volume mounted (e.g. Fly.io at /data), set
// DATA_DIR to that mount point so db.json survives redeploys - the container
// filesystem is rebuilt from the image on every deploy, so anything written
// to the default in-repo `data/` folder would otherwise be wiped every time.
// Falls back to the local `server/src/data` folder for `npm run dev`/`npm start`.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// In-memory cache of the last-parsed (and migrated) state, keyed to the data
// file's mtime. Almost every route calls readDb() at least twice - once in
// the requireAuth/requireAdmin middleware to look up the caller, again in
// the route handler itself - so without this, a single request means two
// full disk reads + JSON.parse passes + the user-migration loop below, on
// every request, even a plain GET. If the file's mtime hasn't changed since
// the last read, skip straight to a fresh deep clone of the cached object
// instead. Cloning is still necessary (routes mutate the returned state
// directly before calling writeDb()), but structuredClone of an in-memory
// object is far cheaper than reading+parsing 100s of KB of JSON from disk.
let cache = null; // { mtimeMs, state }

const EMPTY_STATE = {
  leagues: [],
  divisions: [],
  players: [],
  teams: [],
  pairings: [],
  divisionPlayers: [],
  fixtures: [],
  users: [],
  auditLog: [],
  venues: [],
  passwordResets: [],
  tours: [],
  rollOfHonour: [],
  apiKeys: [],
  // League payment wall: one record per (leagueId, playerId) - see
  // assertPaymentCleared in index.js and POST /api/leagues/:id/payments/:playerId.
  leaguePayments: [],
};

function ensureDataFile() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    writeFileSync(DATA_FILE, JSON.stringify(EMPTY_STATE, null, 2));
  }
}

export function readDb() {
  ensureDataFile();
  const mtimeMs = statSync(DATA_FILE).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) {
    return structuredClone(cache.state);
  }

  const raw = readFileSync(DATA_FILE, 'utf-8');
  const state = JSON.parse(raw);
  // Backfill for databases created before `teams`/`users`/`auditLog`/`venues`
  // existed, and before users had role/status/playerId fields.
  if (!state.teams) state.teams = [];
  if (!state.pairings) state.pairings = [];
  if (!state.users) state.users = [];
  if (!state.auditLog) state.auditLog = [];
  if (!state.venues) state.venues = [];
  if (!state.passwordResets) state.passwordResets = [];
  if (!state.divisions) state.divisions = [];
  if (!state.fixtures) state.fixtures = [];
  // Tours/series (an admin-curated set of divisions whose standings points
  // get summed into one aggregate ranking table - see services/tours.js)
  // and the Roll of Honour (every division's champion, recorded
  // automatically the moment its last fixture completes - see
  // recordChampionIfDivisionComplete in index.js) both post-date the
  // original schema, so backfill them the same way as everything else here.
  if (!state.tours) state.tours = [];
  if (!state.rollOfHonour) state.rollOfHonour = [];
  // StreamDeck / integration API keys - see userAuth.js's loadApiKeyUser.
  if (!state.apiKeys) state.apiKeys = [];
  if (!state.leaguePayments) state.leaguePayments = [];
  // Table scheduling: named tables belong to a league, and a fixture can be
  // assigned to one (plus a time) via POST /api/fixtures/:id/schedule - see
  // that route and the Arena display (GET /api/overlay/leagues/:id/arena).
  for (const league of state.leagues) {
    if (!league.tables) league.tables = [];
    // Payment wall (see assertPaymentCleared in index.js) - every league
    // created before this feature existed defaults to `required: false`,
    // exactly like a freshly-created league with the toggle left off.
    if (!league.payment) {
      league.payment = { required: false, amount: 0, currency: 'GBP', windowStart: null, windowEnd: null };
    }
    // League Manager scoping: userIds of accounts granted admin-equivalent
    // access to just this league (assigned by an Overall Admin only - see
    // POST /api/leagues/:id/managers in index.js). Every league created
    // before this feature existed defaults to an empty list, same as a
    // freshly-created league with no managers assigned yet.
    if (!league.managerUserIds) league.managerUserIds = [];
  }
  for (const fixture of state.fixtures) {
    if (fixture.tableId === undefined) fixture.tableId = null;
    if (fixture.scheduledTime === undefined) fixture.scheduledTime = null;
    // Match timer (elapsed running clock) and shot clock (per-shot
    // countdown) - both start out idle/zeroed for fixtures saved before
    // this feature existed, exactly like a fresh fixture would.
    if (!fixture.timer) fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
    if (!fixture.shotClock) fixture.shotClock = { durationSeconds: 60, startedAt: null, running: false };
  }
  // Round visibility (Manage Fixtures / "Needs Your Confirmation" gating):
  // `visibleRounds` is the list of round numbers a non-admin account is
  // allowed to see or play at all - see the `isRoundVisible` helper and the
  // `POST /api/divisions/:id/rounds/:round/visibility` route in index.js.
  // Backfilling this for a division created before the feature existed
  // always starts empty (hidden) - even if fixtures were already generated -
  // so nothing is visible to players until an admin explicitly releases each
  // round from Manage Fixtures.
  for (const division of state.divisions) {
    if (division.visibleRounds === undefined) {
      division.visibleRounds = [];
    }
    // Closing a division early (POST /api/divisions/:id/close-early, or in
    // bulk via POST /api/leagues/:id/close-early) post-dates the original
    // schema too - every division created before it existed defaults to
    // 'active', exactly like a freshly-created one would.
    if (division.status === undefined) division.status = 'active';
    if (division.completedAt === undefined) division.completedAt = null;
    if (division.completedBy === undefined) division.completedBy = null;
    // Match length (raceTo) used to live on the league, shared by every
    // division under it. Now each division carries its own, so a division
    // created before this migration falls back to whatever race-to its own
    // league used to have (or 6, the old universal default, if even that's
    // missing) - existing fixtures are unaffected either way, this only
    // matters for fixtures generated after the migration.
    if (division.raceTo === undefined) {
      const owningLeague = state.leagues.find((l) => l.id === division.leagueId);
      division.raceTo = (owningLeague && owningLeague.format && owningLeague.format.raceTo) || 6;
    }
  }
  for (const fixture of state.fixtures) {
    // Set only on a fixture that was force-completed 0-0 by close-early
    // above, rather than actually played out - see closeOutstandingFixtures
    // in index.js.
    if (fixture.closedEarly === undefined) fixture.closedEarly = null;
    // Double-elim reserved bye slots (see generateDoubleElimFixtures) post-
    // date every fixture created before this feature existed, so none of
    // them are one - same as a freshly-generated bracket's real matches.
    if (fixture.reserved === undefined) fixture.reserved = false;
  }
  for (const user of state.users) {
    // Migrate the old single-value `role: 'player'|'admin'` field (from when
    // admin/player were separate login flows) into the current boolean
    // flags, which support being both at once.
    if (user.isAdmin === undefined) user.isAdmin = user.role === 'admin';
    if (user.isCaptain === undefined) user.isCaptain = false;
    // League Manager: scoped admin access to specific leagues via
    // league.managerUserIds, granted by an Overall Admin. Defaults to false
    // for every existing account, same as a freshly-created one.
    if (user.isLeagueManager === undefined) user.isLeagueManager = false;
    if (!user.status) user.status = 'active';
    if (user.playerId === undefined) user.playerId = null;
  }

  cache = { mtimeMs, state };
  return structuredClone(state);
}

export function writeDb(state) {
  ensureDataFile();
  writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  // Prime the cache with what was just written so the very next readDb()
  // (often milliseconds later, in the same or next request) doesn't have to
  // hit disk again - re-stat instead of assuming Date.now(), since mtime
  // resolution/rounding varies by OS/filesystem and has to match exactly
  // what the next readDb() will see.
  cache = { mtimeMs: statSync(DATA_FILE).mtimeMs, state: structuredClone(state) };
}

export function resetDb() {
  writeDb(structuredClone(EMPTY_STATE));
}
