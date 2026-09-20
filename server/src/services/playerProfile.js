// Aggregates a player's career record across both singles fixtures and
// nominated legs within team fixtures, plus a head-to-head breakdown per
// opponent. Only completed matches/legs count - in-progress or scheduled
// ones don't affect the numbers yet.
export function buildPlayerProfile(db, playerId) {
  const player = db.players.find((p) => p.id === playerId);
  if (!player) return null;

  const career = { played: 0, won: 0, lost: 0, framesFor: 0, framesAgainst: 0, bnd: 0, rnd: 0, breakWins: 0, nonBreakWins: 0, noShows: 0 };
  const headToHeadMap = new Map();
  const results = [];
  // Table record: how this player fares on each physical table they've
  // played frames on (optional `table`/`venue` tag set from the Live Match
  // Controls card, see POST /fixtures/:id/table-info) - purely informational,
  // like BND/RND above, so a player can see which table they tend to win on.
  const tableRecordMap = new Map();
  function recordTableFrame(table, venue, won) {
    if (!table) return;
    const key = table.trim().toLowerCase();
    if (!key) return;
    if (!tableRecordMap.has(key)) {
      tableRecordMap.set(key, { table: table.trim(), venue: venue ? venue.trim() : null, wins: 0, losses: 0 });
    }
    const rec = tableRecordMap.get(key);
    if (won) rec.wins += 1;
    else rec.losses += 1;
    if (!rec.venue && venue) rec.venue = venue.trim();
  }

  // `outcome` is 'win', 'loss', or 'void' - void is a fixture/leg an admin
  // force-completed 0-0 with no winner by closing its division/league early
  // (see closeOutstandingFixtures in server/src/index.js) rather than one
  // that was actually played out. It counts toward `played` like any other
  // result, but isn't a win or a loss for either side.
  function recordResult({ opponentId, forScore, againstScore, outcome, leagueName, divisionName, fixtureId, context, scheduledDate, round }) {
    career.played += 1;
    career.framesFor += forScore;
    career.framesAgainst += againstScore;
    if (outcome === 'win') career.won += 1;
    else if (outcome === 'loss') career.lost += 1;

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
    if (outcome === 'win') h2h.won += 1;
    else if (outcome === 'loss') h2h.lost += 1;

    results.push({
      fixtureId,
      leagueName,
      divisionName,
      opponentName: opponent ? opponent.name : 'Unknown player',
      forScore,
      againstScore,
      result: outcome,
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
      outcome: fixture.winnerPlayerId === null ? 'void' : (fixture.winnerPlayerId === playerId ? 'win' : 'loss'),
      leagueName: league?.name,
      divisionName: division?.name,
      fixtureId: fixture.id,
      context: 'singles',
      scheduledDate: fixture.scheduledDate,
      round: fixture.round,
    });
    // No-show against this player: an opponent reported them and an admin/
    // League Manager authorised it (fixture.noShowClaim is kept after
    // authorising; counted only while the claimant's win still stands).
    if (fixture.noShowClaim && fixture.winnerPlayerId && fixture.winnerPlayerId === fixture.noShowClaim.winnerPlayerId && fixture.winnerPlayerId !== playerId) {
      career.noShows += 1;
    }
    // BND (Break and Dish) / RND (Reverse Break and Dish) - frames this
    // player personally won that way, tallied from the frame-level `method`
    // tag (see POST /fixtures/:id/frames). Purely informational - doesn't
    // affect win/loss/points anywhere.
    for (const frame of fixture.frames || []) {
      if (frame.winnerPlayerId !== playerId) continue;
      if (frame.method === 'bnd') career.bnd += 1;
      else if (frame.method === 'rnd') career.rnd += 1;
      // Break/non-break win split - only counted when this frame actually has a
      // recorded breaker (see POST /fixtures/:id/frames `breaker`, and the
      // Alternative Breaking auto-tagging). Frames with no breaker recorded at
      // all don't count toward either bucket - nothing to attribute.
      if (frame.breakerPlayerId) {
        if (frame.breakerPlayerId === playerId) career.breakWins += 1;
        else career.nonBreakWins += 1;
      }
    }
    for (const frame of fixture.frames || []) {
      if (!frame.table) continue;
      recordTableFrame(frame.table, frame.venue, frame.winnerPlayerId === playerId);
    }
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
        outcome: leg.winnerPlayerId === null ? 'void' : (leg.winnerPlayerId === playerId ? 'win' : 'loss'),
        leagueName: league?.name,
        divisionName: division?.name,
        fixtureId: fixture.id,
        context: `Leg ${leg.legNumber}`,
        scheduledDate: fixture.scheduledDate,
        round: fixture.round,
      });
      // No-show against this player on this leg - see the singles loop above.
      if (leg.noShowClaim && leg.winnerPlayerId && leg.winnerPlayerId === leg.noShowClaim.winnerPlayerId && leg.winnerPlayerId !== playerId) {
        career.noShows += 1;
      }
      // BND/RND tally for this leg - see the matching comment in the
      // singles loop above.
      for (const frame of leg.frames || []) {
        if (frame.winnerPlayerId !== playerId) continue;
        if (frame.method === 'bnd') career.bnd += 1;
        else if (frame.method === 'rnd') career.rnd += 1;
        // Break/non-break win split for this leg - see the matching comment
        // in the singles loop above.
        if (frame.breakerPlayerId) {
          if (frame.breakerPlayerId === playerId) career.breakWins += 1;
          else career.nonBreakWins += 1;
        }
      }
      for (const frame of leg.frames || []) {
        if (!frame.table) continue;
        recordTableFrame(frame.table, frame.venue, frame.winnerPlayerId === playerId);
      }
    }
  }

  // Most-recent-first: scheduledDate is a "YYYY-MM-DD" string (or null for
  // fixtures that were never given a date), so a plain string compare sorts
  // correctly; round number breaks ties within/without a date. Undated
  // results sort last, since there's no way to know when they actually
  // happened relative to dated ones.
  results.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '') || (b.round ?? 0) - (a.round ?? 0));

  const headToHead = [...headToHeadMap.values()].sort((a, b) => b.played - a.played);
  const tableRecord = [...tableRecordMap.values()]
    .map((r) => ({ ...r, played: r.wins + r.losses, winPct: r.wins + r.losses > 0 ? Math.round((r.wins / (r.wins + r.losses)) * 100) : 0 }))
    .sort((a, b) => b.played - a.played || b.winPct - a.winPct);

  // Form guide: last 5 completed results, most recent first, as a simple
  // 'W'/'L' sequence - results is already sorted most-recent-first above.
  const formGuide = results.slice(0, 5).map((r) => (r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : 'V'));

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
    tableRecord,
    results,
    formGuide,
    trophies,
  };
}
