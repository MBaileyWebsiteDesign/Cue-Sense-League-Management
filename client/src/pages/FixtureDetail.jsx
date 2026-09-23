import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import {
  enqueueFrame,
  enqueueLegFrame,
  newRequestId,
  reattachFixture,
  applyOptimisticFrame,
  rollbackOptimisticFrame,
} from '../scoringQueue.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { useIsAdminSession } from '../useAdminSession.js';
import { useAuth } from '../AuthContext.jsx';
import { formatFixtureDate } from '../components/StatsUI.jsx';

// Shared "submitted, awaiting confirmation / disputed" banner + action
// buttons for a result that's reached the submit -> confirm handshake (see
// server/src/index.js's "Result confirmation" section for the full design).
// BOTH the home and away entrant have to independently confirm before a
// result finalizes - `isHomeEntrant`/`isAwayEntrant` say which side (if any)
// the viewer is, and `homeConfirmed`/`awayConfirmed` say where each side
// currently stands.
function ResultConfirmationPanel({
  status, isAdmin, isHomeEntrant, isAwayEntrant, homeConfirmed, awayConfirmed,
  onConfirm, onDispute, onReopen, homeLabel, awayLabel, disputeReason, leagueManagers,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Disputing always requires a short explanation - it's the context an
  // admin has to work from when resolving it in Game Adjustments, so the
  // form won't submit without one.
  const submitDispute = async () => {
    if (!reason.trim()) {
      setError('Please explain why you’re disputing this result.');
      return;
    }
    await run(() => onDispute(reason.trim()));
    setDisputing(false);
    setReason('');
  };

  if (status === 'pending_confirmation') {
    const canAct = isAdmin || isHomeEntrant || isAwayEntrant;
    const myConfirmed = !isAdmin && ((isHomeEntrant && homeConfirmed) || (isAwayEntrant && awayConfirmed));
    return (
      <section className="card">
        <p className="banner" style={{ background: '#dbeafe', color: '#1e40af' }}>
          Result submitted - both players need to confirm the score before it counts.{' '}
          {homeLabel} confirmed: <strong>{homeConfirmed ? 'Yes' : 'Not yet'}</strong> · {awayLabel} confirmed: <strong>{awayConfirmed ? 'Yes' : 'Not yet'}</strong>
        </p>
        {error && <p className="error">{error}</p>}
        {canAct ? (
          myConfirmed ? (
            <p className="muted">You’ve confirmed this result - waiting on the other player to confirm too.</p>
          ) : disputing ? (
            <div className="inline-form" style={{ flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Why are you disputing this result?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ flex: '1 1 240px' }}
                autoFocus
              />
              <button className="btn btn-primary" disabled={busy} onClick={submitDispute}>Submit Dispute</button>
              <button className="btn" disabled={busy} onClick={() => { setDisputing(false); setReason(''); setError(''); }}>Cancel</button>
            </div>
          ) : (
            <div className="inline-form">
              <button className="btn btn-primary" disabled={busy} onClick={() => run(onConfirm)}>Confirm Result</button>
              <button className="btn" disabled={busy} onClick={() => setDisputing(true)}>Dispute Result</button>
            </div>
          )
        ) : (
          <p className="muted">Waiting on {homeLabel} and {awayLabel} to both confirm this result.</p>
        )}
        {isAdmin && (
          <p className="muted" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy} onClick={() => run(onReopen)}>Reopen for scoring</button>
          </p>
        )}
      </section>
    );
  }

  if (status === 'disputed') {
    return (
      <section className="card">
        <p className="banner" style={{ background: '#fee2e2', color: '#991b1b' }}>
          This result is disputed - an admin needs to resolve it, either by overriding the
          score directly or reopening it for further scoring. Please contact{' '}
          {leagueManagers && leagueManagers.length > 0
            ? leagueManagers.map((m, i) => (
                <span key={m.email}>
                  {i > 0 && (i === leagueManagers.length - 1 ? ' or ' : ', ')}
                  <a href={`mailto:${m.email}`} style={{ color: 'inherit', textDecoration: 'underline' }}>{m.name}</a>
                </span>
              ))
            : 'your League Manager'}{' '}
          if this hasn't been actioned after 7 days.
        </p>
        {disputeReason && (
          <p className="muted"><strong>Reason given:</strong> {disputeReason}</p>
        )}
        {error && <p className="error">{error}</p>}
        {isAdmin && (
          <button className="btn" disabled={busy} onClick={() => run(onReopen)}>Reopen for scoring</button>
        )}
      </section>
    );
  }

  return null;
}

// "Non-contactable / No Show" button - lets a player report their opponent
// as unreachable, claiming a 0-0-frames game win pending admin authorisation
// (see POST .../no-show / .../no-show/authorize in server/src/index.js).
// Only shown to an actual entrant of the fixture/leg, and only while it's
// still open for scoring (not already submitted, completed, or disputed).
function NoShowClaimButton({ onClaim }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onClaim();
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, marginBottom: 16, textAlign: 'center' }}>
      {error && <p className="error">{error}</p>}
      {open ? (
        <div className="inline-form" style={{ flexWrap: 'wrap' }}>
          <span className="muted" style={{ flex: '1 1 320px' }}>
            This reports your opponent as non-contactable / a no-show, claiming a 0-0 walkover win for
            you - an admin has to authorise it before it counts.
          </span>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Reporting…' : 'Confirm report'}
          </button>
          <button className="btn" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn-danger" onClick={() => setOpen(true)}>Non-contactable / No Show</button>
      )}
    </div>
  );
}

function AdminOverridePanel({ fixture, isTeams, isDoubles, onChange }) {
  const homeName = isTeams ? fixture.homeTeam?.name : isDoubles ? fixture.homePairing?.name : fixture.homePlayer?.name;
  const awayName = isTeams ? fixture.awayTeam?.name : isDoubles ? fixture.awayPairing?.name : fixture.awayPlayer?.name;
  const [homeScore, setHomeScore] = useState(String(isTeams ? fixture.homeLegsWon ?? 0 : fixture.homeFrameScore ?? 0));
  const [awayScore, setAwayScore] = useState(String(isTeams ? fixture.awayLegsWon ?? 0 : fixture.awayFrameScore ?? 0));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);

  if (!fixture.bothEntrantsKnown) return null;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      await api.overrideFixture(fixture.id, Number(homeScore), Number(awayScore));
      setSuccess('Result overridden.');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Admin: Override Result</h2>
        <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          <p className="muted">
            Directly sets the final score, bypassing frame-by-frame play. Use to correct mistakes.
            {fixture.adminOverride && (
              <> Last overridden by <strong>{fixture.adminOverride.by}</strong> at {new Date(fixture.adminOverride.at).toLocaleString()}.</>
            )}
          </p>
          <form className="inline-form" onSubmit={onSubmit}>
            <label>
              {homeName || 'Home'}
              <input type="number" min="0" value={homeScore} onChange={(e) => setHomeScore(e.target.value)} required />
            </label>
            <label>
              {awayName || 'Away'}
              <input type="number" min="0" value={awayScore} onChange={(e) => setAwayScore(e.target.value)} required />
            </label>
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Override Score'}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          {success && <p className="banner banner-success">{success}</p>}
        </>
      )}
    </section>
  );
}

