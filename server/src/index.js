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

function recordChampionIfDivisionComplete(db, division, hydrated) {
  if (!division.fixturesGenerated) return;
  const fixtures = hydrated.fixtures;
  if (fixtures.length === 0) return;
  if (fixtures.some((f) => f.status !== 'completed')) return;
  if (db.rollOfHonour.some((r) => r.divisionId === division.id)) return; // already recorded

  const idField = division.entryType === 'teams' ? 'teamId' : 'playerId';
  const nameField = division.entryType === 'teams' ? 'teamName' : 'playerName';
  let championId = null;

  if (DOUBLE_ELIM_TYPES.includes(division.scheduling)) {
    // The winners-bracket finalist can win the Grand Final outright, or lose
    // it and force a bracket-reset decider (see checkGrandFinalReset)
    // - resetFixtureId is only ever set on a completed grand_final fixture
    // once that decider exists, so it's the reliable signal for which
    // fixture actually decided the title. Identical fixture-graph shape for
    // both double-elim formats (bracketRole/nextFixtureId/resetFixtureId),
    // so this detection logic is genuinely format-agnostic - no need for an
    // Ally-specific copy.
    const grandFinal = fixtures.find((f) => f.bracketRole === 'grand_final');
    if (!grandFinal) return;
    const finalFixture = grandFinal.resetFixtureId
      ? fixtures.find((f) => f.id === grandFinal.resetFixtureId)
      : grandFinal;
    if (!finalFixture || finalFixture.status !== 'completed') return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else if (division.scheduling === 'knockout_single_elim') {
    // Every fixture but the final has a nextFixtureId pointing further into
    // the bracket - the final is the one and only fixture with none.
    const finalFixture = fixtures.find((f) => !f.nextFixtureId);
    if (!finalFixture) return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else {
    // round_robin_single / round_robin_double: champion is top of the final
    // standings (already sorted points -> frame difference -> frames for).
    // A top standing with 0 points means nobody actually won a match - the
    // whole division was closed early (closeOutstandingFixtures) before a
    // single result was played out - so there's no real champion to crown,
    // just whoever happened to sort first among an all-0 table.
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
  writeDb(db);
}

app.get('/api/divisions/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const hydrated = hydrateDivision(db, division);
  // A non-admin only ever sees fixtures from rounds the admin has released -
  // see isRoundVisible above. Standings are left untouched (computed from the
  // full fixture list before this filter) since a not-yet-released round
  // shouldn't have any results on it under normal use anyway.
  if (!req.auth.user.isAdmin) {
    hydrated.fixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
  }
  res.json(hydrated);
}));

// "Change Game Type" (see client/src/pages/DivisionDetail.jsx's
// GenerateFixturesButton): lets an admin revise a division's entryType/
// scheduling/raceTo/legsPerMatch/pairingSize before fixtures exist, mainly so
// the client-side "Estimated Game Time"/"Estimated No. of Games" figures
// shown above the Generate Fixtures button can be corrected without
// deleting and recreating the whole division. Deliberately narrower than
// PATCH /api/leagues/:id: once fixturesGenerated is true the game type is
// locked (mirrors the roster-locking behaviour already enforced elsewhere
// on this division once fixtures exist), and entryType can't be changed
// out from under a roster that's already been built in the old shape
// (singles players vs. teams vs. pairings aren't interchangeable records).
app.patch('/api/divisions/:id', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  if (division.fixturesGenerated) {
    throw new ApiError(400, "Can't change game type once fixtures have been generated for this division.");
  }

  const {
    entryType = division.entryType,
    scheduling = division.scheduling,
    raceTo = division.raceTo,
    legsPerMatch,
    pairingSize,
  } = req.body || {};

  if (!['singles', 'teams', 'doubles'].includes(entryType)) {
    throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
  }
  if (!SCHEDULING_TYPES.includes(scheduling)) {
    throw new ApiError(400, `scheduling must be one of: ${SCHEDULING_TYPES.join(', ')}`);
  }
  if (!Number.isInteger(Number(raceTo)) || Number(raceTo) < 1) {
    throw new ApiError(400, 'raceTo must be a whole number of 1 or more');
  }
  const effectiveLegsPerMatch = legsPerMatch !== undefined ? legsPerMatch : division.legsPerMatch || 5;
  const effectivePairingSize = pairingSize !== undefined ? pairingSize : division.pairingSize || 2;
  if (entryType === 'teams' && (!Number.isInteger(Number(effectiveLegsPerMatch)) || Number(effectiveLegsPerMatch) < 1)) {
    throw new ApiError(400, 'legsPerMatch must be a positive whole number');
  }
  if (entryType === 'doubles' && ![2, 3].includes(Number(effectivePairingSize))) {
    throw new ApiError(400, 'pairingSize must be 2 (doubles) or 3 (triples)');
  }

  if (entryType !== division.entryType) {
    const hasRoster = division.playerIds.length > 0 || division.teamIds.length > 0 || division.pairingIds.length > 0;
    if (hasRoster) {
      throw new ApiError(400, "Can't change entry type: this division already has players, teams or pairings registered - remove them first.");
    }
  }

  division.entryType = entryType;
  division.scheduling = scheduling;
  division.raceTo = Number(raceTo);
  division.legsPerMatch = entryType === 'teams' ? Number(effectiveLegsPerMatch) : null;
  division.pairingSize = entryType === 'doubles' ? Number(effectivePairingSize) : null;

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.edit',
    targetType: 'division',
    targetId: division.id,
    details: `Changed game type for "${division.name}" - entryType: ${entryType}, scheduling: ${scheduling}, raceTo: ${raceTo}`,
  });

  writeDb(db);
  const hydrated = hydrateDivision(db, division);
  res.json(hydrated);
}));

// Toggles "Is Open" on an already-existing division - previously this could
// only be set once, at creation time (see the New Division form in
// client/src/pages/LeagueDetail.jsx). Lets an admin open a division for
// join requests after the fact, or close one back off without deleting and
// recreating it. Deliberately its own route rather than folded into the
// PATCH above: PATCH is locked out entirely once fixturesGenerated (it's
// about the game type, which can't change once a roster/bracket exists),
// but closing join requests should still be possible at any point, and
// opening is only blocked because a locked roster makes it pointless -
// see POST /api/join-requests/:id/approve's own fixturesGenerated check.
app.post('/api/divisions/:id/set-open', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const { isOpen } = req.body || {};
  if (typeof isOpen !== 'boolean') throw new ApiError(400, 'isOpen must be true or false');
  if (isOpen && division.fixturesGenerated) {
    throw new ApiError(400, "Can't open this division for join requests once fixtures have been generated.");
  }

  division.isOpen = isOpen;

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.edit',
    targetType: 'division',
    targetId: division.id,
    details: `${isOpen ? 'Opened' : 'Closed'} "${division.name}" for join requests`,
  });

  writeDb(db);
  const hydrated = hydrateDivision(db, division);
  res.json(hydrated);
}));

// League-level version of the above: toggles "Open For Registration" on an
// already-existing league. Unlike a division, a league has no roster or
// fixturesGenerated flag of its own, so there's nothing to lock this
// behind - it can be flipped at any time. See the "---------- Open
// leagues ----------" block further down for what "open" actually exposes.
app.post('/api/leagues/:id/set-open', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);

  const { isOpenForRegistration } = req.body || {};
  if (typeof isOpenForRegistration !== 'boolean') throw new ApiError(400, 'isOpenForRegistration must be true or false');

  league.isOpenForRegistration = isOpenForRegistration;

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.edit',
    targetType: 'league',
    targetId: league.id,
    details: `${isOpenForRegistration ? 'Opened' : 'Closed'} "${league.name}" for interest registration`,
  });

  writeDb(db);
  res.json(league);
}));

// League Manager (scoped to their assigned league) or Overall Admin -
// mirrors DELETE /api/leagues/:id one level down. Permanently deletes just
// this division and everything scoped to it (fixtures, teams/pairings,
// roll-of-honour entries, and its slot in any tour's divisionIds), leaving
// the rest of the league untouched.
app.delete('/api/divisions/:id', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const fixturesRemoved = db.fixtures.filter((f) => f.divisionId === division.id).length;
  db.fixtures = db.fixtures.filter((f) => f.divisionId !== division.id);
  db.teams = db.teams.filter((t) => t.divisionId !== division.id);
  db.pairings = db.pairings.filter((p) => p.divisionId !== division.id);
  db.rollOfHonour = db.rollOfHonour.filter((r) => r.divisionId !== division.id);
  db.tours.forEach((tour) => {
    tour.divisionIds = tour.divisionIds.filter((id) => id !== division.id);
  });
  db.divisions = db.divisions.filter((d) => d.id !== division.id);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.delete',
    targetType: 'division',
    targetId: division.id,
    details: `Deleted division "${division.name}" from league "${league ? league.name : 'Unknown'}" - ${fixturesRemoved} fixture(s)`,
  });

  writeDb(db);
  res.json({ deleted: true, divisionId: division.id, fixturesRemoved });
}));

// ---------- Close a division early ----------
// Lets an admin force-finish a division without waiting on the normal
// submit -> confirm handshake: every fixture that isn't already completed
// is force-completed at 0-0 (0 legs each for a team fixture), with no
// winner, exactly as if it had been abandoned - no player action or
// confirmation is needed or possible. A 0-0/no-winner result is a genuinely
// new outcome for a singles/doubles fixture (normal race-to-N play can never
// end level - see the override route above), so it's treated as a void: it
// counts as "played" for both sides in standings/career stats, but isn't a
// win or a loss for either one and awards no points - see the matching
// changes in services/standings.js and services/playerProfile.js. A team
// fixture closed this way is simply a 0-0 draw, which the standings/legs
// model already supported before this feature existed. Available at both
// the division level (this route) and the league level (POST
// /api/leagues/:id/close-early below, which applies this to every division
// in the league in one call).
function closeOutstandingFixtures(db, division, actorLabel) {
  const outstanding = db.fixtures.filter((f) => f.divisionId === division.id && f.status !== 'completed');
  const closedAt = new Date().toISOString();

  for (const fixture of outstanding) {
    if (division.entryType === 'teams') {
      fixture.homeLegsWon = 0;
      fixture.awayLegsWon = 0;
      fixture.winnerTeamId = null; // drawn - computeTeamStandings already awards 1 point each for this
      fixture.legs = fixture.legs.map((leg) => (leg.status === 'completed' ? leg : {
        ...leg,
        homePlayerId: leg.homePlayerId,
        awayPlayerId: leg.awayPlayerId,
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
      fixture.winnerPlayerId = null; // void - see services/standings.js
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

app.post('/api/divisions/:id/close-early', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const closedCount = closeOutstandingFixtures(db, division, req.adminSession.label);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.closeEarly',
    targetType: 'division',
    targetId: division.id,
    details: closedCount > 0
      ? `Closed the division early - force-completed ${closedCount} outstanding fixture(s) 0-0`
      : 'Marked the division as complete (no outstanding fixtures)',
  });

  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// League-level equivalent of the route above: applies the exact same
// force-complete-at-0-0 treatment to every division in the league in one
// call, for "close the whole league's season early" rather than one
// division at a time. Surfaced from the league management page.
app.post('/api/leagues/:id/close-early', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);

  const divisions = db.divisions.filter((d) => d.leagueId === league.id);
  let totalClosed = 0;
  let divisionsAffected = 0;
  for (const division of divisions) {
    const closedCount = closeOutstandingFixtures(db, division, req.adminSession.label);
    if (closedCount > 0) {
      divisionsAffected += 1;
      totalClosed += closedCount;
    }
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.closeEarly',
    targetType: 'league',
    targetId: league.id,
    details: totalClosed > 0
      ? `Closed the league early - force-completed ${totalClosed} outstanding fixture(s) 0-0 across ${divisionsAffected} division(s)`
      : 'Marked every division in the league as complete (no outstanding fixtures)',
  });

  writeDb(db);
  res.json({
    leagueId: league.id,
    divisionsAffected,
    fixturesClosed: totalClosed,
    divisions: divisions.map((d) => hydrateDivision(db, d)),
  });
}));

// Permanently deletes a league and everything that belongs to it - every
// division, fixture, team and pairing scoped to it, plus its roll-of-honour
// entries, and it's stripped out of any tour's divisionIds. This is the
// destructive counterpart to close-early above (which just force-completes
// outstanding fixtures but leaves the league and its history in place) -
// use this to actually remove a league that was created by mistake or is no
// longer wanted, not just to end its season. There's no undo.
app.delete('/api/leagues/:id', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);

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
    actor: req.adminSession.label,
    action: 'league.delete',
    targetType: 'league',
    targetId: league.id,
    details: `Deleted league "${league.name}" - ${divisions.length} division(s), ${fixturesRemoved} fixture(s)`,
  });

  writeDb(db);
  res.json({ deleted: true, leagueId: league.id, divisionsRemoved: divisions.length, fixturesRemoved });
}));

// ---- Singles players ----
// Players are only ever registered `Users` now (see registeredPlayers()
// below) - a captain picks a name from the list of people who've actually
// signed up rather than typing an arbitrary free-text name. This keeps the
// roster tied to real accounts instead of one-off placeholder names.

// Every registered, active user has (via registration) a linked Player
// record - this is the pool of names a captain/admin can pick from when
// building a division roster or a team. Demo/seed players created directly
// in db.players without a linked user (e.g. the seeded Premier League demo
// data) are NOT included here, since they don't correspond to a real account.
// ---------- League payment wall helpers ----------
// `required: false` keeps the shape stable but inert, so every league (even
// ones that never touch this feature) always has a payment object rather
// than sometimes having one - callers never need an extra null check.
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

// Throws unless `playerId` has a confirmed or waived payment record for the
// league that owns `division` - a no-op when that league doesn't require
// payment. Called from every place a player becomes an entrant: adding to a
// singles division, a team, a pairing, and substituting a replacement in
// (the season wizard's bulk CSV import is deliberately NOT gated here - see
// the note at POST /api/admin/seasons/:leagueId/import-players for why).
function assertPaymentCleared(db, division, playerId) {
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

function registeredPlayers(db) {
  const linkedPlayerIds = new Set(
    db.users.filter((u) => u.status === 'active' && u.playerId).map((u) => u.playerId)
  );
  return db.players
    .filter((p) => linkedPlayerIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/registered-players', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  res.json(registeredPlayers(db));
}));

// Lets the "Pre Configured Double Elimination Knockout" player-count
// selector in the client show what a given entrant count's bracket looks
// like (round counts, byes, estimated games) before a division/roster even
// exists - see pcdekTemplateSummary's own doc comment for what "template"
// does and doesn't mean here. No division context needed, so this is a
// plain reference-data lookup, not scoped to any league/division.
app.get('/api/game-formats/pcdek/:playerCount', requireAuth, asyncRoute((req, res) => {
  const playerCount = Number(req.params.playerCount);
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 50) {
    throw new ApiError(400, 'playerCount must be a whole number from 1 to 50');
  }
  res.json(pcdekTemplateSummary(playerCount));
}));

// Powers the admin "Game Adjustments" page (search a player, then pick the
// fixture to adjust) - same shape/logic as GET /api/users/me/fixtures, just
// parameterized to any playerId rather than the logged-in account's own, and
// admin-only. Includes every status (not just upcoming) since an admin might
// specifically be looking for a `disputed` or `pending_confirmation` match to
// resolve.
app.get('/api/admin/players/:playerId/fixtures', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const playerId = req.params.playerId;
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
  res.json(enriched);
}));

// Powers the Game Adjustments page's "Needs Attention" list - every
// pending_confirmation/disputed result across the whole app, so an admin can
// jump straight to resolving one without first knowing (and searching for)
// which player it involves. Scans both fixture-level status (singles/
// doubles) and leg-level status (team fixtures, since an individual leg can
// be disputed while the overall team match is still in_progress).
app.get('/api/admin/fixtures/needs-attention', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
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
  res.json(results);
}));

// Powers the Admin Portal's "Issue / Bug Tracker" section - a read-only
// mirror of the project's GitHub Issues (github.com/MBaileyWebsiteDesign/
// Cue-Sense-League-Management/issues), admin-only. The repo is public, so
// this deliberately doesn't need a GitHub token - it hits the same
// unauthenticated REST endpoint anyone could call, just server-side to
// avoid a browser CORS request and keep the repo name in one place. A
// short in-memory cache keeps repeat page loads from tripping GitHub's
// ~60-requests/hour unauthenticated rate limit; it's process-local and
// simply resets on every deploy/restart. Deliberately NOT wrapped in
// asyncRoute - that helper only catches synchronous throws (see its
// definition above), not a rejected promise from an async handler, so
// this handler manages its own fetch/catch and error response instead.
const GITHUB_ISSUES_REPO = 'MBaileyWebsiteDesign/Cue-Sense-League-Management';
const GITHUB_ISSUES_CACHE_MS = 60 * 1000;
let githubIssuesCache = { at: 0, data: null };

// Was admin-only (/api/admin/github-issues); the Issues / Bugs / Features
// page it backs (see client/src/pages/IssuesBugsFeatures.jsx) is now
// visible to every logged-in account, not just admins - see the Feature /
// Requests routes just below it for the other half of that page.
app.get('/api/github-issues', requireAuth, (req, res) => {
  const now = Date.now();
  if (githubIssuesCache.data && now - githubIssuesCache.at < GITHUB_ISSUES_CACHE_MS) {
    res.json(githubIssuesCache.data);
    return;
  }

  const githubHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'cue-sense-pool-management' };
  // Optional: set a GITHUB_ISSUES_TOKEN Fly secret to raise the rate limit
  // from GitHub's unauthenticated 60/hour (shared across everything on the
  // host's egress IP - trivial to exhaust) to 5000/hour. Any token works,
  // even one with no special scopes, since this only ever reads a public
  // repo's issues. Falls back to unauthenticated if the secret isn't set.
  if (process.env.GITHUB_ISSUES_TOKEN) {
    githubHeaders.Authorization = `Bearer ${process.env.GITHUB_ISSUES_TOKEN}`;
  }

  fetch(
    `https://api.github.com/repos/${GITHUB_ISSUES_REPO}/issues?state=all&per_page=100&sort=updated&direction=desc`,
    { headers: githubHeaders }
  )
    .then(async (ghRes) => {
      if (!ghRes.ok) {
        res.status(502).json({ error: `GitHub returned ${ghRes.status} fetching issues - try again shortly.` });
        return;
      }
      const raw = await ghRes.json();
      // The Issues API returns pull requests too - a PR is an issue with a
      // `pull_request` key present; filter those out so this only shows
      // real issues.
      const issues = raw
        .filter((item) => !item.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title,
          state: item.state,
          htmlUrl: item.html_url,
          labels: (item.labels || []).map((l) =>
            typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name, color: l.color }
          ),
          commentCount: item.comments,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          author: item.user?.login || null,
        }));
      githubIssuesCache = { at: now, data: issues };
      res.json(issues);
    })
    .catch((err) => {
      res.status(502).json({ error: `Couldn't reach GitHub: ${err.message}` });
    });
});

// Feature / Requests: the other half of the Issues / Bugs / Features page -
// a lightweight in-app alternative to filing a GitHub issue, open to any
// logged-in account (player, League Manager or Overall Admin) rather than
// just admins. Deliberately not wired into GitHub Issues itself (no token
// scope for creating issues is assumed to exist) - these are stored
// app-side and shown in their own "Feature / Requests" list below the
// GitHub-backed Issue / Bug Tracker.
app.get('/api/feature-requests', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const requests = [...db.featureRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(requests);
}));

app.post('/api/feature-requests', requireAuth, asyncRoute((req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) throw new ApiError(400, 'A short title is required');
  if (title.length > 200) throw new ApiError(400, 'Title must be 200 characters or fewer');
  if (description.length > 4000) throw new ApiError(400, 'Description must be 4000 characters or fewer');

  const db = readDb();
  const request = {
    id: uuid(),
    title,
    description,
    createdAt: new Date().toISOString(),
    createdByUserId: req.auth.user.id,
    createdByName: `${req.auth.user.firstName} ${req.auth.user.lastName}`.trim(),
  };
  db.featureRequests.push(request);
  writeDb(db);
  res.status(201).json(request);
}));

// Moderation (e.g. removing a duplicate or spam submission) stays
// admin-only, unlike reading/submitting requests.
app.delete('/api/feature-requests/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const before = db.featureRequests.length;
  db.featureRequests = db.featureRequests.filter((r) => r.id !== req.params.id);
  if (db.featureRequests.length === before) throw new ApiError(404, 'Feature request not found');
  writeDb(db);
  res.status(204).end();
}));

app.post('/api/divisions/:id/players', asyncRoute((req, res) => {
  const { playerId } = req.body;
  if (!playerId) throw new ApiError(400, 'playerId is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'singles') {
    throw new ApiError(400, `This is a ${division.entryType} division - add players to a ${division.entryType === 'teams' ? 'team' : 'pairing'} instead`);
  }
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
  }

  const player = registeredPlayers(db).find((p) => p.id === playerId);
  if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
  assertPaymentCleared(db, division, player.id);
  if (!division.playerIds.includes(player.id)) {
    division.playerIds.push(player.id);
  }
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/divisions/:id/players/:playerId', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove players after fixtures have been generated for this division');
  }
  division.playerIds = division.playerIds.filter((id) => id !== req.params.playerId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// ---------- Open divisions: browse + join requests (NQT) ----------
// "Is Open" divisions (see POST /api/leagues/:leagueId/divisions above) are
// discoverable by any logged-in player and can be requested rather than
// added directly by an admin/League Manager. A request just queues up -
// approving it is the same effect as an admin adding the player directly
// (division.playerIds.push), rejecting it just closes the request out with
// no side effects. Singles-only for now, same scope as Quick Add (walk-in)
// and the late-entrant flow.

// Every open, still-active singles division across every league, for a
// player to browse and request. Doesn't need requireAnyAdmin - any
// logged-in account can see what's open, the gate is on requesting/
// approving, not browsing.
app.get('/api/open-divisions', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const myPlayerId = req.auth.user.playerId;
  const result = db.divisions
    .filter((d) => d.isOpen && d.status !== 'completed' && d.entryType === 'singles')
    .map((d) => {
      const league = db.leagues.find((l) => l.id === d.leagueId);
      const alreadyIn = myPlayerId ? d.playerIds.includes(myPlayerId) : false;
      const pendingRequest = myPlayerId
        ? db.joinRequests.find((r) => r.divisionId === d.id && r.playerId === myPlayerId && r.status === 'pending')
        : null;
      return {
        divisionId: d.id,
        divisionName: d.name,
        leagueId: d.leagueId,
        leagueName: league?.name || 'Unknown league',
        playerCount: d.playerIds.length,
        fixturesGenerated: d.fixturesGenerated,
        alreadyIn,
        requestStatus: alreadyIn ? 'member' : pendingRequest ? 'pending' : null,
      };
    });
  res.json(result);
}));

// A logged-in player requests to join one open division. One pending
// request per (player, division) at a time - re-requesting after a
// rejection is allowed (a League Manager may reconsider), but not while
// one is already pending.
app.post('/api/divisions/:id/join-requests', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (!division.isOpen) throw new ApiError(400, 'This division is not open for join requests');
  if (division.entryType !== 'singles') throw new ApiError(400, 'Only singles divisions accept join requests right now');
  const playerId = req.auth.user.playerId;
  if (!playerId) throw new ApiError(400, 'Your account has no linked player profile yet - contact an admin');
  if (division.playerIds.includes(playerId)) throw new ApiError(400, "You're already in this division");
  const existing = db.joinRequests.find((r) => r.divisionId === division.id && r.playerId === playerId && r.status === 'pending');
  if (existing) throw new ApiError(400, 'You already have a pending request for this division');

  const request = {
    id: uuid(),
    divisionId: division.id,
    playerId,
    userId: req.auth.user.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
  };
  db.joinRequests.push(request);
  writeDb(db);
  res.status(201).json(request);
}));

