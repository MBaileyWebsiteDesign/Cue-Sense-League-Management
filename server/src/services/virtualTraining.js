// Virtual Training profile (added 2026-10-25).
//
// The CueSense Virtual Training app (a separate 3D pool training app) shares this
// app's login. Everything it records for a player lives on that player's
// account in `user.virtualTraining` (small running totals and bests) plus an
// append-only event log (see routes/virtualTraining.js) that keeps the FULL
// history. The totals are always derivable from the events: they are updated
// one event at a time by applyEvent() below, and rebuildFromEvents() can
// recompute them from the log.
//
// Every update rule is order-independent (counters add, bests take the best,
// "last" values compare timestamps), so replaying the log gives the same
// totals as applying events as they arrived, and a late-delivered event from an
// offline device cannot overwrite something newer.
//
// What is NOT decided here: exercise ids, challenge ids and medal names are
// whatever the Virtual Training app sends (validated only for shape and size),
// because this app does not own those lists.

export const VT_SCHEMA_VERSION = 1;
export const LADDER_LEVELS = 8;
export const MAX_DAILY_DATES = 60;
export const MAX_BATCH = 50;
export const MAX_EVENT_BYTES = 2048;

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TABLE_SIZES = ['6ft', '7ft'];
const CHALLENGE_KINDS = ['daily', 'ladder', 'run', 'timed', 'streak', 'breakrun'];
const FIVE_MIN_MS = 5 * 60 * 1000;
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// Paywall (2026-10-25): whether this account has paid for Virtual Training. It
// lives beside the stats block, NOT inside it, so rebuilding the stats from the
// event log can never switch someone's access on or off. Off by default for
// everyone; only an Overall Admin changes it (Admin Portal > Virtual Training).
export function defaultVtAccess() {
  return { paid: false, since: null, changedAt: null, changedBy: null };
}

export function ensureVtAccess(user) {
  if (!user.virtualTrainingAccess || typeof user.virtualTrainingAccess !== 'object') user.virtualTrainingAccess = {};
  const defaults = defaultVtAccess();
  for (const key of Object.keys(defaults)) {
    if (user.virtualTrainingAccess[key] === undefined) user.virtualTrainingAccess[key] = defaults[key];
  }
  return user.virtualTrainingAccess;
}

export const vtPaid = (user) => !!(user && user.virtualTrainingAccess && user.virtualTrainingAccess.paid === true);

export function defaultVirtualTraining() {
  return {
    schemaVersion: VT_SCHEMA_VERSION,
    firstPlayedAt: null,
    lastPlayedAt: null,
    lastSyncAt: null,
    lastDevice: null,
    eventCount: 0,
    // updatedAt: setting name -> when it was last changed (an older change arriving late never overrides a newer one).
    settings: { tableSize: '7ft', assistance: null, camera: null, quality: null, cueView: true, updatedAt: {} },
    training: {
      // exerciseId -> { attempts, bestAttempt: {score,max}|null, sessions,
      //   bestSession: {score,max}|null, bestMedal: 'gold'|... |null, lastPlayedAt }
      exercises: {},
      rounds: { played: 0, best: null, last: null, lastAt: null },
    },
    challenges: {
      lastPlayedAt: null,
      // byDate: 'YYYY-MM-DD' -> { shots, passed }   (latest MAX_DAILY_DATES dates)
      daily: { played: 0, passed: 0, byDate: {} },
      // levels: '1'..'8' -> { plays, completions, bestShots|null }
      ladder: { unlockedLevel: 1, levels: {} },
      // runs: runId -> { plays, completions, bestShots|null }
      runs: {},
      timed: { plays: 0, bestPots: null, lastPots: null, lastAt: null },
      streak: { plays: 0, bestStreak: null, lastStreak: null, lastAt: null },
      // "Break and pot" (added 2026-10-26): balls potted before the first miss; cleared = attempts that potted every ball.
      breakRun: { plays: 0, bestPots: null, lastPots: null, lastAt: null, cleared: 0 },
    },
    matches: { played: 0, won: 0, lost: 0, framesWon: 0, framesLost: 0, lastPlayedAt: null },
    practice: { sessions: 0, shots: 0, pots: 0, scratches: 0, seconds: 0, lastPracticeAt: null },
  };
}

