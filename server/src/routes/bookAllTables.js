// "Book table(s) for a day" and "Block book table(s) for a day" (Matt,
// 2026-09-26, rewritten 2026-09-29, reworked 2026-10-03): blocks one or more
// tables so they can't be booked online - for a whole day (opening to
// closing, or from now if the day has already started), or for a chosen
// start and finish time. So a venue manager can stop tables being booked
// online in one go (e.g. for a private event or league night).
//
// Blocks each table by writing a plain calendar event to that table's own
// Wix events schedule (blockTableForDay, in index.js) - the same thing the
// Wix dashboard's "Block staff time" panel does. This replaced an earlier
// version that created a walk-in Bookings appointment per <=2h chunk of the
// day: Wix's appointment-availability check (SLOT_NOT_AVAILABLE) gave false
// negatives on rapid back-to-back create calls, which made the booking fail
// and roll back on any day with more than ~2 hours left before close.
//
// POST body: { venueId, day, tableIds?, tableId?, startTime?, endTime? }
//  - tableIds: the tables to block (any, including 8 Ball / Chinese). The
//    older single tableId is still accepted. With neither, every table
//    except the 8 Ball / Chinese one is blocked (the original behaviour).
//  - startTime + endTime ("HH:MM" UK time, on :00/:30): block just that
//    window. Must sit inside opening hours, not start in the past, and not
//    overlap a booking or block already on any chosen table.
// GET /api/venue-manager/table-availability?venueId=&day= returns the
// booked/blocked windows on each table that day, which the form uses to
// offer only the times that are actually free.
const BOOK_ALL_EXCLUDE_RE = /\b(8[\s-]?ball|chinese)\b/i;

