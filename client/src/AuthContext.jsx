import { createContext, useContext, useState, useCallback } from 'react';
import { getDemoSession } from './demo/demoApi.js';

// One account, one login, one session - `isAdmin` and `isCaptain` are just
// flags on the logged-in user rather than a separate identity/session (there
// used to be two entirely separate contexts here, one for a hardcoded admin
// account and one for self-registered players; that's gone now that every
// account is the same kind of thing and can hold any combination of flags).
const AuthContext = createContext(null);
const STORAGE_KEY = 'poolLeagueSession';

// Static demo build (see api.js / vite.config.js): there's no real login to
// wait on, so a visitor lands already signed in as the seeded demo admin
// instead of hitting a login screen first - the whole point is to show the
// app itself, not a login form for an account nobody but this browser tab
// can use.
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

function loadStoredSession() {
  if (DEMO_MODE) return getDemoSession();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session.token || !session.expiresAt || Date.now() > session.expiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadStoredSession);

  const login = useCallback((token, expiresAt, user) => {
    const next = { token, expiresAt, user };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
  }, []);

  // Refreshes the cached user object after a self-service profile edit or
  // password change, without needing a brand new token.
  const updateUser = useCallback((user) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, user };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const user = session?.user || null;

  // League Manager scoping: `isAdmin` can always manage any league;
  // `isLeagueManager` can only manage a league whose `managerUserIds`
  // (assigned by an Overall Admin, see LeagueDetail's Managers panel)
  // includes their own account id. Every page that gates a management
  // action on `isAdmin` for something league-scoped should use
  // canManageLeague(league) instead, so a League Manager sees the same
  // controls an Overall Admin does for leagues they've been assigned to -
  // see assertLeagueAccess in server/src/userAuth.js for the backend
  // enforcement this mirrors.
  const canManageLeague = useCallback(
    (league) => {
      if (!user) return false;
      if (user.isAdmin) return true;
      return !!user.isLeagueManager && Array.isArray(league?.managerUserIds) && league.managerUserIds.includes(user.id);
    },
    [user]
  );

  const value = {
    isLoggedIn: !!session,
    token: session?.token || null,
    user,
    isAdmin: !!user?.isAdmin,
    isCaptain: !!user?.isCaptain,
    isLeagueManager: !!user?.isLeagueManager,
    canManageLeague,
    login,
    logout,
    updateUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export function getStoredToken() {
  return loadStoredSession()?.token || null;
}
