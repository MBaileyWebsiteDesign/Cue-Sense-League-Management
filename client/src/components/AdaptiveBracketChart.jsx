// The bracket chart for "Adaptive Double Elimination Knockout" (ADEK).
//
// Every other bracket in this app is a TREE, and its chart's job is to draw
// the wiring: box A's winner goes to box B, its loser drops to box C, and
// those lines exist because the server committed to them at generation time.
//
// ADEK has no wiring. Each round's pairings are computed only once the
// previous round has been played (see appendAdaptiveRound in
// server/src/index.js and services/adaptiveDoubleElim.js), which is exactly
// what lets it guarantee nobody meets the same opponent twice before the
// Losers Final, Winners Final or Grand Final. Drawing connectors here would
// therefore be drawing a promise the format deliberately does not make.
//
// So this is a ROUND-COLUMN chart: one column per round, in the order the
// rounds are actually played, each headed with the name the pairing engine
// gave it. Rounds to the right of "now" simply do not exist yet and appear as
// they are earned - the division page polls for them.
//
// Props:
//   matches: [{ id, round, roundLabel, roundKind, bracketRole, byeSlot,
//               home:{name,score}, away:{name,score}, status, winnerSide,
//               closedEarly, canSelectWinner, homeId, awayId }]
//   fixtureHref: (matchId) => string | null
//   onSelectWinner: (match, side) => void | undefined
import { MatchBox } from './BracketChart.jsx';

// Same geometry as the other two charts, so a page that shows one format
// today and another tomorrow feels like the same app.
const BOX_W = 196;
const BOX_H = 56;
const COL_GAP = 44;
const ROW_GAP = 14;
const ROW_PITCH = BOX_H + ROW_GAP;
const TOP_MARGIN = 26;
const BOTTOM_MARGIN = 18;

function roundTitle(roundMatches, roundNumber) {
  const named = roundMatches.find((m) => m.roundLabel);
  if (named) return named.roundLabel;
  const role = roundMatches[0]?.bracketRole;
  if (role === 'grand_final') return 'Grand Final';
  if (role === 'winners') return 'Winners';
  if (role === 'losers') return 'Losers';
  return `Round ${roundNumber}`;
}

export default function AdaptiveBracketChart({ matches, fixtureHref, onSelectWinner }) {
  if (!matches || matches.length === 0) {
    return <p className="muted">No bracket to show yet.</p>;
  }

  const byRound = new Map();
  for (const m of matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b);

  // Byes are real fixtures here (they have to be - the bye is part of the
  // history the next round is computed from), so label the empty side rather
  // than leaving it blank, which would read as "waiting on an earlier round".
  const columns = rounds.map((r) => byRound.get(r).map((m) => (
    m.byeSlot ? { ...m, [m.byeSlot]: { ...m[m.byeSlot], name: 'Bye' } } : m
  )));

  const maxRows = Math.max(...columns.map((c) => c.length));
  const width = columns.length * (BOX_W + COL_GAP) - COL_GAP;
  const height = TOP_MARGIN + maxRows * ROW_PITCH - ROW_GAP + BOTTOM_MARGIN;

  const boxes = [];
  columns.forEach((roundMatches, col) => {
    const x = col * (BOX_W + COL_GAP);
    const blockH = roundMatches.length * ROW_PITCH - ROW_GAP;
    const top = TOP_MARGIN + ((maxRows * ROW_PITCH - ROW_GAP) - blockH) / 2;
    const title = roundTitle(roundMatches, rounds[col]);
    roundMatches.forEach((m, i) => {
      boxes.push(
        <MatchBox
          key={m.id}
          match={m}
          // Only the top box in each column carries the round name, so a tall
          // column doesn't repeat "Losers Round 3" six times.
          label={i === 0 ? title : ''}
          href={fixtureHref?.(m.id)}
          x={x}
          y={top + i * ROW_PITCH}
          width={BOX_W}
          height={BOX_H}
          isFinal={m.bracketRole === 'grand_final'}
          onSelectWinner={m.byeSlot ? undefined : onSelectWinner}
        />
      );
    });
  });

  return (
    <div className="bracket-chart-scroll">
      <svg className="bracket-chart bracket-chart-adaptive" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {boxes}
      </svg>
    </div>
  );
}
