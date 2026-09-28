// "Book all tables for a day" (Matt, 2026-09-26): fills every bookable
// table except the 8 Ball / Chinese table for a whole day, opening to
// closing, so a venue manager can block the rest of the tables from online
// booking in one go (e.g. for a private event or league night) while
// leaving that one table free to book online. Reuses the same Wix booking
// path as a single walk-in (bookWalkinPart), split into <=2h parts like the
// existing 3h walk-in length. One table failing (e.g. it already has an
// online booking that day) doesn't stop the others.
//
// NOT YET REGISTERED from server/src/index.js as of this commit - index.js
// is too large (483KB) to safely push whole through this session. To wire
// this in, add to index.js:
//   1) right after the existing line
//        import { registerPlayerBookingRoutes } from './routes/playerBookings.js';
//      add:
//        import { registerBookAllTablesRoute } from './routes/bookAllTables.js';
//   2) right after the existing registerPlayerBookingRoutes(app, {...}) call,
//      add:
//        registerBookAllTablesRoute(app, {
//          requireVenueManager,
//          ApiError,
//          walkinVenue,
//          getWalkinTables,
//          walkinWixError,
//          bookWalkinPart,
//          cancelWixBooking,
//          loadWalkins,
//          saveWalkins,
//          readDb,
//          writeDb,
//          recordAudit,
//          resyncAfterWalkin,
//          WALKIN_OPENING_HOURS,
//          WALKIN_MAX_AHEAD_MS,
//          londonWallTimeToUtc,
//        });
// Every dependency listed above is already defined in index.js, above the
// registerPlayerBookingRoutes call site.
const BOOK_ALL_EXCLUDE_RE = /\b(8[\s-]?ball|chinese)\b/i;

export function registerBookAllTablesRoute(app, deps) {
  const {
    requireVenueManager,
    ApiError,
    walkinVenue,
    getWalkinTables,
    walkinWixError,
    bookWalkinPart,
    cancelWixBooking,
    loadWalkins,
    saveWalkins,
    readDb,
    writeDb,
    recordAudit,
    resyncAfterWalkin,
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
    const totalMinutes = Math.round((dayCloseAt.getTime() - startAt.getTime()) / 60000);

    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }
    let toBook, excluded;
    if (tableId) {
      const single = tables.find((t) => t.id === tableId);
      if (!single) throw new ApiError(400, 'Table not found.');
      toBook = [single];
      excluded = [];
    } else {
      toBook = tables.filter((t) => !BOOK_ALL_EXCLUDE_RE.test(t.name));
      excluded = tables.filter((t) => BOOK_ALL_EXCLUDE_RE.test(t.name)).map((t) => t.name);
      if (!toBook.length) throw new ApiError(400, 'No other tables to book - only the 8 Ball / Chinese table is set up.');
    }

    const parts = [];
    { let remaining = totalMinutes; while (remaining > 0) { const chunk = Math.min(120, remaining); parts.push(chunk); remaining -= chunk; } }

    const results = [];
    for (const table of toBook) {
      const created = [];
      let cursor = startAt;
      try {
        for (const len of parts) {
          const partEnd = new Date(cursor.getTime() + len * 60 * 1000);
          created.push(await bookWalkinPart(siteId, table, cursor, partEnd, null));
          cursor = partEnd;
        }
        results.push({ table: table.name, ok: true, start: startAt.toISOString(), end: cursor.toISOString(), bookingIds: created.map((b) => b.id) });
      } catch (err) {
        for (const b of created) {
          try { await cancelWixBooking(siteId, b.id); } catch (e) { console.warn('Could not undo book-all part:', e.message); }
        }
        results.push({ table: table.name, ok: false, error: err instanceof ApiError ? err.message : 'Wix would not take that booking.' });
      }
    }

    const store = loadWalkins();
    const by = (req.adminSession && req.adminSession.label) || null;
    for (const r of results) {
      if (!r.ok) continue;
      for (const id of r.bookingIds) {
        store[id] = { siteId, venueId: venue.id, table: r.table, start: r.start, end: r.end, createdAt: new Date().toISOString(), by };
      }
    }
    saveWalkins();

    const db = readDb();
    recordAudit(db, {
      actor: by,
      action: 'venue.bookAllTables',
      targetType: 'venue',
      targetId: venue.id,
      details: tableId
        ? `Booked ${toBook[0].name} for ${day}: ${results.map((r) => `${r.table} ${r.ok ? 'OK' : `FAILED - ${r.error}`}`).join('; ')}`
        : `Booked all tables for ${day} (except ${excluded.join(', ') || 'none set up'}): ${results.map((r) => `${r.table} ${r.ok ? 'OK' : `FAILED - ${r.error}`}`).join('; ')}`,
    });
    writeDb(db);
    await resyncAfterWalkin(siteId);
    res.json({ ok: true, day, excluded, results });
  })().catch(next));
}
