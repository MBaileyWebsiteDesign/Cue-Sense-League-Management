// Run with: node --test test/   (from the server folder). No extra packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyEvent, defaultVirtualTraining, ensureVirtualTraining, rebuildFromEvents, validateEvent, LADDER_LEVELS,
} from '../src/services/virtualTraining.js';
import { registerVirtualTrainingRoutes } from '../src/routes/virtualTraining.js';

const NOW = Date.parse('2026-10-25T20:00:00Z');
let n = 0;
const ev = (type, data, at = '2026-10-25T19:00:00Z') => ({ id: `evt-${String(++n).padStart(6, '0')}`, type, at, device: 'phone', data });
const good = (raw) => {
  const r = validateEvent(raw, NOW);
  assert.equal(r.ok, true, r.error);
  return r.event;
};

test('ensureVirtualTraining fills gaps and keeps existing values', () => {
  const user = { virtualTraining: { settings: { tableSize: '6ft' }, matches: { won: 3 } } };
  const vt = ensureVirtualTraining(user);
  assert.equal(vt.settings.tableSize, '6ft');
  assert.equal(vt.settings.cueView, true);
  assert.equal(vt.matches.won, 3);
  assert.equal(vt.matches.played, 0);
  assert.deepEqual(vt.challenges.ladder, { unlockedLevel: 1, levels: {} });
  assert.equal(ensureVirtualTraining({}).schemaVersion, 1);
});

test('validateEvent rejects bad input', () => {
  const bad = (raw, text) => {
    const r = validateEvent(raw, NOW);
    assert.equal(r.ok, false, `expected rejection: ${text}`);
  };
  bad(null, 'null');
  bad({ ...ev('training.attempt', { exerciseId: 'x', score: 3, maxScore: 10 }), id: 'short' }, 'short id');
  bad(ev('training.attempt', { exerciseId: 'x', score: 11, maxScore: 10 }), 'score over max');
  bad(ev('training.attempt', { exerciseId: 'bad id!', score: 1, maxScore: 10 }), 'bad exercise id');
  bad(ev('training.attempt', { exerciseId: 'x', score: 1, maxScore: 10 }, '2026-10-25T21:00:00Z'), 'future');
  bad(ev('training.attempt', { exerciseId: 'x', score: 1, maxScore: 10 }, '2020-01-01T00:00:00Z'), 'too old');
  bad(ev('nonsense', {}), 'unknown type');
  bad(ev('challenge.result', { kind: 'daily', key: '2026-13-45', shots: 3, passed: true }), 'bad date');
  bad(ev('challenge.result', { kind: 'ladder', key: String(LADDER_LEVELS + 1), shots: 3, passed: true }), 'level too high');
  bad(ev('practice.session', { shots: 2, pots: 3, scratches: 0, seconds: 10 }), 'pots > shots');
  bad(ev('settings.update', {}), 'empty settings');
  bad(ev('settings.update', { tableSize: '9ft' }), 'bad table');
  bad(ev('match.result', { won: 'yes', framesFor: 1, framesAgainst: 0 }), 'won not boolean');
});

function scenario() {
  return [
    ev('training.attempt', { exerciseId: 'pot-1', score: 4, maxScore: 10 }, '2026-10-20T10:00:00Z'),
    ev('training.attempt', { exerciseId: 'pot-1', score: 8, maxScore: 10 }, '2026-10-20T10:01:00Z'),
    ev('training.session', { exerciseId: 'pot-1', score: 30, maxScore: 50, medal: 'bronze' }, '2026-10-20T10:05:00Z'),
    ev('training.session', { exerciseId: 'pot-1', score: 41, maxScore: 50, medal: 'GOLD' }, '2026-10-21T10:05:00Z'),
    ev('training.round', { score: 40, maxScore: 80 }, '2026-10-22T10:00:00Z'),
    ev('training.round', { score: 55, maxScore: 80 }, '2026-10-23T10:00:00Z'),
    ev('challenge.result', { kind: 'daily', key: '2026-10-24', shots: 9, passed: false }, '2026-10-24T09:00:00Z'),
    ev('challenge.result', { kind: 'daily', key: '2026-10-24', shots: 7, passed: true }, '2026-10-24T09:10:00Z'),
    ev('challenge.result', { kind: 'daily', key: '2026-10-24', shots: 6, passed: true }, '2026-10-24T09:20:00Z'),
    ev('challenge.result', { kind: 'ladder', key: '1', shots: 3, passed: true }, '2026-10-24T10:00:00Z'),
    ev('challenge.result', { kind: 'ladder', key: '2', shots: 12, passed: false }, '2026-10-24T10:10:00Z'),
    ev('challenge.result', { kind: 'ladder', key: '2', shots: 9, passed: true }, '2026-10-24T10:20:00Z'),
    ev('challenge.result', { kind: 'run', key: 'scatter-run', shots: 20, passed: true }, '2026-10-24T11:00:00Z'),
    ev('challenge.result', { kind: 'timed', pots: 6 }, '2026-10-24T12:00:00Z'),
    ev('challenge.result', { kind: 'timed', pots: 4 }, '2026-10-24T12:10:00Z'),
    ev('challenge.result', { kind: 'streak', streak: 3 }, '2026-10-24T13:00:00Z'),
    ev('match.result', { won: true, framesFor: 3, framesAgainst: 1, opponent: 'Sam' }, '2026-10-24T14:00:00Z'),
    ev('match.result', { won: false, framesFor: 0, framesAgainst: 3 }, '2026-10-24T15:00:00Z'),
    ev('practice.session', { shots: 40, pots: 22, scratches: 3, seconds: 900 }, '2026-10-24T16:00:00Z'),
    ev('practice.session', { shots: 10, pots: 5, scratches: 0, seconds: 300 }, '2026-10-24T17:00:00Z'),
    ev('settings.update', { tableSize: '6ft', cueView: false }, '2026-10-24T08:00:00Z'),
    ev('settings.update', { assistance: 'full' }, '2026-10-24T08:30:00Z'),
  ].map(good);
}

