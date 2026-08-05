)) return true;
    if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
    if (f.legs) return f.legs.some((l) => l.homePlayerId === playerId || l.awayPlayerId === playerId);
    return false;
  });

  const enriched = fixtures.map((f) => {
    const division = db.divisions.find((d) => d.id === f.divisionId);
    const league = db.leagues.find((l) => l.id === f.leagueId);
    const isTeams = !!f.legs;
    const isDoubles = division?.entryType === 'doubles';
    const opponentId = isTeams
      ? (myTeamIds.includes(f.homeTeamId) ? f.awayTeamId : f.homeTeamId)
      : isDoubles
        ? (myPairingIds.includes(f.homePlayerId) ? f.awayPlayerId : f.homePlayerId)
        : (f.homePlayerId === playerId ? f.awayPlayerId : f.homePlayerId);
    const opponentName = isTeams
      ? db.teams.find((t) => t.id === opponentId)?.name
      : isDoubles
        ? db.pairings.find((p) => p.id === opponentId)?.name
        : db.players.find((p) => p.id === opponentId)?.name;
    return {
      id: f.id,
      leagueName: league?.name,
      divisionName: division?.name,
      round: f.round,
      status: f.status,
      scoreLabel: isTeams ? `${f.homeLegsWon}-${f.awayLegsWon} legs` : `${f.homeFrameScore}-${f.awayFrameScore} frames`,
      scheduledDate: f.scheduledDate || null,
      opponentName: opponentName || 'TBD',
    };
  });

  enriched.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '') || b.round - a.round);
  res.json(enriched);
}));

// Powers the Game Adjustments page's "Needs Attention" list - every
// pending_confirmation/disputed result across the whole app, so an admin can
// jump straight to resolving one without first knowing (and searching for)
// which player it involves. Scans both fixture-level status (singles/
// doubles) and leg-level status (team fixtures, since an individual leg can
// be disputed while the overall team match is still in_progress).
app.get('/api/admin/fixtures/needs-attention', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const NEEDS_ATTENTION = ['pending_confirmation', 'disputed'];
  const results = [];

  for (const f of db.fixtures) {
    const division = db.divisions.find((d) => d.id === f.divisionId);
    const league = db.leagues.find((l) => l.id === f.leagueId);

    if (f.legs) {
      const homeTeam = db.teams.find((t) => t.id === f.homeTeamId);
      const awayTeam = db.teams.find((t) => t.id === f.awayTeamId);
      for (const leg of f.legs) {
        if (!NEEDS_ATTENTION.includes(leg.status)) continue;
        results.push({
          fixtureId: f.id,
          legNumber: leg.legNumber,
          leagueName: league?.name,
          divisionName: division?.name,
          round: f.round,
          status: leg.status,
          label: `${homeTeam ? homeTeam.name : 'TBD'} vs ${awayTeam ? awayTeam.name : 'TBD'} — Leg ${leg.legNumber}`,
          scoreLabel: `${leg.homeFrameScore}-${leg.awayFrameScore} frames`,
          disputeReason: leg.disputeReason || null,
          noShowClaim: leg.noShowClaim || null,
        });
      }
      continue;
    }

    if (!NEEDS_ATTENTION.includes(f.status)) continue;
    const isDoubles = division?.entryType === 'doubles';
    const homeName = isDoubles
      ? db.pairings.find((p) => p.id === f.homePlayerId)?.name
      : db.players.find((p) => p.id === f.homePlayerId)?.name;
    const awayName = isDoubles
      ? db.pairings.find((p) => p.id === f.awayPlayerId)?.name
      : db.players.find((p) => p.id === f.awayPlayerId)?.name;
    results.push({
      fixtureId: f.id,
      legNumber: null,
      leagueName: league?.name,
      divisionName: division?.name,
      round: f.round,
      status: f.status,
      label: `${homeName || 'TBD'} vs ${awayName || 'TBD'}`,
      scoreLabel: `${f.homeFrameScore}-${f.awayFrameScore} frames`,
      disputeReason: f.disputeReason || null,
      noShowClaim: f.noShowClaim || null,
    });
  }

  const STATUS_ORDER = { disputed: 0, pending_confirmation: 1 };
  results.sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (a.leagueName || '').localeCompare(b.leagueName || '') ||
    a.round - b.round
  );
  res.json(results);
}));

