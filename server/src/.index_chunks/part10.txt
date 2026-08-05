s = db.fixtures.filter((f) => f.divisionId === division.id);
    const lastRound = Math.max(...divisionFixtures.map((f) => f.round));
    const lastRoundDate = divisionFixtures.find((f) => f.round === lastRound)?.scheduledDate;
    generated.push({
      division: division.name,
      players: division.playerIds.length,
      rounds: lastRound,
      lastGameDate: lastRoundDate,
      fitsWithinEndDate: !lastRoundDate || lastRoundDate <= endDate,
    });
  }

  writeDb(db);
  res.status(201).json({ league: { id: league.id, name: league.name, startDate, endDate }, generated, skipped });
}));

// ---------- Roll of Honour ----------
// Every entry is recorded automatically by recordChampionIfDivisionComplete
// (see hydrateDivision above) the moment a division's last fixture
// completes - there's no manual "mark as finished" step, and nothing here
// writes to db.rollOfHonour directly.

app.get('/api/roll-of-honour', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const sorted = [...db.rollOfHonour].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
  );
  res.json(sorted);
}));

// ---------- Tours / Series ----------
// A tour is just an admin-curated list of existing divisions (all sharing
// one entryType, enforced below) - the group stage/knockout divisions
// themselves are completely unaware they belong to one. See
// services/tours.js for how the aggregate ranking table is built from their
// standings.

app.get('/api/tours', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  res.json(db.tours);
}));

app.post('/api/tours', requireAdmin, asyncRoute((req, res) => {
  const { name, entryType = 'singles' } = req.body;
  if (!name || !name.trim()) throw new ApiError(400, 'Tour name is required');
  if (!['singles', 'teams', 'doubles'].includes(entryType)) {
    throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
  }
  const db = readDb();
  const tour = {
    id: uuid(),
    name: name.trim(),
    entryType,
    divisionIds: [],
    createdAt: new Date().toISOString(),
  };
  db.tours.push(tour);
  writeDb(db);
  res.status(201).json(tour);
}));

app.get('/api/tours/:id', requireAuth, asyncRoute((req, res) => {
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');

  const divisions = db.divisions.filter((d) => tour.divisionIds.includes(d.id));
  const hydratedDivisions = divisions.map((d) => hydrateDivision(db, d));
  const standings = computeTourStandings(tour, hydratedDivisions);

  res.json({
    ...tour,
    divisions: hydratedDivisions.map((d) => ({
      id: d.id,
      name: d.name,
      leagueId: d.leagueId,
      leagueName: d.leagueName,
      fixturesGenerated: d.fixturesGenerated,
    })),
    standings,
  });
}));

app.delete('/api/tours/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const index = db.tours.findIndex((t) => t.id === req.params.id);
  if (index === -1) throw new ApiError(404, 'Tour not found');
  db.tours.splice(index, 1);
  writeDb(db);
  res.status(204).end();
}));

app.post('/api/tours/:id/divisions', requireAdmin, asyncRoute((req, res) => {
  const { divisionId } = req.body;
  if (!divisionId) throw new ApiError(400, 'divisionId is required');
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');
  const division = db.divisions.find((d) => d.id === divisionId);
  if (!division) throw new ApiError(404, 'Division not found');
  if (division.entryType !== tour.entryType) {
    throw new ApiError(
      400,
      `This tour only accepts ${tour.entryType} divisions - "${division.name}" is a ${division.entryType} division`
    );
  }
  if (!tour.divisionIds.includes(divisionId)) {
    tour.divisionIds.push(divisionId);
  }
  writeDb(db);
  res.status(201).json(tour);
}));

app.delete('/api/tours/:id/divisions/:divisionId', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const tour = db.tours.find((t) => t.id === req.params.id);
  if (!tour) throw new ApiError(404, 'Tour not found');
  tour.divisionIds = tour.divisionIds.filter((id) => id !== req.params.divisionId);
  writeDb(db);
  res.json(tour);
}));

// ---------- API Keys (StreamDeck / integrations) ----------
// See userAuth.js's generateApiKeyValue/hashApiKey/loadApiKeyUser for how a
// key authenticates - once generated, a key behaves exactly like an admin
// session on every existing route (frame scoring, timer/shot-clock,
// overrides, and so on), so a StreamDeck button can be wired straight to
// any of those endpoints with the key as its bearer token. The raw key is
// only ever shown once, in the response to the POST below.

