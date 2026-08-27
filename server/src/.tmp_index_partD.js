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
  const handled = avoidRematchOnPlacement(db, division, fixture, 'loserNextFixtureId', 'loserNextFixtureSlot', loserId);
  const byeHandled = avoidRepeatByeOnPlacement(db, division, fixture, 'loserNextFixtureId', 'loserNextFixtureSlot', loserId);
  // See propagateWinner's matching comment - either fallback may already
  // have seated `loserId` itself.
  if (handled || byeHandled) return;
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
  // ADEK is specified as a SINGLE Grand Final with no reset: one match
  // decides it, and the winners-bracket finalist gets no second life.
  if (division.scheduling === ADEK) return;
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
  const reservedCount = reservedByeCountFor(entrantIds.length);
  // rounds[0] has real entrants (nulls = ordinary byes, RESERVED_SLOT =
  // reserved late-entrant byes - see MAX_RESERVED_BYE_COUNT); later rounds
  // are just counts.
  const bracketRounds = buildBracketRounds(entrantIds, { reservedCount });

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
  // needs one code path regardless of which round a bye falls in). A
  // RESERVED_SLOT second slot marks a box as a reserved late-entrant bye
  // (see MAX_RESERVED_BYE_COUNT) rather than an ordinary one - same shape,
  // but left unresolved below instead of auto-advancing immediately.
  bracketRounds[0].forEach(([a, b], i) => {
    const fixture = fixturesByRound[0][i];
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

  const allFixtures = fixturesByRound.flat();
  allFixtures.forEach((f) => db.fixtures.push(f));
  // Resolve any non-reserved byes now that every fixture (and its
  // next-round link) exists - resolveByeIfNeeded itself skips anything
  // still marked reserved.
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
function generateDoubleElimFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

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
  // Reserved-slot handling mirrors generateKnockoutFixtures - see its
  // comment above the equivalent block.
  winnersRounds[0].forEach(([a, b], i) => {
    const fixture = wbByRound[0][i];
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
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
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    wbSourceFixtures.forEach((fixture, i) => {
      let dest, slot;
      if (lbRoundIndex === 0) {
        // Entry round - the very first losers pair straight up against each
        // other, two winners-round losers per losers-bracket match.
        dest = lbDestFixtures[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'home' : 'away';
      } else if (i < lbRound.crossMatches) {
        // Cross-match portion - fills the "away" slot of an already-wired
        // 1:1 fixture (the "home" slot is an existing LB survivor, wired
        // above).
        dest = lbDestFixtures[i];
        slot = 'away';
      } else {
        // Leftover portion - not enough waiting LB survivors to pair
        // against every new loser, so these extras pair off among
        // themselves in their own boxes (after the cross-match ones).
        const j = i - lbRound.crossMatches;
        dest = lbDestFixtures[lbRound.crossMatches + Math.floor(j / 2)];
        slot = j % 2 === 0 ? 'home' : 'away';
      }
      fixture.loserNextFixtureId = dest.id;
      fixture.loserNextFixtureSlot = slot;
    });
  });

  // ---- Grand Final ----
  // By convention the winners-bracket champion always lands in the "home"
  // slot and the losers-bracket champion in "away" - checkGrandFinalReset
  // relies on this to know which side needs to win twice.
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
  const grandFinal = makeFixture({ league, division, round: wbByRound.length + lbByRound.length + 1 });
  grandFinal.bracketRole = 'grand_final';
  wbFinal.nextFixtureId = grandFinal.id;
  wbFinal.nextFixtureSlot = 'home';
  lbFinal.nextFixtureId = grandFinal.id;
  lbFinal.nextFixtureSlot = 'away';

  const allFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allFixtures.forEach((f) => db.fixtures.push(f));
  // Resolve any non-reserved winners-bracket round-1 byes now that every
  // fixture (and its next-round link) exists - mirrors
  // generateKnockoutFixtures. An odd entrant count gives one ordinary bye
  // here; MAX_RESERVED_BYE_COUNT can add several more, deliberately left
  // unresolved (resolveByeIfNeeded skips anything still marked reserved).
  // Every later-round bye (winners or losers bracket) cascade-resolves
  // automatically via propagateWinner/propagateLoser as earlier fixtures
  // complete.
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// "Ally Knockout (Double elimination)" - a second, independent double-
// elimination scheduling option (scheduling: 'knockout_double_elim_ally'),
// separate from 'knockout_double_elim' above so the two can diverge in
// future without either affecting the other. Its own function body (not a
// call into generateDoubleElimFixtures) even though today the two are
// logically identical - see the project doc this was verified against
// (claude/ally-knockout-2026-08-14.md) for why: several genuinely different
// routing techniques were tried and empirically tested (a naive reversed-
// order tweak, rebuilding the bracket as a clean power-of-two tree, and a
// mathematically rigorous bracket-lineage-aware router) against the same
// 9,400-tournament methodology the original double-elim fixes used, and
// none measurably beat what's already in generateDoubleElimFixtures -
// three independent methods converged on the same finding the original
// double-elim work already reached: for a fixed entrant count with the
// minimum possible number of games, avoiding every rematch before the
// final and capping everyone to at most one bye are already very close to
// the achievable ceiling, not something a cleverer algorithm still has
// available to it. So this reuses the identical, most battle-tested
// technique (buildDoubleElimBracket for shape, the same
// avoidRematchOnPlacement/avoidRepeatByeOnPlacement reactive fairness
// helpers used by every knockout format) rather than inventing new,
// less-proven logic purely for its own sake - but keeps its own dedicated
// generator function and scheduling type so it has a genuinely independent
// on/off switch and a stable place to diverge later if a real improvement
// is ever found for one format and not the other.
//
// Known v1 limitation, deliberately not carried over: the late-entrant
// bracket rebuild (POST /api/divisions/:id/late-entrants,
// rebuildDoubleElimFromRound1) stays 'knockout_double_elim'-only for now -
// see that route's own guard below. Reserved bye slots
// (MAX_RESERVED_BYE_COUNT) are globally set to 0 already, so nothing is
// lost there for either format.
function generateAllyDoubleElimFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ----
  const wbByRound = winnersRounds.map((pairs, roundIndex) =>
    pairs.map(() => {
      const f = makeFixture({ league, division, round: roundIndex + 1 });
      f.bracketRole = 'winners';
      return f;
    })
  );
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
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

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

  const allFixtures = [...wbByRound.flat(), ...lbByRound.flat(), grandFinal];
  allFixtures.forEach((f) => db.fixtures.push(f));
  wbByRound[0].forEach((fixture) => resolveByeIfNeeded(db, division, fixture));
}

// ---- "Testing Double Elimination" fixture generation ----
//
// A third double-elimination format (division.scheduling ===
// 'knockout_double_elim_test'), independent of both generateDoubleElimFixtures
// and generateAllyDoubleElimFixtures above, that exists specifically to fix a
// real limitation in generateDoubleElimFixtures: that function's losers-
// bracket wiring pairs winners-round losers, and losers-bracket survivors
// against each other, in plain sequential/adjacent order (loser 0 vs loser
// 1, box 0's winner vs box 1's winner, etc.). Sequential-adjacent pairing
// has no relationship to the winners-bracket tree structure, so two players
// can end up facing each other again in the losers bracket well before the
// Losers Final/Grand Final, even though a "proper" double-elimination
// bracket is specifically designed so that only bracket topology (not luck)
// decides when rematches can happen.
//
// This function is otherwise IDENTICAL to generateDoubleElimFixtures - same
// buildDoubleElimBracket() round/box counts, same winners-bracket
// construction, same Grand Final wiring, same reserved-bye handling. The
// only thing that changes is *which* losers-bracket box each loser/survivor
// gets wired into, using standard bracket "mirroring": entrants who are
// close together structurally (adjacent winners-bracket boxes, or adjacent
// losers-bracket survivor boxes) are pushed to opposite ends of the next
// round instead of paired with their neighbour, and freshly-dropped
// winners-bracket losers are cross-matched against waiting losers-bracket
// survivors in reverse order rather than same-index order. This is the same
// "reversal/mirroring" technique standard seeded double-elimination
// generators use to keep opposite bracket halves apart until the brackets
// themselves force a merge.
//
// Note this does NOT pad the field to a power of two (deliberately, per
// product decision) - buildDoubleElimBracket's existing odd-count/bye
// handling is unchanged, so an irregular entrant count can still produce a
// bye in a round after the first exactly as it does for the original
// format. Without power-of-two padding there's no formal mathematical
// guarantee of zero rematches before the final (that guarantee normally
// relies on a fully seeded power-of-two draw) - this is a best-effort
// application of standard mirroring topology on top of the existing
// irregular-bracket shape, and meaningfully reduces (in most draws,
// eliminates) early rematches compared to the sequential-adjacent wiring
// above.
//
// Late-entrant mid-tournament bracket rebuild (see rebuildDoubleElimFromRound1
// and addLateEntrant below) is NOT supported for this format - it remains
// exclusive to 'knockout_double_elim'. That feature is unrelated to bracket
// topology/rematch-avoidance and duplicating its ~300 lines of reroster/
// rebuild logic was out of scope for this change.
function generateTestingDoubleElimFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ---- (identical to generateDoubleElimFixtures)
  const wbByRound = winnersRounds.map((pairs, roundIndex) =>
    pairs.map(() => {
      const f = makeFixture({ league, division, round: roundIndex + 1 });
      f.bracketRole = 'winners';
      return f;
    })
  );
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
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

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
  // Link each losers-bracket round's winner forward to the next LB round.
  // MIRRORED vs generateDoubleElimFixtures: on a pure-consolidation round
  // (existing survivors playing each other, no fresh winners-bracket
  // losers arriving), pair box i's winner against box (count-1-i)'s winner
  // - opposite ends of the round - instead of adjacent boxes i/i+1. Merge
  // rounds (1:1 against a fresh loser, wired below) are unaffected here.
  for (let round = 0; round < lbByRound.length - 1; round++) {
    const current = lbByRound[round];
    const next = lbByRound[round + 1];
    const nextIsMergeRound = losersRounds[round + 1].feedsFromWinnersRound !== null;
    if (nextIsMergeRound) {
      current.forEach((fixture, i) => {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      });
    } else {
      const n = current.length;
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = current[p];
        const away = current[n - 1 - p];
        const target = next[p];
        home.nextFixtureId = target.id;
        home.nextFixtureSlot = 'home';
        away.nextFixtureId = target.id;
        away.nextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        // Structural bye box - the one leftover survivor advances alone.
        const mid = current[pairCount];
        const target = next[pairCount];
        mid.nextFixtureId = target.id;
        mid.nextFixtureSlot = 'home';
      }
    }
  }
  // Wire each winners round's losers into their losers-bracket destination.
  // MIRRORED vs generateDoubleElimFixtures in all three sub-cases below.
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    const n = wbSourceFixtures.length;

    if (lbRoundIndex === 0) {
      // Entry round - outside-in mirror pairing (0 vs last, 1 vs
      // second-last, ...) instead of adjacent pairing (0 vs 1, 2 vs 3, ...),
      // so winners-round losers who were structurally close in the
      // original draw are pushed as far apart as possible in the losers
      // bracket.
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = wbSourceFixtures[p];
        const away = wbSourceFixtures[n - 1 - p];
        const dest = lbDestFixtures[p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = wbSourceFixtures[pairCount];
        const dest = lbDestFixtures[pairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    } else {
      // Cross-match portion - REVERSED vs generateDoubleElimFixtures: the
      // i-th fresh loser fills the away slot of box (crossMatches-1-i)
      // instead of box i, so a fresh loser is matched against the survivor
      // structurally furthest from it rather than the one that happens to
      // share its array index.
      const crossN = lbRound.crossMatches;
      for (let i = 0; i < crossN; i++) {
        const fixture = wbSourceFixtures[i];
        const dest = lbDestFixtures[crossN - 1 - i];
        fixture.loserNextFixtureId = dest.id;
        fixture.loserNextFixtureSlot = 'away';
      }
      // Leftover portion - not enough waiting survivors to pair against
      // every new loser; the leftover new losers pair off among
      // themselves. Mirrored the same way as the entry round above,
      // instead of adjacent pairing.
      const leftoverCount = n - crossN;
      const leftoverPairCount = Math.floor(leftoverCount / 2);
      for (let p = 0; p < leftoverPairCount; p++) {
        const home = wbSourceFixtures[crossN + p];
        const away = wbSourceFixtures[crossN + leftoverCount - 1 - p];
        const dest = lbDestFixtures[crossN + p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (leftoverCount % 2 === 1) {
        const mid = wbSourceFixtures[crossN + leftoverPairCount];
        const dest = lbDestFixtures[crossN + leftoverPairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    }
  });

  // ---- Grand Final ---- (identical to generateDoubleElimFixtures)
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
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

// ---- "Adaptive Double Elimination Knockout" (ADEK) ----
// (division.scheduling === ADEK)
//
// Round-at-a-time double elimination. Generation creates ROUND 1 ONLY; every
// later round is computed by appendAdaptiveRoundsIfDue() once the round
// before it has finished, from the results that actually happened. The
// pairing logic itself lives in services/adaptiveDoubleElim.js and is pure -
// no db, no randomness, no clock - so the next round is a deterministic
// function of (entrant order, completed rounds). That is what makes it safe
// to recompute from the fixture table on any request: the same history always
// yields the same round, so a repeated call can never produce a different
// draw.
//
// Fixture shape, and why it deliberately opts out of the placement engine:
//   * bracketRole is 'winners' | 'losers' | 'grand_final', same as every
//     other double-elim format, so champion detection, the public bracket
//     endpoint and the overlay all work unchanged.
//   * nextFixtureId / loserNextFixtureId / resetFixtureId are left null.
//     propagateWinner returns immediately without one, so avoidRematchOn-
//     Placement and avoidRepeatByeOnPlacement never run - correct, because
//     ADEK has already chosen a rematch-free pairing itself and a reactive
//     swap could only undo that.
//   * a bye is stored as its own completed fixture with byeSlot set, so it is
//     visible in the bracket and, more importantly, so the bye is part of the
//     recorded history the next round is computed from.
//   * `round` is a single sequence across both brackets (1, 2, 3...), because
//     unlike a pre-built bracket only one bracket plays in any given round.

function adaptiveEntrantIds(division) {
  if (division.entryType === 'teams') return division.teamIds || [];
  if (division.entryType === 'doubles') return division.pairingIds || [];
  return division.playerIds || [];
}

// Rebuild the completed-round history the pairing engine needs, straight from
// the fixture table. Returns complete:false the moment it hits a round that
// is still being played, which is also the signal "do not append anything".
function adaptiveHistory(division, fixtures) {
  const isTeams = division.entryType === 'teams';
  const HOME = isTeams ? 'homeTeamId' : 'homePlayerId';
  const AWAY = isTeams ? 'awayTeamId' : 'awayPlayerId';
  const WINNER = isTeams ? 'winnerTeamId' : 'winnerPlayerId';
  const byRound = new Map();
  for (const f of fixtures) {
    if (!byRound.has(f.round)) byRound.set(f.round, []);
    byRound.get(f.round).push(f);
  }
  const history = [];
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const inRound = byRound.get(round);
    if (inRound.some((f) => f.status !== 'completed' || f.closedEarly)) {
      return { history, complete: false };
    }
    const matches = [];
    const byes = [];
    for (const f of inRound) {
      if (f.byeSlot) {
        const who = f[HOME] || f[AWAY];
        if (!who) return { history, complete: false };
        byes.push(who);
      } else {
        if (!f[HOME] || !f[AWAY] || !f[WINNER]) return { history, complete: false };
        matches.push({ a: f[HOME], b: f[AWAY], winner: f[WINNER] });
      }
    }
    const real = inRound.find((f) => !f.byeSlot) || inRound[0];
    history.push({ bracket: real.bracketRole, matches, byes });
  }
  return { history, complete: true };
}

// Build and push the next round. Returns true if anything was added.
function appendAdaptiveRound(db, league, division, fixtures) {
  const { history, complete } = adaptiveHistory(division, fixtures);
  if (!complete) return false;
  let round;
  try {
    round = adaptiveNextRound(adaptiveEntrantIds(division), history);
  } catch (err) {
    // A pairing failure must never take a page down with it. The division
    // simply stops advancing and an admin sees the outstanding round is
    // missing, which is recoverable; a 500 on every poll is not.
    console.error('ADEK: could not compute next round for division', division.id, err);
    return false;
  }
  if (!round || !round.matches.length) return false;

  const roundNo = fixtures.length ? Math.max(...fixtures.map((f) => f.round)) + 1 : 1;
  const isTeams = division.entryType === 'teams';
  const makeFixture = isTeams ? makeTeamFixture : makeSinglesFixture;
  const created = [];

  // The engine names its own rounds, and that name is the authoritative
  // record of whether a match is one of the three where a rematch is
  // permitted (Winners Final / Losers Final / Grand Final). Stamping it on
  // the fixture means the rule is inspectable in the data rather than
  // re-inferred - by the UI, by a report, or by anyone auditing a division.
  for (const [a, b] of round.matches) {
    const f = makeFixture({ league, division, round: roundNo });
    f.bracketRole = round.bracket;
    f.roundLabel = round.label;
    f.roundKind = round.kind;
    if (isTeams) { f.homeTeamId = a; f.awayTeamId = b; } else { f.homePlayerId = a; f.awayPlayerId = b; }
    created.push(f);
  }
  for (const entrantId of round.byes) {
    const f = makeFixture({ league, division, round: roundNo });
    f.bracketRole = round.bracket;
    f.roundLabel = round.label;
    f.roundKind = round.kind;
    f.byeSlot = 'away';
    f.status = 'completed';
    if (isTeams) { f.homeTeamId = entrantId; f.winnerTeamId = entrantId; } else { f.homePlayerId = entrantId; f.winnerPlayerId = entrantId; }
    created.push(f);
  }

  // Dates: carry the previous round's date forward by the division's gap.
  // assignScheduledDates only ever runs at generation time and needs a
  // startDate that isn't persisted, so later rounds date themselves.
  if (division.gapDays && roundNo > 1) {
    const prev = fixtures
      .filter((f) => f.round === roundNo - 1 && f.scheduledDate)
      .map((f) => f.scheduledDate)
      .sort();
    if (prev.length) {
      const d = new Date(`${prev[0]}T00:00:00`);
      d.setDate(d.getDate() + Number(division.gapDays));
      const iso = d.toISOString().slice(0, 10);
      created.forEach((f) => { f.scheduledDate = iso; });
    }
  }

  // Visibility: markAllRoundsVisible is a snapshot taken at generation time,
  // so a round invented later would be invisible to every non-admin - players
  // would never see their own match. Inherit the previous round's visibility,
  // which is the closest thing to the admin's expressed intent.
  if (roundNo === 1 || isRoundVisible(division, roundNo - 1)) {
    if (!Array.isArray(division.visibleRounds)) division.visibleRounds = [];
    if (!division.visibleRounds.includes(roundNo)) {
      division.visibleRounds = [...division.visibleRounds, roundNo].sort((a, b) => a - b);
    }
  }

  created.forEach((f) => db.fixtures.push(f));
  return true;
}

// Called at the top of hydrateDivision, which already runs at the end of
// every route that can complete a fixture (plus every plain GET) - the same
// central hook recordChampionIfDivisionComplete uses, and for the same
// reason: there is no single fixture-completion funnel to hook instead.
// Every guard below is cheap and the common case (a round still in play)
// bails on the first scan, so this is a no-op on virtually every request.
function appendAdaptiveRoundsIfDue(db, division) {
  if (!division || division.scheduling !== ADEK) return false;
  if (!division.fixturesGenerated) return false;
  if (division.status === 'completed') return false;
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  if (fixtures.length === 0) return false;
  if (fixtures.some((f) => f.status !== 'completed')) return false;   // round still being played
  if (fixtures.some((f) => f.closedEarly)) return false;              // division was force-closed
  if (fixtures.some((f) => f.bracketRole === 'grand_final')) return false; // champion decided
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (!league) return false;
  return appendAdaptiveRound(db, league, division, fixtures);
}

function generateAdaptiveDoubleElimFixtures({ db, league, division, entrantIds }) {
  // Round 1 and nothing else - the rest of the event does not exist yet, and
  // that is the entire point of the format.
  appendAdaptiveRound(db, league, division, []);
  void entrantIds;
}

// ---- "Pre Configured Double Elimination Knockout" fixture generation ----
// (division.scheduling === 'knockout_double_elim_pcdek')
//
// IMPORTANT - read before touching this function or its rematch policy:
// this format was originally specced as a library of 50 hand-authored,
// per-entrant-count (1-50) bracket "templates" that would guarantee - not
// just minimize - that no two players ever meet twice before the Grand
// Final/Grand Final Reset, each one exhaustively validated against every
// possible sequence of winners/losers before being allowed into the
// library. That guarantee is proven mathematically impossible for a fixed
// (non-adaptive) match-routing graph, for essentially every entrant count
// above 2 - re-derived independently for this feature (a clean pigeonhole
// argument: whichever losers-bracket box a winners-bracket dropout is
// routed into, there is always at least one outcome branch where the only
// available same-loss-count opponent there is someone they already beat,
// because the routing has to be fixed in advance while the actual identity
// of who's "safe" to pair them with depends on match results that haven't
// happened yet) - and it matches, exactly, what this project's own prior
// research already found twice on 2026-08-14: the Ally Knockout
// bipartite-matching proof (claude/ally-knockout-2026-08-14.md - "impossible
// to guarantee...for most entrant counts") and the Pre-Configured Knockout
// spreadsheet analysis (claude/pre-configured-knockout-spreadsheet-analysis-2026-08-14.md
// - the industry-standard "Superior seeding" algorithm, the same one used by
// brackets-manager.js and Vertex42's templates, still produced a pre-final
// rematch in 49.55% of 23,500 simulated tournaments). Building 50 templates
// that claim to pass exhaustive zero-violation validation would mean either
// faking that result or silently weakening the rule - neither acceptable.
//
// So this format is real, but scoped honestly: "pre configured" means each
// entrant count's bracket SHAPE (round/box counts, bye placement, losers-
// bracket merge structure) is a fully deterministic structural template -
// see pcdekTemplateSummary() below, and buildDoubleElimBracket() in
// services/bracket.js which actually derives it - rather than a bracket
// dynamically invented ad hoc. It is not a hand-authored, independently
// "validated" template per player count; it's the same deterministic
// derivation every double-elim format here already uses, exposed as its
// own inspectable template. On top of that shape, this uses the single
// most effective losers-bracket wiring technique already proven in this
// codebase - the same outside-in "mirrored" topology as
// generateTestingDoubleElimFixtures (mirrors structurally-close dropouts
// to opposite ends of the next round instead of pairing neighbours) - plus
// the full reactive rematch/bye-fairness safety net every double-elim
// format here shares (avoidRematchOnPlacement's multi-hop chain search,
// avoidRepeatByeOnPlacement), which applies automatically to any fixture
// with bracketRole 'winners'/'losers' via propagateWinner/propagateLoser,
// regardless of scheduling type - nothing PCDEK-specific needed there.
// rematchPolicy for this format is GRAND_FINAL_ONLY-*preferred*: the
// generator and the runtime placement engine both actively work to
// avoid every rematch before the Grand Final/Grand Final Reset, and in
// practice succeed far more often than not (see the offline stress-test
// numbers in claude/pcdek-format-2026-08-15.md), but - like every other
// double-elim format in this codebase - cannot guarantee it in every
// branch. Do not present this format to users as a hard guarantee.
//
// Identical to generateTestingDoubleElimFixtures in every other respect
// (reserved-bye handling, Grand Final wiring, no power-of-two padding).
// Late-entrant mid-tournament bracket rebuild is NOT supported for this
// format either, for the same reason as Ally Knockout/Testing Double
// Elimination - see the dedicated generator functions' own comments.
function generatePCDEKFixtures({ db, league, division, entrantIds }) {
  const makeFixture = division.entryType === 'teams' ? makeTeamFixture : makeSinglesFixture;
  const reservedCount = reservedByeCountFor(entrantIds.length);
  const { winnersRounds, losersRounds } = buildDoubleElimBracket(entrantIds, { reservedCount });

  // ---- Winners bracket ---- (identical to generateTestingDoubleElimFixtures)
  const wbByRound = winnersRounds.map((pairs, roundIndex) =>
    pairs.map(() => {
      const f = makeFixture({ league, division, round: roundIndex + 1 });
      f.bracketRole = 'winners';
      return f;
    })
  );
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
    const isReserved = b === RESERVED_SLOT;
    const awayValue = isReserved ? null : b;
    if (b === null || isReserved) fixture.byeSlot = 'away';
    if (isReserved) fixture.reserved = true;
    if (division.entryType === 'teams') {
      fixture.homeTeamId = a;
      fixture.awayTeamId = awayValue;
    } else {
      fixture.homePlayerId = a;
      fixture.awayPlayerId = awayValue;
    }
  });

  // ---- Losers bracket ---- (mirrored topology, identical to
  // generateTestingDoubleElimFixtures - see that function's own comments
  // for why outside-in mirroring beats sequential/adjacent pairing)
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
    if (nextIsMergeRound) {
      current.forEach((fixture, i) => {
        fixture.nextFixtureId = next[i].id;
        fixture.nextFixtureSlot = 'home';
      });
    } else {
      const n = current.length;
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = current[p];
        const away = current[n - 1 - p];
        const target = next[p];
        home.nextFixtureId = target.id;
        home.nextFixtureSlot = 'home';
        away.nextFixtureId = target.id;
        away.nextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = current[pairCount];
        const target = next[pairCount];
        mid.nextFixtureId = target.id;
        mid.nextFixtureSlot = 'home';
      }
    }
  }
  losersRounds.forEach((lbRound, lbRoundIndex) => {
    if (lbRound.feedsFromWinnersRound === null) return;
    const wbSourceFixtures = wbByRound[lbRound.feedsFromWinnersRound].filter((f) => !f.byeSlot);
    const lbDestFixtures = lbByRound[lbRoundIndex];
    const n = wbSourceFixtures.length;

    if (lbRoundIndex === 0) {
      const pairCount = Math.floor(n / 2);
      for (let p = 0; p < pairCount; p++) {
        const home = wbSourceFixtures[p];
        const away = wbSourceFixtures[n - 1 - p];
        const dest = lbDestFixtures[p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (n % 2 === 1) {
        const mid = wbSourceFixtures[pairCount];
        const dest = lbDestFixtures[pairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    } else {
      const crossN = lbRound.crossMatches;
      for (let i = 0; i < crossN; i++) {
        const fixture = wbSourceFixtures[i];
        const dest = lbDestFixtures[crossN - 1 - i];
        fixture.loserNextFixtureId = dest.id;
        fixture.loserNextFixtureSlot = 'away';
      }
      const leftoverCount = n - crossN;
      const leftoverPairCount = Math.floor(leftoverCount / 2);
      for (let p = 0; p < leftoverPairCount; p++) {
        const home = wbSourceFixtures[crossN + p];
        const away = wbSourceFixtures[crossN + leftoverCount - 1 - p];
        const dest = lbDestFixtures[crossN + p];
        home.loserNextFixtureId = dest.id;
        home.loserNextFixtureSlot = 'home';
        away.loserNextFixtureId = dest.id;
        away.loserNextFixtureSlot = 'away';
      }
      if (leftoverCount % 2 === 1) {
        const mid = wbSourceFixtures[crossN + leftoverPairCount];
        const dest = lbDestFixtures[crossN + leftoverPairCount];
        mid.loserNextFixtureId = dest.id;
        mid.loserNextFixtureSlot = 'home';
      }
    }
  });

  // ---- Grand Final ---- (identical to generateDoubleElimFixtures)
  const wbFinal = wbByRound[wbByRound.length - 1][0];
  const lbFinal = lbByRound[lbByRound.length - 1][0];
