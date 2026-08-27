  const grandFinal = makeFixture({ league, division, round: wbByRound.length + lbByRound.length + 1 });
  grandFinal.bracketRole = 'grand_final';
  wbFinal.nextFixtureId = grandFinal.id;
  wbFinal.nextFixtureSlot = 'home';
  lbFinal.nextFixtureId = grandFinal.id;
  lbFinal.nextFixtureSlot = 'away';

  const allFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allFixtures.forEach((f) => db.fixtures.push(f));
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// Read-only structural summary of the PCDEK bracket "template" for a given
// player count (1-50), computed on demand from buildDoubleElimBracket
// rather than looked up from any hand-authored per-count table - see the
// big comment above generatePCDEKFixtures for why there's no such table.
// Used by GET /api/game-formats/pcdek/:playerCount so the client can show
// "what the bracket for N players looks like" (round counts, bye count,
// estimated games) before any division/entrants exist, without pretending
// each count has its own independently-validated design. playerCount === 1
// and 2 are handled as explicit special cases (see section 22 of the brief
// this format was built from) rather than forced through
// buildDoubleElimBracket, which requires 4+ entrants: 1 player is already
// champion with zero matches; 2 players need exactly one match, with no
// meaningful losers-bracket game to invent just to look like a "real" DE
// bracket; 3 players is the smallest count buildDoubleElimBracket doesn't
// support either, so it gets the same minimum-real-games treatment by hand
// (2 winners-bracket rounds feeding a 1-box losers bracket).
function pcdekTemplateSummary(playerCount) {
  const n = Math.max(1, Math.min(50, Math.round(Number(playerCount) || 0)));
  const templateId = `PCDEK-${String(n).padStart(2, '0')}`;
  const base = {
    templateId,
    formatId: 'knockout_double_elim_pcdek',
    formatName: 'Pre Configured Double Elimination Knockout',
    playerCount: n,
    rematchPolicy: 'GRAND_FINAL_ONLY_PREFERRED',
  };
  if (n === 1) {
    return { ...base, winnersBracketRounds: 0, losersBracketRounds: 0, estimatedGames: 0, note: 'A single player is champion immediately - no matches required.' };
  }
  if (n === 2) {
    return { ...base, winnersBracketRounds: 1, losersBracketRounds: 0, estimatedGames: 1, note: 'One match decides the champion outright - no losers-bracket game is meaningful with only 2 players.' };
  }
  if (n === 3) {
    return {
      ...base,
      winnersBracketRounds: 2,
      losersBracketRounds: 1,
      estimatedGames: 4,
      note: 'Smallest count with a genuine winners/losers-bracket split; below buildDoubleElimBracket\'s 4-entrant minimum so this shape is fixed by hand.',
    };
  }
  const reservedCount = reservedByeCountFor(n);
  const entrantIds = Array.from({ length: n }, (_, i) => `SEED-${String(i + 1).padStart(2, '0')}`);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });
  const byeCount =
    winnersRounds.reduce((sum, round) => sum + round.filter(([, b]) => b === null || b === RESERVED_SLOT).length, 0) +
    losersRounds.filter((r) => r.hasBye).length;
  return {
    ...base,
    winnersBracketRounds: winnersRounds.length,
    losersBracketRounds: losersRounds.length,
    byeCount,
    estimatedGames: 2 * n - 2,
    note: 'Bracket shape (rounds/bye placement) is deterministically derived from player count, not independently hand-authored - see generatePCDEKFixtures\'s doc comment.',
  };
}

