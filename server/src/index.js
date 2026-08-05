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
  const result = divisions.map((d) => {
    const league = db.leagues.find((l) => l.id === d.leagueId);
    return { leagueName: league?.name || 'Unknown league', divisionName: d.name };
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
