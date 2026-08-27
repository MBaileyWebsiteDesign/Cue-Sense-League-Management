import { Suspense, lazy, useState } from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import LeagueList from './pages/LeagueList.jsx';
import LeagueDetail from './pages/LeagueDetail.jsx';
import DivisionDetail from './pages/DivisionDetail.jsx';
import TourList from './pages/TourList.jsx';
import TourDetail from './pages/TourDetail.jsx';
import RollOfHonour from './pages/RollOfHonour.jsx';
import FixtureDetail from './pages/FixtureDetail.jsx';
import PlayerProfile from './pages/PlayerProfile.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import RegisterWix from './pages/RegisterWix.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import PlayerPortal from './pages/PlayerPortal.jsx';
import OpenDivisions from './pages/OpenDivisions.jsx';
import OpenLeagues from './pages/OpenLeagues.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { BreadcrumbProvider } from './BreadcrumbContext.jsx';
import Breadcrumbs from './components/Breadcrumbs.jsx';

// Lazy-loaded: everything below is either admin/captain-only (most visitors
// are plain players and never touch these) or, for AdminSeasonWizard/
// AdminUsers specifically, pulls in the `xlsx` and `papaparse` CSV/Excel
// parsing libraries - both sizeable dependencies that have no reason to be
// in the JS every player downloads just to check the league table. Splitting
// these into their own chunks (Vite/Rollup does this automatically for a
// dynamic import()) shrinks the bundle every regular visitor pays for on
// first load; the one-time Suspense fallback flicker on first visit to one
// of these pages is a good trade for that.
const GameAdjustments = lazy(() => import('./pages/GameAdjustments.jsx'));
const CaptainPortal = lazy(() => import('./pages/CaptainPortal.jsx'));
const LeagueManagerPortal = lazy(() => import('./pages/LeagueManagerPortal.jsx'));
const AdminPortal = lazy(() => import('./pages/AdminPortal.jsx'));
const AdminUsers = lazy(() => import('./pages/AdminUsers.jsx'));
const AdminUserEdit = lazy(() => import('./pages/AdminUserEdit.jsx'));
const AdminAuditLog = lazy(() => import('./pages/AdminAuditLog.jsx'));
const IssuesBugsFeatures = lazy(() => import('./pages/IssuesBugsFeatures.jsx'));
const AdminSeasonWizard = lazy(() => import('./pages/AdminSeasonWizard.jsx'));
const ManageFixtures = lazy(() => import('./pages/ManageFixtures.jsx'));
const StreamOverlay = lazy(() => import('./pages/StreamOverlay.jsx'));
const Arena = lazy(() => import('./pages/Arena.jsx'));
const PublicLeagueTable = lazy(() => import('./pages/PublicLeagueTable.jsx'));
const PublicLeagueFixtures = lazy(() => import('./pages/PublicLeagueFixtures.jsx'));
const PublicDivisionBracket = lazy(() => import('./pages/PublicDivisionBracket.jsx'));
const PublicDivisionTable = lazy(() => import('./pages/PublicDivisionTable.jsx'));
const PublicDivisionFixtures = lazy(() => import('./pages/PublicDivisionFixtures.jsx'));
const AdminApiKeys = lazy(() => import('./pages/AdminApiKeys.jsx'));
const AdminBackup = lazy(() => import('./pages/AdminBackup.jsx'));

