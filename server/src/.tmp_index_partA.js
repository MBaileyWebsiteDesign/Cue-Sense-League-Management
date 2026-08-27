import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readDb, writeDb, resetDb, restoreDb } from './db.js';
import { generateRoundRobin, generateRoundRobinDouble } from './services/roundRobin.js';
import { buildBracketRounds, buildDoubleElimBracket, RESERVED_SLOT } from './services/bracket.js';
import { nextRound as adaptiveNextRound } from './services/adaptiveDoubleElim.js';
import { computeStandings } from './services/standings.js';
import { computeTeamStandings } from './services/teamStandings.js';
import { computeTourStandings } from './services/tours.js';
import { buildPlayerProfile } from './services/playerProfile.js';
import { ApiError } from './errors.js';
import {
  CLASSIFICATIONS,
  hashPassword,
  verifyPassword,
  generateTempPassword,
  createSessionToken,
  verifySessionToken,
  publicUser,
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireAnyAdmin,
  assertLeagueAccess,
  generateApiKeyValue,
  hashApiKey,
} from './userAuth.js';
import { recordAudit } from './services/auditLog.js';

const STATUSES = ['active', 'suspended'];

// Late-entrant reserved bye slots (knockout only, singles only - see
// quick-add-player and claim-reserved-slot below). Up to this many round-1
// entrants are held back from normal pairing at fixture-generation time and
// seeded alone into their own bye box instead - see buildBracketRounds'
// reservedCount doc (server/src/services/bracket.js) for the full design,
// and generateKnockoutFixtures/generateDoubleElimFixtures below for how the
// resulting box is left deliberately unresolved until a late entrant claims
// it or an admin closes late entry for the division. Applied to BOTH
// knockout formats uniformly - buildDoubleElimBracket's loser-count math
// was extended (see its own comments) specifically so this could go beyond
// the single reserved pair an earlier, reverted version of this feature
// shipped with.
//
// Set to 0 to turn the whole feature off (temporarily, pending a rethink -
// Aug 2026): reservedByeCountFor floors at 0 regardless of entrant count,
// so generateKnockoutFixtures/generateDoubleElimFixtures never create a
// reserved box, and quick-add-player's "claim a reserved slot" path never
// finds one to claim (falling straight through to its existing "no
// reserved late-entrant slot is open" error once fixtures exist). Nothing
// else here was touched - the surrounding plumbing (routes, claim logic,
// close-late-entry, the client's "Reserved" labeling) is all still in
// place and will work again unchanged the moment this is raised above 0.
// Does not affect divisions whose fixtures were already generated while
// this was non-zero - any reserved boxes they already have stay as they
// are unless an admin claims or closes them.
const MAX_RESERVED_BYE_COUNT = 0;

