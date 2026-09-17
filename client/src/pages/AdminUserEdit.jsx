import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Membership Management: which Venue this account belongs to - a plain data
// field on every account type, admin-set only (see POST
// /api/admin/users/:id/venue). Kept as its own small card, separate from
// ProfileForm above, since it isn't part of applyProfileFields (that
// function also backs the self-service PATCH /api/users/me, and Venue is
// deliberately never self-editable).
function VenuePanel({ user, venues, onSaved, setError, setSuccess }) {
  const [venueId, setVenueId] = useState(user.venueId || '');
  const [submitting, setSubmitting] = useState(false);
  const dirty = venueId !== (user.venueId || '');

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.adminSetUserVenue(user.id, venueId || null);
      onSaved(updated);
      setSuccess('Venue updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Venue</h2>
      <label>
        Venue <span className="muted">(optional)</span>
        <select value={venueId} onChange={(e) => setVenueId(e.target.value)}>
          <option value="">Not set</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>
      <button className="btn btn-primary" type="submit" disabled={!dirty || submitting}>
        {submitting ? 'Saving…' : 'Save Venue'}
      </button>
      {venues.length === 0 && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          No venues exist yet - create one from Admin Portal &rarr; Membership Management first.
        </p>
      )}
    </form>
  );
}

// Membership dates - both optional/nullable; a player can have neither, either,
// or both set. End date reuses the existing membershipRenewalDate field
// (server/src/index.js's POST /api/admin/users/:id/membership-dates), which is
// what the Venue Manager Portal's "due for renewal" counts key off.
function MembershipDatesPanel({ user, onSaved, setError, setSuccess }) {
  const [startDate, setStartDate] = useState(user.membershipStartDate || '');
  const [endDate, setEndDate] = useState(user.membershipRenewalDate || '');
  const [submitting, setSubmitting] = useState(false);
  const dirty =
    startDate !== (user.membershipStartDate || '') ||
    endDate !== (user.membershipRenewalDate || '');

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.adminSetMembershipDates(user.id, {
        membershipStartDate: startDate || null,
        membershipEndDate: endDate || null,
      });
      onSaved(updated);
      setSuccess('Membership dates updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Membership dates</h2>
      <label>
        Start date <span className="muted">(optional)</span>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </label>
      <label>
        End date <span className="muted">(optional)</span>
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={!dirty || submitting}>
        {submitting ? 'Saving…' : 'Save Membership Dates'}
      </button>
    </form>
  );
}

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

