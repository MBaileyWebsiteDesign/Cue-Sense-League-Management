d: league.id, name: league.name, payment: league.payment }, players });
}));

// ---------- Divisions ----------
// A division has two independent axes:
// - entryType: "singles" (players register directly), "teams" (teams
//   register, each fixture is `legsPerMatch` nominated player-vs-player legs),
//   or "doubles" (2-3 named registered players register together as one
//   `Pairing` and play alternate-shot as a single side - structurally a
//   Pairing is just a named group of players like a Team, but a doubles/
//   triples fixture is scored exactly like a singles fixture: one continuous
//   frame race, no legs, `homePlayerId`/`awayPlayerId` just hold a Pairing id
//   instead of a Player id - see the "Pairings" section below)
// - scheduling: "round_robin_single" (default - Round Robin - Single, everyone
//   plays everyone once), "round_robin_double" (Round Robin - Double,
//   everyone plays everyone twice - a home leg and an away leg with sides
//   swapped, see services/roundRobin.js), "knockout_single_elim"
//   (single-elimination bracket, byes only in a round whose survivor count
//   is odd - never just to pad up to a power of two), or "knockout_double_elim"
//   (winners bracket + losers bracket + Grand Final, with a bracket-reset
//   decider if the losers-bracket finalist wins the Grand Final - requires
//   an exact power-of-2 entrant count, see services/bracket.js). This can
//   differ per division from the league's
//   own default, since a league often runs its regular season as a round
//   robin but a separate cup division as a knockout.

app.post('/api/leagues/:leagueId/divisions', requireAnyAdmin, asyncRoute((req, res) => {
  const { name, order = 0, entryType = 'singles', legsPerMatch = 5, pairingSize = 2, raceTo = 6 } = req.body;
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.leagueId);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);
  const scheduling = req.body.scheduling || league.format.scheduling || 'round_robin_single';

  if (!name || !name.trim()) throw new ApiError(400, 'Division name is required');
  if (!['singles', 'teams', 'doubles'].includes(entryType)) {
    throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
  }
  if (!SCHEDULING_TYPES.includes(scheduling)) {
    throw new ApiError(400, `scheduling must be one of: ${SCHEDULING_TYPES.join(', ')}`);
  }
  if (entryType === 'teams' && (!Number.isInteger(Number(legsPerMatch)) || Number(legsPerMatch) < 1)) {
    throw new ApiError(400, 'legsPerMatch must be a positive whole number');
  }
  if (entryType === 'doubles' && ![2, 3].includes(Number(pairingSize))) {
    throw new ApiError(400, 'pairingSize must be 2 (doubles) or 3 (triples)');
  }
  if (!Number.isInteger(Number(raceTo)) || Number(raceTo) < 1) {
    throw new ApiError(400, 'raceTo must be a whole number of 1 or more');
  }

  const division = {
    id: uuid(),
    leagueId: league.id,
    name: name.trim(),
    order,
    entryType,
    scheduling,
    // Match length - each division sets its own rather than inheriting one
    // fixed value from the league, since a league often runs a main
    // division at one length (e.g. race to 7) and a shorter side division
    // (e.g. a plate/consolation event) at another. Every fixture this
    // division ever generates reads it from here (see makeSinglesFixture/
    // makeTeamFixture) - changing it after fixtures already exist has no
    // effect on fixtures already created, only ones generated after.
    raceTo: Number(raceTo),
    playerIds: [],
    teamIds: [],
    pairingIds: [],
    legsPerMatch: entryType === 'teams' ? Number(legsPerMatch) : null,
    pairingSize: entryType === 'doubles' ? Number(pairingSize) : null,
    gapDays: null,
    fixturesGenerated: false,
    // No round is visible to players until an admin explicitly releases it
    // from "Manage Fixtures" - see isRoundVisible / POST
    // /api/divisions/:id/rounds/:round/visibility below. Admins always see
    // every round regardless of this list.
    visibleRounds: [],
    // 'active' | 'completed' - see POST /api/divisions/:id/close-early
    // below (or its league-wide equivalent, POST /api/leagues/:id/close-early).
    // A division also ends up functionally "complete" the moment its last
    // fixture finishes naturally (see recordChampionIfDivisionComplete), but
    // this field is only ever set by that explicit admin action.
    status: 'active',
    completedAt: null,
    completedBy: null,
  };
  db.divisions.push(division);
  writeDb(db);
  res.status(201).json(division);
}));