app.post('/api/divisions/:id/players', asyncRoute((req, res) => {
  const { playerId } = req.body;
  if (!playerId) throw new ApiError(400, 'playerId is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'singles') {
    throw new ApiError(400, `This is a ${division.entryType} division - add players to a ${division.entryType === 'teams' ? 'team' : 'pairing'} instead`);
  }
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot add players after fixtures have been generated for this division');
  }

  const player = registeredPlayers(db).find((p) => p.id === playerId);
  if (!player) throw new ApiError(400, 'Only registered, active users can be added as players - pick a name from the list');
  assertPaymentCleared(db, division, player.id);
  if (!division.playerIds.includes(player.id)) {
    division.playerIds.push(player.id);
  }
  writeDb(db);
  res.status(201).json(hydrateDivision(db, division));
}));

app.delete('/api/divisions/:id/players/:playerId', asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.fixturesGenerated) {
    throw new ApiError(400, 'Cannot remove players after fixtures have been generated for this division');
  }
  division.playerIds = division.playerIds.filter((id) => id !== req.params.playerId);
  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// ---- Teams (team divisions only) ----

// Admin-only "quick add" for a walk-in who's never used CueSense before -
// a front-desk-friendly alternative to POST /api/divisions/:id/players,
// which only accepts an existing registered playerId. Takes just a name,
// creates a minimal account behind the scenes (synthetic, unguessable
// email + random password - this person never needs to log in; an admin
// can turn it into a real account later from Admin > Users if they want
// one), and adds them to the division.
//
// Unlike the ordinary add-player route, this one also works AFTER fixtures
// have been generated for a singles knockout division - see
// insertLateEntrantIntoKnockout below for exactly what that does and does
// not attempt, and insertLateEntrantIntoRoundRobin for the (much simpler)
// round-robin case. Team and doubles divisions aren't supported here yet -
// only singles.
app.post('/api/divisions/:id/quick-add-player', requireAnyAdmin, asyncRoute((req, res) => {
  const { firstName, lastName, override } = req.body || {};
  if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== 'singles') {
    throw new ApiError(400, 'Quick-add is only available for singles divisions right now');
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

  let outcome = { method: 'added' };

  if (!division.fixturesGenerated) {
    if (!division.playerIds.includes(newPlayerId)) division.playerIds.push(newPlayerId);
  } else if (division.scheduling === 'round_robin_single' || division.scheduling === 'round_robin_double') {
    outcome = insertLateEntrantIntoRoundRobin({ db, league, division, newPlayerId });
    division.playerIds.push(newPlayerId);
  } else if (division.scheduling === 'knockout_single_elim' || division.scheduling === 'knockout_double_elim') {
    outcome = insertLateEntrantIntoKnockout({ db, league, division, newPlayerId, override: !!override });
  } else {
    throw new ApiError(400, `Quick-add doesn't support the "${division.scheduling}" scheduling type yet`);
  }

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
    action: 'division.quick_add_player',
    targetType: 'division',
    targetId: division.id,
    details: `Quick-added ${user.firstName} ${user.lastName} to "${division.name}" (${outcome.method})`,
  });

  writeDb(db);
  res.status(201).json({ division: hydrateDivision(db, division), player: { id: newPlayerId, name: `${user.firstName} ${user.lastName}` }, outcome });
}));

// Round-robin late entrant: nothing here is a wired tree the way a
// knockout bracket is, so there's no structural risk - just create one new
// fixture (two, for a double round-robin's home/away legs) pairing the
// newcomer against every entrant who was already in the division, and
// leave every existing fixture completely untouched. New fixtures land in
// a fresh round number after whatever's already there, rather than being
// interleaved into existing rounds, so per-round visibility toggles (see
// POST /api/divisions/:id/rounds/:round/visibility) keep behaving
// predictably for the rounds that existed before this call.
function insertLateEntrantIntoRoundRobin({ db, league, division, newPlayerId }) {
  const makeFixture = makeSinglesFixture;
  const existingFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const maxRound = existingFixtures.reduce((max, f) => Math.max(max, f.round), 0);
  const existingPlayerIds = [...division.playerIds];
  const isDouble = division.scheduling === 'round_robin_double';

  const legOne = existingPlayerIds.map((opponentId) => {
    const fixture = makeFixture({ league, division, round: maxRound + 1 });
    fixture.homePlayerId = newPlayerId;
    fixture.awayPlayerId = opponentId;
    return fixture;
  });
  legOne.forEach((f) => db.fixtures.push(f));

  if (isDouble) {
    const legTwo = existingPlayerIds.map((opponentId) => {
      const fixture = makeFixture({ league, division, round: maxRound + 2 });
      fixture.homePlayerId = opponentId;
      fixture.awayPlayerId = newPlayerId;
      return fixture;
    });
    legTwo.forEach((f) => db.fixtures.push(f));
  }

  return { method: 'round-robin-extra-round', fixturesAdded: legOne.length * (isDouble ? 2 : 1) };
}

