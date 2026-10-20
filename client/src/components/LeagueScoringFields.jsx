// League scoring form fields - shared by the New League form (LeagueList.jsx)
// and the Scoring panel on the League page (LeagueDetail.jsx). Every division
// in the league uses these. See server/src/services/standings.js.
// Values are kept as strings while typing and converted by scoringFormToPayload.

export const DEFAULT_SCORING_FORM = {
  win: '3',
  draw: '2',
  loss: '0',
  framesToPoints: false,
  bndPoints: '0',
  rndPoints: '0',
};

export function scoringToForm(s) {
  const src = s || {};
  const str = (v, d) => (v === undefined || v === null ? d : String(v));
  return {
    win: str(src.win, '3'),
    draw: str(src.draw, '2'),
    loss: str(src.loss, '0'),
    framesToPoints: !!src.framesToPoints,
    bndPoints: str(src.bndPoints, '0'),
    rndPoints: str(src.rndPoints, '0'),
  };
}

const LABELS = {
  win: 'Win points',
  draw: 'Draw points',
  loss: 'Loss points',
  bndPoints: 'BND points',
  rndPoints: 'RND points',
};

// Returns an error message, or '' when every box holds a number from 0 to 100.
export function validateScoringForm(form) {
  for (const key of Object.keys(LABELS)) {
    const raw = String(form[key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) {
      return `${LABELS[key]} must be a number from 0 to 100`;
    }
  }
  return '';
}

export function scoringFormToPayload(form) {
  return {
    win: Number(form.win),
    draw: Number(form.draw),
    loss: Number(form.loss),
    framesToPoints: !!form.framesToPoints,
    bndPoints: Number(form.bndPoints),
    rndPoints: Number(form.rndPoints),
  };
}

// One-line summary of saved scoring, e.g. "Win 3 · Draw 2 · Loss 0 · frames won added · BND +1".
export function scoringSummary(s) {
  if (!s) return '';
  const parts = [`Win ${s.win}`, `Draw ${s.draw}`, `Loss ${s.loss}`];
  parts.push(s.framesToPoints ? 'frames won added to points' : 'frames not added');
  if (Number(s.bndPoints)) parts.push(`BND +${s.bndPoints} per frame`);
  if (Number(s.rndPoints)) parts.push(`RND +${s.rndPoints} per frame`);
  return parts.join(' · ');
}

export default function LeagueScoringFields({ value, onChange, fieldClass = '' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const num = (key) => (
    <label className={fieldClass}>
      {LABELS[key]}
      <input
        type="number"
        min="0"
        max="100"
        step="any"
        inputMode="decimal"
        value={value[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        required
      />
    </label>
  );

  const win = Number(value.win);
  const loss = Number(value.loss);
  const exampleOk = Number.isFinite(win) && Number.isFinite(loss);
  const winner = exampleOk ? win + (value.framesToPoints ? 2 : 0) : null;
  const loser = exampleOk ? loss + (value.framesToPoints ? 1 : 0) : null;

  return (
    <div className="league-scoring-fields">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {num('win')}
        {num('draw')}
        {num('loss')}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={!!value.framesToPoints}
          onChange={(e) => set({ framesToPoints: e.target.checked })}
        />
        Add frames won to the points total
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
        {num('bndPoints')}
        {num('rndPoints')}
      </div>
      <span className="muted" style={{ display: 'block', fontSize: '0.8rem', marginTop: 6 }}>
        BND = Break and Dish, RND = Reverse Break and Dish. These are extra points for each <em>frame</em> won that way
        (not for winning the match). Leave at 0 for no bonus.
        {exampleOk && (
          <>
            {' '}Example: a 2-1 win gives the winner {winner} and the loser {loser}.
          </>
        )}
      </span>
    </div>
  );
}
