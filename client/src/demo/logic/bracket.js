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
// Picks one random entrant out of the list and moves it to the end,
// leaving everyone else's relative order untouched - buildBracketRounds
// always gives an odd round's bye to whoever ends up last, so this is what
// makes that bye recipient random instead of positional, without changing
// who else ends up paired against whom.
function withRandomEntrantLast(entrantIds) {
  const ids = [...entrantIds];
  const byeIndex = Math.floor(Math.random() * ids.length);
  const [byeEntrant] = ids.splice(byeIndex, 1);
  ids.push(byeEntrant);
  return ids;
}

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
//
// When the very first round's entrant count is odd, WHICH entrant sits out
// is chosen at random (see withRandomEntrantLast) rather than always being
// whoever happens to be last in seed order - manual seeding (see
// server/src/index.js's reorder-entrants route) still fully controls who
// plays whom otherwise, only the bye slot itself is randomised. Later
// rounds can also produce a bye (see above), but there's no "entrant" to
// randomise there - it falls out of whichever box a survivor happens to
// land in, decided by results that don't exist yet at generation time.
// How many of a round's boxes can ever be a bye. Structurally, ordinary
// play only ever produces one (see buildBracketRounds's own comments) -
// this is only ever exceeded deliberately, by reservedCount below.
function boxesFor(pairCount) {
  return Array.from({ length: pairCount }, () => [null, null]);
}

// Marker used as round 1's second slot to flag a box as a RESERVED bye
// (see reservedCount below) rather than an ordinary structural one - both
// look like `[entrantId, <empty>]` to the rest of the pipeline, but only a
// reserved one should be left unresolved for a late entrant to claim.
// Ordinary byes still use plain `null`, unchanged.
export const RESERVED_SLOT = Symbol('reserved-slot');

export function buildBracketRounds(entrantIds, { reservedCount = 0 } = {}) {
  if (entrantIds.length < 2 + reservedCount) {
    // Not enough real entrants to both hold reservedCount of them back for
    // a late-entrant slot AND pair off everyone else - the caller
    // (generateKnockoutFixtures) is expected to cap reservedCount before
    // calling this, so this is a defensive floor, not the normal path.
    reservedCount = Math.max(0, entrantIds.length - 2);
  }
  if (entrantIds.length < 2 && reservedCount === 0) return [];

  // Reserved entrants (see reservedCount doc below) are pulled off the end
  // of the field before normal pairing runs, so they never affect who else
  // plays whom in round 1 - withRandomEntrantLast below only ever sees the
  // entrants left after reservedCount has been removed.
  const reservedEntrants = reservedCount > 0 ? entrantIds.slice(entrantIds.length - reservedCount) : [];
  const pairEntrants = reservedCount > 0 ? entrantIds.slice(0, entrantIds.length - reservedCount) : entrantIds;

  const n = pairEntrants.length;
  const firstRoundRealMatches = Math.floor(n / 2);
  const hasFirstRoundBye = n % 2 === 1;
  const orderedIds = hasFirstRoundBye ? withRandomEntrantLast(pairEntrants) : pairEntrants;

  const firstRoundPairs = [];
  let idx = 0;
  for (let p = 0; p < firstRoundRealMatches; p++) {
    firstRoundPairs.push([orderedIds[idx], orderedIds[idx + 1]]);
    idx += 2;
  }
  if (hasFirstRoundBye) {
    firstRoundPairs.push([orderedIds[idx], null]);
  }
  // Reserved slots: up to `reservedCount` extra round-1 boxes, each
  // seeding ONE genuine registered entrant (pulled off the field above)
  // against an open side reserved for a day-of late entrant - structurally
  // an ordinary bye box (one real occupant, byeSlot marked by the caller),
  // except generateKnockoutFixtures/generateDoubleElimFixtures deliberately
  // leave it unresolved instead of auto-advancing the occupant immediately,
  // so a late entrant can claim the open side first. Anything still
  // unclaimed once late entry closes falls back to ordinary bye
  // resolution. This is a different (and safer) design than an earlier,
  // reverted attempt that reserved fully-blank two-sided boxes with no
  // real occupant on either side - see the removal commit "Remove the
  // always-present empty round-1 fixture from double-elim brackets" for
  // why that broke (an empty box has no structural path to ever resolve
  // itself if nobody claims it - a bye box always does).
  reservedEntrants.forEach((entrantId) => {
    firstRoundPairs.push([entrantId, RESERVED_SLOT]);
  });

  const rounds = [firstRoundPairs];
  // Every box in a round (real match or bye) produces exactly one winner,
  // so the next round's box count is always ceil(current / 2) - not an
  // exact halving, since an odd count needs one bye box to mop up the
  // leftover survivor. Reserved boxes count the same as any other box here
  // - the recurrence only cares about round-1's total box count, not how
  // many of them are reserved.
  let survivors = firstRoundPairs.length;
  while (survivors > 1) {
    survivors = Math.ceil(survivors / 2);
    rounds.push(boxesFor(survivors));
  }
  return rounds;
}

