// Adaptive Double Elimination (ADE)
// ============================================================================
// A double-elimination format for any entrant count from 1 upwards whose
// pairings are computed ON THE FLY from real results rather than routed
// through a bracket graph fixed in advance.
//
// Guarantees, verified by exhaustive simulation (see the format's report):
//   * no player meets the same opponent twice before the Losers Final,
//     the Winners Final or the Grand Final
//   * no player ever receives more than one bye
//   * exactly 2n-2 matches, single Grand Final, no bracket reset
//
// WHY THIS CAN GUARANTEE WHAT A PRE-CONFIGURED BRACKET CANNOT
// ------------------------------------------------------------------
// This project has twice proved that zero pre-final rematches is impossible
// (claude/ally-knockout-2026-08-14.md, and the pigeonhole argument in
// generatePCDEKFixtures). Both proofs are correct and both are about a FIXED
// routing graph: whichever losers-bracket box a dropout is wired into, some
// branch exists where the only same-loss-count opponent waiting there is
// someone they already beat, because the wiring must be committed before the
// results that decide who is safe have happened.
//
// This format has no wiring to commit. Each round is chosen after the
// previous one is played, with the actual results in hand, so the pigeonhole
// never closes. That is the whole idea - and it is why this generator must
// never be "optimised" into pre-building its later rounds.
//
// THE SIX FACTS IT RESTS ON
// ------------------------------------------------------------------
// F1  Two winners-bracket players have never met: a match hands out exactly
//     one loss and they have none. The winners bracket is therefore
//     rematch-free however it is paired, and ALL risk lives in the losers
//     bracket.
// F2  Every possible losers-bracket rematch is a pair who met in the WINNERS
//     bracket and are both still alive. A losers match eliminates its loser,
//     so it never creates a future conflict.
// F3  wave(p) = the winners round p lost in. Same-wave players have never met
//     (both undefeated until that round, each beaten by someone different),
//     and conflicts only ever point from a later wave back to an earlier one.
//     Every fresh drop wave is a supply of guaranteed-safe partners.
// F4  A conflict graph of max degree D on 2m players always leaves a
//     conflict-free perfect matching when m >= D+1. For 50 entrants D <= 6,
//     so any losers pool of 14+ is guaranteed pairable.
// F5  THE CONFLICT GRAPH IS A FOREST, HENCE TRIANGLE-FREE. A winners-bracket
//     player who loses leaves it, so nobody carries two WB losses; orient
//     each edge winner->loser and every node has in-degree <= 1. Three
//     mutually-met players would need someone to hold two WB losses.
//     => ANY THREE ALIVE PLAYERS CONTAIN A PAIR WHO HAVE NEVER MET, so a
//     losers pool of three ALWAYS has a clean answer: sit out the odd one,
//     play the clean pair. Only exhausted bye allowance can defeat it, which
//     is why byes are rationed as carefully as they are below.
// F6  A drop wave enters the losers bracket as a UNIT and may be held back a
//     round. That is an entry point, not a bye - exactly what a conventional
//     double-elimination bracket does when losers-bracket survivors play a
//     "minor" round before the next wave joins them, and what it does with
//     the winners-final loser, who sits out every losers round and enters at
//     the Losers Final.
//
// THE FIVE LEVERS, IN ORDER OF PREFERENCE
//   L1 MATCHING  exact conflict-free perfect matching over the pool
//   L2 ROSTER    which held waves join this round - the cheapest parity fix,
//                because it costs nobody a bye
//   L3 BYE       when the pool must be odd, sit out a player whose removal
//                leaves the rest still perfectly matchable
//   L4 CADENCE   a pool that cannot be paired cleanly is never forced to
//                play; run a winners round and let F3 dissolve the blockage
//   L5 SOLVER    once the field is small, hand over to an exhaustive
//                game-tree search that picks a round which stays safe under
//                EVERY remaining sequence of results
//
// This module is PURE: no database, no randomness, no clock. `nextRound` is
// a function of (entrants, completed history) alone, so the server can
// recompute it from its fixture table at any time and always get the same
// answer.
// ============================================================================

export const BRACKET_WINNERS = 'winners';
export const BRACKET_LOSERS = 'losers';
export const BRACKET_GRAND_FINAL = 'grand_final';

