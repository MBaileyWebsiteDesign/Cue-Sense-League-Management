import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

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

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { token, expiresAt, user } = await api.register({
        ...form,
        classification: form.classification || null,
        venueId: form.venueId || null,
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
    <div style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>Create Your Account</h1>
      <p className="muted">
        Register to browse leagues, divisions, fixtures and player profiles. Already have
        an account? <Link to="/login" state={location.state}>Sign in</Link>.
      </p>
      <p className="muted" style={{ fontSize: '0.85rem' }}>* Required field</p>
      <form className="card form" onSubmit={onSubmit}>
        <label>
          First name *
          <input value={form.firstName} onChange={set('firstName')} required autoFocus />
        </label>
        <label>
          Last name *
          <input value={form.lastName} onChange={set('lastName')} required />
        </label>
        <label>
          Email *
          <input type="email" value={form.email} onChange={set('email')} required />
        </label>
        <label>
          Password *
          <input type="password" value={form.password} onChange={set('password')} minLength={8} required />
        </label>
        <label>
          Phone <span className="muted">(optional)</span>
          <input type="tel" value={form.phone} onChange={set('phone')} />
        </label>
        <label>
          Team name <span className="muted">(optional)</span>
          <input value={form.teamName} onChange={set('teamName')} />
        </label>
        <label>
          Classification <span className="muted">(optional)</span>
          <select value={form.classification} onChange={set('classification')}>
            <option value="">Not set</option>
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        {venues.length > 0 && (
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
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
    </div>
  );
}
