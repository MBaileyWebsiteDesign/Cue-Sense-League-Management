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
}
