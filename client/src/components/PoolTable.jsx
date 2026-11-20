import { useEffect, useRef, useState } from 'react';
import { initials } from '../autoDivisions.js';
import {
  W, H, RAIL, PX0, PX1, PY0, PY1, POCKETS, POCKET_R,
  ballRadius, createTable, planShot, startShot, fireShot, forcePot, step, atRest, stopAll,
} from '../poolSim.js';

// Pool-table draw: a virtual cue pots one ball per pick. Everything is drawn on a canvas with
// gradients, lighting, shadows and a procedurally textured table (no image files needed).


// Older Safari/Chrome lack roundRect; a rectangle is an acceptable fallback.
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  // eslint-disable-next-line func-names
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
}

const BALL_COLOURS = ['#f2c500', '#1e57c8', '#d8281f', '#6a2f98', '#f07a12', '#16883f', '#8a2020', '#1b1b1b'];
const T_RESPOT = 0.45;
const T_AIM = 0.85;
const T_PULL = 0.55;
const T_STRIKE = 0.12;
const SUBSTEP = 1 / 240;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ease = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
const easeIn = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * x);

function drawTableLayer(ctx) {
  const rnd = mulberry32(20261120);

  // Wooden frame
  const frame = ctx.createLinearGradient(0, 0, 0, H);
  frame.addColorStop(0, '#7b5028');
  frame.addColorStop(0.5, '#5a3818');
  frame.addColorStop(1, '#46290f');
  ctx.fillStyle = frame;
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 34);
  ctx.fill();

  // Wood grain (horizontal on top/bottom rails, vertical on end rails)
  const grain = (x, y, w, h, vertical) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (let i = 0; i < 90; i += 1) {
      const dark = rnd() < 0.6;
      ctx.strokeStyle = dark ? `rgba(30,14,4,${0.05 + rnd() * 0.1})` : `rgba(210,160,100,${0.04 + rnd() * 0.07})`;
      ctx.lineWidth = 0.6 + rnd() * 1.6;
      ctx.beginPath();
      const off = rnd() * (vertical ? w : h);
      const amp = 1 + rnd() * 3;
      const fr = 0.004 + rnd() * 0.01;
      const ph = rnd() * 6;
      if (vertical) {
        for (let t = 0; t <= h; t += 20) {
          const px = x + off + Math.sin(t * fr + ph) * amp;
          if (t === 0) ctx.moveTo(px, y + t); else ctx.lineTo(px, y + t);
        }
      } else {
        for (let t = 0; t <= w; t += 20) {
          const py = y + off + Math.sin(t * fr + ph) * amp;
          if (t === 0) ctx.moveTo(x + t, py); else ctx.lineTo(x + t, py);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  };
  grain(0, 0, W, RAIL - 18, false);
  grain(0, H - RAIL + 18, W, RAIL - 18, false);
  grain(0, 0, RAIL - 18, H, true);
  grain(W - RAIL + 18, 0, RAIL - 18, H, true);

  // Frame bevel
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,225,170,0.28)';
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, H - 4, 33);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.roundRect(RAIL - 21, RAIL - 21, W - 2 * (RAIL - 21), H - 2 * (RAIL - 21), 10);
  ctx.stroke();

  // Rubber cushions
  const cush = ctx.createLinearGradient(0, RAIL - 20, 0, RAIL + 6);
  cush.addColorStop(0, '#0b3b21');
  cush.addColorStop(1, '#176b3b');
  ctx.fillStyle = '#0f4d2b';
  ctx.beginPath();
  ctx.roundRect(RAIL - 20, RAIL - 20, W - 2 * (RAIL - 20), H - 2 * (RAIL - 20), 8);
  ctx.fill();
  ctx.fillStyle = cush;
  ctx.fillRect(RAIL - 20, RAIL - 20, W - 2 * (RAIL - 20), 22);

  // Cloth
  const cloth = ctx.createRadialGradient(W / 2, H / 2 - 20, 40, W / 2, H / 2, W * 0.62);
  cloth.addColorStop(0, '#2f9a5b');
  cloth.addColorStop(0.55, '#1d7a45');
  cloth.addColorStop(1, '#0f5230');
  ctx.fillStyle = cloth;
  ctx.fillRect(PX0, PY0, PX1 - PX0, PY1 - PY0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(PX0, PY0, PX1 - PX0, PY1 - PY0);
  ctx.clip();
  // woven texture + fibres
  ctx.strokeStyle = 'rgba(0,0,0,0.035)';
  ctx.lineWidth = 1;
  for (let x = PX0 - H; x < PX1; x += 3) {
    ctx.beginPath();
    ctx.moveTo(x, PY0);
    ctx.lineTo(x + (PY1 - PY0), PY1);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  for (let x = PX0; x < PX1 + H; x += 3) {
    ctx.beginPath();
    ctx.moveTo(x, PY0);
    ctx.lineTo(x - (PY1 - PY0), PY1);
    ctx.stroke();
  }
  for (let i = 0; i < 7000; i += 1) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(PX0 + rnd() * (PX1 - PX0), PY0 + rnd() * (PY1 - PY0), 1.2, 1.2);
  }
  // table markings
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  const headX = PX0 + (PX1 - PX0) * 0.25;
  ctx.beginPath();
  ctx.moveTo(headX, PY0);
  ctx.lineTo(headX, PY1);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(headX, H / 2, 68, Math.PI / 2, -Math.PI / 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.arc(PX0 + (PX1 - PX0) * 0.75, H / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '700 30px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(230,190,80,0.14)';
  ctx.fillText('CUE SENSE', PX0 + (PX1 - PX0) * 0.5, H / 2 + 150);
  // cushion shadow on cloth
  const shade = (x0, y0, x1, y1, rx, ry, rw, rh) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,0.38)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };
  shade(0, PY0, 0, PY0 + 20, PX0, PY0, PX1 - PX0, 20);
  shade(0, PY1, 0, PY1 - 20, PX0, PY1 - 20, PX1 - PX0, 20);
  shade(PX0, 0, PX0 + 20, 0, PX0, PY0, 20, PY1 - PY0);
  shade(PX1, 0, PX1 - 20, 0, PX1 - 20, PY0, 20, PY1 - PY0);
  // overhead light vignette
  const vig = ctx.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, W * 0.66);
  vig.addColorStop(0, 'rgba(255,255,230,0.10)');
  vig.addColorStop(1, 'rgba(0,0,0,0.30)');
  ctx.fillStyle = vig;
  ctx.fillRect(PX0, PY0, PX1 - PX0, PY1 - PY0);
  ctx.restore();

  // cushion nose line
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(PX0, PY0, PX1 - PX0, PY1 - PY0);
  ctx.strokeStyle = 'rgba(160,230,180,0.16)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(PX0 - 2, PY0 - 2, PX1 - PX0 + 4, PY1 - PY0 + 4);

  // diamonds (mother of pearl)
  const diamond = (x, y) => {
    const g = ctx.createLinearGradient(x - 6, y - 6, x + 6, y + 6);
    g.addColorStop(0, '#fffdf2');
    g.addColorStop(1, '#c9b98d');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y - 6.5);
    ctx.lineTo(x + 4.5, y);
    ctx.lineTo(x, y + 6.5);
    ctx.lineTo(x - 4.5, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,10,0.5)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  };
  for (let i = 1; i <= 7; i += 1) {
    if (i === 4) continue;
    const x = PX0 + ((PX1 - PX0) * i) / 8;
    diamond(x, (RAIL - 20) / 2 + 2);
    diamond(x, H - (RAIL - 20) / 2 - 2);
  }
  for (let i = 1; i <= 3; i += 1) {
    const y = PY0 + ((PY1 - PY0) * i) / 4;
    diamond((RAIL - 20) / 2 + 2, y);
    diamond(W - (RAIL - 20) / 2 - 2, y);
  }

  // pockets with brass rims
  for (const p of POCKETS) {
    const g = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 36);
    g.addColorStop(0, '#000');
    g.addColorStop(0.75, '#050505');
    g.addColorStop(1, '#1a1a1a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 32, 0, Math.PI * 2);
    ctx.fill();
    const rim = ctx.createLinearGradient(p.x - 34, p.y - 34, p.x + 34, p.y + 34);
    rim.addColorStop(0, '#f2d27a');
    rim.addColorStop(0.5, '#a9791e');
    rim.addColorStop(1, '#e6c36a');
    ctx.strokeStyle = rim;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 37.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawBallSprite(ctx, r, colour, stripe, label, isCue) {
  const R = r;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.clip();
  if (isCue) {
    ctx.fillStyle = '#f7f4ea';
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
  } else if (stripe) {
    ctx.fillStyle = '#f7f4ea';
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    ctx.fillStyle = colour;
    ctx.fillRect(-R, -R * 0.62, 2 * R, R * 1.24);
  } else {
    ctx.fillStyle = colour;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
  }
  if (!isCue) {
    ctx.fillStyle = '#fbf9f0';
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = R * 0.05;
    ctx.stroke();
    ctx.fillStyle = '#141414';
    ctx.font = `800 ${R * 0.72}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, R * 0.04);
  } else {
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }
  // sphere shading
  const sh = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R * 1.05);
  sh.addColorStop(0, 'rgba(255,255,255,0.10)');
  sh.addColorStop(0.55, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = sh;
  ctx.fillRect(-R, -R, 2 * R, 2 * R);
  // specular highlights
  const hl = ctx.createRadialGradient(-R * 0.4, -R * 0.45, 0, -R * 0.4, -R * 0.45, R * 0.42);
  hl.addColorStop(0, 'rgba(255,255,255,0.95)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(-R, -R, 2 * R, 2 * R);
  const bounce = ctx.createRadialGradient(R * 0.35, R * 0.45, 0, R * 0.35, R * 0.45, R * 0.5);
  bounce.addColorStop(0, 'rgba(255,255,255,0.18)');
  bounce.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bounce;
  ctx.fillRect(-R, -R, 2 * R, 2 * R);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = R * 0.05;
  ctx.beginPath();
  ctx.arc(0, 0, R - R * 0.025, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCueStick(ctx, tipX, tipY, angle, alpha, shadowOff) {
  const L = 640;
  const tipR = 2.7;
  const buttR = 6.4;
  ctx.save();
  ctx.globalAlpha = alpha;
  const body = (offX, offY, shadow) => {
    ctx.save();
    ctx.translate(tipX + offX, tipY + offY);
    ctx.rotate(angle);
    // local +x points toward the ball; the stick extends towards -x
    const widthAt = (x) => tipR + ((buttR - tipR) * Math.min(1, -x / L)) ;
    const seg = (x0, x1, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x0, -widthAt(x0));
      ctx.lineTo(x1, -widthAt(x1));
      ctx.lineTo(x1, widthAt(x1));
      ctx.lineTo(x0, widthAt(x0));
      ctx.closePath();
      ctx.fill();
    };
    if (shadow) {
      seg(0, -L, 'rgba(0,0,0,0.28)');
      ctx.restore();
      return;
    }
    const round = (x0, x1, c0, c1) => {
      const g = ctx.createLinearGradient(0, -buttR, 0, buttR);
      g.addColorStop(0, c0);
      g.addColorStop(0.45, c1);
      g.addColorStop(1, c0);
      seg(x0, x1, g);
    };
    round(-5.5, -13, '#c9c4b8', '#fbf9f2'); // ferrule
    round(-13, -L * 0.52, '#c79b5c', '#f1d9a8'); // maple shaft
    round(-L * 0.52, -L * 0.58, '#6b4a22', '#9a6f3a'); // joint
    round(-L * 0.58, -L * 0.83, '#2a170a', '#5a3a1c'); // dark butt sleeve
    round(-L * 0.83, -L, '#141414', '#3a3a3a'); // wrap
    // gold rings
    ctx.fillStyle = '#d9b44a';
    for (const f of [0.58, 0.64, 0.83]) {
      const x = -L * f;
      ctx.fillRect(x - 2, -widthAt(x), 3, 2 * widthAt(x));
    }
    // blue chalked tip
    const tg = ctx.createLinearGradient(0, -tipR, 0, tipR);
    tg.addColorStop(0, '#2a6ed0');
    tg.addColorStop(1, '#14408f');
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.roundRect(-6, -tipR, 6, 2 * tipR, 1.6);
    ctx.fill();
    // long highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-14, -widthAt(-14) * 0.45);
    ctx.lineTo(-L * 0.95, -widthAt(-L * 0.95) * 0.45);
    ctx.stroke();
    ctx.restore();
  };
  body(shadowOff[0] * 1.6, shadowOff[1] * 1.6, true);
  body(0, 0, false);
  ctx.restore();
}

export default function PoolTable({ remaining, spinId, targetId, spinMs, landed, onSettled }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [dims, setDims] = useState({ cw: 0, ch: 0, portrait: false });
  const [plaque, setPlaque] = useState('');
  const simRef = useRef(null);
  const metaRef = useRef({});
  const shotRef = useRef({ phase: 'idle', t: 0 });
  const fxRef = useRef([]);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const tsRef = useRef(1);
  tsRef.current = spinMs <= 1000 ? 2.4 : 1;
  const remainingRef = useRef(remaining);
  remainingRef.current = remaining;
  const layerRef = useRef(null);
  const spritesRef = useRef({});

  // One-off table set-up from the full list of players.
  if (!simRef.current) {
    const names = remaining.map((p) => ({ id: p.id, name: p.name }));
    const small = typeof window !== 'undefined' && window.innerWidth < 600;
    const ids = names.map((p) => p.id);
    simRef.current = createTable(ids, ballRadius(ids.length, small));
    names.forEach((p, i) => {
      metaRef.current[p.id] = {
        name: p.name,
        label: initials(p.name),
        colour: BALL_COLOURS[i % BALL_COLOURS.length],
        stripe: Math.floor(i / BALL_COLOURS.length) % 2 === 1,
      };
    });
  }

  // Size the canvas to its container (portrait table on narrow screens).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const wrapW = el.clientWidth || 320;
      const portrait = wrapW < 560;
      let cw;
      let ch;
      if (portrait) {
        const hmax = Math.max(360, Math.min(680, window.innerHeight * 0.72));
        cw = Math.min(wrapW, (hmax * H) / W);
        ch = (cw * W) / H;
      } else {
        cw = Math.min(wrapW, 860);
        ch = (cw * H) / W;
      }
      setDims((d) => (Math.abs(d.cw - cw) < 1 && d.portrait === portrait ? d : { cw: Math.round(cw), ch: Math.round(ch), portrait }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Pre-render the static table and the ball sprites whenever the size changes.
  useEffect(() => {
    if (!dims.cw) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = ((dims.portrait ? dims.cw / H : dims.cw / W)) * dpr;
    const layer = document.createElement('canvas');
    layer.width = Math.round(dims.cw * dpr);
    layer.height = Math.round(dims.ch * dpr);
    const lc = layer.getContext('2d');
    if (dims.portrait) lc.setTransform(0, k, -k, 0, H * k, 0);
    else lc.setTransform(k, 0, 0, k, 0, 0);
    drawTableLayer(lc);
    layerRef.current = layer;

    const r = simRef.current.r;
    const size = Math.ceil((2 * r + 6) * k);
    const make = (m, isCue) => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const cx = c.getContext('2d');
      cx.scale(k, k);
      cx.translate(r + 3, r + 3);
      drawBallSprite(cx, r, m ? m.colour : '#fff', m ? m.stripe : false, m ? m.label : '', isCue);
      return c;
    };
    const sprites = { cue: make(null, true) };
    Object.keys(metaRef.current).forEach((id) => { sprites[id] = make(metaRef.current[id], false); });
    spritesRef.current = sprites;
  }, [dims]);

  // Start a shot for each new pick.
  useEffect(() => {
    if (spinId == null || !targetId) return;
    const S = simRef.current;
    const meta = metaRef.current[targetId];
    setPlaque(meta ? meta.name : '');
    const plan = planShot(S, targetId);
    if (!plan) {
      setTimeout(() => settledRef.current && settledRef.current(), 50);
      return;
    }
    stopAll(S);
    startShot(S, plan);
    shotRef.current = { phase: plan.respot ? 'respot' : 'aim', t: 0, plan, cueAlpha: plan.respot ? 0 : 1, stick: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);

  // Animation loop.
  useEffect(() => {
    if (!dims.cw) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(dims.cw * dpr);
    canvas.height = Math.round(dims.ch * dpr);
    const ctx = canvas.getContext('2d');
    const k = (dims.portrait ? dims.cw / H : dims.cw / W) * dpr;
    const portrait = dims.portrait;
    const shadowOff = portrait ? [5, -3] : [3, 5];
    let raf = 0;
    let last = performance.now();
    let alive = true;

    const finish = () => {
      shotRef.current = { phase: 'idle', t: 0 };
      if (settledRef.current) settledRef.current();
    };

    const processEvents = (S) => {
      for (const e of S.events) {
        if (e.type === 'pot') {
          const p = POCKETS[e.pocketIdx];
          fxRef.current.push({ x: p.x, y: p.y, t: 0 });
        } else if (e.type === 'scratch') {
          fxRef.current.push({ x: e.x, y: e.y, t: 0, dark: true });
        }
      }
      S.events.length = 0;
    };

    const advance = (dt) => {
      const S = simRef.current;
      const sh = shotRef.current;
      let rem = dt;
      while (rem > 1e-6) {
        const h = Math.min(SUBSTEP, rem);
        step(S, h);
        rem -= h;
      }
      const gone = S.target && !S.target.live;
      processEvents(S);
      fxRef.current.forEach((f) => { f.t += dt; });
      fxRef.current = fxRef.current.filter((f) => f.t < 0.9);
      if (sh.phase === 'idle') return;
      sh.t += dt;
      const plan = sh.plan;
      if (sh.phase === 'respot') {
        sh.cueAlpha = ease(sh.t / T_RESPOT);
        if (sh.t >= T_RESPOT) { sh.phase = 'aim'; sh.t = 0; sh.cueAlpha = 1; }
      } else if (sh.phase === 'aim') {
        sh.stick = ease(sh.t / 0.4);
        if (sh.t >= T_AIM) { sh.phase = 'pull'; sh.t = 0; }
      } else if (sh.phase === 'pull') {
        sh.stick = 1;
        if (sh.t >= T_PULL) { sh.phase = 'strike'; sh.t = 0; }
      } else if (sh.phase === 'strike') {
        if (sh.t >= T_STRIKE) {
          fireShot(S);
          sh.phase = 'roll';
          sh.t = 0;
          sh.strikeAt = { x: S.cue.x, y: S.cue.y };
        }
      } else if (sh.phase === 'roll') {
        if (!S.hit && atRest(S)) forcePot(S);
        if (sh.t > 9 && !S.hit) forcePot(S);
        if (gone) { sh.phase = 'settle'; sh.t = 0; }
      } else if (sh.phase === 'settle') {
        if (atRest(S) || sh.t > 1.6) {
          stopAll(S);
          sh.phase = 'finish';
          sh.t = 0;
        }
      } else if (sh.phase === 'finish') {
        if (sh.t > 0.25) finish();
      }
      sh.plan = plan;
    };

    const stickGap = (sh, S) => {
      const plan = sh.plan;
      const pull = 40 + 80 * plan.power;
      if (sh.phase === 'aim') return 16 + (1 - sh.stick) * 70 + Math.sin(sh.t * 7) * 1.2;
      if (sh.phase === 'pull') return 16 + pull * ease(sh.t / T_PULL);
      if (sh.phase === 'strike') return (16 + pull) * (1 - easeIn(sh.t / T_STRIKE));
      return -4;
    };

    const draw = () => {
      const S = simRef.current;
      const sh = shotRef.current;
      const sprites = spritesRef.current;
      const r = S.r;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (layerRef.current) ctx.drawImage(layerRef.current, 0, 0, canvas.width, canvas.height);
      if (portrait) ctx.setTransform(0, k, -k, 0, H * k, 0);
      else ctx.setTransform(k, 0, 0, k, 0, 0);

      const aiming = ['aim', 'pull', 'strike'].includes(sh.phase) && sh.plan;
      const T = S.target;

      // ball shadows
      const shadow = (x, y, a) => {
        const g = ctx.createRadialGradient(x + shadowOff[0], y + shadowOff[1], r * 0.2, x + shadowOff[0], y + shadowOff[1], r * 1.4);
        g.addColorStop(0, `rgba(0,0,0,${0.5 * a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + shadowOff[0], y + shadowOff[1], r * 1.4, 0, Math.PI * 2);
        ctx.fill();
      };
      S.balls.forEach((b) => { if (b.live && !b.sinking) shadow(b.x, b.y, 1); });
      const cueAlpha = S.cue.on ? (sh.phase === 'respot' ? sh.cueAlpha : 1) : 0;
      if (cueAlpha > 0) shadow(S.cue.x, S.cue.y, cueAlpha);

      // aiming guides
      if (aiming) {
        const plan = sh.plan;
        const a = 0.5 + 0.2 * Math.sin(performance.now() / 160);
        ctx.save();
        ctx.setLineDash([7, 8]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.moveTo(S.cue.x, S.cue.y);
        ctx.lineTo(plan.G.x, plan.G.y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(240,200,80,${a})`;
        ctx.beginPath();
        ctx.moveTo(T.x, T.y);
        ctx.lineTo(plan.pocket.x, plan.pocket.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(plan.G.x, plan.G.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(240,200,80,${a + 0.2})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(plan.pocket.x, plan.pocket.y, 38, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const drawSprite = (img, x, y, scale, alpha) => {
        if (!img) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        if (portrait) ctx.rotate(-Math.PI / 2);
        ctx.scale(scale, scale);
        ctx.drawImage(img, -(r + 3), -(r + 3), 2 * r + 6, 2 * r + 6);
        ctx.restore();
      };

      S.balls.forEach((b) => {
        if (!b.live) return;
        if (b.sinking) {
          const e = ease(b.sinkT);
          const p = POCKETS[b.pocketIdx];
          const x = b.sinkFrom.x + (p.x - b.sinkFrom.x) * e;
          const y = b.sinkFrom.y + (p.y - b.sinkFrom.y) * e;
          drawSprite(sprites[b.id], x, y, 1 - 0.45 * e, 1 - 0.15 * e);
          ctx.fillStyle = `rgba(0,0,0,${0.9 * e})`;
          ctx.beginPath();
          ctx.arc(x, y, r * (1 - 0.45 * e), 0, Math.PI * 2);
          ctx.fill();
        } else {
          drawSprite(sprites[b.id], b.x, b.y, 1, 1);
        }
      });
      if (cueAlpha > 0) {
        const grow = sh.phase === 'respot' ? 0.7 + 0.3 * sh.cueAlpha : 1;
        drawSprite(sprites.cue, S.cue.x, S.cue.y, grow, cueAlpha);
      }

      // glow on the target while aiming
      if (aiming && T && T.live) {
        const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 140);
        ctx.strokeStyle = `rgba(245,205,80,${pulse})`;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.arc(T.x, T.y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(245,205,80,${pulse * 0.35})`;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(T.x, T.y, r + 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      // the cue stick
      if (sh.plan && ['aim', 'pull', 'strike', 'roll'].includes(sh.phase)) {
        let alpha = 1;
        let cx = S.cue.x;
        let cy = S.cue.y;
        if (sh.phase === 'aim') alpha = sh.stick;
        if (sh.phase === 'roll') {
          alpha = Math.max(0, 1 - sh.t / 0.45);
          cx = sh.strikeAt ? sh.strikeAt.x : cx;
          cy = sh.strikeAt ? sh.strikeAt.y : cy;
        }
        if (alpha > 0.01) {
          const gap = stickGap(sh, S);
          const ang = sh.plan.angle + (sh.phase === 'aim' ? Math.sin(sh.t * 5) * 0.004 : 0);
          const tipDist = r + gap;
          const tx = cx - Math.cos(ang) * tipDist;
          const ty = cy - Math.sin(ang) * tipDist;
          drawCueStick(ctx, tx, ty, ang, alpha, shadowOff);
        }
      }

      // pot effects
      fxRef.current.forEach((f) => {
        const u = f.t / 0.9;
        ctx.strokeStyle = f.dark ? `rgba(255,255,255,${0.5 * (1 - u)})` : `rgba(245,210,90,${0.9 * (1 - u)})`;
        ctx.lineWidth = 4 * (1 - u) + 1;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 30 + u * 46, 0, Math.PI * 2);
        ctx.stroke();
        if (!f.dark) {
          const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 52);
          g.addColorStop(0, `rgba(255,230,140,${0.45 * (1 - u)})`);
          g.addColorStop(1, 'rgba(255,230,140,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(f.x, f.y, 52, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    };

    const tick = (now) => {
      if (!alive) return;
      const dtReal = Math.min(0.05, (now - last) / 1000);
      last = now;
      advance(dtReal * tsRef.current);
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims]);

  const showDivision = landed && landed.name === plaque;
  return (
    <div className="ad-pool">
      <div className="ad-plaque" key={plaque || 'none'} aria-live="polite">
        <span className="ad-plaque-name">{plaque || ' '}</span>
        {showDivision ? <span className="ad-plaque-div">&rarr; {landed.division}</span> : null}
      </div>
      <div className="ad-pool-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="ad-pool-canvas"
          style={{ width: dims.cw || '100%', height: dims.ch || 240 }}
          role="img"
          aria-label="Pool table: the cue ball pots one player's ball at a time"
        />
      </div>
    </div>
  );
}
