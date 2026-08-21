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
// Columns are NOT always "Winners Round N, Losers Round N" alternating pairs.
// The engine only plays a Losers round once the Losers pool is big enough to
// pair cleanly (see paceSaysLb/bestLbPlan in adaptiveDoubleElim.js) - that's
// deliberate, not a bug, and is part of what makes the no-rematch guarantee
// possible. So it's normal to see e.g. two Winners rounds back to back before
// the first Losers round appears. Each column's own label (always exactly
// "Winners Round N" / "Losers Round N" / "Winners Final" / "Losers Final" /
// "Grand Final" - see Engine.mk() in adaptiveDoubleElim.js) is what tells the
// viewer which bracket and round they're looking at, since position alone
// doesn't.
//
// Connectors: since there's no fixed box-to-box wiring to draw (see above),
// each column-to-column gap gets a single shared vertical "trunk" with a stub
// from every box on either side into it, rather than individual per-box
// lines - that reads as "this round feeds the next" without implying a
// specific pairing that doesn't exist yet.
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
  const connectors = [];
  // Y-center of every box in every column, keyed by column index - built up
  // in the same pass as the boxes below, then used by the connector pass
  // that follows (it needs both this column's centers and the next one's).
  const colCenters = [];

  columns.forEach((roundMatches, col) => {
    const x = col * (BOX_W + COL_GAP);
    const blockH = roundMatches.length * ROW_PITCH - ROW_GAP;
    const top = TOP_MARGIN + ((maxRows * ROW_PITCH - ROW_GAP) - blockH) / 2;
    const title = roundTitle(roundMatches, rounds[col]);
    const centers = [];
    roundMatches.forEach((m, i) => {
      const y = top + i * ROW_PITCH;
      centers.push(y + BOX_H / 2);
      boxes.push(
        <MatchBox
          key={m.id}
          match={m}
          // Only the top box in each column carries the round name, so a tall
          // column doesn't repeat "Losers Round 3" six times.
          label={i === 0 ? title : ''}
          href={fixtureHref?.(m.id)}
          x={x}
          y={y}
          width={BOX_W}
          height={BOX_H}
          isFinal={m.bracketRole === 'grand_final'}
          onSelectWinner={m.byeSlot ? undefined : onSelectWinner}
        />
      );
    });
    colCenters.push(centers);
  });

  // One shared vertical trunk per column gap, with a stub from every box on
  // either side into it - see the file header comment for why this shape
  // (rather than per-box lines) is the honest way to connect rounds that
  // don't have a fixed pairing yet.
  for (let col = 0; col < columns.length - 1; col += 1) {
    const leftEdge = col * (BOX_W + COL_GAP) + BOX_W;
    const rightEdge = (col + 1) * (BOX_W + COL_GAP);
    const trunkX = (leftEdge + rightEdge) / 2;
    const leftCenters = colCenters[col];
    const rightCenters = colCenters[col + 1];
    const trunkTop = Math.min(...leftCenters, ...rightCenters);
    const trunkBottom = Math.max(...leftCenters, ...rightCenters);

    connectors.push(
      <line key={`trunk-${col}`} className="bracket-connector-adaptive"
        x1={trunkX} y1={trunkTop} x2={trunkX} y2={trunkBottom} />
    );
    leftCenters.forEach((y, i) => {
      connectors.push(
        <line key={`stub-l-${col}-${i}`} className="bracket-connector-adaptive"
          x1={leftEdge} y1={y} x2={trunkX} y2={y} />
      );
    });
    rightCenters.forEach((y, i) => {
      connectors.push(
        <line key={`stub-r-${col}-${i}`} className="bracket-connector-adaptive"
          x1={trunkX} y1={y} x2={rightEdge} y2={y} />
      );
    });
  }

  return (
    <div className="bracket-chart-scroll">
      <svg className="bracket-chart bracket-chart-adaptive" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {connectors}
        {boxes}
      </svg>
    </div>
  );
}
