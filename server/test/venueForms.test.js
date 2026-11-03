// Run with: node --test test/   (from the server folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerVenueFormRoutes, FORM_RATE } from '../src/routes/venueForms.js';

const SITE = 'https://topspin.example.co.uk';
function harness() {
  const handlers = {};
  const reg = (m) => (p, ...fns) => { handlers[`${m} ${p}`] = fns[fns.length - 1]; };
  const db = { venues: [{ id: 'v1', name: 'Top Spin', tableBooking: { guest: { origins: [SITE] } } }, { id: 'v2', name: 'Other' }], venueForms: [] };
  let n = 0;
  registerVenueFormRoutes({ get: reg('GET'), post: reg('POST') }, {
    requireVenueManager: () => {}, assertVenueAccess: (req, v) => { if (req.deny === v.id) { const e = new Error('no'); e.status = 403; throw e; } },
    readDb: () => db, writeDb: () => {}, asyncRoute: (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } }, uuid: () => `f${++n}`,
  });
  const call = (key, req = {}) => {
    let out; let error; let status = 200;
    handlers[key]({ query: {}, params: {}, body: {}, ip: '9.9.9.9', adminSession: { label: 'Bar' }, ...req, headers: { ...(req.headers || {}) } }, { status(s) { status = s; return this; }, json(b) { out = b; } }, (e) => { error = e; });
    return { out, error, status };
  };
  const send = (kind, body, origin = SITE) => call('POST /api/public/venue-forms/:kind', { params: { kind }, body, headers: { origin } });
  return { db, call, send };
}

test('a website enquiry is stored against the venue whose website sent it', () => {
  const h = harness();
  const r = h.send('enquiry', { firstName: 'Jo', email: 'JO@Example.com', topic: 'Group or team night', message: 'Ten of us on Friday?', people: '10' });
  assert.equal(r.status, 201);
  assert.equal(h.db.venueForms[0].venueId, 'v1');
  assert.equal(h.db.venueForms[0].fields.email, 'jo@example.com');
  const list = h.call('GET /api/venue-manager/venue-forms', { query: { venueId: 'v1' } }).out;
  assert.equal(list.newCount, 1);
  assert.equal(list.entries[0].kindLabel, 'Enquiry');
  assert.ok(list.entries[0].lines.some((l) => l.label === 'Number of people' && l.value === '10'));
});

test('forms are refused from other origins, with missing fields, or from the honeypot', () => {
  const h = harness();
  assert.equal(h.send('newsletter', { email: 'a@b.co', consent: true }, 'https://evil.example').error.status, 403);
  assert.equal(h.send('newsletter', { email: 'a@b.co', consent: true }, '').error.status, 403);
  assert.equal(h.send('newsletter', { email: 'a@b.co' }).error.status, 400);
  assert.equal(h.send('cuecare', { firstName: 'A', lastName: 'B', email: 'bad', service: 'Tip shaping' }).error.status, 400);
  assert.equal(h.send('newsletter', { email: 'a@b.co', consent: true, website: 'x' }).error.status, 400);
  assert.equal(h.send('nope', {}).error.status, 404);
  assert.equal(h.db.venueForms.length, 0);
  assert.equal(h.send('newsletter', { email: 'a@b.co', consent: true }).status, 201);
  assert.equal(h.db.venueForms[0].fields.consent, 'yes');
});

test('staff can mark a message done and delete it; other venues cannot see it', () => {
  const h = harness();
  h.send('cuecare', { firstName: 'A', lastName: 'B', email: 'a@b.co', service: 'Tip shaping' });
  const id = h.db.venueForms[0].id;
  assert.equal(h.call('POST /api/venue-manager/venue-forms/:id/status', { params: { id }, body: { status: 'done' }, deny: 'v1' }).error.status, 403);
  assert.equal(h.call('POST /api/venue-manager/venue-forms/:id/status', { params: { id }, body: { status: 'done' } }).error, undefined);
  assert.equal(h.db.venueForms[0].status, 'done');
  assert.equal(h.call('GET /api/venue-manager/venue-forms', { query: { venueId: 'v2' } }).out.entries.length, 0);
  h.call('POST /api/venue-manager/venue-forms/:id/delete', { params: { id } });
  assert.equal(h.db.venueForms.length, 0);
});

test('website forms are rate limited per connection', () => {
  const h = harness();
  let last;
  for (let i = 0; i <= FORM_RATE.max; i++) last = h.send('newsletter', { email: `a${i}@b.co`, consent: true });
  assert.equal(last.error.status, 429);
});
