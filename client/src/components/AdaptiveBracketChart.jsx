// The bracket chart for "Adaptive Double Elimination Knockout" (ADEK).
//
// Every other double-elim chart in this app (DoubleElimBracketChart.jsx)
// draws real fixture-to-fixture wiring, because the server commits that
// wiring at generation time. ADEK never does that - each round's pairings
// are computed only once the previous round has been played (see
// appendAdaptiveRound in server/src/index.js and adaptiveDoubleElim.js),
// which is exactly what lets it guarantee nobody meets the same opponent
// twice before the Losers Final, Winners Final or Grand Final. There is no
// nextFixtureId/loserNextFixtureId to follow.
//
// What there IS, once a round has been played, is a real history: every
// match records which two entrants played and who won. That is enough to
// reconstruct the tree AFTER THE FACT - for any entrant, "the match they
// most recently appeared in" is unambiguous, so every box's true feeder(s)
// can be found by walking history backwards from that box. That is what
// findFeeders below does, and it is what turns this from a flat list of
// round columns into an actual converging bracket tree, redrawn from
// scratch on every render as new rounds are earned.
//
// Layout: Winners Bracket rounds run left-to-right, Losers Bracket rounds
// are MIRRORED - right-to-left, oldest round at the outer right edge,
// newest round nearest the centre - so both brackets converge on a single
// Grand Final in the middle, the way a traditional two-sided bracket does.
// Every connector (WB round -> WB round, LB round -> LB round, a fresh
// Winners-bracket loser dropping into the Losers bracket, or either Final
// -> Grand Final) is drawn the same solid black - unlike
// DoubleElimBracketChart's dashed "drop" variant, there's no fixed-wiring
// vs. drop-in distinction to signal here, since every link on this chart is
// reconstructed from history the same way (see findFeeders below).
//
// One honest limitation: unlike a fixed-size bracket (where both halves
// have the same number of rounds by construction), ADEK's Winners and
// Losers brackets essentially never have equal round counts - the Losers
// bracket typically runs noticeably MORE rounds than the Winners bracket,
// because it only plays once its pool is big enough to pair cleanly (see
// paceSaysLb/bestLbPlan in adaptiveDoubleElim.js). So this chart converges
// on a centred Grand Final, but it will rarely look as evenly symmetric as
// a single-elimination bracket - that asymmetry is a real property of the
// format, not a layout bug.
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
const COL_GAP = 48;
const ROW_GAP = 14;
const ROW_PITCH = BOX_H + ROW_GAP;
const TOP_MARGIN = 18;

function colX(i) {
  return i * (BOX_W + COL_GAP);
}

function groupByRoundSorted(list) {
  const byRound = new Map();
  for (const m of list) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }
  return [...byRound.keys()].sort((a, b) => a - b).map((r) => byRound.get(r));
}

function roundTitle(roundMatches, roundNumber) {
  const named = roundMatches.find((m) => m.roundLabel);
  if (named) return named.roundLabel;
  const role = roundMatches[0]?.bracketRole;
  if (role === 'grand_final') return 'Grand Final';
  if (role === 'winners') return 'Winners';
  if (role === 'losers') return 'Losers';
  return `Round ${roundNumber}`;
}

// Same safety pass DoubleElimBracketChart uses: two boxes in the same
// column can end up with the same (or too-close) feeder-derived y, so this
// nudges them apart after the fact rather than trying to prevent it up
// front.
function resolveRoundOverlaps(roundMatches, yById) {
  const order = [...roundMatches].sort((a, b) => yById.get(a.id) - yById.get(b.id));
  for (let i = 1; i < order.length; i++) {
    const minY = yById.get(order[i - 1].id) + ROW_PITCH;
    if (yById.get(order[i].id) < minY) yById.set(order[i].id, minY);
  }
}

