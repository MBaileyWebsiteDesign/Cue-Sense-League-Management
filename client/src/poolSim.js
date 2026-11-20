// Pool-table physics + shot planning for the division draw (no rendering here).
// World is 1100 x 600 units; the playing cloth is inside a 58-unit rail.
export const W = 1100;
export const H = 600;
export const RAIL = 58;
export const PX0 = RAIL;
export const PX1 = W - RAIL;
export const PY0 = RAIL;
export const PY1 = H - RAIL;
export const POCKET_R = 33;
export const POCKETS = [
  { x: PX0 - 8, y: PY0 - 8, kind: 'corner', nx: 1, ny: 1 },
  { x: W / 2, y: PY0 - 16, kind: 'side', nx: 0, ny: 1 },
  { x: PX1 + 8, y: PY0 - 8, kind: 'corner', nx: -1, ny: 1 },
  { x: PX0 - 8, y: PY1 + 8, kind: 'corner', nx: 1, ny: -1 },
  { x: W / 2, y: PY1 + 16, kind: 'side', nx: 0, ny: -1 },
  { x: PX1 + 8, y: PY1 + 8, kind: 'corner', nx: -1, ny: -1 },
];

const K = 1.05; // rolling friction: speed falls by K units per unit travelled
const WALL_E = 0.78;
const BALL_E = 0.96;
export const STOP = 8;
const SINK_SECONDS = 0.45;

const len = (x, y) => Math.hypot(x, y);

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const inBounds = (x, y, r) => x >= PX0 + r && x <= PX1 - r && y >= PY0 + r && y <= PY1 - r;

export function ballRadius(n, big = false) {
  const base = Math.max(13, Math.min(19, 21 - n * 0.14));
  return big ? Math.min(22, base * 1.2) : base;
}

export function createTable(ids, r, rng = Math.random) {
  const cue = { x: PX0 + (PX1 - PX0) * 0.18, y: H / 2, vx: 0, vy: 0, on: true };
  const balls = [];
  for (const id of ids) {
    let placed = null;
    for (let tries = 0; tries < 4000 && !placed; tries += 1) {
      const x = PX0 + r + 6 + rng() * (PX1 - PX0 - 2 * r - 12);
      const y = PY0 + r + 6 + rng() * (PY1 - PY0 - 2 * r - 12);
      const minGap = tries < 2500 ? 2 * r + 7 : 2 * r + 1;
      if (len(x - cue.x, y - cue.y) < 5 * r) continue;
      if (balls.some((b) => len(b.x - x, b.y - y) < minGap)) continue;
      placed = { x, y };
    }
    if (!placed) placed = { x: PX0 + r + rng() * (PX1 - PX0 - 2 * r), y: PY0 + r + rng() * (PY1 - PY0 - 2 * r) };
    balls.push({ id, x: placed.x, y: placed.y, vx: 0, vy: 0, live: true, sinking: false, sinkT: 0, sinkFrom: null, pocketIdx: -1 });
  }
  return { r, cue, balls, target: null, hit: false, plan: null, events: [] };
}

function buildPlan(S, T, c, G, cx, cy, respot) {
  const r = S.r;
  const gx = G.x - cx;
  const gy = G.y - cy;
  const dc = len(gx, gy);
  const vx = gx / dc;
  const vy = gy / dc;
  const cos = Math.max(0.45, vx * c.ux + vy * c.uy);
  const vT = K * (1.3 * c.D + 70);
  const arrive = vT / (0.98 * cos);
  const s0 = Math.min(2400, Math.max(480, arrive + K * dc));
  return {
    targetId: T.id,
    pocketIdx: c.pi,
    pocket: c.p,
    G,
    ux: c.ux,
    uy: c.uy,
    cx,
    cy,
    respot,
    vx,
    vy,
    angle: Math.atan2(vy, vx),
    s0,
    vT,
    dc,
    D: c.D,
    power: Math.max(0, Math.min(1, (s0 - 480) / 1500)),
    r,
  };
}

