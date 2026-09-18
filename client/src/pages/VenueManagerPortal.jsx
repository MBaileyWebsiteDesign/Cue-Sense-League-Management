import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

// The Venue Manager Portal - a Venue Manager's home base for the one (or
// more) venue(s) an Overall Admin has granted them access to (see
// assertVenueAccess in server/src/userAuth.js and the "Venue Managers"
// panel on MembershipManagement.jsx). First pass, per Matt's request: a
// Status box (registered players + due-for-renewal counts) and a player
// search box. Every count in the Status box is expected to read 0 today -
// there's no UI yet to set a player's membership renewal date, so nobody
// has one; that's a follow-up step, not a bug in this page.
// A whole stat tile that is clickable when its count is non-zero (there's
// nothing to show for a zero count, so those tiles stay plain and inert).
// Renders the same markup/classes as a plain stat card - no button chrome,
// no underline - just a pointer cursor and an accent highlight while its
// player list is open, plus keyboard support (Enter/Space) since it's a
// real interactive control under the hood.
function DueTile({ label, count, active, onClick, caption }) {
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
          <div className="card">
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
          />
          <DueTile
            label="Due in 4 months"
            count={status.dueIn4Months}
            active={openBucket === 4}
            onClick={() => toggleBucket(4)}
            caption="membership renewal"
          />
          <DueTile
            label="Due in 2 months"
            count={status.dueIn2Months}
            active={openBucket === 2}
            onClick={() => toggleBucket(2)}
            caption="membership renewal"
          />
        </div>
      )}
      {openBucket && (
        <DuePlayersPanel venueId={venueId} months={openBucket} onClose={() => setOpenBucket(null)} />
      )}
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12 }}>
        Renewal counts are 0 until a membership renewal date is set against a player - that's not
        built yet, so this is expected for now. Click a non-zero tile to see who it is.
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
        </>
      )}
    </div>
  );
}
