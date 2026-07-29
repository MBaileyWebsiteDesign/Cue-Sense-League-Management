// Tour/series standings: an admin curates a set of divisions (all sharing
// one entryType - see the tour's own `entryType` field) into a Tour, and
// this simply sums each entrant's standings points across every division in
// it. No separate scoring config, no finishing-position table - it reuses
// exactly the same per-division standings rows (see standings.js/
// teamStandings.js) that already power each division's own League Table, so
// a tour's ranking is always self-consistent with what's shown on every
// division page it's built from.
export function computeTourStandings(tour, hydratedDivisions) {
  const idField = tour.entryType === 'teams' ? 'teamId' : 'playerId';
  const nameField = tour.entryType === 'teams' ? 'teamName' : 'playerName';
  const table = new Map();

  for (const division of hydratedDivisions) {
    for (const row of division.standings) {
      const entrantId = row[idField];
      const existing = table.get(entrantId) || {
        entrantId,
        entrantName: row[nameField],
        points: 0,
        played: 0,
        divisionsPlayed: 0,
        breakdown: [],
      };
      existing.points += row.points;
      existing.played += row.played;
      if (row.played > 0) existing.divisionsPlayed += 1;
      existing.breakdown.push({
        divisionId: division.id,
        divisionName: division.name,
        points: row.points,
        played: row.played,
      });
      table.set(entrantId, existing);
    }
  }

  return [...table.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.divisionsPlayed !== a.divisionsPlayed) return b.divisionsPlayed - a.divisionsPlayed;
    return b.played - a.played;
  });
}
