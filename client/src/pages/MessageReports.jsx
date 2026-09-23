import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Abuse reports raised from the Player Messages feature. Overall Admins see
// every report; a League Manager sees reports for players in leagues they
// manage (filtering is enforced server-side).
//
// Mobile layout (2026-09-23): back button, Open/Handled tabs, report cards
// with the reason quoted and the conversation shown as chat bubbles (the
// reported player's messages highlighted). Same API calls as before.

function shortWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ReportCard({ report, onChanged }) {
  const [note, setNote] = useState(report.note || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showConvo, setShowConvo] = useState(false);
  const open = report.status === 'open';
  const snapshot = report.snapshot || [];

  const act = async (status) => {
    setBusy(true);
    setError('');
    try {
      await api.handleMessageReport(report.id, { status, note });
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`card mr-card${open ? ' mr-card-open' : ''}`}>
      <div className="mr-card-head">
        <span className="mr-who">
          <strong className="mr-reported">{report.reportedName}</strong>
          <span className="muted">reported by {report.reporterName}</span>
        </span>
        <span className="muted mr-when">{shortWhen(report.createdAt)}</span>
      </div>

      <div className="ol-chips">
        {report.leagueNames?.length > 0
          ? report.leagueNames.map((n) => <span key={n} className="ol-chip">{n}</span>)
          : <span className="ol-chip">No shared league (admins only)</span>}
      </div>

      <blockquote className="ga-reason">
        <span className="ga-reason-label">Reason</span>
        {report.reason}
      </blockquote>

      {snapshot.length > 0 && (
        <div className="mr-convo">
          <button type="button" className="ah-walkin-toggle" aria-expanded={showConvo} onClick={() => setShowConvo((o) => !o)}>
            <span>{showConvo ? 'Hide' : 'View'} conversation ({snapshot.length})</span>
            <span aria-hidden="true">{showConvo ? '−' : '+'}</span>
          </button>
          {showConvo && (
            <div className="mr-bubbles">
              {snapshot.map((m, i) => {
                const fromReported = m.fromName === report.reportedName;
                return (
                  <div key={i} className={`mr-msg${fromReported ? ' mr-msg-reported' : ''}`}>
                    <span className="mr-msg-meta">
                      <strong>{m.fromName}</strong> · {shortWhen(m.createdAt)}
                    </span>
                    <span className="mr-msg-body">{m.body}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {open ? (
        <>
          <label className="mr-note">
            Note <span className="muted">(optional)</span>
            <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you did or decided" />
          </label>
          <button type="button" className="btn btn-primary cs-btn-block" disabled={busy} onClick={() => act('handled')}>
            {busy ? 'Saving…' : 'Mark handled'}
          </button>
        </>
      ) : (
        <div className="mr-handled">
          <span className="mr-handled-by">
            <span className="status status-completed">Handled</span>
            {report.handledBy && <span className="muted"> by {report.handledBy}</span>}
          </span>
          {report.note && <p className="mr-handled-note">{report.note}</p>}
          <label className="mr-note">
            Note
            <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" className="btn cs-btn-block" disabled={busy} onClick={() => act('open')}>
            {busy ? 'Saving…' : 'Reopen'}
          </button>
        </div>
      )}
    </section>
  );
}

export default function MessageReports() {
  const { isAdmin } = useAuth();
  useSetBreadcrumbs([
    { label: 'Home', to: isAdmin ? '/' : '/account' },
    isAdmin ? { label: 'Admin', to: '/admin' } : { label: 'League Manager Portal', to: '/league-manager' },
    { label: 'Message Reports' },
  ]);
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('open');

  const load = () => api.getMessageReports().then(setReports).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const backTo = isAdmin ? '/admin' : '/league-manager';
  const header = (
    <>
      <div className="au-head">
        <Link to={backTo} className="msg-icon-btn" aria-label={isAdmin ? 'Back to Admin Portal' : 'Back to League Manager Portal'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Message Reports</h1>
      </div>
      <p className="muted mm-intro">Abuse reports from players' private messages.</p>
    </>
  );

  if (error) return <div className="mr-page">{header}<p className="error">{error}</p></div>;
  if (!reports) return <div className="mr-page">{header}<p className="muted">Loading…</p></div>;
  const open = reports.filter((r) => r.status === 'open');
  const handled = reports.filter((r) => r.status !== 'open');
  const shown = tab === 'open' ? open : handled;

  return (
    <div className="mr-page dv-page">
      {header}

      <div className="division-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'open'} className={`division-tab${tab === 'open' ? ' division-tab-active' : ''}`} onClick={() => setTab('open')}>
          Open ({open.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === 'handled'} className={`division-tab${tab === 'handled' ? ' division-tab-active' : ''}`} onClick={() => setTab('handled')}>
          Handled ({handled.length})
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="card mr-empty">
          <span className="mr-empty-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
          </span>
          <strong>{tab === 'open' ? 'No open reports' : 'No handled reports yet'}</strong>
          <span className="muted">{tab === 'open' ? 'Nothing to review right now.' : 'Reports you mark handled will appear here.'}</span>
        </div>
      ) : (
        shown.map((r) => <ReportCard key={r.id} report={r} onChanged={load} />)
      )}
    </div>
  );
}