test('totals follow the rules', () => {
  const vt = rebuildFromEvents(scenario());
  const ex = vt.training.exercises['pot-1'];
  assert.equal(ex.attempts, 2);
  assert.deepEqual(ex.bestAttempt, { score: 8, max: 10 });
  assert.equal(ex.sessions, 2);
  assert.deepEqual(ex.bestSession, { score: 41, max: 50 });
  assert.equal(ex.bestMedal, 'gold');
  assert.deepEqual(vt.training.rounds.best, { score: 55, max: 80 });
  assert.deepEqual(vt.training.rounds.last, { score: 55, max: 80 });
  assert.equal(vt.training.rounds.played, 2);
  assert.deepEqual(vt.challenges.daily.byDate['2026-10-24'], { shots: 6, passed: true });
  assert.equal(vt.challenges.daily.played, 3);
  assert.equal(vt.challenges.daily.passed, 2);
  assert.deepEqual(vt.challenges.ladder.levels['2'], { plays: 2, completions: 1, bestShots: 9 });
  assert.equal(vt.challenges.ladder.unlockedLevel, 3);
  assert.equal(vt.challenges.runs['scatter-run'].bestShots, 20);
  assert.equal(vt.challenges.timed.bestPots, 6);
  assert.equal(vt.challenges.timed.lastPots, 4);
  assert.equal(vt.challenges.streak.bestStreak, 3);
  assert.deepEqual(
    { p: vt.matches.played, w: vt.matches.won, l: vt.matches.lost, fw: vt.matches.framesWon, fl: vt.matches.framesLost },
    { p: 2, w: 1, l: 1, fw: 3, fl: 4 },
  );
  assert.deepEqual(
    { s: vt.practice.sessions, sh: vt.practice.shots, po: vt.practice.pots, sc: vt.practice.scratches, se: vt.practice.seconds },
    { s: 2, sh: 50, po: 27, sc: 3, se: 1200 },
  );
  assert.deepEqual(
    { t: vt.settings.tableSize, a: vt.settings.assistance, c: vt.settings.cueView },
    { t: '6ft', a: 'full', c: false },
  );
  assert.equal(vt.firstPlayedAt, '2026-10-20T10:00:00.000Z');
  assert.equal(vt.lastPlayedAt, '2026-10-24T17:00:00.000Z');
  assert.equal(vt.eventCount, scenario().length);
});

test('a failed ladder level does not unlock the next one', () => {
  const vt = rebuildFromEvents([good(ev('challenge.result', { kind: 'ladder', key: '4', shots: 99, passed: false }))]);
  assert.equal(vt.challenges.ladder.unlockedLevel, 1);
  const top = rebuildFromEvents([good(ev('challenge.result', { kind: 'ladder', key: String(LADDER_LEVELS), shots: 9, passed: true }))]);
  assert.equal(top.challenges.ladder.unlockedLevel, LADDER_LEVELS);
});

test('daily history keeps only the latest 60 dates', () => {
  const events = [];
  for (let i = 0; i < 70; i += 1) {
    const day = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
    events.push(good(ev('challenge.result', { kind: 'daily', key: day, shots: 5, passed: true }, `${day}T10:00:00Z`)));
  }
  const dates = Object.keys(rebuildFromEvents(events).challenges.daily.byDate);
  assert.equal(dates.length, 60);
  assert.ok(!dates.includes('2026-07-01'));
});

const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v);
// lastDevice is "the device of the most recently received event", so it can differ by arrival order.
const strip = (vt) => { const c = structuredClone(vt); delete c.lastDevice; return JSON.stringify(canon(c)); };

test('order of events does not change the totals', () => {
  const events = scenario();
  const base = strip(rebuildFromEvents(events));
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 25; run += 1) {
    const shuffled = [...events].sort(() => rnd() - 0.5);
    assert.equal(strip(rebuildFromEvents(shuffled)), base);
  }
});

