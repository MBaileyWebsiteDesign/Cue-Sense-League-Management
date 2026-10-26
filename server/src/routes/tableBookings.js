// Table booking (Matt, 2026-10-26): venues that do NOT use the Wix booking
// system (Top Spin stays on Wix) can switch on their own table booking. Players
// who are members of the venue book by TABLE TYPE (English pool, Chinese 8
// ball, American pool, Snooker) in 30-minute blocks; the server assigns the
// lowest-numbered free table of that type. The number of tables of each type
// comes from venue.tableCounts (see VENUE_TABLE_TYPES in index.js).
//
// Data: db.tableBookings = [{ id, venueId, type, tableNumber, kind
//   ('player'|'walkin'|'block'), userId (player), name (walk-in), note,
//   start, end (ISO UTC), status ('active'|'cancelled'), createdAt,
//   createdBy, cancelledAt, cancelledBy }]
// Per-venue settings: venue.tableBooking = { enabled, hours: { 0..6: { open,
//   close } | null } (0 = Sunday, UK time), maxMinutes, maxDaysAhead, maxActive }.
// A venue linked to a Wix booking site can never switch this on.
// No emails and no payment - on-screen confirmation only.
import { ApiError } from '../errors.js';
import { recordAudit } from '../services/auditLog.js';

