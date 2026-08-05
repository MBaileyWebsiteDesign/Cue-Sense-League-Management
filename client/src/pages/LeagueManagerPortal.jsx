import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The League Manager Portal. League Managers get scoped admin access to
// specific leagues an Overall Admin has assigned them to (see
// assertLeagueAccess in server/src/userAuth.js and the "Admin: League
// Managers" panel on LeagueDetail.jsx) - this page is their home base for
// finding those leagues quickly, plus a placeholder for dedicated
// League Manager tooling (a combined dashboard across every league they
// manage) that's still on the roadmap. In the meantime, every action a
// League Manager can take already lives on the league/division/fixture
// pages themselves - this portal is a launchpad to those, not a
// replacement for them.
export default function LeagueManagerPortal() {
  const { user, canManageLeague } = useAuth();
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'League Manager Portal' }]);

  useEffect(() => {
    api.getLeagues().then(setLeagues).catch((e) => setError(e.message));
  }, []);

  const managed = (leagues || []).filter((l) => canManageLeague(l));

  return (
    <div>
      <h1>League Manager Portal</h1>
      <p className="muted">
        Signed in as <strong>{user.firstName} {user.lastName}</strong> · flagged as a League Manager.
      </p>

      <section className="card">
        <h2>Coming soon: a dedicated dashboard</h2>
        <p>
          A combined view across every league you manage - entrants awaiting payment, rounds not
          yet released to players, and fixtures needing attention, all in one place - is on the
          roadmap. For now, every action you have access to (entrants, tables, payments,
          fixtures, closing a league early) already lives on that league's own page, reachable
          from the list below.
        </p>
      </section>

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