// Pending join requests across every division in one league, for that
// league's "Admin: Manage this League" -> Join Requests subsection -
// League Manager (scoped to their assigned league) or Overall Admin, same
// access pattern as everything else on that panel.
app.get('/api/leagues/:id/join-requests', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const divisionIds = new Set(db.divisions.filter((d) => d.leagueId === league.id).map((d) => d.id));
  const result = db.joinRequests
    .filter((r) => r.status === 'pending' && divisionIds.has(r.divisionId))
    .map((r) => {
      const division = db.divisions.find((d) => d.id === r.divisionId);
      const player = db.players.find((p) => p.id === r.playerId);
      return {
        id: r.id,
        divisionId: r.divisionId,
        divisionName: division?.name || 'Unknown division',
        playerId: r.playerId,
        playerName: player?.name || 'Unknown player',
        createdAt: r.createdAt,
      };
    });
  res.json(result);
}));

app.post('/api/join-requests/:id/approve', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const request = db.joinRequests.find((r) => r.id === req.params.id);
  if (!request) throw new ApiError(404, 'Join request not found');
  if (request.status !== 'pending') throw new ApiError(400, 'This request has already been decided');
  const division = db.divisions.find((d) => d.id === request.divisionId);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
  }
  assertPaymentCleared(db, division, request.playerId);
  if (!division.playerIds.includes(request.playerId)) {
    division.playerIds.push(request.playerId);
  }
  request.status = 'approved';
  request.decidedAt = new Date().toISOString();
  request.decidedBy = req.adminSession.label;
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'join_request.approve',
    targetType: 'division',
    targetId: division.id,
    details: `Approved join request from player ${request.playerId} for division "${division.name}"`,
  });
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

app.post('/api/join-requests/:id/reject', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const request = db.joinRequests.find((r) => r.id === req.params.id);
  if (!request) throw new ApiError(404, 'Join request not found');
  if (request.status !== 'pending') throw new ApiError(400, 'This request has already been decided');
  const division = db.divisions.find((d) => d.id === request.divisionId);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
  request.status = 'rejected';
  request.decidedAt = new Date().toISOString();
  request.decidedBy = req.adminSession.label;
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'join_request.reject',
    targetType: 'division',
    targetId: division.id,
    details: `Rejected join request from player ${request.playerId} for division "${division.name}"`,
  });
  writeDb(db);
  res.json({ rejected: true, requestId: request.id });
}));

// ---------- Open leagues: browse + interest registration ----------
// League-level equivalent of the "Open divisions" block above. A division
// with "Is Open" set is joinable directly (approving a request adds the
// player straight to that division's roster) - but a league itself has no
// roster of its own, so opening a *league* just lets a player register
// interest in it generally. A League Manager then works through the list
// of interested players whenever they're ready and splits them across
// whichever division(s) they choose, in bulk or one at a time, via POST
// /api/league-interests/bulk-assign below - e.g. 10 players register
// interest in "League 1", the League Manager later puts 5 in Division 1
// and 5 in Division 5 in two clicks each.

// Every league open for interest registration, for a player to browse and
// register against - deliberately public (no login required) as well as
// usable while logged in, so the same list can back both the "Open
// Leagues" browse page and the league-choice dropdown on the account
// registration form itself, before that account exists.
app.get('/api/open-leagues', optionalAuth, asyncRoute((req, res) => {
  const db = readDb();
  const myPlayerId = req.auth?.user?.playerId || null;
  const result = db.leagues
    .filter((l) => l.isOpenForRegistration)
    .map((l) => {
      const divisionCount = db.divisions.filter((d) => d.leagueId === l.id).length;
      const alreadyRegistered = myPlayerId
        ? db.leagueInterests.some((r) => r.leagueId === l.id && r.playerId === myPlayerId && r.status !== 'declined')
        : false;
      const pendingInterest = myPlayerId
        ? db.leagueInterests.find((r) => r.leagueId === l.id && r.playerId === myPlayerId && r.status === 'pending')
        : null;
      return {
        leagueId: l.id,
        leagueName: l.name,
        sport: l.sport,
        divisionCount,
        alreadyRegistered,
        requestStatus: alreadyRegistered ? (pendingInterest ? 'pending' : 'assigned') : null,
      };
    });
  res.json(result);
}));

// A logged-in player registers interest in one open league (not a specific
// division - see the block comment above). One pending interest per
// (player, league) at a time; re-registering after a decline is allowed,
// same rule as division join requests.
app.post('/api/leagues/:id/interests', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  if (!league.isOpenForRegistration) throw new ApiError(400, 'This league is not open for interest registration');
  const playerId = req.auth.user.playerId;
  if (!playerId) throw new ApiError(400, 'Your account has no linked player profile yet - contact an admin');
  const existing = db.leagueInterests.find((r) => r.leagueId === league.id && r.playerId === playerId && r.status === 'pending');
  if (existing) throw new ApiError(400, 'You already have a pending interest registration for this league');

  const request = {
    id: uuid(),
    leagueId: league.id,
    playerId,
    userId: req.auth.user.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
  };
  db.leagueInterests.push(request);
  writeDb(db);
  res.status(201).json(request);
}));

// Pending league-interest registrations for one league, for that league's
// "Admin: Manage this League" -> League Interests subsection - same access
// pattern as GET /api/leagues/:id/join-requests.
app.get('/api/leagues/:id/league-interests', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const result = db.leagueInterests
    .filter((r) => r.status === 'pending' && r.leagueId === league.id)
    .map((r) => {
      const player = db.players.find((p) => p.id === r.playerId);
      return {
        id: r.id,
        leagueId: r.leagueId,
        playerId: r.playerId,
        playerName: player?.name || 'Unknown player',
        createdAt: r.createdAt,
      };
    });
  res.json(result);
}));

// Closes a league-interest registration out with no side effects - the
// league-level equivalent of POST /api/join-requests/:id/reject. There's no
// single-record "approve" (see bulk-assign below for the actual add-to-
// division action) since accepting interest only makes sense alongside
// picking which division to put the player in.
app.post('/api/league-interests/:id/decline', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const request = db.leagueInterests.find((r) => r.id === req.params.id);
  if (!request) throw new ApiError(404, 'League interest registration not found');
  if (request.status !== 'pending') throw new ApiError(400, 'This registration has already been decided');
  const league = db.leagues.find((l) => l.id === request.leagueId);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  request.status = 'declined';
  request.decidedAt = new Date().toISOString();
  request.decidedBy = req.adminSession.label;
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league_interest.decline',
    targetType: 'league',
    targetId: league.id,
    details: `Declined league interest registration from player ${request.playerId} for "${league.name}"`,
  });
  writeDb(db);
  res.json({ declined: true, requestId: request.id });
}));

// Takes a batch of pending league-interest registrations and adds every
// player in it to one chosen division in the same league, in one call -
// e.g. 10 players register interest in "League 1", the League Manager
// later selects 5 of them and this division, then the other 5 and that
// division. Same rules as adding a player to a division directly (POST
// /api/divisions/:id/players): singles-only, locked out once fixtures have
// been generated, payment wall still applies per player. A player already
// in the division, or whose payment isn't cleared, doesn't silently fail
// the whole batch - each one is resolved independently and the response
// reports what happened to each.
app.post('/api/league-interests/bulk-assign', requireAnyAdmin, asyncRoute((req, res) => {
  const { interestIds, divisionId } = req.body || {};
  if (!Array.isArray(interestIds) || interestIds.length === 0) {
    throw new ApiError(400, 'interestIds must be a non-empty array');
  }
  if (!divisionId) throw new ApiError(400, 'divisionId is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === divisionId);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  if (division.entryType !== 'singles') {
    throw new ApiError(400, `This is a ${division.entryType} division - league interests can only be bulk-assigned into a singles division`);
  }
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
  }

  const results = [];
  for (const interestId of interestIds) {
    const request = db.leagueInterests.find((r) => r.id === interestId);
    if (!request) {
      results.push({ interestId, ok: false, error: 'League interest registration not found' });
      continue;
    }
    if (request.leagueId !== league.id) {
      results.push({ interestId, ok: false, error: 'This interest registration is for a different league' });
      continue;
    }
    if (request.status !== 'pending') {
      results.push({ interestId, ok: false, error: 'This registration has already been decided' });
      continue;
    }
    try {
      assertPaymentCleared(db, division, request.playerId);
    } catch (err) {
      results.push({ interestId, ok: false, error: err.message });
      continue;
    }
    if (!division.playerIds.includes(request.playerId)) {
      division.playerIds.push(request.playerId);
    }
    request.status = 'assigned';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = req.adminSession.label;
    results.push({ interestId, ok: true, playerId: request.playerId });
  }

  const assignedCount = results.filter((r) => r.ok).length;
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league_interest.bulk_assign',
    targetType: 'division',
    targetId: division.id,
    details: `Bulk-assigned ${assignedCount} player(s) from league interest registrations into "${division.name}"`,
  });

  writeDb(db);
  res.json({ division: hydrateDivision(db, division), results });
}));

// ---- Teams (team divisions only) ----

// Seats a late entrant into a still-open reserved bye box (see
// MAX_RESERVED_BYE_COUNT), converting it into a genuine two-sided match -
// from this point on it's indistinguishable from any other round-1
// fixture. Called by quick-add-player below when a reserved slot exists.
function claimReservedFixtureSlot(division, fixture, playerId) {
  if (division.entryType === 'teams') {
    fixture.awayTeamId = playerId;
  } else {
    fixture.awayPlayerId = playerId;
  }
  fixture.reserved = false;
  fixture.byeSlot = null;
}

// Admin-only "quick add" for a walk-in who's never used CueSense before -
// a front-desk-friendly alternative to POST /api/divisions/:id/players,
// which only accepts an existing registered playerId. Takes just a name
// and creates a minimal account behind the scenes (synthetic, unguessable
// email + random password - this person never needs to log in; an admin
// can turn it into a real account later from Admin > Users if they want
// one), then adds them to the division roster.
//
// Same lockout as the ordinary add-player route for everything EXCEPT a
// knockout division with an open reserved bye slot (see
// MAX_RESERVED_BYE_COUNT) - that one case is exactly what reserved slots
// exist for: a genuine day-of late entrant claims the slot instead of
// being turned away. Every other case is unchanged: once fixtures have
// been generated, no more players can be added via any route. Team and
// doubles divisions aren't supported here yet - only singles.
app.post('/api/divisions/:id/quick-add-player', requireAnyAdmin, asyncRoute((req, res) => {
  const { firstName, lastName } = req.body || {};
  if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'singles') {
    throw new ApiError(400, 'Quick-add is only available for singles divisions right now');
  }
  const isKnockout = division.scheduling === 'knockout_single_elim' || DOUBLE_ELIM_TYPES.includes(division.scheduling);
  let reservedFixture = null;
  if (division.fixturesGenerated) {
    if (isKnockout) {
      reservedFixture = db.fixtures.find((f) => f.divisionId === division.id && f.reserved && f.status !== 'completed');
    }
    if (!reservedFixture) {
      throw new ApiError(
        400,
        isKnockout
          ? 'No reserved late-entrant slot is open for this division right now'
          : 'Cannot add players after fixtures have been generated for this division'
      );
    }
  }
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const tempPassword = generateTempPassword();
  const syntheticEmail = `walkin-${uuid()}@no-login.cuesense`;
  const user = createUserAccount(db, {
    firstName: firstName.trim(),
    lastName: lastName ? lastName.trim() : '',
    email: syntheticEmail,
    passwordHash: hashPassword(tempPassword),
    teamName: 'Unassigned',
  });
  const newPlayerId = user.playerId;

  if (!division.playerIds.includes(newPlayerId)) division.playerIds.push(newPlayerId);
  if (reservedFixture) claimReservedFixtureSlot(division, reservedFixture, newPlayerId);

  // Same "don't hard-block, just flag it" approach as the season wizard's
  // CSV import (see POST /api/admin/seasons/:leagueId/import-players) - a
  // walk-in who hasn't paid yet shouldn't be refused a spot in the draw,
  // but the league's Payments tab needs to know they owe the entry fee.
  if (league && league.payment && league.payment.required) {
    const existing = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === newPlayerId);
    if (!existing) {
      db.leaguePayments.push({
        id: uuid(),
        leagueId: league.id,
        playerId: newPlayerId,
        status: 'unpaid',
        amount: league.payment.amount,
        currency: league.payment.currency,
        confirmedBy: null,
        confirmedAt: null,
        notes: '',
      });
    }
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: reservedFixture ? 'division.quick_add_late_entrant' : 'division.quick_add_player',
    targetType: 'division',
    targetId: division.id,
    details: reservedFixture
      ? `Quick-added late entrant ${user.firstName} ${user.lastName} to "${division.name}" - claimed a reserved bracket slot`
      : `Quick-added ${user.firstName} ${user.lastName} to "${division.name}"`,
  });

  writeDb(db);
  res.status(201).json({
    division: hydrateDivision(db, division),
    player: { id: newPlayerId, name: `${user.firstName} ${user.lastName}` },
    outcome: { method: reservedFixture ? 'reserved-slot' : 'added' },
  });
}));

// Admin-only: force-releases any still-open reserved bye slots (see
// MAX_RESERVED_BYE_COUNT) in a knockout division, resolving each one as an
// ordinary bye - the seeded entrant advances automatically, exactly like
// any bye the app has always known how to handle (resolveByeIfNeeded).
// Call this once no more late entrants are expected for the division; it's
// a safe no-op if nothing is currently reserved (e.g. everything was
// already claimed, or the division has no reserved slots at all).
app.post('/api/divisions/:id/close-late-entry', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const reservedFixtures = db.fixtures.filter((f) => f.divisionId === division.id && f.reserved);
  reservedFixtures.forEach((fixture) => {
    fixture.reserved = false;
    resolveByeIfNeeded(db, division, fixture);
  });

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.close_late_entry',
    targetType: 'division',
    targetId: division.id,
    details: `Closed late entry for "${division.name}" - released ${reservedFixtures.length} unclaimed reserved slot(s)`,
  });

  writeDb(db);
  res.json({ division: hydrateDivision(db, division), releasedCount: reservedFixtures.length });
}));

// ---- Teams (team divisions only) ----

