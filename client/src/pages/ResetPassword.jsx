import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';

// Public page a player lands on after an admin hands them a reset link
// generated from their profile (see PlayerProfile.jsx's AdminAccountPanel /
// POST /api/admin/users/:id/send-reset-link). No login required - the token
// in the URL is the credential; it's single-use and expires after 1 hour.
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="auth-page">
        <div className="card form">
          <h1>Reset Password</h1>
          <p className="error">This link is missing its reset token - ask an admin to send a new one.</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="card form">
          <h1>Reset Password</h1>
          <p className="banner banner-success">Your password has been updated.</p>
          <p><Link to="/login">Go to Login</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card form" onSubmit={onSubmit}>
        <h1>Reset Password</h1>
        <p className="muted">Choose a new password for your account.</p>
        {error && <p className="error">{error}</p>}
        <label>
          New password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
        </label>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Set New Password'}
        </button>
      </form>
    </div>
  );
}
