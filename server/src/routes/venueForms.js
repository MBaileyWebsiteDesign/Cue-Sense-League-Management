// Venue website forms (Matt, 2026-11-03): the contact / enquiry, newsletter and
// cue care forms on a venue's own website (Top Spin's new site) post here
// instead of to Wix Forms. Entries show in the Venue portal "Website messages"
// card. No emails are sent.
//
// A request is accepted only when its Origin header is one of the venue's
// website addresses - the same list as website table booking
// (venue.tableBooking.guest.origins, set on the Venue portal Table booking card).
//
// Data: db.venueForms = [{ id, venueId, kind ('enquiry'|'newsletter'|'cuecare'),
//   fields: { ... }, status ('new'|'done'), createdAt, handledAt, handledBy }]
import { ApiError } from '../errors.js';
import { normOrigin } from './tableBookings.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const FORM_RATE = { max: 10, windowMs: 60 * 60 * 1000 };
const MAX_PER_VENUE = 3000;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

export const FORM_KINDS = {
  enquiry: {
    label: 'Enquiry',
    fields: {
      firstName: { max: 60, required: true, label: 'First name' },
      lastName: { max: 60, label: 'Last name' },
      email: { max: 120, required: true, email: true, label: 'Email' },
      phone: { max: 30, label: 'Phone' },
      topic: { max: 80, required: true, label: 'What is it about?' },
      date: { max: 10, label: 'Preferred date' },
      people: { max: 4, label: 'Number of people' },
      message: { max: 3000, required: true, label: 'Message' },
    },
  },
  newsletter: {
    label: 'Newsletter sign-up',
    fields: {
      email: { max: 120, required: true, email: true, label: 'Email' },
      firstName: { max: 60, label: 'First name' },
      consent: { max: 5, required: true, label: 'Agreed to receive the newsletter' },
    },
  },
  cuecare: {
    label: 'Cue care request',
    fields: {
      firstName: { max: 60, required: true, label: 'First name' },
      lastName: { max: 60, required: true, label: 'Last name' },
      email: { max: 120, required: true, email: true, label: 'Email' },
      service: { max: 80, required: true, label: 'Cue care service' },
      notes: { max: 2000, label: 'Anything we should know?' },
    },
  },
};

export function registerVenueFormRoutes(app, {
  requireVenueManager, assertVenueAccess, readDb, writeDb, asyncRoute, uuid, now: clock = () => Date.now(),
}) {
  const hits = new Map();
  function rateOk(req) {
    const ip = String(req.headers['fly-client-ip'] || req.ip || 'unknown');
    const t = clock();
    const list = (hits.get(ip) || []).filter((x) => t - x < FORM_RATE.windowMs);
    if (list.length >= FORM_RATE.max) { hits.set(ip, list); return false; }
    list.push(t);
    hits.set(ip, list);
    return true;
  }
  const originsOf = (v) => {
    const g = v && v.tableBooking && v.tableBooking.guest;
    return (g && Array.isArray(g.origins) ? g.origins : []).map(normOrigin).filter(Boolean);
  };

  app.post('/api/public/venue-forms/:kind', asyncRoute((req, res) => {
    const def = FORM_KINDS[req.params.kind];
    if (!def) throw new ApiError(404, 'Not found');
    const origin = normOrigin((req.headers && req.headers.origin) || '');
    const db = readDb();
    const venue = origin ? db.venues.find((v) => originsOf(v).includes(origin)) : null;
    if (!venue) throw new ApiError(403, 'This form only works on the venue’s website.');
    const body = req.body || {};
    if (body.website) throw new ApiError(400, 'Your message could not be sent.'); // honeypot
    const fields = {};
    for (const [k, f] of Object.entries(def.fields)) {
      let v = k === 'consent' ? (body[k] === true || body[k] === 'true' || body[k] === 'on' ? 'yes' : '') : str(body[k], f.max);
      if (f.email) v = v.toLowerCase();
      if (f.required && !v) throw new ApiError(400, `Please fill in: ${f.label}.`);
      if (f.email && v && !EMAIL_RE.test(v)) throw new ApiError(400, 'Please enter a valid email address.');
      if (v) fields[k] = v;
    }
    if (!rateOk(req)) throw new ApiError(429, 'Too many messages from this connection. Please try again later.');
    if (!Array.isArray(db.venueForms)) db.venueForms = [];
    db.venueForms.push({ id: uuid(), venueId: venue.id, kind: req.params.kind, fields, status: 'new', createdAt: new Date(clock()).toISOString() });
    const mine = db.venueForms.filter((e) => e.venueId === venue.id);
    if (mine.length > MAX_PER_VENUE) {
      const drop = new Set(mine.slice(0, mine.length - MAX_PER_VENUE).map((e) => e.id));
      db.venueForms = db.venueForms.filter((e) => !drop.has(e.id));
    }
    writeDb(db);
    res.status(201).json({ ok: true });
  }));

  function vmVenue(req, venueId) {
    const db = readDb();
    const venue = db.venues.find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    return { db, venue };
  }

  app.get('/api/venue-manager/venue-forms', requireVenueManager, asyncRoute((req, res) => {
    const { db, venue } = vmVenue(req, req.query.venueId);
    const list = (db.venueForms || []).filter((e) => e.venueId === venue.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500)
      .map((e) => ({
        ...e,
        kindLabel: (FORM_KINDS[e.kind] || {}).label || e.kind,
        lines: Object.entries(e.fields).map(([k, v]) => ({ key: k, label: ((FORM_KINDS[e.kind] || {}).fields || {})[k]?.label || k, value: v })),
      }));
    res.json({ websites: originsOf(venue), entries: list, newCount: list.filter((e) => e.status === 'new').length });
  }));

  const findEntry = (req) => {
    const db = readDb();
    const e = (db.venueForms || []).find((x) => x.id === req.params.id);
    if (!e) throw new ApiError(404, 'That message was not found.');
    const venue = db.venues.find((v) => v.id === e.venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    return { db, e };
  };

  app.post('/api/venue-manager/venue-forms/:id/status', requireVenueManager, asyncRoute((req, res) => {
    const { db, e } = findEntry(req);
    const status = (req.body || {}).status;
    if (status !== 'new' && status !== 'done') throw new ApiError(400, 'status must be new or done');
    e.status = status;
    if (status === 'done') { e.handledAt = new Date(clock()).toISOString(); e.handledBy = req.adminSession.label; } else { delete e.handledAt; delete e.handledBy; }
    writeDb(db);
    res.json({ ok: true });
  }));

  app.post('/api/venue-manager/venue-forms/:id/delete', requireVenueManager, asyncRoute((req, res) => {
    const { db, e } = findEntry(req);
    db.venueForms = db.venueForms.filter((x) => x.id !== e.id);
    writeDb(db);
    res.json({ ok: true });
  }));
}
