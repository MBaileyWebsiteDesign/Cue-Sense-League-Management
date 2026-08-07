import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './publicPages.css';

// Standalone, unauthenticated "Division Fixtures" board for a single
// division - same reasoning/pattern as PublicLeagueFixtures.jsx (see that
// file's header comment), just scoped to one division instead of every
// division in a league. Polls GET /api/public/divisions/:id/fixtures, which
// already sorts still-to-be-decided fixtures first (soonest scheduled date
// first) and completed ones after (most recent first), and only ever
// includes rounds an admin has released.
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/divisions/<divisionId>/fixtures
const POLL_INTERVAL_MS = 15000;

export default function PublicDivisionFixtures() {
  const { divisionId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicDivisionFixtures(divisionId)
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
  }, [divisionId]);

  if (!data) {
    return (
      <div className="public-root">
        {error ? <p className="public-empty-state">{error}</p> : <p className="public-empty-state">Loadingâ¦</p>}
      </div>
    );
  }

  return (
    <div className="public-root">
      <div className="public-header">
        <h1>{data.divisionName}{data.leagueName ? ` â ${data.leagueName}` : ''} â Fixtures</h1>
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
              <div className="public-division-meta">{f.roundLabel}</div>
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

      <p className="public-footer">
        Powered By Rack Sense,{' '}
        <a href="https://www.racksense.co.uk" target="_blank" rel="noopener noreferrer">
          www.RackSense.co.uk
        </a>
      </p>
    </div>
  );
}