// Caps how many round-1 boxes can be reserved for late entrants relative to
// the field size, so a small division doesn't end up mostly byes - always
// leaves at least one real round-1 match. Every knockout division gets as
// many reserved slots as this allows (up to MAX_RESERVED_BYE_COUNT) - not
// currently an admin-configurable per-division setting.
function reservedByeCountFor(entrantCount) {
  return Math.max(0, Math.min(MAX_RESERVED_BYE_COUNT, Math.floor(entrantCount / 2) - 1));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // season CSV/Excel imports can be a few hundred rows; a full-system backup restore (see POST /api/admin/restore) can be larger still

const asyncRoute = (fn) => (req, res, next) => {
  try {
    fn(req, res);
  } catch (err) {
    next(err);
  }
};

const SCHEDULING_TYPES = ['round_robin_single', 'round_robin_double', 'knockout_single_elim', 'knockout_double_elim', 'knockout_double_elim_ally', 'knockout_double_elim_test', 'knockout_double_elim_pcdek', 'knockout_double_elim_adek'];
// Divisions using any double-elimination format share almost all downstream
// logic (champion detection, knockout-only UI, public bracket view) - only
// fixture *generation* (generateDoubleElimFixtures /
// generateAllyDoubleElimFixtures / generateTestingDoubleElimFixtures /
// generatePCDEKFixtures, see each below) and late-entrant rebuild (which
// only 'knockout_double_elim' supports) differ.
const DOUBLE_ELIM_TYPES = ['knockout_double_elim', 'knockout_double_elim_ally', 'knockout_double_elim_test', 'knockout_double_elim_pcdek', 'knockout_double_elim_adek'];

// "Adaptive Double Elimination Knockout" (ADEK). The odd one out among the
// double-elim formats: every other one builds its ENTIRE fixture graph at
// generation time and then reactively swaps entrants between boxes to dodge
// rematches. ADEK builds ONE ROUND AT A TIME - each round's pairings are
// computed only once the previous round's results are in, by
// services/adaptiveDoubleElim.js. That is what lets it GUARANTEE no rematch
// before the Losers Final / Winners Final / Grand Final, which a fixed
// routing graph provably cannot (see generatePCDEKFixtures' comment for that
// proof - it is correct, and it is a proof about FIXED routing, which is
// exactly the assumption this format drops).
//
// Consequences of being round-at-a-time, all deliberate:
//   * no nextFixtureId / loserNextFixtureId anywhere, so the reactive
//     placement engine (propagateWinner/propagateLoser/avoidRematchOn-
//     Placement) never touches these fixtures - ADEK does its own pairing.
//   * later rounds simply do not exist until they are earned. Rounds are
//     appended by appendAdaptiveRoundsIfDue() below.
//   * NO bracket reset - a single Grand Final decides the title (see the
//     guard in checkGrandFinalReset).
//   * late-entrant rebuild is not supported (nothing to rebuild).
const ADEK = 'knockout_double_elim_adek';

// ---------- Accounts & auth ----------
// One account model, one login. `db.users` holds everyone; `isAdmin` and
// `isCaptain` are just boolean flags on an account rather than a separate
// kind of account. Anyone can self-register (POST /users/register), and an
// admin can flag any account as admin and/or captain from the user
// management screen, or via the season CSV/Excel import.

app.post('/api/auth/login', asyncRoute((req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Email and password are required');

  const db = readDb();
  const normalizedEmail = email.trim().toLowerCase();
  const user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, 'Invalid email or password');
  }
  if (user.status === 'suspended') {
    throw new ApiError(403, 'This account has been suspended');
  }

  const { token, expiresAt } = createSessionToken(user.id);
  res.json({ token, expiresAt, user: publicUser(user) });
}));

// Consumes a password-reset link generated by an admin from a player's
// profile page (see POST /api/admin/users/:id/send-reset-link below) -
// public/unauthenticated, since the whole point is for someone who's lost
// access to their password to be able to set a new one. The token itself is
// the credential here (a long random value, single-use, short-lived), so
// there's nothing else to check the requester's identity against.
app.post('/api/auth/reset-password/:token', asyncRoute((req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) throw new ApiError(400, 'New password must be at least 8 characters');

  const db = readDb();
  const reset = db.passwordResets.find((r) => r.token === req.params.token);
  if (!reset) throw new ApiError(404, 'This reset link is invalid');
  if (reset.usedAt) throw new ApiError(400, 'This reset link has already been used - ask an admin to send a new one');
  if (Date.now() > reset.expiresAt) throw new ApiError(400, 'This reset link has expired - ask an admin to send a new one');

  const user = db.users.find((u) => u.id === reset.userId);
  if (!user) throw new ApiError(404, 'Account not found');

  user.passwordHash = hashPassword(newPassword);
  reset.usedAt = new Date().toISOString();
  writeDb(db);
  res.json({ ok: true });
}));

