// Marketing review (Matt, 2026-10-17): a Venue Manager sub-page where the venue's
// Venue Manager sees the Marketing Agent items copied from Wix and records
// Approve / Dismiss. Recording a decision here does NOT publish anything - Wix has
// no API for these items, so publishing is still done in the Wix Marketing Agent.
//
// Access: the venue's own Venue Manager only, and only for a venue with the
// "Marketing review" tickbox on (set by an Overall Admin in Venue Management ->
// Venue settings). Bar Staff are not in BAR_STAFF_ROUTES so cannot reach these, and
// they are refused again here. Overall Admins are deliberately refused too.
import { MARKETING_SEEDS } from '../data/marketingSeeds.js';
import { recordAudit } from '../services/auditLog.js';

const CONTENT_KEYS = ['kind', 'channel', 'format', 'title', 'body', 'truncated', 'scheduledFor', 'wixStatus', 'source', 'copiedAt', 'venueId', 'inWix'];

export function applyMarketingSeeds({ readDb, writeDb }) {
  const db = readDb();
  if (!Array.isArray(db.marketingItems)) db.marketingItems = [];
  let changed = false;
  for (const seed of MARKETING_SEEDS) {
    const prefix = seed.venueNamePrefix.toLowerCase();
    const venue = (db.venues || []).find((v) => typeof v.name === 'string' && v.name.toLowerCase().startsWith(prefix));
    if (!venue) continue;
    // First time only: an Overall Admin unticking it later is respected (false is kept).
    if (venue.marketingReviewEnabled === undefined) { venue.marketingReviewEnabled = true; changed = true; }
    const seen = new Set();
    for (const it of seed.items) {
      const id = `mk_${it.id}_${venue.id}`;
      seen.add(id);
      const content = {
        kind: it.kind, channel: it.channel, format: it.format, title: it.title || '', body: it.body || '',
        truncated: it.truncated === true, scheduledFor: it.scheduledFor, wixStatus: 'Review needed',
        source: seed.source, copiedAt: seed.copiedAt, venueId: venue.id, inWix: true,
      };
      const existing = db.marketingItems.find((x) => x.id === id);
      if (!existing) {
        db.marketingItems.push({ id, ...content, decision: 'pending', decidedBy: null, decidedAt: null });
        changed = true;
      } else if (CONTENT_KEYS.some((k) => existing[k] !== content[k])) {
        Object.assign(existing, content);
        changed = true;
      }
    }
    for (const x of db.marketingItems) {
      if (x.venueId === venue.id && x.source === seed.source && !seen.has(x.id) && x.inWix !== false) { x.inWix = false; changed = true; }
    }
  }
  if (changed) writeDb(db);
}

export function registerMarketingReviewRoutes(app, { requireAdmin, requireVenueManager, assertVenueAccess, ApiError, asyncRoute, readDb, writeDb }) {
  try { applyMarketingSeeds({ readDb, writeDb }); } catch (err) { console.error('Marketing review seed failed:', err); }

  function managerOnly(req, venueId) {
    const user = req.auth && req.auth.user;
    if (!user) throw new ApiError(401, 'Login required for this action');
    if (req.barStaffMode || user.isAdmin || !user.isVenueManager) {
      throw new ApiError(403, "Marketing review is for the venue's own Venue Manager");
    }
    const db = readDb();
    const venue = (db.venues || []).find((v) => v.id === venueId);
    if (!venue) throw new ApiError(404, 'Venue not found');
    assertVenueAccess(req, venue);
    if (venue.marketingReviewEnabled !== true) throw new ApiError(403, 'Marketing review is not switched on for this venue');
    return { db, venue, user };
  }

  const publicItem = (x) => ({
    id: x.id, kind: x.kind, channel: x.channel, format: x.format, title: x.title, body: x.body,
    truncated: x.truncated === true, scheduledFor: x.scheduledFor, wixStatus: x.wixStatus,
    decision: x.decision, decidedBy: x.decidedBy || null, decidedAt: x.decidedAt || null,
  });

  app.get('/api/venue-manager/marketing-review', requireVenueManager, asyncRoute((req, res) => {
    const venueId = String(req.query.venueId || '');
    const { db, venue } = managerOnly(req, venueId);
    const items = (db.marketingItems || [])
      .filter((x) => x.venueId === venue.id && x.inWix !== false)
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor) || String(a.channel).localeCompare(String(b.channel)))
      .map(publicItem);
    const seed = MARKETING_SEEDS.find((s) => venue.name.toLowerCase().startsWith(s.venueNamePrefix.toLowerCase()));
    res.json({
      venue: { id: venue.id, name: venue.name },
      source: seed ? seed.source : null,
      copiedAt: seed ? seed.copiedAt : null,
      wixUrl: seed ? seed.wixUrl : null,
      items,
    });
  }));

  app.post('/api/venue-manager/marketing-review/items/:id/decision', requireVenueManager, asyncRoute((req, res) => {
    const decision = req.body && req.body.decision;
    if (!['pending', 'approved', 'dismissed'].includes(decision)) throw new ApiError(400, 'decision must be pending, approved or dismissed');
    const found = (readDb().marketingItems || []).find((x) => x.id === req.params.id && x.inWix !== false);
    if (!found) throw new ApiError(404, 'Item not found');
    const { db, user } = managerOnly(req, found.venueId);
    const item = db.marketingItems.find((x) => x.id === found.id);
    const by = `${user.firstName} ${user.lastName}`;
    item.decision = decision;
    item.decidedBy = decision === 'pending' ? null : by;
    item.decidedAt = decision === 'pending' ? null : new Date().toISOString();
    recordAudit(db, {
      actor: by,
      action: 'marketing.decision',
      targetType: 'marketing_item',
      targetId: item.id,
      details: `Marked ${item.channel} ${item.format} "${(item.title || item.body || '').slice(0, 60)}" as ${decision} in Marketing review`,
    });
    writeDb(db);
    res.json(publicItem(item));
  }));

  // Overall Admin switch (Venue Management -> Venue settings). Turning it on does
  // not give the admin the page - only the venue's own Venue Manager sees it.
  app.post('/api/venues/:id/marketing-review', requireAdmin, asyncRoute((req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false');
    const db = readDb();
    const venue = db.venues.find((v) => v.id === req.params.id);
    if (!venue) throw new ApiError(404, 'Venue not found');
    if ((venue.marketingReviewEnabled === true) !== enabled) {
      venue.marketingReviewEnabled = enabled;
      recordAudit(db, {
        actor: req.adminSession.label,
        action: 'venue.marketing_review',
        targetType: 'venue',
        targetId: venue.id,
        details: `${enabled ? 'Turned on' : 'Turned off'} Marketing review for "${venue.name}"`,
      });
      writeDb(db);
    }
    res.json({ marketingReviewEnabled: venue.marketingReviewEnabled === true });
  }));
}
