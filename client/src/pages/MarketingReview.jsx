import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

// Marketing review (Matt, 2026-10-17): the venue's Venue Manager reviews the
// Marketing Agent items copied from Wix. Approve / Dismiss only records the
// venue's decision here - nothing is published from this page.

const LONDON = 'Europe/London';
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(new Date(iso));
const dayLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
const timeLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const dateUK = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const PILL = { pending: 'Waiting', approved: 'Approved', dismissed: 'Dismissed' };
const FILTERS = [['all', 'All'], ['pending', 'Waiting'], ['approved', 'Approved'], ['dismissed', 'Dismissed']];

function Item({ item, busy, onDecide }) {
  const noText = !item.body;
  return (
    <article className={`card mk-item mk-${item.decision}`}>
      <div className="mk-meta">
        <span className="ol-chip">{item.channel}</span>
        <span className="ol-chip">{item.format}</span>
        <span className="mk-time">{timeLabel(item.scheduledFor)}</span>
        <span className={`mk-pill mk-pill-${item.decision}`}>{PILL[item.decision]}</span>
      </div>
      {item.title && <h3 className="mk-title">{item.title}</h3>}
      {noText ? (
        <p className="muted vm-small">Wix showed no caption text for this one.</p>
      ) : (
        <p className="mk-body">{item.body}</p>
      )}
      {item.truncated && <p className="muted vm-small">Wix cuts this text off in its review list, so this is only the start of it.</p>}
      {item.decision !== 'pending' && item.decidedBy && (
        <p className="muted vm-small">{PILL[item.decision]} by {item.decidedBy} on {dateUK(item.decidedAt)}</p>
      )}
      <div className="mk-actions">
        {item.decision === 'pending' ? (
          <>
            <button type="button" className="btn btn-brand-green" disabled={busy} onClick={() => onDecide(item, 'approved')}>Approve</button>
            <button type="button" className="btn cs-btn-outline" disabled={busy} onClick={() => onDecide(item, 'dismissed')}>Dismiss</button>
          </>
        ) : (
          <button type="button" className="btn cs-btn-outline" disabled={busy} onClick={() => onDecide(item, 'pending')}>Undo</button>
        )}
      </div>
    </article>
  );
}

export default function MarketingReview() {
  const { isVenueManager, isAdmin } = useAuth();
  const [params] = useSearchParams();
  const wantedVenueId = params.get('venueId') || '';
  const [venue, setVenue] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [busyId, setBusyId] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Venue Manager Portal', to: '/venue-manager' }, { label: 'Marketing review' }]);

  useEffect(() => {
    if (!isVenueManager || isAdmin) return;
    api.getMyManagedVenues()
      .then((vs) => {
        const on = vs.filter((v) => v.marketingReviewEnabled === true);
        const chosen = on.find((v) => v.id === wantedVenueId) || on[0];
        if (!chosen) { setError('Marketing review is not switched on for your venue.'); return null; }
        setVenue(chosen);
        return api.getMarketingReview(chosen.id).then(setData);
      })
      .catch((e) => setError(e.message));
  }, [isVenueManager, isAdmin, wantedVenueId]);

  const decide = async (item, decision) => {
    setBusyId(item.id);
    setError('');
    try {
      const updated = await api.decideMarketingItem(item.id, decision);
      setData((d) => ({ ...d, items: d.items.map((x) => (x.id === updated.id ? updated : x)) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId('');
    }
  };

  const items = data ? data.items : [];
  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, approved: 0, dismissed: 0 };
    items.forEach((x) => { c[x.decision] += 1; });
    return c;
  }, [items]);
  const groups = useMemo(() => {
    const out = [];
    items.filter((x) => filter === 'all' || x.decision === filter).forEach((x) => {
      const k = dayKey(x.scheduledFor);
      let g = out.find((y) => y.key === k);
      if (!g) { g = { key: k, label: dayLabel(x.scheduledFor), items: [] }; out.push(g); }
      g.items.push(x);
    });
    return out;
  }, [items, filter]);

  if (!isVenueManager || isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="sx-page portal-theme">
      <div className="au-head">
        <Link to="/venue-manager" className="msg-icon-btn" aria-label="Back to Venue Manager Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <span className="vm-title">
          <h1>Marketing review</h1>
          {venue && <span className="muted">{venue.name}</span>}
        </span>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {data && (
        <>
          <section className="card mk-banner">
            <p>
              <strong>Approving or dismissing here only records your decision.</strong> Nothing is published from this page.
              To publish, approve the item in the Wix Marketing Agent.
            </p>
            <p className="muted vm-small">
              These were copied from Wix on {data.copiedAt ? dateUK(data.copiedAt) : 'an earlier date'} and do not update by themselves.
              {data.wixUrl && <> <a href={data.wixUrl} target="_blank" rel="noreferrer">Open the Wix Marketing Agent</a></>}
            </p>
          </section>

          <div className="mk-filters" role="tablist" aria-label="Filter items">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} className={`mk-filter${filter === key ? ' is-on' : ''}`} onClick={() => setFilter(key)}>
                {label} <span className="mk-count">{counts[key]}</span>
              </button>
            ))}
          </div>

          {items.length === 0 && <p className="muted">No items have been copied across yet.</p>}
          {items.length > 0 && groups.length === 0 && <p className="muted">Nothing here.</p>}
          {groups.map((g) => (
            <section key={g.key} className="mk-day">
              <h2>{g.label}</h2>
              {g.items.map((it) => <Item key={it.id} item={it} busy={busyId === it.id} onDecide={decide} />)}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