app.post('/api/users/register', asyncRoute((req, res) => {
  const {
    firstName, lastName, email, password,
    phone = '', teamName = '', classification = null,
  } = req.body;

  if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
  if (!lastName || !lastName.trim()) throw new ApiError(400, 'Last name is required');
  if (!email || !email.trim()) throw new ApiError(400, 'Email is required');
  if (!password || password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
  if (classification && !CLASSIFICATIONS.includes(classification)) {
    throw new ApiError(400, `classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
  }

  const db = readDb();
  const normalizedEmail = email.trim().toLowerCase();
  if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
    throw new ApiError(409, 'An account with this email already exists');
  }

  const user = createUserAccount(db, {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim(),
    passwordHash: hashPassword(password),
    phone: phone ? phone.trim() : '',
    // Team name is optional at self-registration (unlike the admin bulk-add
    // and season-import flows, which default a blank one to 'Unassigned') -
    // a player can register before knowing/being assigned to a team, so an
    // empty string is left as-is here rather than substituted.
    teamName: teamName ? teamName.trim() : '',
    classification: classification || null,
    isAdmin: false,
    isCaptain: false,
  });
  writeDb(db);

  const { token, expiresAt } = createSessionToken(user.id);
  res.status(201).json({ token, expiresAt, user: publicUser(user) });
}));

app.get('/api/users/me', requireAuth, asyncRoute((req, res) => {
  res.json(publicUser(req.auth.user));
}));

// A player's league/division membership, shown as a static read-only field
// in the Player Portal's "Your Details" section - deliberately separate from
// GET /api/users/me/fixtures (which only reflects divisions that already
// have released fixtures), so a newly-registered player who hasn't been
// fixtured yet still sees which league/division they're in.
app.get('/api/users/me/leagues', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const playerId = req.auth.user.playerId;
  if (!playerId) return res.json([]);
  const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
  const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
  const divisions = db.divisions.filter((d) =>
    (d.playerIds || []).includes(playerId) ||
    (d.teamIds || []).some((id) => myTeamIds.includes(id)) ||
    (d.pairingIds || []).some((id) => myPairingIds.includes(id))
  );
  // divisionId/leagueId/status added alongside the original leagueName/
  // divisionName pair (kept for ProfileForm.jsx's existing inline summary)
  // so the player portal's own "My Leagues & Divisions" section (NQT: list
  // divisions/leagues they're in or have been in) can link straight into
  // each one and show whether it's still running. Membership here is never
  // cleared when a division completes, so this already covers past
  // divisions, not just current ones.
  const result = divisions.map((d) => {
    const league = db.leagues.find((l) => l.id === d.leagueId);
    return {
      leagueId: d.leagueId,
      leagueName: league?.name || 'Unknown league',
      divisionId: d.id,
      divisionName: d.name,
      status: d.status || 'active',
    };
  });
  res.json(result);
}));

// Shared account-creation helper: builds the User record (and its linked
// Player roster entry, find-or-create by name) the same way whether the
// account came from self-registration, the season CSV/Excel import, or the
// wizard's "add a player manually" step. Doesn't write to disk - caller
// batches the writeDb() once all rows in a request are processed.
function createUserAccount(db, fields) {
  // Quick Add (walk-in) only requires a first name, so lastName can be
  // empty here - tolerate that without leaving a stray trailing space.
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
    passwordHash: fields.passwordHash,
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

// Keeps a User's linked Player roster entry's display name in sync whenever
// the account's name changes, whether the edit came from the player
// themselves or from an admin.
function syncLinkedPlayerName(db, user) {
  if (!user.playerId) return;
  const player = db.players.find((p) => p.id === user.playerId);
  if (player) player.name = `${user.firstName} ${user.lastName || ''}`.replace(/\s+/g, ' ').trim();
}

function applyProfileFields(db, user, fields) {
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
  syncLinkedPlayerName(db, user);
}

app.patch('/api/users/me', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.userId);
  applyProfileFields(db, user, req.body);
  writeDb(db);
  res.json(publicUser(user));
}));

app.post('/api/users/me/change-password', requireAuth, asyncRoute((req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    throw new ApiError(400, 'Current and new password are required');
  }
  if (newPassword.length < 8) throw new ApiError(400, 'New password must be at least 8 characters');

  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.userId);
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    throw new ApiError(401, 'Current password is incorrect');
  }
  user.passwordHash = hashPassword(newPassword);
  writeDb(db);
  res.json({ ok: true });
}));

// A player's own upcoming/recent fixtures, across every division they're
// registered in (singles) or rostered onto (teams) - powers the Player
// Portal's "My Fixtures" panel without the client having to know which
// divisions/teams they belong to.
app.get('/api/users/me/fixtures', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const user = req.auth.user;
  if (!user.playerId) return res.json([]);
  const playerId = user.playerId;

  const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
  const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);

  const fixtures = db.fixtures.filter((f) => {
    if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
    if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId)) return true;
    if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
    return false;
  });

  // Even a fixture you're actually in doesn't show up here until the admin
  // has released its round - see isRoundVisible above. An admin viewing their
  // own "My Fixtures" (if their account is also linked to a player) still
  // sees everything, same as everywhere else this gate applies.
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
  res.json(enriched);
}));

// A player's own results currently awaiting THEIR confirmation - fixtures
// where they're the home or away entrant (or team-fixture legs where they're
// the home- or away-nominated player) sitting at `pending_confirmation`,
// where THEIR side hasn't confirmed yet (see homeConfirmed/awayConfirmed -
// both sides must independently confirm before a result counts, see the
// "Result confirmation" section further down). This is the player-facing
// counterpart to the admin's Game Adjustments "Needs Attention" list
// (GET /api/admin/fixtures/needs-attention above), scoped to just the
// actions this one account can actually take - powers the "My Submissions"
// panel on the Player Portal (My Account). Defined here, ahead of
// isAwayEntrant/isHomeEntrant's declaration further down - safe because
// Express only calls this handler once a request arrives, long after every
// function declaration in the module has been hoisted and is available.
app.get('/api/users/me/pending-confirmations', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const playerId = req.auth.user.playerId;
  const results = [];
  if (!playerId) return res.json(results);

  for (const f of db.fixtures) {
    const division = db.divisions.find((d) => d.id === f.divisionId);
    const league = db.leagues.find((l) => l.id === f.leagueId);
    // Same round-visibility gate as everywhere else - a result awaiting your
    // confirmation on a not-yet-released round shouldn't surface here either
    // (shouldn't normally happen since scoring itself is also blocked, but an
    // admin could in principle score ahead of release, so this stays
    // consistent rather than relying on that never happening).
    if (!req.auth.user.isAdmin && !isRoundVisible(division, f.round)) continue;

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
    const isHome = isHomeEntrant(db, division, f, playerId);
    const isAway = isAwayEntrant(db, division, f, playerId);
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
  res.json(results);
}));

// ---------- Leagues ----------

app.get('/api/leagues', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const { user } = req.auth;
  // League Managers (and only League Managers - an Overall Admin who also
  // happens to be flagged isLeagueManager still sees everything) are scoped
  // to just the league(s) an Overall Admin assigned them to via
  // league.managerUserIds - the same access boundary assertLeagueAccess
  // already enforces for write actions, applied here to the read/list
  // endpoint too. Without this, a League Manager's browse-everything home
  // page (LeagueList.jsx) showed every league in the app, not just their
  // own, even though the League Manager Portal and Manage Fixtures picker
  // already filtered client-side. Every other account type (admin, player,
  // captain, unflagged) still sees every league, same as before - this is
  // a public-ish directory for everyone except a scoped League Manager.
  const leagues = (user.isLeagueManager && !user.isAdmin)
    ? db.leagues.filter((l) => (l.managerUserIds || []).includes(user.id))
    : db.leagues;
  res.json(leagues);
}));

app.post('/api/leagues', requireAdmin, asyncRoute((req, res) => {
  const { name, sport = 'English 8-Ball Pool', scheduling = 'round_robin_single', payment, managerUserIds } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'League name is required');

  const db = readDb();

  // Optional: grant League Manager access to one or more already-flagged
  // users at creation time, same as POST /api/leagues/:id/managers would -
  // saves a second trip for the common "I already know who's running this
  // league" case. Silently ignores any id that isn't isLeagueManager-flagged
  // or doesn't exist, rather than erroring the whole league creation.
  let assignedManagerIds = [];
  if (Array.isArray(managerUserIds) && managerUserIds.length > 0) {
    for (const userId of managerUserIds) {
      const user = db.users.find((u) => u.id === userId);
      if (user && user.isLeagueManager) assignedManagerIds.push(userId);
    }
    assignedManagerIds = [...new Set(assignedManagerIds)];
  }

  const league = {
    id: uuid(),
    name: name.trim(),
    sport,
    // Race-to lives on each division now (see POST /api/leagues/:leagueId/divisions
    // below) so different divisions in the same league can use different
    // match lengths - a league itself only still carries a scheduling
    // default new divisions can start from.
    format: { scheduling },
    startDate: null,
    endDate: null,
    createdAt: new Date().toISOString(),
    // Named physical tables for scheduling fixtures onto - see
    // POST /api/leagues/:id/tables and POST /api/fixtures/:id/schedule.
    tables: [],
    // Payment wall - see normalizePaymentConfig/assertPaymentCleared below.
    payment: normalizePaymentConfig(payment),
    managerUserIds: assignedManagerIds,
    // "Open For Registration" - league-level equivalent of a division's "Is
    // Open" - lets any registered player register interest in this league
    // via GET /api/open-leagues + POST /api/leagues/:id/interests, without
    // a League Manager adding them to a division directly. See the
    // "---------- Open leagues ----------" block further down for the full
    // browse/interest/bulk-assign flow.
    isOpenForRegistration: !!req.body.isOpenForRegistration,
  };
  db.leagues.push(league);

  if (assignedManagerIds.length > 0) {
    const names = assignedManagerIds.map((id) => {
      const u = db.users.find((user) => user.id === id);
      return u ? `${u.firstName} ${u.lastName}` : id;
    });
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'league.manager_added',
      targetType: 'league',
      targetId: league.id,
      details: `Gave ${names.join(', ')} League Manager access to "${league.name}" at creation`,
    });
  }

  writeDb(db);
  res.status(201).json(league);
}));

// ---------- Table scheduling ----------
// Named physical tables belong to a league (not a division - the same
// tables serve every division in it), and a fixture can be assigned to one
// plus a date/time via POST /api/fixtures/:id/schedule below. See also the
// Arena display (GET /api/overlay/leagues/:id/arena) for a public read-only
// board of what's on which table.

app.post('/api/leagues/:id/tables', requireAnyAdmin, asyncRoute((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Table name is required');
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  league.tables.push({ id: uuid(), name: name.trim() });
  writeDb(db);
  res.status(201).json(league);
}));

app.delete('/api/leagues/:id/tables/:tableId', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  league.tables = league.tables.filter((t) => t.id !== req.params.tableId);
  // Unassign the table from any fixture that had it, rather than leaving a
  // dangling reference to a table that no longer exists.
  for (const fixture of db.fixtures) {
    if (fixture.leagueId === league.id && fixture.tableId === req.params.tableId) {
      fixture.tableId = null;
    }
  }
  writeDb(db);
  res.json(league);
}));

app.get('/api/leagues/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  const divisions = db.divisions
    .filter((d) => d.leagueId === league.id)
    .sort((a, b) => a.order - b.order);
  res.json({ ...league, divisions });
}));

// Leagues could previously only be created or deleted, never edited - this
// is mainly here so the payment wall (amount, window) can be turned on/off
// or adjusted after a league already exists, but also allows a rename.
app.patch('/api/leagues/:id', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);

  if (req.body.name !== undefined) {
    if (!req.body.name.trim()) throw new ApiError(400, 'League name is required');
    league.name = req.body.name.trim();
  }
  if (req.body.payment !== undefined) {
    league.payment = normalizePaymentConfig(req.body.payment);
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.edit',
    targetType: 'league',
    targetId: league.id,
    details: `Updated settings for "${league.name}"`,
  });

  writeDb(db);
  res.json(league);
}));

// ---------- League Manager assignment ----------
// Overall-Admin-only (deliberately requireAdmin, not requireAnyAdmin/
// assertLeagueAccess) - a League Manager can do almost everything within a
// league they're assigned to, but can never assign or remove managers,
// including themselves, on any league. Only an Overall Admin controls who
// has manager access to which league. The "isLeagueManager" account flag
// (see POST /api/admin/users/:id/permissions) just marks someone as
// eligible to be assigned as a manager somewhere - assertLeagueAccess in
// userAuth.js checks league.managerUserIds for the actual per-league grant.
app.post('/api/leagues/:id/managers', requireAdmin, asyncRoute((req, res) => {
  const { userId } = req.body || {};
  if (!userId) throw new ApiError(400, 'userId is required');
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  const user = db.users.find((u) => u.id === userId);
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.isLeagueManager) {
    throw new ApiError(400, `${user.firstName} ${user.lastName} isn't flagged as a League Manager yet - grant that on their account first`);
  }
  if (!Array.isArray(league.managerUserIds)) league.managerUserIds = [];
  if (!league.managerUserIds.includes(userId)) {
    league.managerUserIds.push(userId);
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'league.manager_added',
      targetType: 'league',
      targetId: league.id,
      details: `Gave ${user.firstName} ${user.lastName} League Manager access to "${league.name}"`,
    });
    writeDb(db);
  }
  res.json(league);
}));

