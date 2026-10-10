import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import './scanScoreCard.css';

// Phone photos are often 5-12MB; the card only needs to stay legible, so it's
// shrunk to a JPEG with a 1600px long edge before upload.
const MAX_EDGE = 1600;

async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not open that photo'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not prepare that photo');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readBox(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { kind: 'blank' };
  if (s === '?') return { kind: 'unclear' };
  if (/^\d+$/.test(s)) return { kind: 'num', n: Number(s) };
  return { kind: 'mark' };
}

// Turns the two rows of boxes into an ordered list of frame winners.
// ASSUMPTION (to be confirmed against real cards): each column is one frame,
// and the box of whoever won that frame holds their new running score (or a
// tick/mark), so the winner of a column is the row whose box moved up.
// Anything that doesn't fit is reported as an issue and blocks confirming,
// rather than being guessed at.
export function deriveFrames(homeBoxes, awayBoxes, raceTo) {
  const issues = [];
  const frames = [];
  let home = 0;
  let away = 0;
  let sawEmptyColumn = false;
  const cols = Math.max(homeBoxes.length, awayBoxes.length);
  for (let i = 0; i < cols; i += 1) {
    const col = i + 1;
    const h = readBox(homeBoxes[i]);
    const a = readBox(awayBoxes[i]);
    if (h.kind === 'unclear' || a.kind === 'unclear') {
      issues.push(`Box ${col} is marked "?" - type what is on the card`);
      continue;
    }
    const homeUp = h.kind === 'mark' || (h.kind === 'num' && h.n > home);
    const awayUp = a.kind === 'mark' || (a.kind === 'num' && a.n > away);
    if (h.kind === 'blank' && a.kind === 'blank') {
      sawEmptyColumn = true;
      continue;
    }
    if (homeUp && awayUp) {
      issues.push(`Frame ${col}: both rows show a new score`);
      continue;
    }
    if (!homeUp && !awayUp) {
      issues.push(`Frame ${col}: neither row shows a new score`);
      continue;
    }
    if (sawEmptyColumn) issues.push(`Frame ${col} has a score after an empty column`);
    if (home >= raceTo || away >= raceTo) {
      issues.push(`Frame ${col} comes after a player already reached ${raceTo}`);
      continue;
    }
    if (homeUp) {
      if (h.kind === 'num' && h.n !== home + 1) issues.push(`Frame ${col}: top row jumps from ${home} to ${h.n}`);
      home = h.kind === 'num' ? h.n : home + 1;
      frames.push('home');
    } else {
      if (a.kind === 'num' && a.n !== away + 1) issues.push(`Frame ${col}: bottom row jumps from ${away} to ${a.n}`);
      away = a.kind === 'num' ? a.n : away + 1;
      frames.push('away');
    }
  }
  if (frames.length === 0) issues.push('No frames could be read from the card');
  else if (home < raceTo && away < raceTo) issues.push(`Nobody reaches ${raceTo} on this card`);
  return { frames, issues, homeTotal: home, awayTotal: away };
}

