// A single-elimination knockout bracket, drawn as an SVG "World Cup style"
// chart - two mirrored halves of rounds (Round of 16, Quarter-final,
// Semi-final...) converging on a Final in the centre, rather than the
// flat top-to-bottom round list used elsewhere in the app. Purely
// presentational: it takes an already-normalized list of matches and knows
// nothing about how they were fetched, so the exact same component renders
// both the authenticated division page's live embed and the public,
// unauthenticated embeddable bracket page.
//
// Why the "two halves converging on a centre Final" layout works for *any*
// bracket shape: a single-elimination bracket is a strict binary tree where
// round r's fixture at index i feeds round r+1's fixture at index
// floor(i/2) (see server/src/index.js's generateKnockoutFixtures). The
// semi-final round always has exactly 2 matches when there's more than one
// round total - one whose lineage is entirely the *left* subtree, one
// entirely the *right*. Which round-1 (and every intermediate round's)
// matches belong to which side is computed by walking that same floor(i/2)
// parent relationship backwards from the semi-final's two known boxes
// (see computeSides below) - NOT by naively cutting each round's match list
// in half. A naive half-split only produces a correct bracket when every
// round's box count is even and each side's subtree is the same depth,
// which buildBracketRounds no longer guarantees since byes are now handed
// out only where a round's box count is structurally odd (see that
// function's comment) rather than padding the whole field up to a power of
// two - so a round can have an odd box count, or one side of the draw can
// reach its final survivor in fewer real rounds than the other (that
// survivor then sits out - "bye" - in any round the other side is still
// playing catch-up), and the old half-split logic would silently misplace
// boxes and produce garbled connector lines whenever that happened.
//
// Props:
//   matches: [{ id, round, home: { name, score }, away: { name, score },
//               status, bothEntrantsKnown, winnerSide: 'home'|'away'|null,
//               closedEarly }]
//     - round is 1-indexed, 1 = first round. Order within a round must be
//       original bracket seed order (the order fixtures come back from the
//       API - nothing in this app ever reorders them).
//   totalRounds: total number of rounds (Final = totalRounds).
//   fixtureHref: (matchId) => string | null - if provided, each match box
//     links there (used to jump to the full scoring page); null/undefined
//     renders a plain, non-linked box (used on the public embed, which has
//     nowhere logged-out to send that click).
// Determines, for every round from round 1 up to (and including) the
// semi-final round, which side of the draw (0 = left, 1 = right) each of
// that round's boxes belongs to - i.e. whether its lineage eventually feeds
// the Final's home slot (semi-final box 0) or away slot (semi-final box 1).
//
// Computed top-down, one round at a time, starting from the semi-final
// (which by definition has exactly 2 boxes whenever there's more than one
// round total: box 0 = left, box 1 = right) and walking backwards via the
// exact same floor(i/2) parent-index relationship every round's fixtures
// were linked with at generation time (see generateKnockoutFixtures) - box
// i in round r belongs to whichever side box floor(i/2) in round r+1
// belongs to. Because floor(i/2) is a non-decreasing function of i, the
// resulting side assignment for every round is always a contiguous run of
// lefts followed by rights (never interleaved) - which is what lets the
// caller safely treat each side's own box list as if it were a standalone,
// self-contained bracket (consecutive local boxes (2i, 2i+1) within one
// side's list always feed that side's own next-round box i, exactly like
// columnCenters/the connector-drawing loop below assume) even though the
// two sides can have different depths or an odd box count partway through
// - e.g. one side finishing (reaching its own final survivor) in fewer
// real rounds than the other, in which case that survivor carries forward
// alone (a box with only one real feeder rather than two) through every
// round the other side is still catching up, rather than every round
// needing an equal, even box count the way a strict power-of-two bracket
// would.
function computeSides(byRound, sfRound) {
  const sidesByRound = new Map([[sfRound, [0, 1]]]);
  for (let r = sfRound - 1; r >= 1; r--) {
    const boxCount = (byRound.get(r) || []).length;
    const parentSides = sidesByRound.get(r + 1) || [];
    sidesByRound.set(r, Array.from({ length: boxCount }, (_, i) => parentSides[Math.floor(i / 2)]));
  }
  return sidesByRound;
}

