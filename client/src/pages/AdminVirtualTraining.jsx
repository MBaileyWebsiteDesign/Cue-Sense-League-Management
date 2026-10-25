import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import './adminVirtualTraining.css';

// Admin Portal > Virtual Training (Overall Admins only, added 2026-10-25).
// Lists every account and lets an admin switch the CueSense Virtual Training
// app on or off for it - the paywall in front of the Virtual Training card on
// My Account and the server calls behind it. Switching off keeps the player's
// stored results; they just stop being served or recorded until it is switched
// back on.

const PAGE = 50;
const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.replace(/\s+/g, ' ').trim() || u.email;
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function AdminVirtualTraining() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Virtual Training' }]);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState({});

  useEffect(() => {
    api.adminListVirtualTraining().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  }, []);

  if (users === null && !error) return <p>Loading…</p>;

  const list = users || [];
  const paidCount = list.filter((u) => u.paid).length;
  const needle = q.trim().toLowerCase();
  const visible = list.filter((u) => {
    if (filter === 'paid' && !u.paid) return false;
    if (filter === 'unpaid' && u.paid) return false;
    return !needle || `${fullName(u)} ${u.email}`.toLowerCase().includes(needle);
  });

  const toggle = async (u) => {
    if (u.paid && !window.confirm(`Switch Virtual Training off for ${fullName(u)}? Their results are kept, but they will be locked out until it is switched back on.`)) return;
    setError('');
    setBusy((b) => ({ ...b, [u.id]: true }));
    try {
      const updated = await api.adminSetVirtualTrainingAccess(u.id, !u.paid);
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy((b) => ({ ...b, [u.id]: false }));
    }
  };

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Virtual Training</h1>
        <span className="muted au-total">{paidCount} of {list.length} on</span>
      </div>
      <p className="muted vta-intro">
        Players only see their Virtual Training results, and the training app can only save results for them, while they are switched on here.
        Everyone starts off. Switching a player off keeps their results.
      </p>

      {error && <p className="error">{error}</p>}

      <input
        type="search"
        className="ah-search"
        aria-label="Find a player"
        placeholder="Find a player by name or email…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
      />
      <div className="vta-chips" role="group" aria-label="Filter players">
        {[['all', `All (${list.length})`], ['paid', `Paid (${paidCount})`], ['unpaid', `Not paid (${list.length - paidCount})`]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`vta-chip${filter === key ? ' vta-chip-on' : ''}`}
            aria-pressed={filter === key}
            onClick={() => { setFilter(key); setShown(PAGE); }}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="card sx-card">
        {visible.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No players match.</p>
        ) : (
          <ul className="mm-rows">
            {visible.slice(0, shown).map((u) => (
              <li key={u.id} className="vta-row">
                <span className="mm-row-main">
                  <strong>{fullName(u)}</strong>
                  <span className="muted vta-sub">{u.email}</span>
                  <span className="muted vta-sub">
                    {u.paid ? `On since ${when(u.since)}` : 'Off'}
                    {u.eventCount > 0 ? ` · ${u.eventCount} results, last played ${when(u.lastPlayedAt)}` : ''}
                    {u.status === 'suspended' ? ' · account suspended' : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className={`btn dv-small-btn ${u.paid ? 'btn-danger' : 'btn-primary'}`}
                  disabled={!!busy[u.id]}
                  onClick={() => toggle(u)}
                >
                  {busy[u.id] ? '…' : u.paid ? 'Switch off' : 'Switch on'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {visible.length > shown && (
          <button type="button" className="btn cs-btn-block" onClick={() => setShown(shown + PAGE)}>
            Show more ({visible.length - shown} left)
          </button>
        )}
      </section>
    </div>
  );
}
