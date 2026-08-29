// "Killer" divisions - Killer Classic and Cards Killer. Both are a single,
// ongoing multi-player elimination game (everyone in the division plays at
// once, on one table, taking turns), not a series of 1-v-1 matches - so
// unlike every other scheduling type in this app, a Killer division never
// generates Fixture records. Instead a division of one of these two
// scheduling types carries a single `killer` state object (see
// initKillerState below) that this module reads and writes, and
// server/src/index.js's POST /api/divisions/:id/killer/* routes are the only
// way it changes.
//
// Rules implemented (see the project doc this shipped with for the two
// rule-sheets these were built from):
//
// Killer Classic - turn order is fixed for the whole game (the names are
// "drawn from a hat" once, at the start, into `order`), advancing to the
// next player still holding a life each time, wrapping around.
//
// Cards Killer - turn order is driven by drawing from a shuffled deck built
// from every player's *current* life count (3 lives = 3 cards, matching the
// physical "3 of each number" deck the real game uses) instead of a fixed
// rotation. Rather than modelling individual physical cards (which the
// official rules never actually require - see the "cards left in the pack
// should equal the tally marks left on the board" invariant), this tracks
// only a shuffled array of player ids: drawing is popping the front of it,
// and "the cards are shuffled again" (rule 3.5) is rebuilding that array
// from however many lives each still-active player currently has. That
// invariant - remaining deck size always equals total remaining lives right
// after a (re)shuffle - falls out automatically rather than needing to be
// separately maintained.
//
// Both formats share: a break shot that doesn't cost a life if nothing goes
// in (but must be potted on the very next attempt by the same player), a
// life lost on any other miss (or the white potted/off the table), and the
// last player left with a life wins. Every function here is pure (no I/O),
// mirroring services/bracket.js, services/roundRobin.js etc. - the caller
// (server/src/index.js's routes, or client/src/demo/demoApi.js for the
// static demo build) owns persistence and permission checks.

export const KILLER_CLASSIC = 'killer_classic';
export const CARDS_KILLER = 'cards_killer';
export const KILLER_TYPES = [KILLER_CLASSIC, CARDS_KILLER];

// Cards Killer needs a distinct number 1-N per player, matching the real
// game's deck (numbers 1-13, using J/Q/K above 10) - so it's capped at 13
// players. Killer Classic has no such constraint ("a pool game for as many
// players as you want").
export const CARDS_KILLER_MAX_PLAYERS = 13;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A flat, shuffled array of playerIds - each active id repeated once per
// life it currently holds. Drawing a turn is popping the front of this;
// rebuilding it (once it runs out) is calling this again.
function buildDeck(activePlayerIds, lives) {
  const flat = [];
  for (const id of activePlayerIds) {
    for (let i = 0; i < (lives[id] || 0); i += 1) flat.push(id);
  }
  return shuffle(flat);
}

function activePlayerIds(state) {
  return state.order.filter((id) => (state.lives[id] || 0) > 0);
}

function pushLog(state, entry) {
  state.log = [...state.log, { id: state.log.length + 1, ts: new Date().toISOString(), ...entry }];
}

// Snapshot used for undo - everything except the history stack itself (so
// undo doesn't grow the snapshot it's restoring).
function snapshot(state) {
  const { history, ...rest } = state;
  return JSON.parse(JSON.stringify(rest));
}

const MAX_UNDO_HISTORY = 30;

// Draws (Cards Killer) or advances (Killer Classic) to the next player still
// holding a life. Mutates and returns `state` in place - callers always
// operate on a fresh working copy (see recordShot below), never the
// division's own stored object directly.
function advanceTurn(state, format) {
  if (format === CARDS_KILLER) {
    if (state.deck.length === 0) {
      state.deck = buildDeck(activePlayerIds(state), state.lives);
      pushLog(state, { type: 'reshuffle', detail: `Deck reshuffled - ${state.deck.length} card(s) in play` });
    }
    state.currentPlayerId = state.deck[0];
    state.deck = state.deck.slice(1);
    return state;
  }
  // Killer Classic: fixed rotation, skipping anyone already out.
  const n = state.order.length;
  const startIdx = state.order.indexOf(state.currentPlayerId);
  for (let step = 1; step <= n; step += 1) {
    const candidate = state.order[(startIdx + step) % n];
    if ((state.lives[candidate] || 0) > 0) {
      state.currentPlayerId = candidate;
      return state;
    }
  }
  return state; // unreachable once win detection below has already ended the game
}

