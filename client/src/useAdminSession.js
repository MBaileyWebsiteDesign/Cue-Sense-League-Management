import { useAuth } from './AuthContext.jsx';

// Thin re-export so existing call sites (and any future ones) read clearly
// as "does this session get admin-only UI" without reaching into useAuth()
// directly. Originally just `isAdmin` (one account model, no tiers) - now
// accepts an optional `league` object: pass one to also let a League
// Manager through for that specific league (mirrors assertLeagueAccess in
// server/src/userAuth.js), or omit it entirely for the old Overall-Admin-
// only behaviour (used by pages like PlayerProfile that have nothing to do
// with a single league).
export function useIsAdminSession(league) {
  const { isAdmin, canManageLeague } = useAuth();
  if (league !== undefined) return canManageLeague(league);
  return isAdmin;
}
