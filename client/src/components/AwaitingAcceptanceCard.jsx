import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// "Waiting for the second player to accept" card for the Admin Portal and the
// League Manager Portal. Lists results that have been submitted (singles,
// doubles or a team leg) but not yet accepted by every player, and lets an
// Overall Admin / the league's Manager accept them on the player's behalf
// (the server allows that - see canConfirmOnBehalf in server/src/index.js, and
// each one is written to the Audit Log). Renders nothing at all when no result
// is waiting, and nothing if the list can't be loaded (or in the static demo).
export default function AwaitingAcceptanceCard() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [armed, setArmed] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    if (typeof api.adminGetFixturesAwaitingAcceptance !== 'function') return Promise.resolve();
    return api.adminGetFixturesAwaitingAcceptance()
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const keyOf = (it) => `${it.fixtureId}:${it.legNumber ?? ''}`;

  const accept = async (it) => {
    setBusy(keyOf(it));
    setError('');
    try {
      if (it.legNumber != null) await api.confirmLegResult(it.fixtureId, it.legNumber);
      else await api.confirmResult(it.fixtureId);
      setArmed(null);
      await load();
    } catch (err) {
      setError(err.message || 'Could not accept this result');
    } finally {
      setBusy(null);
    }
  };

  if (!items || items.length === 0) return null;

  const when = (iso) => (iso
    ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null);

  return (
    <section className="ap-section ap-sec-seasons" id="awaiting-acceptance">
      <h2 className="ap-section-title">Waiting for a player to accept ({items.length})</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          These results have been submitted but not accepted by every player yet. You can accept one on
          the player’s behalf - it then counts straight away. Each acceptance is recorded in the Audit Log.
        </p>
        {error && <p className="error">{error}</p>}
        <ul className="fixture-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((it) => {
            const key = keyOf(it);
            const isArmed = armed === key;
            const isBusy = busy === key;
            const waiting = (it.waitingOn || []).join(' and ');
            const submitted = [it.submittedBy && `submitted by ${it.submittedBy}`, when(it.submittedAt)].filter(Boolean).join(' · ');
            return (
              <li key={key} style={{ padding: '10px 0', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <Link to={`/fixtures/${it.fixtureId}`}><strong>{it.label}</strong></Link>
                    <div className="muted">
                      {[it.leagueName, it.divisionName, it.round != null && `Round ${it.round}`].filter(Boolean).join(' · ')}
                      {' · '}{it.scoreLabel}
                    </div>
                    <div className="muted">
                      Waiting on: <strong>{waiting || 'a player'}</strong>{submitted ? ` · ${submitted}` : ''}
                    </div>
                  </div>
                  <div className="inline-form">
                    {isArmed ? (
                      <>
                        <button className="btn btn-primary" disabled={isBusy} onClick={() => accept(it)}>
                          {isBusy ? 'Accepting…' : 'Yes, accept it'}
                        </button>
                        <button className="btn" disabled={isBusy} onClick={() => setArmed(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-primary" onClick={() => { setError(''); setArmed(key); }}>
                        Accept for {waiting || 'player'}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
