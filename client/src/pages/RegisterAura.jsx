import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerWix.css';

// Dedicated registration page for Aura Technology players, at /RegisterAura.
// Own component/route, separate from the standard /register page, so changes
// here never affect in-app registration. Only the four fields a player needs:
// first name, last name, email, password (no phone, team name or
// classification). The venue is preset to Aura Technology and is NOT shown or
// chosen on the form - the page sends joinVia: 'aura' and the server looks the
// venue up by name and adds the membership straight away, even though the
// venue's normal join policy is 'approval' (Matt, 2026-10-12: anyone using
// this link is let straight in). Afterwards the player lands on My Account,
// as with the standard /register page.
export default function RegisterAura() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.register({ ...form, joinVia: 'aura' });
      login(token, expiresAt, user);
      navigate('/account', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="register-popup">
      <h1>Create your account</h1>
      <p className="register-subtitle">
        Registering for Aura Technology. Already have an account? <Link to="/login">Sign in</Link>.
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
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary register-submit" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
    </div>
  );
}
