import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './publicPages.css';

// Standalone, unauthenticated "League Fixtures" board for a whole league -
// same reasoning/pattern as PublicLeagueTable.jsx (see that file's header
// comment), just showing every visible fixture instead of the standings.
// Polls GET /api/public/leagues/:id/fixtures, which already sorts
// still-to-be-decided fixtures first (soonest scheduled date first) and
// completed ones after (most recent first), and only ever includes rounds
// an admin has released (see isRoundVisible / "Manage Fixtures").
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/leagues/<leagueId>/fixtures
const POLL_INTERVAL_MS = 15000;

export default function PublicLeagueFixtures() {
  const { leagueId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicLeagueFixtures(leagueId)
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
      <div className="public-root">
        {error ? <p className="public-empty-state">{error}</p> : <p className="public-empty-state">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="public-root">
      <div className="public-header">
        <h1>{data.leagueName} — Fixtures</h1>
        <span className="public-updated">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {data.fixtures.length === 0 && <p className="public-empty-state">No fixtures released yet.</p>}

      <ul className="public-fixture-list">
        {data.fixtures.map((f) => (
          <li key={f.fixtureId}>
            <div className="public-fixture-entrants">
              {f.home.name}
              {f.status === 'completed' || f.status === 'in_progress' ? (
                <span className="public-fixture-score"> {f.home.score} - {f.away.score} </span>
              ) : (
                ' vs '
              )}
              {f.away.name}
              <div className="public-division-meta">{f.divisionName} · {f.roundLabel}</div>
            </div>
            <div className="public-fixture-meta">
              <span className={`public-status-pill${f.status === 'in_progress' ? ' public-status-live' : ''}${f.status === 'completed' ? ' public-status-completed' : ''}${f.status !== 'completed' && !f.bothEntrantsKnown ? ' public-status-awaiting' : ''}`}>
                {f.status === 'in_progress'
                  ? 'Live'
                  : f.status !== 'completed' && !f.bothEntrantsKnown
                    ? 'awaiting result'
                    : f.status.replace('_', ' ')}
              </span>
              <span>{f.scheduledDate ? `${f.scheduledDate}${f.scheduledTime ? ` ${f.scheduledTime}` : ''}` : 'Date TBD'}</span>
            </div>
          </li>
        ))}
      </ul>

      <p className="public-footer">The Ultimate Pool League</p>
    </div>
  );
}
