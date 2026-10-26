import { useState } from 'react';
import { api } from '../api.js';

// Table counts for a venue (Matt, 2026-10-26). Shared by the Venue Manager
// Portal and Venue Management (admin). The server is the source of truth for
// who may change it and for the limits (whole numbers, 0-100).
export const VENUE_TABLE_TYPES = [
  { key: 'english', label: 'English pool' },
  { key: 'chinese8', label: 'Chinese 8 ball' },
  { key: 'american', label: 'American pool' },
  { key: 'snooker', label: 'Snooker' },
];

function toForm(counts) {
  const c = counts || {};
  const out = {};
  for (const t of VENUE_TABLE_TYPES) out[t.key] = String(Number.isInteger(c[t.key]) ? c[t.key] : 0);
  return out;
}

export default function VenueTableCounts({ venueId, counts, onSaved }) {
  const [saved, setSaved] = useState(toForm(counts));
  const [form, setForm] = useState(toForm(counts));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const dirty = VENUE_TABLE_TYPES.some((t) => form[t.key] !== saved[t.key]);

  const save = async () => {
    setError('');
    setNotice('');
    const body = {};
    for (const t of VENUE_TABLE_TYPES) {
      const raw = String(form[t.key]).trim();
      if (!/^\d+$/.test(raw) || Number(raw) > 100) {
        setError(`${t.label} must be a whole number from 0 to 100.`);
        return;
      }
      body[t.key] = Number(raw);
    }
    setSaving(true);
    try {
      const r = await api.setVenueTableCounts(venueId, body);
      const next = toForm(r.tableCounts);
      setSaved(next);
      setForm(next);
      setNotice('Tables saved.');
      if (onSaved) onSaved(r.tableCounts);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="muted vm-small" style={{ margin: '0 0 10px' }}>How many tables of each type this venue has.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {VENUE_TABLE_TYPES.map((t) => (
          <label key={t.key} className="ll-field">
            {t.label}
            <input
              className="mm-input"
              type="number"
              inputMode="numeric"
              min="0"
              max="100"
              step="1"
              value={form[t.key]}
              disabled={saving}
              onChange={(e) => { setForm((f) => ({ ...f, [t.key]: e.target.value })); setNotice(''); }}
            />
          </label>
        ))}
      </div>
      <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving || !dirty} onClick={save}>
        {saving ? 'Saving…' : 'Save tables'}
      </button>
      {error && <p className="error">{error}</p>}
      {notice && <p className="banner banner-success">{notice}</p>}
    </div>
  );
}
