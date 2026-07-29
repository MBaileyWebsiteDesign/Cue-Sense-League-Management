import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const ENTRY_TYPE_LABEL = { singles: 'Singles', teams: 'Teams', doubles: 'Doubles/Triples' };

export default function TourList() {
  const { isAdmin } = useAuth();
  const [tours, setTours] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', entryType: 'singles' });
  const [showForm, setShowForm] = useState(false);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Tours' }]);

  const load = () => api.getTours().then(setTours).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createTour(form);
      setForm({ name: '', entryType: 'singles' });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tours</h1>
          <p className="muted">
            A tour sums a player's (or team's, or pairing's) standings points across every division added to it.
          </p>
        </div>
        {isAdmin && (
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New Tour'}
          </button>
        )}
      </div>

      {showForm && isAdmin && (
        <form className="card form" onSubmit={onSubmit}>
          <label>
            Tour name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Winter Order of Merit"
              required
            />
          </label>
          <label>
            Entry type
            <select value={form.entryType} onChange={(e) => setForm({ ...form, entryType: e.target.value })}>
              <option value="singles">Singles (one player vs one player)</option>
              <option value="teams">Teams (team vs team)</option>
              <option value="doubles">Doubles/Triples</option>
            </select>
          </label>
          <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
            Only divisions of this entry type can be added to the tour once it's created.
          </p>
          <button className="btn btn-primary" type="submit">
            Create Tour
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card-grid">
        {tours.map((tour) => (
          <Link key={tour.id} to={`/tours/${tour.id}`} className="card card-link">
            <h2>{tour.name}</h2>
            <p className="muted">
              {ENTRY_TYPE_LABEL[tour.entryType] || tour.entryType} · {tour.divisionIds.length} division
              {tour.divisionIds.length === 1 ? '' : 's'}
            </p>
          </Link>
        ))}
        {tours.length === 0 && <p className="muted">No tours yet. Create one to get started.</p>}
      </div>
    </div>
  );
}
