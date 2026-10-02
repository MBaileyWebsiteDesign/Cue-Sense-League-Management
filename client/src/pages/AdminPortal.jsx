import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The Admin Management Portal - the single landing page for everything an
// admin manages: players/accounts, whole new seasons (leagues + divisions +
// rosters + fixtures in one guided flow), and the audit trail. Score
// overrides aren't listed here since they're contextual to a specific
// fixture - they live on that fixture's own page instead (see
// FixtureDetail.jsx's AdminOverridePanel).
//
// Mobile layout (2026-09-23): a "Needs attention" strip (disputed results +
// open message reports, same sources the League Manager Portal uses), a
// primary New Season button, then the tools grouped into sections of compact
// tiles with a filter box.
//
// Colour overhaul (2026-10-02): a hero banner (with the New Season button),
// a row of headline stat cards that replaces the old Needs-attention strip
// (disputed results, open message reports, venue join requests waiting,
// total accounts - each a real count from the same endpoints the tools
// themselves use, and each a link into that tool), and a colour per section.

const Icon = ({ d }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => <path key={p} d={p} />)}
  </svg>
);

const ICONS = {
  leagues: ['M4 21V4h11l-1 4 5 1-2 5H6'],
  fixtures: ['M3 5h18v16H3z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  adjust: ['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M20 18h0', 'M14 4v4', 'M8 10v4', 'M16 16v4'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21c0-4 3-6 7-6s7 2 7 6', 'M17 11a3 3 0 1 0 0-6', 'M22 21c0-3-2-5-5-5.5'],
  membership: ['M3 21h18', 'M5 21V8l7-5 7 5v13', 'M10 21v-6h4v6'],
  reports: ['M4 5h16v11H8l-4 4z', 'M12 8v3', 'M12 13.5v.5'],
  guides: ['M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z', 'M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z'],
  issues: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8v5', 'M12 16v.5'],
  audit: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  email: ['M3 5h18v14H3z', 'M3 6l9 7 9-7'],
  keys: ['M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z'],
  backup: ['M4 7h16v13H4z', 'M4 7l2-3h12l2 3', 'M12 11v6', 'M9 14l3 3 3-3'],
};

const SECTIONS = [
  {
    title: 'Seasons & matches',
    accent: 'seasons',
    tools: [
      { to: '/leagues', icon: 'leagues', title: 'Leagues & Seasons', desc: 'Every league and division - rosters and fixtures.' },
      { to: '/admin/manage-fixtures', icon: 'fixtures', title: 'Manage Fixtures', desc: 'Release rounds to players week by week.' },
      { to: '/admin/game-adjustments', icon: 'adjust', title: 'Game Adjustments', desc: 'Override or reopen a result. Single-match fixes are also on that match’s page.', badge: 'disputes' },
    ],
  },
  {
    title: 'People',
    accent: 'people',
    tools: [
      { to: '/admin/users', icon: 'users', title: 'Manage Users', desc: 'Edit accounts, roles, suspensions and password resets.' },
      { to: '/admin/membership', icon: 'membership', title: 'Membership', desc: 'Venues, Venue Managers and memberships.' },
      { to: '/message-reports', icon: 'reports', title: 'Message Reports', desc: 'Review abuse reports from player messages.', badge: 'reports' },
    ],
  },
  {
    title: 'Help & feedback',
    accent: 'help',
    tools: [
      { to: '/guides', icon: 'guides', title: 'Guides', desc: 'Upload guides and choose who can see them.' },
      { to: '/issues-bugs-features', icon: 'issues', title: 'Issues / Bugs / Features', desc: 'Open issues and feature requests.' },
    ],
  },
  {
    title: 'System',
    accent: 'system',
    tools: [
      { to: '/admin/audit-log', icon: 'audit', title: 'Audit Log', desc: 'Who changed what, and when.' },
      { to: '/admin/email', icon: 'email', title: 'Email', desc: 'Check sending works and see recent results.' },
      { to: '/admin/api-keys', icon: 'keys', title: 'API Keys', desc: 'Keys for StreamDeck and other integrations.' },
      { to: '/admin/backup', icon: 'backup', title: 'Backup & Restore', desc: 'Export, restore or wipe all data - use with care.', danger: true },
    ],
  },
];

