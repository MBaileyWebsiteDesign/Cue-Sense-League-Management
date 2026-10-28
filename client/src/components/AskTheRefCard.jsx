import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './askTheRef.css';

// Player Portal "Ask the Ref" card (Matt, 2026-10-28). The player picks a
// ruleset, describes a shot and gets a ruling worked out from that ruleset's
// rules text (server/src/routes/askTheRef.js). Past questions are saved and
// shown to the player who asked them. Shown inside the owner-only sub-app gate
// in PlayerPortal.jsx until it is released to all players.
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function AskTheRefCard() {
  const supported = typeof api.getAskTheRef === 'function';
  const [rulesets, setRulesets] = useState(null);
  const [history, setHistory] = useState([]);
  const [ruleset, setRuleset] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    if (!supported) return;
    api.getAskTheRef()
      .then((r) => {
        setRulesets(r.rulesets || []);
        setHistory(r.history || []);
        setRuleset((cur) => cur || (r.rulesets && r.rulesets[0] ? r.rulesets[0].key : ''));
      })
      .catch(() => setRulesets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!supported) return null;
  if (rulesets && rulesets.length === 0) return null;

  const current = (rulesets || []).find((r) => r.key === ruleset) || null;

  async function ask() {
    setBusy(true);
    setError('');
    setLatest(null);
    try {
      const r = await api.askTheRef({ ruleset, question });
      setLatest(r.entry);
      setHistory((h) => [r.entry, ...h]);
      setQuestion('');
    } catch (e) {
      setError(e.message || 'Something went wrong - please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card atr-card">
      <h2>Ask the Ref</h2>
      <p className="muted">Describe a shot or situation and get a ruling from the rules.</p>
      {!rulesets && <p className="muted">Loading…</p>}
      {rulesets && (
        <>
          {rulesets.length > 1 ? (
            <select className="mm-input" value={ruleset} onChange={(e) => setRuleset(e.target.value)} aria-label="Ruleset">
              {rulesets.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </select>
          ) : (
            <p className="muted atr-small">Rules: {current ? current.name : ''}</p>
          )}
          <textarea
            className="mm-input atr-question"
            rows={4}
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. The table is open. I hit a yellow first and potted a red. What happens?"
            aria-label="Your question"
            disabled={busy}
          />
          <div className="atr-actions">
            <button type="button" className="btn btn-primary" disabled={busy || question.trim().length < 8 || !ruleset} onClick={ask}>
              {busy ? 'Asking the Ref…' : 'Ask the Ref'}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          {latest && (
            <div className="atr-answer" role="status">
              <strong>The Ref says</strong>
              <p>{latest.answer}</p>
            </div>
          )}
          <p className="muted atr-small">A guide to the written rules only. On the night, the referee&rsquo;s decision is final.</p>
          {history.length > 0 && (
            <details className="atr-history">
              <summary>Your past questions ({history.length})</summary>
              {history.map((h) => (
                <details key={h.id} className="atr-past">
                  <summary>{when(h.createdAt)} &middot; {h.question.length > 70 ? `${h.question.slice(0, 70)}…` : h.question}</summary>
                  <p className="atr-q">{h.question}</p>
                  <p className="atr-a">{h.answer}</p>
                </details>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
