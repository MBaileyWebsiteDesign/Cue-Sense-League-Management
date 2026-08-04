import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

export default function Register() {
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
      });
      login(token, expiresAt, user);
      // New self-registrations are never admins, so this always lands on My
      // Account - mirrors Login.jsx's default for a non-admin sign-in.
      navigate('/account');
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
        an account? <Link to="/login">Sign in</Link>.
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
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </button>
      </form>
    </div>
  );
}