app.post('/api/divisions/:id/teams', asyncRoute((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Team name is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'teams') throw new ApiError(400, 'This is a singles division - add players directly instead');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add teams after fixtures have been generated for this division');
  }

  const team = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
  db.teams.push(team);
  division.teamIds.push(team.id);
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/divisions/:id/teams/:teamId', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove teams after fixtures have been generated for this division');
  }
  division.teamIds = division.teamIds.filter((id) => id !== req.params.teamId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

app.post('/api/teams/:teamId/players', asyncRoute((req, res) => {
  const { playerId } = req.body;
  if (!playerId) throw new ApiError(400, 'playerId is required');

  const db = readDb();
  const team = db.teams.find((t) => t.id === req.params.teamId);
  if (!team) throw new ApiError(404, 'Team not found');
  const division = db.divisions.find((d) => d.id === team.divisionId);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
  }

  const player = registeredPlayers(db).find((p) => p.id === playerId);
  if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
  assertPaymentCleared(db, division, player.id);
  if (!team.playerIds.includes(player.id)) {
    team.playerIds.push(player.id);
  }
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/teams/:teamId/players/:playerId', asyncRoute((req, res) => {
  const db = readDb();
  const team = db.teams.find((t) => t.id === req.params.teamId);
  if (!team) throw new ApiError(404, 'Team not found');
  const division = db.divisions.find((d) => d.id === team.divisionId);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
  }
  team.playerIds = team.playerIds.filter((id) => id !== req.params.playerId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// ---- Pairings (doubles/triples divisions only) ----
// A Pairing is 2 (doubles) or 3 (triples) named registered players who
// register together as one side - structurally the same idea as a Team (a
// named group of players), but a pairing's fixtures are scored exactly like
// a singles fixture (one continuous frame race, no legs), since
// alternate-shot doesn't split a match into separate player-vs-player
// mini-matches the way a team leg does.

app.post('/api/divisions/:id/pairings', asyncRoute((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Pairing name is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'doubles') throw new ApiError(400, 'This is not a doubles/triples division');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add pairings after fixtures have been generated for this division');
  }

  const pairing = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
  db.pairings.push(pairing);
  division.pairingIds.push(pairing.id);
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/divisions/:id/pairings/:pairingId', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove pairings after fixtures have been generated for this division');
  }
  division.pairingIds = division.pairingIds.filter((id) => id !== req.params.pairingId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

app.post('/api/pairings/:pairingId/players', asyncRoute((req, res) => {
  const { playerId } = req.body;
  if (!playerId) throw new ApiError(400, 'playerId is required');

  const db = readDb();
  const pairing = db.pairings.find((p) => p.id === req.params.pairingId);
  if (!pairing) throw new ApiError(404, 'Pairing not found');
  const division = db.divisions.find((d) => d.id === pairing.divisionId);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
  }
  if (pairing.playerIds.length >= division.pairingSize) {
    throw new ApiError(400, `This pairing already has the maximum of ${division.pairingSize} player(s)`);
  }

  const player = registeredPlayers(db).find((p) => p.id === playerId);
  if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
  assertPaymentCleared(db, division, player.id);
  if (!pairing.playerIds.includes(player.id)) {
    pairing.playerIds.push(player.id);
  }
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/pairings/:pairingId/players/:playerId', asyncRoute((req, res) => {
  const db = readDb();
  const pairing = db.pairings.find((p) => p.id === req.params.pairingId);
  if (!pairing) throw new ApiError(404, 'Pairing not found');
  const division = db.divisions.find((d) => d.id === pairing.divisionId);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
  }
  pairing.playerIds = pairing.playerIds.filter((id) => id !== req.params.playerId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// Manual seed ordering: buildBracketRounds/buildDoubleElimBracket pair
// entrants in whatever order division.playerIds/teamIds/pairingIds happens
// to be in (see services/bracket.js - "no real seeding... sort entrantIds
// before calling this"), so reordering that array *is* how a knockout
// bracket's seeding is actually controlled. Seed-from-groups (above)
// already produces a sensible order automatically (top finishers per
// feeder group, group by group); this lets an admin fine-tune that order,
// or set entirely manual seeding for a standalone knockout built by adding
// entrants directly - before fixtures are generated. Works for any entry
// type (singles/teams/doubles), since it's just reordering whichever ID
// array the division uses.
app.post('/api/divisions/:id/reorder-entrants', requireAnyAdmin, asyncRoute((req, res) => {
  const { order } = req.body || {};
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
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
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// ---- Fixture generation (branches on entryType x scheduling) ----

function makeSinglesFixture({ league, division, round }) {
  return {
    id: uuid(),
    leagueId: league.id,
    divisionId: division.id,
    round,
    scheduledDate: null,
    // Table scheduling (see POST /api/fixtures/:id/schedule) - tableId
    // refers to an entry in the league's own `tables` list.
    tableId: null,
    scheduledTime: null,
    // Match timer (elapsed running clock, see /timer/start|pause|reset) and
    // shot clock (per-shot countdown, see /shot-clock/start|stop) - both
    // idle until a captain/admin starts them during live play.
    timer: { startedAt: null, elapsedSeconds: 0, running: false },
    shotClock: { durationSeconds: 60, startedAt: null, running: false },
    homePlayerId: null,
    awayPlayerId: null,
    raceTo: division.raceTo,
    frames: [],
    homeFrameScore: 0,
    awayFrameScore: 0,
    status: 'scheduled', // scheduled -> in_progress -> completed
    winnerPlayerId: null,
    nextFixtureId: null,
    nextFixtureSlot: null,
    // Knockout only: set to 'home' or 'away' when this fixture structurally
    // can never receive an entrant on that side (a bye, from a round whose
    // survivor count was odd - see buildBracketRounds/generateKnockoutFixtures).
    // null for every non-knockout fixture and every genuine two-sided
    // knockout fixture.
    byeSlot: null,
    // Knockout only: true for a round-1 bye box deliberately held open for
    // a day-of late entrant (see MAX_RESERVED_BYE_COUNT) instead of being
    // auto-resolved at generation time like an ordinary bye. Cleared to
    // false the moment it's claimed (claim-reserved-slot below) or when an
    // admin closes late entry for the division (close-late-entry below) -
    // resolveByeIfNeeded skips any fixture while this is still true.
    reserved: false,
    // Double-elimination only (bracketRole stays 'single' for round robin and
    // single-elimination fixtures, which don't use any of the fields below).
    bracketRole: 'single', // 'single' | 'winners' | 'losers' | 'grand_final' | 'grand_final_reset'
    loserNextFixtureId: null, // where this fixture's LOSER drops to in the losers bracket (winners-bracket fixtures only)
    loserNextFixtureSlot: null,
    resetFixtureId: null, // set on a completed grand_final fixture once a bracket-reset decider has been created
  };
}

function makeTeamFixture({ league, division, round }) {
  const legs = Array.from({ length: division.legsPerMatch }, (_, i) => ({
    legNumber: i + 1,
    homePlayerId: null,
    awayPlayerId: null,
    raceTo: division.raceTo,
    frames: [],
    homeFrameScore: 0,
    awayFrameScore: 0,
    status: 'pending', // pending (not nominated) -> scheduled -> in_progress -> completed
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
    status: 'scheduled', // scheduled -> in_progress -> completed
    winnerTeamId: null,
    nextFixtureId: null,
    nextFixtureSlot: null,
    // See makeSinglesFixture's byeSlot comment - same meaning here.
    byeSlot: null,
    // See makeSinglesFixture's reserved comment - same meaning here (teams
    // knockout brackets can carry reserved boxes too, they just have no
    // claim route today - an unclaimed one just falls back to an ordinary
    // bye at close-late-entry, same as any other division).
    reserved: false,
    bracketRole: 'single',
    loserNextFixtureId: null,
    loserNextFixtureSlot: null,
    resetFixtureId: null,
  };
}

function generateRoundRobinFixtures({ db, league, division, entrantIds }) {
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

// Marks a bye fixture (one side missing) as an automatic win, and propagates
// the winner into the next round straight away. A no-op for a fixture still
// held open as a reserved late-entrant slot (see MAX_RESERVED_BYE_COUNT) -
// that one only resolves via claim-reserved-slot or close-late-entry below.
function resolveByeIfNeeded(db, division, fixture) {
  if (fixture.reserved) return;
  if (division.entryType === 'teams') {
    if (fixture.homeTeamId && fixture.awayTeamId) return;
    const winnerTeamId = fixture.homeTeamId || fixture.awayTeamId;
    if (!winnerTeamId) return; // shouldn't happen, but don't crash on a fully-empty fixture
    fixture.status = 'completed';
    fixture.winnerTeamId = winnerTeamId;
    propagateWinner(db, division, fixture, winnerTeamId);
  } else {
    if (fixture.homePlayerId && fixture.awayPlayerId) return;
    const winnerPlayerId = fixture.homePlayerId || fixture.awayPlayerId;
    if (!winnerPlayerId) return;
    fixture.status = 'completed';
    fixture.winnerPlayerId = winnerPlayerId;
    propagateWinner(db, division, fixture, winnerPlayerId);
  }
}

// Checks whether two entrants (player IDs, or team IDs for a teams
// division) have already played a completed fixture against each other in
// this division - the source of truth avoidRematchOnPlacement below uses
// to decide whether a would-be pairing is actually a repeat.
function haveAlreadyPlayed(db, division, aId, bId) {
  if (!aId || !bId) return false;
  const isTeams = division.entryType === 'teams';
  return db.fixtures.some((f) => {
    if (f.divisionId !== division.id || f.status !== 'completed') return false;
    const home = isTeams ? f.homeTeamId : f.homePlayerId;
    const away = isTeams ? f.awayTeamId : f.awayPlayerId;
    return (home === aId && away === bId) || (home === bId && away === aId);
  });
}

// Whether `entrantId` has already been awarded ANY bye in this division -
// round 1's natural/reserved one or a later-round structural one (see
// buildBracketRounds/buildDoubleElimBracket). A bye fixture is
// indistinguishable in the data from any other completed fixture except
// that one side was never filled in (resolveByeIfNeeded deliberately
// leaves the empty side null rather than backfilling it), so that's what
// this checks for - used by avoidRepeatByeOnPlacement below to stop the
// same entrant collecting a second bye while someone else in the draw
// hasn't had one yet.
//
// excludeFixtureId must be passed as the very fixture currently being
// resolved (see avoidRepeatByeOnPlacement's call site) - resolveByeIfNeeded
// marks a bye fixture 'completed' *before* calling propagateWinner, so by
// the time this runs, that fixture already satisfies every criterion below
// for the entrant who just received it. Without excluding it, an entrant's
// first-ever bye is mistaken for prior history of their own still-in-
// progress placement and incorrectly treated as a repeat - most easily
// reproduced whenever a round 1 bye's winner advances straight into a
// round 2 box that's itself a structural bye (e.g. a fresh 9-entrant
// double-elim division, no late entrants involved at all).
function hasHadBye(db, division, entrantId, excludeFixtureId) {
  if (!entrantId) return false;
  const isTeams = division.entryType === 'teams';
  return db.fixtures.some((f) => {
    if (f.id === excludeFixtureId) return false;
    if (f.divisionId !== division.id || f.status !== 'completed') return false;
    const home = isTeams ? f.homeTeamId : f.homePlayerId;
    const away = isTeams ? f.awayTeamId : f.awayPlayerId;
    if (home !== entrantId && away !== entrantId) return false;
    return !home || !away;
  });
}

// Double-elimination rematch avoidance, shared by propagateWinner (losers-
// bracket-internal advancement) and propagateLoser (a winners-bracket
// loser dropping into the losers bracket).
//
// Most losers-bracket placements can never repeat an earlier pairing by
// construction: two winners-bracket losers arriving in the same "entry"
// round always come from two different winners-round-1 matches (so never
// played each other), and two fresh losers paired off against each other
// in the "leftover" portion of a merge round both come from winners
// matches still in progress this round (so, per single-elimination-tree
// properties, can't have met yet either) - see buildDoubleElimBracket's
// comments. The one spot this isn't true: a merge round's box also seats
// an *already-waiting* losers-bracket survivor, whose route through the
// bracket is entirely independent of whoever the incoming entrant is -
// there's nothing structural stopping those two from having played each
// other already. Likewise, once that survivor's own box was decided by an
// earlier swap (see below), later losers-bracket-internal consolidation
// rounds inherit the same risk.
//
// So: before seating `entrantId` into `fixture[idField]`/`fixture[slotField]`,
// check whether whoever already occupies that destination's other slot is
// someone `entrantId` has already played. If so, look for a sibling
// fixture - same round, same bracketRole, not yet completed, wired via the
// same id/slot field pair (to EITHER slot - see occupantAt, which works
// out each sibling's own "other slot" instead of assuming it matches this
// fixture's, so a 'home'-wired sibling and an 'away'-wired one are equally
// valid swap partners) - and swap the two fixtures' routing so each one's
// *eventual* winner/loser lands somewhere rematch-free instead. This only
// ever repoints not-yet-decided assignments, so it's always safe to do
// (and redo, on a result correction) right up until each one's result
// actually lands. If no rematch-free sibling exists, the placement goes
// ahead as originally wired - not every case can be avoided (see the docs
// on this feature).
//
// Widened from an earlier version that only considered siblings wired to
// the *same* target slot as this fixture. That halved the usable sibling
// pool for no real reason (the swap itself is slot-safe either way - it
// always exchanges a fixture's id/slot pair together) and was responsible
// for real missed rematches in production: with only same-slot siblings
// eligible, it's common for all of them to already be decided and routed
// by the time a problem pairing is detected, leaving nothing left to swap
// with.
// FIX (2026-08-14, see claude/double-elim-rematch-fix-2026-08-14.md): the
// swap above - reroute an unclaimed same-round sibling's wiring instead of
// this fixture's own - was the only mitigation this function had. It only
// works when another fixture in the SAME round + bracketRole hasn't
// completed yet and still has a live outbound route to trade. Simulating
// thousands of tournaments showed that in every recorded failure that pool
// was already empty - overwhelmingly in the losers bracket, whose later
// rounds routinely shrink to just one or two fixtures, so by the time the
// second half of a pairing completes there is nothing left in that round to
// swap wiring with. No amount of searching harder within "this round's
// unclaimed routes" fixes that - there's genuinely nothing there.
//
// So: when that first attempt finds no eligible sibling, fall back to a
// second, independent mitigation that doesn't depend on unclaimed routing
// at all. Look at the OTHER boxes in the destination's own round (same
// bracketRole) that haven't started play yet (no frames recorded, not
// completed, not a bye box). If one of them already holds an occupant who
// (a) hasn't played `entrantId` and (b) wouldn't hand dest's existing
// occupant a rematch either, swap the two ALREADY-PLACED occupants
// directly - `entrantId` goes there, that box's occupant comes here. This
// never touches any fixture's routing (idField/slotField), only the two
// fixtures' own player-slot fields, so it cannot create or duplicate a
// routing target (the historical PR #40 failure mode this whole area has to
// stay careful around). The caller is told via the return value that
// placement was handled directly, so it must skip its own normal
// assignment into `dest`.
//
// Like the routing-swap above, this remains a best-effort mitigation, not a
// guarantee: many losers-bracket rounds shrink to a single box with no
// sibling box to trade with either, and no swap of any kind can help there.
function avoidRematchOnPlacement(db, division, fixture, idField, slotField, entrantId) {
  const targetId = fixture[idField];
  const targetSlot = fixture[slotField];
  if (!targetId || !entrantId) return false;
  const dest = db.fixtures.find((f) => f.id === targetId);
  if (!dest) return false;
  const isTeams = division.entryType === 'teams';
  const otherSlotOf = (slot) => (slot === 'home' ? 'away' : 'home');
  const playerField = (slot) => (isTeams
    ? (slot === 'home' ? 'homeTeamId' : 'awayTeamId')
    : (slot === 'home' ? 'homePlayerId' : 'awayPlayerId'));
  const readSlot = (fx, slot) => fx[playerField(slot)];
  const occupant = readSlot(dest, otherSlotOf(targetSlot));
  if (!occupant || !haveAlreadyPlayed(db, division, entrantId, occupant)) return false;

  const siblings = db.fixtures.filter((f) =>
    f.id !== fixture.id &&
    f.divisionId === fixture.divisionId &&
    f.bracketRole === fixture.bracketRole &&
    f.round === fixture.round &&
    f.status !== 'completed' &&
    f[idField]
  );
  // Each sibling's own "other slot" is relative to ITS OWN slotField, not
  // this fixture's targetSlot - a sibling wired to 'away' fills the 'away'
  // side of its destination, so the slot worth checking there is 'home'.
  const occupantAt = (fx) => {
    const d = db.fixtures.find((x) => x.id === fx[idField]);
    return d ? readSlot(d, otherSlotOf(fx[slotField])) : null;
  };
  const pick =
    siblings.find((f) => !occupantAt(f)) ||
    siblings.find((f) => {
      const o = occupantAt(f);
      return o && !haveAlreadyPlayed(db, division, entrantId, o);
    });
  if (pick) {
    const ours = { id: fixture[idField], slot: fixture[slotField] };
    fixture[idField] = pick[idField];
    fixture[slotField] = pick[slotField];
    pick[idField] = ours.id;
    pick[slotField] = ours.slot;
    return false;
  }

  // CHAIN SEARCH (2026-08-14, fourth pass - replaces the single-hop
  // alt-box swap above; see
  // claude/double-elim-rematch-chain-search-2026-08-14.md for the
  // dedicated rematch-only test run that motivated this and the before/
  // after numbers). The single-hop swap could only resolve a conflict by
  // trading entrantId directly with ONE other occupant. That fails
  // whenever the only occupants immediately available are each themselves
  // incompatible with either side - a case a longer chain of swaps can
  // often still resolve (move A into dest, which frees up A's old seat for
  // B, which frees up B's old seat for entrantId, and so on). This is a
  // backtracking search for an augmenting path of any length over every
  // not-yet-started, non-bye box in the same bracketRole (any round, same
  // scope PR #44 already widened to) that currently holds at least one
  // occupant - a box still waiting on its own second feeder is just as
  // valid a source to pull a replacement from as a fully-decided pair,
  // since its still-empty side simply carries no compatibility constraint
  // yet. Verified correct in isolation against a constructed 3-hop
  // scenario before shipping. Like every fallback in this area, it only
  // ever rewrites already-placed occupants' own player-slot fields - never
  // any routing field - so it carries the same PR #40 safety guarantee.
  const pool = db.fixtures.filter((f) =>
    f.id !== dest.id &&
    f.divisionId === dest.divisionId &&
    f.bracketRole === dest.bracketRole &&
    f.status !== 'completed' &&
    !f.byeSlot &&
    (!f.frames || f.frames.length === 0) &&
    (readSlot(f, 'home') || readSlot(f, 'away'))
  );

  // Try to seat `personId` into (fx, slot), whose other slot may already
  // hold a fixed occupant (or be empty - no constraint). If personId fits,
  // done. Otherwise, look for some other pool box holding a compatible
  // replacement, and recursively find a home for personId where THAT
  // replacement came from - forming a chain of any length. `visited` stops
  // any box being used twice in the same search.
  function placeInChain(fx, slot, personId, visited) {
    const otherSlot = otherSlotOf(slot);
    const fixedOccupant = readSlot(fx, otherSlot);
    if (!fixedOccupant || !haveAlreadyPlayed(db, division, personId, fixedOccupant)) {
      return [{ fixtureId: fx.id, slot, value: personId }];
    }
    for (const cand of pool) {
      if (visited.has(cand.id) || cand.id === fx.id) continue;
      for (const candSlot of ['home', 'away']) {
        const candValue = readSlot(cand, candSlot);
        if (!candValue || candValue === personId) continue;
        if (haveAlreadyPlayed(db, division, candValue, fixedOccupant)) continue;
        visited.add(cand.id);
        const rest = placeInChain(cand, candSlot, personId, visited);
        if (rest !== null) {
          return [{ fixtureId: fx.id, slot, value: candValue }, ...rest];
        }
        visited.delete(cand.id);
      }
    }
    return null;
  }

  const chainMoves = placeInChain(dest, targetSlot, entrantId, new Set([dest.id]));
  if (chainMoves) {
    for (const m of chainMoves) {
      const fx = m.fixtureId === dest.id ? dest : db.fixtures.find((f) => f.id === m.fixtureId);
      fx[playerField(m.slot)] = m.value;
    }
    return true; // handled directly - caller must skip its normal assignment
  }

  return false;
}

// Bye-fairness - the structural-bye counterpart to avoidRematchOnPlacement
// above, same swap mechanism, different question. Bye placement (see
// buildBracketRounds/buildDoubleElimBracket) is decided purely by whether a
// round's box count is odd, with no memory of who's already had one; and
// because a round's last box always feeds the next round's last box (see
// generateKnockoutFixtures/generateDoubleElimFixtures's linking loops), an
// entrant who lands in that corner - most commonly whoever got round 1's
// bye in the first place - can structurally end up there again in a later
// round, and again after that, while someone else in the draw has had
// none at all.
//
// Before seating `entrantId` into a destination that turns out to be a bye
// box, check whether they've already had one; if so, look for a
// not-yet-decided sibling (same round, same bracketRole) whose own
// destination is a genuine two-sided fixture, and swap into that instead,
// so the bye goes to someone who hasn't had one yet. If no such sibling
// exists, the placement goes ahead as originally wired - like
// avoidRematchOnPlacement, this is a best-effort mitigation, not a
// guarantee (it doesn't, for instance, check whether the sibling's
// eventual winner has had a bye too - that's not knowable yet). Runs after
// rematch-avoidance in propagateWinner/propagateLoser below, so a
// rematch-free placement is never given up purely to also chase
// bye-fairness.
//
// `fixture` itself counts as a prior bye when it is one (fix, 2026-08-14 -
// see claude/double-elim-bye-fix-2026-08-14.md project doc for the
// simulation that found this): hasHadBye's own exclusion of `fixture.id`
// correctly stops an entrant's first-ever bye from being mistaken for
// prior history of itself while THAT bye is what's currently resolving
// (the PR #40 false-positive) - but that exclusion also went too far: if
// `fixture` just resolved as a genuine bye for `entrantId` AND its
// destination is ALSO a bye box (round 1's bye dropping straight into a
// round 2 box that's itself structurally a bye, most commonly), there was
// no OTHER completed fixture yet to catch it against, so the entrant slid
// through with zero fairness check and picked up a guaranteed second bye
// before a single real match had been played anywhere. Every later hop in
// a longer chain was already covered (by the time round 2's bye resolves
// into round 3, round 1's bye is a separate, non-excluded fixture, so
// hasHadBye already finds it) - only this first hop was blind. Checking
// `fixture` itself alongside hasHadBye's own (unchanged) exclusion closes
// exactly that gap without touching the swap mechanism, or anything about
// why the exclusion was needed in the first place.
// FIX (2026-08-14, second pass - see claude/double-elim-test-and-fix-2026-08-14.md
// project doc for the simulation that found this): the sibling swap below was
// still the only mitigation once the blind spot above was closed, and it
// depends on a same-round sibling having a live, unclaimed route to trade -
// exactly the same dependency avoidRematchOnPlacement's own routing swap had
// (see that function's destination-round fallback, added the same day for
// the identical reason). Simulating the fixed version still found a
// meaningful residual failure rate concentrated at larger player counts, and
// tracing it showed the same cause: the sibling pool had simply run dry for
// that round.
//
// So this gets the same second fallback avoidRematchOnPlacement got: when
// the sibling-routing swap finds nothing, look at the OTHER boxes in the bye
// box's own round (same bracketRole) that are genuine two-sided fixtures
// (not a bye themselves), haven't started play yet, and already hold an
// occupant on either side. If that occupant hasn't had a bye themselves
// (don't just relocate the same problem onto someone else) and swapping them
// in wouldn't create a fresh rematch for either side, swap them directly
// with `entrantId`: the occupant takes the bye, `entrantId` takes over the
// seat they vacated. This only ever rewrites two fixtures' own player-slot
// fields - never any fixture's routing - so it can't create or duplicate a
// routing target (the PR #40 failure mode this area has to stay careful
// around). Because it places `entrantId` directly and resolves the bye it
// just handed out (mirroring what the caller's own normal-assignment path
// would have done), it returns true so the caller knows to skip that normal
// assignment.
function avoidRepeatByeOnPlacement(db, division, fixture, idField, slotField, entrantId) {
  const targetId = fixture[idField];
  const targetSlot = fixture[slotField];
  if (!targetId || !entrantId) return false;
  const dest = db.fixtures.find((f) => f.id === targetId);
  if (!dest || !dest.byeSlot) return false; // destination isn't a bye box - nothing to protect against
  const isTeams = division.entryType === 'teams';
  const playerField = (slot) => (isTeams
    ? (slot === 'home' ? 'homeTeamId' : 'awayTeamId')
    : (slot === 'home' ? 'homePlayerId' : 'awayPlayerId'));
  const otherSlotOf = (slot) => (slot === 'home' ? 'away' : 'home');
  const fixtureIsOwnBye = (() => {
    if (fixture.status !== 'completed') return false;
    const home = isTeams ? fixture.homeTeamId : fixture.homePlayerId;
    const away = isTeams ? fixture.awayTeamId : fixture.awayPlayerId;
    if (home !== entrantId && away !== entrantId) return false;
    return !home || !away;
  })();
  if (!fixtureIsOwnBye && !hasHadBye(db, division, entrantId, fixture.id)) return false; // this entrant's first bye, if it is one - fine

  const siblings = db.fixtures.filter((f) =>
    f.id !== fixture.id &&
    f.divisionId === fixture.divisionId &&
    f.bracketRole === fixture.bracketRole &&
    f.round === fixture.round &&
    f.status !== 'completed' &&
    f[idField]
  );
  const pick = siblings.find((f) => {
    const d = db.fixtures.find((x) => x.id === f[idField]);
    return d && !d.byeSlot;
  });
  if (pick) {
    const ours = { id: fixture[idField], slot: fixture[slotField] };
    fixture[idField] = pick[idField];
    fixture[slotField] = pick[slotField];
    pick[idField] = ours.id;
    pick[slotField] = ours.slot;
    return false;
  }

  // WIDENED - see the matching comment in avoidRematchOnPlacement's own
  // altBoxes block above (same fix, same day, same rationale): dropped the
  // `f.round === dest.round` restriction so this can swap with a
  // not-yet-started box anywhere in the same bracketRole, not just the
  // same round. Still only ever touches player-slot fields, never routing,
  // so it's exactly as safe widened as it was narrow.
  const altBoxes = db.fixtures.filter((f) =>
    f.id !== dest.id &&
    f.divisionId === dest.divisionId &&
    f.bracketRole === dest.bracketRole &&
    f.status !== 'completed' &&
    !f.byeSlot &&
    (!f.frames || f.frames.length === 0)
  );
  for (const alt of altBoxes) {
    for (const slot of ['home', 'away']) {
      const altOccupant = alt[playerField(slot)];
      if (!altOccupant || altOccupant === entrantId) continue;
      if (hasHadBye(db, division, altOccupant, alt.id)) continue; // don't just relocate the problem to someone else
      const altOtherOccupant = alt[playerField(otherSlotOf(slot))];
      if (altOtherOccupant && haveAlreadyPlayed(db, division, altOtherOccupant, entrantId)) continue; // don't fix a bye by creating a rematch

      dest[playerField(targetSlot)] = altOccupant;
      alt[playerField(slot)] = entrantId;
      resolveByeIfNeeded(db, division, dest);
      return true;
    }
  }

  return false;
}

function propagateWinner(db, division, fixture, winnerId) {
  if (!fixture.nextFixtureId) return;
  let handled = false;
  if (fixture.bracketRole === 'losers') {
    handled = avoidRematchOnPlacement(db, division, fixture, 'nextFixtureId', 'nextFixtureSlot', winnerId);
  }
  // Bye-fairness applies regardless of bracketRole (unlike rematch-
  // avoidance just above) - a winners-bracket round can land the same
  // entrant in a structural bye box twice over just as easily as the
  // losers bracket can (see avoidRepeatByeOnPlacement's doc comment). A
  // no-op whenever the destination isn't actually a bye box.
  const byeHandled = avoidRepeatByeOnPlacement(db, division, fixture, 'nextFixtureId', 'nextFixtureSlot', winnerId);
  // Either avoidRematchOnPlacement's or avoidRepeatByeOnPlacement's own
  // destination-round fallback (both 2026-08-14) can place `winnerId`
  // directly into its destination itself, when it does so it hands back
  // true - skip the normal assignment below so it isn't immediately
  // overwritten back into the seat the fallback just moved them out of.
  if (handled || byeHandled) return;
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
  // `next` might structurally never receive a second entrant - see
  // generateKnockoutFixtures, which marks byeSlot on any fixture created
  // from a round whose survivor count was odd (so its last box only ever
  // gets one real feeder). If so, the slot we just filled is next's only
  // real entrant, so it's already decided - resolve it immediately and
  // keep propagating, rather than waiting for a match that will never be
  // played. A genuine two-sided fixture (byeSlot left null) is left alone
  // here: an empty side there just means "the other semi-final hasn't been
  // played yet", not a bye - filling one side of a real fixture must never
  // auto-declare a winner.
  if (next.byeSlot) resolveByeIfNeeded(db, division, next);
}

// Double-elimination only: sends the LOSER of a winners-bracket fixture down
// into its assigned losers-bracket slot. Mirrors propagateWinner, but writes
// loserNextFixtureId/loserNextFixtureSlot instead, and is a no-op for
// anything that isn't a winners-bracket fixture (losers-bracket fixtures
// eliminate their loser outright - there's nowhere further for them to go).
function propagateLoser(db, division, fixture, loserId) {
  if (fixture.bracketRole !== 'winners' || !fixture.loserNextFixtureId || !loserId) return;
  const handled = avoidRematchOnPlacement(db, division, fixture, 'loserNextFixtureId', 'loserNextFixtureSlot', loserId);
  const byeHandled = avoidRepeatByeOnPlacement(db, division, fixture, 'loserNextFixtureId', 'loserNextFixtureSlot', loserId);
  // See propagateWinner's matching comment - either fallback may already
  // have seated `loserId` itself.
  if (handled || byeHandled) return;
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
  // might structurally never receive a second entrant either (a losers
  // bracket round can have its own bye box when its real-match count is
  // odd - see buildDoubleElimBracket/generateDoubleElimFixtures). Resolve
  // it immediately and keep the chain going if so.
  if (dest.byeSlot) resolveByeIfNeeded(db, division, dest);
}

// Double-elimination only: the losers-bracket champion enters the Grand
// Final with one life already spent, while the winners-bracket champion has
// none - so if the losers-bracket entrant (always seeded into the "away"
// slot - see generateDoubleElimFixtures) wins the Grand Final, the two
// entrants are level (one loss each) and must play a single decider
// ("bracket reset") to settle the title. If the winners-bracket entrant
// (home) wins outright, the tournament is over. Safe to call after any
// completion of a grand_final fixture - it's a no-op once a reset has
// already been created, or if the home side won.
function checkGrandFinalReset(db, division, fixture) {
  // ADEK is specified as a SINGLE Grand Final with no reset: one match
  // decides it, and the winners-bracket finalist gets no second life.
  if (division.scheduling === ADEK) return;
  if (fixture.bracketRole !== 'grand_final' || fixture.status !== 'completed' || fixture.resetFixtureId) return;
  const isTeams = division.entryType === 'teams';
  const winnerId = isTeams ? fixture.winnerTeamId : fixture.winnerPlayerId;
  const awayId = isTeams ? fixture.awayTeamId : fixture.awayPlayerId;
  if (!winnerId || winnerId !== awayId) return; // home (winners-bracket side) won outright, or no winner yet

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

function generateKnockoutFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  // rounds[0] has real entrants (nulls = ordinary byes, RESERVED_SLOT =
  // reserved late-entrant byes - see MAX_RESERVED_BYE_COUNT); later rounds
  // are just counts.
  const bracketRounds = buildBracketRounds(entrantIds, { reservedCount });

  const fixturesByRound = bracketRounds.map((pairs, roundIndex) =>
    pairs.map(() => makeFixture({ league, division, round: roundIndex + 1 }))
  );

  // Link each fixture to the one its winner advances to. When a round has
  // an odd number of boxes, its last box (index count-1, always even)
  // maps alone into the next round's last box's 'home' slot - nothing ever
  // maps to that box's 'away' slot, so it's marked byeSlot: 'away' below
  // and resolves itself automatically the moment its one real feeder
  // concludes (see propagateWinner).
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

  // Seed round 1 with the real entrants (marking its own bye box, if any -
  // same byeSlot field every later round uses, so propagateWinner only
  // needs one code path regardless of which round a bye falls in). A
  // RESERVED_SLOT second slot marks a box as a reserved late-entrant bye
  // (see MAX_RESERVED_BYE_COUNT) rather than an ordinary one - same shape,
  // but left unresolved below instead of auto-advancing immediately.
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
  // Resolve any non-reserved byes now that every fixture (and its
  // next-round link) exists - resolveByeIfNeeded itself skips anything
  // still marked reserved.
  fixturesByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// Double-elimination fixture generation. Builds three pieces - a winners
// bracket (identical construction to generateKnockoutFixtures, since
// buildDoubleElimBracket requires a power-of-two entrant count so there are
// never any byes to resolve), a losers bracket that receives each winners
// round's losers via loserNextFixtureId/loserNextFixtureSlot, and a Grand
// Final between the two brackets' champions. A potential bracket-reset
// decider is NOT created here - see checkGrandFinalReset, which creates it
// on demand once the Grand Final result is known.
function generateDoubleElimFixtures({ db, league, division, entrantIds }) {
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
  // Same linking as generateKnockoutFixtures - a non-power-of-two field can
  // still give the winners bracket a bye in a round after the first (see
  // buildBracketRounds), so mark byeSlot the same way here too.
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
  // Reserved-slot handling mirrors generateKnockoutFixtures - see its
  // comment above the equivalent block.
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
  // "LB round" here is numbered separately from winners-bracket rounds - the
  // frontend labels these distinctly (see DivisionDetail.jsx) rather than
  // conflating them with the `round` number, which is only used for the
  // date-spacing logic below.
  const lbByRound = losersRounds.map((round, roundIndex) =>
    Array.from({ length: round.boxCount }, () => {
      const f = makeFixture({ league, division, round: wbByRound.length + roundIndex + 1 });
      f.bracketRole = 'losers';
      return f;
    })
  );
  // A round with an odd real-match count leaves one box with only ever one
  // real feeder (whichever winners-bracket loser or losers-bracket survivor
  // ends up wired to it below) - mark it byeSlot the same way winners-
  // bracket byes are marked, always the round's last box.
  losersRounds.forEach((round, i) => {
    if (round.hasBye) lbByRound[i][lbByRound[i].length - 1].byeSlot = 'away';
  });
  // Link each losers-bracket round's winner forward to the next LB round.
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    current.forEach((fixture, i) => {
      if (nextIsMergeRound) {
        // 1:1 - this survivor takes the "home" slot of its own next-round
        // fixture; the "away" slot is filled by a fresh winners-bracket
        // loser (wired below).
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      } else {
        // Pure consolidation - pairs of adjacent survivors play each other.
        const target = next[Math.floor(i / 2)];
        fixture.nextFixtureId = target.id;
        fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
      }
    });
  }
  // Wire each winners round's losers into their losers-bracket destination.
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    // A bye box in the source winners round never produces a loser (nobody
    // played), so it's excluded here - only real-match boxes feed the
    // losers bracket.
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    wbSourceFixtures.forEach((fixture, i) => {
      let dest, slot;
      if (lbRoundIndex === 0) {
        // Entry round - the very first losers pair straight up against each
        // other, two winners-round losers per losers-bracket match.
        dest = lbDestFixtures[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'home' : 'away';
      } else if (i < lbRound.crossMatches) {
        // Cross-match portion - fills the "away" slot of an already-wired
        // 1:1 fixture (the "home" slot is an existing LB survivor, wired
        // above).
        dest = lbDestFixtures[i];
        slot = 'away';
      } else {
        // Leftover portion - not enough waiting LB survivors to pair
        // against every new loser, so these extras pair off among
        // themselves in their own boxes (after the cross-match ones).
        const j = i - lbRound.crossMatches;
        dest = lbDestFixtures[lbRound.crossMatches + Math.floor(j / 2)];
        slot = j % 2 === 0 ? 'home' : 'away';
      }
      fixture.loserNextFixtureId = dest.id;
      fixture.loserNextFixtureSlot = slot;
    });
  });

  // ---- Grand Final ----
  // By convention the winners-bracket champion always lands in the "home"
  // slot and the losers-bracket champion in "away" - checkGrandFinalReset
  // relies on this to know which side needs to win twice.
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
  // Resolve any non-reserved winners-bracket round-1 byes now that every
  // fixture (and its next-round link) exists - mirrors
  // generateKnockoutFixtures. An odd entrant count gives one ordinary bye
  // here; MAX_RESERVED_BYE_COUNT can add several more, deliberately left
  // unresolved (resolveByeIfNeeded skips anything still marked reserved).
  // Every later-round bye (winners or losers bracket) cascade-resolves
  // automatically via propagateWinner/propagateLoser as earlier fixtures
  // complete.
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// "Ally Knockout (Double elimination)" - a second, independent double-
// elimination scheduling option (scheduling: 'knockout_double_elim_ally'),
// separate from 'knockout_double_elim' above so the two can diverge in
// future without either affecting the other. Its own function body (not a
// call into generateDoubleElimFixtures) even though today the two are
// logically identical - see the project doc this was verified against
// (claude/ally-knockout-2026-08-14.md) for why: several genuinely different
// routing techniques were tried and empirically tested (a naive reversed-
// order tweak, rebuilding the bracket as a clean power-of-two tree, and a
// mathematically rigorous bracket-lineage-aware router) against the same
// 9,400-tournament methodology the original double-elim fixes used, and
// none measurably beat what's already in generateDoubleElimFixtures -
// three independent methods converged on the same finding the original
// double-elim work already reached: for a fixed entrant count with the
// minimum possible number of games, avoiding every rematch before the
// final and capping everyone to at most one bye are already very close to
// the achievable ceiling, not something a cleverer algorithm still has
// available to it. So this reuses the identical, most battle-tested
// technique (buildDoubleElimBracket for shape, the same
// avoidRematchOnPlacement/avoidRepeatByeOnPlacement reactive fairness
// helpers used by every knockout format) rather than inventing new,
// less-proven logic purely for its own sake - but keeps its own dedicated
// generator function and scheduling type so it has a genuinely independent
// on/off switch and a stable place to diverge later if a real improvement
// is ever found for one format and not the other.
//
// Known v1 limitation, deliberately not carried over: the late-entrant
// bracket rebuild (POST /api/divisions/:id/late-entrants,
// rebuildDoubleElimFromRound1) stays 'knockout_double_elim'-only for now -
// see that route's own guard below. Reserved bye slots
// (MAX_RESERVED_BYE_COUNT) are globally set to 0 already, so nothing is
// lost there for either format.
function generateAllyDoubleElimFixtures({ db, league, division, entrantIds }) {
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

  const allFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allFixtures.forEach((f) => db.fixtures.push(f));
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// ---- "Testing Double Elimination" fixture generation ----
//
// A third double-elimination format (division.scheduling ===
// 'knockout_double_elim_test'), independent of both generateDoubleElimFixtures
// and generateAllyDoubleElimFixtures above, that exists specifically to fix a
// real limitation in generateDoubleElimFixtures: that function's losers-
// bracket wiring pairs winners-round losers, and losers-bracket survivors
// against each other, in plain sequential/adjacent order (loser 0 vs loser
// 1, box 0's winner vs box 1's winner, etc.). Sequential-adjacent pairing
// has no relationship to the winners-bracket tree structure, so two players
// can end up facing each other again in the losers bracket well before the
// Losers Final/Grand Final, even though a "proper" double-elimination
// bracket is specifically designed so that only bracket topology (not luck)
// decides when rematches can happen.
//
// This function is otherwise IDENTICAL to generateDoubleElimFixtures - same
// buildDoubleElimBracket() round/box counts, same winners-bracket
// construction, same Grand Final wiring, same reserved-bye handling. The
// only thing that changes is *which* losers-bracket box each loser/survivor
// gets wired into, using standard bracket "mirroring": entrants who are
// close together structurally (adjacent winners-bracket boxes, or adjacent
// losers-bracket survivor boxes) are pushed to opposite ends of the next
// round instead of paired with their neighbour, and freshly-dropped
// winners-bracket losers are cross-matched against waiting losers-bracket
// survivors in reverse order rather than same-index order. This is the same
// "reversal/mirroring" technique standard seeded double-elimination
// generators use to keep opposite bracket halves apart until the brackets
// themselves force a merge.
//
// Note this does NOT pad the field to a power of two (deliberately, per
// product decision) - buildDoubleElimBracket's existing odd-count/bye
// handling is unchanged, so an irregular entrant count can still produce a
// bye in a round after the first exactly as it does for the original
// format. Without power-of-two padding there's no formal mathematical
// guarantee of zero rematches before the final (that guarantee normally
// relies on a fully seeded power-of-two draw) - this is a best-effort
// application of standard mirroring topology on top of the existing
// irregular-bracket shape, and meaningfully reduces (in most draws,
// eliminates) early rematches compared to the sequential-adjacent wiring
// above.
//
// Late-entrant mid-tournament bracket rebuild (see rebuildDoubleElimFromRound1
// and addLateEntrant below) is NOT supported for this format - it remains
// exclusive to 'knockout_double_elim'. That feature is unrelated to bracket
// topology/rematch-avoidance and duplicating its ~300 lines of reroster/
// rebuild logic was out of scope for this change.
function generateTestingDoubleElimFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ---- (identical to generateDoubleElimFixtures)
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
  // Link each losers-bracket round's winner forward to the next LB round.
  // MIRRORED vs generateDoubleElimFixtures: on a pure-consolidation round
  // (existing survivors playing each other, no fresh winners-bracket
  // losers arriving), pair box i's winner against box (count-1-i)'s winner
  // - opposite ends of the round - instead of adjacent boxes i/i+1. Merge
  // rounds (1:1 against a fresh loser, wired below) are unaffected here.
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    if (nextIsMergeRound) {
      current.forEach((fixture, i) => {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      });
    } else {
      const n = current.length;
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = current[p];
        const away = current[n - 1 - p];
        const target = next[p];
        home.nextFixtureId = target.id;
        home.nextFixtureSlot = 'home';
        away.nextFixtureId = target.id;
        away.nextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        // Structural bye box - the one leftover survivor advances alone.
        const mid = current[pairCount];
        const target = next[pairCount];
        mid.nextFixtureId = target.id;
        mid.nextFixtureSlot = 'home';
      }
    }
  }
  // Wire each winners round's losers into their losers-bracket destination.
  // MIRRORED vs generateDoubleElimFixtures in all three sub-cases below.
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    const n = wbSourceFixtures.length;

    if (lbRoundIndex === 0) {
      // Entry round - outside-in mirror pairing (0 vs last, 1 vs
      // second-last, ...) instead of adjacent pairing (0 vs 1, 2 vs 3, ...),
      // so winners-round losers who were structurally close in the
      // original draw are pushed as far apart as possible in the losers
      // bracket.
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = wbSourceFixtures[p];
        const away = wbSourceFixtures[n - 1 - p];
        const dest = lbDestFixtures[p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = wbSourceFixtures[pairCount];
        const dest = lbDestFixtures[pairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    } else {
      // Cross-match portion - REVERSED vs generateDoubleElimFixtures: the
      // i-th fresh loser fills the away slot of box (crossMatches-1-i)
      // instead of box i, so a fresh loser is matched against the survivor
      // structurally furthest from it rather than the one that happens to
      // share its array index.
      const crossN = lbRound.crossMatches;
      for (let i = 0; i < crossN; i++) {
        const fixture = wbSourceFixtures[i];
        const dest = lbDestFixtures[crossN - 1 - i];
        fixture.loserNextFixtureId = dest.id;
        fixture.loserNextFixtureSlot = 'away';
      }
      // Leftover portion - not enough waiting survivors to pair against
      // every new loser; the leftover new losers pair off among
      // themselves. Mirrored the same way as the entry round above,
      // instead of adjacent pairing.
      const leftoverCount = n - crossN;
      const leftoverPairCount = Math.floor(leftoverCount / 2);
      for (let p = 0; p < leftoverPairCount; p++) {
        const home = wbSourceFixtures[crossN + p];
        const away = wbSourceFixtures[crossN + leftoverCount - 1 - p];
        const dest = lbDestFixtures[crossN + p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (leftoverCount % 2 === 1) {
        const mid = wbSourceFixtures[crossN + leftoverPairCount];
        const dest = lbDestFixtures[crossN + leftoverPairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    }
  });

  // ---- Grand Final ---- (identical to generateDoubleElimFixtures)
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
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// ---- "Adaptive Double Elimination Knockout" (ADEK) ----
// (division.scheduling === ADEK)
//
// Round-at-a-time double elimination. Generation creates ROUND 1 ONLY; every
// later round is computed by appendAdaptiveRoundsIfDue() once the round
// before it has finished, from the results that actually happened. The
// pairing logic itself lives in services/adaptiveDoubleElim.js and is pure -
// no db, no randomness, no clock - so the next round is a deterministic
// function of (entrant order, completed rounds). That is what makes it safe
// to recompute from the fixture table on any request: the same history always
// yields the same round, so a repeated call can never produce a different
// draw.
//
// Fixture shape, and why it deliberately opts out of the placement engine:
//   * bracketRole is 'winners' | 'losers' | 'grand_final', same as every
//     other double-elim format, so champion detection, the public bracket
//     endpoint and the overlay all work unchanged.
//   * nextFixtureId / loserNextFixtureId / resetFixtureId are left null.
//     propagateWinner returns immediately without one, so avoidRematchOn-
//     Placement and avoidRepeatByeOnPlacement never run - correct, because
//     ADEK has already chosen a rematch-free pairing itself and a reactive
//     swap could only undo that.
//   * a bye is stored as its own completed fixture with byeSlot set, so it is
//     visible in the bracket and, more importantly, so the bye is part of the
//     recorded history the next round is computed from.
//   * `round` is a single sequence across both brackets (1, 2, 3...), because
//     unlike a pre-built bracket only one bracket plays in any given round.

function adaptiveEntrantIds(division) {
  if (division.entryType === 'teams') return division.teamIds || [];
  if (division.entryType === 'doubles') return division.pairingIds || [];
  return division.playerIds || [];
}

// Rebuild the completed-round history the pairing engine needs, straight from
// the fixture table. Returns complete:false the moment it hits a round that
// is still being played, which is also the signal "do not append anything".
function adaptiveHistory(division, fixtures) {
  const isTeams = division.entryType === 'teams';
  const HOME = isTeams ? 'homeTeamId' : 'homePlayerId';
  const AWAY = isTeams ? 'awayTeamId' : 'awayPlayerId';
  const WINNER = isTeams ? 'winnerTeamId' : 'winnerPlayerId';
  const byRound = new Map();
  for (const f of fixtures) {
    if (!byRound.has(f.round)) byRound.set(f.round, []);
    byRound.get(f.round).push(f);
  }
  const history = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const inRound = byRound.get(round);
    if (inRound.some((f) => f.status !== 'completed' || f.closedEarly)) {
      return { history, complete: false };
    }
    const matches = [];
    const byes = [];
    for (const f of inRound) {
      if (f.byeSlot) {
        const who = f[HOME] || f[AWAY];
        if (!who) return { history, complete: false };
        byes.push(who);
      } else {
        if (!f[HOME] || !f[AWAY] || !f[WINNER]) return { history, complete: false };
        matches.push({ a: f[HOME], b: f[AWAY], winner: f[WINNER] });
      }
    }
    const real = inRound.find((f) => !f.byeSlot) || inRound[0];
    history.push({ bracket: real.bracketRole, matches, byes });
  }
  return { history, complete: true };
}

// Build and push the next round. Returns true if anything was added.
function appendAdaptiveRound(db, league, division, fixtures) {
  const { history, complete } = adaptiveHistory(division, fixtures);
  if (!complete) return false;
  let round;
  try {
    round = adaptiveNextRound(adaptiveEntrantIds(division), history);
  } catch (err) {
    // A pairing failure must never take a page down with it. The division
    // simply stops advancing and an admin sees the outstanding round is
    // missing, which is recoverable; a 500 on every poll is not.
    console.error('ADEK: could not compute next round for division', division.id, err);
    return false;
  }
  if (!round || !round.matches.length) return false;

  const roundNo = fixtures.length ? Math.max(...fixtures.map((f) => f.round)) + 1 : 1;
  const isTeams = division.entryType === 'teams';
  const makeFixture = isTeams ? makeTeamFixture : makeSinglesFixture;
  const created = [];

  // The engine names its own rounds, and that name is the authoritative
  // record of whether a match is one of the three where a rematch is
  // permitted (Winners Final / Losers Final / Grand Final). Stamping it on
  // the fixture means the rule is inspectable in the data rather than
  // re-inferred - by the UI, by a report, or by anyone auditing a division.
  for (const [a, b] of round.matches) {
    const f = makeFixture({ league, division, round: roundNo });
    f.bracketRole = round.bracket;
    f.roundLabel = round.label;
    f.roundKind = round.kind;
    if (isTeams) { f.homeTeamId = a; f.awayTeamId = b; } else { f.homePlayerId = a; f.awayPlayerId = b; }
    created.push(f);
  }
  for (const entrantId of round.byes) {
    const f = makeFixture({ league, division, round: roundNo });
    f.bracketRole = round.bracket;
    f.roundLabel = round.label;
    f.roundKind = round.kind;
    f.byeSlot = 'away';
    f.status = 'completed';
    if (isTeams) { f.homeTeamId = entrantId; f.winnerTeamId = entrantId; } else { f.homePlayerId = entrantId; f.winnerPlayerId = entrantId; }
    created.push(f);
  }

  // Dates: carry the previous round's date forward by the division's gap.
  // assignScheduledDates only ever runs at generation time and needs a
  // startDate that isn't persisted, so later rounds date themselves.
  if (division.gapDays && roundNo > 1) {
    const prev = fixtures
      .filter((f) => f.round === roundNo - 1 && f.scheduledDate)
      .map((f) => f.scheduledDate)
      .sort();
    if (prev.length) {
      const d = new Date(`${prev[0]}T00:00:00`);
      d.setDate(d.getDate() + Number(division.gapDays));
      const iso = d.toISOString().slice(0, 10);
      created.forEach((f) => { f.scheduledDate = iso; });
    }
  }

  // Visibility: markAllRoundsVisible is a snapshot taken at generation time,
  // so a round invented later would be invisible to every non-admin - players
  // would never see their own match. Inherit the previous round's visibility,
  // which is the closest thing to the admin's expressed intent.
  if (roundNo === 1 || isRoundVisible(division, roundNo - 1)) {
    if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
    if (!division.visibleRounds.includes(roundNo)) {
      division.visibleRounds = [...division.visibleRounds, roundNo].sort((a, b) => a - b);
    }
  }

  created.forEach((f) => db.fixtures.push(f));
  return true;
}

// Called at the top of hydrateDivision, which already runs at the end of
// every route that can complete a fixture (plus every plain GET) - the same
// central hook recordChampionIfDivisionComplete uses, and for the same
// reason: there is no single fixture-completion funnel to hook instead.
// Every guard below is cheap and the common case (a round still in play)
// bails on the first scan, so this is a no-op on virtually every request.
function appendAdaptiveRoundsIfDue(db, division) {
  if (!division || division.scheduling !== ADEK) return false;
  if (!division.fixturesGenerated) return false;
  if (division.status === 'completed') return false;
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  if (fixtures.length === 0) return false;
  if (fixtures.some((f) => f.status !== 'completed')) return false;   // round still being played
  if (fixtures.some((f) => f.closedEarly)) return false;              // division was force-closed
  if (fixtures.some((f) => f.bracketRole === 'grand_final')) return false; // champion decided
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (!league) return false;
  return appendAdaptiveRound(db, league, division, fixtures);
}

function generateAdaptiveDoubleElimFixtures({ db, league, division, entrantIds }) {
  // Round 1 and nothing else - the rest of the event does not exist yet, and
  // that is the entire point of the format.
  appendAdaptiveRound(db, league, division, []);
  void entrantIds;
}

// ---- "Pre Configured Double Elimination Knockout" fixture generation ----
// (division.scheduling === 'knockout_double_elim_pcdek')
//
// IMPORTANT - read before touching this function or its rematch policy:
// this format was originally specced as a library of 50 hand-authored,
// per-entrant-count (1-50) bracket "templates" that would guarantee - not
// just minimize - that no two players ever meet twice before the Grand
// Final/Grand Final Reset, each one exhaustively validated against every
// possible sequence of winners/losers before being allowed into the
// library. That guarantee is proven mathematically impossible for a fixed
// (non-adaptive) match-routing graph, for essentially every entrant count
// above 2 - re-derived independently for this feature (a clean pigeonhole
// argument: whichever losers-bracket box a winners-bracket dropout is
// routed into, there is always at least one outcome branch where the only
// available same-loss-count opponent there is someone they already beat,
// because the routing has to be fixed in advance while the actual identity
// of who's "safe" to pair them with depends on match results that haven't
// happened yet) - and it matches, exactly, what this project's own prior
// research already found twice on 2026-08-14: the Ally Knockout
// bipartite-matching proof (claude/ally-knockout-2026-08-14.md - "impossible
// to guarantee...for most entrant counts") and the Pre-Configured Knockout
// spreadsheet analysis (claude/pre-configured-knockout-spreadsheet-analysis-2026-08-14.md
// - the industry-standard "Superior seeding" algorithm, the same one used by
// brackets-manager.js and Vertex42's templates, still produced a pre-final
// rematch in 49.55% of 23,500 simulated tournaments). Building 50 templates
// that claim to pass exhaustive zero-violation validation would mean either
// faking that result or silently weakening the rule - neither acceptable.
//
// So this format is real, but scoped honestly: "pre configured" means each
// entrant count's bracket SHAPE (round/box counts, bye placement, losers-
// bracket merge structure) is a fully deterministic structural template -
// see pcdekTemplateSummary() below, and buildDoubleElimBracket() in
// services/bracket.js which actually derives it - rather than a bracket
// dynamically invented ad hoc. It is not a hand-authored, independently
// "validated" template per player count; it's the same deterministic
// derivation every double-elim format here already uses, exposed as its
// own inspectable template. On top of that shape, this uses the single
// most effective losers-bracket wiring technique already proven in this
// codebase - the same outside-in "mirrored" topology as
// generateTestingDoubleElimFixtures (mirrors structurally-close dropouts
// to opposite ends of the next round instead of pairing neighbours) - plus
// the full reactive rematch/bye-fairness safety net every double-elim
// format here shares (avoidRematchOnPlacement's multi-hop chain search,
// avoidRepeatByeOnPlacement), which applies automatically to any fixture
// with bracketRole 'winners'/'losers' via propagateWinner/propagateLoser,
// regardless of scheduling type - nothing PCDEK-specific needed there.
// rematchPolicy for this format is GRAND_FINAL_ONLY-*preferred*: the
// generator and the runtime placement engine both actively work to
// avoid every rematch before the Grand Final/Grand Final Reset, and in
// practice succeed far more often than not (see the offline stress-test
// numbers in claude/pcdek-format-2026-08-15.md), but - like every other
// double-elim format in this codebase - cannot guarantee it in every
// branch. Do not present this format to users as a hard guarantee.
//
// Identical to generateTestingDoubleElimFixtures in every other respect
// (reserved-bye handling, Grand Final wiring, no power-of-two padding).
// Late-entrant mid-tournament bracket rebuild is NOT supported for this
// format either, for the same reason as Ally Knockout/Testing Double
// Elimination - see the dedicated generator functions' own comments.
function generatePCDEKFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ---- (identical to generateTestingDoubleElimFixtures)
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

  // ---- Losers bracket ---- (mirrored topology, identical to
  // generateTestingDoubleElimFixtures - see that function's own comments
  // for why outside-in mirroring beats sequential/adjacent pairing)
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
    if (nextIsMergeRound) {
      current.forEach((fixture, i) => {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      });
    } else {
      const n = current.length;
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = current[p];
        const away = current[n - 1 - p];
        const target = next[p];
        home.nextFixtureId = target.id;
        home.nextFixtureSlot = 'home';
        away.nextFixtureId = target.id;
        away.nextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = current[pairCount];
        const target = next[pairCount];
        mid.nextFixtureId = target.id;
        mid.nextFixtureSlot = 'home';
      }
    }
  }
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    const n = wbSourceFixtures.length;

    if (lbRoundIndex === 0) {
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = wbSourceFixtures[p];
        const away = wbSourceFixtures[n - 1 - p];
        const dest = lbDestFixtures[p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = wbSourceFixtures[pairCount];
        const dest = lbDestFixtures[pairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    } else {
      const crossN = lbRound.crossMatches;
      for (let i = 0; i < crossN; i++) {
        const fixture = wbSourceFixtures[i];
        const dest = lbDestFixtures[crossN - 1 - i];
        fixture.loserNextFixtureId = dest.id;
        fixture.loserNextFixtureSlot = 'away';
      }
      const leftoverCount = n - crossN;
      const leftoverPairCount = Math.floor(leftoverCount / 2);
      for (let p = 0; p < leftoverPairCount; p++) {
        const home = wbSourceFixtures[crossN + p];
        const away = wbSourceFixtures[crossN + leftoverCount - 1 - p];
        const dest = lbDestFixtures[crossN + p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (leftoverCount % 2 === 1) {
        const mid = wbSourceFixtures[crossN + leftoverPairCount];
        const dest = lbDestFixtures[crossN + leftoverPairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    }
  });

  // ---- Grand Final ---- (identical to generateDoubleElimFixtures)
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
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// Read-only structural summary of the PCDEK bracket "template" for a given
// player count (1-50), computed on demand from buildDoubleElimBracket
// rather than looked up from any hand-authored per-count table - see the
// big comment above generatePCDEKFixtures for why there's no such table.
// Used by GET /api/game-formats/pcdek/:playerCount so the client can show
// "what the bracket for N players looks like" (round counts, bye count,
// estimated games) before any division/entrants exist, without pretending
// each count has its own independently-validated design. playerCount === 1
// and 2 are handled as explicit special cases (see section 22 of the brief
// this format was built from) rather than forced through
// buildDoubleElimBracket, which requires 4+ entrants: 1 player is already
// champion with zero matches; 2 players need exactly one match, with no
// meaningful losers-bracket game to invent just to look like a "real" DE
// bracket; 3 players is the smallest count buildDoubleElimBracket doesn't
// support either, so it gets the same minimum-real-games treatment by hand
// (2 winners-bracket rounds feeding a 1-box losers bracket).
function pcdekTemplateSummary(playerCount) {
  const n = Math.max(1, Math.min(50, Math.round(Number(playerCount) || 0)));
  const templateId = `PCDEK-${String(n).padStart(2, '0')}`;
  const base = {
    templateId,
    formatId: 'knockout_double_elim_pcdek',
    formatName: 'Pre Configured Double Elimination Knockout',
    playerCount: n,
    rematchPolicy: 'GRAND_FINAL_ONLY_PREFERRED',
  };
  if (n === 1) {
    return { ...base, winnersBracketRounds: 0, losersBracketRounds: 0, estimatedGames: 0, note: 'A single player is champion immediately - no matches required.' };
  }
  if (n === 2) {
    return { ...base, winnersBracketRounds: 1, losersBracketRounds: 0, estimatedGames: 1, note: 'One match decides the champion outright - no losers-bracket game is meaningful with only 2 players.' };
  }
  if (n === 3) {
    return {
      ...base,
      winnersBracketRounds: 2,
      losersBracketRounds: 1,
      estimatedGames: 4,
      note: 'Smallest count with a genuine winners/losers-bracket split; below buildDoubleElimBracket\'s 4-entrant minimum so this shape is fixed by hand.',
    };
  }
  const reservedCount = reservedByeCountFor(n);
  const entrantIds = Array.from({ length: n }, (_, i) => `SEED-${String(i + 1).padStart(2, '0')}`);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });
  const byeCount =
    winnersRounds.reduce((sum, round) => sum + round.filter(([, b]) => b === null || b === RESERVED_SLOT).length, 0) +
    losersRounds.filter((r) => r.hasBye).length;
  return {
    ...base,
    winnersBracketRounds: winnersRounds.length,
    losersBracketRounds: losersRounds.length,
    byeCount,
    estimatedGames: 2 * n - 2,
    note: 'Bracket shape (rounds/bye placement) is deterministically derived from player count, not independently hand-authored - see generatePCDEKFixtures\'s doc comment.',
  };
}

// ---- Late entry: unlock the roster and rebuild the bracket ----
//
// Alternative to the reserved-bye-slot approach above (currently switched
// off - see MAX_RESERVED_BYE_COUNT) for a double-elimination knockout
// division: rather than pre-committing speculative empty slots at
// generation time, add the late entrant(s) to the roster for real and
// rebuild exactly as much of the bracket as their arrival actually changes.
// Usable up through the point where round 1 of the winners bracket has
// results on it but nothing past round 1 does (see
// isDivisionBracketReadyForLateEntrantRebuild) - round 1's *composition*
// (who plays whom) never changes for a box that's kept as-is, so any result
// already recorded there is safe to keep and simply replay forward onto the
// freshly rebuilt round 2+/losers-bracket tree (see the replay step at the
// end of this route). Round 2 onward has no such guarantee - which players
// even reach round 2 depends on round-1 boxes a late entrant can reshape -
// so the moment anything past round 1 has a real result, this refuses:
// there'd be no way to regenerate that part of the bracket without a real
// chance of silently discarding it.
//
// Round 1 is handled by hand (never by re-running buildDoubleElimBracket)
// because that function picks its round-1 bye at random on every call when
// the entrant count is odd - calling it again here could reassign the bye
// to a completely different, already-paired entrant instead of the one
// player actually left over. Reconciliation instead: keep every existing
// round-1 real match exactly as it is (result and all); if a round-1 bye
// currently exists, its holder plus the arriving player(s) form a "pending
// pool" (bye-holder first, then new arrivals in the order they're added);
// pair the pool off two at a time, reusing the existing bye fixture's row
// for the first pair so it converts from an automatic walkover into a real
// match without changing its identity; append any further pairs (and, if
// the pool is odd, one final single-occupant bye box) as brand new round-1
// fixtures. That new-fixtures-appended-after-the-existing-ones ordering is
// the "branch at the bottom" - everything before it is untouched.
//
// Everything from round 2 onward - the rest of the winners bracket, the
// entire losers bracket, and the Grand Final - depends on the *exact*
// number of losers each winners round produces, which a late entrant can
// change in ways that ripple much further than round 1 (see the project
// notes this was modelled against). None of that is allowed to have a real
// result on it yet, so rather than trying to patch it in place, it's
// archived wholesale and rebuilt fresh from the finished round-1 shape,
// reusing the same linking logic generateDoubleElimFixtures uses - and then
// any round-1 results are replayed onto it.
function isDivisionBracketReadyForLateEntrantRebuild(db, division) {
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  if (fixtures.length === 0) return false;
  // A fixture can legitimately already be `completed` here if it's a
  // structural bye (byeSlot set - one side was never populated) - that
  // resolves itself automatically the moment fixtures are generated or
  // reconciled (see resolveByeIfNeeded), and that's exactly the structural
  // state this route exists to unwind, not a real result.
  //
  // Round 1 of the winners bracket is allowed to already carry real
  // results - see the replay step at the end of the late-entrants route
  // below, which re-runs propagateWinner/propagateLoser for every decided
  // round-1 match against the freshly rebuilt round 2+/losers-bracket tree,
  // exactly as if an admin had just clicked "select winner" on each one
  // again. That's safe because a *kept* round-1 box's composition (who
  // plays whom) never changes when the entrant count grows - only what its
  // winner goes on to face next does, and the rebuild below regenerates
  // that next step from scratch anyway.
  //
  // Nothing past round 1 gets the same treatment. Round 2 onward is
  // archived and rebuilt wholesale (see rebuildDoubleElimFromRound1), and
  // *which* players even reach round 2 depends on round-1 boxes whose
  // composition a late entrant can change - so a round 2+ pairing that
  // already produced a real result has no guarantee of recurring in the
  // reshaped bracket. Once anything past round 1 has a recorded winner,
  // this still has to refuse - that's what makes archiving and rebuilding
  // everything past round 1 provably lossless. resetFixtureId can only
  // ever be set after a real Grand Final result (always well past round 1),
  // so its presence is an extra tripwire in case this is ever called
  // somewhere the other checks wouldn't catch.
  return fixtures.every((f) => {
    if (f.byeSlot) return true;
    if (f.round === 1 && f.bracketRole === 'winners') return true;
    return f.frames.length === 0 && f.winnerPlayerId == null && f.status !== 'completed' && !f.resetFixtureId;
  });
}

// Builds winners-bracket rounds 2+, the whole losers bracket, and the Grand
// Final from a already-finished round-1 fixture list, exactly mirroring the
// linking logic in generateDoubleElimFixtures's second half - see that
// function's comments for what each step is doing; this is the same thing,
// just driven from a caller-supplied round 1 instead of building one from
// entrantIds. `wbRound1Fixtures` fixtures are used as-is (not recreated);
// everything this function creates is pushed onto db.fixtures directly.
function rebuildDoubleElimFromRound1({ db, league, division, wbRound1Fixtures }) {
  const makeFixture = makeSinglesFixture; // late-entrant rebuild is singles-only for now (see the route below)
  const reservedCount = reservedByeCountFor(division.playerIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(division.playerIds, { reservedCount });

  if (winnersRounds[0].length !== wbRound1Fixtures.length) {
    // Defensive only - the route below constructs wbRound1Fixtures so its
    // length always matches ceil(newEntrantCount / 2), which is exactly
    // what buildDoubleElimBracket computes for round 1 too.
    throw new ApiError(500, 'Internal error: reconciled round 1 does not match the expected bracket shape for this entrant count');
  }

  // ---- Winners bracket rounds 2+ ----
  const wbByRound = [wbRound1Fixtures];
  for (let r = 1; r < winnersRounds.length; r++) {
    wbByRound.push(
      winnersRounds[r].map(() => {
        const f = makeFixture({ league, division, round: r + 1 });
        f.bracketRole = 'winners';
        return f;
      })
    );
  }
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

  const newFixtures = [...wbByRound.slice(1).flat(), ...lbByRound.flat(), grandFinal];
  newFixtures.forEach((f) => db.fixtures.push(f));
}

// Admin-only: adds one or more registered players to an already-generated
// double-elimination singles division and rebuilds the bracket around them,
// in place of turning them away or relying on a reserved slot. Only allowed
// while isDivisionBracketReadyForLateEntrantRebuild holds - see that
// function and the design note above rebuildDoubleElimFromRound1 for why.
// Every fixture this replaces is archived (db.archivedFixtures), never
// deleted outright.
app.post('/api/divisions/:id/late-entrants', requireAnyAdmin, asyncRoute((req, res) => {
  const { playerIds } = req.body || {};
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    throw new ApiError(400, 'playerIds (a non-empty array) is required');
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new ApiError(400, 'The same player was listed more than once');
  }

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  if (division.scheduling !== 'knockout_double_elim') {
    // Ally Knockout (knockout_double_elim_ally), Testing Double Elimination
    // (knockout_double_elim_test) and Pre Configured Double Elimination
    // Knockout (knockout_double_elim_pcdek) deliberately aren't supported
    // here yet - the rebuild below (rebuildDoubleElimFromRound1) is written
    // directly against this format's own bracket-shape assumptions;
    // extending it to the others too is a real follow-up task, not
    // something safe to silently alias.
    throw new ApiError(400, 'Adding a late entrant and rebuilding the bracket is currently only available for double-elimination knockout divisions (not yet supported for Ally Knockout, Testing Double Elimination, or Pre Configured Double Elimination Knockout)');
  }
  if (division.entryType !== 'singles') {
    throw new ApiError(400, 'Adding a late entrant and rebuilding the bracket is currently only available for singles divisions');
  }
  if (!division.fixturesGenerated) {
    throw new ApiError(400, 'Generate fixtures for this division first');
  }
  if (!isDivisionBracketReadyForLateEntrantRebuild(db, division)) {
    throw new ApiError(
      400,
      'This can only rebuild the bracket while round 1 is the furthest point any result has reached - once round 2 or the losers bracket has a recorded result, the bracket shape beyond round 1 can no longer be safely regenerated. Use Quick Add / a reserved slot instead, if one is open.'
    );
  }

  const newPlayers = playerIds.map((id) => {
    const player = registeredPlayers(db).find((p) => p.id === id);
    if (!player) throw new ApiError(400, `Player ${id} is not a registered, active user`);
    if (division.playerIds.includes(id)) throw new ApiError(400, `${player.name} is already in this division`);
    assertPaymentCleared(db, division, id);
    return player;
  });

  newPlayers.forEach((p) => division.playerIds.push(p.id));

  // ---- Reconcile round 1 (see the design note above) ----
  const existingR1 = db.fixtures.filter((f) => f.divisionId === division.id && f.round === 1 && f.bracketRole === 'winners');
  if (existingR1.some((f) => f.reserved)) {
    throw new ApiError(400, 'This division has an open reserved slot - close late entry (or have it claimed) before using this instead');
  }
  const byeBox = existingR1.find((f) => f.byeSlot === 'away') || null;
  if (byeBox && byeBox.frames.length > 0) {
    // Shouldn't be reachable in normal use (a walkover never gets scored),
    // but if it somehow happened, recycling this box below would silently
    // throw those frames away - refuse instead of guessing.
    throw new ApiError(500, 'Internal error: this division\'s round-1 bye box has frames recorded on it, which should never happen - contact support before retrying');
  }
  const realBoxesInOrder = existingR1.filter((f) => f !== byeBox);

  const pendingPool = [...(byeBox ? [byeBox.homePlayerId] : []), ...newPlayers.map((p) => p.id)];
  const wbRound1Fixtures = [...realBoxesInOrder];
  let i = 0;
  if (byeBox) {
    // byeBox was auto-resolved as a walkover the moment it was created (see
    // resolveByeIfNeeded) - status 'completed', a winner already recorded,
    // and that win already propagated forward. All of that is about to be
    // undone: it's becoming a genuine, unplayed two-sided match, so it has
    // to go back to looking like one - otherwise it reads as "already
    // played" and nothing (this route's own propagation below, or anyone
    // just browsing the bracket) will know to treat it as live again.
    byeBox.awayPlayerId = pendingPool[1];
    byeBox.byeSlot = null;
    byeBox.status = 'scheduled';
    byeBox.winnerPlayerId = null;
    byeBox.frames = [];
    byeBox.homeFrameScore = 0;
    byeBox.awayFrameScore = 0;
    wbRound1Fixtures.push(byeBox);
    i = 2;
  }
  for (; i < pendingPool.length; i += 2) {
    const f = makeSinglesFixture({ league, division, round: 1 });
    f.bracketRole = 'winners';
    f.homePlayerId = pendingPool[i];
    if (pendingPool[i + 1] !== undefined) {
      f.awayPlayerId = pendingPool[i + 1];
    } else {
      f.byeSlot = 'away';
    }
    db.fixtures.push(f);
    wbRound1Fixtures.push(f);
  }

  // ---- Archive everything downstream of round 1, then rebuild it fresh ----
  const keepIds = new Set(wbRound1Fixtures.map((f) => f.id));
  const toArchive = db.fixtures.filter((f) => f.divisionId === division.id && !keepIds.has(f.id));
  const archivedReason = `Bracket rebuilt to add late entrant(s): ${newPlayers.map((p) => p.name).join(', ')}`;
  toArchive.forEach((f) => {
    db.archivedFixtures.push({ ...f, archivedAt: new Date().toISOString(), archivedReason });
  });
  const archiveIds = new Set(toArchive.map((f) => f.id));
  db.fixtures = db.fixtures.filter((f) => !archiveIds.has(f.id));

  rebuildDoubleElimFromRound1({ db, league, division, wbRound1Fixtures });

  // Resolve any round-1 bye now that its downstream chain exists again -
  // mirrors the equivalent step at the end of generateDoubleElimFixtures.
  wbRound1Fixtures.filter((f) => f.byeSlot === 'away').forEach((f) => resolveByeIfNeeded(db, division, f));

  // ---- Replay any already-decided round-1 results onto the rebuilt tree ----
  // realBoxesInOrder are the round-1 boxes that existed before this request
  // and were kept exactly as they were (see the design note above) - any of
  // them may already be completed with a real winner (recorded via score
  // entry, or via the "select winner directly" admin override). Their
  // composition hasn't changed, but rebuildDoubleElimFromRound1 just gave
  // them a brand new, blank downstream to feed into - so push each result
  // forward again, exactly as if an admin had just clicked "select winner"
  // on it a second time against the new tree. propagateWinner/
  // propagateLoser handle everything from here, including cascading through
  // any newly-created structural byes further down (see resolveByeIfNeeded
  // calls inside them).
  const decidedRound1Boxes = realBoxesInOrder.filter((f) => f.status === 'completed' && f.winnerPlayerId);
  decidedRound1Boxes.forEach((f) => {
    const loserId = f.winnerPlayerId === f.homePlayerId ? f.awayPlayerId : f.homePlayerId;
    propagateWinner(db, division, f, f.winnerPlayerId);
    propagateLoser(db, division, f, loserId);
  });

  if (league && league.payment && league.payment.required) {
    newPlayers.forEach((p) => {
      const existing = db.leaguePayments.find((pay) => pay.leagueId === league.id && pay.playerId === p.id);
      if (!existing) {
        db.leaguePayments.push({
          id: uuid(),
          leagueId: league.id,
          playerId: p.id,
          status: 'unpaid',
          amount: league.payment.amount,
          currency: league.payment.currency,
          confirmedBy: null,
          confirmedAt: null,
          notes: '',
        });
      }
    });
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.add_late_entrants_rebuild_bracket',
    targetType: 'division',
    targetId: division.id,
    details: `${archivedReason} in "${division.name}" - archived ${toArchive.length} fixture(s), rebuilt the bracket around ${division.playerIds.length} total entrants, and replayed ${decidedRound1Boxes.length} already-decided round-1 result(s) onto it`,
  });

  writeDb(db);
  res.status(201).json({
    division: hydrateDivision(db, division),
    archivedFixtureCount: toArchive.length,
    replayedResultCount: decidedRound1Boxes.length,
    addedPlayers: newPlayers.map((p) => ({ id: p.id, name: p.name })),
  });
}));

// Assigns a `scheduledDate` (YYYY-MM-DD) to every fixture in a division,
// spacing rounds `gapDays` apart starting at `startDate` - this is what the
// season wizard's "gap between games" step controls. Not used for knockout
// divisions with byes in a way that's aware of walkover timing; it just
// spaces round N at startDate + (N-1)*gapDays, which is the right behaviour
// for round robin (every division the wizard creates) and a reasonable
// default for knockout too.
function assignScheduledDates(db, division, startDate, gapDays) {
  if (!startDate || !gapDays) return;
  const base = new Date(`${startDate}T00:00:00`);
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  for (const fixture of fixtures) {
    const date = new Date(base);
    date.setDate(date.getDate() + (fixture.round - 1) * Number(gapDays));
    fixture.scheduledDate = date.toISOString().slice(0, 10);
  }
}

// Multi-stage competitions: rather than one Division trying to model "groups
// then a knockout" internally, a group stage is just ordinary round-robin
// Divisions and the knockout stage is another ordinary Division - this
// endpoint is the one new piece, letting an admin auto-populate a
// not-yet-generated division's roster from the top N finishers of one or
// more other divisions' standings, instead of adding entrants one at a
// time. Every other route (generate-fixtures, scoring, standings) works
// completely unchanged on the resulting division - it's just a division
// whose roster happens to have been filled by group results instead of by
// hand.
app.post('/api/divisions/:id/seed-from-groups', requireAnyAdmin, asyncRoute((req, res) => {
  const { sources } = req.body || {};
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
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
    const { divisionId, count } = source || {};
    if (!divisionId || !Number.isInteger(Number(count)) || Number(count) < 1) {
      throw new ApiError(400, 'Each source needs a divisionId and a positive whole-number count');
    }
    const sourceDivision = db.divisions.find((d) => d.id === divisionId);
    if (!sourceDivision) throw new ApiError(404, `Source division ${divisionId} not found`);
    if (sourceDivision.id === division.id) throw new ApiError(400, 'A division cannot be seeded from itself');
    if (sourceDivision.entryType !== division.entryType) {
      throw new ApiError(
        400,
        `Source division "${sourceDivision.name}" is a ${sourceDivision.entryType} division - can't seed a ${division.entryType} division from it`
      );
    }

    // Reuses the exact same standings computation every division page
    // already shows, so "top N" here always matches what the admin sees on
    // the group's own standings table.
    const hydratedSource = hydrateDivision(db, sourceDivision);
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

  writeDb(db);
  res.status(201).json({ ...hydrateDivision(db, division), seedSummary });
}));

function markAllRoundsVisible(db, division) {
  const rounds = new Set(db.fixtures.filter((f) => f.divisionId === division.id).map((f) => f.round));
  division.visibleRounds = Array.from(rounds).sort((a, b) => a - b);
}

app.post('/api/divisions/:id/generate-fixtures', asyncRoute((req, res) => {
  const { startDate, gapDays, visibleByDefault } = req.body || {};
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Fixtures have already been generated for this division');
  }

  const entrantIds = division.entryType === 'teams'
    ? division.teamIds
    : division.entryType === 'doubles'
      ? division.pairingIds
      : division.playerIds;
  const entrantLabel = division.entryType === 'teams' ? 'teams' : division.entryType === 'doubles' ? 'pairings' : 'players';
  if (entrantIds.length < 2) {
    throw new ApiError(400, `A division needs at least 2 ${entrantLabel} before fixtures can be generated`);
  }
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
    generateKnockoutFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Double elimination needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateDoubleElimFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim_ally') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Ally Knockout needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateAllyDoubleElimFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim_test') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Double elimination needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateTestingDoubleElimFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim_pcdek') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Pre Configured Double Elimination Knockout needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generatePCDEKFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === ADEK) {
    if (entrantIds.length < 2) {
      throw new ApiError(
        400,
        `Adaptive Double Elimination Knockout needs at least 2 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateAdaptiveDoubleElimFixtures({ db, league, division, entrantIds });
  } else {
    generateRoundRobinFixtures({ db, league, division, entrantIds });
  }

  if (startDate && gapDays) {
    division.gapDays = Number(gapDays);
    assignScheduledDates(db, division, startDate, gapDays);
  }

  if (visibleByDefault) markAllRoundsVisible(db, division);
  division.fixturesGenerated = true;
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

// Powers the admin "Manage Fixtures" page: release (or re-hide) one round of
// a division's fixtures to/from players. Deliberately per-round rather than
// an all-or-nothing flag, since the whole point is a week-by-week reveal
// (release Round 1, then Round 2 the following week, and so on) rather than
// publishing the whole season's fixtures up front - see isRoundVisible above
// for what this actually gates.
app.post('/api/divisions/:id/rounds/:round/visibility', requireAnyAdmin, asyncRoute((req, res) => {
  const { visible } = req.body || {};
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
  const round = Number(req.params.round);
  if (!Number.isInteger(round)) throw new ApiError(400, 'round must be a whole number');
  const roundExists = db.fixtures.some((f) => f.divisionId === division.id && f.round === round);
  if (!roundExists) throw new ApiError(404, 'No fixtures found for this round in this division');

  if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
  if (visible) {
    if (!division.visibleRounds.includes(round)) division.visibleRounds.push(round);
  } else {
    division.visibleRounds = division.visibleRounds.filter((r) => r !== round);
  }
  recordAudit(db, {
    actor: req.adminSession.label,
    action: visible ? 'division.round_release' : 'division.round_hide',
    targetType: 'division',
    targetId: division.id,
    details: `Round ${round} ${visible ? 'released to players' : 'hidden from players'} (${division.name})`,
  });
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// Convenience for correcting a division where rounds ended up visible before
// an admin was ready - e.g. legacy data saved before fixtures started
// defaulting to hidden. Resets straight to "nothing released" in one request
// instead of clicking "Hide from Players" round by round.
app.post('/api/divisions/:id/hide-all-rounds', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
  const hadVisibleRounds = Array.isArray(division.visibleRounds) && division.visibleRounds.length > 0;
  division.visibleRounds = [];
  if (hadVisibleRounds) {
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'division.hide_all_rounds',
      targetType: 'division',
      targetId: division.id,
      details: `Hid all rounds from players (${division.name})`,
    });
  }
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// ---------- Fixtures / frame scoring (singles) ----------

app.get('/api/fixtures/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const divisionName = division ? division.name : null;
  // A non-admin can't see a fixture in a round that hasn't been released yet
  // - not even by guessing/bookmarking its direct URL - so this reports the
  // same 404 as a genuinely missing fixture rather than a 403 that would
  // confirm one exists.
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
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
    return res.json({ ...fixture, divisionName, legs, homeTeam, awayTeam, bothEntrantsKnown: !!(fixture.homeTeamId && fixture.awayTeamId) });
  }

  if (division.entryType === 'doubles') {
    const withPlayers = (pairing) => (pairing ? { ...pairing, players: db.players.filter((p) => pairing.playerIds.includes(p.id)) } : null);
    const homePairing = withPlayers(db.pairings.find((p) => p.id === fixture.homePlayerId));
    const awayPairing = withPlayers(db.pairings.find((p) => p.id === fixture.awayPlayerId));
    return res.json({ ...fixture, divisionName, homePairing, awayPairing, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) });
  }

  const homePlayer = fixture.homePlayerId ? db.players.find((p) => p.id === fixture.homePlayerId) : null;
  const awayPlayer = fixture.awayPlayerId ? db.players.find((p) => p.id === fixture.awayPlayerId) : null;
  res.json({ ...fixture, divisionName, homePlayer, awayPlayer, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) });
}));

app.post('/api/fixtures/:id/schedule', requireAnyAdmin, asyncRoute((req, res) => {
  const { tableId, scheduledDate, scheduledTime } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);

  // tableId is nullable (explicitly passing null/omitting clears it); if
  // provided and non-null, it must belong to this fixture's own league.
  if (tableId !== undefined && tableId !== null) {
    const table = league.tables.find((t) => t.id === tableId);
    if (!table) throw new ApiError(400, 'That table does not exist in this fixture\'s league');
  }

  const nextTableId = tableId === undefined ? fixture.tableId : tableId;
  const nextDate = scheduledDate === undefined ? fixture.scheduledDate : scheduledDate;
  const nextTime = scheduledTime === undefined ? fixture.scheduledTime : scheduledTime;

  // Double-booking check: another fixture can't already be on the same
  // table at the same date+time. Only meaningful once all three are set.
  if (nextTableId && nextDate && nextTime) {
    const clash = db.fixtures.find(
      (f) =>
        f.id !== fixture.id &&
        f.tableId === nextTableId &&
        f.scheduledDate === nextDate &&
        f.scheduledTime === nextTime
    );
    if (clash) {
      throw new ApiError(409, 'That table is already booked for another fixture at that date and time');
    }
  }

  fixture.tableId = nextTableId;
  fixture.scheduledDate = nextDate;
  fixture.scheduledTime = nextTime;
  writeDb(db);
  res.json(fixture);
}));

// ---------- Match timer & shot clock ----------
// A match timer (elapsed running clock for the whole fixture) and a shot
// clock (a per-shot countdown a captain/admin restarts before each shot) -
// both live directly on the fixture so they're visible to anyone viewing it
// (including the public overlay/arena display) without any extra state.
// Open to any logged-in account (same as frame scoring) rather than
// restricted to the two entrants, since whoever's refereeing the table is
// often not one of the players themselves.

app.post('/api/fixtures/:id/timer/start', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  if (!fixture.timer.running) {
    fixture.timer.running = true;
    fixture.timer.startedAt = new Date().toISOString();
  }
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/timer/pause', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  if (fixture.timer.running && fixture.timer.startedAt) {
    const elapsed = (Date.now() - new Date(fixture.timer.startedAt).getTime()) / 1000;
    fixture.timer.elapsedSeconds += Math.max(0, elapsed);
  }
  fixture.timer.running = false;
  fixture.timer.startedAt = null;
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/timer/reset', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/shot-clock/start', requireAuth, asyncRoute((req, res) => {
  const { durationSeconds } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  if (durationSeconds !== undefined) {
    if (!Number.isInteger(Number(durationSeconds)) || Number(durationSeconds) < 5) {
      throw new ApiError(400, 'durationSeconds must be a whole number of at least 5 seconds');
    }
    fixture.shotClock.durationSeconds = Number(durationSeconds);
  }
  fixture.shotClock.startedAt = new Date().toISOString();
  fixture.shotClock.running = true;
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/shot-clock/stop', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  fixture.shotClock.running = false;
  fixture.shotClock.startedAt = null;
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/frames', requireAuth, asyncRoute((req, res) => {
  const { winnerPlayerId } = req.body;
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (division.entryType === 'teams') {
    throw new ApiError(400, 'This is a team fixture - record frames against a specific leg instead');
  }
  if (!fixture.homePlayerId || !fixture.awayPlayerId) {
    throw new ApiError(400, 'Both players for this fixture are not yet known - waiting on an earlier round');
  }
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
  // NB: no auto-complete here anymore - reaching the race target just
  // unlocks the "Submit for Confirmation" button (see POST .../submit-result
  // below). Completion now always goes through that submit -> confirm
  // handshake, so a result never counts toward standings/a bracket until the
  // away side has actually agreed to it.

  writeDb(db);
  res.json(fixture);
}));

app.delete('/api/fixtures/:id/frames/last', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
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

  writeDb(db);
  res.json(fixture);
}));

// ---------- Result confirmation (singles/doubles) ----------
// Recording frames alone no longer finishes a match: once a side reaches the
// race target, whoever's entering scores clicks "Submit for Confirmation"
// (POST .../submit-result), which moves the fixture to `pending_confirmation`
// without yet touching standings or bracket propagation (both only ever look
// at `status === 'completed'` fixtures, so a pending result simply doesn't
// count yet). BOTH sides then have to independently confirm it (tracked via
// homeConfirmed/awayConfirmed) before it finalizes exactly the way
// frame-based auto-completion used to - either side can instead dispute it
// at any point while it's pending, which locks the fixture as `disputed`
// until an admin resolves it via a direct score override or by reopening it
// for more frames (Game Adjustments, see below).
function isAwayEntrant(db, division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.awayPlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.awayPlayerId === playerId;
}

function isHomeEntrant(db, division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.homePlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.homePlayerId === playerId;
}

app.post('/api/fixtures/:id/submit-result', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
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
  fixture.resultSubmittedBy = req.auth.user.id;
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/confirm-result', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
  const isHome = isHomeEntrant(db, division, fixture, req.auth.user.playerId);
  const isAway = isAwayEntrant(db, division, fixture, req.auth.user.playerId);
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a player in this fixture (or an admin) can confirm this result');
  }

  if (req.auth.user.isAdmin) {
    fixture.homeConfirmed = true;
    fixture.awayConfirmed = true;
  } else {
    if (isHome) fixture.homeConfirmed = true;
    if (isAway) fixture.awayConfirmed = true;
  }

  if (fixture.homeConfirmed && fixture.awayConfirmed) {
    fixture.status = 'completed';
    propagateWinner(db, division, fixture, fixture.winnerPlayerId);
    const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
    propagateLoser(db, division, fixture, loserPlayerId);
    checkGrandFinalReset(db, division, fixture);
  }
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/dispute-result', requireAuth, asyncRoute((req, res) => {
  const { reason } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
  const isHome = isHomeEntrant(db, division, fixture, req.auth.user.playerId);
  const isAway = isAwayEntrant(db, division, fixture, req.auth.user.playerId);
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a player in this fixture (or an admin) can dispute this result');
  }
  if (!reason || !reason.trim()) {
    throw new ApiError(400, 'A reason is required when disputing a result');
  }

  fixture.status = 'disputed';
  fixture.winnerPlayerId = null;
  fixture.disputeReason = reason.trim();
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/reopen', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);
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
    actor: req.adminSession.label, action: 'fixture.reopen', targetType: 'fixture', targetId: fixture.id,
    details: 'Reopened a pending/disputed result for further scoring',
  });
  writeDb(db);
  res.json(fixture);
}));

// ---------- Non-contactable / No-Show claims (singles/doubles + team legs) ----------
// Lets a player report their opponent as non-contactable / a no-show. Filing
// a claim doesn't finalize anything by itself - it just parks the fixture
// (or leg) as `disputed` with a `noShowClaim` marker, so it surfaces in the
// same admin queue as an ordinary scoring dispute (GET
// /api/admin/fixtures/needs-attention, shown on Game Adjustments as "Games
// disputed and Non-contactable/No Show") but tagged distinctly so an admin
// can action it with one click (POST .../no-show/authorize below) instead of
// the generic score-override form. Authorizing awards the reporting player a
// game win recorded as a 0-0 frame score, exactly as requested - standings
// only ever look at winnerPlayerId (see server/src/services/standings.js),
// so a 0-0 frame score with a real winner is fully compatible with the table.
app.post('/api/fixtures/:id/no-show', requireAuth, asyncRoute((req, res) => {
  const { legNumber } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  const claimantName = `${req.auth.user.firstName} ${req.auth.user.lastName}`;

  if (legNumber !== undefined && legNumber !== null) {
    const { leg } = findTeamFixtureAndLeg(db, req.params.id, legNumber);
    if (!['scheduled', 'in_progress'].includes(leg.status)) {
      throw new ApiError(400, 'Only a leg with both players nominated, that has not yet been submitted, can be reported as a no-show');
    }
    const isHome = !!req.auth.user.playerId && leg.homePlayerId === req.auth.user.playerId;
    const isAway = !!req.auth.user.playerId && leg.awayPlayerId === req.auth.user.playerId;
    if (!req.auth.user.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can report a no-show');
    }
    const winnerPlayerId = isHome ? leg.homePlayerId : leg.awayPlayerId;
    leg.status = 'disputed';
    leg.winnerPlayerId = null;
    leg.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
    leg.noShowClaim = {
      claimedBy: req.auth.user.id,
      claimedByName: claimantName,
      claimedSide: isHome ? 'home' : 'away',
      winnerPlayerId,
      at: new Date().toISOString(),
    };
    recomputeTeamFixture(db, division, fixture);
    writeDb(db);
    return res.json(fixture);
  }

  if (division.entryType === 'teams') {
    throw new ApiError(400, 'This is a team fixture - report a no-show against the specific leg');
  }
  if (!['scheduled', 'in_progress'].includes(fixture.status)) {
    throw new ApiError(400, 'Only a match that has not yet been submitted can be reported as a no-show');
  }
  const isHome = isHomeEntrant(db, division, fixture, req.auth.user.playerId);
  const isAway = isAwayEntrant(db, division, fixture, req.auth.user.playerId);
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a player in this fixture (or an admin) can report a no-show');
  }
  const winnerPlayerId = isHome ? fixture.homePlayerId : fixture.awayPlayerId;
  fixture.status = 'disputed';
  fixture.winnerPlayerId = null;
  fixture.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
  fixture.noShowClaim = {
    claimedBy: req.auth.user.id,
    claimedByName: claimantName,
    claimedSide: isHome ? 'home' : 'away',
    winnerPlayerId,
    at: new Date().toISOString(),
  };
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/no-show/authorize', requireAnyAdmin, asyncRoute((req, res) => {
  const { legNumber } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);

  if (legNumber !== undefined && legNumber !== null) {
    const { leg } = findTeamFixtureAndLeg(db, req.params.id, legNumber);
    if (!leg.noShowClaim) throw new ApiError(400, 'This leg has no no-show claim to authorise');
    leg.homeFrameScore = 0;
    leg.awayFrameScore = 0;
    leg.frames = [];
    leg.winnerPlayerId = leg.noShowClaim.winnerPlayerId;
    leg.status = 'completed';
    leg.disputeReason = null;
    recomputeTeamFixture(db, division, fixture);
    recordAudit(db, {
      actor: req.adminSession.label, action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
      details: `Authorised a non-contactable/no-show 0-0 walkover win for ${leg.noShowClaim.claimedByName} on Leg ${leg.legNumber}`,
    });
    writeDb(db);
    return res.json(fixture);
  }

  if (!fixture.noShowClaim) throw new ApiError(400, 'This fixture has no no-show claim to authorise');
  fixture.homeFrameScore = 0;
  fixture.awayFrameScore = 0;
  fixture.frames = [];
  fixture.winnerPlayerId = fixture.noShowClaim.winnerPlayerId;
  fixture.status = 'completed';
  fixture.disputeReason = null;
  fixture.adminOverride = { at: new Date().toISOString(), by: req.adminSession.label };
  propagateWinner(db, division, fixture, fixture.winnerPlayerId);
  const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
  propagateLoser(db, division, fixture, loserPlayerId);
  checkGrandFinalReset(db, division, fixture);
  recordAudit(db, {
    actor: req.adminSession.label, action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
    details: `Authorised a non-contactable/no-show 0-0 walkover win for ${fixture.noShowClaim.claimedByName}`,
  });
  writeDb(db);
  res.json(fixture);
}));

// ---------- Fixtures / leg scoring (teams) ----------
// A team match is decided the moment one side has won a majority of
// `legsPerMatch` legs (mirrors the singles "race to N" behaviour - once
// decided, no further legs are scored). With an odd legsPerMatch this always
// produces a winner; an even legsPerMatch can end level, which is recorded
// as a drawn team match once every leg is complete. A drawn knockout match
// has no winner to advance - use an odd legsPerMatch for knockout team
// divisions to guarantee one.

function recomputeTeamFixture(db, division, fixture) {
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
    propagateWinner(db, division, fixture, fixture.winnerTeamId);
    const loserTeamId = fixture.winnerTeamId === fixture.homeTeamId ? fixture.awayTeamId : fixture.homeTeamId;
    propagateLoser(db, division, fixture, loserTeamId);
    checkGrandFinalReset(db, division, fixture);
  }
}

function findTeamFixtureAndLeg(db, fixtureId, legNumber) {
  const fixture = db.fixtures.find((f) => f.id === fixtureId);
  if (!fixture || !fixture.legs) throw new ApiError(404, 'Team fixture not found');
  const leg = fixture.legs.find((l) => l.legNumber === Number(legNumber));
  if (!leg) throw new ApiError(404, 'Leg not found');
  return { fixture, leg };
}

app.post('/api/fixtures/:id/legs/:legNumber/nominate', requireAuth, asyncRoute((req, res) => {
  const { homePlayerId, awayPlayerId } = req.body;
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const nominateDivision = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(nominateDivision, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (!fixture.homeTeamId || !fixture.awayTeamId) {
    throw new ApiError(400, 'Both teams for this fixture are not yet known - waiting on an earlier round');
  }
  if (leg.status !== 'pending') {
    throw new ApiError(400, 'This leg already has nominated players - undo its frames first to change them');
  }

  const homeTeam = db.teams.find((t) => t.id === fixture.homeTeamId);
  const awayTeam = db.teams.find((t) => t.id === fixture.awayTeamId);
  if (!homeTeam.playerIds.includes(homePlayerId)) throw new ApiError(400, 'Home player is not registered to the home team');
  if (!awayTeam.playerIds.includes(awayPlayerId)) throw new ApiError(400, 'Away player is not registered to the away team');

  leg.homePlayerId = homePlayerId;
  leg.awayPlayerId = awayPlayerId;
  leg.status = 'scheduled';
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/legs/:legNumber/frames', requireAuth, asyncRoute((req, res) => {
  const { winnerPlayerId } = req.body;
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
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
  // Same submit -> confirm handshake as singles fixtures (see the "Result
  // confirmation" section below the singles frame routes) - reaching the
  // race target here just unlocks "Submit for Confirmation" on this leg.

  recomputeTeamFixture(db, division, fixture);
  writeDb(db);
  res.json(fixture);
}));

app.delete('/api/fixtures/:id/legs/:legNumber/frames/last', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
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

  recomputeTeamFixture(db, division, fixture);
  writeDb(db);
  res.json(fixture);
}));

// Same submit/confirm/dispute/reopen handshake as singles fixtures, scoped
// to one leg - see the singles "Result confirmation" section above for the
// full design notes. recomputeTeamFixture only ever tallies legs with
// status 'completed', so a pending/disputed leg simply doesn't count toward
// the team match yet, same as a pending singles fixture doesn't count
// toward standings.
app.post('/api/fixtures/:id/legs/:legNumber/submit-result', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const submitDivision = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(submitDivision, fixture.round)) {
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
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/legs/:legNumber/confirm-result', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
  const isHome = !!req.auth.user.playerId && leg.homePlayerId === req.auth.user.playerId;
  const isAway = !!req.auth.user.playerId && leg.awayPlayerId === req.auth.user.playerId;
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can confirm this leg');
  }
  if (req.auth.user.isAdmin) {
    leg.homeConfirmed = true;
    leg.awayConfirmed = true;
  } else {
    if (isHome) leg.homeConfirmed = true;
    if (isAway) leg.awayConfirmed = true;
  }
  if (leg.homeConfirmed && leg.awayConfirmed) {
    leg.status = 'completed';
  }
  recomputeTeamFixture(db, division, fixture);
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/legs/:legNumber/dispute-result', requireAuth, asyncRoute((req, res) => {
  const { reason } = req.body || {};
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
  const isHome = !!req.auth.user.playerId && leg.homePlayerId === req.auth.user.playerId;
  const isAway = !!req.auth.user.playerId && leg.awayPlayerId === req.auth.user.playerId;
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can dispute this leg');
  }
  if (!reason || !reason.trim()) {
    throw new ApiError(400, 'A reason is required when disputing a result');
  }
  leg.status = 'disputed';
  leg.winnerPlayerId = null;
  leg.disputeReason = reason.trim();
  recomputeTeamFixture(db, division, fixture);
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/legs/:legNumber/reopen', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const { fixture, leg } = findTeamFixtureAndLeg(db, req.params.id, req.params.legNumber);
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);
  if (!['pending_confirmation', 'disputed'].includes(leg.status)) {
    throw new ApiError(400, 'Only a pending or disputed leg can be reopened');
  }
  leg.status = 'in_progress';
  leg.winnerPlayerId = null;
  leg.disputeReason = null;
  leg.homeConfirmed = false;
  leg.awayConfirmed = false;
  leg.noShowClaim = null;
  recomputeTeamFixture(db, division, fixture);
  recordAudit(db, {
    actor: req.adminSession.label, action: 'fixture.leg_reopen', targetType: 'fixture', targetId: fixture.id,
    details: `Reopened Leg ${leg.legNumber} for further scoring`,
  });
  writeDb(db);
  res.json(fixture);
}));

// ---------- Public: stream overlay (OBS browser source) ----------
// A read-only, unauthenticated summary of one fixture's live score, meant to
// be loaded directly as an OBS "Browser Source" URL - OBS has no way to send
// a login token, so this can't sit behind requireAuth the way
// GET /api/fixtures/:id does. Deliberately public and deliberately narrow:
// it returns just enough to draw a
// scoreboard graphic (entrant names, scores, race/legs target, status), not
// the full fixture record (frame-by-frame history, ids, admin-override
// metadata) that the authenticated fixture endpoint exposes. Works for
// singles, teams, and doubles/triples fixtures alike by normalizing all
// three into the same { home, away } shape up front, so the frontend
// overlay page doesn't need to know which entryType it's rendering.
const OVERLAY_BRACKET_ROLE_LABEL = {
  winners: 'Winners Bracket',
  losers: 'Losers Bracket',
  grand_final: 'Grand Final',
  grand_final_reset: 'Grand Final - Bracket Reset',
};

function buildOverlayFixture(db, division, league, fixture) {
  const isTeams = division.entryType === 'teams';
  const isDoubles = division.entryType === 'doubles';
  const roundLabel = fixture.bracketRole && fixture.bracketRole !== 'single'
    ? (OVERLAY_BRACKET_ROLE_LABEL[fixture.bracketRole] || `Round ${fixture.round}`)
    : `Round ${fixture.round}`;

  let home;
  let away;
  let raceTo = null;
  let legsTotal = null;
  let winner = null;
  let bothEntrantsKnown;

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
      // null means the fixture was force-completed 0-0 by an admin closing
      // the division/league early (closeOutstandingFixtures) rather than
      // actually decided.
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

app.get('/api/overlay/fixtures/:id', asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  res.json(buildOverlayFixture(db, division, league, fixture));
}));

// ---------- Public: Arena big-display view ----------
// A read-only, unauthenticated board meant for a TV/monitor at the venue -
// same "no login token available" reasoning as the OBS overlay above, just
// showing the whole league's table schedule for today instead of one
// fixture. Groups today's fixtures by table (using buildOverlayFixture for
// each one, so the shapes stay consistent with the OBS overlay), plus a
// short list of the most recently completed results.
app.get('/api/overlay/leagues/:id/arena', asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');

  const today = new Date().toISOString().slice(0, 10);
  const leagueFixtures = db.fixtures.filter((f) => f.leagueId === league.id);
  const divisionsById = new Map(db.divisions.map((d) => [d.id, d]));

  const withOverlay = (fixture) => {
    const division = divisionsById.get(fixture.divisionId);
    if (!division) return null;
    return {
      ...buildOverlayFixture(db, division, league, fixture),
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

  res.json({
    leagueId: league.id,
    leagueName: league.name,
    generatedAt: new Date().toISOString(),
    tables,
    unscheduled,
    recentResults,
  });
}));

// ---------- Public: League Table & League Fixtures (embeddable pages) ----------
// Two more read-only, unauthenticated endpoints, same reasoning as the OBS
// overlay and Arena board above (no login available to the visitor), but
// aimed at being embedded (e.g. an <iframe>) on another site rather than an
// OBS scene or a venue TV - a running "League Table" and "League Fixtures"
// view of a whole league. Standings reuse hydrateDivision unmodified (same
// numbers a logged-in player would see - standings aren't gated by round
// visibility, see the comment on GET /api/divisions/:id above), but the
// fixture list *is* filtered by isRoundVisible, same as a non-admin account
// gets on the division page - a public embed must never show a round before
// an admin has released it, or "Manage Fixtures" round-release stops
// meaning anything.

app.get('/api/public/leagues/:id/table', asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');

  const divisions = db.divisions
    .filter((d) => d.leagueId === league.id)
    .sort((a, b) => a.order - b.order)
    .map((division) => {
      const hydrated = hydrateDivision(db, division);
      return {
        divisionId: division.id,
        divisionName: division.name,
        entryType: division.entryType,
        scheduling: division.scheduling,
        status: division.status || 'active',
        standings: hydrated.standings,
      };
    });

  res.json({
    leagueId: league.id,
    leagueName: league.name,
    generatedAt: new Date().toISOString(),
    divisions,
  });
}));

function buildPublicFixture(db, division, league, fixture) {
  if (!division) return null;
  return {
    ...buildOverlayFixture(db, division, league, fixture),
    divisionId: division.id,
    round: fixture.round,
    scheduledDate: fixture.scheduledDate,
    scheduledTime: fixture.scheduledTime,
  };
}

app.get('/api/public/leagues/:id/fixtures', asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');

  const divisionsById = new Map(db.divisions.filter((d) => d.leagueId === league.id).map((d) => [d.id, d]));

  const fixtures = db.fixtures
    .filter((f) => f.leagueId === league.id)
    .filter((f) => isRoundVisible(divisionsById.get(f.divisionId), f.round))
    .map((f) => buildPublicFixture(db, divisionsById.get(f.divisionId), league, f))
    .filter(Boolean)
    .sort((a, b) => {
      // Anything still to be decided sorts first (soonest scheduled date
      // first, unscheduled fixtures last within that group); completed
      // fixtures (including ones force-completed 0-0 by close-early - see
      // fixture.closedEarly) sort after, most recent first.
      const aDone = a.status === 'completed';
      const bDone = b.status === 'completed';
      if (aDone !== bDone) return aDone ? 1 : -1;
      if (aDone) return new Date(b.scheduledDate || 0) - new Date(a.scheduledDate || 0);
      if (!a.scheduledDate && !b.scheduledDate) return 0;
      if (!a.scheduledDate) return 1;
      if (!b.scheduledDate) return -1;
      return new Date(a.scheduledDate) - new Date(b.scheduledDate);
    });

  res.json({
    leagueId: league.id,
    leagueName: league.name,
    generatedAt: new Date().toISOString(),
    fixtures,
  });
}));

// ---------- Public: Division Table & Division Fixtures (embeddable pages) ----------
// Same reasoning/pattern as the League Table/Fixtures endpoints above, but
// scoped to a single division rather than every division in a league - for
// embedding one division's standings/fixtures on its own page elsewhere
// (e.g. a dedicated "Division 3" page on another site), rather than a whole
// league's worth of divisions on one embed.

app.get('/api/public/divisions/:id/table', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const hydrated = hydrateDivision(db, division);

  res.json({
    divisionId: division.id,
    divisionName: division.name,
    leagueId: division.leagueId,
    leagueName: league ? league.name : null,
    entryType: division.entryType,
    scheduling: division.scheduling,
    status: division.status || 'active',
    generatedAt: new Date().toISOString(),
    standings: hydrated.standings,
  });
}));

app.get('/api/public/divisions/:id/fixtures', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);

  const fixtures = db.fixtures
    .filter((f) => f.divisionId === division.id)
    .filter((f) => isRoundVisible(division, f.round))
    .map((f) => buildPublicFixture(db, division, league, f))
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

  res.json({
    divisionId: division.id,
    divisionName: division.name,
    leagueId: division.leagueId,
    leagueName: league ? league.name : null,
    generatedAt: new Date().toISOString(),
    fixtures,
  });
}));

// ---------- Public: Division Bracket (embeddable page) ----------
// A read-only, unauthenticated view of one single-elimination knockout
// division's bracket - same "no login available to an embedded page"
// reasoning as the League Table/Fixtures endpoints above, and built the
// same way: reuse buildOverlayFixture (already computes entrant names,
// scores, bothEntrantsKnown and who won) rather than re-deriving any of
// that, and respect isRoundVisible so an embed can never show a round
// before an admin has released it. Supports both single- and
// double-elimination knockout divisions (round robin's flat standings
// table doesn't fit either chart shape, so anything else still gets a 400)
// - which shape the client should render is told apart by the `scheduling`
// field in the response, since single-elimination's chart needs `matches`
// grouped by a flat `round` plus `totalRounds`, while double-elimination's
// needs each match's `bracketRole`/`nextFixtureId`/`loserNextFixtureId`/
// `resetFixtureId` links instead (see DoubleElimBracketChart.jsx - unlike
// the authenticated division page, this is the only place that chart is
// ever handed those links without also being logged in, so they're
// deliberately included here even though the rest of this endpoint is
// otherwise a deliberately trimmed-down public view).
function buildPublicBracketMatch(db, division, league, fixture) {
  const overlay = buildOverlayFixture(db, division, league, fixture);
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
}

function buildPublicDoubleElimMatch(db, division, league, fixture) {
  const isTeams = division.entryType === 'teams';
  return {
    ...buildPublicBracketMatch(db, division, league, fixture),
    bracketRole: fixture.bracketRole,
    nextFixtureId: fixture.nextFixtureId || null,
    loserNextFixtureId: fixture.loserNextFixtureId || null,
    resetFixtureId: fixture.resetFixtureId || null,
    // ADEK only - see appendAdaptiveRound. Null for every other format,
    // which names its rounds from bracket position instead.
    roundLabel: fixture.roundLabel || null,
    roundKind: fixture.roundKind || null,
    byeSlot: fixture.byeSlot || null,
    // ADEK's public chart (AdaptiveBracketChart.jsx) has no fixture-to-fixture
    // links to draw from (see that file's header comment) - it reconstructs
    // the bracket tree after the fact by tracing which match each entrant
    // most recently appeared in, which needs their raw id, not just their
    // display name. Every other double-elim format ignores these two fields.
    homeId: (isTeams ? fixture.homeTeamId : fixture.homePlayerId) || null,
    awayId: (isTeams ? fixture.awayTeamId : fixture.awayPlayerId) || null,
  };
}

app.get('/api/public/divisions/:id/bracket', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const isDoubleElim = DOUBLE_ELIM_TYPES.includes(division.scheduling);
  if (division.scheduling !== 'knockout_single_elim' && !isDoubleElim) {
    throw new ApiError(400, 'This endpoint only supports single- or double-elimination knockout divisions');
  }
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const hydrated = hydrateDivision(db, division);

  const visibleFixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
  const matches = isDoubleElim
    ? visibleFixtures.map((f) => buildPublicDoubleElimMatch(db, division, league, f))
    : visibleFixtures.map((f) => buildPublicBracketMatch(db, division, league, f));

  res.json({
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
  });
}));

// ---------- Admin score/game override ----------
// Lets an admin directly set a fixture's final score to correct a
// mis-recorded result, bypassing the normal frame-by-frame flow entirely.
// Deliberately blunt: it replaces the recorded frames/legs with just the
// final tally (tagged `adminOverride` so the UI can show it was hand-set
// rather than played out), rather than trying to reconstruct a plausible
// frame history. Re-propagates into the next knockout round if the winner
// changed, but refuses if that would silently overwrite a match that's
// already been played - the admin has to fix the downstream fixture first,
// so a correction can never quietly erase someone else's recorded result.
app.post('/api/fixtures/:id/override', requireAnyAdmin, asyncRoute((req, res) => {
  const { homeScore, awayScore } = req.body;
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);
  const isTeams = division.entryType === 'teams';

  if (isTeams) {
    if (!fixture.homeTeamId || !fixture.awayTeamId) {
      throw new ApiError(400, 'Both teams for this fixture are not yet known');
    }
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

  // Decide whether this override needs to (re-)propagate into the next
  // knockout round by checking what the *destination* fixture currently
  // holds, rather than only comparing newWinnerId to this fixture's own
  // previous winner. The old comparison meant that if an earlier attempt to
  // propagate this fixture's winner never actually landed downstream (for
  // any reason), re-submitting the same correct winner would never
  // re-trigger it - the next round's slot would stay stuck empty forever,
  // since from this fixture's point of view "the winner" never changed.
  // Checking the live downstream state instead makes every override
  // self-healing: it always leaves the next fixture in sync with this one's
  // recorded winner, and still refuses (409, below) whenever doing so would
  // silently overwrite a next fixture that has already been played.
  const next = fixture.nextFixtureId ? db.fixtures.find((f) => f.id === fixture.nextFixtureId) : null;
  const nextCurrentOccupant = next
    ? (isTeams
        ? (fixture.nextFixtureSlot === 'home' ? next.homeTeamId : next.awayTeamId)
        : (fixture.nextFixtureSlot === 'home' ? next.homePlayerId : next.awayPlayerId))
    : null;
  const winnerNeedsPropagating = !!(next && newWinnerId && nextCurrentOccupant !== newWinnerId);

  if (winnerNeedsPropagating) {
    const nextHasStarted = isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0;
    if (nextHasStarted) {
      throw new ApiError(409, 'This result has already progressed to a fixture that has started - override or reset that fixture first');
    }
  }

  if (isTeams) {
    fixture.homeLegsWon = homeScore;
    fixture.awayLegsWon = awayScore;
    fixture.winnerTeamId = newWinnerId;
    fixture.legs = fixture.legs.map((leg) => ({
      ...leg,
      homePlayerId: null,
      awayPlayerId: null,
      frames: [],
      homeFrameScore: 0,
      awayFrameScore: 0,
      status: 'pending',
      winnerPlayerId: null,
    }));
  } else {
    fixture.homeFrameScore = homeScore;
    fixture.awayFrameScore = awayScore;
    fixture.frames = [];
    fixture.winnerPlayerId = newWinnerId;
  }
  fixture.status = 'completed';
  fixture.adminOverride = { at: new Date().toISOString(), by: req.adminSession.label };
  fixture.disputeReason = null;

  if (winnerNeedsPropagating) {
    propagateWinner(db, division, fixture, newWinnerId);
  }
  if (newWinnerId) {
    // Always (re-)propagate the loser too, for the same self-healing reason
    // as above - propagateLoser is a no-op if the losers-bracket
    // destination already holds this loser, so this is always safe.
    const newLoserId = newWinnerId === (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
      ? (isTeams ? fixture.awayTeamId : fixture.awayPlayerId)
      : (isTeams ? fixture.homeTeamId : fixture.homePlayerId);
    propagateLoser(db, division, fixture, newLoserId);
  }
  checkGrandFinalReset(db, division, fixture);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'fixture.override',
    targetType: 'fixture',
    targetId: fixture.id,
    details: `Set final score to ${homeScore}-${awayScore}`,
  });

  writeDb(db);
  res.json(fixture);
}));

// ---------- Admin: select bracket winner directly ----------
// A fast path for the admin bracket chart on the Division page: instead of
// recording frames and going through the normal submit/confirm handshake,
// an admin can click a player's (or team's) name directly and declare them
// the winner - for walk-in exhibition rounds, byes settled without playing,
// or any other case where the actual score doesn't matter. Deliberately
// restricted to fixtures that haven't been touched at all yet (status
// 'scheduled', zero frames/no leg activity) - if any score has already been
// recorded, this route refuses and the admin has to use the normal scoring
// flow or the Override Result panel instead, so a quick mis-tap can never
// silently discard real recorded frames. Recorded with an empty frame
// history and `scoreRecorded: false` (rather than a 0-0 score) so the
// bracket chart/fixture page can show "no score recorded" instead of a
// scoreline that looks like a played 0-0 match. Shares the Override
// endpoint's downstream-propagation guard above: refuses if picking this
// winner would overwrite a next-round fixture that's already started.
app.post('/api/fixtures/:id/select-winner', requireAnyAdmin, asyncRoute((req, res) => {
  const { winnerId } = req.body;
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  const league = db.leagues.find((l) => l.id === fixture.leagueId);
  assertLeagueAccess(req, league);
  const isTeams = division.entryType === 'teams';

  if (isTeams) {
    if (!fixture.homeTeamId || !fixture.awayTeamId) {
      throw new ApiError(400, 'Both teams for this fixture are not yet known');
    }
    if (winnerId !== fixture.homeTeamId && winnerId !== fixture.awayTeamId) {
      throw new ApiError(400, "winnerId must be one of this fixture's two teams");
    }
    if (fixture.status !== 'scheduled' || fixture.legs.some((l) => l.status !== 'pending')) {
      throw new ApiError(400, 'This fixture already has a result recorded - use score entry or the Override Result panel instead');
    }
  } else {
    if (!fixture.homePlayerId || !fixture.awayPlayerId) {
      throw new ApiError(400, 'Both players for this fixture are not yet known');
    }
    if (winnerId !== fixture.homePlayerId && winnerId !== fixture.awayPlayerId) {
      throw new ApiError(400, "winnerId must be one of this fixture's two entrants");
    }
    if (fixture.status !== 'scheduled' || fixture.frames.length > 0) {
      throw new ApiError(400, 'This fixture already has a result recorded - use score entry or the Override Result panel instead');
    }
  }

  const next = fixture.nextFixtureId ? db.fixtures.find((f) => f.id === fixture.nextFixtureId) : null;
  const nextCurrentOccupant = next
    ? (isTeams
        ? (fixture.nextFixtureSlot === 'home' ? next.homeTeamId : next.awayTeamId)
        : (fixture.nextFixtureSlot === 'home' ? next.homePlayerId : next.awayPlayerId))
    : null;
  const winnerNeedsPropagating = !!(next && nextCurrentOccupant !== winnerId);

  if (winnerNeedsPropagating) {
    const nextHasStarted = isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0;
    if (nextHasStarted) {
      throw new ApiError(409, 'This result has already progressed to a fixture that has started - override or reset that fixture first');
    }
  }

  if (isTeams) {
    fixture.homeLegsWon = 0;
    fixture.awayLegsWon = 0;
    fixture.winnerTeamId = winnerId;
    fixture.legs = fixture.legs.map((leg) => ({
      ...leg,
      homePlayerId: null,
      awayPlayerId: null,
      frames: [],
      homeFrameScore: 0,
      awayFrameScore: 0,
      status: 'pending',
      winnerPlayerId: null,
    }));
  } else {
    fixture.homeFrameScore = 0;
    fixture.awayFrameScore = 0;
    fixture.frames = [];
    fixture.winnerPlayerId = winnerId;
  }
  fixture.status = 'completed';
  fixture.adminOverride = { at: new Date().toISOString(), by: req.adminSession.label };
  fixture.scoreRecorded = false;
  fixture.disputeReason = null;

  if (winnerNeedsPropagating) {
    propagateWinner(db, division, fixture, winnerId);
  }
  const loserId = winnerId === (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
    ? (isTeams ? fixture.awayTeamId : fixture.awayPlayerId)
    : (isTeams ? fixture.homeTeamId : fixture.homePlayerId);
  propagateLoser(db, division, fixture, loserId);
  checkGrandFinalReset(db, division, fixture);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'fixture.winner_selected',
    targetType: 'fixture',
    targetId: fixture.id,
    details: 'Selected the winner directly from the bracket, without recording a score',
  });

  writeDb(db);
  res.json(fixture);
}));

// ---------- Admin: mid-season player substitution ----------
// Lets an admin swap a player out for a replacement in a singles division
// when someone drops out. The incoming player takes over every fixture that
// hasn't been played yet at all (status 'scheduled'); anything already
// completed, or already partway through (status 'in_progress' - some frames
// recorded), is left exactly as it is so history/stats aren't disturbed -
// those in-progress fixtures are reported back separately so the admin
// knows they still reference the outgoing player and need to be finished or
// overridden first if they should change hands too.
//
// `reason` distinguishes two situations that reassign fixtures identically
// but differ in one way: whether the outgoing player still belongs on the
// division's roster afterwards.
//   - 'substitution' (default): a like-for-like swap - the outgoing player
//     stays on the roster (their played-so-far record keeps showing in the
//     League Table and their profile); the incoming player is added
//     alongside them, not swapped in for them, since their history is a
//     separate thing.
//   - 'retirement': the outgoing player is leaving the league, not being
//     temporarily covered for. Their remaining fixtures are handed over
//     exactly the same way, but they're also removed from
//     division.playerIds, so their row disappears from the League Table
//     going forward. Matches they already completed are untouched, so
//     opponents' won/lost/frame counts from those games still stand -
//     computeStandings derives every row purely from that row's own
//     fixtures, so removing the retiree from playerIds only removes their
//     own row, it doesn't touch anyone else's numbers. Their full match
//     history still shows on their own player profile page regardless.
// There's no "reset scores and start the incoming player from zero" option
// yet - that's a bigger, separate feature if it's ever needed.
app.post('/api/divisions/:id/substitute-player', requireAnyAdmin, asyncRoute((req, res) => {
  const { outgoingPlayerId, incomingPlayerId, reason = 'substitution' } = req.body;
  if (!outgoingPlayerId || !incomingPlayerId) {
    throw new ApiError(400, 'outgoingPlayerId and incomingPlayerId are required');
  }
  if (outgoingPlayerId === incomingPlayerId) {
    throw new ApiError(400, 'The replacement must be a different player from the one dropping out');
  }
  if (!['substitution', 'retirement'].includes(reason)) {
    throw new ApiError(400, "reason must be 'substitution' or 'retirement'");
  }

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);
  if (division.entryType !== 'singles') {
    throw new ApiError(400, 'Player substitution is only available for singles divisions right now');
  }
  if (!division.playerIds.includes(outgoingPlayerId)) {
    throw new ApiError(400, 'That player is not registered in this division');
  }
  if (division.playerIds.includes(incomingPlayerId)) {
    throw new ApiError(400, 'That replacement is already registered in this division');
  }

  const incoming = registeredPlayers(db).find((p) => p.id === incomingPlayerId);
  if (!incoming) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
  assertPaymentCleared(db, division, incoming.id);
  const outgoing = db.players.find((p) => p.id === outgoingPlayerId);

  const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const swapped = [];
  const blockedInProgress = [];

  for (const fixture of divisionFixtures) {
    const isHome = fixture.homePlayerId === outgoingPlayerId;
    const isAway = fixture.awayPlayerId === outgoingPlayerId;
    if (!isHome && !isAway) continue;

    if (fixture.status === 'completed') continue; // already played - history stays as-is
    if (fixture.status === 'in_progress') {
      blockedInProgress.push({ fixtureId: fixture.id, round: fixture.round });
      continue; // has frames already recorded against the outgoing player
    }
    // status === 'scheduled': nobody has played this yet, safe to hand over
    if (isHome) fixture.homePlayerId = incomingPlayerId;
    else fixture.awayPlayerId = incomingPlayerId;
    swapped.push({ fixtureId: fixture.id, round: fixture.round });
  }

  division.playerIds.push(incomingPlayerId);
  if (reason === 'retirement') {
    division.playerIds = division.playerIds.filter((id) => id !== outgoingPlayerId);
  }
  if (!division.substitutions) division.substitutions = [];
  division.substitutions.push({
    id: uuid(),
    outgoingPlayerId,
    outgoingPlayerName: outgoing ? outgoing.name : 'Unknown player',
    incomingPlayerId,
    incomingPlayerName: incoming.name,
    reason,
    at: new Date().toISOString(),
    by: req.adminSession.label,
    fixturesSwapped: swapped.length,
  });

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.substitute_player',
    targetType: 'division',
    targetId: division.id,
    details: reason === 'retirement'
      ? `${outgoing ? outgoing.name : 'A player'} retired from "${division.name}" - removed from the League Table, ${incoming.name} took over ${swapped.length} remaining fixture(s)`
      : `Swapped ${outgoing ? outgoing.name : 'a player'} out for ${incoming.name} in "${division.name}" (${swapped.length} remaining fixture(s) reassigned)`,
  });

  writeDb(db);
  res.json({ division: hydrateDivision(db, division), swapped, blockedInProgress, reason });
}));

// ---------- Players ----------

app.get('/api/players', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  res.json(db.players);
}));

app.get('/api/players/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const profile = buildPlayerProfile(db, req.params.id);
  if (!profile) throw new ApiError(404, 'Player not found');
  res.json(profile);
}));

// ---------- Admin: user management ----------
// Everything here requires requireAdmin (isAdmin: true on the account).
// There's no protection against an admin demoting/suspending themselves in
// this v1 - keep at least one other working admin account around if you're
// experimenting with permissions.

app.get('/api/admin/users', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const q = (req.query.q || '').trim().toLowerCase();
  let users = db.users;
  if (q) {
    users = users.filter((u) =>
      `${u.firstName} ${u.lastName}`.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.teamName.toLowerCase().includes(q)
    );
  }
  users = [...users].sort((a, b) => a.lastName.localeCompare(b.lastName));
  res.json(users.map(publicUser));
}));

app.get('/api/admin/users/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  res.json(publicUser(user));
}));

// Looks up the registered account (if any) linked to a Player roster entry -
// backs the admin "edit this player's account" panel on the player profile
// page (PlayerProfile.jsx), which needs to go from a `playerId` (the profile
// being viewed) to the `User` record that actually owns name/email/phone/etc.
// Not every Player has a linked account (older seed/demo data can have bare
// Player rows with no registered user) - `user: null` signals that case so
// the frontend can show "no registered account" instead of an edit form.
app.get('/api/admin/users/by-player/:playerId', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.playerId === req.params.playerId) || null;
  res.json({ user: publicUser(user) });
}));

app.patch('/api/admin/users/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  applyProfileFields(db, user, req.body);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'user.edit',
    targetType: 'user',
    targetId: user.id,
    details: `Edited profile for ${user.firstName} ${user.lastName}`,
  });
  writeDb(db);
  res.json(publicUser(user));
}));

// Sets isAdmin/isCaptain in one call - replaces the old single-value `role`
// toggle now that an account can be both, either or neither.
app.post('/api/admin/users/:id/permissions', requireAdmin, asyncRoute((req, res) => {
  const { isAdmin, isCaptain, isLeagueManager } = req.body;
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
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
  // Revoking League Manager also strips their access to every league they
  // were assigned to, rather than leaving orphaned entries in
  // league.managerUserIds that a re-grant would silently reactivate.
  if (isLeagueManager !== undefined && !!isLeagueManager !== user.isLeagueManager) {
    user.isLeagueManager = !!isLeagueManager;
    changes.push(user.isLeagueManager ? 'granted League Manager' : 'revoked League Manager');
    if (!user.isLeagueManager) {
      for (const league of db.leagues) {
        if (Array.isArray(league.managerUserIds) && league.managerUserIds.includes(user.id)) {
          league.managerUserIds = league.managerUserIds.filter((id) => id !== user.id);
        }
      }
    }
  }
  if (changes.length > 0) {
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'user.permissions',
      targetType: 'user',
      targetId: user.id,
      details: `${user.firstName} ${user.lastName}: ${changes.join(', ')}`,
    });
  }
  writeDb(db);
  res.json(publicUser(user));
}));

app.post('/api/admin/users/:id/status', requireAdmin, asyncRoute((req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  user.status = status;
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'user.status',
    targetType: 'user',
    targetId: user.id,
    details: `Set status of ${user.firstName} ${user.lastName} to ${status}`,
  });
  writeDb(db);
  res.json(publicUser(user));
}));

app.post('/api/admin/users/:id/reset-password', requireAdmin, asyncRoute((req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(400, 'New password must be at least 8 characters');
  }
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  user.passwordHash = hashPassword(newPassword);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'user.reset_password',
    targetType: 'user',
    targetId: user.id,
    details: `Force-reset password for ${user.firstName} ${user.lastName}`,
  });
  writeDb(db);
  res.json({ ok: true });
}));

// Generates a one-time password-reset link for a user and hands it straight
// back to the admin (no SMTP/email-sending is wired up in this self-hosted
// v1 - see the README roadmap), rather than silently setting a new password
// the way "Force Password Reset" above does. The admin is expected to relay
// the link to the player themselves (text, email, WhatsApp, whatever) - the
// link is also logged server-side as a fallback if it gets lost before it's
// sent on. Tokens are single-use and expire after 1 hour; visiting the link
// takes the player to POST /api/auth/reset-password/:token, which is public
// since a lost-password player isn't logged in to prove who they are any
// other way.
app.post('/api/admin/users/:id/send-reset-link', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) throw new ApiError(404, 'User not found');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
  db.passwordResets.push({
    id: uuid(),
    userId: user.id,
    token,
    createdAt: new Date().toISOString(),
    expiresAt,
    usedAt: null,
  });

  const origin = `${req.protocol}://${req.get('host')}`;
  const resetLink = `${origin}/reset-password?token=${token}`;

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'user.send_reset_link',
    targetType: 'user',
    targetId: user.id,
    details: `Generated a password reset link for ${user.firstName} ${user.lastName} (${user.email})`,
  });
  writeDb(db);

  // Stand-in for actually emailing the link - see README "Password reset
  // links" for why. Printed here so it's recoverable from server logs even
  // if the admin closes the tab before copying it.
  console.log(`[password reset] ${user.email}: ${resetLink}`);

  res.json({ resetLink, expiresAt, email: user.email });
}));

// Whether a user account has ever actually been used anywhere in the data -
// added to a division roster, put on a team/pairing, played in a fixture
// (singles or as a leg player on a team fixture), captured in Roll of
// Honour, or assigned as a league manager. An account that's clean on every
// one of these can be hard-deleted with nothing left dangling; one that
// isn't can't, since removing it would leave fixtures/results/roll of
// honour entries pointing at a player id that no longer resolves to
// anyone - the account should be suspended (see POST .../status) instead.
function userInUse(db, userId) {
  if (db.divisions.some((d) => d.playerIds.includes(userId))) return true;
  if (db.teams.some((t) => t.playerIds.includes(userId))) return true;
  if (db.pairings.some((p) => p.playerIds.includes(userId))) return true;
  if (db.fixtures.some((f) => {
    if (f.homePlayerId === userId || f.awayPlayerId === userId) return true;
    if (Array.isArray(f.legs) && f.legs.some((leg) => leg.homePlayerId === userId || leg.awayPlayerId === userId)) return true;
    return false;
  })) return true;
  if (db.rollOfHonour.some((r) => r.championId === userId)) return true;
  if (db.leagues.some((l) => Array.isArray(l.managerUserIds) && l.managerUserIds.includes(userId))) return true;
  return false;
}

// Bulk-deletes user accounts straight from Manage Users' tick-box selection.
// Each requested id is checked independently with userInUse above - accounts
// with any league/match history are skipped (reported back so the admin
// knows why) rather than silently ignored or force-deleted, since force-
// deleting one would leave a fixture, team roster, or Roll of Honour entry
// referencing a player id that no longer exists. Genuinely unused accounts
// (created by mistake, a duplicate, or someone who registered but was never
// added to anything) are removed outright - this is the one place a user
// account can be permanently deleted rather than just suspended.
app.post('/api/admin/users/bulk-delete', requireAdmin, asyncRoute((req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new ApiError(400, 'userIds must be a non-empty array');
  }
  const db = readDb();
  const deleted = [];
  const blocked = [];

  for (const userId of userIds) {
    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      blocked.push({ id: userId, name: 'Unknown', reason: 'Account not found (already deleted?)' });
      continue;
    }
    if (userInUse(db, userId)) {
      blocked.push({
        id: userId,
        name: `${user.firstName} ${user.lastName}`,
        reason: 'Has league/match history - suspend the account instead of deleting it',
      });
      continue;
    }
    deleted.push({ id: userId, name: `${user.firstName} ${user.lastName}`, email: user.email });
  }

  if (deleted.length > 0) {
    const deletedIds = new Set(deleted.map((d) => d.id));
    db.users = db.users.filter((u) => !deletedIds.has(u.id));
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'user.bulk_delete',
      targetType: 'user',
      targetId: deleted.map((d) => d.id).join(','),
      details: `Deleted ${deleted.length} account(s): ${deleted.map((d) => `${d.name} (${d.email})`).join(', ')}`,
    });
    writeDb(db);
  }

  res.json({ deleted, blocked });
}));

// Bulk-imports user accounts straight from Manage Users, independent of any
// season or division - each row becomes a full account (generated temporary
// password handed back once, same as the Season Setup Wizard's import) with
// no roster assignment; add people to a specific division/team afterwards
// from that division's own roster page. A row whose email already matches
// an existing account is skipped (reported back, not treated as an error)
// rather than silently overwriting that account. Shares createUserAccount
// with the wizard's per-season import
// (POST /api/admin/seasons/:leagueId/import-players) - this is just a second
// entry point into the same account-creation logic for when there's no
// season context, e.g. onboarding a batch of players before deciding which
// league they'll go in.
app.post('/api/admin/users/import', requireAdmin, asyncRoute((req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');

  const db = readDb();
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
      const isLeagueManagerFlag = row.isLeagueManager === true || String(row.isLeagueManager).trim().toLowerCase() === 'true' || String(row.isLeagueManager).trim() === '1';

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

      // NQT quick-add box (single-row imports from AdminUsers.jsx) passes an
      // explicit password instead of relying on a generated temp one - bulk
      // CSV/Excel imports never set this, so they keep the original
      // generate-and-show-once behaviour untouched.
      const explicitPassword = typeof row.password === 'string' ? row.password : '';
      if (explicitPassword && explicitPassword.length < 8) {
        throw new Error('password must be at least 8 characters');
      }
      const tempPassword = explicitPassword ? null : generateTempPassword();
      const user = createUserAccount(db, {
        firstName, lastName, email, passwordHash: hashPassword(explicitPassword || tempPassword),
        phone: (row.phone || '').trim(), teamName, classification,
        isAdmin: isAdminFlag, isCaptain, isLeagueManager: isLeagueManagerFlag,
      });
      created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, tempPassword });
    } catch (err) {
      errors.push({ row: rowNum, reason: err.message });
    }
  });

  if (created.length > 0) {
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'user.bulk_import',
      targetType: 'user',
      targetId: null,
      details: `Bulk-imported ${created.length} user account(s) from Manage Users`,
    });
  }

  writeDb(db);
  // Note: a 400 here used to fire whenever every row failed validation (e.g.
  // all 14 rows missing a required column) - even though the request itself
  // was well-formed. That tripped the client's generic error handler, which
  // throws "Request failed: 400" and swallows the detailed per-row reasons
  // in `errors`/`skipped`, leaving the admin with a useless message. A
  // structurally invalid request (no rows array) is already rejected above;
  // per-row failures are a normal, successful response, not an error.
  res.status(created.length > 0 ? 201 : 200).json({ created, skipped, errors });
}));

