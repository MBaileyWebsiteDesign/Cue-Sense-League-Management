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
      });
      setForm({ name: '' });
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
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: -8 }}>
            Match format (race to / best of) is now set per division once the league's divisions are
            created, since different divisions in the same league can play to different lengths.
          </p>
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
              style={{ minHeight: 80, width: '100%' }}
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
          </Link>
        ))}
        {leagues.length === 0 && <p className="muted">No leagues yet. Create one to get started.</p>}
      </div>
    </div>
  );
}
