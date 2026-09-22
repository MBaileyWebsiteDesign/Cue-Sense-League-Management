import { useState } from 'react';

// Shared, dependency-free stat visuals used by the player profile, standings
// and fixture pages (mobile redesign, 2026-09-22). Plain SVG/CSS only - this
// app has no charting library. Every chart also states its numbers in text,
// so nothing relies on colour alone.

// W / L / V chips, most recent first.
export function FormStrip({ form, label = 'Form', note = 'latest first' }) {
  if (!form || form.length === 0) return null;
  const names = { W: 'Win', L: 'Loss', V: 'Void' };
  return (
    <div className="cs-form">
      <span className="cs-form-label">{label}</span>
      <div className="cs-form-chips">
        {form.map((g, i) => (
          <span key={i} className={`cs-chip cs-chip-${g}`} aria-label={names[g] || g} title={names[g] || g}>{g}</span>
        ))}
      </div>
      {note && <span className="cs-form-note">{note}</span>}
    </div>
  );
}

// Two-part horizontal bar (e.g. frames won vs lost). Empty when both are 0.
export function SplitBar({ a, b, aClass = 'cs-fill-win', bClass = 'cs-fill-loss', label, height }) {
  const total = (a || 0) + (b || 0);
  const style = height ? { height } : undefined;
  if (total === 0) return <div className="cs-bar cs-bar-empty" style={style} role="img" aria-label={label || 'No data yet'} />;
  const pct = ((a || 0) / total) * 100;
  return (
    <div className="cs-bar" style={style} role="img" aria-label={label}>
      {a > 0 && <div className={aClass} style={{ width: `${pct}%` }} />}
      {b > 0 && <div className={bClass} style={{ flexGrow: 1 }} />}
    </div>
  );
}

// Circular win-rate ring with the percentage in the middle.
export function WinRing({ pct, size = 104, caption = 'WIN RATE' }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct || 0)) / 100 * c;
  return (
    <div className="cs-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Win rate ${pct} percent`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="cs-ring-track" strokeWidth="10" />
        {filled > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" className="cs-ring-fill" strokeWidth="10"
            strokeLinecap="round" strokeDasharray={`${filled} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="cs-ring-label">
        <span className="cs-ring-value">{pct}%</span>
        <span className="cs-ring-caption">{caption}</span>
      </div>
    </div>
  );
}

// Row of small stat tiles. Tiles with an `info` string become buttons that
// show the explanation underneath when tapped (hover tooltips don't work on
// phones).
export function StatTiles({ tiles }) {
  const [open, setOpen] = useState(null);
  const current = tiles.find((t) => t.key === open && t.info);
  return (
    <>
      <div className="cs-tiles">
        {tiles.map((t) => {
          const body = (
            <>
              <span className={`cs-tile-value${t.tone ? ` cs-tone-${t.tone}` : ''}`}>{t.value}</span>
              <span className="cs-tile-label">
                {t.label}
                {t.info && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
                  </svg>
                )}
              </span>
            </>
          );
          const cls = `cs-tile${t.tone ? ` cs-tile-${t.tone}` : ''}${open === t.key ? ' cs-tile-open' : ''}`;
          return t.info ? (
            <button
              key={t.key}
              type="button"
              className={cls}
              aria-expanded={open === t.key}
              aria-label={`${t.label} ${t.value}, tap for explanation`}
              onClick={() => setOpen(open === t.key ? null : t.key)}
            >
              {body}
            </button>
          ) : (
            <div key={t.key} className={cls}>{body}</div>
          );
        })}
      </div>
      {current && (
        <div className="cs-info">
          <strong>{current.infoTitle || current.label}</strong>
          <span>{current.info}</span>
        </div>
      )}
    </>
  );
}

// Big W / L / V badge used on result cards.
export function ResultBadge({ result, size }) {
  const g = result === 'win' ? 'W' : result === 'loss' ? 'L' : 'V';
  const names = { W: 'Win', L: 'Loss', V: 'Void' };
  return <span className={`cs-badge cs-chip-${g}`} style={size ? { width: size, height: size } : undefined} aria-label={names[g]}>{g}</span>;
}

export function Chevron() {
  return (
    <svg className="cs-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// Formats a "YYYY-MM-DD" fixture date for display; null when not set.
export function formatFixtureDate(d) {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
