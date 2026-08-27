    fixture.timer.running = false;
    fixture.timer.startedAt = null;
    return fixture;
  }),

  resetTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    fixture.timer = { startedAt: null, elapsedSeconds: 0, running: false };
    return fixture;
  }),

  startShotClock: op((fixtureId, durationSeconds) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (durationSeconds !== undefined && durationSeconds !== null) {
      if (!Number.isInteger(Number(durationSeconds)) || Number(durationSeconds) < 5) {
        throw new ApiError(400, 'durationSeconds must be a whole number of at least 5 seconds');
      }
      fixture.shotClock.durationSeconds = Number(durationSeconds);
    }
    fixture.shotClock.startedAt = new Date().toISOString();
    fixture.shotClock.running = true;
    return fixture;
  }),

  stopShotClock: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    fixture.shotClock.running = false;
    fixture.shotClock.startedAt = null;
    return fixture;
  }),

  // ---------- API Keys ----------
  // Demo mode has no real StreamDeck to call these, but mirrors the shape
  // so the Admin Portal's API Keys page works identically either way.
  getApiKeys: op(() => db.apiKeys.map(({ hash, ...rest }) => rest)),

  createApiKey: op((label) => {
    if (!label || !label.trim()) throw new ApiError(400, 'A label is required, e.g. "StreamDeck - Table 1"');
    const rawKey = `sdk_demo_${uuid().replace(/-/g, '')}`;
    const apiKey = { id: uuid(), label: label.trim(), hash: rawKey, createdAt: new Date().toISOString(), lastUsedAt: null };
    db.apiKeys.push(apiKey);
    const { hash, ...publicKey } = apiKey;
    return { ...publicKey, key: rawKey };
  }),

  deleteApiKey: op((id) => {
    const index = db.apiKeys.findIndex((k) => k.id === id);
    if (index === -1) throw new ApiError(404, 'API key not found');
    db.apiKeys.splice(index, 1);
    return { ok: true };
  }),

  // ---------- Backup & Restore ----------
  // Demo mode has no server-side db.json to export - this downloads the
  // current localStorage-backed demo dataset instead, and restore/wipe
  // operate on that same `db` the rest of the demo uses. Mirrors
  // server/src/index.js's GET/POST /api/admin/backup|restore|wipe.
  downloadBackup: op(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cuesense-demo-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  }),

  restoreBackup: op((data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ApiError(400, "That file doesn't look like a Cue Sense backup - expected a JSON object.");
    }
    if (!Array.isArray(data.leagues) || !Array.isArray(data.users)) {
      throw new ApiError(400, "That file doesn't look like a Cue Sense backup - missing leagues/users.");
    }
    db = backfillState(structuredClone(data));
    return { restored: true, leagues: db.leagues.length, users: db.users.length, fixtures: db.fixtures.length };
  }),

  // Unlike the real server (which recreates a fixed admin@cuesense.co.uk
  // recovery account), the demo has no fixed bootstrap identity to fall
  // back on - it just reports what a real wipe would say, without actually
  // being able to log the visitor back in afterwards, same as the real app
  // once their account is gone.
  wipeAllData: op(() => {
    db = structuredClone(EMPTY_DEMO_STATE);
    return { wiped: true, bootstrapAdminEmail: 'admin@cuesense.co.uk' };
  }),

  // Mirrors server/src/index.js's GET /api/leagues: a League Manager who
  // isn't also an Overall Admin only sees the league(s) they're assigned to
  // manage, same as the real server enforces.
  getLeagues: op(() => {
    const user = currentUser();
    if (user && user.isLeagueManager && !user.isAdmin) {
      return db.leagues.filter((l) => (l.managerUserIds || []).includes(user.id));
    }
    return db.leagues;
  }),

  createLeague: op((data) => {
    const { name, sport = 'English 8-Ball Pool', matchFormat = 'singles', raceTo = 6, scheduling = 'round_robin_single', payment, managerUserIds } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'League name is required');
    // Optional: assign League Manager(s) at creation - mirrors
    // server/src/index.js's POST /api/leagues, same eligibility rule
    // (must already be flagged isLeagueManager on their account).
    let assignedManagerIds = [];
    if (Array.isArray(managerUserIds) && managerUserIds.length > 0) {
      for (const userId of managerUserIds) {
        const user = db.users.find((u) => u.id === userId);
        if (user && user.isLeagueManager) assignedManagerIds.push(userId);
      }
      assignedManagerIds = [...new Set(assignedManagerIds)];
    }
    const league = {
      id: uuid(), name: name.trim(), sport, format: { matchFormat, raceTo, scheduling },
      startDate: null, endDate: null, createdAt: new Date().toISOString(),
      tables: [],
      payment: normalizePaymentConfig(payment),
      managerUserIds: assignedManagerIds,
      isOpenForRegistration: !!data.isOpenForRegistration,
    };
    db.leagues.push(league);
    if (assignedManagerIds.length > 0) {
      const names = assignedManagerIds
        .map((id) => db.users.find((u) => u.id === id))
        .filter(Boolean)
        .map((u) => `${u.firstName} ${u.lastName}`);
      recordAudit(db, {
        actor: adminLabel(), action: 'league.manager_added', targetType: 'league', targetId: league.id,
        details: `Gave ${names.join(', ')} League Manager access to "${league.name}" at creation`,
      });
    }
    return league;
  }),

  // ---------- League Manager assignment ----------
  // Mirrors server/src/index.js's POST/DELETE /api/leagues/:id/managers -
  // Overall-Admin-only in the real app (enforced by the UI, same as every
  // other admin-only demo op); a League Manager can never assign or remove
  // managers on any league, including themselves.
  addLeagueManager: op((leagueId, userId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
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
        actor: adminLabel(), action: 'league.manager_added', targetType: 'league', targetId: league.id,
        details: `Gave ${user.firstName} ${user.lastName} League Manager access to "${league.name}"`,
      });
    }
    return league;
  }),

  removeLeagueManager: op((leagueId, userId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const user = db.users.find((u) => u.id === userId);
    if (!Array.isArray(league.managerUserIds)) league.managerUserIds = [];
    const hadAccess = league.managerUserIds.includes(userId);
    league.managerUserIds = league.managerUserIds.filter((id) => id !== userId);
    if (hadAccess) {
      recordAudit(db, {
        actor: adminLabel(), action: 'league.manager_removed', targetType: 'league', targetId: league.id,
        details: `Removed ${user ? `${user.firstName} ${user.lastName}` : 'a user'}'s League Manager access to "${league.name}"`,
      });
    }
    return league;
  }),

  getLeague: op((id) => {
    const league = db.leagues.find((l) => l.id === id);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id).sort((a, b) => a.order - b.order);
    return { ...league, divisions };
  }),

  // Mirrors server/src/index.js's PATCH /api/leagues/:id.
  updateLeague: op((id, data) => {
    const league = db.leagues.find((l) => l.id === id);
    if (!league) throw new ApiError(404, 'League not found');
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new ApiError(400, 'League name is required');
      league.name = data.name.trim();
    }
    if (data.payment !== undefined) {
      league.payment = normalizePaymentConfig(data.payment);
    }
    recordAudit(db, {
      actor: adminLabel(), action: 'league.edit', targetType: 'league', targetId: league.id,
      details: `Updated settings for "${league.name}"`,
    });
    return league;
  }),

  // Mirrors server/src/index.js's POST /api/leagues/:id/payments/:playerId.
  setLeaguePaymentStatus: op((leagueId, playerId, status, notes = '') => {
    if (!['confirmed', 'waived', 'unpaid'].includes(status)) {
      throw new ApiError(400, "status must be 'confirmed', 'waived' or 'unpaid'");
    }
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const player = db.players.find((p) => p.id === playerId);
    if (!player) throw new ApiError(404, 'Player not found');
    let record = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === player.id);
    if (!record) {
      record = {
        id: uuid(), leagueId: league.id, playerId: player.id, status: 'unpaid',
        amount: league.payment.amount, currency: league.payment.currency,
        confirmedBy: null, confirmedAt: null, notes: '',
      };
      db.leaguePayments.push(record);
    }
    record.status = status;
    record.notes = notes;
    record.confirmedBy = status === 'unpaid' ? null : adminLabel();
    record.confirmedAt = status === 'unpaid' ? null : new Date().toISOString();
    recordAudit(db, {
      actor: adminLabel(), action: 'league.payment', targetType: 'league', targetId: league.id,
      details: `${player.name}: payment marked ${status} for "${league.name}"`,
    });
    return record;
  }),

  // Mirrors server/src/index.js's GET /api/leagues/:id/payments.
  getLeaguePayments: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const recordsByPlayer = new Map(
      db.leaguePayments.filter((p) => p.leagueId === league.id).map((p) => [p.playerId, p])
    );
    const players = registeredPlayers().map((player) => {
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
    return { league: { id: league.id, name: league.name, payment: league.payment }, players };
  }),

  createDivision: op((leagueId, data) => {
    const { name, order = 0, entryType = 'singles', legsPerMatch = 5, pairingSize = 2 } = data;
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const scheduling = data.scheduling || league.format.scheduling || 'round_robin_single';
    if (!name || !name.trim()) throw new ApiError(400, 'Division name is required');
    if (!['singles', 'teams', 'doubles'].includes(entryType)) {
      throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
    }
    if (!SCHEDULING_TYPES.includes(scheduling)) throw new ApiError(400, `scheduling must be one of: ${SCHEDULING_TYPES.join(', ')}`);
    if (entryType === 'teams' && (!Number.isInteger(Number(legsPerMatch)) || Number(legsPerMatch) < 1)) {
      throw new ApiError(400, 'legsPerMatch must be a positive whole number');
    }
    if (entryType === 'doubles' && ![2, 3].includes(Number(pairingSize))) {
      throw new ApiError(400, 'pairingSize must be 2 (doubles) or 3 (triples)');
    }
    const division = {
      id: uuid(), leagueId: league.id, name: name.trim(), order, entryType, scheduling,
      playerIds: [], teamIds: [], pairingIds: [],
      legsPerMatch: entryType === 'teams' ? Number(legsPerMatch) : null,
      pairingSize: entryType === 'doubles' ? Number(pairingSize) : null,
      gapDays: null, fixturesGenerated: false,
      // No round is visible to players until released - see isRoundVisible.
      visibleRounds: [],
      // 'active' | 'completed' - see closeDivisionEarly/closeLeagueEarly below
      // (mirrors server/src/index.js's close-early routes).
      status: 'active',
      completedAt: null,
      completedBy: null,
      isOpen: !!data.isOpen,
    };
    db.divisions.push(division);
    return division;
  }),

  getDivision: op((id) => {
    const division = db.divisions.find((d) => d.id === id);
    if (!division) throw new ApiError(404, 'Division not found');
    const hydrated = hydrateDivision(division);
    // Non-admins only see fixtures from released rounds - see isRoundVisible.
    if (!currentUser()?.isAdmin) {
      hydrated.fixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
    }
    return hydrated;
  }),

  // NQT open divisions browse + join requests - mirrors server/src/index.js's
  // GET /api/divisions/open, POST /api/divisions/:id/join-requests,
  // GET /api/leagues/:id/join-requests, and the approve/reject routes.
  getOpenDivisions: op(() => {
    const user = currentUser();
    const myPlayerId = user?.playerId;
    return db.divisions
      .filter((d) => d.isOpen && d.status !== 'completed' && d.entryType === 'singles')
      .map((d) => {
        const league = db.leagues.find((l) => l.id === d.leagueId);
        const alreadyIn = myPlayerId ? d.playerIds.includes(myPlayerId) : false;
        const pendingRequest = myPlayerId
          ? db.joinRequests.find((r) => r.divisionId === d.id && r.playerId === myPlayerId && r.status === 'pending')
          : null;
        return {
          divisionId: d.id,
          divisionName: d.name,
          leagueId: d.leagueId,
          leagueName: league?.name || 'Unknown league',
          playerCount: d.playerIds.length,
          fixturesGenerated: d.fixturesGenerated,
          alreadyIn,
          requestStatus: alreadyIn ? 'member' : pendingRequest ? 'pending' : null,
        };
      });
  }),

  requestToJoinDivision: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (!division.isOpen) throw new ApiError(400, 'This division is not open for join requests');
    const user = currentUser();
    const playerId = user?.playerId;
    if (!playerId) throw new ApiError(400, 'Your account has no linked player profile yet - contact an admin');
    if (division.playerIds.includes(playerId)) throw new ApiError(400, "You're already in this division");
    const existing = db.joinRequests.find((r) => r.divisionId === division.id && r.playerId === playerId && r.status === 'pending');
    if (existing) throw new ApiError(400, 'You already have a pending request for this division');
    const request = {
      id: uuid(), divisionId: division.id, playerId, userId: user.id,
      status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
    };
    db.joinRequests.push(request);
    return request;
  }),

  getLeagueJoinRequests: op((leagueId) => {
    const divisionIds = new Set(db.divisions.filter((d) => d.leagueId === leagueId).map((d) => d.id));
    return db.joinRequests
      .filter((r) => r.status === 'pending' && divisionIds.has(r.divisionId))
      .map((r) => {
        const division = db.divisions.find((d) => d.id === r.divisionId);
        const player = db.players.find((p) => p.id === r.playerId);
        return {
          id: r.id, divisionId: r.divisionId, divisionName: division?.name || 'Unknown division',
          playerId: r.playerId, playerName: player?.name || 'Unknown player', createdAt: r.createdAt,
        };
      });
  }),

  approveJoinRequest: op((requestId) => {
    const request = db.joinRequests.find((r) => r.id === requestId);
    if (!request) throw new ApiError(404, 'Join request not found');
    if (request.status !== 'pending') throw new ApiError(400, 'This request has already been decided');
    const division = db.divisions.find((d) => d.id === request.divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) {
      throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
    }
    if (!division.playerIds.includes(request.playerId)) {
      division.playerIds.push(request.playerId);
    }
    request.status = 'approved';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = adminLabel();
    return hydrateDivision(division);
  }),

  rejectJoinRequest: op((requestId) => {
    const request = db.joinRequests.find((r) => r.id === requestId);
    if (!request) throw new ApiError(404, 'Join request not found');
    if (request.status !== 'pending') throw new ApiError(400, 'This request has already been decided');
    request.status = 'rejected';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = adminLabel();
    return { rejected: true, requestId: request.id };
  }),

  setLeagueOpen: op((leagueId, isOpenForRegistration) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    league.isOpenForRegistration = !!isOpenForRegistration;
    return league;
  }),

  // League-level open/interest flow - mirrors server/src/index.js's
  // "---------- Open leagues ----------" block.
  getOpenLeagues: op(() => {
    const user = currentUser();
    const myPlayerId = user?.playerId || null;
    return db.leagues
      .filter((l) => l.isOpenForRegistration)
      .map((l) => {
        const divisionCount = db.divisions.filter((d) => d.leagueId === l.id).length;
        const alreadyRegistered = myPlayerId
          ? db.leagueInterests.some((r) => r.leagueId === l.id && r.playerId === myPlayerId && r.status !== 'declined')
          : false;
        const pendingInterest = myPlayerId
          ? db.leagueInterests.find((r) => r.leagueId === l.id && r.playerId === myPlayerId && r.status === 'pending')
          : null;
        return {
          leagueId: l.id,
          leagueName: l.name,
          sport: l.sport,
          divisionCount,
          alreadyRegistered,
          requestStatus: alreadyRegistered ? (pendingInterest ? 'pending' : 'assigned') : null,
        };
      });
  }),

  requestToJoinLeague: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    if (!league.isOpenForRegistration) throw new ApiError(400, 'This league is not open for interest registration');
    const user = currentUser();
    const playerId = user?.playerId;
    if (!playerId) throw new ApiError(400, 'Your account has no linked player profile yet - contact an admin');
    const existing = db.leagueInterests.find((r) => r.leagueId === league.id && r.playerId === playerId && r.status === 'pending');
    if (existing) throw new ApiError(400, 'You already have a pending interest registration for this league');
    const request = {
      id: uuid(), leagueId: league.id, playerId, userId: user.id,
      status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
    };
    db.leagueInterests.push(request);
    return request;
  }),

  getLeagueInterests: op((leagueId) => {
    return db.leagueInterests
      .filter((r) => r.status === 'pending' && r.leagueId === leagueId)
      .map((r) => {
        const player = db.players.find((p) => p.id === r.playerId);
        return {
          id: r.id, leagueId: r.leagueId, playerId: r.playerId,
          playerName: player?.name || 'Unknown player', createdAt: r.createdAt,
        };
      });
  }),

  declineLeagueInterest: op((requestId) => {
    const request = db.leagueInterests.find((r) => r.id === requestId);
    if (!request) throw new ApiError(404, 'League interest registration not found');
    if (request.status !== 'pending') throw new ApiError(400, 'This registration has already been decided');
    request.status = 'declined';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = adminLabel();
    return { declined: true, requestId: request.id };
  }),

  bulkAssignLeagueInterests: op((interestIds, divisionId) => {
    if (!Array.isArray(interestIds) || interestIds.length === 0) {
      throw new ApiError(400, 'interestIds must be a non-empty array');
    }
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const league = db.leagues.find((l) => l.id === division.leagueId);
    if (!league) throw new ApiError(404, 'League not found');
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
      if (!division.playerIds.includes(request.playerId)) {
        division.playerIds.push(request.playerId);
      }
      request.status = 'assigned';
      request.decidedAt = new Date().toISOString();
      request.decidedBy = adminLabel();
      results.push({ interestId, ok: true, playerId: request.playerId });
    }
    return { division: hydrateDivision(division), results };
  }),

  // Force-completes every outstanding fixture in a division at 0-0 (0 legs
  // for a team fixture), no winner, no confirmation needed - mirrors
  // server/src/index.js's closeOutstandingFixtures / POST
  // /api/divisions/:id/close-early. A null winner is a genuinely new
  // outcome for a singles/doubles fixture (normal race-to-N play can't end
  // level) - see the 'void' handling in demo/logic/standings.js and
  // demo/logic/playerProfile.js.
  closeDivisionEarly: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    closeOutstandingFixtures(division, adminLabel());
    recordAudit(db, {
      actor: adminLabel(), action: 'division.closeEarly', targetType: 'division', targetId: division.id,
      details: 'Closed the division early',
    });
    return hydrateDivision(division);
  }),

  // League-wide equivalent - applies the same treatment to every division
  // in the league. Mirrors server/src/index.js's POST
  // /api/leagues/:id/close-early.
  closeLeagueEarly: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    for (const division of divisions) {
      closeOutstandingFixtures(division, adminLabel());
    }
    recordAudit(db, {
      actor: adminLabel(), action: 'league.closeEarly', targetType: 'league', targetId: league.id,
      details: `Closed the league early across ${divisions.length} division(s)`,
    });
    return {
      leagueId: league.id,
      divisions: divisions.map((d) => hydrateDivision(d)),
    };
  }),

  // Mirrors server/src/index.js's DELETE /api/leagues/:id - permanently
  // removes a league and everything scoped to it (divisions, fixtures,
  // teams, pairings, roll-of-honour entries), and strips it out of any
  // tour's divisionIds. No undo.
  deleteLeague: op((leagueId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const divisionIds = new Set(divisions.map((d) => d.id));

    const fixturesRemoved = db.fixtures.filter((f) => f.leagueId === league.id).length;
    db.fixtures = db.fixtures.filter((f) => f.leagueId !== league.id);
    db.teams = db.teams.filter((t) => !divisionIds.has(t.divisionId));
    db.pairings = db.pairings.filter((p) => !divisionIds.has(p.divisionId));
    db.rollOfHonour = db.rollOfHonour.filter((r) => r.leagueId !== league.id);
    db.tours.forEach((tour) => {
      tour.divisionIds = tour.divisionIds.filter((id) => !divisionIds.has(id));
    });
    db.divisions = db.divisions.filter((d) => d.leagueId !== league.id);
    db.leagues = db.leagues.filter((l) => l.id !== league.id);

    recordAudit(db, {
      actor: adminLabel(), action: 'league.delete', targetType: 'league', targetId: league.id,
      details: `Deleted league "${league.name}" - ${divisions.length} division(s), ${fixturesRemoved} fixture(s)`,
    });

    return { deleted: true, leagueId: league.id, divisionsRemoved: divisions.length, fixturesRemoved };
  }),

  // Powers the admin "Manage Fixtures" page - mirrors server/src/index.js's
  // POST /api/divisions/:id/rounds/:round/visibility.
  setRoundVisibility: op((divisionId, round, visible) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const roundNum = Number(round);
    if (!Number.isInteger(roundNum)) throw new ApiError(400, 'round must be a whole number');
    const roundExists = db.fixtures.some((f) => f.divisionId === division.id && f.round === roundNum);
    if (!roundExists) throw new ApiError(404, 'No fixtures found for this round in this division');
    if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
    if (visible) {
      if (!division.visibleRounds.includes(roundNum)) division.visibleRounds.push(roundNum);
    } else {
      division.visibleRounds = division.visibleRounds.filter((r) => r !== roundNum);
    }
    recordAudit(db, {
      actor: adminLabel(), action: visible ? 'division.round_release' : 'division.round_hide',
      targetType: 'division', targetId: division.id,
      details: `Round ${roundNum} ${visible ? 'released to players' : 'hidden from players'} (${division.name})`,
    });
    return hydrateDivision(division);
  }),

  // Convenience for correcting a division where rounds ended up visible
  // before an admin was ready (e.g. legacy data saved before fixtures
  // started defaulting to hidden) - mirrors the server's POST
  // /api/divisions/:id/hide-all-rounds.
  hideAllRounds: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const hadVisibleRounds = Array.isArray(division.visibleRounds) && division.visibleRounds.length > 0;
    division.visibleRounds = [];
    if (hadVisibleRounds) {
      recordAudit(db, {
        actor: adminLabel(), action: 'division.hide_all_rounds', targetType: 'division', targetId: division.id,
        details: `Hid all rounds from players (${division.name})`,
      });
    }
    return hydrateDivision(division);
  }),

  getRegisteredPlayers: op(() => registeredPlayers()),

  addPlayer: op((divisionId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'singles') {
      throw new ApiError(400, `This is a ${division.entryType} division - add players to a ${division.entryType === 'teams' ? 'team' : 'pairing'} instead`);
    }
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    assertPaymentCleared(division, player.id);
    if (!division.playerIds.includes(player.id)) division.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removePlayer: op((divisionId, playerId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players after fixtures have been generated for this division');
    division.playerIds = division.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/quick-add-player.
  quickAddPlayer: op((divisionId, firstName, lastName) => {
    if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'singles') {
      throw new ApiError(400, 'Quick-add is only available for singles divisions right now');
    }
    const isKnockout = division.scheduling === 'knockout_single_elim' || division.scheduling === 'knockout_double_elim' || division.scheduling === 'knockout_double_elim_ally';
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

    const user = createUserAccount({
      firstName: firstName.trim(),
      lastName: lastName ? lastName.trim() : '',
      email: `walkin-${uuid()}@no-login.cuesense`,
      teamName: 'Unassigned',
    });
    const newPlayerId = user.playerId;

    if (!division.playerIds.includes(newPlayerId)) division.playerIds.push(newPlayerId);
    if (reservedFixture) {
      reservedFixture.awayPlayerId = newPlayerId;
      reservedFixture.reserved = false;
      reservedFixture.byeSlot = null;
    }

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
      actor: adminLabel(),
      action: reservedFixture ? 'division.quick_add_late_entrant' : 'division.quick_add_player',
      targetType: 'division',
      targetId: division.id,
      details: reservedFixture
        ? `Quick-added late entrant ${user.firstName} ${user.lastName} to "${division.name}" - claimed a reserved bracket slot`
        : `Quick-added ${user.firstName} ${user.lastName} to "${division.name}"`,
    });

    return {
      division: hydrateDivision(division),
      player: { id: newPlayerId, name: `${user.firstName} ${user.lastName}` },
      outcome: { method: reservedFixture ? 'reserved-slot' : 'added' },
    };
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/close-late-entry.
  closeLateEntry: op((divisionId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    const reservedFixtures = db.fixtures.filter((f) => f.divisionId === division.id && f.reserved);
    reservedFixtures.forEach((fixture) => {
      fixture.reserved = false;
      resolveByeIfNeeded(division, fixture);
    });
    recordAudit(db, {
      actor: adminLabel(),
      action: 'division.close_late_entry',
      targetType: 'division',
      targetId: division.id,
      details: `Closed late entry for "${division.name}" - released ${reservedFixtures.length} unclaimed reserved slot(s)`,
    });
    return { division: hydrateDivision(division), releasedCount: reservedFixtures.length };
  }),

  createPairing: op((divisionId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Pairing name is required');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== 'doubles') throw new ApiError(400, 'This is not a doubles/triples division');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add pairings after fixtures have been generated for this division');
    const pairing = { id: uuid(), divisionId: division.id, name: name.trim(), playerIds: [] };
    db.pairings.push(pairing);
    division.pairingIds.push(pairing.id);
    return hydrateDivision(division);
  }),

  removePairing: op((divisionId, pairingId) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove pairings after fixtures have been generated for this division');
    division.pairingIds = division.pairingIds.filter((id) => id !== pairingId);
    return hydrateDivision(division);
  }),

  addPairingPlayer: op((pairingId, playerId) => {
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const pairing = db.pairings.find((p) => p.id === pairingId);
    if (!pairing) throw new ApiError(404, 'Pairing not found');
    const division = db.divisions.find((d) => d.id === pairing.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot add players once fixtures have been generated for this division');
    if (pairing.playerIds.length >= division.pairingSize) {
      throw new ApiError(400, `This pairing already has the maximum of ${division.pairingSize} player(s)`);
    }
    const player = registeredPlayers().find((p) => p.id === playerId);
    if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
    assertPaymentCleared(division, player.id);
    if (!pairing.playerIds.includes(player.id)) pairing.playerIds.push(player.id);
    return hydrateDivision(division);
  }),

  removePairingPlayer: op((pairingId, playerId) => {
    const pairing = db.pairings.find((p) => p.id === pairingId);
    if (!pairing) throw new ApiError(404, 'Pairing not found');
    const division = db.divisions.find((d) => d.id === pairing.divisionId);
    if (division.fixturesGenerated) throw new ApiError(400, 'Cannot remove players once fixtures have been generated for this division');
    pairing.playerIds = pairing.playerIds.filter((id) => id !== playerId);
    return hydrateDivision(division);
  }),

  // Mirrors server/src/index.js's POST /api/divisions/:id/seed-from-groups -
  // see that route for the full "multi-stage competitions are just linked
  // divisions" rationale. Auto-populates a not-yet-generated division's
  // roster from the top N finishers of one or more other divisions'
  // standings.
  seedFromGroups: op((divisionId, sources) => {
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
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
      const { divisionId: sourceDivisionId, count } = source || {};
      if (!sourceDivisionId || !Number.isInteger(Number(count)) || Number(count) < 1) {
        throw new ApiError(400, 'Each source needs a divisionId and a positive whole-number count');
      }
      const sourceDivision = db.divisions.find((d) => d.id === sourceDivisionId);
      if (!sourceDivision) throw new ApiError(404, `Source division ${sourceDivisionId} not found`);
      if (sourceDivision.id === division.id) throw new ApiError(400, 'A division cannot be seeded from itself');
      if (sourceDivision.entryType !== division.entryType) {
        throw new ApiError(
          400,
          `Source division "${sourceDivision.name}" is a ${sourceDivision.entryType} division - can't seed a ${division.entryType} division from it`
        );
      }

      const hydratedSource = hydrateDivision(sourceDivision);
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