app.delete('/api/leagues/:id/managers/:userId', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  const user = db.users.find((u) => u.id === req.params.userId);
  if (!Array.isArray(league.managerUserIds)) league.managerUserIds = [];
  const hadAccess = league.managerUserIds.includes(req.params.userId);
  league.managerUserIds = league.managerUserIds.filter((id) => id !== req.params.userId);
  if (hadAccess) {
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'league.manager_removed',
      targetType: 'league',
      targetId: league.id,
      details: `Removed ${user ? `${user.firstName} ${user.lastName}` : 'a user'}'s League Manager access to "${league.name}"`,
    });
    writeDb(db);
  }
  res.json(league);
}));

// ---------- League payments (manual confirmation) ----------
// A league can require players to have a confirmed (or waived) payment
// before being added as an entrant to any of its divisions - see
// assertPaymentCleared, used by every place a player becomes an entrant
// (singles/team/pairing add, season-wizard import, substitution). Payment
// is tracked once per (league, player) - not per division - so clearing it
// for one division's entry covers every other division in the same league
// too.

// Admin-only: mark a player's payment 'confirmed' (they paid, however that
// happened outside the app), 'waived' (comp entry - counts the same as
// confirmed for the purposes of assertPaymentCleared), or back to 'unpaid'.
// This only gates *future* adds - it never removes someone already in a
// division.
app.post('/api/leagues/:id/payments/:playerId', requireAnyAdmin, asyncRoute((req, res) => {
  const { status, notes = '' } = req.body || {};
  if (!['confirmed', 'waived', 'unpaid'].includes(status)) {
    throw new ApiError(400, "status must be 'confirmed', 'waived' or 'unpaid'");
  }
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const player = db.players.find((p) => p.id === req.params.playerId);
  if (!player) throw new ApiError(404, 'Player not found');

  let record = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === player.id);
  if (!record) {
    record = {
      id: uuid(),
      leagueId: league.id,
      playerId: player.id,
      status: 'unpaid',
      amount: league.payment.amount,
      currency: league.payment.currency,
      confirmedBy: null,
      confirmedAt: null,
      notes: '',
    };
    db.leaguePayments.push(record);
  }
  record.status = status;
  record.notes = notes;
  record.confirmedBy = status === 'unpaid' ? null : req.adminSession.label;
  record.confirmedAt = status === 'unpaid' ? null : new Date().toISOString();

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.payment',
    targetType: 'league',
    targetId: league.id,
    details: `${player.name}: payment marked ${status} for "${league.name}"`,
  });

  writeDb(db);
  res.json(record);
}));

