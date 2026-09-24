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
  const clickable = count > 0 && !!onClick;
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
        {p.membershipRenewalDate ? `Renews ${formatDateUK(p.membershipRenewalDate)}` : 'No renewal date set'}
      </span>
      {onRenew && <RenewButtons player={p} busy={busy} onRenew={onRenew} />}
    </li>
  );
}

// The list of players behind whichever "Due in N months" tile is currently
// selected - same table pattern as PlayerSearchBox's results below, minus
// the Status column (Registered-players-only players are already filtered
// to non-suspended by the API, so it'd always read the same thing).
function DuePlayersPanel({ venueId, months, onClose }) {
  const [players, setPlayers] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setError('');
    api.getVenueManagerDuePlayers(venueId, months)
      .then((p) => { if (!cancelled) setPlayers(p); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [venueId, months]);

  return (
    <div className="vm-due-panel">
      <div className="sx-card-head">
        <h3 style={{ margin: 0 }}>Due in {months} months</h3>
        <button className="btn dv-small-btn" type="button" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        <ul className="vm-players">
          {players.map((p) => <PlayerCard key={p.id} p={p} showStatus={false} />)}
        </ul>
      )}
    </div>
  );
}

function StatusBox({ status, loading, venueId }) {
  const [openBucket, setOpenBucket] = useState(null);
  const toggleBucket = (months) => setOpenBucket((prev) => (prev === months ? null : months));

  return (
    <section className="card sx-card">
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Status</h2>
      {loading || !status ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="vm-tiles">
          <DueTile
            label="Registered players"
            count={status.registeredPlayers}
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
        Each player is counted in one window only. Tap a tile with players to see who's due.
      </p>
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
    <section className="card sx-card">
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Search players</h2>
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
    <section className="card sx-card">
      <div className="sx-card-head">
        <h2>Registered players</h2>
        {players && <span className="muted">{players.length}</span>}
      </div>
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
          <StatusBox status={status} loading={statusLoading} venueId={selectedVenueId} />
          {selectedVenueId && <PlayerSearchBox venueId={selectedVenueId} />}
          {selectedVenueId && <RegisteredPlayersList venueId={selectedVenueId} />}
        </>
      )}
    </div>
  );
}
