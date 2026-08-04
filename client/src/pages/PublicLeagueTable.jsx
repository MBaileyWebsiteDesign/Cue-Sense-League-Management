import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './publicPages.css';

// Standalone, unauthenticated "League Table" board for a whole league - like
// Arena/StreamOverlay (outside the normal app shell, no login gate), but
// meant to be embedded elsewhere (an <iframe> on another site) rather than
// shown on a venue TV or keyed over OBS video. Polls GET
// /api/public/leagues/:id/table (a public, read-only endpoint) so an
// embedded copy stays close to live without any extra infrastructure - same
// reasoning as Arena/StreamOverlay's own polling.
//
// Usage: embed this page's URL, e.g.
//   https://your-deployment.example.com/public/leagues/<leagueId>/table
// The league id is the same one in that league's own management page URL
// (/leagues/<leagueId>).
const POLL_INTERVAL_MS = 20000;

export default function PublicLeagueTable() {
  const { leagueId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getPublicLeagueTable(leagueId)
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
        <h1>{data.leagueName} — League Table</h1>
        <span className="public-updated">Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      {data.divisions.length === 0 && <p className="public-empty-state">No divisions set up for this league yet.</p>}

      {data.divisions.map((division) => (
        <div key={division.divisionId} className="public-division-block">
          <div className="public-division-header">
            <h2>{division.divisionName}</h2>
            <span className="public-division-meta">
              {division.status === 'completed' && <span className="public-complete-pill">Complete</span>}
            </span>
          </div>
          <StandingsTable division={division} />
        </div>
      ))}

      <p className="public-footer">Cue Sense - Pool Management</p>
    </div>
  );
}

function StandingsTable({ division }) {
  if (division.standings.length === 0) {
    return <p className="public-empty-state">No entrants registered yet.</p>;
  }

  const isTeams = division.entryType === 'teams';

  return (
    <table className="public-table">
      {isTeams ? (
        <>
          <thead>
            <tr>
              <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>LF</th><th>LA</th><th>+/-</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>
            {division.standings.map((row, i) => (
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
              <th>#</th><th>{division.entryType === 'doubles' ? 'Pairing' : 'Player'}</th><th>P</th><th>W</th><th>L</th><th>F</th><th>A</th><th>+/-</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>
            {division.standings.map((row, i) => (
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
  );
}
