// Standings table for a division: 3 points for a match win, 2 for a draw, 0 for
// a loss (race-to-N frame formats can't end in a draw unless a fixture is
// genuinely level), plus frames won when division.addFramesToPoints is ticked.
// Mirrors server/src/services/standings.js. Ranked by points then by
// frame difference then by frames won, head-to-head is left as a manual
// tie-break for the admin since it's rarely needed in a single round-robin.
export function computeStandings(division, fixtures, players) {
  const addFrames = !!division.addFramesToPoints;
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
      drawn: 0,
      framesFor: 0,
      framesAgainst: 0,
      frameDifference: 0,
      points: 0,
      // BND (Break and Dish) / RND (Reverse Break and Dish) - count of
      // frames won that way, tallied from each frame's `method` tag below.
      // Informational only - doesn't affect points/ranking.
      bnd: 0,
      rnd: 0,
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

    for (const frame of fixture.frames || []) {
      const winner = table.get(frame.winnerPlayerId);
      if (!winner) continue;
      if (frame.method === 'bnd') winner.bnd += 1;
      else if (frame.method === 'rnd') winner.rnd += 1;
    }

    if (fixture.winnerPlayerId === null) {
      if (!fixture.closedEarly && fixture.homeFrameScore === fixture.awayFrameScore) {
        // Genuinely level completed fixture - 2 points each.
        home.drawn += 1;
        away.drawn += 1;
        home.points += 2;
        away.points += 2;
      }
      // else: force-completed 0-0 by an admin closing the division/league
      // early (see closeOutstandingFixtures in server/src/index.js) - counts
      // as played, no win/loss/points either way.
    } else if (fixture.winnerPlayerId === fixture.homePlayerId) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    }

    if (addFrames) {
      home.points += fixture.homeFrameScore;
      away.points += fixture.awayFrameScore;
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
