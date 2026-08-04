import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './publicPages.css';

// Standalone, unauthenticated "Division Table" board for a single division -
// same reasoning/pattern as PublicLeagueTable.jsx (see that file's header
// comment), just scoped to one division instead of every division in a
// league. Polls GET /api/public/divisions/:id/table.
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/divisions/<divisionId>/table
// The division id is the same one in that division's own management page
// URL (/divisions/<divisionId>).
const POLL_INTERVAL_MS = 20000;

export default function PublicDivisionTable() {
  const { divisionId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicDivisionTable(divisionId)
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
        {error ? <p className="public-empty-state">{error}</p> : <p className="public-empty-state">Loading…</p>}
      </div>
    );
  }

  const isTeams = data.entryType === 'teams';

  return (
    <div className="public-root">
      <div className="public-header">
        <h1>{data.divisionName}{data.leagueName ? ` — ${data.leagueName}` : ''}</h1>
        <span className="public-updated">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {data.status === 'completed' && <span className="public-complete-pill">Complete</span>}

      {data.standings.length === 0 ? (
        <p className="public-empty-state">No entrants registered yet.</p>
      ) : (
        <table className="public-table">
          {isTeams ? (
            <>
              <thead>
                <tr>
                  <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>LF</th><th>LA</th><th>+/-</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>
                {data.standings.map((row, i) => (
                  <tr key={row.teamId}>
                    <td>{i + 1}</td>
                    <td>{row.teamName}</td>
                    <td>{row.played}</td>
                    <td>{row.won}</td>
                    <td>{row.drawn}</td>
                    <td>{row.lost}</td>
                    <td>{row.legsFor}</td>
                    <td>{row.legsAgainst}</td>
                    <td>{row.legDifference}</td>
                    <td><strong>{row.points}</strong></td>
                  </tr>
                ))}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th>#</th><th>{data.entryType === 'doubles' ? 'Pairing' : 'Player'}</th><th>P</th><th>W</th><th>L</th><th>F</th><th>A</th><th>+/-</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>
                {data.standings.map((row, i) => (
                  <tr key={row.playerId}>
                    <td>{i + 1}</td>
                    <td>{row.playerName}</td>
                    <td>{row.played}</td>
                    <td>{row.won}</td>
                    <td>{row.lost}</td>
                    <td>{row.framesFor}</td>
                    <td>{row.framesAgainst}</td>
                    <td>{row.frameDifference}</td>
                    <td><strong>{row.points}</strong></td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
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
