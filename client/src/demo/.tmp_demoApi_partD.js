    const awayPlayer = fixture.awayPlayerId ? db.players.find((p) => p.id === fixture.awayPlayerId) : null;
    return { ...fixture, divisionName, homePlayer, awayPlayer, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) };
  }),

  // Ported from server/src/index.js's GET /api/overlay/fixtures/:id (see the
  // design notes there) - normalizes singles/teams/doubles into the same
  // { home, away } shape for the OBS-facing stream overlay page. There's no
  // real auth boundary in demo mode to begin with, so this is really just
  // "the same data, reshaped" rather than a public-vs-private distinction.
  getOverlayFixture: op((id) => {
    const fixture = db.fixtures.find((f) => f.id === id);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    return buildOverlayFixture(fixture);
  }),

  // Ported from server/src/index.js's GET /api/overlay/leagues/:id/arena -
  // a public read-only board of today's table schedule plus recent results,
  // reusing buildOverlayFixture for each fixture so the shapes stay
  // consistent with the OBS overlay above.
  getArena: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const today = new Date().toISOString().slice(0, 10);
    const leagueFixtures = db.fixtures.filter((f) => f.leagueId === league.id);

    const withOverlay = (fixture) => {
      const division = db.divisions.find((d) => d.id === fixture.divisionId);
      if (!division) return null;
      return {
        ...buildOverlayFixture(fixture),
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

    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      tables,
      unscheduled,
      recentResults,
    };
  }),

  // Public League Table / League Fixtures (embeddable pages) - mirrors
  // server/src/index.js's GET /api/public/leagues/:id/table and
  // GET /api/public/leagues/:id/fixtures.
  getPublicLeagueTable: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions
      .filter((d) => d.leagueId === league.id)
      .sort((a, b) => a.order - b.order)
      .map((division) => {
        const hydrated = hydrateDivision(division);
        return {
          divisionId: division.id,
          divisionName: division.name,
          entryType: division.entryType,
          scheduling: division.scheduling,
          status: division.status || 'active',
          standings: hydrated.standings,
        };
      });
    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      divisions,
    };
  }),

  getPublicLeagueFixtures: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisionsById = new Map(db.divisions.filter((d) => d.leagueId === league.id).map((d) => [d.id, d]));

    const buildPublicFixture = (fixture) => {
      const division = divisionsById.get(fixture.divisionId);
      if (!division) return null;
      return {
        ...buildOverlayFixture(fixture),
        divisionId: division.id,
        round: fixture.round,
        scheduledDate: fixture.scheduledDate,
        scheduledTime: fixture.scheduledTime,
      };
    };

    const fixtures = db.fixtures
      .filter((f) => f.leagueId === league.id)
      .filter((f) => isRoundVisible(divisionsById.get(f.divisionId), f.round))
      .map(buildPublicFixture)
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

    return {
      leagueId: league.id,
      leagueName: league.name,
      generatedAt: new Date().toISOString(),
      fixtures,
    };
  }),

  // Public Division Table / Division Fixtures (embeddable pages) - mirrors
  // server/src/index.js's GET /api/public/divisions/:id/table and
  // GET /api/public/divisions/:id/fixtures.
  getPublicDivisionTable: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);
    const hydrated = hydrateDivision(division);
    return {
      divisionId: division.id,
      divisionName: division.name,
      leagueId: division.leagueId,
      leagueName: league ? league.name : null,
      entryType: division.entryType,
      scheduling: division.scheduling,
      status: division.status || 'active',
      generatedAt: new Date().toISOString(),
      standings: hydrated.standings,
    };
  }),

  getPublicDivisionFixtures: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);

    const buildPublicFixture = (fixture) => ({
      ...buildOverlayFixture(fixture),
      divisionId: division.id,
      round: fixture.round,
      scheduledDate: fixture.scheduledDate,
      scheduledTime: fixture.scheduledTime,
    });

    const fixtures = db.fixtures
      .filter((f) => f.divisionId === division.id)
      .filter((f) => isRoundVisible(division, f.round))
      .map(buildPublicFixture)
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

    return {
      divisionId: division.id,
      divisionName: division.name,
      leagueId: division.leagueId,
      leagueName: league ? league.name : null,
      generatedAt: new Date().toISOString(),
      fixtures,
    };
  }),

  // Public Division Bracket (embeddable page) - mirrors server/src/index.js's
  // GET /api/public/divisions/:id/bracket, including double-elimination
  // support (see that file's comment for the full reasoning).
  getPublicDivisionBracket: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const isDoubleElim = division.scheduling === 'knockout_double_elim' || division.scheduling === 'knockout_double_elim_ally';
    if (division.scheduling !== 'knockout_single_elim' && !isDoubleElim) {
      throw new ApiError(400, 'This endpoint only supports single- or double-elimination knockout divisions');
    }
    const league = db.leagues.find((l) => l.id === division.leagueId);
    const hydrated = hydrateDivision(division);

    const buildPublicBracketMatch = (fixture) => {
      const overlay = buildOverlayFixture(fixture);
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
    };

    const buildPublicDoubleElimMatch = (fixture) => ({
      ...buildPublicBracketMatch(fixture),
      bracketRole: fixture.bracketRole,
      nextFixtureId: fixture.nextFixtureId || null,
      loserNextFixtureId: fixture.loserNextFixtureId || null,
      resetFixtureId: fixture.resetFixtureId || null,
    });

    const visibleFixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
    const matches = isDoubleElim
      ? visibleFixtures.map(buildPublicDoubleElimMatch)
      : visibleFixtures.map(buildPublicBracketMatch);

    return {
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
    };
  }),

  recordFrame: op((fixtureId, winnerPlayerId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (division.entryType === 'teams') throw new ApiError(400, 'This is a team fixture - record frames against a specific leg instead');
    if (!fixture.homePlayerId || !fixture.awayPlayerId) throw new ApiError(400, 'Both players for this fixture are not yet known - waiting on an earlier round');
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
    // No auto-complete - see the server's matching route for why (reaching
    // the race target just unlocks "Submit for Confirmation").
    return fixture;
  }),

  undoLastFrame: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const undoDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(undoDivision, fixture.round)) {
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
    return fixture;
  }),

  // ---- Result confirmation (singles/doubles) - mirrors server/src/index.js's
  // submit-result / confirm-result / dispute-result / reopen routes. ----
  submitResult: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
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
    fixture.resultSubmittedBy = currentUser()?.id || null;
    return fixture;
  }),

  confirmResult: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can confirm this result');
    }
    if (user?.isAdmin) {
      fixture.homeConfirmed = true;
      fixture.awayConfirmed = true;
    } else {
      if (isHome) fixture.homeConfirmed = true;
      if (isAway) fixture.awayConfirmed = true;
    }
    if (fixture.homeConfirmed && fixture.awayConfirmed) {
      fixture.status = 'completed';
      propagateWinner(division, fixture, fixture.winnerPlayerId);
      const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
      propagateLoser(division, fixture, loserPlayerId);
      checkGrandFinalReset(division, fixture);
    }
    return fixture;
  }),

  disputeResult: op((fixtureId, reason) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (fixture.status !== 'pending_confirmation') throw new ApiError(400, 'This result is not awaiting confirmation');
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can dispute this result');
    }
    if (!reason || !reason.trim()) throw new ApiError(400, 'A reason is required when disputing a result');
    fixture.status = 'disputed';
    fixture.winnerPlayerId = null;
    fixture.disputeReason = reason.trim();
    return fixture;
  }),

  adminReopenFixture: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
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
      actor: adminLabel(), action: 'fixture.reopen', targetType: 'fixture', targetId: fixture.id,
      details: 'Reopened a pending/disputed result for further scoring',
    });
    return fixture;
  }),

  // ---- Non-contactable / No-Show claims - mirrors server/src/index.js's
  // POST .../no-show and POST .../no-show/authorize (see that file for the
  // full design note). ----
  claimNoShow: op((fixtureId, legNumber) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    const claimantName = user ? `${user.firstName} ${user.lastName}` : 'A player';

    if (legNumber !== undefined && legNumber !== null) {
      const { leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
      if (!['scheduled', 'in_progress'].includes(leg.status)) {
        throw new ApiError(400, 'Only a leg with both players nominated, that has not yet been submitted, can be reported as a no-show');
      }
      const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
      const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
      if (!user?.isAdmin && !isHome && !isAway) {
        throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can report a no-show');
      }
      const winnerPlayerId = isHome ? leg.homePlayerId : leg.awayPlayerId;
      leg.status = 'disputed';
      leg.winnerPlayerId = null;
      leg.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
      leg.noShowClaim = {
        claimedBy: user?.id,
        claimedByName: claimantName,
        claimedSide: isHome ? 'home' : 'away',
        winnerPlayerId,
        at: new Date().toISOString(),
      };
      recomputeTeamFixture(division, fixture);
      return fixture;
    }

    if (division.entryType === 'teams') {
      throw new ApiError(400, 'This is a team fixture - report a no-show against the specific leg');
    }
    if (!['scheduled', 'in_progress'].includes(fixture.status)) {
      throw new ApiError(400, 'Only a match that has not yet been submitted can be reported as a no-show');
    }
    const isHome = isHomeEntrant(division, fixture, user?.playerId);
    const isAway = isAwayEntrant(division, fixture, user?.playerId);
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a player in this fixture (or an admin) can report a no-show');
    }
    const winnerPlayerId = isHome ? fixture.homePlayerId : fixture.awayPlayerId;
    fixture.status = 'disputed';
    fixture.winnerPlayerId = null;
    fixture.disputeReason = `${claimantName} reported the opponent as non-contactable / a no-show, and is claiming a 0-0 walkover win.`;
    fixture.noShowClaim = {
      claimedBy: user?.id,
      claimedByName: claimantName,
      claimedSide: isHome ? 'home' : 'away',
      winnerPlayerId,
      at: new Date().toISOString(),
    };
    return fixture;
  }),

  authorizeNoShow: op((fixtureId, legNumber) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);

    if (legNumber !== undefined && legNumber !== null) {
      const { leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
      if (!leg.noShowClaim) throw new ApiError(400, 'This leg has no no-show claim to authorise');
      leg.homeFrameScore = 0;
      leg.awayFrameScore = 0;
      leg.frames = [];
      leg.winnerPlayerId = leg.noShowClaim.winnerPlayerId;
      leg.status = 'completed';
      leg.disputeReason = null;
      recomputeTeamFixture(division, fixture);
      recordAudit(db, {
        actor: adminLabel(), action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
        details: `Authorised a non-contactable/no-show 0-0 walkover win for ${leg.noShowClaim.claimedByName} on Leg ${leg.legNumber}`,
      });
      return fixture;
    }

    if (!fixture.noShowClaim) throw new ApiError(400, 'This fixture has no no-show claim to authorise');
    fixture.homeFrameScore = 0;
    fixture.awayFrameScore = 0;
    fixture.frames = [];
    fixture.winnerPlayerId = fixture.noShowClaim.winnerPlayerId;
    fixture.status = 'completed';
    fixture.disputeReason = null;
    fixture.adminOverride = { at: new Date().toISOString(), by: adminLabel() };
    propagateWinner(division, fixture, fixture.winnerPlayerId);
    const loserPlayerId = fixture.winnerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId;
    propagateLoser(division, fixture, loserPlayerId);
    checkGrandFinalReset(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.no_show_authorized', targetType: 'fixture', targetId: fixture.id,
      details: `Authorised a non-contactable/no-show 0-0 walkover win for ${fixture.noShowClaim.claimedByName}`,
    });
    return fixture;
  }),

  createTeam: op((divisionId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Team name is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'teams') throw new ApiError(400, 'This is a singles division - add players directly instead');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add teams after fixtures have been generated for this division');
    const team = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
    db.teams.push(team);
    division.teamIds.push(team.id);
    return hydrateDivision(division);
  }),

  removeTeam: op((divisionId, teamId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove teams after fixtures have been generated for this division');
    division.teamIds = division.teamIds.filter((id) => id !== teamId);
    return hydrateDivision(division);
  }),

  addTeamPlayer: op((teamId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const team = db.teams.find((t) => t.id === teamId);
    if (!team) throw new ApiError(404, 'Team not found');
    const division = db.divisions.find((d) => d.id === team.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    assertPaymentCleared(division, player.id);
    if (!team.playerIds.includes(player.id)) team.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removeTeamPlayer: op((teamId, playerId) => {
    const team = db.teams.find((t) => t.id === teamId);
    if (!team) throw new ApiError(404, 'Team not found');
    const division = db.divisions.find((d) => d.id === team.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
    team.playerIds = team.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  nominateLeg: op((fixtureId, legNumber, homePlayerId, awayPlayerId) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const nominateDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(nominateDivision, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (!fixture.homeTeamId || !fixture.awayTeamId) throw new ApiError(400, 'Both teams for this fixture are not yet known - waiting on an earlier round');
    if (leg.status !== 'pending') throw new ApiError(400, 'This leg already has nominated players - undo its frames first to change them');
    const homeTeam = db.teams.find((t) => t.id === fixture.homeTeamId);
    const awayTeam = db.teams.find((t) => t.id === fixture.awayTeamId);
    if (!homeTeam.playerIds.includes(homePlayerId)) throw new ApiError(400, 'Home player is not registered to the home team');
    if (!awayTeam.playerIds.includes(awayPlayerId)) throw new ApiError(400, 'Away player is not registered to the away team');
    leg.homePlayerId = homePlayerId;
    leg.awayPlayerId = awayPlayerId;
    leg.status = 'scheduled';
    return fixture;
  }),

  recordLegFrame: op((fixtureId, legNumber, winnerPlayerId) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
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
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  undoLastLegFrame: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
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
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  // ---- Result confirmation (team legs) - mirrors the singles version above. ----
  submitLegResult: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const submitDivision = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!currentUser()?.isAdmin && !isRoundVisible(submitDivision, fixture.round)) {
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
    return fixture;
  }),

  confirmLegResult: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
    const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
    const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can confirm this leg');
    }
    if (user?.isAdmin) {
      leg.homeConfirmed = true;
      leg.awayConfirmed = true;
    } else {
      if (isHome) leg.homeConfirmed = true;
      if (isAway) leg.awayConfirmed = true;
    }
    if (leg.homeConfirmed && leg.awayConfirmed) {
      leg.status = 'completed';
    }
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  disputeLegResult: op((fixtureId, legNumber, reason) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const user = currentUser();
    if (!user?.isAdmin && !isRoundVisible(division, fixture.round)) {
      throw new ApiError(403, "This round hasn't been released to players yet");
    }
    if (leg.status !== 'pending_confirmation') throw new ApiError(400, "This leg's result is not awaiting confirmation");
    const isHome = !!user?.playerId && leg.homePlayerId === user.playerId;
    const isAway = !!user?.playerId && leg.awayPlayerId === user.playerId;
    if (!user?.isAdmin && !isHome && !isAway) {
      throw new ApiError(403, 'Only a nominated player in this leg (or an admin) can dispute this leg');
    }
    if (!reason || !reason.trim()) throw new ApiError(400, 'A reason is required when disputing a result');
    leg.status = 'disputed';
    leg.winnerPlayerId = null;
    leg.disputeReason = reason.trim();
    recomputeTeamFixture(division, fixture);
    return fixture;
  }),

  adminReopenLeg: op((fixtureId, legNumber) => {
    const { fixture, leg } = findTeamFixtureAndLeg(fixtureId, legNumber);
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    if (!['pending_confirmation', 'disputed'].includes(leg.status)) {
      throw new ApiError(400, 'Only a pending or disputed leg can be reopened');
    }
    leg.status = 'in_progress';
    leg.winnerPlayerId = null;
    leg.disputeReason = null;
    leg.homeConfirmed = false;
    leg.awayConfirmed = false;
    leg.noShowClaim = null;
    recomputeTeamFixture(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.leg_reopen', targetType: 'fixture', targetId: fixture.id,
      details: `Reopened Leg ${leg.legNumber} for further scoring`,
    });
    return fixture;
  }),

  getPlayerProfile: op((playerId) => {
    const profile = buildPlayerProfile(db, playerId);
    if (!profile) throw new ApiError(404, 'Player not found');
    return profile;
  }),
};