export default function AdaptiveBracketChart({ matches, fixtureHref, onSelectWinner }) {
  if (!matches || matches.length === 0) {
    return <p className="muted">No bracket to show yet.</p>;
  }

  // Byes are real fixtures here (they have to be - the bye is part of the
  // history the next round is computed from), so label the empty side
  // rather than leaving it blank, which would read as "waiting on an
  // earlier round".
  const withByeNames = matches.map((m) => (
    m.byeSlot ? { ...m, [m.byeSlot]: { ...m[m.byeSlot], name: 'Bye' } } : m
  ));

  const wbRounds = groupByRoundSorted(withByeNames.filter((m) => m.bracketRole === 'winners'));
  const lbRounds = groupByRoundSorted(withByeNames.filter((m) => m.bracketRole === 'losers'));
  const grandFinal = withByeNames.find((m) => m.bracketRole === 'grand_final');

  if (wbRounds.length === 0) {
    return <p className="muted">No bracket to show yet.</p>;
  }

  // For any entrant, the match they most recently appeared in before round
  // `beforeRound` - WB or LB, real match or bye - is that box's feeder,
  // regardless of which bracket it was in. That single rule reconstructs
  // both same-bracket advancement AND a fresh Winners-bracket loser's
  // first appearance in the Losers bracket, with no separate cross-bracket
  // bookkeeping needed. Round numbers are assigned in strict play order by
  // appendAdaptiveRound (server-side), so sorting by round and keeping the
  // last match before `beforeRound` that an entrant appeared in finds it.
  const chronological = [...withByeNames].sort((a, b) => a.round - b.round);
  function feederFor(entrantId, beforeRound) {
    if (!entrantId) return null;
    let found = null;
    for (const m of chronological) {
      if (m.round >= beforeRound) break;
      if (m.homeId === entrantId || m.awayId === entrantId) found = m;
    }
    return found;
  }

  const xById = new Map();
  const yById = new Map();
  const feedersById = new Map();

  // ---- Winners Bracket: left-to-right, converging toward the Grand Final.
  // Round 0 fills the block's height evenly; every later round centres
  // each box on its real feeder(s) (see feederFor above).
  const wbHeight = wbRounds[0].length * ROW_PITCH;
  wbRounds.forEach((roundMatches, r) => {
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(r));
      const feeders = [feederFor(m.homeId, m.round), feederFor(m.awayId, m.round)].filter(Boolean);
      feedersById.set(m.id, feeders);
      const y = feeders.length
        ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
        : TOP_MARGIN + (i + 0.5) * (wbHeight / roundMatches.length);
      yById.set(m.id, y);
    });
    resolveRoundOverlaps(roundMatches, yById);
  });

  // ---- Grand Final column: always immediately after the Winners Bracket's
  // last round, with no gap - that's what keeps this a true mirror. (An
  // earlier version of this chart used max(wbRounds.length, lbRounds.length)
  // here, which is wrong: since the Losers Bracket almost always runs MORE
  // rounds than the Winners Bracket - see the header comment - that left a
  // dead gap of empty columns between the Winners Bracket and the Grand
  // Final every time. Anchoring on the Winners Bracket alone, and letting
  // the mirrored Losers Bracket below extend outward from the Grand Final
  // by however many rounds it actually has, is what makes both sides read
  // as a real mirror regardless of which one has more rounds.)
  const gfCol = wbRounds.length;

  // ---- Losers Bracket: MIRRORED - round 0 (the oldest Losers round) sits
  // at the outer right edge, and each later round moves one column closer
  // to the centre, so the block reads right-to-left even though the rounds
  // themselves are still numbered/played in the normal left-to-right time
  // order. The last Losers round drawn is always immediately to the right
  // of the Grand Final column.
  const lbHeight = lbRounds.length ? lbRounds[0].length * ROW_PITCH : 0;
  lbRounds.forEach((roundMatches, j) => {
    const col = gfCol + (lbRounds.length - j);
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(col));
      const feeders = [feederFor(m.homeId, m.round), feederFor(m.awayId, m.round)].filter(Boolean);
      feedersById.set(m.id, feeders);
      const y = feeders.length
        ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
        : TOP_MARGIN + (i + 0.5) * (lbHeight / roundMatches.length);
      yById.set(m.id, y);
    });
    resolveRoundOverlaps(roundMatches, yById);
  });

  // ---- Grand Final ----
  if (grandFinal) {
    xById.set(grandFinal.id, colX(gfCol));
    const feeders = [feederFor(grandFinal.homeId, grandFinal.round), feederFor(grandFinal.awayId, grandFinal.round)].filter(Boolean);
    feedersById.set(grandFinal.id, feeders);
    const y = feeders.length
      ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
      : TOP_MARGIN;
    yById.set(grandFinal.id, y);
  }

  const lastCol = gfCol + lbRounds.length;
  const width = colX(lastCol) + BOX_W;
  const height = Math.max(...yById.values()) + BOX_H / 2 + TOP_MARGIN;

  // Direction-aware: a Winners-bracket connector runs left-to-right, a
  // Losers-bracket (mirrored) or drop-in connector can run either way
  // depending on where the two boxes actually landed, so this picks
  // whichever pair of edges faces the other box rather than assuming a
  // fixed direction.
  function connectorPath(x1, y1, x2, y2) {
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
  }

  const boxes = [];
  const connectors = [];

  function addBox(m, label) {
    const x = xById.get(m.id);
    const y = yById.get(m.id);
    boxes.push(
      <MatchBox key={m.id} match={m} label={label} href={fixtureHref?.(m.id)}
        x={x} y={y - BOX_H / 2} width={BOX_W} height={BOX_H}
        isFinal={m.bracketRole === 'grand_final'}
        onSelectWinner={m.byeSlot ? undefined : onSelectWinner} />
    );
  }

  function addConnectors(m) {
    const feeders = feedersById.get(m.id) || [];
    const destX = xById.get(m.id);
    const destY = yById.get(m.id);
    feeders.forEach((f, i) => {
      const srcX = xById.get(f.id);
      const srcY = yById.get(f.id);
      const forward = destX >= srcX;
      const x1 = forward ? srcX + BOX_W : srcX;
      const x2 = forward ? destX : destX + BOX_W;
      // Every connector is solid black (.bracket-connector, var(--ink)) -
      // no dashed "drop-in" variant here. DoubleElimBracketChart uses a
      // dashed style for that because its wiring is fixed and genuinely
      // different in kind (advance vs. drop). Here every line is the same
      // reconstructed-from-history kind of link, so drawing some of them
      // differently would suggest a distinction that isn't real.
      connectors.push(
        <path key={`conn-${m.id}-${i}`} className="bracket-connector"
          d={connectorPath(x1, srcY, x2, destY)} fill="none" />
      );
    });
  }

  wbRounds.forEach((roundMatches, r) => {
    const title = roundTitle(roundMatches, r + 1);
    roundMatches.forEach((m) => { addBox(m, title); addConnectors(m); });
  });
  lbRounds.forEach((roundMatches, j) => {
    const title = roundTitle(roundMatches, j + 1);
    roundMatches.forEach((m) => { addBox(m, title); addConnectors(m); });
  });
  if (grandFinal) { addBox(grandFinal, 'Grand Final'); addConnectors(grandFinal); }

  return (
    <div className="bracket-chart-scroll">
      <svg className="bracket-chart bracket-chart-adaptive" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {connectors}
        {boxes}
      </svg>
    </div>
  );
}