const SLOT_MIN = 30;
const SLOT_MS = SLOT_MIN * 60 * 1000;
const DEFAULTS = { open: '10:00', close: '23:00', maxMinutes: 120, maxDaysAhead: 14, maxActive: 2 };
const TIME_RE = /^(?:[01]\d|2[0-3]):(?:00|30)$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    return {
      enabled: raw.enabled === true,
      hours,
      maxMinutes: mm - (mm % SLOT_MIN),
      maxDaysAhead: int(raw.maxDaysAhead, 1, 90, DEFAULTS.maxDaysAhead),
      maxActive: int(raw.maxActive, 1, 20, DEFAULTS.maxActive),
    };
  }

  const typesFor = (venue) => {
    const counts = venueTableCounts(venue);
    return VENUE_TABLE_TYPES.filter((t) => counts[t.key] > 0).map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }));
  };
  const tableLabel = (type, n) => `${(typeDef(type) || { label: type }).label} ${n}`;
  const activeFor = (db, venueId) => (db.tableBookings || []).filter((b) => b.venueId === venueId && b.status === 'active');
  const clash = (b, startMs, endMs) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs;
  const tableFree = (list, type, number, startMs, endMs, ignoreId) => !list.some((b) => b.type === type && b.tableNumber === number && b.id !== ignoreId && clash(b, startMs, endMs));
  function findFreeTable(list, venue, type, startMs, endMs) {
    const count = venueTableCounts(venue)[type] || 0;
    for (let n = 1; n <= count; n++) if (tableFree(list, type, n, startMs, endMs)) return n;
    return null;
  }
  const localHM = (iso) => londonLocalString(new Date(iso)).slice(11, 16);
  const localDay = (iso) => londonLocalString(new Date(iso)).slice(0, 10);

  // A member may book if registered; where the venue runs memberships the
  // membership must still be live on the booking day (UK date).
  function memberOkOn(user, venue, day) {
    const m = membershipAt(user, venue.id);
    if (!m) return false;
    if (venue.membershipEnabled === false) return true;
    return !!m.renewalDate && String(m.renewalDate) >= day;
  }
  function bookableDays(user, venue, settings, now = Date.now()) {
    const start = todayUk(now);
    let last = addDays(start, settings.maxDaysAhead);
    const m = membershipAt(user, venue.id);
    if (venue.membershipEnabled !== false && m && m.renewalDate && String(m.renewalDate) < last) last = String(m.renewalDate);
    const days = [];
    for (let d = start; d <= last; d = addDays(d, 1)) if (settings.hours[dayOfWeek(d)]) days.push(d);
    return days;
  }

  function availability(db, venue, settings, type, day, now = Date.now()) {
    const hours = settings.hours[dayOfWeek(day)];
    if (!hours) return { closed: true, open: null, close: null, slots: [] };
    const list = activeFor(db, venue.id);
    const count = venueTableCounts(venue)[type] || 0;
    const openM = toMin(hours.open);
    const closeM = toMin(hours.close);
    const slots = [];
    for (let m = openM; m < closeM; m += SLOT_MIN) {
      const time = fromMin(m);
      const start = parseLondonLocal(`${day}T${time}`);
      if (!start) continue;
      const startMs = start.getTime();
      if (startMs <= now) { slots.push({ time, maxBlocks: 0 }); continue; }
      const cap = Math.min(settings.maxMinutes / SLOT_MIN, (closeM - m) / SLOT_MIN);
      let best = 0;
      for (let n = 1; n <= count; n++) {
        let blocks = 0;
        while (blocks < cap && tableFree(list, type, n, startMs + blocks * SLOT_MS, startMs + (blocks + 1) * SLOT_MS)) blocks++;
        if (blocks > best) best = blocks;
      }
      slots.push({ time, maxBlocks: best });
    }
    return { closed: false, open: hours.open, close: hours.close, slots };
  }

  const shapeMine = (db, b) => {
    const v = db.venues.find((x) => x.id === b.venueId);
    return {
      id: b.id, venueId: b.venueId, venueName: v ? v.name : 'Venue', type: b.type,
      table: tableLabel(b.type, b.tableNumber), day: localDay(b.start), startTime: localHM(b.start),
      endTime: localHM(b.end), minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000),
      start: b.start, end: b.end,
    };
  };

  function parseStart(start) {
    const dt = parseLondonLocal(start);
    if (!dt || ![0, 30].includes(Number(String(start).slice(14, 16)))) throw new ApiError(400, 'Start time must be on the hour or half past (UK time).');
    return dt;
  }
  function parseMinutes(minutes, max) {
    const mins = Number(minutes);
    if (!Number.isInteger(mins) || mins < SLOT_MIN || mins % SLOT_MIN !== 0) throw new ApiError(400, 'Length must be in 30 minute blocks.');
    if (mins > max) throw new ApiError(400, `The longest booking here is ${max} minutes.`);
    return mins;
  }

  // ---------------- Player ----------------
  app.get('/api/users/me/table-booking/venues', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const out = [];
    for (const v of db.venues) {
      const s = settingsOf(v);
      if (!s.enabled || wixSiteIdForVenue(v)) continue;
      const types = typesFor(v);
      if (types.length === 0) continue;
      const days = bookableDays(user, v, s);
      if (!membershipAt(user, v.id)) continue;
      if (v.membershipEnabled !== false && !memberOkOn(user, v, todayUk())) continue;
      out.push({ id: v.id, name: v.name, types, days, maxMinutes: s.maxMinutes, maxDaysAhead: s.maxDaysAhead, maxActive: s.maxActive });
    }
    res.json(out);
  }));

  app.get('/api/users/me/table-booking/availability', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
    const venue = db.venues.find((v) => v.id === req.query.venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    const s = settingsOf(venue);
    if (!s.enabled || wixSiteIdForVenue(venue)) throw new ApiError(400, 'Table booking is not switched on at this venue.');
    const type = String(req.query.type || '');
    if (!typeDef(type) || !(venueTableCounts(venue)[type] > 0)) throw new ApiError(400, 'Choose a table type.');
    const day = String(req.query.day || '');
    if (!DAY_RE.test(day)) throw new ApiError(400, 'Choose a day.');
    if (!bookableDays(user, venue, s).includes(day)) throw new ApiError(400, 'That day cannot be booked.');
    if (!memberOkOn(user, venue, day)) throw new ApiError(403, 'You need to be a member of this venue to book a table.');
    res.json({ ...availability(db, venue, s, type, day), maxMinutes: s.maxMinutes });
  }));

  app.get('/api/users/me/table-bookings', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const now = Date.now();
    const mine = (db.tableBookings || [])
      .filter((b) => b.status === 'active' && b.userId === req.auth.user.id && Date.parse(b.end) > now)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((b) => shapeMine(db, b));
    res.json({ bookings: mine });
  }));

  app.post('/api/users/me/table-bookings', requireAuth, asyncRoute((req, res) => {
    const { venueId, type, start, minutes } = req.body || {};
    const db = readDb();
    if (!Array.isArray(db.tableBookings)) db.tableBookings = [];
    const user = db.users.find((u) => u.id === req.auth.user.id);
    if (!user) throw new ApiError(404, 'Account not found');
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    const s = settingsOf(venue);
    if (!s.enabled || wixSiteIdForVenue(venue)) throw new ApiError(400, 'Table booking is not switched on at this venue.');
    if (!typeDef(type) || !(venueTableCounts(venue)[type] > 0)) throw new ApiError(400, 'Choose a table type.');
    const startAt = parseStart(start);
    const mins = parseMinutes(minutes, s.maxMinutes);
    const day = String(start).slice(0, 10);
    if (!memberOkOn(user, venue, day)) throw new ApiError(403, 'You need to be a member of this venue to book a table.');
    const now = Date.now();
    if (startAt.getTime() <= now) throw new ApiError(400, 'That start time has already passed.');
    if (day > addDays(todayUk(now), s.maxDaysAhead)) throw new ApiError(400, `Tables can be booked up to ${s.maxDaysAhead} days ahead.`);
    const hours = s.hours[dayOfWeek(day)];
    const startM = Number(String(start).slice(11, 13)) * 60 + Number(String(start).slice(14, 16));
    if (!hours || startM < toMin(hours.open) || startM + mins > toMin(hours.close)) throw new ApiError(400, 'That time is outside the venue\u2019s booking hours.');
    const active = activeFor(db, venue.id).filter((b) => b.kind === 'player' && b.userId === user.id && Date.parse(b.end) > now);
    if (active.length >= s.maxActive) throw new ApiError(400, `You can have ${s.maxActive} upcoming booking${s.maxActive === 1 ? '' : 's'} at a time here. Cancel one to book another.`);
    const endMs = startAt.getTime() + mins * 60 * 1000;
    const number = findFreeTable(activeFor(db, venue.id), venue, type, startAt.getTime(), endMs);
    if (number === null) throw new ApiError(409, 'Sorry, that time has just been taken. Please pick another.');
    const booking = {
      id: uuid(), venueId: venue.id, type, tableNumber: number, kind: 'player', userId: user.id,
      start: startAt.toISOString(), end: new Date(endMs).toISOString(), status: 'active',
      createdAt: new Date().toISOString(), createdBy: `${user.firstName} ${user.lastName}`,
    };
    db.tableBookings.push(booking);
    recordAudit(db, {
      actor: `${user.firstName} ${user.lastName}`, action: 'venue.table_booking', targetType: 'venue', targetId: venue.id,
      details: `${user.firstName} ${user.lastName} booked ${tableLabel(type, number)} at ${venue.name}: ${day} ${localHM(booking.start)}-${localHM(booking.end)}`,
    });
    writeDb(db);
    res.status(201).json({ ok: true, booking: shapeMine(db, booking) });
  }));

  app.post('/api/users/me/table-bookings/:id/cancel', requireAuth, asyncRoute((req, res) => {
    const db = readDb();
    const b = (db.tableBookings || []).find((x) => x.id === req.params.id);
    if (!b || b.userId !== req.auth.user.id || b.kind !== 'player') throw new ApiError(404, 'That booking was not found.');
    if (b.status !== 'active') throw new ApiError(400, 'That booking was already cancelled.');
    if (Date.parse(b.start) <= Date.now()) throw new ApiError(400, 'That booking has already started.');
    b.status = 'cancelled';
    b.cancelledAt = new Date().toISOString();
    b.cancelledBy = `${req.auth.user.firstName} ${req.auth.user.lastName}`;
    const v = db.venues.find((x) => x.id === b.venueId);
    recordAudit(db, {
      actor: b.cancelledBy, action: 'venue.table_booking_cancel', targetType: 'venue', targetId: b.venueId,
      details: `${b.cancelledBy} cancelled their booking of ${tableLabel(b.type, b.tableNumber)} at ${v ? v.name : 'venue'}: ${localDay(b.start)} ${localHM(b.start)}`,
    });
    writeDb(db);
    res.json({ ok: true });
  }));

  // ---------------- Venue Manager / Overall Admin ----------------
  function vmVenue(req, venueId) {
    const db = readDb();
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    return { db, venue };
  }

  app.get('/api/venue-manager/table-booking', requireVenueManager, asyncRoute((req, res) => {
    const { venue } = vmVenue(req, req.query.venueId);
    res.json({ wixLinked: !!wixSiteIdForVenue(venue), settings: settingsOf(venue), types: typesFor(venue) });
  }));

  app.post('/api/venue-manager/venues/:id/table-booking', requireVenueManager, asyncRoute((req, res) => {
    const { db, venue } = vmVenue(req, req.params.id);
    const body = req.body || {};
    const cur = settingsOf(venue);
    const next = { ...cur, hours: { ...cur.hours } };
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
    venue.tableBooking = next;
    recordAudit(db, {
      actor: req.adminSession.label, action: 'venue.table_booking_settings', targetType: 'venue', targetId: venue.id,
      details: `Updated table booking settings for "${venue.name}" (${next.enabled ? 'on' : 'off'}, max ${next.maxMinutes} min, ${next.maxDaysAhead} days ahead, ${next.maxActive} active per player)`,
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
    const tables = [];
    for (const t of VENUE_TABLE_TYPES) {
      const maxBooked = dayBookings.filter((b) => b.type === t.key).reduce((m, b) => Math.max(m, b.tableNumber), 0);
      for (let n = 1; n <= Math.max(counts[t.key], maxBooked); n++) {
        tables.push({
          type: t.key, number: n, label: tableLabel(t.key, n),
          bookings: dayBookings.filter((b) => b.type === t.key && b.tableNumber === n).sort((a, b) => a.start.localeCompare(b.start)).map((b) => {
            const u = b.userId ? db.users.find((x) => x.id === b.userId) : null;
            const who = b.kind === 'player' ? (u ? `${u.firstName} ${u.lastName}`.trim() : 'Player') : b.kind === 'walkin' ? (b.name || 'Walk-in') : (b.note || 'Blocked');
            return { id: b.id, kind: b.kind, who, note: b.note || '', startTime: localHM(b.start), endTime: localHM(b.end), minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000) };
          }),
        });
      }
    }
    res.json({ day, hours: s.hours[dayOfWeek(day)], enabled: s.enabled, tables });
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
    if (endMs <= Date.now()) throw new ApiError(400, 'That time has already passed.');
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
      if (!tableFree(list, type, n, startAt.getTime(), endMs)) throw new ApiError(409, `${tableLabel(type, n)} is already booked at that time.`);
    }
    const created = numbers.map((n) => ({
      id: uuid(), venueId: venue.id, type, tableNumber: n, kind,
      name: kind === 'walkin' ? String(name || '').trim().slice(0, 80) : undefined,
      note: String(note || '').trim().slice(0, 120) || undefined,
      start: startAt.toISOString(), end: new Date(endMs).toISOString(), status: 'active',
      createdAt: new Date().toISOString(), createdBy: req.adminSession.label,
    }));
    db.tableBookings.push(...created);
    recordAudit(db, {
      actor: req.adminSession.label, action: kind === 'block' ? 'venue.table_block' : 'venue.table_walkin', targetType: 'venue', targetId: venue.id,
      details: `${kind === 'block' ? 'Blocked' : 'Booked walk-in on'} ${numbers.map((n) => tableLabel(type, n)).join(', ')} at ${venue.name}: ${localDay(created[0].start)} ${localHM(created[0].start)}-${localHM(created[0].end)}`,
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
    b.cancelledAt = new Date().toISOString();
    b.cancelledBy = req.adminSession.label;
    recordAudit(db, {
      actor: req.adminSession.label, action: 'venue.table_booking_cancel', targetType: 'venue', targetId: venue.id,
      details: `Cancelled ${b.kind} ${tableLabel(b.type, b.tableNumber)} at ${venue.name}: ${localDay(b.start)} ${localHM(b.start)}`,
    });
    writeDb(db);
    res.json({ ok: true });
  }));
}
