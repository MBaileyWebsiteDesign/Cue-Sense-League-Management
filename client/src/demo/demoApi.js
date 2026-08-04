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
import { buildBracketRounds, buildDoubleElimBracket } from './logic/bracket.js';
import { computeStandings } from './logic/standings.js';
import { computeTeamStandings } from './logic/teamStandings.js';
import { computeTourStandings } from './logic/tours.js';
import { buildPlayerProfile } from './logic/playerProfile.js';
import { recordAudit } from './logic/auditLog.js';

const uuid = () => crypto.randomUUID();
const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];
const STATUSES = ['active', 'suspended'];
const SCHEDULING_TYPES = ['round_robin_single', 'round_robin_double', 'knockout_single_elim', 'knockout_double_elim'];
const DB_KEY = 'poolLeagueDemoDb';
const CURRENT_USER_KEY = 'poolLeagueDemoCurrentUserId';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadInitialDb() {
  let base;
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) base = JSON.parse(raw);
  } catch {
    // fall through to the bundled seed
  }
  if (!base) base = structuredClone(demoDataSeed);
  // Backfill for a seed/save that predates `pairings` (doubles/triples) -
  // mirrors db.js's readDb() migration on the real server.
  if (!base.pairings) base.pairings = [];
  if (!base.passwordResets) base.passwordResets = [];
  if (!base.divisions) base.divisions = [];
  if (!base.fixtures) base.fixtures = [];
  // Tours/series and the Roll of Honour both post-date the original schema
  // too - mirrors db.js's readDb() migration on the real server.
  if (!base.tours) base.tours = [];
  if (!base.rollOfHonour) base.rollOfHonour = [];
  if (!base.apiKeys) base.apiKeys = [];
  for (const league of base.leagues) {
    if (!league.tables) league.tables = [];
  }
  for (const fixture of base.fixtures) {
    if (fixture.tableId === undefined) fixture.tableId = null;
    if (fixture.scheduledTime === undefined) fixture.scheduledTime = null;
    if (!fixture.timer) fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
    if (!fixture.shotClock) fixture.shotClock = { durationSeconds: 60, startedAt: null, running: false };
  }
  // Round visibility ("Manage Fixtures") - mirrors db.js's readDb() migration:
  // fixtures are hidden from players by default, even for a division saved
  // before this feature existed and already has fixtures generated - an
  // admin has to explicitly release each round from Manage Fixtures.
  for (const division of base.divisions) {
    if (division.visibleRounds === undefined) {
      division.visibleRounds = [];
    }
  }
  return base;
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
  const fullName = `${fields.firstName} ${fields.lastName}`;
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
  if (player) player.name = `${user.firstName} ${user.lastName}`;
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

  if (division.scheduling === 'knockout_double_elim') {
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
  const bracketRounds = buildBracketRounds(entrantIds);

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
    if (b === null) fixture.byeSlot = 'away';
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = b;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = b;
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
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds);

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
    if (b === null) fixture.byeSlot = 'away';
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = b;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = b;
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
  // Resolve any winners-bracket round-1 byes - see server/src/index.js's
  // matching comment (no-op today since double elimination requires an
  // even entrant count, kept for defensive parity).
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
      firstName, lastName, email, phone = '', teamName, classification = null,
    } = data;
    if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
    if (!lastName || !lastName.trim()) throw new ApiError(400, 'Last name is required');
    if (!email || !email.trim()) throw new ApiError(400, 'Email is required');
    if (!teamName || !teamName.trim()) throw new ApiError(400, 'Team name is required');
    if (classification && !CLASSIFICATIONS.includes(classification)) {
      throw new ApiError(400, `classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      throw new ApiError(409, 'An account with this email already exists');
    }
    const user = createUserAccount({
      firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(),
      phone: phone ? phone.trim() : '', teamName: teamName.trim(),
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
      return { leagueName: league?.name || 'Unknown league', divisionName: d.name };
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
    const { isAdmin, isCaptain } = permissions;
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

  adminCreateSeason: op((data) => {
    const { name, leagueCount, playersPerLeague } = data;
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
    rows.forEach((row, index) => {
      const rowNum = index + 1;
      try {
        const firstName = (row.firstName || '').trim();
        const lastName = (row.lastName || '').trim();
        const email = (row.email || '').trim();
        const teamName = (row.teamName || '').trim() || 'Unassigned';
        const classification = (row.classification || '').trim().toUpperCase() || null;
        const divisionName = (row.division || '').trim();
        const isCaptain = row.isCaptain === true || String(row.isCaptain).trim().toLowerCase() === 'true' || String(row.isCaptain).trim() === '1';
        if (!firstName) throw new Error('firstName is required');
        if (!lastName) throw new Error('lastName is required');
        if (!email) throw new Error('email is required');
        if (!divisionName) throw new Error('division is required');
        if (classification && !CLASSIFICATIONS.includes(classification)) {
          throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
        }
        const division = divisionByName.get(divisionName.toLowerCase());
        if (!division) {
          throw new Error(`division "${divisionName}" doesn't match any league in this season (expected one of: ${divisions.map((d) => d.name).join(', ')})`);
        }
        if (division.fixturesGenerated) {
          throw new Error(`fixtures have already been generated for "${division.name}" - can't add more players`);
        }
        const normalizedEmail = email.toLowerCase();
        let user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
        if (!user) {
          user = createUserAccount({
            firstName, lastName, email, phone: (row.phone || '').trim(), teamName, classification, isCaptain,
          });
          created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, division: division.name, tempPassword: '(not needed in demo mode)' });
        } else {
          if (isCaptain && !user.isCaptain) user.isCaptain = true;
          linkedExisting.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email, division: division.name });
        }
        if (!division.playerIds.includes(user.playerId)) {
          division.playerIds.push(user.playerId);
        }
      } catch (err) {
        errors.push({ row: rowNum, reason: err.message });
      }
    });
    return { created, linkedExisting, errors };
  }),

  adminGenerateSeason: op((leagueId, data) => {
    const { startDate, endDate, gapDays } = data;
    if (!startDate) throw new ApiError(400, 'startDate is required');
    if (!endDate) throw new ApiError(400, 'endDate is required');
    if (!Number.isInteger(Number(gapDays)) || Number(gapDays) < 1) {
      throw new ApiError(400, 'gapDays must be a positive whole number of days between rounds');
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new ApiError(400, 'endDate cannot be before startDate');
    }
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'Season not found');
    league.startDate = startDate;
    league.endDate = endDate;
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const generated = [];
    const skipped = [];
    for (const division of divisions) {
      if (division.fixturesGenerated) {
        skipped.push({ division: division.name, reason: 'fixtures already generated' });
        continue;
      }
      if (division.playerIds.length < 2) {
        skipped.push({ division: division.name, reason: `only ${division.playerIds.length} player(s) - needs at least 2` });
        continue;
      }
      generateRoundRobinFixtures({ league, division, entrantIds: division.playerIds });
      division.gapDays = Number(gapDays);
      assignScheduledDates(division, startDate, gapDays);
      division.fixturesGenerated = true;
      const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
      const lastRound = Math.max(...divisionFixtures.map((f) => f.round));
      const lastRoundDate = divisionFixtures.find((f) => f.round === lastRound)?.scheduledDate;
      generated.push({
        division: division.name, players: division.playerIds.length, rounds: lastRound,
        lastGameDate: lastRoundDate, fitsWithinEndDate: !lastRoundDate || lastRoundDate <= endDate,
      });
    }
    return { league: { id: league.id, name: league.name, startDate, endDate }, generated, skipped };
  }),

  overrideFixture: op((fixtureId, homeScore, awayScore) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const isTeams = division.entryType === 'teams';
    if (isTeams) {
      if (!fixture.homeTeamId || !fixture.awayTeamId) throw new ApiError(400, 'Both teams for this fixture are not yet known');
    } else if (!fixture.homePlayerId || !fixture.awayPlayerId) {
      throw new ApiError(400, 'Both players for this fixture are not yet known');
    }
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      throw new ApiError(400, 'homeScore and awayScore must be non-negative whole numbers');
    }
    if (!isTeams && homeScore === awayScore) {
      throw new ApiError(400, 'This match cannot end level - set different scores for home and away');
    }
    const oldWinnerId = isTeams ? fixture.winnerTeamId : fixture.winnerPlayerId;
    const newWinnerId = homeScore === awayScore
      ? null
      : homeScore > awayScore
        ? (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
        : (isTeams ? fixture.awayTeamId : fixture.awayPlayerId);
    if (fixture.nextFixtureId && oldWinnerId && newWinnerId !== oldWinnerId) {
      const next = db.fixtures.find((f) => f.id === fixture.nextFixtureId);
      const nextHasStarted = next && (isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0);
      if (nextHasStarted) {
        throw new ApiError(409, 'This result has already progressed to a fixture that has started - override or reset that fixture first');
      }
    }
    if (isTeams) {
      fixture.homeLegsWon = homeScore;
      fixture.awayLegsWon = awayScore;
      fixture.winnerTeamId = newWinnerId;
      fixture.legs = fixture.legs.map((leg) => ({
        ...leg, homePlayerId: null, awayPlayerId: null, frames: [], homeFrameScore: 0, awayFrameScore: 0,
        status: 'pending', winnerPlayerId: null,
      }));
    } else {
      fixture.homeFrameScore = homeScore;
      fixture.awayFrameScore = awayScore;
      fixture.frames = [];
      fixture.winnerPlayerId = newWinnerId;
    }
    fixture.status = 'completed';
    fixture.adminOverride = { at: new Date().toISOString(), by: adminLabel() };
    fixture.disputeReason = null;
    if (fixture.nextFixtureId && newWinnerId && newWinnerId !== oldWinnerId) {
      propagateWinner(division, fixture, newWinnerId);
    }
    if (newWinnerId && newWinnerId !== oldWinnerId) {
      const newLoserId = newWinnerId === (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
        ? (isTeams ? fixture.awayTeamId : fixture.awayPlayerId)
        : (isTeams ? fixture.homeTeamId : fixture.homePlayerId);
      propagateLoser(division, fixture, newLoserId);
    }
    checkGrandFinalReset(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.override', targetType: 'fixture', targetId: fixture.id,
      details: `Set final score to ${homeScore}-${awayScore}`,
    });
    return fixture;
  }),

  // ---------- Roll of Honour ----------
  // Every entry is recorded automatically by recordChampionIfDivisionComplete
  // (see hydrateDivision above) - nothing here writes to db.rollOfHonour
  // directly, mirroring the real server's GET /api/roll-of-honour.
  getRollOfHonour: op(() =>
    [...db.rollOfHonour].sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
  ),

  // ---------- Tours / Series ----------
  // Mirrors server/src/index.js's Tours routes - see those for the full
  // "an admin-curated list of existing divisions" rationale.
  getTours: op(() => db.tours),

  createTour: op((data) => {
    const { name, entryType = 'singles' } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'Tour name is required');
    if (!['singles', 'teams', 'doubles'].includes(entryType)) {
      throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
    }
    const tour = { id: uuid(), name: name.trim(), entryType, divisionIds: [], createdAt: new Date().toISOString() };
    db.tours.push(tour);
    return tour;
  }),

  getTour: op((id) => {
    const tour = db.tours.find((t) => t.id === id);
    if (!tour) throw new ApiError(404, 'Tour not found');
    const divisions = db.divisions.filter((d) => tour.divisionIds.includes(d.id));
    const hydratedDivisions = divisions.map((d) => hydrateDivision(d));
    const standings = computeTourStandings(tour, hydratedDivisions);
    return {
      ...tour,
      divisions: hydratedDivisions.map((d) => ({
        id: d.id, name: d.name, leagueId: d.leagueId, leagueName: d.leagueName, fixturesGenerated: d.fixturesGenerated,
      })),
      standings,
    };
  }),

  deleteTour: op((id) => {
    const index = db.tours.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError(404, 'Tour not found');
    db.tours.splice(index, 1);
    return { ok: true };
  }),

  addTourDivision: op((tourId, divisionId) => {
    if (!divisionId) throw new ApiError(400, 'divisionId is required');
    const tour = db.tours.find((t) => t.id === tourId);
    if (!tour) throw new ApiError(404, 'Tour not found');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== tour.entryType) {
      throw new ApiError(
        400,
        `This tour only accepts ${tour.entryType} divisions - "${division.name}" is a ${division.entryType} division`
      );
    }
    if (!tour.divisionIds.includes(divisionId)) tour.divisionIds.push(divisionId);
    return tour;
  }),

  removeTourDivision: op((tourId, divisionId) => {
    const tour = db.tours.find((t) => t.id === tourId);
    if (!tour) throw new ApiError(404, 'Tour not found');
    tour.divisionIds = tour.divisionIds.filter((id) => id !== divisionId);
    return tour;
  }),

  // ---------- Table scheduling ----------
  addTable: op((leagueId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Table name is required');
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    league.tables.push({ id: uuid(), name: name.trim() });
    return league;
  }),

  removeTable: op((leagueId, tableId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    league.tables = league.tables.filter((t) => t.id !== tableId);
    for (const fixture of db.fixtures) {
      if (fixture.leagueId === league.id && fixture.tableId === tableId) {
        fixture.tableId = null;
      }
    }
    return league;
  }),

  scheduleFixture: op((fixtureId, { tableId, scheduledDate, scheduledTime } = {}) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const league = db.leagues.find((l) => l.id === fixture.leagueId);

    if (tableId !== undefined && tableId !== null) {
      const table = league.tables.find((t) => t.id === tableId);
      if (!table) throw new ApiError(400, "That table does not exist in this fixture's league");
    }

    const nextTableId = tableId === undefined ? fixture.tableId : tableId;
    const nextDate = scheduledDate === undefined ? fixture.scheduledDate : scheduledDate;
    const nextTime = scheduledTime === undefined ? fixture.scheduledTime : scheduledTime;

    if (nextTableId && nextDate && nextTime) {
      const clash = db.fixtures.find(
        (f) => f.id !== fixture.id && f.tableId === nextTableId && f.scheduledDate === nextDate && f.scheduledTime === nextTime
      );
      if (clash) throw new ApiError(409, 'That table is already booked for another fixture at that date and time');
    }

    fixture.tableId = nextTableId;
    fixture.scheduledDate = nextDate;
    fixture.scheduledTime = nextTime;
    return fixture;
  }),

  // ---------- Match timer & shot clock ----------
  startTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (!fixture.timer.running) {
      fixture.timer.running = true;
      fixture.timer.startedAt = new Date().toISOString();
    }
    return fixture;
  }),

  pauseTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (fixture.timer.running && fixture.timer.startedAt) {
      const elapsed = (Date.now() - new Date(fixture.timer.startedAt).getTime()) / 1000;
      fixture.timer.elapsedSeconds += Math.max(0, elapsed);
    }
    fixture.timer.running = false;
    fixture.timer.startedAt = null;
    return fixture;
  }),

  resetTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
    return fixture;
  }),

  startShotClock: op((fixtureId, durationSeconds) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (durationSeconds !== undefined && durationSeconds !== null) {
      if (!Number.isInteger(Number(durationSeconds)) || Number(durationSeconds) < 5) {
        throw new ApiError(400, 'durationSeconds must be a whole number of at least 5 seconds');
      }
      fixture.shotClock.durationSeconds = Number(durationSeconds);
    }
    fixture.shotClock.startedAt = new Date().toISOString();
    fixture.shotClock.running = true;
    return fixture;
  }),

  stopShotClock: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    fixture.shotClock.running = false;
    fixture.shotClock.startedAt = null;
    return fixture;
  }),

  // ---------- API Keys ----------
  // Demo mode has no real StreamDeck to call these, but mirrors the shape
  // so the Admin Portal's API Keys page works identically either way.
  getApiKeys: op(() => db.apiKeys.map(({ hash, ...rest }) => rest)),

  createApiKey: op((label) => {
    if (!label || !label.trim()) throw new ApiError(400, 'A label is required, e.g. "StreamDeck - Table 1"');
    const rawKey = `sdk_demo_${uuid().replace(/-/g, '')}`;
    const apiKey = { id: uuid(), label: label.trim(), hash: rawKey, createdAt: new Date().toISOString(), lastUsedAt: null };
    db.apiKeys.push(apiKey);
    const { hash, ...publicKey } = apiKey;
    return { ...publicKey, key: rawKey };
  }),

  deleteApiKey: op((id) => {
    const index = db.apiKeys.findIndex((k) => k.id === id);
    if (index === -1) throw new ApiError(404, 'API key not found');
    db.apiKeys.splice(index, 1);
    return { ok: true };
  }),

  getLeagues: op(() => db.leagues),

  createLeague: op((data) => {
    const { name, sport = 'English 8-Ball Pool', matchFormat = 'singles', raceTo = 6, scheduling = 'round_robin_single' } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'League name is required');
    const league = {
      id: uuid(), name: name.trim(), sport, format: { matchFormat, raceTo, scheduling },
      startDate: null, endDate: null, createdAt: new Date().toISOString(),
      tables: [],
    };
    db.leagues.push(league);
    return league;
  }),

  getLeague: op((id) => {
    const league = db.leagues.find((l) => l.id === id);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id).sort((a, b) => a.order - b.order);
    return { ...league, divisions };
  }),

  createDivision: op((leagueId, data) => {
    const { name, order = 0, entryType = 'singles', legsPerMatch = 5, pairingSize = 2 } = data;
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const scheduling = data.scheduling || league.format.scheduling || 'round_robin_single';
    if (!name || !name.trim()) throw new ApiError(400, 'Division name is required');
    if (!['singles', 'teams', 'doubles'].includes(entryType)) {
      throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
    }
    if (!SCHEDULING_TYPES.includes(scheduling)) throw new ApiError(400, `scheduling must be one of: ${SCHEDULING_TYPES.join(', ')}`);
    if (entryType === 'teams' && (!Number.isInteger(Number(legsPerMatch)) || Number(legsPerMatch) < 1)) {
      throw new ApiError(400, 'legsPerMatch must be a positive whole number');
    }
    if (entryType === 'doubles' && ![2, 3].includes(Number(pairingSize))) {
      throw new ApiError(400, 'pairingSize must be 2 (doubles) or 3 (triples)');
    }
    const division = {
      id: uuid(), leagueId: league.id, name: name.trim(), order, entryType, scheduling,
      playerIds: [], teamIds: [], pairingIds: [],
      legsPerMatch: entryType === 'teams' ? Number(legsPerMatch) : null,
      pairingSize: entryType === 'doubles' ? Number(pairingSize) : null,
      gapDays: null, fixturesGenerated: false,
      // No round is visible to players until released - see isRoundVisible.
      visibleRounds: [],
      // 'active' | 'completed' - see closeDivisionEarly/closeLeagueEarly below
      // (mirrors server/src/index.js's close-early routes).
      status: 'active',
      completedAt: null,
      completedBy: null,
    };
    db.divisions.push(division);
    return division;
  }),

  getDivision: op((id) => {
    const division = db.divisions.find((d) => d.id === id);
    if (!division) throw new ApiError(404, 'Division not found');
    const hydrated = hydrateDivision(division);
    // Non-admins only see fixtures from released rounds - see isRoundVisible.
    if (!currentUser()?.isAdmin) {
      hydrated.fixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
    }
    return hydrated;
  }),

  // Force-completes every outstanding fixture in a division at 0-0 (0 legs
  // for a team fixture), no winner, no confirmation needed - mirrors
  // server/src/index.js's closeOutstandingFixtures / POST
  // /api/divisions/:id/close-early. A null winner is a genuinely new
  // outcome for a singles/doubles fixture (normal race-to-N play can't end
  // level) - see the 'void' handling in demo/logic/standings.js and
  // demo/logic/playerProfile.js.
  closeDivisionEarly: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    closeOutstandingFixtures(division, adminLabel());
    recordAudit(db, {
      actor: adminLabel(), action: 'division.closeEarly', targetType: 'division', targetId: division.id,
      details: 'Closed the division early',
    });
    return hydrateDivision(division);
  }),

  // League-wide equivalent - applies the same treatment to every division
  // in the league. Mirrors server/src/index.js's POST
  // /api/leagues/:id/close-early.
  closeLeagueEarly: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    for (const division of divisions) {
      closeOutstandingFixtures(division, adminLabel());
    }
    recordAudit(db, {
      actor: adminLabel(), action: 'league.closeEarly', targetType: 'league', targetId: league.id,
      details: `Closed the league early across ${divisions.length} division(s)`,
    });
    return {
      leagueId: league.id,
      divisions: divisions.map((d) => hydrateDivision(d)),
    };
  }),

  // Mirrors server/src/index.js's DELETE /api/leagues/:id - permanently
  // removes a league and everything scoped to it (divisions, fixtures,
  // teams, pairings, roll-of-honour entries), and strips it out of any
  // tour's divisionIds. No undo.
  deleteLeague: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const divisionIds = new Set(divisions.map((d) => d.id));

    const fixturesRemoved = db.fixtures.filter((f) => f.leagueId === league.id).length;
    db.fixtures = db.fixtures.filter((f) => f.leagueId !== league.id);
    db.teams = db.teams.filter((t) => !divisionIds.has(t.divisionId));
    db.pairings = db.pairings.filter((p) => !divisionIds.has(p.divisionId));
    db.rollOfHonour = db.rollOfHonour.filter((r) => r.leagueId !== league.id);
    db.tours.forEach((tour) => {
      tour.divisionIds = tour.divisionIds.filter((id) => !divisionIds.has(id));
    });
    db.divisions = db.divisions.filter((d) => d.leagueId !== league.id);
    db.leagues = db.leagues.filter((l) => l.id !== league.id);

    recordAudit(db, {
      actor: adminLabel(), action: 'league.delete', targetType: 'league', targetId: league.id,
      details: `Deleted league "${league.name}" - ${divisions.length} division(s), ${fixturesRemoved} fixture(s)`,
    });

    return { deleted: true, leagueId: league.id, divisionsRemoved: divisions.length, fixturesRemoved };
  }),

  // Powers the admin "Manage Fixtures" page - mirrors server/src/index.js's
  // POST /api/divisions/:id/rounds/:round/visibility.
  setRoundVisibility: op((divisionId, round, visible) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const roundNum = Number(round);
    if (!Number.isInteger(roundNum)) throw new ApiError(400, 'round must be a whole number');
    const roundExists = db.fixtures.some((f) => f.divisionId === division.id && f.round === roundNum);
    if (!roundExists) throw new ApiError(404, 'No fixtures found for this round in this division');
    if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
    if (visible) {
      if (!division.visibleRounds.includes(roundNum)) division.visibleRounds.push(roundNum);
    } else {
      division.visibleRounds = division.visibleRounds.filter((r) => r !== roundNum);
    }
    recordAudit(db, {
      actor: adminLabel(), action: visible ? 'division.round_release' : 'division.round_hide',
      targetType: 'division', targetId: division.id,
      details: `Round ${roundNum} ${visible ? 'released to players' : 'hidden from players'} (${division.name})`,
    });
    return hydrateDivision(division);
  }),

  // Convenience for correcting a division where rounds ended up visible
  // before an admin was ready (e.g. legacy data saved before fixtures
  // started defaulting to hidden) - mirrors the server's POST
  // /api/divisions/:id/hide-all-rounds.
  hideAllRounds: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const hadVisibleRounds = Array.isArray(division.visibleRounds) && division.visibleRounds.length > 0;
    division.visibleRounds = [];
    if (hadVisibleRounds) {
      recordAudit(db, {
        actor: adminLabel(), action: 'division.hide_all_rounds', targetType: 'division', targetId: division.id,
        details: `Hid all rounds from players (${division.name})`,
      });
    }
    return hydrateDivision(division);
  }),

  getRegisteredPlayers: op(() => registeredPlayers()),

  addPlayer: op((divisionId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'singles') {
      throw new ApiError(400, `This is a ${division.entryType} division - add players to a ${division.entryType === 'teams' ? 'team' : 'pairing'} instead`);
    }
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    if (!division.playerIds.includes(player.id)) division.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removePlayer: op((divisionId, playerId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players after fixtures have been generated for this division');
    division.playerIds = division.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  createPairing: op((divisionId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Pairing name is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'doubles') throw new ApiError(400, 'This is not a doubles/triples division');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add pairings after fixtures have been generated for this division');
    const pairing = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
    db.pairings.push(pairing);
    division.pairingIds.push(pairing.id);
    return hydrateDivision(division);
  }),

  removePairing: op((divisionId, pairingId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove pairings after fixtures have been generated for this division');
    division.pairingIds = division.pairingIds.filter((id) => id !== pairingId);
    return hydrateDivision(division);
  }),

  addPairingPlayer: op((pairingId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const pairing = db.pairings.find((p) => p.id === pairingId);
    if (!pairing) throw new ApiError(404, 'Pairing not found');
    const division = db.divisions.find((d) => d.id === pairing.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
    if (pairing.playerIds.length >= division.pairingSize) {
      throw new ApiError(400, `This pairing already has the maximum of ${division.pairingSize} player(s)`);
    }
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    if (!pairing.playerIds.includes(player.id)) pairing.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removePairingPlayer: op((pairingId, playerId) => {
    const pairing = db.pairings.find((p) => p.id === pairingId);
    if (!pairing) throw new ApiError(404, 'Pairing not found');
    const division = db.divisions.find((d) => d.id === pairing.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
    pairing.playerIds = pairing.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/seed-from-groups -
  // see that route for the full "multi-stage competitions are just linked
  // divisions" rationale. Auto-populates a not-yet-generated division's
  // roster from the top N finishers of one or more other divisions'
  // standings.
  seedFromGroups: op((divisionId, sources) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) {
      throw new ApiError(400, 'Cannot seed entrants after fixtures have been generated for this division');
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new ApiError(400, 'sources must be a non-empty array of { divisionId, count }');
    }

    const entrantList = division.entryType === 'teams'
      ? division.teamIds
      : division.entryType === 'doubles'
        ? division.pairingIds
        : division.playerIds;

    const seedSummary = [];
    for (const source of sources) {
      const { divisionId: sourceDivisionId, count } = source || {};
      if (!sourceDivisionId || !Number.isInteger(Number(count)) || Number(count) < 1) {
        throw new ApiError(400, 'Each source needs a divisionId and a positive whole-number count');
      }
      const sourceDivision = db.divisions.find((d) => d.id === sourceDivisionId);
      if (!sourceDivision) throw new ApiError(404, `Source division ${sourceDivisionId} not found`);
      if (sourceDivision.id === division.id) throw new ApiError(400, 'A division cannot be seeded from itself');
      if (sourceDivision.entryType !== division.entryType) {
        throw new ApiError(
          400,
          `Source division "${sourceDivision.name}" is a ${sourceDivision.entryType} division - can't seed a ${division.entryType} division from it`
        );
      }

      const hydratedSource = hydrateDivision(sourceDivision);
      const idField = division.entryType === 'teams' ? 'teamId' : 'playerId';
      const rankedIds = hydratedSource.standings.map((row) => row[idField]);
      const take = rankedIds.slice(0, Number(count));

      let added = 0;
      for (const entrantId of take) {
        if (!entrantList.includes(entrantId)) {
          entrantList.push(entrantId);
          added += 1;
        }
      }
      seedSummary.push({
        divisionId: sourceDivision.id,
        divisionName: sourceDivision.name,
        requested: Number(count),
        available: rankedIds.length,
        added,
      });
    }

    return { ...hydrateDivision(division), seedSummary };
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/reorder-entrants -
  // lets an admin fine-tune (or fully set) a not-yet-generated division's
  // entrant order, which is what actually controls knockout bracket seeding
  // (buildBracketRounds/buildDoubleElimBracket just pair entrants in
  // whatever array order they're given).
  reorderEntrants: op((divisionId, order) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) {
      throw new ApiError(400, 'Cannot reorder entrants after fixtures have been generated for this division');
    }
    if (!Array.isArray(order) || order.length === 0) {
      throw new ApiError(400, 'order must be a non-empty array of entrant IDs');
    }

    const field = division.entryType === 'teams' ? 'teamIds' : division.entryType === 'doubles' ? 'pairingIds' : 'playerIds';
    const current = division[field];
    const sameMembers =
      order.length === current.length &&
      new Set(order).size === current.length &&
      order.every((id) => current.includes(id));
    if (!sameMembers) {
      throw new ApiError(400, 'order must contain exactly the same entrants the division currently has, each exactly once');
    }

    division[field] = order;
    return hydrateDivision(division);
  }),

  generateFixtures: op((divisionId, data = {}) => {
    const { startDate, gapDays } = data;
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Fixtures have already been generated for this division');
    const entrantIds = division.entryType === 'teams'
      ? division.teamIds
      : division.entryType === 'doubles'
        ? division.pairingIds
        : division.playerIds;
    const entrantLabel = division.entryType === 'teams' ? 'teams' : division.entryType === 'doubles' ? 'pairings' : 'players';
    if (entrantIds.length < 2) throw new ApiError(400, `A division needs at least 2 ${entrantLabel} before fixtures can be generated`);
    if (division.entryType === 'doubles') {
      const incomplete = db.pairings.filter(
        (p) => division.pairingIds.includes(p.id) && p.playerIds.length !== division.pairingSize
      );
      if (incomplete.length > 0) {
        throw new ApiError(
          400,
          `Every pairing needs exactly ${division.pairingSize} player(s) before fixtures can be generated - ` +
            `incomplete: ${incomplete.map((p) => p.name).join(', ')}`
        );
      }
    }
    if (division.scheduling === 'knockout_single_elim') {
      generateKnockoutFixtures({ league, division, entrantIds });
    } else if (division.scheduling === 'knockout_double_elim') {
      if (entrantIds.length < 4) {
        throw new ApiError(
          400,
          `Double elimination needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
        );
      }
      generateDoubleElimFixtures({ league, division, entrantIds });
    } else {
      generateRoundRobinFixtures({ league, division, entrantIds });
    }
    if (startDate && gapDays) {
      division.gapDays = Number(gapDays);
      assignScheduledDates(division, startDate, gapDays);
    }
    division.fixturesGenerated = true;
    return hydrateDivision(division);
  }),

  substitutePlayer: op((divisionId, outgoingPlayerId, incomingPlayerId, reason = 'substitution') => {
    if (!outgoingPlayerId || !incomingPlayerId) throw new ApiError(400, 'outgoingPlayerId and incomingPlayerId are required');
    if (outgoingPlayerId === incomingPlayerId) throw new ApiError(400, 'The replacement must be a different player from the one dropping out');
    if (!['substitution', 'retirement'].includes(reason)) throw new ApiError(400, "reason must be 'substitution' or 'retirement'");
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'singles') throw new ApiError(400, 'Player substitution is only available for singles divisions right now');
    if (!division.playerIds.includes(outgoingPlayerId)) throw new ApiError(400, 'That player is not registered in this division');
    if (division.playerIds.includes(incomingPlayerId)) throw new ApiError(400, 'That replacement is already registered in this division');
    const incoming = registeredPlayers().find((p) => p.id === incomingPlayerId);
    if (!incoming) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    const outgoing = db.players.find((p) => p.id === outgoingPlayerId);
    const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
    const swapped = [];
    const blockedInProgress = [];
    for (const fixture of divisionFixtures) {
      const isHome = fixture.homePlayerId === outgoingPlayerId;
      const isAway = fixture.awayPlayerId === outgoingPlayerId;
      if (!isHome && !isAway) continue;
      if (fixture.status === 'completed') continue;
      if (fixture.status === 'in_progress') {
        blockedInProgress.push({ fixtureId: fixture.id, round: fixture.round });
        continue;
      }
      if (isHome) fixture.homePlayerId = incomingPlayerId;
      else fixture.awayPlayerId = incomingPlayerId;
      swapped.push({ fixtureId: fixture.id, round: fixture.round });
    }
    division.playerIds.push(incomingPlayerId);
    // A 'retirement' also drops the outgoing player from the roster, so
    // their row disappears from the League Table - unlike a plain
    // 'substitution', where they stay listed with their played-so-far
    // record frozen. Either way, computeStandings only ever aggregates a
    // row from that row's own fixtures, so this never touches opponents'
    // already-completed results.
    if (reason === 'retirement') {
      division.playerIds = division.playerIds.filter((id) => id !== outgoingPlayerId);
    }
    if (!division.substitutions) division.substitutions = [];
    division.substitutions.push({
      id: uuid(), outgoingPlayerId, outgoingPlayerName: outgoing ? outgoing.name : 'Unknown player',
      incomingPlayerId, incomingPlayerName: incoming.name, reason, at: new Date().toISOString(),
      by: adminLabel(), fixturesSwapped: swapped.length,
    });
    recordAudit(db, {
      actor: adminLabel(), action: 'division.substitute_player', targetType: 'division', targetId: division.id,
      details: reason === 'retirement'
        ? `${outgoing ? outgoing.name : 'A player'} retired from "${division.name}" - removed from the League Table, ${incoming.name} took over ${swapped.length} remaining fixture(s)`
        : `Swapped ${outgoing ? outgoing.name : 'a player'} out for ${incoming.name} in "${division.name}" (${swapped.length} remaining fixture(s) reassigned)`,
    });
    return { division: hydrateDivision(division), swapped, blockedInProgress, reason };
  }),

  getFixture: op((id) => {
    const fixture = db.fixtures.find((f) => f.id === id);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const divisionName = division ? division.name : null;
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(404, 'Fixture not found');
    }
    if (division.entryType === 'teams') {
      const withPlayers = (team) => (team ? { ...team, players: db.players.filter((p) => team.playerIds.includes(p.id)) } : null);
      const homeTeam = withPlayers(db.teams.find((t) => t.id === fixture.homeTeamId));
      const awayTeam = withPlayers(db.teams.find((t) => t.id === fixture.awayTeamId));
      const legs = fixture.legs.map((leg) => ({
        ...leg,
        homePlayer: leg.homePlayerId ? db.players.find((p) => p.id === leg.homePlayerId) : null,
        awayPlayer: leg.awayPlayerId ? db.players.find((p) => p.id === leg.awayPlayerId) : null,
      }));
      return { ...fixture, divisionName, legs, homeTeam, awayTeam, bothEntrantsKnown: !!(fixture.homeTeamId && fixture.awayTeamId) };
    }
    if (division.entryType === 'doubles') {
      const withPlayers = (pairing) => (pairing ? { ...pairing, players: db.players.filter((p) => pairing.playerIds.includes(p.id)) } : null);
      const homePairing = withPlayers(db.pairings.find((p) => p.id === fixture.homePlayerId));
      const awayPairing = withPlayers(db.pairings.find((p) => p.id === fixture.awayPlayerId));
      return { ...fixture, divisionName, homePairing, awayPairing, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) };
    }
    const homePlayer = fixture.homePlayerId ? db.players.find((p) => p.id === fixture.homePlayerId) : null;
    const awayPlayer = fixture.awayPlayerId ? db.players.find((p) => p.id === fixture.awayPlayerId) : null;
    return { ...fixture, divisionName, homePlayer, awayPlayer, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) };
  }),

  // Ported from server/src/index.js's GET /api/overlay/fixtures/:id (see the
  // design notes there) - normalizes singles/teams/doubles into the same
  // { home, away } shape for the OBS-facing stream overlay page. There's no
  // real auth boundary in demo mode to begin with, so this is really just
  // "the same data, reshaped" rather than a public-vs-private distinction.
  getOverlayFixture: op((id) => {
    const fixture = db.fixtures.find((f) => f.id === id);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    return buildOverlayFixture(fixture);
  }),

  // Ported from server/src/index.js's GET /api/overlay/leagues/:id/arena -
  // a public read-only board of today's table schedule plus recent results,
  // reusing buildOverlayFixture for each fixture so the shapes stay
  // consistent with the OBS overlay above.
  getArena: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const today = new Date().toISOString().slice(0, 10);
    const leagueFixtures = db.fixtures.filter((f) => f.leagueId === league.id);

    const withOverlay = (fixture) => {
      const division = db.divisions.find((d) => d.id === fixture.divisionId);
      if (!division) return null;
      return {
        ...buildOverlayFixture(fixture),
        tableId: fixture.tableId,
        scheduledDate: fixture.scheduledDate,
        scheduledTime: fixture.scheduledTime,
      };
    };

    const todaysFixtures = leagueFixtures
      .filter((f) => f.status !== 'completed' && (f.scheduledDate === today || f.status === 'in_progress'))
      .map(withOverlay)
      .filter(Boolean);

    const recentResults = leagueFixtures
      .filter((f) => f.status === 'completed')
      .sort((a, b) => new Date(b.scheduledDate || 0) - new Date(a.scheduledDate || 0))
      .slice(0, 8)
      .map(withOverlay)
      .filter(Boolean);

    const tables = league.tables.map((table) => ({
      ...table,
      fixture: todaysFixtures.find((f) => f.tableId === table.id) || null,
    }));
    const unscheduled = todaysFixtures.filter((f) => !f.tableId);

    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      tables,
      unscheduled,
      recentResults,
    };
  }),

  // Public League Table / League Fixtures (embeddable pages) - mirrors
  // server/src/index.js's GET /api/public/leagues/:id/table and
  // GET /api/public/leagues/:id/fixtures.
  getPublicLeagueTable: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions
      .filter((d) => d.leagueId === league.id)
      .sort((a, b) => a.order - b.order)
      .map((division) => {
        const hydrated = hydrateDivision(division);
        return {
          divisionId: division.id,
          divisionName: division.name,
          entryType: division.entryType,
          scheduling: division.scheduling,
          status: division.status || 'active',
          standings: hydrated.standings,
        };
      });
    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      divisions,
    };
  }),

  getPublicLeagueFixtures: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisionsById = new Map(db.divisions.filter((d) => d.leagueId === league.id).map((d) => [d.id, d]));

    const buildPublicFixture = (fixture) => {
      const division = divisionsById.get(fixture.divisionId);
      if (!division) return null;
      return {
        ...buildOverlayFixture(fixture),
        divisionId: division.id,
        round: fixture.round,
        scheduledDate: fixture.scheduledDate,
        scheduledTime: fixture.scheduledTime,
      };
    };

    const fixtures = db.fixtures
      .filter((f) => f.leagueId === league.id)
      .filter((f) => isRoundVisible(divisionsById.get(f.divisionId), f.round))
      .map(buildPublicFixture)
      .filter(Boolean)
      .sort((a, b) => {
        const aDone = a.status === 'completed';
        const bDone = b.status === 'completed';
        if (aDone !== bDone) return aDone ? 1 : -1;
        if (aDone) return new Date(b.scheduledDate || 0) - new Date(a.scheduledDate || 0);
        if (!a.scheduledDate && !b.scheduledDate) return 0;
        if (!a.scheduledDate) return 1;
        if (!b.scheduledDate) return -1;
        return new Date(a.scheduledDate) - new Date(b.scheduledDate);
      });

    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      fixtures,
    };
  }),

  // Public Division Table / Division Fixtures (embeddable pages) - mirrors
  // server/src/index.js's GET /api/public/divisions/:id/table and
  // GET /api/public/divisions/:id/fixtures.
  getPublicDivisionTable: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);
    const hydrated = hydrateDivision(division);
    return {
      divisionId: division.id,
      divisionName: division.name,
      leagueId: division.leagueId,
      leagueName: league ? league.name : null,
      entryType: division.entryType,
      scheduling: division.scheduling,
      status: division.status || 'active',
      generatedAt: new Date().toISOString(),
      standings: hydrated.standings,
    };
  }),

  getPublicDivisionFixtures: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);

    const buildPublicFixture = (fixture) => ({
      ...buildOverlayFixture(fixture),
      divisionId: division.id,
      round: fixture.round,
      scheduledDate: fixture.scheduledDate,
      scheduledTime: fixture.scheduledTime,
    });

    const fixtures = db.fixtures
      .filter((f) => f.divisionId === division.id)
      .filter((f) => isRoundVisible(division, f.round))
      .map(buildPublicFixture)
      .filter(Boolean)
      .sort((a, b) => {
        const aDone = a.status === 'completed';
        const bDone = b.status === 'completed';
        if (aDone !== bDone) return aDone ? 1 : -1;
        if (aDone) return new Date(b.scheduledDate || 0) - new Date(a.scheduledDate || 0);
        if (!a.scheduledDate && !b.scheduledDate) return 0;
        if (!a.scheduledDate) return 1;
        if (!b.scheduledDate) return -1;
        return new Date(a.scheduledDate) - new Date(b.scheduledDate);
      });

    return {
      divisionId: division.id,
      divisionName: division.name,
      leagueId: division.leagueId,
      leagueName: league ? league.name : null,
      generatedAt: new Date().toISOString(),
      fixtures,
    };
  }),

  // Public Division Bracket (embeddable page) - mirrors server/src/index.js's
  // GET /api/public/divisions/:id/bracket, including double-elimination
  // support (see that file's comment for the full reasoning).
  getPublicDivisionBracket: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const isDoubleElim = division.scheduling === 'knockout_double_elim';
    if (division.scheduling !== 'knockout_single_elim' && !isDoubleElim) {
      throw new ApiError(400, 'This endpoint only supports single- or double-elimination knockout divisions');
    }
    const league = db.leagues.find((l) => l.id === division.leagueId);
    const hydrated = hydrateDivision(division);

    const buildPublicBracketMatch = (fixture) => {
      const overlay = buildOverlayFixture(fixture);
      return {
        id: fixture.id,
        round: fixture.round,
        home: overlay.home,
        away: overlay.away,
        status: overlay.status,
        bothEntrantsKnown: overlay.bothEntrantsKnown,
        winnerSide: overlay.winner === 'home' || overlay.winner === 'away' ? overlay.winner : null,
        closedEarly: !!fixture.closedEarly,
      };
    };

    const buildPublicDoubleElimMatch = (fixture) => ({
      ...buildPublicBracketMatch(fixture),
      bracketRole: fixture.bracketRole,
      nextFixtureId: fixture.nextFixtureId || null,
      loserNextFixtureId: fixture.loserNextFixtureId || null,
      resetFixtureId: fixture.resetFixtureId || null,
    });

    const visibleFixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
    const matches = isDoubleElim
      ? visibleFixtures.map(buildPublicDoubleElimMatch)
      : visibleFixtures.map(buildPublicBracketMatch);

    return {
      divisionId: division.id,
      divisionName: division.name,
      leagueId: division.leagueId,
      leagueName: league ? league.name : null,
      entryType: division.entryType,
      scheduling: division.scheduling,
      status: division.status || 'active',
      totalRounds: isDoubleElim ? null : hydrated.totalRounds,
      generatedAt: new Date().toISOString(),
      matches,
    };
  }),

  recordFrame: op((fixtureId, winnerPlayerId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (division.entryType === 'teams') throw new ApiError(400, 'This is a team fixture - record frames against a specific leg instead');
    if (!fixture.homePlayerId || !fixture.awayPlayerId) throw new ApiError(400, 'Both players for this fixture are not yet known - waiting on an earlier round');
    if (fixture.status === 'completed') {
      throw new ApiError(400, `Match is already complete (${fixture.homeFrameScore}-${fixture.awayFrameScore}). Undo a frame to make corrections.`);
    }
    if (fixture.status === 'pending_confirmation') {
      throw new ApiError(400, 'This result has already been submitted and is awaiting confirmation from the other side.');
    }
    if (fixture.status === 'disputed') {
      throw new ApiError(400, 'This result is disputed - an admin needs to resolve it (Game Adjustments) before more frames can be recorded.');
    }
    if (![fixture.homePlayerId, fixture.awayPlayerId].includes(winnerPlayerId)) {
      throw new ApiError(400, 'winnerPlayerId must be one of the two players in this fixture');
    }
    if (fixture.homeFrameScore >= fixture.raceTo || fixture.awayFrameScore >= fixture.raceTo) {
      throw new ApiError(400, `The race target (${fixture.raceTo}) has been reached - submit the result for confirmation instead of recording another frame.`);
    }
    fixture.frames.push({ frameNumber: fixture.frames.length + 1, winnerPlayerId });
    fixture.homeFrameScore = fixture.frames.filter((f) => f.winnerPlayerId === fixture.homePlayerId).length;
    fixture.awayFrameScore = fixture.frames.filter((f) => f.winnerPlayerId === fixture.awayPlayerId).length;
    fixture.status = 'in_progress';
    // No auto-complete - see the server's matching route for why (reaching
    // the race target just unlocks "Submit for Confirmation").
    return fixture;
  }),

  undoLastFrame: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const undoDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(undoDivision, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.frames.length === 0) throw new ApiError(400, 'No frames recorded yet');
    if (fixture.nextFixtureId && fixture.status === 'completed') {
      throw new ApiError(400, 'This result has already advanced a player to the next round and cannot be undone here');
    }
    if (fixture.resetFixtureId) {
      throw new ApiError(400, 'This Grand Final result already triggered a bracket-reset decider and cannot be undone here');
    }
    if (fixture.status === 'pending_confirmation' || fixture.status === 'disputed') {
      throw new ApiError(400, 'This result is awaiting confirmation or is disputed - an admin needs to reopen it (Game Adjustments) before frames can be undone');
    }
    fixture.frames.pop();
    fixture.homeFrameScore = fixture.frames.filter((f) => f.winnerPlayerId === fixture.homePlayerId).length;
    fixture.awayFrameScore = fixture.frames.filter((f) => f.winnerPlayerId === fixture.awayPlayerId).length;
    fixture.winnerPlayerId = null;
    fixture.status = fixture.frames.length === 0 ? 'scheduled' : 'in_progress';
    return fixture;
  }),

  // ---- Result confirmation (singles/doubles) - mirrors server/src/index.js's
  // submit-result / confirm-result / dispute-result / reopen routes. ----
  submitResult: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (division.entryType === 'teams') throw new ApiError(400, 'This is a team fixture - submit each leg individually');
    if (fixture.status !== 'in_progress') throw new ApiError(400, 'Only an in-progress match can be submitted for confirmation');
    if (fixture.homeFrameScore < fixture.raceTo && fixture.awayFrameScore < fixture.raceTo) {
      throw new ApiError(400, `Neither side has reached the race target (${fixture.raceTo}) yet`);
    }
    fixture.winnerPlayerId = fixture.homeFrameScore >= fixture.raceTo ? fixture.homePlayerId : fixture.awayPlayerId;
    fixture.status = 'pending_confirmation';
    fixture.homeConfirmed = false;
    fixture.awayConfirmed = false;
    fixture.resultSubmittedAt = new Date().toISOString();
    fixture.resultSubmittedBy = currentUser()?.id || null;
    return fixture;
  }),

  confirmResult: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can confirm this result');
    }
    if (user?.isAdmin) {
      fixture.homeConfirmed = true;
      fixture.awayConfirmed = true;
    } else {
      if (isHome) fixture.homeConfirmed = true;
      if (isAway) fixture.awayConfirmed = true;
    }
    if (fixture.homeConfirmed && fixture.awayConfirmed) {
      fixture.status = 'completed';
      propagateWinner(division, fixture, fixture.winnerPlayerId);
      const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
      propagateLoser(division, fixture, loserPlayerId);
      checkGrandFinalReset(division, fixture);
    }
    return fixture;
  }),

  disputeResult: op((fixtureId, reason) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can dispute this result');
    }
    if (!reason || !reason.trim()) throw new ApiError(400, 'A reason is required when disputing a result');
    fixture.status = 'disputed';
    fixture.winnerPlayerId = null;
    fixture.disputeReason = reason.trim();
    return fixture;
  }),

  adminReopenFixture: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (!['pending_confirmation', 'disputed'].includes(fixture.status)) {
      throw new ApiError(400, 'Only a pending or disputed result can be reopened');
    }
    fixture.status = 'in_progress';
    fixture.winnerPlayerId = null;
    fixture.disputeReason = null;
    fixture.homeConfirmed = false;
    fixture.awayConfirmed = false;
    fixture.noShowClaim = null;
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.reopen', targetType: 'fixture', targetId: fixture.id,
      details: 'Reopened a pending/disputed result for further scoring',
    });
    return fixture;
  }),

  // ---- Non-contactable / No-Show claims - mirrors server/src/index.js's
  // POST .../no-show and POST .../no-show/authorize (see that file for the
  // full design note). ----
  claimNoShow: op((fixtureId, legNumber) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    const claimantName = user ? `${user.firstName} ${user.lastName}` : 'A player';

    if (legNumber !== undefined && legNumber !== null) {
      const { leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
      if (!['scheduled', 'in_progress'].includes(leg.status)) {
        throw new ApiError(400, 'Only a leg with both players nominated, that has not yet been submitted, can be reported as a no-show');
      }
      const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
      const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
      if (!user?.isAdmin && !isHome && !isAway) {
        throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can report a no-show');
      }
      const winnerPlayerId = isHome ? leg.homePlayerId : leg.awayPlayerId;
      leg.status = 'disputed';
      leg.winnerPlayerId = null;
      leg.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
      leg.noShowClaim = {
        claimedBy: user?.id,
        claimedByName: claimantName,
        claimedSide: isHome ? 'home' : 'away',
        winnerPlayerId,
        at: new Date().toISOString(),
      };
      recomputeTeamFixture(division, fixture);
      return fixture;
    }

    if (division.entryType === 'teams') {
      throw new ApiError(400, 'This is a team fixture - report a no-show against the specific leg');
    }
    if (!['scheduled', 'in_progress'].includes(fixture.status)) {
      throw new ApiError(400, 'Only a match that has not yet been submitted can be reported as a no-show');
    }
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can report a no-show');
    }
    const winnerPlayerId = isHome ? fixture.homePlayerId : fixture.awayPlayerId;
    fixture.status = 'disputed';
    fixture.winnerPlayerId = null;
    fixture.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
    fixture.noShowClaim = {
      claimedBy: user?.id,
      claimedByName: claimantName,
      claimedSide: isHome ? 'home' : 'away',
      winnerPlayerId,
      at: new Date().toISOString(),
    };
    return fixture;
  }),

  authorizeNoShow: op((fixtureId, legNumber) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);

    if (legNumber !== undefined && legNumber !== null) {
      const { leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
      if (!leg.noShowClaim) throw new ApiError(400, 'This leg has no no-show claim to authorise');
      leg.homeFrameScore = 0;
      leg.awayFrameScore = 0;
      leg.frames = [];
      leg.winnerPlayerId = leg.noShowClaim.winnerPlayerId;
      leg.status = 'completed';
      leg.disputeReason = null;
      recomputeTeamFixture(division, fixture);
      recordAudit(db, {
        actor: adminLabel(), action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
        details: `Authorised a non-contactable/no-show 0-0 walkover win for ${leg.noShowClaim.claimedByName} on Leg ${leg.legNumber}`,
      });
      return fixture;
    }

    if (!fixture.noShowClaim) throw new ApiError(400, 'This fixture has no no-show claim to authorise');
    fixture.homeFrameScore = 0;
    fixture.awayFrameScore = 0;
    fixture.frames = [];
    fixture.winnerPlayerId = fixture.noShowClaim.winnerPlayerId;
    fixture.status = 'completed';
    fixture.disputeReason = null;
    fixture.adminOverride = { at: new Date().toISOString(), by: adminLabel() };
    propagateWinner(division, fixture, fixture.winnerPlayerId);
    const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
    propagateLoser(division, fixture, loserPlayerId);
    checkGrandFinalReset(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
      details: `Authorised a non-contactable/no-show 0-0 walkover win for ${fixture.noShowClaim.claimedByName}`,
    });
    return fixture;
  }),

  createTeam: op((divisionId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Team name is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'teams') throw new ApiError(400, 'This is a singles division - add players directly instead');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add teams after fixtures have been generated for this division');
    const team = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
    db.teams.push(team);
    division.teamIds.push(team.id);
    return hydrateDivision(division);
  }),

  removeTeam: op((divisionId, teamId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove teams after fixtures have been generated for this division');
    division.teamIds = division.teamIds.filter((id) => id !== teamId);
    return hydrateDivision(division);
  }),

  addTeamPlayer: op((teamId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const team = db.teams.find((t) => t.id === teamId);
    if (!team) throw new ApiError(404, 'Team not found');
    const division = db.divisions.find((d) => d.id === team.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    if (!team.playerIds.includes(player.id)) team.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removeTeamPlayer: op((teamId, playerId) => {
    const team = db.teams.find((t) => t.id === teamId);
    if (!team) throw new ApiError(404, 'Team not found');
    const division = db.divisions.find((d) => d.id === team.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
    team.playerIds = team.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  nominateLeg: op((fixtureId, legNumber, homePlayerId, awayPlayerId) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const nominateDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(nominateDivision, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (!fixture.homeTeamId || !fixture.awayTeamId) throw new ApiError(400, 'Both teams for this fixture are not yet known - waiting on an earlier round');
    if (leg.status !== 'pending') throw new ApiError(400, 'This leg already has nominated players - undo its frames first to change them');
    const homeTeam = db.teams.find((t) => t.id === fixture.homeTeamId);
    const awayTeam = db.teams.find((t) => t.id === fixture.awayTeamId);
    if (!homeTeam.playerIds.includes(homePlayerId)) throw new ApiError(400, 'Home player is not registered to the home team');
    if (!awayTeam.playerIds.includes(awayPlayerId)) throw new ApiError(400, 'Away player is not registered to the away team');
    leg.homePlayerId = homePlayerId;
    leg.awayPlayerId = awayPlayerId;
    leg.status = 'scheduled';
    return fixture;
  }),

  recordLegFrame: op((fixtureId, legNumber, winnerPlayerId) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.status === 'completed') throw new ApiError(400, 'This team match is already decided');
    if (leg.status === 'pending') throw new ApiError(400, 'Nominate both players for this leg before recording frames');
    if (leg.status === 'completed') {
      throw new ApiError(400, `This leg is already complete (${leg.homeFrameScore}-${leg.awayFrameScore}). Undo a frame to make corrections.`);
    }
    if (leg.status === 'pending_confirmation') {
      throw new ApiError(400, "This leg's result has already been submitted and is awaiting confirmation from the away side.");
    }
    if (leg.status === 'disputed') {
      throw new ApiError(400, "This leg's result is disputed - an admin needs to resolve it (Game Adjustments) before more frames can be recorded.");
    }
    if (![leg.homePlayerId, leg.awayPlayerId].includes(winnerPlayerId)) {
      throw new ApiError(400, 'winnerPlayerId must be one of the two nominated players for this leg');
    }
    if (leg.homeFrameScore >= leg.raceTo || leg.awayFrameScore >= leg.raceTo) {
      throw new ApiError(400, `This leg's race target (${leg.raceTo}) has been reached - submit the result for confirmation instead of recording another frame.`);
    }
    leg.frames.push({ frameNumber: leg.frames.length + 1, winnerPlayerId });
    leg.homeFrameScore = leg.frames.filter((f) => f.winnerPlayerId === leg.homePlayerId).length;
    leg.awayFrameScore = leg.frames.filter((f) => f.winnerPlayerId === leg.awayPlayerId).length;
    leg.status = 'in_progress';
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  undoLastLegFrame: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.frames.length === 0) throw new ApiError(400, 'No frames recorded yet for this leg');
    if (fixture.nextFixtureId && fixture.status === 'completed') {
      throw new ApiError(400, 'This result has already advanced a team to the next round and cannot be undone here');
    }
    if (fixture.resetFixtureId) {
      throw new ApiError(400, 'This Grand Final result already triggered a bracket-reset decider and cannot be undone here');
    }
    if (leg.status === 'pending_confirmation' || leg.status === 'disputed') {
      throw new ApiError(400, "This leg's result is awaiting confirmation or is disputed - an admin needs to reopen it (Game Adjustments) before frames can be undone");
    }
    leg.frames.pop();
    leg.homeFrameScore = leg.frames.filter((f) => f.winnerPlayerId === leg.homePlayerId).length;
    leg.awayFrameScore = leg.frames.filter((f) => f.winnerPlayerId === leg.awayPlayerId).length;
    leg.winnerPlayerId = null;
    leg.status = leg.frames.length === 0 ? 'scheduled' : 'in_progress';
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  // ---- Result confirmation (team legs) - mirrors the singles version above. ----
  submitLegResult: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const submitDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(submitDivision, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.status !== 'in_progress') throw new ApiError(400, 'Only an in-progress leg can be submitted for confirmation');
    if (leg.homeFrameScore < leg.raceTo && leg.awayFrameScore < leg.raceTo) {
      throw new ApiError(400, `Neither side has reached this leg's race target (${leg.raceTo}) yet`);
    }
    leg.winnerPlayerId = leg.homeFrameScore >= leg.raceTo ? leg.homePlayerId : leg.awayPlayerId;
    leg.status = 'pending_confirmation';
    leg.homeConfirmed = false;
    leg.awayConfirmed = false;
    return fixture;
  }),

  confirmLegResult: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
    const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
    const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can confirm this leg');
    }
    if (user?.isAdmin) {
      leg.homeConfirmed = true;
      leg.awayConfirmed = true;
    } else {
      if (isHome) leg.homeConfirmed = true;
      if (isAway) leg.awayConfirmed = true;
    }
    if (leg.homeConfirmed && leg.awayConfirmed) {
      leg.status = 'completed';
    }
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  disputeLegResult: op((fixtureId, legNumber, reason) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
    const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
    const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can dispute this leg');
    }
    if (!reason || !reason.trim()) throw new ApiError(400, 'A reason is required when disputing a result');
    leg.status = 'disputed';
    leg.winnerPlayerId = null;
    leg.disputeReason = reason.trim();
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  adminReopenLeg: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!['pending_confirmation', 'disputed'].includes(leg.status)) {
      throw new ApiError(400, 'Only a pending or disputed leg can be reopened');
    }
    leg.status = 'in_progress';
    leg.winnerPlayerId = null;
    leg.disputeReason = null;
    leg.homeConfirmed = false;
    leg.awayConfirmed = false;
    leg.noShowClaim = null;
    recomputeTeamFixture(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.leg_reopen', targetType: 'fixture', targetId: fixture.id,
      details: `Reopened Leg ${leg.legNumber} for further scoring`,
    });
    return fixture;
  }),

  getPlayerProfile: op((playerId) => {
    const profile = buildPlayerProfile(db, playerId);
    if (!profile) throw new ApiError(404, 'Player not found');
    return profile;
  }),
};
