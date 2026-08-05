;
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
    // Double-elimination winners-bracket round 1 only: true for one of the
    // always-added reserved slots (see buildDoubleElimBracket's
    // reservedPairCount) until a real entrant takes it over - see
    // generateDoubleElimFixtures and insertLateEntrantIntoKnockout.
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
// the winner into the next round straight away.
function resolveByeIfNeeded(db, division, fixture) {
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

function propagateWinner(db, division, fixture, winnerId) {
  if (!fixture.nextFixtureId) return;
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
  const bracketRounds = buildBracketRounds(entrantIds); // rounds[0] has real entrants (nulls = byes); later rounds are just counts

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
  // needs one code path regardless of which round a bye falls in).
  bracketRounds[0].forEach(([a, b], i) => {
    const fixture = fixturesByRound[0][i];
    if (b === null) fixture.byeSlot = 'away';
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = b;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = b;
    }
  });

  const allFixtures = fixturesByRound.flat();
  allFixtures.forEach((f) => db.fixtures.push(f));
  // Resolve any byes now that every fixture (and its next-round link) exists.
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
// Always reserved on top of the real entrants - 2 pairs (4 slots total),
// baked into the bracket tree itself at generation time so a late arrival
// or day-of walk-in substitution can take a genuine seed and play forward
// through the real bracket, no override/decider/regenerate needed. See
// buildDoubleElimBracket's reservedPairCount and insertLateEntrantIntoKnockout.
const DOUBLE_ELIM_RESERVED_PAIR_COUNT = 2;

function generateDoubleElimFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, {
    reservedPairCount: DOUBLE_ELIM_RESERVED_PAIR_COUNT,
  });

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
  winnersRounds[0].forEach(([a, b], i) => {
    const fixture = wbByRound[0][i];
    if (a === RESERVED_SLOT && b === RESERVED_SLOT) {
      // Neither side is a real entrant yet - nothing to play by default, so
      // this box starts already resolved with no result. Left completely
      // untouched (still both null) it's permanently inert; the moment a
      // real entrant takes one side over (see insertLateEntrantIntoKnockout)
      // it's reopened and resolved as a genuine bye for them, exactly like
      // any other round-1 bye.
      fixture.reserved = true;
      fixture.status = 'completed';
      return;
    }
    if (b === null) fixture.byeSlot = 'away';
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = b;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = b;
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
    const wbSourceFixtur