// Round visibility ("Manage Fixtures"): a division's `visibleRounds` (array
// of round numbers) controls which rounds a non-admin account is allowed to
// see or take any action on at all - fixture lists, "My Fixtures"/"Needs Your
// Confirmation", direct fixture pages, and every scoring route. Admins always
// see and can act on every round regardless of this list, so a season can be
// built (and even scored ahead of time) before any of it is revealed to
// players. See POST /api/divisions/:id/rounds/:round/visibility below.
function isRoundVisible(division, round) {
  return !!division && Array.isArray(division.visibleRounds) && division.visibleRounds.includes(round);
}

function hydrateDivision(db, division) {
  // Filtered once here, then reused below - computeStandings/
  // computeTeamStandings used to each be handed the *whole* db.fixtures
  // array and re-filter it by divisionId themselves, meaning every call to
  // hydrateDivision (every division page load, every roster/fixture change)
  // did two full scans over every fixture in the entire app instead of one.
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  const league = db.leagues.find((l) => l.id === division.leagueId);
  const leagueName = league ? league.name : null;

  // `bothEntrantsKnown` mirrors the same field the single-fixture endpoint
  // (GET /api/fixtures/:id) and the public/overlay endpoints already expose
  // (see buildOverlayFixture) - added here too so every fixture-list view
  // fed by hydrateDivision (division page, "Manage Fixtures", etc.) can tell
  // "genuinely scheduled and ready to play" apart from "this knockout slot
  // is still waiting on an earlier round's winner" without re-deriving that
  // check in every consuming component. Built as a fresh array (not a
  // mutation of the db.fixtures objects themselves) so the extra field never
  // gets persisted to db.json.
  const isTeamsDivision = division.entryType === 'teams';
  const displayFixtures = fixtures.map((f) => ({
    ...f,
    bothEntrantsKnown: isTeamsDivision
      ? !!(f.homeTeamId && f.awayTeamId)
      : !!(f.homePlayerId && f.awayPlayerId),
  }));
  // Single-elimination round count, computed from the *full* (pre round-
  // visibility-filter) fixture list so it's accurate even for a non-admin
  // viewer who's only been released a later round - see the "Manage
  // Fixtures round visibility" filtering GET /api/divisions/:id does after
  // calling this. Lets the client label rounds by their real distance from
  // the Final (Quarter-final, Semi-final...) instead of a raw round number,
  // without needing to see every earlier round to work out where it sits.
  // null for anything that isn't single-elimination knockout - the client
  // falls back to plain "Round N" labels for those.
  const totalRounds = division.scheduling === 'knockout_single_elim' && fixtures.length > 0
    ? Math.max(...fixtures.map((f) => f.round))
    : null;

  let hydrated;
  if (division.entryType === 'teams') {
    const teams = db.teams
      .filter((t) => division.teamIds.includes(t.id))
      .map((t) => ({ ...t, players: db.players.filter((p) => t.playerIds.includes(p.id)) }));
    const standings = computeTeamStandings(division, fixtures, db.teams);
    hydrated = { ...division, leagueName, teams, fixtures: displayFixtures, standings };
  } else if (division.entryType === 'doubles') {
    const pairings = db.pairings
      .filter((p) => division.pairingIds.includes(p.id))
      .map((p) => ({ ...p, players: db.players.filter((pl) => p.playerIds.includes(pl.id)) }));
    // computeStandings just needs an entrant-id list (division.playerIds) and
    // a matching list of { id, name } entrants to label rows with - a Pairing
    // already has both fields, so this reuses the singles standings
    // calculation unmodified rather than needing its own version.
    const standings = computeStandings({ ...division, playerIds: division.pairingIds }, fixtures, pairings);
    hydrated = { ...division, leagueName, pairings, fixtures: displayFixtures, standings };
  } else {
    const players = db.players.filter((p) => division.playerIds.includes(p.id));
    const standings = computeStandings(division, fixtures, db.players);
    hydrated = { ...division, leagueName, players, fixtures: displayFixtures, standings };
  }
  hydrated.totalRounds = totalRounds;
  hydrated.leaguePayment = league ? league.payment : null;
  // So DivisionDetail.jsx can compute canManageLeague(...) for a League
  // Manager without a second round-trip to GET /api/leagues/:id.
  hydrated.leagueManagerUserIds = league && Array.isArray(league.managerUserIds) ? league.managerUserIds : [];

  // Roll of Honour: rather than hooking every single fixture-completion code
  // path (confirm-result, no-show walkovers, admin overrides, team leg
  // majorities...) to separately check "is the division finished now?",
  // it's checked once, centrally, right here - hydrateDivision already runs
  // at the end of every one of those routes (plus every plain GET), so this
  // reliably catches the transition to "complete" wherever it happens. The
  // first hydrate after the division's last fixture completes records the
  // champion (and does one extra writeDb to persist it, since this function
  // runs after the route's own write); every hydrate after that is a cheap
  // no-op, short-circuited by the existing-record check below.
  recordChampionIfDivisionComplete(db, division, hydrated);

  return hydrated;
}

