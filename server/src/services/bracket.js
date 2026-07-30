// Single-elimination bracket seeding.
//
// Returns an array of rounds. Round 0 is the first round: each entry is a
// pair `[entrantA, entrantB]` where either side may be `null` if there
// weren't enough entrants to fill the bracket evenly (a "bye" - the other
// side advances automatically, no match played). Rounds after the first are
// returned only as a *count* of matches (pairs of `null`), since who plays
// in them depends on results that don't exist yet - the caller links
// fixtures across rounds via nextFixtureId/nextFixtureSlot instead.
//
// No real seeding (e.g. by past performance) is implemented - entrants are
// paired in the order they're given. That's a reasonable v1 default; proper
// seeding is a small, isolated improvement for later (sort `entrantIds`
// before calling this). Byes ARE spread deliberately though - see
// distributeByeSlots below - since which first-round slots get a bye
// directly determines how the two-sided bracket chart (client's
// BracketChart, which splits round 1 straight down the middle into a left
// half and a right half) looks, and an uneven bye split there isn't just a
// display quirk: it makes one half of the actual draw easier than the
// other, since the players who land in that half play fewer real matches
// to reach the same round.
export function buildBracketRounds(entrantIds) {
  if (entrantIds.length < 2) return [];

  let bracketSize = 1;
  while (bracketSize < entrantIds.length) bracketSize *= 2;

  const pairsCount = bracketSize / 2;
  const byes = bracketSize - entrantIds.length;
  // `byes` is always < pairsCount (bracketSize is the *smallest* power of 2 that
  // fits the entrants, so more than half the bracket is always real entrants).
  const byeSlots = distributeByeSlots(pairsCount, byes);

  const firstRoundPairs = [];
  let idx = 0;
  for (let p = 0; p < pairsCount; p++) {
    if (byeSlots[p]) {
      firstRoundPairs.push([entrantIds[idx], null]);
      idx += 1;
    } else {
      firstRoundPairs.push([entrantIds[idx], entrantIds[idx + 1]]);
      idx += 2;
    }
  }

  const rounds = [firstRoundPairs];
  let roundSize = pairsCount;
  while (roundSize >= 2) {
    roundSize = roundSize / 2;
    rounds.push(Array.from({ length: roundSize }, () => [null, null]));
  }
  return rounds;
}

// Marks which of `slotCount` first-round pair slots get a bye, spreading
// `byeCount` of them as evenly as possible across the whole range by
// recursively halving it: each half gets byeCount/2 (rounded), so no half -
// and, one level down, no quarter - absorbs a disproportionate share.
// slotCount is always a power of two (it's `bracketSize / 2` from the
// caller) so the halving always divides evenly. This also guarantees no
// pair ends up as bye-vs-bye (each bye slot only ever holds one entrant),
// since byeCount is always < slotCount - see the caller's comment.
function distributeByeSlots(slotCount, byeCount) {
  const slots = new Array(slotCount).fill(false);
  function assign(start, count, byes) {
    if (byes <= 0 || count === 0) return;
    if (count === 1) {
      slots[start] = true; // byes >= 1 here since we returned above otherwise
      return;
    }
    const half = count / 2;
    const leftByes = Math.ceil(byes / 2);
    const rightByes = byes - leftByes;
    assign(start, half, leftByes);
    assign(start + half, half, rightByes);
  }
  assign(0, slotCount, byeCount);
  return slots;
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
