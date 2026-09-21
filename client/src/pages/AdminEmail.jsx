import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// Admin > Email: shows whether MailerSend is configured on this server, sends a
// test email to your own address and lists the most recent send attempts with
// MailerSend's answer (kept in server memory only - cleared on restart/deploy).
export default function AdminEmail() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

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
    <div>
      <div className="page-header">
        <div>
          <h1>Email</h1>
          <p className="muted">Check that Cue Sense can send email through MailerSend.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Status</h2>
        {status === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>
              MailerSend API key:{' '}
              <strong>{status.configured ? 'set on this server' : 'NOT set on this server - no email will be sent'}</strong>
            </p>
            <p className="muted">Sending as {status.fromName} &lt;{status.fromEmail}&gt;</p>
            <button type="button" className="btn btn-primary" onClick={sendTest} disabled={testing}>
              {testing ? 'Sending…' : 'Send a test email to me'}
            </button>
            {testResult && (
              <p className={testResult.sent ? 'banner banner-success' : 'error'} style={{ marginTop: 12 }}>
                {testResult.sent
                  ? `Accepted by MailerSend for ${testResult.sentTo}. Check that inbox (and spam).`
                  : `Not sent: ${testResult.error || 'unknown error'}`}
              </p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Recent sends</h2>
        {!status || status.recent.length === 0 ? (
          <p className="muted">Nothing sent since the server last started.</p>
        ) : (
          <table>
            <tbody>
              {status.recent.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="muted">{new Date(r.at).toLocaleString('en-GB')}</td>
                  <td>{r.to}</td>
                  <td>{r.subject}</td>
                  <td>{r.sent ? 'Accepted' : `Failed: ${r.error || 'unknown'}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
