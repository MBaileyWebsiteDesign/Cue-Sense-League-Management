import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { sortDivisionsPremierFirst } from '../divisionDisplay.js';
import { buildAssignment, initials, nextDivisionNames, shuffle } from '../autoDivisions.js';
import PoolTable from './PoolTable.jsx';
import './autoDivisions.css';

// "Automatically manage divisions" (Matt, 2026-11-20). Opened from the League page.
// 1) Setup: how many divisions (and, only if the league already has divisions, whether
//    to create new ones or use its existing empty ones), visual style, speed.
// 2) Draw: players are revealed one at a time - spinning wheel (default) or ball draw
//    (alternative for testing) - and dealt into balanced divisions, one division each.
// 3) Nothing is saved until "Save these divisions" is pressed (then new divisions are
//    created if needed and players are added with the existing bulk-assign endpoint,
//    so the payment-wall rules still apply). The draw can be redone as often as wanted.
//
// Who takes part: players with a pending league interest (or one added earlier but now in
// no division). If the league has an entry fee, only paid/waived players are drawn;
// the rest are listed as skipped.

const SPEEDS = { normal: { spin: 2800, hold: 900 }, fast: { spin: 900, hold: 300 } };
const TAU = Math.PI * 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WHEEL_COLOURS = ['#123d24', '#2f7d39'];
const WHEEL_GOLD = '#d9a62a';

function Wheel({ names, spinId, targetIdx, spinMs, onSettled }) {
  const canvasRef = useRef(null);
  const rotRef = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const draw = (rot) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const r = size / 2 - 6;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    const n = Math.max(names.length, 1);
    const seg = TAU / n;
    for (let i = 0; i < names.length; i += 1) {
      const a0 = rot + i * seg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a0, a0 + seg);
      ctx.closePath();
      const gold = n % 2 === 1 && i === n - 1;
      ctx.fillStyle = gold ? WHEEL_GOLD : WHEEL_COLOURS[i % 2];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const fontPx = Math.max(8, Math.min(17, r * seg * 0.42));
      if (r * seg * 0.55 >= 9) {
        ctx.save();
        ctx.rotate(a0 + seg / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
        ctx.fillStyle = gold ? '#1a1a1a' : '#fff';
        const label = names[i].length > 16 ? `${names[i].slice(0, 15)}…` : names[i];
        ctx.fillText(label, r - 12, 0);
        ctx.restore();
      }
    }
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, TAU);
    ctx.fillStyle = WHEEL_GOLD;
    ctx.fill();
    ctx.strokeStyle = '#a67d1f';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  };

  useEffect(() => {
    draw(rotRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names]);

  useEffect(() => {
    if (spinId == null || targetIdx == null || names.length === 0) return undefined;
    const seg = TAU / names.length;
    const jitter = (Math.random() - 0.5) * 0.6 * seg;
    const wanted = -Math.PI / 2 - (targetIdx + 0.5) * seg + jitter;
    const from = rotRef.current;
    const delta = ((((wanted - from) % TAU) + TAU) % TAU) + (4 + Math.floor(Math.random() * 2)) * TAU;
    const to = from + delta;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / spinMs);
      const eased = 1 - (1 - p) ** 3;
      rotRef.current = from + (to - from) * eased;
      draw(rotRef.current);
      if (p < 1) raf = requestAnimationFrame(tick);
      else settledRef.current();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);

  return (
    <div className="ad-wheel-wrap">
      <div className="ad-pointer" aria-hidden="true" />
      <canvas ref={canvasRef} width={640} height={640} className="ad-wheel" role="img" aria-label="Wheel of players" />
    </div>
  );
}