// ---- Late entry: unlock the roster and rebuild the bracket ----
//
// Alternative to the reserved-bye-slot approach above (currently switched
// off - see MAX_RESERVED_BYE_COUNT) for a double-elimination knockout
// division: rather than pre-committing speculative empty slots at
// generation time, add the late entrant(s) to the roster for real and
// rebuild exactly as much of the bracket as their arrival actually changes.
// Usable up through the point where round 1 of the winners bracket has
// results on it but nothing past round 1 does (see
// isDivisionBracketReadyForLateEntrantRebuild) - round 1's *composition*
// (who plays whom) never changes for a box that's kept as-is, so any result
// already recorded there is safe to keep and simply replay forward onto the
// freshly rebuilt round 2+/losers-bracket tree (see the replay step at the
// end of this route). Round 2 onward has no such guarantee - which players
// even reach round 2 depends on round-1 boxes a late entrant can reshape -
// so the moment anything past round 1 has a real result, this refuses:
// there'd be no way to regenerate that part of the bracket without a real
// chance of silently discarding it.
//
// Round 1 is handled by hand (never by re-running buildDoubleElimBracket)
// because that function picks its round-1 bye at random on every call when
// the entrant count is odd - calling it again here could reassign the bye
// to a completely different, already-paired entrant instead of the one
// player actually left over. Reconciliation instead: keep every existing
// round-1 real match exactly as it is (result and all); if a round-1 bye
// currently exists, its holder plus the arriving player(s) form a "pending
// pool" (bye-holder first, then new arrivals in the order they're added);
// pair the pool off two at a time, reusing the existing bye fixture's row
// for the first pair so it converts from an automatic walkover into a real
// match without changing its identity; append any further pairs (and, if
// the pool is odd, one final single-occupant bye box) as brand new round-1
// fixtures. That new-fixtures-appended-after-the-existing-ones ordering is
// the "branch at the bottom" - everything before it is untouched.
//
// Everything from round 2 onward - the rest of the winners bracket, the
// entire losers bracket, and the Grand Final - depends on the *exact*
// number of losers each winners round produces, which a late entrant can
// change in ways that ripple much further than round 1 (see the project
// notes this was modelled against). None of that is allowed to have a real
// result on it yet, so rather than trying to patch it in place, it's
// archived wholesale and rebuilt fresh from the finished round-1 shape,
// reusing the same linking logic generateDoubleElimFixtures uses - and then
// any round-1 results are replayed onto it.
function isDivisionBracketReadyForLateEntrantRebuild(db, division) {
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  if (fixtures.length === 0) return false;
  // A fixture can legitimately already be `completed` here if it's a
  // structural bye (byeSlot set - one side was never populated) - that
  // resolves itself automatically the moment fixtures are generated or
  // reconciled (see resolveByeIfNeeded), and that's exactly the structural
  // state this route exists to unwind, not a real result.
  //
  // Round 1 of the winners bracket is allowed to already carry real
  // results - see the replay step at the end of the late-entrants route
  // below, which re-runs propagateWinner/propagateLoser for every decided
  // round-1 match against the freshly rebuilt round 2+/losers-bracket tree,
  // exactly as if an admin had just clicked "select winner" on each one
  // again. That's safe because a *kept* round-1 box's composition (who
  // plays whom) never changes when the entrant count grows - only what its
  // winner goes on to face next does, and the rebuild below regenerates
  // that next step from scratch anyway.
  //
  // Nothing past round 1 gets the same treatment. Round 2 onward is
  // archived and rebuilt wholesale (see rebuildDoubleElimFromRound1), and
  // *which* players even reach round 2 depends on round-1 boxes whose
  // composition a late entrant can change - so a round 2+ pairing that
  // already produced a real result has no guarantee of recurring in the
  // reshaped bracket. Once anything past round 1 has a recorded winner,
  // this still has to refuse - that's what makes archiving and rebuilding
  // everything past round 1 provably lossless. resetFixtureId can only
  // ever be set after a real Grand Final result (always well past round 1),
  // so its presence is an extra tripwire in case this is ever called
  // somewhere the other checks wouldn't catch.
  return fixtures.every((f) => {
    if (f.byeSlot) return true;
    if (f.round === 1 && f.bracketRole === 'winners') return true;
    return f.frames.length === 0 && f.winnerPlayerId == null && f.status !== 'completed' && !f.resetFixtureId;
  });
}