app.get('/api/admin/audit-log', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const entries = [...db.auditLog].reverse().slice(0, 200);
  res.json(entries);
}));

// ---------- Admin: season setup wizard ----------
// Backs the 5-step "New Season" wizard in the admin portal:
//   1. name the season            -> POST /api/admin/seasons
//   2. how many leagues/players   -> (same call - leagueCount/playersPerLeague)
//   3. CSV/Excel or manual add    -> POST /api/admin/seasons/:leagueId/import-players
//   4. start/end date             -> (passed straight into step 5's call)
//   5. generate fixtures + gaps   -> POST /api/admin/seasons/:leagueId/generate
//
// A "season" isn't a new top-level entity - it reuses League (the season)
// and Division (each of the N "leagues" within it) so it gets standings,
// fixtures and scoring for free from the existing engine. CSV/Excel parsing
// itself happens client-side (see client/src/pages/AdminSeasonWizard.jsx);
// the server just receives plain row objects either way.

app.post('/api/admin/seasons', requireAdmin, asyncRoute((req, res) => {
  const { name, leagueCount, playersPerLeague, payment } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Season name is required');
  const count = Number(leagueCount);
  const perLeague = Number(playersPerLeague);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new ApiError(400, 'Number of leagues must be a whole number between 1 and 50');
  }
  if (!Number.isInteger(perLeague) || perLeague < 2 || perLeague > 200) {
    throw new ApiError(400, 'Players per league must be a whole number between 2 and 200');
  }

  const db = readDb();
  const league = {
    id: uuid(),
    name: name.trim(),
    sport: 'English 8-Ball Pool',
    // Match format now lives on each division (see POST /api/leagues/:leagueId/divisions) -
    // the wizard just gives every division it creates the default race to 6 below.
    format: { scheduling: 'round_robin_single' },
    startDate: null,
    endDate: null,
    createdAt: new Date().toISOString(),
    // Payment wall - see normalizePaymentConfig/assertPaymentCleared above.
    payment: normalizePaymentConfig(payment),
  };
  db.leagues.push(league);

  const divisions = [];
  for (let i = 0; i < count; i++) {
    const division = {
      id: uuid(),
      leagueId: league.id,
      name: `League ${i + 1}`,
      order: i,
      entryType: 'singles',
      scheduling: 'round_robin_single',
      raceTo: 6,
      playerIds: [],
      teamIds: [],
      legsPerMatch: null,
      gapDays: null,
      targetPlayerCount: perLeague,
      fixturesGenerated: false,
    };
    db.divisions.push(division);
    divisions.push(division);
  }

  writeDb(db);
  res.status(201).json({ ...league, divisions });
}));

