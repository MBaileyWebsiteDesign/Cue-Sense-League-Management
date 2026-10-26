// Run with: node --test   (from the server folder). No extra packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  academyPaid, academyView, applyEvent, defaultAcademy, ensureAcademy, ensureAcademyAccess, rebuildFromEvents, validateEvent,
} from '../src/services/poolAcademy.js';
import { registerPoolAcademyRoutes } from '../src/routes/poolAcademy.js';
import { publicUser } from '../src/userAuth.js';

const NOW = Date.parse('2026-10-26T20:00:00Z');
let n = 0;
const RECENT = new Date(Date.now() - 60000).toISOString(); // the routes use the real clock
const ev = (type, data, at = '2026-10-26T19:00:00Z') => ({ id: `acd-${String(++n).padStart(6, '0')}`, type, at, data });
const good = (raw) => { const r = validateEvent(raw, NOW); assert.equal(r.ok, true, r.error); return r.event; };

test('ensureAcademy fills gaps and keeps existing values', () => {
  const user = { academy: { levels: { 1: { lessonsCompleted: 4 } }, eventCount: 9 } };
  const a = ensureAcademy(user);
  assert.equal(a.levels['1'].lessonsCompleted, 4);
  assert.equal(a.levels['1'].quizzesPassed, 0);
  assert.equal(Object.keys(a.levels).length, 5);
  assert.equal(a.eventCount, 9);
  assert.equal(ensureAcademy({}).schemaVersion, 1);
});

test('validateEvent rejects bad input', () => {
  const bad = (raw, text) => assert.equal(validateEvent(raw, NOW).ok, false, `expected rejection: ${text}`);
  bad(null, 'null');
  bad({ ...ev('lesson.completed', { level: 1, lessonKey: 'l1' }), id: 'short' }, 'short id');
  bad(ev('lesson.completed', { level: 6, lessonKey: 'l1' }), 'level 6');
  bad(ev('lesson.completed', { level: 1, lessonKey: 'bad key!' }), 'bad key');
  bad(ev('lesson.completed', { level: 1 }), 'no key');
  bad(ev('quiz.attempt', { level: 1, quizKey: 'q1', score: 11, maxScore: 10, passed: true }), 'score over max');
  bad(ev('quiz.attempt', { level: 1, quizKey: 'q1', score: 5, maxScore: 10, passed: 'yes' }), 'passed not boolean');
  bad(ev('challenge.day', { date: '2026-13-45' }), 'bad date');
  bad(ev('lesson.completed', { level: 1, lessonKey: 'l1' }, '2026-10-26T21:00:00Z'), 'future');
  bad(ev('lesson.completed', { level: 1, lessonKey: 'l1' }, '2020-01-01T00:00:00Z'), 'too old');
  bad(ev('nonsense', {}), 'unknown type');
});

function scenario() {
  return [
    ev('lesson.visited', { level: 1, lessonKey: 'less-a' }, '2026-10-20T09:00:00Z'),
    ev('lesson.completed', { level: 1, lessonKey: 'less-a' }, '2026-10-20T09:10:00Z'),
    ev('lesson.completed', { level: 1, lessonKey: 'less-a' }, '2026-10-21T09:10:00Z'),
    ev('lesson.completed', { level: 1, lessonKey: 'less-b' }, '2026-10-21T10:00:00Z'),
    ev('quiz.attempt', { level: 1, quizKey: 'quiz-1', score: 4, maxScore: 10, passed: false }, '2026-10-21T10:30:00Z'),
    ev('quiz.attempt', { level: 1, quizKey: 'quiz-1', score: 8, maxScore: 10, passed: true }, '2026-10-21T10:40:00Z'),
    ev('quiz.attempt', { level: 1, quizKey: 'quiz-1', score: 6, maxScore: 10, passed: false }, '2026-10-22T10:40:00Z'),
    ev('lesson.visited', { level: 2, lessonKey: 'less-c' }, '2026-10-23T09:00:00Z'),
    ev('lesson.completed', { level: 2, lessonKey: 'less-c' }, '2026-10-23T09:30:00Z'),
    ev('challenge.day', { date: '2026-10-24' }, '2026-10-24T18:00:00Z'),
    ev('challenge.day', { date: '2026-10-25' }, '2026-10-25T18:00:00Z'),
    ev('challenge.day', { date: '2026-10-25' }, '2026-10-25T19:00:00Z'),
  ].map(good);
}

