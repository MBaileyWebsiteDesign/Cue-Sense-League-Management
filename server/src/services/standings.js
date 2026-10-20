// League scoring. Each league carries a `scoring` object (set when the league is
// created, editable by its League Manager) that every division in it uses:
//   win / draw / loss  - points for the match result (defaults 3 / 2 / 0)
//   framesToPoints     - when ticked, every frame a player wins is also added
//                        to their points, so a 2-1 result with the defaults is
//                        3 + 2 = 5 to the winner and 0 + 1 = 1 to the loser
//   bndPoints/rndPoints - extra points for each FRAME won by Break and Dish /
//                        Reverse Break and Dish (not a match win). Default 0.
// Applies to Standard League (round robin) singles/doubles divisions. Anything
// else (knockout, killer, free play, teams) keeps the fixed defaults. A league
// created before this existed has no `scoring` object; its divisions carry on
// with the defaults plus their own old division.addFramesToPoints tickbox until
// a manager saves league scoring.
export const DEFAULT_SCORING = {
  win: 3,
  draw: 2,
  loss: 0,
  framesToPoints: false,
  bndPoints: 0,
  rndPoints: 0,
};

const SCORING_NUMBER_FIELDS = [
  ['win', 'Win points'],
  ['draw', 'Draw points'],
  ['loss', 'Loss points'],
  ['bndPoints', 'BND points'],
  ['rndPoints', 'RND points'],
];

// Validates a scoring object coming from the client. Returns { value } or
// { error } (index.js turns an error into a 400).
export function parseScoring(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Scoring settings must be an object' };
  }
  const value = { ...DEFAULT_SCORING };
  for (const [key, label] of SCORING_NUMBER_FIELDS) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: `${label} must be a number from 0 to 100` };
    }
    value[key] = Math.round(n * 100) / 100;
  }
  value.framesToPoints = !!input.framesToPoints;
  return { value };
}

// True for the division types the league scoring applies to.
export function usesLeagueScoring(division) {
  return !!division && String(division.scheduling || '').startsWith('round_robin') && division.entryType !== 'teams';
}

// The scoring actually used for a division's table.
export function resolveScoring(division, league) {
  if (!usesLeagueScoring(division)) return { ...DEFAULT_SCORING };
  if (league && league.scoring && typeof league.scoring === 'object') {
    return { ...DEFAULT_SCORING, ...league.scoring, framesToPoints: !!league.scoring.framesToPoints };
  }
  return { ...DEFAULT_SCORING, framesToPoints: !!(division && division.addFramesToPoints) };
}

// What the league's Scoring panel shows. For a league with no saved scoring
// yet, reports what its divisions are using now and flags it.
export function describeLeagueScoring(league, divisions) {
  if (league && league.scoring && typeof league.scoring === 'object') {
    return { settings: resolveScoring({ scheduling: 'round_robin_single', entryType: 'singles' }, league), saved: true, mixed: false };
  }
  const applicable = (divisions || []).filter(usesLeagueScoring);
  const ticked = applicable.filter((d) => d.addFramesToPoints).length;
  return {
    settings: { ...DEFAULT_SCORING, framesToPoints: applicable.length > 0 && ticked === applicable.length },
    saved: false,
    mixed: ticked > 0 && ticked < applicable.length,
  };
}

// Standings table for a division, using the scoring above (default: 3 points
// for a match win, 2 for a draw, 0 for a loss; normal race-to-N frame play
// can't end level, so a draw only arises from a genuinely level completed
// fixture).
// Ranked by points then by
// frame difference then by frames won, head-to-head is left as a manual
// tie-break for the admin since it's rarely needed in a single round-robin.
// The one exception is a fixture force-completed 0-0 with no winner by an
// admin closing the division/league early (fixture.closedEarly) - see the
// winnerPlayerId === null branch below - which counts as played but awards no
// points either way (it is NOT a draw).
export function computeStandings(division, fixtures, players, scoring) {
  const sc = scoring || resolveScoring(division, null);
  const addFrames = !!sc.framesToPoints;
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
      // Each also earns the league's BND/RND bonus points (default 0).
      bnd: 0,
      rnd: 0,
      // Authorised no-shows against this entrant - see the noShowClaim block
      // in the fixtures loop below. Informational only; the walkover win for
      // the opponent already flows through the normal won/lost/points logic.
      noShows: 0,
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

    // No-show: a player reported their opponent (POST /api/fixtures/:id/no-show)
    // and an admin/League Manager authorised it (.../no-show/authorize), which
    // completes the fixture with the claimant as winner. The claim marker is
    // kept on the fixture, so it's counted only while the result still stands
    // as the claimant's win (an admin later overriding it to something else
    // drops the no-show). The absent entrant is the non-claimant.
    const nsClaim = fixture.noShowClaim;
    if (nsClaim && fixture.winnerPlayerId && fixture.winnerPlayerId === nsClaim.winnerPlayerId) {
      (fixture.winnerPlayerId === fixture.homePlayerId ? away : home).noShows += 1;
    }

    for (const frame of fixture.frames || []) {
      const winner = table.get(frame.winnerPlayerId);
      if (!winner) continue;
      if (frame.method === 'bnd') {
        winner.bnd += 1;
        winner.points += sc.bndPoints;
      } else if (frame.method === 'rnd') {
        winner.rnd += 1;
        winner.points += sc.rndPoints;
      }
    }

    if (fixture.winnerPlayerId === null) {
      if (!fixture.closedEarly && fixture.homeFrameScore === fixture.awayFrameScore) {
        // Genuinely level completed fixture - draw points each.
        home.drawn += 1;
        away.drawn += 1;
        home.points += sc.draw;
        away.points += sc.draw;
      }
      // else: force-completed 0-0 by an admin closing the division/league
      // early (see closeOutstandingFixtures in server/src/index.js) - counts
      // as played, no win/loss/points either way.
    } else if (fixture.winnerPlayerId === fixture.homePlayerId) {
      home.won += 1;
      home.points += sc.win;
      away.lost += 1;
      away.points += sc.loss;
    } else {
      away.won += 1;
      away.points += sc.win;
      home.lost += 1;
      home.points += sc.loss;
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