// Knockout late entrant. Two safe paths only - anything riskier than these
// is refused with a clear error rather than attempted:
//
// 1. Bye reclaim: a round-1 bye auto-resolves the instant fixtures are
//    generated (see resolveByeIfNeeded) - its occupant is immediately
//    marked the winner and advanced into round 2. If that round-2 fixture
//    hasn't started yet (and isn't itself another bye - a cascade more
//    than one level deep is refused, to keep the revert logic simple and
//    safe rather than chasing a chain of auto-resolved winners), the bye
//    can be "reclaimed": the newcomer fills the empty bye slot, the round-1
//    fixture becomes a real match again, and the round-2 slot that was
//    prematurely filled by the walkover is cleared back to pending -
//    exactly mirroring how that slot would look if round 1 just hadn't
//    finished yet. Nothing that's actually been played is touched.
//
// 2. Full regenerate: only if literally no fixture in the whole division
//    has started or completed - i.e. fixtures were generated but the event
//    hasn't actually begun yet. In that case every fixture is thrown away
//    and the bracket is rebuilt from scratch with the newcomer included,
//    using the exact same generator as a fresh division - safe because no
//    real result exists anywhere yet to lose.
//
// If neither applies (the bracket is genuinely underway and has no open
// bye to use), this throws rather than attempting to splice a new branch
// into an already-live bracket tree - see the quick-add-player route's
// caller for the resulting error message.
function insertLateEntrantIntoKnockout({ db, league, division, newPlayerId, override }) {
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);

  // Reserved slots (double-elim only - see DOUBLE_ELIM_RESERVED_PAIR_COUNT
  // in generateDoubleElimFixtures) are always-available capacity baked into
  // the bracket tree at generation time, checked before anything else since
  // this is the cleanest possible outcome: the newcomer takes a genuine
  // seed and plays forward through the real bracket exactly like anyone
  // else - no bye-reclaim, no full regenerate, no branch/decider needed.
  // Only a fixture where NEITHER side has been touched yet counts - the
  // moment either side is filled it's immediately resolved as a bye below
  // (see the round1Byes reclaim loop, which then handles it exactly like
  // any other bye), so there's never a lingering half-filled reserved
  // fixture to find here.
  const openReserved = fixtures.find(
    (f) => f.round === 1 && f.reserved && f.homePlayerId === null && f.awayPlayerId === null
  );
  if (openReserved) {
    openReserved.homePlayerId = newPlayerId;
    openReserved.byeSlot = 'away';
    openReserved.reserved = false;
    division.playerIds.push(newPlayerId);
    resolveByeIfNeeded(db, division, openReserved);
    return { method: 'reserved-slot', fixtureId: openReserved.id };
  }

  const round1Byes = fixtures.filter(
    (f) => f.round === 1 && f.byeSlot && f.status === 'completed' &&
      (division.scheduling !== 'knockout_double_elim' || f.bracketRole === 'winners')
  );
  for (const bye of round1Byes) {
    if (!bye.nextFixtureId) continue;
    const next = fixtures.find((f) => f.id === bye.nextFixtureId);
    // A bye whose next fixture is a late-entry decider (see
    // appendLateEntrantBranch) is a synthetic bye created by a *previous*
    // late-arrival override, not a genuine round-1 bye from the original
    // bracket - it only exists because there was nobody to pair that
    // entrant against. Reclaiming it here would silently reopen an
    // already-resolved branch match and null out the decider's homePlayerId
    // with nothing left to ever fill it back in, corrupting that decider.
    // Route this newcomer through the override branch path instead (below).
    // A genuine round-1 bye's next fixture always shares its own bracketRole
    // (winners->winners) - that's how the generator wires it (see
    // generateKnockoutFixtures/generateDoubleElimFixtures). Anything else can
    // only be a synthetic bridge fixture created by a *previous* late-arrival
    // override (appendLateEntrantBranch below tags those 'late_entry_decider'
    // for single-elimination, 'losers' for double-elimination) - reclaiming
    // one of those would reopen an already-resolved branch match and corrupt
    // whatever it feeds, so skip it and let this newcomer fall through to the
    // override branch path instead.
    if (!next || next.byeSlot || next.status !== 'scheduled' || next.bracketRole !== bye.bracketRole) continue;

    if (bye.nextFixtureSlot === 'home') next.homePlayerId = null;
    else next.awayPlayerId = null;

    if (bye.byeSlot === 'home') bye.homePlayerId = newPlayerId;
    else bye.awayPlayerId = newPlayerId;
    bye.byeSlot = null;
    bye.status = 'scheduled';
    bye.winnerPlayerId = null;

    division.playerIds.push(newPlayerId);
    return { method: 'bye-reclaim', fixtureId: bye.id };
  }

  const anyStarted = fixtures.some((f) => f.status === 'in_progress' || f.status === 'completed');
  if (!anyStarted) {
    db.fixtures = db.fixtures.filter((f) => f.divisionId !== division.id);
    division.playerIds.push(newPlayerId);
    const entrantIds = [...division.playerIds];
    if (division.scheduling === 'knockout_single_elim') {
      generateKnockoutFixtures({ db, league, division, entrantIds });
    } else {
      generateDoubleElimFixtures({ db, league, division, entrantIds });
    }
    // A full regenerate replaces every fixture with brand new ones, so the
    // round numbers this bracket now uses (and how many rounds it has) can
    // be completely different from before - e.g. adding a 9th entrant to an
    // 8-entrant double-elim bracket adds a whole extra winners round, which
    // pushes the Grand Final (and the last losers-bracket round) out to
    // round numbers that didn't exist previously. The old visibleRounds
    // array is stale the moment that happens: it was computed for the old
    // fixture set, and only coincidentally still matches the new bracket's
    // early rounds by number - anything past the old bracket's old last
    // round (most visibly the new Grand Final) silently drops out of the
    // public/embed bracket page's isRoundVisible filter, even though the
    // fixture genuinely exists. Recompute it the same way a fresh
    // "Generate Fixtures" with visibleByDefault does, so every round of
    // the regenerated bracket is visible again.
    markAllRoundsVisible(db, division);
    return { method: 'bracket-regenerated' };
  }

  // Admin override: rather than refusing outright, splice the late entrant
  // in as a brand new round-1 branch - see appendLateEntrantBranch.
  if (override) {
    return appendLateEntrantBranch({ db, league, division, newPlayerId, fixtures });
  }

  throw new ApiError(
    400,
    "This bracket has already started and has no open bye to slot a new player into right now - it can't be safely expanded without disturbing a match that's already underway. They can still be registered for next time from here, or added anyway as a new branch that plays off against the eventual champion."
  );
}