function recordChampionIfDivisionComplete(db, division, hydrated) {
  if (!division.fixturesGenerated) return;
  const fixtures = hydrated.fixtures;
  if (fixtures.length === 0) return;
  if (fixtures.some((f) => f.status !== 'completed')) return;
  if (db.rollOfHonour.some((r) => r.divisionId === division.id)) return; // already recorded

  const idField = division.entryType === 'teams' ? 'teamId' : 'playerId';
  const nameField = division.entryType === 'teams' ? 'teamName' : 'playerName';
  let championId = null;

  if (division.scheduling === 'knockout_double_elim') {
    // The winners-bracket finalist can win the Grand Final outright, or lose
    // it and force a bracket-reset decider (see checkGrandFinalReset)
    // - resetFixtureId is only ever set on a completed grand_final fixture
    // once that decider exists, so it's the reliable signal for which
    // fixture actually decided the title.
    const grandFinal = fixtures.find((f) => f.bracketRole === 'grand_final');
    if (!grandFinal) return;
    const finalFixture = grandFinal.resetFixtureId
      ? fixtures.find((f) => f.id === grandFinal.resetFixtureId)
      : grandFinal;
    if (!finalFixture || finalFixture.status !== 'completed') return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else if (division.scheduling === 'knockout_single_elim') {
    // Every fixture but the final has a nextFixtureId pointing further into
    // the bracket - the final is the one and only fixture with none.
    const finalFixture = fixtures.find((f) => !f.nextFixtureId);
    if (!finalFixture) return;
    championId = division.entryType === 'teams' ? finalFixture.winnerTeamId : finalFixture.winnerPlayerId;
  } else {
    // round_robin_single / round_robin_double: champion is top of the final
    // standings (already sorted points -> frame difference -> frames for).
    // A top standing with 0 points means nobody actually won a match - the
    // whole division was closed early (closeOutstandingFixtures) before a
    // single result was played out - so there's no real champion to crown,
    // just whoever happened to sort first among an all-0 table.
    const top = hydrated.standings[0];
    if (!top || top.points === 0) return;
    championId = top[idField];
  }
  if (!championId) return;

  const championRow = hydrated.standings.find((row) => row[idField] === championId);
  const championName = championRow ? championRow[nameField] : 'Unknown';
  const league = db.leagues.find((l) => l.id === division.leagueId);

  db.rollOfHonour.push({
    id: uuid(),
    leagueId: division.leagueId,
    leagueName: league ? league.name : 'Unknown league',
    divisionId: division.id,
    divisionName: division.name,
    entryType: division.entryType,
    scheduling: division.scheduling,
    championId,
    championName,
    recordedAt: new Date().toISOString(),
  });
  writeDb(db);
}

app.get('/api/divisions/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const hydrated = hydrateDivision(db, division);
  // A non-admin only ever sees fixtures from rounds the admin has released -
  // see isRoundVisible above. Standings are left untouched (computed from the
  // full fixture list before this filter) since a not-yet-released round
  // shouldn't have any results on it under normal use anyway.
  if (!req.auth.user.isAdmin) {
    hydrated.fixtures = hydrated.fixtures.filter((f) => isRoundVisible(division, f.round));
  }
  res.json(hydrated);
}));

