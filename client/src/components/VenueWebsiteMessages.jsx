import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Venue portal "Website messages" card (Matt, 2026-11-03): entries from the
// enquiry, newsletter and cue care forms on the venue's own website (Top Spin's
// new site - no longer Wix Forms). Server: server/src/routes/venueForms.js.
// Hidden for venues with no website address set on the Table booking card.
const KINDS = [['', 'All'], ['enquiry', 'Enquiries'], ['cuecare', 'Cue care'], ['newsletter', 'Newsletter']];
const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

export default function VenueWebsiteMessages({ venueId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [armed, setArmed] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.getVenueWebsiteMessages(venueId).then((r) => { if (live) setData(r); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [venueId, tick]);

  if (!data) return error ? <p className="error">{error}</p> : null;
  if (data.websites.length === 0 && data.entries.length === 0) return null;

  const list = data.entries.filter((e) => (!kind || e.kind === kind) && (showDone || e.status === 'new'));
  const setStatus = async (e, status) => {
    setError('');
    try { await api.setVenueWebsiteMessageStatus(e.id, status); setTick((t) => t + 1); } catch (err) { setError(err.message); }
  };
  const remove = async (e) => {
    if (armed !== e.id) { setArmed(e.id); return; }
    setError('');
    try { await api.deleteVenueWebsiteMessage(e.id); setArmed(null); setTick((t) => t + 1); } catch (err) { setError(err.message); }
  };
  const newsletterEmails = data.entries.filter((e) => e.kind === 'newsletter').map((e) => e.fields.email).filter(Boolean);

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band"><span className="vm-bk-band-title"><h2>Website messages{data.newCount ? ` (${data.newCount} new)` : ''}</h2></span></div>
      <div className="vm-panel-body">
        <p className="muted vm-small" style={{ marginTop: 0 }}>Enquiries, cue care requests and newsletter sign-ups from {data.websites.join(', ') || 'the venue website'}.</p>
        {error && <p className="error">{error}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
          {KINDS.map(([k, l]) => (
            <button key={k || 'all'} type="button" className={kind === k ? 'btn btn-primary' : 'btn'} onClick={() => setKind(k)}>{l}</button>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', marginLeft: 'auto' }}>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} style={{ width: 18, height: 18, minHeight: 0, margin: 0 }} />
            Show done
          </label>
        </div>
        {kind === 'newsletter' && newsletterEmails.length > 0 && (
          <p className="vm-small"><button type="button" className="btn" onClick={() => navigator.clipboard && navigator.clipboard.writeText(newsletterEmails.join('\n'))}>Copy all {newsletterEmails.length} newsletter emails</button></p>
        )}
        {list.length === 0 && <p className="muted">Nothing here{showDone ? '' : ' that needs doing'}.</p>}
        {list.map((e) => (
          <div key={e.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 10, padding: '10px 12px', marginBottom: 8, opacity: e.status === 'done' ? 0.65 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong>{e.kindLabel}{e.status === 'done' ? ' · done' : ''}</strong>
              <span className="muted vm-small">{when(e.createdAt)}</span>
            </div>
            <dl style={{ margin: '6px 0', display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '2px 10px', fontSize: '0.9rem' }}>
              {e.lines.map((l) => (
                <div key={l.key} style={{ display: 'contents' }}>
                  <dt className="muted">{l.label}</dt>
                  <dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {l.key === 'email' ? <a href={`mailto:${l.value}`}>{l.value}</a> : l.key === 'phone' ? <a href={`tel:${l.value.replace(/[^\d+]/g, '')}`}>{l.value}</a> : l.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {e.status === 'new'
                ? <button type="button" className="btn btn-primary" onClick={() => setStatus(e, 'done')}>Mark done</button>
                : <button type="button" className="btn" onClick={() => setStatus(e, 'new')}>Mark not done</button>}
              <button type="button" className={armed === e.id ? 'btn btn-danger' : 'btn'} onClick={() => remove(e)}>{armed === e.id ? 'Tap again to delete' : 'Delete'}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