export default function ScanScoreCard({ fixture, homeName, awayName, onApplied }) {
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const topRef = useRef(null);

  // Arriving from the Player Portal's "Scan score card" button (?scan=1):
  // bring the panel into view rather than leaving it below the scoreboard.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('scan') && topRef.current) {
      topRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);
  const [stage, setStage] = useState('idle'); // idle | scanning | review | saving
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [scan, setScan] = useState(null);
  // Boxes stay in the order they appear on the card (top row, bottom row);
  // `swapped` says whether the top row belongs to the away side instead.
  const [grid, setGrid] = useState({ top: [], bottom: [] });
  const [swapped, setSwapped] = useState(false);

  const raceTo = fixture.raceTo;
  const maxBoxes = raceTo * 2 - 1;

  const reset = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setScan(null);
    setSwapped(false);
    setStage('idle');
  };

  const onPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setStage('scanning');
    try {
      const blob = await shrinkPhoto(file);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(blob));
      const result = await api.scanScoreCard(fixture.id, blob, homeName, awayName);
      const pad = (boxes) => Array.from({ length: maxBoxes }, (_, i) => boxes[i] ?? '');
      setScan(result);
      setGrid({ top: pad(result.rows[0].boxes), bottom: pad(result.rows[1].boxes) });
      setSwapped(false);
      setStage('review');
    } catch (err) {
      setError(err.message);
      setStage('idle');
    }
  };

  const setBox = (rowKey, index, value) => {
    setGrid((g) => ({ ...g, [rowKey]: g[rowKey].map((v, i) => (i === index ? value.trim().slice(0, 2) : v)) }));
  };

  const homeKey = swapped ? 'bottom' : 'top';
  const awayKey = swapped ? 'top' : 'bottom';
  const derived = stage === 'review' || stage === 'saving' ? deriveFrames(grid[homeKey], grid[awayKey], raceTo) : null;

  const apply = async () => {
    setError('');
    setStage('saving');
    try {
      await api.applyScoreCard(fixture.id, derived.frames);
      reset();
      onApplied();
    } catch (err) {
      setError(err.message);
      setStage('review');
    }
  };

  if (stage === 'idle' || stage === 'scanning') {
    return (
      <section className="card sc-card" ref={topRef}>
        <div className="cs-card-head"><h2>Scan score card</h2></div>
        <p className="muted sc-lead">
          Played on paper? Photograph the card and check the digital version before anything is recorded.
        </p>
        {error && <p className="sc-error" role="alert">{error}</p>}
        {stage === 'scanning' ? (
          <p className="sc-busy">Reading the card&hellip;</p>
        ) : (
          <div className="sc-actions">
            <button type="button" className="btn btn-primary" onClick={() => cameraRef.current?.click()}>Take photo</button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Choose photo</button>
          </div>
        )}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPhoto} />
      </section>
    );
  }

  const rowDefs = [
    { key: homeKey, side: 'home', label: homeName, cardName: scan.rows[swapped ? 1 : 0].name },
    { key: awayKey, side: 'away', label: awayName, cardName: scan.rows[swapped ? 0 : 1].name },
  ];
  // Keep the rows in card order on screen so they line up with the photo.
  const ordered = swapped ? [rowDefs[1], rowDefs[0]] : rowDefs;
  const canConfirm = derived.issues.length === 0 && stage !== 'saving';

  return (
    <section className="card sc-card">
      <div className="cs-card-head">
        <h2>Check the score card</h2>
        <button type="button" className="cs-link-btn" disabled={stage === 'saving'} onClick={reset}>Cancel</button>
      </div>
      {preview && <img className="sc-photo" src={preview} alt="The photographed score card" />}
      <p className="sc-lead muted">
        Compare each box with the photo and correct anything that is wrong. Nothing is recorded until you confirm.
      </p>
      {scan.notes && <p className="sc-note">The scan noted: {scan.notes}</p>}
      {error && <p className="sc-error" role="alert">{error}</p>}

      {ordered.map((r) => (
        <div key={r.side} className={`sc-row sc-row-${r.side}`}>
          <div className="sc-rowhead">
            <strong>{r.label}</strong>
            <span className="muted sc-small">{r.cardName ? `Card says: ${r.cardName}` : 'No name read'}</span>
          </div>
          <div className="sc-boxes" style={{ gridTemplateColumns: `repeat(${maxBoxes}, minmax(0, 1fr))` }}>
            {grid[r.key].map((v, i) => (
              <input
                key={i}
                className="sc-box"
                value={v}
                inputMode="numeric"
                maxLength={2}
                aria-label={`${r.label}, box ${i + 1}`}
                onChange={(e) => setBox(r.key, i, e.target.value)}
              />
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="cs-link-btn" onClick={() => setSwapped((s) => !s)}>
        Players the wrong way round? Swap them
      </button>

      <div className="sc-total" aria-live="polite">
        <span>{homeName}</span>
        <strong>{derived.homeTotal} &ndash; {derived.awayTotal}</strong>
        <span>{awayName}</span>
      </div>
      {derived.frames.length > 0 && (
        <div className="sc-order" aria-label="Frame winners in order">
          {derived.frames.map((w, i) => (
            <span key={i} className={`sc-sq sc-sq-${w}`} title={`Frame ${i + 1}: ${w === 'home' ? homeName : awayName}`}>{i + 1}</span>
          ))}
        </div>
      )}
      {derived.issues.length > 0 && (
        <ul className="sc-issues">
          {derived.issues.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      <button type="button" className="btn btn-primary sc-confirm" disabled={!canConfirm} onClick={apply}>
        {stage === 'saving' ? 'Recording\u2026' : 'Confirm card and record frames'}
      </button>
      <p className="muted sc-small">You will still press Submit afterwards, and both players confirm as usual.</p>
    </section>
  );
}
