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
  }
  if (!base) base = structuredClone(demoDataSeed);
  return backfillState(base);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let db = loadInitialDb();

function persist() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
  }
}

let currentUserId = (() => {
  try {
    const stored = localStorage.getItem(CURRENT_USER_KEY);
    if (stored && db.users.some((u) => u.id === stored)) return stored;
  } catch {
  }
  return db.users[0]?.id || null;
})();

function setCurrentUser(userId) {
  currentUserId = userId;
  try {
    localStorage.setItem(CURRENT_USER_KEY, userId);
  } catch {
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

function createUserAccount(fields) {
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

function isRoundVisible(division, round) {
  return !!division && Array.isArray(division.visibleRounds) && division.visibleRounds.includes(round);
}

function hydrateDivision(division) {
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const leagueName = league ? league.name : null;

  const isTeamsDivision = division.entryType === 'teams';
  const displayFixtures = fixtures.map((f) => ({
    ...f,
    bothEntrantsKnown: isTeamsDivision
      ? !!(f.homeTeamId && f.awayTeamId)
      : !!(f.homePlayerId && f.awayPlayerId),
  }));
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
  persist();
}

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

function markAllRoundsVisible(division) {
  const rounds = new Set(db.fixtures.filter((f) => f.divisionId === division.id).map((f) => f.round));
  division.visibleRounds = Array.from(rounds).sort((a, b) => a - b);
}

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
    byeSlot: null,
    reserved: false,
    bracketRole: 'single',
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
  if (next.byeSlot) resolveByeIfNeeded(division, next);
}

function generateKnockoutFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const bracketRounds = buildBracketRounds(entrantIds, { reservedCount });

  const fixturesByRound = bracketRounds.map((pairs, roundIndex) =>
    pairs.map(() => makeFixture({ league, division, round: roundIndex + 1 }))
  );

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
  if (dest.byeSlot) resolveByeIfNeeded(division, dest);
}

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

function generateDoubleElimFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

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
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(division, fixture));
}

function generateAllyDoubleElimFixtures({ league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

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
