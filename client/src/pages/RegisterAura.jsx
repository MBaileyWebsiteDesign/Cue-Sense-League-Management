import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerPages.css';

// Dedicated registration page for Aura Technology players, at /RegisterAura.
// Own component/route, separate from the standard /register page, so changes
// here never affect in-app registration. Only the four fields a player needs:
// first name, last name, email, password (no phone, team name or
// classification). The venue is preset to Aura Technology and is NOT shown or
// chosen on the form - the page sends joinVia: 'aura' and the server looks the
// venue up by name and adds the membership straight away, even though the
// venue's normal join policy is 'approval' (Matt, 2026-10-12: anyone using
// this link is let straight in). Afterwards the player lands on My Account,
// as with the standard /register page. Look (green banner, gold chip, card,
// 16px inputs) shared with /register via registerPages.css (2026-10-12).
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
    <div className="rg-page">
      <div className="rg-banner">
        <h1>Create your account</h1>
        <p>Register to join your venue and see your leagues, fixtures and results.</p>
        <span className="rg-chip">Aura Technology</span>
      </div>
      <form className="card form rg-form" onSubmit={onSubmit}>
        <p className="rg-req">* Required field</p>
        <div className="rg-row">
          <label>
            First name *
            <input value={form.firstName} onChange={set('firstName')} autoComplete="given-name" required autoFocus />
          </label>
          <label>
            Last name *
            <input value={form.lastName} onChange={set('lastName')} autoComplete="family-name" required />
          </label>
        </div>
        <label>
          Email *
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
        </label>
        <label>
          Password *
          <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
          <span className="rg-hint">At least 8 characters</span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary rg-submit" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
      <p className="rg-foot">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
