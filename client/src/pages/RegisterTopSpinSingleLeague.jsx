import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import './registerPages.css';

// Dedicated sign-up page for the Top Spin Singles League, at /registerTopSpinSingleLeague
// (Matt, 2026-10-27). Own component/route, separate from /register, /RegisterTopSpin and
// /RegisterAura. Four fields. The server (POST /api/users/register-top-spin-singles) adds the
// player to the Top Spin venue and registers interest in the Top Spin Singles League. Interest is
// NOT payment: a manager confirms payment later, so the player still has to pay.
// - New email: account created, logged in, lands on My Account (unless interest could not be
//   registered, in which case they are told first).
// - Email already has an account: the password must match. If it does, Top Spin is added to that
//   account and the player is told what happened (not logged in). If not, nothing is changed and
//   they are offered a password reset.
const INTEREST_TEXT = {
  registered: (league) => `Your interest in ${league || 'the Top Spin Singles League'} has been registered, but you still need to pay to secure your place.`,
  already_registered: (league) => `You had already registered interest in ${league || 'the Top Spin Singles League'}. You still need to pay to secure your place.`,
  league_closed: (league) => `${league || 'The Top Spin Singles League'} is not open for registration at the moment, so your interest has not been registered.`,
  league_not_found: () => 'We could not find the Top Spin Singles League, so your interest has not been registered. Please contact the venue.',
  no_player_profile: () => 'Your account has no linked player profile yet, so your interest has not been registered. Please contact an admin.',
};

export default function RegisterTopSpinSingleLeague() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // 'existing_updated' | 'existing_wrong_password' | 'created_notice'
  const [info, setInfo] = useState(null);
  const [resetMsg, setResetMsg] = useState('');
  const [resetting, setResetting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setResetMsg('');
    setSubmitting(true);
    try {
      const r = await api.registerTopSpinSingleLeague(form);
      if (r.status === 'created') {
        login(r.token, r.expiresAt, r.user);
        if (r.interest === 'registered') {
          navigate('/account', { replace: true });
        } else {
          setInfo(r);
          setResult('created_notice');
        }
      } else if (r.status === 'existing_updated') {
        setInfo(r);
        setResult('existing_updated');
      } else {
        setResult('existing_wrong_password');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const sendReset = async () => {
    setResetting(true);
    setResetMsg('');
    try {
      const r = await api.forgotPassword(form.email);
      setResetMsg(r.message || 'If an account exists for that email, a reset link is on its way.');
    } catch (err) {
      setResetMsg(err.message);
    } finally {
      setResetting(false);
    }
  };

  const banner = (
    <div className="rg-banner">
      <h1>Top Spin Singles League</h1>
      <p>Join Top Spin and register your interest in the Top Spin Singles League. Registering interest does not take payment: you will still need to pay to secure your place.</p>
      <span className="rg-chip">Top Spin</span>
    </div>
  );

  const resetBlock = (
    <>
      <p>Would you like to reset your password so you can log in?</p>
      {resetMsg ? (
        <p className="banner banner-success">{resetMsg}</p>
      ) : (
        <button type="button" className="btn btn-primary rg-submit" onClick={sendReset} disabled={resetting}>
          {resetting ? 'Sending…' : 'Yes, email me a reset link'}
        </button>
      )}
    </>
  );

  if (result === 'created_notice' && info) {
    return (
      <div className="rg-page">
        {banner}
        <div className="card form rg-form">
          <p className="banner banner-success">Your account has been created and you have been added to {info.venueName}.</p>
          <p>{(INTEREST_TEXT[info.interest] || INTEREST_TEXT.league_not_found)(info.leagueName)}</p>
          <button type="button" className="btn btn-primary rg-submit" onClick={() => navigate('/account', { replace: true })}>
            Go to My Account
          </button>
        </div>
      </div>
    );
  }

  if (result === 'existing_updated' && info) {
    return (
      <div className="rg-page">
        {banner}
        <div className="card form rg-form">
          <h2>You already have an account</h2>
          <p className="banner banner-success">
            {info.venueAdded
              ? `You have now been added to ${info.venueName}.`
              : `You were already a member of ${info.venueName}.`}
          </p>
          <p>{(INTEREST_TEXT[info.interest] || INTEREST_TEXT.league_not_found)(info.leagueName)}</p>
          {resetBlock}
          <p className="rg-foot"><Link to="/login">Go to Sign in</Link></p>
        </div>
      </div>
    );
  }

  if (result === 'existing_wrong_password') {
    return (
      <div className="rg-page">
        {banner}
        <div className="card form rg-form">
          <h2>You already have an account</h2>
          <p className="error">An account with this email already exists, but the password you entered does not match it, so nothing has been changed.</p>
          {resetBlock}
          <p>After resetting, come back to this page and enter your email and new password to be added to Top Spin and the Top Spin Singles League.</p>
          <button type="button" className="btn rg-submit" onClick={() => { setResult(null); setResetMsg(''); }}>
            Try again
          </button>
          <p className="rg-foot"><Link to="/login">Go to Sign in</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className="rg-page">
      {banner}
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
          <input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" minLength={8} required />
          <span className="rg-hint">At least 8 characters. Already have an account? Use your existing password and we will add you to Top Spin and the league.</span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary rg-submit" type="submit" disabled={submitting}>
          {submitting ? 'Please wait…' : 'Register'}
        </button>
      </form>
      <p className="rg-foot">
        Forgot your password? <Link to="/forgot-password">Reset it</Link>
      </p>
    </div>
  );
}
