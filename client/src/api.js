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
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed: ${res.status}`);
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
  resetPassword: (token, newPassword) =>
    request(`/auth/reset-password/${token}`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  getMe: () => request('/users/me'),
  updateMe: (data) => request('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),
  changePassword: (currentPassword, newPassword) =>
    request('/users/me/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  getMyFixtures: () => request('/users/me/fixtures'),
  getMyPendingConfirmations: () => request('/users/me/pending-confirmations'),

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
  adminGetUserByPlayer: (playerId) => request(`/admin/users/by-player/${playerId}`),
  adminImportUsers: (rows) => request('/admin/users/import', { method: 'POST', body: JSON.stringify({ rows }) }),
  adminGetAuditLog: () => request('/admin/audit-log'),

  // Admin: Game Adjustments
  adminGetPlayerFixtures: (playerId) => request(`/admin/players/${playerId}/fixtures`),
  adminGetFixturesNeedingAttention: () => request('/admin/fixtures/needs-attention'),
  adminReopenFixture: (fixtureId) => request(`/fixtures/${fixtureId}/reopen`, { method: 'POST' }),
  adminReopenLeg: (fixtureId, legNumber) => request(`/fixtures/${fixtureId}/legs/${legNumber}/reopen`, { method: 'POST' }),

  // Venues
  getVenues: () => request('/venues'),
  adminListVenues: () => request('/admin/venues'),
  adminApproveVenue: (id) => request(`/admin/venues/${id}/approve`, { method: 'POST' }),
  adminRejectVenue: (id) => request(`/admin/venues/${id}/reject`, { method: 'POST' }),

  // Admin: season setup wizard
  adminCreateSeason: (data) => request('/admin/seasons', { method: 'POST', body: JSON.stringify(data) }),
  adminImportSeasonPlayers: (leagueId, rows) =>
    request(`/admin/seasons/${leagueId}/import-players`, { method: 'POST', body: JSON.stringify({ rows }) }),
  adminGenerateSeason: (leagueId, data) =>
    request(`/admin/seasons/${leagueId}/generate`, { method: 'POST', body: JSON.stringify(data) }),

  // Admin: score override
  overrideFixture: (fixtureId, homeScore, awayScore) =>
    request(`/fixtures/${fixtureId}/override`, { method: 'POST', body: JSON.stringify({ homeScore, awayScore }) }),

  getLeagues: () => request('/leagues'),
  createLeague: (data) => request('/leagues', { method: 'POST', body: JSON.stringify(data) }),
  getLeague: (id) => request(`/leagues/${id}`),

  createDivision: (leagueId, data) =>
    request(`/leagues/${leagueId}/divisions`, { method: 'POST', body: JSON.stringify(data) }),
  getDivision: (id) => request(`/divisions/${id}`),
  getRegisteredPlayers: () => request('/registered-players'),
  addPlayer: (divisionId, playerId) =>
    request(`/divisions/${divisionId}/players`, { method: 'POST', body: JSON.stringify({ playerId }) }),
  removePlayer: (divisionId, playerId) =>
    request(`/divisions/${divisionId}/players/${playerId}`, { method: 'DELETE' }),
  generateFixtures: (divisionId, data = {}) =>
    request(`/divisions/${divisionId}/generate-fixtures`, { method: 'POST', body: JSON.stringify(data) }),
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
  recordFrame: (fixtureId, winnerPlayerId) =>
    request(`/fixtures/${fixtureId}/frames`, { method: 'POST', body: JSON.stringify({ winnerPlayerId }) }),
  undoLastFrame: (fixtureId) => request(`/fixtures/${fixtureId}/frames/last`, { method: 'DELETE' }),
  submitResult: (fixtureId) => request(`/fixtures/${fixtureId}/submit-result`, { method: 'POST' }),
  confirmResult: (fixtureId) => request(`/fixtures/${fixtureId}/confirm-result`, { method: 'POST' }),
  disputeResult: (fixtureId, reason) =>
    request(`/fixtures/${fixtureId}/dispute-result`, { method: 'POST', body: JSON.stringify({ reason }) }),

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
  recordLegFrame: (fixtureId, legNumber, winnerPlayerId) =>
    request(`/fixtures/${fixtureId}/legs/${legNumber}/frames`, {
      method: 'POST',
      body: JSON.stringify({ winnerPlayerId }),
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
};

export const api = DEMO_MODE ? demoApi : networkApi;