export default function AdminPortal() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin Portal' }]);

  // Open abuse reports from Player Messages, and disputed results (same
  // "fixtures needing attention" source as Game Adjustments / the League
  // Manager Portal).
  const [openReports, setOpenReports] = useState(null);
  const [disputeCount, setDisputeCount] = useState(null);
  const [joinRequests, setJoinRequests] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    // Venue join requests waiting across every venue (an admin sees them all).
    api.getMyManagedVenues()
      .then((venues) => setJoinRequests((venues || []).reduce((n, v) => n + (v.pendingJoinRequests || 0), 0)))
      .catch(() => {});
    api.adminListUsers().then((users) => setAccounts((users || []).length)).catch(() => {});
    api.getMessageReportSummary().then((r) => setOpenReports(r.open || 0)).catch(() => {});
    api.adminGetFixturesNeedingAttention()
      .then((items) => setDisputeCount((items || []).filter((item) => item.status === 'disputed').length))
      .catch(() => {});
  }, []);

  const badgeCount = (badge) => (badge === 'reports' ? openReports : badge === 'disputes' ? disputeCount : 0);
  const q = filter.trim().toLowerCase();
  const sections = SECTIONS.map((s) => ({
    ...s,
    tools: q ? s.tools.filter((t) => `${t.title} ${t.desc}`.toLowerCase().includes(q)) : s.tools,
  })).filter((s) => s.tools.length > 0);
  const showNewSeason = !q || 'new season'.includes(q) || q.includes('season');
  const stats = [
    { key: 'disputes', label: 'Disputed results', value: disputeCount, to: '/admin/game-adjustments', alert: true },
    { key: 'reports', label: 'Message reports', value: openReports, to: '/message-reports', alert: true },
    { key: 'joins', label: 'Venue join requests', value: joinRequests, to: '/venue-manager', alert: true },
    { key: 'accounts', label: 'Accounts', value: accounts, to: '/admin/users' },
  ];

  return (
    <div className="ap-page">
      <section className="ap-hero">
        <div className="ap-hero-text">
          <h1>Admin Portal</h1>
          <p>Manage accounts, seasons and the system.</p>
        </div>
        {showNewSeason && (
          <Link to="/admin/seasons/new" className="ap-hero-cta">
            + New Season
            <span className="ap-hero-cta-sub">Guided set-up: leagues, players, dates and fixtures</span>
          </Link>
        )}
      </section>

      <section className="ap-stats" aria-label="At a glance">
        {stats.map((st) => {
          const loaded = st.value !== null;
          const hot = st.alert && loaded && st.value > 0;
          return (
            <Link key={st.key} to={st.to} className={`ap-stat ap-stat-${hot ? 'alert' : st.alert ? 'ok' : 'info'}`}>
              <span className="ap-stat-value">{loaded ? st.value : '–'}</span>
              <span className="ap-stat-label">{st.label}</span>
            </Link>
          );
        })}
      </section>

      <input
        type="search"
        className="ah-search"
        aria-label="Find an admin tool"
        placeholder="Find a tool…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {sections.length === 0 && !showNewSeason && <p className="muted">No tools match “{filter.trim()}”.</p>}

      {sections.map((s) => (
        <section key={s.title} className={`ap-section ap-sec-${s.accent}`}>
          <h2 className="ap-section-title">{s.title}</h2>
          <div className="ap-grid">
            {s.tools.map((t) => {
              const count = badgeCount(t.badge);
              return (
                <Link key={t.to} to={t.to} className={`ap-tile${t.danger ? ' ap-tile-danger' : ''}${count > 0 ? ' ap-tile-alert' : ''}`}>
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
    </div>
  );
}