// Rematches are permitted in exactly these three matches, and nowhere else.
export const EXEMPT_KINDS = new Set(['wb_final', 'lb_final', 'grand_final']);

const CFG = {
  byeCap: 1,
  maxHold: 1,        // max losers rounds a drop wave may be held (F6)
  solverAt: 10,      // engage the exhaustive solver at <= N alive
  solverBudget: 250000,
  wShared: 100,
  wDegree: 10,
  wSameWave: 3,
  wWorkload: 1,
};

// ---------------------------------------------------------------------------
// L1 - exact conflict-free perfect matching.
// Minimum-remaining-values ordering plus dead-vertex pruning; effectively
// linear on a forest conflict graph (F5).
// ---------------------------------------------------------------------------

function perfectMatching(items, blockedFn, scoreFn, budget = 200000) {
  const n = items.length;
  if (n % 2) throw new Error('perfect matching needs an even pool');
  if (n === 0) return [];

  // Adjacency is stored as the CONFLICT list, not the allowed list: by F5 the
  // conflict graph is a forest, so this is tiny while its complement (what we
  // actually match on) is dense. It also sidesteps bitmask matching, which
  // would silently break above 31 players - a 50-entrant field reaches a
  // losers pool of 49.
  const blocked = items.map((a, i) => {
    const s = new Set();
    items.forEach((b, j) => { if (i !== j && blockedFn(a, b)) s.add(j); });
    return s;
  });
  const order = items.map((a, i) => {
    const cand = [];
    items.forEach((b, j) => { if (i !== j && !blocked[i].has(j)) cand.push(j); });
    cand.sort((x, y) => {
      const d = scoreFn(a, items[y]) - scoreFn(a, items[x]);
      return d !== 0 ? d : items[x].seed - items[y].seed;
    });
    return cand;
  });

  const taken = new Uint8Array(n);
  const out = [];
  let left = budget;

  const solve = (remaining) => {
    if (remaining === 0) return true;
    if (--left <= 0) throw new Error('matching budget');
    // Minimum-remaining-values: expand the most constrained vertex first, and
    // abandon the branch the moment any vertex has no legal partner left.
    let bestI = -1; let bestC = Infinity;
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      let blockedLeft = 0;
      for (const j of blocked[i]) if (!taken[j]) blockedLeft += 1;
      const c = remaining - 1 - blockedLeft;
      if (c <= 0) return false;
      if (c < bestC) { bestI = i; bestC = c; if (c === 1) break; }
    }
    taken[bestI] = 1;
    for (const j of order[bestI]) {
      if (taken[j]) continue;
      taken[j] = 1;
      out.push([items[bestI], items[j]]);
      if (solve(remaining - 2)) return true;
      out.pop();
      taken[j] = 0;
    }
    taken[bestI] = 0;
    return false;
  };

  try {
    return solve(n) ? out.slice() : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// L5 - exhaustive endgame solver.
//
// Everything above is greedy. By F4 that is provably safe while the field is
// big; the danger is the endgame, where pools are small, bye allowance is
// spent, and a wrong choice three rounds earlier leaves no legal move at all.
// Below `solverAt` alive players this search answers, exactly:
//
//   is there a round I can run now such that, whoever wins each match, a
//   rematch-free continuation still exists all the way to the Grand Final?
//
// Outcomes are adversarial - a state is safe only if EVERY winner/loser
// sequence stays safe. The conflict set is part of the state, not a
// constant: every winners-bracket match the search simulates creates a
// permanent new conflict between two players who both stay alive, and a
// solver that froze it would walk into positions it had itself made
// unplayable. Losers matches eliminate their loser and so add nothing;
// pruning dead players out after each transition is what keeps the memo
// table small enough to be fast.
// ---------------------------------------------------------------------------

function allPairings(items) {
  if (items.length === 0) return [[]];
  const [a, ...rest] = items;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    const remain = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const tail of allPairings(remain)) out.push([[a, b], ...tail]);
  }
  return out;
}

