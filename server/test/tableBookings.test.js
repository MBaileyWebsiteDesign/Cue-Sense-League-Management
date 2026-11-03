// Run with: node --test test/   (from the server folder). No extra packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTableBookingRoutes } from '../src/routes/tableBookings.js';

const SITE = 'https://topspin.example.co.uk';
const TYPES = [
  { key: 'english', label: 'English pool' },
  { key: 'chinese8', label: 'Chinese 8 ball' },
];

function londonLocalString(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`;
}
// November: UK time = UTC, which is all these tests need.
const parseLondonLocal = (s) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? new Date(`${s}:00Z`) : null);

function harness({ settings = {}, wix = false } = {}) {
  const handlers = {};
  const reg = (m) => (p, ...fns) => { handlers[`${m} ${p}`] = fns[fns.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST') };
  const venue = {
    id: 'v1', name: 'Top Spin', tableCounts: { english: 14, chinese8: 1 }, wixBooking: wix ? undefined : false,
    tableBooking: {
      enabled: true, maxMinutes: 120, maxDaysAhead: 7, maxActive: 2, bufferMinutes: 5,
      tables: [
        { type: 'english', number: 13, label: 'Table 13', price: '£10 per hour' },
        { type: 'english', number: 1, label: 'Match Table 1', price: '£12 per hour' },
        { type: 'chinese8', number: 1, label: 'Chinese 8 Ball', price: '£10 per hour' },
      ],
      payNote: 'Pay at the bar.', policy: 'Please arrive on time.',
      guest: { enabled: true, origins: [SITE], manageUrl: `${SITE}/book.html` },
      ...settings,
    },
  };
  const db = {
    venues: [venue],
    users: [{ id: 'u1', firstName: 'Sam', lastName: 'Cue', email: 'sam@example.com', venueMemberships: [{ venueId: 'v1', renewalDate: '2027-01-01' }] }],
    tableBookings: [],
    auditLog: [],
  };
  const mails = [];
  let clock = Date.parse('2026-11-03T12:00:00Z');
  let n = 0;
  registerTableBookingRoutes(app, {
    requireAuth: () => {}, requireVenueManager: () => {}, assertVenueAccess: () => {},
    readDb: () => db, writeDb: () => {},
    asyncRoute: (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } },
    uuid: () => `id${++n}`,
    membershipAt: (u, vid) => (u.venueMemberships || []).find((m) => m.venueId === vid) || null,
    parseLondonLocal, londonLocalString,
    wixSiteIdForVenue: (v) => (v.wixBooking === false ? null : 'wix-site'),
    venueTableCounts: (v) => ({ english: 0, chinese8: 0, ...(v.tableCounts || {}) }),
    VENUE_TABLE_TYPES: TYPES,
    sendMail: (m) => { mails.push(m); return Promise.resolve({ sent: true }); },
    now: () => clock,
  });
  const call = (key, req = {}) => {
    let out; let error; let status = 200;
    const base = { query: {}, params: {}, body: {}, headers: {}, ip: '1.2.3.4', get: () => 'app.example', protocol: 'https' };
    handlers[key]({ ...base, ...req, headers: { ...base.headers, ...(req.headers || {}) } }, {
      status(s) { status = s; return this; },
      json(b) { out = b; },
    }, (e) => { error = e; });
    return { out, error, status };
  };
  const member = { auth: { user: db.users[0] } };
  const site = { headers: { origin: SITE } };
  const guestBook = (body) => call('POST /api/public/table-booking/bookings', { ...site, body: { name: 'Jo Guest', email: 'jo@example.com', phone: '07700 900123', ...body } });
  return { call, db, mails, member, site, guestBook, advance: (ms) => { clock += ms; } };
}

test('website booking info lists only the named tables with prices, policy and pay note', () => {
  const h = harness();
  const r = h.call('GET /api/public/table-booking', h.site);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.out.tables.map((t) => t.label), ['Table 13', 'Match Table 1', 'Chinese 8 Ball']);
  assert.equal(r.out.tables[1].price, '£12 per hour');
  assert.equal(r.out.payNote, 'Pay at the bar.');
  assert.equal(r.out.policy, 'Please arrive on time.');
  assert.equal(r.out.days[0], '2026-11-03');
});

test('guest booking is refused without the website origin', () => {
  const h = harness();
  assert.equal(h.call('GET /api/public/table-booking').error.status, 403);
  assert.equal(h.call('GET /api/public/table-booking', { headers: { origin: 'https://evil.example' } }).error.status, 403);
  const r = h.call('POST /api/public/table-booking/bookings', { body: { table: 'english-13', start: '2026-11-04T18:00', minutes: 60, name: 'A B', email: 'a@b.co', phone: '07700900123' } });
  assert.equal(r.error.status, 403);
});

test('guest booking is refused while the venue is still on Wix', () => {
  const h = harness({ wix: true });
  assert.equal(h.call('GET /api/public/table-booking', h.site).error.status, 403);
});

test('a guest can book a named table, gets an email with a manage link, and staff see it', () => {
  const h = harness();
  const r = h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60 });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 201);
  assert.equal(r.out.booking.table, 'Table 13');
  assert.ok(r.out.token.length >= 32);
  assert.ok(r.out.manageLink.startsWith(`${SITE}/book.html?booking=`));
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, 'jo@example.com');
  assert.match(h.mails[0].text, /Pay at the bar/);
  assert.match(h.mails[0].text, /book\.html\?booking=/);
  assert.equal(h.db.tableBookings[0].tokenHash.length, 64);
  assert.equal(h.db.tableBookings[0].token, undefined);
  const day = h.call('GET /api/venue-manager/table-booking/day', { query: { venueId: 'v1', day: '2026-11-04' } }).out;
  const t13 = day.tables.find((t) => t.label === 'Table 13');
  assert.equal(t13.bookings[0].who, 'Jo Guest');
  assert.equal(t13.bookings[0].kind, 'guest');
  assert.equal(t13.bookings[0].phone, '07700 900123');
  assert.equal(day.tables.length, 3);
});

test('guest details are required and the honeypot blocks bots', () => {
  const h = harness();
  assert.equal(h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60, email: 'nope' }).error.status, 400);
  assert.equal(h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60, phone: '12' }).error.status, 400);
  assert.equal(h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60, website: 'spam' }).error.status, 400);
  assert.equal(h.db.tableBookings.length, 0);
});

test('tables not on the bookable list cannot be booked by customers', () => {
  const h = harness();
  assert.equal(h.guestBook({ table: 'english-5', start: '2026-11-04T18:00', minutes: 60 }).error.status, 400);
  const r = h.call('POST /api/users/me/table-bookings', { ...h.member, body: { venueId: 'v1', table: 'english-5', start: '2026-11-04T18:00', minutes: 60 } });
  assert.equal(r.error.status, 400);
});

test('the 5 minute changeover blocks back-to-back bookings and offers a follow-on time', () => {
  const h = harness();
  assert.equal(h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60 }).status, 201);
  const clashR = h.guestBook({ table: 'english-13', start: '2026-11-04T19:00', minutes: 60, email: 'b@example.com' });
  assert.equal(clashR.error.status, 409);
  const av = h.call('GET /api/public/table-booking/availability', { ...h.site, query: { table: 'english-13', day: '2026-11-04' } }).out;
  const at = (t) => av.slots.find((s) => s.time === t);
  assert.equal(at('19:00').maxBlocks, 0);
  assert.ok(at('19:05').maxBlocks > 0);
  assert.equal(at('17:30').maxBlocks, 0); // 17:30-18:00 would leave no changeover
  assert.equal(h.guestBook({ table: 'english-13', start: '2026-11-04T19:05', minutes: 60, email: 'b@example.com' }).status, 201);
  // A different table is unaffected.
  assert.equal(h.guestBook({ table: 'english-1', start: '2026-11-04T19:00', minutes: 60, email: 'c@example.com' }).status, 201);
});

test('a guest can move and cancel with their token (no cut-off), not without it', () => {
  const h = harness();
  const { out } = h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60 });
  const id = out.booking.id;
  assert.equal(h.call('POST /api/public/table-booking/bookings/:id/cancel', { ...h.site, params: { id }, body: { token: 'wrong' } }).error.status, 404);
  const mv = h.call('POST /api/public/table-booking/bookings/:id/move', { ...h.site, params: { id }, body: { token: out.token, table: 'chinese8-1', start: '2026-11-05T20:00', minutes: 120 } });
  assert.equal(mv.error, undefined);
  assert.equal(mv.out.booking.table, 'Chinese 8 Ball');
  assert.equal(mv.out.booking.startTime, '20:00');
  assert.equal(h.mails.at(-1).subject.startsWith('Your booking has been moved'), true);
  // Moving onto its own old slot is fine (it ignores itself).
  const back = h.call('POST /api/public/table-booking/bookings/:id/move', { ...h.site, params: { id }, body: { token: out.token, table: 'chinese8-1', start: '2026-11-05T20:30', minutes: 60 } });
  assert.equal(back.error, undefined);
  h.advance((24 + 8) * 3600 * 1000 - 5 * 60 * 1000); // five minutes before it starts
  const c = h.call('POST /api/public/table-booking/bookings/:id/cancel', { ...h.site, params: { id }, body: { token: out.token } });
  assert.equal(c.error, undefined);
  assert.equal(h.db.tableBookings[0].status, 'cancelled');
  assert.match(h.mails.at(-1).subject, /cancelled/);
});

test('a move onto a taken time is refused and the booking stays put', () => {
  const h = harness();
  const a = h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60 }).out;
  h.guestBook({ table: 'english-13', start: '2026-11-04T20:00', minutes: 60, email: 'z@example.com' });
  const r = h.call('POST /api/public/table-booking/bookings/:id/move', { ...h.site, params: { id: a.booking.id }, body: { token: a.token, table: 'english-13', start: '2026-11-04T19:30', minutes: 60 } });
  assert.equal(r.error.status, 409);
  assert.equal(h.db.tableBookings[0].start, '2026-11-04T18:00:00.000Z');
});

test('members book named tables in the app, get an email, and can move their booking', () => {
  const h = harness();
  const v = h.call('GET /api/users/me/table-booking/venues', h.member).out;
  assert.equal(v[0].tables.length, 3);
  const r = h.call('POST /api/users/me/table-bookings', { ...h.member, body: { venueId: 'v1', table: 'english-1', start: '2026-11-04T18:00', minutes: 90 } });
  assert.equal(r.error, undefined);
  assert.equal(r.out.booking.table, 'Match Table 1');
  assert.equal(r.out.booking.price, '£12 per hour');
  assert.equal(h.mails[0].to, 'sam@example.com');
  const mv = h.call('POST /api/users/me/table-bookings/:id/move', { ...h.member, params: { id: r.out.booking.id }, body: { table: 'english-13', start: '2026-11-04T21:00', minutes: 60 } });
  assert.equal(mv.error, undefined);
  assert.equal(mv.out.booking.table, 'Table 13');
});

test('staff walk-ins can use any table and staff cancelling emails the customer', () => {
  const h = harness();
  const w = h.call('POST /api/venue-manager/table-bookings', { adminSession: { label: 'Bar' }, body: { venueId: 'v1', type: 'english', tableNumber: 5, start: '2026-11-04T18:00', minutes: 60, kind: 'walkin', name: 'Walk in' } });
  assert.equal(w.error, undefined);
  const g = h.guestBook({ table: 'english-13', start: '2026-11-04T18:00', minutes: 60 }).out;
  const c = h.call('POST /api/venue-manager/table-bookings/:id/cancel', { adminSession: { label: 'Bar' }, params: { id: g.booking.id } });
  assert.equal(c.error, undefined);
  assert.match(h.mails.at(-1).subject, /cancelled by the venue/);
  const day = h.call('GET /api/venue-manager/table-booking/day', { query: { venueId: 'v1', day: '2026-11-04' } }).out;
  assert.ok(day.tables.some((t) => t.number === 5 && t.bookings.length === 1)); // shown because it has a booking
});

test('settings save validates named tables, website origins and changeover', () => {
  const h = harness();
  const save = (body) => h.call('POST /api/venue-manager/venues/:id/table-booking', { adminSession: { label: 'Admin' }, params: { id: 'v1' }, body });
  assert.equal(save({ tables: [{ type: 'english', number: 99, label: 'X' }] }).error.status, 400);
  assert.equal(save({ guest: { origins: ['http://insecure.example'] } }).error.status, 400);
  assert.equal(save({ bufferMinutes: 7 }).error.status, 400);
  const ok = save({ bufferMinutes: 10, guest: { origins: 'https://a.example, https://b.example/path' } });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.out.settings.guest.origins, ['https://a.example', 'https://b.example']);
  assert.equal(ok.out.settings.bufferMinutes, 10);
});

test('only an Overall Admin can switch a venue between Wix and Cue Sense booking', () => {
  const h = harness({ wix: true });
  const sw = (user, system) => h.call('POST /api/venue-manager/venues/:id/booking-system', { auth: { user }, adminSession: { label: 'X' }, params: { id: 'v1' }, body: { system } });
  assert.equal(sw({ isAdmin: false }, 'cuesense').error.status, 403);
  const r = sw({ isAdmin: true }, 'cuesense');
  assert.equal(r.error, undefined);
  assert.equal(r.out.wixLinked, false);
  assert.equal(h.db.venues[0].wixBooking, false);
  const back = sw({ isAdmin: true }, 'wix');
  assert.equal(back.out.wixLinked, true);
  assert.equal(h.db.venues[0].tableBooking.enabled, false);
});

test('guest bookings are rate limited per connection', () => {
  const h = harness({ maxActive: 20 });
  let last;
  for (let i = 0; i < 9; i++) last = h.guestBook({ table: 'english-13', start: `2026-11-0${4 + Math.floor(i / 4)}T${12 + (i % 4) * 2}:00`, minutes: 60, email: `g${i}@example.com` });
  assert.equal(last.error.status, 429);
});
