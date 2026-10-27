// Dedicated "Top Spin + Top Spin Singles League" sign-up (Matt, 2026-10-27), used by the
// page at /registerTopSpinSingleLeague. One public endpoint:
//   POST /api/users/register-top-spin-singles  { firstName, lastName, email, password }
//
//  * New email: the account is created, joins the Top Spin venue straight away (even if the
//    venue's join policy is 'approval', same as /RegisterTopSpin and /RegisterAura), a PENDING
//    interest is registered in the Top Spin Singles League (= unpaid; a manager confirms payment
//    on the League Interests page), and the player is logged in (same response as /api/users/register).
//  * Email already has an account: the password must match (Matt's choice). If it does, Top Spin is
//    added to the account, interest in the league is registered (pending/unpaid) and the page tells
//    the player what happened. Nothing is changed and nobody is logged in. If it does NOT match,
//    nothing is changed and the page offers a password reset.
//  * League not open for registration (or not found): the venue is still added and the response says
//    interest was not registered. The league is matched by exact name, case-insensitive.
// Password guesses are rate limited in memory (resets on deploy/restart): 20 requests per IP and
// 6 wrong passwords per email in 15 minutes.
const LEAGUE_NAME = 'top spin singles league';
const WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 20;
const EMAIL_FAIL_LIMIT = 6;

export function registerTopSpinSingleLeagueRoute(app, deps) {
  const {
    asyncRoute, ApiError, readDb, writeDb, uuid, verifyPassword, hashPassword, createSessionToken,
    publicUser, createUserAccount, ensureMembership, membershipAt, pendingJoinRequest, recordAudit,
    userDisplayName, notifyCheckinStreams,
  } = deps;
  const hitsByIp = new Map();
  const failsByEmail = new Map();

  function recent(map, key) {
    const now = Date.now();
    const list = (map.get(key) || []).filter((t) => now - t < WINDOW_MS);
    map.set(key, list);
    if (map.size > 5000) {
      for (const [k, v] of map) if (!v.some((t) => now - t < WINDOW_MS)) map.delete(k);
    }
    return list;
  }

  app.post('/api/users/register-top-spin-singles', asyncRoute((req, res) => {
    const { firstName, lastName, email, password } = req.body || {};
    if (!firstName || !String(firstName).trim()) throw new ApiError(400, 'First name is required');
    if (!lastName || !String(lastName).trim()) throw new ApiError(400, 'Last name is required');
    if (!email || !String(email).trim()) throw new ApiError(400, 'Email is required');
    if (!password || String(password).length < 8) throw new ApiError(400, 'Password must be at least 8 characters');

    const ip = String(req.headers['fly-client-ip'] || req.ip || 'unknown');
    const ipHits = recent(hitsByIp, ip);
    if (ipHits.length >= IP_LIMIT) {
      throw new ApiError(429, 'Too many attempts - please wait a few minutes and try again');
    }
    ipHits.push(Date.now());

    const db = readDb();
    const normalizedEmail = String(email).trim().toLowerCase();
    const venue = db.venues.find((v) => /^\s*top\s*spin\b/i.test(v.name || ''));
    if (!venue) throw new ApiError(400, 'The Top Spin venue could not be found');
    const leagues = db.leagues.filter((l) => String(l.name || '').trim().toLowerCase() === LEAGUE_NAME);
    const league = leagues.find((l) => l.isOpenForRegistration) || leagues[0] || null;

    const existing = db.users.find((u) => String(u.email || '').toLowerCase() === normalizedEmail);
    let user;
    let created = false;
    if (existing) {
      const fails = recent(failsByEmail, normalizedEmail);
      if (fails.length >= EMAIL_FAIL_LIMIT) {
        throw new ApiError(429, 'Too many attempts - please wait a few minutes, or reset your password');
      }
      if (!verifyPassword(String(password), existing.passwordHash)) {
        fails.push(Date.now());
        return res.json({ status: 'existing_wrong_password' });
      }
      if (existing.status === 'suspended') throw new ApiError(403, 'This account has been suspended');
      user = existing;
    } else {
      user = createUserAccount(db, {
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        email: String(email).trim(),
        passwordHash: hashPassword(String(password)),
        phone: '',
        teamName: '',
        classification: null,
        isAdmin: false,
        isCaptain: false,
        venueId: null,
      });
      created = true;
    }

    // Top Spin membership (no dates until the bar sets them). Joins straight away even if the
    // venue's join policy is 'approval'; a waiting request for the same venue is closed off.
    const venueAdded = !membershipAt(user, venue.id);
    if (venueAdded) {
      ensureMembership(user, venue.id);
      recordAudit(db, {
        actor: userDisplayName(user),
        action: 'user.venueMembership',
        targetType: 'user',
        targetId: user.id,
        details: `${userDisplayName(user)} ${created ? 'chose' : 'was added to'} "${venue.name}" ${created ? 'as their venue while creating their account' : 'via /registerTopSpinSingleLeague'}`,
      });
    }
    const waiting = pendingJoinRequest(venue, user.id);
    if (waiting) {
      waiting.status = 'approved';
      waiting.decidedAt = new Date().toISOString();
      waiting.decidedBy = 'Top Spin Singles League sign-up link';
    }

    // Interest in the league: pending = unpaid. Same rules as /RegisterAura: skip when the player
    // already has an interest that was not declined.
    if (!Array.isArray(db.leagueInterests)) db.leagueInterests = [];
    let interest;
    if (!league) interest = 'league_not_found';
    else if (!league.isOpenForRegistration) interest = 'league_closed';
    else if (!user.playerId) interest = 'no_player_profile';
    else if (db.leagueInterests.some((r) => r.leagueId === league.id && r.playerId === user.playerId && r.status !== 'declined')) {
      interest = 'already_registered';
    } else {
      db.leagueInterests.push({
        id: uuid(),
        leagueId: league.id,
        playerId: user.playerId,
        userId: user.id,
        status: 'pending',
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
      });
      recordAudit(db, {
        actor: userDisplayName(user),
        action: 'league_interest.auto_register',
        targetType: 'league',
        targetId: league.id,
        details: `${userDisplayName(user)} registered interest in "${league.name}" via /registerTopSpinSingleLeague${created ? ' while creating their account' : ' (existing account)'}`,
      });
      interest = 'registered';
    }
    writeDb(db);

    const base = { venueName: venue.name, leagueName: league ? league.name : null, venueAdded, interest };
    if (created) {
      const { token, expiresAt } = createSessionToken(user.id);
      res.status(201).json({ status: 'created', token, expiresAt, user: publicUser(user), ...base });
    } else {
      res.json({ status: 'existing_updated', ...base });
    }
    if (venueAdded) notifyCheckinStreams(venue.id, { kind: 'registered', userId: user.id });
  }));
}
