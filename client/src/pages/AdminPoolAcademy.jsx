import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import './adminPoolAcademy.css';

// Admin Portal > Pool Academy (Overall Admins only, added 2026-10-26).
// Lists every account and lets an admin switch Pool Academy Levels 2-5 on or off
// for it - the paywall behind the Pool Academy card on My Account and the server
// calls behind it. Level 1 is always free. Switching off keeps the player's stored
// progress; Level 2-5 progress just stops being served or recorded until it is
// switched back on.

const PAGE = 50;
const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.replace(/\s+/g, ' ').trim() || u.email;
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function AdminPoolAcademy() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Pool Academy' }]);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState({});

  useEffect(() => {
    api.adminListAcademy().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
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
    if (u.paid && !window.confirm(`Switch Pool Academy Levels 2-5 off for ${fullName(u)}? Their progress is kept, but Levels 2-5 will be locked until they are switched back on.`)) return;
    setError('');
    setBusy((b) => ({ ...b, [u.id]: true }));
    try {
      const updated = await api.adminSetAcademyAccess(u.id, !u.paid);
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
        <h1>Pool Academy</h1>
        <span className="muted au-total">{paidCount} of {list.length} on</span>
      </div>
      <p className="muted vta-intro">
        Level 1 is free for everyone. Levels 2 to 5 are open to a player, and their progress there is saved, only while they are switched on here.
        Everyone starts off. Switching a player off keeps their progress.
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
                    {u.paid ? `Levels 2-5 on since ${when(u.since)}` : 'Levels 2-5 off'}
                    {u.eventCount > 0 ? ` · ${u.lessonsCompleted} ${u.lessonsCompleted === 1 ? 'lesson' : 'lessons'} done, last active ${when(u.lastActiveAt)}` : ''}
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
