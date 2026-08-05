es = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
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
  // Resolve any winners-bracket round-1 byes now that every fixture (and
  // its next-round link) exists - mirrors generateKnockoutFixtures. This is
  // a no-op today (double elimination requires an even entrant count, so
  // round 1 itself never has a bye), but kept for defensive parity with the
  // single-elimination generator and in case that constraint ever loosens.
  // Every later-round bye (winners or losers bracket) cascade-resolves
  // automatically via propagateWinner/propagateLoser as earlier fixtures
  // complete.
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

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
  const division = db.divis