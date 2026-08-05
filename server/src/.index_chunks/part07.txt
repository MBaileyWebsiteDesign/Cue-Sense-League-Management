ions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (division.entryType === 'teams') throw new ApiError(400, 'This is a team fixture - submit each leg individually');
  if (fixture.status !== 'in_progress') throw new ApiError(400, 'Only an in-progress match can be submitted for confirmation');
  if (fixture.homeFrameScore < fixture.raceTo && fixture.awayFrameScore < fixture.raceTo) {
    throw new ApiError(400, `Neither side has reached the race target (${fixture.raceTo}) yet`);
  }

  fixture.winnerPlayerId = fixture.homeFrameScore >= fixture.raceTo ? fixture.homePlayerId : fixture.awayPlayerId;
  fixture.status = 'pending_confirmation';
  fixture.homeConfirmed = false;
  fixture.awayConfirmed = false;
  fixture.resultSubmittedAt = new Date().toISOString();
  fixture.resultSubmittedBy = req.auth.user.id;
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/confirm-result', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
  const isHome = isHomeEntrant(db, division, fixture, req.auth.user.playerId);
  const isAway = isAwayEntrant(db, division, fixture, req.auth.user.playerId);
  if (!req.auth.user.isAdmin && !isHome && !isAway) {
    throw new ApiError(403, 'Only a player in this fixture (or an admin) can confirm this result');
  }

  if (req.auth.user.isAdmin) {
    fixture.homeConfirmed = true;
    fixture.awayConfirmed = true;
  } else {
    if (isHome) fixture.homeConfirmed = true;
    if (isAway) fixture.awayConfirmed = true;
  }

  if (fixture.homeConfirmed && fixture.awayConfirmed) {
    fixture.status = 'completed';
    propagateWinner(db, division, fixture, fixture.winnerPlayerId);
    const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
    propagateLoser(db, division, fixture, loserPlayerId);
    checkGrandFinalReset(db, division, fixture);
  }
  writeDb(db);
  res.json(fixture);
}));

app.post('/api/fixtures/:id/dispute-result', requireAuth, asyncRoute((req, res) => {
  const { reason } = req.body || {};
  const db = readDb();
  const fixture = db.fixtures.find((f) => f.id === req.params.id);
  if (!fixture) throw new ApiError(404, 'Fixture not found');
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
  if (!req.auth.user.isAdmin && !isRoundVisible(division, fixture.round)) {
    throw new ApiError(403, "This round hasn't been released to players yet");
  }
  if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
  const isHome = isHomeEntrant(db, division, fixture, req.auth.user.playerId);
  const isAway = isAwayEntrant(db, division, fixture, req.auth.user.playerId);
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
    const awayTeam = fixture.awayTeamId