// Pool Academy profile (added 2026-10-26).
//
// The CueSense Pool Academy (cuesense.co.uk/academy, a Wix site with five levels)
// shares this app's login. What a player has done there lives on their account in
// `user.academy` (small running totals) plus an append-only event log (see
// routes/poolAcademy.js) that keeps the FULL history. The totals are always
// derivable from the events: applyEvent() updates them one event at a time and
// rebuildFromEvents() recomputes them from the log.
//
// Every update rule is order-independent (earliest completion wins, bests take the
// best, "last" values compare timestamps), so replaying the log gives the same
// totals as applying events as they arrived.
//
// Paywall: Level 1 is free. Levels 2-5 need `user.academyAccess.paid` (one switch,
// set by an Overall Admin in Admin Portal > Pool Academy). The flag lives beside the
// stats block, NOT inside it, so rebuilding the stats can never change access.
//
// NOT decided here: lesson and quiz keys are whatever the Academy site sends (for
// example the Wix Online Programs step ids); they are validated for shape only.

export const ACADEMY_SCHEMA_VERSION = 1;
export const ACADEMY_LEVELS = 5;
export const FREE_LEVEL = 1;
export const MAX_BATCH = 50;
export const MAX_EVENT_BYTES = 1024;
export const MAX_LESSONS = 400;
export const MAX_QUIZZES = 200;
export const MAX_PRACTICE_DAYS = 120;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIVE_MIN_MS = 5 * 60 * 1000;
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export function defaultAcademyAccess() {
  return { paid: false, since: null, changedAt: null, changedBy: null };
}

export function ensureAcademyAccess(user) {
  if (!user.academyAccess || typeof user.academyAccess !== 'object') user.academyAccess = {};
  const defaults = defaultAcademyAccess();
  for (const key of Object.keys(defaults)) {
    if (user.academyAccess[key] === undefined) user.academyAccess[key] = defaults[key];
  }
  return user.academyAccess;
}

export const academyPaid = (user) => !!(user && user.academyAccess && user.academyAccess.paid === true);

const emptyLevel = () => ({ lessonsCompleted: 0, quizzesPassed: 0, quizAttempts: 0, lastActivityAt: null });

export function defaultAcademy() {
  const levels = {};
  for (let n = 1; n <= ACADEMY_LEVELS; n += 1) levels[String(n)] = emptyLevel();
  return {
    schemaVersion: ACADEMY_SCHEMA_VERSION,
    firstActiveAt: null,
    lastActiveAt: null,
    lastSyncAt: null,
    eventCount: 0,
    // Highest level the player has completed a lesson or quiz in (0 = none yet).
    highestLevel: 0,
    // levels: '1'..'5' -> { lessonsCompleted, quizzesPassed, quizAttempts, lastActivityAt }
    levels,
    // lessons: lessonKey -> { level, completedAt }   (earliest completion kept)
    lessons: {},
    // quizzes: quizKey -> { level, attempts, best: {score,max}|null, passed, lastAttemptAt }
    quizzes: {},
    // The Level 2 30-day practice challenge: days: 'YYYY-MM-DD' -> true
    practice: { days: {}, daysDone: 0, firstDay: null, lastDay: null },
    // Where to resume: { level, lessonKey, at } (the most recent visit wins)
    lastVisited: null,
  };
}

