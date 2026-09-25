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
//
// Mobile layout (2026-09-23): compact header, one card per venue with a
// member-count chip, manager rows with a remove button, a tick-box picker
// for adding managers, and Rename/Delete tucked into a collapsed "Venue
// settings" section. Same API calls as before.

function initialsOf(u) {
  return `${(u.firstName || '')[0] || ''}${(u.lastName || '')[0] || ''}`.toUpperCase() || '?';
}

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
    <form className="mm-add-form" onSubmit={onSubmit}>
      <input
        className="mm-input"
        aria-label="New venue name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New venue name"
        required
      />
      <button className="btn btn-primary" type="submit" disabled={submitting || !name.trim()}>
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
    <form className="mm-rename" onSubmit={onSubmit}>
      <label className="mm-label" htmlFor={`rename-${venue.id}`}>Venue name</label>
      <div className="mm-add-form">
        <input id={`rename-${venue.id}`} className="mm-input" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn" type="submit" disabled={!dirty || submitting}>
          {submitting ? 'Saving…' : 'Rename'}
        </button>
      </div>
    </form>
  );
}

function VenueManagersPanel({ venue, users, onChange, setError }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const managers = users.filter((u) => (venue.managerUserIds || []).includes(u.id));
  const eligible = users.filter((u) => u.isVenueManager && !(venue.managerUserIds || []).includes(u.id));
  const anyFlagged = users.some((u) => u.isVenueManager);

  const toggle = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Grants each ticked account in turn - same single-account
  // POST /api/venues/:id/managers call the old dropdown made, once per pick.
  const onAdd = async () => {
    if (selectedIds.length === 0) return;
    setBusy(true);
    setError('');
    try {
      for (const id of selectedIds) {
        // eslint-disable-next-line no-await-in-loop
        await api.addVenueManager(venue.id, id);
      }
      setSelectedIds([]);
      setAdding(false);
      onChange();
    } catch (err) {
      setError(err.message);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (m) => {
    if (!window.confirm(`Remove ${m.firstName} ${m.lastName}'s Venue Manager access to ${venue.name}?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.removeVenueManager(venue.id, m.id);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mm-managers">
      <div className="mm-sub-head">
        <h3>Venue managers</h3>
        <span className="muted">{managers.length}</span>
      </div>
      {managers.length === 0 ? (
        <p className="muted mm-small">No Venue Managers assigned yet.</p>
      ) : (
        <ul className="mm-rows">
          {managers.map((m) => (
            <li key={m.id}>
              <span className="dv-avatar" aria-hidden="true">{initialsOf(m)}</span>
              <span className="mm-row-main">
                <strong>{m.firstName} {m.lastName}</strong>
                <span className="muted">{m.email}</span>
              </span>
              <button
                type="button"
                className="ah-remove"
                disabled={busy}
                onClick={() => onRemove(m)}
                aria-label={`Remove ${m.firstName} ${m.lastName}'s access`}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}

      {eligible.length > 0 && (
        <div className="ah-walkin">
          <button type="button" className="ah-walkin-toggle" aria-expanded={adding} onClick={() => setAdding((o) => !o)}>
            <span>Add a venue manager</span>
            <span aria-hidden="true">{adding ? '−' : '+'}</span>
          </button>
          {adding && (
            <div className="mm-pick">
              <ul className="ll-manager-list">
                {eligible.map((u) => (
                  <li key={u.id}>
                    <label className="ll-manager-row">
                      <input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggle(u.id)} />
                      <span className="ll-manager-text">
                        <strong>{u.firstName} {u.lastName}</strong>
                        <span className="muted">{u.email}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button className="btn btn-brand-green cs-btn-block" type="button" disabled={busy || selectedIds.length === 0} onClick={onAdd}>
                {busy ? 'Granting…' : selectedIds.length > 1 ? `Grant access to ${selectedIds.length}` : 'Grant access'}
              </button>
            </div>
          )}
        </div>
      )}

      {eligible.length === 0 && (
        <p className="muted mm-small">
          {anyFlagged
            ? 'Everyone flagged as Venue Manager is already assigned here.'
            : 'No accounts are flagged as Venue Manager yet - grant that flag from '}
          {!anyFlagged && <Link to="/admin/users">Manage Users</Link>}
          {!anyFlagged && ' first.'}
        </p>
      )}
    </div>
  );
}

function VenueCard({ venue, users, onChange, setError }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const registeredCount = users.filter((u) => (u.venueMemberships || []).some((m) => m.venueId === venue.id)).length;

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
    <section className="card mm-venue">
      <div className="mm-venue-head">
        <span className="mm-venue-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M10 21v-6h4v6" /></svg>
        </span>
        <h2>{venue.name}</h2>
        <span className="ol-chip">{registeredCount} member{registeredCount === 1 ? '' : 's'}</span>
      </div>

      <VenueManagersPanel venue={venue} users={users} onChange={onChange} setError={setError} />

      <div className="mm-settings">
        <button type="button" className="ah-walkin-toggle mm-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
          <span>Venue settings</span>
          <span aria-hidden="true">{settingsOpen ? '−' : '+'}</span>
        </button>
        {settingsOpen && (
          <div className="mm-settings-body">
            <RenameVenueForm venue={venue} onSaved={onChange} setError={setError} />
            <button className="btn btn-danger cs-btn-block" type="button" disabled={deleting} onClick={onDelete}>
              {deleting ? 'Deleting…' : 'Delete venue'}
            </button>
          </div>
        )}
      </div>
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
    <div className="mm-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Membership</h1>
        {venues && <span className="muted au-total">{venues.length} venue{venues.length === 1 ? '' : 's'}</span>}
      </div>
      <p className="muted mm-intro">
        Venues and their managers. Set each account's venue from <Link to="/admin/users">Manage Users</Link>.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="card mm-add">
        <h2>Add a venue</h2>
        <CreateVenueForm onCreated={load} setError={setError} />
      </section>

      {!venues ? (
        <p className="muted">Loading…</p>
      ) : venues.length === 0 ? (
        <p className="muted">No venues yet - add one above to get started.</p>
      ) : (
        <div className="mm-venues">
          {venues.map((v) => (
            <VenueCard key={v.id} venue={v} users={users} onChange={load} setError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}