export function registerBookAllTablesRoute(app, deps) {
  const {
    requireVenueManager,
    ApiError,
    walkinVenue,
    getWalkinTables,
    walkinWixError,
    blockTableForDay,
    tableBusyIntervals,
    readDb,
    writeDb,
    recordAudit,
    WALKIN_OPENING_HOURS,
    BLOCK_MAX_AHEAD_MS,
    londonWallTimeToUtc,
  } = deps;

  const parseDay = (day) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) throw new ApiError(400, 'Choose a day.');
    const [y, mo, d] = m.slice(1).map(Number);
    return { y, mo, d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
  };
  const wall = (y, mo, d, minutes) => new Date(londonWallTimeToUtc(y, mo, d, Math.floor(minutes / 60)).getTime() + (minutes % 60) * 60 * 1000);
  const parseHm = (s) => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    return Number(m[2]) % 30 === 0 ? mins : null;
  };
  const ukHm = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

  app.get('/api/venue-manager/table-availability', requireVenueManager, (req, res, next) => (async () => {
    const { siteId } = walkinVenue(req, req.query.venueId);
    const { y, mo, d } = parseDay(req.query.day);
    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }
    const from = wall(y, mo, d, 0);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    let busy;
    try {
      busy = await tableBusyIntervals(siteId, tables, from, to);
    } catch (err) {
      throw walkinWixError(err, 'Could not check the existing bookings');
    }
    res.json({ busy: busy.map((b) => ({ tableId: b.tableId, start: b.start.toISOString(), end: b.end.toISOString() })) });
  })().catch(next));

  app.post('/api/venue-manager/walkins/book-all-tables', requireVenueManager, (req, res, next) => (async () => {
    const { venueId, day, tableId, startTime, endTime } = req.body || {};
    const tableIds = Array.isArray(req.body && req.body.tableIds) ? req.body.tableIds.map(String) : null;
    const { venue, siteId } = walkinVenue(req, venueId);
    const { y, mo, d, dow } = parseDay(day);
    const hours = WALKIN_OPENING_HOURS[dow];
    const dayOpenAt = wall(y, mo, d, hours.open);
    const dayCloseAt = wall(y, mo, d, hours.close);
    const now = Date.now();
    const nowFloored = new Date(Math.floor(now / (30 * 60 * 1000)) * 30 * 60 * 1000);
    if (dayOpenAt.getTime() > now + BLOCK_MAX_AHEAD_MS) throw new ApiError(400, 'Tables can be blocked up to 14 days ahead.');

    const timed = startTime != null || endTime != null;
    let startAt;
    let endAt = dayCloseAt;
    if (timed) {
      const startMin = parseHm(startTime);
      const endMin = parseHm(endTime);
      if (startMin == null || endMin == null) throw new ApiError(400, 'Choose a start and finish time on the hour or half hour.');
      if (startMin < hours.open || endMin > hours.close) throw new ApiError(400, 'Those times are outside opening hours.');
      if (endMin <= startMin) throw new ApiError(400, 'The finish time must be after the start time.');
      startAt = wall(y, mo, d, startMin);
      endAt = wall(y, mo, d, endMin);
      if (startAt.getTime() < nowFloored.getTime()) throw new ApiError(400, 'That start time has already passed.');
    } else {
      startAt = nowFloored.getTime() > dayOpenAt.getTime() ? nowFloored : dayOpenAt;
      if (startAt.getTime() >= dayCloseAt.getTime()) throw new ApiError(400, 'That day has already finished.');
    }

    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }

    let toBlock;
    if (tableIds) {
      toBlock = tables.filter((t) => tableIds.includes(t.id));
      if (!toBlock.length || toBlock.length !== new Set(tableIds).size) throw new ApiError(400, 'Choose at least one table.');
    } else if (tableId) {
      const single = tables.find((t) => t.id === tableId);
      if (!single) throw new ApiError(400, 'Table not found.');
      toBlock = [single];
    } else {
      toBlock = tables.filter((t) => !BOOK_ALL_EXCLUDE_RE.test(t.name));
      if (!toBlock.length) throw new ApiError(400, 'No other tables to book - only the 8 Ball / Chinese table is set up.');
    }

    if (timed) {
      let busy;
      try {
        busy = await tableBusyIntervals(siteId, tables, startAt, endAt);
      } catch (err) {
        throw walkinWixError(err, 'Could not check the existing bookings');
      }
      for (const table of toBlock) {
        const clash = busy.find((b) => b.tableId === table.id && b.start.getTime() < endAt.getTime() && b.end.getTime() > startAt.getTime());
        if (clash) {
          throw new ApiError(409, `${table.name} is already booked or blocked ${ukHm(clash.start)}-${ukHm(clash.end)}, which overlaps ${ukHm(startAt)}-${ukHm(endAt)}. Pick a different time.`);
        }
      }
    }

    const by = (req.adminSession && req.adminSession.label) || null;
    const title = by ? `Blocked by ${by}` : 'Blocked';
    const results = [];
    for (const table of toBlock) {
      try {
        await blockTableForDay(siteId, table, startAt, endAt, title);
        results.push({ table: table.name, ok: true, start: startAt.toISOString(), end: endAt.toISOString() });
      } catch (err) {
        results.push({ table: table.name, ok: false, error: err instanceof ApiError ? err.message : 'Wix would not take that block.' });
      }
    }

    const db = readDb();
    const outcome = results.map((r) => `${r.table} ${r.ok ? 'OK' : `FAILED - ${r.error}`}`).join('; ');
    recordAudit(db, {
      actor: by,
      action: 'venue.bookAllTables',
      targetType: 'venue',
      targetId: venue.id,
      details: timed
        ? `Blocked ${toBlock.map((t) => t.name).join(', ')} on ${day} ${ukHm(startAt)}-${ukHm(endAt)}: ${outcome}`
        : `Blocked ${toBlock.map((t) => t.name).join(', ')} for ${day}: ${outcome}`,
    });
    writeDb(db);
    res.json({ ok: true, day, excluded: [], results });
  })().catch(next));
}