export default function BracketChart({ matches, totalRounds, fixtureHref, onSelectWinner }) {
  if (!matches || matches.length === 0 || !totalRounds || totalRounds < 1) {
    return <p className="muted">No bracket to show yet.</p>;
  }

  const byRound = new Map();
  for (const m of matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  }

  const finalMatch = byRound.get(totalRounds)?.[0];
  if (!finalMatch) return <p className="muted">No bracket to show yet.</p>;

  // Single-match "tournament" (2 entrants, no earlier rounds at all) - just
  // the Final, no left/right split needed.
  if (totalRounds === 1) {
    return (
      <div className="bracket-chart bracket-chart-single">
        <MatchBox match={finalMatch} label="Final" href={fixtureHref?.(finalMatch.id)} onSelectWinner={onSelectWinner} />
      </div>
    );
  }

  const sfRound = totalRounds - 1;
  // For every round from the semi-final down to round 1, work out which
  // side (0 = left, feeds the Final's home slot; 1 = right, feeds away)
  // each of that round's boxes belongs to - see computeSides below for why
  // this has to be derived from the actual floor(i/2) parent linkage
  // rather than assumed from box counts.
  const sidesByRound = computeSides(byRound, sfRound);
  const leftRounds = [];
  const rightRounds = [];
  for (let r = 1; r <= sfRound; r++) {
    const ms = byRound.get(r) || [];
    const sides = sidesByRound.get(r) || [];
    leftRounds.push(ms.filter((_, i) => sides[i] === 0));
    rightRounds.push(ms.filter((_, i) => sides[i] === 1));
  }

  const ROUND_NAMES_FROM_FINAL = ['Final', 'Semi-final', 'Quarter-final', 'Round of 16', 'Round of 32', 'Round of 64'];
  const roundLabel = (r) => ROUND_NAMES_FROM_FINAL[totalRounds - r] || `Round ${r}`;

  // ---- Layout geometry ----
  const BOX_W = 196;
  const BOX_H = 56;
  const COL_GAP = 48;
  const ROW_MIN_GAP = 14;
  // First-round row pitch is whatever fits the tallest side's first round;
  // every later round's boxes are centred on the midpoint of the pair of
  // boxes that feed them, so the connectors always meet cleanly.
  const firstRoundCount = Math.max(leftRounds[0]?.length || 0, rightRounds[0]?.length || 0);
  const rowPitch = BOX_H + ROW_MIN_GAP;
  // Extra headroom above row 0 so the round-name label drawn above each box
  // (see MatchBox) has somewhere to go instead of being clipped by the
  // viewBox - every y-coordinate below is offset by this.
  const TOP_MARGIN = 18;
  const height = firstRoundCount * rowPitch + TOP_MARGIN;

  function columnCenters(sideRounds) {
    // Returns, for each round in this side, the y-centre of every match box
    // - round 0 (first round) evenly fills the full height; every round
    // after that is centred on its feeder box(es) from the round before.
    // Usually that's a real pair (two boxes averaging together, same as a
    // normal bracket round) - but a box can also have only ONE real feeder,
    // when this side reaches its own lone survivor before the other side
    // does (see the header comment): that survivor then carries forward,
    // unpaired, through however many more rounds the other side still
    // needs, each one a box with a single child rather than two. Handle
    // that by falling back to the one real child's y unchanged instead of
    // averaging with a second child that doesn't exist.
    const centers = [];
    sideRounds.forEach((roundMatches, r) => {
      if (r === 0) {
        const usable = height - TOP_MARGIN;
        centers.push(roundMatches.map((_, i) => TOP_MARGIN + (i + 0.5) * (usable / roundMatches.length)));
      } else {
        const prev = centers[r - 1];
        centers.push(roundMatches.map((_, i) => {
          const c1 = prev[i * 2];
          const c2 = prev[i * 2 + 1];
          return c2 === undefined ? c1 : (c1 + c2) / 2;
        }));
      }
    });
    return centers;
  }

  const leftCenters = columnCenters(leftRounds);
  const rightCenters = columnCenters(rightRounds);
  const finalY = (leftCenters[leftCenters.length - 1][0] + rightCenters[rightCenters.length - 1][0]) / 2;

  const width = (sfRound * 2 + 1) * (BOX_W + COL_GAP) - COL_GAP;
  const centerX = width / 2;

  function sideBoxX(side, r) {
    // Left side: round 0 at the far left, increasing r moves right toward
    // centre. Right side is the mirror image.
    const colFromCenter = sfRound - r; // sfRound (outermost) .. 1 (closest to centre)
    return side === 'left'
      ? centerX - BOX_W / 2 - colFromCenter * (BOX_W + COL_GAP)
      : centerX + BOX_W / 2 + (colFromCenter - 1) * (BOX_W + COL_GAP) + COL_GAP;
  }

  function connectorPath(side, x1, y1, x2, y2) {
    const midX = side === 'left' ? x1 + COL_GAP / 2 : x1 - COL_GAP / 2;
    return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
  }

  const elements = [];

  ['left', 'right'].forEach((side) => {
    const sideRounds = side === 'left' ? leftRounds : rightRounds;
    const centers = side === 'left' ? leftCenters : rightCenters;
    sideRounds.forEach((roundMatches, r) => {
      const x = sideBoxX(side, r);
      roundMatches.forEach((m, i) => {
        const y = centers[r][i];
        elements.push(
          <MatchBox
            key={m.id}
            match={m}
            label={roundLabel(m.round)}
            href={fixtureHref?.(m.id)}
            x={x}
            y={y - BOX_H / 2}
            width={BOX_W}
            height={BOX_H}
            onSelectWinner={onSelectWinner}
          />
        );
      });
      // Connectors from this round to the next (if there is one) - one
      // line per box in this round, drawn to wherever its own parent box
      // ended up (see columnCenters above - that parent might be shared
      // with a sibling box, or might be this box's only feeder if it's
      // carrying forward alone). Drawing per-source-box like this, rather
      // than assuming boxes always come in feeder pairs, is what makes
      // this correct for an odd box count too.
      if (r < sideRounds.length - 1) {
        const nextX = sideBoxX(side, r + 1);
        const boxEdgeX = side === 'left' ? x + BOX_W : x;
        const nextEdgeX = side === 'left' ? nextX : nextX + BOX_W;
        roundMatches.forEach((_, i) => {
          const y = centers[r][i];
          const parentY = centers[r + 1][Math.floor(i / 2)];
          elements.push(
            <path key={`${side}-conn-${r}-${i}`} className="bracket-connector"
              d={connectorPath(side, boxEdgeX, y, nextEdgeX, parentY)} fill="none" />
          );
        });
      } else {
        // Last column on this side -> the Final box in the centre.
        const finalX = centerX - BOX_W / 2;
        const boxEdgeX = side === 'left' ? x + BOX_W : x;
        const finalEdgeX = side === 'left' ? finalX : finalX + BOX_W;
        const y = centers[r][0];
        elements.push(
          <path key={`${side}-conn-final`} className="bracket-connector"
            d={connectorPath(side, boxEdgeX, y, finalEdgeX, finalY)} fill="none" />
        );
      }
    });
  });

  elements.push(
    <MatchBox
      key={finalMatch.id}
      match={finalMatch}
      label="Final"
      href={fixtureHref?.(finalMatch.id)}
      x={centerX - BOX_W / 2}
      y={finalY - BOX_H / 2}
      width={BOX_W}
      height={BOX_H}
      isFinal
      onSelectWinner={onSelectWinner}
    />
  );

  return (
    <div className="bracket-chart-scroll">
      <svg className="bracket-chart" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {elements}
      </svg>
    </div>
  );
}

