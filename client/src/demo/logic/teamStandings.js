// Standings table for a *team* division: 2 points for winning a team match,
// 0 for losing. "Legs" are the team-level equivalent of "frames" in a
// singles standings table - each leg is itself a nominated-player race-to-N
// mini-match (see roundLegs.js / the fixture leg endpoints).
export function computeTeamStandings(division, fixtures, teams) {
  // Index once by id instead of Array.find()-ing `teams` for every entrant
  // (was O(entrants * teams) - a real cost once `teams` is the whole app's
  // team pool, not just this division's roster).
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const table = new Map();
  for (const teamId of division.teamIds || []) {
    const team = teamsById.get(teamId);
    table.set(teamId, {
      teamId,
      teamName: team ? team.name : 'Unknown team',
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      legsFor: 0,
      legsAgainst: 0,
      legDifference: 0,
      points: 0,
    });
  }

  const relevant = fixtures.filter(
    (f) => f.divisionId === division.id && f.status === 'completed'
  );

  for (const fixture of relevant) {
    const home = table.get(fixture.homeTeamId);
    const away = table.get(fixture.awayTeamId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.legsFor += fixture.homeLegsWon;
    home.legsAgainst += fixture.awayLegsWon;
    away.legsFor += fixture.awayLegsWon;
    away.legsAgainst += fixture.homeLegsWon;

    if (fixture.winnerTeamId === null) {
      // Only possible with an even legsPerMatch that ends tied.
      home.drawn += 1;
      home.points += 1;
      away.drawn += 1;
      away.points += 1;
    } else if (fixture.winnerTeamId === fixture.homeTeamId) {
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
    row.legDifference = row.legsFor - row.legsAgainst;
  }

  return [...table.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.legDifference !== a.legDifference) return b.legDifference - a.legDifference;
    return b.legsFor - a.legsFor;
  });
}