// Builds winners-bracket rounds 2+, the whole losers bracket, and the Grand
// Final from a already-finished round-1 fixture list, exactly mirroring the
// linking logic in generateDoubleElimFixtures's second half - see that
// function's comments for what each step is doing; this is the same thing,
// just driven from a caller-supplied round 1 instead of building one from
// entrantIds. `wbRound1Fixtures` fixtures are used as-is (not recreated);
// everything this function creates is pushed onto db.fixtures directly.
function rebuildDoubleElimFromRound1({ db, league, division, wbRound1Fixtures }) {
  const makeFixture = makeSinglesFixture; // late-entrant rebuild is singles-only for now (see the route below)
  const reservedCount = reservedByeCountFor(division.playerIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(division.playerIds, { reservedCount });

  if (winnersRounds[0].length !== wbRound1Fixtures.length) {
    // Defensive only - the route below constructs wbRound1Fixtures so its
    // length always matches ceil(newEntrantCount / 2), which is exactly
    // what buildDoubleElimBracket computes for round 1 too.
    throw new ApiError(500, 'Internal error: reconciled round 1 does not match the expected bracket shape for this entrant count');
  }

  // ---- Winners bracket rounds 2+ ----
  const wbByRound = [wbRound1Fixtures];
  for (let r = 1; r < winnersRounds.length; r++) {
    wbByRound.push(
      winnersRounds[r].map(() => {
        const f = makeFixture({ league, division, round: r + 1 });
        f.bracketRole = 'winners';
        return f;
      })
    );
  }
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

  // ---- Losers bracket ----
  const lbByRound = losersRounds.map((round, roundIndex) =>
    Array.from({ length: round.boxCount }, () => {
      const f = makeFixture({ league, division, round: wbByRound.length + roundIndex + 1 });
      f.bracketRole = 'losers';
      return f;
    })
  );
  losersRounds.forEach((round, i) => {
    if (round.hasBye) lbByRound[i][lbByRound[i].length - 1].byeSlot = 'away';
  });
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    current.forEach((fixture, i) => {
      if (nextIsMergeRound) {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      } else {
        const target = next[Math.floor(i / 2)];
        fixture.nextFixtureId = target.id;
        fixture.nextFixtureSlot = i % 2 === 0 ? 'home' : 'away';
      }
    });
  }
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    wbSourceFixtures.forEach((fixture, i) => {
      let dest, slot;
      if (lbRoundIndex === 0) {
        dest = lbDestFixtures[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'home' : 'away';
      } else if (i < lbRound.crossMatches) {
        dest = lbDestFixtures[i];
        slot = 'away';
      } else {
        const j = i - lbRound.crossMatches;
        dest = lbDestFixtures[lbRound.crossMatches + Math.floor(j / 2)];
        slot = j % 2 === 0 ? 'home' : 'away';
      }
      fixture.loserNextFixtureId = dest.id;
      fixture.loserNextFixtureSlot = slot;
    });
  });

  // ---- Grand Final ----
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
  const grandFinal = makeFixture({ league, division, round: wbByRound.length + lbByRound.length + 1 });
  grandFinal.bracketRole = 'grand_final';
  wbFinal.nextFixtureId = grandFinal.id;
  wbFinal.nextFixtureSlot = 'home';
  lbFinal.nextFixtureId = grandFinal.id;
  lbFinal.nextFixtureSlot = 'away';

  const newFixtures = [...wbByRound.slice(1).flat(), ...lbByRound.flat(), grandFinal];
  newFixtures.forEach((f) => db.fixtures.push(f));
}

