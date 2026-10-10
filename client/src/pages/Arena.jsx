import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './arena.css';

// Standalone big-display board for a venue TV/monitor - like StreamOverlay
// (outside the normal app shell, no login gate, since a TV at the venue has
// no way to log in either), but shows the whole league's table schedule for
// today instead of one fixture. Polls GET /api/overlay/leagues/:id/arena (a
// public, unauthenticated endpoint) rather than opening a websocket, for
// the same "close enough to live, zero extra infrastructure" reasoning as
// the OBS overlay.
//
// Usage: put this page's URL on the venue's display, e.g.
//   https://your-deployment.example.com/arena/<leagueId>
// The league id is the same one in that league's own page URL
// (/leagues/<leagueId>) - copy it from there.
//
// Display refresh (2026-10-10): sizes scale with the screen (em units off a
// viewport-based root size in arena.css) so the same page reads on a phone, a
// laptop mirrored to a TV, or a 4K screen; live matches get a highlighted card;
// a small notice appears if the feed stops updating; and the page reloads
// itself every few hours (only when the site is reachable) so a TV that is
// never touched still picks up new versions of the app.
const POLL_INTERVAL_MS = 15000;
const RELOAD_EVERY_MS = 6 * 60 * 60 * 1000;

export default function Arena() {
  const { leagueId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());
  const [lastOk, setLastOk] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const clockTimer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getArena(leagueId)
        .then((result) => {
          if (!mountedRef.current) return;
          setData(result);
          setLastOk(new Date());
          setError('');
        })
        .catch((err) => {
          if (!mountedRef.current) return;
          setError(err.message);
        })
        .finally(() => {
          if (mountedRef.current) timer = setTimeout(poll, POLL_INTERVAL_MS);
        });
    };
    poll();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, [leagueId]);

  // Reload now and then so an unattended TV picks up new app versions - but
  // only if the site answers first, so a dropped connection never leaves a
  // browser error page on the screen.
  useEffect(() => {
    const t = setInterval(() => {
      fetch(window.location.href, { cache: 'no-store' })
        .then((r) => { if (r.ok) window.location.reload(); })
        .catch(() => {});
    }, RELOAD_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return (
      <div className="arena-root">
        {error ? <p className="arena-empty-state">{error}</p> : <p className="arena-empty-state">Loading…</p>}
      </div>
    );
  }

  const hasSide = data.unscheduled.length > 0 || data.recentResults.length > 0;
  const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="arena-root">
      <div className="arena-header">
        <h1>{data.leagueName}</h1>
        <div className="arena-clock-block">
          <span className="arena-clock">{time(now)}</span>
          <span className="arena-date">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        </div>
      </div>

      {error && (
        <p className="arena-stale" role="status">
          Connection lost - showing scores from {lastOk ? time(lastOk) : 'earlier'}. Retrying…
        </p>
      )}

      <div className={`arena-body${hasSide ? ' has-side' : ''}`}>
        <div className="arena-tables-col">
          <div className="arena-tables-grid">
            {data.tables.map((table) => {
              const live = table.fixture && table.fixture.status === 'in_progress';
              return (
                <div key={table.id} className={`arena-table-card${live ? ' arena-card-live' : ''}${table.fixture ? '' : ' arena-card-idle'}`}>
                  <div className="arena-table-name">{table.name}</div>
                  {table.fixture ? <ArenaFixture fixture={table.fixture} /> : <div className="arena-table-empty">No match scheduled</div>}
                </div>
              );
            })}
          </div>
          {data.tables.length === 0 && (
            <p className="arena-empty-state">No tables set up for this league yet.</p>
          )}
        </div>

        {hasSide && (
          <aside className="arena-side">
            {data.unscheduled.length > 0 && (
              <>
                <h2 className="arena-section-title">Not yet on a table</h2>
                <ul className="arena-unscheduled-list">
                  {data.unscheduled.map((f) => (
                    <li key={f.fixtureId}>
                      <span>{f.home.name} vs {f.away.name}</span>
                      <span className="arena-li-div">{f.divisionName}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {data.recentResults.length > 0 && (
              <>
                <h2 className="arena-section-title">Recent Results</h2>
                <ul className="arena-results-list">
                  {data.recentResults.map((f) => (
                    <li key={f.fixtureId}>
                      <span>{f.home.name} <strong className="arena-li-score">{f.home.score} - {f.away.score}</strong> {f.away.name}</span>
                      <span className="arena-li-div">{f.divisionName}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function ArenaFixture({ fixture }) {
  return (
    <div>
      <div className="arena-fixture-matchup">
        <div className="arena-fixture-entrant">
          <div className="arena-fixture-name">{fixture.home.name}</div>
          <div className="arena-fixture-score">{fixture.home.score}</div>
        </div>
        <span className="arena-fixture-vs">vs</span>
        <div className="arena-fixture-entrant">
          <div className="arena-fixture-name">{fixture.away.name}</div>
          <div className="arena-fixture-score">{fixture.away.score}</div>
        </div>
      </div>
      <div className="arena-fixture-meta">
        {fixture.status === 'in_progress'
          ? <span className="arena-status-live"><span className="arena-live-dot" aria-hidden="true" />LIVE</span>
          : <span>{fixture.scheduledTime || 'Time TBD'}</span>}
        <span>{fixture.divisionName}</span>
      </div>
    </div>
  );
}