export function MatchBox({ match, label, href, x, y, width = 176, height = 56, isFinal, onSelectWinner }) {
  const winnerSide = match.status === 'completed' ? match.winnerSide : null;
  // Only offer the "click a name to set the winner" quick-pick when a
  // handler was actually passed in (DivisionDetail only passes one for an
  // admin viewer) AND this specific match is eligible (see
  // buildBracketMatches's canSelectWinner comment - both entrants known,
  // nothing recorded against it yet).
  const selectable = !!onSelectWinner && !!match.canSelectWinner;
  // Clip the entrant rows' hover-highlight rects to the box's rounded
  // corners, so the highlight fill (see .bracket-entrant-pick-target:hover)
  // doesn't poke out past the box outline at the top/bottom edges.
  const clipId = `bracket-box-clip-${match.id}`;
  const content = (
    <g>
      <clipPath id={clipId}>
        <rect x={x} y={y} width={width} height={height} rx={6} />
      </clipPath>
      <rect
        className={`bracket-box${isFinal ? ' bracket-box-final' : ''}${match.reserved ? ' bracket-box-reserved' : ''}`}
        x={x} y={y} width={width} height={height} rx={6}
      />
      <text className="bracket-round-label" x={x + width / 2} y={y - 6} textAnchor="middle">{label}</text>
      <g clipPath={`url(#${clipId})`}>
        <EntrantRow
          entrant={match.home}
          won={winnerSide === 'home'}
          x={x} y={y} width={width} rowHeight={height / 2}
          onSelect={selectable ? () => onSelectWinner(match, 'home') : null}
        />
        <EntrantRow
          entrant={match.away}
          won={winnerSide === 'away'}
          x={x} y={y + height / 2} width={width} rowHeight={height / 2}
          onSelect={selectable ? () => onSelectWinner(match, 'away') : null}
        />
      </g>
      <line className="bracket-box-divider" x1={x} y1={y + height / 2} x2={x + width} y2={y + height / 2} />
      {match.closedEarly && (
        <text className="bracket-closed-early" x={x + width / 2} y={y + height + 12} textAnchor="middle">closed early</text>
      )}
    </g>
  );
  return href ? (
    <a href={href} className="bracket-box-link">{content}</a>
  ) : content;
}

