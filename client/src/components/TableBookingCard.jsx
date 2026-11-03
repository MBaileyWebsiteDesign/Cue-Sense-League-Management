import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './tableBooking.css';

// Player "Table booking" card (Matt, 2026-10-26; 2026-11-03): book a table at a
// venue that uses the in-app booking system. Book by TABLE TYPE (the server
// picks the table) or, where the venue has named tables (Top Spin: Table 13,
// Match Tables 1-3, Chinese 8 Ball), by picking the table itself, with its
// price. Bookings can be moved or cancelled any time before they start.
// Payment is at the venue - the card shows the venue's pay note and policy.
// Hidden when the player has no such venue and no bookings.
const pad = (n) => String(n).padStart(2, '0');
const dayShort = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const addMin = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return t >= 1440 ? '24:00' : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};
const lenLabel = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
};

export default function TableBookingCard() {
  const supported = typeof api.getTableBookingVenues === 'function';
  const [venues, setVenues] = useState(null);
  const [mine, setMine] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [venueId, setVenueId] = useState('');
  const [type, setType] = useState('');
  const [day, setDay] = useState('');
  const [avail, setAvail] = useState(null);
  const [availErr, setAvailErr] = useState('');
  const [time, setTime] = useState('');
  const [blocks, setBlocks] = useState(2);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(null);
  const [moving, setMoving] = useState(null); // booking being moved

  const loadMine = () => api.getMyTableBookings().then((r) => setMine(r.bookings || [])).catch(() => {});
  const loadVenues = () => api.getTableBookingVenues().then((v) => {
    setVenues(v);
    setVenueId((cur) => (v.some((x) => x.id === cur) ? cur : (v[0] ? v[0].id : '')));
  }).catch(() => setVenues([]));

  useEffect(() => {
    if (!supported) return;
    loadVenues();
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const venue = (venues || []).find((v) => v.id === venueId) || null;
  const namedTables = venue && Array.isArray(venue.tables) ? venue.tables : [];
  const byTable = namedTables.length > 0;
  // `type` holds a table key ("english-13") when the venue has named tables.
  const pick = byTable ? { table: type } : type;
  const choices = byTable ? namedTables.map((t) => ({ key: t.key, label: t.label, price: t.price })) : (venue ? venue.types : []);

  // New venue: reset the choices (a single choice is made for them).
  useEffect(() => {
    if (!venue || moving) return;
    const list = venue.tables && venue.tables.length ? venue.tables : venue.types;
    setType(list.length === 1 ? list[0].key : '');
    setDay(venue.days[0] || '');
    setTime('');
    setAvail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  const ignoreId = moving ? moving.id : undefined;
  useEffect(() => {
    if (!open || !venueId || !type || !day) return undefined;
    let live = true;
    setAvailErr('');
    api.getTableBookingAvailability(venueId, pick, day, ignoreId)
      .then((r) => { if (live) setAvail(r); })
      .catch((e) => { if (live) { setAvail(null); setAvailErr(e.message); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, venueId, type, day, ignoreId]);

  const slot = avail && time ? avail.slots.find((s) => s.time === time) : null;
  const maxBlocks = slot ? slot.maxBlocks : 0;
  useEffect(() => {
    if (!slot) return;
    if (slot.maxBlocks === 0) { setTime(''); return; }
    setBlocks((b) => Math.max(1, Math.min(b, slot.maxBlocks)));
  }, [slot]);

  const pickType = (k) => { setType(k); setTime(''); };
  const pickDay = (d) => { setDay(d); setTime(''); };

  const book = async () => {
    setBusy(true); setError(''); setNotice('');
    const body = { venueId, ...(byTable ? { table: type } : { type }), start: `${day}T${time}`, minutes: blocks * 30 };
    try {
      const r = moving ? await api.moveMyTableBooking(moving.id, body) : await api.bookMyTable(body);
      const b = r.booking;
      setNotice(`${moving ? 'Moved' : 'Booked'}: ${b.table} at ${b.venueName}, ${dayLong(b.day)}, ${b.startTime}–${b.endTime}.${b.price ? ` ${b.price}.` : ''} A confirmation email is on its way.`);
      setOpen(false);
      setMoving(null);
      setTime('');
      await loadMine();
    } catch (e) {
      setError(e.message);
      api.getTableBookingAvailability(venueId, pick, day, ignoreId).then(setAvail).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const startMove = (b) => {
    const v = (venues || []).find((x) => x.id === b.venueId);
    if (!v) { setError('That venue is not taking bookings right now.'); return; }
    setMoving(b);
    setVenueId(b.venueId);
    setType(v.tables && v.tables.length ? b.tableKey : b.type);
    setDay(v.days.includes(b.day) ? b.day : (v.days[0] || ''));
    setTime('');
    setBlocks(Math.max(1, Math.round(b.minutes / 30)));
    setAvail(null);
    setOpen(true); setNotice(''); setError('');
  };
  const closeSteps = () => { setOpen(false); setMoving(null); };

  const cancel = async (b) => {
    if (armed !== b.id) { setArmed(b.id); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.cancelMyTableBooking(b.id);
      setNotice(`Cancelled: ${b.table}, ${dayShort(b.day)} ${b.startTime}.`);
      setArmed(null);
      await loadMine();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // The Next match card's "Book a table" button opens this card's booking steps.
  useEffect(() => {
    const onBook = (e) => {
      if (e.detail !== 'app') return;
      setOpen(true); setNotice(''); setError('');
      setTimeout(() => {
        const el = document.getElementById('table-booking-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    };
    window.addEventListener('cs-book-table', onBook);
    return () => window.removeEventListener('cs-book-table', onBook);
  }, []);

  if (!supported || venues === null) return null;
  if (venues.length === 0 && mine.length === 0) return null;

  return (
    <section className="card" id="table-booking-card">
      <h2>Table booking</h2>
      {notice && <p className="banner banner-success">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {mine.length > 0 && (
        <ul className="tb-mine">
          {mine.map((b) => (
            <li key={b.id}>
              <span>
                <strong>{dayShort(b.day)} {b.startTime}–{b.endTime}</strong><br />
                <span className="muted">{b.table} · {b.venueName}{b.price ? ` · ${b.price}` : ''}</span>
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn" disabled={busy} onClick={() => startMove(b)}>Move</button>
                <button type="button" className={armed === b.id ? 'btn btn-danger' : 'btn'} disabled={busy} onClick={() => cancel(b)}>
                  {armed === b.id ? 'Tap again to confirm' : 'Cancel'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {venues.length > 0 && !open && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => { setOpen(true); setNotice(''); setError(''); }}>
          Book a table
        </button>
      )}
      {open && venue && (
        <div className="tb-steps">
          {moving && <p className="banner">Moving your booking: {moving.table}, {dayShort(moving.day)} {moving.startTime}–{moving.endTime}. Pick the new table, day and time.</p>}
          <div className="tb-step">
            <h3>Venue</h3>
            <select className="mm-input" aria-label="Venue to book at" value={venueId} disabled={!!moving} onChange={(e) => setVenueId(e.target.value)}>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div className="tb-step">
            <h3>1. {byTable ? 'Table' : 'Table type'}</h3>
            <div className="tb-types">
              {choices.map((t) => (
                <button key={t.key} type="button" className={`tb-type${type === t.key ? ' on' : ''}`} onClick={() => pickType(t.key)}>
                  {t.label}{t.price ? <><br /><small className="muted">{t.price}</small></> : null}
                </button>
              ))}
            </div>
          </div>
          {type && (
            <div className="tb-step">
              <h3>2. Day</h3>
              {venue.days.length === 0 ? <p className="muted">No days are open for booking right now.</p> : (
                <div className="tb-days">
                  {venue.days.map((d) => (
                    <button key={d} type="button" className={`tb-day${day === d ? ' on' : ''}`} onClick={() => pickDay(d)}>{dayShort(d)}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {type && day && (
            <div className="tb-step">
              <h3>3. Start time</h3>
              {availErr && <p className="error">{availErr}</p>}
              {!avail && !availErr && <p className="muted">Loading times…</p>}
              {avail && (
                <>
                  <div className="tb-chips">
                    {avail.slots.map((s) => (
                      <button key={s.time} type="button" disabled={s.maxBlocks === 0} className={`tb-chip${time === s.time ? ' on' : ''}`} onClick={() => setTime(s.time)}>{s.time}</button>
                    ))}
                  </div>
                  <p className="muted vm-small" style={{ margin: '6px 0 0' }}>Greyed-out times are taken or have passed. Open {avail.open}–{avail.close}.</p>
                </>
              )}
            </div>
          )}
          {time && slot && slot.maxBlocks > 0 && (
            <div className="tb-step">
              <h3>4. How long</h3>
              <div className="tb-stepper">
                <button type="button" aria-label="Shorter" disabled={blocks <= 1} onClick={() => setBlocks((b) => b - 1)}>−</button>
                <strong>{lenLabel(blocks * 30)}</strong>
                <button type="button" aria-label="Longer" disabled={blocks >= maxBlocks} onClick={() => setBlocks((b) => b + 1)}>+</button>
              </div>
            </div>
          )}
          <div className="tb-summary">
            <span>
              {time && slot && slot.maxBlocks > 0
                ? <><strong>{venue.name}</strong><br />{(choices.find((t) => t.key === type) || {}).label} · {dayShort(day)} · {time}–{addMin(time, blocks * 30)}</>
                : <span className="muted">Pick a type, day and start time</span>}
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={closeSteps}>Close</button>
              <button type="button" className="btn btn-primary" disabled={busy || !time || !slot || slot.maxBlocks === 0} onClick={book}>{busy ? 'Saving…' : moving ? 'Move booking' : 'Book'}</button>
            </span>
          </div>
          {venue.payNote && <p className="muted vm-small" style={{ margin: '8px 0 0' }}>{venue.payNote}</p>}
          {venue.policy && (
            <details style={{ marginTop: 6 }}>
              <summary className="vm-small" style={{ cursor: 'pointer' }}>Booking policy</summary>
              <p className="muted vm-small" style={{ whiteSpace: 'pre-line', margin: '6px 0 0' }}>{venue.policy}</p>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