test('totals are right', () => {
  const a = rebuildFromEvents(scenario());
  assert.equal(a.eventCount, 12);
  assert.equal(a.firstActiveAt, '2026-10-20T09:00:00.000Z');
  assert.equal(a.lastActiveAt, '2026-10-25T19:00:00.000Z');
  assert.equal(a.highestLevel, 2);
  assert.equal(a.lessons['less-a'].completedAt, '2026-10-20T09:10:00.000Z');
  assert.equal(a.levels['1'].lessonsCompleted, 2);
  assert.equal(a.levels['2'].lessonsCompleted, 1);
  assert.deepEqual(a.quizzes['quiz-1'], { level: 1, attempts: 3, best: { score: 8, max: 10 }, passed: true, lastAttemptAt: '2026-10-22T10:40:00.000Z' });
  assert.equal(a.levels['1'].quizzesPassed, 1);
  assert.equal(a.levels['1'].quizAttempts, 3);
  assert.equal(a.practice.daysDone, 2);
  assert.equal(a.practice.firstDay, '2026-10-24');
  assert.equal(a.practice.lastDay, '2026-10-25');
  assert.deepEqual(a.lastVisited, { level: 2, lessonKey: 'less-c', at: '2026-10-23T09:00:00.000Z' });
  assert.equal(a.levels['2'].lastActivityAt, '2026-10-25T19:00:00.000Z');
});

const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

test('order of events does not change the totals, and one at a time equals a rebuild', () => {
  const events = scenario();
  const base = JSON.stringify(canon(rebuildFromEvents(events)));
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 25; run += 1) {
    assert.equal(JSON.stringify(canon(rebuildFromEvents([...events].sort(() => rnd() - 0.5)))), base);
  }
  const live = defaultAcademy();
  for (const e of events) applyEvent(live, e);
  assert.equal(JSON.stringify(canon(live)), base);
});

test('view: unpaid sees Level 1 only, paid sees everything, nothing is deleted', () => {
  const user = { academy: rebuildFromEvents(scenario()) };
  const free = academyView(user);
  assert.equal(free.levelsUnlocked, false);
  assert.deepEqual(Object.keys(free.academy.levels), ['1']);
  assert.deepEqual(Object.keys(free.academy.lessons), ['less-a', 'less-b']);
  assert.equal(free.academy.practice, undefined);
  assert.equal(free.academy.lastVisited, null);
  assert.equal(user.academy.levels['2'].lessonsCompleted, 1);
  ensureAcademyAccess(user).paid = true;
  assert.equal(academyPaid(user), true);
  const full = academyView(user);
  assert.equal(full.levelsUnlocked, true);
  assert.equal(full.academy.practice.daysDone, 2);
});

test('account data sent to the browser never includes the progress block', () => {
  const out = publicUser({ id: 'x', passwordHash: 'h', academy: { eventCount: 3 }, academyAccess: { paid: false }, virtualTraining: {} });
  assert.equal(out.academy, undefined);
  assert.equal(out.passwordHash, undefined);
  assert.deepEqual(out.academyAccess, { paid: false });
});

