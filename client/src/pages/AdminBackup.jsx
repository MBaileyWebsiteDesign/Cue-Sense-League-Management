import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const RESTORE_CONFIRM_PHRASE = 'RESTORE';
const WIPE_CONFIRM_PHRASE = 'WIPE ALL DATA';

// Overall-Admin-only. Three independent destructive/system actions, each
// its own two-step "type to confirm" section like LeagueDetail's Delete
// League panel - see server/src/index.js's GET/POST
// /api/admin/backup|restore|wipe for the backend side of each.
export default function AdminBackup() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Backup & Restore' }]);

  const [error, setError] = useState('');

  const [exporting, setExporting] = useState(false);

  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);

  const [wipeConfirm, setWipeConfirm] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeResult, setWipeResult] = useState(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

  const onExport = async () => {
    setError('');
    setExporting(true);
    try {
      await api.downloadBackup();
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const onFileChange = (e) => {
    const picked = e.target.files[0];
    setRestoreResult(null);
    setError('');
    if (!picked) {
      setFile(null);
      setFileName('');
      return;
    }
    setFileName(picked.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setFile(JSON.parse(reader.result));
      } catch {
        setFile(null);
        setError("That file isn't valid JSON - pick the .json file you exported from this page.");
      }
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(picked);
  };

  const onRestore = async () => {
    if (!file) return;
    setError('');
    setRestoring(true);
    try {
      const result = await api.restoreBackup(file);
      setRestoreResult(result);
      setRestoreConfirm('');
      setFile(null);
      setFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  };

  const onWipe = async () => {
    setError('');
    setWiping(true);
    try {
      const result = await api.wipeAllData();
      setWipeResult(result);
      setWipeConfirm('');
    } catch (err) {
      setError(err.message);
    } finally {
      setWiping(false);
    }
  };

  const onLogoutAfterWipe = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Backup &amp; Restore</h1>
      </div>
      <p className="muted mm-intro">Export everything before a risky change, restore it if something goes wrong, or wipe back to a clean slate.</p>

      {error && <p className="error">{error}</p>}

      <section className="card sx-card sx-safe">
        <div className="sx-card-head"><h2>Download a backup</h2><span className="status status-completed">Safe</span></div>
        <p className="muted sx-small" style={{ margin: 0 }}>
          One JSON file with every league, division, fixture, account, roll-of-honour entry and API key. Keep it somewhere safe -
          it's the only way back if a restore is ever needed.
        </p>
        <button className="btn btn-primary cs-btn-block" type="button" disabled={exporting} onClick={onExport}>
          {exporting ? 'Preparing…' : 'Download backup'}
        </button>
      </section>

      <section className="card sx-card sx-caution">
        <button type="button" className="dv-danger-toggle sx-caution-toggle" aria-expanded={restoreOpen} onClick={() => setRestoreOpen((o) => !o)}>
          <span>Restore from a backup</span>
          <span aria-hidden="true">{restoreOpen ? '−' : '+'}</span>
        </button>
        {restoreOpen && (
          <div className="sx-danger-body">
            <p className="muted sx-small" style={{ margin: 0 }}>
              Replaces <strong>everything</strong> in the system with the backup file. Anything created or changed since that export is
              lost - including your own account if it didn't exist then. This cannot be undone.
            </p>
            <label className="sx-file">
              <span>Backup file</span>
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onFileChange} />
            </label>
            {fileName && file && <p className="muted sx-small" style={{ margin: 0 }}>Selected: {fileName}</p>}
            <label className="dv-confirm">
              Type <strong>{RESTORE_CONFIRM_PHRASE}</strong> to confirm
              <input value={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.value)} autoComplete="off" />
            </label>
            {(!file || restoreConfirm.trim() !== RESTORE_CONFIRM_PHRASE) && (
              <p className="dv-hint">{!file ? 'Choose a backup file first.' : `The button unlocks once you type ${RESTORE_CONFIRM_PHRASE}.`}</p>
            )}
            <button
              className="btn btn-danger cs-btn-block"
              type="button"
              disabled={!file || restoreConfirm.trim() !== RESTORE_CONFIRM_PHRASE || restoring}
              onClick={onRestore}
            >
              {restoring ? 'Restoring…' : 'Restore from this file'}
            </button>
          </div>
        )}
        {restoreResult && (
          <div className="banner banner-success" style={{ margin: 0 }}>
            Restored {restoreResult.leagues} league(s), {restoreResult.users} user(s) and{' '}
            {restoreResult.fixtures} fixture(s). If your own account wasn't part of that backup,
            you'll need to log in again as an account that was.
          </div>
        )}
      </section>

      <section className="card sx-card dv-danger">
        <button type="button" className="dv-danger-toggle" aria-expanded={wipeOpen} onClick={() => setWipeOpen((o) => !o)}>
          <span>Wipe all data</span>
          <span aria-hidden="true">{wipeOpen ? '−' : '+'}</span>
        </button>
        {wipeOpen && (
          <div className="sx-danger-body">
            <p className="muted sx-small" style={{ margin: 0 }}>
              Deletes every league, division, fixture and account - back to an empty system. This cannot be undone, so download a
              backup first. Your own session stops working immediately; the standard recovery admin account a brand-new
              deployment gets is recreated automatically so you can log back in.
            </p>
            <label className="dv-confirm">
              Type <strong>{WIPE_CONFIRM_PHRASE}</strong> to confirm
              <input value={wipeConfirm} onChange={(e) => setWipeConfirm(e.target.value)} autoComplete="off" />
            </label>
            {wipeConfirm.trim() !== WIPE_CONFIRM_PHRASE && (
              <p className="dv-hint">The button unlocks once you type {WIPE_CONFIRM_PHRASE}.</p>
            )}
            <button
              className="btn btn-danger cs-btn-block"
              type="button"
              disabled={wipeConfirm.trim() !== WIPE_CONFIRM_PHRASE || wiping}
              onClick={onWipe}
            >
              {wiping ? 'Wiping…' : 'Wipe all data permanently'}
            </button>
          </div>
        )}
        {wipeResult && (
          <div className="banner banner-success" style={{ margin: 0 }}>
            <p style={{ margin: 0 }}>
              Everything has been wiped. Log back in as <strong>{wipeResult.bootstrapAdminEmail}</strong>{' '}
              using its normal password once you're done here.
            </p>
            <button className="btn" type="button" style={{ marginTop: 8 }} onClick={onLogoutAfterWipe}>
              Log out now
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
