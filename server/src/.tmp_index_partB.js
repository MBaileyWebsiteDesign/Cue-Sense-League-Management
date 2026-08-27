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