export function planShot(S, targetId) {
  const r = S.r;
  const T = S.balls.find((b) => b.id === targetId && b.live);
  if (!T) return null;
  const others = S.balls.filter((b) => b.live && b !== T);
  const cueReady = S.cue.on && Math.hypot(S.cue.vx, S.cue.vy) < STOP;

  const cands = [];
  POCKETS.forEach((p, pi) => {
    const dx = p.x - T.x;
    const dy = p.y - T.y;
    const D = len(dx, dy);
    const ux = dx / D;
    const uy = dy / D;
    const entry = -(ux * p.nx + uy * p.ny) / len(p.nx, p.ny);
    if (entry < (p.kind === 'side' ? 0.6 : 0.47)) return;
    const tpClear = others.every((o) => segDist(o.x, o.y, T.x, T.y, p.x, p.y) >= 2 * r + 1);
    cands.push({ pi, p, D, ux, uy, tpClear, entry });
  });

  if (cueReady) {
    let best = null;
    for (const c of cands) {
      const G = { x: T.x - c.ux * 2 * r, y: T.y - c.uy * 2 * r };
      if (!inBounds(G.x, G.y, r - 0.5)) continue;
      const gx = G.x - S.cue.x;
      const gy = G.y - S.cue.y;
      const dc = len(gx, gy);
      if (dc < 2) continue;
      const cos = (gx / dc) * c.ux + (gy / dc) * c.uy;
      if (cos < 0.5) continue;
      if (!others.every((o) => segDist(o.x, o.y, S.cue.x, S.cue.y, G.x, G.y) > 2 * r + 1.5)) continue;
      const score = Math.acos(Math.min(1, cos)) * 2 + (c.tpClear ? 0 : 3) + c.D / 1000;
      if (!best || score < best.score) best = { c, G, score };
    }
    if (best) return buildPlan(S, T, best.c, best.G, S.cue.x, S.cue.y, false);
  }

  // Cue ball is repositioned (ball-in-hand): look for a clear approach to the ghost ball.
  const order = (list) => [...list].sort((a2, b2) => (b2.tpClear - a2.tpClear) || a2.D - b2.D);
  const passes = [cands.filter((c) => c.tpClear), cands];
  const angles = [0, 12, -12, 24, -24, 36, -36, 48, -48].map((d) => (d * Math.PI) / 180);
  for (const pass of passes) {
    for (const c of order(pass)) {
      const G = { x: T.x - c.ux * 2 * r, y: T.y - c.uy * 2 * r };
      if (!inBounds(G.x, G.y, r - 0.5)) continue;
      if (others.some((o) => len(o.x - G.x, o.y - G.y) < 2 * r + 1)) continue;
      for (const th of angles) {
        const dx = c.ux * Math.cos(th) - c.uy * Math.sin(th);
        const dy = c.ux * Math.sin(th) + c.uy * Math.cos(th);
        for (const dist of [250, 200, 160, 320, 130, 380, 110, 90]) {
          const cx = G.x - dx * dist;
          const cy = G.y - dy * dist;
          if (!inBounds(cx, cy, r)) continue;
          if (others.some((o) => len(o.x - cx, o.y - cy) < 2 * r + 2)) continue;
          if (!others.every((o) => segDist(o.x, o.y, cx, cy, G.x, G.y) > 2 * r + 1.5)) continue;
          return buildPlan(S, T, c, G, cx, cy, true);
        }
      }
    }
  }
  // Crowded table: take the nearest pocket and shoot straight, passing over anything in the way.
  let pi = 0;
  let bestD = Infinity;
  POCKETS.forEach((p, i) => {
    const d = len(p.x - T.x, p.y - T.y);
    if (d < bestD) { bestD = d; pi = i; }
  });
  const p = POCKETS[pi];
  const ux = (p.x - T.x) / bestD;
  const uy = (p.y - T.y) / bestD;
  const c = { pi, p, D: bestD, ux, uy };
  const G = { x: T.x - ux * 2 * r, y: T.y - uy * 2 * r };
  const dist = 2 * r + 60;
  const cx = Math.max(PX0 + r, Math.min(PX1 - r, T.x - ux * dist));
  const cy = Math.max(PY0 + r, Math.min(PY1 - r, T.y - uy * dist));
  return buildPlan(S, T, c, G, cx, cy, true);
}

export function startShot(S, plan) {
  const T = S.balls.find((b) => b.id === plan.targetId);
  S.target = T;
  S.hit = false;
  S.plan = plan;
  if (plan.respot) {
    S.cue.x = plan.cx;
    S.cue.y = plan.cy;
    S.cue.vx = 0;
    S.cue.vy = 0;
    S.cue.on = true;
  }
}

export function fireShot(S) {
  S.cue.vx = S.plan.vx * S.plan.s0;
  S.cue.vy = S.plan.vy * S.plan.s0;
}

// Safety net: the cue ball missed or got blocked, so the target is sent to its pocket anyway.
export function forcePot(S) {
  const T = S.target;
  if (!T || !T.live || S.hit) return;
  S.hit = true;
  const dx = S.plan.pocket.x - T.x;
  const dy = S.plan.pocket.y - T.y;
  const d = len(dx, dy) || 1;
  T.vx = (dx / d) * S.plan.vT;
  T.vy = (dy / d) * S.plan.vT;
  S.events.push({ type: 'hit', x: T.x, y: T.y, power: 0.5 });
}

export function atRest(S) {
  const still = (m) => m.vx * m.vx + m.vy * m.vy < 1e-6;
  if (S.cue.on && !still(S.cue)) return false;
  return S.balls.every((b) => !b.live || b.sinking || still(b));
}

