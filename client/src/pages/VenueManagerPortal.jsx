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
function StatusBox({ status, loading }) {
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
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Due in 6 months</h3>
            <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>{status.dueIn6Months}</p>
            <p className="muted" style={{ margin: 0 }}>membership renewal</p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Due in 4 months</h3>
            <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>{status.dueIn4Months}</p>
            <p className="muted" style={{ margin: 0 }}>membership renewal</p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Due in 2 months</h3>
            <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>{status.dueIn2Months}</p>
            <p className="muted" style={{ margin: 0 }}>membership renewal</p>
          </div>
        </div>
      )}
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12 }}>
        Renewal counts are 0 until a membership renewal date is set against a player - that's not
        built yet, so this is expected for now.
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
          <StatusBox status={status} loading={statusLoading} />
          {selectedVenueId && <PlayerSearchBox venueId={selectedVenueId} />}
        </>
      )}
    </div>
  );
}
