import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import './streamOverlay.css';

// Standalone OBS "Browser Source" scoreboard for one fixture - deliberately
// outside the normal app shell (see App.jsx): no header, no breadcrumbs, no
// login gate, transparent background, big high-contrast text designed to be
// keyed over live video rather than browsed on its own. Polls
// GET /api/overlay/fixtures/:id (a public, unauthenticated endpoint - see
// server/src/index.js) every few seconds rather than opening a websocket,
// since a stream operator just needs "close enough to live", and polling
// needs zero additional server infrastructure.
//
// Usage: add this page's URL as an OBS Browser Source, e.g.
//   https://your-deployment.example.com/overlay/<fixtureId>
// The fixture id is the same one in a normal fixture page's URL
// (/fixtures/<fixtureId>) - copy it from there.
const POLL_INTERVAL_MS = 5000;

// Win celebration: a confetti burst + the winner's name flashing, played
// once the moment a fixture is seen with a real winner (status
// 'completed', winner 'home' or 'away' - never for a draw/void result, see
// closeOutstandingFixtures). Pure CSS/JS - no animation library, matching
// the rest of this app's minimal-dependency style. `celebratedFixtureRef`
// makes sure this only plays once per fixture per page load, whether that's
// because the match finished while this overlay was already open (the
// common case - a stream operator leaves the browser source running
// through the whole match) or because the page loaded straight into an
// already-completed match.
const CELEBRATION_MS = 3400;
const CONFETTI_COLORS = ['#f94144', '#f3722c', '#f9c74f', '#90be6d', '#43aa8b', '#577590', '#f9844a', '#ffd60a'];
const CONFETTI_COUNT = 80;

function makeConfettiPieces() {
  return Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay: Math.random() * 0.5,
    duration: 2.2 + Math.random() * 1.3,
    drift: Math.round((Math.random() - 0.5) * 240),
    rotate: Math.round(Math.random() * 540),
    width: 6 + Math.random() * 6,
    height: 10 + Math.random() * 8,
  }));
}

export default function StreamOverlay() {
  const { fixtureId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [celebrating, setCelebrating] = useState(false);
  const [confettiPieces, setConfettiPieces] = useState([]);
  const mountedRef = useRef(true);
  const celebratedFixtureRef = useRef(null);
  const celebrationTimerRef = useRef(null);

  useEffect(() => {
    // Force a transparent canvas regardless of the app's normal page
    // background (styles.css sets `body { background: var(--bg) }` for
    // every other page) - restore it on unmount for tidiness, even though
    // in real OBS usage this page is never navigated away from.
    const previousBodyBackground = document.body.style.background;
    document.body.style.background = 'transparent';
    return () => {
      document.body.style.background = previousBodyBackground;
    };
  }, []);

  // A new fixture id (a stream operator swapping the overlay to a different
  // match without reloading OBS) should be able to celebrate again.
  useEffect(() => {
    celebratedFixtureRef.current = null;
    setCelebrating(false);
    clearTimeout(celebrationTimerRef.current);
  }, [fixtureId]);

  useEffect(() => {
    mountedRef.current = true;
    let timer;

    const poll = () => {
      api.getOverlayFixture(fixtureId)
        .then((result) => {
          if (!mountedRef.current) return;
          setData(result);
          setError('');
          if (
            result.status === 'completed' &&
            (result.winner === 'home' || result.winner === 'away') &&
            celebratedFixtureRef.current !== fixtureId
          ) {
            celebratedFixtureRef.current = fixtureId;
            setConfettiPieces(makeConfettiPieces());
            setCelebrating(true);
            clearTimeout(celebrationTimerRef.current);
            celebrationTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setCelebrating(false);
            }, CELEBRATION_MS);
          }
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
      clearTimeout(celebrationTimerRef.current);
    };
  }, [fixtureId]);

  // Errors and the initial load render nothing visible rather than an error
  // box - a blank transparent frame is the right failure mode for something
  // keyed live over video (an OBS operator would rather see nothing than a
  // jarring error card), but the message still renders as an HTML comment-
  // like faint corner note for debugging while setting the source up.
  if (!data) {
    return <div className="overlay-root overlay-empty">{error && <span className="overlay-debug">{error}</span>}</div>;
  }

  const raceOrLegsLabel = data.legsTotal != null
    ? `Best of ${data.legsTotal} legs`
    : data.raceTo != null
      ? `Race to ${data.raceTo}`
      : null;

  const statusClass = data.status === 'completed'
    ? 'overlay-status-completed'
    : data.status === 'in_progress'
      ? 'overlay-status-live'
      : 'overlay-status-scheduled';

  const statusLabel = data.status === 'completed'
    ? 'Final'
    : data.status === 'in_progress'
      ? 'Live'
      : 'Upcoming';

  return (
    <div className="overlay-root">
      {celebrating && <Confetti pieces={confettiPieces} />}
      <div className="overlay-card">
        <div className="overlay-header">
          <span className="overlay-competition">
            {data.leagueName}{data.divisionName ? ` · ${data.divisionName}` : ''}
          </span>
          <span className="overlay-round">{data.roundLabel}</span>
        </div>

        <div className="overlay-scoreboard">
          <Entrant entrant={data.home} highlight={data.winner === 'home'} flashing={celebrating && data.winner === 'home'} />
          <div className="overlay-vs-block">
            <span className={`overlay-status-pill ${statusClass}`}>{statusLabel}</span>
            <span className="overlay-vs">vs</span>
          </div>
          <Entrant entrant={data.away} highlight={data.winner === 'away'} flashing={celebrating && data.winner === 'away'} />
        </div>

        <div className="overlay-footer">
          {!data.bothEntrantsKnown && <span>Waiting on an earlier round</span>}
          {data.bothEntrantsKnown && data.winner === 'draw' && <span>Match drawn</span>}
          {data.bothEntrantsKnown && raceOrLegsLabel && <span>{raceOrLegsLabel}</span>}
        </div>
      </div>
    </div>
  );
}

function Entrant({ entrant, highlight, flashing }) {
  return (
    <div className={`overlay-entrant${highlight ? ' overlay-entrant-winner' : ''}`}>
      <div className={`overlay-entrant-name${flashing ? ' overlay-entrant-flash' : ''}`}>{entrant.name}</div>
      {entrant.subLabel && <div className="overlay-entrant-sub">{entrant.subLabel}</div>}
      <div className="overlay-entrant-score">{entrant.score}</div>
    </div>
  );
}

// Party-popper confetti burst - a fixed, full-viewport layer of small
// rectangles falling from just above the top edge with randomised
// horizontal position/colour/drift/rotation/timing (see makeConfettiPieces),
// each one driven entirely by a CSS animation (see streamOverlay.css) so
// there's nothing to animate from JS once the pieces are generated.
// pointer-events: none (in CSS) keeps it purely decorative.
function Confetti({ pieces }) {
  return (
    <div className="overlay-confetti" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="overlay-confetti-piece"
          style={{
            left: `${p.left}%`,
            backgroundColor: p.color,
            width: p.width,
            height: p.height,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            '--overlay-confetti-drift': `${p.drift}px`,
            '--overlay-confetti-rotate': `${p.rotate}deg`,
          }}
        />
      ))}
    </div>
  );
}
