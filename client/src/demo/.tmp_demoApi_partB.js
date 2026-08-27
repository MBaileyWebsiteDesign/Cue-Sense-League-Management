  if (!startDate || !gapDays) return;
  const base = new Date(`${startDate}T00:00:00`);
  const fixtures = db.fixtures.filter((f) => f.divisionId === division.id);
  for (const fixture of fixtures) {
    const date = new Date(base);
    date.setDate(date.getDate() + (fixture.round - 1) * Number(gapDays));
    fixture.scheduledDate = date.toISOString().slice(0, 10);
  }
}

function recomputeTeamFixture(division, fixture) {
  const homeLegsWon = fixture.legs.filter((l) => l.status === 'completed' && l.winnerPlayerId === l.homePlayerId).length;
  const awayLegsWon = fixture.legs.filter((l) => l.status === 'completed' && l.winnerPlayerId === l.awayPlayerId).length;
  fixture.homeLegsWon = homeLegsWon;
  fixture.awayLegsWon = awayLegsWon;

  const totalLegs = fixture.legs.length;
  const majority = Math.floor(totalLegs / 2) + 1;
  const allLegsDone = fixture.legs.every((l) => l.status === 'completed');
  const wasCompleted = fixture.status === 'completed';

  if (homeLegsWon >= majority) {
    fixture.status = 'completed';
    fixture.winnerTeamId = fixture.homeTeamId;
  } else if (awayLegsWon >= majority) {
    fixture.status = 'completed';
    fixture.winnerTeamId = fixture.awayTeamId;
  } else if (allLegsDone) {
    fixture.status = 'completed';
    fixture.winnerTeamId = homeLegsWon === awayLegsWon ? null : (homeLegsWon > awayLegsWon ? fixture.homeTeamId : fixture.awayTeamId);
  } else {
    fixture.status = fixture.legs.some((l) => l.status !== 'pending') ? 'in_progress' : 'scheduled';
    fixture.winnerTeamId = null;
  }

  if (!wasCompleted && fixture.status === 'completed' && fixture.winnerTeamId) {
    propagateWinner(division, fixture, fixture.winnerTeamId);
    const loserTeamId = fixture.winnerTeamId === fixture.homeTeamId ? fixture.awayTeamId : fixture.homeTeamId;
    propagateLoser(division, fixture, loserTeamId);
    checkGrandFinalReset(division, fixture);
  }
}

function findTeamFixtureAndLeg(fixtureId, legNumber) {
  const fixture = db.fixtures.find((f) => f.id === fixtureId);
  if (!fixture || !fixture.legs) throw new ApiError(404, 'Team fixture not found');
  const leg = fixture.legs.find((l) => l.legNumber === Number(legNumber));
  if (!leg) throw new ApiError(404, 'Leg not found');
  return { fixture, leg };
}

// Mirrors server/src/index.js's isAwayEntrant/isHomeEntrant - whether the
// given playerId is (or is part of, for doubles pairings) the home/away side
// of a singles or doubles fixture. Used by the mutual result-confirmation
// and no-show-claim logic below.
function isAwayEntrant(division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.awayPlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.awayPlayerId === playerId;
}

function isHomeEntrant(division, fixture, playerId) {
  if (!playerId) return false;
  if (division.entryType === 'doubles') {
    const pairing = db.pairings.find((p) => p.id === fixture.homePlayerId);
    return !!pairing && pairing.playerIds.includes(playerId);
  }
  return fixture.homePlayerId === playerId;
}

// Synchronous session lookup for AuthContext's initial state - there's no
// server round-trip to await in demo mode, so a visitor is "logged in" the
// instant the page loads rather than seeing a login screen first.
export function getDemoSession() {
  const user = currentUser();
  if (!user) return null;
  return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
}

// ---------- the api surface (same method names/signatures as ../api.js) ----------

