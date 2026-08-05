ion`,
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
//   is odd - never just to pad up to a power of two), or "knockout_double_elim"
//   (winners bracket + losers bracket + Grand Final, with a bracket-reset
//   decider if the losers-bracket finalist wins the Grand Final - requires
//   an exact power-of-2 entrant count, see services/bracket.js). This can
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

  if (division.scheduling === 'knockout_double_elim') {
    // The winners-bracket finalist can win the Grand Final outright, or lose
    // it and force a bracke