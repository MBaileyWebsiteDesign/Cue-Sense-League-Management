import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// No breadcrumb here - this is the home page, so there's nothing useful to
// show as a trail (the shared Breadcrumbs component renders nothing when no
// page has set any crumbs, which is the desired look here).
export default function LeagueList() {
  const { isAdmin, user } = useAuth();
  const [leagues, setLeagues] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '' });
  const [showForm, setShowForm] = useState(false);
  // Payment wall (optional) - see the League Detail page's Payment Wall
  // panel for editing this after the league already exists.
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentWindowStart, setPaymentWindowStart] = useState('');
  const [paymentWindowEnd, setPaymentWindowEnd] = useState('');
  // League Manager assignment at creation time - see LeagueDetail.jsx's own
  // "Admin: League Managers" panel for assigning/removing these after the
  // league already exists. Only accounts already flagged isLeagueManager
  // (Admin Portal -> Users) are eligible to appear here.
  const [managerCandidates, setManagerCandidates] = useState([]);
  const [selectedManagerIds, setSelectedManagerIds] = useState([]);
  // League-level "Open For Registration" - see OpenLeagues.jsx for the
  // browse/register side and LeagueDetail.jsx's ManageLeaguePanel for the
  // toggle-after-creation and "League Interests" bulk-assign side.
  const [isOpenForRegistration, setIsOpenForRegistration] = useState(false);

  const load = () => api.getLeagues().then(setLeagues).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.adminListUsers().then((users) => setManagerCandidates(users.filter((u) => u.isLeagueManager))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (paymentRequired && (!paymentAmount || Number(paymentAmount) <= 0)) {
      setError('Entry fee must be a number greater than 0');
      return;
    }
    try {
      await api.createLeague({
        name: form.name,
        payment: paymentRequired
          ? {
              required: true,
              amount: Number(paymentAmount),
              currency: 'GBP',
              windowStart: paymentWindowStart || null,
              windowEnd: paymentWindowEnd || null,
            }
          : { required: false },
        managerUserIds: selectedManagerIds,
        isOpenForRegistration,
      });
      setForm({ name: '' });
      setPaymentRequired(false);
      setPaymentAmount('');
      setPaymentWindowStart('');
      setPaymentWindowEnd('');
      setSelectedManagerIds([]);
      setIsOpenForRegistration(false);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleManager = (id) =>
    setSelectedManagerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Real leagues first (A-Z as returned), the system Ad Hoc Games pool (only
  // ever listed for an Overall Admin - see GET /api/leagues) last.
  const sortedLeagues = [...leagues].sort((x, y) => Number(!!x.isAdHocPool) - Number(!!y.isAdHocPool));
  const realCount = leagues.filter((l) => !l.isAdHocPool).length;

  return (
    <div className="ll-page">
      <div className="ll-head">
        <h1>Leagues</h1>
        <span className="muted">{realCount} league{realCount === 1 ? '' : 's'}</span>
      </div>

      {isAdmin && (
        <button className={`btn ${showForm ? '' : 'btn-primary '}cs-btn-block ll-new`} onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ New League'}
        </button>
      )}

      {showForm && isAdmin && (
        <form className="card ll-form" onSubmit={onSubmit}>
          <h2>New league</h2>
          <label className="ll-field">
            League name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Top Spin Singles"
              required
            />
          </label>
          <p className="muted ll-note">Match format (race to / best of) is set per division once divisions are added.</p>

          <div className="dv-switch-row ll-switch">
            <span className="dv-switch-text">
              <strong>Payment required</strong>
              <span className="muted">Players can only be added to divisions once their payment is confirmed or waived.</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={paymentRequired}
              aria-label="Require payment to join this league"
              className={`cs-switch${paymentRequired ? ' cs-switch-on' : ''}`}
              onClick={() => setPaymentRequired((v) => !v)}
            >
              <span />
            </button>
          </div>
          {paymentRequired && (
            <div className="ll-sub">
              <label className="ll-field">
                Entry fee (£)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  required
                />
              </label>
              <div className="ll-dates">
                <label className="ll-field">
                  Payment opens <span className="muted">(optional)</span>
                  <input type="date" value={paymentWindowStart} onChange={(e) => setPaymentWindowStart(e.target.value)} />
                </label>
                <label className="ll-field">
                  Payment closes <span className="muted">(optional)</span>
                  <input type="date" value={paymentWindowEnd} onChange={(e) => setPaymentWindowEnd(e.target.value)} />
                </label>
              </div>
            </div>
          )}

          <div className="dv-switch-row ll-switch">
            <span className="dv-switch-text">
              <strong>Open for registration</strong>
              <span className="muted">
                Players can register interest from <Link to="/open-leagues">Open Leagues</Link>; you place them into
                divisions later. Can be changed any time.
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isOpenForRegistration}
              aria-label="Open this league for interest registration"
              className={`cs-switch${isOpenForRegistration ? ' cs-switch-on' : ''}`}
              onClick={() => setIsOpenForRegistration((v) => !v)}
            >
              <span />
            </button>
          </div>

          <fieldset className="ll-managers">
            <legend>
              League managers <span className="muted">(optional)</span>
            </legend>
            {managerCandidates.length === 0 ? (
              <p className="muted ll-note">
                Nobody is flagged as a League Manager yet - grant that on an account from Admin Portal &rarr; Users. You
                can still create the league now and assign a manager later.
              </p>
            ) : (
              <>
                <ul className="ll-manager-list">
                  {managerCandidates.map((u) => (
                    <li key={u.id}>
                      <label className="ll-manager-row">
                        <input type="checkbox" checked={selectedManagerIds.includes(u.id)} onChange={() => toggleManager(u.id)} />
                        <span className="ll-manager-text">
                          <strong>{u.firstName} {u.lastName}</strong>
                          <span className="muted">{u.email}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="muted ll-note">They get the same day-to-day access an Overall Admin has for this league.</p>
              </>
            )}
          </fieldset>

          <button className="btn btn-primary cs-btn-block" type="submit">
            Create League
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      {leagues.length === 0 ? (
        <div className="card ll-empty">
          <p><strong>No leagues yet.</strong></p>
          {isAdmin && !showForm && (
            <button className="btn btn-primary cs-btn-block" onClick={() => setShowForm(true)}>Create one</button>
          )}
        </div>
      ) : (
        <ul className="ll-list">
          {sortedLeagues.map((league) => {
            const pay = league.payment && league.payment.required
              ? league.payment.currency === 'GBP' || !league.payment.currency
                ? `£${league.payment.amount} entry`
                : `${league.payment.amount} ${league.payment.currency} entry`
              : null;
            const manages = !isAdmin && user && Array.isArray(league.managerUserIds) && league.managerUserIds.includes(user.id);
            return (
              <li key={league.id}>
                <Link to={`/leagues/${league.id}`} className={`ll-card${league.isAdHocPool ? ' ll-card-system' : ''}`}>
                  <span className="ll-card-main">
                    <strong className="ll-name">{league.name}</strong>
                    {league.sport && !league.isAdHocPool && <span className="muted ll-sport">{league.sport}</span>}
                    <span className="ol-chips">
                      {league.isAdHocPool && <span className="ol-chip">System - ad hoc games</span>}
                      {league.isOpenForRegistration && <span className="ol-chip lg-chip-open">Open for registration</span>}
                      {pay && <span className="ol-chip">{pay}</span>}
                      {manages && <span className="ol-chip ol-chip-free">You manage this</span>}
                    </span>
                  </span>
                  <svg className="ll-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
