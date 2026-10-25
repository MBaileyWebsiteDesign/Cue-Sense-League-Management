// Virtual Training profile routes (added 2026-10-25). See
// services/virtualTraining.js for what is stored and why.
//
// Players write only to their OWN account. Their totals live on the user record
// (user.virtualTraining, returned by GET /api/users/me and to admins like the
// rest of the account). The FULL history is an append-only file of events in
// DATA_DIR (the Fly volume), one JSON object per line, kept outside db.json so
// the main data file (which is re-read and cloned on every request) does not
// grow with every shot played. NOTE: that file is not part of the admin
// "backup export", which only covers db.json.
import { appendFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  MAX_BATCH,
  applyEvent,
  ensureVirtualTraining,
  ensureVtAccess,
  rebuildFromEvents,
  validateEvent,
  vtPaid,
} from '../services/virtualTraining.js';

export function registerVirtualTrainingRoutes(app, { requireAuth, requireAdmin, asyncRoute, ApiError, readDb, writeDb, recordAudit, DATA_DIR }) {
  const EVENTS_FILE = path.join(DATA_DIR, 'virtual-training-events.jsonl');

  // userId -> Set of event ids already stored, built from the file on first use.
  let idIndex = null;
  function loadAll() {
    if (!existsSync(EVENTS_FILE)) return [];
    const lines = readFileSync(EVENTS_FILE, 'utf-8').split('\n');
    const out = [];
    for (const line of lines) {
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
  function userEvents(userId) {
    return loadAll().filter((e) => e.userId === userId);
  }

  function requireRealAccount(req) {
    const id = req.auth && req.auth.userId;
    if (!id || String(id).startsWith('apikey:')) {
      throw new ApiError(403, 'Virtual Training stats need a player account');
    }
  }

  // Paywall: an account that has not been switched on gets nothing back, and
  // nothing can be recorded for it. Stored data is kept, just not served.
  function requirePaid(user) {
    if (!vtPaid(user)) throw new ApiError(403, 'Virtual Training is not switched on for this account');
  }

  app.get('/api/users/me/virtual-training', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    const user = readDb().users.find((u) => u.id === req.auth.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    if (!vtPaid(user)) { res.json({ locked: true }); return; }
    res.json({ locked: false, virtualTraining: ensureVirtualTraining(user) });
  }));

  app.get('/api/users/me/virtual-training/events', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    requirePaid(readDb().users.find((u) => u.id === req.auth.userId));
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const type = typeof req.query.type === 'string' ? req.query.type : null;
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    let events = userEvents(req.auth.userId);
    if (type) events = events.filter((e) => e.type === type);
    if (before) events = events.filter((e) => e.at < before);
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    res.json({
      total: events.length,
      events: events.slice(0, limit).map(({ userId, ...rest }) => rest),
    });
  }));

  app.post('/api/users/me/virtual-training/events', requireAuth, asyncRoute((req, res) => {
    requireRealAccount(req);
    const raw = req.body && req.body.events;
    if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, 'events must be a non-empty list');
    if (raw.length > MAX_BATCH) throw new ApiError(400, `Send at most ${MAX_BATCH} events at a time`);

    const db = readDb();
    const user = db.users.find((u) => u.id === req.auth.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    requirePaid(user);
    const vt = ensureVirtualTraining(user);
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
      if (mine.has(event.id)) { results.push({ id: event.id, status: 'duplicate' }); continue; }
      mine.add(event.id);
      accepted.push(event);
      results.push({ id: event.id, status: 'applied' });
    }

    if (accepted.length > 0) {
      const receivedAt = new Date(now).toISOString();
      // Log first, then update the totals: if the totals update ever failed, the
      // log still has the event and POST .../rebuild (admin) recomputes them.
      appendFileSync(
        EVENTS_FILE,
        accepted.map((e) => JSON.stringify({ userId: user.id, ...e, receivedAt })).join('\n') + '\n',
      );
      for (const event of accepted) applyEvent(vt, event);
      vt.lastSyncAt = receivedAt;
      writeDb(db);
    }
    res.json({ results, virtualTraining: vt });
  }));

  // ---------- Admin: who has paid (Admin Portal > Virtual Training) ----------
  const adminName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.replace(/\s+/g, ' ').trim() || u.email;
  const accessRow = (u) => {
    const access = ensureVtAccess(u);
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
      eventCount: (u.virtualTraining && u.virtualTraining.eventCount) || 0,
      lastPlayedAt: (u.virtualTraining && u.virtualTraining.lastPlayedAt) || null,
    };
  };

  app.get('/api/admin/virtual-training/users', requireAdmin, asyncRoute((req, res) => {
    const rows = readDb().users.map(accessRow)
      .sort((a, b) => adminName(a).localeCompare(adminName(b)));
    res.json({ total: rows.length, paid: rows.filter((r) => r.paid).length, users: rows });
  }));

  app.post('/api/admin/users/:id/virtual-training-access', requireAdmin, asyncRoute((req, res) => {
    const paid = req.body && req.body.paid;
    if (typeof paid !== 'boolean') throw new ApiError(400, 'paid must be true or false');
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    const access = ensureVtAccess(user);
    if (access.paid !== paid) {
      const now = new Date().toISOString();
      if (paid) access.since = now;
      access.paid = paid;
      access.changedAt = now;
      access.changedBy = adminName(req.auth.user);
      recordAudit(db, {
        actor: adminName(req.auth.user),
        action: 'user.virtualTrainingAccess',
        targetType: 'user',
        targetId: user.id,
        details: `Virtual Training switched ${paid ? 'on' : 'off'} for ${adminName(user)}`,
      });
      writeDb(db);
    }
    res.json(accessRow(user));
  }));

  // Admin recovery: recompute a player's totals from their stored events.
  app.post('/api/admin/users/:id/virtual-training/rebuild', requireAdmin, asyncRoute((req, res) => {
    const db = readDb();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    const old = ensureVirtualTraining(user);
    const events = userEvents(user.id);
    const fresh = rebuildFromEvents(events);
    fresh.lastSyncAt = old.lastSyncAt;
    fresh.lastDevice = old.lastDevice;
    user.virtualTraining = fresh;
    writeDb(db);
    res.json({ rebuiltFrom: events.length, virtualTraining: fresh });
  }));
}
