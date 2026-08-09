// Single, unified account model. There used to be two separate login flows
// (one hardcoded super-admin account, one self-registered "player" account) -
// now there is exactly one kind of account (`db.users`), and `isAdmin` /
// `isCaptain` are just boolean flags on it rather than a separate identity.
// Anyone can log in with the same form; what they can see/do depends on
// their flags, checked fresh on every request (so promoting, demoting or
// suspending someone takes effect immediately, without them needing to log
// back in).
//
// Passwords are hashed with Node's built-in `crypto.scrypt` (salted,
// per-user) - no bcrypt dependency needed. Session tokens are a hand-rolled
// HMAC-signed payload (HMAC-SHA256 via Node's built-in `crypto`), which is
// fine for a v1 with a single trusted deployment but should be swapped for a
// real session/JWT library before this is exposed at real scale - see the
// README roadmap.
import crypto from 'crypto';
import { ApiError } from './errors.js';
import { readDb, writeDb } from './db.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const candidateBuf = Buffer.from(candidate, 'hex');
  const hashBuf = Buffer.from(hash, 'hex');
  return candidateBuf.length === hashBuf.length && crypto.timingSafeEqual(candidateBuf, hashBuf);
}

// Generates a short, human-typeable random password - used when an admin
// creates an account on someone else's behalf (season CSV/Excel import, or
// the wizard's "add a player manually" step) since there's no email
// verification flow to let the player set their own. The plaintext is
// returned to the admin once, in the API response, so they can hand it to
// the player directly; only the hash is ever persisted.
export function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url'); // ~8 chars, url-safe
}

export function createSessionToken(userId) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `user.${userId}.${expiresAt}`;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = sign(payload);
  return { token: `${payloadB64}.${signature}`, expiresAt };
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, signature] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  const expectedSignature = sign(payload);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== 'user') return null;
  const [, userId, expiresAtStr] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null;
  return { userId, expiresAt };
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function tokenFromHeader(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

// API keys (StreamDeck / other unattended integrations): a permanent,
// admin-equivalent credential rather than a 24h session, meant to sit in a
// StreamDeck plugin's HTTP request config - see the Admin Portal's "API
// Keys" page (generate, label, revoke). Only the SHA-256 hash is ever
// persisted; the raw value is shown to the admin exactly once, at creation.
export function generateApiKeyValue() {
  return `sdk_${crypto.randomBytes(36).toString('base64url')}`;
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// A valid key is synthesized into the same shape loadActiveUser() would
// return for a real account, so requireAuth/requireAdmin below need no
// changes at all - every existing authenticated/admin route already works
// for a StreamDeck key with zero further wiring.
function loadApiKeyUser(token) {
  if (!token || !token.startsWith('sdk_')) return null;
  const db = readDb();
  const hash = hashApiKey(token);
  const apiKey = db.apiKeys.find((k) => k.hash === hash);
  if (!apiKey) return null;
  apiKey.lastUsedAt = new Date().toISOString();
  writeDb(db);
  return {
    id: `apikey:${apiKey.id}`,
    firstName: 'API Key',
    lastName: apiKey.label,
    email: null,
    isAdmin: true,
    isCaptain: false,
    status: 'active',
    playerId: null,
  };
}

// Looks up the live user record behind a verified token - flags and
// suspension status can change after a token was issued (an admin can
// change them mid-session), so both are always read fresh from the db
// rather than trusted from the token payload. Falls back to API key auth
// (see loadApiKeyUser above) for anything that isn't a valid session token -
// a raw API key (no embedded '.') fails verifySessionToken's format check
// immediately, so there's no ambiguity between the two credential kinds.
function loadActiveUser(token) {
  const session = verifySessionToken(token);
  if (session) {
    const db = readDb();
    const user = db.users.find((u) => u.id === session.userId);
    if (user) return user;
  }
  return loadApiKeyUser(token);
}

// Standard "you must be logged in" gate - used both for the self-service
// /users/me routes and for viewing the site at all (leagues, divisions,
// fixtures, player profiles). Every account is the same kind of thing now,
// so there's no separate "player vs admin" check here - see requireAdmin
// below for the extra check admin-only routes add on top of this.
export function requireAuth(req, res, next) {
  const user = loadActiveUser(tokenFromHeader(req));
  if (!user) {
    throw new ApiError(401, 'Login required for this action');
  }
  if (user.status === 'suspended') {
    throw new ApiError(403, 'This account has been suspended');
  }
  req.auth = { userId: user.id, user };
  next();
}

// Admin panel / admin-only-action gate: requires being logged in AND having
// `isAdmin: true`. Any account can be flagged as admin (see
// POST /api/admin/users/:id/permissions) - there's no tiered admin
// permission model in this v1, every admin can do everything, including
// managing other admins and their own account.
export function requireAdmin(req, res, next) {
  const user = loadActiveUser(tokenFromHeader(req));
  if (!user || user.status === 'suspended') {
    throw new ApiError(401, 'Login required for this action');
  }
  if (!user.isAdmin) {
    throw new ApiError(403, 'Admin access required');
  }
  req.auth = { userId: user.id, user };
  req.adminSession = { label: `${user.firstName} ${user.lastName}` };
  next();
}

// League Manager gate: lets an Overall Admin OR a League Manager through the
// door (both get req.adminSession set the same way, since both can perform
// admin-shaped actions like recordAudit calls). This alone does NOT check
// which league is being touched - every route using this middleware must
// also call assertLeagueAccess(req, league) once it has resolved the
// specific league the request targets, so a League Manager can't reach a
// league they haven't been assigned to just by knowing its ID.
export function requireAnyAdmin(req, res, next) {
  const user = loadActiveUser(tokenFromHeader(req));
  if (!user || user.status === 'suspended') {
    throw new ApiError(401, 'Login required for this action');
  }
  if (!user.isAdmin && !user.isLeagueManager) {
    throw new ApiError(403, 'Admin or League Manager access required');
  }
  req.auth = { userId: user.id, user };
  req.adminSession = { label: `${user.firstName} ${user.lastName}` };
  next();
}

// Call after requireAnyAdmin, once the target league is known - an Overall
// Admin (isAdmin) always passes; a League Manager only passes for a league
// whose managerUserIds includes their own user id (assigned by an Overall
// Admin via POST /api/leagues/:id/managers - League Managers can never
// assign themselves). Also gates DELETE /api/leagues/:id and
// DELETE /api/divisions/:id - a League Manager can delete a league (or a
// division within it) they manage, the same as an Overall Admin.
export function assertLeagueAccess(req, league) {
  const user = req.auth && req.auth.user;
  if (!user) throw new ApiError(401, 'Login required for this action');
  if (user.isAdmin) return;
  if (
    user.isLeagueManager &&
    league &&
    Array.isArray(league.managerUserIds) &&
    league.managerUserIds.includes(user.id)
  ) {
    return;
  }
  throw new ApiError(403, "You don't have manager access to this league");
}
