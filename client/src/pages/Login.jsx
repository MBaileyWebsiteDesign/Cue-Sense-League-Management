import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// One login for everyone - admins, players and captains all sign in here
// with the same email/password form. What you can see and do afterwards
// depends on the flags on your account (isAdmin, isCaptain), not on which
// login page you used.
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.login(email, password);
      login(token, expiresAt, user);
      // If a protected page redirected here (RequireLogin/RequireAdmin/
      // RequireCaptain sets state.from), honor that - the account is
      // clearly trying to reach something specific. Otherwise, every
      // account - player, Captain, League Manager or Admin - lands on
      // their own My Account page; Admins/League Managers reach their
      // portals via the nav menu from there.
      const from = location.state?.from?.pathname;
      navigate(from || '/account', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 360, margin: '40px auto' }}>
      <h1>Log In</h1>
      <p className="muted">
        Sign in to browse leagues, divisions, fixtures and player profiles. No account
        yet? <Link to="/register">Create one</Link>.
      </p>
      <form className="card form" onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
