import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { useIsAdminSession } from '../useAdminSession.js';
import { useAuth } from '../AuthContext.jsx';

// Shared "submitted, awaiting confirmation / disputed" banner + action
// buttons for a result that's reached the submit -> confirm handshake (see
// server/src/index.js's "Result confirmation" section for the full design).
// `canDecide` is true for the away-side entrant or an admin - only they can
// confirm or dispute; everyone else just sees the status.
function ResultConfirmationPanel({ status, canDecide, isAdmin, onConfirm, onDispute, onReopen, homeLabel, awayLabel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  if (status === 'pending_confirmation') {
    return (
      <section className="card">
        <p className="banner" style={{ background: '#dbeafe', color: '#1e40af' }}>
          {homeLabel} submitted this result - awaiting confirmation from {awayLabel}.
        </p>
        {error && <p className="error">{error}</p>}
        {canDecide ? (
          <div className="inline-form">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(onConfirm)}>Confirm Result</button>
            <button className="btn" disabled={busy} onClick={() => run(onDispute)}>Dispute Result</button>
          </div>
        ) : (
          <p className="muted">Waiting on {awayLabel} to confirm or dispute this result.</p>
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
          {awayLabel} disputed this result - an admin needs to resolve it, either by overriding the
          score directly or reopening it for further scoring. See <Link to="/admin/game-adjustments">Game Adjustments</Link>.
        </p>
        {error && <p className="error">{error}</p>}
        {isAdmin && (
          <button className="btn" disabled={busy} onClick={() => run(onReopen)}>Reopen for scoring</button>
        )}
      </section>
    );
  }

  return null;
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
      Stream overlay (OBS Browser Source): <code>{url}</code>{' '}
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
  const isAwayNominee = user?.playerId === leg.awayPlayerId;

  const onRecord = async (winnerPlayerId) => {
    setError('');
    try {
      await api.recordLegFrame(fixture.id, leg.legNumber, winnerPlayerId);
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
            </div>
            <div className="scoreboard-vs">vs</div>
            <div className="scoreboard-player">
              <h2><Link to={`/players/${leg.awayPlayerId}`}>{leg.awayPlayer.name}</Link></h2>
              <div className="score">{leg.awayFrameScore}</div>
              <button className="btn btn-primary" disabled={locked} onClick={() => onRecord(leg.awayPlayerId)}>
                Frame won
              </button>
            </div>
          </div>
          <div className="page-header">
            <span className="muted">Race to {leg.raceTo}</span>
            <button className="btn" disabled={leg.frames.length === 0 || locked} onClick={onUndo}>
              Undo last frame
            </button>
          </div>

          {raceTargetReached && (
            <p className="banner" style={{ background: '#dbeafe', color: '#1e40af' }}>
              Race to {leg.raceTo} reached ({leg.homeFrameScore}-{leg.awayFrameScore}).{' '}
              <button className="btn btn-primary" onClick={onSubmitResult} style={{ marginLeft: 8 }}>
                Submit for Confirmation
              </button>
            </p>
          )}

          <ResultConfirmationPanel
            status={leg.status}
            canDecide={isAdmin || isAwayNominee}
            isAdmin={isAdmin}
            homeLabel={leg.homePlayer.name}
            awayLabel={leg.awayPlayer.name}
            onConfirm={async () => { await api.confirmLegResult(fixture.id, leg.legNumber); onChange(); }}
            onDispute={async () => { await api.disputeLegResult(fixture.id, leg.legNumber); onChange(); }}
            onReopen={async () => { await api.adminReopenLeg(fixture.id, leg.legNumber); onChange(); }}
          />
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
        </p>
      )}

      {fixture.legs.map((leg) => (
        <LegRow key={leg.legNumber} fixture={fixture} leg={leg} onChange={onChange} setError={setError} />
      ))}
    </div>
  );
}

// Handles both singles fixtures (fixture.homePlayer/awayPlayer, a single
// registered player) and doubles/triples fixtures (fixture.homePairing/
// awayPairing, a named 2-3 player group) - the two are structurally
// identical (one continuous frame race, no legs), differing only in what
// the "entrant" is and whether it links to a player profile page.
function SinglesFixtureView({ fixture, isDoubles, onChange, setError }) {
  const { user, isAdmin } = useAuth();
  const complete = fixture.status === 'completed';
  // Scoring is locked once a result has been submitted (pending_confirmation)
  // or disputed - only "Submit for Confirmation" / Confirm / Dispute /
  // Reopen apply from that point on, not more frames.
  const locked = complete || fixture.status === 'pending_confirmation' || fixture.status === 'disputed';
  const raceTargetReached = fixture.status === 'in_progress' && (fixture.homeFrameScore >= fixture.raceTo || fixture.awayFrameScore >= fixture.raceTo);
  const homeEntrant = isDoubles ? fixture.homePairing : fixture.homePlayer;
  const awayEntrant = isDoubles ? fixture.awayPairing : fixture.awayPlayer;
  const isAwayEntrant = isDoubles
    ? !!(user?.playerId && awayEntrant?.players?.some((p) => p.id === user.playerId))
    : user?.playerId === fixture.awayPlayerId;

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

  const onRecord = async (winnerId) => {
    setError('');
    try {
      await api.recordFrame(fixture.id, winnerId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
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
      <section className="card scoreboard">
        <div className="scoreboard-player">
          <h2><EntrantName entrant={homeEntrant} id={fixture.homePlayerId} /></h2>
          <div className="score">{fixture.homeFrameScore}</div>
          <button className="btn btn-primary" disabled={locked} onClick={() => onRecord(fixture.homePlayerId)}>
            Frame won by {homeEntrant.name}
          </button>
        </div>
        <div className="scoreboard-vs">vs</div>
        <div className="scoreboard-player">
          <h2><EntrantName entrant={awayEntrant} id={fixture.awayPlayerId} /></h2>
          <div className="score">{fixture.awayFrameScore}</div>
          <button className="btn btn-primary" disabled={locked} onClick={() => onRecord(fixture.awayPlayerId)}>
            Frame won by {awayEntrant.name}
          </button>
        </div>
      </section>

      {raceTargetReached && (
        <p className="banner" style={{ background: '#dbeafe', color: '#1e40af' }}>
          Race to {fixture.raceTo} reached ({fixture.homeFrameScore}-{fixture.awayFrameScore}).{' '}
          <button className="btn btn-primary" onClick={onSubmitResult} style={{ marginLeft: 8 }}>
            Submit for Confirmation
          </button>
        </p>
      )}

      <ResultConfirmationPanel
        status={fixture.status}
        canDecide={isAdmin || isAwayEntrant}
        isAdmin={isAdmin}
        homeLabel={homeEntrant.name}
        awayLabel={awayEntrant.name}
        onConfirm={async () => { await api.confirmResult(fixture.id); onChange(); }}
        onDispute={async () => { await api.disputeResult(fixture.id); onChange(); }}
        onReopen={async () => { await api.adminReopenFixture(fixture.id); onChange(); }}
      />

      {complete && (
        <p className="banner banner-success">
          Match complete: {homeEntrant.name} {fixture.homeFrameScore} - {fixture.awayFrameScore} {awayEntrant.name}
        </p>
      )}

      <section className="card">
        <div className="page-header">
          <h2>Frame history</h2>
          <button className="btn" disabled={fixture.frames.length === 0 || locked} onClick={onUndo}>
            Undo last frame
          </button>
        </div>
        <ol className="frame-history">
          {fixture.frames.map((f) => (
            <li key={f.frameNumber}>
              Frame {f.frameNumber}: {f.winnerPlayerId === fixture.homePlayerId ? homeEntrant.name : awayEntrant.name}
            </li>
          ))}
          {fixture.frames.length === 0 && <li className="muted">No frames recorded yet.</li>}
        </ol>
      </section>
    </div>
  );
}

export default function FixtureDetail() {
  const { fixtureId } = useParams();
  const [fixture, setFixture] = useState(null);
  const [error, setError] = useState('');
  const isAdminSession = useIsAdminSession();

  const load = () => api.getFixture(fixtureId).then(setFixture).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureId]);

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
      ? [{ label: 'Home', to: '/' }, { label: fixture.divisionName || 'Division', to: `/divisions/${fixture.divisionId}` }, { label: roundLabel(fixture) }]
      : [{ label: 'Home', to: '/' }, { label: 'Loading…' }]
  );

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
      <p><Link to={`/divisions/${fixture.divisionId}`}>&larr; Back to division</Link></p>
      <h1>{roundLabel(fixture)}{isTeams ? ` · Best of ${fixture.legs.length} legs` : ` · Race to ${fixture.raceTo}`}</h1>
      {isAdminSession && <StreamOverlayLink fixtureId={fixture.id} />}
      {error && <p className="error">{error}</p>}

      {isTeams ? (
        <TeamFixtureView fixture={fixture} onChange={load} setError={setError} />
      ) : (
        <SinglesFixtureView fixture={fixture} isDoubles={isDoubles} onChange={load} setError={setError} />
      )}

      {isAdminSession && <AdminOverridePanel fixture={fixture} isTeams={isTeams} isDoubles={isDoubles} onChange={load} />}
    </div>
  );
}
