// "Book all tables for a day" (Matt, 2026-09-26, rewritten 2026-09-29):
// blocks every bookable table except the 8 Ball / Chinese table for a whole
// day, opening to closing, so a venue manager can stop the rest of the
// tables being booked online in one go (e.g. for a private event or league
// night) while leaving that one table free to book online. Also takes an
// optional tableId to block just one specific table for the day instead -
// including the 8 Ball/Chinese table, since that's then an explicit choice.
//
// Blocks each table by writing a plain calendar event to that table's own
// Wix events schedule (blockTableForDay, in index.js) - the same thing the
// Wix dashboard's "Block staff time" panel does. This replaced an earlier
// version that created a walk-in Bookings appointment per <=2h chunk of the
// day: Wix's appointment-availability check (SLOT_NOT_AVAILABLE) gave false
// negatives on rapid back-to-back create calls, which made book-all-tables
// fail and roll back on any day with more than ~2 hours left before close.
const BOOK_ALL_EXCLUDE_RE = /\b(8[\s-]?ball|chinese)\b/i;

export function registerBookAllTablesRoute(app, deps) {
  const {
    requireVenueManager,
    ApiError,
    walkinVenue,
    getWalkinTables,
    walkinWixError,
    blockTableForDay,
    readDb,
    writeDb,
    recordAudit,
    WALKIN_OPENING_HOURS,
    WALKIN_MAX_AHEAD_MS,
    londonWallTimeToUtc,
  } = deps;

  app.post('/api/venue-manager/walkins/book-all-tables', requireVenueManager, (req, res, next) => (async () => {
    const { venueId, day, tableId } = req.body || {};
    const { venue, siteId } = walkinVenue(req, venueId);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) throw new ApiError(400, 'Choose a day.');
    const [y, mo, d] = m.slice(1).map(Number);
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const hours = WALKIN_OPENING_HOURS[dow];
    const dayOpenAt = londonWallTimeToUtc(y, mo, d, hours.open / 60);
    const dayCloseAt = londonWallTimeToUtc(y, mo, d, hours.close / 60);
    const now = Date.now();
    const nowFloored = new Date(Math.floor(now / (30 * 60 * 1000)) * 30 * 60 * 1000);
    const startAt = nowFloored.getTime() > dayOpenAt.getTime() ? nowFloored : dayOpenAt;
    if (startAt.getTime() >= dayCloseAt.getTime()) throw new ApiError(400, 'That day has already finished.');
    if (dayOpenAt.getTime() > now + WALKIN_MAX_AHEAD_MS) throw new ApiError(400, 'Days can be booked up to 7 days ahead.');

    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }

    let toBlock, excluded;
    if (tableId) {
      const single = tables.find((t) => t.id === tableId);
      if (!single) throw new ApiError(400, 'Table not found.');
      toBlock = [single];
      excluded = [];
    } else {
      toBlock = tables.filter((t) => !BOOK_ALL_EXCLUDE_RE.test(t.name));
      excluded = tables.filter((t) => BOOK_ALL_EXCLUDE_RE.test(t.name)).map((t) => t.name);
      if (!toBlock.length) throw new ApiError(400, 'No other tables to book - only the 8 Ball / Chinese table is set up.');
    }

    const by = (req.adminSession && req.adminSession.label) || null;
    const title = by ? `Blocked by ${by}` : 'Blocked';
    const results = [];
    for (const table of toBlock) {
      try {
        await blockTableForDay(siteId, table, startAt, dayCloseAt, title);
        results.push({ table: table.name, ok: true, start: startAt.toISOString(), end: dayCloseAt.toISOString() });
      } catch (err) {
        results.push({ table: table.name, ok: false, error: err instanceof ApiError ? err.message : 'Wix would not take that block.' });
      }
    }

    const db = readDb();
    recordAudit(db, {
      actor: by,
      action: 'venue.bookAllTables',
      targetType: 'venue',
      targetId: venue.id,
      details: tableId
        ? `Blocked ${toBlock[0].name} for ${day}: ${results.map((r) => `${r.table} ${r.ok ? 'OK' : `FAILED - ${r.error}`}`).join('; ')}`
        : `Blocked all tables for ${day} (except ${excluded.join(', ') || 'none set up'}): ${results.map((r) => `${r.table} ${r.ok ? 'OK' : `FAILED - ${r.error}`}`).join('; ')}`,
    });
    writeDb(db);
    res.json({ ok: true, day, excluded, results });
  })().catch(next));
}
