// Aggregates a player's career record across both singles fixtures and
// nominated legs within team fixtures, plus a head-to-head breakdown per
// opponent. Only completed matches/legs count - in-progress or scheduled
// ones don't affect the numbers yet.
export function buildPlayerProfile(db, playerId) {
  const player = db.players.find((p) => p.id === playerId);
  if (!player) return null;

  const career = { played: 0, won: 0, lost: 0, framesFor: 0, framesAgainst: 0 };
  const headToHeadMap = new Map();
  const results = [];

  function recordResult({ opponentId, forScore, againstScore, won, leagueName, divisionName, fixtureId, context, scheduledDate, round }) {
    career.played += 1;
    career.framesFor += forScore;
    career.framesAgainst += againstScore;
    if (won) career.won += 1;
    else career.lost += 1;

    // Looked up once and reused below - this used to call db.players.find()
    // a second time for the same id just a few lines later.
    const opponent = db.players.find((p) => p.id === opponentId);

    if (!headToHeadMap.has(opponentId)) {
      headToHeadMap.set(opponentId, {
        opponentId,
        opponentName: opponent ? opponent.name : 'Unknown player',
        played: 0,
        won: 0,
        lost: 0,
      });
    }
    const h2h = headToHeadMap.get(opponentId);
    h2h.played += 1;
    if (won) h2h.won += 1;
    else h2h.lost += 1;

    results.push({
      fixtureId,
      leagueName,
      divisionName,
      opponentName: opponent ? opponent.name : 'Unknown player',
      forScore,
      againstScore,
      result: won ? 'win' : 'loss',
      context,
      scheduledDate: scheduledDate || null,
      round: round ?? null,
    });
  }

  const singlesFixtures = db.fixtures.filter(
    (f) => !f.homeTeamId && f.status === 'completed' && (f.homePlayerId === playerId || f.awayPlayerId === playerId)
  );
  for (const fixture of singlesFixtures) {
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const league = db.leagues.find((l) => l.id === fixture.leagueId);
    const isHome = fixture.homePlayerId === playerId;
    recordResult({
      opponentId: isHome ? fixture.awayPlayerId : fixture.homePlayerId,
      forScore: isHome ? fixture.homeFrameScore : fixture.awayFrameScore,
      againstScore: isHome ? fixture.awayFrameScore : fixture.homeFrameScore,
      won: fixture.winnerPlayerId === playerId,
      leagueName: league?.name,
      divisionName: division?.name,
      fixtureId: fixture.id,
      context: 'singles',
      scheduledDate: fixture.scheduledDate,
      round: fixture.round,
    });
  }

  const teamFixtures = db.fixtures.filter(
    (f) => f.homeTeamId && f.legs.some((l) => l.status === 'completed' && (l.homePlayerId === playerId || l.awayPlayerId === playerId))
  );
  for (const fixture of teamFixtures) {
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const league = db.leagues.find((l) => l.id === fixture.leagueId);
    for (const leg of fixture.legs) {
      if (leg.status !== 'completed') continue;
      if (leg.homePlayerId !== playerId && leg.awayPlayerId !== playerId) continue;
      const isHome = leg.homePlayerId === playerId;
      recordResult({
        opponentId: isHome ? leg.awayPlayerId : leg.homePlayerId,
        forScore: isHome ? leg.homeFrameScore : leg.awayFrameScore,
        againstScore: isHome ? leg.awayFrameScore : leg.homeFrameScore,
        won: leg.winnerPlayerId === playerId,
        leagueName: league?.name,
        divisionName: division?.name,
        fixtureId: fixture.id,
        context: `Leg ${leg.legNumber}`,
        scheduledDate: fixture.scheduledDate,
        round: fixture.round,
      });
    }
  }

  // Most-recent-first: scheduledDate is a "YYYY-MM-DD" string (or null for
  // fixtures that were never given a date), so a plain string compare sorts
  // correctly; round number breaks ties within/without a date. Undated
  // results sort last, since there's no way to know when they actually
  // happened relative to dated ones.
  results.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '') || (b.round ?? 0) - (a.round ?? 0));

  const headToHead = [...headToHeadMap.values()].sort((a, b) => b.played - a.played);

  // Form guide: last 5 completed results, most recent first, as a simple
  // 'W'/'L' sequence - results is already sorted most-recent-first above.
  const formGuide = results.slice(0, 5).map((r) => (r.result === 'win' ? 'W' : 'L'));

  // Every league/division this player currently shows up in - directly
  // (singles), via a team roster, or via a doubles/triples pairing. Powers
  // the admin "League" context shown above Career on the profile page;
  // reassigning a player between divisions isn't a feature yet (see
  // README roadmap / player substitution for the closest existing tool), so
  // this is read-only for now.
  const memberTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
  const memberPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);

  // Trophy cabinet: every Roll of Honour entry (see recordChampionIfDivisionComplete
  // in index.js) where this player was the champion directly (a singles
  // division), or was on the roster of the winning team/pairing (a teams or
  // doubles division) - cross-season, since Roll of Honour entries are never
  // deleted. Most recent first, same convention as everything else here.
  const trophies = db.rollOfHonour
    .filter((entry) => {
      if (entry.entryType === 'singles') return entry.championId === playerId;
      if (entry.entryType === 'teams') return memberTeamIds.includes(entry.championId);
      if (entry.entryType === 'doubles') return memberPairingIds.includes(entry.championId);
      return false;
    })
    .map((entry) => ({
      id: entry.id,
      leagueId: entry.leagueId,
      leagueName: entry.leagueName,
      divisionId: entry.divisionId,
      divisionName: entry.divisionName,
      entryType: entry.entryType,
      scheduling: entry.scheduling,
      championName: entry.championName,
      recordedAt: entry.recordedAt,
    }))
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

  const divisions = db.divisions
    .filter((d) =>
      d.playerIds?.includes(playerId) ||
      d.teamIds?.some((id) => memberTeamIds.includes(id)) ||
      d.pairingIds?.some((id) => memberPairingIds.includes(id))
    )
    .map((d) => {
      const league = db.leagues.find((l) => l.id === d.leagueId);
      return { id: d.id, name: d.name, leagueId: d.leagueId, leagueName: league?.name || null };
    });

  return {
    id: player.id,
    name: player.name,
    divisions,
    career: { ...career, frameDifference: career.framesFor - career.framesAgainst },
    headToHead,
    results,
    formGuide,
    trophies,
  };
}
