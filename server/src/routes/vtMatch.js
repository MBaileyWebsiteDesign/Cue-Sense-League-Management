// Two-phone matches for the Virtual Training app (added 2026-10-28).
//
// A match is a small "room" that two phones share. Player 1 creates it and gets a short code; player 2 joins
// with the code. The phones then pass messages through the room: aim updates, a shot (so the other phone can
// watch it), and the table state after each shot. The server does NOT run the game: whoever is shooting runs the
// physics on their phone and sends the result, and the other phone adopts it. The server only keeps the rooms,
// numbers the messages, and checks that a message comes from a player in the room.
//
// Guests can play: no account is needed, a player is identified by a secret token the server hands them when
// they create or join. The display name is whatever the phone sends and is NOT verified (it is not tied to a
// login). Rooms live in memory only: a server restart or deploy ends every match in progress, and a room is
// dropped after ROOM_IDLE_MS with no traffic. Messages are not cheat-proof (a modified phone could send a
// false result), which is accepted for friendly matches; see docs in the Virtual Training repo.
import crypto from 'crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_LENGTH = 5;
export const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
export const MAX_ROOMS = 500;
export const MAX_EVENTS_KEPT = 200;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_BATCH = 20;
/** A phone that has not been heard from for this long shows as offline to the other player. */
export const ONLINE_MS = 15 * 1000;
/** At most this many messages from one player in RATE_WINDOW_MS. */
export const RATE_LIMIT = 80;
export const RATE_WINDOW_MS = 10 * 1000;
export const EVENT_TYPES = ['aim', 'shot', 'state', 'leave'];

const cleanName = (v, fallback) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) : '';
  return s || fallback;
};

export function registerVtMatchRoutes(app, { asyncRoute, ApiError, now = () => Date.now() }) {
  /** code -> room */
  const rooms = new Map();

  function newCode() {
    for (let tries = 0; tries < 50; tries += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    throw new ApiError(503, 'Could not make a match code, try again');
  }

  function sweep() {
    const t = now();
    for (const [code, room] of rooms) if (t - room.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }

  function sameToken(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  }

  function findRoom(req) {
    const code = String(req.params.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) throw new ApiError(404, 'Match not found. Check the code, or the match may have ended.');
    return room;
  }

  function seatOf(room, req) {
    const token = req.headers && (req.headers['x-match-token'] || req.headers['X-Match-Token']);
    const seat = room.seats.findIndex((s) => s && sameToken(s.token, token));
    if (seat < 0) throw new ApiError(401, 'You are not a player in this match');
    return seat;
  }

  const view = (room) => ({
    code: room.code,
    seq: room.seq,
    seats: [0, 1].map((i) => {
      const s = room.seats[i];
      return s ? { name: s.name, online: now() - s.lastSeen < ONLINE_MS, left: s.left } : null;
    }),
  });

  app.post('/api/vt-match', asyncRoute((req, res) => {
    sweep();
    if (rooms.size >= MAX_ROOMS) throw new ApiError(503, 'Too many matches at the moment, try again soon');
    const t = now();
    const code = newCode();
    const token = crypto.randomBytes(16).toString('hex');
    const room = {
      code, seq: 0, events: [], lastState: null, created: t, lastActive: t,
      seats: [{ token, name: cleanName(req.body && req.body.name, 'Player 1'), lastSeen: t, left: false, sent: [] }, null],
    };
    rooms.set(code, room);
    res.status(201).json({ ...view(room), token, seat: 0 });
  }));

  app.post('/api/vt-match/:code/join', asyncRoute((req, res) => {
    const room = findRoom(req);
    if (room.seats[1]) throw new ApiError(409, 'This match already has two players');
    const t = now();
    const token = crypto.randomBytes(16).toString('hex');
    room.seats[1] = { token, name: cleanName(req.body && req.body.name, 'Player 2'), lastSeen: t, left: false, sent: [] };
    room.lastActive = t;
    res.status(201).json({ ...view(room), token, seat: 1 });
  }));

  // Poll: everything after `since`. Also marks this player as online.
  app.get('/api/vt-match/:code', asyncRoute((req, res) => {
    const room = findRoom(req);
    const seat = seatOf(room, req);
    const t = now();
    room.seats[seat].lastSeen = t;
    room.lastActive = t;
    const since = Math.max(parseInt(req.query && req.query.since, 10) || 0, 0);
    // lastState: the newest full table state, handed out on a first poll (since = 0) so a phone that reloaded
    // can pick the match up again even if that message has already been pushed out of the recent list.
    res.json({ ...view(room), seat, events: room.events.filter((e) => e.seq > since), lastState: since === 0 ? room.lastState : null });
  }));

  app.post('/api/vt-match/:code/events', asyncRoute((req, res) => {
    const room = findRoom(req);
    const seat = seatOf(room, req);
    const raw = req.body && req.body.events;
    if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, 'events must be a non-empty list');
    if (raw.length > MAX_BATCH) throw new ApiError(400, `Send at most ${MAX_BATCH} messages at a time`);
    const t = now();
    const me = room.seats[seat];
    me.sent = me.sent.filter((x) => t - x < RATE_WINDOW_MS);
    if (me.sent.length + raw.length > RATE_LIMIT) throw new ApiError(429, 'Slow down: too many messages');
    for (const item of raw) {
      if (!item || typeof item !== 'object' || !EVENT_TYPES.includes(item.type)) throw new ApiError(400, `type must be one of: ${EVENT_TYPES.join(', ')}`);
      if (item.data === undefined || item.data === null || typeof item.data !== 'object' || Array.isArray(item.data)) throw new ApiError(400, 'data must be an object');
      if (JSON.stringify(item.data).length > MAX_EVENT_BYTES) throw new ApiError(413, 'Message too large');
    }
    for (const item of raw) {
      room.seq += 1;
      const event = { seq: room.seq, seat, type: item.type, data: item.data, at: new Date(t).toISOString() };
      // Only the newest aim from a player matters, so older ones are dropped instead of piling up.
      if (item.type === 'aim') room.events = room.events.filter((e) => !(e.type === 'aim' && e.seat === seat));
      if (item.type === 'state') room.lastState = event;
      room.events.push(event);
      me.sent.push(t);
      if (item.type === 'leave') me.left = true;
    }
    if (room.events.length > MAX_EVENTS_KEPT) room.events.splice(0, room.events.length - MAX_EVENTS_KEPT);
    me.lastSeen = t;
    room.lastActive = t;
    res.json({ seq: room.seq });
  }));

  return { rooms };
}
