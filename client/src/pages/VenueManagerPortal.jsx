import { useEffect, useState } from 'react';
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
      aria-pressed={active}
      onClick={onClick}
    >
      {inner}
    </button>
  ) : (
    <div className="vm-tile" style={{ backgroundColor: tint }}>{inner}</div>
  );
}

// One player as a compact card (2026-10-06): name/email (links to their profile
// when they have one) with the small quick-renew buttons beside it, and a
// foot line with the renewal date (tinted as it gets close), status and Remove.
function renewalExpired(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || '');
  if (!match) return false;
  const today = new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

function PlayerCard({ p, busy, onRenew, onRemove, removing = false, showStatus = true }) {
  const urgency = renewalUrgency(p.membershipRenewalDate);
  // Coloured edge + chip by how close the renewal is (same bands as the Status
  // tiles: red = due within 2 months or already past, amber = within 4, green = later).
  const tone = !p.membershipRenewalDate ? 'none' : urgency === 'red' ? 'red' : urgency === 'amber' ? 'amber' : 'green';
  const initials = `${(p.firstName || '').charAt(0)}${(p.lastName || '').charAt(0)}`.toUpperCase() || '?';
  return (
    <li className={`vm-player vm-player-${tone}`}>
      <span className="vm-player-ini" aria-hidden="true">{initials}</span>
      <span className="vm-player-main">
        <strong><PlayerLink playerId={p.playerId}>{p.firstName} {p.lastName}</PlayerLink></strong>
        <span className="muted vm-small">{p.email}</span>
      </span>
      <span className="vm-player-foot">
        <span className={`vm-renews vm-renews-${tone}`}>
          {p.membershipRenewalDate ? `${renewalExpired(p.membershipRenewalDate) ? 'Expired' : 'Expires'} ${formatDateUK(p.membershipRenewalDate)}` : 'No expiry date set'}
        </span>
        {showStatus && p.status && (
          <span className={`status ${p.status === 'suspended' ? 'status-disputed' : 'status-completed'}`}>{p.status}</span>
        )}
        {p.expiryEmailSentAt && (
          <span className="status status-completed" title="The 5-day membership-expiry email has been sent to this player">
            Email sent {formatDateUK(String(p.expiryEmailSentAt).slice(0, 10))}
          </span>
        )}
        {onRemove && <RemovePlayerButton player={p} busy={removing} onRemove={onRemove} />}
      </span>
      {onRenew && <RenewButtons player={p} busy={busy} onRenew={onRenew} />}
    </li>
  );
}

// "Remove from venue" button at the foot of a Registered players row. Two taps,
// like the table-booking cancel buttons: the first arms it (and it disarms
// itself after a few seconds), the second confirms. Removing only drops the
// player's membership at this venue - they register again to come back.
function RemovePlayerButton({ player, busy, onRemove }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  const name = `${player.firstName} ${player.lastName}`;
  return (
    <span style={{ display: 'flex', justifyContent: 'flex-end', marginLeft: 'auto' }}>
      <button
        type="button"
        className={`vm-bk-cancel${armed ? ' vm-bk-cancel-armed' : ''}`}
        disabled={busy}
        aria-label={armed ? `Confirm removing ${name} from this venue` : `Remove ${name} from this venue`}
        onClick={() => {
          if (!armed) { setArmed(true); return; }
          setArmed(false);
          onRemove(player);
        }}
      >
        {busy ? 'Removing…' : armed ? 'Tap to confirm' : 'Remove from venue'}
      </button>
    </span>
  );
}

// Status card (top of the page). Tapping a tile no longer opens a list inside
// this card - it filters the Registered players card below instead (Matt,
// 2026-10-06), via `selected` / `onSelect` held by the page: 'all' or null =
// everyone, 2 / 4 / 6 = players due for renewal in that window.
function StatusBox({ status, loading, selected, onSelect }) {
  const pick = (value) => onSelect(selected === value ? null : value);

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
            active={selected === 'all'}
            onClick={() => pick('all')}
            caption="at this venue"
            tint={registeredPlayersTint(status.registeredPlayers)}
          />
          <DueTile
            label="Due in 2 months"
            count={status.dueIn2Months}
            active={selected === 2}
            onClick={() => pick(2)}
            caption="renewals"
            tint={TINT_RED}
          />
          <DueTile
            label="Due in 4 months"
            count={status.dueIn4Months}
            active={selected === 4}
            onClick={() => pick(4)}
            caption="renewals"
            tint={TINT_YELLOW}
          />
          <DueTile
            label="Due in 6 months"
            count={status.dueIn6Months}
            active={selected === 6}
            onClick={() => pick(6)}
            caption="renewals"
            tint={TINT_GREEN}
          />
        </div>
      )}
      <p className="muted vm-small" style={{ margin: 0 }}>
        Each player is counted in one window only. Tap a tile to filter the Registered players list.
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

