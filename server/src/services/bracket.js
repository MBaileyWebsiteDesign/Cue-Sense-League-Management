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
// Sentinel for a reserved (empty) bracket slot - always-available capacity
// for a late arrival or day-of walk-in substitution, baked into the
// bracket tree itself at generation time rather than needing any override
// once the bracket already exists (see the double-elim reservedPairCount
// option below, and insertLateEntrantIntoKnockout in server/src/index.js
// for how a real entrant later takes over one of these). Never a real
// entrant id, so it's always safe to check `=== RESERVED_SLOT`.
export const RESERVED_SLOT = '__RESERVED__';

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
export function buildBracketRounds(entrantIds, { reservedPairCount = 0 } = {}) {
  if (entrantIds.length < 2) return [];

  const n = entrantIds.length;
  const firstRoundRealMatches = Math.floor(n / 2);
  const hasFirstRoundBye = n % 2 === 1;
  const orderedIds = hasFirstRoundBye ? withRandomEntrantLast(entrantIds) : entrantIds;

  const firstRoundPairs = [];
  let idx = 0;
  for (let p = 0; p < firstRoundRealMatches; p++) {
    firstRoundPairs.push([orderedIds[idx], orderedIds[idx + 1]]);
    idx += 2;
  }
  if (hasFirstRoundBye) {
    firstRoundPairs.push([orderedIds[idx], null]);
  }
  // Reserved slots (see RESERVED_SLOT above) - added on top of the real
  // entrants' own pairing/bye above, never mixed into it, so how many
  // reserved slots exist never changes who any real entrant is paired
  // against or whether they get the real bye. Each pair faces its own kind
  // - two reserved slots against each other - so by default nothing about
  // them needs playing at all; every later round's size is computed from
  // firstRoundPairs.length below, which already includes them, so the
  // reserved capacity carries all the way through to the final exactly as
  // if they were real entrants who simply haven't shown up yet.
  for (let r = 0; r < reservedPairCount; r++) {
    firstRoundPairs.push([RESERVED_SLOT, RESERVED_SLOT]);
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
export function buildDoubleElimBracket(entrantIds, { reservedPairCount = 0 } = {}) {
  const n = entrantIds.length;
  if (n < 4) throw new Error('Double elimination needs at least 4 entrants');

  // buildBracketRounds already handles an odd entrant count on its own -
  // one randomly-chosen entrant sits out round 1 with a bye, exactly like
  // single-elimination - so an odd n here needs no special handling beyond
  // that; the loser-count math below (Math.floor(count / 2) throughout)
  // already accounts for a bye box producing no loser.
  const winnersRounds = buildBracketRounds(entrantIds, { reservedPairCount });
  // How many entrants/survivors enter each winners round (round 0 starts
  // with everyone plus any reserved slots - see reservedPairCount above -
  // since the losers bracket has to have room for one of those to produce
  // a real loser later, exactly as if it always held a real entrant; every
  // later round starts with however many boxes the round before it had,
  // since every box - real match, bye, or reserved - produces exactly one
  // survivor slot).
  const incoming = [n + reservedPairCount * 2, ...winnersRounds.slice(0, -1).map((round) => round.length)];
  // Only real matches produce a loser - a bye box's occupant advances for
  // free, so Math.floor handles both the even case (no bye) and the odd
  // case (one bye, floor drops it) correctly.
  const wbLosers = incoming.map((count) => Math.floor(count / 2));

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
