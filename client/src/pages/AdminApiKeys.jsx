import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Admin-only management for StreamDeck / integration API keys - see
// server/src/userAuth.js's loadApiKeyUser for how a key authenticates.
// Every key is admin-equivalent (there's no tiered permission model here,
// same as an admin account itself - see requireAdmin's own comment), so
// treat a generated key with the same care as an admin password.
// Mobile layout 2026-09-23 - same API calls; revoking now asks to confirm.
export default function AdminApiKeys() {
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);
  const [copied, setCopied] = useState(false);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'API Keys' }]);

  const load = () => api.getApiKeys().then(setKeys).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    setError('');
    setCreating(true);
    setCopied(false);
    try {
      const result = await api.createApiKey(label.trim());
      setJustCreated(result);
      setLabel('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (k) => {
    if (!window.confirm(`Revoke "${k.label}"? Anything using this key will stop working straight away.`)) return;
    setError('');
    try {
      await api.deleteApiKey(k.id);
      if (justCreated && justCreated.id === k.id) setJustCreated(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(justCreated.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>API Keys</h1>
        <span className="muted au-total">{keys.length} active</span>
      </div>
      <div className="sx-warn">
        <strong>Treat a key like an admin password.</strong>
        <span>Each key is a permanent, admin-equivalent login for StreamDeck or other integrations - send it as the bearer token (Authorization header) on API calls such as starting a match timer or submitting a score.</span>
      </div>

      {error && <p className="error">{error}</p>}

      <form className="card sx-card" onSubmit={onCreate}>
        <h2>New key</h2>
        <label className="ll-field">
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. StreamDeck - Table 1"
            required
          />
        </label>
        <button className="btn btn-primary cs-btn-block" type="submit" disabled={!label.trim() || creating}>
          {creating ? 'Generating…' : 'Generate key'}
        </button>
      </form>

      {justCreated && (
        <div className="sx-newkey">
          <strong>{justCreated.label} created</strong>
          <span>Copy this key now - it won't be shown again.</span>
          <code className="sx-key">{justCreated.key}</code>
          <button type="button" className="btn btn-brand-green cs-btn-block" onClick={onCopy}>
            {copied ? 'Copied ✓' : 'Copy key'}
          </button>
        </div>
      )}

      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Active keys</h2>
          <span className="muted">{keys.length}</span>
        </div>
        {keys.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No API keys yet.</p>
        ) : (
          <ul className="mm-rows">
            {keys.map((k) => (
              <li key={k.id}>
                <span className="mm-row-main">
                  <strong>{k.label}</strong>
                  <span className="muted">
                    Created {new Date(k.createdAt).toLocaleDateString('en-GB')}
                    {' · last used '}{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}
                  </span>
                </span>
                <button type="button" className="btn btn-danger dv-small-btn" onClick={() => onRevoke(k)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
