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
