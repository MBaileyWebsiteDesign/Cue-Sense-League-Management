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
    <div>
      <p><Link to="/admin">&larr; Admin Portal</Link></p>
      <h1>Backup &amp; Restore</h1>
      <p className="muted">
        Export a full copy of every league, division, fixture and account before a risky upgrade or
        migration. If anything goes wrong afterwards, restore that file to put everything back exactly
        as it was - or wipe the whole system back to a clean slate.
      </p>

      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Export</h2>
        <p className="muted">
          Downloads everything - leagues, divisions, fixtures, accounts, roll-of-honour history, API
          keys - as one JSON file. Keep it somewhere safe; it's the only way back if a restore is
          needed later.
        </p>
        <button className="btn btn-primary" type="button" disabled={exporting} onClick={onExport}>
          {exporting ? 'Preparing…' : 'Download backup'}
        </button>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Restore</h2>
        <p className="muted">
          Replaces <strong>everything</strong> currently in the system with the contents of a
          previously exported backup file. Anything created or changed since that export is lost -
          including your own account if it didn't exist at export time. This cannot be undone.
        </p>
        <label>
          Backup file
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onFileChange} />
        </label>
        {fileName && file && (
          <p className="muted" style={{ fontSize: '0.8rem' }}>Selected: {fileName}</p>
        )}
        <label>
          Type {RESTORE_CONFIRM_PHRASE} to confirm
          <input
            value={restoreConfirm}
            onChange={(e) => setRestoreConfirm(e.target.value)}
            placeholder={RESTORE_CONFIRM_PHRASE}
          />
        </label>
        <button
          className="btn btn-danger"
          type="button"
          disabled={!file || restoreConfirm.trim() !== RESTORE_CONFIRM_PHRASE || restoring}
          onClick={onRestore}
        >
          {restoring ? 'Restoring…' : 'Restore from this file'}
        </button>
        {restoreResult && (
          <div className="banner banner-success" style={{ marginTop: 12 }}>
            Restored {restoreResult.leagues} league(s), {restoreResult.users} user(s) and{' '}
            {restoreResult.fixtures} fixture(s). If your own account wasn't part of that backup,
            you'll need to log in again as an account that was.
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Wipe all data</h2>
        <p className="muted">
          Deletes every league, division, fixture and account, back to a completely empty system.
          This cannot be undone - export a backup first if there's any chance you'll want this data
          again. Your own admin session stops working immediately (your account is deleted along with
          everything else), so the standard <code>admin@cuesense.co.uk</code> recovery account -
          the same one a brand-new deployment gets - is recreated automatically to log back in with.
        </p>
        <label>
          Type {WIPE_CONFIRM_PHRASE} to confirm
          <input
            value={wipeConfirm}
            onChange={(e) => setWipeConfirm(e.target.value)}
            placeholder={WIPE_CONFIRM_PHRASE}
          />
        </label>
        <button
          className="btn btn-danger"
          type="button"
          disabled={wipeConfirm.trim() !== WIPE_CONFIRM_PHRASE || wiping}
          onClick={onWipe}
        >
          {wiping ? 'Wiping…' : 'Wipe all data permanently'}
        </button>
        {wipeResult && (
          <div className="banner banner-success" style={{ marginTop: 12 }}>
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