// Gates the standard "view the site" pages: any logged-in account (whatever
// combination of admin/captain/plain-player flags it has) can browse. There
// used to be two separate login flows (admin, player) each with their own
// gate - now there's one account model, so one gate.
function RequireLogin({ children }) {
  const { isLoggedIn } = useAuth();
  const location = useLocation();

  if (!isLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

function RequireAdmin({ children }) {
  const { isAdmin } = useAuth();
  const location = useLocation();

  if (!isAdmin) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

// League Managers need to reach Manage Fixtures for their own assigned
// league(s) (round visibility is now a league-scoped action, see
// assertLeagueAccess in server/src/userAuth.js) but nothing else under
// /admin/* - every other admin route stays RequireAdmin-only below.
function RequireAnyAdmin({ children }) {
  const { isAdmin, isLeagueManager } = useAuth();
  const location = useLocation();

  if (!isAdmin && !isLeagueManager) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

function RequireCaptain({ children }) {
  const { isCaptain, isAdmin } = useAuth();
  const location = useLocation();

  // Admins can also see the Captain Portal (useful while the captain flag is
  // still singles-only and not many accounts have it set yet).
  if (!isCaptain && !isAdmin) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

// On a narrow (phone-width) screen there isn't room for every link in one
// row (Admin Portal, Captain Portal, Player Portal, Log out), so below the
// 640px breakpoint (see styles.css) the link list
// collapses behind a hamburger toggle instead - the links themselves are
// unchanged, just hidden/shown as a dropdown panel via the
// "header-accounts-open" class rather than always inline. Above 640px the
// hamburger button is display:none and .header-accounts just renders as
// the same inline row it always did - nothing changes for desktop/tablet.
function HeaderNav() {
  const { isLoggedIn, isAdmin, isCaptain, isLeagueManager, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!isLoggedIn) {
    return (
      <Link to="/login" className="header-link">
        Login
      </Link>
    );
  }

  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <button
        type="button"
        className="hamburger-btn"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span />
        <span />
        <span />
      </button>
      <span className={`header-accounts${menuOpen ? ' header-accounts-open' : ''}`}>
        {isAdmin && (
          <Link to="/admin" className="header-link" onClick={closeMenu}>
            Admin Portal
          </Link>
        )}
        {isLeagueManager && !isAdmin && (
          <Link to="/league-manager" className="header-link" onClick={closeMenu}>
            League Manager Portal
          </Link>
        )}
        {(isAdmin || isCaptain) && (
          <Link to="/captain" className="header-link" onClick={closeMenu}>
            Captain Portal
          </Link>
        )}
        <Link to="/open-divisions" className="header-link" onClick={closeMenu}>
          Open Divisions
        </Link>
        <Link to="/open-leagues" className="header-link" onClick={closeMenu}>
          Open Leagues
        </Link>
        <Link to="/account" className="header-link" onClick={closeMenu}>
          Player Portal
        </Link>
        <span className="header-admin">
          <button
            className="header-link header-link-button"
            onClick={() => {
              closeMenu();
              logout();
              navigate('/login');
            }}
          >
            Log out
          </button>
        </span>
      </span>
    </>
  );
}

// Shows a "Development Platform" strip under the header on the staging
// site only - a visual guard so nobody mistakes dev.poolmanager for the
// live app while testing there. Detected purely by hostname at runtime
// (no build-time env var currently distinguishes staging from production -
// both are built by the same Dockerfile/`npm run build`, see
// fly.staging.toml vs fly.toml), matched against the staging custom domain
// (see .github/workflows/deploy-fly-staging.yml) and, as a fallback, any
// default Fly.io *.fly.dev hostname containing "staging" - so this stays
// hidden by default (including on production and localhost) and only
// switches on when the hostname is affirmatively recognised as staging.
function isStagingEnvironment() {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host.endsWith('.cuesense.co.uk')) {
    const label = host.slice(0, -'.cuesense.co.uk'.length);
    if (label.includes('dev')) return true;
  }
  if (host.endsWith('.fly.dev')) {
    const label = host.slice(0, -'.fly.dev'.length);
    if (label.includes('dev') || label.includes('staging')) return true;
  }
  return false;
}

function StagingBanner() {
  if (!isStagingEnvironment()) return null;
  return (
    <div className="staging-banner" role="status">
      Development Platform
    </div>
  );
}

function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-logo" />
          <span className="brand-text">
            <span className="brand-name">Cue Sense</span>
            <span className="brand-tagline">League Management</span>
          </span>
        </Link>
        <HeaderNav />
      </header>
      <StagingBanner />
      <Breadcrumbs />
      <main className="app-main">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            <Route path="/" element={<RequireLogin><LeagueList /></RequireLogin>} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/account" element={<RequireLogin><PlayerPortal /></RequireLogin>} />
            <Route path="/open-divisions" element={<RequireLogin><OpenDivisions /></RequireLogin>} />
            <Route path="/open-leagues" element={<RequireLogin><OpenLeagues /></RequireLogin>} />
            <Route path="/captain" element={<RequireCaptain><CaptainPortal /></RequireCaptain>} />
            <Route path="/league-manager" element={<RequireAnyAdmin><LeagueManagerPortal /></RequireAnyAdmin>} />
            <Route path="/admin" element={<RequireAdmin><AdminPortal /></RequireAdmin>} />
            <Route path="/admin/users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
            <Route path="/admin/users/:userId" element={<RequireAdmin><AdminUserEdit /></RequireAdmin>} />
            <Route path="/admin/audit-log" element={<RequireAdmin><AdminAuditLog /></RequireAdmin>} />
            {/* Was admin-only at /admin/issues (AdminIssueTracker) - now open to
                every logged-in account and moved out from under /admin, since
                the Feature / Requests half is meant for players and league
                admins too, not just Overall Admins. /admin/issues redirects
                here for anyone with the old link/bookmark. */}
            <Route path="/issues-bugs-features" element={<RequireLogin><IssuesBugsFeatures /></RequireLogin>} />
            <Route path="/admin/issues" element={<Navigate to="/issues-bugs-features" replace />} />
            <Route path="/admin/api-keys" element={<RequireAdmin><AdminApiKeys /></RequireAdmin>} />
            <Route path="/admin/backup" element={<RequireAdmin><AdminBackup /></RequireAdmin>} />
            <Route path="/admin/game-adjustments" element={<RequireAdmin><GameAdjustments /></RequireAdmin>} />
            <Route path="/admin/seasons/new" element={<RequireAdmin><AdminSeasonWizard /></RequireAdmin>} />
            <Route path="/admin/manage-fixtures" element={<RequireAnyAdmin><ManageFixtures /></RequireAnyAdmin>} />
            <Route path="/admin/manage-fixtures/:divisionId" element={<RequireAnyAdmin><ManageFixtures /></RequireAnyAdmin>} />
            <Route path="/leagues/:leagueId" element={<RequireLogin><LeagueDetail /></RequireLogin>} />
            <Route path="/divisions/:divisionId" element={<RequireLogin><DivisionDetail /></RequireLogin>} />
            <Route path="/fixtures/:fixtureId" element={<RequireLogin><FixtureDetail /></RequireLogin>} />
            <Route path="/players/:playerId" element={<RequireLogin><PlayerProfile /></RequireLogin>} />
            <Route path="/tours" element={<RequireLogin><TourList /></RequireLogin>} />
            <Route path="/tours/:tourId" element={<RequireLogin><TourDetail /></RequireLogin>} />
            <Route path="/roll-of-honour" element={<RequireLogin><RollOfHonour /></RequireLogin>} />
          </Routes>
        </Suspense>
      </main>
      <footer className="app-footer">
        <p>
          Powered By Cue Sense,{' '}
          <a href="https://www.cuesense.co.uk" target="_blank" rel="noopener noreferrer">
            www.CueSense.co.uk
          </a>
        </p>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Standalone, unauthenticated route for the OBS stream overlay - no
          header/breadcrumbs/login gate, since this is meant to be loaded
          cold inside OBS's Browser Source, not browsed by a logged-in
          person. Deliberately outside AuthProvider/AppShell entirely. */}
      <Route
        path="/overlay/:fixtureId"
        element={
          <Suspense fallback={null}>
            <StreamOverlay />
          </Suspense>
        }
      />
      {/* Standalone, unauthenticated route for the Arena big-display board -
          same reasoning as the OBS overlay above: a venue TV has no way to
          log in either, so this sits outside AuthProvider/AppShell too. */}
      <Route
        path="/arena/:leagueId"
        element={
          <Suspense fallback={null}>
            <Arena />
          </Suspense>
        }
      />
      {/* Standalone, unauthenticated routes for the two embeddable public
          pages (League Table, League Fixtures) - same reasoning as the two
          routes above, but meant to be dropped into an <iframe> on another
          site rather than shown on a venue TV or OBS canvas, so they sit
          outside AuthProvider/AppShell too. See LeagueDetail.jsx for where
          these links are surfaced to admins. */}
      <Route
        path="/public/leagues/:leagueId/table"
        element={
          <Suspense fallback={null}>
            <PublicLeagueTable />
          </Suspense>
        }
      />
      <Route
        path="/public/leagues/:leagueId/fixtures"
        element={
          <Suspense fallback={null}>
            <PublicLeagueFixtures />
          </Suspense>
        }
      />
      {/* Standalone, unauthenticated route for the embeddable Bracket page -
          one knockout division's bracket chart (single- or double-
          elimination), same reasoning/pattern as the two routes above. See
          DivisionDetail.jsx for where this link is surfaced to admins. */}
      <Route
        path="/public/divisions/:divisionId/bracket"
        element={
          <Suspense fallback={null}>
            <PublicDivisionBracket />
          </Suspense>
        }
      />
      {/* Standalone, unauthenticated routes for the embeddable Division
          Table / Division Fixtures pages - one division's standings or
          fixtures on their own, e.g. for a dedicated per-division page on
          another site. Same pattern as the League Table/Fixtures and
          Bracket routes above. See DivisionDetail.jsx for where these
          links are surfaced to admins. */}
      <Route
        path="/public/divisions/:divisionId/table"
        element={
          <Suspense fallback={null}>
            <PublicDivisionTable />
          </Suspense>
        }
      />
      <Route
        path="/public/divisions/:divisionId/fixtures"
        element={
          <Suspense fallback={null}>
            <PublicDivisionFixtures />
          </Suspense>
        }
      />
      {/* Standalone, unauthenticated route for the Wix-embedded player
          registration popup - no header/breadcrumbs, since this is linked
          to directly from the Wix marketing site as a pop-out rather than
          surfaced inside the app shell. Kept as its own dedicated
          route/component (RegisterWix.jsx), separate from the standard
          /register page above, so changes made for the Wix popup never
          affect in-app registration. Still needs AuthProvider (not
          AppShell) since RegisterWix.jsx calls useAuth().login() on
          successful signup. */}
      <Route
        path="/register-wix"
        element={
          <AuthProvider>
            <RegisterWix />
          </AuthProvider>
        }
      />
      <Route
        path="/*"
        element={
          <AuthProvider>
            <BreadcrumbProvider>
              <AppShell />
            </BreadcrumbProvider>
          </AuthProvider>
        }
      />
    </Routes>
  );
}