export function EntrantRow({ entrant, won, x, y, width, rowHeight, onSelect }) {
  const name = entrant?.name || 'TBD';
  // An invisible rect over the whole row, drawn under the name/score text,
  // is the actual click target - simpler and more forgiving to tap than
  // relying on SVG text glyph hit-testing. preventDefault/stopPropagation
  // here stops the enclosing MatchBox <a href> (see below) from also
  // navigating to the fixture's full scoring page on the same click.
  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
  };
  return (
    <g>
      {won && <rect className="bracket-entrant-won-bg" x={x} y={y} width={width} height={rowHeight} />}
      {onSelect && (
        <rect
          className="bracket-entrant-pick-target"
          x={x} y={y} width={width} height={rowHeight}
          onClick={handleClick}
        >
          <title>{`Click anywhere in this box to set ${name} as the winner (no score recorded)`}</title>
        </rect>
      )}
      <text
        className={`bracket-entrant-name${won ? ' bracket-entrant-winner' : ''}${!entrant?.name ? ' bracket-entrant-tbd' : ''}`}
        x={x + 10} y={y + rowHeight / 2 + 4}
      >
        {name.length > 23 ? `${name.slice(0, 22)}…` : name}
      </text>
      {entrant?.score !== undefined && entrant?.score !== null && (
        <text className={`bracket-entrant-score${won ? ' bracket-entrant-winner' : ''}`} x={x + width - 12} y={y + rowHeight / 2 + 4} textAnchor="end">
          {entrant.score}
        </text>
      )}
    </g>
  );
}
