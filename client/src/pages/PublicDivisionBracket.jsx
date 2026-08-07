import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import BracketChart from '../components/BracketChart.jsx';
import DoubleElimBracketChart from '../components/DoubleElimBracketChart.jsx';
import './publicPages.css';

// Standalone, unauthenticated "Bracket" board for one knockout division -
// same pattern as PublicLeagueTable/PublicLeagueFixtures (outside the
// normal app shell, no login gate, meant to be embedded elsewhere), just
// showing a bracket chart instead of a table or flat fixture list. Polls
// GET /api/public/divisions/:id/bracket, which works for both single- and
// double-elimination knockout divisions (round robin's flat standings
// table doesn't fit either chart shape) - `data.scheduling` says which one
// this division is, so this page renders the matching chart component.
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/divisions/<divisionId>/bracket
// The division id is the same one in that division's own management page
// URL (/divisions/<divisionId>).
const POLL_INTERVAL_MS = 15000;

export default function PublicDivisionBracket() {
  const { divisionId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicDivisionBracket(divisionId)
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

  if (!data && !error) {
    return (
      <div className="public-root">
        <p className="public-empty-state">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="public-root">
        <p className="public-empty-state">{error}</p>
      </div>
    );
  }

  return (
    <div className="public-root">
      <div className="public-header">
        <h1>{data.leagueName} — {data.divisionName}</h1>
        <span className="public-updated">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {data.status === 'completed' && <p className="public-complete-pill" style={{ marginBottom: 12 }}>Complete</p>}

      {data.matches.length === 0 ? (
        <p className="public-empty-state">No bracket to show yet.</p>
      ) : data.scheduling === 'knockout_double_elim' ? (
        <DoubleElimBracketChart matches={data.matches} />
      ) : (
        <BracketChart matches={data.matches} totalRounds={data.totalRounds} />
      )}

      <p className="public-footer">
        Powered By Rack Sense,{' '}
        <a href="https://www.racksense.co.uk" target="_blank" rel="noopener noreferrer">
          www.RackSense.co.uk
        </a>
      </p>
    </div>
  );
}
