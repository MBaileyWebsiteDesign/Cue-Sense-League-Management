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
