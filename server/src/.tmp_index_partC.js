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
