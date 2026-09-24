import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The Captain Management Portal. Captain-specific tools (managing a team's
// roster and nominating players for each leg - GitHub issue #31) aren't
// built yet; the `isCaptain` flag exists now (set per-account by an admin,
// or via the season CSV/Excel import) so accounts are ready before they
// ship. In the meantime this shows the account's own upcoming fixtures
// (same source as the Player Portal), a Guides tile, and a short note on
// what's coming.
//
// Mobile layout (2026-09-24): back button, a status chip that reflects the
// real flag (Captain / Viewing as admin), upcoming matches first as cards,
// Guides tile with a live count, and the coming-soon note last.
export default function CaptainPortal() {
  const { user, isAdmin, isCaptain } = useAuth();
  const [fixtures, setFixtures] = useState(null);
  const [error, setError] = useState('');
  const [guideCount, setGuideCount] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Captain Portal' }]);

  useEffect(() => {
    api.getMyFixtures().then(setFixtures).catch((e) => setError(e.message));
    api.getGuides().then((g) => setGuideCount(Array.isArray(g) ? g.length : null)).catch(() => setGuideCount(null));
  }, []);

  const upcoming = (fixtures || []).filter((f) => f.status !== 'completed');

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/" className="msg-icon-btn" aria-label="Back to home">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Captain Portal</h1>
        {isCaptain ? (
          <span className="status status-completed">Captain</span>
        ) : isAdmin ? (
          <span className="status">Viewing as admin</span>
        ) : null}
      </div>
      <p className="muted mm-intro">Signed in as <strong>{user.firstName} {user.lastName}</strong>.</p>

      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Your upcoming matches</h2>
          {fixtures && <span className="muted">{upcoming.length}</span>}
        </div>
        {error && <p className="error">{error}</p>}
        {!fixtures ? (
          <p className="muted">Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing scheduled right now.</p>
        ) : (
          <ul className="ll-list">
            {upcoming.map((f) => (
              <li key={f.id}>
                <Link to={`/fixtures/${f.id}`} className="ll-card">
                  <span className="ll-card-main">
                    <strong className="ll-name">vs {f.opponentName}</strong>
                    <span className="muted sx-small">{f.leagueName} · {f.divisionName} · Round {f.round}</span>
                    <span className="ol-chips">
                      <span className="ol-chip">{f.scheduledDate || 'Date to be arranged'}</span>
                    </span>
                  </span>
                  <svg className="ll-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ap-grid">
        <Link to="/guides" className="ap-tile">
          <span className="ap-tile-top">
            <span className="ap-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" /><path d="M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" /></svg>
            </span>
          </span>
          <strong className="ap-tile-title">Guides</strong>
          <span className="ap-tile-desc">
            {guideCount === null ? 'Reference documents' : `${guideCount} guide${guideCount === 1 ? '' : 's'} available`}
          </span>
        </Link>
        <Link to="/messages" className="ap-tile">
          <span className="ap-tile-top">
            <span className="ap-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>
            </span>
          </span>
          <strong className="ap-tile-title">Messages</strong>
          <span className="ap-tile-desc">Arrange games with players</span>
        </Link>
      </div>

      <section className="card sx-card cp-soon">
        <span className="ol-chip lg-chip-open" style={{ alignSelf: 'flex-start' }}>Coming soon</span>
        <p style={{ margin: 0 }}>
          Captain tools - managing your team's roster and nominating players for each leg - are on the way.
        </p>
      </section>
    </div>
  );
}
