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

// Which demo user is "logged in" right now - there's only ever one browser
// tab's worth of state, so this is just an id rather than a real session.
// Starts as the seeded demo account (an admin + captain, linked to the real
// "Matt Bailey" player so "My Account" has real fixtures to show).
let currentUserId = (() => {
  try {
    const stored = localStorage.getItem(CURRENT_USER_KEY);
    if (stored && db.users.some((u) => u.id === stored)) return stored;
  } catch {
    // ignore
  }
  return db.users[0]?.id || null;
})();

function setCurrentUser(userId) {
  currentUserId = userId;
  try {
    localStorage.setItem(CURRENT_USER_KEY, userId);
  } catch {
    // ignore
  }
}

function currentUser() {
  return db.users.find((u) => u.id === currentUserId) || null;
}

function adminLabel() {
  const user = currentUser();
  return user ? `${user.firstName} ${user.lastName}` : 'Demo Admin';
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

// Wraps a synchronous handler so it behaves like the real fetch-backed api.*
// methods: resolves with the return value (after persisting any change to
// localStorage), or rejects with an Error whose `.message` is the same
// user-facing text the real backend would have sent - every page's existing
// `catch (err) { setError(err.message) }` keeps working unmodified.
function op(fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      persist();
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

// ---------- account creation / profile helpers (ported from server/src/index.js) ----------

function createUserAccount(fields) {
  // Tolerates an empty/omitted lastName (e.g. a first-name-only Quick Add
  // walk-in) without leaving a stray trailing space in the linked player's
  // display name - mirrors server/src/index.js's createUserAccount.
  const fullName = `${fields.firstName} ${fields.lastName || ''}`.replace(/\s+/g, ' ').trim();
  let linkedPlayer = db.players.find((p) => p.name.toLowerCase() === fullName.toLowerCase());
  if (!linkedPlayer) {
    linkedPlayer = { id: uuid(), name: fullName };
    db.players.push(linkedPlayer);
  }
  const user = {
    id: uuid(),
    firstName: fields.firstName,
    lastName: fields.lastName,
    email: fields.email,
    passwordHash: fields.passwordHash || null,
    phone: fields.phone || '',
    teamName: fields.teamName,
    classification: fields.classification || null,
    isAdmin: !!fields.isAdmin,
    isCaptain: !!fields.isCaptain,
    isLeagueManager: !!fields.isLeagueManager,
    status: 'active',
    playerId: linkedPlayer.id,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  return user;
}

function syncLinkedPlayerName(user) {
  if (!user.playerId) return;
  const player = db.players.find((p) => p.id === user.playerId);
  if (player) player.name = `${user.firstName} ${user.lastName || ''}`.replace(/\s+/g, ' ').trim();
}

function applyProfileFields(user, fields) {
  const { firstName, lastName, email, phone, teamName, classification } = fields;
  if (firstName !== undefined) {
    if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
    user.firstName = firstName.trim();
  }
  if (lastName !== undefined) {
    if (!lastName || !lastName.trim()) throw new ApiError(400, 'Last name is required');
    user.lastName = lastName.trim();
  }
  if (email !== undefined) {
    if (!email || !email.trim()) throw new ApiError(400, 'Email is required');
    const normalized = email.trim().toLowerCase();
    if (db.users.some((u) => u.id !== user.id && u.email.toLowerCase() === normalized)) {
      throw new ApiError(409, 'An account with this email already exists');
    }
    user.email = email.trim();
  }
  if (phone !== undefined) user.phone = phone ? phone.trim() : '';
  if (teamName !== undefined) {
    if (!teamName || !teamName.trim()) throw new ApiError(400, 'Team name is required');
    user.teamName = teamName.trim();
  }
  if (classification !== undefined) {
    if (classification && !CLASSIFICATIONS.includes(classification)) {
      throw new ApiError(400, `classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    }
    user.classification = classification || null;
  }
  syncLinkedPlayerName(user);
}

// ---------- fixture / bracket helpers (ported from server/src/index.js) ----------

// Round visibility ("Manage Fixtures") - mirrors server/src/index.js's
// isRoundVisible. Admins always see/act on every round; everyone else only
// sees rounds the admin has released via setRoundVisibility below.
function isRoundVisible(division, round) {
  return !!division && Array.isArray(division.visibleRounds) && division.visibleRounds.includes(round);
}

function hydrateDivision(division) {
  // Filtered once here, then reused below - mirrors the same fix in
  // server/src/index.js's hydrateDivision (see that copy for the full note):
  // computeStandings/computeTeamStandings used to each re-filter the whole
  // db.fixtures array by divisionId themselves instead of reusing this.
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const leagueName = league ? league.name : null;

  // See server/src/index.js's hydrateDivision for the full note - mirrors
  // `bothEntrantsKnown` here too so the demo build's fixture-list views can
  // tell "genuinely scheduled" apart from "still waiting on an earlier
  // knockout round's winner" the same way the live server does.
  const isTeamsDivision = division.entryType === 'teams';
  const displayFixtures = fixtures.map((f) => ({
    ...f,
    bothEntrantsKnown: isTeamsDivision
      ? !!(f.homeTeamId && f.awayTeamId)
      : !!(f.homePlayerId && f.awayPlayerId),
  }));
  // See server/src/index.js's hydrateDivision for the full note.
  const totalRounds = division.scheduling === 'knockout_single_elim' && fixtures.length > 0
    ? Math.max(...fixtures.map((f) => f.round))
    : null;

  let hydrated;
  if (division.entryType === 'teams') {
    const teams = db.teams
      .filter((t) => division.teamIds.includes(t.id))
      .map((t) => ({ ...t, players: db.players.filter((p) => t.playerIds.includes(p.id)) }));
    const standings = computeTeamStandings(division, fixtures, db.teams);
    hydrated = { ...division, leagueName, teams, fixtures: displayFixtures, standings };
  } else if (division.entryType === 'doubles') {
    const pairings = db.pairings
      .filter((p) => division.pairingIds.includes(p.id))
      .map((p) => ({ ...p, players: db.players.filter((pl) => p.playerIds.includes(pl.id)) }));
    const standings = computeStandings({ ...division, playerIds: division.pairingIds }, fixtures, pairings);
    hydrated = { ...division, leagueName, pairings, fixtures: displayFixtures, standings };
  } else {
    const players = db.players.filter((p) => division.playerIds.includes(p.id));
    const standings = computeStandings(division, fixtures, db.players);
    hydrated = { ...division, leagueName, players, fixtures: displayFixtures, standings };
  }
  hydrated.totalRounds = totalRounds;
  hydrated.leaguePayment = league ? league.payment : null;
  hydrated.leagueManagerUserIds = league && Array.isArray(league.managerUserIds) ? league.managerUserIds : [];

  // Roll of Honour - mirrors server/src/index.js's
  // recordChampionIfDivisionComplete (see that copy for the full note on why
  // this is checked centrally here instead of at every fixture-completion
  // call site).
  recordChampionIfDivisionComplete(division, hydrated);

  return hydrated;
}

function recordChampionIfDivisionComplete(division, hydrated) {
  if (!division.fixturesGenerated) return;
  const fixtures = hydrated.fixtures;
  if (fixtures.length === 0) return;
  if (fixtures.some((f) => f.status !== 'completed')) return;
  if (db.rollOfHonour.some((r) => r.divisionId === division.id)) return;

  const idField = division.entryType === 'teams' ? 'teamId' : 'playerId';
  const nameField = division.entryType === 'teams' ? 'teamName' : 'playerName';
  let championId = null;

  if (division.scheduling === 'knockout_double_elim' || division.scheduling === 'knockout_double_elim_ally') {
    const grandFinal = fixtures.find((f) => f.bracketRole === 'grand_final');
    if (!grandFinal) return;
    const finalFixture = grandFinal.resetFixtureId
      ? fixtures.find((f) => f.id === grandFinal.resetFixtureId)
      : grandFinal;
    if (!finalFixture || finalFixture.status !== 'completed') return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else if (division.scheduling === 'knockout_single_elim') {
    const finalFixture = fixtures.find((f) => !f.nextFixtureId);
    if (!finalFixture) return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else {
    // A top standing with 0 points means nobody actually won a match (the
    // division was closed early before any result was played out) - see
    // the matching check in server/src/index.js.
    const top = hydrated.standings[0];
    if (!top || top.points === 0) return;
    championId = top[idField];
  }
  if (!championId) return;

  const championRow = hydrated.standings.find((row) => row[idField] === championId);
  const championName = championRow ? championRow[nameField] : 'Unknown';
  const league = db.leagues.find((l) => l.id === division.leagueId);

  db.rollOfHonour.push({
    id: uuid(),
    leagueId: division.leagueId,
    leagueName: league ? league.name : 'Unknown league',
    divisionId: division.id,
    divisionName: division.name,
    entryType: division.entryType,
    scheduling: division.scheduling,
    championId,
    championName,
    recordedAt: new Date().toISOString(),
  });
  // Not wrapped in persist()/op() - this is a side effect of a read
  // (hydrateDivision runs on GETs too), so it saves immediately the same way
  // server/src/db.js's writeDb() does inside recordChampionIfDivisionComplete,
  // rather than waiting for whatever op() the caller happens to be inside.
  persist();
}

// Force-completes every not-yet-completed fixture in a division at 0-0 (0
// legs for a team fixture), no winner - mirrors server/src/index.js's
// closeOutstandingFixtures. Used by both closeDivisionEarly (one division)
// and closeLeagueEarly (every division in a league) below.
function closeOutstandingFixtures(division, actorLabel) {
  const outstanding = db.fixtures.filter((f) => f.divisionId === division.id && f.status !== 'completed');
  const closedAt = new Date().toISOString();

  for (const fixture of outstanding) {
    if (division.entryType === 'teams') {
      fixture.homeLegsWon = 0;
      fixture.awayLegsWon = 0;
      fixture.winnerTeamId = null;
      fixture.legs = fixture.legs.map((leg) => (leg.status === 'completed' ? leg : {
        ...leg,
        frames: [],
        homeFrameScore: 0,
        awayFrameScore: 0,
        status: 'completed',
        winnerPlayerId: null,
      }));
    } else {
      fixture.homeFrameScore = 0;
      fixture.awayFrameScore = 0;
      fixture.frames = [];
      fixture.winnerPlayerId = null;
    }
    fixture.status = 'completed';
    fixture.disputeReason = null;
    fixture.closedEarly = { at: closedAt, by: actorLabel };
  }

  if (outstanding.length > 0 || division.status !== 'completed') {
    division.status = 'completed';
    division.completedAt = closedAt;
    division.completedBy = actorLabel;
  }

  return outstanding.length;
}

// Round visibility: normally every round starts hidden, released one at a
// time from Manage Fixtures - but generating fixtures asks up front whether
// to skip that entirely and make the whole season visible immediately.
// Mirrors server/src/index.js's markAllRoundsVisible. Shared by both
// generateFixtures (one division) and adminGenerateSeason (every division
// in a league at once) below.
function markAllRoundsVisible(division) {
  const rounds = new Set(db.fixtures.filter((f) => f.divisionId === division.id).map((f) => f.round));
  division.visibleRounds = Array.from(rounds).sort((a, b) => a - b);
}

// Ported from server/src/index.js's buildOverlayFixture - normalizes
// singles/teams/doubles fixtures into one { home, away } shape for the OBS
// overlay and Arena display pages. Shared by both getOverlayFixture and
// getArena below so there's exactly one place that does this normalization.
function buildOverlayFixture(fixture) {
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  const isTeams = division.entryType === 'teams';
  const isDoubles = division.entryType === 'doubles';
  const BRACKET_ROLE_LABEL = {
    winners: 'Winners Bracket',
    losers: 'Losers Bracket',
    grand_final: 'Grand Final',
    grand_final_reset: 'Grand Final - Bracket Reset',
  };
  const roundLabel = fixture.bracketRole && fixture.bracketRole !== 'single'
    ? (BRACKET_ROLE_LABEL[fixture.bracketRole] || `Round ${fixture.round}`)
    : `Round ${fixture.round}`;

  let home, away, raceTo = null, legsTotal = null, winner = null, bothEntrantsKnown;

  if (isTeams) {
    const homeTeam = fixture.homeTeamId ? db.teams.find((t) => t.id === fixture.homeTeamId) : null;
    const awayTeam = fixture.awayTeamId ? db.teams.find((t) => t.id === fixture.awayTeamId) : null;
    home = { name: homeTeam ? homeTeam.name : 'TBD', subLabel: null, score: fixture.homeLegsWon };
    away = { name: awayTeam ? awayTeam.name : 'TBD', subLabel: null, score: fixture.awayLegsWon };
    legsTotal = fixture.legs.length;
    bothEntrantsKnown = !!(fixture.homeTeamId && fixture.awayTeamId);
    if (fixture.status === 'completed') {
      winner = fixture.winnerTeamId === null ? 'draw' : (fixture.winnerTeamId === fixture.homeTeamId ? 'home' : 'away');
    }
  } else if (isDoubles) {
    const nameOfPairing = (pairing) => (pairing
      ? { name: pairing.name, subLabel: db.players.filter((p) => pairing.playerIds.includes(p.id)).map((p) => p.name).join(' & ') }
      : { name: 'TBD', subLabel: null });
    const homePairing = fixture.homePlayerId ? db.pairings.find((p) => p.id === fixture.homePlayerId) : null;
    const awayPairing = fixture.awayPlayerId ? db.pairings.find((p) => p.id === fixture.awayPlayerId) : null;
    home = { ...nameOfPairing(homePairing), score: fixture.homeFrameScore };
    away = { ...nameOfPairing(awayPairing), score: fixture.awayFrameScore };
    raceTo = fixture.raceTo;
    bothEntrantsKnown = !!(fixture.homePlayerId && fixture.awayPlayerId);
    if (fixture.status === 'completed') {
      winner = fixture.winnerPlayerId === null ? 'draw' : (fixture.winnerPlayerId === fixture.homePlayerId ? 'home' : 'away');
    }
  } else {
    const homePlayer = fixture.homePlayerId ? db.players.find((p) => p.id === fixture.homePlayerId) : null;
    const awayPlayer = fixture.awayPlayerId ? db.players.find((p) => p.id === fixture.awayPlayerId) : null;
    home = { name: homePlayer ? homePlayer.name : 'TBD', subLabel: null, score: fixture.homeFrameScore };
    away = { name: awayPlayer ? awayPlayer.name : 'TBD', subLabel: null, score: fixture.awayFrameScore };
    raceTo = fixture.raceTo;
    bothEntrantsKnown = !!(fixture.homePlayerId && fixture.awayPlayerId);
    if (fixture.status === 'completed') {
      winner = fixture.winnerPlayerId === null ? 'draw' : (fixture.winnerPlayerId === fixture.homePlayerId ? 'home' : 'away');
    }
  }

  return {
    fixtureId: fixture.id,
    leagueName: league ? league.name : null,
    divisionName: division ? division.name : null,
    roundLabel,
    entryType: division.entryType,
    status: fixture.status,
    bothEntrantsKnown,
    home,
    away,
    raceTo,
    legsTotal,
    winner,
  };
}

// ---------- League payment wall helpers (mirrors server/src/index.js) ----------
function normalizePaymentConfig(input) {
  const required = !!(input && input.required);
  if (!required) {
    return { required: false, amount: 0, currency: 'GBP', windowStart: null, windowEnd: null };
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'Payment amount must be a number greater than 0');
  }
  const windowStart = input.windowStart || null;
  const windowEnd = input.windowEnd || null;
  if (windowStart && windowEnd && new Date(windowEnd) < new Date(windowStart)) {
    throw new ApiError(400, 'Payment window end date cannot be before the start date');
  }
  return {
    required: true,
    amount,
    currency: (input.currency || 'GBP').toUpperCase(),
    windowStart,
    windowEnd,
  };
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(amount);
  } catch {
    return `${amount} ${currency || 'GBP'}`;
  }
}

// See server/src/index.js's assertPaymentCleared for the full note - not
// called from adminImportSeasonPlayers below for the same chicken-and-egg
// reason documented there.
function assertPaymentCleared(division, playerId) {
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (!league || !league.payment || !league.payment.required) return;
  const record = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === playerId);
  if (record && ['confirmed', 'waived'].includes(record.status)) return;
  const player = db.players.find((p) => p.id === playerId);
  throw new ApiError(
    402,
    `${player ? player.name : 'This player'} hasn't paid the ${formatMoney(league.payment.amount, league.payment.currency)} entry fee for "${league.name}" yet - confirm or waive their payment from the league's Payments tab before adding them.`
  );
}

function registeredPlayers() {
  const linkedPlayerIds = new Set(
    db.users.filter((u) => u.status === 'active' && u.playerId).map((u) => u.playerId)
  );
  return db.players
    .filter((p) => linkedPlayerIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function makeSinglesFixture({ league, division, round }) {
  return {
    id: uuid(),
    leagueId: league.id,
    divisionId: division.id,
    round,
    scheduledDate: null,
    tableId: null,
    scheduledTime: null,
    timer: { startedAt: null, elapsedSeconds: 0, running: false },
    shotClock: { durationSeconds: 60, startedAt: null, running: false },
    homePlayerId: null,
    awayPlayerId: null,
    raceTo: league.format.raceTo,
    frames: [],
    homeFrameScore: 0,
    awayFrameScore: 0,
    status: 'scheduled',
    winnerPlayerId: null,
    nextFixtureId: null,
    nextFixtureSlot: null,
    // Knockout only - see server/src/index.js's byeSlot comment.
    byeSlot: null,
    // See server/src/index.js's reserved comment.
    reserved: false,
    bracketRole: 'single', // 'single' | 'winners' | 'losers' | 'grand_final' | 'grand_final_reset'
    loserNextFixtureId: null,
    loserNextFixtureSlot: null,
    resetFixtureId: null,
  };
}

function makeTeamFixture({ league, division, round }) {
  const legs = Array.from({ length: division.legsPerMatch }, (_, i) => ({
    legNumber: i + 1,
    homePlayerId: null,
    awayPlayerId: null,
    raceTo: league.format.raceTo,
    frames: [],
    homeFrameScore: 0,
    awayFrameScore: 0,
    status: 'pending',
    winnerPlayerId: null,
  }));
  return {
    id: uuid(),
    leagueId: league.id,
    divisionId: division.id,
    round,
    scheduledDate: null,
    tableId: null,
    scheduledTime: null,
    timer: { startedAt: null, elapsedSeconds: 0, running: false },
    shotClock: { durationSeconds: 60, startedAt: null, running: false },
    homeTeamId: null,
    awayTeamId: null,
    legs,
    homeLegsWon: 0,
    awayLegsWon: 0,
    status: 'scheduled',
    winnerTeamId: null,
    nextFixtureId: null,
    nextFixtureSlot: null,
    byeSlot: null,
    reserved: false,
    bracketRole: 'single',
    loserNextFixtureId: null,
    loserNextFixtureSlot: null,
    resetFixtureId: null,
  };
}

function generateRoundRobinFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const rounds = division.scheduling === 'round_robin_double'
    ? generateRoundRobinDouble(entrantIds)
    : generateRoundRobin(entrantIds);
  rounds.forEach((pairs, roundIndex) => {
    pairs.forEach(([a, b]) => {
      const fixture = makeFixture({ league, division, round: roundIndex + 1 });
      if (division.entryType === 'teams') {
        fixture.homeTeamId = a;
        fixture.awayTeamId = b;
      } else {
        fixture.homePlayerId = a;
        fixture.awayPlayerId = b;
      }
      db.fixtures.push(fixture);
    });
  });
}

function resolveByeIfNeeded(division, fixture) {
  if (fixture.reserved) return;
  if (division.entryType === 'teams') {
    if (fixture.homeTeamId && fixture.awayTeamId) return;
    const winnerTeamId = fixture.homeTeamId || fixture.awayTeamId;
    if (!winnerTeamId) return;
    fixture.status = 'completed';
    fixture.winnerTeamId = winnerTeamId;
    propagateWinner(division, fixture, winnerTeamId);
  } else {
    if (fixture.homePlayerId && fixture.awayPlayerId) return;
    const winnerPlayerId = fixture.homePlayerId || fixture.awayPlayerId;
    if (!winnerPlayerId) return;
    fixture.status = 'completed';
    fixture.winnerPlayerId = winnerPlayerId;
    propagateWinner(division, fixture, winnerPlayerId);
  }
}

function propagateWinner(division, fixture, winnerId) {
  if (!fixture.nextFixtureId) return;
  const next = db.fixtures.find((f) => f.id === fixture.nextFixtureId);
  if (!next) return;
  if (division.entryType === 'teams') {
    if (fixture.nextFixtureSlot === 'home') next.homeTeamId = winnerId;
    else next.awayTeamId = winnerId;
  } else if (fixture.nextFixtureSlot === 'home') {
    next.homePlayerId = winnerId;
  } else {
    next.awayPlayerId = winnerId;
  }
  // See server/src/index.js's propagateWinner comment - `next` might
  // structurally never receive a second entrant (byeSlot set), in which
  // case resolve it immediately and keep the chain going.
  if (next.byeSlot) resolveByeIfNeeded(division, next);
}

function generateKnockoutFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const bracketRounds = buildBracketRounds(entrantIds, { reservedCount });

  const fixturesByRound = bracketRounds.map((pairs, roundIndex) =>
    pairs.map(() => makeFixture({ league, division, round: roundIndex + 1 }))
  );

  // See server/src/index.js's generateKnockoutFixtures comment - a round
  // with an odd box count leaves its last next-round box's 'away' slot
  // permanently unlinked; mark it byeSlot so propagateWinner knows to
  // auto-resolve it the moment its lone real feeder concludes.
  for (let round = 0; round < fixturesByRound.length - 1; round++) {
    const thisRound = fixturesByRound[round];
    const nextRound = fixturesByRound[round + 1];
    thisRound.forEach((fixture, i) => {
      const next = nextRound[Math.floor(i / 2)];
      fixture.nextFixtureId = next.id;
      fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
    });
    if (thisRound.length % 2 === 1) {
      nextRound[nextRound.length - 1].byeSlot = 'away';
    }
  }

  bracketRounds[0].forEach(([a, b], i) => {
    const fixture = fixturesByRound[0][i];
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

  const allFixtures = fixturesByRound.flat();
  allFixtures.forEach((f) => db.fixtures.push(f));
  fixturesByRound[0].forEach((fixture) => resolveByeIfNeeded(division, fixture));
}

// Double-elimination only: sends the LOSER of a winners-bracket fixture down
// into its assigned losers-bracket slot (mirrors propagateWinner). No-op for
// anything other than a winners-bracket fixture - a losers-bracket loss is
// simply an elimination, nowhere further to go.
function propagateLoser(division, fixture, loserId) {
  if (fixture.bracketRole !== 'winners' || !fixture.loserNextFixtureId || !loserId) return;
  const dest = db.fixtures.find((f) => f.id === fixture.loserNextFixtureId);
  if (!dest) return;
  if (division.entryType === 'teams') {
    if (fixture.loserNextFixtureSlot === 'home') dest.homeTeamId = loserId;
    else dest.awayTeamId = loserId;
  } else if (fixture.loserNextFixtureSlot === 'home') {
    dest.homePlayerId = loserId;
  } else {
    dest.awayPlayerId = loserId;
  }
  // See propagateWinner's byeSlot comment - the losers-bracket destination
  // might structurally never receive a second entrant either. Resolve it
  // immediately and keep the chain going if so.
  if (dest.byeSlot) resolveByeIfNeeded(division, dest);
}

// Double-elimination only: the losers-bracket champion enters the Grand
// Final with one life already spent, the winners-bracket champion with
// none - so if the losers-bracket entrant (always the "away" slot - see
// generateDoubleElimFixtures) wins the Grand Final, a single decider
// ("bracket reset") is required to settle the title. No-op once a reset has
// already been created, or if the winners-bracket (home) side won outright.
function checkGrandFinalReset(division, fixture) {
  if (fixture.bracketRole !== 'grand_final' || fixture.status !== 'completed' || fixture.resetFixtureId) return;
  const isTeams = division.entryType === 'teams';
  const winnerId = isTeams ? fixture.winnerTeamId : fixture.winnerPlayerId;
  const awayId = isTeams ? fixture.awayTeamId : fixture.awayPlayerId;
  if (!winnerId || winnerId !== awayId) return;

  const league = db.leagues.find((l) => l.id === division.leagueId);
  const makeFixture = isTeams ? makeTeamFixture : makeSinglesFixture;
  const reset = makeFixture({ league, division, round: fixture.round + 1 });
  reset.bracketRole = 'grand_final_reset';
  if (isTeams) {
    reset.homeTeamId = fixture.homeTeamId;
    reset.awayTeamId = fixture.awayTeamId;
  } else {
    reset.homePlayerId = fixture.homePlayerId;
    reset.awayPlayerId = fixture.awayPlayerId;
  }
  db.fixtures.push(reset);
  fixture.resetFixtureId = reset.id;
}

// Double-elimination fixture generation - see server/src/index.js's
// generateDoubleElimFixtures for the full design notes (this is a direct
// port, adapted only for demoApi's closed-over `db` instead of a db param).
function generateDoubleElimFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ----
  const wbByRound = winnersRounds.map((pairs, roundIndex) =>
    pairs.map(() => {
      const f = makeFixture({ league, division, round: roundIndex + 1 });
      f.bracketRole = 'winners';
      return f;
    })
  );
  for (let round = 0; round < wbByRound.length - 1; round++) {
    const thisRound = wbByRound[round];
    const nextRound = wbByRound[round + 1];
    thisRound.forEach((fixture, i) => {
      const next = nextRound[Math.floor(i / 2)];
      fixture.nextFixtureId = next.id;
      fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
    });
    if (thisRound.length % 2 === 1) {
      nextRound[nextRound.length - 1].byeSlot = 'away';
    }
  }
  winnersRounds[0].forEach(([a, b], i) => {
    const fixture = wbByRound[0][i];
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

  // ---- Losers bracket ----
  const lbByRound = losersRounds.map((round, roundIndex) =>
    Array.from({ length: round.boxCount }, () => {
      const f = makeFixture({ league, division, round: wbByRound.length + roundIndex + 1 });
      f.bracketRole = 'losers';
      return f;
    })
  );
  losersRounds.forEach((round, i) => {
    if (round.hasBye) lbByRound[i][lbByRound[i].length - 1].byeSlot = 'away';
  });
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    current.forEach((fixture, i) => {
      if (nextIsMergeRound) {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      } else {
        const target = next[Math.floor(i / 2)];
        fixture.nextFixtureId = target.id;
        fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
      }
    });
  }
  // Wire each winners round's losers into their losers-bracket destination
  // - see server/src/index.js's generateDoubleElimFixtures for the full
  // comments (this is a direct port).
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    wbSourceFixtures.forEach((fixture, i) => {
      let dest, slot;
      if (lbRoundIndex === 0) {
        dest = lbDestFixtures[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'home' : 'away';
      } else if (i < lbRound.crossMatches) {
        dest = lbDestFixtures[i];
        slot = 'away';
      } else {
        const j = i - lbRound.crossMatches;
        dest = lbDestFixtures[lbRound.crossMatches + Math.floor(j / 2)];
        slot = j % 2 === 0 ? 'home' : 'away';
      }
      fixture.loserNextFixtureId = dest.id;
      fixture.loserNextFixtureSlot = slot;
    });
  });

  // ---- Grand Final ----
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
  const grandFinal = makeFixture({ league, division, round: wbByRound.length + lbByRound.length + 1 });
  grandFinal.bracketRole = 'grand_final';
  wbFinal.nextFixtureId = grandFinal.id;
  wbFinal.nextFixtureSlot = 'home';
  lbFinal.nextFixtureId = grandFinal.id;
  lbFinal.nextFixtureSlot = 'away';

  const allFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allFixtures.forEach((f) => db.fixtures.push(f));
  // Resolve any non-reserved winners-bracket round-1 byes - see
  // server/src/index.js's matching comment.
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(division, fixture));
}

// "Ally Knockout (Double elimination)" - the demo/sandbox mirror of
// server/src/index.js's generateAllyDoubleElimFixtures. Its own function
// body (a direct port, not a call into generateDoubleElimFixtures above) so
// this format has a genuinely independent scheduling type here too, same
// as the real backend - see that file's comment for why.
function generateAllyDoubleElimFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ----
  const wbByRound = winnersRounds.map((pairs, roundIndex) =>
    pairs.map(() => {
      const f = makeFixture({ league, division, round: roundIndex + 1 });
      f.bracketRole = 'winners';
      return f;
    })
  );
  for (let round = 0; round < wbByRound.length - 1; round++) {
    const thisRound = wbByRound[round];
    const nextRound = wbByRound[round + 1];
    thisRound.forEach((fixture, i) => {
      const next = nextRound[Math.floor(i / 2)];
      fixture.nextFixtureId = next.id;
      fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
    });
    if (thisRound.length % 2 === 1) {
      nextRound[nextRound.length - 1].byeSlot = 'away';
    }
  }
  winnersRounds[0].forEach(([a, b], i) => {
    const fixture = wbByRound[0][i];
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

  // ---- Losers bracket ----
  const lbByRound = losersRounds.map((round, roundIndex) =>
    Array.from({ length: round.boxCount }, () => {
      const f = makeFixture({ league, division, round: wbByRound.length + roundIndex + 1 });
      f.bracketRole = 'losers';
      return f;
    })
  );
  losersRounds.forEach((round, i) => {
    if (round.hasBye) lbByRound[i][lbByRound[i].length - 1].byeSlot = 'away';
  });
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    current.forEach((fixture, i) => {
      if (nextIsMergeRound) {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      } else {
        const target = next[Math.floor(i / 2)];
        fixture.nextFixtureId = target.id;
        fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
      }
    });
  }
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    wbSourceFixtures.forEach((fixture, i) => {
      let dest, slot;
      if (lbRoundIndex === 0) {
        dest = lbDestFixtures[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'home' : 'away';
      } else if (i < lbRound.crossMatches) {
        dest = lbDestFixtures[i];
        slot = 'away';
      } else {
        const j = i - lbRound.crossMatches;
        dest = lbDestFixtures[lbRound.crossMatches + Math.floor(j / 2)];
        slot = j % 2 === 0 ? 'home' : 'away';
      }
      fixture.loserNextFixtureId = dest.id;
      fixture.loserNextFixtureSlot = slot;
    });
  });

  // ---- Grand Final ----
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
  const grandFinal = makeFixture({ league, division, round: wbByRound.length + lbByRound.length + 1 });
  grandFinal.bracketRole = 'grand_final';
  wbFinal.nextFixtureId = grandFinal.id;
  wbFinal.nextFixtureSlot = 'home';
  lbFinal.nextFixtureId = grandFinal.id;
  lbFinal.nextFixtureSlot = 'away';

  const allAllyFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allAllyFixtures.forEach((f) => db.fixtures.push(f));
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(division, fixture));
}

function assignScheduledDates(division, startDate, gapDays) {
  if (!startDate || !gapDays) return;
  const base = new Date(`${startDate}T00:00:00`);
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  for (const fixture of fixtures) {
    const date = new Date(base);
    date.setDate(date.getDate() + (fixture.round - 1) * Number(gapDays));
    fixture.scheduledDate = date.toISOString().slice(0, 10);
  }
}

function recomputeTeamFixture(division, fixture) {
  const homeLegsWon = fixture.legs.filter((l) => l.status === 'completed' && l.winnerPlayerId === l.homePlayerId).length;
  const awayLegsWon = fixture.legs.filter((l) => l.status === 'completed' && l.winnerPlayerId === l.awayPlayerId).length;
  fixture.homeLegsWon = homeLegsWon;
  fixture.awayLegsWon = awayLegsWon;

  const totalLegs = fixture.legs.length;
  const majority = Math.floor(totalLegs / 2) + 1;
  const allLegsDone = fixture.legs.every((l) => l.status === 'completed');
  const wasCompleted = fixture.status === 'completed';

  if (homeLegsWon >= majority) {
    fixture.status = 'completed';
    fixture.winnerTeamId = fixture.homeTeamId;
  } else if (awayLegsWon >= majority) {
    fixture.status = 'completed';
    fixture.winnerTeamId = fixture.awayTeamId;
  } else if (allLegsDone) {
    fixture.status = 'completed';
    fixture.winnerTeamId = homeLegsWon === awayLegsWon ? null : (homeLegsWon > awayLegsWon ? fixture.homeTeamId : fixture.awayTeamId);
  } else {
    fixture.status = fixture.legs.some((l) => l.status !== 'pending') ? 'in_progress' : 'scheduled';
    fixture.winnerTeamId = null;
  }

  if (!wasCompleted && fixture.status === 'completed' && fixture.winnerTeamId) {
    propagateWinner(division, fixture, fixture.winnerTeamId);
    const loserTeamId = fixture.winnerTeamId === fixture.homeTeamId ? fixture.awayTeamId : fixture.homeTeamId;
    propagateLoser(division, fixture, loserTeamId);
    checkGrandFinalReset(division, fixture);
  }
}

function findTeamFixtureAndLeg(fixtureId, legNumber) {
  const fixture = db.fixtures.find((f) => f.id === fixtureId);
  if (!fixture || !fixture.legs) throw new ApiError(404, 'Team fixture not found');
  const leg = fixture.legs.find((l) => l.legNumber === Number(legNumber));
  if (!leg) throw new ApiError(404, 'Leg not found');
  return { fixture, leg };
}

// Mirrors server/src/index.js's isAwayEntrant/isHomeEntrant - whether the
// given playerId is (or is part of, for doubles pairings) the home/away side
// of a singles or doubles fixture. Used by the mutual result-confirmation
// and no-show-claim logic below.
function isAwayEntrant(division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.awayPlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.awayPlayerId === playerId;
}

function isHomeEntrant(division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.homePlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.homePlayerId === playerId;
}

// Synchronous session lookup for AuthContext's initial state - there's no
// server round-trip to await in demo mode, so a visitor is "logged in" the
// instant the page loads rather than seeing a login screen first.
export function getDemoSession() {
  const user = currentUser();
  if (!user) return null;
  return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
}

// ---------- the api surface (same method names/signatures as ../api.js) ----------

export const demoApi = {
  login: op((email, password) => {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
    // Real passwords aren't part of the bundled demo data (nothing to check
    // them against), so any password is accepted for a known demo account -
    // this is a public, throwaway playground, not a real login boundary.
    if (!user) throw new ApiError(401, 'Invalid email or password');
    if (user.status === 'suspended') throw new ApiError(403, 'This account has been suspended');
    setCurrentUser(user.id);
    return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
  }),

  // Public - consumes a demo password-reset token (see adminSendResetLink).
  resetPassword: op((token, newPassword) => {
    const reset = db.passwordResets.find((r) => r.token === token);
    if (!reset) throw new ApiError(404, 'This reset link is invalid');
    if (reset.usedAt) throw new ApiError(400, 'This reset link has already been used - ask an admin to send a new one');
    if (Date.now() > reset.expiresAt) throw new ApiError(400, 'This reset link has expired - ask an admin to send a new one');
    const user = db.users.find((u) => u.id === reset.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    reset.usedAt = new Date().toISOString();
    // Demo mode never checks password hashes at login (see login() below),
    // so there's nothing real to update here - the reset flow itself (token
    // validity, single-use, expiry) still works exactly like the real app.
    return { ok: true };
  }),

  register: op((data) => {
    const {
      firstName, lastName, email, phone = '', teamName = '', classification = null,
    } = data;
    if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
    if (!lastName || !lastName.trim()) throw new ApiError(400, 'Last name is required');
    if (!email || !email.trim()) throw new ApiError(400, 'Email is required');
    if (classification && !CLASSIFICATIONS.includes(classification)) {
      throw new ApiError(400, `classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      throw new ApiError(409, 'An account with this email already exists');
    }
    const user = createUserAccount({
      firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(),
      phone: phone ? phone.trim() : '', teamName: teamName ? teamName.trim() : '',
      classification: classification || null, isAdmin: false, isCaptain: false,
    });
    setCurrentUser(user.id);
    return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
  }),

  getMe: op(() => publicUser(currentUser())),

  // Mirrors server/src/index.js's GET /api/users/me/leagues - static
  // read-only league/division membership shown in the Player Portal's "Your
  // Details" section.
  getMyLeagueMembership: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const divisions = db.divisions.filter((d) =>
      (d.playerIds || []).includes(playerId) ||
      (d.teamIds || []).some((id) => myTeamIds.includes(id)) ||
      (d.pairingIds || []).some((id) => myPairingIds.includes(id))
    );
    return divisions.map((d) => {
      const league = db.leagues.find((l) => l.id === d.leagueId);
      return {
        leagueId: d.leagueId,
        leagueName: league?.name || 'Unknown league',
        divisionId: d.id,
        divisionName: d.name,
        status: d.status || 'active',
      };
    });
  }),

  updateMe: op((data) => {
    const user = currentUser();
    applyProfileFields(user, data);
    return publicUser(user);
  }),

  changePassword: op(() => ({ ok: true })),

  getMyFixtures: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const fixtures = db.fixtures.filter((f) => {
      if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
      if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId)) return true;
      if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
      return false;
    });
    // Even a fixture you're actually in doesn't show up here until its round
    // is released - see isRoundVisible above. Admins see everything.
    const visibleFixtures = user.isAdmin
      ? fixtures
      : fixtures.filter((f) => isRoundVisible(db.divisions.find((d) => d.id === f.divisionId), f.round));
    const enriched = visibleFixtures.map((f) => {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      const isTeams = !!f.legs;
      const isDoubles = division?.entryType === 'doubles';
      const opponentId = isTeams
        ? (myTeamIds.includes(f.homeTeamId) ? f.awayTeamId : f.homeTeamId)
        : isDoubles
          ? (myPairingIds.includes(f.homePlayerId) ? f.awayPlayerId : f.homePlayerId)
          : (f.homePlayerId === playerId ? f.awayPlayerId : f.homePlayerId);
      const opponentName = isTeams
        ? db.teams.find((t) => t.id === opponentId)?.name
        : isDoubles
          ? db.pairings.find((p) => p.id === opponentId)?.name
          : db.players.find((p) => p.id === opponentId)?.name;
      return {
        id: f.id,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        scheduledDate: f.scheduledDate || null,
        opponentName: opponentName || 'TBD',
      };
    });
    enriched.sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || '') || a.round - b.round);
    return enriched;
  }),

  // A player's own results currently awaiting THEIR confirmation - mirrors
  // server/src/index.js's GET /api/users/me/pending-confirmations (see that
  // route for the full design note). Powers the "Needs Your Confirmation"
  // panel on the Player Portal.
  getMyPendingConfirmations: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const results = [];

    for (const f of db.fixtures) {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      // Same round-visibility gate as everywhere else - see isRoundVisible.
      if (!user.isAdmin && !isRoundVisible(division, f.round)) continue;

      if (f.legs) {
        const homeTeam = db.teams.find((t) => t.id === f.homeTeamId);
        const awayTeam = db.teams.find((t) => t.id === f.awayTeamId);
        for (const leg of f.legs) {
          if (leg.status !== 'pending_confirmation') continue;
          const isHome = leg.homePlayerId === playerId;
          const isAway = leg.awayPlayerId === playerId;
          if (!isHome && !isAway) continue;
          if (isHome && leg.homeConfirmed) continue;
          if (isAway && leg.awayConfirmed) continue;
          const opponentPlayer = db.players.find((p) => p.id === (isHome ? leg.awayPlayerId : leg.homePlayerId));
          results.push({
            fixtureId: f.id,
            legNumber: leg.legNumber,
            leagueName: league?.name,
            divisionName: division?.name,
            round: f.round,
            opponentName: opponentPlayer?.name || (isHome ? awayTeam?.name : homeTeam?.name) || 'TBD',
            scoreLabel: `${leg.homeFrameScore}-${leg.awayFrameScore} frames`,
          });
        }
        continue;
      }

      if (f.status !== 'pending_confirmation') continue;
      const isDoubles = division?.entryType === 'doubles';
      const isHome = isHomeEntrant(division, f, playerId);
      const isAway = isAwayEntrant(division, f, playerId);
      if (!isHome && !isAway) continue;
      if (isHome && f.homeConfirmed) continue;
      if (isAway && f.awayConfirmed) continue;
      const opponentId = isHome ? f.awayPlayerId : f.homePlayerId;
      const opponentName = isDoubles
        ? db.pairings.find((p) => p.id === opponentId)?.name
        : db.players.find((p) => p.id === opponentId)?.name;
      results.push({
        fixtureId: f.id,
        legNumber: null,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        opponentName: opponentName || 'TBD',
        scoreLabel: `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        submittedAt: f.resultSubmittedAt || null,
      });
    }

    results.sort((a, b) => (a.leagueName || '').localeCompare(b.leagueName || '') || a.round - b.round);
    return results;
  }),

  // Admin: Game Adjustments - same shape as getMyFixtures but for any
  // playerId, including every status (not just upcoming), since an admin
  // might be specifically looking for a disputed/pending result to resolve.
  adminGetPlayerFixtures: op((playerId) => {
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const fixtures = db.fixtures.filter((f) => {
      if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
      if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId)) return true;
      if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
      if (f.legs) return f.legs.some((l) => l.homePlayerId === playerId || l.awayPlayerId === playerId);
      return false;
    });
    const enriched = fixtures.map((f) => {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      const isTeams = !!f.legs;
      const isDoubles = division?.entryType === 'doubles';
      const opponentId = isTeams
        ? (myTeamIds.includes(f.homeTeamId) ? f.awayTeamId : f.homeTeamId)
        : isDoubles
          ? (myPairingIds.includes(f.homePlayerId) ? f.awayPlayerId : f.homePlayerId)
          : (f.homePlayerId === playerId ? f.awayPlayerId : f.homePlayerId);
      const opponentName = isTeams
        ? db.teams.find((t) => t.id === opponentId)?.name
        : isDoubles
          ? db.pairings.find((p) => p.id === opponentId)?.name
          : db.players.find((p) => p.id === opponentId)?.name;
      return {
        id: f.id,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        scoreLabel: isTeams ? `${f.homeLegsWon}-${f.awayLegsWon} legs` : `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        scheduledDate: f.scheduledDate || null,
        opponentName: opponentName || 'TBD',
      };
    });
    enriched.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '') || b.round - a.round);
    return enriched;
  }),

  // Powers the Game Adjustments "Needs Attention" list - mirrors the server's
  // GET /api/admin/fixtures/needs-attention (see that route for design notes).
  adminGetFixturesNeedingAttention: op(() => {
    const NEEDS_ATTENTION = ['pending_confirmation', 'disputed'];
    const results = [];
    for (const f of db.fixtures) {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      if (f.legs) {
        const homeTeam = db.teams.find((t) => t.id === f.homeTeamId);
        const awayTeam = db.teams.find((t) => t.id === f.awayTeamId);
        for (const leg of f.legs) {
          if (!NEEDS_ATTENTION.includes(leg.status)) continue;
          results.push({
            fixtureId: f.id,
            legNumber: leg.legNumber,
            leagueName: league?.name,
            divisionName: division?.name,
            round: f.round,
            status: leg.status,
            label: `${homeTeam ? homeTeam.name : 'TBD'} vs ${awayTeam ? awayTeam.name : 'TBD'} — Leg ${leg.legNumber}`,
            scoreLabel: `${leg.homeFrameScore}-${leg.awayFrameScore} frames`,
            disputeReason: leg.disputeReason || null,
            noShowClaim: leg.noShowClaim || null,
          });
        }
        continue;
      }
      if (!NEEDS_ATTENTION.includes(f.status)) continue;
      const isDoubles = division?.entryType === 'doubles';
      const homeName = isDoubles
        ? db.pairings.find((p) => p.id === f.homePlayerId)?.name
        : db.players.find((p) => p.id === f.homePlayerId)?.name;
      const awayName = isDoubles
        ? db.pairings.find((p) => p.id === f.awayPlayerId)?.name
        : db.players.find((p) => p.id === f.awayPlayerId)?.name;
      results.push({
        fixtureId: f.id,
        legNumber: null,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        label: `${homeName || 'TBD'} vs ${awayName || 'TBD'}`,
        scoreLabel: `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        disputeReason: f.disputeReason || null,
        noShowClaim: f.noShowClaim || null,
      });
    }
    const STATUS_ORDER = { disputed: 0, pending_confirmation: 1 };
    results.sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.leagueName || '').localeCompare(b.leagueName || '') ||
      a.round - b.round
    );
    return results;
  }),

  adminListUsers: op((q = '') => {
    const query = (q || '').trim().toLowerCase();
    let users = db.users;
    if (query) {
      users = users.filter((u) =>
        `${u.firstName} ${u.lastName}`.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query) ||
        u.teamName.toLowerCase().includes(query)
      );
    }
    users = [...users].sort((a, b) => a.lastName.localeCompare(b.lastName));
    return users.map(publicUser);
  }),

  adminGetUser: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    return publicUser(user);
  }),

  adminGetUserByPlayer: op((playerId) => {
    const user = db.users.find((u) => u.playerId === playerId) || null;
    return { user: publicUser(user) };
  }),

  adminUpdateUser: op((id, data) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    applyProfileFields(user, data);
    recordAudit(db, {
      actor: adminLabel(), action: 'user.edit', targetType: 'user', targetId: user.id,
      details: `Edited profile for ${user.firstName} ${user.lastName}`,
    });
    return publicUser(user);
  }),

  adminSetPermissions: op((id, permissions) => {
    const { isAdmin, isCaptain, isLeagueManager } = permissions;
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    const changes = [];
    if (isAdmin !== undefined && !!isAdmin !== user.isAdmin) {
      user.isAdmin = !!isAdmin;
      changes.push(user.isAdmin ? 'granted admin' : 'revoked admin');
    }
    if (isCaptain !== undefined && !!isCaptain !== user.isCaptain) {
      user.isCaptain = !!isCaptain;
      changes.push(user.isCaptain ? 'marked as captain' : 'unmarked as captain');
    }
    if (isLeagueManager !== undefined && !!isLeagueManager !== user.isLeagueManager) {
      user.isLeagueManager = !!isLeagueManager;
      changes.push(user.isLeagueManager ? 'granted League Manager' : 'revoked League Manager');
      if (!user.isLeagueManager) {
        for (const league of db.leagues) {
          if (Array.isArray(league.managerUserIds) && league.managerUserIds.includes(user.id)) {
            league.managerUserIds = league.managerUserIds.filter((mid) => mid !== user.id);
          }
        }
      }
    }
    if (changes.length > 0) {
      recordAudit(db, {
        actor: adminLabel(), action: 'user.permissions', targetType: 'user', targetId: user.id,
        details: `${user.firstName} ${user.lastName}: ${changes.join(', ')}`,
      });
    }
    return publicUser(user);
  }),

  adminSetStatus: op((id, status) => {
    if (!STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    user.status = status;
    recordAudit(db, {
      actor: adminLabel(), action: 'user.status', targetType: 'user', targetId: user.id,
      details: `Set status of ${user.firstName} ${user.lastName} to ${status}`,
    });
    return publicUser(user);
  }),

  adminResetPassword: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    recordAudit(db, {
      actor: adminLabel(), action: 'user.reset_password', targetType: 'user', targetId: user.id,
      details: `Force-reset password for ${user.firstName} ${user.lastName}`,
    });
    return { ok: true };
  }),

  adminImportUsers: op((rows) => {
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');
    const created = [];
    const skipped = [];
    const errors = [];
    rows.forEach((row, index) => {
      const rowNum = index + 1;
      try {
        const firstName = (row.firstName || '').trim();
        const lastName = (row.lastName || '').trim();
        const email = (row.email || '').trim();
        const teamName = (row.teamName || '').trim() || 'Unassigned';
        const classification = (row.classification || '').trim().toUpperCase() || null;
        const isAdminFlag = row.isAdmin === true || String(row.isAdmin).trim().toLowerCase() === 'true' || String(row.isAdmin).trim() === '1';
        const isCaptain = row.isCaptain === true || String(row.isCaptain).trim().toLowerCase() === 'true' || String(row.isCaptain).trim() === '1';
        if (!firstName) throw new Error('firstName is required');
        if (!lastName) throw new Error('lastName is required');
        if (!email) throw new Error('email is required');
        if (classification && !CLASSIFICATIONS.includes(classification)) {
          throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
        }
        const normalizedEmail = email.toLowerCase();
        const existing = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
        if (existing) {
          skipped.push({ row: rowNum, name: `${existing.firstName} ${existing.lastName}`, email, reason: 'an account with this email already exists' });
          return;
        }
        const user = createUserAccount({
          firstName, lastName, email, phone: (row.phone || '').trim(), teamName, classification,
          isAdmin: isAdminFlag, isCaptain,
        });
        created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, tempPassword: '(not needed in demo mode)' });
      } catch (err) {
        errors.push({ row: rowNum, reason: err.message });
      }
    });
    if (created.length > 0) {
      recordAudit(db, {
        actor: adminLabel(), action: 'user.bulk_import', targetType: 'user', targetId: null,
        details: `Bulk-imported ${created.length} user account(s) from Manage Users`,
      });
    }
    return { created, skipped, errors };
  }),

  adminSendResetLink: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    const token = randomToken();
    const expiresAt = Date.now() + 60 * 60 * 1000;
    db.passwordResets.push({ id: uuid(), userId: user.id, token, createdAt: new Date().toISOString(), expiresAt, usedAt: null });
    const resetLink = `${window.location.origin}${window.location.pathname}#/reset-password?token=${token}`;
    recordAudit(db, {
      actor: adminLabel(), action: 'user.send_reset_link', targetType: 'user', targetId: user.id,
      details: `Generated a password reset link for ${user.firstName} ${user.lastName} (${user.email})`,
    });
    return { resetLink, expiresAt, email: user.email };
  }),

  adminGetAuditLog: op(() => [...db.auditLog].reverse().slice(0, 200)),

  // Issues / Bugs / Features page. The GitHub-backed Issue / Bug Tracker
  // half has no demo equivalent - there's no live repo to read from a
  // static Pages build, and this demo never invents data that isn't really
  // there - so it surfaces a clear message instead of the network version's
  // fetch. The Feature / Requests half is genuine in-app data (submitted by
  // whoever is using this demo session), so that's a real, fully working op
  // like everything else here.
  getGithubIssues: () => Promise.reject(new Error("GitHub Issues aren't available in this demo build.")),
  getFeatureRequests: op(() => [...db.featureRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))),
  submitFeatureRequest: op((title, description) => {
    const trimmedTitle = (title || '').trim();
    const trimmedDescription = (description || '').trim();
    if (!trimmedTitle) throw new ApiError(400, 'A short title is required');
    if (trimmedTitle.length > 200) throw new ApiError(400, 'Title must be 200 characters or fewer');
    if (trimmedDescription.length > 4000) throw new ApiError(400, 'Description must be 4000 characters or fewer');
    const user = currentUser();
    if (!user) throw new ApiError(401, 'Login required for this action');
    const request = {
      id: uuid(),
      title: trimmedTitle,
      description: trimmedDescription,
      createdAt: new Date().toISOString(),
      createdByUserId: user.id,
      createdByName: `${user.firstName} ${user.lastName}`.trim(),
    };
    db.featureRequests.push(request);
    return request;
  }),
  adminDeleteFeatureRequest: op((id) => {
    const before = db.featureRequests.length;
    db.featureRequests = db.featureRequests.filter((r) => r.id !== id);
    if (db.featureRequests.length === before) throw new ApiError(404, 'Feature request not found');
    return null;
  }),

  adminCreateSeason: op((data) => {
    const { name, leagueCount, playersPerLeague, payment } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'Season name is required');
    const count = Number(leagueCount);
    const perLeague = Number(playersPerLeague);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ApiError(400, 'Number of leagues must be a whole number between 1 and 50');
    }
    if (!Number.isInteger(perLeague) || perLeague < 2 || perLeague > 200) {
      throw new ApiError(400, 'Players per league must be a whole number between 2 and 200');
    }
    const league = {
      id: uuid(),
      name: name.trim(),
      sport: 'English 8-Ball Pool',
      format: { matchFormat: 'singles', raceTo: 6, scheduling: 'round_robin_single' },
      startDate: null,
      endDate: null,
      createdAt: new Date().toISOString(),
      payment: normalizePaymentConfig(payment),
      managerUserIds: [],
      tables: [],
    };
    db.leagues.push(league);
    const divisions = [];
    for (let i = 0; i < count; i++) {
      const division = {
        id: uuid(), leagueId: league.id, name: `League ${i + 1}`, order: i,
        entryType: 'singles', scheduling: 'round_robin_single', playerIds: [], teamIds: [],
        legsPerMatch: null, gapDays: null, targetPlayerCount: perLeague, fixturesGenerated: false,
      };
      db.divisions.push(division);
      divisions.push(division);
    }
    return { ...league, divisions };
  }),

  adminImportSeasonPlayers: op((leagueId, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'Season not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const divisionByName = new Map(divisions.map((d) => [d.name.trim().toLowerCase(), d]));
    const created = [];
    const linkedExisting = [];
    const errors = [];
    // See server/src/index.js's import-players route for why this isn't
    // hard-gated by assertPaymentCleared - anyone imported into a paid
    // league without an existing confirmed/waived record gets an 'unpaid'
    // one created and is listed here instead.
    const pendingPayment = [];
