// Table booking (Matt, 2026-10-26; extended 2026-11-03 for Top Spin).
//
// Venues that do NOT use the Wix booking system can switch on their own table
// booking. A venue that was linked to Wix (Top Spin) is moved over by an
// Overall Admin with POST /api/venue-manager/venues/:id/booking-system, which
// sets venue.wixBooking = false (see wixSiteIdForVenue in index.js).
//
// Two ways to offer tables:
//   - by TYPE (default): members pick English pool / Chinese 8 ball / ... and
//     the server assigns the lowest-numbered free table of that type.
//   - by NAMED TABLE: when settings.tables is set (e.g. Top Spin: "Table 13",
//     "Match Table 1-3", "Chinese 8 Ball"), ONLY those tables can be booked by
//     customers, each with its own name and price text, and the customer picks
//     the table. Staff walk-ins and blocks can still use any table.
//
// Who can book:
//   - members of the venue, in the app (/api/users/me/table-...)
//   - non-members ("guests") ONLY from the venue's own website: the
//     /api/public/table-booking endpoints accept a request only when its Origin
//     header is one of settings.guest.origins. Guests give name, email and
//     phone and get a private manage link (booking id + token) to move or
//     cancel.
// Customers (members and guests) can move and cancel their own bookings at
// any time before the booking starts (no cut-off), as long as the new time is
// free. settings.bufferMinutes is the changeover gap kept between a customer
// booking and any other booking on the same table.
//
// Confirmation emails (MailerSend, same as the rest of the app) go to the
// customer when they book, move or cancel, and when the venue cancels their
// booking. No emails go to the venue - bookings show in the Venue portal.
// No online payment: prices are shown with settings.payNote ("pay at the bar").
//
// Data: db.tableBookings = [{ id, venueId, type, tableNumber, kind
//   ('player'|'guest'|'walkin'|'block'), userId (player), guest: { name, email,
//   phone } (guest), tokenHash (guest), name (walk-in), note, start, end (ISO
//   UTC), status ('active'|'cancelled'), createdAt, createdBy, movedAt,
//   cancelledAt, cancelledBy }]
// Per-venue settings: venue.tableBooking = { enabled, hours: { 0..6: { open,
//   close } | null } (0 = Sunday, UK time), maxMinutes, maxDaysAhead, maxActive,
//   bufferMinutes, tables: [{ type, number, label, price }], policy, payNote,
//   guest: { enabled, origins: [https origin], manageUrl } }.
import crypto from 'node:crypto';
import { ApiError } from '../errors.js';
import { recordAudit } from '../services/auditLog.js';
import { sendMail as realSendMail, emailHtml, escapeHtml, baseUrlFor } from '../mailer.js';

export const SLOT_MIN = 30;
const SLOT_MS = SLOT_MIN * 60 * 1000;
const STEP_MIN = 5; // follow-on start times after a changeover land on 5 minutes
const DEFAULTS = { open: '10:00', close: '23:00', maxMinutes: 120, maxDaysAhead: 14, maxActive: 2 };
const TIME_RE = /^(?:[01]\d|2[0-3]):(?:00|30)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const GUEST_RATE = { max: 8, windowMs: 60 * 60 * 1000 };

