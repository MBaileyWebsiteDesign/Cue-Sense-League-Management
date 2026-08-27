      }
      seedSummary.push({
        divisionId: sourceDivision.id,
        divisionName: sourceDivision.name,
        requested: Number(count),
        available: rankedIds.length,
        added,
      });
    }

    return { ...hydrateDivision(division), seedSummary };
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/reorder-entrants -
  // lets an admin fine-tune (or fully set) a not-yet-generated division's
  // entrant order, which is what actually controls knockout bracket seeding
  // (buildBracketRounds/buildDoubleElimBracket just pair entrants in
  // whatever array order they're given).
  reorderEntrants: op((divisionId, order) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
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
    return hydrateDivision(division);
  }),

  generateFixtures: op((divisionId, data = {}) => {
    const { startDate, gapDays, visibleByDefault } = data;
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Fixtures have already been generated for this division');
    const entrantIds = division.entryType === 'teams'
      ? division.teamIds
      : division.entryType === 'doubles'
        ? division.pairingIds
        : division.playerIds;
    const entrantLabel = division.entryType === 'teams' ? 'teams' : division.entryType === 'doubles' ? 'pairings' : 'players';
    if (entrantIds.length < 2) throw new ApiError(400, `A division needs at least 2 ${entrantLabel} before fixtures can be generated`);
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
      generateKnockoutFixtures({ league, division, entrantIds });
    } else if (division.scheduling === 'knockout_double_elim') {
      if (entrantIds.length < 4) {
        throw new ApiError(
          400,
          `Double elimination needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
        );
      }
      generateDoubleElimFixtures({ league, division, entrantIds });
    } else if (division.scheduling === 'knockout_double_elim_ally') {
      if (entrantIds.length < 4) {
        throw new ApiError(
          400,
          `Ally Knockout needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
        );
      }
      generateAllyDoubleElimFixtures({ league, division, entrantIds });
    } else {
      generateRoundRobinFixtures({ league, division, entrantIds });
    }
    if (startDate && gapDays) {
      division.gapDays = Number(gapDays);
      assignScheduledDates(division, startDate, gapDays);
    }
    if (visibleByDefault) markAllRoundsVisible(division);
    division.fixturesGenerated = true;
    return hydrateDivision(division);
  }),

  substitutePlayer: op((divisionId, outgoingPlayerId, incomingPlayerId, reason = 'substitution') => {
    if (!outgoingPlayerId || !incomingPlayerId) throw new ApiError(400, 'outgoingPlayerId and incomingPlayerId are required');
    if (outgoingPlayerId === incomingPlayerId) throw new ApiError(400, 'The replacement must be a different player from the one dropping out');
    if (!['substitution', 'retirement'].includes(reason)) throw new ApiError(400, "reason must be 'substitution' or 'retirement'");
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'singles') throw new ApiError(400, 'Player substitution is only available for singles divisions right now');
    if (!division.playerIds.includes(outgoingPlayerId)) throw new ApiError(400, 'That player is not registered in this division');
    if (division.playerIds.includes(incomingPlayerId)) throw new ApiError(400, 'That replacement is already registered in this division');
    const incoming = registeredPlayers().find((p) => p.id === incomingPlayerId);
    if (!incoming) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    assertPaymentCleared(division, incoming.id);
    const outgoing = db.players.find((p) => p.id === outgoingPlayerId);
    const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
    const swapped = [];
    const blockedInProgress = [];
    for (const fixture of divisionFixtures) {
      const isHome = fixture.homePlayerId === outgoingPlayerId;
      const isAway = fixture.awayPlayerId === outgoingPlayerId;
      if (!isHome && !isAway) continue;
      if (fixture.status === 'completed') continue;
      if (fixture.status === 'in_progress') {
        blockedInProgress.push({ fixtureId: fixture.id, round: fixture.round });
        continue;
      }
      if (isHome) fixture.homePlayerId = incomingPlayerId;
      else fixture.awayPlayerId = incomingPlayerId;
      swapped.push({ fixtureId: fixture.id, round: fixture.round });
    }
    division.playerIds.push(incomingPlayerId);
    // A 'retirement' also drops the outgoing player from the roster, so
    // their row disappears from the League Table - unlike a plain
    // 'substitution', where they stay listed with their played-so-far
    // record frozen. Either way, computeStandings only ever aggregates a
    // row from that row's own fixtures, so this never touches opponents'
    // already-completed results.
    if (reason === 'retirement') {
      division.playerIds = division.playerIds.filter((id) => id !== outgoingPlayerId);
    }
    if (!division.substitutions) division.substitutions = [];
    division.substitutions.push({
      id: uuid(), outgoingPlayerId, outgoingPlayerName: outgoing ? outgoing.name : 'Unknown player',
      incomingPlayerId, incomingPlayerName: incoming.name, reason, at: new Date().toISOString(),
      by: adminLabel(), fixturesSwapped: swapped.length,
    });
    recordAudit(db, {
      actor: adminLabel(), action: 'division.substitute_player', targetType: 'division', targetId: division.id,
      details: reason === 'retirement'
        ? `${outgoing ? outgoing.name : 'A player'} retired from "${division.name}" - removed from the League Table, ${incoming.name} took over ${swapped.length} remaining fixture(s)`
        : `Swapped ${outgoing ? outgoing.name : 'a player'} out for ${incoming.name} in "${division.name}" (${swapped.length} remaining fixture(s) reassigned)`,
    });
    return { division: hydrateDivision(division), swapped, blockedInProgress, reason };
  }),

  getFixture: op((id) => {
    const fixture = db.fixtures.find((f) => f.id === id);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const divisionName = division ? division.name : null;
    if (!currentUser()?.isAdmin && !isRoundVisible(division, fixture.round)) {
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
      return { ...fixture, divisionName, legs, homeTeam, awayTeam, bothEntrantsKnown: !!(fixture.homeTeamId && fixture.awayTeamId) };
    }
    if (division.entryType === 'doubles') {
      const withPlayers = (pairing) => (pairing ? { ...pairing, players: db.players.filter((p) => pairing.playerIds.includes(p.id)) } : null);
      const homePairing = withPlayers(db.pairings.find((p) => p.id === fixture.homePlayerId));
      const awayPairing = withPlayers(db.pairings.find((p) => p.id === fixture.awayPlayerId));
      return { ...fixture, divisionName, homePairing, awayPairing, bothEntrantsKnown: !!(fixture.homePlayerId && fixture.awayPlayerId) };
    }
    const homePlayer = fixture.homePlayerId ? db.players.find((p) => p.id === fixture.homePlayerId) : null;
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
