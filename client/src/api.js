import { getStoredToken } from './AuthContext.jsx';
import { demoApi } from './demo/demoApi.js';

// Static demo build (see vite.config.js / README "Deployment note"): with no
// server to talk to on GitHub Pages, every method below is swapped for an
// in-memory equivalent that runs the same logic against the bundled seed
// data instead of making a real request - see client/src/demo/demoApi.js.
// `VITE_DEMO_MODE` is only ever 'true' for the `npm run build:demo` build;
// a normal `npm run build`/`npm run dev` always uses the real network api.
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

const BASE = '/api';

async function request(path, options = {}) {
  const token = getStoredToken();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    });
  } catch (err) {
    // fetch() itself throws for network-level failures (offline, DNS,
    // dropped connection, CORS) - the request never reached the server at
    // all. Tagged so callers like the scoring retry queue (scoringQueue.js)
    // can tell "definitely didn't get through" apart from a definite
    // rejection the server sent back (see the status tag below).
    const networkErr = new Error('Network error - request did not reach the server');
    networkErr.isNetworkError = true;
    networkErr.cause = err;
    throw networkErr;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const networkApi = {
  // Single unified login for every account (admin, player, captain - any
  // combination of flags on the same account).
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (data) =>
    request('/users/register', { method: 'POST', body: JSON.stringify(data) }),
  // Public - consumes an admin-generated password reset link (see
  // adminSendResetLink below).
  // Public - asks for a reset link to be emailed to the given address. The
  // server always answers the same generic message (no account enumeration).
  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token, newPassword) =>
    request(`/auth/reset-password/${token}`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  getMe: () => request('/users/me'),
  updateMe: (data) => request('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),
  changePassword: (currentPassword, newPassword) =>
    request('/users/me/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  getMyFixtures: () => request('/users/me/fixtures'),
  getMyPendingConfirmations: () => request('/users/me/pending-confirmations'),
  getMyLeagueMembership: () => request('/users/me/leagues'),

  // Admin: user management
  adminListUsers: (q = '') => request(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminGetUser: (id) => request(`/admin/users/${id}`),
  adminUpdateUser: (id, data) => request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminSetPermissions: (id, permissions) =>
    request(`/admin/users/${id}/permissions`, { method: 'POST', body: JSON.stringify(permissions) }),
  adminSetStatus: (id, status) => request(`/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  adminResetPassword: (id, newPassword) =>
    request(`/admin/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  adminSendResetLink: (id) => request(`/admin/users/${id}/send-reset-link`, { method: 'POST' }),
  // Accounts with any league/match history are skipped server-side rather
  // than deleted - see userInUse in server/src/index.js. Response is
  // { deleted: [...], blocked: [...] } so the UI can report both.
  adminBulkDeleteUsers: (userIds) => request('/admin/users/bulk-delete', { method: 'POST', body: JSON.stringify({ userIds }) }),
  adminGetUserByPlayer: (playerId) => request(`/admin/users/by-player/${playerId}`),
  adminImportUsers: (rows) => request('/admin/users/import', { method: 'POST', body: JSON.stringify({ rows }) }),
  adminGetAuditLog: () => request('/admin/audit-log'),
  // Membership Management: which Venue this account belongs to - admin-set
  // only (see server/src/index.js's POST /api/admin/users/:id/venue).
  // Venue memberships (a player can belong to several venues, each with
  // optional start/end dates) - admin side.
  adminSetVenueMembership: (id, { venueId, startDate = null, renewalDate = null }) =>
    request(`/admin/users/${id}/venue-memberships`, {
      method: 'POST',
      body: JSON.stringify({ venueId, startDate, renewalDate }),
    }),
  adminRemoveVenueMembership: (id, venueId) =>
    request(`/admin/users/${id}/venue-memberships/${encodeURIComponent(venueId)}`, { method: 'DELETE' }),
  // Player self-service: venue names, join a venue, leave a venue.
  listVenuesPublic: () => request('/venues/list'),
  joinMyVenue: (venueId) => request('/users/me/venues', { method: 'POST', body: JSON.stringify({ venueId }) }),
  leaveMyVenue: (venueId) => request(`/users/me/venues/${encodeURIComponent(venueId)}`, { method: 'DELETE' }),
    }),

  // Membership Management: Venues (client/src/pages/MembershipManagement.jsx)
  // - Overall-Admin-only to create/rename/delete a venue and to grant/revoke
  // Venue Manager access, same shape as League Managers on a League.
  getVenues: () => request('/venues'),
  createVenue: (name) => request('/venues', { method: 'POST', body: JSON.stringify({ name }) }),
  renameVenue: (id, name) => request(`/venues/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteVenue: (id) => request(`/venues/${id}`, { method: 'DELETE' }),
  addVenueManager: (venueId, userId) =>
    request(`/venues/${venueId}/managers`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeVenueManager: (venueId, userId) =>
    request(`/venues/${venueId}/managers/${userId}`, { method: 'DELETE' }),

  // Venue Manager Portal (client/src/pages/VenueManagerPortal.jsx).
  getMyManagedVenues: () => request('/venue-manager/venues'),
  getVenueManagerStatus: (venueId) => request(`/venue-manager/status?venueId=${encodeURIComponent(venueId)}`),
  // Today's and future table bookings from the venue's Wix site (read-only;
  // the server syncs from Wix at 09:00, 11:00 and 17:00 UK time).
  // refresh=true asks for an immediate sync (Refresh button; max once a minute).
  getVenueBookings: (venueId, refresh = false) =>
    request(`/venue-manager/bookings?venueId=${encodeURIComponent(venueId)}${refresh ? '&refresh=1' : ''}`),
  // Live updates for the Table bookings card: a Server-Sent Events stream
  // read with fetch (so the login token can go in the Authorization header,
  // which EventSource can't send). Calls onOpen once connected and onUpdate
  // each time the server says the saved bookings changed; resolves when the
  // stream ends and rejects on a network error - the caller reconnects.
  streamVenueBookings: async (venueId, { onUpdate, onOpen, signal } = {}) => {
    const token = getStoredToken();
    const res = await fetch(`${BASE}/venue-manager/bookings/stream?venueId=${encodeURIComponent(venueId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Live updates unavailable (${res.status})`);
    if (onOpen) onOpen();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (/^event: bookings$/m.test(chunk) && onUpdate) onUpdate();
      }
    }
  },
  // Walk-in bookings (Table bookings card): the venue's bookable Wix tables,
  // book one (start = "YYYY-MM-DDTHH:MM" UK time on :00/:30, minutes 60/120/180),
  // and cancel a walk-in made here. Creates/cancels real bookings on Wix.
  getWalkinTables: (venueId) =>
    request(`/venue-manager/walkin-tables?venueId=${encodeURIComponent(venueId)}`),
  // player (optional): { firstName, lastName, email, signUp, membership: '' | '1m' | '12m' }
  bookWalkin: (venueId, tableId, start, minutes, player = {}) =>
    request('/venue-manager/walkins', {
      method: 'POST',
      body: JSON.stringify({ venueId, tableId, start, minutes, ...player }),
    }),
  // Cancels any booking on the venue's Wix site (walk-ins silently; online
  // bookings with Wix's customer cancellation email/SMS).
  cancelWalkin: (venueId, bookingId) =>
    request(`/venue-manager/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ venueId }),
    }),
  // Backs the clickable "Due in N months" stat tiles - months must be 2, 4, or 6.
  getVenueManagerDuePlayers: (venueId, months) =>
    request(`/venue-manager/status/players?venueId=${encodeURIComponent(venueId)}&months=${months}`),
  searchVenuePlayers: (venueId, q = '') =>
    request(`/venue-manager/players?venueId=${encodeURIComponent(venueId)}&q=${encodeURIComponent(q)}`),
  // Quick-renew buttons on Search players' results - months must be 1, 6, or 12.
  renewVenuePlayer: (venueId, playerId, months) =>
    request(`/venue-manager/players/${playerId}/renew`, {
      method: 'POST',
      body: JSON.stringify({ venueId, months }),
    }),

  // Issues / Bugs / Features page (client/src/pages/IssuesBugsFeatures.jsx)
  // - visible to every logged-in account, not just admins.
  getGithubIssues: () => request('/github-issues'),
  getFeatureRequests: () => request('/feature-requests'),
  submitFeatureRequest: (title, description) =>
    request('/feature-requests', { method: 'POST', body: JSON.stringify({ title, description }) }),
  adminDeleteFeatureRequest: (id) => request(`/feature-requests/${id}`, { method: 'DELETE' }),

  // Guides page (client/src/pages/Guides.jsx) - visible to every logged-in
  // account (filtered server-side to what applies to them); only an
  // Overall Admin can upload, edit, or remove one. Upload and download
  // bypass the JSON-only `request()` helper the same way downloadBackup
  // does below - one sends a real file (multipart/form-data, no
  // Content-Type set so the browser adds its own boundary), the other
  // reads back a binary blob instead of parsed JSON.
  getGuides: () => request('/guides'),
  uploadGuide: async ({ title, description, visibility, file }) => {
    const token = getStoredToken();
    const formData = new FormData();
    formData.append('title', title);
    formData.append('description', description || '');
    formData.append('visibility', JSON.stringify(visibility));
    formData.append('file', file);
    const res = await fetch(`${BASE}/guides`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return body;
  },
  updateGuide: (id, data) => request(`/guides/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGuide: (id) => request(`/guides/${id}`, { method: 'DELETE' }),
  downloadGuide: async (id, fallbackFileName) => {
    const token = getStoredToken();
    const res = await fetch(`${BASE}/guides/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : (fallbackFileName || 'guide');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Admin: Game Adjustments
  adminGetPlayerFixtures: (playerId) => request(`/admin/players/${playerId}/fixtures`),
  adminGetFixturesNeedingAttention: () => request('/admin/fixtures/needs-attention'),
  adminReopenFixture: (fixtureId) => request(`/fixtures/${fixtureId}/reopen`, { method: 'POST' }),
  adminReopenLeg: (fixtureId, legNumber) => request(`/fixtures/${fixtureId}/legs/${legNumber}/reopen`, { method: 'POST' }),

  // Admin: season setup wizard
  adminCreateSeason: (data) => request('/admin/seasons', { method: 'POST', body: JSON.stringify(data) }),
  adminImportSeasonPlayers: (leagueId, rows) =>
    request(`/admin/seasons/${leagueId}/import-players`, { method: 'POST', body: JSON.stringify({ rows }) }),
  adminGenerateSeason: (leagueId, data) =>
    request(`/admin/seasons/${leagueId}/generate`, { method: 'POST', body: JSON.stringify(data) }),

  // Admin: score override
  overrideFixture: (fixtureId, homeScore, awayScore) =>
    request(`/fixtures/${fixtureId}/override`, { method: 'POST', body: JSON.stringify({ homeScore, awayScore }) }),

  // Admin: select bracket winner directly, without recording a score
  selectFixtureWinner: (fixtureId, winnerId) =>
    request(`/fixtures/${fixtureId}/select-winner`, { method: 'POST', body: JSON.stringify({ winnerId }) }),

  getRollOfHonour: () => request('/roll-of-honour'),

  getTours: () => request('/tours'),
  createTour: (data) => request('/tours', { method: 'POST', body: JSON.stringify(data) }),
  getTour: (id) => request(`/tours/${id}`),
  deleteTour: (id) => request(`/tours/${id}`, { method: 'DELETE' }),
  addTourDivision: (tourId, divisionId) =>
    request(`/tours/${tourId}/divisions`, { method: 'POST', body: JSON.stringify({ divisionId }) }),
  removeTourDivision: (tourId, divisionId) =>
    request(`/tours/${tourId}/divisions/${divisionId}`, { method: 'DELETE' }),

  getLeagues: () => request('/leagues'),
  createLeague: (data) => request('/leagues', { method: 'POST', body: JSON.stringify(data) }),
  getLeague: (id) => request(`/leagues/${id}`),
  updateLeague: (id, data) => request(`/leagues/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getLeaguePayments: (leagueId) => request(`/leagues/${leagueId}/payments`),
  setLeaguePaymentStatus: (leagueId, playerId, status, notes) =>
    request(`/leagues/${leagueId}/payments/${playerId}`, { method: 'POST', body: JSON.stringify({ status, notes }) }),
  // Overall-Admin-only: assign/remove a League Manager's scoped access to
  // this specific league. See server/src/index.js's POST/DELETE
  // /api/leagues/:id/managers.
  addLeagueManager: (leagueId, userId) =>
    request(`/leagues/${leagueId}/managers`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeLeagueManager: (leagueId, userId) =>
    request(`/leagues/${leagueId}/managers/${userId}`, { method: 'DELETE' }),

  createDivision: (leagueId, data) =>
    request(`/leagues/${leagueId}/divisions`, { method: 'POST', body: JSON.stringify(data) }),
  // Player-initiated one-off game (client/src/pages/AdHocGame.jsx) - same
  // shape as createDivision's data, but with no leagueId: the server creates
  // it under the shared, hidden "Ad Hoc Games" league. See
  // server/src/index.js's POST /api/adhoc-games.
  createAdHocGame: (data) => request('/adhoc-games', { method: 'POST', body: JSON.stringify(data) }),
  getDivision: (id) => request(`/divisions/${id}`),
  // NQT: open divisions browse + join requests.
  getOpenDivisions: () => request('/open-divisions'),
  requestToJoinDivision: (divisionId) =>
    request(`/divisions/${divisionId}/join-requests`, { method: 'POST' }),
  getLeagueJoinRequests: (leagueId) => request(`/leagues/${leagueId}/join-requests`),
  approveJoinRequest: (requestId) =>
    request(`/join-requests/${requestId}/approve`, { method: 'POST' }),
  rejectJoinRequest: (requestId) =>
    request(`/join-requests/${requestId}/reject`, { method: 'POST' }),
  // "Change Game Type" (DivisionDetail.jsx's GenerateFixturesButton): only
  // works while the division has no fixtures yet - see server/src/index.js's
  // PATCH /api/divisions/:id for the full validation/gating.
  updateDivision: (id, data) => request(`/divisions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Toggle "Is Open" on an existing division from Admin: Manage this League
  // - see server/src/index.js's POST /api/divisions/:id/set-open.
  setDivisionOpen: (id, isOpen) =>
    request(`/divisions/${id}/set-open`, { method: 'POST', body: JSON.stringify({ isOpen }) }),
  // League-level "Open For Registration": browse + interest registration +
  // bulk assignment into divisions. See server/src/index.js's
  // "---------- Open leagues ----------" block.
  getOpenLeagues: () => request('/open-leagues'),
  requestToJoinLeague: (leagueId) =>
    request(`/leagues/${leagueId}/interests`, { method: 'POST' }),
  getLeagueInterests: (leagueId) => request(`/leagues/${leagueId}/league-interests`),
  declineLeagueInterest: (id) =>
    request(`/league-interests/${id}/decline`, { method: 'POST' }),
  bulkAssignLeagueInterests: (interestIds, divisionId) =>
    request('/league-interests/bulk-assign', { method: 'POST', body: JSON.stringify({ interestIds, divisionId }) }),
  setLeagueOpen: (id, isOpenForRegistration) =>
    request(`/leagues/${id}/set-open`, { method: 'POST', body: JSON.stringify({ isOpenForRegistration }) }),
  // Admin-only: force-completes every outstanding fixture in a division (or,
  // for the league version, every division in the league) at 0-0 with no
  // winner - no player confirmation needed. See server/src/index.js's
  // closeOutstandingFixtures for the full behaviour.
  closeDivisionEarly: (divisionId) => request(`/divisions/${divisionId}/close-early`, { method: 'POST' }),
  closeLeagueEarly: (leagueId) => request(`/leagues/${leagueId}/close-early`, { method: 'POST' }),
  // Admin-only, irreversible: permanently deletes a league and every
  // division/fixture/team/pairing scoped to it. See server/src/index.js's
  // DELETE /api/leagues/:id.
  deleteLeague: (leagueId) => request(`/leagues/${leagueId}`, { method: 'DELETE' }),
  // Overall-Admin-or-assigned-League-Manager, irreversible: permanently
  // deletes a division and everything scoped to it (fixtures, teams/
  // pairings, roll-of-honour history), leaving the rest of the league
  // untouched. See server/src/index.js's DELETE /api/divisions/:id.
  deleteDivision: (divisionId) => request(`/divisions/${divisionId}`, { method: 'DELETE' }),
  getRegisteredPlayers: () => request('/registered-players'),
  addPlayer: (divisionId, playerId) =>
    request(`/divisions/${divisionId}/players`, { method: 'POST', body: JSON.stringify({ playerId }) }),
  removePlayer: (divisionId, playerId) =>
    request(`/divisions/${divisionId}/players/${playerId}`, { method: 'DELETE' }),
  quickAddPlayer: (divisionId, firstName, lastName) =>
    request(`/divisions/${divisionId}/quick-add-player`, { method: 'POST', body: JSON.stringify({ firstName, lastName }) }),
  closeLateEntry: (divisionId) =>
    request(`/divisions/${divisionId}/close-late-entry`, { method: 'POST' }),
  // Pre-tournament late entry for a double-elim knockout (see POST
  // /api/divisions/:id/late-entrants) - unlocks the roster and rebuilds the
  // bracket around the new player(s), rather than relying on a reserved
  // slot. Only succeeds while nothing in the bracket has been played yet.
  addLateEntrants: (divisionId, playerIds) =>
    request(`/divisions/${divisionId}/late-entrants`, { method: 'POST', body: JSON.stringify({ playerIds }) }),
  generateFixtures: (divisionId, data = {}) =>
    request(`/divisions/${divisionId}/generate-fixtures`, { method: 'POST', body: JSON.stringify(data) }),
  // Killer Classic / Cards Killer - see server/src/services/killer.js.
  // These divisions never generate fixtures; startKiller is their
  // equivalent of generateFixtures.
  startKiller: (divisionId) => request(`/divisions/${divisionId}/killer/start`, { method: 'POST' }),
  recordKillerShot: (divisionId, outcome, lastBall = false) =>
    request(`/divisions/${divisionId}/killer/shot`, { method: 'POST', body: JSON.stringify({ outcome, lastBall }) }),
  undoKillerShot: (divisionId) => request(`/divisions/${divisionId}/killer/undo`, { method: 'POST' }),
  resetKiller: (divisionId) => request(`/divisions/${divisionId}/killer/reset`, { method: 'POST' }),
  seedFromGroups: (divisionId, sources) =>
    request(`/divisions/${divisionId}/seed-from-groups`, { method: 'POST', body: JSON.stringify({ sources }) }),
  reorderEntrants: (divisionId, order) =>
    request(`/divisions/${divisionId}/reorder-entrants`, { method: 'POST', body: JSON.stringify({ order }) }),
  setRoundVisibility: (divisionId, round, visible) =>
    request(`/divisions/${divisionId}/rounds/${round}/visibility`, { method: 'POST', body: JSON.stringify({ visible }) }),
  hideAllRounds: (divisionId) =>
    request(`/divisions/${divisionId}/hide-all-rounds`, { method: 'POST' }),
  substitutePlayer: (divisionId, outgoingPlayerId, incomingPlayerId, reason = 'substitution') =>
    request(`/divisions/${divisionId}/substitute-player`, {
      method: 'POST',
      body: JSON.stringify({ outgoingPlayerId, incomingPlayerId, reason }),
    }),

  getFixture: (id) => request(`/fixtures/${id}`),
  // Public, unauthenticated summary for the OBS stream overlay page - no
  // Authorization header required (and none sent, even if one happens to be
  // in localStorage), since OBS Browser Source loads this URL cold.
  getOverlayFixture: (id) => request(`/overlay/fixtures/${id}`),
  // Public, unauthenticated Arena big-display board for a league - same
  // reasoning as the overlay above, but for a venue TV rather than OBS.
  getArena: (leagueId) => request(`/overlay/leagues/${leagueId}/arena`),
  // Public, unauthenticated League Table / League Fixtures - meant to be
  // embedded (e.g. an <iframe>) on another site. Same "no login available"
  // reasoning as overlay/arena above.
  getPublicLeagueTable: (leagueId) => request(`/public/leagues/${leagueId}/table`),
  getPublicLeagueFixtures: (leagueId) => request(`/public/leagues/${leagueId}/fixtures`),
  getPublicLeagueInterests: (leagueId) => request(`/public/leagues/${leagueId}/interests`),
  getPublicDivisionBracket: (divisionId) => request(`/public/divisions/${divisionId}/bracket`),
  getPublicDivisionTable: (divisionId) => request(`/public/divisions/${divisionId}/table`),
  getPublicDivisionFixtures: (divisionId) => request(`/public/divisions/${divisionId}/fixtures`),

  addTable: (leagueId, name) => request(`/leagues/${leagueId}/tables`, { method: 'POST', body: JSON.stringify({ name }) }),
  removeTable: (leagueId, tableId) => request(`/leagues/${leagueId}/tables/${tableId}`, { method: 'DELETE' }),
  scheduleFixture: (fixtureId, data) =>
    request(`/fixtures/${fixtureId}/schedule`, { method: 'POST', body: JSON.stringify(data) }),

  startTimer: (fixtureId) => request(`/fixtures/${fixtureId}/timer/start`, { method: 'POST' }),
  pauseTimer: (fixtureId) => request(`/fixtures/${fixtureId}/timer/pause`, { method: 'POST' }),
  resetTimer: (fixtureId) => request(`/fixtures/${fixtureId}/timer/reset`, { method: 'POST' }),
  startShotClock: (fixtureId, durationSeconds) =>
    request(`/fixtures/${fixtureId}/shot-clock/start`, { method: 'POST', body: JSON.stringify({ durationSeconds }) }),
  stopShotClock: (fixtureId) => request(`/fixtures/${fixtureId}/shot-clock/stop`, { method: 'POST' }),
  setFixtureTableInfo: (fixtureId, table, venue) =>
    request(`/fixtures/${fixtureId}/table-info`, { method: 'POST', body: JSON.stringify({ table, venue }) }),

  getApiKeys: () => request('/api-keys'),
  createApiKey: (label) => request('/api-keys', { method: 'POST', body: JSON.stringify({ label }) }),
  deleteApiKey: (id) => request(`/api-keys/${id}`, { method: 'DELETE' }),

  // Backup, restore & wipe (Overall-Admin-only) - see server/src/index.js's
  // GET/POST /api/admin/backup|restore|wipe.
  //
  // Bypasses the JSON-only `request()` helper: the response is the raw
  // db.json body with a Content-Disposition filename, not a parsed API
  // result, so this reads it as a blob and triggers a real browser download
  // instead of returning data to the caller.
  downloadBackup: async () => {
    const token = getStoredToken();
    const res = await fetch(`${BASE}/admin/backup`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'cuesense-backup.json';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  restoreBackup: (data) => request('/admin/restore', { method: 'POST', body: JSON.stringify(data) }),
  wipeAllData: () => request('/admin/wipe', { method: 'POST' }),
  setAlternativeBreaking: (fixtureId, enabled) =>
    request(`/fixtures/${fixtureId}/alternative-breaking`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // clientRequestId is an optional client-generated id (see scoringQueue.js)
  // that lets a retried call after a dropped connection be recognised as a
  // no-op replay by the server instead of double-recording the frame.
  recordFrame: (fixtureId, winnerPlayerId, method, breaker, clientRequestId) =>
    request(`/fixtures/${fixtureId}/frames`, { method: 'POST', body: JSON.stringify({ winnerPlayerId, method, breaker, clientRequestId }) }),
  undoLastFrame: (fixtureId) => request(`/fixtures/${fixtureId}/frames/last`, { method: 'DELETE' }),
  submitResult: (fixtureId) => request(`/fixtures/${fixtureId}/submit-result`, { method: 'POST' }),
  confirmResult: (fixtureId) => request(`/fixtures/${fixtureId}/confirm-result`, { method: 'POST' }),
  disputeResult: (fixtureId, reason) =>
    request(`/fixtures/${fixtureId}/dispute-result`, { method: 'POST', body: JSON.stringify({ reason }) }),
  addFixtureReferee: (fixtureId, email) =>
    request(`/fixtures/${fixtureId}/referee`, { method: 'POST', body: JSON.stringify({ email }) }),
  getRefereeCandidates: (fixtureId) => request(`/fixtures/${fixtureId}/referee-candidates`),
  addFixtureRefereeById: (fixtureId, userId) =>
    request(`/fixtures/${fixtureId}/referee`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeFixtureReferee: (fixtureId, userId) =>
    request(`/fixtures/${fixtureId}/referee/${userId}`, { method: 'DELETE' }),
  claimNoShow: (fixtureId, legNumber) =>
    request(`/fixtures/${fixtureId}/no-show`, { method: 'POST', body: JSON.stringify({ legNumber: legNumber ?? undefined }) }),
  authorizeNoShow: (fixtureId, legNumber) =>
    request(`/fixtures/${fixtureId}/no-show/authorize`, { method: 'POST', body: JSON.stringify({ legNumber: legNumber ?? undefined }) }),

  // Teams (team divisions only)
  createTeam: (divisionId, name) =>
    request(`/divisions/${divisionId}/teams`, { method: 'POST', body: JSON.stringify({ name }) }),
  removeTeam: (divisionId, teamId) =>
    request(`/divisions/${divisionId}/teams/${teamId}`, { method: 'DELETE' }),
  addTeamPlayer: (teamId, playerId) =>
    request(`/teams/${teamId}/players`, { method: 'POST', body: JSON.stringify({ playerId }) }),
  removeTeamPlayer: (teamId, playerId) =>
    request(`/teams/${teamId}/players/${playerId}`, { method: 'DELETE' }),

  // Pairings (doubles/triples divisions only)
  createPairing: (divisionId, name) =>
    request(`/divisions/${divisionId}/pairings`, { method: 'POST', body: JSON.stringify({ name }) }),
  removePairing: (divisionId, pairingId) =>
    request(`/divisions/${divisionId}/pairings/${pairingId}`, { method: 'DELETE' }),
  addPairingPlayer: (pairingId, playerId) =>
    request(`/pairings/${pairingId}/players`, { method: 'POST', body: JSON.stringify({ playerId }) }),
  removePairingPlayer: (pairingId, playerId) =>
    request(`/pairings/${pairingId}/players/${playerId}`, { method: 'DELETE' }),

  // Leg scoring (team fixtures only)
  nominateLeg: (fixtureId, legNumber, homePlayerId, awayPlayerId) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/nominate`, {
      method: 'POST',
      body: JSON.stringify({ homePlayerId, awayPlayerId }),
    }),
  setLegAlternativeBreaking: (fixtureId, legNumber, enabled) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/alternative-breaking`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // See recordFrame above for what clientRequestId does.
  recordLegFrame: (fixtureId, legNumber, winnerPlayerId, method, breaker, clientRequestId) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/frames`, {
      method: 'POST',
      body: JSON.stringify({ winnerPlayerId, method, breaker, clientRequestId }),
    }),
  undoLastLegFrame: (fixtureId, legNumber) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/frames/last`, { method: 'DELETE' }),
  submitLegResult: (fixtureId, legNumber) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/submit-result`, { method: 'POST' }),
  confirmLegResult: (fixtureId, legNumber) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/confirm-result`, { method: 'POST' }),
  disputeLegResult: (fixtureId, legNumber, reason) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/dispute-result`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getPlayerProfile: (playerId) => request(`/players/${playerId}`),

  // Player messaging (1-to-1 chat, blocking, abuse reports) - see the
  // "Player messaging" section of server/src/index.js. Not mirrored in the
  // static demo build (demoApi), so callers use optional chaining on
  // api.getMessageSummary where the demo build must not break.
  getMessageSummary: () => request('/messages/summary'),
  getMessageThreads: () => request('/messages/threads'),
  getMessageContacts: (q = '') => request(`/messages/contacts?q=${encodeURIComponent(q)}`),
  getMessageThread: (userId) => request(`/messages/with/${userId}`),
  sendMessage: (userId, body) =>
    request(`/messages/with/${userId}`, { method: 'POST', body: JSON.stringify({ body }) }),
  getMessageBlocks: () => request('/messages/blocks'),
  getMailStatus: () => request('/admin/mail/status'),
  sendTestEmail: () => request('/admin/mail/test', { method: 'POST' }),
  getMessageEmailPreference: () => request('/messages/email-preference'),
  setMessageEmailPreference: (emailMessageAlerts) =>
    request('/messages/email-preference', { method: 'POST', body: JSON.stringify({ emailMessageAlerts }) }),
  blockUser: (userId) => request(`/messages/blocks/${userId}`, { method: 'POST' }),
  unblockUser: (userId) => request(`/messages/blocks/${userId}`, { method: 'DELETE' }),
  reportMessageUser: (userId, reason) =>
    request('/messages/reports', { method: 'POST', body: JSON.stringify({ userId, reason }) }),
  getMessageReportSummary: () => request('/message-reports/summary'),
  getMessageReports: () => request('/message-reports'),
  handleMessageReport: (id, data) =>
    request(`/message-reports/${id}/handle`, { method: 'POST', body: JSON.stringify(data) }),
};

export const api = DEMO_MODE ? demoApi : networkApi;
