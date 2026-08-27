import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// League-level version of OpenDivisions.jsx. A league marked "Open For
// Registration" doesn't have a roster of its own to join directly - a
// player here just registers interest in the league as a whole, and a
// League Manager splits interested players across whichever division(s)
// they choose (bulk or one at a time) from that league's "Admin: Manage
// this League" -> League Interests subsection whenever they're ready.
export default function OpenLeagues() {
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Open Leagues' }]);

  const load = () => api.getOpenLeagues().then(setLeagues).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const onRequest = async (leagueId) => {
    setRequesting(leagueId);
    setError('');
    try {
      await api.requestToJoinLeague(leagueId);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequesting(null);
    }
  };

  return (
    <div>
      <h1>Open Leagues</h1>
      <p className="muted">
        Leagues here are open for any registered player to register interest in. A League Manager will
        place you into a division once they're ready - see also{' '}
        <Link to="/open-divisions">Open Divisions</Link> for divisions that can be joined directly.
      </p>

      {error && <p className="error">{error}</p>}

      {!leagues ? (
        <p className="muted">Loading…</p>
      ) : leagues.length === 0 ? (
        <p className="muted">No leagues are open for interest registration right now.</p>
      ) : (
        <ul className="fixture-list">
          {leagues.map((l) => (
            <li key={l.leagueId}>
              <span>
                <Link to={`/leagues/${l.leagueId}`}>{l.leagueName}</Link>{' '}
                <span className="muted">
                  · {l.divisionCount} division{l.divisionCount === 1 ? '' : 's'}
                </span>
              </span>
              {l.requestStatus === 'assigned' ? (
                <span className="muted">You're already registered</span>
              ) : l.requestStatus === 'pending' ? (
                <span className="muted">Interest registered - awaiting placement</span>
              ) : (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={requesting === l.leagueId}
                  onClick={() => onRequest(l.leagueId)}
                >
                  {requesting === l.leagueId ? 'Registering…' : 'Register interest'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
