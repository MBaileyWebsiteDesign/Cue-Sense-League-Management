// A drop-in, client-only stand-in for `../api.js`, used for the static
// GitHub Pages build (see vite.config.js / VITE_DEMO_MODE). There's no
// server to talk to on Pages - so instead of fetch() calls, every method
// here runs the same logic as the real Express routes in
// server/src/index.js directly against an in-memory copy of the seeded demo
// dataset (client/src/demo/demoData.json). Every method still returns a
// Promise that resolves/rejects exactly like the real network version (same
// shapes, same `.message` text on failure), so no page component needs to
// know or care which api it's talking to.
//
// This is a genuine port of the real route logic (not a simplified rewrite)
// so the demo behaves the same as a real deployment - it just keeps its
// state in the browser's localStorage instead of a server-side JSON file,
// which means a visitor's changes (scores, admin edits, new fixtures) stick
// around across a refresh in *their own browser*, but nobody else sees them
// and there's no way to reset short of clearing site data.
import demoDataSeed from './demoData.json';
import { generateRoundRobin, generateRoundRobinDouble } from './logic/roundRobin.js';
import { buildBracketRounds, buildDoubleElimBracket, RESERVED_SLOT } from './logic/bracket.js';
import { computeStandings } from './logic/standings.js';
import { computeTeamStandings } from './logic/teamStandings.js';
import { computeTourStandings } from './logic/tours.js';
import { buildPlayerProfile } from './logic/playerProfile.js';
import { recordAudit } from './logic/auditLog.js';

const uuid = () => crypto.randomUUID();
const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];
const STATUSES = ['active', 'suspended'];

// See server/src/index.js's MAX_RESERVED_BYE_COUNT / reservedByeCountFor
// comments - mirrored here so the demo build behaves the same way.
const MAX_RESERVED_BYE_COUNT = 4;
function reservedByeCountFor(entrantCount) {
  return Math.max(0, Math.min(MAX_RESERVED_BYE_COUNT, Math.floor(entrantCount / 2) - 1));
}
const SCHEDULING_TYPES = ['round_robin_single', 'round_robin_double', 'knockout_single_elim', 'knockout_double_elim', 'knockout_double_elim_ally'];
const DB_KEY = 'poolLeagueDemoDb';
const CURRENT_USER_KEY = 'poolLeagueDemoCurrentUserId';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Mirrors db.js's readDb() migration on the real server - backfills any
// collection/field a seed/save (or, for restoreBackup below, an uploaded
// export) predates. Shared by loadInitialDb() below and restoreBackup(), so
// there's exactly one place this list has to stay in sync with db.js.
function backfillState(base) {
  if (!base.pairings) base.pairings = [];
  if (!base.passwordResets) base.passwordResets = [];
  if (!base.divisions) base.divisions = [];
  if (!base.fixtures) base.fixtures = [];
  if (!base.tours) base.tours = [];
  if (!base.rollOfHonour) base.rollOfHonour = [];
  if (!base.apiKeys) base.apiKeys = [];
  if (!base.leaguePayments) base.leaguePayments = [];
  for (const league of base.leagues) {
    if (!league.tables) league.tables = [];
    if (!league.payment) {
      league.payment = { required: false, amount: 0, currency: 'GBP', windowStart: null, windowEnd: null };
    }
    if (!league.managerUserIds) league.managerUserIds = [];
    if (league.isOpenForRegistration === undefined) league.isOpenForRegistration = false;
  }
  for (const user of base.users) {
    if (user.isLeagueManager === undefined) user.isLeagueManager = false;
  }
  for (const fixture of base.fixtures) {
    if (fixture.tableId === undefined) fixture.tableId = null;
    if (fixture.scheduledTime === undefined) fixture.scheduledTime = null;
    if (!fixture.timer) fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
    if (!fixture.shotClock) fixture.shotClock = { durationSeconds: 60, startedAt: null, running: false };
  }
  for (const division of base.divisions) {
    if (division.visibleRounds === undefined) {
      division.visibleRounds = [];
    }
    if (division.isOpen === undefined) {
      division.isOpen = false;
    }
  }
  if (!base.joinRequests) base.joinRequests = [];
  if (!base.leagueInterests) base.leagueInterests = [];
  if (!base.featureRequests) base.featureRequests = [];
  return base;
}

// Bare, empty shape - mirrors db.js's EMPTY_STATE, used only by
// wipeAllData() below.
const EMPTY_DEMO_STATE = {
  leagues: [], divisions: [], players: [], teams: [], pairings: [], divisionPlayers: [],
  fixtures: [], users: [], auditLog: [], venues: [], passwordResets: [], tours: [],
  rollOfHonour: [], apiKeys: [], leaguePayments: [], joinRequests: [], leagueInterests: [], featureRequests: [],
};

function loadInitialDb() {
  let base;
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) base = JSON.parse(raw);
  } catch {
    // fall through to the bundled seed
  }
  if (!base) base = structuredClone(demoDataSeed);
  return backfillState(base);
}

// Browser-safe stand-in for Node's crypto.randomBytes(...).toString('hex'),
// used for password-reset tokens (see adminSendResetLink/resetPassword).
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let db = loadInitialDb();

function persist() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    // localStorage can be unavailable (private browsing, quota) - the demo
    // still works for the rest of the page load, it just won't survive a
    // refresh in that case.
  }
}
