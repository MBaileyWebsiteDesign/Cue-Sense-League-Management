import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const SCHEDULING_LABEL = {
  round_robin_single: 'Standard League - Single Leg',
  round_robin_double: 'Standard League - Double Leg',
  knockout_single_elim: 'Knockout (single elim)',
  knockout_double_elim: 'Knockout (double elim)',
  knockout_double_elim_pcdek: 'Pre Configured Double Elim Knockout',
  knockout_double_elim_adek: 'Adaptive Double Elim Knockout',
  killer_classic: 'Killer Classic',
  cards_killer: 'Cards Killer',
  free_play: 'Free Play',
};

// A pure history page - every row here was written automatically the moment
// a division's last fixture completed (see recordChampionIfDivisionComplete
// in server/src/index.js), so there's nothing to create or edit from this
// page, just a filterable list of who's won what.
export default function RollOfHonour() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [leagueFilter, setLeagueFilter] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Roll of Honour' }]);

  useEffect(() => {
    api.getRollOfHonour().then(setEntries).catch((e) => setError(e.message));
  }, []);

  const leagueNames = [...new Set(entries.map((e) => e.leagueName))].sort();
  const visible = leagueFilter ? entries.filter((e) => e.leagueName === leagueFilter) : entries;

  return (
    <div>
      <h1>Roll of Honour</h1>
      <p className="muted">
        Every division's champion, recorded automatically the moment its last fixture is completed.
      </p>
      {error && <p className="error">{error}</p>}

      {leagueNames.length > 1 && (
        <label style={{ display: 'inline-block', marginBottom: 12 }}>
          Filter by league
          <select value={leagueFilter} onChange={(e) => setLeagueFilter(e.target.value)}>
            <option value="">All leagues</option>
            {leagueNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
      )}

      {visible.length === 0 ? (
        <p className="muted">No champions recorded yet - this fills in automatically as divisions finish.</p>
      ) : (
        <ul className="fixture-list">
          {visible.map((entry) => (
            <li key={entry.id}>
              <span>
                <strong>{entry.championName}</strong> — {entry.divisionName}
                <span className="muted"> ({SCHEDULING_LABEL[entry.scheduling] || entry.scheduling})</span>
              </span>
              <span className="muted">
                <Link to={`/leagues/${entry.leagueId}`}>{entry.leagueName}</Link>
                {' · '}
                {new Date(entry.recordedAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
