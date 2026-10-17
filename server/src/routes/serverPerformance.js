// Server performance monitor (admin only) - added 2026-10-17.
//
// Answers one question for the Admin Portal's "Server Performance" page: is the
// Fly.io machine this app runs on short of memory, CPU or disk?
//
// Everything here is measured from INSIDE the machine (Linux /proc files, Node's
// own process counters, and a statfs() of the data volume) - no Fly.io API token
// is needed. One reading is taken every minute while the app is running; the
// last 6 hours are kept per-minute and the last 7 days per-5-minutes. History is
// saved to DATA_DIR (the Fly volume) so it survives restarts and deploys.
// Readings only exist while the machine is running - the Fly config lets the
// machine stop when idle, so there are gaps while it is stopped.
//
// The rules of thumb used for the "increase / watch / ok" verdicts are in
// THRESHOLDS below and are returned to the page so they are shown to the admin.
// They are sensible defaults chosen here, not figures published by Fly.io.
import { readFileSync, writeFileSync, renameSync, statSync, statfsSync, readdirSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from '../db.js';

const MB = 1024 * 1024;
const SAMPLE_MS = 60 * 1000;
const FINE_KEEP = 360; // 6 hours at 1 minute
const COARSE_STEP = 5; // 5 fine readings -> 1 coarse reading
const COARSE_KEEP = 2016; // 7 days at 5 minutes
const SAVE_EVERY = 5; // write history to disk every 5 readings
const BOOTS_KEEP = 50;
const LAG_TICK_MS = 100;
const HISTORY_FILE = path.join(DATA_DIR, 'server-metrics.json');
const LAST_FILE = path.join(DATA_DIR, 'server-metrics-last.json');

export const THRESHOLDS = {
  memory: { watchP95: 70, increaseP95: 85, watchPeak: 85, increasePeak: 95, watchSwapMb: 20, increaseSwapMb: 100 },
  cpu: { watchP95: 60, increaseP95: 80, watchStealP95: 3, increaseStealP95: 10 },
  lag: { watchMs: 100, increaseMs: 250 },
  disk: { watchPct: 70, increasePct: 85, watchDaysToFull: 30, increaseDaysToFull: 7 },
  highMemoryRestartPct: 90,
};

const round1 = (n) => Math.round(n * 10) / 10;
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

const state = {
  fine: [],
  coarse: [],
  boots: [],
  startedAt: Date.now(),
  prevCpu: null,
  prevProc: null,
  prevAt: null,
  lagSamples: [],
  lastTick: Date.now(),
  ticks: 0,
  persistError: null,
};

// ---- raw readings ----------------------------------------------------------

function readMeminfo() {
  const txt = readText('/proc/meminfo');
  if (txt) {
    const kv = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kv[m[1]] = Number(m[2]) * 1024;
    }
    if (kv.MemTotal && kv.MemAvailable !== undefined) {
      return { total: kv.MemTotal, available: kv.MemAvailable, swapTotal: kv.SwapTotal || 0, swapFree: kv.SwapFree || 0 };
    }
  }
  return { total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapFree: 0 };
}

function readCpuTimes() {
  const txt = readText('/proc/stat');
  const line = txt && txt.split('\n').find((l) => l.startsWith('cpu '));
  if (line) {
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
    return { busy: user + nice + system + irq + softirq, idle, iowait, steal, hasSteal: true };
  }
  const t = os.cpus().reduce((a, c) => ({ busy: a.busy + c.times.user + c.times.nice + c.times.sys + c.times.irq, idle: a.idle + c.times.idle }), { busy: 0, idle: 0 });
  return { busy: t.busy, idle: t.idle, iowait: 0, steal: 0, hasSteal: false };
}

function diskUsage(dir) {
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    const denom = used + avail;
    return { total, used, avail, usedPct: denom > 0 ? (used / denom) * 100 : 0 };
  } catch {
    return null;
  }
}

