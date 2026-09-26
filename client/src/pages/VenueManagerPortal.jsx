import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

// Displays a membershipRenewalDate (stored/sent as ISO "yyyy-mm-dd") in UK
// format, dd-mm-yyyy, per Matt's request. Plain string reslicing rather than
// a Date object, since the stored value has no time component and parsing
// it as a Date risks a timezone-driven off-by-one-day shift.
function formatDateUK(isoDate) {
  if (!isoDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}

// 'red' within 2 months, 'amber' within 4, otherwise '' - same windows as
// the Due in 2 / 4 month tiles.
function renewalUrgency(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
  if (!match) return '';
  const due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  const in2 = new Date(today.getFullYear(), today.getMonth() + 2, today.getDate());
  const in4 = new Date(today.getFullYear(), today.getMonth() + 4, today.getDate());
  if (due <= in2) return 'red';
  if (due <= in4) return 'amber';
  return '';
}

// The Venue Manager Portal - a Venue Manager's home base for the one (or
// more) venue(s) an Overall Admin has granted them access to (see
// assertVenueAccess in server/src/userAuth.js and the "Venue Managers"
// panel on MembershipManagement.jsx). Status box (registered players +
// due-for-renewal counts, each with its own traffic-light shading), a
// player search box, and a Registered Players card listing everyone
// currently assigned to the venue.

// Pale traffic-light backgrounds, shared by the Registered Players tile and
// the three due-for-renewal tiles. Kept as plain hex (rather than new CSS
// classes) since these are the only places in the app that need this exact
// pale-red/yellow/green trio; --danger/--warning/--success tokens don't
// exist in styles.css today.
const TINT_RED = '#fee2e2';
const TINT_YELLOW = '#fef3c7';
const TINT_GREEN = '#d1fae5';

// Registered-players traffic light: Matt's thresholds are fewer than 10 ->
// red, 10-20 inclusive -> yellow, above 20 -> green.
function registeredPlayersTint(count) {
  if (count < 10) return TINT_RED;
  if (count <= 20) return TINT_YELLOW;
  return TINT_GREEN;
}

// Renders a player's name or email as a link into their public Player
// Profile page (/players/:playerId - PlayerProfile.jsx, the same career/
// stats page reachable from anywhere else in the app, e.g. standings and
// fixture pages) so a Venue Manager can jump straight to "their portal"
// view of that player. Not every account is guaranteed to carry a
// playerId (older data could lack the link), so this falls back to plain
// text rather than rendering a dead link.
function PlayerLink({ playerId, children }) {
  return playerId ? <Link to={`/players/${playerId}`}>{children}</Link> : children;
}

// A whole stat tile that is clickable when its count is non-zero (there's
// nothing to show for a zero count, so those tiles stay plain and inert).
// Renders the same markup/classes as a plain stat card - no button chrome,
// no underline - just a pointer cursor and an accent highlight while its
// player list is open, plus keyboard support (Enter/Space) since it's a
// real interactive control under the hood. `tint` sets the card's pale
// traffic-light background.
function DueTile({ label, count, active, onClick, caption, tint }) {
  // Every tile with an onClick is clickable, even at 0 (Matt, 2026-09-24) -
  // the list then says nobody is in that window.
  const clickable = !!onClick;
  const inner = (
    <>
      <span className="vm-tile-top">
        <span className="vm-tile-label">{label}</span>
        {clickable && (
          <svg className={`vm-tile-chev${active ? ' vm-tile-chev-open' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        )}
      </span>
      <span className="vm-tile-num">{count}</span>
      <span className="vm-tile-caption">{caption}</span>
    </>
  );
  return clickable ? (
    <button
      type="button"
      className={`vm-tile${active ? ' vm-tile-active' : ''}`}
      style={{ backgroundColor: tint }}
      aria-expanded={active}
      onClick={onClick}
    >
      {inner}
    </button>
  ) : (
    <div className="vm-tile" style={{ backgroundColor: tint }}>{inner}</div>
  );
}

// One player as a card: name/email (links to their profile when they have
// one), status, renewal date (tinted as it gets close) and - when renewals
// are allowed here - the three quick-renew buttons.
function PlayerCard({ p, busy, onRenew, showStatus = true }) {
  const urgency = renewalUrgency(p.membershipRenewalDate);
  return (
    <li className="vm-player">
      <span className="vm-player-top">
        <span className="vm-player-main">
          <strong><PlayerLink playerId={p.playerId}>{p.firstName} {p.lastName}</PlayerLink></strong>
          <span className="muted vm-small">{p.email}</span>
        </span>
        {showStatus && p.status && (
          <span className={`status ${p.status === 'suspended' ? 'status-disputed' : 'status-completed'}`}>{p.status}</span>
        )}
      </span>
      <span className={`vm-renews${urgency ? ` vm-renews-${urgency}` : ''}`}>
        {p.membershipRenewalDate ? `Expires ${formatDateUK(p.membershipRenewalDate)}` : 'No expiry date set'}
      </span>
      {onRenew && <RenewButtons player={p} busy={busy} onRenew={onRenew} />}
    </li>
  );
}

// The list of players behind whichever "Due in N months" tile is currently
// selected - same table pattern as PlayerSearchBox's results below, minus
// the Status column (Registered-players-only players are already filtered
// to non-suspended by the API, so it'd always read the same thing).
// `months` is 2, 4 or 6 for a renewal window, or 'all' for the Registered
// players tile - that one lists everyone at the venue except suspended
// accounts, matching how the tile's count is worked out on the server.
function DuePlayersPanel({ venueId, months, onClose }) {
  const [players, setPlayers] = useState(null);
  const [error, setError] = useState('');
  const isAll = months === 'all';

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setError('');
    const load = isAll
      ? api.searchVenuePlayers(venueId, '').then((list) => list.filter((p) => p.status !== 'suspended'))
      : api.getVenueManagerDuePlayers(venueId, months);
    load
      .then((p) => { if (!cancelled) setPlayers(p); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [venueId, months, isAll]);

  return (
    <div className="vm-due-panel">
      <div className="sx-card-head">
        <h3 style={{ margin: 0 }}>{isAll ? 'Registered players' : `Due in ${months} months`}</h3>
        <button className="btn dv-small-btn" type="button" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        players.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {isAll ? 'No players are registered to this venue yet.' : 'No players are due for renewal in this window.'}
          </p>
        ) : (
          <ul className="vm-players">
            {players.map((p) => <PlayerCard key={p.id} p={p} showStatus={isAll} />)}
          </ul>
        )
      )}
    </div>
  );
}

function StatusBox({ status, loading, venueId }) {
  const [openBucket, setOpenBucket] = useState(null);
  const toggleBucket = (months) => setOpenBucket((prev) => (prev === months ? null : months));

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
          <h2>Status</h2>
        </span>
      </div>
      <div className="vm-panel-body">
      {loading || !status ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="vm-tiles">
          <DueTile
            label="Registered players"
            count={status.registeredPlayers}
            active={openBucket === 'all'}
            onClick={() => toggleBucket('all')}
            caption="at this venue"
            tint={registeredPlayersTint(status.registeredPlayers)}
          />
          <DueTile
            label="Due in 2 months"
            count={status.dueIn2Months}
            active={openBucket === 2}
            onClick={() => toggleBucket(2)}
            caption="renewals"
            tint={TINT_RED}
          />
          <DueTile
            label="Due in 4 months"
            count={status.dueIn4Months}
            active={openBucket === 4}
            onClick={() => toggleBucket(4)}
            caption="renewals"
            tint={TINT_YELLOW}
          />
          <DueTile
            label="Due in 6 months"
            count={status.dueIn6Months}
            active={openBucket === 6}
            onClick={() => toggleBucket(6)}
            caption="renewals"
            tint={TINT_GREEN}
          />
        </div>
      )}
      {openBucket && (
        <DuePlayersPanel venueId={venueId} months={openBucket} onClose={() => setOpenBucket(null)} />
      )}
      <p className="muted vm-small" style={{ margin: 0 }}>
        Each player is counted in one window only. Tap a tile to see the players.
      </p>
      </div>
    </section>
  );
}

// The three quick-renew buttons shown at the end of a player row (both on
// Search players and on Registered players). Each extends that player's
// membershipRenewalDate by the given number of months (from their existing
// date if they have one, otherwise from today - see the server route's own
// comment). `busy` disables all three while a request for this row is in
// flight, so a double-click can't fire two renewals at once. Color-coded
// with the same traffic-light trio as the renewal-due Status tiles: 1
// month red, 6 months yellow, 12 months green - reusing the app's existing
// .btn-danger for red and two new pale button classes for yellow/green
// (see styles.css).
const RENEW_BUTTON_CLASS = { 1: 'btn-danger', 6: 'btn-renew-yellow', 12: 'btn-renew-green' };

function RenewButtons({ player, busy, onRenew }) {
  return (
    <span className="vm-renew-row">
      {[1, 6, 12].map((months) => (
        <button
          key={months}
          className={`btn ${RENEW_BUTTON_CLASS[months]}`}
          type="button"
          disabled={busy}
          onClick={() => onRenew(player, months)}
          title={`Extend ${player.firstName} ${player.lastName}'s membership by ${months} month${months === 1 ? '' : 's'}`}
        >
          {busy ? '…' : `+${months} mo`}
        </button>
      ))}
    </span>
  );
}

function PlayerSearchBox({ venueId }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [renewingId, setRenewingId] = useState(null);
  const [renewError, setRenewError] = useState('');

  const onSearch = async (e) => {
    e.preventDefault();
    setSearching(true);
    setError('');
    try {
      const players = await api.searchVenuePlayers(venueId, query);
      setResults(players);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const onRenew = async (player, months) => {
    setRenewingId(player.id);
    setRenewError('');
    try {
      const updated = await api.renewVenuePlayer(venueId, player.id, months);
      setResults((prev) => prev && prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
    } catch (err) {
      setRenewError(err.message);
    } finally {
      setRenewingId(null);
    }
  };

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <h2>Search players</h2>
        </span>
      </div>
      <div className="vm-panel-body">
      <form className="au-search" onSubmit={onSearch} role="search">
        <input
          type="search"
          className="ah-search"
          aria-label="Search players by first name, last name or both"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="First name, last name or both"
        />
        <button className="btn btn-primary" type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {renewError && <p className="error">{renewError}</p>}
      {results && (
        results.length === 0 ? (
          <p className="muted">No players at this venue match that search.</p>
        ) : (
          <ul className="vm-players">
            {results.map((p) => (
              <PlayerCard key={p.id} p={p} busy={renewingId === p.id} onRenew={onRenew} />
            ))}
          </ul>
        )
      )}
      </div>
    </section>
  );
}

// New card, under Search players per Matt's request: every user currently
// registered to this venue, not just search matches. Reuses the same
// GET /api/venue-manager/players endpoint the search box calls, just with
// an empty query (the server already returns everyone at the venue when
// `q` is blank), so no server change was needed for this list itself.
function RegisteredPlayersList({ venueId }) {
  const [players, setPlayers] = useState(null);
  const [error, setError] = useState('');
  const [renewingId, setRenewingId] = useState(null);
  const [renewError, setRenewError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setError('');
    api.searchVenuePlayers(venueId, '')
      .then((p) => { if (!cancelled) setPlayers(p); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [venueId]);

  const onRenew = async (player, months) => {
    setRenewingId(player.id);
    setRenewError('');
    try {
      const updated = await api.renewVenuePlayer(venueId, player.id, months);
      setPlayers((prev) => prev && prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
    } catch (err) {
      setRenewError(err.message);
    } finally {
      setRenewingId(null);
    }
  };

  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" /></svg>
          <h2>Registered players</h2>
          {players && <span className="vm-bk-count" aria-label={`${players.length} registered players`}>{players.length}</span>}
        </span>
      </div>
      <div className="vm-panel-body">
      {error && <p className="error">{error}</p>}
      {renewError && <p className="error">{renewError}</p>}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        players.length === 0 ? (
          <p className="muted">No players are registered to this venue yet.</p>
        ) : (
          <ul className="vm-players">
            {players.map((p) => (
              <PlayerCard key={p.id} p={p} busy={renewingId === p.id} onRenew={onRenew} />
            ))}
          </ul>
        )
      )}
      </div>
    </section>
  );
}

// ---------- Table bookings (from the venue's Wix website) ----------
// Read-only list of today's and future bookings made on the venue's own
// Wix site (Top Spin only for now - see /api/venue-manager/bookings in
// server/src/index.js). Grouped by day, times in UK time. Cancelled
// bookings stay in the list, greyed out with a Cancelled chip. The server
// pulls from Wix at 09:00, 11:00 and 17:00 UK time only, so the card shows
// when the list was last updated and when the next update is due.
const UK_TZ = 'Europe/London';

function ukDayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: UK_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function ukTime(iso) {
  return iso
    ? new Intl.DateTimeFormat('en-GB', { timeZone: UK_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
    : '';
}

function dayHeading(key) {
  const today = ukDayKey(new Date().toISOString());
  const tomorrow = ukDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  const [y, m, d] = key.split('-').map(Number);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
  if (key === today) return `Today · ${label}`;
  if (key === tomorrow) return `Tomorrow · ${label}`;
  return label;
}

// "11:00" for today, otherwise "Fri 11:00" - used for the last/next sync times.
function syncLabel(iso) {
  const sameDay = ukDayKey(iso) === ukDayKey(new Date().toISOString());
  if (sameDay) return ukTime(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: UK_TZ, weekday: 'short' }).format(new Date(iso));
  return `${day} ${ukTime(iso)}`;
}

const BOOKING_STATUS = {
  CONFIRMED: { label: 'Confirmed', cls: 'status-completed' },
  PENDING: { label: 'Pending', cls: '' },
  WAITING_LIST: { label: 'Waiting list', cls: '' },
  CANCELED: { label: 'Cancelled', cls: 'status-disputed' },
  DECLINED: { label: 'Declined', cls: 'status-disputed' },
};

const PAYMENT_LABEL = {
  PAID: 'Paid',
  NOT_PAID: 'Not paid',
  PARTIALLY_PAID: 'Part paid',
  REFUNDED: 'Refunded',
  EXEMPT: 'No charge',
};

// Fallback if the server doesn't send opening hours (minutes after midnight,
// 0 = Sunday): Mon-Sat 11:00-24:00, Sun 11:00-22:00.
const DEFAULT_OPENING_HOURS = [
  { open: 660, close: 1320 },
  { open: 660, close: 1440 }, { open: 660, close: 1440 }, { open: 660, close: 1440 },
  { open: 660, close: 1440 }, { open: 660, close: 1440 }, { open: 660, close: 1440 },
];

// Opening hours for the UK day of a "YYYY-MM-DDTHH:MM" value, plus its start minute.
function walkinSlotInfo(value, hours) {
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const day = hours[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || { open: 0, close: 0 };
  return { startMin: h * 60 + mi, open: day.open, close: day.close };
}

// Start-time choices for a walk-in: every half-hour start over the next 7
// days (the current half hour first, as "Now") that falls inside opening
// hours and leaves at least an hour before closing. Each option carries its
// UK day so the form can show a Day picker and then that day's times
// (Matt, 2026-09-26 - the old list stopped after 13 slots, so after
// midnight it ran 11:00-17:00 and later times couldn't be booked).
// Values are UK wall-clock "YYYY-MM-DDTHH:MM". UK offsets are whole hours,
// so flooring to 30 minutes in UTC matches UK.
function walkinStartOptions(hours = DEFAULT_OPENING_HOURS) {
  const step = 30 * 60 * 1000;
  const first = Math.floor(Date.now() / step) * step;
  const opts = [];
  for (let i = 0; i < 7 * 48; i++) {
    const d = new Date(first + i * step);
    const iso = d.toISOString();
    const day = ukDayKey(iso);
    const value = `${day}T${ukTime(iso)}`;
    const { startMin, open, close } = walkinSlotInfo(value, hours);
    if (startMin < open || startMin + 60 > close) continue;
    opts.push({ value, day, label: i === 0 ? `Now (${ukTime(iso)})` : ukTime(iso) });
  }
  return opts;
}

// Day picker choices: the UK days that have at least one start option.
function walkinDayOptions(startOpts) {
  const todayKey = ukDayKey(new Date(Date.now()).toISOString());
  const tomorrowKey = ukDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  const seen = [];
  startOpts.forEach((o) => { if (!seen.includes(o.day)) seen.push(o.day); });
  return seen.map((day) => {
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(date);
    const label = day === todayKey ? `Today (${name})` : day === tomorrowKey ? `Tomorrow (${name})` : name;
    return { value: day, label };
  });
}

const WALKIN_LENGTH_LABEL = { 60: '1 hr', 120: '2 hrs', 180: '3 hrs' };

// "Book walk-in" form: books a table on the venue's Wix site straight away
// (a confirmed booking named "Walk-in"), so it can't be booked online.
function WalkinForm({ venueId, onDone, onClose, initialPlayer = null }) {
  const [tables, setTables] = useState(null);
  const [lengths, setLengths] = useState([60, 120, 180]);
  const [tableId, setTableId] = useState('');
  const [openingHours, setOpeningHours] = useState(DEFAULT_OPENING_HOURS);
  const [startOpts, setStartOpts] = useState(() => walkinStartOptions());
  const [start, setStart] = useState(() => (startOpts[0] ? startOpts[0].value : ''));
  const [day, setDay] = useState(() => (startOpts[0] ? startOpts[0].day : ''));
  const dayOpts = walkinDayOptions(startOpts);
  const dayStarts = startOpts.filter((o) => o.day === day);
  const pickDay = (value) => {
    setDay(value);
    const firstOfDay = startOpts.find((o) => o.day === value);
    setStart(firstOfDay ? firstOfDay.value : '');
  };
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [firstName, setFirstName] = useState((initialPlayer && initialPlayer.firstName) || '');
  const [lastName, setLastName] = useState((initialPlayer && initialPlayer.lastName) || '');
  const [email, setEmail] = useState((initialPlayer && initialPlayer.email) || '');
  const [signUp, setSignUp] = useState(false);
  const [membership, setMembership] = useState(''); // '' | '1m' | '12m'
  const wantsAccount = signUp || !!membership;
  // Minutes between the chosen start and closing - lengths that would run
  // past closing are disabled.
  const minutesToClose = start ? (() => { const i = walkinSlotInfo(start, openingHours); return i.close - i.startMin; })() : 0;
  useEffect(() => {
    if (minutes > minutesToClose) {
      const fit = lengths.filter((m) => m <= minutesToClose);
      if (fit.length) setMinutes(fit[fit.length - 1]);
    }
  }, [start, minutesToClose]);

  useEffect(() => {
    api.getWalkinTables(venueId)
      .then((d) => {
        setTables(d.tables || []);
        if (Array.isArray(d.lengths) && d.lengths.length) setLengths(d.lengths);
        if (Array.isArray(d.openingHours) && d.openingHours.length === 7) {
          setOpeningHours(d.openingHours);
          const opts = walkinStartOptions(d.openingHours);
          setStartOpts(opts);
          setStart((cur) => {
            const keep = opts.find((o) => o.value === cur);
            const next = keep || opts[0];
            setDay(next ? next.day : '');
            return next ? next.value : '';
          });
        }
      })
      .catch((e) => setError(e.message));
  }, [venueId]);

  const submit = (e) => {
    e.preventDefault();
    if (!tableId) { setError('Choose a table.'); return; }
    if (!start) { setError('Choose a start time.'); return; }
    if (minutes > minutesToClose) { setError('That would run past closing time - choose a shorter length.'); return; }
    if (wantsAccount && (!firstName.trim() || !lastName.trim() || !email.trim())) {
      setError('First name, last name and email are needed to sign up or add a membership.');
      return;
    }
    setBusy(true);
    setError('');
    const player = { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), signUp, membership };
    api.bookWalkin(venueId, tableId, start, minutes, player)
      .then((r) => {
        const who = [player.firstName, player.lastName].filter(Boolean).join(' ');
        const parts = [`${r.table} booked ${ukTime(r.start)}–${ukTime(r.end)}${who ? ` for ${who}` : ' as a walk-in'}. It can't be booked online now.`];
        const p = r.player;
        if (p) {
          if (p.accountCreated) parts.push(`Account created - a welcome email with a link to set their password has been sent to ${p.email}.`);
          else if (p.alreadyRegistered) parts.push(`${p.email} already has an account, so no welcome email was sent.`);
          if (p.membership) parts.push(`${p.membership.months === 12 ? '1 year' : '1 month'} membership set: ${formatDateUK(p.membership.start)} to ${formatDateUK(p.membership.end)}, added to Registered players.`);
        }
        onDone(parts.join(' '));
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <form className="vm-wi" onSubmit={submit}>
      <label className="vm-wi-field">
        <span>Table</span>
        <select className="mm-input" value={tableId} onChange={(e) => setTableId(e.target.value)} disabled={!tables || busy}>
          <option value="">{tables ? 'Choose a table' : 'Loading tables…'}</option>
          {(tables || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <div className="vm-wi-daytime">
        <label className="vm-wi-field">
          <span>Day</span>
          <select className="mm-input" value={day} onChange={(e) => pickDay(e.target.value)} disabled={busy}>
            {dayOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="vm-wi-field">
          <span>Start</span>
          <select className="mm-input" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy}>
            {dayStarts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <span className="vm-wi-hours">Open Mon–Sat 11:00–midnight, Sun 11:00–22:00. Games must finish by closing.</span>
      <div className="vm-wi-field">
        <span>How long</span>
        <div className="vm-wi-lengths" role="group" aria-label="How long">
          {lengths.map((m) => (
            <button
              key={m}
              type="button"
              className={`vm-wi-len${minutes === m ? ' vm-wi-len-on' : ''}`}
              aria-pressed={minutes === m}
              onClick={() => setMinutes(m)}
              disabled={busy || m > minutesToClose}
              title={m > minutesToClose ? 'Would run past closing time' : undefined}
            >
              {WALKIN_LENGTH_LABEL[m] || `${m} min`}
            </button>
          ))}
        </div>
      </div>
      <fieldset className="vm-wi-player">
        <legend>Player details <span>(optional)</span></legend>
        <div className="vm-wi-names">
          <label className="vm-wi-field">
            <span>First name</span>
            <input className="mm-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" maxLength={60} disabled={busy} />
          </label>
          <label className="vm-wi-field">
            <span>Last name</span>
            <input className="mm-input" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" maxLength={60} disabled={busy} />
          </label>
        </div>
        <label className="vm-wi-field">
          <span>Email</span>
          <input className="mm-input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={200} disabled={busy} />
        </label>
        <label className="vm-wi-check">
          <input type="checkbox" checked={signUp} onChange={(e) => setSignUp(e.target.checked)} disabled={busy} />
          <span>Sign up - create a player account and email a link to set a password</span>
        </label>
        <label className="vm-wi-check">
          <input type="checkbox" checked={membership === '1m'} onChange={(e) => setMembership(e.target.checked ? '1m' : '')} disabled={busy} />
          <span>1 month membership (starts today)</span>
        </label>
        <label className="vm-wi-check">
          <input type="checkbox" checked={membership === '12m'} onChange={(e) => setMembership(e.target.checked ? '12m' : '')} disabled={busy} />
          <span>1 year membership (starts today)</span>
        </label>
        {wantsAccount && <p className="vm-wi-help">First name, last name and email are needed. A membership also adds them to this venue's Registered players.</p>}
      </fieldset>
      {error && <p className="error vm-small">{error}</p>}
      <div className="vm-wi-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !tables}>
          {busy ? 'Booking…' : 'Book table'}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Close</button>
      </div>
    </form>
  );
}

// Table bookings shows this many days that have bookings at a time.
const BOOKING_DAYS_STEP = 5;

function BookingsCard({ venueId }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [walkinOpen, setWalkinOpen] = useState(false);
  const [daysShown, setDaysShown] = useState(BOOKING_DAYS_STEP);
  const [notice, setNotice] = useState('');
  const [armedCancel, setArmedCancel] = useState(null); // booking id waiting for a second tap
  const [cancelling, setCancelling] = useState(null);

  // Two taps to cancel a walk-in: the first arms the button for 5 seconds.
  useEffect(() => {
    if (!armedCancel) return undefined;
    const t = setTimeout(() => setArmedCancel(null), 5000);
    return () => clearTimeout(t);
  }, [armedCancel]);

  const cancelWalkin = (b) => {
    if (armedCancel !== b.id) { setArmedCancel(b.id); return; }
    setArmedCancel(null);
    setCancelling(b.id);
    setError('');
    api.cancelWalkin(venueId, b.id)
      .then((r) => {
        setNotice(b.walkIn
          ? `Walk-in on ${b.table} at ${ukTime(b.start)} cancelled - the table is free to book online again.`
          : `${b.customerName || 'Booking'} on ${b.table} at ${ukTime(b.start)} cancelled${r && r.notified ? ' - Wix will let the customer know' : ''}. The table is free to book online again.`);
        return api.getVenueBookings(venueId).then(setData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setCancelling(null));
  };

  // refresh=true asks the server to pull from Wix now rather than waiting
  // for the next 09:00/11:00/17:00 update (the server allows one a minute).
  const load = (refresh) => {
    if (typeof api.getVenueBookings !== 'function') return;
    setError('');
    setLoading(true);
    api.getVenueBookings(venueId, refresh)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setData(null);
    setDaysShown(BOOKING_DAYS_STEP);
    load(false);
  }, [venueId]);

  // Live updates: while the card is on screen, hold a stream open to the
  // server; when Wix reports a new booking the server re-syncs and pings the
  // stream, and the card re-reads the list. Disconnects while the tab is
  // hidden (reloading and reconnecting when it's shown again) and retries
  // every 5s if the connection drops.
  const [live, setLive] = useState(false);
  const liveOk = !!data && data.linked !== false && data.configured !== false;
  useEffect(() => {
    if (!liveOk || typeof api.streamVenueBookings !== 'function') return undefined;
    let stopped = false;
    let ctrl = null;
    let retry = null;
    const reload = () => api.getVenueBookings(venueId).then(setData).catch(() => {});
    const connect = () => {
      if (stopped || document.hidden) return;
      const mine = new AbortController();
      ctrl = mine;
      api.streamVenueBookings(venueId, { onUpdate: reload, onOpen: () => setLive(true), signal: mine.signal })
        .catch(() => {})
        .finally(() => {
          setLive(false);
          if (!stopped && !mine.signal.aborted) retry = setTimeout(connect, 5000);
        });
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(retry);
        if (ctrl) ctrl.abort();
      } else if (!stopped) {
        reload();
        if (!ctrl || ctrl.signal.aborted) connect();
      }
    };
    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(retry);
      if (ctrl) ctrl.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [venueId, liveOk]);

  // Venues with no Wix site linked don't get the card at all.
  if (data && data.linked === false) return null;

  const bookings = (data && data.bookings) || [];
  const groups = [];
  for (const b of bookings) {
    const key = ukDayKey(b.start);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(b);
    else groups.push({ key, items: [b] });
  }
  const activeCount = bookings.filter((b) => b.status !== 'CANCELED' && b.status !== 'DECLINED').length;
  // Show the first 5 days that have bookings; "Show more" adds 5 more each tap.
  const shownGroups = groups.slice(0, daysShown);
  const hiddenDays = groups.length - shownGroups.length;

  return (
    <section className="sx-card vm-bookings">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
          <h2>Table bookings</h2>
          {data && data.configured !== false && !data.error && (
            <span className="vm-bk-count" aria-label={`${activeCount} bookings`}>{activeCount}</span>
          )}
        </span>
        {data && data.configured !== false && (
          <button type="button" className="btn vm-bk-refresh" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
        {data && data.syncedAt && (
          <span className="vm-bk-sync">
            {live && <span className="vm-bk-live"><span className="vm-bk-live-dot" aria-hidden="true" />Live · </span>}
            Updated {syncLabel(data.syncedAt)}
          </span>
        )}
      </div>

      <div className="vm-bk-body">
        {data && data.warning && <p className="error vm-small">{data.warning} Showing the last list that loaded.</p>}
        {error && <p className="error">{error}</p>}
        {notice && <p className="vm-wi-notice" role="status">{notice}</p>}
        {data && data.walkIns && data.configured !== false && !data.error && (
          walkinOpen ? (
            <WalkinForm
              venueId={venueId}
              onClose={() => setWalkinOpen(false)}
              onDone={(msg) => {
                setWalkinOpen(false);
                setNotice(msg);
                api.getVenueBookings(venueId).then(setData).catch(() => {});
              }}
            />
          ) : (
            <button type="button" className="btn vm-wi-open" onClick={() => { setNotice(''); setWalkinOpen(true); }}>
              + Book walk-in
            </button>
          )
        )}

        {!data ? (
          !error && loading && <p className="muted">Loading bookings…</p>
        ) : data.configured === false ? (
          <p className="muted">
            {isAdmin
              ? 'Not connected yet - the WIX_API_KEY secret still needs adding on the server.'
              : 'Bookings aren’t available yet.'}
          </p>
        ) : data.error ? (
          <p className="error">{data.error}</p>
        ) : bookings.length === 0 ? (
          <p className="vm-bk-empty">No bookings today or coming up.</p>
        ) : (
          shownGroups.map((g) => (
            <div key={g.key} className="vm-bk-day">
              <h3 className="vm-bk-day-head">{dayHeading(g.key)}</h3>
              <ul className="vm-bk-list">
                {g.items.map((b) => {
                  const st = BOOKING_STATUS[b.status] || { label: b.status || 'Unknown', cls: '' };
                  const cancelled = b.status === 'CANCELED' || b.status === 'DECLINED';
                  const tone = cancelled ? 'cancelled' : b.status === 'CONFIRMED' ? 'confirmed' : 'pending';
                  return (
                    <li key={b.id} className={`vm-bk vm-bk-${tone}`}>
                      <span className="vm-bk-time">
                        <strong>{ukTime(b.start)}</strong>
                        {b.end && <span>{ukTime(b.end)}</span>}
                      </span>
                      <span className="vm-bk-main">
                        <strong>{b.table}</strong>
                        <span>{b.customerName || 'No name given'}</span>
                      </span>
                      <span className="vm-bk-chips">
                        <span className={`status ${st.cls}`}>{st.label}</span>
                        {b.walkIn && <span className="vm-bk-walkin">Walk-in</span>}
                        {data.walkIns && !cancelled && (
                          <button
                            type="button"
                            className={`vm-bk-cancel${armedCancel === b.id ? ' vm-bk-cancel-armed' : ''}`}
                            onClick={() => cancelWalkin(b)}
                            disabled={cancelling === b.id}
                            aria-label={armedCancel === b.id ? `Confirm cancelling ${b.table} at ${ukTime(b.start)}` : `Cancel ${b.table} at ${ukTime(b.start)}`}
                          >
                            {cancelling === b.id ? 'Cancelling…' : armedCancel === b.id ? 'Tap to confirm' : 'Cancel'}
                          </button>
                        )}
                        {!cancelled && !b.walkIn && b.paymentStatus && (
                          <span className={`vm-bk-pay${b.paymentStatus === 'PAID' ? ' vm-bk-paid' : ''}`}>
                            {PAYMENT_LABEL[b.paymentStatus] || b.paymentStatus}
                          </span>
                        )}
                      </span>
                      {armedCancel === b.id && !b.walkIn && (
                        <span className="vm-bk-cancel-hint">Wix will email/text {b.customerName || 'the customer'} to say it's cancelled.</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
        {data && data.configured !== false && !data.error && bookings.length > 0 && (
          <button
            type="button"
            className="btn vm-bk-more"
            onClick={() => setDaysShown((n) => n + BOOKING_DAYS_STEP)}
            disabled={hiddenDays === 0}
          >
            {hiddenDays > 0
              ? `Show more (${Math.min(hiddenDays, BOOKING_DAYS_STEP)} more ${Math.min(hiddenDays, BOOKING_DAYS_STEP) === 1 ? 'day' : 'days'})`
              : 'No more bookings'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- Tap to check in (NFC cards and the bar tag) ----------
// Players sign in at the bar by tapping their NFC card on this phone (Web
// NFC - Chrome on Android only), or a card number can be typed/scanned into
// the box (a USB desk reader that types the number works the same way).
// Each check-in is logged and shows the player's membership status here,
// with the quick-renew buttons and a walk-in booking prefilled with their
// details. The "Bar check-in tag" section makes the link for an NFC sticker
// on the bar that players tap with their own phone (iPhone or Android) - see
// client/src/pages/CheckIn.jsx.
const NFC_SUPPORTED = typeof window !== 'undefined' && 'NDEFReader' in window;
const CARD_REPEAT_MS = 3000;

const CHECKIN_STATUS = {
  active: { cls: 'ci-chip-green', text: (r) => `Member · expires ${formatDateUK(r)}` },
  expired: { cls: 'ci-chip-red', text: (r) => `Membership ended ${formatDateUK(r)}` },
  'no-dates': { cls: 'ci-chip-amber', text: () => 'Member · no dates set' },
  'not-member': { cls: 'ci-chip-red', text: () => 'Not a member here' },
};

const CHECKIN_SHORT = { active: 'Member', expired: 'Expired', 'no-dates': 'No dates', 'not-member': 'Not a member' };

function CheckinStatusChip({ status, renewalDate, small = false }) {
  const key = CHECKIN_STATUS[status] ? status : 'not-member';
  const s = CHECKIN_STATUS[key];
  return <span className={`ci-chip ${s.cls}${small ? ' ci-chip-small' : ''}`}>{small ? CHECKIN_SHORT[key] : s.text(renewalDate)}</span>;
}

function ukToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Web NFC reader: start() must come from a tap on a button (the browser
// asks for NFC permission the first time). Calls onUid with the card's
// serial number; the same card held on the phone fires repeatedly, so a
// repeat of the same card within CARD_REPEAT_MS is ignored.
function useNfcReader(onUid) {
  const [state, setState] = useState('off'); // off | starting | on
  const [error, setError] = useState('');
  const cb = useRef(onUid);
  cb.current = onUid;
  const ctrl = useRef(null);
  const last = useRef({ uid: '', at: 0 });

  const stop = () => {
    if (ctrl.current) ctrl.current.abort();
    ctrl.current = null;
    setState('off');
  };
  useEffect(() => () => { if (ctrl.current) ctrl.current.abort(); }, []);

  const start = async () => {
    if (!NFC_SUPPORTED) return;
    setError('');
    setState('starting');
    try {
      const reader = new window.NDEFReader();
      const ac = new AbortController();
      ctrl.current = ac;
      await reader.scan({ signal: ac.signal });
      reader.onreading = (e) => {
        const uid = e.serialNumber || '';
        if (!uid) { setError('That card has no readable number. Try a different card.'); return; }
        const now = Date.now();
        if (last.current.uid === uid && now - last.current.at < CARD_REPEAT_MS) return;
        last.current = { uid, at: now };
        setError('');
        cb.current(uid);
      };
      reader.onreadingerror = () => {
        setError("Couldn't read that card. Hold it still on the back of the phone. Cards need to be NFC NTAG (e.g. NTAG213/215) type.");
      };
      setState('on');
    } catch (err) {
      ctrl.current = null;
      setState('off');
      setError(err && err.name === 'NotAllowedError'
        ? 'NFC permission was refused. Allow NFC for this site in Chrome settings, then try again.'
        : `Could not start the card reader${err && err.message ? `: ${err.message}` : ''}. Check NFC is switched on in the phone's settings.`);
    }
  };
  return { state, error, start, stop };
}

// Pick a player of this venue (for linking a card).
function VenuePlayerPicker({ venueId, onPick, disabled }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const search = (e) => {
    e.preventDefault();
    setError('');
    api.searchVenuePlayers(venueId, q).then(setResults).catch((err) => setError(err.message));
  };
  return (
    <div className="ci-picker">
      <form className="au-search" onSubmit={search} role="search">
        <input type="search" className="ah-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Player's first name, last name or both" aria-label="Find a player" disabled={disabled} />
        <button className="btn btn-primary" type="submit" disabled={disabled}>Find</button>
      </form>
      {error && <p className="error vm-small">{error}</p>}
      {results && (results.length === 0 ? (
        <p className="muted vm-small">No players at this venue match that search.</p>
      ) : (
        <ul className="ci-pick-list">
          {results.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.firstName} {p.lastName}</strong>
                <span className="muted vm-small"> {p.email}{p.cards && p.cards.length ? ` · ${p.cards.length} card${p.cards.length === 1 ? '' : 's'}` : ''}</span>
              </span>
              <button type="button" className="btn" onClick={() => onPick(p)} disabled={disabled}>Choose</button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

function CardList({ cards, onUnlink, busy }) {
  const [armed, setArmed] = useState('');
  if (!cards || cards.length === 0) return <p className="muted vm-small">No cards linked yet.</p>;
  return (
    <ul className="ci-cards">
      {cards.map((c) => (
        <li key={c.uid}>
          <span className="ci-uid">{c.uid}{c.label ? ` · ${c.label}` : ''}</span>
          {onUnlink && (
            <button
              type="button"
              className={`btn ${armed === c.uid ? 'btn-danger' : ''}`}
              disabled={busy}
              onClick={() => { if (armed === c.uid) { setArmed(''); onUnlink(c.uid); } else setArmed(c.uid); }}
            >
              {armed === c.uid ? 'Tap again to unlink' : 'Unlink'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function BarTagPanel({ venueId }) {
  const [tag, setTag] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [armRotate, setArmRotate] = useState(false);

  const load = (rotate = false) => {
    setBusy(true); setError(''); setMsg('');
    api.getCheckinTag(venueId, rotate)
      .then((t) => { setTag(t); if (rotate) setMsg('New link made. Write it to the bar tag - the old tag no longer works.'); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(tag.url).then(() => setMsg('Link copied.'), () => setError('Could not copy - select the link and copy it.'));
  };
  const write = async () => {
    setError(''); setMsg('Hold the NFC sticker on the back of this phone…');
    try {
      await new window.NDEFReader().write({ records: [{ recordType: 'url', data: tag.url }] });
      setMsg('Tag written. Test it by tapping it with a phone that is logged in.');
    } catch (err) {
      setMsg('');
      setError(`Could not write the tag${err && err.message ? `: ${err.message}` : ''}. Blank NTAG stickers work best; locked tags can't be written.`);
    }
  };

  return (
    <details className="ci-tag" onToggle={(e) => { if (e.currentTarget.open && !tag && !busy) load(); }}>
      <summary>Bar check-in tag (players tap with their own phone)</summary>
      <p className="muted vm-small">
        Put an NFC sticker on the bar with this link on it. A player taps it with their phone (iPhone or Android),
        the link opens, and they're checked in with their own account. Players can't renew from there - they'll be asked to see the bar staff.
      </p>
      {error && <p className="error vm-small">{error}</p>}
      {msg && <p className="vm-wi-notice" role="status">{msg}</p>}
      {!tag ? <p className="vm-small">{busy ? 'Loading…' : ''}</p> : (
        <>
          <p className="ci-link"><code>{tag.url}</code></p>
          <div className="ci-actions">
            {NFC_SUPPORTED && <button type="button" className="btn btn-primary" onClick={write} disabled={busy}>Write to NFC tag</button>}
            <button type="button" className="btn" onClick={copy} disabled={busy}>Copy link</button>
            <button
              type="button"
              className={`btn ${armRotate ? 'btn-danger' : ''}`}
              disabled={busy}
              onClick={() => { if (armRotate) { setArmRotate(false); load(true); } else setArmRotate(true); }}
            >
              {armRotate ? 'Tap again - old tag will stop working' : 'Make a new link'}
            </button>
          </div>
          {!NFC_SUPPORTED && <p className="muted vm-small">To write the sticker from here, open this page in Chrome on an Android phone. Or copy the link into any NFC writing app.</p>}
        </>
      )}
    </details>
  );
}

function CheckinCard({ venueId }) {
  const [result, setResult] = useState(null); // { kind: 'player', data, repeat, at } | { kind: 'unknown', uid }
  const [linkFor, setLinkFor] = useState(null); // player a card is being linked to
  const [linking, setLinking] = useState(false); // link panel open
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [today, setToday] = useState(null);
  const [walkinFor, setWalkinFor] = useState(null);
  const [renewing, setRenewing] = useState(false);
  const linkRef = useRef(null);
  linkRef.current = linkFor;

  // Today's check-ins (Matt, 2026-09-26): "Clear list" hides everything so
  // far (kept on record, "Show cleared" brings them back into view) and
  // each row has a remove button that deletes that visit. Both need a
  // second tap to confirm.
  const [showCleared, setShowCleared] = useState(false);
  const [armedClear, setArmedClear] = useState(false);
  const [armedDelete, setArmedDelete] = useState(null); // visit id waiting for a second tap
  const [todayBusy, setTodayBusy] = useState(false);
  useEffect(() => {
    if (!armedClear && !armedDelete) return undefined;
    const t = setTimeout(() => { setArmedClear(false); setArmedDelete(null); }, 4000);
    return () => clearTimeout(t);
  }, [armedClear, armedDelete]);

  const loadToday = () => {
    if (typeof api.getVenueCheckinsToday !== 'function') return;
    api.getVenueCheckinsToday(venueId, true).then(setToday).catch(() => {});
  };
  const clearToday = () => {
    if (!armedClear) { setArmedClear(true); setArmedDelete(null); return; }
    setArmedClear(false); setTodayBusy(true); setError('');
    api.clearVenueCheckins(venueId)
      .then(() => { setShowCleared(false); loadToday(); })
      .catch((err) => setError(err.message))
      .finally(() => setTodayBusy(false));
  };
  const deleteVisit = (v) => {
    if (armedDelete !== v.id) { setArmedDelete(v.id); setArmedClear(false); return; }
    setArmedDelete(null); setTodayBusy(true); setError('');
    api.deleteVenueCheckin(venueId, v.id)
      .then(() => setToday((list) => (list || []).filter((x) => x.id !== v.id)))
      .catch((err) => setError(err.message))
      .finally(() => setTodayBusy(false));
  };
  useEffect(() => {
    setResult(null); setLinkFor(null); setLinking(false); setToday(null); setWalkinFor(null);
    setShowCleared(false); setArmedClear(false); setArmedDelete(null);
    loadToday();
    const t = setInterval(loadToday, 30000);
    return () => clearInterval(t);
  }, [venueId]);

  const handleUid = (uid) => {
    setError(''); setNotice(''); setWalkinFor(null);
    setBusy(true);
    const target = linkRef.current;
    const req = target
      ? api.linkVenueCard(venueId, target.id, uid).then((data) => {
        setNotice(`Card linked to ${data.firstName} ${data.lastName}. Tap it again to check them in.`);
        setLinkFor(null); setLinking(false);
        setResult({ kind: 'linked', data });
      })
      : api.venueCheckin(venueId, uid).then((r) => {
        if (!r.found) setResult({ kind: 'unknown', uid: r.uid });
        else { setResult({ kind: 'player', data: r.player, repeat: r.repeat, at: r.visit.at }); loadToday(); }
      });
    req.catch((err) => setError(err.message)).finally(() => setBusy(false));
  };
  const reader = useNfcReader(handleUid);

  const submitManual = (e) => {
    e.preventDefault();
    const v = manual.trim();
    if (!v) return;
    setManual('');
    handleUid(v);
  };

  const renew = (player, months) => {
    setRenewing(true); setError('');
    api.renewVenuePlayer(venueId, player.id, months)
      .then((u) => {
        const r = u.membershipRenewalDate;
        setResult((prev) => prev && prev.data && prev.data.id === u.id
          ? { ...prev, data: { ...prev.data, membershipRenewalDate: r, membershipStatus: u.membershipStatus || (r && r >= ukToday() ? 'active' : prev.data.membershipStatus) } }
          : prev);
        setNotice(`Renewed - now runs to ${formatDateUK(r)}.`);
      })
      .catch((err) => setError(err.message))
      .finally(() => setRenewing(false));
  };

  const unlink = (player, uid) => {
    setBusy(true); setError('');
    api.unlinkVenueCard(venueId, player.id, uid)
      .then((data) => {
        setNotice(`Card ${uid} unlinked.`);
        setResult((prev) => (prev && prev.data && prev.data.id === data.id ? { ...prev, data } : prev));
        setLinkFor((prev) => (prev && prev.id === data.id ? { ...prev, cards: data.cards } : prev));
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const readerLabel = reader.state === 'on'
    ? (linkFor ? `Tap the new card for ${linkFor.firstName} now` : 'Ready - tap a card on the back of this phone')
    : reader.state === 'starting' ? 'Starting…' : 'Card reader is off';

  const p = result && result.data;
  return (
    <section className="card sx-card vm-panel ci-card">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10.5a3 3 0 0 1 0 3M10 9a5.5 5.5 0 0 1 0 6" /></svg>
          <h2>Tap to check in</h2>
          {today && <span className="vm-bk-count" aria-label={`${today.length} check-ins today`}>{today.length}</span>}
        </span>
      </div>
      <div className="vm-panel-body">
        {NFC_SUPPORTED ? (
          <div className={`ci-reader ci-reader-${reader.state}`}>
            <span className="ci-reader-dot" aria-hidden="true" />
            <span className="ci-reader-text" role="status">{readerLabel}</span>
            {reader.state === 'on'
              ? <button type="button" className="btn" onClick={reader.stop}>Stop</button>
              : <button type="button" className="btn btn-primary" onClick={reader.start} disabled={reader.state === 'starting'}>Start card reader</button>}
          </div>
        ) : (
          <p className="muted vm-small">This browser can't read NFC cards. Card tapping works in Chrome on an Android phone. You can still type or scan a card number below.</p>
        )}
        {reader.error && <p className="error vm-small">{reader.error}</p>}

        <form className="au-search ci-manual" onSubmit={submitManual}>
          <input className="ah-search" value={manual} onChange={(e) => setManual(e.target.value)} placeholder={linkFor ? 'New card number' : 'Card number'} aria-label="Card number" autoComplete="off" disabled={busy} />
          <button className="btn" type="submit" disabled={busy || !manual.trim()}>{linkFor ? 'Link' : 'Check in'}</button>
        </form>

        {busy && <p className="vm-small">Working…</p>}
        {error && <p className="error">{error}</p>}
        {notice && <p className="vm-wi-notice" role="status">{notice}</p>}

        {result && result.kind === 'unknown' && !linkFor && (
          <div className="ci-result ci-result-unknown">
            <p><strong>This card isn't linked to anyone yet.</strong> <span className="ci-uid">{result.uid}</span></p>
            <p className="muted vm-small">Find the player to link it to:</p>
            <VenuePlayerPicker venueId={venueId} disabled={busy} onPick={(pl) => handleLinkPick(pl, result.uid)} />
          </div>
        )}

        {p && (result.kind === 'player' || result.kind === 'linked') && (
          <div className={`ci-result ci-result-${p.membershipStatus}`}>
            <div className="ci-result-head">
              <strong className="ci-name"><PlayerLink playerId={p.playerId}>{p.firstName} {p.lastName}</PlayerLink></strong>
              <CheckinStatusChip status={p.membershipStatus} renewalDate={p.membershipRenewalDate} />
              {p.status === 'suspended' && <span className="status status-disputed">suspended</span>}
            </div>
            <p className="muted vm-small">
              {result.kind === 'player' ? `${result.repeat ? 'Already checked in' : 'Checked in'} at ${ukTime(result.at)} · ` : ''}
              Visits here: {p.visitCount}
            </p>
            {result.kind === 'player' || p.membershipStatus !== 'not-member' ? (
              <RenewButtons player={p} busy={renewing} onRenew={renew} />
            ) : null}
            <div className="ci-actions">
              <button type="button" className="btn btn-primary" onClick={() => setWalkinFor(walkinFor ? null : p)}>
                {walkinFor ? 'Close walk-in' : 'Book walk-in'}
              </button>
              <button type="button" className="btn" onClick={() => { setResult(null); setWalkinFor(null); setNotice(''); }}>Clear</button>
            </div>
            {walkinFor && (
              <WalkinForm
                key={walkinFor.id}
                venueId={venueId}
                initialPlayer={{ firstName: walkinFor.firstName, lastName: walkinFor.lastName, email: walkinFor.email }}
                onDone={(msg) => { setWalkinFor(null); setNotice(msg); }}
                onClose={() => setWalkinFor(null)}
              />
            )}
            {result.kind === 'player' && p.membershipStatus !== 'not-member' && (
              <details className="ci-cards-box">
                <summary>Cards ({p.cards.length})</summary>
                <CardList cards={p.cards} busy={busy} onUnlink={(uid) => unlink(p, uid)} />
              </details>
            )}
          </div>
        )}

        <div className="ci-link-box">
          {!linking ? (
            <button type="button" className="btn" onClick={() => { setLinking(true); setLinkFor(null); setNotice(''); }}>Link a card to a player</button>
          ) : (
            <div className="ci-linking">
              <div className="ci-linking-head">
                <strong>{linkFor ? `Linking a card to ${linkFor.firstName} ${linkFor.lastName}` : 'Link a card to a player'}</strong>
                <button type="button" className="btn" onClick={() => { setLinking(false); setLinkFor(null); }}>Cancel</button>
              </div>
              {!linkFor ? (
                <VenuePlayerPicker venueId={venueId} disabled={busy} onPick={(pl) => { setLinkFor(pl); setNotice(''); }} />
              ) : (
                <>
                  <p className="vm-small">
                    {NFC_SUPPORTED
                      ? (reader.state === 'on' ? 'Tap the new card on the back of this phone now,' : 'Start the card reader above and tap the new card,')
                      : 'Type or scan the new card number above,'} or type its number in the box above.
                  </p>
                  <p className="muted vm-small">Cards already linked to {linkFor.firstName}:</p>
                  <CardList cards={linkFor.cards || []} busy={busy} onUnlink={(uid) => unlink(linkFor, uid)} />
                </>
              )}
            </div>
          )}
        </div>

        {(() => {
          const all = today || [];
          const visible = all.filter((v) => !v.hidden);
          const hiddenCount = all.length - visible.length;
          const rows = showCleared ? all : visible;
          return (
            <>
              <div className="ci-today-bar">
                <h3 className="ci-today-head">Today's check-ins</h3>
                {visible.length > 0 && (
                  <button
                    type="button"
                    className={`btn ci-clear${armedClear ? ' btn-danger' : ''}`}
                    onClick={clearToday}
                    disabled={todayBusy}
                  >
                    {armedClear ? 'Tap to confirm' : 'Clear list'}
                  </button>
                )}
              </div>
              {!today ? <p className="muted vm-small">Loading…</p> : rows.length === 0 ? (
                <p className="muted vm-small">{hiddenCount > 0 ? 'List cleared. New check-ins will show here.' : 'Nobody has checked in yet today.'}</p>
              ) : (
                <ul className="ci-today">
                  {rows.map((v) => (
                    <li key={v.id} className={v.hidden ? 'ci-hidden' : undefined}>
                      <span className="ci-time">{ukTime(v.at)}</span>
                      <span className="ci-who"><Link to={`/venue-manager/players/${v.userId}?venueId=${encodeURIComponent(venueId)}`}>{v.name}</Link></span>
                      <span className="muted vm-small">{v.source === 'tag' ? 'Bar tag' : 'Card'}</span>
                      <CheckinStatusChip status={v.membershipStatus} small />
                      <button
                        type="button"
                        className={`ci-del${armedDelete === v.id ? ' ci-del-armed' : ''}`}
                        onClick={() => deleteVisit(v)}
                        disabled={todayBusy}
                        aria-label={armedDelete === v.id ? `Confirm deleting ${v.name}'s check-in at ${ukTime(v.at)}` : `Delete ${v.name}'s check-in at ${ukTime(v.at)}`}
                      >
                        {armedDelete === v.id ? 'Delete?' : '✕'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {hiddenCount > 0 && (
                <button type="button" className="ci-show-cleared" onClick={() => setShowCleared((s) => !s)}>
                  {showCleared ? 'Hide cleared check-ins' : `Show ${hiddenCount} cleared check-in${hiddenCount === 1 ? '' : 's'}`}
                </button>
              )}
            </>
          );
        })()}

        <BarTagPanel venueId={venueId} />
      </div>
    </section>
  );

  function handleLinkPick(pl, uid) {
    setBusy(true); setError('');
    api.linkVenueCard(venueId, pl.id, uid)
      .then((data) => {
        setNotice(`Card linked to ${data.firstName} ${data.lastName}.`);
        return api.venueCheckin(venueId, uid).then((r) => {
          if (r.found) { setResult({ kind: 'player', data: r.player, repeat: r.repeat, at: r.visit.at }); loadToday(); }
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }
}

export default function VenueManagerPortal() {
  const { user, isAdmin } = useAuth();
  const [venues, setVenues] = useState(null);
  const [selectedVenueId, setSelectedVenueId] = useState('');
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Venue Manager Portal' }]);
  const selectedVenue = (venues || []).find((v) => v.id === selectedVenueId);

  useEffect(() => {
    api.getMyManagedVenues()
      .then((v) => {
        setVenues(v);
        if (v.length > 0) setSelectedVenueId(v[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedVenueId) return;
    setStatusLoading(true);
    api.getVenueManagerStatus(selectedVenueId)
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setStatusLoading(false));
  }, [selectedVenueId]);

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/" className="msg-icon-btn" aria-label="Back to home">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <span className="vm-title">
          <h1>Venue Manager</h1>
          {selectedVenue && <span className="muted">{selectedVenue.name}</span>}
        </span>
        {user?.isVenueManager ? (
          <span className="status status-completed">Venue Manager</span>
        ) : isAdmin ? (
          <span className="status">Viewing as admin</span>
        ) : null}
      </div>

      {error && <p className="error">{error}</p>}

      {!venues ? (
        <p>Loading…</p>
      ) : venues.length === 0 ? (
        <p className="muted">
          You haven't been assigned to a venue yet - an Overall Admin assigns Venue Manager access
          from the Membership Management page.
        </p>
      ) : (
        <>
          {venues.length > 1 && (
            <div className="vm-switch">
              <label className="ll-field">
                Venue
                <select className="mm-input" value={selectedVenueId} onChange={(e) => setSelectedVenueId(e.target.value)}>
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {selectedVenueId && <CheckinCard venueId={selectedVenueId} />}
          {selectedVenueId && <BookingsCard venueId={selectedVenueId} />}
          <StatusBox status={status} loading={statusLoading} venueId={selectedVenueId} />
          {selectedVenueId && <PlayerSearchBox venueId={selectedVenueId} />}
          {selectedVenueId && <RegisteredPlayersList venueId={selectedVenueId} />}
        </>
      )}
    </div>
  );
}
