import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Admin-only management for StreamDeck / integration API keys - see
// server/src/userAuth.js's loadApiKeyUser for how a key authenticates.
// Every key is admin-equivalent (there's no tiered permission model here,
// same as an admin account itself - see requireAdmin's own comment), so
// treat a generated key with the same care as an admin password.
export default function AdminApiKeys() {
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

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

  const onRevoke = async (id) => {
    setError('');
    try {
      await api.deleteApiKey(id);
      if (justCreated && justCreated.id === id) setJustCreated(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <p><Link to="/admin">&larr; Admin Portal</Link></p>
      <h1>API Keys</h1>
      <p className="muted">
        For StreamDeck or other unattended integrations - a key acts as a permanent,
        admin-equivalent login. Set it as the bearer token/Authorization header on any
        API call (e.g. starting a match timer or shot clock, submitting a score).
      </p>

      {error && <p className="error">{error}</p>}

      <form className="card form" onSubmit={onCreate}>
        <label>
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. StreamDeck - Table 1"
            required
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!label.trim() || creating}>
          {creating ? 'Generating…' : 'Generate Key'}
        </button>
      </form>

      {justCreated && (
        <div className="banner banner-success" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>{justCreated.label}</strong> created. Copy this key now - it won't be shown again:
          </p>
          <code style={{ display: 'block', marginTop: 8, wordBreak: 'break-all', userSelect: 'all' }}>
            {justCreated.key}
          </code>
        </div>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Active Keys</h2>
        {keys.length === 0 ? (
          <p className="muted">No API keys yet.</p>
        ) : (
          <ul className="player-list">
            {keys.map((k) => (
              <li key={k.id}>
                <span>
                  {k.label}
                  <span className="muted">
                    {' · created '}{new Date(k.createdAt).toLocaleDateString()}
                    {' · last used '}{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}
                  </span>
                </span>
                <button className="btn-link" onClick={() => onRevoke(k.id)}>revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