function isMountPoint(dir) {
  const txt = readText('/proc/mounts');
  if (!txt) return null;
  const target = path.resolve(dir);
  return txt.split('\n').some((l) => l.split(' ')[1] === target);
}

function fileSize(p) { try { return statSync(p).size; } catch { return 0; } }

let dataCache = null;
function walkSize(p, depth, budget) {
  let st;
  try { st = statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  if (depth > 6 || budget.left <= 0) return 0;
  let total = 0;
  let names = [];
  try { names = readdirSync(p); } catch { return 0; }
  for (const n of names) {
    if (budget.left-- <= 0) break;
    total += walkSize(path.join(p, n), depth + 1, budget);
  }
  return total;
}
function dataBreakdown() {
  if (dataCache && Date.now() - dataCache.at < 5 * 60 * 1000) return dataCache.value;
  const budget = { left: 20000 };
  const items = [];
  let names = [];
  try { names = readdirSync(DATA_DIR); } catch { /* ignore */ }
  for (const n of names) {
    if (n === 'lost+found') continue;
    items.push({ name: n, bytes: walkSize(path.join(DATA_DIR, n), 0, budget) });
  }
  items.sort((a, b) => b.bytes - a.bytes);
  const value = { totalBytes: items.reduce((s, i) => s + i.bytes, 0), items: items.slice(0, 8), truncated: budget.left <= 0 };
  dataCache = { at: Date.now(), value };
  return value;
}

// ---- event-loop lag (own measurement, so the numbers mean what they say) ---
// A 100ms timer; how much later than 100ms it actually fires is how long the
// single Node thread was busy and unable to answer requests.
function startLagTimer() {
  state.lastTick = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    state.lagSamples.push(Math.max(0, now - state.lastTick - LAG_TICK_MS));
    if (state.lagSamples.length > 1000) state.lagSamples.shift();
    state.lastTick = now;
  }, LAG_TICK_MS);
  t.unref();
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---- sampling --------------------------------------------------------------

function takeSample() {
  const now = Date.now();
  const mem = readMeminfo();
  const cpu = readCpuTimes();
  const proc = process.cpuUsage();
  const mu = process.memoryUsage();
  const disk = diskUsage(DATA_DIR);
  const usedMem = mem.total - mem.available;

  let cpuPct = null;
  let steal = null;
  let iowait = null;
  let nodeCpu = null;
  if (state.prevCpu) {
    const dBusy = cpu.busy - state.prevCpu.busy;
    const dIdle = cpu.idle - state.prevCpu.idle;
    const dIo = cpu.iowait - state.prevCpu.iowait;
    const dSteal = cpu.steal - state.prevCpu.steal;
    const total = dBusy + dIdle + dIo + dSteal;
    if (total > 0) {
      cpuPct = (dBusy / total) * 100;
      iowait = (dIo / total) * 100;
      steal = cpu.hasSteal ? (dSteal / total) * 100 : null;
    }
    const elapsedUs = (now - state.prevAt) * 1000;
    if (elapsedUs > 0) {
      nodeCpu = ((proc.user - state.prevProc.user + (proc.system - state.prevProc.system)) / (elapsedUs * Math.max(1, os.cpus().length))) * 100;
    }
  }
  state.prevCpu = cpu;
  state.prevProc = proc;
  state.prevAt = now;

  const lags = state.lagSamples.slice().sort((a, b) => a - b);
  state.lagSamples = [];
  const firstReading = state.ticks === 0; // start-up work (reading the database) is not a fair lag reading

  const s = {
    t: now,
    memPct: round1((usedMem / mem.total) * 100),
    memPctMax: round1((usedMem / mem.total) * 100),
    memUsedMb: Math.round(usedMem / MB),
    swapMb: Math.round((mem.swapTotal - mem.swapFree) / MB),
    rssMb: Math.round(mu.rss / MB),
    heapMb: Math.round(mu.heapUsed / MB),
    cpu: cpuPct === null ? null : round1(cpuPct),
    cpuMax: cpuPct === null ? null : round1(cpuPct),
    steal: steal === null ? null : round1(steal),
    stealMax: steal === null ? null : round1(steal),
    iowait: iowait === null ? null : round1(iowait),
    nodeCpu: nodeCpu === null ? null : round1(nodeCpu),
    load1: round1(os.loadavg()[0]),
    lagP99: firstReading || !lags.length ? null : round1(percentile(lags, 99)),
    lagMax: firstReading || !lags.length ? null : round1(lags[lags.length - 1]),
    diskPct: disk ? round1(disk.usedPct) : null,
    diskUsedMb: disk ? Math.round(disk.used / MB) : null,
    diskAvailMb: disk ? Math.round(disk.avail / MB) : null,
    dbMb: round1(fileSize(path.join(DATA_DIR, 'db.json')) / MB),
  };
  state.ticks += 1;
  return s;
}