// ---------- Close a division early ----------
// Lets an admin force-finish a division without waiting on the normal
// submit -> confirm handshake: every fixture that isn't already completed
// is force-completed at 0-0 (0 legs each for a team fixture), with no
// winner, exactly as if it had been abandoned - no player action or
// confirmation is needed or possible. A 0-0/no-winner result is a genuinely
// new outcome for a singles/doubles fixture (normal race-to-N play can never
// end level - see the override route above), so it's treated as a void: it
// counts as "played" for both sides in standings/career stats, but isn't a
// win or a loss for either one and awards no points - see the matching
// changes in services/standings.js and services/playerProfile.js. A team
// fixture closed this way is simply a 0-0 draw, which the standings/legs
// model already supported before this feature existed. Available at both
// the division level (this route) and the league level (POST
// /api/leagues/:id/close-early below, which applies this to every division
// in the league in one call).
function closeOutstandingFixtures(db, division, actorLabel) {
  const outstanding = db.fixtures.filter((f) => f.divisionId === division.id && f.status !== 'completed');
  const closedAt = new Date().toISOString();

  for (const fixture of outstanding) {
    if (division.entryType === 'teams') {
      fixture.homeLegsWon = 0;
      fixture.awayLegsWon = 0;
      fixture.winnerTeamId = null; // drawn - computeTeamStandings already awards 1 point each for this
      fixture.legs = fixture.legs.map((leg) => (leg.status === 'completed' ? leg : {
        ...leg,
        homePlayerId: leg.homePlayerId,
        awayPlayerId: leg.awayPlayerId,
        frames: [],
        homeFrameScore: 0,
        awayFrameScore: 0,
        status: 'completed',
        winnerPlayerId: null,
      }));
    } else {
      fixture.homeFrameScore = 0;
      fixture.awayFrameScore = 0;
      fixture.frames = [];
      fixture.winnerPlayerId = null; // void - see services/standings.js
    }
    fixture.status = 'completed';
    fixture.disputeReason = null;
    fixture.closedEarly = { at: closedAt, by: actorLabel };
  }

  if (outstanding.length > 0 || division.status !== 'completed') {
    division.status = 'completed';
    division.completedAt = closedAt;
    division.completedBy = actorLabel;
  }

  return outstanding.length;
}

app.post('/api/divisions/:id/close-early', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const division = db.divisions.find((d) => d.id === req.params.id);
  if (!division) throw new ApiError(404, 'Division not found');
  const league = db.leagues.find((l) => l.id === division.leagueId);
  assertLeagueAccess(req, league);

  const closedCount = closeOutstandingFixtures(db, division, req.adminSession.label);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'division.closeEarly',
    targetType: 'division',
    targetId: division.id,
    details: closedCount > 0
      ? `Closed the division early - force-completed ${closedCount} outstanding fixture(s) 0-0`
      : 'Marked the division as complete (no outstanding fixtures)',
  });

  writeDb(db);
  res.json(hydrateDivision(db, division));
}));

// League-level equivalent of the route above: applies the exact same
// force-complete-at-0-0 treatment to every division in the league in one
// call, for "close the whole league's season early" rather than one
// division at a time. Surfaced from the league management page.
app.post('/api/leagues/:id/close-early', requireAnyAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');
  assertLeagueAccess(req, league);

  const divisions = db.divisions.filter((d) => d.leagueId === league.id);
  let totalClosed = 0;
  let divisionsAffected = 0;
  for (const division of divisions) {
    const closedCount = closeOutstandingFixtures(db, division, req.adminSession.label);
    if (closedCount > 0) {
      divisionsAffected += 1;
      totalClosed += closedCount;
    }
  }

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.closeEarly',
    targetType: 'league',
    targetId: league.id,
    details: totalClosed > 0
      ? `Closed the league early - force-completed ${totalClosed} outstanding fixture(s) 0-0 across ${divisionsAffected} division(s)`
      : 'Marked every division in the league as complete (no outstanding fixtures)',
  });

  writeDb(db);
  res.json({
    leagueId: league.id,
    divisionsAffected,
    fixturesClosed: totalClosed,
    divisions: divisions.map((d) => hydrateDivision(db, d)),
  });
}));

