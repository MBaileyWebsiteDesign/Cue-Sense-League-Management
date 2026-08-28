import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The Captain Management Portal. Captains don't have anything team-specific
// to manage yet - team leagues are on the roadmap, and the `isCaptain` flag
// exists now (set per-account by an admin, or via the season CSV/Excel
// import) purely so accounts are ready to be captains before that ships.
// In the meantime this reuses the same personal fixture list as the Player
// Portal (a captain's own singles matches), framed as their captain home
// base, plus a placeholder describing what's coming once team leagues
// launch - so there's a real, working page behind the "Captain Portal" nav
// link rather than a dead end.
export default function CaptainPortal() {
  const { user } = useAuth();
  const [fixtures, setFixtures] = useState(null);
  const [error, setError] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Captain Portal' }]);

  useEffect(() => {
    api.getMyFixtures().then(setFixtures).catch((e) => setError(e.message));
  }, []);

  const upcoming = (fixtures || []).filter((f) => f.status !== 'completed');

  return (
    <div>
      <h1>Captain Portal</h1>
      <p className="muted">
        Signed in as <strong>{user.firstName} {user.lastName}</strong> · marked as a team captain.
      </p>

      <section className="card">
        <h2>Coming soon: team management</h2>
        <p>
          Team leagues are on the roadmap. Once they launch, this is where you'll manage your
          team's roster, nominate players for each leg of a match, and see your team's
          upcoming fixtures - all gated to just the team(s) you captain. For now, captain
          status doesn't unlock anything extra beyond this page, since the app is singles-only.
        </p>
      </section>

      <div className="card-grid">
        <Link to="/guides" className="card card-link">
          <h2>Guides</h2>
          <p className="muted">Reference documents an admin has made available to captains.</p>
        </Link>
      </div>

      <section className="card">
        <h2>Your upcoming matches</h2>
        {error && <p className="error">{error}</p>}
        {!fixtures ? (
          <p>Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="muted">Nothing scheduled right now.</p>
        ) : (
          <ul className="fixture-list">
            {upcoming.map((f) => (
              <li key={f.id}>
                <Link to={`/fixtures/${f.id}`}>
                  {f.leagueName} · {f.divisionName} · Round {f.round} vs {f.opponentName}
                </Link>
                <span className="muted">{f.scheduledDate || 'date TBC'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