// Bulk-imports players into one season's divisions - used both for a real
// CSV/Excel upload (client parses the file, posts an array of row objects)
// and for the wizard's "add a player manually" step (posts a single-row
// array). Each row creates a brand-new account (with a generated temporary
// password handed back to the admin) unless the email already matches an
// existing account, in which case that person is just added to the
// requested division instead of being duplicated.
//
// Deliberately NOT hard-gated by assertPaymentCleared like the other four
// entrant-adding routes: a brand-new player has no leaguePayments record at
// all yet (there's nothing to have confirmed before their account exists),
// so a hard block here would make it impossible to bulk-import a fresh
// roster into a paid season in one step - the entire point of this wizard
// stage. Instead, anyone imported into a paid league who doesn't already
// have a confirmed/waived record gets an 'unpaid' one created for them (so
// they show up on the league's Payments tab) and is returned in
// `pendingPayment` below, rather than being silently skipped or blocking
// the whole import.
app.post('/api/admin/seasons/:leagueId/import-players', requireAnyAdmin, asyncRoute((req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');

  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.leagueId);
  if (!league) throw new ApiError(404, 'Season not found');
  assertLeagueAccess(req, league);
  const divisions = db.divisions.filter((d) => d.leagueId === league.id);
  const divisionByName = new Map(divisions.map((d) => [d.name.trim().toLowerCase(), d]));

  const created = [];
  const linkedExisting = [];
  const errors = [];
  const pendingPayment = [];

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
      let tempPassword = null;

      if (!user) {
        tempPassword = generateTempPassword();
        user = createUserAccount(db, {
          firstName, lastName, email, passwordHash: hashPassword(tempPassword),
          phone: (row.phone || '').trim(), teamName, classification, isCaptain,
        });
        created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, division: division.name, tempPassword });
      } else {
        if (isCaptain && !user.isCaptain) user.isCaptain = true;
        linkedExisting.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email, division: division.name });
      }

      if (!division.playerIds.includes(user.playerId)) {
        division.playerIds.push(user.playerId);
      }

      if (league.payment.required) {
        const existingPayment = db.leaguePayments.find(
          (p) => p.leagueId === league.id && p.playerId === user.playerId
        );
        if (existingPayment && ['confirmed', 'waived'].includes(existingPayment.status)) {
          // already cleared from an earlier season/import - nothing to do.
        } else if (!existingPayment) {
          db.leaguePayments.push({
            id: uuid(),
            leagueId: league.id,
            playerId: user.playerId,
            status: 'unpaid',
            amount: league.payment.amount,
            currency: league.payment.currency,
            confirmedBy: null,
            confirmedAt: null,
            notes: '',
          });
          pendingPayment.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email: user.email, division: division.name });
        } else {
          pendingPayment.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email: user.email, division: division.name });
        }
      }
    } catch (err) {
      errors.push({ row: rowNum, reason: err.message });
    }
  });

  writeDb(db);
  // Same fix as the standalone bulk-user import above: don't return 400 just
  // because every row failed validation (e.g. a division name that doesn't
  // match this season, or a missing column) - that's a normal response with
  // zero successes, not a malformed request, and a 400 here makes the client
  // throw a generic "Request failed: 400" instead of showing the real
  // per-row reasons in `errors`.
  res.status(created.length + linkedExisting.length > 0 ? 201 : 200).json({ created, linkedExisting, errors, pendingPayment });
}));

