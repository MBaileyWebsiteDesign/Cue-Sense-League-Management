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