app.get('/api/api-keys', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  res.json(db.apiKeys.map(({ hash, ...rest }) => rest));
}));

app.post('/api/api-keys', requireAdmin, asyncRoute((req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) throw new ApiError(400, 'A label is required, e.g. "StreamDeck - Table 1"');
  const db = readDb();
  const rawKey = generateApiKeyValue();
  const apiKey = {
    id: uuid(),
    label: label.trim(),
    hash: hashApiKey(rawKey),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  db.apiKeys.push(apiKey);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'apiKey.create',
    targetType: 'apiKey',
    targetId: apiKey.id,
    details: `Created API key "${apiKey.label}"`,
  });
  writeDb(db);
  const { hash, ...publicKey } = apiKey;
  res.status(201).json({ ...publicKey, key: rawKey });
}));

app.delete('/api/api-keys/:id', requireAdmin, asyncRoute((req, res) => {
  const db = readDb();
  const index = db.apiKeys.findIndex((k) => k.id === req.params.id);
  if (index === -1) throw new ApiError(404, 'API key not found');
  const [removed] = db.apiKeys.splice(index, 1);
  recordAudit(db, {
    actor: req.adminSession.label,
    action: 'apiKey.revoke',
    targetType: 'apiKey',
    targetId: removed.id,
    details: `Revoked API key "${removed.label}"`,
  });
  writeDb(db);
  res.status(204).end();
}));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---------- Serve the built React client, if present ----------
// (`npm run build` in /client produces /client/dist; when present we serve
// it here so the whole app runs from a single `npm start` on one port. In
// local development, run the Vite dev server separately instead - see
// README - so you get hot reload.)
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ---------- Error handling ----------

app.use((err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ---------- Bootstrap accounts ----------
// Ensures two known accounts exist every time the server boots (a fresh
// deploy, a restart, a new environment) - idempotent, so once both exist
// this is just a couple of cheap reads on every subsequent boot. A temp
// password is only ever set at creation time - if an account already
// exists, whatever password is on it (including one the owner has since
// changed via the normal change-password flow) is left untouched, so a
// redeploy can never silently reset a real password back to the default.
//
// admin@cuesense.co.uk is the one account guaranteed to always be an
// admin - the break-glass login if every other admin account is ever
// suspended or demoted by mistake. This is enforced every boot (granted
// back if it's ever found not-admin), the same way the old bootstrap
// account used to be.
//
// matt.bailey1985@gmail.com is a normal default player account and is
// explicitly NOT an admin - enforced the other way every boot, so it can
// never end up admin again by accident (an old backup, a manual mistake).
// It's still guaranteed to exist, just as a player only.
function ensureBootstrapAccounts() {
  const db = readDb();
  let changed = false;

  const adminEmail = 'admin@cuesense.co.uk';
  const normalizedAdminEmail = adminEmail.toLowerCase();
  let admin = db.users.find((u) => u.email.toLowerCase() === normalizedAdminEmail);
  if (admin) {
    if (!admin.isAdmin) {
      admin.isAdmin = true;
      changed = true;
      console.log(`Bootstrap: granted admin to existing account ${adminEmail}`);
    }
  } else {
    admin = createUserAccount(db, {
      firstName: 'Admin',
      lastName: 'Cue Sense',
      email: adminEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: true,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created admin account ${adminEmail}`);
  }

  const playerEmail = 'matt.bailey1985@gmail.com';
  const normalizedPlayerEmail = playerEmail.toLowerCase();
  let player = db.users.find((u) => u.email.toLowerCase() === normalizedPlayerEmail);
  if (player) {
    if (player.isAdmin) {
      player.isAdmin = false;
      changed = true;
      console.log(`Bootstrap: removed admin from ${playerEmail} - player only now`);
    }
  } else {
    player = createUserAccount(db, {
      firstName: 'Matt',
      lastName: 'Bailey',
      email: playerEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: false,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created player account ${playerEmail}`);
  }

  if (changed) writeDb(db);
}
ensureBootstrapAccounts();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Cue Sense API listening on http://localhost:${PORT}`);
});

