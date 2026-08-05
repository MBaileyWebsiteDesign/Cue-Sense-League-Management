import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// No breadcrumb here - this is the home page, so there's nothing useful to
// show as a trail (the shared Breadcrumbs component renders nothing when no
// page has set any crumbs, which is the desired look here).
export default function LeagueList() {
  const { isAdmin } = useAuth();
  const [leagues, setLeagues] = useState([]);
  const [error, setError] = useState('');
  // "Race to (frames)" is the raw value the server stores and every match
  // uses to decide when a fixture is done (see server/src/index.js's frame
  // recording - it already stops a match the moment one side reaches the
  // target, without playing out frames that can no longer change the
  // result). "Best of (frames)" is just a different way for an admin to
  // express the same target using how pool leagues usually talk about
  // match length ("best of 3", "best of 5"...) - best of X frames means
  // first to (X+1)/2 wins, which only makes sense for an odd X (an even
  // "best of" could end level). Whichever mode is selected, only the
  // resulting raceTo number is ever sent to the server - there's no
  // separate "format mode" stored anywhere, since the two are otherwise
  // identical once converted.
  const [form, setForm] = useState({ name: '', formatMode: 'raceTo', formatValue: 6 });
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
    const formatValue = Number(form.formatValue);
    let raceTo;
    if (form.formatMode === 'bestOf') {
      if (!Number.isInteger(formatValue) || formatValue < 1 || formatValue % 2 === 0) {
        setError('Best of (frames) must be an odd whole number - e.g. 3, 5, 7, 9, 11');
        return;
      }
      raceTo = (formatValue + 1) / 2;
    } else {
      if (!Number.isInteger(formatValue) || formatValue < 1) {
        setError('Race to (frames) must be a whole number of 1 or more');
        return;
      }
      raceTo = formatValue;
    }
    if (paymentRequired && (!paymentAmount || Number(paymentAmount) <= 0)) {
      setError('Entry fee must be a number greater than 0');
      return;
    }
    try {
      await api.createLeague({
        name: form.name,
        raceTo,
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
      });
      setForm({ name: '', formatMode: 'raceTo', formatValue: 6 });
      setPaymentRequired(false);
      setPaymentAmount('');
      setPaymentWindowStart('');
      setPaymentWindowEnd('');
      setSelectedManagerIds([]);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Leagues</h1>
        {isAdmin && (
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New League'}
          </button>
        )}
      </div>

      {showForm && isAdmin && (
        <form className="card form" onSubmit={onSubmit}>
          <label>
            League name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Top Spin Singles"
              required
            />
          </label>
          <label>
            Match format
            <select
              value={form.formatMode}
              onChange={(e) => setForm({ ...form, formatMode: e.target.value })}
            >
              <option value="raceTo">Race to (frames)</option>
              <option value="bestOf">Best of (frames)</option>
            </select>
          </label>
          <label>
            {form.formatMode === 'bestOf' ? 'Best of (frames)' : 'Race to (frames)'}
            <input
              type="number"
              min="1"
              step={form.formatMode === 'bestOf' ? 2 : 1}
              value={form.formatValue}
              onChange={(e) => setForm({ ...form, formatValue: e.target.value })}
              required
            />
            {form.formatMode === 'bestOf' && (() => {
              const v = Number(form.formatValue);
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={paymentRequired}
              onChange={(e) => setPaymentRequired(e.target.checked)}
            />
            Require payment to join this league
          </label>
          {paymentRequired && (
            <>
              <label>
                Entry fee (£)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  required
                />
              </label>
              <label>
                Payment window opens (optional)
                <input
                  type="date"
                  value={paymentWindowStart}
                  onChange={(e) => setPaymentWindowStart(e.target.value)}
                />
              </label>
              <label>
                Payment window closes (optional)
                <input
                  type="date"
                  value={paymentWindowEnd}
                  onChange={(e) => setPaymentWindowEnd(e.target.value)}
                />
              </label>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: -8 }}>
                Players can only be added to this league's divisions once their payment is confirmed or waived
                from the league page.
              </p>
            </>
          )}
          <label>
            League Manager(s) <span className="muted">(optional)</span>
            <select
              multiple
              value={selectedManagerIds}
              onChange={(e) => setSelectedManagerIds(Array.from(e.target.selectedOptions, (o) => o.value))}
              style={{ minHeight: 80 }}
            >
              {managerCandidates.map((u) => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
              ))}
            </select>
            {managerCandidates.length === 0 ? (
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                Nobody is flagged as a League Manager yet - grant that flag on an account first from Admin
                Portal &rarr; Users. This league can still be created without one and assigned a manager later.
              </span>
            ) : (
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                Hold Cmd/Ctrl (or tap each on mobile) to select more than one. They'll get the same
                day-to-day access an Overall Admin has for this league.
              </span>
            )}
          </label>
          <button className="btn btn-primary" type="submit">
            Create League
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card-grid">
        {leagues.map((league) => (
          <Link key={league.id} to={`/leagues/${league.id}`} className="card card-link">
            <h2>{league.name}</h2>
            <p className="muted">{league.sport}</p>
            <p>
              {league.format.matchFormat} · race to {league.format.raceTo} ·{' '}
              {league.format.scheduling === 'round_robin_single'
                ? 'Round Robin - Single (play once)'
                : league.format.scheduling === 'round_robin_double'
                  ? 'Round Robin - Double (home and away)'
                  : league.format.scheduling}
            </p>
          </Link>
        ))}
        {leagues.length === 0 && <p className="muted">No leagues yet. Create one to get started.</p>}
      </div>
    </div>
  );
}
