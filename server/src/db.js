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
const DATA_DIR = path.join(__dirname, 'data');
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
  // Table scheduling: named tables belong to a league, and a fixture can be
  // assigned to one (plus a time) via POST /api/fixtures/:id/schedule - see
  // that route and the Arena display (GET /api/overlay/leagues/:id/arena).
  for (const league of state.leagues) {
    if (!league.tables) league.tables = [];
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
  }
  for (const user of state.users) {
    // Migrate the old single-value `role: 'player'|'admin'` field (from when
    // admin/player were separate login flows) into the current boolean
    // flags, which support being both at once.
    if (user.isAdmin === undefined) user.isAdmin = user.role === 'admin';
    if (user.isCaptain === undefined) user.isCaptain = false;
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
