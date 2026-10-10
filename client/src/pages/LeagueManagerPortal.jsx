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
//
// Colour/UI refresh (2026-10-10): same look as the Admin Portal - a hero
// banner, a row of headline stat cards (each a real count from the same
// endpoints the tools use, and each a link into that tool), and compact icon
// tiles grouped into coloured sections. It reuses the Admin Portal's .ap-*
// classes and the existing brand palette; no new colours.

const Icon = ({ d }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => <path key={p} d={p} />)}
  </svg>
);

const ICONS = {
  fixtures: ['M3 5h18v16H3z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  adjust: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M20 18h0', 'M14 4v4', 'M8 10v4', 'M16 16v4'],
  reports: ['M4 5h16v11H8l-4 4z', 'M12 8v3', 'M12 13.5v.5'],
  guides: ['M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z', 'M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z'],
};

const SECTIONS = [
  {
    title: 'Seasons & matches',
    accent: 'seasons',
    tools: [
      { to: '/admin/manage-fixtures', icon: 'fixtures', title: 'Manage Fixtures', desc: 'Release each round to players week by week.' },
      { to: '/admin/game-adjustments', icon: 'adjust', title: 'Game Adjustments', desc: 'Resolve disputed results, or override or reopen a fixture in your leagues.', badge: 'disputes' },
    ],
  },
  {
    title: 'People',
    accent: 'people',
    tools: [
      { to: '/message-reports', icon: 'reports', title: 'Message Reports', desc: 'Review abuse reports from players in your leagues and mark each one handled.', badge: 'reports' },
    ],
  },
  {
    title: 'Help',
    accent: 'help',
    tools: [
      { to: '/guides', icon: 'guides', title: 'Guides', desc: 'Reference documents an admin has made available to League Managers.' },
    ],
  },
];

export default function LeagueManagerPortal() {
  const { user, canManageLeague } = useAuth();
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');
  // Number of disputed results waiting on this manager (same source as the
  // "Games disputed" list on Game Adjustments, already scoped server-side to
  // the leagues they manage). null until loaded.
  const [disputeCount, setDisputeCount] = useState(null);
  // Open abuse reports from Player Messages (already scoped server-side to the
  // leagues this manager runs). null until loaded.
  const [openReports, setOpenReports] = useState(null);
  // Guides this manager can see (same source as the Guides page). null until loaded.
  const [guideCount, setGuideCount] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'League Manager Portal' }]);

  useEffect(() => {
    api.getLeagues().then(setLeagues).catch((e) => setError(e.message));
    api.adminGetFixturesNeedingAttention()
      .then((items) => setDisputeCount((items || []).filter((item) => item.status === 'disputed').length))
      .catch(() => {});
    api.getMessageReportSummary().then((r) => setOpenReports(r.open || 0)).catch(() => {});
    api.getGuides().then((g) => setGuideCount(Array.isArray(g) ? g.length : null)).catch(() => setGuideCount(null));
  }, []);

  const managed = (leagues || []).filter((l) => canManageLeague(l));
  const badgeCount = (badge) => (badge === 'reports' ? openReports : badge === 'disputes' ? disputeCount : 0) || 0;

  const stats = [
    { key: 'disputes', label: 'Disputed results', value: disputeCount, to: '/admin/game-adjustments', alert: true },
    { key: 'reports', label: 'Message reports', value: openReports, to: '/message-reports', alert: true },
    { key: 'leagues', label: 'Leagues you manage', value: leagues ? managed.length : null, href: '#lm-leagues' },
    { key: 'guides', label: 'Guides available', value: guideCount, to: '/guides' },
  ];

  return (
    <div className="admin-theme-home">
      <div className="ap-page">
        <section className="ap-hero">
          <div className="ap-hero-text">
            <h1>League Manager Portal</h1>
            <p>Signed in as <strong>{user.firstName} {user.lastName}</strong> · League Manager</p>
          </div>
        </section>

        <section className="ap-stats" aria-label="At a glance">
          {stats.map((st) => {
            const loaded = st.value !== null;
            const hot = st.alert && loaded && st.value > 0;
            const cls = `ap-stat ap-stat-${hot ? 'alert' : st.alert ? 'ok' : 'info'}`;
            const body = (
              <>
                <span className="ap-stat-value">{loaded ? st.value : '–'}</span>
                <span className="ap-stat-label">{st.label}</span>
              </>
            );
            return st.to ? (
              <Link key={st.key} to={st.to} className={cls}>{body}</Link>
            ) : (
              <a key={st.key} href={st.href} className={cls}>{body}</a>
            );
          })}
        </section>

        {SECTIONS.map((s) => (
          <section key={s.title} className={`ap-section ap-sec-${s.accent}`}>
            <h2 className="ap-section-title">{s.title}</h2>
            <div className="ap-grid">
              {s.tools.map((t) => {
                const count = badgeCount(t.badge);
                return (
                  <Link key={t.to} to={t.to} className={`ap-tile${count > 0 ? ' ap-tile-alert' : ''}`}>
                    <span className="ap-tile-top">
                      <span className="ap-icon"><Icon d={ICONS[t.icon]} /></span>
                      {count > 0 && <span className="ap-count">{count}</span>}
                    </span>
                    <strong className="ap-tile-title">{t.title}</strong>
                    <span className="ap-tile-desc">{t.desc}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}

        <section className="ap-section ap-sec-seasons" id="lm-leagues">
          <h2 className="ap-section-title">Leagues you manage</h2>
          <div className="card lm-leagues">
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
          </div>
        </section>
      </div>
    </div>
  );
}
