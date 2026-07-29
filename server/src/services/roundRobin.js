// Circle-method round-robin scheduler.
// Pairs every player against every other player exactly once ("play each
// other once"). If there's an odd number of players a bye is inserted; the
// player paired against the bye in a given round simply has no fixture that
// round. Returns an array of rounds, each an array of [playerIdA, playerIdB].
export function generateRoundRobin(playerIds) {
  if (playerIds.length < 2) return [];

  const BYE = null;
  const players = [...playerIds];
  if (players.length % 2 !== 0) players.push(BYE);

  const n = players.length;
  const fixed = players[0];
  let rotating = players.slice(1);
  const rounds = [];

  for (let round = 0; round < n - 1; round++) {
    const lineup = [fixed, ...rotating];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = lineup[i];
      const b = lineup[n - 1 - i];
      if (a !== BYE && b !== BYE) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // rotate: move last element of `rotating` to the front
    rotating.unshift(rotating.pop());
  }

  return rounds;
}

// Double round-robin: everyone plays each other twice, once at home and
// once away. The first half of the rounds is a standard single round-robin
// (leg 1); the second half repeats the exact same pairings with home/away
// swapped (leg 2, the "return leg"). Round numbers are contiguous across
// both legs (leg 2 continues numbering where leg 1 left off).
export function generateRoundRobinDouble(playerIds) {
  const legOne = generateRoundRobin(playerIds);
  const legTwo = legOne.map((pairs) => pairs.map(([home, away]) => [away, home]));
  return [...legOne, ...legTwo];
}