// Lists every registered player against their payment status for this
// league, for the admin "Payments" tab - includes players with no
// leaguePayments record yet at all (shown as 'unpaid' without writing one,
// so just viewing this list never silently creates rows).
app.get('/api/leagues/:id/payments', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const recordsByPlayer = new Map(
    db.leaguePayments.filter((p) => p.leagueId === league.id).map((p) => [p.playerId, p])
  );
  const players = registeredPlayers(db).map((player) => {
    const record = recordsByPlayer.get(player.id);
    return {
      playerId: player.id,
      playerName: player.name,
      status: record ? record.status : 'unpaid',
      amount: record ? record.amount : league.payment.amount,
      currency: record ? record.currency : league.payment.currency,
      confirmedBy: record ? record.confirmedBy : null,
      confirmedAt: record ? record.confirmedAt : null,
      notes: record ? record.notes : '',
    };
  });
  res.json({ league: { id: league.id, name: league.name, payment: league.payment }, players });
}));

// ---------- Divisions ----------
// A division has two independent axes:
// - entryType: "singles" (players register directly), "teams" (teams
//   register, each fixture is `legsPerMatch` nominated player-vs-player legs),
//   or "doubles" (2-3 named registered players register together as one
//   `Pairing` and play alternate-shot as a single side - structurally a
//   Pairing is just a named group of players like a Team, but a doubles/
//   triples fixture is scored exactly like a singles fixture: one continuous
//   frame race, no legs, `homePlayerId`/`awayPlayerId` just hold a Pairing id
//   instead of a Player id - see the "Pairings" section below)
// - scheduling: "round_robin_single" (default - Round Robin - Single, everyone
//   plays everyone once), "round_robin_double" (Round Robin - Double,
//   everyone plays everyone twice - a home leg and an away leg with sides
//   swapped, see services/roundRobin.js), "knockout_single_elim"
//   (single-elimination bracket, byes only in a round whose survivor count
//   is odd - never just to pad up to a power of two), "knockout_double_elim"
//   (winners bracket + losers bracket + Grand Final, with a bracket-reset
//   decider if the losers-bracket finalist wins the Grand Final - any
//   entrant count of 4+, not just an exact power of 2, see
//   services/bracket.js), or "knockout_double_elim_ally" ("Ally Knockout
//   (Double elimination)" - a second, independently-maintained double-
//   elimination option with its own generator function
//   (generateAllyDoubleElimFixtures) and its own scheduling type, so it can
//   diverge from knockout_double_elim later without either affecting the
//   other; today it uses the identical technique, since extensive testing
//   (claude/ally-knockout-2026-08-14.md) found no algorithm that measurably
//   beats it for this format's constraints - minimum games, at most one bye
//   per entrant ever, and minimizing (not fully eliminating - proven not
//   always possible) rematches before the final), or
//   "knockout_double_elim_pcdek" ("Pre Configured Double Elimination
//   Knockout" - see generatePCDEKFixtures below for what "pre configured"
//   actually means here and why it does NOT guarantee zero rematches
//   before the Grand Final, despite that being the format's original
//   brief). This can
//   differ per division from the league's
//   own default, since a league often runs its regular season as a round
//   robin but a separate cup division as a knockout.

