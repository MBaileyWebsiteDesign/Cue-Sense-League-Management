// Player Portal "My Bookings" card (Matt, 2026-09-26): a player's own view
// of, and ability to cancel, their table bookings across every venue linked
// to a Wix booking site (see wixSiteIdForVenue in server/src/index.js - Top
// Spin only for now, more venues will appear here automatically as they're
// linked the same way). Matched to the account purely by email (Wix's
// booking contact email vs the player's account email, case-insensitive) -
// a booking made under a different email won't show here or be cancellable
// from here. No cancellation cut-off: a player can cancel any of their own
// upcoming bookings right up until it starts, same as a Venue Manager can
// today. Kept in its own file since index.js is already very large; the
// helpers it needs (wixSiteIdForVenue, startOfTodayLondonIso,
// syncWixSiteIfDue, loadWixSnapshots, getWixBooking, cancelWixBooking,
// resyncAfterWalkin, walkinWixError) are passed in from index.js rather
// than re-implemented here, so there is exactly one copy of the Wix
// booking logic.
//
// Book a table (Matt, 2026-09-30): a player can also make a new booking for
// themselves, from the same "My Bookings" card - shown only when they have
// an active membership at a venue that has table booking set up (i.e. a
// linked Wix site). Reuses the exact same Wix booking helpers the Venue
// Manager's "Book walk-in" form uses (getWalkinTables, bookWalkinPart,
// assertWithinOpeningHours, the WALKIN_* limits) so there is one copy of
// the booking logic and the same rules apply (opening hours, 7-day-ahead
// limit, 1/2/3 hour lengths). The booking is made under the player's own
// name and account email, so it shows up in Wix like any other booking (not
// tagged as a walk-in), and a Venue Manager cancelling it later gets Wix's
// normal customer-cancellation notice rather than the silent walk-in one.
import { ApiError } from '../errors.js';
import { recordAudit } from '../services/auditLog.js';

