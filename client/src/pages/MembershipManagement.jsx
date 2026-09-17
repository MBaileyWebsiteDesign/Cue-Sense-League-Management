import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Membership Management - Overall-Admin-only. First pass: create/rename/
// delete Venues, and grant/revoke Venue Manager access to them. Assigning a
// specific account's own Venue happens from that account's own edit page
// (Admin Portal -> Manage Users -> pick a user), same place every other
// per-account field/flag is set - see AdminUserEdit.jsx.
//
// This is deliberately a placeholder-shaped first pass, per Matt's request
// to "start there and see what it looks like" - membership plan types,
// pricing, and a way to actually set/edit a player's renewal date are all
// follow-ups once this shape is confirmed. See claude/membership-management-
// venue-manager-2026-09-17.md for the full write-up.
function CreateVenueForm({ onCreated, setError }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setSubmitting(true);
    try {
      await api.createVenue(name.trim());
      setName('');
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New venue name…"
        required
      />
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add venue'}
      </button>
    </form>
  );
}

function RenameVenueForm({ venue, onSaved, setError }) {
  const [name, setName] = useState(venue.name);
  const [submitting, setSubmitting] = useState(false);
  const dirty = name.trim() && name.trim() !== venue.name;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!dirty) return;
    setError('');
    setSubmitting(true);
    try {
      const updated = await api.renameVenue(venue.id, name.trim());
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="inline-form" onSubmit={onSubmit} style={{ marginBottom: 0 }}>
      <input value={name} onChange={(e) => setName(e.target.value)} required />
      <button className="btn" type="submit" disabled={!dirty || submitting}>
        {submitting ? 'Saving…' : 'Rename'}
      </button>
    </form>
  );
}

function VenueManagersPanel({ venue, users, onChange, setError }) {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const managers = users.filter((u) => (venue.managerUserIds || []).includes(u.id));
  const eligible = users.filter((u) => u.isVenueManager && !(venue.managerUserIds || []).includes(u.id));

  const onAdd = async (e) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setBusy(true);
    setError('');
    try {
      await api.addVenueManager(venue.id, selectedUserId);
      setSelectedUserId('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (userId) => {
    setBusy(true);
    setError('');
    try {
      await api.removeVenueManager(venue.id, userId);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      {managers.length === 0 ? (
        <p className="muted" style={{ margin: '4px 0' }}>No Venue Managers assigned yet.</p>
      ) : (
        <ul className="fixture-list">
          {managers.map((m) => (
            <li key={m.id}>
              <span>{m.firstName} {m.lastName} <span className="muted">({m.email})</span></span>
              <button className="btn" type="button" disabled={busy} onClick={() => onRemove(m.id)}>
                Remove access
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={onAdd}>
        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
          <option value="">Select a Venue Manager to add…</option>
          {eligible.map((u) => (
            <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
          ))}
        </select>
        <button className="btn" type="submit" disabled={!selectedUserId || busy}>
          Grant access
        </button>
      </form>
      {eligible.length === 0 && managers.length === 0 && (
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 4 }}>
          No accounts are flagged as Venue Manager yet - grant that flag from{' '}
          <Link to="/admin/users">Manage Users</Link> first.
        </p>
      )}
    </div>
  );
}

function VenueCard({ venue, users, onChange, setError }) {
  const [managing, setManaging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const registeredCount = users.filter((u) => u.venueId === venue.id).length;

  const onDelete = async () => {
    if (!window.confirm(`Delete venue "${venue.name}"? This can't be undone.`)) return;
    setDeleting(true);
    setError('');
    try {
      await api.deleteVenue(venue.id);
      onChange();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{venue.name}</h2>
        <button className="btn btn-danger" type="button" disabled={deleting} onClick={onDelete}>
          {deleting ? 'Deleting…' : 'Delete venue'}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {registeredCount} account{registeredCount === 1 ? '' : 's'} currently assigned to this venue.
      </p>
      <RenameVenueForm venue={venue} onSaved={onChange} setError={setError} />
      <h3 style={{ marginBottom: 4, marginTop: 16 }}>Venue Managers</h3>
      <p className="muted" style={{ margin: '0 0 4px' }}>
        A Venue Manager sees this venue's registered-player status and search from their own
        Venue Manager Portal - grant the Venue Manager flag on an account's profile first
        (Admin Portal &rarr; Manage Users) before assigning them here.
      </p>
      <VenueManagersPanel venue={venue} users={users} onChange={onChange} setError={setError} />
    </section>
  );
}

export default function MembershipManagement() {
  const [venues, setVenues] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Membership Management' }]);

  const load = () => {
    Promise.all([api.getVenues(), api.adminListUsers('')])
      .then(([v, u]) => {
        setVenues(v);
        setUsers(u);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Membership Management</h1>
        <Link to="/admin" className="btn">&larr; Admin Portal</Link>
      </div>
      <p className="muted">
        Create Venues here, then assign each account's Venue from its own page in{' '}
        <Link to="/admin/users">Manage Users</Link>. A Venue Manager (flagged and granted access
        here) gets a dedicated portal showing that venue's registered-player status and a player
        search - see the "Venue Manager Portal" link in the header once an account has that flag.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Add a venue</h2>
        <CreateVenueForm onCreated={load} setError={setError} />
      </section>

      {!venues ? (
        <p>Loading…</p>
      ) : venues.length === 0 ? (
        <p className="muted">No venues yet - add one above to get started.</p>
      ) : (
        <div className="card-grid">
          {venues.map((v) => (
            <VenueCard key={v.id} venue={v} users={users} onChange={load} setError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}