// Fills in anything missing (older records, or fields added later) without
// touching values that already exist. Returns the block.
export function ensureVirtualTraining(user) {
  const defaults = defaultVirtualTraining();
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
  if (!user.virtualTraining || typeof user.virtualTraining !== 'object') user.virtualTraining = {};
  fill(user.virtualTraining, defaults);
  user.virtualTraining.schemaVersion = VT_SCHEMA_VERSION;
  return user.virtualTraining;
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const isNum = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const isKey = (s) => typeof s === 'string' && KEY_RE.test(s);
const isShortStr = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

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
  const device = raw.device == null ? null : String(raw.device).slice(0, 40);
  const base = { id: raw.id, type: raw.type, at, device };

  switch (raw.type) {
    case 'training.attempt': {
      if (!isKey(d.exerciseId)) return { ok: false, error: 'exerciseId is required' };
      if (!isInt(d.maxScore, 1, 1000)) return { ok: false, error: 'maxScore must be a whole number 1-1000' };
      if (!isNum(d.score, 0, d.maxScore)) return { ok: false, error: 'score must be between 0 and maxScore' };
      return { ok: true, event: { ...base, data: { exerciseId: d.exerciseId, score: d.score, maxScore: d.maxScore } } };
    }
    case 'training.session': {
      if (!isKey(d.exerciseId)) return { ok: false, error: 'exerciseId is required' };
      if (!isInt(d.maxScore, 1, 10000)) return { ok: false, error: 'maxScore must be a whole number 1-10000' };
      if (!isNum(d.score, 0, d.maxScore)) return { ok: false, error: 'score must be between 0 and maxScore' };
      const medal = d.medal == null ? null : String(d.medal).toLowerCase().slice(0, 12);
      return { ok: true, event: { ...base, data: { exerciseId: d.exerciseId, score: d.score, maxScore: d.maxScore, medal } } };
    }
    case 'training.round': {
      if (!isInt(d.maxScore, 1, 10000)) return { ok: false, error: 'maxScore must be a whole number 1-10000' };
      if (!isNum(d.score, 0, d.maxScore)) return { ok: false, error: 'score must be between 0 and maxScore' };
      return { ok: true, event: { ...base, data: { score: d.score, maxScore: d.maxScore } } };
    }
    case 'challenge.result': {
      if (!CHALLENGE_KINDS.includes(d.kind)) return { ok: false, error: `kind must be one of: ${CHALLENGE_KINDS.join(', ')}` };
      const out = { kind: d.kind };
      if (d.kind === 'daily') {
        if (typeof d.key !== 'string' || !DATE_RE.test(d.key) || Number.isNaN(Date.parse(d.key))) return { ok: false, error: 'daily key must be a YYYY-MM-DD date' };
        if (!isInt(d.shots, 0, 10000)) return { ok: false, error: 'shots must be a whole number' };
        if (typeof d.passed !== 'boolean') return { ok: false, error: 'passed must be true or false' };
        Object.assign(out, { key: d.key, shots: d.shots, passed: d.passed });
      } else if (d.kind === 'ladder') {
        const level = Number(d.key);
        if (!isInt(level, 1, LADDER_LEVELS)) return { ok: false, error: `ladder key must be a level 1-${LADDER_LEVELS}` };
        if (!isInt(d.shots, 0, 10000)) return { ok: false, error: 'shots must be a whole number' };
        if (typeof d.passed !== 'boolean') return { ok: false, error: 'passed must be true or false' };
        Object.assign(out, { key: String(level), shots: d.shots, passed: d.passed });
      } else if (d.kind === 'run') {
        if (!isKey(d.key)) return { ok: false, error: 'run key is required' };
        if (!isInt(d.shots, 0, 10000)) return { ok: false, error: 'shots must be a whole number' };
        if (typeof d.passed !== 'boolean') return { ok: false, error: 'passed must be true or false' };
        Object.assign(out, { key: d.key, shots: d.shots, passed: d.passed });
      } else if (d.kind === 'timed') {
        if (!isInt(d.pots, 0, 10000)) return { ok: false, error: 'pots must be a whole number' };
        Object.assign(out, { pots: d.pots });
      } else if (d.kind === 'breakrun') {
        if (!isInt(d.pots, 0, 100)) return { ok: false, error: 'pots must be a whole number 0-100' };
        if (d.cleared !== undefined && typeof d.cleared !== 'boolean') return { ok: false, error: 'cleared must be true or false' };
        Object.assign(out, { pots: d.pots, cleared: d.cleared === true });
      } else {
        if (!isInt(d.streak, 0, 10000)) return { ok: false, error: 'streak must be a whole number' };
        Object.assign(out, { streak: d.streak });
      }
      return { ok: true, event: { ...base, data: out } };
    }
    case 'match.result': {
      if (typeof d.won !== 'boolean') return { ok: false, error: 'won must be true or false' };
      if (!isInt(d.framesFor, 0, 100) || !isInt(d.framesAgainst, 0, 100)) return { ok: false, error: 'framesFor and framesAgainst must be whole numbers 0-100' };
      const opponent = d.opponent == null ? 'guest' : String(d.opponent).slice(0, 60) || 'guest';
      return { ok: true, event: { ...base, data: { won: d.won, framesFor: d.framesFor, framesAgainst: d.framesAgainst, opponent } } };
    }
    case 'practice.session': {
      if (!isInt(d.shots, 0, 100000) || !isInt(d.pots, 0, 100000) || !isInt(d.scratches, 0, 100000)) return { ok: false, error: 'shots, pots and scratches must be whole numbers' };
      if (d.pots > d.shots) return { ok: false, error: 'pots cannot be more than shots' };
      if (!isInt(d.seconds, 0, 86400)) return { ok: false, error: 'seconds must be a whole number up to 86400' };
      return { ok: true, event: { ...base, data: { shots: d.shots, pots: d.pots, scratches: d.scratches, seconds: d.seconds } } };
    }
    case 'settings.update': {
      const out = {};
      if (d.tableSize !== undefined) {
        if (!TABLE_SIZES.includes(d.tableSize)) return { ok: false, error: `tableSize must be one of: ${TABLE_SIZES.join(', ')}` };
        out.tableSize = d.tableSize;
      }
      for (const field of ['assistance', 'camera', 'quality']) {
        if (d[field] !== undefined) {
          if (d[field] !== null && !isShortStr(d[field], 20)) return { ok: false, error: `${field} must be short text` };
          out[field] = d[field];
        }
      }
      if (d.cueView !== undefined) {
        if (typeof d.cueView !== 'boolean') return { ok: false, error: 'cueView must be true or false' };
        out.cueView = d.cueView;
      }
      if (Object.keys(out).length === 0) return { ok: false, error: 'settings.update needs at least one setting' };
      return { ok: true, event: { ...base, data: out } };
    }
    default:
      return { ok: false, error: 'Unknown event type' };
  }
}