function ProfileForm({ user, onSaved, setError, setSuccess }) {
  const [form, setForm] = useState({
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone || '',
    teamName: user.teamName,
    classification: user.classification || '',
  });
  const [submitting, setSubmitting] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.adminUpdateUser(user.id, { ...form, classification: form.classification || null });
      onSaved(updated);
      setSuccess('Profile updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Profile</h2>
      <label>First name<input value={form.firstName} onChange={set('firstName')} required /></label>
      <label>Last name<input value={form.lastName} onChange={set('lastName')} required /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
      <label>Phone <span className="muted">(optional)</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
      <label>Team name<input value={form.teamName} onChange={set('teamName')} required /></label>
      <label>
        Classification <span className="muted">(optional)</span>
        <select value={form.classification} onChange={set('classification')}>
          <option value="">Not set</option>
          {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save Profile'}
      </button>
    </form>
  );
}

// One account can be admin, captain, both or neither - these are independent
// flags now (there's no single "role" to toggle between). Suspending an
// account blocks its login immediately regardless of either flag.
function PermissionsPanel({ user, onSaved, setError, setSuccess }) {
  const [busy, setBusy] = useState(false);

  const setPermission = async (patch) => {
    setError(''); setSuccess(''); setBusy(true);
    try {
      const updated = await api.adminSetPermissions(user.id, patch);
      onSaved(updated);
      setSuccess('Permissions updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async () => {
    setError(''); setSuccess(''); setBusy(true);
    const nextStatus = user.status === 'suspended' ? 'active' : 'suspended';
    try {
      const updated = await api.adminSetStatus(user.id, nextStatus);
      onSaved(updated);
      setSuccess(`Account ${nextStatus === 'suspended' ? 'suspended' : 'reactivated'}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Permissions &amp; Status</h2>
      <p className="muted">
        Current status: <strong>{user.status}</strong>
      </p>
      <div className="inline-form">
        <button className="btn" disabled={busy} onClick={() => setPermission({ isAdmin: !user.isAdmin })}>
          {user.isAdmin ? 'Revoke Admin' : 'Grant Admin'}
        </button>
        <button className="btn" disabled={busy} onClick={() => setPermission({ isCaptain: !user.isCaptain })}>
          {user.isCaptain ? 'Unmark Captain' : 'Mark as Captain'}
        </button>
        <button className="btn" disabled={busy} onClick={() => setPermission({ isLeagueManager: !user.isLeagueManager })}>
          {user.isLeagueManager ? 'Revoke League Manager' : 'Grant League Manager'}
        </button>
        <button className="btn" disabled={busy} onClick={() => setPermission({ isVenueManager: !user.isVenueManager })}>
          {user.isVenueManager ? 'Revoke Venue Manager' : 'Grant Venue Manager'}
        </button>
        <button className="btn" disabled={busy} onClick={toggleStatus}>
          {user.status === 'suspended' ? 'Reactivate Account' : 'Suspend Account'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 12, fontSize: '0.8rem' }}>
        Admin unlocks the full Admin Portal (users, seasons, audit log). Captain is
        currently a flag only - team captain tools appear once team leagues launch. League
        Manager makes this account eligible to be assigned scoped admin access to specific
        leagues (assign them from that league's own page) - granting it here doesn't give
        access to anything by itself, and revoking it also strips any leagues they were
        already assigned to. Venue Manager works the same way, but for venues - assign them
        from Admin Portal &rarr; Membership Management.
      </p>
    </section>
  );
}

function ResetPasswordForm({ user, setError, setSuccess }) {
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    setSubmitting(true);
    try {
      await api.adminResetPassword(user.id, newPassword);
      setNewPassword('');
      setSuccess('Password reset - share the new password with the player securely.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Force Password Reset</h2>
      <p className="muted">Sets a new password directly - no need to know the current one.</p>
      <label>
        New password
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
      </label>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Resetting…' : 'Reset Password'}
      </button>
    </form>
  );
}

export default function AdminUserEdit() {
  const { userId } = useParams();
  const [user, setUser] = useState(null);
  const [venues, setVenues] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.adminGetUser(userId).then(setUser).catch((e) => setError(e.message));
    api.getVenues().then(setVenues).catch(() => {});
  }, [userId]);

  useSetBreadcrumbs(
    user
      ? [{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Users', to: '/admin/users' }, { label: `${user.firstName} ${user.lastName}` }]
      : [{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Users', to: '/admin/users' }, { label: 'Loading…' }]
  );

  if (!user && !error) return <p>Loading…</p>;

  return (
    <div>
      <p><Link to="/admin/users">&larr; Back to all users</Link></p>
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}
      {user && (
        <>
          <h1>{user.firstName} {user.lastName}</h1>
          {user.playerId && (
            <p className="muted"><Link to={`/players/${user.playerId}`}>View their stats &amp; match history</Link></p>
          )}
          <ProfileForm user={user} onSaved={setUser} setError={setError} setSuccess={setSuccess} />
          <VenuePanel user={user} venues={venues} onSaved={setUser} setError={setError} setSuccess={setSuccess} />
          <MembershipDatesPanel user={user} onSaved={setUser} setError={setError} setSuccess={setSuccess} />
          <PermissionsPanel user={user} onSaved={setUser} setError={setError} setSuccess={setSuccess} />
          <ResetPasswordForm user={user} setError={setError} setSuccess={setSuccess} />
        </>
      )}
    </div>
  );
}