const nums = (arr, k) => arr.map((p) => p[k]).filter((v) => typeof v === 'number');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const max = (a) => (a.length ? Math.max(...a) : null);

// Collapse several readings into one: averages for "typical" fields, maximums
// for "peak" fields, last value for disk.
function aggregate(points) {
  const last = points[points.length - 1];
  const A = (k) => { const v = avg(nums(points, k)); return v === null ? null : round1(v); };
  const M = (k) => { const v = max(nums(points, k)); return v === null ? null : round1(v); };
  return {
    t: last.t,
    memPct: A('memPct'), memPctMax: M('memPctMax'), memUsedMb: Math.round(A('memUsedMb') ?? 0),
    swapMb: M('swapMb'), rssMb: M('rssMb'), heapMb: M('heapMb'),
    cpu: A('cpu'), cpuMax: M('cpuMax'), steal: A('steal'), stealMax: M('stealMax'), iowait: A('iowait'), nodeCpu: A('nodeCpu'),
    load1: M('load1'), lagP99: M('lagP99'), lagMax: M('lagMax'),
    diskPct: last.diskPct, diskUsedMb: last.diskUsedMb, diskAvailMb: last.diskAvailMb, dbMb: last.dbMb,
  };
}

function save() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ fine: state.fine, coarse: state.coarse, boots: state.boots }));
    renameSync(tmp, HISTORY_FILE);
    state.persistError = null;
  } catch (e) {
    state.persistError = e.message;
  }
}

function tick() {
  const s = takeSample();
  state.fine.push(s);
  if (state.fine.length > FINE_KEEP) state.fine.shift();
  if (state.ticks % COARSE_STEP === 0) {
    state.coarse.push(aggregate(state.fine.slice(-COARSE_STEP)));
    if (state.coarse.length > COARSE_KEEP) state.coarse.shift();
  }
  try { writeFileSync(LAST_FILE, JSON.stringify({ t: s.t, memPct: s.memPct, cpu: s.cpu, diskPct: s.diskPct })); } catch (e) { state.persistError = e.message; }
  if (state.ticks % SAVE_EVERY === 0) save();
}

function loadHistory() {
  try {
    const j = JSON.parse(readText(HISTORY_FILE) || 'null');
    if (j) {
      state.fine = Array.isArray(j.fine) ? j.fine.slice(-FINE_KEEP) : [];
      state.coarse = Array.isArray(j.coarse) ? j.coarse.slice(-COARSE_KEEP) : [];
      state.boots = Array.isArray(j.boots) ? j.boots.slice(-BOOTS_KEEP) : [];
    }
  } catch { /* start fresh if the file is missing or unreadable */ }
  let prev = null;
  try { prev = JSON.parse(readText(LAST_FILE) || 'null'); } catch { /* ignore */ }
  if (!prev && state.fine.length) {
    const l = state.fine[state.fine.length - 1];
    prev = { t: l.t, memPct: l.memPctMax, cpu: l.cpu, diskPct: l.diskPct };
  }
  state.boots.push({
    at: Date.now(),
    prev: prev ? { at: prev.t, memPct: prev.memPct ?? null, cpu: prev.cpu ?? null, diskPct: prev.diskPct ?? null } : null,
  });
  state.boots = state.boots.slice(-BOOTS_KEEP);
}

