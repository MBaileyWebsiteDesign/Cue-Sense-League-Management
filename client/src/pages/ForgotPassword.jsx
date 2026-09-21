import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

// Public "Forgot password" page: enter your email and, if an account exists,
// a single-use reset link (1 hour) is emailed to you. The link lands on
// /reset-password (ResetPassword.jsx). The server deliberately gives the same
// answer whether or not the email matches an account.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await api.forgotPassword(email);
      setMessage(res.message || 'If an account exists for that email, a reset link is on its way.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (message) {
    return (
      <div className="auth-page">
        <div className="card form">
          <h1>Check your email</h1>
          <p className="banner banner-success">{message}</p>
          <p className="muted">Nothing arrived after a few minutes? Check your spam folder, or ask an administrator to send you a link.</p>
          <p><Link to="/login">Back to Log In</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card form" onSubmit={onSubmit}>
        <h1>Forgot Password</h1>
        <p className="muted">Enter the email address on your account and we'll send you a link to choose a new password.</p>
        {error && <p className="error">{error}</p>}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send Reset Link'}
        </button>
        <p><Link to="/login">Back to Log In</Link></p>
      </form>
    </div>
  );
}
