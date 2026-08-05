
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
  res.json(db.leagues);
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
  res.json({ league: { i