export function stopAll(S) {
  S.cue.vx = 0;
  S.cue.vy = 0;
  S.balls.forEach((b) => { b.vx = 0; b.vy = 0; });
}

function wallBounce(m, r) {
  if (m.x < PX0 + r) { m.x = PX0 + r; m.vx = Math.abs(m.vx) * WALL_E; }
  else if (m.x > PX1 - r) { m.x = PX1 - r; m.vx = -Math.abs(m.vx) * WALL_E; }
  if (m.y < PY0 + r) { m.y = PY0 + r; m.vy = Math.abs(m.vy) * WALL_E; }
  else if (m.y > PY1 - r) { m.y = PY1 - r; m.vy = -Math.abs(m.vy) * WALL_E; }
}

function collide(a, b, r, S) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = 2 * r;
  if (d2 >= min * min || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const overlap = min - d;
  const T = S.target;
  if (S.hit && T && (a === T || b === T)) {
    // Potting ball is steered: it shoves other balls aside and is never deflected.
    const other = a === T ? b : a;
    if (other === S.cue) return;
    const sgn = a === T ? 1 : -1; // direction from T to other
    other.x += nx * sgn * overlap;
    other.y += ny * sgn * overlap;
    const rvn = (other.vx - T.vx) * nx * sgn + (other.vy - T.vy) * ny * sgn;
    if (rvn < 0) {
      other.vx -= (1 + BALL_E) * rvn * nx * sgn;
      other.vy -= (1 + BALL_E) * rvn * ny * sgn;
    }
    return;
  }
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn < 0) {
    const p = (-(1 + BALL_E) * vn) / 2;
    a.vx -= p * nx;
    a.vy -= p * ny;
    b.vx += p * nx;
    b.vy += p * ny;
  }
  if (!S.hit && T && ((a === S.cue && b === T) || (b === S.cue && a === T))) {
    S.hit = true;
    const plan = S.plan;
    const dx2 = plan.pocket.x - T.x;
    const dy2 = plan.pocket.y - T.y;
    const dd = len(dx2, dy2);
    const sp = Math.max(len(T.vx, T.vy), plan.vT * 0.85);
    T.vx = (dx2 / dd) * sp;
    T.vy = (dy2 / dd) * sp;
    S.events.push({ type: 'hit', x: T.x, y: T.y, power: Math.min(1, sp / 900) });
  }
}

export function step(S, h) {
  const r = S.r;
  const f = Math.exp(-K * h);
  const movers = [];
  if (S.cue.on) movers.push(S.cue);
  S.balls.forEach((b) => { if (b.live && !b.sinking) movers.push(b); });
  for (const m of movers) {
    m.x += m.vx * h;
    m.y += m.vy * h;
    m.vx *= f;
    m.vy *= f;
    if (m.vx * m.vx + m.vy * m.vy < STOP * STOP) { m.vx = 0; m.vy = 0; }
  }
  const T = S.target;
  if (S.hit && T && T.live && !T.sinking) {
    const p = S.plan.pocket;
    const dx = p.x - T.x;
    const dy = p.y - T.y;
    const d = len(dx, dy) || 1;
    const sp = Math.max(len(T.vx, T.vy), 95);
    T.vx = (dx / d) * sp;
    T.vy = (dy / d) * sp;
  }
  for (const m of movers) {
    if (S.hit && m === T) continue;
    wallBounce(m, r);
  }
  for (let i = 0; i < movers.length; i += 1) {
    for (let j = i + 1; j < movers.length; j += 1) collide(movers[i], movers[j], r, S);
  }
  if (S.hit && T && T.live && !T.sinking) {
    const p = S.plan.pocket;
    if (len(T.x - p.x, T.y - p.y) < POCKET_R * 0.8) {
      T.sinking = true;
      T.sinkT = 0;
      T.sinkFrom = { x: T.x, y: T.y };
      T.vx = 0;
      T.vy = 0;
      T.pocketIdx = S.plan.pocketIdx;
      S.events.push({ type: 'pot', id: T.id, pocketIdx: T.pocketIdx });
    }
  }
  if (S.cue.on) {
    for (const p of POCKETS) {
      if (len(S.cue.x - p.x, S.cue.y - p.y) < POCKET_R * 0.8) {
        S.cue.on = false;
        S.cue.vx = 0;
        S.cue.vy = 0;
        S.events.push({ type: 'scratch', x: p.x, y: p.y });
        break;
      }
    }
  }
  for (const b of S.balls) {
    if (b.sinking) {
      b.sinkT += h / SINK_SECONDS;
      if (b.sinkT >= 1) {
        b.sinkT = 1;
        b.sinking = false;
        b.live = false;
        S.events.push({ type: 'gone', id: b.id });
      }
    }
  }
}