function BallRack({ remaining, spinId, targetId, spinMs, onSettled }) {
  const [lit, setLit] = useState(null);
  const [picked, setPicked] = useState(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const remainingRef = useRef(remaining);
  remainingRef.current = remaining;

  useEffect(() => {
    if (spinId == null || !targetId) return undefined;
    setPicked(null);
    const flickerFor = Math.max(300, spinMs - 500);
    const t0 = Date.now();
    const timer = setInterval(() => {
      const list = remainingRef.current;
      if (list.length) setLit(list[Math.floor(Math.random() * list.length)].id);
      if (Date.now() - t0 >= flickerFor) {
        clearInterval(timer);
        setLit(null);
        setPicked(targetId);
        setTimeout(() => settledRef.current(), 450);
      }
    }, 90);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);

  return (
    <div className="ad-rack" aria-label="Rack of player balls">
      {remaining.map((p) => (
        <span
          key={p.id}
          className={`ad-ball ${lit === p.id ? 'ad-ball-lit' : ''} ${picked === p.id ? 'ad-ball-picked' : ''}`}
          title={p.name}
        >
          {initials(p.name)}
        </span>
      ))}
    </div>
  );
}

export default function AutoDivisionsWizard({ league, onClose, onSaved }) {
  const [step, setStep] = useState('loading'); // loading | setup | draw | saving | saved
  const [error, setError] = useState('');
  const [interests, setInterests] = useState([]);
  const [divisionCount, setDivisionCount] = useState('2');
  const [mode, setMode] = useState('new'); // new | existing
  const [visual, setVisual] = useState('wheel'); // wheel | balls | pool
  const [speed, setSpeed] = useState('normal');

  const [plan, setPlan] = useState(null); // { assignment, labels, targets }
  const [revealed, setRevealed] = useState([]);
  const [drawing, setDrawing] = useState(false);
  const [spin, setSpin] = useState({ id: null, idx: null, targetId: null });
  const [landed, setLanded] = useState(null);
  const [runId, setRunId] = useState(0);
  const [saveReport, setSaveReport] = useState(null);

  const settledRef = useRef(null);
  const skipRef = useRef(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const visualRef = useRef(visual);
  visualRef.current = visual;

  const paywall = !!league.payment?.required;
  const hasDivisions = (league.divisions || []).length > 0;
  const emptyExisting = sortDivisionsPremierFirst(
    (league.divisions || []).filter(
      (d) => d.entryType === 'singles' && !d.fixturesGenerated && (d.playerIds || []).length === 0,
    ),
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getLeagueInterests(league.id)
      .then((rows) => {
        if (cancelled) return;
        setInterests(rows || []);
        setStep('setup');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message);
        setStep('setup');
      });
    return () => {
      cancelled = true;
    };
  }, [league.id]);

  const isCleared = (r) => !paywall || ['confirmed', 'waived'].includes(r.paymentStatus);
  const isOpenInterest = (r) => r.status === 'pending' || (r.status === 'assigned' && !r.inDivision);
  const eligible = interests.filter((r) => isOpenInterest(r) && isCleared(r));
  const skippedUnpaid = interests.filter((r) => isOpenInterest(r) && !isCleared(r)).length;
  const alreadyPlaced = interests.filter((r) => r.status === 'assigned' && r.inDivision).length;
  const nameById = Object.fromEntries(interests.map((r) => [r.id, r.playerName]));

  const countNum = Number(divisionCount);
  const countOk = Number.isInteger(countNum) && countNum >= 1 && countNum <= eligible.length;
  const existingOk = emptyExisting.length >= countNum;

  const startDraw = () => {
    setError('');
    if (!countOk) {
      setError(`Enter a whole number of divisions between 1 and ${eligible.length}.`);
      return;
    }
    const useExisting = hasDivisions && mode === 'existing';
    if (useExisting && !existingOk) {
      setError(`Only ${emptyExisting.length} existing division(s) are empty and open - choose fewer divisions or create new ones.`);
      return;
    }
    const targets = useExisting ? emptyExisting.slice(0, countNum) : null;
    const labels = useExisting
      ? targets.map((d) => d.name)
      : nextDivisionNames((league.divisions || []).map((d) => d.name), countNum);
    const assignment = buildAssignment(eligible.map((r) => r.id), countNum);
    skipRef.current = false;
    setPlan({ assignment, labels, targets });
    setRevealed([]);
    setLanded(null);
    setSpin({ id: null, idx: null, targetId: null });
    setDrawing(true);
    setRunId((x) => x + 1);
    setStep('draw');
  };

  // The reveal loop. One pass per runId; ends with drawing=false and everyone revealed.
  useEffect(() => {
    if (step !== 'draw' || !plan || !drawing) return undefined;
    let cancelled = false;
    const sortedIds = eligible
      .map((r) => r.id)
      .sort((a, b) => (nameById[a] || '').localeCompare(nameById[b] || ''));
    (async () => {
      const done = [];
      const pottedIds = [];
      for (let i = 0; i < plan.assignment.length; i += 1) {
        if (cancelled || skipRef.current) break;
        const item = plan.assignment[i];
        const remainingIds = sortedIds.filter((id) => !done.includes(id));
        const idx = remainingIds.indexOf(item.id);
        const timing = SPEEDS[speedRef.current] || SPEEDS.normal;
        setLanded(null);
        // Pool table: the table decides who is potted next; the division comes from the rotation.
        const free = visualRef.current === 'pool';
        const potted = await new Promise((resolve) => {
          settledRef.current = resolve;
          setSpin({ id: `${runId}-${i}`, idx, targetId: free ? null : item.id, nextId: null });
        });
        if (cancelled || skipRef.current) break;
        if (free && potted) {
          plan.assignment[i] = { id: potted, divisionIndex: item.divisionIndex };
          pottedIds.push(potted);
        }
        const cur = plan.assignment[i];
        setLanded({ name: nameById[cur.id], division: plan.labels[cur.divisionIndex] });
        await sleep(timing.hold * 0.6);
        if (cancelled || skipRef.current) break;
        done.push(cur.id);
        setRevealed([...done].map((id) => plan.assignment.find((a) => a.id === id)));
        await sleep(timing.hold * 0.4);
      }
      if (cancelled) return;
      if (visualRef.current === 'pool' && pottedIds.length < plan.assignment.length) {
        // Skipped part-way: deal the players not yet potted into the remaining slots.
        const left = shuffle(eligible.map((r) => r.id).filter((id) => !pottedIds.includes(id)));
        for (let j = pottedIds.length; j < plan.assignment.length; j += 1) {
          plan.assignment[j] = { id: left.shift(), divisionIndex: plan.assignment[j].divisionIndex };
        }
      }
      setRevealed(plan.assignment);
      setLanded(null);
      setDrawing(false);
    })();
    return () => {
      cancelled = true;
      if (settledRef.current) settledRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const skip = () => {
    skipRef.current = true;
    if (settledRef.current) settledRef.current();
  };

  const save = async () => {
    if (!plan) return;
    setStep('saving');
    setError('');
    const report = { created: [], added: 0, failures: [] };
    try {
      let targetIds;
      if (plan.targets) {
        targetIds = plan.targets.map((d) => d.id);
      } else {
        const base = sortDivisionsPremierFirst(
          (league.divisions || []).filter((d) => d.entryType === 'singles' && String(d.scheduling || '').startsWith('round_robin')),
        )[0];
        targetIds = [];
        for (let i = 0; i < plan.labels.length; i += 1) {
          const created = await api.createDivision(league.id, {
            name: plan.labels[i],
            order: (league.divisions || []).length + i,
            entryType: 'singles',
            scheduling: base?.scheduling || 'round_robin_single',
            raceTo: base?.raceTo || 6,
          });
          targetIds.push(created.id);
          report.created.push(created.name);
        }
      }
      for (let d = 0; d < targetIds.length; d += 1) {
        const ids = plan.assignment.filter((a) => a.divisionIndex === d).map((a) => a.id);
        if (ids.length === 0) continue;
        const res = await api.bulkAssignLeagueInterests(ids, targetIds[d]);
        const results = res?.results || [];
        report.added += results.filter((r) => r.ok).length;
        results.filter((r) => !r.ok).forEach((r) => report.failures.push(`${nameById[r.interestId] || 'A player'}: ${r.error}`));
      }
      setSaveReport(report);
      setStep('saved');
      if (onSaved) onSaved();
    } catch (err) {
      setSaveReport(report);
      setError(`${err.message}${report.created.length ? ` (Divisions already created: ${report.created.join(', ')} - check the league page before trying again.)` : ''}`);
      setStep('draw');
    }
  };

  const revealedIds = new Set(revealed.map((a) => a.id));
  const remainingPlayers = eligible
    .filter((r) => !revealedIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.playerName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const columns = (plan ? plan.labels : []).map((label, d) => ({
    label,
    ids: revealed.filter((a) => a.divisionIndex === d).map((a) => a.id),
  }));
  const timing = SPEEDS[speed] || SPEEDS.normal;
  const lastRevealedId = revealed.length ? revealed[revealed.length - 1].id : null;

  return (
    <div className="ad-overlay" role="dialog" aria-modal="true" aria-label="Automatically manage divisions">
      <div className="ad-modal">
        <header className="ad-head">
          <h2>Automatically manage divisions</h2>
          <button type="button" className="ad-x" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        {error && <p className="error">{error}</p>}

        {step === 'loading' && <p className="muted">Loading registered players…</p>}

        {step === 'setup' && (
          <div className="ad-body">
            <p className="ad-count">
              <strong>{eligible.length}</strong> registered player{eligible.length === 1 ? '' : 's'} ready to be placed in {league.name}.
            </p>
            {(skippedUnpaid > 0 || alreadyPlaced > 0) && (
              <p className="muted ad-note">
                {skippedUnpaid > 0 && `${skippedUnpaid} unpaid player${skippedUnpaid === 1 ? ' is' : 's are'} left out (mark them paid or waived on the Interests page first). `}
                {alreadyPlaced > 0 && `${alreadyPlaced} already in a division and not included.`}
              </p>
            )}
            {eligible.length < 2 ? (
              <p className="muted">There need to be at least 2 players ready before a draw can run.</p>
            ) : (
              <>
                <label className="ad-field">
                  How many divisions are required?
                  <input
                    type="number"
                    min="1"
                    max={eligible.length}
                    value={divisionCount}
                    onChange={(e) => setDivisionCount(e.target.value)}
                    inputMode="numeric"
                  />
                  {countOk && (
                    <span className="muted ad-note">
                      About {Math.floor(eligible.length / countNum)}
                      {eligible.length % countNum ? `-${Math.floor(eligible.length / countNum) + 1}` : ''} players per division.
                    </span>
                  )}
                </label>

                {hasDivisions && (
                  <fieldset className="ad-field ad-choices">
                    <legend>This league already has {league.divisions.length} division{league.divisions.length === 1 ? '' : 's'}. What should happen?</legend>
                    <label className="ad-choice">
                      <input type="radio" name="ad-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
                      <span><strong>Create new divisions</strong><br /><span className="muted">Existing divisions are left alone.</span></span>
                    </label>
                    <label className={`ad-choice ${!existingOk ? 'ad-choice-off' : ''}`}>
                      <input type="radio" name="ad-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={!existingOk} />
                      <span>
                        <strong>Use existing empty divisions</strong><br />
                        <span className="muted">
                          {emptyExisting.length} empty singles division{emptyExisting.length === 1 ? '' : 's'} available
                          {countOk && !existingOk ? ` - not enough for ${countNum}` : ''}.
                        </span>
                      </span>
                    </label>
                  </fieldset>
                )}

                <fieldset className="ad-field ad-choices">
                  <legend>Draw style</legend>
                  <label className="ad-choice">
                    <input type="radio" name="ad-visual" checked={visual === 'wheel'} onChange={() => setVisual('wheel')} />
                    <span><strong>Spinning wheel</strong><br /><span className="muted">A wheel of names spins and picks one player at a time.</span></span>
                  </label>
                  <label className="ad-choice">
                    <input type="radio" name="ad-visual" checked={visual === 'balls'} onChange={() => setVisual('balls')} />
                    <span><strong>Ball draw (option B)</strong><br /><span className="muted">Player balls in a rack - one is drawn and drops into its division.</span></span>
                  </label>
                  <label className="ad-choice">
                    <input type="radio" name="ad-visual" checked={visual === 'pool'} onChange={() => setVisual('pool')} />
                    <span><strong>Pool table (option C)</strong><br /><span className="muted">A cue pots one player's ball at a time - the full name shows above the table.</span></span>
                  </label>
                </fieldset>

                <fieldset className="ad-field ad-choices ad-inline">
                  <legend>Speed</legend>
                  <label className="ad-choice"><input type="radio" name="ad-speed" checked={speed === 'normal'} onChange={() => setSpeed('normal')} /> Normal</label>
                  <label className="ad-choice"><input type="radio" name="ad-speed" checked={speed === 'fast'} onChange={() => setSpeed('fast')} /> Fast</label>
                </fieldset>

                <p className="muted ad-note">Each player goes into exactly one division and the divisions are kept as even as possible. Nothing is saved until you confirm at the end.</p>
                <div className="ad-actions">
                  <button type="button" className="btn" onClick={onClose}>Cancel</button>
                  <button type="button" className="btn btn-primary" onClick={startDraw}>Start the draw</button>
                </div>
              </>
            )}
          </div>
        )}

        {(step === 'draw' || step === 'saving') && plan && (
          <div className="ad-body">
            <div className="ad-stage">
              {drawing ? (
                visual === 'wheel' ? (
                  <Wheel
                    names={remainingPlayers.map((p) => p.name)}
                    spinId={spin.id}
                    targetIdx={spin.idx}
                    spinMs={timing.spin}
                    onSettled={() => settledRef.current && settledRef.current()}
                  />
                ) : visual === 'pool' ? (
                  <PoolTable
                    remaining={remainingPlayers}
                    spinId={spin.id}
                    targetId={spin.targetId}
                    spinMs={timing.spin}
                    landed={landed}
                    onSettled={(id) => settledRef.current && settledRef.current(id)}
                  />
                ) : (
                  <BallRack
                    remaining={remainingPlayers}
                    spinId={spin.id}
                    targetId={spin.targetId}
                    spinMs={timing.spin}
                    onSettled={() => settledRef.current && settledRef.current()}
                  />
                )
              ) : (
                <p className="ad-done">Draw complete - {plan.assignment.length} players placed.</p>
              )}
              <div className="ad-caption" aria-live="polite">
                {drawing && landed && visual !== 'pool' ? (
                  <>
                    <strong>{landed.name}</strong> <span aria-hidden="true">&rarr;</span> <span className="ad-caption-div">{landed.division}</span>
                  </>
                ) : drawing ? (
                  <span className="muted">Drawing… {revealed.length} of {plan.assignment.length}</span>
                ) : null}
              </div>
            </div>

            <div className="ad-cols">
              {columns.map((c) => (
                <div className="ad-col" key={c.label}>
                  <h3>{c.label} <span className="ad-col-count">{c.ids.length}</span></h3>
                  <ul>
                    {c.ids.map((id) => (
                      <li key={id} className={id === lastRevealedId && drawing ? 'ad-pop' : ''}>{nameById[id]}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="ad-actions">
              {drawing ? (
                <button type="button" className="btn" onClick={skip}>Skip to result</button>
              ) : (
                <>
                  <button type="button" className="btn" onClick={onClose} disabled={step === 'saving'}>Cancel</button>
                  <button type="button" className="btn" onClick={startDraw} disabled={step === 'saving'}>Draw again</button>
                  <button type="button" className="btn btn-primary" onClick={save} disabled={step === 'saving'}>
                    {step === 'saving' ? 'Saving…' : 'Save these divisions'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {step === 'saved' && saveReport && (
          <div className="ad-body">
            <p className="ad-count">
              <strong>{saveReport.added}</strong> player{saveReport.added === 1 ? '' : 's'} placed
              {saveReport.created.length ? ` in ${saveReport.created.length} new division${saveReport.created.length === 1 ? '' : 's'} (${saveReport.created.join(', ')})` : ' in the chosen divisions'}.
            </p>
            {saveReport.failures.length > 0 && (
              <div className="error">
                <p>Some players could not be added:</p>
                <ul>{saveReport.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )}
            <div className="ad-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