export function ensureAcademy(user) {
  const defaults = defaultAcademy();
  const fill = (target, source) => {
    for (const key of Object.keys(source)) {
      const want = source[key];
      if (target[key] === undefined) {
        target[key] = structuredClone(want);
      } else if (
        want && typeof want === 'object' && !Array.isArray(want) &&
        target[key] && typeof target[key] === 'object' && Object.keys(want).length > 0
      ) {
        fill(target[key], want);
      }
    }
  };
  if (!user.academy || typeof user.academy !== 'object') user.academy = {};
  fill(user.academy, defaults);
  user.academy.schemaVersion = ACADEMY_SCHEMA_VERSION;
  return user.academy;
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const isNum = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const isKey = (s) => typeof s === 'string' && KEY_RE.test(s);

// The level an event belongs to (the practice challenge is a Level 2 feature).
export function eventLevel(event) {
  return event.type === 'challenge.day' ? 2 : event.data.level;
}

// Returns { ok: true, event } (cleaned copy) or { ok: false, error }.
export function validateEvent(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Event must be an object' };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { ok: false, error: 'id must be 8-64 letters, digits, - or _' };
  if (JSON.stringify(raw).length > MAX_EVENT_BYTES) return { ok: false, error: 'Event is too large' };
  const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
  if (Number.isNaN(atMs)) return { ok: false, error: 'at must be an ISO date-time' };
  if (atMs > nowMs + FIVE_MIN_MS) return { ok: false, error: 'at is in the future' };
  if (atMs < nowMs - TWO_YEARS_MS) return { ok: false, error: 'at is more than two years old' };
  const at = new Date(atMs).toISOString();
  const d = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null;
  if (!d) return { ok: false, error: 'data must be an object' };
  const base = { id: raw.id, type: raw.type, at };

  switch (raw.type) {
    case 'lesson.completed':
    case 'lesson.visited': {
      if (!isInt(d.level, 1, ACADEMY_LEVELS)) return { ok: false, error: `level must be a whole number 1-${ACADEMY_LEVELS}` };
      if (!isKey(d.lessonKey)) return { ok: false, error: 'lessonKey is required' };
      return { ok: true, event: { ...base, data: { level: d.level, lessonKey: d.lessonKey } } };
    }
    case 'quiz.attempt': {
      if (!isInt(d.level, 1, ACADEMY_LEVELS)) return { ok: false, error: `level must be a whole number 1-${ACADEMY_LEVELS}` };
      if (!isKey(d.quizKey)) return { ok: false, error: 'quizKey is required' };
      if (!isInt(d.maxScore, 1, 1000)) return { ok: false, error: 'maxScore must be a whole number 1-1000' };
      if (!isNum(d.score, 0, d.maxScore)) return { ok: false, error: 'score must be between 0 and maxScore' };
      if (typeof d.passed !== 'boolean') return { ok: false, error: 'passed must be true or false' };
      return { ok: true, event: { ...base, data: { level: d.level, quizKey: d.quizKey, score: d.score, maxScore: d.maxScore, passed: d.passed } } };
    }
    case 'challenge.day': {
      if (typeof d.date !== 'string' || !DATE_RE.test(d.date) || Number.isNaN(Date.parse(d.date))) return { ok: false, error: 'date must be a YYYY-MM-DD date' };
      return { ok: true, event: { ...base, data: { date: d.date } } };
    }
    default:
      return { ok: false, error: `Unknown event type: ${raw.type}` };
  }
}

const minIso = (a, b) => (!a ? b : !b ? a : a <= b ? a : b);
const maxIso = (a, b) => (!a ? b : !b ? a : a >= b ? a : b);

// Better = higher share of the maximum; a tie keeps the higher raw score.
function betterScore(current, cand) {
  if (!current) return true;
  const a = cand.score / cand.max;
  const b = current.score / current.max;
  return a > b || (a === b && cand.score > current.score);
}

function recountLevel(a, level) {
  const key = String(level);
  const row = a.levels[key];
  row.lessonsCompleted = Object.values(a.lessons).filter((l) => l.level === level).length;
  const quizzes = Object.values(a.quizzes).filter((q) => q.level === level);
  row.quizzesPassed = quizzes.filter((q) => q.passed).length;
  row.quizAttempts = quizzes.reduce((n, q) => n + q.attempts, 0);
}

// Applies one already-validated event. Returns { applied: false, reason } when a
// size cap stops it (the event is still in the log), else { applied: true }.
export function applyEvent(a, event) {
  const { type, at, data: d } = event;
  a.eventCount += 1;
  a.firstActiveAt = minIso(a.firstActiveAt, at);
  a.lastActiveAt = maxIso(a.lastActiveAt, at);

  if (type === 'lesson.visited') {
    if (!a.lastVisited || at >= a.lastVisited.at) a.lastVisited = { level: d.level, lessonKey: d.lessonKey, at };
    return { applied: true };
  }

  if (type === 'lesson.completed') {
    const existing = a.lessons[d.lessonKey];
    if (!existing && Object.keys(a.lessons).length >= MAX_LESSONS) return { applied: false, reason: 'lesson limit reached' };
    a.lessons[d.lessonKey] = { level: d.level, completedAt: minIso(existing && existing.completedAt, at) };
    recountLevel(a, d.level);
  } else if (type === 'quiz.attempt') {
    const existing = a.quizzes[d.quizKey];
    if (!existing && Object.keys(a.quizzes).length >= MAX_QUIZZES) return { applied: false, reason: 'quiz limit reached' };
    const q = (a.quizzes[d.quizKey] ||= { level: d.level, attempts: 0, best: null, passed: false, lastAttemptAt: null });
    q.attempts += 1;
    const cand = { score: d.score, max: d.maxScore };
    if (betterScore(q.best, cand)) q.best = cand;
    q.passed = q.passed || d.passed;
    q.lastAttemptAt = maxIso(q.lastAttemptAt, at);
    recountLevel(a, d.level);
  } else if (type === 'challenge.day') {
    const p = a.practice;
    if (!p.days[d.date] && Object.keys(p.days).length >= MAX_PRACTICE_DAYS) return { applied: false, reason: 'practice day limit reached' };
    p.days[d.date] = true;
    p.daysDone = Object.keys(p.days).length;
    p.firstDay = minIso(p.firstDay, d.date);
    p.lastDay = maxIso(p.lastDay, d.date);
  }

  const level = eventLevel(event);
  const row = a.levels[String(level)];
  row.lastActivityAt = maxIso(row.lastActivityAt, at);
  if (type !== 'challenge.day' && level > a.highestLevel) a.highestLevel = level;
  return { applied: true };
}

// Recomputes the block from validated events (in any order).
export function rebuildFromEvents(events) {
  const a = defaultAcademy();
  for (const e of events) applyEvent(a, e);
  return a;
}

// What a player is allowed to see: everything when Levels 2-5 are switched on,
// otherwise Level 1 only (higher-level progress is kept but not served).
export function academyView(user) {
  const a = ensureAcademy(user);
  const paid = academyPaid(user);
  if (paid) return { levelsUnlocked: true, academy: a };
  const only = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v.level === FREE_LEVEL));
  const lessons = only(a.lessons);
  const quizzes = only(a.quizzes);
  const free = {
    ...defaultAcademy(),
    firstActiveAt: a.firstActiveAt,
    lastActiveAt: a.lastActiveAt,
    eventCount: a.eventCount,
    highestLevel: Math.min(a.highestLevel, FREE_LEVEL),
    levels: { [String(FREE_LEVEL)]: a.levels[String(FREE_LEVEL)] },
    lessons,
    quizzes,
    lastVisited: a.lastVisited && a.lastVisited.level === FREE_LEVEL ? a.lastVisited : null,
  };
  delete free.practice;
  return { levelsUnlocked: false, academy: free };
}
