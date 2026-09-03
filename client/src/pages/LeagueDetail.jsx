import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Named physical tables for this league - see server/src/index.js's
// POST /api/leagues/:id/tables and the Arena display, which shows what's
// currently assigned to each one.
function TablesPanel({ league, onChange, setError }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onAdd = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setSubmitting(true);
    try {
      await api.addTable(league.id, name.trim());
      setName('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (tableId) => {
    setError('');
    try {
      await api.removeTable(league.id, tableId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card">
      <h2>Tables</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        Named physical tables fixtures can be scheduled onto (see a fixture's own page) -
        shown live on the <Link to={`/arena/${league.id}`}>Arena display</Link> for a venue TV.
      </p>
      <ul className="player-list">
        {league.tables.map((t) => (
          <li key={t.id}>
            {t.name}
            <button className="btn-link" onClick={() => onRemove(t.id)}>remove</button>
          </li>
        ))}
        {league.tables.length === 0 && <li className="muted">No tables added yet</li>}
      </ul>
      <form className="inline-form" onSubmit={onAdd} style={{ marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Table 1" />
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || submitting}>
          Add Table
        </button>
      </form>
    </section>
  );
}

// Admin-only panel for the payment wall settings: turning it on/off and
// setting the amount + optional window (edits the League record via
// PATCH). The per-player Confirm/Waive/Reset list used to live here too,
// but it's been folded into ManageLeaguePanel's "League Interests" section
// below instead (see the comment there) - a manager decides who to place
// and clears their payment in the same spot, rather than jumping between
// two separate lists. See assertPaymentCleared in server/src/index.js for
// how payment status gates adding entrants to a division.
function PaymentsPanel({ league, onChange, setError }) {
  const [editing, setEditing] = useState(false);
  const [required, setRequired] = useState(false);
  const [amount, setAmount] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-populate the edit form from the current league every time it's
  // opened, rather than once on mount - otherwise a second edit after a
  // save would show stale values from before the first save.
  useEffect(() => {
    if (editing) {
      setRequired(league.payment?.required || false);
      setAmount(league.payment?.amount || '');
      setWindowStart(league.payment?.windowStart || '');
      setWindowEnd(league.payment?.windowEnd || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const onSaveSettings = async (e) => {
    e.preventDefault();
    if (required && (!amount || Number(amount) <= 0)) {
      setError('Entry fee must be a number greater than 0');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await api.updateLeague(league.id, {
        payment: required
          ? { required: true, amount: Number(amount), currency: 'GBP', windowStart: windowStart || null, windowEnd: windowEnd || null }
          : { required: false },
      });
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Payment Wall</h2>
        <button className="btn" type="button" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel' : league.payment?.required ? 'Edit' : 'Set Up'}
        </button>
      </div>

      {!editing && (
        league.payment?.required ? (
          <p className="muted">
            Requires a confirmed £{league.payment.amount} entry fee before a player can be added to any division
            in this league.
            {(league.payment.windowStart || league.payment.windowEnd) && (
              <> Payment window: {league.payment.windowStart || 'no start set'} to {league.payment.windowEnd || 'no end set'}.</>
            )}
          </p>
        ) : (
          <p className="muted">No payment wall - anyone can be added to this league's divisions for free.</p>
        )
      )}

      {editing && (
        <form className="form" onSubmit={onSaveSettings}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={required} onChange={(e) => setRequired(e.target.checked)} />
            Require payment to join this league
          </label>
          {required && (
            <>
              <label>
                Entry fee (£)
                <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </label>
              <label>
                Payment window opens (optional)
                <input type="date" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
              </label>
              <label>
                Payment window closes (optional)
                <input type="date" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
              </label>
            </>
          )}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}

    </section>
  );
}

// Collapsed-by-default panel of league-wide destructive/admin actions -
// closing the season early (force-completes outstanding fixtures, but the
// league and its history stick around), assigning League Manager access
// (Overall-Admin-only), and, below that, permanently deleting the league
// altogether (removes the league and everything scoped to it: divisions,
// fixtures, teams, pairings, roll-of-honour entries). Delete is available to
// an Overall Admin or a League Manager assigned to this league - same
// two-step "Show" then confirm pattern as the rest of the app's irreversible
// actions, with an extra type-the-league-name confirmation before delete
// specifically, since that one can't be recovered from at all.
function ManageLeaguePanel({ league, isAdmin, canManage, canCloseEarly, onChange, setError }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // League Manager assignment (Overall-Admin-only, see below) - candidates
  // are only fetched once this panel is opened, same lazy-load pattern as
  // the rest of this collapsible card.
  const [candidates, setCandidates] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [managerBusy, setManagerBusy] = useState(false);

  // League-level "Open For Registration" toggle + League Interests bulk
  // assignment - see server/src/index.js's "---------- Open leagues
  // ----------" block. Interested players are listed here with checkboxes
  // plus a division picker, so a League Manager can split e.g. 10
  // interested players across several divisions in a few clicks rather
  // than adding each one individually. This is the only self-service join
  // mechanism left in the app - the older division-level "Is Open"/Join
  // Requests feature was removed (see claude/join-requests-removal doc in
  // the project) in favour of this league-level flow.
  //
  // Each pending interest also carries the requester's payment-wall status
  // (server-side, GET /api/leagues/:id/league-interests joins against
  // db.leaguePayments) with inline Confirm/Waive/Reset controls - folded in
  // from what used to be a separate "Players" list under the Payment Wall
  // panel, so a manager clears payment right where they decide who to
  // place, instead of jumping between two lists. Deliberately pending-only:
  // bulk-assign already calls assertPaymentCleared before adding anyone to
  // a division, so an assigned player's payment is cleared by definition -
  // there's nothing left to manage for them here.
  const [leagueOpenBusy, setLeagueOpenBusy] = useState(false);
  const [leagueInterests, setLeagueInterests] = useState([]);
  const [selectedInterestIds, setSelectedInterestIds] = useState([]);
  const [assignDivisionId, setAssignDivisionId] = useState('');
  const [interestBusy, setInterestBusy] = useState(false);
  // Per-item failures from the last bulk-assign attempt (e.g. a selected
  // player hasn't cleared the league's payment wall) - shown as a red
  // notice directly under the "Add ... selected to division" button rather
  // than the page-level error banner, since bulk-assign returns 200 with a
  // per-item results array (see server's POST /api/league-interests/bulk-
  // assign) instead of throwing, so these were previously swallowed
  // silently by onBulkAssign below.
  const [assignFailures, setAssignFailures] = useState([]);

  useEffect(() => {
    if (!open || !isAdmin) return;
    api.adminListUsers().then(setCandidates).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdmin]);

  const loadLeagueInterests = () => {
    api.getLeagueInterests(league.id).then(setLeagueInterests).catch((e) => setError(e.message));
  };

  useEffect(() => {
    if (!open || !canManage) return;
    loadLeagueInterests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canManage, league.id]);

  const onToggleLeagueOpen = async (isOpenForRegistration) => {
    setLeagueOpenBusy(true);
    setError('');
    try {
      await api.setLeagueOpen(league.id, isOpenForRegistration);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setLeagueOpenBusy(false);
    }
  };

  const toggleInterestSelected = (id) => {
    setSelectedInterestIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const onDeclineInterest = async (id) => {
    setInterestBusy(true);
    setError('');
    try {
      await api.declineLeagueInterest(id);
      setSelectedInterestIds((ids) => ids.filter((x) => x !== id));
      loadLeagueInterests();
    } catch (err) {
      setError(err.message);
    } finally {
      setInterestBusy(false);
    }
  };

  // Confirm/waive/reset a requester's payment status right from their
  // League Interests row - see the block comment above for why this lives
  // here instead of a separate Payment Wall players list.
  const onSetInterestPayment = async (playerId, status) => {
    setInterestBusy(true);
    setError('');
    try {
      await api.setLeaguePaymentStatus(league.id, playerId, status);
      loadLeagueInterests();
    } catch (err) {
      setError(err.message);
    } finally {
      setInterestBusy(false);
    }
  };

  const onBulkAssign = async () => {
    if (selectedInterestIds.length === 0 || !assignDivisionId) return;
    setInterestBusy(true);
    setError('');
    setAssignFailures([]);
    try {
      const res = await api.bulkAssignLeagueInterests(selectedInterestIds, assignDivisionId);
      const results = res?.results || [];
      const succeededIds = results.filter((r) => r.ok).map((r) => r.interestId);
      // Only drop the ones that succeeded from the selection - a failed one
      // (e.g. unpaid) stays selected/visible so the manager can see exactly
      // who still needs sorting out before trying again. The server's error
      // message already names the player (see assertPaymentCleared), so
      // there's no need to re-look-up the interest here.
      setSelectedInterestIds((ids) => ids.filter((id) => !succeededIds.includes(id)));
      setAssignFailures(results.filter((r) => !r.ok).map((r) => r.error));
      loadLeagueInterests();
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setInterestBusy(false);
    }
  };

  const managers = candidates.filter((u) => (league.managerUserIds || []).includes(u.id));
  const eligible = candidates.filter((u) => u.isLeagueManager && !(league.managerUserIds || []).includes(u.id));

  const onAddManager = async (e) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setManagerBusy(true);
    setError('');
    try {
      await api.addLeagueManager(league.id, selectedUserId);
      setSelectedUserId('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setManagerBusy(false);
    }
  };

  const onRemoveManager = async (userId) => {
    setManagerBusy(true);
    setError('');
    try {
      await api.removeLeagueManager(league.id, userId);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setManagerBusy(false);
    }
  };

  const onCloseEarly = async () => {
    setClosing(true);
    setError('');
    try {
      await api.closeLeagueEarly(league.id);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(false);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await api.deleteLeague(league.id);
      navigate('/');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Admin: Manage this League</h2>
        <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          {canCloseEarly && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>Close League Early</h3>
              <p className="muted">
                Force-completes every outstanding fixture across <strong>every division</strong> in this
                league at 0-0, with no winner - no confirmation from either side is needed. Use this to end
                the whole league's season early rather than closing each division one at a time. This can't
                be undone.
              </p>
              <button className="btn btn-primary" type="button" disabled={closing} onClick={onCloseEarly}>
                {closing ? 'Closing…' : 'Close the whole league now'}
              </button>
            </div>
          )}

          {isAdmin && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>League Managers</h3>
              <p className="muted">
                League Managers get the same day-to-day access as an Overall Admin for this one league
                (entrants, tables, payments, fixtures, closing it early, and deleting the league or a division
                within it) - but can never manage who else has access. Grant the League Manager flag on an
                account's profile first (Admin Portal &rarr; Users) before assigning them here.
              </p>
              {managers.length === 0 ? (
                <p className="muted">No League Managers assigned to this league yet.</p>
              ) : (
                <ul className="fixture-list">
                  {managers.map((m) => (
                    <li key={m.id}>
                      <span>{m.firstName} {m.lastName} <span className="muted">({m.email})</span></span>
                      <button className="btn" type="button" disabled={managerBusy} onClick={() => onRemoveManager(m.id)}>
                        Remove access
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="inline-form" onSubmit={onAddManager}>
                <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                  <option value="">Select a League Manager to add…</option>
                  {eligible.map((u) => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
                  ))}
                </select>
                <button className="btn btn-primary" type="submit" disabled={managerBusy || !selectedUserId}>
                  Grant access
                </button>
              </form>
              {eligible.length === 0 && candidates.length > 0 && (
                <p className="muted">
                  Nobody is flagged as a League Manager yet - grant that flag on an account first from Admin
                  Portal &rarr; Users.
                </p>
              )}
            </div>
          )}

          {canManage && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>League Interests</h3>
              <p className="muted">
                League-level version of "Is Open" - when this league is open for interest registration,
                any registered player can register interest from the <Link to="/open-leagues">Open
                Leagues</Link> page without picking a division. Select who you're ready to place, pick a
                division to put them in, and add them in bulk - repeat for as many divisions as you like.
                {league.payment?.required && ' If this league has a payment wall, confirm or waive each player’s payment below before adding them.'}
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={!!league.isOpenForRegistration}
                  disabled={leagueOpenBusy}
                  onChange={(e) => onToggleLeagueOpen(e.target.checked)}
                />
                {league.isOpenForRegistration ? 'Open for interest registration' : 'Closed to interest registration'}
              </label>
              {leagueInterests.length === 0 ? (
                <p className="muted">No pending interest registrations for this league right now.</p>
              ) : (
                <>
                  <ul className="fixture-list">
                    {leagueInterests.map((r) => (
                      <li key={r.id}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            checked={selectedInterestIds.includes(r.id)}
                            disabled={interestBusy}
                            onChange={() => toggleInterestSelected(r.id)}
                          />
                          {r.playerName}
                          {league.payment?.required && (
                            <span className="muted" style={{ fontSize: '0.8rem' }}>
                              (<strong>{r.paymentStatus}</strong>)
                            </span>
                          )}
                        </label>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {league.payment?.required && (
                            <>
                              {r.paymentStatus !== 'confirmed' && (
                                <button
                                  className="btn-link"
                                  type="button"
                                  disabled={interestBusy}
                                  onClick={() => onSetInterestPayment(r.playerId, 'confirmed')}
                                >
                                  confirm paid
                                </button>
                              )}
                              {r.paymentStatus !== 'waived' && (
                                <button
                                  className="btn-link"
                                  type="button"
                                  disabled={interestBusy}
                                  onClick={() => onSetInterestPayment(r.playerId, 'waived')}
                                >
                                  waive
                                </button>
                              )}
                              {r.paymentStatus !== 'unpaid' && (
                                <button
                                  className="btn-link"
                                  type="button"
                                  disabled={interestBusy}
                                  onClick={() => onSetInterestPayment(r.playerId, 'unpaid')}
                                >
                                  reset
                                </button>
                              )}
                            </>
                          )}
                          <button
                            className="btn"
                            type="button"
                            disabled={interestBusy}
                            onClick={() => onDeclineInterest(r.id)}
                          >
                            Decline
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="inline-form">
                    <select value={assignDivisionId} onChange={(e) => setAssignDivisionId(e.target.value)}>
                      <option value="">Select a division to add them to…</option>
                      {league.divisions
                        .filter((d) => d.entryType === 'singles' && !d.fixturesGenerated)
                        .map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                    </select>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={interestBusy || selectedInterestIds.length === 0 || !assignDivisionId}
                      onClick={onBulkAssign}
                    >
                      {interestBusy ? 'Adding…' : `Add ${selectedInterestIds.length || ''} selected to division`}
                    </button>
                  </div>
                  {assignFailures.length > 0 && (
                    <p className="error" style={{ marginTop: 8 }}>
                      {assignFailures.join(' ')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {canManage && (
            <div>
              <h3 style={{ marginBottom: '0.25rem' }}>Delete League</h3>
              <p className="muted">
                Permanently deletes <strong>{league.name}</strong> and everything in it - every division,
                fixture, team and pairing, plus its roll-of-honour history. This cannot be undone. To
                confirm, type the league's name below.
              </p>
              <label>
                League name
                <input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={league.name}
                />
              </label>
              <button
                className="btn btn-danger"
                type="button"
                disabled={deleting || confirmName.trim() !== league.name}
                onClick={onDelete}
              >
                {deleting ? 'Deleting…' : 'Delete this league permanently'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function LeagueDetail() {
  const { isAdmin, canManageLeague } = useAuth();
  const { leagueId } = useParams();
  const [league, setLeague] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [entryType, setEntryType] = useState('singles');
  const [legsPerMatch, setLegsPerMatch] = useState(5);
  const [pairingSize, setPairingSize] = useState(2);
  const [scheduling, setScheduling] = useState('round_robin_single');
  // Match length for this division - see LeagueList.jsx's old create-league
  // form (removed) for why raceTo/bestOf are offered as two ways to express
  // the same underlying number; only the resulting raceTo is ever sent.
  const [formatMode, setFormatMode] = useState('raceTo');
  const [formatValue, setFormatValue] = useState(6);
  // Killer Classic / Cards Killer only - replaces Match format/Race to,
  // which don't apply to a lives-based free-for-all game. See
  // server/src/services/killer.js.
  const [startingLives, setStartingLives] = useState(3);
  const [showForm, setShowForm] = useState(false);

  const isKiller = scheduling === 'killer_classic' || scheduling === 'cards_killer';
  const isFreePlay = scheduling === 'free_play';

  const onSchedulingChange = (value) => {
    setScheduling(value);
    // No fixed sides in a free-for-all/2-player game - see the
    // KILLER_TYPES/FREE_PLAY comments in server/src/index.js.
    if (value === 'killer_classic' || value === 'cards_killer' || value === 'free_play') setEntryType('singles');
  };

  useSetBreadcrumbs(
    league
      ? [{ label: 'Home', to: '/' }, { label: league.name }]
      : [{ label: 'Home', to: '/' }, { label: 'Loading…' }]
  );

  const load = () => api.getLeague(leagueId).then(setLeague).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId]);

  const onAddDivision = async (e) => {
    e.preventDefault();
    setError('');
    // Killer Classic/Cards Killer have no per-match frame race - Match
    // format/Race to are skipped entirely and startingLives is sent instead.
    // Free Play has no frame count target at all, so Match format/Race to
    // are skipped there too and nothing replaces them.
    let raceTo;
    if (!isKiller && !isFreePlay) {
      const numericFormatValue = Number(formatValue);
      if (formatMode === 'bestOf') {
        if (!Number.isInteger(numericFormatValue) || numericFormatValue < 1 || numericFormatValue % 2 === 0) {
          setError('Best of (frames) must be an odd whole number - e.g. 3, 5, 7, 9, 11');
          return;
        }
        raceTo = (numericFormatValue + 1) / 2;
      } else {
        if (!Number.isInteger(numericFormatValue) || numericFormatValue < 1) {
          setError('Race to (frames) must be a whole number of 1 or more');
          return;
        }
        raceTo = numericFormatValue;
      }
    } else if (!Number.isInteger(Number(startingLives)) || Number(startingLives) < 1) {
      setError('Starting lives must be a whole number of 1 or more');
      return;
    }
    try {
      await api.createDivision(leagueId, {
        name,
        order: league.divisions.length,
        entryType,
        scheduling,
        ...(isKiller ? { startingLives: Number(startingLives) } : { raceTo }),
        ...(entryType === 'teams' ? { legsPerMatch: Number(legsPerMatch) } : {}),
        ...(entryType === 'doubles' ? { pairingSize: Number(pairingSize) } : {}),
      });
      setName('');
      setEntryType('singles');
      setLegsPerMatch(5);
      setPairingSize(2);
      setScheduling('round_robin_single');
      setFormatMode('raceTo');
      setFormatValue(6);
      setStartingLives(3);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!league) return <p>Loading…</p>;

  const canManage = canManageLeague(league);

  return (
    <div>
      <p><Link to="/">&larr; All leagues</Link></p>
      <div className="page-header">
        <div>
          <h1>{league.name}</h1>
          <p className="muted">
            {league.sport}
          </p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New Division'}
          </button>
        )}
      </div>

      {showForm && canManage && (
        <form className="card form" onSubmit={onAddDivision}>
          <label>
            Division name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Division 1" required />
          </label>
          <label>
            Entry type
            <select value={entryType} onChange={(e) => setEntryType(e.target.value)} disabled={isKiller || isFreePlay}>
              {isKiller ? (
                <option value="singles">Singles (one player at a time, everyone in the game together)</option>
              ) : isFreePlay ? (
                <option value="singles">Singles (one player vs one player)</option>
              ) : (
                <>
                  <option value="singles">Singles (one player vs one player)</option>
                  <option value="teams">Teams (team vs team, made up of legs)</option>
                  <option value="doubles">Doubles/Triples (2-3 player pairing vs pairing, alternate-shot)</option>
                </>
              )}
            </select>
            {isKiller && (
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                Killer Classic/Cards Killer are free-for-all games with no fixed sides, so this is locked to Singles.
              </span>
            )}
            {isFreePlay && (
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                Free Play is a 2-player game, so this is locked to Singles.
              </span>
            )}
          </label>
          {entryType === 'teams' && !isKiller && !isFreePlay && (
            <label>
              Legs per match
              <input
                type="number"
                min="1"
                value={legsPerMatch}
                onChange={(e) => setLegsPerMatch(e.target.value)}
                required
              />
            </label>
          )}
          {entryType === 'doubles' && !isKiller && !isFreePlay && (
            <label>
              Players per pairing
              <select value={pairingSize} onChange={(e) => setPairingSize(e.target.value)}>
                <option value={2}>2 (doubles)</option>
                <option value={3}>3 (triples)</option>
              </select>
            </label>
          )}
          <label>
            Format
            <select value={scheduling} onChange={(e) => onSchedulingChange(e.target.value)}>
              <option value="round_robin_single">Standard League - Single Leg (Everyone plays each other once)</option>
              <option value="round_robin_double">Standard League - Double Leg (Everyone plays each other twice, home and away)</option>
              <option value="knockout_single_elim">Knockout (single elimination)</option>
              <option value="knockout_double_elim">Knockout (double elimination)</option>
              <option value="killer_classic">Killer Classic (Players play in order)</option>
              <option value="cards_killer">Killer Random (Player order randomised on each turn)</option>
              <option value="free_play">Free Play (2 player free style, no frame count target)</option>
            </select>
          </label>
          {isKiller ? (
            <label>
              Starting lives
              <input
                type="number"
                min="1"
                value={startingLives}
                onChange={(e) => setStartingLives(e.target.value)}
                required
              />
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                Every player starts the game with this many lives (3 tally marks in both rule sheets) - there's no
                per-match race to a number of frames in {scheduling === 'cards_killer' ? 'Cards Killer' : 'Killer Classic'},
                so Match format/Race to don't apply.
              </span>
            </label>
          ) : isFreePlay ? (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Free Play has no frame count target, so Match format/Race to don't apply - frames are still recorded
              one at a time, and either player can finish the match themselves whenever the scores aren't level.
            </p>
          ) : (
            <>
              <label>
                Match format
                <select
                  value={formatMode}
                  onChange={(e) => setFormatMode(e.target.value)}
                >
                  <option value="raceTo">Race to (frames)</option>
                  <option value="bestOf">Best of (frames)</option>
                </select>
              </label>
              <label>
                {formatMode === 'bestOf' ? 'Best of (frames)' : 'Race to (frames)'}
                <input
                  type="number"
                  min="1"
                  step={formatMode === 'bestOf' ? 2 : 1}
                  value={formatValue}
                  onChange={(e) => setFormatValue(e.target.value)}
                  required
                />
                {formatMode === 'bestOf' && (() => {
                  const v = Number(formatValue);
                  if (!Number.isInteger(v) || v < 1) return null;
                  return v % 2 === 0 ? (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      Best of must be an odd number, so it can't end level.
                    </span>
                  ) : (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      = Race to {(v + 1) / 2} - first to {(v + 1) / 2} frame{(v + 1) / 2 === 1 ? '' : 's'} wins the
                      match; any frames that can no longer affect the result aren't played.
                    </span>
                  );
                })()}
              </label>
            </>
          )}
          <button className="btn btn-primary" type="submit">
            Add Division
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Link className="btn btn-primary" to={`/arena/${league.id}`}>View Arena display &rarr;</Link>
        <Link className="btn btn-primary" to={`/public/leagues/${league.id}/table`}>View public League Table &rarr;</Link>
        <Link className="btn btn-primary" to={`/public/leagues/${league.id}/fixtures`}>View public League Fixtures &rarr;</Link>
      </p>
      {canManage && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          The two links above are live, unauthenticated pages meant to be embedded elsewhere (e.g. an
          &lt;iframe&gt; on another site) - copy either URL from your browser's address bar once you're on
          the page.
        </p>
      )}

      <div className="card-grid">
        {league.divisions.map((division) => (
          <Link key={division.id} to={`/divisions/${division.id}`} className="card card-link">
            <h2>{division.name}</h2>
            <p className="muted">
              {division.entryType === 'teams'
                ? `${division.teamIds.length} team${division.teamIds.length === 1 ? '' : 's'} · ${division.legsPerMatch} legs/match`
                : division.entryType === 'doubles'
                  ? `${division.pairingIds.length} pairing${division.pairingIds.length === 1 ? '' : 's'} · ${division.pairingSize} players/pairing`
                  : `${division.playerIds.length} player${division.playerIds.length === 1 ? '' : 's'}`}
              {' · '}
              {division.scheduling === 'knockout_single_elim'
                ? 'Knockout (single elim)'
                : division.scheduling === 'knockout_double_elim'
                  ? 'Knockout (double elim)'
                  : division.scheduling === 'knockout_double_elim_pcdek'
                    ? 'Pre Configured Double Elim Knockout'
                    : division.scheduling === 'knockout_double_elim_adek'
                      ? 'Adaptive Double Elim Knockout'
                      : division.scheduling === 'killer_classic'
                        ? 'Killer Classic'
                        : division.scheduling === 'cards_killer'
                          ? 'Cards Killer'
                          : division.scheduling === 'free_play'
                            ? 'Free Play'
                            : division.scheduling === 'round_robin_double'
                              ? 'Standard League - Double Leg'
                              : 'Standard League - Single Leg'}
              {' · '}
              {division.scheduling === 'killer_classic' || division.scheduling === 'cards_killer'
                ? (division.killer?.status === 'finished' ? 'game finished' : division.killer?.status === 'in_progress' ? 'game in progress' : 'not started')
                : division.fixturesGenerated ? 'fixtures generated' : 'not started'}
              {division.status === 'completed' && ' · season complete'}
            </p>
          </Link>
        ))}
      </div>

      {canManage && <TablesPanel league={league} onChange={load} setError={setError} />}

      {canManage && <PaymentsPanel league={league} onChange={load} setError={setError} />}

      {canManage && (
        <ManageLeaguePanel
          league={league}
          isAdmin={isAdmin}
          canManage={canManage}
          canCloseEarly={league.divisions.some((d) => d.fixturesGenerated && d.status !== 'completed')}
          onChange={load}
          setError={setError}
        />
      )}
    </div>
  );
}
