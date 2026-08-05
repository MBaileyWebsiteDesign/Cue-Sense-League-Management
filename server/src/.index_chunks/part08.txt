 ? db.teams.find((t) => t.id === fixture.awayTeamId) : null;
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
  return {
    ...buildPublicBracketMatch(db, division, league, fixture),
    bracketRole: fixture.bracketRole,
    nextFixtureId: fixture.nextFixtureId || null,
    loserNextFixtureId: fixture.loserNextFixtureId || null,
    resetFixtureId: fixture.resetFixtureId || null,
  };
}

app.get('/api/public/divisions/:id/bracket', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const isDoubleElim = division.scheduling === 'knockout_double_elim';
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

  if (fixture.nextFixtureId && oldWinnerId && newWinnerId !== oldWinnerId) {
    const next = db.fixtures.find((f) => f.id === fixture.nextFixtureId);
    const nextHasStarted = next && (isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0);
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

  if (fixture.nextFixtureId && newWinnerId && newWinnerId !== oldWinnerId) {
    propagateWinner(db, division, fixture, newWinnerId);
  }
  if (newWinnerId && newWinnerId !== oldWinnerId) {
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
  let users = db.u