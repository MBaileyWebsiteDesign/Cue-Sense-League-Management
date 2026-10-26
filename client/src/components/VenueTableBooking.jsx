import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './tableBooking.css';

// Venue Manager / Overall Admin panel for the in-app table booking system
// (Matt, 2026-10-26): switch on/off, weekly opening hours, limits, and a day
// view per table with walk-ins and blocks. Not for Wix-linked venues (Top Spin).
const DAYS = [
  { k: '1', l: 'Monday' }, { k: '2', l: 'Tuesday' }, { k: '3', l: 'Wednesday' }, { k: '4', l: 'Thursday' },
  { k: '5', l: 'Friday' }, { k: '6', l: 'Saturday' }, { k: '0', l: 'Sunday' },
];
const pad = (n) => String(n).padStart(2, '0');
const times = (fromMin, toMin) => { const out = []; for (let m = fromMin; m <= toMin; m += 30) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`); return out; };
const OPEN_OPTS = times(0, 23 * 60 + 30);
const CLOSE_OPTS = [...times(30, 23 * 60 + 30), '24:00'];
const LEN_OPTS = Array.from({ length: 16 }, (_, i) => (i + 1) * 30);
const lenLabel = (mins) => { const h = Math.floor(mins / 60); const m = mins % 60; return h === 0 ? `${m} min` : m === 0 ? `${h} hr` : `${h} hr ${m} min`; };
const todayUk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export default function VenueTableBooking({ venueId }) {
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [day, setDay] = useState(todayUk());
  const [dayData, setDayData] = useState(null);
  const [tick, setTick] = useState(0);
  const [kind, setKind] = useState('walkin');
  const [add, setAdd] = useState({ type: '', table: '', start: '18:00', minutes: 60, name: '', note: '', allTables: false });
  const [adding, setAdding] = useState(false);

  const load = () => api.getVenueTableBooking(venueId).then((r) => {
    setInfo(r);
    setForm({ ...r.settings, hours: { ...r.settings.hours } });
    setAdd((a) => ({ ...a, type: a.type || (r.types[0] ? r.types[0].key : '') }));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const enabled = !!(info && info.settings.enabled);
  useEffect(() => {
    if (!enabled) { setDayData(null); return; }
    api.getVenueTableDay(venueId, day).then(setDayData).catch((e) => setError(e.message));
  }, [venueId, day, enabled, tick]);

  if (!info || !form) return error ? <p className="error">{error}</p> : null;

  const toggle = async (next) => {
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await api.saveVenueTableBooking(venueId, { enabled: next });
      setInfo((i) => ({ ...i, settings: r.settings }));
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const saveSettings = async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await api.saveVenueTableBooking(venueId, { hours: form.hours, maxMinutes: Number(form.maxMinutes), maxDaysAhead: Number(form.maxDaysAhead), maxActive: Number(form.maxActive) });
      setInfo((i) => ({ ...i, settings: r.settings }));
      setForm({ ...r.settings, hours: { ...r.settings.hours } });
      setNotice('Booking settings saved.');
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const setHours = (k, patch) => setForm((f) => ({ ...f, hours: { ...f.hours, [k]: patch === null ? null : { ...(f.hours[k] || { open: '10:00', close: '23:00' }), ...patch } } }));

  const submitAdd = async () => {
    setAdding(true); setError(''); setNotice('');
    try {
      await api.addVenueTableBooking({
        venueId, type: add.type, tableNumber: add.table === '' ? undefined : Number(add.table),
        start: `${day}T${add.start}`, minutes: Number(add.minutes), kind,
        name: kind === 'walkin' ? add.name : undefined, note: kind === 'block' ? add.note : undefined,
        allTables: kind === 'block' ? add.allTables : undefined,
      });
      setNotice(kind === 'block' ? 'Blocked.' : 'Walk-in booked.');
      setTick((t) => t + 1);
    } catch (e) { setError(e.message); } finally { setAdding(false); }
  };
  const cancelBooking = async (b) => {
    if (!window.confirm(`Cancel ${b.who} ${b.startTime}–${b.endTime}?`)) return;
    setError(''); setNotice('');
    try { await api.cancelVenueTableBooking(b.id); setTick((t) => t + 1); } catch (e) { setError(e.message); }
  };

  const typeTables = (dayData ? dayData.tables : []).filter((t) => t.type === add.type);

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band"><span className="vm-bk-band-title"><h2>Table booking</h2></span></div>
      <div className="vm-panel-body">
        {info.wixLinked ? (
          <p className="muted">This venue uses the Wix booking system, so the in-app table booking is not available here.</p>
        ) : (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => toggle(e.target.checked)}
                style={{ width: 22, height: 22, minHeight: 0, margin: 0, padding: 0, flex: '0 0 auto', accentColor: 'var(--primary)' }} />
              <span>Let members book tables here</span>
            </label>
            {info.types.length === 0 && <p className="muted vm-small">Add the number of tables first (Tables card above).</p>}
            {error && <p className="error">{error}</p>}
            {notice && <p className="banner banner-success">{notice}</p>}

            <h3 style={{ margin: '14px 0 6px', fontSize: '0.95rem' }}>Opening hours for booking (UK time)</h3>
            {DAYS.map((d) => {
              const h = form.hours[d.k];
              return (
                <div className="tb-hours" key={d.k}>
                  <span>{d.l}</span>
                  <input type="checkbox" aria-label={`${d.l} open`} checked={!!h} onChange={(e) => setHours(d.k, e.target.checked ? {} : null)}
                    style={{ width: 22, height: 22, minHeight: 0, margin: 0, accentColor: 'var(--primary)' }} />
                  <select className="mm-input" disabled={!h} value={h ? h.open : '10:00'} onChange={(e) => setHours(d.k, { open: e.target.value })}>
                    {OPEN_OPTS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select className="mm-input" disabled={!h} value={h ? h.close : '23:00'} onChange={(e) => setHours(d.k, { close: e.target.value })}>
                    {CLOSE_OPTS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              );
            })}
            <div className="tb-row2" style={{ marginTop: 10 }}>
              <label className="ll-field">Longest booking
                <select className="mm-input" value={form.maxMinutes} onChange={(e) => setForm((f) => ({ ...f, maxMinutes: e.target.value }))}>
                  {LEN_OPTS.map((m) => <option key={m} value={m}>{lenLabel(m)}</option>)}
                </select>
              </label>
              <label className="ll-field">Days ahead
                <input className="mm-input" type="number" min="1" max="90" value={form.maxDaysAhead} onChange={(e) => setForm((f) => ({ ...f, maxDaysAhead: e.target.value }))} />
              </label>
              <label className="ll-field">Active bookings per player
                <input className="mm-input" type="number" min="1" max="20" value={form.maxActive} onChange={(e) => setForm((f) => ({ ...f, maxActive: e.target.value }))} />
              </label>
            </div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving} onClick={saveSettings}>{saving ? 'Saving…' : 'Save booking settings'}</button>

            {enabled && (
              <>
                <h3 style={{ margin: '20px 0 8px', fontSize: '0.95rem' }}>Day view</h3>
                <div className="tb-daynav">
                  <button type="button" className="btn" onClick={() => setDay((d) => addDays(d, -1))}>‹</button>
                  <input className="mm-input" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 'auto' }} />
                  <button type="button" className="btn" onClick={() => setDay((d) => addDays(d, 1))}>›</button>
                  <button type="button" className="btn" onClick={() => setDay(todayUk())}>Today</button>
                </div>
                <p className="muted vm-small" style={{ margin: '0 0 8px' }}>{dayLong(day)}{dayData && dayData.hours ? ` · open ${dayData.hours.open}–${dayData.hours.close}` : dayData ? ' · closed for booking' : ''}</p>
                {dayData && dayData.tables.map((t) => (
                  <div className="tb-table" key={`${t.type}-${t.number}`}>
                    <h4>{t.label}</h4>
                    {t.bookings.length === 0 && <span className="muted vm-small">Free all day</span>}
                    {t.bookings.map((b) => (
                      <div key={b.id} className={`tb-bk${b.kind === 'block' ? ' block' : ''}`}>
                        <span><strong>{b.startTime}–{b.endTime}</strong> {b.who}{b.kind === 'walkin' ? ' (walk-in)' : ''}</span>
                        <button type="button" aria-label="Cancel booking" onClick={() => cancelBooking(b)}>✕</button>
                      </div>
                    ))}
                  </div>
                ))}

                <h3 style={{ margin: '16px 0 8px', fontSize: '0.95rem' }}>Add a walk-in or block a table ({dayLong(day)})</h3>
                <div className="tb-row2">
                  <label className="ll-field">What
                    <select className="mm-input" value={kind} onChange={(e) => setKind(e.target.value)}>
                      <option value="walkin">Walk-in booking</option>
                      <option value="block">Block out</option>
                    </select>
                  </label>
                  <label className="ll-field">Table type
                    <select className="mm-input" value={add.type} onChange={(e) => setAdd((a) => ({ ...a, type: e.target.value, table: '' }))}>
                      {info.types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="ll-field">Table
                    <select className="mm-input" value={add.table} disabled={kind === 'block' && add.allTables} onChange={(e) => setAdd((a) => ({ ...a, table: e.target.value }))}>
                      <option value="">{kind === 'walkin' ? 'Any free table' : 'Choose a table'}</option>
                      {typeTables.map((t) => <option key={t.number} value={t.number}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="ll-field">Start
                    <select className="mm-input" value={add.start} onChange={(e) => setAdd((a) => ({ ...a, start: e.target.value }))}>
                      {OPEN_OPTS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <label className="ll-field">Length
                    <select className="mm-input" value={add.minutes} onChange={(e) => setAdd((a) => ({ ...a, minutes: e.target.value }))}>
                      {LEN_OPTS.map((m) => <option key={m} value={m}>{lenLabel(m)}</option>)}
                    </select>
                  </label>
                  {kind === 'walkin' ? (
                    <label className="ll-field">Name (optional)
                      <input className="mm-input" value={add.name} maxLength={80} onChange={(e) => setAdd((a) => ({ ...a, name: e.target.value }))} />
                    </label>
                  ) : (
                    <label className="ll-field">Reason (optional)
                      <input className="mm-input" value={add.note} maxLength={120} placeholder="e.g. League night" onChange={(e) => setAdd((a) => ({ ...a, note: e.target.value }))} />
                    </label>
                  )}
                </div>
                {kind === 'block' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 0', fontSize: '0.9rem', fontWeight: 600 }}>
                    <input type="checkbox" checked={add.allTables} onChange={(e) => setAdd((a) => ({ ...a, allTables: e.target.checked }))}
                      style={{ width: 22, height: 22, minHeight: 0, margin: 0, accentColor: 'var(--primary)' }} />
                    <span>Block every table of this type</span>
                  </label>
                )}
                <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={adding || !add.type || (kind === 'block' && !add.allTables && add.table === '')} onClick={submitAdd}>
                  {adding ? 'Saving…' : kind === 'block' ? 'Block out' : 'Book walk-in'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
