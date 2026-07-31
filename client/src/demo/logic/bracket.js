// Single-elimination bracket seeding.
//
// Returns an array of rounds. Round 0 is the first round: each entry is a
// pair `[entrantA, entrantB]` where either side may be `null` if there
// weren't enough entrants to pair evenly (a "bye" - the other side advances
// automatically, no match played). Rounds after the first are returned only
// as a *count* of matches (pairs of `null`), since who plays in them
// depends on results that don't exist yet - the caller links fixtures
// across rounds via nextFixtureId/nextFixtureSlot instead (and marks the
// resulting bye box's byeSlot - see generateKnockoutFixtures).
//
// No real seeding (e.g. by past performance) is implemented - entrants are
// paired in the order they're given. That's a reasonable v1 default; proper
// seeding is a small, isolated improvement for later (sort `entrantIds`
// before calling this).
//
// Byes are only ever given when a round's entrant/survivor count is ODD -
// never to pad the field up to a power of two. E.g. 6 entrants play 3 real
// first-round matches (nobody sits out); the resulting 3 survivors are an
// odd number, so *that* round gives exactly one of them a bye into the
// round after. This is deliberately different from the more common "pad to
// the next power of two, front-load every resulting bye into round 1"
// scheme - that scheme means someone can skip playing an actual match
// entirely even when the field is otherwise a perfectly even number (e.g.
// 6 people forced into an 8-slot bracket, 2 of whom never play a first
// round at all). Building the bracket round-by-round like this instead
// means a bye only ever happens where it's structurally unavoidable - and,
// since at most one entrant per round can ever get one, there's no need to
// spread multiple byes evenly across the draw the way the old scheme did.
export function buildBracketRounds(entrantIds) {
  if (entrantIds.length < 2) return [];

  const n = entrantIds.length;
  const firstRoundRealMatches = Math.floor(n / 2);
  const hasFirstRoundBye = n % 2 === 1;

  const firstRoundPairs = [];
  let idx = 0;
  for (let p = 0; p < firstRoundRealMatches; p++) {
    firstRoundPairs.push([entrantIds[idx], entrantIds[idx + 1]]);
    idx += 2;
  }
  if (hasFirstRoundBye) {
    firstRoundPairs.push([entrantIds[idx], null]);
  }

  const rounds = [firstRoundPairs];
  // Every box in a round (real match or bye) produces exactly one winner,
  // so the next round's box count is always ceil(current / 2) - not an
  // exact halving, since an odd count needs one bye box to mop up the
  // leftover survivor.
  let survivors = firstRoundPairs.length;
  while (survivors > 1) {
    survivors = Math.ceil(survivors / 2);
    rounds.push(Array.from({ length: survivors }, () => [null, null]));
  }
  return rounds;
}

// Double-elimination bracket seeding.
//
// v1 scope: requires the entrant count to be an exact power of two (4, 8,
// 16, 32...). A double-elimination losers bracket works by interleaving
// newly-eliminated players with the losers bracket's existing survivors,
// round by round - the arithmetic for that only lines up cleanly when every
// winners-bracket round produces exactly half as many losers as the round
// before it, which is only guaranteed when the winners bracket has no byes
// at all. Non-power-of-two fields should use single elimination (which
// already handles byes correctly) or add/remove an entrant to reach a power
// of two - the caller is expected to validate the count and produce a
// friendly error before calling this.
//
// Returns:
//   winnersRounds: identical shape to buildBracketRounds()'s return value -
//     round 0 has the real entrant pairs, later rounds are counts only.
//   losersRounds: an array of `{ matchCount, feedsFromWinnersRound }`
//     describing the losers bracket, in play order:
//       - `feedsFromWinnersRound` is the 0-indexed winners-bracket round
//         whose losers join this round, paired against whatever the losers
//         bracket already has (or against each other if it has nobody yet).
//       - `feedsFromWinnersRound` is `null` for a pure "consolidation"
//         round, where the losers bracket's own survivors just play each
//         other to halve the pool before the next round injects new losers.
//     Like buildBracketRounds, only the *shape* is returned - actual
//     entrant IDs for anything beyond winnersRounds[0] are only known once
//     earlier matches are played, and are wired up by the caller via
//     nextFixtureId/nextFixtureSlot (winner advances) and
//     loserNextFixtureId/loserNextFixtureSlot (loser drops to the losers
//     bracket) on each generated fixture.
export function buildDoubleElimBracket(entrantIds) {
  const n = entrantIds.length;
  if (n < 4) throw new Error('Double elimination needs at least 4 entrants');
  let bracketSize = 1;
  while (bracketSize < n) bracketSize *= 2;
  if (bracketSize !== n) {
    throw new Error(
      `Double elimination requires a power-of-two number of entrants (4, 8, 16, 32...) - got ${n}. ` +
      'Add or remove an entrant to reach one, or use single elimination instead.'
    );
  }

  const winnersRounds = buildBracketRounds(entrantIds); // no byes possible - n is already a power of two
  const losersProducedCounts = winnersRounds.map((round) => round.length);

  const losersRounds = [];
  let pool = 0; // survivors currently waiting in the losers bracket
  for (let r = 0; r < losersProducedCounts.length; r++) {
    const batch = losersProducedCounts[r];
    if (pool === 0) {
      // First losers to arrive - nothing to consolidate against yet, so
      // they just play each other directly.
      losersRounds.push({ matchCount: batch / 2, feedsFromWinnersRound: r });
      pool = batch / 2;
    } else {
      // Consolidate existing survivors down until the pool matches this
      // round's incoming batch size (by construction this is always exactly
      // one halving, since each winners round produces half as many losers
      // as the round before it).
      while (pool > batch) {
        losersRounds.push({ matchCount: pool / 2, feedsFromWinnersRound: null });
        pool = pool / 2;
      }
      losersRounds.push({ matchCount: batch, feedsFromWinnersRound: r });
      pool = batch;
    }
  }

  return { winnersRounds, losersRounds };
}
