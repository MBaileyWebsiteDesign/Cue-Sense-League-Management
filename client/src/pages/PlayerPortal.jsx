import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import VenueSelect from '../components/VenueSelect.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

function ProfileForm({ player, onSaved }) {
  const [form, setForm] = useState({
    firstName: player.firstName,
    lastName: player.lastName,
    email: player.email,
    phone: player.phone || '',
    venue: player.venue,
    teamName: player.teamName,
    classification: player.classification || '',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.updateMe({ ...form, classification: form.classification || null });
      onSaved(updated);
      setSuccess('Details updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Your Details</h2>
      <label>
        First name
        <input value={form.firstName} onChange={set('firstName')} required />
      </label>
      <label>
        Last name
        <input value={form.lastName} onChange={set('lastName')} required />
      </label>
      <label>
        Email
        <input type="email" value={form.email} onChange={set('email')} required />
      </label>
      <label>
        Phone <span className="muted">(optional)</span>
        <input type="tel" value={form.phone} onChange={set('phone')} />
      </label>
      <label>
        Venue
        <VenueSelect value={form.venue} onChange={(name) => setForm({ ...form, venue: name })} />
      </label>
      <label>
        Team name
        <input value={form.teamName} onChange={set('teamName')} required />
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
      {success && <p className="banner banner-success">{success}</p>}
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save Details'}
      </button>
    </form>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Password changed.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Change Password</h2>
      <label>
        Current password
        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
      </label>
      <label>
        New password
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
      </label>
      <label>
        Confirm new password
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
      </label>
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Changing…' : 'Change Password'}
      </button>
    </form>
  );
}

// Inline "why are you disputing this" prompt - collapsed to a single Dispute
// button until clicked, then expands to a required reason field so the
// admin resolving it (Game Adjustments) has context to work from.
function DisputeControl({ onDispute }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return <button className="btn" onClick={() => setOpen(true)}>Dispute</button>;
  }

  const submit = async () => {
    if (!reason.trim()) {
      setError('Please explain why you’re disputing this result.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onDispute(reason.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 6, width: '100%' }}>
      <div className="inline-form" style={{ flexWrap: 'wrap', marginBottom: error ? 4 : 0 }}>
        <input
          type="text"
          placeholder="Why are you disputing this result?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ flex: '1 1 220px' }}
          autoFocus
        />
        <button className="btn btn-primary" disabled={submitting} onClick={submit}>Submit Dispute</button>
        <button className="btn" disabled={submitting} onClick={() => { setOpen(false); setReason(''); setError(''); }}>Cancel</button>
      </div>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

// Results your opponent has already submitted that are sitting at
// `pending_confirmation`, waiting specifically on you (the away side/nominee)
// to confirm or dispute - the player-facing counterpart to the admin's
// Game Adjustments "Games disputed" list. Shown above My Fixtures so it's
// the first thing a player sees if something needs their attention; renders
// nothing at all once there's nothing pending, to keep the page uncluttered.
function NeedsYourConfirmation() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState('');

  const load = () => {
    api.getMyPendingConfirmations().then(setItems).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const onConfirm = async (item) => {
    setError('');
    setBanner('');
    try {
      if (item.legNumber) await api.confirmLegResult(item.fixtureId, item.legNumber);
      else await api.confirmResult(item.fixtureId);
      setBanner('Result confirmed.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const onDispute = async (item, reason) => {
    if (item.legNumber) await api.disputeLegResult(item.fixtureId, item.legNumber, reason);
    else await api.disputeResult(item.fixtureId, reason);
    setBanner('Result disputed - an admin will review it.');
    load();
  };

  if (error) return <p className="error">{error}</p>;
  if (!items || items.length === 0) return null;

  return (
    <section className="card">
      <h2>Needs Your Confirmation</h2>
      <p className="muted">
        Results submitted by your opponent that are waiting on you to confirm or dispute.
      </p>
      {banner && <p className="banner banner-success">{banner}</p>}
      <ul className="fixture-list">
        {items.map((item) => (
          <li key={`${item.fixtureId}-${item.legNumber ?? 'main'}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Link to={`/fixtures/${item.fixtureId}`}>
                vs {item.opponentName} <strong>{item.scoreLabel}</strong>
                <span className="muted"> · {item.leagueName} / {item.divisionName} · Round {item.round}</span>
              </Link>
            </div>
            <div className="inline-form" style={{ marginTop: 6, marginBottom: 0 }}>
              <button className="btn btn-primary" onClick={() => onConfirm(item)}>Confirm</button>
              <DisputeControl onDispute={(reason) => onDispute(item, reason)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MyFixtures() {
  const [fixtures, setFixtures] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getMyFixtures().then(setFixtures).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!fixtures) return <p>Loading…</p>;

  const upcoming = fixtures.filter((f) => f.status !== 'completed');
  const recent = fixtures.filter((f) => f.status === 'completed').slice(-10).reverse();

  return (
    <section className="card">
      <h2>My Fixtures</h2>
      {fixtures.length === 0 && (
        <p className="muted">You're not registered in any division or team yet - an admin or captain can add you from Manage Users / a division's roster.</p>
      )}

      {upcoming.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>Upcoming</h3>
          <ul className="fixture-list">
            {upcoming.map((f) => (
              <li key={f.id}>
                <Link to={`/fixtures/${f.id}`}>
                  {f.leagueName} · {f.divisionName} · Round {f.round} vs {f.opponentName}
                </Link>
                <span className="muted">{f.scheduledDate || 'date TBC'}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {recent.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>Recent results</h3>
          <ul className="fixture-list">
            {recent.map((f) => (
              <li key={f.id}>
                <Link to={`/fixtures/${f.id}`}>
                  {f.leagueName} · {f.divisionName} · Round {f.round} vs {f.opponentName}
                </Link>
                <span className="status status-completed">completed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// The Player Management Portal - every account's home base: profile details,
// password, and a personal fixture list (upcoming + recent results) across
// every division/team they're registered in. Admins and captains land here
// too via "My Account" in the header; their extra Admin/Captain Portal links
// sit alongside this rather than replacing it, since every account is a
// player account first.
export default function PlayerPortal() {
  const { user, updateUser } = useAuth();
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'My Account' }]);

  if (!user) return <p>Loading…</p>;

  const badges = [user.isAdmin && 'Admin', user.isCaptain && 'Captain'].filter(Boolean);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>My Account</h1>
          <p className="muted">
            {badges.length > 0 ? `Player account · ${badges.join(' & ')}` : 'Player account'}
            {user.playerId && (
              <> · <Link to={`/players/${user.playerId}`}>View my stats &amp; match history</Link></>
            )}
          </p>
        </div>
      </div>

      <NeedsYourConfirmation />
      <MyFixtures />
      <ProfileForm player={user} onSaved={updateUser} />
      <ChangePasswordForm />
    </div>
  );
}