export function startServerMetricsSampler() {
  loadHistory();
  startLagTimer();
  tick(); // first reading now (CPU needs two readings, so it fills in a minute later)
  save();
  const t = setInterval(tick, SAMPLE_MS);
  t.unref();
}

// ---- verdicts --------------------------------------------------------------

const RANK = { collecting: 0, ok: 0, watch: 1, increase: 2 };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const fmt = (n) => (n === null || n === undefined ? 'n/a' : String(round1(n)));

function allPoints() {
  const lastCoarse = state.coarse.length ? state.coarse[state.coarse.length - 1].t : 0;
  return [...state.coarse, ...state.fine.filter((f) => f.t > lastCoarse)];
}

function buildVerdict(points, liveDisk, hasSteal) {
  const T = THRESHOLDS;
  const span = points.length ? (points[points.length - 1].t - points[0].t) / 60000 : 0;
  const collecting = span < 30;
  const out = {};

  // Memory
  const memAvg = nums(points, 'memPct');
  const memP95 = pct(memAvg, 95);
  const memPeak = max(nums(points, 'memPctMax'));
  const swapPeak = max(nums(points, 'swapMb')) ?? 0;
  const highRestarts = state.boots.filter((b) => b.prev && b.prev.memPct !== null && b.prev.memPct >= T.highMemoryRestartPct && b.at > Date.now() - 7 * 86400000).length;
  let ml = 'ok';
  if (memP95 !== null && (memP95 >= T.memory.increaseP95 || memPeak >= T.memory.increasePeak || swapPeak >= T.memory.increaseSwapMb || highRestarts > 0)) ml = 'increase';
  else if (memP95 !== null && (memP95 >= T.memory.watchP95 || memPeak >= T.memory.watchPeak || swapPeak >= T.memory.watchSwapMb)) ml = 'watch';
  out.memory = {
    level: collecting && ml === 'ok' ? 'collecting' : ml,
    summary: `Typical (95th percentile) ${fmt(memP95)}% used, peak ${fmt(memPeak)}%${swapPeak > 0 ? `, swap peaked at ${swapPeak} MB` : ''}.`,
    detail: highRestarts > 0 ? `${highRestarts} restart(s) in the last 7 days followed a reading of ${T.highMemoryRestartPct}%+ memory (could be a deploy, or the machine running out of memory).` : null,
    stats: { p95: memP95, peak: memPeak, swapPeakMb: swapPeak, highMemoryRestarts7d: highRestarts },
  };

  // CPU
  const cpuP95 = pct(nums(points, 'cpu'), 95);
  const cpuAvg = avg(nums(points, 'cpu'));
  const cpuPeak = max(nums(points, 'cpuMax'));
  const stealP95 = pct(nums(points, 'steal'), 95);
  let cl = 'ok';
  if (cpuP95 !== null && (cpuP95 >= T.cpu.increaseP95 || (stealP95 !== null && stealP95 >= T.cpu.increaseStealP95))) cl = 'increase';
  else if (cpuP95 !== null && (cpuP95 >= T.cpu.watchP95 || (stealP95 !== null && stealP95 >= T.cpu.watchStealP95))) cl = 'watch';
  out.cpu = {
    level: cpuP95 === null ? 'collecting' : collecting && cl === 'ok' ? 'collecting' : cl,
    summary: `Average ${fmt(cpuAvg)}% busy, typical busy period (95th percentile) ${fmt(cpuP95)}%, peak minute ${fmt(cpuPeak)}%${hasSteal ? `; CPU time withheld by the host (steal) ${fmt(stealP95)}% at the 95th percentile` : ''}.`,
    detail: null,
    stats: { avg: cpuAvg === null ? null : round1(cpuAvg), p95: cpuP95, peak: cpuPeak, stealP95 },
  };

  // Responsiveness (event-loop lag)
  const lagP95 = pct(nums(points, 'lagP99'), 95);
  const lagPeak = max(nums(points, 'lagMax'));
  let ll = 'ok';
  if (lagP95 !== null && lagP95 >= T.lag.increaseMs) ll = 'increase';
  else if (lagP95 !== null && lagP95 >= T.lag.watchMs) ll = 'watch';
  out.responsiveness = {
    level: lagP95 === null ? 'collecting' : collecting && ll === 'ok' ? 'collecting' : ll,
    summary: `Typical worst-case delay ${fmt(lagP95)} ms, longest stall ${fmt(lagPeak)} ms.`,
    detail: ll !== 'ok' && out.cpu.level === 'ok' ? 'Delays are high while the CPU is not busy overall: the app is stalling on its own work (for example reading and copying the whole database file on each request) rather than running out of CPU, so more hardware may help less than code changes.' : null,
    stats: { p95: lagP95, peak: lagPeak },
  };

  // Disk
  const diskNow = liveDisk ? liveDisk.usedPct : null;
  let dl = 'ok';
  if (diskNow !== null && diskNow >= T.disk.increasePct) dl = 'increase';
  else if (diskNow !== null && diskNow >= T.disk.watchPct) dl = 'watch';
  let growthMbPerDay = null;
  let daysToFull = null;
  const dpts = points.filter((p) => typeof p.diskUsedMb === 'number');
  if (dpts.length > 1 && liveDisk) {
    const spanDays = (dpts[dpts.length - 1].t - dpts[0].t) / 86400000;
    if (spanDays >= 1) {
      growthMbPerDay = round1((dpts[dpts.length - 1].diskUsedMb - dpts[0].diskUsedMb) / spanDays);
      if (growthMbPerDay > 0) daysToFull = Math.round(liveDisk.avail / MB / growthMbPerDay);
    }
  }
  if (daysToFull !== null) {
    if (daysToFull <= T.disk.increaseDaysToFull && RANK[dl] < 2) dl = 'increase';
    else if (daysToFull <= T.disk.watchDaysToFull && RANK[dl] < 1) dl = 'watch';
  }
  out.disk = {
    level: diskNow === null ? 'collecting' : dl,
    summary: liveDisk
      ? `${fmt(diskNow)}% of the data volume used (${round1(liveDisk.used / MB)} MB of ${round1(liveDisk.total / MB)} MB).${growthMbPerDay === null ? ' Growth rate needs 24 hours of readings.' : growthMbPerDay > 0 ? ` Growing about ${growthMbPerDay} MB/day, roughly ${daysToFull} days until full at that rate.` : ' Not growing over the readings so far.'}`
      : 'Disk usage could not be read on this machine.',
    detail: null,
    stats: { usedPct: diskNow, growthMbPerDay, daysToFull },
  };

  const names = { memory: 'memory (RAM)', cpu: 'CPU', responsiveness: 'responsiveness', disk: 'disk space' };
  const keys = Object.keys(out);
  const worst = keys.reduce((w, k) => (RANK[out[k].level] > w ? RANK[out[k].level] : w), 0);
  const pick = (lvl) => keys.filter((k) => out[k].level === lvl).map((k) => names[k]);
  let overall;
  if (worst === 2) overall = { level: 'increase', headline: `Short of capacity: ${pick('increase').join(', ')}. Increasing it is recommended.` };
  else if (worst === 1) overall = { level: 'watch', headline: `Getting tight: ${pick('watch').join(', ')}. No increase needed yet, but keep an eye on it.` };
  else if (collecting) overall = { level: 'collecting', headline: `Still collecting readings (${Math.round(span)} minutes so far). A reliable verdict needs a few hours of normal use.` };
  else overall = { level: 'ok', headline: 'No resource problems in the readings so far. No increase needed.' };
  return { overall, ...out, spanMinutes: Math.round(span) };
}