app.post('/api/leagues/:leagueId/divisions', requireAnyAdmin, asyncRoute((req, res) => {
  const { name, order = 0, entryType = 'singles', legsPerMatch = 5, pairingSize = 2, raceTo = 6 } = req.body;
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.leagueId);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const scheduling = req.body.scheduling || league.format.scheduling || 'round_robin_single';

  if (!name || !name.trim()) throw new ApiError(400, 'Division name is required');
  if (!['singles', 'teams', 'doubles'].includes(entryType)) {
    throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
  }
  if (!SCHEDULING_TYPES.includes(scheduling)) {
    throw new ApiError(400, `scheduling must be one of: ${SCHEDULING_TYPES.join(', ')}`);
  }
  if (entryType === 'teams' && (!Number.isInteger(Number(legsPerMatch)) || Number(legsPerMatch) < 1)) {
    throw new ApiError(400, 'legsPerMatch must be a positive whole number');
  }
  if (entryType === 'doubles' && ![2, 3].includes(Number(pairingSize))) {
    throw new ApiError(400, 'pairingSize must be 2 (doubles) or 3 (triples)');
  }
  if (!Number.isInteger(Number(raceTo)) || Number(raceTo) < 1) {
    throw new ApiError(400, 'raceTo must be a whole number of 1 or more');
  }

  const division = {
    id: uuid(),
    leagueId: league.id,
    name: name.trim(),
    order,
    entryType,
    scheduling,
    // Match length - each division sets its own rather than inheriting one
    // fixed value from the league, since a league often runs a main
    // division at one length (e.g. race to 7) and a shorter side division
    // (e.g. a plate/consolation event) at another. Every fixture this
    // division ever generates reads it from here (see makeSinglesFixture/
    // makeTeamFixture) - changing it after fixtures already exist has no
    // effect on fixtures already created, only ones generated after.
    raceTo: Number(raceTo),
    playerIds: [],
    teamIds: [],
    pairingIds: [],
    legsPerMatch: entryType === 'teams' ? Number(legsPerMatch) : null,
    pairingSize: entryType === 'doubles' ? Number(pairingSize) : null,
    gapDays: null,
    fixturesGenerated: false,
    // No round is visible to players until an admin explicitly releases it
    // from "Manage Fixtures" - see isRoundVisible / POST
    // /api/divisions/:id/rounds/:round/visibility below. Admins always see
    // every round regardless of this list.
    visibleRounds: [],
    // 'active' | 'completed' - see POST /api/divisions/:id/close-early
    // below (or its league-wide equivalent, POST /api/leagues/:id/close-early).
    // A division also ends up functionally "complete" the moment its last
    // fixture finishes naturally (see recordChampionIfDivisionComplete), but
    // this field is only ever set by that explicit admin action.
    status: 'active',
    completedAt: null,
    completedBy: null,
    // NQT: "Is Open" - lets any registered player request to join this
    // division without an admin/League Manager adding them directly. See
    // POST /api/divisions/:id/join-requests and the /api/join-requests/:id
    // approve/reject routes further down.
    isOpen: !!req.body.isOpen,
  };
  db.divisions.push(division);
  writeDb(db);
  res.status(201).json(division);
}));

