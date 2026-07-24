import { Routes, Route, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import LeagueList from './pages/LeagueList.jsx';
import LeagueDetail from './pages/LeagueDetail.jsx';
import DivisionDetail from './pages/DivisionDetail.jsx';
import FixtureDetail from './pages/FixtureDetail.jsx';
import PlayerProfile from './pages/PlayerProfile.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import GameAdjustments from './pages/GameAdjustments.jsx';
import PlayerPortal from './pages/PlayerPortal.jsx';
import CaptainPortal from './pages/CaptainPortal.jsx';
import AdminPortal from './pages/AdminPortal.jsx';
import AdminUsers from './pages/AdminUsers.jsx';
import AdminUserEdit from './pages/AdminUserEdit.jsx';
import AdminAuditLog from './pages/AdminAuditLog.jsx';
import AdminVenues from './pages/AdminVenues.jsx';
import AdminSeasonWizard from './pages/AdminSeasonWizard.jsx';
import StreamOverlay from './pages/StreamOverlay.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { BreadcrumbProvider } from './BreadcrumbContext.jsx';
import Breadcrumbs from './components/Breadcrumbs.jsx';

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

function HeaderNav() {
  const { isLoggedIn, isAdmin, isCaptain, user, logout } = useAuth();
  const navigate = useNavigate();

  if (!isLoggedIn) {
    return (
      <Link to="/login" className="header-link">
        Login
      </Link>
    );
  }

  return (
    <span className="header-accounts">
      {isAdmin && (
        <Link to="/admin" className="header-link">
          Admin Portal
        </Link>
      )}
      {isCaptain && (
        <Link to="/captain" className="header-link">
          Captain Portal
        </Link>
      )}
      <span className="header-admin">
        <Link to="/account" className="admin-badge">
          {user.firstName}{isAdmin ? ' · Admin' : ''}{isCaptain ? ' · Captain' : ''}
        </Link>
        <button
          className="header-link header-link-button"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Log out
        </button>
      </span>
    </span>
  );
}

function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          🎱 The Ultimate Pool League
        </Link>
        <HeaderNav />
      </header>
      <Breadcrumbs />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<RequireLogin><LeagueList /></RequireLogin>} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/account" element={<RequireLogin><PlayerPortal /></RequireLogin>} />
          <Route path="/captain" element={<RequireCaptain><CaptainPortal /></RequireCaptain>} />
          <Route path="/admin" element={<RequireAdmin><AdminPortal /></RequireAdmin>} />
          <Route path="/admin/users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
          <Route path="/admin/users/:userId" element={<RequireAdmin><AdminUserEdit /></RequireAdmin>} />
          <Route path="/admin/audit-log" element={<RequireAdmin><AdminAuditLog /></RequireAdmin>} />
          <Route path="/admin/venues" element={<RequireAdmin><AdminVenues /></RequireAdmin>} />
          <Route path="/admin/game-adjustments" element={<RequireAdmin><GameAdjustments /></RequireAdmin>} />
          <Route path="/admin/seasons/new" element={<RequireAdmin><AdminSeasonWizard /></RequireAdmin>} />
          <Route path="/leagues/:leagueId" element={<RequireLogin><LeagueDetail /></RequireLogin>} />
          <Route path="/divisions/:divisionId" element={<RequireLogin><DivisionDetail /></RequireLogin>} />
          <Route path="/fixtures/:fixtureId" element={<RequireLogin><FixtureDetail /></RequireLogin>} />
          <Route path="/players/:playerId" element={<RequireLogin><PlayerProfile /></RequireLogin>} />
        </Routes>
      </main>
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
      <Route path="/overlay/:fixtureId" element={<StreamOverlay />} />
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
