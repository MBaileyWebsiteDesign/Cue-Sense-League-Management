import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Mobile layout (2026-09-23): search, category chips (from each entry's
// `action` prefix), entries grouped by day, 50 at a time with Load more.
// Same GET /api/admin/audit-log call as before.

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'results', label: 'Results', test: (a) => a.startsWith('fixture.') },
  { key: 'divisions', label: 'Divisions & rounds', test: (a) => a.startsWith('division.') || a.startsWith('league_interest.') || a.startsWith('join_request.') },
  { key: 'leagues', label: 'Leagues', test: (a) => a.startsWith('league.') },
  { key: 'accounts', label: 'Accounts', test: (a) => a.startsWith('user.') },
  { key: 'venues', label: 'Venues', test: (a) => a.startsWith('venue.') },
  { key: 'system', label: 'System', test: (a) => !/^(fixture|division|league_interest|join_request|league|user|venue)\./.test(a) },
];

const ICON = {
  results: 'M5 12l5 5 9-10',
  divisions: 'M4 6h16M4 12h16M4 18h10',
  leagues: 'M4 21V4h11l-1 4 5 1-2 5H6',
  accounts: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  venues: 'M3 21h18M5 21V8l7-5 7 5v13',
  system: 'M12 3v4M12 17v4M3 12h4M17 12h4',
};

function categoryOf(action) {
  const a = action || '';
  const hit = CATEGORIES.find((c) => c.test && c.key !== 'system' && c.test(a));
  return hit ? hit.key : 'system';
}

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

const PAGE = 50;

export default function AdminAuditLog() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');
  const [limit, setLimit] = useState(PAGE);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Audit Log' }]);

  useEffect(() => {
    api.adminGetAuditLog().then(setEntries).catch((e) => setError(e.message));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries || []).filter((e) => {
      if (cat !== 'all' && categoryOf(e.action) !== cat) return false;
      if (!q) return true;
      return `${e.actor || ''} ${e.details || ''}`.toLowerCase().includes(q);
    });
  }, [entries, query, cat]);

  const countFor = (key) => (entries || []).filter((e) => key === 'all' || categoryOf(e.action) === key).length;
  const shown = filtered.slice(0, limit);
  const groups = [];
  for (const e of shown) {
    const k = dayKey(e.at);
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, label: dayLabel(e.at), items: [] });
    groups[groups.length - 1].items.push(e);
  }

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Audit Log</h1>
        {entries && <span className="muted au-total">{entries.length} entries</span>}
      </div>
      <p className="muted mm-intro">Admin and league manager actions, most recent first.</p>
      {error && <p className="error">{error}</p>}

      <input
        type="search"
        className="ah-search"
        aria-label="Search the audit log"
        placeholder="Search by name or action"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
      />
      <div className="au-filters" role="group" aria-label="Filter by type">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`au-filter${cat === c.key ? ' au-filter-on' : ''}`}
            aria-pressed={cat === c.key}
            onClick={() => { setCat(c.key); setLimit(PAGE); }}
          >
            {c.label}
            {entries && <span className="au-filter-count">{countFor(c.key)}</span>}
          </button>
        ))}
      </div>

      {!entries ? (
        <p className="muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="card mr-empty"><strong>{entries.length === 0 ? 'No admin actions recorded yet.' : 'Nothing matches that search.'}</strong></div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.key} className="sx-day">
              <h2 className="ap-section-title">{g.label}</h2>
              <ul className="sx-log">
                {g.items.map((e) => {
                  const c = categoryOf(e.action);
                  return (
                    <li key={e.id} className="sx-log-row">
                      <span className={`sx-log-icon sx-log-${c}`} aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={ICON[c]} /></svg>
                      </span>
                      <span className="sx-log-main">
                        <span className="sx-log-top">
                          <strong>{e.actor}</strong>
                          <span className="muted sx-log-time">{new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                        </span>
                        <span className="sx-log-details">{e.details}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {filtered.length > limit && (
            <button type="button" className="btn cs-btn-block" onClick={() => setLimit((l) => l + PAGE)}>
              Load more ({filtered.length - limit} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}