export function registerPlayerBookingRoutes(app, {
  requireAuth,
  readDb,
  writeDb,
  wixSiteIdForVenue,
  startOfTodayLondonIso,
  syncWixSiteIfDue,
  loadWixSnapshots,
  getWixBooking,
  cancelWixBooking,
  resyncAfterWalkin,
  walkinWixError,
  asyncRoute,
  membershipAt,
  membershipActive,
  getWalkinTables,
  bookWalkinPart,
  assertWithinOpeningHours,
  parseLondonLocal,
  WALKIN_LENGTHS,
  WALKIN_OPENING_HOURS,
  WALKIN_MAX_AHEAD_MS,
}) {
  app.get('/api/users/me/bookings', requireAuth, asyncRoute(async (req, res) => {
    const myEmail = (req.auth.user.email || '').trim().toLowerCase();
    if (!myEmail) return res.json({ bookings: [] });
    const db = readDb();
    const fromIso = startOfTodayLondonIso();
    const bookings = [];
    for (const venue of db.venues) {
      const siteId = wixSiteIdForVenue(venue);
      if (!siteId || !process.env.WIX_API_KEY) continue;
      await syncWixSiteIfDue(siteId);
      const snap = loadWixSnapshots()[siteId] || { bookings: [] };
      for (const b of snap.bookings || []) {
        if (!b.start || new Date(b.start) < new Date(fromIso)) continue;
        if ((b.email || '') !== myEmail) continue;
        bookings.push({ ...b, venueId: venue.id, venueName: venue.name });
      }
    }
    bookings.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    res.json({ bookings });
  }));

  app.post('/api/users/me/bookings/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
    const myEmail = (req.auth.user.email || '').trim().toLowerCase();
    const { venueId } = req.body || {};
    if (!venueId) throw new ApiError(400, 'venueId is required');
    const db = readDb();
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    const siteId = wixSiteIdForVenue(venue);
    if (!siteId) throw new ApiError(400, 'This venue is not linked to a Wix booking site.');
    if (!process.env.WIX_API_KEY) throw new ApiError(503, 'Wix bookings are not connected yet.');
    const bookingId = String(req.params.id || '');
    let booking;
    try {
      booking = await getWixBooking(siteId, bookingId);
    } catch (err) {
      throw walkinWixError(err, 'Could not look up the booking on Wix');
    }
    if (!booking) throw new ApiError(404, 'That booking was not found.');
    const contact = booking.contactDetails || {};
    if ((contact.email || '').trim().toLowerCase() !== myEmail) {
      throw new ApiError(403, 'That booking is not on your account.');
    }
    if (booking.status === 'DECLINED') throw new ApiError(400, 'That booking was already declined.');
    if (booking.status !== 'CANCELED') {
      try {
        await cancelWixBooking(siteId, bookingId, true, booking);
      } catch (err) {
        throw walkinWixError(err, 'Wix would not cancel the booking');
      }
    }
    const who = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Player';
    recordAudit(db, {
      actor: `${req.auth.user.firstName} ${req.auth.user.lastName}`,
      action: 'venue.playerBookingCancel',
      targetType: 'venue',
      targetId: venue.id,
      details: `${who} cancelled their own booking on Wix: ${venue.name} (${bookingId})`,
    });
    writeDb(db);
    await resyncAfterWalkin(siteId);
    res.json({ ok: true });
  }));

  // Venues a player can book a table at right now: an active membership
  // there, and the venue has table booking set up (a linked Wix site). This
  // is what the "Book a table" section in My Bookings is gated on - it's
  // hidden entirely when this list is empty.
  app.get('/api/users/me/booking-venues', requireAuth, asyncRoute(async (req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const venues = db.venues
      .filter((v) => membershipActive(membershipAt(user, v.id)) && !!wixSiteIdForVenue(v) && !!process.env.WIX_API_KEY)
      .map((v) => ({ id: v.id, name: v.name }));
    res.json(venues);
  }));

  // Tables/lengths/opening hours for one of those venues - same shape and
  // same Wix data as the Venue Manager's walk-in-tables endpoint.
  app.get('/api/users/me/booking-tables', requireAuth, asyncRoute(async (req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const venue = db.venues.find((v) => v.id === req.query.venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    if (!membershipActive(membershipAt(user, venue.id))) {
      throw new ApiError(403, 'You need an active membership at this venue to book a table.');
    }
    const siteId = wixSiteIdForVenue(venue);
    if (!siteId) throw new ApiError(400, 'This venue does not have table booking set up.');
    if (!process.env.WIX_API_KEY) throw new ApiError(503, 'Table booking is not connected yet.');
    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }
    res.json({
      tables: tables.map((t) => ({ id: t.id, name: t.name })),
      lengths: WALKIN_LENGTHS,
      openingHours: WALKIN_OPENING_HOURS,
    });
  }));

  // Make a new booking for yourself - same rules (opening hours, 7-day-ahead
  // limit, 1/2/3 hour lengths, 3 hours split into a 2h + 1h Wix booking) as
  // the Venue Manager's walk-in booking, gated on an active membership at
  // the venue instead of venue-manager access.
  app.post('/api/users/me/bookings', requireAuth, asyncRoute(async (req, res) => {
    const { venueId, tableId, start, minutes } = req.body || {};
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id);
    if (!user) throw new ApiError(404, 'Account not found');
    if (!user.email) throw new ApiError(400, 'Your account needs an email address to book a table.');
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    if (!membershipActive(membershipAt(user, venue.id))) {
      throw new ApiError(403, 'You need an active membership at this venue to book a table.');
    }
    const siteId = wixSiteIdForVenue(venue);
    if (!siteId) throw new ApiError(400, 'This venue does not have table booking set up.');
    if (!process.env.WIX_API_KEY) throw new ApiError(503, 'Table booking is not connected yet.');

    const mins = Number(minutes);
    if (!WALKIN_LENGTHS.includes(mins)) throw new ApiError(400, 'Length must be 1, 2 or 3 hours.');
    const startAt = parseLondonLocal(start);
    if (!startAt || ![0, 30].includes(startAt.getUTCMinutes())) {
      throw new ApiError(400, 'Start time must be on the hour or half past (UK time).');
    }
    const now = Date.now();
    if (startAt.getTime() + 30 * 60 * 1000 <= now) throw new ApiError(400, 'That start time has already passed.');
    if (startAt.getTime() > now + WALKIN_MAX_AHEAD_MS) throw new ApiError(400, 'Tables can be booked up to 7 days ahead.');
    assertWithinOpeningHours(start, mins);

    let tables;
    try {
      tables = await getWalkinTables(siteId);
    } catch (err) {
      throw walkinWixError(err, 'Could not load the tables from Wix');
    }
    const table = tables.find((t) => t.id === tableId);
    if (!table) throw new ApiError(400, 'Choose a table.');

    const contact = { firstName: user.firstName, lastName: user.lastName, email: user.email };
    const parts = mins === 180 ? [120, 60] : [mins];
    const created = [];
    let cursor = startAt;
    try {
      for (const len of parts) {
        const partEnd = new Date(cursor.getTime() + len * 60 * 1000);
        created.push(await bookWalkinPart(siteId, table, cursor, partEnd, contact));
        cursor = partEnd;
      }
    } catch (err) {
      // Don't leave half a booking behind (e.g. the 2h part of a 3h booking).
      for (const b of created) {
        try { await cancelWixBooking(siteId, b.id); } catch (e) { console.warn('Could not undo booking part:', e.message); }
      }
      if (created.length) resyncAfterWalkin(siteId);
      throw walkinWixError(err, 'Wix would not take that booking');
    }

    const endAt = cursor;
    recordAudit(db, {
      actor: `${user.firstName} ${user.lastName}`,
      action: 'venue.playerBooking',
      targetType: 'venue',
      targetId: venue.id,
      details: `${user.firstName} ${user.lastName} booked ${table.name} at ${venue.name} from their account: ${startAt.toISOString().slice(0, 16).replace('T', ' ')} for ${mins} min (${created.map((b) => b.id).join(', ')})`,
    });
    writeDb(db);
    await resyncAfterWalkin(siteId);
    res.json({
      ok: true,
      table: table.name,
      start: startAt.toISOString(),
      end: endAt.toISOString(),
      bookingIds: created.map((b) => b.id),
    });
  }));
}