// Shows the OBS Browser Source URL for this fixture's stream overlay
// (StreamOverlay.jsx / GET /api/overlay/fixtures/:id - see that page for the
// design notes) with a one-click copy button, so an admin can grab the link
// without hand-editing a URL. Admin-only since it's a broadcast-setup tool,
// not something a spectator needs.
function StreamOverlayLink({ fixtureId }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/overlay/${fixtureId}`;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked (insecure context, permissions) -
      // the URL is still selectable/copyable by hand in that case.
    }
  };

  return (
    <p className="muted" style={{ fontSize: '0.85rem' }}>
      Stream overlay (OBS Browser Source): <code style={{ wordBreak: 'break-all' }}>{url}</code>{' '}
      <button className="btn" type="button" onClick={onCopy}>
        {copied ? 'Copied!' : 'Copy link'}
      </button>
    </p>
  );
}

function LegNominationForm({ fixture, leg, onChange, setError }) {
  const [homePlayerId, setHomePlayerId] = useState('');
  const [awayPlayerId, setAwayPlayerId] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.nominateLeg(fixture.id, leg.legNumber, homePlayerId, awayPlayerId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <select value={homePlayerId} onChange={(e) => setHomePlayerId(e.target.value)} required>
        <option value="" disabled>{fixture.homeTeam.name} player…</option>
        {fixture.homeTeam.players.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <span className="muted">vs</span>
      <select value={awayPlayerId} onChange={(e) => setAwayPlayerId(e.target.value)} required>
        <option value="" disabled>{fixture.awayTeam.name} player…</option>
        {fixture.awayTeam.players.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button className="btn btn-primary" type="submit">Nominate</button>
    </form>
  );
}

function LegRow({ fixture, leg, onChange, setError, onOptimisticLegFrame, onRollbackLegFrame }) {
  const { user, isAdmin } = useAuth();
  const complete = leg.status === 'completed';
  const locked = complete || leg.status === 'pending_confirmation' || leg.status === 'disputed' || !fixture.canControl;
  const raceTargetReached = leg.status === 'in_progress' && (leg.homeFrameScore >= leg.raceTo || leg.awayFrameScore >= leg.raceTo);
  const isHomeNominee = !!user?.playerId && user.playerId === leg.homePlayerId;
  const isAwayNominee = !!user?.playerId && user.playerId === leg.awayPlayerId;
  const canReportNoShow = (isHomeNominee || isAwayNominee) && ['scheduled', 'in_progress'].includes(leg.status) && leg.frames.length === 0;

  // Records which player won the lag and broke to start the frame currently
  // being played. Purely informational (frame history only) - doesn't award
  // a frame win by itself, so it's tracked locally here and only sent along
  // once the frame's actual winner is recorded (Frame won/BND/RND below).
  const [breakerId, setBreakerId] = useState(null);
  const onSelectBreaker = (playerId) => {
    setBreakerId((cur) => (cur === playerId ? null : playerId));
  };
  // True while a frame recording for this leg is queued/in flight (see
  // scoringQueue.js) - guards the frame-win buttons against a double tap
  // recording the same frame twice while a slow request is still pending.
  const [framePending, setFramePending] = useState(false);

  // Alternative breaking: see the matching computation in SinglesFixtureView
  // above - same logic, scoped to this leg's own frames/players.
  const currentBreakerId = leg.alternativeBreaking
    ? (() => {
        const lastBreakerFrame = [...leg.frames].reverse().find((f) => f.breakerPlayerId);
        // No frame's breaker recorded yet - the lag decides who breaks
        // frame 1, so there's nothing to show until that's set.
        return lastBreakerFrame
          ? (lastBreakerFrame.breakerPlayerId === leg.homePlayerId ? leg.awayPlayerId : leg.homePlayerId)
          : null;
      })()
    : null;
  // See the matching const in SinglesFixtureView above for what this does.
  const breakOrderLocked = leg.alternativeBreaking && leg.frames.some((f) => f.breakerPlayerId);

  const onToggleAlternativeBreaking = async () => {
    setError('');
    try {
      await api.setLegAlternativeBreaking(fixture.id, leg.legNumber, !leg.alternativeBreaking);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onRecord = (winnerPlayerId, method) => {
    setError('');
    const clientRequestId = newRequestId();
    const chosenBreaker = breakerId || undefined;
    setBreakerId(null);
    setFramePending(true);
    // Optimistic UI: show the frame's effect on the scoreboard immediately,
    // before the network request (queued below, with automatic retry on a
    // slow/dropped connection) actually confirms it - reconciled with the
    // server's real state once the request succeeds, or rolled back if it's
    // definitively rejected.
    onOptimisticLegFrame(leg.legNumber, { winnerPlayerId, method, breaker: chosenBreaker, clientRequestId });
    enqueueLegFrame({
      fixtureId: fixture.id,
      legNumber: leg.legNumber,
      winnerPlayerId,
      method,
      breaker: chosenBreaker,
      clientRequestId,
      onSettled: (err) => {
        setFramePending(false);
        if (err) {
          onRollbackLegFrame(leg.legNumber, clientRequestId);
          setError(err.message);
        } else {
          onChange();
        }
      },
    });
  };

  const onUndo = async () => {
    setError('');
    try {
      await api.undoLastLegFrame(fixture.id, leg.legNumber);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onSubmitResult = async () => {
    setError('');
    try {
      await api.submitLegResult(fixture.id, leg.legNumber);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="card">
      <div className="page-header">
        <h3 style={{ margin: 0 }}>Leg {leg.legNumber}</h3>
        <span className={`status status-${leg.status === 'pending' ? 'scheduled' : leg.status}`}>
          {leg.status === 'pending' ? 'not nominated' : leg.status.replace('_', ' ')}
        </span>
      </div>

      {leg.status === 'pending' ? (
        fixture.canControl
          ? <LegNominationForm fixture={fixture} leg={leg} onChange={onChange} setError={setError} />
          : <p className="muted">Waiting for a player in this fixture to nominate players for this leg.</p>
      ) : (
        <>
          {framePending && (
            <p className="muted">
              {typeof navigator !== 'undefined' && navigator.onLine === false
                ? 'Offline - this frame will be recorded automatically once you\'re back online.'
                : 'Saving frame\u2026'}
            </p>
          )}
          <div className="scoreboard">
            <div className={`scoreboard-player${currentBreakerId ? (currentBreakerId === leg.homePlayerId ? ' scoreboard-player-breaking' : ' scoreboard-player-not-breaking') : ''}`}>
              <h2><Link to={`/players/${leg.homePlayerId}`}>{leg.homePlayer.name}</Link></h2>
              <div className="score">{leg.homeFrameScore}</div>
              <button className="btn btn-primary" disabled={locked || framePending} onClick={() => onRecord(leg.homePlayerId)}>
                Frame won
              </button>
              <div className="inline-form" style={{ justifyContent: 'center', marginTop: 6 }}>
                <button
                  className="btn btn-yellow"
                  disabled={locked || framePending}
                  title="Break and Dish - breaks and clears every ball including the black without missing a shot; the other side gets no visit to the table."
                  onClick={() => onRecord(leg.homePlayerId, 'bnd')}
                >
                  BND
                </button>
                <button
                  type="button"
                  className={`btn btn-break${breakerId === leg.homePlayerId ? ' btn-break-selected' : ''}`}
                  disabled={locked || breakOrderLocked}
                  title="Record that this player won the lag and broke to start this frame. Doesn't award a frame win by itself - record the winner as usual once the frame is played."
                  onClick={() => onSelectBreaker(leg.homePlayerId)}
                >
                  {breakerId === leg.homePlayerId ? 'Breaking \u2713' : 'Break'}
                </button>
                <button
                  className="btn btn-yellow"
                  disabled={locked || framePending}
                  title="Reverse Break and Dish - the breaker misses at some point, then this player clears every ball including the black on their first visit without missing."
                  onClick={() => onRecord(leg.homePlayerId, 'rnd')}
                >
                  RND
                </button>
              </div>
            </div>
            <div className="scoreboard-vs">vs</div>
            <div className={`scoreboard-player${currentBreakerId ? (currentBreakerId === leg.awayPlayerId ? ' scoreboard-player-breaking' : ' scoreboard-player-not-breaking') : ''}`}>
              <h2><Link to={`/players/${leg.awayPlayerId}`}>{leg.awayPlayer.name}</Link></h2>
              <div className="score">{leg.awayFrameScore}</div>
              <button className="btn btn-primary" disabled={locked || framePending} onClick={() => onRecord(leg.awayPlayerId)}>
                Frame won
              </button>
              <div className="inline-form" style={{ justifyContent: 'center', marginTop: 6 }}>
                <button
                  className="btn btn-yellow"
                  disabled={locked || framePending}
                  title="Break and Dish - breaks and clears every ball including the black without missing a shot; the other side gets no visit to the table."
                  onClick={() => onRecord(leg.awayPlayerId, 'bnd')}
                >
                  BND
                </button>
                <button
                  type="button"
                  className={`btn btn-break${breakerId === leg.awayPlayerId ? ' btn-break-selected' : ''}`}
                  disabled={locked || breakOrderLocked}
                  title="Record that this player won the lag and broke to start this frame. Doesn't award a frame win by itself - record the winner as usual once the frame is played."
                  onClick={() => onSelectBreaker(leg.awayPlayerId)}
                >
                  {breakerId === leg.awayPlayerId ? 'Breaking \u2713' : 'Break'}
                </button>
                <button
                  className="btn btn-yellow"
                  disabled={locked || framePending}
                  title="Reverse Break and Dish - the breaker misses at some point, then this player clears every ball including the black on their first visit without missing."
                  onClick={() => onRecord(leg.awayPlayerId, 'rnd')}
                >
                  RND
                </button>
              </div>
            </div>
          </div>
          <div className="page-header">
            <span className="muted">Race to {leg.raceTo}</span>
            <button
              type="button"
              className={`btn ${leg.alternativeBreaking ? 'btn-alt-breaking-on' : 'btn-alt-breaking-off'}`}
              disabled={locked}
              title="When on, the app automatically alternates who breaks each frame of this leg (the first frame's breaker is still set manually via the Break button, e.g. after a lag)."
              onClick={onToggleAlternativeBreaking}
            >
              Alternative breaking: {leg.alternativeBreaking ? 'On' : 'Off'}
            </button>
            <button className="btn" disabled={leg.frames.length === 0 || locked || framePending} onClick={onUndo}>
              Undo last frame
            </button>
          </div>
          {leg.alternativeBreaking && (
            <div className="inline-form" style={{ marginTop: -4, marginBottom: 8 }}>
              <button
                type="button"
                className="btn btn-alt-breaking-on"
                tabIndex={-1}
                aria-disabled="true"
                style={{ cursor: 'default', pointerEvents: 'none' }}
              >
                Player to break next frame: {currentBreakerId
                  ? (currentBreakerId === leg.homePlayerId ? leg.homePlayer.name : leg.awayPlayer.name)
                  : ''}
              </button>
            </div>
          )}

          {raceTargetReached && fixture.canControl && (
            <p className="banner" style={{ background: '#dbeafe', color: '#1e40af', textAlign: 'center' }}>
              Race to {leg.raceTo} reached ({leg.homeFrameScore}-{leg.awayFrameScore}).
              <br />
              <button className="btn btn-primary" onClick={onSubmitResult} style={{ marginTop: 8 }}>
                Submit
              </button>
            </p>
          )}

          {canReportNoShow && (
            <NoShowClaimButton
              onClaim={async () => { await api.claimNoShow(fixture.id, leg.legNumber); onChange(); }}
            />
          )}

          <ResultConfirmationPanel
            status={leg.status}
            isAdmin={isAdmin}
            isHomeEntrant={isHomeNominee}
            isAwayEntrant={isAwayNominee}
            homeConfirmed={!!leg.homeConfirmed}
            awayConfirmed={!!leg.awayConfirmed}
            homeLabel={leg.homePlayer.name}
            awayLabel={leg.awayPlayer.name}
            disputeReason={leg.disputeReason}
            leagueManagers={fixture.leagueManagers}
            onConfirm={async () => { await api.confirmLegResult(fixture.id, leg.legNumber); onChange(); }}
            onDispute={async (reason) => { await api.disputeLegResult(fixture.id, leg.legNumber, reason); onChange(); }}
            onReopen={async () => { await api.adminReopenLeg(fixture.id, leg.legNumber); onChange(); }}
          />

          <section className="card">
            <h2 style={{ marginTop: 0 }}>Frame history</h2>
            <ol className="frame-history">
              {leg.frames.map((f) => (
                <li key={f.frameNumber}>
                  Frame {f.frameNumber}: Winner: {f.winnerPlayerId === leg.homePlayerId ? leg.homePlayer.name : leg.awayPlayer.name}
                  {f.method === 'bnd' && <strong> (BND)</strong>}
                  {f.method === 'rnd' && <strong> (RND)</strong>}
                  {f.breakerPlayerId && (
                    <span className="muted">
                      {' '}- Breaking player: {f.breakerPlayerId === leg.homePlayerId ? leg.homePlayer.name : leg.awayPlayer.name}
                    </span>
                  )}
                  {f.pending && <span className="muted"> - saving…</span>}
                </li>
              ))}
              {leg.frames.length === 0 && <li className="muted">No frames recorded yet.</li>}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

function TeamFixtureView({ fixture, onChange, setError, onOptimisticLegFrame, onRollbackLegFrame }) {
  const complete = fixture.status === 'completed';
  const drawn = complete && fixture.winnerTeamId === null;

  if (!fixture.bothEntrantsKnown) {
    return (
      <section className="card scoreboard">
        <div className="scoreboard-player">
          <h2>{fixture.homeTeam ? fixture.homeTeam.name : 'TBD'}</h2>
        </div>
        <div className="scoreboard-vs">vs</div>
        <div className="scoreboard-player">
          <h2>{fixture.awayTeam ? fixture.awayTeam.name : 'TBD'}</h2>
        </div>
        <p className="muted" style={{ width: '100%', textAlign: 'center' }}>
          Waiting on the result of an earlier round before this match can be played.
        </p>
      </section>
    );
  }

  return (
    <div>
      <section className="card scoreboard">
        <div className="scoreboard-player">
          <h2>{fixture.homeTeam.name}</h2>
          <div className="score">{fixture.homeLegsWon}</div>
        </div>
        <div className="scoreboard-vs">legs</div>
        <div className="scoreboard-player">
          <h2>{fixture.awayTeam.name}</h2>
          <div className="score">{fixture.awayLegsWon}</div>
        </div>
      </section>

      {complete && (
        <p className="banner banner-success">
          {drawn
            ? `Team match drawn ${fixture.homeLegsWon}-${fixture.awayLegsWon}`
            : `Match complete: ${fixture.winnerTeamId === fixture.homeTeamId ? fixture.homeTeam.name : fixture.awayTeam.name} win ${Math.max(fixture.homeLegsWon, fixture.awayLegsWon)}-${Math.min(fixture.homeLegsWon, fixture.awayLegsWon)}`}
          {fixture.closedEarly && ' - closed early, not played out'}
        </p>
      )}

      {fixture.legs.map((leg) => (
        <LegRow key={leg.legNumber} fixture={fixture} leg={leg} onChange={onChange} setError={setError} onOptimisticLegFrame={onOptimisticLegFrame} onRollbackLegFrame={onRollbackLegFrame} />
      ))}
    </div>
  );
}

// Handles both singles fixtures (fixture.homePlayer/awayPlayer, a single
// registered player) and doubles/triples fixtures (fixture.homePairing/
// awayPairing, a named 2-3 player group) - the two are structurally
// identical (one continuous frame race, no legs), differing only in what
// the "entrant" is and whether it links to a player profile page.
// Completed singles/doubles match (mobile redesign, 2026-09-22): the result
// comes first as a summary card instead of the full scoring panel with
// every button greyed out - scoring controls only show while a match is live.
function FinalResultCard({ fixture, homeEntrant, awayEntrant, EntrantName }) {
  const winnerId = fixture.winnerPlayerId;
  const date = formatFixtureDate(fixture.scheduledDate);
  const side = (entrant, id, score) => {
    const won = winnerId && winnerId === id;
    const lost = winnerId && winnerId !== id;
    return (
      <div className={`cs-final-side${won ? ' cs-final-won' : ''}`}>
        <span className={`cs-badge ${won ? 'cs-chip-W' : lost ? 'cs-chip-L' : 'cs-chip-V'}`} aria-label={won ? 'Winner' : lost ? 'Loser' : 'No winner'}>
          {won ? 'W' : lost ? 'L' : '–'}
        </span>
        <span className="cs-final-name"><EntrantName entrant={entrant} id={id} /></span>
        <span className="cs-final-score">{score}</span>
      </div>
    );
  };
  return (
    <section className="card cs-final">
      <div className="cs-card-head">
        <h2>Final result</h2>
        {date && <span className="muted">{date}</span>}
      </div>
      {side(homeEntrant, fixture.homePlayerId, fixture.homeFrameScore)}
      {side(awayEntrant, fixture.awayPlayerId, fixture.awayFrameScore)}
      {fixture.closedEarly && <p className="muted cs-small" style={{ margin: '8px 0 0' }}>Closed early - not played out.</p>}
      {!fixture.closedEarly && fixture.frames.length === 0 && (
        <p className="muted cs-small" style={{ margin: '8px 0 0' }}>Marked complete with no frames recorded.</p>
      )}
    </section>
  );
}

function SinglesFixtureView({ fixture, isDoubles, onChange, setError, onOptimisticFrame, onRollbackFrame, tools }) {
  const { user, isAdmin } = useAuth();
  const complete = fixture.status === 'completed';
  // Scoring is locked once a result has been submitted (pending_confirmation)
  // or disputed - only "Submit for Confirmation" / Confirm / Dispute /
  // Reopen apply from that point on, not more frames.
  const locked = complete || fixture.status === 'pending_confirmation' || fixture.status === 'disputed' || !fixture.canControl;
  // fixture.raceTo is null for Free Play (no frame count target) - there's
  // no target to "reach", so that match instead becomes finishable the
  // moment it's in progress and the scores aren't level (see
  // freePlayReadyToFinish below).
  const isFreePlay = fixture.raceTo == null;
  const raceTargetReached = !isFreePlay && fixture.status === 'in_progress' && (fixture.homeFrameScore >= fixture.raceTo || fixture.awayFrameScore >= fixture.raceTo);
  const freePlayInProgress = isFreePlay && fixture.status === 'in_progress';
  const freePlayReadyToFinish = freePlayInProgress && fixture.homeFrameScore !== fixture.awayFrameScore;
  const homeEntrant = isDoubles ? fixture.homePairing : fixture.homePlayer;
  const awayEntrant = isDoubles ? fixture.awayPairing : fixture.awayPlayer;
  const amHomeEntrant = isDoubles
    ? !!(user?.playerId && homeEntrant?.players?.some((p) => p.id === user.playerId))
    : user?.playerId === fixture.homePlayerId;
  const amAwayEntrant = isDoubles
    ? !!(user?.playerId && awayEntrant?.players?.some((p) => p.id === user.playerId))
    : user?.playerId === fixture.awayPlayerId;
  const canReportNoShow = (amHomeEntrant || amAwayEntrant) && ['scheduled', 'in_progress'].includes(fixture.status) && fixture.frames.length === 0;

  const EntrantName = ({ entrant, id }) => {
    if (!entrant) return 'TBD';
    if (isDoubles) {
      return (
        <>
          {entrant.name}
          <div className="muted" style={{ fontSize: '0.75rem', fontWeight: 400, marginTop: 2 }}>
            {entrant.players.map((p) => p.name).join(' & ')}
          </div>
        </>
      );
    }
    return <Link to={`/players/${id}`}>{entrant.name}</Link>;
  };

  if (!fixture.bothEntrantsKnown) {
    return (
      <section className="card scoreboard">
        <div className="scoreboard-player">
          <h2><EntrantName entrant={homeEntrant} id={fixture.homePlayerId} /></h2>
        </div>
        <div className="scoreboard-vs">vs</div>
        <div className="scoreboard-player">
          <h2><EntrantName entrant={awayEntrant} id={fixture.awayPlayerId} /></h2>
        </div>
        <p className="muted" style={{ width: '100%', textAlign: 'center' }}>
          Waiting on the result of an earlier round before this match can be played.
        </p>
      </section>
    );
  }

  // Records which player won the lag and broke to start the frame currently
  // being played. Purely informational (frame history only) - doesn't award
  // a frame win by itself, so it's tracked locally here and only sent along
  // once the frame's actual winner is recorded (Frame won/BND/RND below).
  const [breakerId, setBreakerId] = useState(null);
  const onSelectBreaker = (playerId) => {
    setBreakerId((cur) => (cur === playerId ? null : playerId));
  };
  // True while a frame recording is queued/in flight (see scoringQueue.js)
  // - guards the frame-win buttons against a double tap recording the same
  // frame twice while a slow request is still pending.
  const [framePending, setFramePending] = useState(false);

  // Alternative breaking: who's due to break the next frame, mirroring the
  // server's alternation logic - used only to highlight the scoreboard
  // below, never sent to the server (the server resolves the real breaker
  // itself once alternative breaking is on).
  const currentBreakerId = fixture.alternativeBreaking
    ? (() => {
        const lastBreakerFrame = [...fixture.frames].reverse().find((f) => f.breakerPlayerId);
        // No frame's breaker recorded yet - the lag decides who breaks
        // frame 1, so there's nothing to show until that's set.
        return lastBreakerFrame
          ? (lastBreakerFrame.breakerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId)
          : null;
      })()
    : null;
  // While alternative breaking is on, the Break button decides only who
  // breaks the very first frame (the lag winner) - once that frame's been
  // recorded, the breaking order is set and every frame after alternates
  // automatically, so both Break buttons lock out rather than staying
  // usable for one side.
  const breakOrderLocked = fixture.alternativeBreaking && fixture.frames.some((f) => f.breakerPlayerId);

  const onRecord = (winnerId, method) => {
    setError('');
    const clientRequestId = newRequestId();
    const chosenBreaker = breakerId || undefined;
    setBreakerId(null);
    setFramePending(true);
    // Optimistic UI: show the frame's effect on the scoreboard immediately,
    // before the network request (queued below, with automatic retry on a
    // slow/dropped connection) actually confirms it - reconciled with the
    // server's real state once the request succeeds, or rolled back if it's
    // definitively rejected.
    onOptimisticFrame({ winnerPlayerId: winnerId, method, breaker: chosenBreaker, clientRequestId });
    enqueueFrame({
      fixtureId: fixture.id,
      winnerPlayerId: winnerId,
      method,
      breaker: chosenBreaker,
      clientRequestId,
      onSettled: (err) => {
        setFramePending(false);
        if (err) {
          onRollbackFrame(clientRequestId);
          setError(err.message);
        } else {
          onChange();
        }
      },
    });
  };

  const onUndo = async () => {
    setError('');
    try {
      await api.undoLastFrame(fixture.id);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onSubmitResult = async () => {
    setError('');
    try {
      await api.submitResult(fixture.id);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      {framePending && (
        <p className="muted">
          {typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'Offline - this frame will be recorded automatically once you\'re back online.'
            : 'Saving frame\u2026'}
        </p>
      )}
      {complete ? (
        <FinalResultCard fixture={fixture} homeEntrant={homeEntrant} awayEntrant={awayEntrant} EntrantName={EntrantName} />
      ) : (
      <>
        <section className="card cs-board">
          <div className="cs-board-grid">
            {[
              { id: fixture.homePlayerId, entrant: homeEntrant, score: fixture.homeFrameScore, side: 'home' },
              { id: fixture.awayPlayerId, entrant: awayEntrant, score: fixture.awayFrameScore, side: 'away' },
            ].map((p, idx) => (
              <div key={p.side} className={`cs-board-player cs-side-${p.side}`} style={{ gridColumn: idx === 0 ? 1 : 3 }}>
                <span className="cs-board-bar" aria-hidden="true" />
                <span className="cs-board-name"><EntrantName entrant={p.entrant} id={p.id} /></span>
                <span className="cs-board-score">{p.score}</span>
                {!isFreePlay && fixture.raceTo <= 15 && (
                  <span className="cs-pips" role="img" aria-label={`${p.score} of ${fixture.raceTo} frames`}>
                    {Array.from({ length: fixture.raceTo }, (_, i) => (
                      <span key={i} className={i < p.score ? 'cs-pip cs-pip-on' : 'cs-pip'} />
                    ))}
                  </span>
                )}
                {!isFreePlay && (
                  <span className="cs-to-win">{Math.max(0, fixture.raceTo - p.score) === 0 ? 'Target reached' : `${fixture.raceTo - p.score} to win`}</span>
                )}
                {!locked && (
                  <button
                    type="button"
                    className={`cs-break-pill${breakerId === p.id || (!breakerId && currentBreakerId === p.id) ? ' cs-break-on' : ''}`}
                    disabled={breakOrderLocked}
                    aria-pressed={breakerId === p.id}
                    title="Record that this player won the lag and broke to start this frame. Doesn't award a frame win by itself."
                    onClick={() => onSelectBreaker(p.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M3 21L17 7" /><circle cx="19" cy="5" r="2.5" /></svg>
                    {breakerId === p.id ? 'Breaking' : (!breakerId && currentBreakerId === p.id) ? 'Breaks next' : 'Break?'}
                  </button>
                )}
              </div>
            ))}
            <span className="cs-board-vs" style={{ gridColumn: 2, gridRow: 1 }}>vs</span>
          </div>
          <p className="cs-board-note">
            {isFreePlay ? "Free Play – no frame target. Finish whenever someone's ahead." : `Race to ${fixture.raceTo}`}
          </p>
        </section>

        {tools}

        {!locked && (
          <div className="cs-score-grid">
            {[
              { id: fixture.homePlayerId, entrant: homeEntrant, side: 'home' },
              { id: fixture.awayPlayerId, entrant: awayEntrant, side: 'away' },
            ].map((p) => (
              <div key={p.side} className={`cs-score-col cs-side-${p.side}`}>
                <button className="cs-plus" disabled={framePending} onClick={() => onRecord(p.id)}>
                  +1 Frame<span className="cs-plus-name">{p.entrant.name}</span>
                </button>
                <div className="cs-method-row">
                  <button
                    className="cs-method"
                    disabled={framePending}
                    title="Break and Dish - breaks and clears every ball including the black without missing a shot; the other side gets no visit to the table."
                    onClick={() => onRecord(p.id, 'bnd')}
                  >BND</button>
                  <button
                    className="cs-method"
                    disabled={framePending}
                    title="Reverse Break and Dish - the breaker misses at some point, then this player clears every ball including the black on their first visit without missing."
                    onClick={() => onRecord(p.id, 'rnd')}
                  >RND</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
      )}

      {raceTargetReached && fixture.canControl && (
        <p className="banner" style={{ background: '#dbeafe', color: '#1e40af', textAlign: 'center' }}>
          Race to {fixture.raceTo} reached ({fixture.homeFrameScore}-{fixture.awayFrameScore}).
          <br />
          <button className="btn btn-primary" onClick={onSubmitResult} style={{ marginTop: 8 }}>
            Submit
          </button>
        </p>
      )}

      {freePlayReadyToFinish && fixture.canControl && (
        <p className="banner" style={{ background: '#dbeafe', color: '#1e40af' }}>
          {fixture.homeFrameScore > fixture.awayFrameScore ? homeEntrant.name : awayEntrant.name} is ahead
          ({fixture.homeFrameScore}-{fixture.awayFrameScore}). Free Play has no frame count target - finish the
          match whenever you're ready, no need to wait for the other side to confirm.{' '}
          <button className="btn btn-primary" onClick={onSubmitResult} style={{ marginLeft: 8 }}>
            Finish Match
          </button>
        </p>
      )}

      {freePlayInProgress && !freePlayReadyToFinish && (
        <p className="muted">
          Scores are level ({fixture.homeFrameScore}-{fixture.awayFrameScore}) - play another frame before
          finishing this Free Play match.
        </p>
      )}


      <ResultConfirmationPanel
        status={fixture.status}
        isAdmin={isAdmin}
        isHomeEntrant={amHomeEntrant}
        isAwayEntrant={amAwayEntrant}
        homeConfirmed={!!fixture.homeConfirmed}
        awayConfirmed={!!fixture.awayConfirmed}
        homeLabel={homeEntrant.name}
        awayLabel={awayEntrant.name}
        disputeReason={fixture.disputeReason}
        leagueManagers={fixture.leagueManagers}
        onConfirm={async () => { await api.confirmResult(fixture.id); onChange(); }}
        onDispute={async (reason) => { await api.disputeResult(fixture.id, reason); onChange(); }}
        onReopen={async () => { await api.adminReopenFixture(fixture.id); onChange(); }}
      />


      {/* Free Play has no division/league to browse back to afterwards (it's
          just the one 2-player match - see AdHocGame.jsx), so once it's
          complete, point the player straight at the two places they'd
          actually go next instead of leaving them on a finished scoreboard. */}
      {complete && isFreePlay && (
        <div className="inline-form inline-form-center">
          <Link className="btn btn-primary" to="/account">Home</Link>
          <Link className="btn btn-primary" to="/adhoc-game/new">New Game</Link>
        </div>
      )}

      <section className="card">
        <div className="cs-card-head">
          <h2>Frames</h2>
          {!locked && fixture.frames.length > 0 && (
            <button type="button" className="cs-link-btn" disabled={framePending} onClick={onUndo}>
              Undo frame {fixture.frames.length}
            </button>
          )}
        </div>
        {fixture.frames.length > 0 && (
          <FrameStrip fixture={fixture} homeName={homeEntrant.name} awayName={awayEntrant.name} />
        )}
        {fixture.frames.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{complete ? 'No frames recorded.' : "No frames yet. Tap Break? on whoever won the lag, then +1 Frame when a frame's won."}</p>
        ) : (
          <ol className="cs-timeline">
            {(() => {
              let h = 0;
              let a = 0;
              return fixture.frames.map((f) => {
                const homeWon = f.winnerPlayerId === fixture.homePlayerId;
                if (homeWon) h += 1; else a += 1;
                const winnerName = homeWon ? homeEntrant.name : awayEntrant.name;
                return (
                  <li key={f.frameNumber} className={homeWon ? 'cs-tl-home' : 'cs-tl-away'}>
                    <span className="cs-tl-num">{f.frameNumber}</span>
                    <span className="cs-tl-body">
                      <strong>{winnerName}</strong>
                      {f.method === 'bnd' && <span className="cs-tag">BND</span>}
                      {f.method === 'rnd' && <span className="cs-tag">RND</span>}
                      {f.breakerPlayerId && (
                        <span className="muted cs-small">Broke: {f.breakerPlayerId === fixture.homePlayerId ? homeEntrant.name : awayEntrant.name}</span>
                      )}
                      {f.table && <span className="muted cs-small">Table {f.table}</span>}
                      {f.pending && <span className="muted cs-small">saving…</span>}
                    </span>
                    <span className="cs-tl-score">{h}–{a}</span>
                  </li>
                );
              });
            })()}
          </ol>
        )}
      </section>

      {canReportNoShow && <ProblemWithMatch onClaim={async () => { await api.claimNoShow(fixture.id); onChange(); }} />}
    </div>
  );
}

// "Problem with this match?" - keeps the no-show report out of the way of
// the scoring buttons (mobile redesign 2026-09-23).
function ProblemWithMatch({ onClaim }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cs-problem">
      <button type="button" className="cs-link-btn cs-muted-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Problem with this match?
      </button>
      {open && <NoShowClaimButton onClaim={onClaim} />}
    </div>
  );
}

// Frame strip + live mini-stats: one square per frame coloured by winner,
// marked B (won on own break), D (BND) or R (RND).
function FrameStrip({ fixture, homeName, awayName }) {
  const frames = fixture.frames || [];
  const stat = (id, fn) => frames.filter((f) => f.winnerPlayerId === id && fn(f)).length;
  const rows = [
    ['Frames won', (id) => stat(id, () => true)],
    ['Won on own break', (id) => stat(id, (f) => f.breakerPlayerId === id)],
    ['BND', (id) => stat(id, (f) => f.method === 'bnd')],
    ['RND', (id) => stat(id, (f) => f.method === 'rnd')],
  ];
  return (
    <div className="cs-strip-wrap">
      <div className="cs-strip">
        {frames.map((f, i) => {
          const home = f.winnerPlayerId === fixture.homePlayerId;
          const mark = f.method === 'bnd' ? 'D' : f.method === 'rnd' ? 'R' : f.breakerPlayerId && f.breakerPlayerId === f.winnerPlayerId ? 'B' : String(i + 1);
          return (
            <span key={f.frameNumber || i} className={`cs-sq ${home ? 'cs-sq-home' : 'cs-sq-away'}${f.pending ? ' cs-sq-pending' : ''}`} title={`Frame ${i + 1}: ${home ? homeName : awayName}`}>
              {mark}
            </span>
          );
        })}
      </div>
      <div className="cs-strip-key">
        <span><span className="cs-key cs-sq-home" /> {homeName}</span>
        <span><span className="cs-key cs-sq-away" /> {awayName}</span>
        <span>B = won on own break · D = BND · R = RND</span>
      </div>
      <table className="cs-mini">
        <thead><tr><th /><th className="cs-tone-home">{homeName}</th><th className="cs-tone-away">{awayName}</th></tr></thead>
        <tbody>
          {rows.map(([label, fn]) => (
            <tr key={label}><td>{label}</td><td>{fn(fixture.homePlayerId)}</td><td>{fn(fixture.awayPlayerId)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Live match timer (elapsed running clock) and shot clock (per-shot
// countdown) - see server/src/index.js's /timer/* and /shot-clock/* routes.
// Open to any logged-in account, same as frame scoring, since whoever's
// refereeing the table is often not one of the two players. Ticks its own
// display every second locally (rather than polling the server) using the
// startedAt timestamp the server already returns, so the display stays
// smooth between the occasional onChange() refresh.
function LiveMatchControls({ fixture, isTeams, isDoubles, onChange, setError }) {
  const [now, setNow] = useState(Date.now());
  // Optional table/venue tag for this match - see POST .../table-info.
  // Local state seeded from the fixture and only pushed back on Save, so
  // typing doesn't fight with the periodic tick/reload above.
  const [tableNumber, setTableNumber] = useState(fixture.table || '');
  const [venue, setVenue] = useState(fixture.venue || '');
  const [savingTableInfo, setSavingTableInfo] = useState(false);

  // Alternative breaking: see the matching computation in SinglesFixtureView
  // for what this does - used here only to name the next breaker below the
  // toggle, never sent to the server.
  const currentBreakerId = fixture.alternativeBreaking
    ? (() => {
        const lastBreakerFrame = [...fixture.frames].reverse().find((f) => f.breakerPlayerId);
        // No frame's breaker recorded yet - the lag decides who breaks
        // frame 1, so there's nothing to show until that's set.
        return lastBreakerFrame
          ? (lastBreakerFrame.breakerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId)
          : null;
      })()
    : null;
  const homeEntrantName = isDoubles ? fixture.homePairing?.name : fixture.homePlayer?.name;
  const awayEntrantName = isDoubles ? fixture.awayPairing?.name : fixture.awayPlayer?.name;

  useEffect(() => {
    if (!fixture.timer.running && !fixture.shotClock.running) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [fixture.timer.running, fixture.shotClock.running]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const saveTableInfo = async () => {
    setSavingTableInfo(true);
    try {
      await run(() => api.setFixtureTableInfo(fixture.id, tableNumber.trim(), venue.trim()));
    } finally {
      setSavingTableInfo(false);
    }
  };

  const timerElapsed = fixture.timer.elapsedSeconds
    + (fixture.timer.running && fixture.timer.startedAt ? (now - new Date(fixture.timer.startedAt).getTime()) / 1000 : 0);
  const formatClock = (totalSeconds) => {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const shotRemaining = fixture.shotClock.running && fixture.shotClock.startedAt
    ? fixture.shotClock.durationSeconds - (now - new Date(fixture.shotClock.startedAt).getTime()) / 1000
    : fixture.shotClock.durationSeconds;

  return (
    <section className="card card-center">
      <h2>Live Match Controls</h2>
      <div className="inline-form inline-form-center" style={{ alignItems: 'center' }}>
        <div>
          <div className="muted" style={{ fontSize: '0.75rem' }}>Match Timer</div>
          <div style={{ fontSize: '1.8rem', fontVariantNumeric: 'tabular-nums' }}>{formatClock(timerElapsed)}</div>
        </div>
        {fixture.timer.running ? (
          <button className="btn" onClick={() => run(() => api.pauseTimer(fixture.id))}>Pause</button>
        ) : (
          <button className="btn btn-primary" onClick={() => run(() => api.startTimer(fixture.id))}>Start</button>
        )}
        <button className="btn" onClick={() => run(() => api.resetTimer(fixture.id))}>Reset</button>
      </div>
      <div className="inline-form inline-form-center" style={{ alignItems: 'center', marginTop: 16 }}>
        <div>
          <div className="muted" style={{ fontSize: '0.75rem' }}>Shot Clock</div>
          <div
            style={{
              fontSize: '1.8rem',
              fontVariantNumeric: 'tabular-nums',
              color: fixture.shotClock.running && shotRemaining <= 10 ? '#dc2626' : undefined,
            }}
          >
            {formatClock(shotRemaining)}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => run(() => api.startShotClock(fixture.id, fixture.shotClock.durationSeconds))}>
          {fixture.shotClock.running ? 'Restart' : `Start (${fixture.shotClock.durationSeconds}s)`}
        </button>
        <button className="btn" onClick={() => run(() => api.stopShotClock(fixture.id))}>Stop</button>
      </div>
      <div className="inline-form inline-form-center" style={{ alignItems: 'center', marginTop: 16 }}>
        <div>
          <div className="muted" style={{ fontSize: '0.75rem' }}>Table number (optional)</div>
          <input type="text" value={tableNumber} onChange={(e) => setTableNumber(e.target.value)} placeholder="e.g. Table 3" />
        </div>
        <div>
          <div className="muted" style={{ fontSize: '0.75rem' }}>Venue (optional)</div>
          <input type="text" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g. The Cue Club" />
        </div>
        <button className="btn" disabled={savingTableInfo} onClick={saveTableInfo}>
          {savingTableInfo ? 'Saving…' : 'Save table & venue'}
        </button>
      </div>
      {(fixture.table || fixture.venue) && (
        <p className="muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>
          Recording frames against {fixture.table ? `table "${fixture.table}"` : 'no table set'}{fixture.venue ? ` at ${fixture.venue}` : ''} - builds each player's table win/loss record on their stats page.
        </p>
      )}
      {/* Team fixtures alternate breaking per-leg (each leg has its own pair
          of players) - see the matching toggle inside LegRow instead. */}
      {!isTeams && (
        <div className="inline-form inline-form-center" style={{ alignItems: 'center', marginTop: 16 }}>
          <button
            type="button"
            className={`btn ${fixture.alternativeBreaking ? 'btn-alt-breaking-on' : 'btn-alt-breaking-off'}`}
            title="When on, the app automatically alternates who breaks each frame (the first frame's breaker is still set manually via the Break button, e.g. after a lag)."
            onClick={() => run(() => api.setAlternativeBreaking(fixture.id, !fixture.alternativeBreaking))}
          >
            Alternative breaking: {fixture.alternativeBreaking ? 'On' : 'Off'}
          </button>
        </div>
      )}
      {!isTeams && fixture.alternativeBreaking && (
        <div className="inline-form inline-form-center" style={{ alignItems: 'center', marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-alt-breaking-on"
            tabIndex={-1}
            aria-disabled="true"
            style={{ cursor: 'default', pointerEvents: 'none' }}
          >
            Player to break next frame: {currentBreakerId
              ? (currentBreakerId === fixture.homePlayerId ? homeEntrantName : awayEntrantName)
              : ''}
          </button>
        </div>
      )}
    </section>
  );
}

// Referee picker: a dropdown of accounts an admin has flagged as referees
// (Manage Users -> Mark as Referee) who play in or manage this fixture's
// league (every flagged referee for ad hoc games) - see GET
// /api/fixtures/:id/referee-candidates. Replaces the old type-an-email box
// (Matt, 2026-09-23).
function RefereePicker({ fixture, onChange, setError }) {
  const [candidates, setCandidates] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const refereeKey = (fixture.refereeUsers || []).map((u) => u.id).join(',');

  useEffect(() => {
    let cancelled = false;
    if (!api.getRefereeCandidates) { setCandidates([]); return undefined; }
    api.getRefereeCandidates(fixture.id)
      .then((r) => { if (!cancelled) setCandidates(r.candidates || []); })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, [fixture.id, refereeKey]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); onChange(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="cs-ref">
      {(fixture.refereeUsers || []).map((u) => (
        <div key={u.id} className="cs-ref-current">
          <span><strong>{u.name}</strong> <span className="muted cs-small">is refereeing</span></span>
          <button type="button" className="cs-link-btn" disabled={busy} onClick={() => run(() => api.removeFixtureReferee(fixture.id, u.id))}>Remove</button>
        </div>
      ))}
      {candidates && candidates.length === 0 ? (
        <p className="muted cs-small" style={{ margin: 0 }}>
          No players in this league are flagged as referees yet - an admin can flag them in Manage Users.
        </p>
      ) : (
        <div className="cs-ref-row">
          <select aria-label="Choose a referee" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!candidates || busy}>
            <option value="">{candidates ? 'Choose a referee…' : 'Loading…'}</option>
            {(candidates || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!choice || busy}
            onClick={() => run(async () => { await api.addFixtureRefereeById(fixture.id, choice); setChoice(''); })}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// Match tools (mobile redesign, 2026-09-23) for singles/doubles fixtures:
// sits between the scoreboard and the scoring buttons. Alternative breaking,
// table & venue and referee are always on the front; the timer and shot
// clock fold away. Same API calls as the older LiveMatchControls card, which
// team fixtures still use.
function MatchToolsCard({ fixture, isDoubles, onChange, setError }) {
  const [now, setNow] = useState(Date.now());
  const [tableNumber, setTableNumber] = useState(fixture.table || '');
  const [venue, setVenue] = useState(fixture.venue || '');
  const [savingTableInfo, setSavingTableInfo] = useState(false);
  const [timerOpen, setTimerOpen] = useState(!!(fixture.timer?.running || fixture.shotClock?.running));
  const canControl = !!fixture.canControl;

  const currentBreakerId = fixture.alternativeBreaking
    ? (() => {
        const lastBreakerFrame = [...fixture.frames].reverse().find((f) => f.breakerPlayerId);
        return lastBreakerFrame
          ? (lastBreakerFrame.breakerPlayerId === fixture.homePlayerId ? fixture.awayPlayerId : fixture.homePlayerId)
          : null;
      })()
    : null;
  const homeName = isDoubles ? fixture.homePairing?.name : fixture.homePlayer?.name;
  const awayName = isDoubles ? fixture.awayPairing?.name : fixture.awayPlayer?.name;

  useEffect(() => {
    if (!fixture.timer.running && !fixture.shotClock.running) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [fixture.timer.running, fixture.shotClock.running]);

  const run = async (fn) => {
    setError('');
    try { await fn(); onChange(); } catch (err) { setError(err.message); }
  };
  const saveTableInfo = async () => {
    setSavingTableInfo(true);
    try { await run(() => api.setFixtureTableInfo(fixture.id, tableNumber.trim(), venue.trim())); } finally { setSavingTableInfo(false); }
  };

  const formatClock = (totalSeconds) => {
    const sec = Math.max(0, Math.floor(totalSeconds));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  };
  const timerElapsed = fixture.timer.elapsedSeconds
    + (fixture.timer.running && fixture.timer.startedAt ? (now - new Date(fixture.timer.startedAt).getTime()) / 1000 : 0);
  const shotRemaining = fixture.shotClock.running && fixture.shotClock.startedAt
    ? fixture.shotClock.durationSeconds - (now - new Date(fixture.shotClock.startedAt).getTime()) / 1000
    : fixture.shotClock.durationSeconds;

  const altNote = fixture.alternativeBreaking
    ? (currentBreakerId ? `On – ${currentBreakerId === fixture.homePlayerId ? homeName : awayName} breaks next` : 'On – set the first breaker with Break?')
    : 'Off – when on, players take turns to break';

  return (
    <section className="card cs-tools">
      <h2>Match tools</h2>
      {canControl && (
        <div className="cs-tools-row">
          <div className="cs-grow">
            <strong>Alternative breaking</strong>
            <span className="muted cs-small">{altNote}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!fixture.alternativeBreaking}
            aria-label="Alternative breaking"
            className={`cs-switch${fixture.alternativeBreaking ? ' cs-switch-on' : ''}`}
            onClick={() => run(() => api.setAlternativeBreaking(fixture.id, !fixture.alternativeBreaking))}
          >
            <span />
          </button>
        </div>
      )}
      {canControl && (
        <div className="cs-tools-block">
          <strong>Table &amp; venue <span className="muted cs-small" style={{ fontWeight: 400 }}>optional – feeds the Table record on players' stats</span></strong>
          <div className="cs-table-row">
            <input type="text" aria-label="Table number" value={tableNumber} onChange={(e) => setTableNumber(e.target.value)} placeholder="Table" />
            <input type="text" aria-label="Venue" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue, e.g. The Cue Club" />
          </div>
          <button type="button" className="btn cs-btn-outline" disabled={savingTableInfo} onClick={saveTableInfo}>
            {savingTableInfo ? 'Saving…' : 'Save table & venue'}
          </button>
          {(fixture.table || fixture.venue) && (
            <span className="muted cs-small">
              Recording frames against {fixture.table ? `table "${fixture.table}"` : 'no table set'}{fixture.venue ? ` at ${fixture.venue}` : ''}.
            </span>
          )}
        </div>
      )}
      {fixture.canManageReferees && (
        <div className="cs-tools-block">
          <strong>Referee <span className="muted cs-small" style={{ fontWeight: 400 }}>optional – can score this match for you</span></strong>
          <RefereePicker fixture={fixture} onChange={onChange} setError={setError} />
        </div>
      )}
      {canControl && (
        <>
          <button type="button" className="cs-tools-toggle" aria-expanded={timerOpen} onClick={() => setTimerOpen((o) => !o)}>
            <span>Timer &amp; shot clock</span>
            <span className="muted cs-small">{timerOpen ? 'Hide' : `${formatClock(timerElapsed)} · ${formatClock(shotRemaining)}`}</span>
          </button>
          {timerOpen && (
            <div className="cs-clocks">
              <div className="cs-clock">
                <span className="cs-kicker">Match timer</span>
                <span className="cs-clock-value">{formatClock(timerElapsed)}</span>
                <div className="cs-clock-btns">
                  {fixture.timer.running ? (
                    <button className="btn" onClick={() => run(() => api.pauseTimer(fixture.id))}>Pause</button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => run(() => api.startTimer(fixture.id))}>Start</button>
                  )}
                  <button className="btn" onClick={() => run(() => api.resetTimer(fixture.id))}>Reset</button>
                </div>
              </div>
              <div className="cs-clock">
                <span className="cs-kicker">Shot clock</span>
                <span className="cs-clock-value" style={{ color: fixture.shotClock.running && shotRemaining <= 10 ? '#dc2626' : undefined }}>{formatClock(shotRemaining)}</span>
                <div className="cs-clock-btns">
                  <button className="btn btn-primary" onClick={() => run(() => api.startShotClock(fixture.id, fixture.shotClock.durationSeconds))}>
                    {fixture.shotClock.running ? 'Restart' : `Start ${fixture.shotClock.durationSeconds}s`}
                  </button>
                  <button className="btn" onClick={() => run(() => api.stopShotClock(fixture.id))}>Stop</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Admin-only: assign this fixture to a table plus a date/time - see
// server/src/index.js's POST /api/fixtures/:id/schedule (rejects a
// double-booking on the same table at the same date+time).
function RefereePanel({ fixture, onChange, setError }) {
  return (
    <section className="card card-center">
      <h2>Referee</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Only the players in this match (and admins) can score it. To let someone else referee, choose a player flagged as a referee.
      </p>
      <RefereePicker fixture={fixture} onChange={onChange} setError={setError} />
    </section>
  );
}

function ScheduleFixturePanel({ fixture, onChange, setError }) {
  const [tables, setTables] = useState([]);
  const [tableId, setTableId] = useState(fixture.tableId || '');
  const [scheduledDate, setScheduledDate] = useState(fixture.scheduledDate || '');
  const [scheduledTime, setScheduledTime] = useState(fixture.scheduledTime || '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.getLeague(fixture.leagueId).then((league) => setTables(league.tables)).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture.leagueId]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.scheduleFixture(fixture.id, {
        tableId: tableId || null,
        scheduledDate: scheduledDate || null,
        scheduledTime: scheduledTime || null,
      });
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <h2>Schedule</h2>
      <form className="inline-form" onSubmit={onSubmit}>
        <select value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">No table assigned</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
        <input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}

export default function FixtureDetail() {
  const { fixtureId } = useParams();
  const [fixture, setFixture] = useState(null);
  const [league, setLeague] = useState(null);
  const [error, setError] = useState('');
  // League-scoped: an Overall Admin passes regardless of `league` (even
  // before it's loaded, since canManageLeague short-circuits on isAdmin) -
  // a League Manager only passes once `league` has loaded and lists them.
  const isAdminSession = useIsAdminSession(league);
  const { isCaptain } = useAuth();
  // Plain players (not Admin/League Manager for this league, not Captain)
  // don't have a division-management reason to land on the division page -
  // their equivalent "back" destination is the fixtures list on their own
  // account portal (PlayerPortal.jsx's "My Fixtures" panel, at /account).
  const isPlayerSession = !isAdminSession && !isCaptain;

  // notFound: GET /api/fixtures/:id returned 404 - the fixture doesn't exist,
  // or it's in a round that hasn't been released to players yet (the server
  // deliberately reports both the same way). Previously this left the page
  // stuck on "Loading…" forever.
  const [notFound, setNotFound] = useState(false);
  const load = () => api.getFixture(fixtureId)
    .then((f) => { setNotFound(false); setFixture(f); })
    .catch((e) => {
      if (e.status === 404) setNotFound(true);
      setError(e.message);
    });

  useEffect(() => {
    load();
    // Any scoring actions still queued from before this page loaded (e.g.
    // the tab was closed or reloaded while a frame recording was retrying
    // on a dropped connection) lost their original onSettled callback when
    // the page reloaded - reattach `load` so their eventual success/failure
    // still refreshes this page instead of silently resolving in the
    // background. See scoringQueue.js.
    reattachFixture(fixtureId, () => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureId]);

  // Optimistic UI for scoring actions (see scoringQueue.js): applies a
  // frame's effect on the local fixture state immediately, before the
  // network request confirms it, so the scoreboard updates instantly even
  // on a slow connection. `onChange`/`load` still refetches the canonical
  // state once the request actually succeeds; these only bridge the gap.
  const onOptimisticFrame = (patch) => {
    setFixture((cur) => (cur ? applyOptimisticFrame(cur, patch) : cur));
  };
  const onRollbackFrame = (clientRequestId) => {
    setFixture((cur) => (cur ? rollbackOptimisticFrame(cur, clientRequestId) : cur));
  };
  const onOptimisticLegFrame = (legNumber, patch) => {
    setFixture((cur) => {
      if (!cur) return cur;
      return { ...cur, legs: cur.legs.map((leg) => (leg.legNumber === legNumber ? applyOptimisticFrame(leg, patch) : leg)) };
    });
  };
  const onRollbackLegFrame = (legNumber, clientRequestId) => {
    setFixture((cur) => {
      if (!cur) return cur;
      return { ...cur, legs: cur.legs.map((leg) => (leg.legNumber === legNumber ? rollbackOptimisticFrame(leg, clientRequestId) : leg)) };
    });
  };

  useEffect(() => {
    if (!fixture) return;
    api.getLeague(fixture.leagueId).then(setLeague).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixture?.leagueId]);

  // Double-elimination fixtures carry a bracketRole that's more useful to
  // show than the raw (globally-offset) round number - e.g. a losers-bracket
  // fixture's `round` might read "6" in an 8-player bracket, which is
  // confusing without context.
  const BRACKET_ROLE_LABEL = {
    winners: 'Winners Bracket',
    losers: 'Losers Bracket',
    grand_final: 'Grand Final',
    grand_final_reset: 'Grand Final — Bracket Reset',
  };
  const roundLabel = (f) =>
    f.bracketRole && f.bracketRole !== 'single' ? BRACKET_ROLE_LABEL[f.bracketRole] || `Round ${f.round}` : `Round ${f.round}`;

  useSetBreadcrumbs(
    fixture
      ? [{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: fixture.divisionName || 'Division', to: `/divisions/${fixture.divisionId}` }, { label: roundLabel(fixture) }]
      : [{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: notFound ? 'Not available' : 'Loading…' }]
  );

  if (!fixture && notFound) {
    return (
      <section className="card cs-notfound">
        <h1 style={{ marginTop: 0 }}>Fixture not available</h1>
        <p className="muted">
          This fixture couldn't be found. It may have been removed, or it's in a round that hasn't been
          released yet.
        </p>
        <Link className="btn btn-primary" to={isPlayerSession ? '/account' : '/'}>Back to home</Link>
      </section>
    );
  }
  if (!fixture && error) return <p className="error">{error}</p>;
  if (!fixture) return <p>Loading…</p>;

  // NB: can't detect team fixtures via `homeTeamId` - it's `null` for TBD
  // knockout slots even on team fixtures. `legs` is always present on team
  // fixture responses (even before both sides are known), never on singles.
  const isTeams = Array.isArray(fixture.legs);
  // Doubles/triples fixtures reuse the singles shape (no `legs`), but the
  // API keys them `homePairing`/`awayPairing` instead of `homePlayer`/
  // `awayPlayer` since the entrant is a named 2-3 player group, not one
  // registered player - that key is always present (even `null`) on a
  // doubles/triples division's fixtures, never on a singles one.
  const isDoubles = !isTeams && 'homePairing' in fixture;

  return (
    <div>
      <p>
        {isPlayerSession ? (
          <Link to="/account">&larr; Back to fixtures</Link>
        ) : (
          <Link to={`/divisions/${fixture.divisionId}`}>&larr; Back to division</Link>
        )}
      </p>
      <h1 className="fixture-heading">{roundLabel(fixture)}{isTeams ? ` · Best of ${fixture.legs.length} legs` : fixture.raceTo == null ? ' · Free Play' : ` · Race to ${fixture.raceTo}`}</h1>
      {isAdminSession && <StreamOverlayLink fixtureId={fixture.id} />}
      {error && <p className="error">{error}</p>}

      {!fixture.canControl && fixture.status !== 'completed' && (
        <p className="banner" style={{ textAlign: 'center' }}>
          View only - only the players in this match, its referee, or an admin/league manager can score or control it.
        </p>
      )}
      {isTeams && fixture.canManageReferees && fixture.status !== 'completed' && <RefereePanel fixture={fixture} onChange={load} setError={setError} />}

      {isAdminSession && <ScheduleFixturePanel fixture={fixture} onChange={load} setError={setError} />}
      {isTeams && fixture.status !== 'completed' && fixture.canControl && <LiveMatchControls fixture={fixture} isTeams={isTeams} isDoubles={isDoubles} onChange={load} setError={setError} />}

      {isTeams ? (
        <TeamFixtureView
          fixture={fixture}
          onChange={load}
          setError={setError}
          onOptimisticLegFrame={onOptimisticLegFrame}
          onRollbackLegFrame={onRollbackLegFrame}
        />
      ) : (
        <SinglesFixtureView
          fixture={fixture}
          isDoubles={isDoubles}
          onChange={load}
          setError={setError}
          onOptimisticFrame={onOptimisticFrame}
          onRollbackFrame={onRollbackFrame}
          tools={fixture.status !== 'completed' && fixture.bothEntrantsKnown && (fixture.canControl || fixture.canManageReferees)
            ? <MatchToolsCard fixture={fixture} isDoubles={isDoubles} onChange={load} setError={setError} />
            : null}
        />
      )}

      {isAdminSession && <AdminOverridePanel fixture={fixture} isTeams={isTeams} isDoubles={isDoubles} onChange={load} />}
    </div>
  );
}