// Registered players card, with the player search built into the top of it.
// With the box empty the card lists everyone registered to this venue; Search
// swaps the list for just the matches (same GET /api/venue-manager/players
// endpoint, which already returns everyone when `q` is blank), and Clear
// brings the full list back. The header count always shows the venue's total
// registered players, not the number of matches.
function RegisteredPlayersList({ venueId, bucket = null, onShowAll, onRemoved }) {
  const dueMonths = typeof bucket === 'number' ? bucket : null; // 2 | 4 | 6 filters the list to that renewal window
  const [players, setPlayers] = useState(null);
  const [total, setTotal] = useState(null);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [renewingId, setRenewingId] = useState(null);
  const [renewError, setRenewError] = useState('');
  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState('');
  const [removedNote, setRemovedNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setTotal(null);
    setQuery('');
    setActiveQuery('');
    setError('');
    const load = dueMonths ? api.getVenueManagerDuePlayers(venueId, dueMonths) : api.searchVenuePlayers(venueId, '');
    load
      .then((p) => { if (!cancelled) { setPlayers(p); if (!dueMonths) setTotal(p.length); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [venueId, dueMonths]);

  const runSearch = async (q) => {
    const trimmed = q.trim();
    setSearching(true);
    setError('');
    try {
      // A search looks through everyone; clearing it goes back to whatever the
      // Status tile filter is showing (or everyone).
      const found = trimmed || !dueMonths
        ? await api.searchVenuePlayers(venueId, trimmed)
        : await api.getVenueManagerDuePlayers(venueId, dueMonths);
      setPlayers(found);
      setActiveQuery(trimmed);
      if (!trimmed && !dueMonths) setTotal(found.length);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const onSearch = (e) => {
    e.preventDefault();
    runSearch(query);
  };

  const onClear = () => {
    setQuery('');
    runSearch('');
  };

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

  const onRemove = async (player) => {
    setRemovingId(player.id);
    setRemoveError('');
    setRemovedNote('');
    try {
      await api.removeVenuePlayer(venueId, player.id);
      setPlayers((prev) => prev && prev.filter((p) => p.id !== player.id));
      setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
      setRemovedNote(`${player.firstName} ${player.lastName} was removed from this venue. They'll need to register again to get back in.`);
      if (onRemoved) onRemoved();
    } catch (err) {
      setRemoveError(err.message);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section className="card sx-card vm-panel" id="vm-registered-players">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" /></svg>
          <h2>Registered players</h2>
          {total !== null && <span className="vm-bk-count" aria-label={`${total} registered players`}>{total}</span>}
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
        {activeQuery && (
          <button className="btn" type="button" onClick={onClear} disabled={searching}>
            Clear
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
      {renewError && <p className="error">{renewError}</p>}
      {removeError && <p className="error">{removeError}</p>}
      {removedNote && <p className="muted">{removedNote}</p>}
      {dueMonths && !activeQuery && players && (
        <p className="muted vm-filter-note">
          Showing players due in {dueMonths} months ({players.length}).{' '}
          <button type="button" className="btn dv-small-btn" onClick={onShowAll}>Show everyone</button>
        </p>
      )}
      {activeQuery && players && (
        <p className="muted">
          {players.length} of {total} player{total === 1 ? '' : 's'} match “{activeQuery}”.
        </p>
      )}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        players.length === 0 ? (
          <p className="muted">
            {activeQuery
              ? 'No players at this venue match that search.'
              : dueMonths
                ? 'No players are due for renewal in this window.'
                : 'No players are registered to this venue yet.'}
          </p>
        ) : (
          <ul className="vm-players">
            {players.map((p) => (
              <PlayerCard key={p.id} p={p} busy={renewingId === p.id} onRenew={onRenew} onRemove={onRemove} removing={removingId === p.id} />
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

// What the chip on an unpaid ("Not paid") table booking says, from the
// booking customer's membership at this venue (matched by email on the
// server): active member = green, expired = yellow, no membership = red and
// tappable (becomes green "Paid" once marked). A member entry with no end date
// counts as active.
// Wix sometimes sends a payment status of UNDEFINED (it used to show up as a
// yellow "UNDEFINED" chip) - treat it like "Not paid" so it gets the same
// membership check instead of a meaningless label.
const needsPayCheck = (b) => b.paymentStatus === 'NOT_PAID' || b.paymentStatus === 'UNDEFINED';

function notPaidChip(b) {
  const m = b.membershipStatus;
  if (m === 'active' || m === 'no-dates') return { text: 'Active Membership', cls: 'vm-bk-paid', clickable: false };
  if (m === 'expired') return { text: 'Membership Expired', cls: 'vm-bk-pay-amber', clickable: false };
  return b.markedPaid
    ? { text: 'Paid', cls: 'vm-bk-paid', clickable: true }
    : { text: 'Needs to pay', cls: 'vm-bk-pay-red', clickable: true };
}

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
function walkinStartOptions(hours = DEFAULT_OPENING_HOURS, days = 7) {
  const step = 30 * 60 * 1000;
  const first = Math.floor(Date.now() / step) * step;
  const opts = [];
  for (let i = 0; i < days * 48; i++) {
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

// "Book table(s) for a day" and "Block book table(s) for a day" (Matt,
// 2026-09-26, reworked 2026-10-03): block one or more tables so they can't
// be booked online. Tick the table(s) - by default every table except the
// 8 Ball / Chinese one, as the old "all tables" option did. Day mode blocks
// each ticked table from opening (or now) to closing; timed mode blocks a
// chosen start-to-finish window instead, and only offers times when every
// ticked table is genuinely free (opening hours minus the bookings and
// blocks already on those tables, read fresh from Wix by the server).
const BOOK_ALL_EXCLUDE_RE = /\b(8[\s-]?ball|chinese)\b/i;
// Blocks (unlike walk-in bookings) can go two weeks ahead.
const BLOCK_DAYS_AHEAD = 14;

function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function BookTablesForm({ venueId, timed, onDone, onClose }) {
  const [openingHours, setOpeningHours] = useState(DEFAULT_OPENING_HOURS);
  const [startOpts, setStartOpts] = useState(() => walkinStartOptions(undefined, BLOCK_DAYS_AHEAD));
  const dayOpts = walkinDayOptions(startOpts);
  const [day, setDay] = useState(() => (dayOpts[0] ? dayOpts[0].value : ''));
  const [tables, setTables] = useState([]);
  const [picked, setPicked] = useState([]);
  const [busyList, setBusyList] = useState([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [startMin, setStartMin] = useState(null);
  const [endMin, setEndMin] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getWalkinTables(venueId)
      .then((d) => {
        if (Array.isArray(d.openingHours) && d.openingHours.length === 7) {
          setOpeningHours(d.openingHours);
          setStartOpts(walkinStartOptions(d.openingHours, BLOCK_DAYS_AHEAD));
        }
        if (Array.isArray(d.tables)) {
          setTables(d.tables);
          setPicked(d.tables.filter((t) => !BOOK_ALL_EXCLUDE_RE.test(t.name)).map((t) => t.id));
        }
      })
      .catch(() => {});
  }, [venueId]);

  useEffect(() => {
    const opts = walkinDayOptions(startOpts);
    setDay((cur) => (opts.find((o) => o.value === cur) ? cur : (opts[0] ? opts[0].value : '')));
  }, [startOpts]);

  // Timed mode: what's already booked or blocked that day.
  useEffect(() => {
    if (!timed || !day) return undefined;
    let cancelled = false;
    setAvailLoading(true);
    setBusyList([]);
    api.getTableAvailability(venueId, day)
      .then((d) => { if (!cancelled) { setBusyList(Array.isArray(d.busy) ? d.busy : []); setError(''); } })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setAvailLoading(false); });
    return () => { cancelled = true; };
  }, [timed, venueId, day]);

  // Free half-hour slots for the ticked tables (timed mode).
  let startChoices = [];
  let endChoices = [];
  let startVal = null;
  let endVal = null;
  if (timed && day) {
    const [yy, mm, dd] = day.split('-').map(Number);
    const hours = openingHours[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()] || { open: 660, close: 1380 };
    const todayKey = ukDayKey(new Date().toISOString());
    const [nh, nm] = ukTime(new Date().toISOString()).split(':').map(Number);
    const nowMin = Math.floor((nh * 60 + nm) / 30) * 30;
    const minOf = (iso) => {
      const k = ukDayKey(iso);
      if (k < day) return 0;
      if (k > day) return 1440;
      const [h, m] = ukTime(iso).split(':').map(Number);
      return h * 60 + m;
    };
    const intervals = busyList.filter((b) => picked.includes(b.tableId)).map((b) => [minOf(b.start), minOf(b.end)]);
    const slotFree = (m) => !intervals.some(([s, en]) => s < m + 30 && en > m);
    for (let m = hours.open; m <= hours.close - 30; m += 30) {
      if (day === todayKey && m < nowMin) continue;
      if (slotFree(m)) startChoices.push(m);
    }
    startVal = startChoices.includes(startMin) ? startMin : (startChoices.length ? startChoices[0] : null);
    if (startVal != null) {
      for (let m = startVal + 30; m <= hours.close; m += 30) {
        if (!slotFree(m - 30)) break;
        endChoices.push(m);
      }
    }
    endVal = endChoices.includes(endMin) ? endMin : (endChoices.length ? endChoices[endChoices.length - 1] : null);
  }

  const togglePicked = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = (ev) => {
    ev.preventDefault();
    if (!day) { setError('Choose a day.'); return; }
    if (!picked.length) { setError('Choose at least one table.'); return; }
    if (timed && (startVal == null || endVal == null)) { setError('Choose a start and finish time.'); return; }
    setSaving(true);
    setError('');
    const opts = { tableIds: picked, ...(timed ? { startTime: hmLabel(startVal), endTime: hmLabel(endVal) } : {}) };
    api.bookAllTables(venueId, day, opts)
      .then((r) => {
        const lines = (r.results || []).map((x) => (x.ok
          ? `${x.table}: booked ${ukTime(x.start)}–${ukTime(x.end)}.`
          : `${x.table}: ${x.error}`));
        const heading = timed ? `Table(s) blocked ${hmLabel(startVal)}–${hmLabel(endVal)}:` : 'Table(s) booked for the day:';
        onDone([heading, ...lines].join(' '));
      })
      .catch((err) => setError(err.message))
      .finally(() => setSaving(false));
  };

  const noTimes = timed && !availLoading && picked.length > 0 && startChoices.length === 0;

  return (
    <form className="vm-wi" onSubmit={submit}>
      <label className="vm-wi-field">
        <span>Day</span>
        <select className="mm-input" value={day} onChange={(ev) => setDay(ev.target.value)} disabled={saving}>
          {dayOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <div className="vm-wi-field">
        <span>Table(s)</span>
        <div className="vm-wi-tables">
          {tables.map((t) => (
            <label key={t.id} className="vm-wi-check">
              <input type="checkbox" checked={picked.includes(t.id)} onChange={() => togglePicked(t.id)} disabled={saving} />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
        <div className="vm-wi-quick">
          <button type="button" className="btn vm-wi-quick-btn" disabled={saving} onClick={() => setPicked(tables.map((t) => t.id))}>All</button>
          <button type="button" className="btn vm-wi-quick-btn" disabled={saving} onClick={() => setPicked(tables.filter((t) => !BOOK_ALL_EXCLUDE_RE.test(t.name)).map((t) => t.id))}>All except 8 Ball / Chinese</button>
          <button type="button" className="btn vm-wi-quick-btn" disabled={saving} onClick={() => setPicked([])}>None</button>
        </div>
      </div>
      {timed && (
        <div className="vm-wi-times">
          <label className="vm-wi-field">
            <span>Start</span>
            <select className="mm-input" value={startVal == null ? '' : startVal} onChange={(ev) => setStartMin(Number(ev.target.value))} disabled={saving || availLoading || !startChoices.length}>
              {startChoices.map((m) => <option key={m} value={m}>{hmLabel(m)}</option>)}
            </select>
          </label>
          <label className="vm-wi-field">
            <span>Finish</span>
            <select className="mm-input" value={endVal == null ? '' : endVal} onChange={(ev) => setEndMin(Number(ev.target.value))} disabled={saving || availLoading || !endChoices.length}>
              {endChoices.map((m) => <option key={m} value={m}>{hmLabel(m)}</option>)}
            </select>
          </label>
        </div>
      )}
      <span className="vm-wi-hours">
        {timed
          ? (availLoading
            ? 'Checking what is already booked…'
            : noTimes
              ? 'No free times that day on the ticked table(s) - untick a table or pick another day.'
              : 'Blocks the ticked table(s) between the start and finish. Only times when every ticked table is free are shown.')
          : 'Books each ticked table for the whole day (opening to closing, or from now if the day has started).'}
      </span>
      {error && <p className="error vm-small">{error}</p>}
      <div className="vm-wi-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || !dayOpts.length || !picked.length || (timed && (availLoading || startVal == null || endVal == null))}
        >
          {saving ? 'Booking…' : (timed ? 'Block book table(s)' : 'Book table(s)')}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Close</button>
      </div>
    </form>
  );
}

// Table bookings shows this many days that have bookings at a time.
const BOOKING_DAYS_STEP = 5;

// Groups one day's bookings into display rows. Active table blocks that share
// the same start, end and blocker (what "Block all tables for a day" creates -
// one block per table) collapse into a single row with one "Unblock" button;
// real bookings and walk-ins are never grouped, so they are never touched by it.
function groupRows(items) {
  const rows = [];
  const blockGroups = new Map();
  for (const b of items) {
    const cancelled = b.status === 'CANCELED' || b.status === 'DECLINED';
    if (b.blocked && !cancelled) {
      const key = `${b.start}|${b.end || ''}|${b.customerName || ''}`;
      let grp = blockGroups.get(key);
      if (!grp) {
        grp = { type: 'blocks', key, blocks: [] };
        blockGroups.set(key, grp);
        rows.push(grp);
      }
      grp.blocks.push(b);
    } else {
      rows.push({ type: 'booking', b });
    }
  }
  return rows;
}

function BookingsCard({ venueId }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [walkinOpen, setWalkinOpen] = useState(false);
  const [bookAllOpen, setBookAllOpen] = useState(false); // false | 'day' | 'timed'
  const [daysShown, setDaysShown] = useState(BOOKING_DAYS_STEP);
  const [notice, setNotice] = useState('');
  const [armedCancel, setArmedCancel] = useState(null); // booking id waiting for a second tap
  const [cancelling, setCancelling] = useState(null);
  const [payBusy, setPayBusy] = useState(null); // booking id whose Paid mark is being saved

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
    (b.blocked ? api.cancelBlock(venueId, b.id) : api.cancelWalkin(venueId, b.id))
      .then((r) => {
        setNotice(b.blocked
          ? `Block on ${b.table} removed - the table is free to book online again.`
          : b.walkIn
            ? `Walk-in on ${b.table} at ${ukTime(b.start)} cancelled - the table is free to book online again.`
            : `${b.customerName || 'Booking'} on ${b.table} at ${ukTime(b.start)} cancelled${r && r.notified ? ' - Wix will let the customer know' : ''}. The table is free to book online again.`);
        return api.getVenueBookings(venueId).then(setData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setCancelling(null));
  };

  // Unblock one grouped row: removes each table's block in turn (one request
  // per table, sequential so Wix isn't hit in parallel), then re-reads the list.
  // Two taps, like cancelling a booking. Only blocks are ever removed here.
  const cancelBlockGroup = async (grp) => {
    const armKey = `grp:${grp.key}`;
    if (armedCancel !== armKey) { setArmedCancel(armKey); return; }
    setArmedCancel(null);
    setCancelling(armKey);
    setError('');
    const failed = [];
    for (const b of grp.blocks) {
      try {
        await api.cancelBlock(venueId, b.id);
      } catch (e) {
        failed.push(`${b.table} (${e.message})`);
      }
    }
    const removed = grp.blocks.length - failed.length;
    if (removed > 0) {
      setNotice(grp.blocks.length === 1
        ? `Block on ${grp.blocks[0].table} removed - the table is free to book online again.`
        : `Blocks removed on ${removed} table${removed === 1 ? '' : 's'} - free to book online again.`);
    }
    if (failed.length) setError(`Couldn't remove the block on: ${failed.join(', ')}.`);
    try { setData(await api.getVenueBookings(venueId)); } catch (e) { /* list refreshes on the next live update */ }
    setCancelling(null);
  };

  // Tap on a red "Needs to pay" chip marks the booking paid (green "Paid");
  // tapping the green chip puts it back. Saved by this app only - it does not
  // change the booking in Wix.
  const markPaid = (b, paid) => {
    setPayBusy(b.id);
    setError('');
    api.setVenueBookingPaid(venueId, b.id, paid)
      .then(() => setData((d) => (d ? { ...d, bookings: d.bookings.map((x) => (x.id === b.id ? { ...x, markedPaid: paid } : x)) } : d)))
      .catch((e) => setError(e.message))
      .finally(() => setPayBusy(null));
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
          ) : bookAllOpen ? (
            <BookTablesForm
              venueId={venueId}
              timed={bookAllOpen === 'timed'}
              onClose={() => setBookAllOpen(false)}
              onDone={(msg) => {
                setBookAllOpen(false);
                setNotice(msg);
                api.getVenueBookings(venueId).then(setData).catch(() => {});
              }}
            />
          ) : (
            <>
              <div className="vm-bk-actions">
                <button type="button" className="btn vm-act vm-act-primary" onClick={() => { setNotice(''); setWalkinOpen(true); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  Book walk-in
                </button>
                <button type="button" className="btn vm-act vm-act-secondary" onClick={() => { setNotice(''); setBookAllOpen('day'); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
                  Book table(s) for a day
                </button>
                <button type="button" className="btn vm-act vm-act-secondary" onClick={() => { setNotice(''); setBookAllOpen('timed'); }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  Block book table(s) for a day
                </button>
              </div>
            </>
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
                {groupRows(g.items).map((row) => {
                  if (row.type === 'blocks') {
                    const first = row.blocks[0];
                    const n = row.blocks.length;
                    const armKey = `grp:${row.key}`;
                    const armed = armedCancel === armKey;
                    const busyGrp = cancelling === armKey;
                    const what = n > 1 ? `the blocks on ${n} tables` : `the block on ${first.table}`;
                    return (
                      <li key={row.key} className="vm-bk vm-bk-block">
                        <span className="vm-bk-time">
                          <strong>{ukTime(first.start)}</strong>
                          {first.end && <span>to {ukTime(first.end)}</span>}
                        </span>
                        <span className="vm-bk-main vm-bk-block-main">
                          <span className="vm-bk-block-title">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
                            <strong>{n > 1 ? `${n} tables blocked` : `${first.table} blocked`}</strong>
                          </span>
                          <span className="vm-bk-block-by">{first.customerName || 'Blocked'}</span>
                          {n > 1 && (
                            <span className="vm-bk-block-tags">
                              {row.blocks.map((blk) => (
                                <span key={blk.id} className="vm-bk-block-tag">{blk.table}</span>
                              ))}
                            </span>
                          )}
                        </span>
                        {data.walkIns && (
                          <span className="vm-bk-chips">
                            <button
                              type="button"
                              className={`vm-bk-cancel${armed ? ' vm-bk-cancel-armed' : ''}`}
                              onClick={() => cancelBlockGroup(row)}
                              disabled={busyGrp}
                              aria-label={armed ? `Confirm removing ${what}` : `Remove ${what}`}
                            >
                              {busyGrp ? 'Removing…' : armed ? 'Tap to confirm' : (n > 1 ? 'Unblock all' : 'Unblock')}
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  }
                  const b = row.b;
                  const st = BOOKING_STATUS[b.status] || { label: b.status ? 'Status unknown' : 'Unknown', cls: 'vm-bk-st-unknown' };
                  const cancelled = b.status === 'CANCELED' || b.status === 'DECLINED';
                  const tone = cancelled ? 'cancelled' : b.status === 'CONFIRMED' ? 'confirmed' : 'pending';
                  const payChip = !cancelled && !b.walkIn && !b.blocked && needsPayCheck(b) ? notPaidChip(b) : null;
                  const unpaid = !!payChip && payChip.cls === 'vm-bk-pay-red';
                  return (
                    <li key={b.id} className={`vm-bk vm-bk-${tone}${unpaid ? ' vm-bk-unpaid' : ''}`}>
                      <span className="vm-bk-time">
                        <strong>{ukTime(b.start)}</strong>
                        {b.end && <span>to {ukTime(b.end)}</span>}
                      </span>
                      <span className="vm-bk-main">
                        <strong>{b.table}</strong>
                        <span>{b.customerName || 'No name given'}</span>
                      </span>
                      <span className="vm-bk-chips">
                        {b.status !== 'CONFIRMED' && <span className={`status ${st.cls}`}>{st.label}</span>}
                        {b.blocked && <span className="vm-bk-walkin">Blocked</span>}
                        {b.walkIn && <span className="vm-bk-walkin">Walk-in</span>}
                        {payChip && (() => {
                          const chip = payChip;
                          return chip.clickable ? (
                            <button
                              type="button"
                              className={`vm-bk-pay vm-bk-pay-btn ${chip.cls}`}
                              disabled={payBusy === b.id}
                              onClick={() => markPaid(b, !b.markedPaid)}
                              aria-label={b.markedPaid ? `Marked as paid - tap to undo for ${b.customerName || 'this booking'}` : `Needs to pay - tap to mark ${b.customerName || 'this booking'} as paid`}
                            >
                              {payBusy === b.id ? '…' : chip.text}
                            </button>
                          ) : (
                            <span className={`vm-bk-pay ${chip.cls}`}>{chip.text}</span>
                          );
                        })()}
                        {!cancelled && !b.walkIn && !b.blocked && b.paymentStatus && !needsPayCheck(b) && (
                          <span className={`vm-bk-pay${b.paymentStatus === 'PAID' ? ' vm-bk-paid' : ''}`}>
                            {PAYMENT_LABEL[b.paymentStatus] || b.paymentStatus}
                          </span>
                        )}
                        {data.walkIns && !cancelled && (
                          <button
                            type="button"
                            className={`vm-bk-cancel${armedCancel === b.id ? ' vm-bk-cancel-armed' : ''}`}
                            onClick={() => cancelWalkin(b)}
                            disabled={cancelling === b.id}
                            aria-label={armedCancel === b.id
                              ? `Confirm ${b.blocked ? 'removing the block on' : 'cancelling'} ${b.table} at ${ukTime(b.start)}`
                              : `${b.blocked ? 'Unblock' : 'Cancel'} ${b.table} at ${ukTime(b.start)}`}
                          >
                            {cancelling === b.id
                              ? (b.blocked ? 'Removing…' : 'Cancelling…')
                              : armedCancel === b.id ? 'Tap to confirm' : (b.blocked ? 'Unblock' : 'Cancel')}
                          </button>
                        )}
                      </span>
                      {armedCancel === b.id && !b.walkIn && !b.blocked && (
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
          hiddenDays > 0 ? (
            <button
              type="button"
              className="btn vm-bk-more"
              onClick={() => setDaysShown((n) => n + BOOKING_DAYS_STEP)}
            >
              {`Show more (${Math.min(hiddenDays, BOOKING_DAYS_STEP)} more ${Math.min(hiddenDays, BOOKING_DAYS_STEP) === 1 ? 'day' : 'days'})`}
            </button>
          ) : (
            <p className="vm-bk-end">No more bookings</p>
          )
        )}
      </div>
    </section>
  );
}

// ---------- Checked in (today's check-ins) ----------
// Shows only today's check-ins at this venue (Matt, 2026-10-06 - the card
// reader, typed card numbers, card linking and the bar-tag panel were taken
// off this card; the bar check-in tag now lives on Admin Portal -> Membership,
// on each venue's card). Players still check in by tapping the bar tag with
// their own phone (see client/src/pages/CheckIn.jsx). "Clear list" hides
// everything so far (kept on record, "Show cleared" brings them back) and each
// row has a remove button that deletes that visit; both need a second tap.
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

function CheckinCard({ venueId }) {
  const [today, setToday] = useState(null);
  const [error, setError] = useState('');
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
    setToday(null);
    setShowCleared(false); setArmedClear(false); setArmedDelete(null);
    loadToday();
    const t = setInterval(loadToday, 30000);
    return () => clearInterval(t);
  }, [venueId]);

  const all = today || [];
  const visible = all.filter((v) => !v.hidden);
  const hiddenCount = all.length - visible.length;
  const rows = showCleared ? all : visible;

  return (
    <section className="card sx-card vm-panel ci-card">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10.5a3 3 0 0 1 0 3M10 9a5.5 5.5 0 0 1 0 6" /></svg>
          <h2>Checked in</h2>
          {today && <span className="vm-bk-count" aria-label={`${today.length} check-ins today`}>{today.length}</span>}
        </span>
      </div>
      <div className="vm-panel-body">
        {error && <p className="error">{error}</p>}
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
          <button type="button" className="ci-show-cleared" onClick={() => setShowCleared((x) => !x)}>
            {showCleared ? 'Hide cleared check-ins' : `Show ${hiddenCount} cleared check-in${hiddenCount === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </section>
  );
}

// Join policy + pending join requests for one venue. 'open' = players add
// the venue to their account themselves; 'approval' = they send a request
// that is approved/declined here (the player is emailed either way).
function JoinRequestsCard({ venue, onApproved }) {
  const venueId = venue.id;
  const [policy, setPolicy] = useState(venue.joinPolicy === 'approval' ? 'approval' : 'open');
  const [requests, setRequests] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [expiryOn, setExpiryOn] = useState(venue.expiryEmailsEnabled === true);
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.getVenueJoinRequests(venueId).then(setRequests).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const changePolicy = async (next) => {
    setSavingPolicy(true);
    setError('');
    setNotice('');
    try {
      await api.setVenueJoinPolicy(venueId, next);
      setPolicy(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingPolicy(false);
    }
  };

  const changeExpiry = async (next) => {
    setSavingExpiry(true);
    setError('');
    setNotice('');
    try {
      const r = await api.setVenueExpiryEmails(venueId, next);
      setExpiryOn(r.expiryEmailsEnabled === true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingExpiry(false);
    }
  };

  const decide = async (r, decision) => {
    setBusyId(r.id);
    setError('');
    setNotice('');
    try {
      await api.decideVenueJoinRequest(r.id, decision);
      setNotice(decision === 'approve' ? `${r.name} approved.` : `${r.name} declined.`);
      await load();
      if (decision === 'approve') onApproved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const count = requests ? requests.length : 0;
  return (
    <section className="card sx-card vm-panel">
      <div className="vm-bk-band">
        <span className="vm-bk-band-title">
          <h2>Join requests</h2>
          {requests !== null && count > 0 && <span className="vm-bk-count" aria-label={`${count} pending`}>{count}</span>}
        </span>
      </div>
      <div className="vm-panel-body">
        <label className="ll-field">
          How players join this venue
          <select className="mm-input" value={policy} disabled={savingPolicy} onChange={(e) => changePolicy(e.target.value)}>
            <option value="open">Anyone can join instantly</option>
            <option value="approval">Players must be approved</option>
          </select>
        </label>
        <label className="ll-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={expiryOn} disabled={savingExpiry} onChange={(e) => changeExpiry(e.target.checked)} />
          <span>Email players when their membership is 5 days from ending</span>
        </label>
        {error && <p className="error">{error}</p>}
        {notice && <p className="banner banner-success">{notice}</p>}
        {requests === null ? (
          <p className="muted">Loading…</p>
        ) : count === 0 ? (
          <p className="muted">No requests waiting.</p>
        ) : (
          <ul className="cs-venue-list">
            {requests.map((r) => (
              <li key={r.id} className="cs-venue-row">
                <span className="cs-venue-main">
                  <strong>{r.name}</strong>
                  <span className="muted">{r.email} · {formatDateUK(String(r.createdAt).slice(0, 10))}</span>
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-primary" disabled={busyId === r.id} onClick={() => decide(r, 'approve')}>Approve</button>
                  <button type="button" className="btn btn-danger" disabled={busyId === r.id} onClick={() => decide(r, 'decline')}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default function VenueManagerPortal() {
  const { user, isAdmin } = useAuth();
  const [venues, setVenues] = useState(null);
  const [selectedVenueId, setSelectedVenueId] = useState('');
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState('');
  // Bumped when a join request is approved so the status counts and the
  // registered-players list reload with the new member.
  const [memberRefresh, setMemberRefresh] = useState(0);
  // Bumped when a player is removed so the Status counts reload (the Registered
  // players list updates itself, so it isn't remounted and keeps its search).
  const [statusRefresh, setStatusRefresh] = useState(0);
  // Which Status tile is selected: null / 'all' = everyone, 2 / 4 / 6 = due in
  // that many months. Drives the Registered players list.
  const [bucket, setBucket] = useState(null);
  const pickBucket = (value) => {
    setBucket(value);
    if (value !== null) {
      // The list is further down the page - bring it into view.
      setTimeout(() => {
        const el = document.getElementById('vm-registered-players');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  };

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
  }, [selectedVenueId, memberRefresh, statusRefresh]);

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
                <select className="mm-input" value={selectedVenueId} onChange={(e) => { setSelectedVenueId(e.target.value); setBucket(null); }}>
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <StatusBox status={status} loading={statusLoading} selected={bucket} onSelect={pickBucket} />
          {selectedVenueId && <CheckinCard venueId={selectedVenueId} />}
          {selectedVenueId && <BookingsCard venueId={selectedVenueId} />}
          {selectedVenue && <JoinRequestsCard key={selectedVenue.id} venue={selectedVenue} onApproved={() => setMemberRefresh((n) => n + 1)} />}
          {selectedVenueId && <RegisteredPlayersList key={`${selectedVenueId}-${memberRefresh}`} venueId={selectedVenueId} bucket={bucket} onShowAll={() => setBucket(null)} onRemoved={() => setStatusRefresh((n) => n + 1)} />}
        </>
      )}
    </div>
  );
}
