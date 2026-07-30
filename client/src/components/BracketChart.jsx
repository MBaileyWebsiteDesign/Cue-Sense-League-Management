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
// bracket size: a single-elimination bracket is a strict binary tree where
// round r's fixture at index i feeds round r+1's fixture at index
// floor(i/2) (see server/src/index.js's generateKnockoutFixtures). Working
// that recurrence backwards from the Final, the semi-final round always has
// exactly 2 matches - one whose lineage is entirely the *first* half of
// every earlier round's fixture list (in seed order), one entirely the
// *second* half. So splitting each round's matches down the middle and
// rendering the first half as the left-hand side, the second half as the
// right, always produces a structurally correct two-sided bracket, however
// many rounds deep it goes.
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
export default function BracketChart({ matches, totalRounds, fixtureHref }) {
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
        <MatchBox match={finalMatch} label="Final" href={fixtureHref?.(finalMatch.id)} />
      </div>
    );
  }

  const sfRound = totalRounds - 1;
  const leftRounds = [];
  const rightRounds = [];
  for (let r = 1; r <= sfRound; r++) {
    const ms = byRound.get(r) || [];
    const half = ms.length / 2;
    leftRounds.push(ms.slice(0, half));
    rightRounds.push(ms.slice(half));
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
    // after that is centred between its two feeder boxes.
    const centers = [];
    sideRounds.forEach((roundMatches, r) => {
      if (r === 0) {
        const usable = height - TOP_MARGIN;
        centers.push(roundMatches.map((_, i) => TOP_MARGIN + (i + 0.5) * (usable / roundMatches.length)));
      } else {
        const prev = centers[r - 1];
        centers.push(roundMatches.map((_, i) => (prev[i * 2] + prev[i * 2 + 1]) / 2));
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
          />
        );
      });
      // Connectors from this round to the next (if there is one).
      if (r < sideRounds.length - 1) {
        const nextX = sideBoxX(side, r + 1);
        for (let i = 0; i < roundMatches.length; i += 2) {
          const y1 = centers[r][i];
          const y2 = centers[r][i + 1];
          const boxEdgeX = side === 'left' ? x + BOX_W : x;
          const nextEdgeX = side === 'left' ? nextX : nextX + BOX_W;
          elements.push(
            <path key={`${side}-conn-${r}-${i}`} className="bracket-connector"
              d={connectorPath(side, boxEdgeX, y1, nextEdgeX, y1)} fill="none" />
          );
          elements.push(
            <path key={`${side}-conn-${r}-${i + 1}`} className="bracket-connector"
              d={connectorPath(side, boxEdgeX, y2, nextEdgeX, y2)} fill="none" />
          );
        }
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

function MatchBox({ match, label, href, x, y, width = 176, height = 56, isFinal }) {
  const winnerSide = match.status === 'completed' ? match.winnerSide : null;
  const content = (
    <g>
      <rect
        className={`bracket-box${isFinal ? ' bracket-box-final' : ''}`}
        x={x} y={y} width={width} height={height} rx={6}
      />
      <text className="bracket-round-label" x={x + width / 2} y={y - 6} textAnchor="middle">{label}</text>
      <line className="bracket-box-divider" x1={x} y1={y + height / 2} x2={x + width} y2={y + height / 2} />
      <EntrantRow entrant={match.home} won={winnerSide === 'home'} x={x} y={y} width={width} rowHeight={height / 2} />
      <EntrantRow entrant={match.away} won={winnerSide === 'away'} x={x} y={y + height / 2} width={width} rowHeight={height / 2} />
      {match.closedEarly && (
        <text className="bracket-closed-early" x={x + width / 2} y={y + height + 12} textAnchor="middle">closed early</text>
      )}
    </g>
  );
  return href ? (
    <a href={href} className="bracket-box-link">{content}</a>
  ) : content;
}

function EntrantRow({ entrant, won, x, y, width, rowHeight }) {
  const name = entrant?.name || 'TBD';
  return (
    <g>
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
