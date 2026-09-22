import { useState } from 'react';
import { Link } from 'react-router-dom';

// Phone-width standings (mobile redesign, 2026-09-22). The full desktop
// table has up to 12 columns and scrolled sideways on a phone, hiding Pts.
// This keeps #, name, P, +/- and Pts always visible; tapping a row expands
// the remaining columns as small tiles. Shown only under 640px via CSS
// (.cs-standings-mobile / .cs-standings-desktop in styles.css) - desktop
// keeps the existing table unchanged.
//
// rows: [{ key, name, played, diff, points, profileTo?, details: [{ label, title, value }] }]
export default function MobileStandings({ rows, diffLabel = '+/-', nameLabel = 'Player' }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="cs-standings-mobile">
      <div className="cs-st-head" aria-hidden="true">
        <span className="cs-st-pos">#</span>
        <span className="cs-st-name">{nameLabel}</span>
        <span className="cs-st-num">P</span>
        <span className="cs-st-num">{diffLabel}</span>
        <span className="cs-st-pts">Pts</span>
        <span className="cs-st-chev" />
      </div>
      {rows.map((row, i) => {
        const isOpen = open === row.key;
        const diff = Number(row.diff) || 0;
        return (
          <div key={row.key} className={`cs-st-row${isOpen ? ' cs-st-open' : ''}`}>
            <button
              type="button"
              className="cs-st-main"
              aria-expanded={isOpen}
              aria-label={`${i + 1}. ${row.name}: played ${row.played}, ${diffLabel} ${row.diff}, ${row.points} points. Tap for more.`}
              onClick={() => setOpen(isOpen ? null : row.key)}
            >
              <span className="cs-st-pos">{i + 1}</span>
              <span className="cs-st-name">{row.name}</span>
              <span className="cs-st-num">{row.played}</span>
              <span className={`cs-st-num ${diff > 0 ? 'cs-tone-win' : diff < 0 ? 'cs-tone-loss' : ''}`}>{diff > 0 ? `+${diff}` : row.diff}</span>
              <span className="cs-st-pts">{row.points}</span>
              <svg className="cs-st-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {isOpen && (
              <div className="cs-st-detail">
                <div className="cs-st-tiles">
                  {row.details.map((d) => (
                    <div key={d.label} className="cs-st-tile">
                      <strong>{d.value}</strong>
                      <span>{d.title || d.label}</span>
                    </div>
                  ))}
                </div>
                {row.profileTo && <Link to={row.profileTo} className="cs-st-link">View player profile →</Link>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Builds MobileStandings rows from the standings shapes the API returns.
export function standingsRows(standings, isTeams, { withProfileLinks = false, withBreakStats = false, isDoubles = false } = {}) {
  return standings.map((row) => (isTeams
    ? {
      key: row.teamId,
      name: row.teamName,
      played: row.played,
      diff: row.legDifference,
      points: row.points,
      details: [
        { label: 'W', title: 'Won', value: row.won },
        { label: 'D', title: 'Drawn', value: row.drawn },
        { label: 'L', title: 'Lost', value: row.lost },
        { label: 'LF', title: 'Legs for', value: row.legsFor },
        { label: 'LA', title: 'Legs against', value: row.legsAgainst },
      ],
    }
    : {
      key: row.playerId,
      name: row.playerName,
      played: row.played,
      diff: row.frameDifference,
      points: row.points,
      profileTo: withProfileLinks && !isDoubles ? `/players/${row.playerId}` : null,
      details: [
        { label: 'W', title: 'Won', value: row.won },
        { label: 'L', title: 'Lost', value: row.lost },
        { label: 'F', title: 'Frames for', value: row.framesFor },
        { label: 'A', title: 'Frames against', value: row.framesAgainst },
        ...(withBreakStats
          ? [
            { label: 'BND', title: 'Break & Dish', value: row.bnd || 0 },
            { label: 'RND', title: 'Reverse B&D', value: row.rnd || 0 },
            { label: 'NS', title: 'No-shows', value: row.noShows || 0 },
          ]
          : []),
      ],
    }));
}
