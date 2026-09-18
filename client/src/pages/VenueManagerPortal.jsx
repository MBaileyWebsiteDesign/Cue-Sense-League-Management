import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

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

// A whole stat tile that is clickable when its count is non-zero (there's
// nothing to show for a zero count, so those tiles stay plain and inert).
// Renders the same markup/classes as a plain stat card - no button chrome,
// no underline - just a pointer cursor and an accent highlight while its
// player list is open, plus keyboard support (Enter/Space) since it's a
// real interactive control under the hood. `tint` sets the card's pale
// traffic-light background.
function DueTile({ label, count, active, onClick, caption, tint }) {
  const clickable = count > 0;
  return (
    <div
      className="card"
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{
        cursor: clickable ? 'pointer' : 'default',
        backgroundColor: tint,
        boxShadow: active ? 'inset 0 0 0 2px var(--accent, #2563eb)' : undefined,
      }}
    >
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      <p
        style={{
          fontSize: '2rem',
          fontWeight: 700,
          margin: 0,
          color: active ? 'var(--accent, #2563eb)' : 'inherit',
        }}
      >
        {count}
      </p>
      <p className="muted" style={{ margin: 0 }}>{caption}</p>
    </div>
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
    <div className="card" style={{ marginTop: 12 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Due in {months} months</h3>
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        <table className="standings-table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Renewal due</th></tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id}>
                <td style={{ textAlign: 'left' }}>{p.firstName} {p.lastName}</td>
                <td style={{ textAlign: 'left' }}>{p.email}</td>
                <td>{p.membershipRenewalDate || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBox({ status, loading, venueId }) {
  const [openBucket, setOpenBucket] = useState(null);
  const toggleBucket = (months) => setOpenBucket((prev) => (prev === months ? null : months));

  return (
    <section className="card">
      <h2>Status</h2>
      {loading || !status ? (
        <p>Loading…</p>
      ) : (
        <div className="card-grid">
          <div className="card" style={{ backgroundColor: registeredPlayersTint(status.registeredPlayers) }}>
            <h3 style={{ marginTop: 0 }}>Registered players</h3>
            <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>{status.registeredPlayers}</p>
            <p className="muted" style={{ margin: 0 }}>at this venue</p>
          </div>
          <DueTile
            label="Due in 6 months"
            count={status.dueIn6Months}
            active={openBucket === 6}
            onClick={() => toggleBucket(6)}
            caption="membership renewal"
            tint={TINT_GREEN}
          />
          <DueTile
            label="Due in 4 months"
            count={status.dueIn4Months}
            active={openBucket === 4}
            onClick={() => toggleBucket(4)}
            caption="membership renewal"
            tint={TINT_YELLOW}
          />
          <DueTile
            label="Due in 2 months"
            count={status.dueIn2Months}
            active={openBucket === 2}
            onClick={() => toggleBucket(2)}
            caption="membership renewal"
            tint={TINT_RED}
          />
        </div>
      )}
      {openBucket && (
        <DuePlayersPanel venueId={venueId} months={openBucket} onClose={() => setOpenBucket(null)} />
      )}
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12 }}>
        Each "Due in N months" tile now counts only players whose renewal falls in that specific
        window (2 months: within the next 2 months; 4 months: more than 2 but within 4; 6 months:
        more than 4 but within 6) - a player only ever appears in one tile, not every tile up to
        their actual renewal window.
      </p>
    </section>
  );
}

function PlayerSearchBox({ venueId }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <section className="card">
      <h2>Search players</h2>
      <p className="muted">Search by first name, last name, or both.</p>
      <form className="inline-form" onSubmit={onSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name…"
        />
        <button className="btn btn-primary" type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {results && (
        results.length === 0 ? (
          <p className="muted">No players at this venue match that search.</p>
        ) : (
          <table className="standings-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Status</th><th>Renewal due</th></tr>
            </thead>
            <tbody>
              {results.map((p) => (
                <tr key={p.id}>
                  <td style={{ textAlign: 'left' }}>{p.firstName} {p.lastName}</td>
                  <td style={{ textAlign: 'left' }}>{p.email}</td>
                  <td>{p.status}</td>
                  <td>{p.membershipRenewalDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

  useEffect(() => {
    let cancelled = false;
    setPlayers(null);
    setError('');
    api.searchVenuePlayers(venueId, '')
      .then((p) => { if (!cancelled) setPlayers(p); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [venueId]);

  return (
    <section className="card">
      <h2>Registered players</h2>
      <p className="muted">Everyone currently registered to this venue.</p>
      {error && <p className="error">{error}</p>}
      {!players && !error ? (
        <p>Loading…</p>
      ) : players && (
        players.length === 0 ? (
          <p className="muted">No players are registered to this venue yet.</p>
        ) : (
          <table className="standings-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Status</th><th>Renewal due</th></tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <td style={{ textAlign: 'left' }}>{p.firstName} {p.lastName}</td>
                  <td style={{ textAlign: 'left' }}>{p.email}</td>
                  <td>{p.status}</td>
                  <td>{p.membershipRenewalDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}

export default function VenueManagerPortal() {
  const { user } = useAuth();
  const [venues, setVenues] = useState(null);
  const [selectedVenueId, setSelectedVenueId] = useState('');
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Venue Manager Portal' }]);

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
    <div>
      <h1>Venue Manager Portal</h1>
      <p className="muted">
        Signed in as <strong>{user.firstName} {user.lastName}</strong> · flagged as a Venue Manager.
      </p>

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
            <div className="inline-form">
              <label>
                Venue
                <select value={selectedVenueId} onChange={(e) => setSelectedVenueId(e.target.value)}>
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
