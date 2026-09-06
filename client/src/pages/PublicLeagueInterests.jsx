import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './publicPages.css';

// Standalone, unauthenticated "League Interests" board for a league - same
// pattern as PublicLeagueTable/PublicLeagueFixtures (outside the normal app
// shell, no login gate, polls a public read-only endpoint), but shows who
// has registered interest in the league rather than standings/fixtures.
// Read-only: no decline/assign controls, no player ids - just name and a
// simple paid/not-paid flag (only shown when the league has a payment wall).
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/leagues/<leagueId>/interests
// The league id is the same one in that league's own management page URL
// (/leagues/<leagueId>).
const POLL_INTERVAL_MS = 20000;

export default function PublicLeagueInterests() {
  const { leagueId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicLeagueInterests(leagueId)
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
        <h1>{data.leagueName} — League Interests</h1>
        <span className="public-updated">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {data.interests.length === 0 ? (
        <p className="public-empty-state">No players have registered interest yet.</p>
      ) : (
        <table className="public-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              {data.paymentRequired && <th>Paid</th>}
            </tr>
          </thead>
          <tbody>
            {data.interests.map((row, i) => (
              <tr key={row.playerName + i}>
                <td>{i + 1}</td>
                <td>{row.playerName}</td>
                {data.paymentRequired && (
                  <td>
                    <span className={row.paid ? 'public-complete-pill' : 'muted'}>
                      {row.paid ? 'Paid' : 'Not paid'}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="public-footer">
        Powered By Cue Sense,{' '}
        <a href="https://www.cuesense.co.uk" target="_blank" rel="noopener noreferrer">
          www.CueSense.co.uk
        </a>
      </p>
    </div>
  );
}