// Admin override for a knockout bracket that's already underway with no
// open bye to reclaim (see insertLateEntrantIntoKnockout above). Rather
// than refusing the late entrant outright, gives them their own new
// round-1 box - a bye, since there's nobody left to pair them against -
// and carries that bye forward into a single decider match: one life, one
// elimination, decided by exactly one result.
//
// Single-elimination has no losers bracket to speak of, so there's nothing
// fairer on offer than a decider against the tournament's eventual champion
// directly - created one round past whatever's currently the last round,
// with the current final pointed at it instead of staying terminal.
//
// Double-elimination instead drops the late entrant into the LOSERS side,
// not a shortcut straight to the title: their one decider is against
// whoever currently feeds the Grand Final's away slot - the real
// losers-bracket leader right now, whether that's the original LB Final or
// a previous late entrant's own still-unplayed decider - and is tagged
// bracketRole 'losers' so it renders as a genuine part of the Losers
// Bracket (DoubleElimBracketChart already knows how to draw any 'losers'
// fixture - see that component) rather than a bolt-on appendage. Lose it
// and they're eliminated outright, no second life, unlike everyone who
// legitimately dropped from the winners bracket with one still in hand.
// Win it, and they only take that spot: they still have to beat the
// winners-bracket champion in the real Grand Final (potentially twice, if
// a bracket-reset gets forced - see checkGrandFinalReset) to actually take
// the division, exactly like anyone who came up through the losers side.
//
// Known limitation: if the Grand Final has already been completed (the
// division's already fully decided), this refuses outright rather than
// reopening an already-confirmed result and everything that depends on it.
function appendLateEntrantBranch({ db, league, division, newPlayerId, fixtures }) {
  const isDoubleElim = division.scheduling === 'knockout_double_elim';

  const branchFixture = makeSinglesFixture({ league, division, round: 1 });
  branchFixture.bracketRole = isDoubleElim ? 'winners' : 'single';
  branchFixture.homePlayerId = newPlayerId;
  branchFixture.byeSlot = 'away';

  let decider;

  if (isDoubleElim) {
    const grandFinal = fixtures.find((f) => f.bracketRole === 'grand_final');
    if (!grandFinal) throw new ApiError(500, "This division's Grand Final fixture is missing - can't work out who a late arrival should play.");
    if (grandFinal.status === 'completed') {
      throw new ApiError(
        400,
        "This division's Grand Final has already been played - a late arrival can no longer be worked into the losers bracket this way."
      );
    }
    const lbLeader = fixtures.find((f) => f.nextFixtureId === grandFinal.id && f.nextFixtureSlot === 'away');
    if (!lbLeader) throw new ApiError(500, "Couldn't find the current losers-bracket leader - this bracket may be in an unexpected state.");

    decider = makeSinglesFixture({ league, division, round: Math.max(...fixtures.map((f) => f.round)) + 1 });
    decider.bracketRole = 'losers';
    decider.nextFixtureId = grandFinal.id;
    decider.nextFixtureSlot = 'away';

    branchFixture.nextFixtureId = decider.id;
    branchFixture.nextFixtureSlot = 'home';

    db.fixtures.push(branchFixture);
    db.fixtures.push(decider);
    division.playerIds.push(newPlayerId);

    if (lbLeader.status === 'completed') {
      // Already decided - propagateWinner won't fire again on its own, so
      // wire that winner in directly as the one this late entrant has to
      // beat. That result already advanced into Grand Final's away slot
      // when it was confirmed - reopen that slot now that it's about to be
      // challenged by the decider instead of standing unopposed.
      decider.awayPlayerId = lbLeader.winnerPlayerId;
      grandFinal.awayPlayerId = null;
    } else {
      // Still to be played - redirect it at the new decider instead of
      // Grand Final, so whichever route eventually completes it carries
      // its winner forward into the decider the normal way.
      lbLeader.nextFixtureId = decider.id;
      lbLeader.nextFixtureSlot = 'away';
    }
  } else {
    const terminalFixtures = fixtures.filter((f) => !f.nextFixtureId);
    const currentFinal = terminalFixtures.reduce(
      (latest, f) => (!latest || f.round > latest.round ? f : latest),
      null
    );

    decider = makeSinglesFixture({ league, division, round: currentFinal.round + 1 });
    decider.bracketRole = 'late_entry_decider';

    branchFixture.nextFixtureId = decider.id;
    branchFixture.nextFixtureSlot = 'home';

    db.fixtures.push(branchFixture);
    db.fixtures.push(decider);
    division.playerIds.push(newPlayerId);

    if (currentFinal.status === 'completed') {
      decider.awayPlayerId = currentFinal.winnerPlayerId;
    } else {
      currentFinal.nextFixtureId = decider.id;
      currentFinal.nextFixtureSlot = 'away';
    }
  }

  // The decider's round number is brand new (one past whatever round was
  // previously last) and was never part of division.visibleRounds, which is
  // only populated once at original fixture-generation time - without this,
  // the public/embed bracket page (GET /api/public/divisions/:id/bracket,
  // which filters fixtures through isRoundVisible) silently drops the decider
  // while still handing out branchFixture's nextFixtureId pointing at it,
  // leaving that chart with a dangling reference to a match it never receives.
  if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
  if (!division.visibleRounds.includes(decider.round)) division.visibleRounds.push(decider.round);

  // Resolves branchFixture's bye immediately (nothing to wait on) and
  // propagates the win straight into decider.homePlayerId.
  resolveByeIfNeeded(db, division, branchFixture);

  return { method: 'late-branch', fixtureId: branchFixture.id, deciderFixtureId: decider.id };
}

// ---- Teams (team divisions only) ----

app.post('/api/divisions/:id/teams', asyncRoute((req, res) => {
  const { name } = req.body