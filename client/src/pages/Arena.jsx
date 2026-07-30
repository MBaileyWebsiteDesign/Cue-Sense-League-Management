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
const POLL_INTERVAL_MS = 15000;

export default function Arena() {
  const { leagueId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());
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

  if (!data) {
    return (
      <div className="arena-root">
        {error ? <p className="arena-empty-state">{error}</p> : <p className="arena-empty-state">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="arena-root">
      <div className="arena-header">
        <h1>{data.leagueName}</h1>
        <span className="arena-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="arena-tables-grid">
        {data.tables.map((table) => (
          <div key={table.id} className="arena-table-card">
            <div className="arena-table-name">{table.name}</div>
            {table.fixture ? <ArenaFixture fixture={table.fixture} /> : <div className="arena-table-empty">No match scheduled</div>}
          </div>
        ))}
        {data.tables.length === 0 && (
          <p className="arena-empty-state">No tables set up for this league yet.</p>
        )}
      </div>

      {data.unscheduled.length > 0 && (
        <>
          <h2 className="arena-section-title">Not yet on a table</h2>
          <ul className="arena-unscheduled-list">
            {data.unscheduled.map((f) => (
              <li key={f.fixtureId}>
                <span>{f.home.name} vs {f.away.name}</span>
                <span>{f.divisionName}</span>
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
                <span>{f.home.name} {f.home.score} - {f.away.score} {f.away.name}</span>
                <span>{f.divisionName}</span>
              </li>
            ))}
          </ul>
        </>
      )}
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
        <span className={fixture.status === 'in_progress' ? 'arena-status-live' : ''}>
          {fixture.status === 'in_progress' ? 'LIVE' : fixture.scheduledTime || 'Time TBD'}
        </span>
        <span>{fixture.divisionName}</span>
      </div>
    </div>
  );
}