// ---- response --------------------------------------------------------------

const RANGES = { '1h': { ms: 3600e3, src: 'fine' }, '6h': { ms: 6 * 3600e3, src: 'fine' }, '24h': { ms: 24 * 3600e3, src: 'coarse' }, '7d': { ms: 7 * 86400e3, src: 'coarse' } };

function mergeChunks(points, size) {
  if (size <= 1) return points;
  const out = [];
  for (let i = 0; i < points.length; i += size) out.push(aggregate(points.slice(i, i + size)));
  return out;
}

function liveSnapshot(liveDisk) {
  const mem = readMeminfo();
  const mu = process.memoryUsage();
  const last = state.fine[state.fine.length - 1] || null;
  const used = mem.total - mem.available;
  return {
    at: Date.now(),
    memTotalMb: Math.round(mem.total / MB),
    memUsedMb: Math.round(used / MB),
    memPct: round1((used / mem.total) * 100),
    swapTotalMb: Math.round(mem.swapTotal / MB),
    swapUsedMb: Math.round((mem.swapTotal - mem.swapFree) / MB),
    rssMb: Math.round(mu.rss / MB),
    heapUsedMb: Math.round(mu.heapUsed / MB),
    heapTotalMb: Math.round(mu.heapTotal / MB),
    load: os.loadavg().map(round1),
    cpuPct: last ? last.cpu : null,
    stealPct: last ? last.steal : null,
    nodeCpuPct: last ? last.nodeCpu : null,
    lagP99: last ? last.lagP99 : null,
    lagMax: last ? last.lagMax : null,
    lastReadingAt: last ? last.t : null,
    disk: liveDisk ? { totalMb: Math.round(liveDisk.total / MB), usedMb: Math.round(liveDisk.used / MB), availMb: Math.round(liveDisk.avail / MB), usedPct: round1(liveDisk.usedPct) } : null,
  };
}

