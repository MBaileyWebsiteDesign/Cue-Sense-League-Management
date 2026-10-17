import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerPages.css';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

// Dedicated registration page for Top Spin players, at /RegisterTopSpin.
// Own component/route, separate from the standard /register page, so changes
// here never affect in-app registration. Same fields as /register (first name,
// last name, email, password, then optional phone, team name, classification).
// The venue is preset to Top Spin and cannot be changed: the page sends
// joinVia: 'topspin' and the server looks the venue up by name and adds the
// membership straight away, even if the venue's normal join policy is
// 'approval' (Matt, 2026-10-17: same as /RegisterAura). Afterwards the player
// lands on My Account. Look shared with /register via registerPages.css.
export default function RegisterTopSpin() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', password: '',
    phone: '', teamName: '', classification: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.register({
        ...form,
        classification: form.classification || null,
        joinVia: 'topspin',
      });
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
        <span className="rg-chip">Top Spin</span>
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
        <div className="rg-row">
          <label>
            Phone <span className="muted">(optional)</span>
            <input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" />
          </label>
          <label>
            Team name <span className="muted">(optional)</span>
            <input value={form.teamName} onChange={set('teamName')} autoComplete="off" />
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
        <label>
          Venue
          <input value="Top Spin" disabled readOnly />
          <span className="rg-hint">You'll be added to Top Spin when you create your account.</span>
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
