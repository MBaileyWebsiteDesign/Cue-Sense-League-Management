import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './tableBooking.css';

// Venue Manager / Overall Admin panel for the in-app table booking system
// (Matt, 2026-10-26): switch on/off, weekly opening hours, limits, and a day
// view per table with walk-ins and blocks. A Wix-linked venue (Top Spin) can be
// moved onto it by an Overall Admin (2026-11-03), which also adds named tables
// with prices, a changeover gap, the policy / pay-at-the-bar text and booking
// from the venue's own website for non-members. Bar Staff get the day view
// only (barStaff prop, their own api object).
const DAYS = [
  { k: '1', l: 'Monday' }, { k: '2', l: 'Tuesday' }, { k: '3', l: 'Wednesday' }, { k: '4', l: 'Thursday' },
  { k: '5', l: 'Friday' }, { k: '6', l: 'Saturday' }, { k: '0', l: 'Sunday' },
];
const pad = (n) => String(n).padStart(2, '0');
const times = (fromMin, toMin) => { const out = []; for (let m = fromMin; m <= toMin; m += 30) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`); return out; };
const OPEN_OPTS = times(0, 23 * 60 + 30);
const CLOSE_OPTS = [...times(30, 23 * 60 + 30), '24:00'];
const LEN_OPTS = Array.from({ length: 16 }, (_, i) => (i + 1) * 30);
const BUFFER_OPTS = [0, 5, 10, 15, 20, 30];
const lenLabel = (mins) => { const h = Math.floor(mins / 60); const m = mins % 60; return h === 0 ? `${m} min` : m === 0 ? `${h} hr` : `${h} hr ${m} min`; };
const todayUk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export default function VenueTableBooking({ venueId, apiObj, barStaff = false }) {
  const tbApi = apiObj || api;
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

  const toForm = (st) => ({
    ...st, hours: { ...st.hours },
    tables: Object.fromEntries((st.tables || []).map((t) => [`${t.type}-${t.number}`, { label: t.label, price: t.price }])),
    guestEnabled: !!(st.guest && st.guest.enabled),
    guestOrigins: ((st.guest && st.guest.origins) || []).join('\n'),
    guestManageUrl: (st.guest && st.guest.manageUrl) || '',
  });
  const load = () => tbApi.getVenueTableBooking(venueId).then((r) => {
    setInfo(r);
    setForm(toForm(r.settings));
    setAdd((a) => ({ ...a, type: a.type || (r.types[0] ? r.types[0].key : '') }));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const enabled = !!(info && info.settings.enabled);
  useEffect(() => {
    if (!enabled) { setDayData(null); return; }
    tbApi.getVenueTableDay(venueId, day).then(setDayData).catch((e) => setError(e.message));
  }, [venueId, day, enabled, tick]);

  if (!info || !form) return error && !barStaff ? <p className="error">{error}</p> : null;
  if (barStaff && (info.wixLinked || !info.settings.enabled)) return null;

  const switchSystem = async (system) => {
    const msg = system === 'cuesense'
      ? 'Move this venue from Wix Bookings to Cue Sense table booking? Wix bookings will no longer show in the app. Set up the tables and switch booking on afterwards.'
      : 'Move this venue back to Wix Bookings? Cue Sense table booking will be switched off here.';
    if (!window.confirm(msg)) return;
    setSaving(true); setError(''); setNotice('');
    try { await api.setVenueBookingSystem(venueId, system); await load(); } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const toggle = async (next) => {
    setSaving(true); setError(''); setNotice('');
    try {
      const r = await tbApi.saveVenueTableBooking(venueId, { enabled: next });
      setInfo((i) => ({ ...i, settings: r.settings }));
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const saveSettings = async () => {
    setSaving(true); setError(''); setNotice('');
    try {
      const tables = Object.entries(form.tables).map(([k, v]) => {
        const i = k.lastIndexOf('-');
        return { type: k.slice(0, i), number: Number(k.slice(i + 1)), label: v.label, price: v.price };
      });
      const r = await tbApi.saveVenueTableBooking(venueId, {
        hours: form.hours, maxMinutes: Number(form.maxMinutes), maxDaysAhead: Number(form.maxDaysAhead), maxActive: Number(form.maxActive),
        bufferMinutes: Number(form.bufferMinutes), tables, policy: form.policy, payNote: form.payNote,
        guest: { enabled: form.guestEnabled, origins: form.guestOrigins, manageUrl: form.guestManageUrl },
      });
      setInfo((i) => ({ ...i, settings: r.settings }));
      setForm(toForm(r.settings));
      setNotice('Booking settings saved.');
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const setHours = (k, patch) => setForm((f) => ({ ...f, hours: { ...f.hours, [k]: patch === null ? null : { ...(f.hours[k] || { open: '10:00', close: '23:00' }), ...patch } } }));

  const submitAdd = async () => {
    setAdding(true); setError(''); setNotice('');
    try {
      await tbApi.addVenueTableBooking({
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
    try { await tbApi.cancelVenueTableBooking(b.id); setTick((t) => t + 1); } catch (e) { setError(e.message); }
  };

  const typeTables = (dayData ? (dayData.allTables || dayData.tables) : []).filter((t) => t.type === add.type);
  const allTables = info.types.flatMap((t) => Array.from({ length: t.count }, (_, i) => ({ type: t.key, number: i + 1, key: `${t.key}-${i + 1}`, dflt: `${t.label} ${i + 1}` })));
  const setTable = (k, patch) => setForm((f) => {
    const tables = { ...f.tables };
    if (patch === null) delete tables[k]; else tables[k] = { label: '', price: '', ...(tables[k] || {}), ...patch };
    return { ...f, tables };
  });

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band"><span className="vm-bk-band-title"><h2>Table booking</h2></span></div>
      <div className="vm-panel-body">
        {info.wixLinked ? (
          <>
            <p className="muted">This venue uses the Wix booking system, so the in-app table booking is not available here.</p>
            {error && <p className="error">{error}</p>}
            {info.canSwitchSystem && (
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => switchSystem('cuesense')}>Move this venue to Cue Sense table booking</button>
            )}
          </>
        ) : (
          <>
            {!barStaff && (<>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => toggle(e.target.checked)}
                style={{ width: 22, height: 22, minHeight: 0, margin: 0, padding: 0, flex: '0 0 auto', accentColor: 'var(--primary)' }} />
              <span>Let members book tables in the app</span>
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
              <label className="ll-field">Changeover between bookings
                <select className="mm-input" value={form.bufferMinutes} onChange={(e) => setForm((f) => ({ ...f, bufferMinutes: e.target.value }))}>
                  {BUFFER_OPTS.map((m) => <option key={m} value={m}>{m === 0 ? 'None' : `${m} min`}</option>)}
                </select>
              </label>
            </div>

            <details style={{ marginTop: 14 }} open={Object.keys(form.tables).length > 0}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem' }}>Bookable tables and prices ({Object.keys(form.tables).length || 'all tables, by type'})</summary>
              <p className="muted vm-small" style={{ margin: '6px 0' }}>Tick the tables customers can book. With none ticked, customers book by table type and every table can be used. Ticked tables get their own name and price, and customers choose the table.</p>
              {allTables.map((t) => {
                const on = !!form.tables[t.key];
                return (
                  <div key={t.key} className="tb-row2" style={{ alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}>
                      <input type="checkbox" checked={on} onChange={(e) => setTable(t.key, e.target.checked ? { label: t.dflt } : null)}
                        style={{ width: 20, height: 20, minHeight: 0, margin: 0, accentColor: 'var(--primary)' }} />
                      {t.dflt}
                    </label>
                    <input className="mm-input" aria-label={`${t.dflt} name`} disabled={!on} maxLength={40} placeholder="Name shown to customers" value={on ? form.tables[t.key].label : ''} onChange={(e) => setTable(t.key, { label: e.target.value })} />
                    <input className="mm-input" aria-label={`${t.dflt} price`} disabled={!on} maxLength={60} placeholder="Price, e.g. £10 per hour" value={on ? form.tables[t.key].price : ''} onChange={(e) => setTable(t.key, { price: e.target.value })} />
                  </div>
                );
              })}
            </details>

            <label className="ll-field" style={{ marginTop: 12 }}>Payment note shown to customers
              <input className="mm-input" maxLength={300} placeholder="e.g. No payment is taken online - please pay at the bar." value={form.payNote} onChange={(e) => setForm((f) => ({ ...f, payNote: e.target.value }))} />
            </label>
            <label className="ll-field" style={{ marginTop: 8 }}>Booking policy shown to customers
              <textarea className="mm-input" rows={4} maxLength={2000} value={form.policy} onChange={(e) => setForm((f) => ({ ...f, policy: e.target.value }))} />
            </label>

            <h3 style={{ margin: '14px 0 6px', fontSize: '0.95rem' }}>Booking from the venue website (non-members)</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.guestEnabled} onChange={(e) => setForm((f) => ({ ...f, guestEnabled: e.target.checked }))}
                style={{ width: 22, height: 22, minHeight: 0, margin: 0, padding: 0, flex: '0 0 auto', accentColor: 'var(--primary)' }} />
              <span>Let anyone book from the website</span>
            </label>
            <label className="ll-field" style={{ marginTop: 8 }}>Website addresses allowed to take bookings (one per line, https://)
              <textarea className="mm-input" rows={2} value={form.guestOrigins} onChange={(e) => setForm((f) => ({ ...f, guestOrigins: e.target.value }))} />
            </label>
            <label className="ll-field" style={{ marginTop: 8 }}>Website page for moving or cancelling (link in the confirmation email)
              <input className="mm-input" placeholder="https://www.example.co.uk/book.html" value={form.guestManageUrl} onChange={(e) => setForm((f) => ({ ...f, guestManageUrl: e.target.value }))} />
            </label>

            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving} onClick={saveSettings}>{saving ? 'Saving…' : 'Save booking settings'}</button>
            {info.canSwitchSystem && info.usesCueSenseInsteadOfWix && (
              <p className="vm-small" style={{ marginTop: 10 }}>
                <button type="button" className="btn" disabled={saving} onClick={() => switchSystem('wix')}>Move this venue back to Wix Bookings</button>
              </p>
            )}
            </>)}
            {barStaff && error && <p className="error">{error}</p>}
            {barStaff && notice && <p className="banner banner-success">{notice}</p>}

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
                    <h4>{t.label}{t.price ? <span className="muted vm-small"> · {t.price}</span> : null}</h4>
                    {t.bookings.length === 0 && <span className="muted vm-small">Free all day</span>}
                    {t.bookings.map((b) => (
                      <div key={b.id} className={`tb-bk${b.kind === 'block' ? ' block' : ''}`}>
                        <span>
                          <strong>{b.startTime}–{b.endTime}</strong> {b.who}{b.kind === 'walkin' ? ' (walk-in)' : b.kind === 'guest' ? ` (website${b.member ? ', member' : ''})` : ''}
                          {b.phone ? <> · <a href={`tel:${b.phone.replace(/[^\d+]/g, '')}`}>{b.phone}</a></> : null}
                        </span>
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