test('applying one at a time equals a rebuild', () => {
  const events = scenario();
  const live = defaultVirtualTraining();
  for (const e of events) applyEvent(live, e);
  assert.equal(strip(live), strip(rebuildFromEvents(events)));
});

// ---------- routes, with a stub app and an in-memory database ----------
function makeHarness() {
  const handlers = {};
  const app = {
    get: (p, ...fns) => { handlers[`GET ${p}`] = fns[fns.length - 1]; },
    post: (p, ...fns) => { handlers[`POST ${p}`] = fns[fns.length - 1]; },
  };
  let db = { users: [{ id: 'u1', firstName: 'A', lastName: 'B' }, { id: 'u2', firstName: 'C', lastName: 'D' }] };
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const dir = mkdtempSync(path.join(tmpdir(), 'vt-'));
  registerVirtualTrainingRoutes(app, {
    requireAuth: () => {}, requireAdmin: () => {},
    asyncRoute: (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } },
    ApiError,
    readDb: () => structuredClone(db),
    writeDb: (s) => { db = structuredClone(s); },
    DATA_DIR: dir,
  });
  const call = (key, req) => {
    let out; let error;
    handlers[key]({ query: {}, params: {}, body: {}, ...req }, { json: (b) => { out = b; } }, (e) => { error = e; });
    return { out, error };
  };
  return { call, dir, getDb: () => db };
}

test('routes: send, repeat, reject, read back, rebuild', () => {
  const h = makeHarness();
  const as = (userId) => ({ auth: { userId } });
  const batch = [
    ev('training.attempt', { exerciseId: 'pot-1', score: 7, maxScore: 10 }, '2026-10-25T10:00:00Z'),
    ev('challenge.result', { kind: 'streak', streak: 5 }, '2026-10-25T10:05:00Z'),
    { id: 'evt-bad-0001', type: 'training.attempt', at: '2026-10-25T10:00:00Z', data: { exerciseId: 'pot-1', score: 99, maxScore: 10 } },
  ];
  const first = h.call('POST /api/users/me/virtual-training/events', { ...as('u1'), body: { events: batch } });
  assert.equal(first.error, undefined);
  assert.deepEqual(first.out.results.map((r) => r.status), ['applied', 'applied', 'rejected']);
  assert.equal(first.out.virtualTraining.eventCount, 2);
  assert.equal(first.out.virtualTraining.challenges.streak.bestStreak, 5);

  const again = h.call('POST /api/users/me/virtual-training/events', { ...as('u1'), body: { events: batch.slice(0, 2) } });
  assert.deepEqual(again.out.results.map((r) => r.status), ['duplicate', 'duplicate']);
  assert.equal(again.out.virtualTraining.eventCount, 2);

  const other = h.call('GET /api/users/me/virtual-training', as('u2'));
  assert.equal(other.out.virtualTraining.eventCount, 0);
  assert.equal(h.getDb().users[1].virtualTraining, undefined);

  const mine = h.call('GET /api/users/me/virtual-training', as('u1'));
  assert.equal(mine.out.virtualTraining.training.exercises['pot-1'].attempts, 1);

  const list = h.call('GET /api/users/me/virtual-training/events', { ...as('u1'), query: { limit: '1' } });
  assert.equal(list.out.total, 2);
  assert.equal(list.out.events.length, 1);
  assert.equal(list.out.events[0].type, 'challenge.result');
  assert.equal(list.out.events[0].userId, undefined);
  assert.equal(h.call('GET /api/users/me/virtual-training/events', { ...as('u2') }).out.total, 0);

  // damage the totals, then rebuild from the log
  const broken = h.getDb();
  broken.users[0].virtualTraining.matches.played = 99;
  const file = readFileSync(path.join(h.dir, 'virtual-training-events.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(file.length, 2);
  const fixed = h.call('POST /api/admin/users/:id/virtual-training/rebuild', { params: { id: 'u1' } });
  assert.equal(fixed.out.rebuiltFrom, 2);
  assert.equal(fixed.out.virtualTraining.matches.played, 0);
  assert.equal(fixed.out.virtualTraining.challenges.streak.bestStreak, 5);
});

test('routes: limits and non-player sessions', () => {
  const h = makeHarness();
  const noList = h.call('POST /api/users/me/virtual-training/events', { auth: { userId: 'u1' }, body: { events: [] } });
  assert.equal(noList.error.status, 400);
  const tooMany = h.call('POST /api/users/me/virtual-training/events', {
    auth: { userId: 'u1' }, body: { events: Array.from({ length: 51 }, () => ev('training.round', { score: 1, maxScore: 2 })) },
  });
  assert.equal(tooMany.error.status, 400);
  const key = h.call('GET /api/users/me/virtual-training', { auth: { userId: 'apikey:abc' } });
  assert.equal(key.error.status, 403);
  const missing = h.call('GET /api/users/me/virtual-training', { auth: { userId: 'nobody' } });
  assert.equal(missing.error.status, 404);
});
