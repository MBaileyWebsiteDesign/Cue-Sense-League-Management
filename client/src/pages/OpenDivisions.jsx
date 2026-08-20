import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// NQT: "Some way to allow players to see leagues, or divisions to request
// to join... If ticket [checked] any registered player can request to
// join the open league/division, with league managers then making a
// decision." This is the browse/request side - the approval side lives on
// each league's "Admin: Manage this League" -> Join Requests subsection
// (LeagueDetail.jsx's ManageLeaguePanel).
export default function OpenDivisions() {
  const [divisions, setDivisions] = useState(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Open Divisions' }]);

  const load = () => api.getOpenDivisions().then(setDivisions).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const onRequest = async (divisionId) => {
    setRequesting(divisionId);
    setError('');
    try {
      await api.requestToJoinDivision(divisionId);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequesting(null);
    }
  };

  return (
    <div>
      <h1>Open Divisions</h1>
      <p className="muted">
        Divisions here are open for any registered player to request to join. A League Manager or
        admin will approve or decline your request - you'll see it appear in your division list once
        it's approved.
      </p>

      {error && <p className="error">{error}</p>}

      {!divisions ? (
        <p className="muted">Loading…</p>
      ) : divisions.length === 0 ? (
        <p className="muted">No divisions are open for join requests right now.</p>
      ) : (
        <ul className="fixture-list">
          {divisions.map((d) => (
            <li key={d.divisionId}>
              <span>
                <Link to={`/divisions/${d.divisionId}`}>{d.leagueName} - {d.divisionName}</Link>{' '}
                <span className="muted">
                  · {d.playerCount} player{d.playerCount === 1 ? '' : 's'}
                  {d.fixturesGenerated ? ' · fixtures already generated' : ''}
                </span>
              </span>
              {d.requestStatus === 'member' ? (
                <span className="muted">You're already in</span>
              ) : d.requestStatus === 'pending' ? (
                <span className="muted">Request pending</span>
              ) : (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={requesting === d.divisionId}
                  onClick={() => onRequest(d.divisionId)}
                >
                  {requesting === d.divisionId ? 'Requesting…' : 'Request to join'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
