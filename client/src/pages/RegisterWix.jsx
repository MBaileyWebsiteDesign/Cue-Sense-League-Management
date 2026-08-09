import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerWix.css';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

// Dedicated registration page for the Wix marketing site's popup Register
// button (see App.jsx: /register-wix). Kept as its own component/route,
// separate from the standard in-app /register page, so changes made here
// for the Wix embed never affect in-app registration. Sized for a 640x640
// popup window opened via window.open() from the Wix site. On success this
// shows an inline confirmation instead of navigating to /account - the
// popup is too small for the full app shell, and the whole point of a
// dedicated popup is register -> confirm, not register -> land in the
// Player Portal. The account is still logged in via useAuth().login() (so
// the session is already live if the player continues to the main site in
// another tab afterwards), it just doesn't navigate anywhere.
export default function RegisterWix() {
  const { login } = useAuth();
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', password: '',
    phone: '', teamName: '', classification: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.register({
        ...form,
        classification: form.classification || null,
      });
      login(token, expiresAt, user);
      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="register-popup">
        <div className="register-confirmation">
          <h1>You're registered{form.firstName ? `, ${form.firstName}` : ''}!</h1>
          <p className="register-subtitle">
            Your account has been created. You can close this window now.
          </p>
          <button
            className="btn btn-primary register-submit"
            type="button"
            onClick={() => window.close()}
          >
            Close window
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="register-popup">
      <h1>Create Your Account</h1>
      <p className="register-subtitle">
        Register to browse leagues, divisions, fixtures and player profiles.{' '}
        Already have an account? <Link to="/login">Sign in</Link>.
      </p>
      <form className="register-form" onSubmit={onSubmit}>
        <div className="register-row">
          <label>
            First name *
            <input value={form.firstName} onChange={set('firstName')} required autoFocus />
          </label>
          <label>
            Last name *
            <input value={form.lastName} onChange={set('lastName')} required />
          </label>
        </div>
        <label>
          Email *
          <input type="email" value={form.email} onChange={set('email')} required />
        </label>
        <label>
          Password *
          <input type="password" value={form.password} onChange={set('password')} minLength={8} required />
        </label>
        <div className="register-row">
          <label>
            Phone <span className="muted">(optional)</span>
            <input type="tel" value={form.phone} onChange={set('phone')} />
          </label>
          <label>
            Team name <span className="muted">(optional)</span>
            <input value={form.teamName} onChange={set('teamName')} />
          </label>
        </div>
        <label>
          Classification <span className="muted">(optional)</span>
          <select value={form.classification} onChange={set('classification')}>
            <option value="">Not set</option>
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary register-submit" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
    </div>
  );
}
