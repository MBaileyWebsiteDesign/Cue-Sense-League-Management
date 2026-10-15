import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerPages.css';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

// Look (green banner, card, 16px inputs, full-width gold button) shared with
// the dedicated /RegisterAura page via registerPages.css (Matt, 2026-10-12).
export default function Register() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', password: '',
    phone: '', teamName: '', classification: '', venueId: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Venue (optional) - the venues already in the system. GET /api/venues/list
  // is public so it can fill this before an account exists. Venues set to
  // 'approval' send a join request instead of joining straight away.
  const [venues, setVenues] = useState([]);

  useEffect(() => {
    api.listVenuesPublic().then(setVenues).catch(() => {});
  }, []);

  // Came here from a bar check-in tag (Login passes it along as state.from)? For a Top Spin tag the
  // venue is preset and fixed, and the account joins it straight away (Matt, 2026-10-15).
  const tagMatch = /^\/checkin\/([^/?#]+)/.exec(location.state?.from?.pathname || '');
  const tagToken = tagMatch ? decodeURIComponent(tagMatch[1]) : '';
  const [tagVenue, setTagVenue] = useState(null);
  useEffect(() => {
    if (!tagToken || typeof api.checkinSignupVenue !== 'function') return undefined;
    let off = false;
    api.checkinSignupVenue(tagToken)
      .then((r) => { if (!off) setTagVenue(r && r.venueName ? r.venueName : null); })
      .catch(() => {});
    return () => { off = true; };
  }, [tagToken]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.register({
        ...form,
        classification: form.classification || null,
        venueId: tagVenue ? null : (form.venueId || null),
        ...(tagVenue ? { checkinToken: tagToken } : {}),
      });
      login(token, expiresAt, user);
      // If the player came here from a page that needed a login (e.g. they
      // tapped the bar check-in sticker, went to Log In, then "Create one"),
      // RequireLogin's state.from is passed along by Login.jsx's link - send
      // them straight back so they're checked in with one tap (Matt,
      // 2026-10-08). Otherwise new self-registrations (never admins) land on
      // My Account, mirroring Login.jsx's default for a non-admin sign-in.
      const from = location.state?.from?.pathname;
      navigate(from || '/account', { replace: true });
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
        <p>Register to browse leagues, divisions, fixtures and player profiles.</p>
        {tagVenue && <span className="rg-chip">{tagVenue}</span>}
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
        {tagVenue ? (
          <label>
            Venue
            <input value={tagVenue} disabled readOnly />
            <span className="rg-hint">You'll be added to {tagVenue} when you create your account.</span>
          </label>
        ) : venues.length > 0 && (
          <label>
            Venue <span className="muted">(optional)</span>
            <select value={form.venueId} onChange={set('venueId')}>
              <option value="">Not now</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.joinPolicy === 'approval' ? ' (needs approval)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary rg-submit" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
      <p className="rg-foot">
        Already have an account? <Link to="/login" state={location.state}>Sign in</Link>
      </p>
    </div>
  );
}