function toMin(hhmm) {
  if (hhmm === '24:00') return 1440;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fromMin(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function dayOfWeek(day) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
function addDays(day, n) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}
function todayUk(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(now));
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
function normOrigin(o) {
  try {
    const u = new URL(String(o).trim());
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}
const lenLabel = (mins) => {
  const h = Math.floor(mins / 60); const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
};
const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function registerTableBookingRoutes(app, {
  requireAuth,
  requireVenueManager,
  assertVenueAccess,
  readDb,
  writeDb,
  asyncRoute,
  uuid,
  membershipAt,
  parseLondonLocal,
  londonLocalString,
  wixSiteIdForVenue,
  venueTableCounts,
  VENUE_TABLE_TYPES,
  sendMail = realSendMail,
  now: clock = () => Date.now(),
}) {
  const typeDef = (key) => VENUE_TABLE_TYPES.find((t) => t.key === key) || null;

  function settingsOf(venue) {
    const raw = (venue && venue.tableBooking && typeof venue.tableBooking === 'object') ? venue.tableBooking : {};
    const hours = {};
    for (let d = 0; d < 7; d++) {
      const h = raw.hours && Object.prototype.hasOwnProperty.call(raw.hours, String(d)) ? raw.hours[String(d)] : undefined;
      if (h === null) hours[d] = null;
      else if (h && TIME_RE.test(h.open) && (TIME_RE.test(h.close) || h.close === '24:00') && toMin(h.close) > toMin(h.open)) hours[d] = { open: h.open, close: h.close };
      else hours[d] = { open: DEFAULTS.open, close: DEFAULTS.close };
    }
    const int = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
    const mm = int(raw.maxMinutes, SLOT_MIN, 480, DEFAULTS.maxMinutes);
    const counts = venueTableCounts(venue);
    const seen = new Set();
    const tables = (Array.isArray(raw.tables) ? raw.tables : []).filter((t) => {
      if (!t || !typeDef(t.type) || !Number.isInteger(t.number) || t.number < 1 || t.number > (counts[t.type] || 0)) return false;
      const k = `${t.type}-${t.number}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((t) => ({ type: t.type, number: t.number, label: str(t.label, 40) || `${typeDef(t.type).label} ${t.number}`, price: str(t.price, 60) }));
    const g = raw.guest && typeof raw.guest === 'object' ? raw.guest : {};
    return {
      enabled: raw.enabled === true,
      hours,
      maxMinutes: mm - (mm % SLOT_MIN),
      maxDaysAhead: int(raw.maxDaysAhead, 1, 90, DEFAULTS.maxDaysAhead),
      maxActive: int(raw.maxActive, 1, 20, DEFAULTS.maxActive),
      bufferMinutes: int(raw.bufferMinutes, 0, 30, 0),
      tables,
      policy: str(raw.policy, 2000),
      payNote: str(raw.payNote, 300),
      guest: {
        enabled: g.enabled === true,
        origins: (Array.isArray(g.origins) ? g.origins : []).map(normOrigin).filter(Boolean).slice(0, 5),
        manageUrl: typeof g.manageUrl === 'string' && /^https:\/\//.test(g.manageUrl) ? g.manageUrl.slice(0, 300) : '',
      },
    };
  }

  const named = (s) => s.tables.length > 0;
  const tableKey = (type, n) => `${type}-${n}`;
  const namedEntry = (s, type, n) => s.tables.find((t) => t.type === type && t.number === n) || null;
  const labelFor = (s, type, n) => {
    const e = s ? namedEntry(s, type, n) : null;
    return e ? e.label : `${(typeDef(type) || { label: type }).label} ${n}`;
  };
  const venueLabel = (venue, type, n) => labelFor(settingsOf(venue), type, n);

  const typesFor = (venue) => {
    const counts = venueTableCounts(venue);
    return VENUE_TABLE_TYPES.filter((t) => counts[t.key] > 0).map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }));
  };
  // What customers see: in named mode only the named tables' types.
  const customerTypes = (venue, s) => {
    const all = typesFor(venue);
    if (!named(s)) return all;
    return all.filter((t) => s.tables.some((x) => x.type === t.key)).map((t) => ({ ...t, count: s.tables.filter((x) => x.type === t.key).length }));
  };
  const customerTables = (s) => s.tables.map((t) => ({ key: tableKey(t.type, t.number), type: t.type, number: t.number, label: t.label, price: t.price }));

  const activeFor = (db, venueId) => (db.tableBookings || []).filter((b) => b.venueId === venueId && b.status === 'active');
  // buf = changeover minutes kept free either side of the new booking.
  const clash = (b, startMs, endMs, buf = 0) => Date.parse(b.start) < endMs + buf * 60000 && Date.parse(b.end) + buf * 60000 > startMs;
  const tableFree = (list, type, number, startMs, endMs, ignoreId, buf = 0) => !list.some((b) => b.type === type && b.tableNumber === number && b.id !== ignoreId && clash(b, startMs, endMs, buf));
  function findFreeTable(list, venue, type, startMs, endMs) {
    const count = venueTableCounts(venue)[type] || 0;
    for (let n = 1; n <= count; n++) if (tableFree(list, type, n, startMs, endMs)) return n;
    return null;
  }
  const localHM = (iso) => londonLocalString(new Date(iso)).slice(11, 16);
  const localDay = (iso) => londonLocalString(new Date(iso)).slice(0, 10);

  // Tables a customer request may land on: one named table (table=key), or
  // every bookable table of a type.
  function candidates(venue, s, { table, type }) {
    if (table) {
      const m = /^([a-z0-9]+)-(\d+)$/.exec(String(table));
      const t = m && (named(s) ? namedEntry(s, m[1], Number(m[2])) : null);
      if (!t) throw new ApiError(400, 'Choose a table.');
      return [[t.type, t.number]];
    }
    if (!typeDef(type) || !(venueTableCounts(venue)[type] > 0)) throw new ApiError(400, named(s) ? 'Choose a table.' : 'Choose a table type.');
    if (named(s)) {
      const list = s.tables.filter((t) => t.type === type).map((t) => [t.type, t.number]);
      if (list.length === 0) throw new ApiError(400, 'Choose a table.');
      return list;
    }
    const count = venueTableCounts(venue)[type];
    return Array.from({ length: count }, (_, i) => [type, i + 1]);
  }

  // A member may book if registered; where the venue runs memberships the
  // membership must still be live on the booking day (UK date).
  function memberOkOn(user, venue, day) {
    const m = membershipAt(user, venue.id);
    if (!m) return false;
    if (venue.membershipEnabled === false) return true;
    return !!m.renewalDate && String(m.renewalDate) >= day;
  }
  function openDays(settings, last, now) {
    const days = [];
    for (let d = todayUk(now); d <= last; d = addDays(d, 1)) if (settings.hours[dayOfWeek(d)]) days.push(d);
    return days;
  }
  function bookableDays(user, venue, settings, now = clock()) {
    let last = addDays(todayUk(now), settings.maxDaysAhead);
    const m = membershipAt(user, venue.id);
    if (venue.membershipEnabled !== false && m && m.renewalDate && String(m.renewalDate) < last) last = String(m.renewalDate);
    return openDays(settings, last, now);
  }
  const guestDays = (settings, now = clock()) => openDays(settings, addDays(todayUk(now), settings.maxDaysAhead), now);

  function availability(db, venue, settings, cands, day, now = clock(), ignoreId) {
    const hours = settings.hours[dayOfWeek(day)];
    if (!hours) return { closed: true, open: null, close: null, slots: [] };
    const list = activeFor(db, venue.id);
    const buf = settings.bufferMinutes;
    const openM = toMin(hours.open);
    const closeM = toMin(hours.close);
    // Start times: every 30 minutes, plus the first time after each existing
    // booking's changeover (e.g. 19:05 after a booking ending at 19:00).
    const starts = new Set();
    for (let m = openM; m < closeM; m += SLOT_MIN) starts.add(m);
    for (const b of list) {
      if (b.id === ignoreId || localDay(b.end) !== day) continue;
      if (!cands.some(([t, n]) => b.type === t && b.tableNumber === n)) continue;
      const hm = localHM(b.end);
      let m = toMin(hm) + buf;
      m = Math.ceil(m / STEP_MIN) * STEP_MIN;
      if (m > openM && m < closeM) starts.add(m);
    }
    const slots = [];
    for (const m of [...starts].sort((a, b) => a - b)) {
      const time = fromMin(m);
      const start = parseLondonLocal(`${day}T${time}`);
      if (!start) continue;
      const startMs = start.getTime();
      if (startMs <= now) { slots.push({ time, maxBlocks: 0 }); continue; }
      const cap = Math.floor(Math.min(settings.maxMinutes, closeM - m) / SLOT_MIN);
      let best = 0;
      for (const [t, n] of cands) {
        let blocks = 0;
        while (blocks < cap && tableFree(list, t, n, startMs, startMs + (blocks + 1) * SLOT_MS, ignoreId, buf)) blocks++;
        if (blocks > best) best = blocks;
      }
      // Follow-on times only appear when something can actually be booked.
      if (best === 0 && m % SLOT_MIN !== 0) continue;
      slots.push({ time, maxBlocks: best });
    }
    return { closed: false, open: hours.open, close: hours.close, slots };
  }

  const shapeMine = (db, b) => {
    const v = db.venues.find((x) => x.id === b.venueId);
    const s = v ? settingsOf(v) : null;
    const e = s ? namedEntry(s, b.type, b.tableNumber) : null;
    return {
      id: b.id, venueId: b.venueId, venueName: v ? v.name : 'Venue', type: b.type,
      tableKey: tableKey(b.type, b.tableNumber),
      table: labelFor(s, b.type, b.tableNumber), price: e ? e.price : '', day: localDay(b.start), startTime: localHM(b.start),
      endTime: localHM(b.end), minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000),
      start: b.start, end: b.end, status: b.status,
    };
  };

  function parseStart(start) {
    const dt = parseLondonLocal(start);
    if (!dt || Number(String(start).slice(14, 16)) % STEP_MIN !== 0) throw new ApiError(400, 'Choose one of the start times shown.');
    return dt;
  }
  function parseMinutes(minutes, max) {
    const mins = Number(minutes);
    if (!Number.isInteger(mins) || mins < SLOT_MIN || mins % SLOT_MIN !== 0) throw new ApiError(400, 'Length must be in 30 minute blocks.');
    if (mins > max) throw new ApiError(400, `The longest booking here is ${max} minutes.`);
    return mins;
  }

  // Check a customer request and find the table it lands on.
  function placeCustomer(db, venue, s, { cands, start, minutes, ignoreId }) {
    const startAt = parseStart(start);
    const mins = parseMinutes(minutes, s.maxMinutes);
    const day = String(start).slice(0, 10);
    const now = clock();
    if (startAt.getTime() <= now) throw new ApiError(400, 'That start time has already passed.');
    if (day > addDays(todayUk(now), s.maxDaysAhead)) throw new ApiError(400, `Tables can be booked up to ${s.maxDaysAhead} days ahead.`);
    const hours = s.hours[dayOfWeek(day)];
    const startM = Number(String(start).slice(11, 13)) * 60 + Number(String(start).slice(14, 16));
    if (!hours || startM < toMin(hours.open) || startM + mins > toMin(hours.close)) throw new ApiError(400, 'That time is outside the venue’s booking hours.');
    const endMs = startAt.getTime() + mins * 60 * 1000;
    const list = activeFor(db, venue.id);
    const hit = cands.find(([t, n]) => tableFree(list, t, n, startAt.getTime(), endMs, ignoreId, s.bufferMinutes));
    if (!hit) throw new ApiError(409, 'Sorry, that time is not free. Please pick another.');
    return { type: hit[0], number: hit[1], startIso: startAt.toISOString(), endIso: new Date(endMs).toISOString(), day };
  }

  // ---------------- Emails ----------------
  function bookingEmail(what, { to, name, venue, b, manageLink, manageText }) {
    if (!to) return;
    const s = settingsOf(venue);
    const e = namedEntry(s, b.type, b.tableNumber);
    const table = labelFor(s, b.type, b.tableNumber);
    const day = localDay(b.start);
    const when = `${dayLong(day)}, ${localHM(b.start)}–${localHM(b.end)} (${lenLabel(Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000))})`;
    const heading = {
      booked: 'Your table is booked',
      moved: 'Your booking has been moved',
      cancelled: 'Your booking is cancelled',
      venueCancelled: 'Your booking has been cancelled by the venue',
    }[what];
    const lines = [
      ['Venue', venue.name],
      ['Table', table],
      ['When', when],
    ];
    if (e && e.price && what !== 'cancelled' && what !== 'venueCancelled') lines.push(['Price', e.price]);
    const rows = lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${escapeHtml(k)}</td><td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`).join('');
    const live = what === 'booked' || what === 'moved';
    const html = emailHtml(heading, [
      `<p>Hi ${escapeHtml(name || 'there')},</p>`,
      `<table style="border-collapse:collapse;margin:8px 0 12px">${rows}</table>`,
      live && s.payNote ? `<p>${escapeHtml(s.payNote)}</p>` : '',
      live && manageLink ? `<p><a href="${escapeHtml(manageLink)}">${escapeHtml(manageText || 'Move or cancel this booking')}</a></p>` : '',
      live && s.policy ? `<p style="color:#555;font-size:13px;white-space:pre-line">${escapeHtml(s.policy)}</p>` : '',
    ].join('\n'));
    const text = [
      `Hi ${name || 'there'},`, '', heading, '',
      ...lines.map(([k, v]) => `${k}: ${v}`), '',
      live && s.payNote ? s.payNote : '',
      live && manageLink ? `${manageText || 'Move or cancel this booking'}: ${manageLink}` : '',
      live && s.policy ? `\n${s.policy}` : '',
    ].filter((x) => x !== '').join('\n');
    // Best-effort - sendMail never throws, and the booking never waits on it.
    Promise.resolve(sendMail({ to, toName: name, subject: `${heading} - ${venue.name}`, text, html })).catch(() => {});
  }
  const guestManageLink = (s, b, token) => (s.guest.manageUrl && token
    ? `${s.guest.manageUrl}${s.guest.manageUrl.includes('?') ? '&' : '?'}booking=${encodeURIComponent(b.id)}&token=${encodeURIComponent(token)}`
    : '');
  function emailCustomer(db, what, venue, b, req, token) {
    if (b.kind === 'guest' && b.guest) {
      const s = settingsOf(venue);
      bookingEmail(what, { to: b.guest.email, name: b.guest.name, venue, b, manageLink: guestManageLink(s, b, token) });
    } else if (b.kind === 'player') {
      const u = db.users.find((x) => x.id === b.userId);
      if (!u || !u.email) return;
      let link = '';
      try { link = req ? baseUrlFor(req) : ''; } catch { link = ''; }
      bookingEmail(what, { to: u.email, name: u.firstName, venue, b, manageLink: link, manageText: 'Move or cancel it in the Cue Sense app' });
    }
  }

  // ---------------- Player (members, in the app) ----------------
  const playerVenueOut = (v, s, user) => ({
    id: v.id, name: v.name, types: customerTypes(v, s), tables: customerTables(s), days: bookableDays(user, v, s),
    maxMinutes: s.maxMinutes, maxDaysAhead: s.maxDaysAhead, maxActive: s.maxActive,
    bufferMinutes: s.bufferMinutes, policy: s.policy, payNote: s.payNote,
  });

  app.get('/api/users/me/table-booking/venues', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const out = [];
    for (const v of db.venues) {
      const s = settingsOf(v);
      if (!s.enabled || wixSiteIdForVenue(v)) continue;
      if (customerTypes(v, s).length === 0) continue;
      if (!membershipAt(user, v.id)) continue;
      if (v.membershipEnabled !== false && !memberOkOn(user, v, todayUk(clock()))) continue;
      out.push(playerVenueOut(v, s, user));
    }
    res.json(out);
  }));

  const ownBooking = (db, req, id) => {
    const b = (db.tableBookings || []).find((x) => x.id === id);
    if (!b || b.userId !== req.auth.user.id || b.kind !== 'player') throw new ApiError(404, 'That booking was not found.');
    return b;
  };

  app.get('/api/users/me/table-booking/availability', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const venue = db.venues.find((v) => v.id === req.query.venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    const s = settingsOf(venue);
    if (!s.enabled || wixSiteIdForVenue(venue)) throw new ApiError(400, 'Table booking is not switched on at this venue.');
    const cands = candidates(venue, s, { table: req.query.table, type: String(req.query.type || '') });
    const day = String(req.query.day || '');
    if (!DAY_RE.test(day)) throw new ApiError(400, 'Choose a day.');
    if (!bookableDays(user, venue, s).includes(day)) throw new ApiError(400, 'That day cannot be booked.');
    if (!memberOkOn(user, venue, day)) throw new ApiError(403, 'You need to be a member of this venue to book a table.');
    const ignore = req.query.ignore ? ownBooking(db, req, String(req.query.ignore)).id : undefined;
    res.json({ ...availability(db, venue, s, cands, day, clock(), ignore), maxMinutes: s.maxMinutes });
  }));

  app.get('/api/users/me/table-bookings', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const now = clock();
    const mine = (db.tableBookings || [])
      .filter((b) => b.status === 'active' && b.userId === req.auth.user.id && Date.parse(b.end) > now)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((b) => shapeMine(db, b));
    res.json({ bookings: mine });
  }));

  function memberVenue(db, req, venueId, day) {
    const user = db.users.find((u) => u.id === req.auth.user.id);
    if (!user) throw new ApiError(404, 'Account not found');
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    const s = settingsOf(venue);
    if (!s.enabled || wixSiteIdForVenue(venue)) throw new ApiError(400, 'Table booking is not switched on at this venue.');
    if (day && !memberOkOn(user, venue, day)) throw new ApiError(403, 'You need to be a member of this venue to book a table.');
    return { user, venue, s };
  }

  app.post('/api/users/me/table-bookings', requireAuth, asyncRoute((req, res) => {
    const { venueId, type, table, start, minutes } = req.body || {};
    const db = readDb();
    if (!Array.isArray(db.tableBookings)) db.tableBookings = [];
    const { user, venue, s } = memberVenue(db, req, venueId, String(start || '').slice(0, 10));
    const cands = candidates(venue, s, { table, type });
    const now = clock();
    const active = activeFor(db, venue.id).filter((b) => b.kind === 'player' && b.userId === user.id && Date.parse(b.end) > now);
    if (active.length >= s.maxActive) throw new ApiError(400, `You can have ${s.maxActive} upcoming booking${s.maxActive === 1 ? '' : 's'} at a time here. Cancel one to book another.`);
    const p = placeCustomer(db, venue, s, { cands, start, minutes });
    const booking = {
      id: uuid(), venueId: venue.id, type: p.type, tableNumber: p.number, kind: 'player', userId: user.id,
      start: p.startIso, end: p.endIso, status: 'active',
      createdAt: new Date(now).toISOString(), createdBy: `${user.firstName} ${user.lastName}`,
    };
    db.tableBookings.push(booking);
    recordAudit(db, {
      actor: `${user.firstName} ${user.lastName}`, action: 'venue.table_booking', targetType: 'venue', targetId: venue.id,
      details: `${user.firstName} ${user.lastName} booked ${labelFor(s, p.type, p.number)} at ${venue.name}: ${p.day} ${localHM(booking.start)}-${localHM(booking.end)}`,
    });
    writeDb(db);
    emailCustomer(db, 'booked', venue, booking, req);
    res.status(201).json({ ok: true, booking: shapeMine(db, booking) });
  }));

  function moveBooking(db, venue, s, b, body, actor) {
    if (b.status !== 'active') throw new ApiError(400, 'That booking was cancelled.');
    if (Date.parse(b.start) <= clock()) throw new ApiError(400, 'That booking has already started.');
    const cands = candidates(venue, s, { table: body.table, type: body.type || (named(s) ? undefined : b.type) });
    const p = placeCustomer(db, venue, s, { cands, start: body.start, minutes: body.minutes, ignoreId: b.id });
    const before = `${labelFor(s, b.type, b.tableNumber)} ${localDay(b.start)} ${localHM(b.start)}`;
    Object.assign(b, { type: p.type, tableNumber: p.number, start: p.startIso, end: p.endIso, movedAt: new Date(clock()).toISOString() });
    recordAudit(db, {
      actor, action: 'venue.table_booking_move', targetType: 'venue', targetId: venue.id,
      details: `${actor} moved a booking at ${venue.name} from ${before} to ${labelFor(s, p.type, p.number)} ${p.day} ${localHM(b.start)}-${localHM(b.end)}`,
    });
  }

  app.post('/api/users/me/table-bookings/:id/move', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const b = ownBooking(db, req, req.params.id);
    const { user, venue, s } = memberVenue(db, req, b.venueId, String((req.body || {}).start || '').slice(0, 10));
    moveBooking(db, venue, s, b, req.body || {}, `${user.firstName} ${user.lastName}`);
    writeDb(db);
    emailCustomer(db, 'moved', venue, b, req);
    res.json({ ok: true, booking: shapeMine(db, b) });
  }));

  app.post('/api/users/me/table-bookings/:id/cancel', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const b = ownBooking(db, req, req.params.id);
    if (b.status !== 'active') throw new ApiError(400, 'That booking was already cancelled.');
    if (Date.parse(b.start) <= clock()) throw new ApiError(400, 'That booking has already started.');
    b.status = 'cancelled';
    b.cancelledAt = new Date(clock()).toISOString();
    b.cancelledBy = `${req.auth.user.firstName} ${req.auth.user.lastName}`;
    const v = db.venues.find((x) => x.id === b.venueId);
    recordAudit(db, {
      actor: b.cancelledBy, action: 'venue.table_booking_cancel', targetType: 'venue', targetId: b.venueId,
      details: `${b.cancelledBy} cancelled their booking of ${v ? venueLabel(v, b.type, b.tableNumber) : b.type} at ${v ? v.name : 'venue'}: ${localDay(b.start)} ${localHM(b.start)}`,
    });
    writeDb(db);
    if (v) emailCustomer(db, 'cancelled', v, b, req);
    res.json({ ok: true });
  }));

  // ---------------- Guests (non-members, from the venue's website only) ----------------
  const guestHits = new Map(); // ip -> [ms]
  function guestRateOk(req) {
    const ip = String(req.headers['fly-client-ip'] || req.ip || 'unknown');
    const t = clock();
    const list = (guestHits.get(ip) || []).filter((x) => t - x < GUEST_RATE.windowMs);
    if (list.length >= GUEST_RATE.max) { guestHits.set(ip, list); return false; }
    list.push(t);
    guestHits.set(ip, list);
    return true;
  }
  const originOf = (req) => normOrigin((req.headers && (req.headers.origin || req.headers.Origin)) || '');
  function guestVenue(req) {
    const origin = originOf(req);
    const db = readDb();
    if (!origin) throw new ApiError(403, 'Online booking is only available through the venue’s website.');
    const venue = db.venues.find((v) => {
      const s = settingsOf(v);
      return s.enabled && s.guest.enabled && !wixSiteIdForVenue(v) && s.guest.origins.includes(origin);
    });
    if (!venue) throw new ApiError(403, 'Online booking is only available through the venue’s website.');
    const s = settingsOf(venue);
    if (!named(s) && typesFor(venue).length === 0) throw new ApiError(400, 'Table booking is not set up yet.');
    return { db, venue, s };
  }
  function guestBooking(db, venue, id, token) {
    const b = (db.tableBookings || []).find((x) => x.id === String(id || ''));
    const ok = b && b.kind === 'guest' && b.venueId === venue.id && b.tokenHash && token
      && crypto.timingSafeEqual(Buffer.from(b.tokenHash), Buffer.from(sha(token)));
    if (!ok) throw new ApiError(404, 'That booking was not found. Please use the link in your confirmation email.');
    return b;
  }
  const guestOut = (db, b) => ({ ...shapeMine(db, b), name: b.guest ? b.guest.name : '' });

  app.get('/api/public/table-booking', asyncRoute((req, res) => {
    const { venue, s } = guestVenue(req);
    res.json({
      venue: { id: venue.id, name: venue.name },
      types: customerTypes(venue, s), tables: customerTables(s), days: guestDays(s),
      maxMinutes: s.maxMinutes, maxDaysAhead: s.maxDaysAhead, bufferMinutes: s.bufferMinutes,
      policy: s.policy, payNote: s.payNote,
    });
  }));

  app.get('/api/public/table-booking/availability', asyncRoute((req, res) => {
    const { db, venue, s } = guestVenue(req);
    const cands = candidates(venue, s, { table: req.query.table, type: String(req.query.type || '') });
    const day = String(req.query.day || '');
    if (!DAY_RE.test(day) || !guestDays(s).includes(day)) throw new ApiError(400, 'That day cannot be booked.');
    const ignore = req.query.booking ? guestBooking(db, venue, req.query.booking, req.query.token).id : undefined;
    res.json({ ...availability(db, venue, s, cands, day, clock(), ignore), maxMinutes: s.maxMinutes });
  }));

  app.post('/api/public/table-booking/bookings', asyncRoute((req, res) => {
    const body = req.body || {};
    const { db, venue, s } = guestVenue(req);
    if (body.website) throw new ApiError(400, 'Booking could not be made.'); // honeypot field
    const name = str(body.name, 80);
    const email = str(body.email, 120).toLowerCase();
    const phone = str(body.phone, 30);
    if (name.length < 2) throw new ApiError(400, 'Please enter your name.');
    if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Please enter a valid email address.');
    if ((phone.match(/\d/g) || []).length < 7) throw new ApiError(400, 'Please enter a phone number.');
    const cands = candidates(venue, s, { table: body.table, type: body.type });
    const now = clock();
    const active = activeFor(db, venue.id).filter((b) => b.kind === 'guest' && b.guest && b.guest.email === email && Date.parse(b.end) > now);
    if (active.length >= s.maxActive) throw new ApiError(400, `You can have ${s.maxActive} upcoming booking${s.maxActive === 1 ? '' : 's'} at a time. Cancel one to book another.`);
    const p = placeCustomer(db, venue, s, { cands, start: body.start, minutes: body.minutes });
    if (!guestRateOk(req)) throw new ApiError(429, 'Too many bookings from this connection. Please try again later or call the venue.');
    if (!Array.isArray(db.tableBookings)) db.tableBookings = [];
    const token = crypto.randomBytes(24).toString('hex');
    const booking = {
      id: uuid(), venueId: venue.id, type: p.type, tableNumber: p.number, kind: 'guest',
      guest: { name, email, phone }, tokenHash: sha(token),
      start: p.startIso, end: p.endIso, status: 'active',
      createdAt: new Date(now).toISOString(), createdBy: `${name} (website)`,
    };
    db.tableBookings.push(booking);
    recordAudit(db, {
      actor: `${name} (website)`, action: 'venue.table_booking', targetType: 'venue', targetId: venue.id,
      details: `${name} booked ${labelFor(s, p.type, p.number)} at ${venue.name} from the website: ${p.day} ${localHM(booking.start)}-${localHM(booking.end)}`,
    });
    writeDb(db);
    emailCustomer(db, 'booked', venue, booking, req, token);
    res.status(201).json({ ok: true, booking: guestOut(db, booking), token, manageLink: guestManageLink(s, booking, token) });
  }));

  app.get('/api/public/table-booking/bookings/:id', asyncRoute((req, res) => {
    const { db, venue } = guestVenue(req);
    const b = guestBooking(db, venue, req.params.id, req.query.token);
    res.json({ booking: guestOut(db, b) });
  }));

  app.post('/api/public/table-booking/bookings/:id/move', asyncRoute((req, res) => {
    const body = req.body || {};
    const { db, venue, s } = guestVenue(req);
    const b = guestBooking(db, venue, req.params.id, body.token);
    moveBooking(db, venue, s, b, body, `${b.guest.name} (website)`);
    writeDb(db);
    emailCustomer(db, 'moved', venue, b, req, body.token);
    res.json({ ok: true, booking: guestOut(db, b) });
  }));

  app.post('/api/public/table-booking/bookings/:id/cancel', asyncRoute((req, res) => {
    const body = req.body || {};
    const { db, venue, s } = guestVenue(req);
    const b = guestBooking(db, venue, req.params.id, body.token);
    if (b.status !== 'active') throw new ApiError(400, 'That booking was already cancelled.');
    if (Date.parse(b.start) <= clock()) throw new ApiError(400, 'That booking has already started.');
    b.status = 'cancelled';
    b.cancelledAt = new Date(clock()).toISOString();
    b.cancelledBy = `${b.guest.name} (website)`;
    recordAudit(db, {
      actor: b.cancelledBy, action: 'venue.table_booking_cancel', targetType: 'venue', targetId: venue.id,
      details: `${b.cancelledBy} cancelled their booking of ${labelFor(s, b.type, b.tableNumber)} at ${venue.name}: ${localDay(b.start)} ${localHM(b.start)}`,
    });
    writeDb(db);
    emailCustomer(db, 'cancelled', venue, b, req);
    res.json({ ok: true });
  }));

  // ---------------- Venue Manager / Overall Admin / Bar Staff ----------------
  function vmVenue(req, venueId) {
    const db = readDb();
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    return { db, venue };
  }
  const isAdmin = (req) => !!(req.auth && req.auth.user && req.auth.user.isAdmin) && !req.barStaffMode;

  app.get('/api/venue-manager/table-booking', requireVenueManager, asyncRoute((req, res) => {
    const { venue } = vmVenue(req, req.query.venueId);
    res.json({
      wixLinked: !!wixSiteIdForVenue(venue),
      // Overall Admin can move a Wix-linked venue (Top Spin) to this system, or back.
      canSwitchSystem: isAdmin(req) && (!!wixSiteIdForVenue(venue) || venue.wixBooking === false),
      usesCueSenseInsteadOfWix: venue.wixBooking === false,
      settings: settingsOf(venue), types: typesFor(venue),
    });
  }));

  app.post('/api/venue-manager/venues/:id/booking-system', requireVenueManager, asyncRoute((req, res) => {
    if (!isAdmin(req)) throw new ApiError(403, 'Only an Overall Admin can change the booking system.');
    const { db, venue } = vmVenue(req, req.params.id);
    const system = (req.body || {}).system;
    if (system !== 'cuesense' && system !== 'wix') throw new ApiError(400, 'system must be cuesense or wix');
    if (system === 'cuesense') venue.wixBooking = false;
    else {
      delete venue.wixBooking;
      if (venue.tableBooking) venue.tableBooking.enabled = false;
    }
    recordAudit(db, {
      actor: req.adminSession.label, action: 'venue.booking_system', targetType: 'venue', targetId: venue.id,
      details: `Switched "${venue.name}" to ${system === 'cuesense' ? 'Cue Sense table booking (Wix bookings no longer used)' : 'Wix bookings'}`,
    });
    writeDb(db);
    res.json({ ok: true, wixLinked: !!wixSiteIdForVenue(venue), settings: settingsOf(venue) });
  }));

  app.post('/api/venue-manager/venues/:id/table-booking', requireVenueManager, asyncRoute((req, res) => {
    const { db, venue } = vmVenue(req, req.params.id);
    const body = req.body || {};
    const cur = settingsOf(venue);
    const next = { ...cur, hours: { ...cur.hours }, guest: { ...cur.guest } };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false');
      if (body.enabled && wixSiteIdForVenue(venue)) throw new ApiError(400, 'This venue uses the Wix booking system, so this booking system cannot be switched on.');
      if (body.enabled && typesFor(venue).length === 0) throw new ApiError(400, 'Add the number of tables first (Tables card), then switch booking on.');
      next.enabled = body.enabled;
    }
    if (body.hours !== undefined) {
      if (!body.hours || typeof body.hours !== 'object') throw new ApiError(400, 'hours must be an object');
      for (const [k, h] of Object.entries(body.hours)) {
        if (!/^[0-6]$/.test(k)) throw new ApiError(400, 'Unknown day of the week');
        if (h === null) { next.hours[k] = null; continue; }
        if (!h || !TIME_RE.test(h.open) || !(TIME_RE.test(h.close) || h.close === '24:00') || toMin(h.close) <= toMin(h.open)) {
          throw new ApiError(400, 'Opening and closing times must be on the hour or half past, with closing after opening.');
        }
        next.hours[k] = { open: h.open, close: h.close };
      }
    }
    const intField = (name, lo, hi, step) => {
      if (body[name] === undefined) return;
      const v = body[name];
      if (!Number.isInteger(v) || v < lo || v > hi || (step && v % step !== 0)) throw new ApiError(400, `${name} must be a whole number from ${lo} to ${hi}${step ? ` in steps of ${step}` : ''}`);
      next[name] = v;
    };
    intField('maxMinutes', SLOT_MIN, 480, SLOT_MIN);
    intField('maxDaysAhead', 1, 90);
    intField('maxActive', 1, 20);
    intField('bufferMinutes', 0, 30, STEP_MIN);
    if (body.tables !== undefined) {
      if (!Array.isArray(body.tables) || body.tables.length > 50) throw new ApiError(400, 'tables must be a list');
      const counts = venueTableCounts(venue);
      next.tables = body.tables.map((t) => {
        const n = Number(t && t.number);
        if (!t || !typeDef(t.type) || !Number.isInteger(n) || n < 1 || n > (counts[t.type] || 0)) throw new ApiError(400, 'One of the bookable tables does not exist.');
        return { type: t.type, number: n, label: str(t.label, 40), price: str(t.price, 60) };
      });
    }
    if (body.policy !== undefined) next.policy = str(body.policy, 2000);
    if (body.payNote !== undefined) next.payNote = str(body.payNote, 300);
    if (body.guest !== undefined) {
      const g = body.guest || {};
      if (g.enabled !== undefined) next.guest.enabled = g.enabled === true;
      if (g.origins !== undefined) {
        const list = (Array.isArray(g.origins) ? g.origins : String(g.origins).split(/[\s,]+/)).filter(Boolean);
        const norm = list.map(normOrigin);
        if (norm.some((o) => !o)) throw new ApiError(400, 'Website addresses must start with https://');
        next.guest.origins = [...new Set(norm)].slice(0, 5);
      }
      if (g.manageUrl !== undefined) {
        const u = str(g.manageUrl, 300);
        if (u && !/^https:\/\//.test(u)) throw new ApiError(400, 'The manage-booking page must start with https://');
        next.guest.manageUrl = u;
      }
    }
    venue.tableBooking = next;
    recordAudit(db, {
      actor: req.adminSession.label, action: 'venue.table_booking_settings', targetType: 'venue', targetId: venue.id,
      details: `Updated table booking settings for "${venue.name}" (${next.enabled ? 'on' : 'off'}, max ${next.maxMinutes} min, ${next.maxDaysAhead} days ahead, ${next.maxActive} active per customer, ${next.bufferMinutes} min changeover, ${next.tables.length} named tables, website booking ${next.guest.enabled ? 'on' : 'off'})`,
    });
    writeDb(db);
    res.json({ settings: settingsOf(venue) });
  }));

  app.get('/api/venue-manager/table-booking/day', requireVenueManager, asyncRoute((req, res) => {
    const { db, venue } = vmVenue(req, req.query.venueId);
    const day = String(req.query.day || '');
    if (!DAY_RE.test(day)) throw new ApiError(400, 'Choose a day.');
    const s = settingsOf(venue);
    const dayBookings = activeFor(db, venue.id).filter((b) => localDay(b.start) === day);
    const counts = venueTableCounts(venue);
    const members = new Map();
    for (const u of db.users) if (u.email && membershipAt(u, venue.id)) members.set(String(u.email).trim().toLowerCase(), u);
    const shape = (b) => {
      const u = b.userId ? db.users.find((x) => x.id === b.userId) : null;
      let who = 'Blocked';
      if (b.kind === 'player') who = u ? `${u.firstName} ${u.lastName}`.trim() : 'Player';
      else if (b.kind === 'guest') who = b.guest ? b.guest.name : 'Guest';
      else if (b.kind === 'walkin') who = b.name || 'Walk-in';
      else who = b.note || 'Blocked';
      const out = { id: b.id, kind: b.kind, who, note: b.note || '', startTime: localHM(b.start), endTime: localHM(b.end), minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000) };
      if (b.kind === 'guest' && b.guest) {
        out.phone = b.guest.phone;
        out.email = b.guest.email;
        out.member = members.has(b.guest.email);
      }
      if (b.kind === 'player' && u) out.phone = u.phone || '';
      return out;
    };
    const tables = [];
    const push = (type, n) => tables.push({
      type, number: n, key: tableKey(type, n), label: labelFor(s, type, n),
      price: (namedEntry(s, type, n) || {}).price || '', bookable: !named(s) || !!namedEntry(s, type, n),
      bookings: dayBookings.filter((b) => b.type === type && b.tableNumber === n).sort((a, b) => a.start.localeCompare(b.start)).map(shape),
    });
    if (named(s)) {
      for (const t of s.tables) push(t.type, t.number);
      // Any other table with something on it today still shows.
      const extra = [...new Set(dayBookings.filter((b) => !namedEntry(s, b.type, b.tableNumber)).map((b) => tableKey(b.type, b.tableNumber)))];
      for (const k of extra.sort()) { const [t, n] = k.split('-'); push(t, Number(n)); }
    } else {
      for (const t of VENUE_TABLE_TYPES) {
        const maxBooked = dayBookings.filter((b) => b.type === t.key).reduce((m, b) => Math.max(m, b.tableNumber), 0);
        for (let n = 1; n <= Math.max(counts[t.key], maxBooked); n++) push(t.key, n);
      }
    }
    // Every table of every type, for the walk-in / block form.
    const allTables = [];
    for (const t of VENUE_TABLE_TYPES) for (let n = 1; n <= (counts[t.key] || 0); n++) allTables.push({ type: t.key, number: n, label: labelFor(s, t.key, n) });
    res.json({ day, hours: s.hours[dayOfWeek(day)], enabled: s.enabled, tables, allTables });
  }));

  app.post('/api/venue-manager/table-bookings', requireVenueManager, asyncRoute((req, res) => {
    const { venueId, type, tableNumber, start, minutes, kind, name, note, allTables } = req.body || {};
    const { db, venue } = vmVenue(req, venueId);
    if (!Array.isArray(db.tableBookings)) db.tableBookings = [];
    const s = settingsOf(venue);
    if (wixSiteIdForVenue(venue)) throw new ApiError(400, 'This venue uses the Wix booking system.');
    if (!s.enabled) throw new ApiError(400, 'Switch table booking on first.');
    if (kind !== 'walkin' && kind !== 'block') throw new ApiError(400, 'kind must be walkin or block');
    if (!typeDef(type) || !(venueTableCounts(venue)[type] > 0)) throw new ApiError(400, 'Choose a table type.');
    const startAt = parseStart(start);
    const mins = parseMinutes(minutes, 24 * 60);
    const endMs = startAt.getTime() + mins * 60 * 1000;
    if (endMs <= clock()) throw new ApiError(400, 'That time has already passed.');
    const list = activeFor(db, venue.id);
    const count = venueTableCounts(venue)[type];
    let numbers;
    if (kind === 'block' && allTables === true) {
      numbers = Array.from({ length: count }, (_, i) => i + 1);
    } else if (tableNumber !== undefined && tableNumber !== null && tableNumber !== '') {
      const n = Number(tableNumber);
      if (!Number.isInteger(n) || n < 1 || n > count) throw new ApiError(400, 'That table does not exist.');
      numbers = [n];
    } else {
      const n = findFreeTable(list, venue, type, startAt.getTime(), endMs);
      if (n === null) throw new ApiError(409, 'No table of that type is free at that time.');
      numbers = [n];
    }
    for (const n of numbers) {
      if (!tableFree(list, type, n, startAt.getTime(), endMs)) throw new ApiError(409, `${labelFor(s, type, n)} is already booked at that time.`);
    }
    const created = numbers.map((n) => ({
      id: uuid(), venueId: venue.id, type, tableNumber: n, kind,
      name: kind === 'walkin' ? String(name || '').trim().slice(0, 80) : undefined,
      note: String(note || '').trim().slice(0, 120) || undefined,
      start: startAt.toISOString(), end: new Date(endMs).toISOString(), status: 'active',
      createdAt: new Date(clock()).toISOString(), createdBy: req.adminSession.label,
    }));
    db.tableBookings.push(...created);
    recordAudit(db, {
      actor: req.adminSession.label, action: kind === 'block' ? 'venue.table_block' : 'venue.table_walkin', targetType: 'venue', targetId: venue.id,
      details: `${kind === 'block' ? 'Blocked' : 'Booked walk-in on'} ${numbers.map((n) => labelFor(s, type, n)).join(', ')} at ${venue.name}: ${localDay(created[0].start)} ${localHM(created[0].start)}-${localHM(created[0].end)}`,
    });
    writeDb(db);
    res.status(201).json({ ok: true, count: created.length });
  }));

  app.post('/api/venue-manager/table-bookings/:id/cancel', requireVenueManager, asyncRoute((req, res) => {
    const db = readDb();
    const b = (db.tableBookings || []).find((x) => x.id === req.params.id);
    if (!b) throw new ApiError(404, 'That booking was not found.');
    const venue = db.venues.find((v) => v.id === b.venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    if (b.status !== 'active') throw new ApiError(400, 'That booking was already cancelled.');
    b.status = 'cancelled';
    b.cancelledAt = new Date(clock()).toISOString();
    b.cancelledBy = req.adminSession.label;
    recordAudit(db, {
      actor: req.adminSession.label, action: 'venue.table_booking_cancel', targetType: 'venue', targetId: venue.id,
      details: `Cancelled ${b.kind} ${venueLabel(venue, b.type, b.tableNumber)} at ${venue.name}: ${localDay(b.start)} ${localHM(b.start)}`,
    });
    writeDb(db);
    if (Date.parse(b.start) > clock()) emailCustomer(db, 'venueCancelled', venue, b, req);
    res.json({ ok: true });
  }));

  return { settingsOf, guestHits };
}
