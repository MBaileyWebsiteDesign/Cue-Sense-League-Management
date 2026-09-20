import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The League Manager Portal. League Managers get scoped admin access to
// specific leagues an Overall Admin has assigned them to (see
// assertLeagueAccess in server/src/userAuth.js and the "Admin: League
// Managers" panel on LeagueDetail.jsx) - this page is their home base for
// finding those leagues quickly. Every action a League Manager can take
// already lives on the league/division/fixture pages themselves - this
// portal is a launchpad to those, not a replacement for them.
export default function LeagueManagerPortal() {
  const { user, canManageLeague } = useAuth();
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');
  // Number of disputed results waiting on this manager (same source as the
  // "Games disputed" list on Game Adjustments, already scoped server-side to
  // the leagues they manage) - turns the Game Adjustments card pale red.
  const [disputeCount, setDisputeCount] = useState(0);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'League Manager Portal' }]);

  useEffect(() => {
    api.getLeagues().then(setLeagues).catch((e) => setError(e.message));
    api.adminGetFixturesNeedingAttention()
      .then((items) => setDisputeCount((items || []).filter((item) => item.status === 'disputed').length))
      .catch(() => {});
  }, []);

  const managed = (leagues || []).filter((l) => canManageLeague(l));

  return (
    <div>
      <h1>League Manager Portal</h1>
      <p className="muted">
        Signed in as <strong>{user.firstName} {user.lastName}</strong> · flagged as a League Manager.
      </p>

      <div className="card-grid">
        <Link to="/guides" className="card card-link">
          <h2>Guides</h2>
          <p className="muted">Reference documents an admin has made available to League Managers.</p>
        </Link>

        <Link to="/admin/manage-fixtures" className="card card-link">
          <h2>Manage Fixtures</h2>
          <p className="muted">
            Pick one of your leagues and a division, then release each round to players week by
            week - players only see the rounds you've released.
          </p>
        </Link>

        <Link
          to="/admin/game-adjustments"
          className="card card-link"
          style={disputeCount > 0 ? { background: '#fee2e2' } : undefined}
        >
          <h2>Game Adjustments</h2>
          <p className="muted">
            Resolve disputed results, or search for a player to override or reopen one of their
            fixtures - limited to the leagues you manage.
          </p>
          {disputeCount > 0 && (
            <p style={{ color: '#991b1b', fontWeight: 600 }}>
              {disputeCount} disputed result{disputeCount === 1 ? '' : 's'} to resolve
            </p>
          )}
        </Link>
      </div>

      <section className="card">
        <h2>Leagues you manage</h2>
        {error && <p className="error">{error}</p>}
        {!leagues ? (
          <p>Loading…</p>
        ) : managed.length === 0 ? (
          <p className="muted">
            You haven't been assigned to a league yet - an Overall Admin assigns League Manager
            access from that league's own "Admin: League Managers" panel.
          </p>
        ) : (
          <ul className="fixture-list">
            {managed.map((l) => (
              <li key={l.id}>
                <Link to={`/leagues/${l.id}`}>{l.name}</Link>
                <span className="muted">{l.sport}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
