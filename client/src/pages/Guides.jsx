import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
    <span className="sx-chips" role="group" aria-label="Visible to">
      {GUIDE_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          className={`au-filter${value[role] ? ' au-filter-on' : ''}`}
          aria-pressed={!!value[role]}
          disabled={disabled}
          onClick={() => onChange({ ...value, [role]: !value[role] })}
        >
          {value[role] ? '✓ ' : ''}{GUIDE_ROLE_LABELS[role]}
        </button>
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
    <form className="sx-form" onSubmit={onSubmit}>
      <label className="ll-field">
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </label>
      <label className="ll-field">
        <span>Description <span className="muted">(optional)</span></span>
        <textarea className="sx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
      </label>
      <label className="sx-file">
        <span>File <span className="muted">(PDF or Word document)</span></span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFileChange}
          required
        />
      </label>
      {fileName && <p className="muted sx-small" style={{ margin: 0 }}>Selected: {fileName}</p>}
      <div className="sx-field">
        <span className="sx-field-label">Visible to</span>
        <VisibilityCheckboxes value={visibility} onChange={setVisibility} />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary cs-btn-block" type="submit" disabled={submitting}>
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
    <li className="sx-guide">
      <div className="sx-guide-top">
        <span className={`sx-kind sx-kind-${fileKindLabel(guide).toLowerCase()}`} aria-hidden="true">{fileKindLabel(guide)}</span>
        <span className="sx-guide-main">
          <strong>{guide.title}</strong>
          {guide.description && <span className="muted sx-small">{guide.description}</span>}
          <span className="muted sx-small">
            {guide.uploadedByName} &middot; {new Date(guide.createdAt).toLocaleDateString('en-GB')}
            {guide.size !== undefined ? ` · ${formatSize(guide.size)}` : ''}
          </span>
        </span>
      </div>
      <button type="button" className="btn btn-brand-green cs-btn-block" disabled={downloading} onClick={download}>
        {downloading ? 'Downloading…' : `Download ${fileKindLabel(guide)}`}
      </button>

      {isAdmin && (
        <div className="sx-guide-admin">
          <span className="sx-field-label">Visible to</span>
          <VisibilityCheckboxes value={visibility} onChange={setVisibility} disabled={saving || deleting} />
          <div className="sx-guide-actions">
            <button type="button" className="btn dv-small-btn" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-danger dv-small-btn" disabled={deleting} onClick={() => { if (window.confirm(`Remove "${guide.title}"?`)) remove(); }}>
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          </div>
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
  const [uploadOpen, setUploadOpen] = useState(false);

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
    <div className="sx-stack">
      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Available guides</h2>
          {guides && <span className="muted">{guides.length}</span>}
        </div>

        {error && <p className="error">{error}</p>}

        {!guides ? (
          <p className="muted">Loading&hellip;</p>
        ) : guides.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No guides available{isAdmin ? ' yet - upload one below' : ''}.</p>
        ) : (
          <ul className="sx-guides">
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

      {isAdmin && (
        <section className="card au-add">
          <button type="button" className="au-add-toggle" aria-expanded={uploadOpen} onClick={() => setUploadOpen((o) => !o)}>
            <span>Upload a guide</span>
            <span aria-hidden="true">{uploadOpen ? '−' : '+'}</span>
          </button>
          {uploadOpen && <UploadGuideForm onUploaded={async () => { await load(); setUploadOpen(false); }} />}
        </section>
      )}
    </div>
  );
}

// The standalone /guides page: same body as above, plus the page heading
// and breadcrumbs - reached via the "Guides" card on every portal
// (Player/Captain/League Manager/Admin).
export default function Guides() {
  const { isAdmin, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'Guides' }]);

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to={isPlayerSession ? '/account' : '/'} className="msg-icon-btn" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Guides</h1>
      </div>
      <p className="muted mm-intro">Reference documents for your account type.</p>
      <GuidesBody />
    </div>
  );
}
