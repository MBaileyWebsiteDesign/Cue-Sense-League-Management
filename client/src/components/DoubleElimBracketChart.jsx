// A double-elimination knockout bracket, drawn as an SVG chart: the Winners
// Bracket across the top, the Losers Bracket underneath, both converging
// into a Grand Final (and, if the losers-bracket champion forces a decider,
// a Bracket Reset match) on the right. Sibling to BracketChart.jsx (the
// single-elimination "two halves converging on a centre Final" chart) but
// laid out very differently, because a losers bracket isn't a clean binary
// tree - a round's boxes can be fed by the previous losers round, by fresh
// losers dropping in from the winners bracket, or (in "leftover" rounds,
// which only occur for some non-power-of-two entrant counts) purely by two
// fresh winners-bracket losers pairing off with no losers-bracket lineage
// at all. See server/src/services/bracket.js's buildDoubleElimBracket for
// the generation logic this mirrors.
//
// Unlike BracketChart (which has to reconstruct its tree shape from round
// numbers and array position alone, because the public embeddable bracket
// page it also renders never exposes fixture-to-fixture links), this chart
// is only ever shown on the authenticated division page, where every
// fixture already carries its real links: `nextFixtureId`/`nextFixtureSlot`
// (winner advances to), `loserNextFixtureId`/`loserNextFixtureSlot` (loser
// drops to, winners-bracket fixtures only) and `resetFixtureId` (grand final
// -> bracket-reset decider, once one exists). Every box is positioned and
// every connector drawn by following those real ids rather than inferring
// structure - simpler and correct for any shape, including the irregular
// "leftover" losers-bracket rounds above.
//
// Props:
//   matches: [{ id, round, bracketRole: 'winners'|'losers'|'grand_final'|
//               'grand_final_reset', nextFixtureId, loserNextFixtureId,
//               resetFixtureId, home: { name, score }, away: { name, score },
//               status, winnerSide, closedEarly }]
//     - round is whatever raw round number the fixture carries (winners and
//       losers rounds are numbered in one continuous sequence server-side -
//       see generateDoubleElimFixtures - but this component only uses round
//       numbers to group and order each bracket's own rounds, never to
//       compare across brackets, so that offset doesn't matter here).
//     - Only fixtures the caller passes in are ever referenced - if a
//       linked fixture id isn't present (e.g. a round hidden from a
//       non-admin viewer), that connector/box is simply skipped rather than
//       breaking the rest of the chart.
//   fixtureHref: (matchId) => string | null - same as BracketChart.
import { MatchBox } from './BracketChart.jsx';

function groupByRoundSorted(list) {
  const byRound = new Map();
  for (const m of list) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }
  return [...byRound.keys()].sort((a, b) => a - b).map((r) => byRound.get(r));
}

// ---- Layout geometry (shared with BracketChart's own numbers, so a page
// showing both chart types side by side over time feels consistent) ----
const BOX_W = 196;
const BOX_H = 56;
const COL_GAP = 48;
const ROW_GAP = 14;
const ROW_PITCH = BOX_H + ROW_GAP;
const TOP_MARGIN = 18;
const BRACKET_GAP = 64; // vertical gap between the Winners and Losers blocks

function colX(i) {
  return i * (BOX_W + COL_GAP);
}

// See the Losers Bracket layout comment below for why this is needed - a
// round's boxes can be positioned by two different schemes (centred on a
// real feeder vs. evenly spaced as a fallback) that don't know about each
// other, so this is a final safety pass applied to every round (Winners and
// Losers alike, though the Winners Bracket's clean binary-tree shape means
// it should never actually need to move anything) that guarantees no two
// boxes in the same column ever end up closer than one row's pitch apart.
function resolveRoundOverlaps(roundMatches, yById) {
  const order = [...roundMatches].sort((a, b) => yById.get(a.id) - yById.get(b.id));
  for (let i = 1; i < order.length; i++) {
    const minY = yById.get(order[i - 1].id) + ROW_PITCH;
    if (yById.get(order[i].id) < minY) yById.set(order[i].id, minY);
  }
}