// Starts a new killer game for a division. `playerIds` is whatever the
// admin has registered on the division's normal singles roster
// (division.playerIds) - Killer divisions reuse that same roster mechanism,
// they just never call generate-fixtures. Returns { ok:true, state } or
// { ok:false, error }.
export function initKillerState(playerIds, format, startingLives) {
  if (!KILLER_TYPES.includes(format)) return { ok: false, error: `Unknown killer format: ${format}` };
  if (!Number.isInteger(startingLives) || startingLives < 1) {
    return { ok: false, error: 'Starting lives must be a whole number of 1 or more' };
  }
  const ids = [...new Set(playerIds)];
  if (ids.length < 2) return { ok: false, error: 'A killer game needs at least 2 players' };
  if (format === CARDS_KILLER && ids.length > CARDS_KILLER_MAX_PLAYERS) {
    return { ok: false, error: `Cards Killer supports at most ${CARDS_KILLER_MAX_PLAYERS} players (one number per card, up to King) - you have ${ids.length}` };
  }

  const order = shuffle(ids);
  const lives = Object.fromEntries(order.map((id) => [id, startingLives]));

  const state = {
    status: 'in_progress',
    format,
    startingLives,
    order,
    lives,
    currentPlayerId: null,
    isBreakShot: true,
    rackNumber: 1,
    deck: format === CARDS_KILLER ? [] : undefined,
    finishOrder: [],
    winnerId: null,
    log: [],
    history: [],
  };
  pushLog(state, { type: 'game_started', detail: `${order.length} player(s), ${startingLives} lives each` });
  advanceTurn(state, format); // sets currentPlayerId (draws the first card for Cards Killer)
  pushLog(state, { type: 'turn', playerId: state.currentPlayerId, detail: 'Breaks off' });
  return { ok: true, state };
}

// outcome: 'break_miss' (only legal while isBreakShot - nothing potted on
// the break, no life lost, same player goes again), 'missed' (or white
// potted/off the table - loses a life), or 'potted' (life kept). Pass
// { lastBall: true } alongside 'potted' when that shot cleared the table, so
// the next player's shot is flagged as a fresh break.
export function recordShot(state, outcome, { lastBall = false } = {}) {
  if (!state || state.status !== 'in_progress') {
    return { ok: false, error: 'This killer game is not in progress.' };
  }
  if (!['break_miss', 'missed', 'potted'].includes(outcome)) {
    return { ok: false, error: `Unknown shot outcome: ${outcome}` };
  }
  const format = state.format;
  const current = state.currentPlayerId;
  const working = snapshot(state);
  working.history = [...(state.history || []), snapshot(state)].slice(-MAX_UNDO_HISTORY);

  if (outcome === 'break_miss') {
    if (!working.isBreakShot) {
      return { ok: false, error: 'Nothing on the break only applies to the first shot of a rack - use "Missed" instead.' };
    }
    working.isBreakShot = false; // same player again, but it's a normal shot now
    pushLog(working, { type: 'break_miss', playerId: current, detail: 'Nothing on the break - no life lost, shoots again' });
    return { ok: true, state: working };
  }

  if (outcome === 'missed') {
    if (working.isBreakShot) {
      return { ok: false, error: 'Nothing went in on the break shot - use "Nothing on break" instead; the first attempt doesn\'t cost a life.' };
    }
    working.lives[current] = Math.max(0, (working.lives[current] || 0) - 1);
    pushLog(working, { type: 'life_lost', playerId: current, detail: `Lost a life - ${working.lives[current]} left` });

    if (working.lives[current] <= 0) {
      const stillActive = activePlayerIds(working);
      const place = stillActive.length + 1;
      working.finishOrder = [...working.finishOrder, { playerId: current, place }];
      pushLog(working, { type: 'eliminated', playerId: current, detail: `Eliminated (finished ${place === 2 ? 'runner-up' : `${place}${ordinalSuffix(place)}`})` });

      if (stillActive.length <= 1) {
        working.status = 'finished';
        working.winnerId = stillActive[0] || null;
        working.currentPlayerId = null;
        working.isBreakShot = false;
        if (working.winnerId) pushLog(working, { type: 'game_finished', playerId: working.winnerId, detail: 'Wins the pot' });
        return { ok: true, state: working };
      }
    }
    advanceTurn(working, format);
    pushLog(working, { type: 'turn', playerId: working.currentPlayerId, detail: working.isBreakShot ? 'Breaks off' : 'To play' });
    return { ok: true, state: working };
  }

  // outcome === 'potted'
  pushLog(working, { type: 'potted', playerId: current, detail: lastBall ? 'Potted the last ball - re-rack' : 'Potted - safe' });
  if (lastBall) {
    working.rackNumber += 1;
    pushLog(working, { type: 'rerack', detail: `Rack ${working.rackNumber}` });
  }
  advanceTurn(working, format);
  working.isBreakShot = !!lastBall;
  pushLog(working, { type: 'turn', playerId: working.currentPlayerId, detail: working.isBreakShot ? 'Breaks off' : 'To play' });
  return { ok: true, state: working };
}

export function undoLastShot(state) {
  if (!state || !Array.isArray(state.history) || state.history.length === 0) {
    return { ok: false, error: 'Nothing to undo.' };
  }
  const prev = state.history[state.history.length - 1];
  return { ok: true, state: { ...prev, history: state.history.slice(0, -1) } };
}

function ordinalSuffix(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}
