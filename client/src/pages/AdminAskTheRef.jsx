import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import './askTheRef.css';

// Overall Admin view of every question players have put to "Ask the Ref"
// (2026-10-28): who asked, when, what they asked and the answer they got.
// Search by player, email, question or answer; 50 at a time.
const PAGE = 50;
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function AdminAskTheRef() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Ask the Ref' }]);

  useEffect(() => {
    if (typeof api.adminGetAskTheRef !== 'function') {
      setError('This page is not available in the demo.');
      return;
    }
    api.adminGetAskTheRef().then(setData).catch((e) => setError(e.message));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data ? data.entries : [];
    if (!q) return list;
    return list.filter((e) => `${e.playerName} ${e.email} ${e.question} ${e.answer}`.toLowerCase().includes(q));
  }, [data, query]);

  const shown = filtered.slice(0, limit);

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Ask the Ref</h1>
        {data && <span className="muted au-total">{data.total} {data.total === 1 ? 'question' : 'questions'}</span>}
      </div>
      <p className="muted mm-intro">Every question players have asked the Ref, most recent first.</p>
      {error && <p className="error">{error}</p>}
      <input
        type="search"
        className="ah-search"
        aria-label="Search the questions"
        placeholder="Search by player, question or answer"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
      />
      {!data && !error && <p className="muted">Loading…</p>}
      {data && filtered.length === 0 && (
        <div className="card mr-empty"><strong>{data.entries.length === 0 ? 'No questions have been asked yet.' : 'Nothing matches that search.'}</strong></div>
      )}
      {data && filtered.length > 0 && (
        <>
          <div className="atr-admin-list">
            {shown.map((e) => (
              <details key={e.id} className="atr-past atr-admin-item">
                <summary>
                  <span className="atr-admin-who"><strong>{e.playerName}</strong> <span className="muted">{when(e.createdAt)}</span></span>
                  <span className="atr-admin-q">{e.question.length > 90 ? `${e.question.slice(0, 90)}…` : e.question}</span>
                </summary>
                {e.email && <p className="muted atr-small">{e.email}</p>}
                <p className="atr-q">{e.question}</p>
                <p className="atr-a">{e.answer}</p>
              </details>
            ))}
          </div>
          {filtered.length > limit && (
            <button type="button" className="btn cs-btn-block" onClick={() => setLimit((l) => l + PAGE)}>
              Load more ({filtered.length - limit} left)
            </button>
          )}
          {data.total > data.entries.length && (
            <p className="muted atr-small">Showing the latest {data.entries.length} of {data.total} questions.</p>
          )}
        </>
      )}
    </div>
  );
}
