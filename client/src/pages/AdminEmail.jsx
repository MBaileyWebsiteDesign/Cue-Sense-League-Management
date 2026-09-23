import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Admin > Email: shows whether MailerSend is configured on this server, sends a
// test email to your own address and lists the most recent send attempts with
// MailerSend's answer (kept in server memory only - cleared on restart/deploy).
// Mobile layout 2026-09-23 - same API calls.
export default function AdminEmail() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Email' }]);

  const load = useCallback(() => {
    api.getMailStatus().then(setStatus).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const sendTest = async () => {
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      const r = await api.sendTestEmail();
      setTestResult(r);
      setStatus(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Email</h1>
      </div>
      <p className="muted mm-intro">Check that Cue Sense can send email through MailerSend.</p>
      {error && <p className="error">{error}</p>}

      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Status</h2>
          {status && (
            <span className={`status ${status.configured ? 'status-completed' : 'status-disputed'}`}>
              {status.configured ? 'Connected' : 'Not set up'}
            </span>
          )}
        </div>
        {status === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="sx-kv">
              <span className="muted">API key</span>
              <strong>{status.configured ? 'Set on this server' : 'NOT set - no email will be sent'}</strong>
            </p>
            <p className="sx-kv">
              <span className="muted">Sending as</span>
              <strong>{status.fromName} &lt;{status.fromEmail}&gt;</strong>
            </p>
            <button type="button" className="btn btn-primary cs-btn-block" onClick={sendTest} disabled={testing}>
              {testing ? 'Sending…' : 'Send a test email to me'}
            </button>
            {testResult && (
              <p className={testResult.sent ? 'banner banner-success' : 'error'} style={{ margin: 0 }}>
                {testResult.sent
                  ? `Accepted by MailerSend for ${testResult.sentTo}. Check that inbox (and spam).`
                  : `Not sent: ${testResult.error || 'unknown error'}`}
              </p>
            )}
          </>
        )}
      </section>

      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Recent sends</h2>
          {status && <span className="muted">{status.recent.length}</span>}
        </div>
        {!status || status.recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing sent since the server last started (this list clears on each deploy).</p>
        ) : (
          <ul className="sx-sends">
            {status.recent.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className="sx-send-top">
                  <strong className="sx-send-to">{r.to}</strong>
                  <span className={`status ${r.sent ? 'status-completed' : 'status-disputed'}`}>{r.sent ? 'Accepted' : 'Failed'}</span>
                </span>
                <span className="sx-send-subject">{r.subject}</span>
                <span className="muted sx-small">
                  {new Date(r.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {!r.sent && ` · ${r.error || 'unknown error'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