function makeHarness() {
  const handlers = {};
  const app = {
    get: (p, ...fns) => { handlers[`GET ${p}`] = fns[fns.length - 1]; },
    post: (p, ...fns) => { handlers[`POST ${p}`] = fns[fns.length - 1]; },
  };
  let db = {
    users: [
      { id: 'u1', firstName: 'A', lastName: 'B', email: 'a@x.test', academyAccess: { paid: true, since: '2026-10-01T00:00:00.000Z', changedAt: null, changedBy: null } },
      { id: 'u3', firstName: 'E', lastName: 'F', email: 'e@x.test' },
    ],
    auditLog: [],
  };
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const dir = mkdtempSync(path.join(tmpdir(), 'acd-'));
  registerPoolAcademyRoutes(app, {
    requireAuth: () => {}, requireAdmin: () => {},
    asyncRoute: (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } },
    ApiError,
    recordAudit: (d, entry) => d.auditLog.push(entry),
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

test('routes: free player can save Level 1 but Level 2 and the challenge are refused', () => {
  const h = makeHarness();
  const as = { auth: { userId: 'u3' } };
  const batch = [
    ev('lesson.completed', { level: 1, lessonKey: 'less-a' }, RECENT),
    ev('lesson.completed', { level: 2, lessonKey: 'less-c' }, RECENT),
    ev('challenge.day', { date: '2026-10-25' }, '2026-10-25T18:00:00Z'),
    ev('quiz.attempt', { level: 1, quizKey: 'quiz-1', score: 7, maxScore: 10, passed: true }, RECENT),
  ];
  const r = h.call('POST /api/users/me/academy/events', { ...as, body: { events: batch } });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.out.results.map((x) => x.status), ['applied', 'rejected', 'rejected', 'applied']);
  assert.equal(r.out.levelsUnlocked, false);
  assert.equal(r.out.academy.eventCount, 2);
  const logged = readFileSync(path.join(h.dir, 'academy-events.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(logged.length, 2);
  const get = h.call('GET /api/users/me/academy', as);
  assert.equal(get.out.academy.levels['2'], undefined);
  const evs = h.call('GET /api/users/me/academy/events', as);
  assert.equal(evs.out.total, 2);
});

test('routes: paid player saves every level, repeats are ignored, admin switch works and is audited', () => {
  const h = makeHarness();
  const batch = [
    ev('lesson.completed', { level: 3, lessonKey: 'less-z' }, RECENT),
    ev('challenge.day', { date: '2026-10-25' }, '2026-10-25T18:00:00Z'),
  ];
  const first = h.call('POST /api/users/me/academy/events', { auth: { userId: 'u1' }, body: { events: batch } });
  assert.deepEqual(first.out.results.map((x) => x.status), ['applied', 'applied']);
  assert.equal(first.out.levelsUnlocked, true);
  const again = h.call('POST /api/users/me/academy/events', { auth: { userId: 'u1' }, body: { events: batch } });
  assert.deepEqual(again.out.results.map((x) => x.status), ['duplicate', 'duplicate']);
  assert.equal(again.out.academy.eventCount, 2);

  const admin = { auth: { userId: 'admin', user: { firstName: 'Root', lastName: 'Admin', email: 'r@x.test' } } };
  const bad = h.call('POST /api/admin/users/:id/academy-access', { ...admin, params: { id: 'u1' }, body: { paid: 'yes' } });
  assert.equal(bad.error.status, 400);
  assert.equal(h.call('POST /api/admin/users/:id/academy-access', { ...admin, params: { id: 'nope' }, body: { paid: true } }).error.status, 404);
  const off = h.call('POST /api/admin/users/:id/academy-access', { ...admin, params: { id: 'u1' }, body: { paid: false } });
  assert.equal(off.out.paid, false);
  assert.equal(h.getDb().auditLog.length, 1);
  assert.equal(h.getDb().auditLog[0].action, 'user.academyAccess');
  h.call('POST /api/admin/users/:id/academy-access', { ...admin, params: { id: 'u1' }, body: { paid: false } });
  assert.equal(h.getDb().auditLog.length, 1, 'no change, no audit entry');
  const now = h.call('GET /api/users/me/academy', { auth: { userId: 'u1' } });
  assert.equal(now.out.levelsUnlocked, false);
  assert.equal(now.out.academy.eventCount, 2, 'progress kept after switching off');
  const on = h.call('POST /api/admin/users/:id/academy-access', { ...admin, params: { id: 'u3' }, body: { paid: true } });
  assert.equal(on.out.paid, true);
  assert.ok(on.out.since);
  const list = h.call('GET /api/admin/academy/users', admin);
  assert.equal(list.out.total, 2);
  assert.equal(list.out.paid, 1);
  const rebuilt = h.call('POST /api/admin/users/:id/academy/rebuild', { ...admin, params: { id: 'u1' } });
  assert.equal(rebuilt.out.rebuiltFrom, 2);
  assert.equal(rebuilt.out.academy.levels['3'].lessonsCompleted, 1);
});

test('routes: limits and non-player sessions', () => {
  const h = makeHarness();
  assert.equal(h.call('POST /api/users/me/academy/events', { auth: { userId: 'apikey:1' }, body: { events: [] } }).error.status, 403);
  assert.equal(h.call('POST /api/users/me/academy/events', { auth: { userId: 'u1' }, body: { events: [] } }).error.status, 400);
  assert.equal(h.call('POST /api/users/me/academy/events', { auth: { userId: 'u1' }, body: { events: Array.from({ length: 51 }, () => ev('lesson.visited', { level: 1, lessonKey: 'a' }, RECENT)) } }).error.status, 400);
});