// Generates round-robin fixtures for every division in the season that has
// at least 2 players and hasn't been generated yet, spacing rounds
// `gapDays` apart starting at `startDate`. Also stamps the season's
// start/end dates onto the League record itself.
app.post('/api/admin/seasons/:leagueId/generate', requireAnyAdmin, asyncRoute((req, res) => {
  const { startDate, endDate, gapDays, visibleByDefault } = req.body;
  if (!startDate) throw new ApiError(400, 'startDate is required');
  if (!endDate) throw new ApiError(400, 'endDate is required');
  if (!Number.isInteger(Number(gapDays)) || Number(gapDays) < 1) {
    throw new ApiError(400, 'gapDays must be a positive whole number of days between rounds');
  }
  if (new Date(endDate) < new Date(startDate)) {
    throw new ApiError(400, 'endDate cannot be before startDate');
  }

  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.leagueId);
  if (!league) throw new ApiError(404, 'Season not found');
  assertLeagueAccess(req, league);
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
    generateRoundRobinFixtures({ db, league, division, entrantIds: division.playerIds });
    division.gapDays = Number(gapDays);
    assignScheduledDates(db, division, startDate, gapDays);
    if (visibleByDefault) markAllRoundsVisible(db, division);
    division.fixturesGenerated = true;

    const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
    const lastRound = Math.max(...divisionFixtures.map((f) => f.round));
    const lastRoundDate = divisionFixtures.find((f) => f.round === lastRound)?.scheduledDate;
    generated.push({
      division: division.name,
      players: division.playerIds.length,
      rounds: lastRound,
      lastGameDate: lastRoundDate,
      fitsWithinEndDate: !lastRoundDate || lastRoundDate <= endDate,
    });
  }

  writeDb(db);
  res.status(201).json({ league: { id: league.id, name: league.name, startDate, endDate }, generated, skipped });
}));

