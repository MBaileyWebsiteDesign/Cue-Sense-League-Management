import { Link } from 'react-router-dom';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// The Admin Management Portal - the single landing page for everything an
// admin manages: players/accounts, whole new seasons (leagues + divisions +
// rosters + fixtures in one guided flow), and the audit trail. Score
// overrides aren't listed here since they're contextual to a specific
// fixture - they live on that fixture's own page instead (see
// FixtureDetail.jsx's AdminOverridePanel).
export default function AdminPortal() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin Portal' }]);

  return (
    <div>
      <h1>Admin Portal</h1>
      <p className="muted">
        Manage accounts and whole seasons from here. Score corrections for a
        specific match are on that match's own page, or search for one directly below.
      </p>

      <div className="card-grid">
        <Link to="/admin/seasons/new" className="card card-link">
          <h2>+ New Season</h2>
          <p className="muted">
            Guided setup: name the season, choose how many leagues and players per league,
            add players by CSV/Excel or manually, set the season's dates, and generate every
            division's fixtures with the games spaced out automatically.
          </p>
        </Link>

        <Link to="/" className="card card-link">
          <h2>Leagues &amp; Seasons</h2>
          <p className="muted">
            Browse every league (including ones created by the season wizard), drill into a
            division to manage its roster, or generate fixtures for a division on its own.
          </p>
        </Link>

        <Link to="/admin/users" className="card card-link">
          <h2>Manage Users</h2>
          <p className="muted">
            Search every account, edit any profile field, grant/revoke admin or captain
            status, suspend or reactivate accounts, and force-reset passwords.
          </p>
        </Link>

        <Link to="/admin/game-adjustments" className="card card-link">
          <h2>Game Adjustments</h2>
          <p className="muted">
            Search for a player, pick one of their fixtures, and directly override or reopen
            the result - the tool a "Result disputed" banner points you at.
          </p>
        </Link>

        <Link to="/admin/manage-fixtures" className="card card-link">
          <h2>Manage Fixtures</h2>
          <p className="muted">
            Pick a league and division, then release each round to players week by week -
            only admins see the whole season's fixtures until you release them.
          </p>
        </Link>

        <Link to="/admin/audit-log" className="card card-link">
          <h2>Audit Log</h2>
          <p className="muted">
            Every admin action that affects someone else's account or a match result - who
            did it, and when.
          </p>
        </Link>

        <Link to="/issues-bugs-features" className="card card-link">
          <h2>Issues / Bugs / Features</h2>
          <p className="muted">
            Every open and recently-closed issue on the project's GitHub repo (Overall-Admin-only),
            plus in-app Feature / Requests submitted by players and league admins. Also
            reachable by every logged-in account from the main nav, not just admins.
          </p>
        </Link>

        <Link to="/guides" className="card card-link">
          <h2>Guides</h2>
          <p className="muted">
            Upload PDF or Word reference guides and choose which account types can see each one -
            players, captains, league managers and/or admins.
          </p>
        </Link>

        <Link to="/admin/api-keys" className="card card-link">
          <h2>API Keys</h2>
          <p className="muted">
            Generate or revoke API keys for StreamDeck or other unattended integrations -
            each one acts as a permanent, admin-equivalent login.
          </p>
        </Link>

        <Link to="/admin/backup" className="card card-link">
          <h2>Backup &amp; Restore</h2>
          <p className="muted">
            Export every league, division, fixture and account to a file before a risky upgrade -
            restore it if something goes wrong, or wipe everything back to a clean slate.
          </p>
        </Link>
      </div>
    </div>
  );
}
