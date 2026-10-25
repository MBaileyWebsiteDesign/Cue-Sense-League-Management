import { useEffect, useState } from 'react';
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
//
// Forwards to the check-in link (Matt, 2026-10-25): this page's link is the QR code on the
// printed Top Spin check-in poster, and scanning it should check the player in, not just
// sign them up. So on opening it asks the server for Top Spin's current bar tag token and
// replaces itself with /checkin/<token>: logged-out players get Sign In (with "Create one",
// which presets Top Spin and joins straight away), then are checked in and see their
// membership status, and appear on the Venue Manager / Bar Staff check-in list. The form
// below is only shown if Top Spin has no tag yet or the lookup fails.
export default function RegisterTopSpin() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [checkingLink, setCheckingLink] = useState(true);
  useEffect(() => {
    if (typeof api.topSpinCheckinLink !== 'function') { setCheckingLink(false); return undefined; }
    let off = false;
    api.topSpinCheckinLink()
      .then((r) => {
        if (off) return;
        if (r && r.token) navigate(`/checkin/${encodeURIComponent(r.token)}`, { replace: true });
        else setCheckingLink(false);
      })
      .catch(() => { if (!off) setCheckingLink(false); });
    return () => { off = true; };
  }, [navigate]);
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

  if (checkingLink) {
    return (
      <div className="rg-page">
        <div className="rg-banner">
          <h1>Top Spin check-in</h1>
          <p>Loading…</p>
        </div>
      </div>
    );
  }

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
