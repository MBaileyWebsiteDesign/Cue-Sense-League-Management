import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];
const TEMPLATE_COLUMNS = ['firstName', 'lastName', 'email', 'phone', 'teamName', 'classification', 'isCaptain', 'isAdmin', 'isLeagueManager'];
const TEMPLATE_EXAMPLE_ROW = {
  firstName: 'Jamie', lastName: 'Smith', email: 'jamie.smith@example.com', phone: '',
  teamName: '', classification: '', isCaptain: '', isAdmin: '', isLeagueManager: '',
};

function downloadCsvTemplate() {
  const csv = Papa.unparse({ fields: TEMPLATE_COLUMNS, data: [TEMPLATE_COLUMNS.map((c) => TEMPLATE_EXAMPLE_ROW[c])] });
  triggerDownload(new Blob([csv], { type: 'text/csv' }), 'users-template.csv');
}

function downloadExcelTemplate() {
  const sheet = XLSX.utils.json_to_sheet([TEMPLATE_EXAMPLE_ROW], { header: TEMPLATE_COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Users');
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  triggerDownload(new Blob([buffer], { type: 'application/octet-stream' }), 'users-template.xlsx');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Column names are matched exactly (firstName, lastName, ...) against
// whatever key papaparse/xlsx hands back for each header cell. Excel/Numbers
// exports routinely add a leading UTF-8 BOM to the very first header cell,
// or leave stray leading/trailing spaces on any header from copy-paste - either
// one silently turns e.g. "firstName" into a different key, so every row
// fails "firstName is required" with no obvious reason. Trim (and strip any
// BOM char) off every key here so the required-field checks on the server
// actually see the field the admin thinks they filled in.
function cleanRowKeys(rows) {
  return rows.map((row) => {
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      clean[key.replace(/^﻿/, '').trim()] = value;
    }
    return clean;
  });
}

function parseUploadedFile(file) {
  return new Promise((resolve, reject) => {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    if (isCsv) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.replace(/^﻿/, '').trim(),
        complete: (result) => resolve(cleanRowKeys(result.data)),
        error: reject,
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(cleanRowKeys(XLSX.utils.sheet_to_json(firstSheet, { defval: '' })));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function ImportResultSummary({ result }) {
  if (!result) return null;
  return (
    <div className="banner banner-success" style={{ marginTop: 12 }}>
      <p style={{ margin: '0 0 8px' }}>
        {result.created.length} account{result.created.length === 1 ? '' : 's'} created,{' '}
        {result.skipped.length} skipped (already existed), {result.errors.length} row{result.errors.length === 1 ? '' : 's'} rejected.
      </p>
      {result.created.length > 0 && (
        <>
          <p style={{ margin: '0 0 4px', fontWeight: 700 }}>Temporary passwords (share with each player):</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.created.map((c) => (
              <li key={c.email}>{c.name} ({c.email}) &rarr; <code>{c.tempPassword}</code></li>
            ))}
          </ul>
        </>
      )}
      {result.skipped.length > 0 && (
        <>
          <p style={{ margin: '8px 0 4px', fontWeight: 700 }}>Skipped (account already existed):</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.skipped.map((s) => (
              <li key={s.email}>Row {s.row}: {s.name} ({s.email})</li>
            ))}
          </ul>
        </>
      )}
      {result.errors.length > 0 && (
        <>
          <p style={{ margin: '8px 0 4px', fontWeight: 700, color: '#991b1b' }}>Rejected rows:</p>
          <ul style={{ margin: 0, paddingLeft: 20, color: '#991b1b' }}>
            {result.errors.map((e) => (
              <li key={e.row}>Row {e.row}: {e.reason}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ManualAddForm({ onImported, setError }) {
  const emptyForm = {
    firstName: '', lastName: '', email: '', phone: '', teamName: '',
    classification: '', isCaptain: false, isAdmin: false, isLeagueManager: false,
  };
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await api.adminImportUsers([{ ...form, classification: form.classification || null }]);
      onImported(result);
      setForm({ ...emptyForm, teamName: form.teamName });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h3 style={{ marginTop: 0 }}>Add one player</h3>
      <label>First name<input value={form.firstName} onChange={set('firstName')} required /></label>
      <label>Last name<input value={form.lastName} onChange={set('lastName')} required /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
      <label>Phone <span className="muted">(optional)</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
      <label>Team name <span className="muted">(optional)</span><input value={form.teamName} onChange={set('teamName')} /></label>
      <label>
        Classification <span className="muted">(optional)</span>
        <select value={form.classification} onChange={set('classification')}>
          <option value="">Not set</option>
          {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.isCaptain} onChange={(e) => setForm({ ...form, isCaptain: e.target.checked })} />
        Mark as captain
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
        Grant admin
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.isLeagueManager} onChange={(e) => setForm({ ...form, isLeagueManager: e.target.checked })} />
        Grant League Manager
      </label>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add Player'}
      </button>
    </form>
  );
}

// Quick, single-row account creation right under the search box - separate
// from ManualAddForm/BulkImportPanel above (that one is a vertical form
// tucked inside the collapsible bulk-import panel and never asks for a
// password, since bulk-imported accounts always get a random temp
// password shown once). NQT: "Add a box under search to quickly add a
// user manually using this field, but horizontal, not vertically. It only
// needs to ask for first name, last name, email, password, with the
// option to tick flags as well." Reuses POST /api/admin/users/import
// (a single-row array) rather than a new endpoint - the only backend
// change needed was letting that route accept an explicit password
// instead of always generating one.
function QuickAddUserBox({ onAdded }) {
  const emptyForm = { firstName: '', lastName: '', email: '', password: '', isCaptain: false, isAdmin: false, isLeagueManager: false };
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const setFlag = (field) => (e) => setForm({ ...form, [field]: e.target.checked });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const result = await api.adminImportUsers([form]);
      if (result.errors && result.errors.length > 0) {
        setError(result.errors[0].reason);
      } else if (result.skipped && result.skipped.length > 0) {
        setError(result.skipped[0].reason);
      } else {
        setSuccess(`Added ${form.firstName} ${form.lastName}.`);
        setForm(emptyForm);
        onAdded();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="quick-add-user-box" onSubmit={onSubmit}>
      <input placeholder="First name *" value={form.firstName} onChange={set('firstName')} required />
      <input placeholder="Last name *" value={form.lastName} onChange={set('lastName')} required />
      <input type="email" placeholder="Email *" value={form.email} onChange={set('email')} required />
      <input type="password" placeholder="Password *" value={form.password} onChange={set('password')} minLength={8} required />
      <span className="quick-add-flags">
        <label><input type="checkbox" checked={form.isCaptain} onChange={setFlag('isCaptain')} /> Captain</label>
        <label><input type="checkbox" checked={form.isAdmin} onChange={setFlag('isAdmin')} /> Admin</label>
        <label><input type="checkbox" checked={form.isLeagueManager} onChange={setFlag('isLeagueManager')} /> League Manager</label>
      </span>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Quick add user'}
      </button>
      {error && <p className="error quick-add-message">{error}</p>}
      {success && <p className="muted quick-add-message">{success}</p>}
    </form>
  );
}

// A standalone bulk-import panel for the Manage Users screen - separate from
// the Season Setup Wizard's CSV/Excel import (which assigns straight into a
// season's divisions). This one just creates accounts: no division/season
// context required, so it's the right tool for onboarding a batch of players
// ahead of deciding which league they'll land in, or just building out the
// user list in bulk. New accounts get a random temporary password (shown
// once, to hand to the player); rows whose email already has an account are
// skipped rather than silently overwritten.
function BulkImportPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('csv');
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
    setFileName(file.name);
    try {
      const rows = await parseUploadedFile(file);
      setParsedRows(rows);
    } catch (err) {
      setError(`Couldn't read that file: ${err.message}`);
    }
  };

  const onImportParsedRows = async () => {
    setError('');
    setSubmitting(true);
    try {
      const result = await api.adminImportUsers(parsedRows);
      setImportResult(result);
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const mergeManualResult = (result) => {
    setImportResult((prev) => prev
      ? { created: [...prev.created, ...result.created], skipped: [...prev.skipped, ...result.skipped], errors: [...prev.errors, ...result.errors] }
      : result);
    onImported();
  };

  return (
    <section className="card">
      <div className="page-header" style={{ marginBottom: open ? 12 : 0 }}>
        <h2 style={{ margin: 0 }}>Bulk Add Users</h2>
        <button className="btn" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Upload CSV / Excel or add players'}
        </button>
      </div>

      {open && (
        <div>
          <p className="muted">
            Create accounts in bulk without assigning them to a season - use this to onboard a
            batch of players, then add them to a division/team roster afterwards from that
            division's page. To build a whole new season (leagues + rosters + fixtures) in one
            go instead, use <Link to="/admin/seasons/new">+ New Season</Link>.
          </p>

          <div className="inline-form">
            <button className={`btn ${mode === 'csv' ? 'btn-primary' : ''}`} type="button" onClick={() => setMode('csv')}>
              Upload CSV / Excel
            </button>
            <button className={`btn ${mode === 'manual' ? 'btn-primary' : ''}`} type="button" onClick={() => setMode('manual')}>
              Add players manually
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          {mode === 'csv' ? (
            <div>
              <div className="inline-form">
                <button className="btn" type="button" onClick={downloadCsvTemplate}>Download CSV template</button>
                <button className="btn" type="button" onClick={downloadExcelTemplate}>Download Excel template</button>
              </div>
              <label>
                Upload filled-in file
                <input type="file" accept=".csv,.xlsx,.xls" onChange={onFileChange} />
              </label>
              {fileName && parsedRows && (
                <>
                  <p className="muted">{fileName}: {parsedRows.length} row(s) found.</p>
                  <button className="btn btn-primary" type="button" onClick={onImportParsedRows} disabled={submitting}>
                    {submitting ? 'Importing…' : `Import ${parsedRows.length} player(s)`}
                  </button>
                </>
              )}
            </div>
          ) : (
            <ManualAddForm onImported={mergeManualResult} setError={setError} />
          )}

          <ImportResultSummary result={importResult} />
        </div>
      )}
    </section>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Users' }]);

  const load = (q) => api.adminListUsers(q).then(setUsers).catch((e) => setError(e.message));

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = (e) => {
    e.preventDefault();
    load(query);
  };

  const toggleOne = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const allSelected = users && users.length > 0 && selectedIds.length === users.length;
  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : users.map((u) => u.id));
  };

  // Accounts with any league/match history (played a fixture, on a division/
  // team/pairing roster, in Roll of Honour, a league manager) can't be
  // hard-deleted - the server skips those and reports why (see userInUse
  // in server/src/index.js) rather than silently ignoring or force-deleting
  // them, since force-deleting would leave a fixture or Roll of Honour entry
  // pointing at a player id that no longer exists. Suspend those instead
  // from the account's own edit page.
  const onDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    const names = users.filter((u) => selectedIds.includes(u.id)).map((u) => `${u.firstName} ${u.lastName}`);
    if (!window.confirm(`Delete ${selectedIds.length} account(s)?\n\n${names.join(', ')}\n\nThis can't be undone.`)) {
      return;
    }
    setError('');
    setDeleteResult(null);
    setDeleting(true);
    try {
      const result = await api.adminBulkDeleteUsers(selectedIds);
      setDeleteResult(result);
      setSelectedIds([]);
      load(query);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Manage Users</h1>
        <span className="inline-form" style={{ marginBottom: 0 }}>
          <Link to="/admin" className="btn">&larr; Admin Portal</Link>
        </span>
      </div>

      <BulkImportPanel onImported={() => load(query)} />

      <form className="inline-form" onSubmit={onSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email or team…"
        />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>

      <QuickAddUserBox onAdded={() => load(query)} />

      {error && <p className="error">{error}</p>}

      {deleteResult && (
        <div className="banner banner-success" style={{ marginTop: 12 }}>
          {deleteResult.deleted.length > 0 && (
            <p style={{ margin: '0 0 8px' }}>
              Deleted {deleteResult.deleted.length} account{deleteResult.deleted.length === 1 ? '' : 's'}:{' '}
              {deleteResult.deleted.map((d) => d.name).join(', ')}.
            </p>
          )}
          {deleteResult.blocked.length > 0 && (
            <>
              <p style={{ margin: '0 0 4px', fontWeight: 700, color: '#991b1b' }}>
                Couldn't delete {deleteResult.blocked.length}:
              </p>
              <ul style={{ margin: 0, paddingLeft: 20, color: '#991b1b' }}>
                {deleteResult.blocked.map((b) => (
                  <li key={b.id}>{b.name}: {b.reason}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="inline-form" style={{ marginTop: 12 }}>
          <button className="btn btn-danger" type="button" onClick={onDeleteSelected} disabled={deleting}>
            {deleting ? 'Deleting…' : `Delete ${selectedIds.length} selected`}
          </button>
          <button className="btn" type="button" onClick={() => setSelectedIds([])} disabled={deleting}>
            Clear selection
          </button>
        </div>
      )}

      {!users ? (
        <p>Loading…</p>
      ) : (
        <table className="standings-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all users"
                />
              </th>
              <th>Name</th><th>Email</th><th>Team</th><th>Class</th><th>Flags</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={selectedIds.includes(u.id)}
                    onChange={() => toggleOne(u.id)}
                    aria-label={`Select ${u.firstName} ${u.lastName}`}
                  />
                </td>
                <td style={{ textAlign: 'left' }}>
                  <Link to={`/admin/users/${u.id}`}>{u.firstName} {u.lastName}</Link>
                </td>
                <td style={{ textAlign: 'left' }}>{u.email}</td>
                <td style={{ textAlign: 'left' }}>{u.teamName}</td>
                <td>{u.classification || '—'}</td>
                <td>{[u.isAdmin && 'Admin', u.isCaptain && 'Captain', u.isLeagueManager && 'League Manager'].filter(Boolean).join(', ') || '—'}</td>
                <td>
                  <span className={`status ${u.status === 'suspended' ? '' : 'status-completed'}`}>{u.status}</span>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={7} className="muted">No users match that search.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
