// Standings table for a division: 2 points for a match win, 0 for a loss
// (race-to-N frame formats can't end in a draw), ranked by points then by
// frame difference then by frames won, head-to-head is left as a manual
// tie-break for the admin since it's rarely needed in a single round-robin.
export function computeStandings(division, fixtures, players) {
  // Index once by id instead of Array.find()-ing `players` for every entrant
  // (was O(entrants * players) - a real cost once `players` is the whole
  // app's player pool, not just this division's roster).
  const playersById = new Map(players.map((p) => [p.id, p]));
  const table = new Map();
  for (const playerId of division.playerIds) {
    const player = playersById.get(playerId);
    table.set(playerId, {
      playerId,
      playerName: player ? player.name : 'Unknown player',
      played: 0,
      won: 0,
      lost: 0,
      framesFor: 0,
      framesAgainst: 0,
      frameDifference: 0,
      points: 0,
    });
  }

  const relevant = fixtures.filter(
    (f) => f.divisionId === division.id && f.status === 'completed'
  );

  for (const fixture of relevant) {
    const home = table.get(fixture.homePlayerId);
    const away = table.get(fixture.awayPlayerId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.framesFor += fixture.homeFrameScore;
    home.framesAgainst += fixture.awayFrameScore;
    away.framesFor += fixture.awayFrameScore;
    away.framesAgainst += fixture.homeFrameScore;

    if (fixture.winnerPlayerId === fixture.homePlayerId) {
      home.won += 1;
      home.points += 2;
      away.lost += 1;
    } else {
      away.won += 1;
      away.points += 2;
      home.lost += 1;
    }
  }

  for (const row of table.values()) {
    row.frameDifference = row.framesFor - row.framesAgainst;
  }

  return [...table.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.frameDifference !== a.frameDifference) return b.frameDifference - a.frameDifference;
    return b.framesFor - a.framesFor;
  });
}
