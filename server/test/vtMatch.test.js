// Run with: node --test test/   (from the server folder). No extra packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_ALPHABET, CODE_LENGTH, MAX_EVENTS_KEPT, MAX_EVENT_BYTES, RATE_LIMIT, ROOM_IDLE_MS, ONLINE_MS, registerVtMatchRoutes,
} from '../src/routes/vtMatch.js';

function harness() {
  const handlers = {};
  const app = {
    get: (p, ...fns) => { handlers[`GET ${p}`] = fns[fns.length - 1]; },
    post: (p, ...fns) => { handlers[`POST ${p}`] = fns[fns.length - 1]; },
  };
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const api = registerVtMatchRoutes(app, {
    asyncRoute: (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } },
    ApiError,
    now: () => clock,
  });
  const call = (key, req) => {
    let out; let error; let status = 200;
    handlers[key]({ query: {}, params: {}, body: {}, headers: {}, ...req }, {
      status(s) { status = s; return this; },
      json(b) { out = b; },
    }, (e) => { error = e; });
    return { out, error, status };
  };
  const create = (name) => call('POST /api/vt-match', { body: { name } });
  const join = (code, name) => call('POST /api/vt-match/:code/join', { params: { code }, body: { name } });
  const poll = (code, token, since = 0) => call('GET /api/vt-match/:code', { params: { code }, headers: { 'x-match-token': token }, query: { since: String(since) } });
  const send = (code, token, events) => call('POST /api/vt-match/:code/events', { params: { code }, headers: { 'x-match-token': token }, body: { events } });
  return { call, create, join, poll, send, rooms: api.rooms, advance: (ms) => { clock += ms; } };
}

test('creating a match gives a short code from the unambiguous alphabet and a secret token', () => {
  const h = harness();
  const r = h.create('Sam');
  assert.equal(r.status, 201);
  assert.equal(r.out.code.length, CODE_LENGTH);
  for (const ch of r.out.code) assert.ok(CODE_ALPHABET.includes(ch));
  assert.equal(r.out.seat, 0);
  assert.ok(r.out.token.length >= 32);
  assert.equal(r.out.seats[0].name, 'Sam');
  assert.equal(r.out.seats[1], null);
});

test('a second player can join once, case-insensitively; a third is refused', () => {
  const h = harness();
  const a = h.create('Sam').out;
  const b = h.join(a.code.toLowerCase(), 'Alex');
  assert.equal(b.status, 201);
  assert.equal(b.out.seat, 1);
  assert.notEqual(b.out.token, a.token);
  assert.equal(b.out.seats[0].name, 'Sam');
  assert.equal(h.join(a.code, 'Third').error.status, 409);
  assert.equal(h.join('ZZZZZ', 'X').error.status, 404);
});

test('names are cleaned and have defaults', () => {
  const h = harness();
  const a = h.create('  <b>Sam</b>\u0007  ').out;
  assert.equal(a.seats[0].name, 'bSam/b');
  assert.equal(h.join(a.code, '').out.seats[1].name, 'Player 2');
  assert.equal(h.create(undefined).out.seats[0].name, 'Player 1');
  assert.equal(h.create('x'.repeat(100)).out.seats[0].name.length, 24);
});

test('messages are numbered, come back to the other player, and carry the sender seat from the token', () => {
  const h = harness();
  const a = h.create('A').out;
  const b = h.join(a.code, 'B').out;
  const s1 = h.send(a.code, a.token, [{ type: 'state', data: { n: 1 } }, { type: 'aim', data: { aimDeg: 12 }, seat: 1 }]);
  assert.equal(s1.out.seq, 2);
  const p = h.poll(a.code, b.token, 0);
  assert.deepEqual(p.out.events.map((e) => [e.seq, e.seat, e.type]), [[1, 0, 'state'], [2, 0, 'aim']]);
  assert.deepEqual(h.poll(a.code, b.token, 1).out.events.map((e) => e.seq), [2]);
  assert.deepEqual(h.poll(a.code, b.token, 2).out.events, []);
  h.send(a.code, b.token, [{ type: 'shot', data: { s: 1 } }]);
  const again = h.poll(a.code, a.token, 2).out.events;
  assert.deepEqual(again.map((e) => [e.seq, e.seat]), [[3, 1]]);
});

test('a wrong or missing token is refused', () => {
  const h = harness();
  const a = h.create('A').out;
  assert.equal(h.poll(a.code, 'nope').error.status, 401);
  assert.equal(h.poll(a.code, undefined).error.status, 401);
  assert.equal(h.send(a.code, 'nope', [{ type: 'aim', data: {} }]).error.status, 401);
  assert.equal(h.poll('QQQQQ', a.token).error.status, 404);
});

test('bad messages are refused', () => {
  const h = harness();
  const a = h.create('A').out;
  const bad = (events, status) => assert.equal(h.send(a.code, a.token, events).error.status, status);
  bad([], 400);
  bad('x', 400);
  bad([{ type: 'chat', data: {} }], 400);
  bad([{ type: 'aim' }], 400);
  bad([{ type: 'aim', data: [1] }], 400);
  bad(Array.from({ length: 21 }, () => ({ type: 'aim', data: {} })), 400);
  bad([{ type: 'state', data: { blob: 'x'.repeat(MAX_EVENT_BYTES) } }], 413);
  assert.equal(h.poll(a.code, a.token).out.events.length, 0);
});

test('a player sending too fast is slowed down, and the window clears', () => {
  const h = harness();
  const a = h.create('A').out;
  for (let i = 0; i < RATE_LIMIT / 10; i += 1) {
    assert.equal(h.send(a.code, a.token, Array.from({ length: 10 }, () => ({ type: 'aim', data: { aimDeg: 1 } }))).error, undefined);
  }
  assert.equal(h.send(a.code, a.token, [{ type: 'aim', data: {} }]).error.status, 429);
  h.advance(11000);
  assert.equal(h.send(a.code, a.token, [{ type: 'aim', data: {} }]).error, undefined);
});

test('only the latest messages are kept', () => {
  const h = harness();
  const a = h.create('A').out;
  for (let i = 0; i < MAX_EVENTS_KEPT + 30; i += 1) {
    h.send(a.code, a.token, [{ type: 'state', data: { i } }]);
    h.advance(200);
  }
  const events = h.poll(a.code, a.token, 0).out.events;
  assert.equal(events.length, MAX_EVENTS_KEPT);
  assert.equal(events[events.length - 1].data.i, MAX_EVENTS_KEPT + 29);
});

test('presence: online while polling, offline after a while, and leave is recorded', () => {
  const h = harness();
  const a = h.create('A').out;
  const b = h.join(a.code, 'B').out;
  assert.equal(h.poll(a.code, a.token).out.seats[1].online, true);
  h.advance(ONLINE_MS + 1000);
  const view = h.poll(a.code, a.token).out;
  assert.equal(view.seats[0].online, true);
  assert.equal(view.seats[1].online, false);
  h.send(a.code, b.token, [{ type: 'leave', data: {} }]);
  assert.equal(h.poll(a.code, a.token).out.seats[1].left, true);
});

test('idle matches are removed', () => {
  const h = harness();
  const a = h.create('A').out;
  h.advance(ROOM_IDLE_MS + 1000);
  h.create('B'); // creating a match sweeps old ones
  assert.equal(h.poll(a.code, a.token).error.status, 404);
});