// ratio helpers: best = higher score/max; tie -> larger max; tie -> earlier.
function betterScore(current, candidate) {
  if (!current) return true;
  const a = candidate.score / candidate.max;
  const b = current.score / current.max;
  if (a !== b) return a > b;
  if (candidate.max !== current.max) return candidate.max > current.max;
  return false;
}

const laterOrEqual = (atIso, prevIso) => !prevIso || atIso >= prevIso;
const maxIso = (a, b) => (!a || b > a ? b : a);
const minIso = (a, b) => (!a || b < a ? b : a);

function touchPlayed(vt, at) {
  vt.firstPlayedAt = minIso(vt.firstPlayedAt, at);
  vt.lastPlayedAt = maxIso(vt.lastPlayedAt, at);
}

function bestShotsEntry(map, key) {
  if (!map[key]) map[key] = { plays: 0, completions: 0, bestShots: null };
  return map[key];
}

// Applies one VALIDATED event to the block (mutates). Does no id de-duplication:
// the caller does that.
export function applyEvent(vt, event) {
  const { type, at, data: d } = event;
  vt.eventCount += 1;
  if (event.device) vt.lastDevice = event.device;

  if (type === 'settings.update') {
    // Each setting keeps its own timestamp, so an older change that arrives
    // late never overrides a newer one, whatever else was sent with it.
    for (const field of Object.keys(d)) {
      if (laterOrEqual(at, vt.settings.updatedAt[field])) {
        vt.settings[field] = d[field];
        vt.settings.updatedAt[field] = at;
      }
    }
    return vt;
  }

  touchPlayed(vt, at);

  if (type === 'training.attempt') {
    const ex = (vt.training.exercises[d.exerciseId] ||= { attempts: 0, bestAttempt: null, sessions: 0, bestSession: null, bestMedal: null, lastPlayedAt: null });
    ex.attempts += 1;
    const cand = { score: d.score, max: d.maxScore };
    if (betterScore(ex.bestAttempt, cand)) ex.bestAttempt = cand;
    ex.lastPlayedAt = maxIso(ex.lastPlayedAt, at);
  } else if (type === 'training.session') {
    const ex = (vt.training.exercises[d.exerciseId] ||= { attempts: 0, bestAttempt: null, sessions: 0, bestSession: null, bestMedal: null, lastPlayedAt: null });
    ex.sessions += 1;
    const cand = { score: d.score, max: d.maxScore };
    if (betterScore(ex.bestSession, cand)) ex.bestSession = cand;
    if ((MEDAL_RANK[d.medal] || 0) > (MEDAL_RANK[ex.bestMedal] || 0)) ex.bestMedal = d.medal;
    ex.lastPlayedAt = maxIso(ex.lastPlayedAt, at);
  } else if (type === 'training.round') {
    const r = vt.training.rounds;
    r.played += 1;
    const cand = { score: d.score, max: d.maxScore };
    if (betterScore(r.best, cand)) r.best = cand;
    if (laterOrEqual(at, r.lastAt)) { r.last = cand; r.lastAt = at; }
  } else if (type === 'challenge.result') {
    const c = vt.challenges;
    c.lastPlayedAt = maxIso(c.lastPlayedAt, at);
    if (d.kind === 'daily') {
      c.daily.played += 1;
      if (d.passed) c.daily.passed += 1;
      const prev = c.daily.byDate[d.key];
      if (!prev) {
        c.daily.byDate[d.key] = { shots: d.shots, passed: d.passed };
      } else if (d.passed && (!prev.passed || d.shots < prev.shots)) {
        c.daily.byDate[d.key] = { shots: d.shots, passed: true };
      }
      const dates = Object.keys(c.daily.byDate).sort().reverse();
      for (const old of dates.slice(MAX_DAILY_DATES)) delete c.daily.byDate[old];
    } else if (d.kind === 'ladder' || d.kind === 'run') {
      const map = d.kind === 'ladder' ? c.ladder.levels : c.runs;
      const e = bestShotsEntry(map, d.key);
      e.plays += 1;
      if (d.passed) {
        e.completions += 1;
        if (e.bestShots === null || d.shots < e.bestShots) e.bestShots = d.shots;
        if (d.kind === 'ladder') {
          c.ladder.unlockedLevel = Math.max(c.ladder.unlockedLevel, Math.min(Number(d.key) + 1, LADDER_LEVELS));
        }
      }
    } else if (d.kind === 'timed') {
      c.timed.plays += 1;
      if (c.timed.bestPots === null || d.pots > c.timed.bestPots) c.timed.bestPots = d.pots;
      if (laterOrEqual(at, c.timed.lastAt)) { c.timed.lastPots = d.pots; c.timed.lastAt = at; }
    } else if (d.kind === 'breakrun') {
      c.breakRun.plays += 1;
      if (d.cleared) c.breakRun.cleared += 1;
      if (c.breakRun.bestPots === null || d.pots > c.breakRun.bestPots) c.breakRun.bestPots = d.pots;
      if (laterOrEqual(at, c.breakRun.lastAt)) { c.breakRun.lastPots = d.pots; c.breakRun.lastAt = at; }
    } else {
      c.streak.plays += 1;
      if (c.streak.bestStreak === null || d.streak > c.streak.bestStreak) c.streak.bestStreak = d.streak;
      if (laterOrEqual(at, c.streak.lastAt)) { c.streak.lastStreak = d.streak; c.streak.lastAt = at; }
    }
  } else if (type === 'match.result') {
    const m = vt.matches;
    m.played += 1;
    if (d.won) m.won += 1; else m.lost += 1;
    m.framesWon += d.framesFor;
    m.framesLost += d.framesAgainst;
    m.lastPlayedAt = maxIso(m.lastPlayedAt, at);
  } else if (type === 'practice.session') {
    const p = vt.practice;
    p.sessions += 1;
    p.shots += d.shots;
    p.pots += d.pots;
    p.scratches += d.scratches;
    p.seconds += d.seconds;
    p.lastPracticeAt = maxIso(p.lastPracticeAt, at);
  }
  return vt;
}

// Recomputes the block from a list of validated events (in any order).
export function rebuildFromEvents(events) {
  const vt = defaultVirtualTraining();
  for (const e of events) applyEvent(vt, e);
  return vt;
}
