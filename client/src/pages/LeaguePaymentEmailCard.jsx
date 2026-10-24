import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// "Payment request email" card on the League Interests page (Matt, 2026-10-14).
// Holds the league's bank details, sends a TEST of the email to the test address
// only, then emails every player showing the red Unpaid chip below - once each.
// Server side: server/src/leaguePaymentEmail.js. The bank details live in the
// server's own list, not on the league, so they are never part of a league lookup.
// Real sending is blocked on the server until a test has been sent with the
// current details, and only works on the live app.
// Chasing (2026-10-24): a second block sends a REMINDER version to unpaid players who
// were already emailed - the ticked players on the page, or everyone due. A player
// emailed in the last 24 hours is skipped. Needs its own reminder test first.

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function fmtMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
}

const fieldStyle = { width: '100%', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '0.85rem', fontWeight: 600, margin: '10px 0 4px' };

export default function LeaguePaymentEmailCard({ leagueId, refreshKey, selectedIds = [], onChased }) {
  const [st, setSt] = useState(null);
  const [form, setForm] = useState({ accountName: '', accountNumber: '', sortCode: '' });
  const formInit = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [armed, setArmed] = useState(false);
  const [chaseArmed, setChaseArmed] = useState(null);
  const wasRunning = useRef(false);

  const load = () => api.getLeaguePaymentEmail(leagueId)
    .then((s) => {
      setSt(s);
      if (!formInit.current) {
        formInit.current = true;
        setForm({ accountName: s.bank.accountName, accountNumber: s.bank.accountNumber, sortCode: s.bank.sortCode });
      }
    })
    .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId, refreshKey]);

  const running = !!st?.job?.running;
  useEffect(() => {
    if (!running) {
      // A run just finished: let the page reload so the 'last chased' notes update.
      if (wasRunning.current && onChased) onChased();
      wasRunning.current = false;
      return undefined;
    }
    wasRunning.current = true;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, leagueId]);

  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    if (!chaseArmed) return undefined;
    const t = setTimeout(() => setChaseArmed(null), 6000);
    return () => clearTimeout(t);
  }, [chaseArmed]);

  if (!st) return error ? <p className="error">{error}</p> : null;

  if (!st.payment.required) {
    return (
      <section className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Payment request email</h2>
        <p className="muted" style={{ margin: 0 }}>Turn on this league's payment wall (with an amount) to email players who haven't paid.</p>
      </section>
    );
  }

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = form.accountName.trim() !== st.bank.accountName
    || form.accountNumber.replace(/[\s-]/g, '') !== st.bank.accountNumber
    || form.sortCode.replace(/[\s-]/g, '') !== st.bank.sortCode.replace(/\s/g, '');

  const save = () => run(async () => {
    const s = await api.saveLeaguePaymentEmail(leagueId, form);
    setSt(s);
    setForm({ accountName: s.bank.accountName, accountNumber: s.bank.accountNumber, sortCode: s.bank.sortCode });
    setNote('Bank details saved.');
  });

  const sendTest = (reminder) => run(async () => {
    const r = await api.testLeaguePaymentEmail(leagueId, reminder);
    if (r.status) setSt(r.status);
    if (r.sent) setNote(`${reminder ? 'Reminder test' : 'Test'} email sent to ${r.sentTo}. Check it, then you can ${reminder ? 'chase' : 'email'} the players.`);
    else setError(`The test email was not sent: ${r.error || 'unknown error'}`);
  });

  const chase = (mode) => {
    if (chaseArmed !== mode) { setChaseArmed(mode); return undefined; }
    setChaseArmed(null);
    return run(async () => {
      const r = await api.chaseLeaguePaymentEmails(leagueId, mode === 'all' ? { all: true } : { interestIds: selectedIds });
      const skipNote = r.skipped && r.skipped.length > 0 ? ` Skipped: ${r.skipped.map((s) => `${s.name} ${s.reason}`).join('; ')}.` : '';
      setNote(`Chasing ${r.total} ${r.total === 1 ? 'player' : 'players'}...${skipNote}`);
      await load();
    });
  };

  const sendAll = () => {
    if (!armed) { setArmed(true); return undefined; }
    setArmed(false);
    return run(async () => {
      const r = await api.sendLeaguePaymentEmails(leagueId);
      setNote(`Sending to ${r.total} ${r.total === 1 ? 'player' : 'players'}...`);
      await load();
    });
  };

  const c = st.counts;
  let blocker = '';
  if (dirty) blocker = 'Save the bank details first.';
  else if (!st.bank.saved) blocker = 'Enter and save the bank details first.';
  else if (!st.testSentAt) blocker = 'Send the test email first.';
  else if (!st.canSendHere) blocker = 'Emails to players only go out from the live app; on this site only the test works.';
  else if (c.toEmail === 0) blocker = 'Nobody left to email.';

  let chaseBlocker = '';
  if (dirty) chaseBlocker = 'Save the bank details first.';
  else if (!st.bank.saved) chaseBlocker = 'Enter and save the bank details first.';
  else if (!st.reminderTestSentAt) chaseBlocker = 'Send the reminder test email first.';
  else if (!st.canSendHere) chaseBlocker = 'Emails to players only go out from the live app; on this site only the tests work.';

  const job = st.job;
  const sentWord = job && job.reminder ? 'chased' : 'sent';

  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0 }}>Payment request email</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Asks players with the red Unpaid chip below to pay the {fmtMoney(st.payment.amount, st.payment.currency)} entry fee. Each player is emailed once.
      </p>

      <label style={labelStyle} htmlFor="pe-name">Account name</label>
      <input id="pe-name" style={fieldStyle} value={form.accountName} maxLength={80} disabled={busy} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
      <label style={labelStyle} htmlFor="pe-acc">Account number</label>
      <input id="pe-acc" style={fieldStyle} inputMode="numeric" value={form.accountNumber} disabled={busy} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
      <label style={labelStyle} htmlFor="pe-sort">Sort code</label>
      <input id="pe-sort" style={fieldStyle} inputMode="numeric" value={form.sortCode} disabled={busy} onChange={(e) => setForm({ ...form, sortCode: e.target.value })} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn" disabled={busy || !dirty} onClick={save}>Save details</button>
        <button type="button" className="btn" disabled={busy || running || dirty || !st.bank.saved} onClick={() => sendTest(false)}>Send test to {st.testRecipient}</button>
        <button type="button" className="btn" disabled={busy || running || dirty || !st.bank.saved} onClick={() => sendTest(true)}>Send reminder test</button>
      </div>
      <p className="muted" style={{ margin: '8px 0 0' }}>
        {st.testSentAt ? `Test sent ${fmtWhen(st.testSentAt)}.` : 'Test not sent yet.'}
        {' '}
        {st.reminderTestSentAt ? `Reminder test sent ${fmtWhen(st.reminderTestSentAt)}.` : 'Reminder test not sent yet.'}
        {' '}Changing the bank details means testing again.
      </p>

      <hr style={{ margin: '14px 0', border: 0, borderTop: '1px solid #e5e7eb' }} />

      <p style={{ margin: '0 0 6px' }}>
        <strong>{c.toEmail}</strong> to email now &middot; {c.alreadyEmailed} already emailed &middot; {c.skipped} can't be emailed
      </p>
      {c.skipped > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary className="muted">Who can't be emailed (no real email address)</summary>
          <p className="muted" style={{ margin: '6px 0 0' }}>{st.skippedNames.join(', ')}</p>
        </details>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || running || !!blocker}
        onClick={sendAll}
      >
        {armed ? `Tap again to email ${c.toEmail} ${c.toEmail === 1 ? 'player' : 'players'}` : `Email unpaid players (${c.toEmail})`}
      </button>
      {blocker && <p className="muted" style={{ margin: '8px 0 0' }}>{blocker}</p>}

      {c.alreadyEmailed > 0 && (
        <>
          <hr style={{ margin: '14px 0', border: 0, borderTop: '1px solid #e5e7eb' }} />
          <p style={{ margin: '0 0 6px' }}>
            <strong>Chase</strong>: {c.chaseable} can be chased now &middot; {c.chasedRecently} emailed in the last {st.chaseGapHours} hours
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || running || !!chaseBlocker || selectedIds.length === 0}
              onClick={() => chase('ticked')}
            >
              {chaseArmed === 'ticked'
                ? `Tap again to chase ${selectedIds.length} ${selectedIds.length === 1 ? 'player' : 'players'}`
                : `Chase ticked players (${selectedIds.length})`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || running || !!chaseBlocker || c.chaseable === 0}
              onClick={() => chase('all')}
            >
              {chaseArmed === 'all' ? `Tap again to email ${c.chaseable} again` : `Email all unpaid again (${c.chaseable})`}
            </button>
          </div>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            {chaseBlocker || 'Tick players in the list below to chase them, or email everyone who is due. Sends the reminder version of the email.'}
          </p>
        </>
      )}

      {running && job && <p style={{ margin: '10px 0 0' }}>{job.reminder ? 'Chasing' : 'Sending'}... {job.sent + job.failed.length} of {job.total}</p>}
      {!running && job && job.finishedAt && (
        <p style={{ margin: '10px 0 0' }}>
          Last run {fmtWhen(job.finishedAt)}: {job.sent} of {job.total} {sentWord}{job.failed.length > 0 ? `, ${job.failed.length} failed` : ''}.
        </p>
      )}
      {!running && job && job.failed.length > 0 && (
        <p className="error" style={{ margin: '6px 0 0' }}>
          Not sent: {job.failed.map((f) => `${f.name} (${f.error})`).join('; ')}. Press the button again to retry them.
        </p>
      )}
      {note && <p style={{ margin: '10px 0 0' }}>{note}</p>}
      {error && <p className="error" style={{ margin: '10px 0 0' }}>{error}</p>}
    </section>
  );
}