// Admin-only: adds one or more registered players to an already-generated
// double-elimination singles division and rebuilds the bracket around them,
// in place of turning them away or relying on a reserved slot. Only allowed
// while isDivisionBracketReadyForLateEntrantRebuild holds - see that
// function and the design note above rebuildDoubleElimFromRound1 for why.
// Every fixture this replaces is archived (db.archivedFixtures), never
// deleted outright.
app.post('/api/divisions/:id/late-entrants', requireAnyAdmin, asyncRoute((req, res) => {
  const { playerIds } = req.body || {};
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    throw new ApiError(400, 'playerIds (a non-empty array) is required');
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new ApiError(400, 'The same player was listed more than once');
  }

  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  if (division.scheduling !== 'knockout_double_elim') {
    // Ally Knockout (knockout_double_elim_ally), Testing Double Elimination
    // (knockout_double_elim_test) and Pre Configured Double Elimination
    // Knockout (knockout_double_elim_pcdek) deliberately aren't supported
    // here yet - the rebuild below (rebuildDoubleElimFromRound1) is written
    // directly against this format's own bracket-shape assumptions;
    // extending it to the others too is a real follow-up task, not
    // something safe to silently alias.
    throw new ApiError(400, 'Adding a late entrant and rebuilding the bracket is currently only available for double-elimination knockout divisions (not yet supported for Ally Knockout, Testing Double Elimination, or Pre Configured Double Elimination Knockout)');
  }
  if (division.entryType !== 'singles') {
    throw new ApiError(400, 'Adding a late entrant and rebuilding the bracket is currently only available for singles divisions');
  }
  if (!division.fixturesGenerated) {
    throw new ApiError(400, 'Generate fixtures for this division first');
  }
  if (!isDivisionBracketReadyForLateEntrantRebuild(db, division)) {
    throw new ApiError(
      400,
      'This can only rebuild the bracket while round 1 is the furthest point any result has reached - once round 2 or the losers bracket has a recorded result, the bracket shape beyond round 1 can no longer be safely regenerated. Use Quick Add / a reserved slot instead, if one is open.'
    );
  }

  const newPlayers = playerIds.map((id) => {
    const player = registeredPlayers(db).find((p) => p.id === id);
    if (!player) throw new ApiError(400, `Player ${id} is not a registered, active user`);
    if (division.playerIds.includes(id)) throw new ApiError(400, `${player.name} is already in this division`);
    assertPaymentCleared(db, division, id);
    return player;
  });

  newPlayers.forEach((p) => division.playerIds.push(p.id));

  // ---- Reconcile round 1 (see the design note above) ----
  const existingR1 = db.fixtures.filter((f) => f.divisionId === division.id && f.round === 1 && f.bracketRole === 'winners');
  if (existingR1.some((f) => f.reserved)) {
    throw new ApiError(400, 'This division has an open reserved slot - close late entry (or have it claimed) before using this instead');
  }
  const byeBox = existingR1.find((f) => f.byeSlot === 'away') || null;
  if (byeBox && byeBox.frames.length > 0) {
    // Shouldn't be reachable in normal use (a walkover never gets scored),
    // but if it somehow happened, recycling this box below would silently
    // throw those frames away - refuse instead of guessing.
    throw new ApiError(500, 'Internal error: this division\'s round-1 bye box has frames recorded on it, which should never happen - contact support before retrying');
  }
  const realBoxesInOrder = existingR1.filter((f) => f !== byeBox);

  const pendingPool = [...(byeBox ? [byeBox.homePlayerId] : []), ...newPlayers.map((p) => p.id)];
  const wbRound1Fixtures = [...realBoxesInOrder];
  let i = 0;
  if (byeBox) {
    // byeBox was auto-resolved as a walkover the moment it was created (see
    // resolveByeIfNeeded) - status 'completed', a winner already recorded,
    // and that win already propagated forward. All of that is about to be
    // undone: it's becoming a genuine, unplayed two-sided match, so it has
    // to go back to looking like one - otherwise it reads as "already
    // played" and nothing (this route's own propagation below, or anyone
    // just browsing the bracket) will know to treat it as live again.
    byeBox.awayPlayerId = pendingPool[1];
    byeBox.byeSlot = null;
    byeBox.status = 'scheduled';
    byeBox.winnerPlayerId = null;
    byeBox.frames = [];
    byeBox.homeFrameScore = 0;
    byeBox.awayFrameScore = 0;
    wbRound1Fixtures.push(byeBox);
    i = 2;
  }
  for (; i < pendingPool.length; i += 2) {
    const f = makeSinglesFixture({ league, division, round: 1 });
    f.bracketRole = 'winners';
    f.homePlayerId = pendingPool[i];
    if (pendingPool[i + 1] !== undefined) {
      f.awayPlayerId = pendingPool[i + 1];
    } else {
      f.byeSlot = 'away';
    }
    db.fixtures.push(f);
    wbRound1Fixtures.push(f);
  }

  // ---- Archive everything downstream of round 1, then rebuild it fresh ----
  const keepIds = new Set(wbRound1Fixtures.map((f) => f.id));
  const toArchive = db.fixtures.filter((f) => f.divisionId === division.id && !keepIds.has(f.id));
  const archivedReason = `Bracket rebuilt to add late entrant(s): ${newPlayers.map((p) => p.name).join(', ')}`;
  toArchive.forEach((f) => {
    db.archivedFixtures.push({ ...f, archivedAt: new Date().toISOString(), archivedReason });
  });
  const archiveIds = new Set(toArchive.map((f) => f.id));
  db.fixtures = db.fixtures.filter((f) => !archiveIds.has(f.id));

  rebuildDoubleElimFromRound1({ db, league, division, wbRound1Fixtures });

  // Resolve any round-1 bye now that its downstream chain exists again -
  // mirrors the equivalent step at the end of generateDoubleElimFixtures.
  wbRound1Fixtures.filter((f) => f.byeSlot === 'away').forEach((f) => resolveByeIfNeeded(db, division, f));

  // ---- Replay any already-decided round-1 results onto the rebuilt tree ----
  // realBoxesInOrder are the round-1 boxes that existed before this request
  // and were kept exactly as they were (see the design note above) - any of
  // them may already be completed with a real winner (recorded via score
  // entry, or via the "select winner directly" admin override). Their
  // composition hasn't changed, but rebuildDoubleElimFromRound1 just gave
  // them a brand new, blank downstream to feed into - so push each result
  // forward again, exactly as if an admin had just clicked "select winner"
  // on it a second time against the new tree. propagateWinner/
  // propagateLoser handle everything from here, including cascading through
  // any newly-created structural byes further down (see resolveByeIfNeeded
  // calls inside them).
  const decidedRound1Boxes = realBoxesInOrder.filter((f) => f.status === 'completed' && f.winnerPlayerId);
  decidedRound1Boxes.forEach((f) => {
    const loserId = f.winnerPlayerId === f.homePlayerId ? f.awayPlayerId : f.homePlayerId;
    propagateWinner(db, division, f, f.winnerPlayerId);
    propagateLoser(db, division, f, loserId);
  });

  if (league && league.payment && league.payment.required) {
    newPlayers.forEach((p) => {
      const existing = db.leaguePayments.find((pay) => pay.leagueId === league.id && pay.playerId === p.id);
      if (!existing) {
        db.leaguePayments.push({
          id: uuid(),
          leagueId: league.id,
          playerId: p.id,
          status: 'unpaid',
          amount: league.payment.amount,
          currency: league.payment.currency,
          confirmedBy: null,
          confirmedAt: null,
          notes: '',
        });
      }
    });
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.add_late_entrants_rebuild_bracket',
    targetType: 'division',
    targetId: division.id,
    details: `${archivedReason} in "${division.name}" - archived ${toArchive.length} fixture(s), rebuilt the bracket around ${division.playerIds.length} total entrants, and replayed ${decidedRound1Boxes.length} already-decided round-1 result(s) onto it`,
  });

  writeDb(db);
  res.status(201).json({
    division: hydrateDivision(db, division),
    archivedFixtureCount: toArchive.length,
    replayedResultCount: decidedRound1Boxes.length,
    addedPlayers: newPlayers.map((p) => ({ id: p.id, name: p.name })),
  });
}));

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
  } else if (division.scheduling === 'knockout_double_elim_ally') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Ally Knockout needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateAllyDoubleElimFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim_test') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Double elimination needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateTestingDoubleElimFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === 'knockout_double_elim_pcdek') {
    if (entrantIds.length < 4) {
      throw new ApiError(
        400,
        `Pre Configured Double Elimination Knockout needs at least 4 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generatePCDEKFixtures({ db, league, division, entrantIds });
  } else if (division.scheduling === ADEK) {
    if (entrantIds.length < 2) {
      throw new ApiError(
        400,
        `Adaptive Double Elimination Knockout needs at least 2 ${entrantLabel} - you have ${entrantIds.length}.`
      );
    }
    generateAdaptiveDoubleElimFixtures({ db, league, division, entrantIds });
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
  const division = db.divisions.find((d) => d.id === fixture.divisionId);
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