function vmInfo() {
  const e = process.env;
  const cpus = os.cpus();
  const fly = {};
  for (const [k, v] of [['app', e.FLY_APP_NAME], ['region', e.FLY_REGION], ['machineId', e.FLY_MACHINE_ID], ['vmMemoryMb', e.FLY_VM_MEMORY_MB]]) if (v) fly[k] = v;
  return {
    cpuCount: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : null,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    fly,
    dataDir: DATA_DIR,
    dataDirIsMount: isMountPoint(DATA_DIR),
    processUptimeSeconds: Math.round(process.uptime()),
    machineUptimeSeconds: Math.round(os.uptime()),
  };
}

export function registerServerPerformanceRoutes(app, { requireAdmin, asyncRoute }) {
  startServerMetricsSampler();
  app.get('/api/admin/server/metrics', requireAdmin, asyncRoute((req, res) => {
    const range = RANGES[req.query.range] ? req.query.range : '24h';
    const cfg = RANGES[range];
    const since = Date.now() - cfg.ms;
    const all = allPoints();
    const liveDisk = diskUsage(DATA_DIR);
    const cpuNow = readCpuTimes();
    let series;
    if (cfg.src === 'fine') series = state.fine.filter((p) => p.t >= since);
    else series = all.filter((p) => p.t >= since);
    if (range === '7d') series = mergeChunks(series, 4);
    res.json({
      generatedAt: Date.now(),
      range,
      rangeMs: cfg.ms,
      sampleIntervalSeconds: SAMPLE_MS / 1000,
      series,
      now: liveSnapshot(liveDisk),
      vm: vmInfo(),
      verdict: buildVerdict(all, liveDisk, cpuNow.hasSteal),
      thresholds: THRESHOLDS,
      boots: state.boots.slice(-12).reverse(),
      data: dataBreakdown(),
      readingsSince: all.length ? all[0].t : null,
      readingCount: state.fine.length + state.coarse.length,
      persistError: state.persistError,
      stealReported: cpuNow.hasSteal,
    });
  }));
}
