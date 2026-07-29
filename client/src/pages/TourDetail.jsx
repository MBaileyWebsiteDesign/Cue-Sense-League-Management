import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const ENTRY_TYPE_LABEL = { singles: 'Singles', teams: 'Teams', doubles: 'Doubles/Triples' };

// Admin panel for adding/removing divisions from a tour. Loads every
// league's divisions up front (this app is typically a handful of leagues
// with a handful of divisions each, so one Promise.all here is simpler than
// a two-step league-then-division picker) and offers only the ones that
// match this tour's entryType and aren't already in it.
function AddDivisionPanel({ tour, onChange, setError }) {
  const [candidates, setCandidates] = useState([]);
  const [divisionId, setDivisionId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getLeagues()
      .then((leagues) => Promise.all(leagues.map((l) => api.getLeague(l.id))))
      .then((hydratedLeagues) => {
        if (cancelled) return;
        const alreadyIn = new Set(tour.divisionIds);
        const options = hydratedLeagues.flatMap((league) =>
          league.divisions
            .filter((d) => d.entryType === tour.entryType && !alreadyIn.has(d.id))
            .map((d) => ({ id: d.id, label: `${league.name} — ${d.name}` }))
        );
        setCandidates(options);
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.divisionIds.join(',')]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!divisionId) return;
    setError('');
    setSubmitting(true);
    try {
      await api.addTourDivision(tour.id, divisionId);
      setDivisionId('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (candidates.length === 0) {
    return <p className="muted">No other {ENTRY_TYPE_LABEL[tour.entryType].toLowerCase()} divisions available to add.</p>;
  }

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <select value={divisionId} onChange={(e) => setDivisionId(e.target.value)} required>
        <option value="" disabled>Select a division…</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
      </select>
      <button className="btn btn-primary" type="submit" disabled={!divisionId || submitting}>
        {submitting ? 'Adding…' : 'Add to Tour'}
      </button>
    </form>
  );
}

export default function TourDetail() {
  const { tourId } = useParams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [tour, setTour] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getTour(tourId).then(setTour).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourId]);

  useSetBreadcrumbs(
    tour
      ? [{ label: 'Home', to: '/' }, { label: 'Tours', to: '/tours' }, { label: tour.name }]
      : [{ label: 'Home', to: '/' }, { label: 'Tours', to: '/tours' }, { label: 'Loading…' }]
  );

  if (!tour) return <p>Loading…</p>;

  const onRemoveDivision = async (divisionId) => {
    setError('');
    try {
      await api.removeTourDivision(tour.id, divisionId);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const onDeleteTour = async () => {
    setError('');
    try {
      await api.deleteTour(tour.id);
      navigate('/tours');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <p><Link to="/tours">&larr; All tours</Link></p>
      <div className="page-header">
        <div>
          <h1>{tour.name}</h1>
          <p className="muted">{ENTRY_TYPE_LABEL[tour.entryType] || tour.entryType} tour</p>
        </div>
        {isAdmin && (
          <button className="btn" onClick={onDeleteTour}>Delete Tour</button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Divisions in this Tour</h2>
        {tour.divisions.length === 0 ? (
          <p className="muted">No divisions added yet.</p>
        ) : (
          <ul className="player-list">
            {tour.divisions.map((d) => (
              <li key={d.id}>
                <Link to={`/divisions/${d.id}`}>{d.leagueName} — {d.name}</Link>
                {isAdmin && (
                  <button className="btn-link" onClick={() => onRemoveDivision(d.id)}>remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <div style={{ marginTop: 12 }}>
            <AddDivisionPanel tour={tour} onChange={load} setError={setError} />
          </div>
        )}
      </section>

      <section className="card">
        <h2>Tour Standings</h2>
        {tour.standings.length === 0 ? (
          <p className="muted">Add a division above to start ranking entrants.</p>
        ) : (
          <table className="standings-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{tour.entryType === 'teams' ? 'Team' : 'Player'}</th>
                <th>Divisions</th>
                <th>Played</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody>
              {tour.standings.map((row, i) => (
                <tr key={row.entrantId}>
                  <td>{i + 1}</td>
                  <td>{row.entrantName}</td>
                  <td className="muted" title={row.breakdown.map((b) => `${b.divisionName}: ${b.points}pts`).join(', ')}>
                    {row.divisionsPlayed}
                  </td>
                  <td>{row.played}</td>
                  <td><strong>{row.points}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