// Round visibility ("Manage Fixtures"): a division's `visibleRounds` (array
// of round numbers) controls which rounds a non-admin account is allowed to
// see or take any action on at all - fixture lists, "My Fixtures"/"Needs Your
// Confirmation", direct fixture pages, and every scoring route. Admins always
// see and can act on every round regardless of this list, so a season can be
// built (and even scored ahead of time) before any of it is revealed to
// players. See POST /api/divisions/:id/rounds/:round/visibility below.
function isRoundVisible(division, round) {
  return !!division && Array.isArray(division.visibleRounds) && division.visibleRounds.includes(round);
}

function hydrateDivision(db, division) {
  // ADEK invents its next round from the results of the last one, so that has
  // to happen BEFORE the fixture list below is built - otherwise the very
  // request that completed a round would return a division with nothing left
  // to play. Loop-with-a-cap rather than once: a round can in principle
  // resolve instantly, and an unbounded loop here would be a hang.
  for (let guard = 0; guard < 4 && appendAdaptiveRoundsIfDue(db, division); guard += 1) {
    writeDb(db);
  }
  // Filtered once here, then reused below - computeStandings/
  // computeTeamStandings used to each be handed the *whole* db.fixtures
  // array and re-filter it by divisionId themselves, meaning every call to
  // hydrateDivision (every division page load, every roster/fixture change)
  // did two full scans over every fixture in the entire app instead of one.
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const leagueName = league ? league.name : null;

  // `bothEntrantsKnown` mirrors the same field the single-fixture endpoint
  // (GET /api/fixtures/:id) and the public/overlay endpoints already expose
  // (see buildOverlayFixture) - added here too so every fixture-list view
  // fed by hydrateDivision (division page, "Manage Fixtures", etc.) can tell
  // "genuinely scheduled and ready to play" apart from "this knockout slot
  // is still waiting on an earlier round's winner" without re-deriving that
  // check in every consuming component. Built as a fresh array (not a
  // mutation of the db.fixtures objects themselves) so the extra field never
  // gets persisted to db.json.
  const isTeamsDivision = division.entryType === 'teams';
  const displayFixtures = fixtures.map((f) => ({
    ...f,
    bothEntrantsKnown: isTeamsDivision
      ? !!(f.homeTeamId && f.awayTeamId)
      : !!(f.homePlayerId && f.awayPlayerId),
  }));
  // Single-elimination round count, computed from the *full* (pre round-
  // visibility-filter) fixture list so it's accurate even for a non-admin
  // viewer who's only been released a later round - see the "Manage
  // Fixtures round visibility" filtering GET /api/divisions/:id does after
  // calling this. Lets the client label rounds by their real distance from
  // the Final (Quarter-final, Semi-final...) instead of a raw round number,
  // without needing to see every earlier round to work out where it sits.
  // null for anything that isn't single-elimination knockout - the client
  // falls back to plain "Round N" labels for those.
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
    // computeStandings just needs an entrant-id list (division.playerIds) and
    // a matching list of { id, name } entrants to label rows with - a Pairing
    // already has both fields, so this reuses the singles standings
    // calculation unmodified rather than needing its own version.
    const standings = computeStandings({ ...division, playerIds: division.pairingIds }, fixtures, pairings);
    hydrated = { ...division, leagueName, pairings, fixtures: displayFixtures, standings };
  } else {
    const players = db.players.filter((p) => division.playerIds.includes(p.id));
    const standings = computeStandings(division, fixtures, db.players);
    hydrated = { ...division, leagueName, players, fixtures: displayFixtures, standings };
  }
  hydrated.totalRounds = totalRounds;
  hydrated.leaguePayment = league ? league.payment : null;
  // So DivisionDetail.jsx can compute canManageLeague(...) for a League
  // Manager without a second round-trip to GET /api/leagues/:id.
  hydrated.leagueManagerUserIds = league && Array.isArray(league.managerUserIds) ? league.managerUserIds : [];

  // Roll of Honour: rather than hooking every single fixture-completion code
  // path (confirm-result, no-show walkovers, admin overrides, team leg
  // majorities...) to separately check "is the division finished now?",
  // it's checked once, centrally, right here - hydrateDivision already runs
  // at the end of every one of those routes (plus every plain GET), so this
  // reliably catches the transition to "complete" wherever it happens. The
  // first hydrate after the division's last fixture completes records the
  // champion (and does one extra writeDb to persist it, since this function
  // runs after the route's own write); every hydrate after that is a cheap
  // no-op, short-circuited by the existing-record check below.
  recordChampionIfDivisionComplete(db, division, hydrated);

  return hydrated;
}