// ---------- Roll of Honour ----------
// Every entry is recorded automatically by recordChampionIfDivisionComplete
// (see hydrateDivision above) the moment a division's last fixture
// completes - there's no manual "mark as finished" step, and nothing here
// writes to db.rollOfHonour directly.

app.get('/api/roll-of-honour', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const sorted = [...db.rollOfHonour].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
  );
  res.json(sorted);
}));

// ---------- Tours / Series ----------
// A tour is just an admin-curated list of existing divisions (all sharing
// one entryType, enforced below) - the group stage/knockout divisions
// themselves are completely unaware they belong to one. See
// services/tours.js for how the aggregate ranking table is built from their
// standings.

app.get('/api/tours', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  res.json(db.tours);
}));

app.post('/api/tours', requireAdmin, asyncRoute((req, res) => {
  const { name, entryType = 'singles' } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Tour name is required');
  if (!['singles', 'teams', 'doubles'].includes(entryType)) {
    throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
  }
  const db = readDb();
  const tour = {
    id: uuid(),
    name: name.trim(),
    entryType,
    divisionIds: [],
    createdAt: new Date().toISOString(),
  };
  db.tours.push(tour);
  writeDb(db);
  res.status(201).json(tour);
}));

app.get('/api/tours/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');

  const divisions = db.divisions.filter((d) => tour.divisionIds.includes(d.id));
  const hydratedDivisions = divisions.map((d) => hydrateDivision(db, d));
  const standings = computeTourStandings(tour, hydratedDivisions);

  res.json({
    ...tour,
    divisions: hydratedDivisions.map((d) => ({
      id: d.id,
      name: d.name,
      leagueId: d.leagueId,
      leagueName: d.leagueName,
      fixturesGenerated: d.fixturesGenerated,
    })),
    standings,
  });
}));