// Permanently deletes a league and everything that belongs to it - every
// division, fixture, team and pairing scoped to it, plus its roll-of-honour
// entries, and it's stripped out of any tour's divisionIds. This is the
// destructive counterpart to close-early above (which just force-completes
// outstanding fixtures but leaves the league and its history in place) -
// use this to actually remove a league that was created by mistake or is no
// longer wanted, not just to end its season. There's no undo.
app.delete('/api/leagues/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const league = db.leagues.find((l) => l.id === req.params.id);
  if (!league) throw new ApiError(404, 'League not found');

  const divisions = db.divisions.filter((d) => d.leagueId === league.id);
  const divisionIds = new Set(divisions.map((d) => d.id));

  const fixturesRemoved = db.fixtures.filter((f) => f.leagueId === league.id).length;
  db.fixtures = db.fixtures.filter((f) => f.leagueId !== league.id);
  db.teams = db.teams.filter((t) => !divisionIds.has(t.divisionId));
  db.pairings = db.pairings.filter((p) => !divisionIds.has(p.divisionId));
  db.rollOfHonour = db.rollOfHonour.filter((r) => r.leagueId !== league.id);
  db.tours.forEach((tour) => {
    tour.divisionIds = tour.divisionIds.filter((id) => !divisionIds.has(id));
  });
  db.divisions = db.divisions.filter((d) => d.leagueId !== league.id);
  db.leagues = db.leagues.filter((l) => l.id !== league.id);

  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'league.delete',
    targetType: 'league',
    targetId: league.id,
    details: `Deleted league "${league.name}" - ${divisions.length} division(s), ${fixturesRemoved} fixture(s)`,
  });

  writeDb(db);
  res.json({ deleted: true, leagueId: league.id, divisionsRemoved: divisions.length, fixturesRemoved });
}));

// ---- Singles players ----
// Players are only ever registered `Users` now (see registeredPlayers()
// below) - a captain picks a name from the list of people who've actually
// signed up rather than typing an arbitrary free-text name. This keeps the
// roster tied to real accounts instead of one-off placeholder names.

// Every registered, active user has (via registration) a linked Player
// record - this is the pool of names a captain/admin can pick from when
// building a division roster or a team. Demo/seed players created directly
// in db.players without a linked user (e.g. the seeded Premier League demo
// data) are NOT included here, since they don't correspond to a real account.
// ---------- League payment wall helpers ----------
// `required: false` keeps the shape stable but inert, so every league (even
// ones that never touch this feature) always has a payment object rather
// than sometimes having one - callers never need an extra null check.
function normalizePaymentConfig(input) {
  const required = !!(input && input.required);
  if (!required) {
    return { required: false, amount: 0, currency: 'GBP', windowStart: null, windowEnd: null };
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError(400, 'Payment amount must be a number greater than 0');
  }
  const windowStart = input.windowStart || null;
  const windowEnd = input.windowEnd || null;
  if (windowStart && windowEnd && new Date(windowEnd) < new Date(windowStart)) {
    throw new ApiError(400, 'Payment window end date cannot be before the start date');
  }
  return {
    required: true,
    amount,
    currency: (input.currency || 'GBP').toUpperCase(),
    windowStart,
    windowEnd,
  };
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(amount);
  } catch {
    return `${amount} ${currency || 'GBP'}`;
  }
}

// Throws unless `playerId` has a confirmed or waived payment record for the
// league that owns `division` - a no-op when that league doesn't require
// payment. Called from every place a player becomes an entrant: adding to a
// singles division, a team, a pairing, and substituting a replacement in
// (the season wizard's bulk CSV import is deliberately NOT gated here - see
// the note at POST /api/admin/seasons/:leagueId/import-players for why).
function assertPaymentCleared(db, division, playerId) {
  const league = db.leagues.find((l) => l.id === division.leagueId);
  if (!league || !league.payment || !league.payment.required) return;
  const record = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === playerId);
  if (record && ['confirmed', 'waived'].includes(record.status)) return;
  const player = db.players.find((p) => p.id === playerId);
  throw new ApiError(
    402,
    `${player ? player.name : 'This player'} hasn't paid the ${formatMoney(league.payment.amount, league.payment.currency)} entry fee for "${league.name}" yet - confirm or waive their payment from the league's Payments tab before adding them.`
  );
}

function registeredPlayers(db) {
  const linkedPlayerIds = new Set(
    db.users.filter((u) => u.status === 'active' && u.playerId).map((u) => u.playerId)
  );
  return db.players
    .filter((p) => linkedPlayerIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/registered-players', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  res.json(registeredPlayers(db));
}));

// Powers the admin "Game Adjustments" page (search a player, then pick the
// fixture to adjust) - same shape/logic as GET /api/users/me/fixtures, just
// parameterized to any playerId rather than the logged-in account's own, and
// admin-only. Includes every status (not just upcoming) since an admin might
// specifically be looking for a `disputed` or `pending_confirmation` match to
// resolve.
app.get('/api/admin/players/:playerId/fixtures', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const playerId = req.params.playerId;
  const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
  const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);

  const fixtures = db.fixtures.filter((f) => {
    if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
    if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId