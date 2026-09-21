import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Abuse reports raised from the Player Messages feature. Overall Admins see
// every report; a League Manager sees reports for players in leagues they
// manage (filtering is enforced server-side).

function ReportCard({ report, onChanged }) {
  const [note, setNote] = useState(report.note || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const open = report.status === 'open';

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
    <section className="card" style={open ? { background: '#fee2e2' } : undefined}>
      <h2>{report.reportedName} reported by {report.reporterName}</h2>
      <p className="muted">
        {new Date(report.createdAt).toLocaleString('en-GB')}
        {report.leagueNames?.length > 0 ? ` · Shared league(s): ${report.leagueNames.join(', ')}` : ' · No shared league (admins only)'}
      </p>
      <p><strong>Reason:</strong> {report.reason}</p>
      <details>
        <summary>Conversation ({report.snapshot.length} message{report.snapshot.length === 1 ? '' : 's'})</summary>
        <div style={{ margin: '0.5rem 0' }}>
          {report.snapshot.map((m, i) => (
            <p key={i} style={{ margin: '0.25rem 0' }}>
              <strong>{m.fromName}</strong> <span className="muted">{new Date(m.createdAt).toLocaleString('en-GB')}</span>
              <br />
              <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</span>
            </p>
          ))}
        </div>
      </details>
      {error && <p className="error">{error}</p>}
      <label>
        Note
        <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="inline-form">
        {open ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('handled')}>Mark handled</button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => act('open')}>Reopen</button>
        )}
        {!open && report.handledBy && (
          <span className="muted">Handled by {report.handledBy}</span>
        )}
      </div>
    </section>
  );
}

export default function MessageReports() {
  useSetBreadcrumbs([{ label: 'Home', to: '/account' }, { label: 'Message Reports' }]);
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getMessageReports().then(setReports).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <p className="error">{error}</p>;
  if (!reports) return <p>Loading…</p>;
  const open = reports.filter((r) => r.status === 'open');
  const handled = reports.filter((r) => r.status !== 'open');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Message Reports</h1>
          <p className="muted">Abuse reports from players' private messages.</p>
        </div>
      </div>
      <h2>Open ({open.length})</h2>
      {open.length === 0 && <p className="muted">No open reports.</p>}
      {open.map((r) => <ReportCard key={r.id} report={r} onChanged={load} />)}
      {handled.length > 0 && <h2>Handled ({handled.length})</h2>}
      {handled.map((r) => <ReportCard key={r.id} report={r} onChanged={load} />)}
    </div>
  );
}