app.delete('/api/tours/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const index = db.tours.findIndex((t) => t.id === req.params.id);
  if (index === -1) throw new ApiError(404, 'Tour not found');
  db.tours.splice(index, 1);
  writeDb(db);
  res.status(204).end();
}));

app.post('/api/tours/:id/divisions', requireAdmin, asyncRoute((req, res) => {
  const { divisionId } = req.body;
  if (!divisionId) throw new ApiError(400, 'divisionId is required');
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');
  const division = db.divisions.find((d) => d.id === divisionId);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== tour.entryType) {
    throw new ApiError(
      400,
      `This tour only accepts ${tour.entryType} divisions - "${division.name}" is a ${division.entryType} division`
    );
  }
  if (!tour.divisionIds.includes(divisionId)) {
    tour.divisionIds.push(divisionId);
  }
  writeDb(db);
  res.status(201).json(tour);
}));

app.delete('/api/tours/:id/divisions/:divisionId', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');
  tour.divisionIds = tour.divisionIds.filter((id) => id !== req.params.divisionId);
  writeDb(db);
  res.json(tour);
}));

// ---------- API Keys (StreamDeck / integrations) ----------
// See userAuth.js's generateApiKeyValue/hashApiKey/loadApiKeyUser for how a
// key authenticates - once generated, a key behaves exactly like an admin
// session on every existing route (frame scoring, timer/shot-clock,
// overrides, and so on), so a StreamDeck button can be wired straight to
// any of those endpoints with the key as its bearer token. The raw key is
// only ever shown once, in the response to the POST below.

app.get('/api/api-keys', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  res.json(db.apiKeys.map(({ hash, ...rest }) => rest));
}));

app.post('/api/api-keys', requireAdmin, asyncRoute((req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) throw new ApiError(400, 'A label is required, e.g. "StreamDeck - Table 1"');
  const db = readDb();
  const rawKey = generateApiKeyValue();
  const apiKey = {
    id: uuid(),
    label: label.trim(),
    hash: hashApiKey(rawKey),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  db.apiKeys.push(apiKey);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'apiKey.create',
    targetType: 'apiKey',
    targetId: apiKey.id,
    details: `Created API key "${apiKey.label}"`,
  });
  writeDb(db);
  const { hash, ...publicKey } = apiKey;
  res.status(201).json({ ...publicKey, key: rawKey });
}));

app.delete('/api/api-keys/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const index = db.apiKeys.findIndex((k) => k.id === req.params.id);
  if (index === -1) throw new ApiError(404, 'API key not found');
  const [removed] = db.apiKeys.splice(index, 1);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'apiKey.revoke',
    targetType: 'apiKey',
    targetId: removed.id,
    details: `Revoked API key "${removed.label}"`,
  });
  writeDb(db);
  res.status(204).end();
}));

// ---------- Backup, restore & wipe ----------
// Overall-Admin-only (never League Manager - this touches every league at
// once, not just one a manager is scoped to). Meant to be run immediately
// before a risky upgrade/migration: export first, apply the upgrade, and if
// anything goes wrong either restore the exported file or wipe back to a
// clean slate. Nothing here is scoped by league, so it stays on
// requireAdmin directly rather than requireAnyAdmin + assertLeagueAccess.

// Downloads the entire db.json as a single file. db.js's readDb() already
// backfills any collection/field an older export predates, so re-uploading
// this file later (even after future schema changes) restores cleanly - see
// POST /api/admin/restore below.
app.get('/api/admin/backup', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'backup.export',
    targetType: 'system',
    targetId: 'db',
    details: `Exported a full data backup (${db.leagues.length} league(s), ${db.users.length} user(s), ${db.fixtures.length} fixture(s))`,
  });
  writeDb(db);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="cuesense-backup-${stamp}.json"`);
  res.send(JSON.stringify(db, null, 2));
}));

// Replaces everything currently in the system with the contents of a
// previously exported backup file - irreversible, and expected to be used
// right after a failed/problematic upgrade to put things back exactly as
// they were beforehand. Only sanity-checks the two most fundamental
// collections (leagues/users are arrays) rather than every field - anything
// more specific that's missing or stale gets backfilled by readDb() via
// restoreDb() below, the same way opening an old db.json would.
app.post('/api/admin/restore', requireAdmin, asyncRoute((req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ApiError(400, "That file doesn't look like a Cue Sense backup - expected a JSON object.");
  }
  if (!Array.isArray(incoming.leagues) || !Array.isArray(incoming.users)) {
    throw new ApiError(400, "That file doesn't look like a Cue Sense backup - missing leagues/users.");
  }

  const before = readDb();
  restoreDb(incoming);
  const restored = readDb(); // forces a fresh disk read + migration/backfill pass, thanks to restoreDb() dropping the cache

  recordAudit(restored, {
    actor: req.adminSession.label,
    action: 'backup.restore',
    targetType: 'system',
    targetId: 'db',
    details: `Restored from an uploaded backup, replacing ${before.leagues.length} league(s)/${before.users.length} user(s) with ${restored.leagues.length} league(s)/${restored.users.length} user(s)`,
  });
  writeDb(restored);

  res.json({
    restored: true,
    leagues: restored.leagues.length,
    users: restored.users.length,
    fixtures: restored.fixtures.length,
  });
}));

// Deletes everything, back to a completely empty system - for when there's
// no export worth restoring and the goal is a genuinely clean slate (e.g.
// clearing out test data before real use). This necessarily also deletes
// the acting admin's own account, which would otherwise lock every admin
// out with no way back in short of a redeploy - so ensureBootstrapAccounts()
// (see below, normally only run once at server startup) is re-run
// immediately after, since a wipe is functionally a fresh deploy from the
// app's point of view. That guarantees the same admin@cuesense.co.uk
// recovery account a brand-new deployment gets, rather than a bespoke
// one-off account invented just for this route.
app.post('/api/admin/wipe', requireAdmin, asyncRoute((req, res) => {
  const before = readDb();
  resetDb();
  ensureBootstrapAccounts();
  const after = readDb();

  recordAudit(after, {
    actor: req.adminSession.label,
    action: 'backup.wipe',
    targetType: 'system',
    targetId: 'db',
    details: `Wiped all data - removed ${before.leagues.length} league(s), ${before.users.length} user(s), ${before.fixtures.length} fixture(s). Recreated the standard bootstrap admin account.`,
  });
  writeDb(after);

  res.json({ wiped: true, bootstrapAdminEmail: 'admin@cuesense.co.uk' });
}));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---------- Serve the built React client, if present ----------
// (`npm run build` in /client produces /client/dist; when present we serve
// it here so the whole app runs from a single `npm start` on one port. In
// local development, run the Vite dev server separately instead - see
// README - so you get hot reload.)
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ---------- Error handling ----------

app.use((err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ---------- Bootstrap accounts ----------
// Ensures two known accounts exist every time the server boots (a fresh
// deploy, a restart, a new environment) - idempotent, so once both exist
// this is just a couple of cheap reads on every subsequent boot. A temp
// password is only ever set at creation time - if an account already
// exists, whatever password is on it (including one the owner has since
// changed via the normal change-password flow) is left untouched, so a
// redeploy can never silently reset a real password back to the default.
//
// admin@cuesense.co.uk is the one account guaranteed to always be an
// admin - the break-glass login if every other admin account is ever
// suspended or demoted by mistake. This is enforced every boot (granted
// back if it's ever found not-admin), the same way the old bootstrap
// account used to be.
//
// matt.bailey1985@gmail.com is a normal default player account and is
// explicitly NOT an admin - enforced the other way every boot, so it can
// never end up admin again by accident (an old backup, a manual mistake).
// It's still guaranteed to exist, just as a player only.
function ensureBootstrapAccounts() {
  const db = readDb();
  let changed = false;

  const adminEmail = 'admin@cuesense.co.uk';
  const normalizedAdminEmail = adminEmail.toLowerCase();
  let admin = db.users.find((u) => u.email.toLowerCase() === normalizedAdminEmail);
  if (admin) {
    if (!admin.isAdmin) {
      admin.isAdmin = true;
      changed = true;
      console.log(`Bootstrap: granted admin to existing account ${adminEmail}`);
    }
  } else {
    admin = createUserAccount(db, {
      firstName: 'Admin',
      lastName: 'Cue Sense',
      email: adminEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: true,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created admin account ${adminEmail}`);
  }

  const playerEmail = 'matt.bailey1985@gmail.com';
  const normalizedPlayerEmail = playerEmail.toLowerCase();
  let player = db.users.find((u) => u.email.toLowerCase() === normalizedPlayerEmail);
  if (player) {
    if (player.isAdmin) {
      player.isAdmin = false;
      changed = true;
      console.log(`Bootstrap: removed admin from ${playerEmail} - player only now`);
    }
  } else {
    player = createUserAccount(db, {
      firstName: 'Matt',
      lastName: 'Bailey',
      email: playerEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: false,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created player account ${playerEmail}`);
  }

  if (changed) writeDb(db);
}
ensureBootstrapAccounts();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Cue Sense API listening on http://localhost:${PORT}`);
});
