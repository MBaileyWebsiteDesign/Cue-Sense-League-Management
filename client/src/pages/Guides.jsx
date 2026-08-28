import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Reference documents (PDF/Word) an Overall Admin uploads, each flagged
// with which account type(s) can see it - see GET/POST /api/guides and
// PATCH/DELETE /api/guides/:id in server/src/index.js. Every account is at
// least a "player" for this purpose, same convention used everywhere else
// in the app (see PlayerPortal.jsx) - a Captain or League Manager account
// is also checked against the player flag, not just their own.
const GUIDE_ROLES = ['player', 'captain', 'leagueManager', 'admin'];
const GUIDE_ROLE_LABELS = {
  player: 'Players',
  captain: 'Captains',
  leagueManager: 'League Managers',
  admin: 'Overall Admins',
};
const DEFAULT_VISIBILITY = { player: true, captain: true, leagueManager: true, admin: true };

function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKindLabel(guide) {
  const name = (guide.originalFileName || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'PDF';
  if (name.endsWith('.doc') || name.endsWith('.docx')) return 'Word';
  return 'File';
}

// Shared by the upload form (Admin only) and each guide row's inline edit
// controls (Admin only) - "who can view this guide".
function VisibilityCheckboxes({ value, onChange, disabled }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 12 }}>
      {GUIDE_ROLES.map((role) => (
        <label key={role} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 'normal' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={!!value[role]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [role]: e.target.checked })}
          />
          {GUIDE_ROLE_LABELS[role]}
        </label>
      ))}
    </span>
  );
}

function UploadGuideForm({ onUploaded }) {
  const fileInputRef = useRef(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState(DEFAULT_VISIBILITY);
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const onFileChange = (e) => {
    const picked = e.target.files[0] || null;
    setFile(picked);
    setFileName(picked ? picked.name : '');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!file) {
      setError('Choose a PDF or Word document to upload.');
      return;
    }
    if (!GUIDE_ROLES.some((role) => visibility[role])) {
      setError('Choose at least one account type who can view this guide.');
      return;
    }
    setSubmitting(true);
    try {
      await api.uploadGuide({ title, description, visibility, file });
      setTitle('');
      setDescription('');
      setVisibility(DEFAULT_VISIBILITY);
      setFile(null);
      setFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await onUploaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="form" onSubmit={onSubmit}>
      <label>
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </label>
      <label className="label-details">
        <span>Description <span className="muted">(optional)</span></span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
      </label>
      <label>
        File <span className="muted">(PDF or Word document)</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFileChange}
          required
        />
      </label>
      {fileName && <p className="muted" style={{ fontSize: '0.8rem' }}>Selected: {fileName}</p>}
      <div>
        <p style={{ marginBottom: 4 }}>Visible to</p>
        <VisibilityCheckboxes value={visibility} onChange={setVisibility} />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Uploading…' : 'Upload guide'}
      </button>
    </form>
  );
}

function GuideRow({ guide, isAdmin, onDownload, onSave, onDelete }) {
  const [visibility, setVisibility] = useState(guide.visibility);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [rowError, setRowError] = useState('');

  const dirty = GUIDE_ROLES.some((role) => !!visibility[role] !== !!guide.visibility[role]);

  const save = async () => {
    setRowError('');
    setSaving(true);
    try {
      await onSave(guide.id, visibility);
    } catch (err) {
      setRowError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRowError('');
    setDeleting(true);
    try {
      await onDelete(guide.id);
    } catch (err) {
      setRowError(err.message);
      setDeleting(false);
    }
  };

  const download = async () => {
    setRowError('');
    setDownloading(true);
    try {
      await onDownload(guide);
    } catch (err) {
      setRowError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', gap: 12 }}>
        <span>
          <strong>{guide.title}</strong>
          <span
            style={{
              marginLeft: 8,
              fontSize: 12,
              padding: '1px 6px',
              borderRadius: 10,
              background: 'var(--border)',
              color: 'var(--muted)',
            }}
          >
            {fileKindLabel(guide)}
          </span>
          {guide.description && <div className="muted">{guide.description}</div>}
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {guide.uploadedByName} &middot; {new Date(guide.createdAt).toLocaleDateString()}
            {guide.size !== undefined ? ` · ${formatSize(guide.size)}` : ''}
          </div>
        </span>
        <button type="button" className="btn" style={{ flexShrink: 0 }} disabled={downloading} onClick={download}>
          {downloading ? 'Downloading…' : 'Download'}
        </button>
      </div>

      {isAdmin && (
        <div className="inline-form" style={{ flexWrap: 'wrap', marginTop: 8, marginBottom: 0 }}>
          <VisibilityCheckboxes value={visibility} onChange={setVisibility} disabled={saving || deleting} />
          <button type="button" className="btn" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-link" disabled={deleting} onClick={remove}>
            {deleting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}
      {rowError && <p className="error" style={{ margin: '4px 0 0' }}>{rowError}</p>}
    </li>
  );
}

// The actual Guides markup and logic, split out from the standalone page
// below the same way IssuesBugsFeaturesBody is - so a future embed
// elsewhere (e.g. the Help page) can reuse it without duplicating anything.
// Every logged-in account type gets a filtered, view-only list of whichever
// guides an Overall Admin has ticked as visible to them; only an Overall
// Admin also sees the upload form and per-guide edit/remove controls.
export function GuidesBody() {
  const { isAdmin } = useAuth();
  const [guides, setGuides] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getGuides().then(setGuides).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const onDownload = (guide) => api.downloadGuide(guide.id, guide.originalFileName);

  const onSave = async (id, visibility) => {
    const updated = await api.updateGuide(id, { visibility });
    setGuides((current) => current.map((g) => (g.id === id ? updated : g)));
  };

  const onDelete = async (id) => {
    await api.deleteGuide(id);
    setGuides((current) => current.filter((g) => g.id !== id));
  };

  return (
    <>
      {isAdmin && (
        <section className="card">
          <h2>Upload a Guide</h2>
          <p className="muted">
            Choose which account types can see it - players, captains, league managers and/or
            overall admins.
          </p>
          <UploadGuideForm onUploaded={load} />
        </section>
      )}

      <section className="card">
        <h2>Available Guides</h2>

        {error && <p className="error">{error}</p>}

        {!guides ? (
          <p>Loading&hellip;</p>
        ) : guides.length === 0 ? (
          <p className="muted">No guides available{isAdmin ? ' yet' : ''}.</p>
        ) : (
          <ul className="fixture-list">
            {guides.map((guide) => (
              <GuideRow
                key={guide.id}
                guide={guide}
                isAdmin={isAdmin}
                onDownload={onDownload}
                onSave={onSave}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// The standalone /guides page: same body as above, plus the page heading
// and breadcrumbs - reached via the "Guides" card on every portal
// (Player/Captain/League Manager/Admin).
export default function Guides() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Guides' }]);

  return (
    <div>
      <h1>Guides</h1>
      <GuidesBody />
    </div>
  );
}