export const demoApi = {
  login: op((email, password) => {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
    // Real passwords aren't part of the bundled demo data (nothing to check
    // them against), so any password is accepted for a known demo account -
    // this is a public, throwaway playground, not a real login boundary.
    if (!user) throw new ApiError(401, 'Invalid email or password');
    if (user.status === 'suspended') throw new ApiError(403, 'This account has been suspended');
    setCurrentUser(user.id);
    return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
  }),

  // Public - consumes a demo password-reset token (see adminSendResetLink).
  resetPassword: op((token, newPassword) => {
    const reset = db.passwordResets.find((r) => r.token === token);
    if (!reset) throw new ApiError(404, 'This reset link is invalid');
    if (reset.usedAt) throw new ApiError(400, 'This reset link has already been used - ask an admin to send a new one');
    if (Date.now() > reset.expiresAt) throw new ApiError(400, 'This reset link has expired - ask an admin to send a new one');
    const user = db.users.find((u) => u.id === reset.userId);
    if (!user) throw new ApiError(404, 'Account not found');
    reset.usedAt = new Date().toISOString();
    // Demo mode never checks password hashes at login (see login() below),
    // so there's nothing real to update here - the reset flow itself (token
    // validity, single-use, expiry) still works exactly like the real app.
    return { ok: true };
  }),

  register: op((data) => {
    const {
      firstName, lastName, email, phone = '', teamName = '', classification = null,
    } = data;
    if (!firstName || !firstName.trim()) throw new ApiError(400, 'First name is required');
    if (!lastName || !lastName.trim()) throw new ApiError(400, 'Last name is required');
    if (!email || !email.trim()) throw new ApiError(400, 'Email is required');
    if (classification && !CLASSIFICATIONS.includes(classification)) {
      throw new ApiError(400, `classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      throw new ApiError(409, 'An account with this email already exists');
    }
    const user = createUserAccount({
      firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(),
      phone: phone ? phone.trim() : '', teamName: teamName ? teamName.trim() : '',
      classification: classification || null, isAdmin: false, isCaptain: false,
    });
    setCurrentUser(user.id);
    return { token: 'demo-token', expiresAt: Date.now() + 24 * 60 * 60 * 1000, user: publicUser(user) };
  }),

  getMe: op(() => publicUser(currentUser())),

  // Mirrors server/src/index.js's GET /api/users/me/leagues - static
  // read-only league/division membership shown in the Player Portal's "Your
  // Details" section.
  getMyLeagueMembership: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const divisions = db.divisions.filter((d) =>
      (d.playerIds || []).includes(playerId) ||
      (d.teamIds || []).some((id) => myTeamIds.includes(id)) ||
      (d.pairingIds || []).some((id) => myPairingIds.includes(id))
    );
    return divisions.map((d) => {
      const league = db.leagues.find((l) => l.id === d.leagueId);
      return {
        leagueId: d.leagueId,
        leagueName: league?.name || 'Unknown league',
        divisionId: d.id,
        divisionName: d.name,
        status: d.status || 'active',
      };
    });
  }),

  updateMe: op((data) => {
    const user = currentUser();
    applyProfileFields(user, data);
    return publicUser(user);
  }),

  changePassword: op(() => ({ ok: true })),

  getMyFixtures: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const fixtures = db.fixtures.filter((f) => {
      if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
      if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId)) return true;
      if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
      return false;
    });
    // Even a fixture you're actually in doesn't show up here until its round
    // is released - see isRoundVisible above. Admins see everything.
    const visibleFixtures = user.isAdmin
      ? fixtures
      : fixtures.filter((f) => isRoundVisible(db.divisions.find((d) => d.id === f.divisionId), f.round));
    const enriched = visibleFixtures.map((f) => {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      const isTeams = !!f.legs;
      const isDoubles = division?.entryType === 'doubles';
      const opponentId = isTeams
        ? (myTeamIds.includes(f.homeTeamId) ? f.awayTeamId : f.homeTeamId)
        : isDoubles
          ? (myPairingIds.includes(f.homePlayerId) ? f.awayPlayerId : f.homePlayerId)
          : (f.homePlayerId === playerId ? f.awayPlayerId : f.homePlayerId);
      const opponentName = isTeams
        ? db.teams.find((t) => t.id === opponentId)?.name
        : isDoubles
          ? db.pairings.find((p) => p.id === opponentId)?.name
          : db.players.find((p) => p.id === opponentId)?.name;
      return {
        id: f.id,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        scheduledDate: f.scheduledDate || null,
        opponentName: opponentName || 'TBD',
      };
    });
    enriched.sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || '') || a.round - b.round);
    return enriched;
  }),

  // A player's own results currently awaiting THEIR confirmation - mirrors
  // server/src/index.js's GET /api/users/me/pending-confirmations (see that
  // route for the full design note). Powers the "Needs Your Confirmation"
  // panel on the Player Portal.
  getMyPendingConfirmations: op(() => {
    const user = currentUser();
    if (!user || !user.playerId) return [];
    const playerId = user.playerId;
    const results = [];

    for (const f of db.fixtures) {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      // Same round-visibility gate as everywhere else - see isRoundVisible.
      if (!user.isAdmin && !isRoundVisible(division, f.round)) continue;

      if (f.legs) {
        const homeTeam = db.teams.find((t) => t.id === f.homeTeamId);
        const awayTeam = db.teams.find((t) => t.id === f.awayTeamId);
        for (const leg of f.legs) {
          if (leg.status !== 'pending_confirmation') continue;
          const isHome = leg.homePlayerId === playerId;
          const isAway = leg.awayPlayerId === playerId;
          if (!isHome && !isAway) continue;
          if (isHome && leg.homeConfirmed) continue;
          if (isAway && leg.awayConfirmed) continue;
          const opponentPlayer = db.players.find((p) => p.id === (isHome ? leg.awayPlayerId : leg.homePlayerId));
          results.push({
            fixtureId: f.id,
            legNumber: leg.legNumber,
            leagueName: league?.name,
            divisionName: division?.name,
            round: f.round,
            opponentName: opponentPlayer?.name || (isHome ? awayTeam?.name : homeTeam?.name) || 'TBD',
            scoreLabel: `${leg.homeFrameScore}-${leg.awayFrameScore} frames`,
          });
        }
        continue;
      }

      if (f.status !== 'pending_confirmation') continue;
      const isDoubles = division?.entryType === 'doubles';
      const isHome = isHomeEntrant(division, f, playerId);
      const isAway = isAwayEntrant(division, f, playerId);
      if (!isHome && !isAway) continue;
      if (isHome && f.homeConfirmed) continue;
      if (isAway && f.awayConfirmed) continue;
      const opponentId = isHome ? f.awayPlayerId : f.homePlayerId;
      const opponentName = isDoubles
        ? db.pairings.find((p) => p.id === opponentId)?.name
        : db.players.find((p) => p.id === opponentId)?.name;
      results.push({
        fixtureId: f.id,
        legNumber: null,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        opponentName: opponentName || 'TBD',
        scoreLabel: `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        submittedAt: f.resultSubmittedAt || null,
      });
    }

    results.sort((a, b) => (a.leagueName || '').localeCompare(b.leagueName || '') || a.round - b.round);
    return results;
  }),

  // Admin: Game Adjustments - same shape as getMyFixtures but for any
  // playerId, including every status (not just upcoming), since an admin
  // might be specifically looking for a disputed/pending result to resolve.
  adminGetPlayerFixtures: op((playerId) => {
    const myTeamIds = db.teams.filter((t) => t.playerIds.includes(playerId)).map((t) => t.id);
    const myPairingIds = db.pairings.filter((p) => p.playerIds.includes(playerId)).map((p) => p.id);
    const fixtures = db.fixtures.filter((f) => {
      if (f.homePlayerId === playerId || f.awayPlayerId === playerId) return true;
      if (myTeamIds.includes(f.homeTeamId) || myTeamIds.includes(f.awayTeamId)) return true;
      if (myPairingIds.includes(f.homePlayerId) || myPairingIds.includes(f.awayPlayerId)) return true;
      if (f.legs) return f.legs.some((l) => l.homePlayerId === playerId || l.awayPlayerId === playerId);
      return false;
    });
    const enriched = fixtures.map((f) => {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      const isTeams = !!f.legs;
      const isDoubles = division?.entryType === 'doubles';
      const opponentId = isTeams
        ? (myTeamIds.includes(f.homeTeamId) ? f.awayTeamId : f.homeTeamId)
        : isDoubles
          ? (myPairingIds.includes(f.homePlayerId) ? f.awayPlayerId : f.homePlayerId)
          : (f.homePlayerId === playerId ? f.awayPlayerId : f.homePlayerId);
      const opponentName = isTeams
        ? db.teams.find((t) => t.id === opponentId)?.name
        : isDoubles
          ? db.pairings.find((p) => p.id === opponentId)?.name
          : db.players.find((p) => p.id === opponentId)?.name;
      return {
        id: f.id,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        scoreLabel: isTeams ? `${f.homeLegsWon}-${f.awayLegsWon} legs` : `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        scheduledDate: f.scheduledDate || null,
        opponentName: opponentName || 'TBD',
      };
    });
    enriched.sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || '') || b.round - a.round);
    return enriched;
  }),

  // Powers the Game Adjustments "Needs Attention" list - mirrors the server's
  // GET /api/admin/fixtures/needs-attention (see that route for design notes).
  adminGetFixturesNeedingAttention: op(() => {
    const NEEDS_ATTENTION = ['pending_confirmation', 'disputed'];
    const results = [];
    for (const f of db.fixtures) {
      const division = db.divisions.find((d) => d.id === f.divisionId);
      const league = db.leagues.find((l) => l.id === f.leagueId);
      if (f.legs) {
        const homeTeam = db.teams.find((t) => t.id === f.homeTeamId);
        const awayTeam = db.teams.find((t) => t.id === f.awayTeamId);
        for (const leg of f.legs) {
          if (!NEEDS_ATTENTION.includes(leg.status)) continue;
          results.push({
            fixtureId: f.id,
            legNumber: leg.legNumber,
            leagueName: league?.name,
            divisionName: division?.name,
            round: f.round,
            status: leg.status,
            label: `${homeTeam ? homeTeam.name : 'TBD'} vs ${awayTeam ? awayTeam.name : 'TBD'} — Leg ${leg.legNumber}`,
            scoreLabel: `${leg.homeFrameScore}-${leg.awayFrameScore} frames`,
            disputeReason: leg.disputeReason || null,
            noShowClaim: leg.noShowClaim || null,
          });
        }
        continue;
      }
      if (!NEEDS_ATTENTION.includes(f.status)) continue;
      const isDoubles = division?.entryType === 'doubles';
      const homeName = isDoubles
        ? db.pairings.find((p) => p.id === f.homePlayerId)?.name
        : db.players.find((p) => p.id === f.homePlayerId)?.name;
      const awayName = isDoubles
        ? db.pairings.find((p) => p.id === f.awayPlayerId)?.name
        : db.players.find((p) => p.id === f.awayPlayerId)?.name;
      results.push({
        fixtureId: f.id,
        legNumber: null,
        leagueName: league?.name,
        divisionName: division?.name,
        round: f.round,
        status: f.status,
        label: `${homeName || 'TBD'} vs ${awayName || 'TBD'}`,
        scoreLabel: `${f.homeFrameScore}-${f.awayFrameScore} frames`,
        disputeReason: f.disputeReason || null,
        noShowClaim: f.noShowClaim || null,
      });
    }
    const STATUS_ORDER = { disputed: 0, pending_confirmation: 1 };
    results.sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.leagueName || '').localeCompare(b.leagueName || '') ||
      a.round - b.round
    );
    return results;
  }),

  adminListUsers: op((q = '') => {
    const query = (q || '').trim().toLowerCase();
    let users = db.users;
    if (query) {
      users = users.filter((u) =>
        `${u.firstName} ${u.lastName}`.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query) ||
        u.teamName.toLowerCase().includes(query)
      );
    }
    users = [...users].sort((a, b) => a.lastName.localeCompare(b.lastName));
    return users.map(publicUser);
  }),

  adminGetUser: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    return publicUser(user);
  }),

  adminGetUserByPlayer: op((playerId) => {
    const user = db.users.find((u) => u.playerId === playerId) || null;
    return { user: publicUser(user) };
  }),

  adminUpdateUser: op((id, data) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    applyProfileFields(user, data);
    recordAudit(db, {
      actor: adminLabel(), action: 'user.edit', targetType: 'user', targetId: user.id,
      details: `Edited profile for ${user.firstName} ${user.lastName}`,
    });
    return publicUser(user);
  }),

  adminSetPermissions: op((id, permissions) => {
    const { isAdmin, isCaptain, isLeagueManager } = permissions;
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    const changes = [];
    if (isAdmin !== undefined && !!isAdmin !== user.isAdmin) {
      user.isAdmin = !!isAdmin;
      changes.push(user.isAdmin ? 'granted admin' : 'revoked admin');
    }
    if (isCaptain !== undefined && !!isCaptain !== user.isCaptain) {
      user.isCaptain = !!isCaptain;
      changes.push(user.isCaptain ? 'marked as captain' : 'unmarked as captain');
    }
    if (isLeagueManager !== undefined && !!isLeagueManager !== user.isLeagueManager) {
      user.isLeagueManager = !!isLeagueManager;
      changes.push(user.isLeagueManager ? 'granted League Manager' : 'revoked League Manager');
      if (!user.isLeagueManager) {
        for (const league of db.leagues) {
          if (Array.isArray(league.managerUserIds) && league.managerUserIds.includes(user.id)) {
            league.managerUserIds = league.managerUserIds.filter((mid) => mid !== user.id);
          }
        }
      }
    }
    if (changes.length > 0) {
      recordAudit(db, {
        actor: adminLabel(), action: 'user.permissions', targetType: 'user', targetId: user.id,
        details: `${user.firstName} ${user.lastName}: ${changes.join(', ')}`,
      });
    }
    return publicUser(user);
  }),

  adminSetStatus: op((id, status) => {
    if (!STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    user.status = status;
    recordAudit(db, {
      actor: adminLabel(), action: 'user.status', targetType: 'user', targetId: user.id,
      details: `Set status of ${user.firstName} ${user.lastName} to ${status}`,
    });
    return publicUser(user);
  }),

  adminResetPassword: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    recordAudit(db, {
      actor: adminLabel(), action: 'user.reset_password', targetType: 'user', targetId: user.id,
      details: `Force-reset password for ${user.firstName} ${user.lastName}`,
    });
    return { ok: true };
  }),

  adminImportUsers: op((rows) => {
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');
    const created = [];
    const skipped = [];
    const errors = [];
    rows.forEach((row, index) => {
      const rowNum = index + 1;
      try {
        const firstName = (row.firstName || '').trim();
        const lastName = (row.lastName || '').trim();
        const email = (row.email || '').trim();
        const teamName = (row.teamName || '').trim() || 'Unassigned';
        const classification = (row.classification || '').trim().toUpperCase() || null;
        const isAdminFlag = row.isAdmin === true || String(row.isAdmin).trim().toLowerCase() === 'true' || String(row.isAdmin).trim() === '1';
        const isCaptain = row.isCaptain === true || String(row.isCaptain).trim().toLowerCase() === 'true' || String(row.isCaptain).trim() === '1';
        if (!firstName) throw new Error('firstName is required');
        if (!lastName) throw new Error('lastName is required');
        if (!email) throw new Error('email is required');
        if (classification && !CLASSIFICATIONS.includes(classification)) {
          throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
        }
        const normalizedEmail = email.toLowerCase();
        const existing = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
        if (existing) {
          skipped.push({ row: rowNum, name: `${existing.firstName} ${existing.lastName}`, email, reason: 'an account with this email already exists' });
          return;
        }
        const user = createUserAccount({
          firstName, lastName, email, phone: (row.phone || '').trim(), teamName, classification,
          isAdmin: isAdminFlag, isCaptain,
        });
        created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, tempPassword: '(not needed in demo mode)' });
      } catch (err) {
        errors.push({ row: rowNum, reason: err.message });
      }
    });
    if (created.length > 0) {
      recordAudit(db, {
        actor: adminLabel(), action: 'user.bulk_import', targetType: 'user', targetId: null,
        details: `Bulk-imported ${created.length} user account(s) from Manage Users`,
      });
    }
    return { created, skipped, errors };
  }),

  adminSendResetLink: op((id) => {
    const user = db.users.find((u) => u.id === id);
    if (!user) throw new ApiError(404, 'User not found');
    const token = randomToken();
    const expiresAt = Date.now() + 60 * 60 * 1000;
    db.passwordResets.push({ id: uuid(), userId: user.id, token, createdAt: new Date().toISOString(), expiresAt, usedAt: null });
    const resetLink = `${window.location.origin}${window.location.pathname}#/reset-password?token=${token}`;
    recordAudit(db, {
      actor: adminLabel(), action: 'user.send_reset_link', targetType: 'user', targetId: user.id,
      details: `Generated a password reset link for ${user.firstName} ${user.lastName} (${user.email})`,
    });
    return { resetLink, expiresAt, email: user.email };
  }),

  adminGetAuditLog: op(() => [...db.auditLog].reverse().slice(0, 200)),

  // Issues / Bugs / Features page. The GitHub-backed Issue / Bug Tracker
  // half has no demo equivalent - there's no live repo to read from a
  // static Pages build, and this demo never invents data that isn't really
  // there - so it surfaces a clear message instead of the network version's
  // fetch. The Feature / Requests half is genuine in-app data (submitted by
  // whoever is using this demo session), so that's a real, fully working op
  // like everything else here.
  getGithubIssues: () => Promise.reject(new Error("GitHub Issues aren't available in this demo build.")),
  getFeatureRequests: op(() => [...db.featureRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))),
  submitFeatureRequest: op((title, description) => {
    const trimmedTitle = (title || '').trim();
    const trimmedDescription = (description || '').trim();
    if (!trimmedTitle) throw new ApiError(400, 'A short title is required');
    if (trimmedTitle.length > 200) throw new ApiError(400, 'Title must be 200 characters or fewer');
    if (trimmedDescription.length > 4000) throw new ApiError(400, 'Description must be 4000 characters or fewer');
    const user = currentUser();
    if (!user) throw new ApiError(401, 'Login required for this action');
    const request = {
      id: uuid(),
      title: trimmedTitle,
      description: trimmedDescription,
      createdAt: new Date().toISOString(),
      createdByUserId: user.id,
      createdByName: `${user.firstName} ${user.lastName}`.trim(),
    };
    db.featureRequests.push(request);
    return request;
  }),
  adminDeleteFeatureRequest: op((id) => {
    const before = db.featureRequests.length;
    db.featureRequests = db.featureRequests.filter((r) => r.id !== id);
    if (db.featureRequests.length === before) throw new ApiError(404, 'Feature request not found');
    return null;
  }),

  adminCreateSeason: op((data) => {
    const { name, leagueCount, playersPerLeague, payment } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'Season name is required');
    const count = Number(leagueCount);
    const perLeague = Number(playersPerLeague);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new ApiError(400, 'Number of leagues must be a whole number between 1 and 50');
    }
    if (!Number.isInteger(perLeague) || perLeague < 2 || perLeague > 200) {
      throw new ApiError(400, 'Players per league must be a whole number between 2 and 200');
    }
    const league = {
      id: uuid(),
      name: name.trim(),
      sport: 'English 8-Ball Pool',
      format: { matchFormat: 'singles', raceTo: 6, scheduling: 'round_robin_single' },
      startDate: null,
      endDate: null,
      createdAt: new Date().toISOString(),
      payment: normalizePaymentConfig(payment),
      managerUserIds: [],
      tables: [],
    };
    db.leagues.push(league);
    const divisions = [];
    for (let i = 0; i < count; i++) {
      const division = {
        id: uuid(), leagueId: league.id, name: `League ${i + 1}`, order: i,
        entryType: 'singles', scheduling: 'round_robin_single', playerIds: [], teamIds: [],
        legsPerMatch: null, gapDays: null, targetPlayerCount: perLeague, fixturesGenerated: false,
      };
      db.divisions.push(division);
      divisions.push(division);
    }
    return { ...league, divisions };
  }),

  adminImportSeasonPlayers: op((leagueId, rows) => {
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'Season not found');
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const divisionByName = new Map(divisions.map((d) => [d.name.trim().toLowerCase(), d]));
    const created = [];
    const linkedExisting = [];
    const errors = [];
    // See server/src/index.js's import-players route for why this isn't
    // hard-gated by assertPaymentCleared - anyone imported into a paid
    // league without an existing confirmed/waived record gets an 'unpaid'
    // one created and is listed here instead.
    const pendingPayment = [];
    rows.forEach((row, index) => {
      const rowNum = index + 1;
      try {
        const firstName = (row.firstName || '').trim();
        const lastName = (row.lastName || '').trim();
        const email = (row.email || '').trim();
        const teamName = (row.teamName || '').trim() || 'Unassigned';
        const classification = (row.classification || '').trim().toUpperCase() || null;
        const divisionName = (row.division || '').trim();
        const isCaptain = row.isCaptain === true || String(row.isCaptain).trim().toLowerCase() === 'true' || String(row.isCaptain).trim() === '1';
        if (!firstName) throw new Error('firstName is required');
        if (!lastName) throw new Error('lastName is required');
        if (!email) throw new Error('email is required');
        if (!divisionName) throw new Error('division is required');
        if (classification && !CLASSIFICATIONS.includes(classification)) {
          throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
        }
        const division = divisionByName.get(divisionName.toLowerCase());
        if (!division) {
          throw new Error(`division "${divisionName}" doesn't match any league in this season (expected one of: ${divisions.map((d) => d.name).join(', ')})`);
        }
        if (division.fixturesGenerated) {
          throw new Error(`fixtures have already been generated for "${division.name}" - can't add more players`);
        }
        const normalizedEmail = email.toLowerCase();
        let user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
        if (!user) {
          user = createUserAccount({
            firstName, lastName, email, phone: (row.phone || '').trim(), teamName, classification, isCaptain,
          });
          created.push({ row: rowNum, name: `${firstName} ${lastName}`, email, division: division.name, tempPassword: '(not needed in demo mode)' });
        } else {
          if (isCaptain && !user.isCaptain) user.isCaptain = true;
          linkedExisting.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email, division: division.name });
        }
        if (!division.playerIds.includes(user.playerId)) {
          division.playerIds.push(user.playerId);
        }

        if (league.payment.required) {
          const existingPayment = db.leaguePayments.find(
            (p) => p.leagueId === league.id && p.playerId === user.playerId
          );
          if (existingPayment && ['confirmed', 'waived'].includes(existingPayment.status)) {
            // already cleared - nothing to do.
          } else if (!existingPayment) {
            db.leaguePayments.push({
              id: uuid(), leagueId: league.id, playerId: user.playerId, status: 'unpaid',
              amount: league.payment.amount, currency: league.payment.currency,
              confirmedBy: null, confirmedAt: null, notes: '',
            });
            pendingPayment.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email: user.email, division: division.name });
          } else {
            pendingPayment.push({ row: rowNum, name: `${user.firstName} ${user.lastName}`, email: user.email, division: division.name });
          }
        }
      } catch (err) {
        errors.push({ row: rowNum, reason: err.message });
      }
    });
    return { created, linkedExisting, errors, pendingPayment };
  }),

  adminGenerateSeason: op((leagueId, data) => {
    const { startDate, endDate, gapDays, visibleByDefault } = data;
    if (!startDate) throw new ApiError(400, 'startDate is required');
    if (!endDate) throw new ApiError(400, 'endDate is required');
    if (!Number.isInteger(Number(gapDays)) || Number(gapDays) < 1) {
      throw new ApiError(400, 'gapDays must be a positive whole number of days between rounds');
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new ApiError(400, 'endDate cannot be before startDate');
    }
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'Season not found');
    league.startDate = startDate;
    league.endDate = endDate;
    const divisions = db.divisions.filter((d) => d.leagueId === league.id);
    const generated = [];
    const skipped = [];
    for (const division of divisions) {
      if (division.fixturesGenerated) {
        skipped.push({ division: division.name, reason: 'fixtures already generated' });
        continue;
      }
      if (division.playerIds.length < 2) {
        skipped.push({ division: division.name, reason: `only ${division.playerIds.length} player(s) - needs at least 2` });
        continue;
      }
      generateRoundRobinFixtures({ league, division, entrantIds: division.playerIds });
      division.gapDays = Number(gapDays);
      assignScheduledDates(division, startDate, gapDays);
      if (visibleByDefault) markAllRoundsVisible(division);
      division.fixturesGenerated = true;
      const divisionFixtures = db.fixtures.filter((f) => f.divisionId === division.id);
      const lastRound = Math.max(...divisionFixtures.map((f) => f.round));
      const lastRoundDate = divisionFixtures.find((f) => f.round === lastRound)?.scheduledDate;
      generated.push({
        division: division.name, players: division.playerIds.length, rounds: lastRound,
        lastGameDate: lastRoundDate, fitsWithinEndDate: !lastRoundDate || lastRoundDate <= endDate,
      });
    }
    return { league: { id: league.id, name: league.name, startDate, endDate }, generated, skipped };
  }),

  overrideFixture: op((fixtureId, homeScore, awayScore) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const isTeams = division.entryType === 'teams';
    if (isTeams) {
      if (!fixture.homeTeamId || !fixture.awayTeamId) throw new ApiError(400, 'Both teams for this fixture are not yet known');
    } else if (!fixture.homePlayerId || !fixture.awayPlayerId) {
      throw new ApiError(400, 'Both players for this fixture are not yet known');
    }
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      throw new ApiError(400, 'homeScore and awayScore must be non-negative whole numbers');
    }
    if (!isTeams && homeScore === awayScore) {
      throw new ApiError(400, 'This match cannot end level - set different scores for home and away');
    }
    const oldWinnerId = isTeams ? fixture.winnerTeamId : fixture.winnerPlayerId;
    const newWinnerId = homeScore === awayScore
      ? null
      : homeScore > awayScore
        ? (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
        : (isTeams ? fixture.awayTeamId : fixture.awayPlayerId);
    const next = fixture.nextFixtureId ? db.fixtures.find((f) => f.id === fixture.nextFixtureId) : null;
    const nextCurrentOccupant = next
      ? (isTeams
          ? (fixture.nextFixtureSlot === 'home' ? next.homeTeamId : next.awayTeamId)
          : (fixture.nextFixtureSlot === 'home' ? next.homePlayerId : next.awayPlayerId))
      : null;
    const winnerNeedsPropagating = !!(next && newWinnerId && nextCurrentOccupant !== newWinnerId);
    if (winnerNeedsPropagating) {
      const nextHasStarted = isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0;
      if (nextHasStarted) {
        throw new ApiError(409, 'This result has already progressed to a fixture that has started - override or reset that fixture first');
      }
    }
    if (isTeams) {
      fixture.homeLegsWon = homeScore;
      fixture.awayLegsWon = awayScore;
      fixture.winnerTeamId = newWinnerId;
      fixture.legs = fixture.legs.map((leg) => ({
        ...leg, homePlayerId: null, awayPlayerId: null, frames: [], homeFrameScore: 0, awayFrameScore: 0,
        status: 'pending', winnerPlayerId: null,
      }));
    } else {
      fixture.homeFrameScore = homeScore;
      fixture.awayFrameScore = awayScore;
      fixture.frames = [];
      fixture.winnerPlayerId = newWinnerId;
    }
    fixture.status = 'completed';
    fixture.adminOverride = { at: new Date().toISOString(), by: adminLabel() };
    fixture.disputeReason = null;
    if (winnerNeedsPropagating) {
      propagateWinner(division, fixture, newWinnerId);
    }
    if (newWinnerId) {
      const newLoserId = newWinnerId === (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
        ? (isTeams ? fixture.awayTeamId : fixture.awayPlayerId)
        : (isTeams ? fixture.homeTeamId : fixture.homePlayerId);
      propagateLoser(division, fixture, newLoserId);
    }
    checkGrandFinalReset(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.override', targetType: 'fixture', targetId: fixture.id,
      details: `Set final score to ${homeScore}-${awayScore}`,
    });
    return fixture;
  }),

  selectFixtureWinner: op((fixtureId, winnerId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const division = db.divisions.find((d) => d.id === fixture.divisionId);
    const isTeams = division.entryType === 'teams';
    if (isTeams) {
      if (!fixture.homeTeamId || !fixture.awayTeamId) throw new ApiError(400, 'Both teams for this fixture are not yet known');
      if (winnerId !== fixture.homeTeamId && winnerId !== fixture.awayTeamId) {
        throw new ApiError(400, "winnerId must be one of this fixture's two teams");
      }
      if (fixture.status !== 'scheduled' || fixture.legs.some((l) => l.status !== 'pending')) {
        throw new ApiError(400, 'This fixture already has a result recorded - use score entry or the Override Result panel instead');
      }
    } else {
      if (!fixture.homePlayerId || !fixture.awayPlayerId) throw new ApiError(400, 'Both players for this fixture are not yet known');
      if (winnerId !== fixture.homePlayerId && winnerId !== fixture.awayPlayerId) {
        throw new ApiError(400, "winnerId must be one of this fixture's two entrants");
      }
      if (fixture.status !== 'scheduled' || fixture.frames.length > 0) {
        throw new ApiError(400, 'This fixture already has a result recorded - use score entry or the Override Result panel instead');
      }
    }
    const next = fixture.nextFixtureId ? db.fixtures.find((f) => f.id === fixture.nextFixtureId) : null;
    const nextCurrentOccupant = next
      ? (isTeams
          ? (fixture.nextFixtureSlot === 'home' ? next.homeTeamId : next.awayTeamId)
          : (fixture.nextFixtureSlot === 'home' ? next.homePlayerId : next.awayPlayerId))
      : null;
    const winnerNeedsPropagating = !!(next && nextCurrentOccupant !== winnerId);
    if (winnerNeedsPropagating) {
      const nextHasStarted = isTeams ? next.legs.some((l) => l.status !== 'pending') : next.frames.length > 0;
      if (nextHasStarted) {
        throw new ApiError(409, 'This result has already progressed to a fixture that has started - override or reset that fixture first');
      }
    }
    if (isTeams) {
      fixture.homeLegsWon = 0;
      fixture.awayLegsWon = 0;
      fixture.winnerTeamId = winnerId;
      fixture.legs = fixture.legs.map((leg) => ({
        ...leg, homePlayerId: null, awayPlayerId: null, frames: [], homeFrameScore: 0, awayFrameScore: 0,
        status: 'pending', winnerPlayerId: null,
      }));
    } else {
      fixture.homeFrameScore = 0;
      fixture.awayFrameScore = 0;
      fixture.frames = [];
      fixture.winnerPlayerId = winnerId;
    }
    fixture.status = 'completed';
    fixture.adminOverride = { at: new Date().toISOString(), by: adminLabel() };
    fixture.scoreRecorded = false;
    fixture.disputeReason = null;
    if (winnerNeedsPropagating) {
      propagateWinner(division, fixture, winnerId);
    }
    const loserId = winnerId === (isTeams ? fixture.homeTeamId : fixture.homePlayerId)
      ? (isTeams ? fixture.awayTeamId : fixture.awayPlayerId)
      : (isTeams ? fixture.homeTeamId : fixture.homePlayerId);
    propagateLoser(division, fixture, loserId);
    checkGrandFinalReset(division, fixture);
    recordAudit(db, {
      actor: adminLabel(), action: 'fixture.winner_selected', targetType: 'fixture', targetId: fixture.id,
      details: 'Selected the winner directly from the bracket, without recording a score',
    });
    return fixture;
  }),

  // ---------- Roll of Honour ----------
  // Every entry is recorded automatically by recordChampionIfDivisionComplete
  // (see hydrateDivision above) - nothing here writes to db.rollOfHonour
  // directly, mirroring the real server's GET /api/roll-of-honour.
  getRollOfHonour: op(() =>
    [...db.rollOfHonour].sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
  ),

  // ---------- Tours / Series ----------
  // Mirrors server/src/index.js's Tours routes - see those for the full
  // "an admin-curated list of existing divisions" rationale.
  getTours: op(() => db.tours),

  createTour: op((data) => {
    const { name, entryType = 'singles' } = data;
    if (!name || !name.trim()) throw new ApiError(400, 'Tour name is required');
    if (!['singles', 'teams', 'doubles'].includes(entryType)) {
      throw new ApiError(400, 'entryType must be "singles", "teams" or "doubles"');
    }
    const tour = { id: uuid(), name: name.trim(), entryType, divisionIds: [], createdAt: new Date().toISOString() };
    db.tours.push(tour);
    return tour;
  }),

  getTour: op((id) => {
    const tour = db.tours.find((t) => t.id === id);
    if (!tour) throw new ApiError(404, 'Tour not found');
    const divisions = db.divisions.filter((d) => tour.divisionIds.includes(d.id));
    const hydratedDivisions = divisions.map((d) => hydrateDivision(d));
    const standings = computeTourStandings(tour, hydratedDivisions);
    return {
      ...tour,
      divisions: hydratedDivisions.map((d) => ({
        id: d.id, name: d.name, leagueId: d.leagueId, leagueName: d.leagueName, fixturesGenerated: d.fixturesGenerated,
      })),
      standings,
    };
  }),

  deleteTour: op((id) => {
    const index = db.tours.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError(404, 'Tour not found');
    db.tours.splice(index, 1);
    return { ok: true };
  }),

  addTourDivision: op((tourId, divisionId) => {
    if (!divisionId) throw new ApiError(400, 'divisionId is required');
    const tour = db.tours.find((t) => t.id === tourId);
    if (!tour) throw new ApiError(404, 'Tour not found');
    const division = db.divisions.find((d) => d.id === divisionId);
    if (!division) throw new ApiError(404, 'Division not found');
    if (division.entryType !== tour.entryType) {
      throw new ApiError(
        400,
        `This tour only accepts ${tour.entryType} divisions - "${division.name}" is a ${division.entryType} division`
      );
    }
    if (!tour.divisionIds.includes(divisionId)) tour.divisionIds.push(divisionId);
    return tour;
  }),

  removeTourDivision: op((tourId, divisionId) => {
    const tour = db.tours.find((t) => t.id === tourId);
    if (!tour) throw new ApiError(404, 'Tour not found');
    tour.divisionIds = tour.divisionIds.filter((id) => id !== divisionId);
    return tour;
  }),

  // ---------- Table scheduling ----------
  addTable: op((leagueId, name) => {
    if (!name || !name.trim()) throw new ApiError(400, 'Table name is required');
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    league.tables.push({ id: uuid(), name: name.trim() });
    return league;
  }),

  removeTable: op((leagueId, tableId) => {
    const league = db.leagues.find((l) => l.id === leagueId);
    if (!league) throw new ApiError(404, 'League not found');
    league.tables = league.tables.filter((t) => t.id !== tableId);
    for (const fixture of db.fixtures) {
      if (fixture.leagueId === league.id && fixture.tableId === tableId) {
        fixture.tableId = null;
      }
    }
    return league;
  }),

  scheduleFixture: op((fixtureId, { tableId, scheduledDate, scheduledTime } = {}) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    const league = db.leagues.find((l) => l.id === fixture.leagueId);

    if (tableId !== undefined && tableId !== null) {
      const table = league.tables.find((t) => t.id === tableId);
      if (!table) throw new ApiError(400, "That table does not exist in this fixture's league");
    }

    const nextTableId = tableId === undefined ? fixture.tableId : tableId;
    const nextDate = scheduledDate === undefined ? fixture.scheduledDate : scheduledDate;
    const nextTime = scheduledTime === undefined ? fixture.scheduledTime : scheduledTime;

    if (nextTableId && nextDate && nextTime) {
      const clash = db.fixtures.find(
        (f) => f.id !== fixture.id && f.tableId === nextTableId && f.scheduledDate === nextDate && f.scheduledTime === nextTime
      );
      if (clash) throw new ApiError(409, 'That table is already booked for another fixture at that date and time');
    }

    fixture.tableId = nextTableId;
    fixture.scheduledDate = nextDate;
    fixture.scheduledTime = nextTime;
    return fixture;
  }),

  // ---------- Match timer & shot clock ----------
  startTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (!fixture.timer.running) {
      fixture.timer.running = true;
      fixture.timer.startedAt = new Date().toISOString();
    }
    return fixture;
  }),

  pauseTimer: op((fixtureId) => {
    const fixture = db.fixtures.find((f) => f.id === fixtureId);
    if (!fixture) throw new ApiError(404, 'Fixture not found');
    if (fixture.timer.running && fixture.timer.startedAt) {
      const elapsed = (Date.now() - new Date(fixture.timer.startedAt).getTime()) / 1000;
      fixture.timer.elapsedSeconds += Math.max(0, elapsed);
    }
