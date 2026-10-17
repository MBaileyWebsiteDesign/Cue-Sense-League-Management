import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import './serverPerformance.css';

// Admin > Server Performance: is the Fly.io machine this app runs on short of
// memory, CPU or disk? Readings come from inside the machine (see
// server/src/routes/serverPerformance.js) - one a minute while the app is
// running, kept for 7 days - so this page needs no Fly.io login or token.

const RANGES = [
  { key: '1h', label: '1 hour' },
  { key: '6h', label: '6 hours' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

const LEVEL_LABEL = { ok: 'Fine', watch: 'Watch', increase: 'Increase', collecting: 'Collecting data' };
const LEVEL_PILL = { ok: 'status-completed', watch: 'status-in_progress', increase: 'status-disputed', collecting: '' };

const mbText = (mb) => (mb === null || mb === undefined ? '–' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const pctText = (v) => (v === null || v === undefined ? '–' : `${v}%`);
const msText = (v) => (v === null || v === undefined ? '–' : `${v} ms`);

function durationText(sec) {
  if (sec === null || sec === undefined) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const timeText = (t, withDay) =>
  new Date(t).toLocaleString('en-GB', withDay ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

function LevelPill({ level }) {
  return <span className={`status ${LEVEL_PILL[level] || ''}`}>{LEVEL_LABEL[level] || level}</span>;
}

// A dependency-free SVG line chart. Lines break where there are no readings
// (the machine can be stopped while idle), so gaps show as gaps.
function LineChart({ title, points, lines, rangeMs, nowMs, yMax, unit, guides, sampleSeconds }) {
  const W = 600;
  const H = 150;
  const start = nowMs - rangeMs;
  const gapMs = Math.max(sampleSeconds * 1000 * 3.5, (rangeMs / 120) * 3.5);
  const x = (t) => ((t - start) / rangeMs) * W;
  const y = (v) => H - Math.min(1, Math.max(0, v / yMax)) * H;
  const paths = lines.map((ln) => {
    let d = '';
    let seg = [];
    const flush = () => {
      if (seg.length === 1) d += `M${seg[0][0].toFixed(1)} ${seg[0][1].toFixed(1)}l0.01 0`;
      else if (seg.length > 1) d += `M${seg.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}`;
      seg = [];
    };
    let prevT = null;
    points.forEach((p) => {
      const v = p[ln.key];
      if (typeof v !== 'number') { flush(); prevT = null; return; }
      if (prevT !== null && p.t - prevT > gapMs) flush();
      seg.push([x(p.t), y(v)]);
      prevT = p.t;
    });
    flush();
    return { ...ln, d };
  });
  const hasData = paths.some((p) => p.d);
  const lastVals = lines.map((ln) => {
    const v = [...points].reverse().find((p) => typeof p[ln.key] === 'number');
    return v ? `${ln.label}: ${v[ln.key]}${unit}` : null;
  }).filter(Boolean);
  return (
    <section className="card sx-card sp-chart">
      <div className="sx-card-head">
        <h2>{title}</h2>
        <span className="muted sp-scale">0 – {yMax}{unit}</span>
      </div>
      {!hasData ? (
        <p className="muted" style={{ margin: 0 }}>No readings in this period yet.</p>
      ) : (
        <>
          <svg className="sp-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title} over the selected period. ${lastVals.join('; ')}`}>
            {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="sp-grid" vectorEffect="non-scaling-stroke" />)}
            {(guides || []).map((g) => g.value <= yMax && (
              <line key={g.label} x1="0" x2={W} y1={y(g.value)} y2={y(g.value)} className={`sp-guide sp-guide-${g.kind}`} vectorEffect="non-scaling-stroke" />
            ))}
            {paths.map((p) => p.d && <path key={p.key} d={p.d} className={`sp-line sp-line-${p.tone}`} vectorEffect="non-scaling-stroke" />)}
          </svg>
          <div className="sp-axis muted">
            <span>{timeText(start, rangeMs > 86400000 / 2)}</span>
            <span>now</span>
          </div>
          <ul className="sp-legend">
            {lines.map((ln) => <li key={ln.key}><span className={`sp-swatch sp-swatch-${ln.tone}`} aria-hidden="true" />{ln.label}</li>)}
            {(guides || []).map((g) => <li key={g.label}><span className={`sp-swatch sp-swatch-${g.kind}`} aria-hidden="true" />{g.label}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function Gauge({ title, level, big, bigSub, pct, lines, detail, action }) {
  return (
    <section className="card sx-card sp-gauge">
      <div className="sx-card-head">
        <h2>{title}</h2>
        <LevelPill level={level} />
      </div>
      <div className="sp-big">{big}{bigSub && <span className="sp-big-sub">{bigSub}</span>}</div>
      {pct !== null && pct !== undefined && (
        <div className="sp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${title} used`}>
          <span className={`sp-bar-fill sp-bar-${level}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      )}
      {lines.map((l) => <p key={l} className="sp-line-text">{l}</p>)}
      {detail && <p className="sp-line-text sp-detail">{detail}</p>}
      {action}
    </section>
  );
}

export default function AdminServerPerformance() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Server Performance' }]);
  const [range, setRange] = useState('24h');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getServerMetrics(range)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => clearInterval(id);
  }, [load]);

  const appFlag = data && data.vm.fly.app ? ` -a ${data.vm.fly.app}` : '';
  const v = data ? data.verdict : null;
  const now = data ? data.now : null;
  const T = data ? data.thresholds : null;

  const cmd = (text) => <code className="sp-cmd">{text}</code>;
  const fix = (level, body) => (level === 'increase' || level === 'watch') && <div className="sp-fix"><strong>{level === 'increase' ? 'What to do' : 'If it keeps rising'}</strong>{body}</div>;

  return (
    <div className="sx-page sp-page">
      <div className="au-head">
        <Link to="/admin" className="msg-icon-btn" aria-label="Back to Admin Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Server Performance</h1>
      </div>
      <p className="muted mm-intro">Is the Fly.io machine running this app short of memory, CPU or disk space?</p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <section className={`sp-verdict sp-verdict-${v.overall.level}`} aria-live="polite">
            <div className="sp-verdict-top">
              <LevelPill level={v.overall.level} />
              <strong className="sp-verdict-head">{v.overall.headline}</strong>
            </div>
            <ul className="sp-verdict-list">
              <li><span>Memory</span><LevelPill level={v.memory.level} /></li>
              <li><span>CPU</span><LevelPill level={v.cpu.level} /></li>
              <li><span>Responsiveness</span><LevelPill level={v.responsiveness.level} /></li>
              <li><span>Disk</span><LevelPill level={v.disk.level} /></li>
            </ul>
            <p className="sp-verdict-note">
              Based on {data.readingsSince ? `${v.spanMinutes >= 120 ? `${Math.round(v.spanMinutes / 60)} hours` : `${v.spanMinutes} minutes`} of readings, since ${timeText(data.readingsSince, true)}` : 'no readings yet'}.
              Readings only exist while the machine is running.
            </p>
          </section>

          <div className="sp-controls">
            <div className="sp-range" role="group" aria-label="Chart period">
              {RANGES.map((r) => (
                <button key={r.key} type="button" className={`btn sp-range-btn${range === r.key ? ' is-active' : ''}`} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
              ))}
            </div>
            <button type="button" className="btn" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          <p className="muted sp-small" style={{ margin: 0 }}>Updated {timeText(data.generatedAt)} · refreshes itself every 30 seconds while this page is open.</p>

          {data.persistError && <p className="banner banner-warning">History could not be saved to the data volume ({data.persistError}). Readings will be lost on the next restart.</p>}

          <div className="sp-gauges">
            <Gauge
              title="Memory (RAM)"
              level={v.memory.level}
              big={pctText(now.memPct)}
              bigSub={` ${mbText(now.memUsedMb)} of ${mbText(now.memTotalMb)}`}
              pct={now.memPct}
              lines={[
                v.memory.summary,
                `The app process itself holds ${mbText(now.rssMb)} (JavaScript heap ${mbText(now.heapUsedMb)}).`,
                now.swapTotalMb > 0 ? `Swap: ${mbText(now.swapUsedMb)} of ${mbText(now.swapTotalMb)} in use.` : 'No swap space is configured on this machine.',
              ]}
              detail={v.memory.detail}
              action={fix(v.memory.level, <p>Add RAM: {cmd(`fly scale memory 2048${appFlag}`)} then change <code>memory</code> in the <code>[[vm]]</code> section of <code>fly.toml</code> to match, so a later deploy doesn’t put it back.</p>)}
            />
            <Gauge
              title="CPU"
              level={v.cpu.level}
              big={pctText(now.cpuPct)}
              bigSub={` busy now · ${data.vm.cpuCount} CPU${data.vm.cpuCount === 1 ? '' : 's'}`}
              pct={now.cpuPct}
              lines={[
                v.cpu.summary,
                `Load average (1 / 5 / 15 min): ${now.load.join(' / ')}. Around ${data.vm.cpuCount} or less is comfortable on this machine.`,
                data.stealReported ? 'Steal = time the app wanted the CPU but the shared host gave it to something else.' : 'This machine does not report CPU steal.',
              ]}
              action={fix(v.cpu.level, <p>Move to a bigger CPU: {cmd(`fly scale vm shared-cpu-2x${appFlag}`)} or, for sustained load, {cmd(`fly scale vm performance-1x${appFlag}`)}. The app runs your code on one thread, so a faster CPU type helps more than extra shared cores.</p>)}
            />
            <Gauge
              title="Responsiveness"
              level={v.responsiveness.level}
              big={msText(now.lagP99)}
              bigSub=" worst delay in the last minute"
              pct={null}
              lines={[
                v.responsiveness.summary,
                'How long the app was too busy to answer anything. Short delays are normal; seconds-long ones mean visitors are waiting.',
              ]}
              detail={v.responsiveness.detail}
              action={fix(v.responsiveness.level, <p>If delays come with a busy CPU, use the CPU steps above. If the CPU is not busy, the delay is in how the app works and should be looked at in the code.</p>)}
            />
            <Gauge
              title="Disk (data volume)"
              level={v.disk.level}
              big={now.disk ? pctText(now.disk.usedPct) : '–'}
              bigSub={now.disk ? ` ${mbText(now.disk.usedMb)} of ${mbText(now.disk.totalMb)}` : ''}
              pct={now.disk ? now.disk.usedPct : null}
              lines={[
                v.disk.summary,
                data.vm.dataDirIsMount === false ? `Warning: ${data.vm.dataDir} is not a separate volume on this machine, so its data would not survive a redeploy.` : `Data folder: ${data.vm.dataDir}${data.vm.dataDirIsMount ? ' (a mounted volume)' : ''}.`,
              ]}
              action={fix(v.disk.level, <p>Grow the volume: {cmd(`fly volumes list${appFlag}`)} to find its ID, then {cmd('fly volumes extend <volume-id> -s <new size in GB>')}.</p>)}
            />
          </div>

          <LineChart title="Memory used" points={data.series} rangeMs={data.rangeMs} nowMs={data.generatedAt} yMax={100} unit="%" sampleSeconds={data.sampleIntervalSeconds}
            lines={[{ key: 'memPct', label: 'Typical', tone: 'green' }, { key: 'memPctMax', label: 'Peak', tone: 'gold' }]}
            guides={[{ value: T.memory.watchP95, kind: 'watch', label: `Watch ${T.memory.watchP95}%` }, { value: T.memory.increaseP95, kind: 'increase', label: `Increase ${T.memory.increaseP95}%` }]} />
          <LineChart title="CPU busy" points={data.series} rangeMs={data.rangeMs} nowMs={data.generatedAt} yMax={100} unit="%" sampleSeconds={data.sampleIntervalSeconds}
            lines={[{ key: 'cpu', label: 'Busy', tone: 'green' }, ...(data.stealReported ? [{ key: 'steal', label: 'Steal', tone: 'gold' }] : [])]}
            guides={[{ value: T.cpu.watchP95, kind: 'watch', label: `Watch ${T.cpu.watchP95}%` }, { value: T.cpu.increaseP95, kind: 'increase', label: `Increase ${T.cpu.increaseP95}%` }]} />
          <LineChart title="Responsiveness (delay)"
            points={data.series} rangeMs={data.rangeMs} nowMs={data.generatedAt} sampleSeconds={data.sampleIntervalSeconds}
            yMax={Math.max(300, Math.ceil((Math.max(0, ...data.series.map((p) => p.lagMax || 0)) * 1.1) / 100) * 100)} unit=" ms"
            lines={[{ key: 'lagP99', label: 'Typical worst delay', tone: 'green' }, { key: 'lagMax', label: 'Longest stall', tone: 'gold' }]}
            guides={[{ value: T.lag.watchMs, kind: 'watch', label: `Watch ${T.lag.watchMs} ms` }, { value: T.lag.increaseMs, kind: 'increase', label: `Increase ${T.lag.increaseMs} ms` }]} />
          <LineChart title="Disk used" points={data.series} rangeMs={data.rangeMs} nowMs={data.generatedAt} yMax={100} unit="%" sampleSeconds={data.sampleIntervalSeconds}
            lines={[{ key: 'diskPct', label: 'Volume used', tone: 'green' }]}
            guides={[{ value: T.disk.watchPct, kind: 'watch', label: `Watch ${T.disk.watchPct}%` }, { value: T.disk.increasePct, kind: 'increase', label: `Increase ${T.disk.increasePct}%` }]} />

          <section className="card sx-card">
            <div className="sx-card-head"><h2>This machine</h2></div>
            <p className="sx-kv"><span className="muted">Memory (RAM)</span><strong>{mbText(now.memTotalMb)}</strong></p>
            <p className="sx-kv"><span className="muted">CPUs</span><strong>{data.vm.cpuCount}{data.vm.cpuModel ? ` · ${data.vm.cpuModel}` : ''}</strong></p>
            <p className="sx-kv"><span className="muted">Data volume</span><strong>{now.disk ? mbText(now.disk.totalMb) : 'not readable'}</strong></p>
            <p className="sx-kv"><span className="muted">App running for</span><strong>{durationText(data.vm.processUptimeSeconds)}</strong></p>
            <p className="sx-kv"><span className="muted">Machine up for</span><strong>{durationText(data.vm.machineUptimeSeconds)}</strong></p>
            {data.vm.fly.app && <p className="sx-kv"><span className="muted">Fly.io app</span><strong>{data.vm.fly.app}{data.vm.fly.region ? ` · ${data.vm.fly.region}` : ''}</strong></p>}
            {data.vm.fly.machineId && <p className="sx-kv"><span className="muted">Machine ID</span><strong>{data.vm.fly.machineId}</strong></p>}
            <p className="sx-kv"><span className="muted">Software</span><strong>Node {data.vm.node} · {data.vm.platform}</strong></p>
            {data.data && (
              <>
                <p className="sx-kv"><span className="muted">Data stored on the volume</span><strong>{mbText(Math.round(data.data.totalBytes / 1048576))}</strong></p>
                <ul className="sp-files">
                  {data.data.items.map((i) => <li key={i.name}><span>{i.name}</span><span className="muted">{mbText(Math.round((i.bytes / 1048576) * 10) / 10)}</span></li>)}
                </ul>
              </>
            )}
          </section>

          <section className="card sx-card">
            <div className="sx-card-head"><h2>Restarts</h2><span className="muted">{data.boots.length}</span></div>
            <p className="muted sp-small" style={{ margin: 0 }}>Each time the app started (deploys, the machine waking from a stop, or a crash). The reading shown is the last one taken before it stopped, up to a minute earlier.</p>
            {data.boots.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>None recorded yet.</p>
            ) : (
              <ul className="sp-boots">
                {data.boots.map((b) => (
                  <li key={b.at}>
                    <strong>{timeText(b.at, true)}</strong>
                    <span className="muted sp-small">
                      {b.prev
                        ? `Before it: last reading ${timeText(b.prev.at, true)} · memory ${pctText(b.prev.memPct)}${b.prev.cpu !== null ? ` · CPU ${pctText(b.prev.cpu)}` : ''}${b.prev.memPct !== null && b.prev.memPct >= T.highMemoryRestartPct ? ' · memory was very high' : ''}`
                        : 'First time monitoring started on this machine.'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card sx-card">
            <div className="sx-card-head"><h2>How to read this</h2></div>
            <details className="sp-details">
              <summary>Where the numbers come from, and what they can’t tell you</summary>
              <ul className="sp-notes">
                <li>Measured from inside the machine every minute: memory from the machine’s own counters, CPU from its CPU time counters, disk from the data volume, and delay by timing how late the app answers a 100 ms timer.</li>
                <li>The machine is set to stop when idle, so there are no readings while it is stopped, and a quiet period can look healthier than a busy one. Use the busiest hours as the guide.</li>
                <li>Fly.io’s own Metrics page for this app is the authority on CPU throttling on shared CPUs. {data.stealReported ? 'Steal here is reported by the machine, but a 0% reading does not prove nothing was throttled.' : 'This machine does not report steal.'}</li>
                <li>The Fine / Watch / Increase levels use these rules of thumb, chosen for this app rather than set by Fly.io: memory watch at {T.memory.watchP95}% typical or {T.memory.watchPeak}% peak, increase at {T.memory.increaseP95}% typical or {T.memory.increasePeak}% peak (or swap use, or a restart straight after memory above {T.highMemoryRestartPct}%); CPU watch at {T.cpu.watchP95}% typical, increase at {T.cpu.increaseP95}%, or steal above {T.cpu.watchStealP95}% / {T.cpu.increaseStealP95}%; delay watch at {T.lag.watchMs} ms, increase at {T.lag.increaseMs} ms; disk watch at {T.disk.watchPct}%, increase at {T.disk.increasePct}%, or full within {T.disk.watchDaysToFull} / {T.disk.increaseDaysToFull} days at the current growth rate. “Typical” means the 95th percentile of the readings kept (up to 7 days).</li>
                <li>This page shows the machine the app is running on right now. If production and staging are separate Fly.io apps, open this page on each to see its own machine.</li>
              </ul>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