export default function DoubleElimBracketChart({ matches, fixtureHref }) {
  if (!matches || matches.length === 0) return <p className="muted">No bracket to show yet.</p>;

  const grandFinal = matches.find((m) => m.bracketRole === 'grand_final');
  const wbRounds = groupByRoundSorted(matches.filter((m) => m.bracketRole === 'winners'));
  const lbRounds = groupByRoundSorted(matches.filter((m) => m.bracketRole === 'losers'));
  const reset = matches.find((m) => m.bracketRole === 'grand_final_reset');

  // Every one of these should exist for a genuine double-elimination
  // division once fixtures are generated - if any is missing (most likely
  // because a non-admin viewer doesn't have every round released yet), the
  // plain Winners/Losers/Grand Final fixture lists elsewhere on the page
  // remain the source of truth, so it's safer to skip the chart entirely
  // than to draw a structurally broken one.
  if (wbRounds.length === 0 || lbRounds.length === 0 || !grandFinal) {
    return <p className="muted">No bracket to show yet.</p>;
  }

  const xById = new Map();
  const yById = new Map();

  // ---- Winners Bracket: a clean binary tree, same shape as BracketChart's
  // single-elimination bracket, just laid out straight left-to-right
  // instead of split into two halves converging on a centre - there's
  // nothing here that needs to visually meet a mirrored other half. Round 0
  // fills the block's height evenly; every later round centres each box on
  // the real WB fixture(s) whose nextFixtureId points at it (1 feeder if
  // this box's lineage reached its lone survivor early and is carrying
  // forward alone, 2 for a normal pairing).
  const wbHeight = wbRounds[0].length * ROW_PITCH;
  wbRounds.forEach((roundMatches, r) => {
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(r));
      if (r === 0) {
        yById.set(m.id, TOP_MARGIN + (i + 0.5) * (wbHeight / roundMatches.length));
      } else {
        const feeders = wbRounds[r - 1].filter((f) => f.nextFixtureId === m.id);
        const y = feeders.length > 0
          ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
          : TOP_MARGIN + (i + 0.5) * (wbHeight / roundMatches.length); // defensive fallback, shouldn't happen
        yById.set(m.id, y);
      }
    });
    resolveRoundOverlaps(roundMatches, yById);
  });

  // ---- Losers Bracket: centred on losers-bracket-internal lineage only
  // (previous LB round's forward nextFixtureId link) so the block stays a
  // coherent, non-overlapping run of rows even though some of its boxes
  // also receive a fresh loser dropping in from the winners bracket far
  // above (drawn as its own cross-bracket connector below, regardless of
  // where it lands vertically). A box with no LB-internal feeder at all -
  // either round 0 (fed entirely by fresh winners-bracket losers) or a
  // "leftover" box in a merge round that pairs two fresh losers together
  // with no surviving LB lineage - falls back to even spacing within its
  // own round, the same way round 0 always does.
  const lbTop = TOP_MARGIN + wbHeight + BRACKET_GAP;
  const lbHeight = lbRounds[0].length * ROW_PITCH;
  lbRounds.forEach((roundMatches, r) => {
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(r));
      const feeder = r > 0
        ? lbRounds[r - 1].find((f) => f.bracketRole === 'losers' && f.nextFixtureId === m.id)
        : null;
      const y = feeder
        ? yById.get(feeder.id)
        : lbTop + (i + 0.5) * (lbHeight / roundMatches.length);
      yById.set(m.id, y);
    });
    // A round can mix LB-internal-feeder boxes (whose y is inherited,
    // possibly bunched together) with fallback-spaced boxes (whose y is
    // spread evenly across the whole block) - those two schemes don't
    // coordinate with each other, so two boxes can occasionally land close
    // enough to overlap. Resolve that the same way a tree layout algorithm
    // would: sort this round's boxes by whatever y they were just given,
    // then walk top-to-bottom nudging any box that's closer than a row's
    // pitch to the one above it back down until every box in the round has
    // its own clear row - a small, rare visual compromise (a box's centre
    // may end up a few pixels from its "ideal" feeder-centred position) in
    // exchange for guaranteeing boxes never sit on top of each other.
    resolveRoundOverlaps(roundMatches, yById);
  });

  // ---- Grand Final (+ Bracket Reset decider, if one exists) ----
  const gfCol = Math.max(wbRounds.length, lbRounds.length);
  const wbFinal = wbRounds[wbRounds.length - 1][0];
  const lbFinal = lbRounds[lbRounds.length - 1][0];
  xById.set(grandFinal.id, colX(gfCol));
  yById.set(grandFinal.id, (yById.get(wbFinal.id) + yById.get(lbFinal.id)) / 2);
  if (reset) {
    xById.set(reset.id, colX(gfCol + 1));
    yById.set(reset.id, yById.get(grandFinal.id));
  }

  // ---- Late-entry deciders (see appendLateEntrantBranch, server-side) ----
  // A late arrival added after this bracket was already underway gets its
  // own round-1 branch box (drawn as an ordinary Winners Bracket box above,
  // since its bracketRole is 'winners' like any other) plus a decider match
  // against whichever fixture was the current "final" at the moment they
  // were added - normally the Grand Final, but if an earlier late arrival's
  // own decider was still the current final, this one chains off THAT
  // decider instead. Sorted by round, which is always increasing along
  // that chain, so each decider is positioned only after anything it could
  // possibly depend on for its own y-centring below.
  const deciders = matches
    .filter((m) => m.bracketRole === 'late_entry_decider')
    .sort((a, b) => a.round - b.round);
  let deciderCol = gfCol + (reset ? 2 : 1);
  deciders.forEach((d) => {
    xById.set(d.id, colX(deciderCol));
    deciderCol += 1;
    // Whichever already-positioned fixture feeds this decider that *isn't*
    // the round-1 branch (the Grand Final, a Bracket Reset, or an earlier
    // decider) is the one worth lining up with vertically - the branch
    // itself lives all the way back in round 1, so its own connector below
    // is just a long line in from the left regardless of where this box
    // ends up centred.
    const feeders = matches.filter((m) => m.nextFixtureId === d.id && yById.has(m.id));
    const mainFeeder = feeders.find((f) => f.bracketRole !== 'winners') || feeders[0];
    yById.set(d.id, mainFeeder ? yById.get(mainFeeder.id) : yById.get(grandFinal.id));
  });
  const lastCol = deciders.length > 0 ? deciderCol - 1 : gfCol + (reset ? 1 : 0);

  const width = colX(lastCol) + BOX_W;
  // Computed from actual box positions, not the Winners/Losers block
  // heights planned above - resolveRoundOverlaps can push a box's y past
  // where those numbers alone would predict.
  const height = Math.max(...yById.values()) + BOX_H / 2 + TOP_MARGIN / 2;

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
        x={x} y={y - BOX_H / 2} width={BOX_W} height={BOX_H} />
    );
  }

  function addConnector(key, sourceId, destId, className = 'bracket-connector') {
    const x1 = xById.get(sourceId);
    const y1 = yById.get(sourceId);
    const x2 = xById.get(destId);
    const y2 = yById.get(destId);
    if (x1 === undefined || x2 === undefined) return; // destination not in the visible fixture set - skip
    connectors.push(
      <path key={key} className={className}
        d={connectorPath(x1 + BOX_W, y1, x2, y2)} fill="none" />
    );
  }

  wbRounds.forEach((roundMatches, r) => {
    const label = r === wbRounds.length - 1 ? 'WB Final' : `WB Round ${r + 1}`;
    roundMatches.forEach((m) => {
      addBox(m, label);
      if (m.nextFixtureId) addConnector(`wb-${m.id}`, m.id, m.nextFixtureId);
      if (m.loserNextFixtureId) addConnector(`wb-lose-${m.id}`, m.id, m.loserNextFixtureId, 'bracket-connector bracket-connector-cross');
    });
  });

  lbRounds.forEach((roundMatches, r) => {
    const label = r === lbRounds.length - 1 ? 'LB Final' : `LB Round ${r + 1}`;
    roundMatches.forEach((m) => {
      addBox(m, label);
      if (m.nextFixtureId) addConnector(`lb-${m.id}`, m.id, m.nextFixtureId);
    });
  });

  addBox(grandFinal, 'Grand Final');
  if (grandFinal.resetFixtureId) addConnector('gf-reset', grandFinal.id, grandFinal.resetFixtureId);
  // The Grand Final was still the current final when a late arrival was
  // added (see appendLateEntrantBranch) - this is the one connector type
  // that section of that function's caller can leave wired here rather
  // than on a bracket-reset decider (see the 'reset-late' connector below).
  if (grandFinal.nextFixtureId) addConnector('gf-late', grandFinal.id, grandFinal.nextFixtureId, 'bracket-connector bracket-connector-cross');
  if (reset) {
    addBox(reset, 'Bracket Reset');
    if (reset.nextFixtureId) addConnector('reset-late', reset.id, reset.nextFixtureId, 'bracket-connector bracket-connector-cross');
  }

  deciders.forEach((d, i) => {
    addBox(d, deciders.length === 1 ? 'Late Entry Decider' : `Late Entry Decider ${i + 1}`);
    // Chains to whichever decider came after it, if a further late arrival
    // was added before this one's match was played.
    if (d.nextFixtureId) addConnector(`late-${d.id}`, d.id, d.nextFixtureId, 'bracket-connector bracket-connector-cross');
  });

  return (
    <div className="bracket-chart-scroll">
      <svg className="bracket-chart bracket-chart-double" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {connectors}
        {boxes}
      </svg>
    </div>
  );
}
