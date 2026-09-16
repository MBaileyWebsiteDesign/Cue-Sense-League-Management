import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { useIsAdminSession } from '../useAdminSession.js';
import { useAuth } from '../AuthContext.jsx';

// Shared "submitted, awaiting confirmation / disputed" banner + action
// buttons for a result that's reached the submit -> confirm handshake (see
// server/src/index.js's "Result confirmation" section for the full design).
// BOTH the home and away entrant have to independently confirm before a
// result finalizes - `isHomeEntrant`/`isAwayEntrant` say which side (if any)
// the viewer is, and `homeConfirmed`/`awayConfirmed` say where each side
// currently stands.
function ResultConfirmationPanel({
  status, isAdmin, isHomeEntrant, isAwayEntrant, homeConfirmed, awayConfirmed,
  onConfirm, onDispute, onReopen, homeLabel, awayLabel, disputeReason,
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
          score directly or reopening it for further scoring. See <Link to="/admin/game-adjustments">Game Adjustments</Link>.
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

function LegRow({ fixture, leg, onChange, setError }) {
  const { user, isAdmin } = useAuth();
  const complete = leg.status === 'completed';
  const locked = complete || leg.status === 'pending_confirmation' || leg.status === 'disputed';
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

  const onRecord = async (winnerPlayerId, method) => {
    setError('');
    try {
      await api.recordLegFrame(fixture.id, leg.legNumber, winnerPlayerId, method, breakerId || undefined);
      setBreakerId(null);
      onChange();
    } catch (err) {
      setError(err.message);
    }
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
        <LegNominationForm fixture={fixture} leg={leg} onChange={onChange} setError={setError} />
      ) : (
        <>
          <div className="scoreboard">
            <div className="scoreboard-player">
              <h2><Link to={`/players/${leg.homePlayerId}`}>{leg.homePlayer.name}</Link></h2>
              <div className="score">{leg.homeFrameScore}</div>
              <button className="btn btn-primary" disabled={locked} onClick={() => onRecord(leg.homePlayerId)}>
                Frame won
              </button>
              <div className="inline-form" style={{ justifyContent: 'center', marginTop: 6 }}>
                <button
                  className="btn btn-yellow"
                  disabled={locked}
                  title="Break and Dish - breaks and clears every ball including the black without missing a shot; the other side gets no visit to the table."
                  onClick={() => onRecord(leg.homePlayerId, 'bnd')}
                >
                  BND
                </button>
                <button
                  type="button"
                  className={`btn btn-break${breakerId === leg.homePlayerId ? ' btn-break-selected' : ''}`}
                  disabled={locked}
                  title="Record that this player won the lag and broke to start this frame. Doesn't award a frame win by itself - record the winner as usual once the frame is played."
                  onClick={() => onSelectBreaker(leg.homePlayerId)}
                >
                  {breakerId === leg.homePlayerId ? 'Breaking \u2713' : 'Break'}
                </button>
              </div>
            </div>
            <div className="scoreboard-vs">vs</div>
            <div className="scoreboard-player">
              <h2><Link to={`/players/${leg.awayPlayerId}`}>{leg.awayPlayer.name}</Link></h2>
              <div className="score">{leg.awayFrameScore}</div>
              <button className="btn btn-primary" disabled={locked} onClick={() => onRecord(leg.awayPlayerId)}>
                Frame won
              </button>
              <div className="inline-form" style={{ justifyContent: 'center', marginTop: 6 }}>
                <button
                  className="btn btn-yellow"
                  disabled={locked}
                  title="Break and Dish - breaks and clears every ball including the black without missing a shot; the other side gets no visit to the table."
                  onClick={() => onRecord(leg.awayPlayerId, 'bnd')}
                >
                  BND
                </button>
                <button
                  type="button"
                  className={`btn btn-break${breakerId === leg.awayPlayerId ? ' btn-break-selected' : ''}`}
                  disabled={locked}
                  title="Record that this player won the lag and broke to start this frame. Doesn't award a frame win by itself - record the winner as usual once the frame is played."
                  onClick={() => onSelectBreaker(leg.awayPlayerId)}
                >
                  {breakerId === leg.awayPlayerId ? 'Breaking \u2713' : 'Break'}
                </button>
              </div>
            </div>
          </div>
          <div className="page-header">
            <span className="muted">Race to {leg.raceTo}</span>
            <button className="btn" disabled={leg.frames.length === 0 || locked} onClick={onUndo}>
              Undo last frame
            </button>
          </div>

          {raceTargetReached && (
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

function TeamFixtureView({ fixture, onChange, setError }) {
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
     