// Double-elimination bracket seeding.
//
// Accepts any entrant count of 4 or more, odd or even - not just an exact
// power of two, and not just an even field (an odd field gets one
// randomly-assigned bye in the winners bracket's first round, exactly like
// buildBracketRounds/single-elimination). The winners bracket is built
// exactly like buildBracketRounds (byes only when a round's survivor count
// is odd), so a non-power-of-two field
// can still produce winners-bracket byes in rounds after the first (e.g. 6
// entrants: round 1 has 3 real matches and no bye, but its 3 survivors are
// odd, so round 2 gives exactly one of them a bye). The losers bracket has
// to absorb whatever comes out of that irregular winners bracket, so unlike
// the old power-of-two-only version it can no longer assume each winners
// round produces exactly half as many losers as the round before - instead
// each losers round is computed from up to two pieces:
//   - `crossMatches`: how many of the losers bracket's own waiting
//     survivors get paired 1:1 against a fresh batch of winners-bracket
//     losers (the survivor takes the "home" slot, the new loser "away").
//   - any leftover new losers (if the fresh batch outnumbers the waiting
//     pool) or leftover survivors (if the pool needs consolidating down
//     before/after) pair off among themselves, taking a bye if there's an
//     odd one out.
// A round with `feedsFromWinnersRound: null` is a pure consolidation round
// (existing losers-bracket survivors playing each other, no new losers
// arriving); a round with it set receives that winners round's losers,
// either as brand new entries (pool was empty) or merged in per the above.
//
// Returns:
//   winnersRounds: identical shape to buildBracketRounds()'s return value.
//   losersRounds: an array of
//     `{ boxCount, realMatches, hasBye, feedsFromWinnersRound, crossMatches }`
//     describing the losers bracket, in play order. `boxCount` is the total
//     number of fixtures in the round (including any bye box); `realMatches`
//     is how many of those are actual matches; `hasBye` marks whether the
//     round has exactly one bye box (always the last one, mirroring
//     buildBracketRounds); `crossMatches` is how many of the round's boxes
//     pair a losers-bracket survivor against a fresh winners-bracket loser
//     (only meaningful on a merge round - see generateDoubleElimFixtures for
//     how the caller uses it to wire winners-bracket losers to the right
//     losers-bracket box). Like buildBracketRounds, only the *shape* is
//     returned - actual entrant IDs are wired up by the caller via
//     nextFixtureId/nextFixtureSlot and loserNextFixtureId/loserNextFixtureSlot.
export function buildDoubleElimBracket(entrantIds, { reservedCount = 0 } = {}) {
  const n = entrantIds.length;
  if (n < 4) throw new Error('Double elimination needs at least 4 entrants');

  // buildBracketRounds already handles an odd entrant count on its own -
  // one randomly-chosen entrant sits out round 1 with a bye, exactly like
  // single-elimination - and now also handles reservedCount (see its own
  // doc comment) the same way single-elimination does: up to reservedCount
  // entrants are held back from round 1 and each seeded alone into their
  // own bye box instead.
  const winnersRounds = buildBracketRounds(entrantIds, { reservedCount });
  // wbLosers: how many *real* matches (and therefore losers) each winners
  // round produces. Math.floor(count / 2) is only correct when a round has
  // AT MOST ONE bye box - true everywhere else in this file, since ordinary
  // play only ever produces one structurally-unavoidable bye per round, but
  // round 1 can now carry a natural bye AND up to several reserved byes at
  // once (see reservedCount above). So round 1's real-match count is read
  // directly off its pairing (how many boxes have a real second entrant)
  // instead of assumed from a simple halving, and every later round keeps
  // the floor-based shortcut, since only round 1 is ever deliberately
  // padded with more than one bye.
  const wbLosers = winnersRounds.map((round, r) => {
    if (r === 0) return round.filter(([, b]) => b !== null && b !== RESERVED_SLOT).length;
    const hasBye = winnersRounds[r - 1].length % 2 === 1;
    return round.length - (hasBye ? 1 : 0);
  });

  const losersRounds = [];
  let pool = 0; // losers-bracket survivors currently waiting, between rounds
  for (let r = 0; r < wbLosers.length; r++) {
    const batch = wbLosers[r];
    if (pool === 0) {
      // First losers to arrive this cycle - nothing to consolidate against
      // yet, so they just play each other directly.
      const hasBye = batch % 2 === 1;
      const realMatches = Math.floor(batch / 2);
      const boxCount = realMatches + (hasBye ? 1 : 0);
      losersRounds.push({ boxCount, realMatches, hasBye, feedsFromWinnersRound: r, crossMatches: 0 });
      pool = boxCount;
    } else {
      // Consolidate the existing pool down (pure survivor-vs-survivor
      // rounds) until it's no larger than this round's incoming batch.
      while (pool > batch) {
        const hasBye = pool % 2 === 1;
        const realMatches = Math.floor(pool / 2);
        const boxCount = realMatches + (hasBye ? 1 : 0);
        losersRounds.push({ boxCount, realMatches, hasBye, feedsFromWinnersRound: null, crossMatches: 0 });
        pool = boxCount;
      }
      if (pool === batch) {
        // Pool lines up exactly with the incoming batch - classic 1:1
        // merge, every waiting survivor gets a fresh loser to play.
        losersRounds.push({ boxCount: batch, realMatches: batch, hasBye: false, feedsFromWinnersRound: r, crossMatches: batch });
        pool = batch;
      } else {
        // pool < batch: not enough waiting survivors to pair against every
        // new loser. `pool` of them get a 1:1 cross-match; the leftover new
        // losers pair off among themselves (with a bye if there's an odd
        // one out).
        const leftover = batch - pool;
        const leftoverHasBye = leftover % 2 === 1;
        const leftoverRealMatches = Math.floor(leftover / 2);
        const leftoverBoxCount = leftoverRealMatches + (leftoverHasBye ? 1 : 0);
        losersRounds.push({
          boxCount: pool + leftoverBoxCount,
          realMatches: pool + leftoverRealMatches,
          hasBye: leftoverHasBye,
          feedsFromWinnersRound: r,
          crossMatches: pool,
        });
        pool = pool + leftoverBoxCount;
      }
    }
  }
  // Once the winners bracket is exhausted, keep consolidating any remaining
  // losers-bracket pool down to a single champion.
  while (pool > 1) {
    const hasBye = pool % 2 === 1;
    const realMatches = Math.floor(pool / 2);
    const boxCount = realMatches + (hasBye ? 1 : 0);
    losersRounds.push({ boxCount, realMatches, hasBye, feedsFromWinnersRound: null, crossMatches: 0 });
    pool = boxCount;
  }

  return { winnersRounds, losersRounds };
}
