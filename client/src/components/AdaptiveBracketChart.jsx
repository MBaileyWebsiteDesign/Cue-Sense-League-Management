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
// feederFor below does, and it is what turns this from a flat list of round
// columns into an actual converging bracket tree, redrawn from scratch on
// every render as new rounds are earned.
//
// Layout: Winners Bracket rounds run left-to-right, Losers Bracket rounds
// are MIRRORED - right-to-left, oldest round at the outer right edge, newest
// round nearest the centre - so both brackets converge on a single Grand
// Final in the middle, the way a traditional two-sided bracket does. Both
// halves are drawn to the SAME vertical extent and centred against each
// other, so the two sides carry equal visual weight even though the Losers
// bracket holds fewer matches per round.
//
// The one thing this layout deliberately does NOT draw is the drop-in link
// from a Winners-bracket match to the Losers-bracket match its loser lands
// in. In a mirrored chart those two boxes sit at opposite ends of the page -
// a Winners Round 1 box is in the leftmost column, the Losers Round 1 box its
// loser drops into is in the RIGHTMOST column - so every one of those links
// would be a full-width line cutting straight across the middle of the chart.
// With a dozen entrants that is ten-plus lines spanning eleven columns each,
// which is what made an earlier version of this chart unreadable. So each
// bracket is positioned and wired from its OWN history only (see the
// roleFilter argument to feederFor), exactly like the two halves of the
// traditional two-sided bracket this is modelled on, and the only links
// crossing the centre are the two that belong there: Winners Final -> Grand
// Final and Losers Final -> Grand Final. A losers-bracket box whose entrants
// have both just dropped in from the winners bracket therefore starts a fresh
// line, with no incoming connector - the same way a first-round box does.
//
// Every connector is drawn the same solid black. Unlike
// DoubleElimBracketChart, which has genuinely different kinds of wiring to
// signal (fixed advance vs. drop), every line here is the same
// reconstructed-from-history kind of link, so drawing some of them
// differently would suggest a distinction that isn't real.
//
// One honest limitation: unlike a fixed-size bracket (where both halves have
// the same number of rounds by construction), ADEK's Winners and Losers
// brackets essentially never have equal round counts - the Losers bracket
// typically runs noticeably MORE rounds than the Winners bracket, because it
// only plays once its pool is big enough to pair cleanly (see
// paceSaysLb/bestLbPlan in adaptiveDoubleElim.js). So this chart converges on
// a centred Grand Final, but the right-hand side will usually be longer than
// the left - that asymmetry is a real property of the format, not a layout
// bug.
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
  // `beforeRound` is that box's feeder. Round numbers are assigned in strict
  // play order by appendAdaptiveRound (server-side) across BOTH brackets
  // combined, so scanning in round order and keeping the last match the
  // entrant appeared in finds it.
  //
  // `roleFilter` restricts that search to one bracket. Each bracket is laid
  // out and wired from its own history only, so that the mirrored halves read
  // as two converging trees instead of being stitched together by full-width
  // drop-in lines (see the header comment). Passing null considers both
  // brackets, which is what the Grand Final needs.
  const chronological = [...withByeNames].sort((a, b) => a.round - b.round);
  function feederFor(entrantId, beforeRound, roleFilter) {
    if (!entrantId) return null;
    let found = null;
    for (const m of chronological) {
      if (m.round >= beforeRound) break;
      if (roleFilter && m.bracketRole !== roleFilter) continue;
      if (m.homeId === entrantId || m.awayId === entrantId) found = m;
    }
    return found;
  }

  // Both sides of a box can trace back to the same feeder (a Grand Final
  // reached without a Losers Final ever being played, for instance), and one
  // link should only be drawn once.
  function feedersOf(m, roleFilter) {
    return [...new Set([
      feederFor(m.homeId, m.round, roleFilter),
      feederFor(m.awayId, m.round, roleFilter),
    ].filter(Boolean))];
  }

  const xById = new Map();
  const yById = new Map();
  const feedersById = new Map();

  // Places one round's boxes: each box centres on its own feeders, and a box
  // with none (a first round, or a losers box made entirely of fresh drop-ins)
  // falls back to an even share of the band [blockTop, blockTop + blockHeight].
  function placeRound(roundMatches, col, roleFilter, blockTop, blockHeight) {
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(col));
      const feeders = feedersOf(m, roleFilter);
      feedersById.set(m.id, feeders);
      const y = feeders.length
        ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
        : blockTop + (i + 0.5) * (blockHeight / roundMatches.length);
      yById.set(m.id, y);
    });
    resolveRoundOverlaps(roundMatches, yById);
  }

  // ---- Winners Bracket: left-to-right, converging toward the Grand Final.
  const wbHeight = wbRounds[0].length * ROW_PITCH;
  wbRounds.forEach((roundMatches, r) => placeRound(roundMatches, r, 'winners', TOP_MARGIN, wbHeight));

  // ---- Grand Final column: always immediately after the Winners Bracket's
  // last round, with no gap. Anchoring on the Winners Bracket alone (rather
  // than on max(wbRounds, lbRounds), which an earlier version used) is what
  // keeps the centre where it belongs: because the Losers Bracket almost
  // always runs MORE rounds, taking the max left a dead gap of empty columns
  // between the Winners Bracket and the Grand Final. The mirrored Losers
  // Bracket below extends outward from the Grand Final by however many rounds
  // it actually has, so both sides meet in the middle either way.
  const gfCol = wbRounds.length;

  // The Winners Bracket's vertical extent is the reference BOTH halves are
  // drawn to. Sizing the Losers block off its own first round instead (which
  // an earlier version did) is what made the right-hand side look squashed:
  // the Losers bracket's opening round pairs up Winners-bracket losers, so it
  // has at most half as many matches, and half the matches at the same row
  // pitch means half the height - a thin strip of boxes facing a full-height
  // fan on the left.
  const wbYs = wbRounds.flat().map((m) => yById.get(m.id));
  const wbTop = Math.min(...wbYs);
  const wbSpan = Math.max(...wbYs) - wbTop;

  // ---- Losers Bracket: MIRRORED - the oldest Losers round sits at the outer
  // right edge and each later round moves one column closer to the centre, so
  // the block reads right-to-left even though the rounds are still played in
  // the normal time order. The newest Losers round drawn always ends up
  // immediately to the right of the Grand Final column.
  lbRounds.forEach((roundMatches, j) => {
    const col = gfCol + (lbRounds.length - j);
    if (j > 0) {
      placeRound(roundMatches, col, 'losers', wbTop, wbSpan);
      return;
    }
    // The outermost Losers round is usually the one that sets the block's
    // height, so it is spread edge to edge across the Winners Bracket's extent
    // rather than packed at the row pitch - top box level with the top of the
    // Winners bracket, bottom box level with its bottom. Everything inward of
    // it then converges on its own feeders as usual. Spacing only ever widens
    // here (this round can never hold more boxes than the Winners opening
    // round), so boxes cannot be pushed together by this.
    roundMatches.forEach((m, i) => {
      xById.set(m.id, colX(col));
      feedersById.set(m.id, feedersOf(m, 'losers'));
      yById.set(m.id, roundMatches.length === 1
        ? wbTop + wbSpan / 2
        : wbTop + i * (wbSpan / (roundMatches.length - 1)));
    });
    resolveRoundOverlaps(roundMatches, yById);
  });

  // ---- Match the two blocks' heights, then centre them against each other.
  //
  // Spreading the outermost Losers round (above) covers the usual case, but it
  // is not always the widest one: the Losers bracket can open with a single
  // match and only widen a round or two later, once more Winners-bracket
  // losers have dropped in. When that happens the block still comes up short,
  // so it is stretched about its own middle until it spans the same height as
  // the Winners block. This only ever expands (never compresses), so it cannot
  // push boxes into each other.
  if (lbRounds.length) {
    const lbIds = lbRounds.flat().map((m) => m.id);
    let lbYs = lbIds.map((id) => yById.get(id));
    const lbLo = Math.min(...lbYs), lbHi = Math.max(...lbYs);
    const lbSpan = lbHi - lbLo;
    if (lbSpan > 1 && lbSpan < wbSpan) {
      const scale = wbSpan / lbSpan;
      const mid = (lbLo + lbHi) / 2;
      for (const id of lbIds) yById.set(id, mid + (yById.get(id) - mid) * scale);
      lbYs = lbIds.map((id) => yById.get(id));
    }
    const delta = (wbTop + wbSpan / 2)
                - ((Math.min(...lbYs) + Math.max(...lbYs)) / 2);
    for (const id of lbIds) yById.set(id, yById.get(id) + delta);
  }

  // ---- Grand Final: sits between the two finals that feed it, so it needs to
  // see both brackets (hence no role filter).
  if (grandFinal) {
    xById.set(grandFinal.id, colX(gfCol));
    const feeders = feedersOf(grandFinal, null);
    feedersById.set(grandFinal.id, feeders);
    const y = feeders.length
      ? feeders.reduce((sum, f) => sum + yById.get(f.id), 0) / feeders.length
      : TOP_MARGIN;
    yById.set(grandFinal.id, y);
  }

  // Centring can lift a block above the top edge; slide everything back down
  // together rather than clipping it.
  const minY = Math.min(...yById.values());
  const needY = TOP_MARGIN + BOX_H / 2;
  if (minY < needY) {
    const shift = needY - minY;
    for (const [id, y] of yById) yById.set(id, y + shift);
  }

  const lastCol = gfCol + lbRounds.length;
  const width = colX(lastCol) + BOX_W;
  const height = Math.max(...yById.values()) + BOX_H / 2 + TOP_MARGIN;

  // Direction-aware: a Winners-bracket connector runs left-to-right while a
  // mirrored Losers-bracket one runs right-to-left, so this picks whichever
  // pair of edges faces the other box rather than assuming a fixed direction.
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
