import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { sortDivisionsPremierFirst } from '../divisionDisplay.js';
import LeaguePaymentEmailCard from './LeaguePaymentEmailCard.jsx';

// League Interests (manager view), reached from the "Interests" tile at the top
// of a league's page. Moved here from the "Admin: Manage this League" panel
// (2026-10-10) so a League Manager can clear payment and place players without
// opening that panel. Lists the league's pending interest registrations with
// their payment-wall status and inline Mark paid / Waive / Mark unpaid /
// Decline controls, plus bulk "add selected to a division". Same endpoints as
// before (GET /api/leagues/:id/league-interests, POST .../payments/:playerId,
// POST /api/league-interests/:id/decline, POST /api/league-interests/bulk-assign).
// Shows pending interests plus 'assigned' ones (2026-10-17): a player already in a
// division is labelled and can't be selected; one marked assigned but in no
// division (added, then removed) can be selected and added again.
// The public, unauthenticated embeddable board
// (/public/leagues/:id/interests) is unchanged and linked from here.
const STATUS_LABEL = { confirmed: 'Paid', waived: 'Waived', unpaid: 'Unpaid' };

// Payment-email note under an unpaid player's name (2026-10-24): when the last chase
// went out and how many times they've been emailed.
function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function LeagueInterests() {
  const { leagueId } = useParams();
  const { canManageLeague } = useAuth();
  const [league, setLeague] = useState(null);
  const [interests, setInterests] = useState(null);
  const [selected, setSelected] = useState([]);
  const [divisionId, setDivisionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  useSetBreadcrumbs([
    { label: 'Home', to: '/' },
    { label: league ? league.name : 'League', to: `/leagues/${leagueId}` },
    { label: 'League Interests' },
  ]);

  const loadInterests = () => api.getLeagueInterests(leagueId).then(setInterests).catch((e) => setError(e.message));

  useEffect(() => {
    api.getLeague(leagueId).then(setLeague).catch((e) => setError(e.message));
  }, [leagueId]);

  const canManage = league ? canManageLeague(league) : false;

  useEffect(() => {
    if (league && canManage) loadInterests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, canManage]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setPayment = (playerId, status) => run(async () => {
    await api.setLeaguePaymentStatus(leagueId, playerId, status);
    await loadInterests();
  });

  const decline = (id) => run(async () => {
    await api.declineLeagueInterest(id);
    setSelected((ids) => ids.filter((x) => x !== id));
    await loadInterests();
  });

  const bulkAssign = () => {
    if (selected.length === 0 || !divisionId) return;
    return run(async () => {
      setFailures([]);
      const res = await api.bulkAssignLeagueInterests(selected, divisionId);
      const results = res?.results || [];
      const succeeded = results.filter((r) => r.ok).map((r) => r.interestId);
      // Only drop the ones that succeeded - a failed one (e.g. unpaid) stays
      // selected so the manager can see who still needs sorting out.
      setSelected((ids) => ids.filter((id) => !succeeded.includes(id)));
      setFailures(results.filter((r) => !r.ok).map((r) => r.error));
      await loadInterests();
      api.getLeague(leagueId).then(setLeague).catch(() => {});
    });
  };

  const toggle = (id) => setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  if (!league) return error ? <p className="error">{error}</p> : <p>Loading…</p>;

  if (!canManage) {
    return (
      <div className="li-page">
        <p className="muted">Only this league's managers can manage interest registrations.</p>
        <p><Link to={`/leagues/${leagueId}`}>&larr; Back to {league.name}</Link></p>
      </div>
    );
  }

  const paywall = !!league.payment?.required;
  const list = interests || [];
  const isPlaced = (r) => r.status === 'assigned' && r.inDivision;
  const count = (s) => list.filter((r) => r.paymentStatus === s).length;
  const visible = paywall && filter !== 'all' ? list.filter((r) => r.paymentStatus === filter) : list;
  const divisions = sortDivisionsPremierFirst(
    (league.divisions || []).filter((d) => d.entryType === 'singles' && !d.fixturesGenerated),
  );
  const FILTERS = [
    ['all', `All ${list.length}`],
    ['unpaid', `Unpaid ${count('unpaid')}`],
    ['confirmed', `Paid ${count('confirmed')}`],
    ['waived', `Waived ${count('waived')}`],
  ];

  return (
    <div className="li-page">
      <section className="li-head">
        <Link to={`/leagues/${leagueId}`} className="lg-back">&larr; {league.name}</Link>
        <h1>League Interests</h1>
        <p>
          Players who have registered interest in {league.name}.
          {paywall ? ' Mark each one paid or waived, then add them to a division.' : ' Select players and add them to a division.'}
        </p>
        <Link to={`/public/leagues/${leagueId}/interests`} className="li-public">Public board (for embedding) &rarr;</Link>
      </section>

      {error && <p className="error">{error}</p>}

      {paywall && api.getLeaguePaymentEmail && <LeaguePaymentEmailCard leagueId={leagueId} refreshKey={interests} selectedIds={selected} onChased={loadInterests} />}

      {paywall && (
        <div className="li-filters" role="tablist" aria-label="Filter by payment">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`li-filter${filter === key ? ' li-filter-on' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!interests ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <section className="card"><p className="muted" style={{ margin: 0 }}>No pending interest registrations for this league right now.</p></section>
      ) : (
        <>
          <div className="li-bulk">
            <button type="button" className="btn-link" disabled={busy} onClick={() => setSelected(visible.filter((r) => !isPlaced(r)).map((r) => r.id))}>Select all{paywall && filter !== 'all' ? ' shown' : ''}</button>
            <button type="button" className="btn-link" disabled={busy || selected.length === 0} onClick={() => setSelected([])}>Clear</button>
            <span className="muted">{selected.length} selected</span>
          </div>
          <ul className="li-list">
            {visible.map((r) => (
              <li key={r.id} className={`li-row${paywall ? ` li-row-${r.paymentStatus}` : ''}`}>
                <label className="li-who">
                  <input type="checkbox" checked={selected.includes(r.id)} disabled={busy || isPlaced(r)} onChange={() => toggle(r.id)} />
                  <span className="li-name">{r.playerName}</span>
                  {paywall && <span className={`li-chip li-chip-${r.paymentStatus}`}>{STATUS_LABEL[r.paymentStatus] || r.paymentStatus}</span>}
                  {isPlaced(r) && <span className="li-chip">In {r.divisionName}</span>}
                  {r.status === 'assigned' && !r.inDivision && <span className="li-chip">Added earlier, not in a division</span>}
                  {paywall && r.paymentStatus === 'unpaid' && r.paymentEmailSentAt && (
                    <span className="muted" style={{ flexBasis: '100%', fontSize: '0.85rem' }}>
                      {r.paymentEmailCount > 1
                        ? `Last chased ${fmtWhen(r.paymentEmailSentAt)} \u00b7 emailed ${r.paymentEmailCount} times`
                        : `Payment email sent ${fmtWhen(r.paymentEmailSentAt)}`}
                    </span>
                  )}
                </label>
                <div className="li-actions" style={isPlaced(r) ? { display: 'none' } : undefined}>
                  {paywall && r.paymentStatus !== 'confirmed' && (
                    <button type="button" className="btn btn-primary li-btn" disabled={busy} onClick={() => setPayment(r.playerId, 'confirmed')}>Mark paid</button>
                  )}
                  {paywall && r.paymentStatus !== 'waived' && (
                    <button type="button" className="btn li-btn" disabled={busy} onClick={() => setPayment(r.playerId, 'waived')}>Waive</button>
                  )}
                  {paywall && r.paymentStatus !== 'unpaid' && (
                    <button type="button" className="btn li-btn" disabled={busy} onClick={() => setPayment(r.playerId, 'unpaid')}>Mark unpaid</button>
                  )}
                  <button type="button" className="btn li-btn li-decline" disabled={busy} onClick={() => decline(r.id)}>Decline</button>
                </div>
              </li>
            ))}
          </ul>

          <section className="li-place">
            <select value={divisionId} onChange={(e) => setDivisionId(e.target.value)} aria-label="Division to add players to">
              <option value="">Select a division to add them to…</option>
              {divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button type="button" className="btn btn-primary" disabled={busy || selected.length === 0 || !divisionId} onClick={bulkAssign}>
              {busy ? 'Working…' : `Add ${selected.length || ''} selected to division`}
            </button>
            {failures.length > 0 && <p className="error" style={{ margin: 0 }}>{failures.join(' ')}</p>}
          </section>
        </>
      )}
    </div>
  );
}
