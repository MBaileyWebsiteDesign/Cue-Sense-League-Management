// Pool Academy profile routes (added 2026-10-26). See services/poolAcademy.js for
// what is stored and why.
//
// Players write only to their OWN account. Their totals live on the user record
// (user.academy); the FULL history is an append-only file of events in DATA_DIR
// (the Fly volume), one JSON object per line, kept outside db.json. NOTE: that file
// is not part of the admin "backup export", which only covers db.json.
//
// Paywall: Level 1 is free. Events for Levels 2-5 (and the Level 2 practice
// challenge) are refused, and their progress is not served, until an Overall Admin
// switches Levels 2-5 on for the account (Admin Portal > Pool Academy).
import { appendFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  FREE_LEVEL,
  MAX_BATCH,
  academyPaid,
  academyView,
  applyEvent,
  ensureAcademy,
  ensureAcademyAccess,
  eventLevel,
  rebuildFromEvents,
  validateEvent,
} from '../services/poolAcademy.js';

export function registerPoolAcademyRoutes(app, { requireAuth, requireAdmin, asyncRoute, ApiError, readDb, writeDb, recordAudit, DATA_DIR }) {
  const EVENTS_FILE = path.join(DATA_DIR, 'academy-events.jsonl');

  let idIndex = null;
  function loadAll() {
    if (!existsSync(EVENTS_FILE)) return [];
    const out = [];
    for (const line of readFileSync(EVENTS_FILE, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
    }
    return out;
  }
  function index() {
    if (!idIndex) {
      idIndex = new Map();
      for (const e of loadAll()) {
        if (!idIndex.has(e.userId)) idIndex.set(e.userId, new Set());
        idIndex.get(e.userId).add(e.id);
      }
    }
    return idIndex;
  }
  const userEvents = (userId) => loadAll().filter((e) => e.userId === userId);

  function requireRealAccount(req) {
    const id = req.auth && req.auth.userId;
    if (!id || String(id).startsWith('apikey:')) throw new ApiError(403, 'Pool Academy progress needs a player account');
  }

  app.get('/api/users/me/academy', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    const user = readDb().users.find((u) => u.id === req.auth.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    res.json(academyView(user));
  }));

  app.get('/api/users/me/academy/events', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    const user = readDb().users.find((u) => u.id === req.auth.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    const paid = academyPaid(user);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    let events = userEvents(req.auth.userId).filter((e) => paid || eventLevel(e) === FREE_LEVEL);
    if (type) events = events.filter((e) => e.type === type);
    if (before) events = events.filter((e) => e.at < before);
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    res.json({ total: events.length, events: events.slice(0, limit).map(({ userId, ...rest }) => rest) });
  }));

  app.post('/api/users/me/academy/events', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    const raw = req.body && req.body.events;
    if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, 'events must be a non-empty list');
    if (raw.length > MAX_BATCH) throw new ApiError(400, `Send at most ${MAX_BATCH} events at a time`);

    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    const paid = academyPaid(user);
    const a = ensureAcademy(user);
    const seen = index();
    if (!seen.has(user.id)) seen.set(user.id, new Set());
    const mine = seen.get(user.id);

    const results = [];
    const accepted = [];
    const now = Date.now();
    for (const item of raw) {
      const id = item && typeof item === 'object' ? item.id : undefined;
      const checked = validateEvent(item, now);
      if (!checked.ok) { results.push({ id: id ?? null, status: 'rejected', error: checked.error }); continue; }
      const event = checked.event;
      if (!paid && eventLevel(event) > FREE_LEVEL) {
        results.push({ id: event.id, status: 'rejected', error: 'Levels 2 and up are not switched on for this account' });
        continue;
      }
      if (mine.has(event.id)) { results.push({ id: event.id, status: 'duplicate' }); continue; }
      mine.add(event.id);
      accepted.push(event);
      results.push({ id: event.id, status: 'applied' });
    }

    if (accepted.length > 0) {
      const receivedAt = new Date(now).toISOString();
      // Log first, then update the totals: if the totals update ever failed, the
      // log still has the event and POST .../rebuild (admin) recomputes them.
      appendFileSync(EVENTS_FILE, accepted.map((e) => JSON.stringify({ userId: user.id, ...e, receivedAt })).join('\n') + '\n');
      for (const event of accepted) {
        const outcome = applyEvent(a, event);
        if (!outcome.applied) {
          const r = results.find((x) => x.id === event.id);
          if (r) { r.status = 'logged'; r.note = outcome.reason; }
        }
      }
      a.lastSyncAt = receivedAt;
      writeDb(db);
    }
    res.json({ results, ...academyView(user) });
  }));

  // ---------- Admin: who has Levels 2-5 (Admin Portal > Pool Academy) ----------
  const adminName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.replace(/\s+/g, ' ').trim() || u.email;
  const accessRow = (u) => {
    const access = ensureAcademyAccess(u);
    return {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      status: u.status,
      paid: access.paid,
      since: access.since,
      changedAt: access.changedAt,
      changedBy: access.changedBy,
      eventCount: (u.academy && u.academy.eventCount) || 0,
      lastActiveAt: (u.academy && u.academy.lastActiveAt) || null,
      lessonsCompleted: u.academy && u.academy.lessons ? Object.keys(u.academy.lessons).length : 0,
      highestLevel: (u.academy && u.academy.highestLevel) || 0,
    };
  };

  app.get('/api/admin/academy/users', requireAdmin, asyncRoute((req, res) => {
    const rows = readDb().users.map(accessRow).sort((a, b) => adminName(a).localeCompare(adminName(b)));
    res.json({ total: rows.length, paid: rows.filter((r) => r.paid).length, users: rows });
  }));

  app.post('/api/admin/users/:id/academy-access', requireAdmin, asyncRoute((req, res) => {
    const paid = req.body && req.body.paid;
    if (typeof paid !== 'boolean') throw new ApiError(400, 'paid must be true or false');
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    const access = ensureAcademyAccess(user);
    if (access.paid !== paid) {
      const now = new Date().toISOString();
      if (paid) access.since = now;
      access.paid = paid;
      access.changedAt = now;
      access.changedBy = adminName(req.auth.user);
      recordAudit(db, {
        actor: adminName(req.auth.user),
        action: 'user.academyAccess',
        targetType: 'user',
        targetId: user.id,
        details: `Pool Academy Levels 2-5 switched ${paid ? 'on' : 'off'} for ${adminName(user)}`,
      });
      writeDb(db);
    }
    res.json(accessRow(user));
  }));

  // Admin recovery: recompute a player's totals from their stored events.
  app.post('/api/admin/users/:id/academy/rebuild', requireAdmin, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    const old = ensureAcademy(user);
    const events = userEvents(user.id);
    const fresh = rebuildFromEvents(events);
    fresh.lastSyncAt = old.lastSyncAt;
    user.academy = fresh;
    writeDb(db);
    res.json({ rebuiltFrom: events.length, academy: fresh });
  }));
}