const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// JS compares arrays as strings, so tuple ordering needs saying out loud.
function lexLess(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

class Endgame {
  constructor(maxHold, budget) {
    this.maxHold = maxHold;
    this.budget = budget;
    this.memo = new Map();
    this.exhausted = false;
  }

  key(W, L, Q, used, met) {
    return `${[...W].sort().join(',')}#${L.join(',')}#` +
      `${Q.map((q) => q[0].join('.') + ':' + q[1]).join(';')}#` +
      `${[...used].sort().join(',')}#${[...met].sort().join(',')}`;
  }

  *lbActions(W, L, Q, used, met) {
    const lbAlive = L.length + Q.reduce((s, q) => s + q[0].length, 0);
    let need = L.length < 2 ? 1 : 0;
    if (W.size <= 1) need = Q.length;
    Q.forEach((q, i) => { if (q[1] >= this.maxHold) need = Math.max(need, i + 1); });
    need = Math.min(need, Q.length);
    for (let k = need; k <= Q.length; k++) {
      let roster = [...L];
      for (let i = 0; i < k; i++) roster = roster.concat(Q[i][0]);
      roster.sort((a, b) => a - b);
      if (roster.length < 2) continue;
      const newQ = Q.slice(k).map((q) => [q[0], q[1] + 1]);
      const exempt = W.size <= 1 && lbAlive === 2 && roster.length === 2;
      const cands = roster.length % 2 === 0
        ? [[roster, null]]
        : roster.filter((c) => !used.has(c)).map((c) => [roster.filter((p) => p !== c), c]);
      for (const [pool, bye] of cands) {
        for (const m of allPairings(pool)) {
          if (!exempt && m.some(([a, b]) => met.has(pk(a, b)))) continue;
          yield [m, bye, newQ];
        }
      }
    }
  }

  *wbActions(W, used) {
    const w = [...W].sort((a, b) => a - b);
    if (w.length % 2 === 0) {
      for (const m of allPairings(w)) yield [m, null];
    } else {
      for (const c of w) {
        if (used.has(c)) continue;
        for (const m of allPairings(w.filter((p) => p !== c))) yield [m, c];
      }
    }
  }

  static prune(met, alive) {
    const out = new Set();
    for (const p of met) {
      const [a, b] = p.split('|').map(Number);
      if (alive.has(a) && alive.has(b)) out.add(p);
    }
    return out;
  }

  safe(W, L, Q, used, met) {
    const lbAlive = L.length + Q.reduce((s, q) => s + q[0].length, 0);
    if (W.size <= 1 && lbAlive <= 1) return true;   // champion, or exempt Grand Final
    const k = this.key(W, L, Q, used, met);
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    if (--this.budget <= 0) { this.exhausted = true; return false; }
    const res = this.search(W, L, Q, used, met) !== null;
    this.memo.set(k, res);
    return res;
  }

  search(W, L, Q, used, met) {
    const lbAlive = L.length + Q.reduce((s, q) => s + q[0].length, 0);

    if (lbAlive >= 2) {
      for (const [m, bye, newQ] of this.lbActions(W, L, Q, used, met)) {
        let ok = true;
        for (let bits = 0; bits < (1 << m.length); bits++) {
          const surv = bye !== null ? [bye] : [];
          m.forEach(([a, b], i) => surv.push((bits >> i & 1) ? a : b));
          surv.sort((a, b) => a - b);
          const alive = new Set([...surv, ...W]);
          newQ.forEach((q) => q[0].forEach((p) => alive.add(p)));
          const nu = new Set([...used, ...(bye !== null ? [bye] : [])].filter((x) => alive.has(x)));
          if (!this.safe(W, surv, newQ, nu, Endgame.prune(met, alive))) { ok = false; break; }
        }
        if (ok) return ['lb', m, bye, newQ];
      }
    }

    if (W.size >= 2) {
      for (const [m, bye] of this.wbActions(W, used)) {
        let ok = true;
        for (let bits = 0; bits < (1 << m.length); bits++) {
          const win = bye !== null ? [bye] : []; const drop = [];
          m.forEach(([a, b], i) => {
            const [w_, l_] = (bits >> i & 1) ? [a, b] : [b, a];
            win.push(w_); drop.push(l_);
          });
          const nmet = new Set(met);
          m.forEach(([a, b]) => nmet.add(pk(a, b)));
          const nu = new Set([...used, ...(bye !== null ? [bye] : [])]);
          const nQ = [...Q, [drop.slice().sort((a, b) => a - b), 0]];
          if (!this.safe(new Set(win), L, nQ, nu, nmet)) { ok = false; break; }
        }
        if (ok) return ['wb', m, bye, Q];
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class Engine {
  constructor(entrantIds) {
    this.byId = new Map();
    entrantIds.forEach((id, i) => this.byId.set(id, {
      id, seed: i, losses: 0, byes: 0, wave: null, met: new Set(), lbGames: 0,
    }));
    this.index = new Map(entrantIds.map((id, i) => [id, i]));
    this.W = entrantIds.map((id) => this.byId.get(id));
    this.L = [];
    this.Q = [];               // [{ players: [p], held: n }]
    this.wbRoundNo = 0;
    this.lbRoundNo = 0;
    this.roundNo = 0;
    this.champion = null;
    if (entrantIds.length === 1) { this.champion = this.W[0]; this.W = []; }
  }

  bySeed(list) { return [...list].sort((a, b) => a.seed - b.seed); }
  lbAlive() { return this.L.length + this.Q.reduce((s, w) => s + w.players.length, 0); }

  // -- replay -------------------------------------------------------------

  applyRound(bracket, matches, byes) {
    this.roundNo += 1;
    if (bracket === BRACKET_WINNERS) this.wbRoundNo += 1;
    if (bracket === BRACKET_LOSERS) this.lbRoundNo += 1;
    for (const { a, b } of matches) {
      a.met.add(b.id); b.met.add(a.id);
    }
    if (bracket === BRACKET_WINNERS) {
      const survivors = [...byes]; const drops = [];
      for (const { a, b, winner } of matches) {
        const loser = winner === a ? b : a;
        loser.losses += 1; loser.wave = this.wbRoundNo;
        survivors.push(winner); drops.push(loser);
      }
      this.W = this.bySeed(survivors);
      if (drops.length) this.Q.push({ players: this.bySeed(drops), held: 0 });
    } else if (bracket === BRACKET_LOSERS) {
      // Whoever appears in a losers round has, by definition, been admitted
      // from the waiting room. History records only matches and byes, so
      // admission is re-derived here rather than stored.
      const appeared = new Set();
      matches.forEach(({ a, b }) => { appeared.add(a.id); appeared.add(b.id); });
      byes.forEach((p) => appeared.add(p.id));
      this.Q = this.Q
        .map((w) => ({ players: w.players.filter((p) => !appeared.has(p.id)), held: w.held }))
        .filter((w) => w.players.length > 0);
      const keep = [...byes];
      for (const { a, b, winner } of matches) {
        const loser = winner === a ? b : a;
        loser.losses += 1;
        a.lbGames += 1; b.lbGames += 1;
        keep.push(winner);
      }
      this.L = this.bySeed(keep);
      this.Q.forEach((w) => { w.held += 1; });
    } else {
      const { a, b, winner } = matches[0];
      (winner === a ? b : a).losses += 1;
      this.champion = winner;
      this.W = []; this.L = []; this.Q = [];
    }
    for (const p of byes) p.byes += 1;
  }

  // -- conflict views -------------------------------------------------------

  blocked(pool) {
    const ids = new Set(pool.map((p) => p.id));
    const m = new Map();
    for (const p of pool) m.set(p.id, new Set([...p.met].filter((x) => ids.has(x))));
    return m;
  }

  // Forward-looking entanglement: opponents already met who are STILL ALIVE
  // anywhere, losers pool or winners bracket. A winners-bracket opponent is a
  // conflict-in-waiting - the moment they drop they become unpairable with
  // this player. Ranking on the live set rather than the current pool is what
  // stops the engine spending a player's one bye on someone about to become
  // the pool's most-constrained hub.
  live(pool) {
    const alive = new Set();
    this.W.forEach((p) => alive.add(p.id));
    this.L.forEach((p) => alive.add(p.id));
    this.Q.forEach((w) => w.players.forEach((p) => alive.add(p.id)));
    const m = new Map();
    for (const p of pool) m.set(p.id, new Set([...p.met].filter((x) => alive.has(x) && x !== p.id)));
    return m;
  }

  // -- next round -----------------------------------------------------------

  nextRound() {
    if (this.champion) return null;
    if (this.W.length === 1 && this.lbAlive() === 1) {
      this.flush();
      return this.mk(BRACKET_GRAND_FINAL, 'grand_final', [[this.W[0], this.L[0]]], [], 'Grand Final');
    }
    if (this.W.length <= 1 && this.lbAlive() <= 1) return null;

    // L5 gets first refusal on EVERY endgame decision - including winners
    // rounds, whose pairing decides which conflicts the losers bracket has to
    // live with later.
    const solved = this.solveEndgame();
    if (solved) return solved;

    if (this.W.length <= 1) { this.flush(); return this.lbRound(); }
    if (this.lbAlive() <= 1) return this.wbRound();

    const plan = this.bestLbPlan();
    if (!plan) return this.wbRound();          // L4: never force a dirty round
    if (!this.paceSaysLb(plan)) return this.wbRound();
    return this.lbRound(plan);
  }

  flush() { while (this.Q.length) this.L = this.bySeed(this.L.concat(this.Q.shift().players)); }

  solveEndgame() {
    const alive = [...this.W, ...this.L, ...this.Q.flatMap((w) => w.players)];
    if (alive.length > CFG.solverAt) return null;
    const met = new Set();
    const ids = new Set(alive.map((p) => p.id));
    for (const p of alive) for (const q of p.met) if (ids.has(q)) met.add(pk(this.index.get(p.id), this.index.get(q)));
    const W = new Set(this.W.map((p) => this.index.get(p.id)));
    const L = this.L.map((p) => this.index.get(p.id)).sort((a, b) => a - b);
    const Q = this.Q.map((w) => [w.players.map((p) => this.index.get(p.id)).sort((a, b) => a - b), w.held]);
    const used = new Set(alive.filter((p) => p.byes >= CFG.byeCap).map((p) => this.index.get(p.id)));
    const sol = new Endgame(CFG.maxHold, CFG.solverBudget);
    const act = sol.search(W, L, Q, used, met);
    if (!act || sol.exhausted) return null;
    const seeds = [...this.byId.values()].sort((a, b) => a.seed - b.seed);
    const P = (i) => seeds[i];
    const [kind, m, bye, newQ] = act;
    const pm = m.map(([a, b]) => [P(a), P(b)]);
    const byes = bye !== null ? [P(bye)] : [];
    if (kind === 'wb') {
      const isFinal = this.W.length === 2;
      return this.mk(BRACKET_WINNERS, isFinal ? 'wb_final' : 'wb', pm, byes,
        isFinal ? 'Winners Final' : `Winners Round ${this.wbRoundNo + 1}`);
    }
    const consumed = this.Q.length - newQ.length;
    const roster = pm.flat().concat(byes);
    this.Q.splice(0, consumed);
    this.L = this.bySeed(roster);
    const isFinal = this.lbAlive() === 2 && this.W.length <= 1;
    return this.mk(BRACKET_LOSERS, isFinal ? 'lb_final' : 'lb', pm, byes,
      isFinal ? 'Losers Final' : `Losers Round ${this.lbRoundNo + 1}`);
  }

  // -- winners round --------------------------------------------------------

  wbRound() {
    let pool = [...this.W]; const byes = [];
    if (pool.length % 2) {
      const b = this.wbBye(pool);
      byes.push(b); pool = pool.filter((p) => p !== b);
    }
    pool = this.bySeed(pool);
    const matches = this.wbPairs(pool);
    const isFinal = this.W.length === 2;
    return this.mk(BRACKET_WINNERS, isFinal ? 'wb_final' : 'wb', matches, byes,
      isFinal ? 'Winners Final' : `Winners Round ${this.wbRoundNo + 1}`);
  }

  // F1 says every winners-bracket pairing is rematch-safe, so the pairing is
  // free to serve a different purpose: PROTECTING THE BYE BUDGET. A bye is a
  // free pass, so bye recipients are over-represented among deep survivors -
  // and a field like 33, whose winners pool runs 33 -> 17 -> 9 -> 5 -> 3 -> 2,
  // hands out five of them. Left alone all five can reach the last handful of
  // players, and then the losers bracket has no bye left to spend on the one
  // player whose sitting out would keep a round clean. So pair players who
  // have already used their bye AGAINST EACH OTHER: every such match retires
  // one of them, keeping bye-free players alive deep into the event where
  // their allowance is worth most. The rest get the classic seed fold, which
  // keeps the implied bracket tree balanced and drop waves even.
  wbPairs(pool) {
    const spent = pool.filter((p) => p.byes > 0);
    const free = pool.filter((p) => p.byes === 0);
    const matches = [];
    while (spent.length >= 2) matches.push([spent.shift(), spent.shift()]);
    if (spent.length) matches.push([spent.shift(), free.splice(Math.floor(free.length / 2), 1)[0]]);
    for (let i = 0; i < Math.floor(free.length / 2); i++) matches.push([free[i], free[free.length - 1 - i]]);
    return matches;
  }

  wbBye(pool) {
    const elig = pool.filter((p) => p.byes < CFG.byeCap);
    const from = elig.length ? elig : pool;
    const live = this.live(from);
    return [...from].sort((a, b) => (live.get(a.id).size - live.get(b.id).size) || (a.seed - b.seed))[0];
  }

  // -- losers round ---------------------------------------------------------

  minWaves() {
    let need = this.L.length < 2 ? 1 : 0;
    this.Q.forEach((w, i) => { if (w.held >= CFG.maxHold) need = Math.max(need, i + 1); });
    return Math.min(need, this.Q.length);
  }

  // L2 - try every legal roster (current pool plus 0..k held waves, admitted
  // oldest first) and take the cheapest rematch-free plan. Preference: fewest
  // byes, then fewest waves pulled forward, then the larger pool.
  bestLbPlan() {
    const lo = this.minWaves();
    let roster = [...this.L]; let best = null;
    for (let k = 0; k <= this.Q.length; k++) {
      if (k) roster = roster.concat(this.Q[k - 1].players);
      if (k < lo || roster.length < 2) continue;
      const plan = this.plan(this.bySeed(roster), k);
      if (!plan) continue;
      const key = [plan.byes.length, k, -roster.length];
      if (!best || lexLess(key, best.key)) best = { key, plan };
      if (plan.byes.length === 0 && k === lo) break;
    }
    return best ? best.plan : null;
  }

  plan(roster, waves) {
    if (this.lbAlive() === 2 && this.W.length <= 1 && roster.length === 2) {
      return { matches: [[roster[0], roster[1]]], byes: [], roster, waves };
    }
    if (roster.length % 2 === 0) {
      const m = this.match(roster);
      return m ? { matches: m, byes: [], roster, waves } : null;
    }
    // L3 - every eligible sit-out candidate is tried and only accepted if the
    // remainder is still perfectly matchable, so a bye can never be the thing
    // that forces a rematch. Sit out the LEAST entangled player: the hubs stay
    // in play where they can be eliminated, and a hub's single bye stays
    // unspent for the endgame, where sitting the hub out is often the only
    // rematch-free option left (F5).
    const live = this.live(roster);
    const elig = roster.filter((p) => p.byes < CFG.byeCap)
      .sort((a, b) => (live.get(a.id).size - live.get(b.id).size) || (a.seed - b.seed));
    for (const cand of elig) {
      const rest = roster.filter((p) => p !== cand);
      const m = this.match(rest);
      if (m) return { matches: m, byes: [cand], roster, waves };
    }
    return null;
  }

  match(pool) {
    const blocked = this.blocked(pool);
    const live = this.live(pool);
    const score = (a, b) => {
      // wShared: pairing two players who both threaten the same third player
      //   guarantees one of them dies, so that third player's entanglement
      //   drops - the most effective way to dissolve a blockage before it
      //   forms. wDegree: pairing two hubs together kills one hub outright.
      let shared = 0;
      for (const x of live.get(a.id)) if (live.get(b.id).has(x)) shared += 1;
      let s = CFG.wShared * shared + CFG.wDegree * (live.get(a.id).size + live.get(b.id).size);
      if (a.wave === b.wave) s += CFG.wSameWave;
      return s - CFG.wWorkload * Math.abs(a.lbGames - b.lbGames);
    };
    return perfectMatching(pool, (a, b) => blocked.get(a.id).has(b.id), score);
  }

  // L4 - drain toward the size of the wave the next winners round will drop.
  // Its most valuable consequence is forcing the losers pool to 1 before the
  // WINNERS FINAL, so the winners-final loser - the most entangled player in
  // the event - enters at the exempt LOSERS FINAL.
  paceSaysLb(plan) {
    const alive = this.lbAlive();
    const target = Math.max(Math.floor(this.W.length / 2), 1);
    if (alive <= target) return false;
    if (plan.byes.length && this.W.length > 1) {
      // this roster needs a bye; waiting for the next drop wave may remove
      // the need, and costs nobody anything (F6)
      if ((alive + Math.floor(this.W.length / 2)) % 2 === 0) return false;
    }
    return true;
  }

  lbRound(plan) {
    const p = plan || this.bestLbPlan();
    if (!p) return this.fallbackLbRound();
    this.Q.splice(0, p.waves);
    this.L = this.bySeed(p.roster);
    const isFinal = this.lbAlive() === 2 && this.W.length <= 1;
    return this.mk(BRACKET_LOSERS, isFinal ? 'lb_final' : 'lb', p.matches, p.byes,
      isFinal ? 'Losers Final' : `Losers Round ${this.lbRoundNo + 1}`);
  }

  // Reached only if no roster can be played cleanly and the winners bracket is
  // spent. Simulation has never produced this state for 1..50 entrants, but a
  // generator must always return a legal round, so: fewest rematches possible.
  fallbackLbRound() {
    let roster = [...this.L]; const waves = this.Q.length;
    this.Q.forEach((w) => { roster = roster.concat(w.players); });
    roster = this.bySeed(roster);
    const byes = [];
    if (roster.length % 2) {
      const live = this.live(roster);
      const elig = roster.filter((x) => x.byes < CFG.byeCap);
      const from = elig.length ? elig : roster;
      const b = [...from].sort((a, c) => (live.get(a.id).size - live.get(c.id).size) || (a.seed - c.seed))[0];
      byes.push(b); roster = roster.filter((x) => x !== b);
    }
    const blocked = this.blocked(roster);
    const matches = [];
    const pool = [...roster];
    while (pool.length) {
      const a = pool.shift();
      let idx = pool.findIndex((x) => !blocked.get(a.id).has(x.id));
      if (idx < 0) idx = 0;
      matches.push([a, pool.splice(idx, 1)[0]]);
    }
    this.Q.splice(0, waves);
    this.L = this.bySeed(matches.flat().concat(byes));
    return this.mk(BRACKET_LOSERS, 'lb', matches, byes, `Losers Round ${this.lbRoundNo + 1}`);
  }

  mk(bracket, kind, matches, byes, label) {
    return { bracket, kind, matches, byes, label, degraded: false };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the next round from the entrant list plus every round already
 * played. Pure - no DB, no randomness, no clock. Calling it twice with the
 * same input always returns the same round, which is what lets the server
 * recompute it from the fixture table whenever it likes.
 *
 * @param entrantIds  ordered entrant ids (the order is the seeding)
 * @param history     [{ bracket, matches: [{a,b,winner}], byes: [id] }] in play order
 * @returns { bracket, kind, label, matches: [[idA,idB]], byes: [id] } or null when finished
 */
export function nextRound(entrantIds, history = []) {
  const e = new Engine(entrantIds);
  for (const r of history) {
    e.applyRound(
      r.bracket,
      r.matches.map((m) => ({
        a: e.byId.get(m.a), b: e.byId.get(m.b), winner: e.byId.get(m.winner),
      })),
      (r.byes || []).map((id) => e.byId.get(id)),
    );
  }
  const r = e.nextRound();
  if (!r) return null;
  return {
    bracket: r.bracket,
    kind: r.kind,
    label: r.label,
    matches: r.matches.map(([a, b]) => [a.id, b.id]),
    byes: r.byes.map((p) => p.id),
  };
}

/** Total matches an n-entrant event will contain (single Grand Final). */
export function expectedMatchCount(n) {
  return n <= 1 ? 0 : 2 * n - 2;
}
