import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

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
        <button className="btn" disabled={busy} onClick={toggleStatus}>
          {user.status === 'suspended' ? 'Reactivate Account' : 'Suspend Account'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 12, fontSize: '0.8rem' }}>
        Admin unlocks the full Admin Portal (users, seasons, audit log). Captain is
        currently a flag only - team captain tools appear once team leagues launch.
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
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.adminGetUser(userId).then(setUser).catch((e) => setError(e.message));
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
          <PermissionsPanel user={user} onSaved={setUser} setError={setError} setSuccess={setSuccess} />
          <ResetPasswordForm user={user} setError={setError} setSuccess={setSuccess} />
        </>
      )}
    </div>
  );
}
