import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import BracketChart from '../components/BracketChart.jsx';
import DoubleElimBracketChart from '../components/DoubleElimBracketChart.jsx';

function generateFixturesLabel(division) {
  if (division.scheduling === 'knockout_single_elim') return 'Generate Fixtures (single-elimination knockout)';
  if (division.scheduling === 'knockout_double_elim') return 'Generate Fixtures (double-elimination knockout)';
  if (division.scheduling === 'knockout_double_elim_test') return 'Generate Fixtures (double-elimination knockout - testing)';
  if (division.scheduling === 'round_robin_double') return 'Generate Fixtures (Round Robin - Double, home and away)';
  return 'Generate Fixtures (Round Robin - Single, play each other once)';
}

// Both double-elimination formats ('knockout_double_elim' and the
// mirrored-routing 'knockout_double_elim_test' - see
// generateTestingDoubleElimFixtures, server/src/index.js) share the same
// fixture shape and bracket display, so most UI checks below treat them the
// same. Only the "add a late entrant / rebuild bracket" flow (see
// canAddLateEntrant further down) is exclusive to the original format.
const DOUBLE_ELIM_TYPES = ['knockout_double_elim', 'knockout_double_elim_test'];

// How many entrants are currently registered, read off whichever roster
// array hydrateDivision actually populated for this entryType (players/
// teams/pairings) - see server/src/index.js's hydrateDivision.
function currentEntrantCount(division) {
  if (division.entryType === 'teams') return (division.teams || []).length;
  if (division.entryType === 'doubles') return (division.pairings || []).length;
  return (division.players || []).length;
}

// Estimated number of games the division's fixtures will contain, from the
// current entrant count and scheduling format - mirrors the shape of what
// generateRoundRobinFixtures/generateKnockoutFixtures actually produce
// server-side (server/src/index.js), without needing fixtures to exist yet.
function estimateGameCount(division) {
  const n = currentEntrantCount(division);
  if (n < 2) return 0;
  switch (division.scheduling) {
    case 'round_robin_double':
      // Everyone plays everyone twice (home and away).
      return n * (n - 1);
    case 'knockout_single_elim':
      // Every match eliminates exactly one entrant, so it always takes
      // n - 1 matches to reduce the field to a single champion, regardless
      // of how byes/reserved slots land in round 1.
      return n - 1;
    case 'knockout_double_elim':
    case 'knockout_double_elim_test':
      // Minimum matches for a double-elimination bracket: 2n - 2 if the
      // winners-bracket finalist takes the Grand Final outright. If they
      // lose it, a reset decider adds one more match (2n - 1) - so the
      // real count can be one game higher than this estimate.
      return 2 * n - 2;
    case 'round_robin_single':
    default:
      // Everyone plays everyone once.
      return (n * (n - 1)) / 2;
  }
}

// MaxFramesPerGame: the maximum number of frames a single game could ever
// go to before someone reaches the winning threshold. A division only ever
// persists a "race to" value (division.raceTo) - even one set up as
// "Best of X" gets converted to raceTo = (X + 1) / 2 before it's ever saved
// (see ChangeGameTypeForm's onSubmit above, and the matching conversion at
// division creation, server/src/index.js) - so from here on N is always a
// race-to value, and MaxFramesPerGame = (N x 2) - 1 (e.g. race to 5 ->
// worst case is 4-4, decided on the 9th frame - the same total a "Best of
// 9" division would have stored this same raceTo value from in the first
// place).
function maxFramesPerGame(division) {
  const n = division.raceTo || 0;
  return n > 0 ? (n * 2) - 1 : 0;
}

// Estimated total playing time in minutes: MaxFramesPerGame x 10 x
// (number of games). Tables available is deliberately left out of this
// formula for now (see the "Number of Tables available" input in
// GenerateFixturesButton below, which is currently just a standalone
// reference field).
function estimateGameTimeMinutes(division) {
  return maxFramesPerGame(division) * 10 * estimateGameCount(division);
}

function formatMinutes(mins) {
  if (!mins || mins <= 0) return '0 mins';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min${m === 1 ? '' : 's'}`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Editable copy of the same 4 fields LeagueDetail.jsx's "+ New Division"
// form collects (entry type, match format, race to/best of frames, format),
// used here to revise a division's game type before fixtures are generated.
// See PATCH /api/divisions/:id (server/src/index.js) for the matching
// backend validation/gating - most importantly, it 400s once
// division.fixturesGenerated is true, which is also why this whole button
// (and therefore this form) is only ever rendered pre-fixtures to begin with.
function ChangeGameTypeForm({ division, onChange, setError, onDone }) {
  const [entryType, setEntryType] = useState(division.entryType);
  const [legsPerMatch, setLegsPerMatch] = useState(division.legsPerMatch || 5);
  const [pairingSize, setPairingSize] = useState(division.pairingSize || 2);
  const [scheduling, setScheduling] = useState(division.scheduling);
  const [formatMode, setFormatMode] = useState('raceTo');
  const [formatValue, setFormatValue] = useState(division.raceTo || 6);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const numericFormatValue = Number(formatValue);
    let raceTo;
    if (formatMode === 'bestOf') {
      if (!Number.isInteger(numericFormatValue) || numericFormatValue < 1 || numericFormatValue % 2 === 0) {
        setError('Best of (frames) must be an odd whole number - e.g. 3, 5, 7, 9, 11');
        return;
      }
      raceTo = (numericFormatValue + 1) / 2;
    } else {
      if (!Number.isInteger(numericFormatValue) || numericFormatValue < 1) {
        setError('Race to (frames) must be a whole number of 1 or more');
        return;
      }
      raceTo = numericFormatValue;
    }
    setSaving(true);
    try {
      await api.updateDivision(division.id, {
        entryType,
        scheduling,
        raceTo,
        ...(entryType === 'teams' ? { legsPerMatch: Number(legsPerMatch) } : {}),
        ...(entryType === 'doubles' ? { pairingSize: Number(pairingSize) } : {}),
      });
      onChange();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" style={{ marginTop: 8, marginBottom: 8 }} onSubmit={onSubmit}>
      <label>
        Entry type
        <select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
          <option value="singles">Singles (one player vs one player)</option>
          <option value="teams">Teams (team vs team, made up of legs)</option>
          <option value="doubles">Doubles/Triples (2-3 player pairing vs pairing, alternate-shot)</option>
        </select>
      </label>
      {entryType === 'teams' && (
        <label>
          Legs per match
          <input type="number" min="1" value={legsPerMatch} onChange={(e) => setLegsPerMatch(e.target.value)} required />
        </label>
      )}
      {entryType === 'doubles' && (
        <label>
          Players per pairing
          <select value={pairingSize} onChange={(e) => setPairingSize(e.target.value)}>
            <option value={2}>2 (doubles)</option>
            <option value={3}>3 (triples)</option>
          </select>
        </label>
      )}
      <label>
        Match format
        <select value={formatMode} onChange={(e) => setFormatMode(e.target.value)}>
          <option value="raceTo">Race to (frames)</option>
          <option value="bestOf">Best of (frames)</option>
        </select>
      </label>
      <label>
        {formatMode === 'bestOf' ? 'Best of (frames)' : 'Race to (frames)'}
        <input
          type="number"
          min="1"
          step={formatMode === 'bestOf' ? 2 : 1}
          value={formatValue}
          onChange={(e) => setFormatValue(e.target.value)}
          required
        />
      </label>
      <label>
        Format
        <select value={scheduling} onChange={(e) => setScheduling(e.target.value)}>
          <option value="round_robin_single">Round Robin - Single (everyone plays each other once)</option>
          <option value="round_robin_double">Round Robin - Double (everyone plays each other twice, home and away)</option>
          <option value="knockout_single_elim">Knockout (single elimination)</option>
          <option value="knockout_double_elim">Knockout (double elimination)</option>
          <option value="knockout_double_elim_test">Testing Double Elimination (mirrored losers-bracket routing)</option>
        </select>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Submit'}
        </button>
        <button className="btn" type="button" onClick={onDone} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}

// Shared by SinglesRoster/TeamRoster/PairingRoster below - asks up front
// whether the fixtures about to be generated should start visible to
// players immediately (skipping the normal per-round release from Manage
// Fixtures entirely) or hidden as usual, since that choice has to be made
// at generation time - see markAllRoundsVisible in server/src/index.js.
// Number of Tables available / Estimated Game Time / Estimated No. of Games
// - shared between the pre-fixtures GenerateFixturesButton view below and
// the locked "fixtures already generated" roster views (SinglesRoster/
// TeamRoster/PairingRoster further down), so the same at-a-glance figures
// stay visible once a division is actually running, not just while it's
// being set up. tablesAvailable is local, in-memory only (see
// estimateGameTimeMinutes above) - each place this renders gets its own
// independent value, resetting to 1 on reload.
function GameTimeEstimate({ division }) {
  const [tablesAvailable, setTablesAvailable] = useState(1);
  return (
    <div>
      <p style={{ margin: 0 }}>
        <label>
          <strong>Number of Tables available:</strong>{' '}
          <input
            type="number"
            min="1"
            value={tablesAvailable}
            onChange={(e) => setTablesAvailable(e.target.value)}
            style={{ width: 60 }}
          />
        </label>
      </p>
      <p style={{ margin: 0 }}>
        <strong>Estimated Game Time:</strong> {formatMinutes(estimateGameTimeMinutes(division))}
      </p>
      <p style={{ margin: 0 }}>
        <strong>Estimated No. of Games:</strong> {estimateGameCount(division)}
      </p>
    </div>
  );
}

function GenerateFixturesButton({ division, disabled, title, onChange, setError }) {
  const [visibleByDefault, setVisibleByDefault] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [changingGameType, setChangingGameType] = useState(false);

  const onGenerate = async () => {
    setError('');
    setGenerating(true);
    try {
      await api.generateFixtures(division.id, { visibleByDefault });
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <GameTimeEstimate division={division} />
        <button className="btn" type="button" onClick={() => setChangingGameType((v) => !v)}>
          {changingGameType ? 'Cancel' : 'Change Game Type'}
        </button>
      </div>
      {changingGameType && (
        <ChangeGameTypeForm
          division={division}
          onChange={onChange}
          setError={setError}
          onDone={() => setChangingGameType(false)}
        />
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={visibleByDefault}
          onChange={(e) => setVisibleByDefault(e.target.checked)}
        />
        Make all fixtures visible to players immediately (skip releasing rounds one at a time)
      </label>
      <button className="btn btn-primary" disabled={disabled || generating} onClick={onGenerate} title={title}>
        {generating ? 'Generating…' : generateFixturesLabel(division)}
      </button>
    </div>
  );
}

function SinglesRoster({ division, registeredPlayers, onChange, setError, isAdmin }) {
  const [playerId, setPlayerId] = useState('');
  const [quickFirstName, setQuickFirstName] = useState('');
  const [quickLastName, setQuickLastName] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  const [quickResult, setQuickResult] = useState('');
  const [closingLateEntry, setClosingLateEntry] = useState(false);
  const [lateEntrantPlayerId, setLateEntrantPlayerId] = useState('');
  const [addingLateEntrant, setAddingLateEntrant] = useState(false);
  const [lateEntrantResult, setLateEntrantResult] = useState('');
  const alreadyIn = new Set(division.players.map((p) => p.id));
  const available = registeredPlayers.filter((p) => !alreadyIn.has(p.id));
  // Reserved bracket slots (see MAX_RESERVED_BYE_COUNT, server-side) - up to
  // a few round-1 boxes a knockout division's fixtures can carry, each
  // holding one seeded entrant and one side deliberately left open for a
  // day-of late entrant. Only relevant once fixtures exist; a round robin
  // (or a knockout with none reserved) never has any.
  const isKnockout = division.scheduling === 'knockout_single_elim' || DOUBLE_ELIM_TYPES.includes(division.scheduling);
  const openReservedSlots = isKnockout ? (division.fixtures || []).filter((f) => f.reserved) : [];
  const canQuickAddLateEntrant = division.fixturesGenerated && openReservedSlots.length > 0;
  // Pre-tournament late entry (see POST /api/divisions/:id/late-entrants) -
  // unlocks the roster on a double-elim knockout and rebuilds the bracket
  // around a registered player added after fixtures were generated, instead
  // of relying on a reserved slot. The server is the real gatekeeper (it
  // refuses once any frame anywhere in the bracket has been recorded) - this
  // just decides whether to show the control at all, so it only needs to
  // rule out formats/states the route can never succeed for. Deliberately
  // 'knockout_double_elim' only - 'knockout_double_elim_test' doesn't
  // support the rebuild flow (see generateTestingDoubleElimFixtures,
  // server/src/index.js).
  const canAddLateEntrant =
    isAdmin &&
    division.scheduling === 'knockout_double_elim' &&
    division.fixturesGenerated &&
    division.status === 'active';

  const onAddPlayer = async (e) => {
    e.preventDefault();
    if (!playerId) return;
    setError('');
    try {
      await api.addPlayer(division.id, playerId);
      setPlayerId('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onQuickAdd = async (e) => {
    if (e) e.preventDefault();
    if (!quickFirstName.trim()) return;
    setError('');
    setQuickResult('');
    setQuickAdding(true);
    try {
      const res = await api.quickAddPlayer(division.id, quickFirstName.trim(), quickLastName.trim() || null);
      setQuickFirstName('');
      setQuickLastName('');
      setQuickResult(
        res.outcome?.method === 'reserved-slot'
          ? `${res.player.name}: added - took one of the bracket's reserved round 1 slots and plays forward through the bracket like anyone else, no decider match involved.`
          : `${res.player.name}: Added.`
      );
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setQuickAdding(false);
    }
  };

  const onCloseLateEntry = async () => {
    setError('');
    setClosingLateEntry(true);
    try {
      const res = await api.closeLateEntry(division.id);
      setQuickResult(
        res.releasedCount > 0
          ? `Late entry closed - ${res.releasedCount} unclaimed reserved slot(s) released as ordinary byes.`
          : 'Late entry closed - nothing was left unclaimed.'
      );
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosingLateEntry(false);
    }
  };

  const onAddLateEntrant = async (e) => {
    e.preventDefault();
    if (!lateEntrantPlayerId) return;
    setError('');
    setLateEntrantResult('');
    setAddingLateEntrant(true);
    try {
      const res = await api.addLateEntrants(division.id, [lateEntrantPlayerId]);
      setLateEntrantPlayerId('');
      setLateEntrantResult(
        `${res.addedPlayers.map((p) => p.name).join(', ')}: added - the bracket was rebuilt around them (${res.archivedFixtureCount} old fixture(s) archived, kept for the record)` +
          (res.replayedResultCount > 0
            ? `, and ${res.replayedResultCount} already-decided round 1 result(s) were carried forward onto the new bracket.`
            : '.')
      );
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingLateEntrant(false);
    }
  };

  const onRemovePlayer = async (playerId) => {
    setError('');
    try {
      await api.removePlayer(division.id, playerId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  // Manual seeding: division.playerIds order is exactly what a knockout
  // bracket seeds off (see server's reorder-entrants route) - swapping two
  // adjacent entrants here is the whole UI for it, no drag-and-drop needed.
  const onMovePlayer = async (index, delta) => {
    const ids = division.players.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setError('');
    try {
      await api.reorderEntrants(division.id, ids);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card">
      <h2>Players</h2>
      {!division.fixturesGenerated && (
        <form className="inline-form" onSubmit={onAddPlayer}>
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)} required>
            <option value="" disabled>
              {available.length === 0 ? 'No registered players available' : 'Select a registered player…'}
            </option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={!playerId}>Add Player</button>
        </form>
      )}
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        Only people with a registered player account can be added this way - see "My Account" to register.
      </p>

      {isAdmin && (!division.fixturesGenerated || canQuickAddLateEntrant) && (
        <>
          <h3 style={{ marginBottom: 4 }}>Quick add (walk-in)</h3>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8, fontSize: '0.8rem' }}>
            {division.fixturesGenerated
              ? `Fixtures are already generated, but ${openReservedSlots.length} reserved bracket slot${openReservedSlots.length === 1 ? ' is' : 's are'} still open for a day-of arrival - just a name, no account needed.`
              : 'For someone who\'s never used CueSense before - just a name, no account needed to add them to the draw.'}
          </p>
          <form className="inline-form" onSubmit={onQuickAdd}>
            <input
              type="text"
              placeholder="First name *"
              aria-label="First name (required)"
              value={quickFirstName}
              onChange={(e) => setQuickFirstName(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Last name (optional)"
              aria-label="Last name (optional)"
              value={quickLastName}
              onChange={(e) => setQuickLastName(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={quickAdding || !quickFirstName.trim()}>
              {quickAdding ? 'Adding…' : 'Quick Add'}
            </button>
          </form>
          <p className="muted" style={{ marginTop: 4, fontSize: '0.75rem' }}>* required</p>
          {quickResult && <p className="muted" style={{ fontSize: '0.85rem' }}>{quickResult}</p>}
        </>
      )}
      {isAdmin && canQuickAddLateEntrant && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Not expecting anyone else?{' '}
          <button className="btn-link" type="button" disabled={closingLateEntry} onClick={onCloseLateEntry}>
            {closingLateEntry ? 'Closing…' : 'Close late entry'}
          </button>{' '}
          to release the remaining reserved slot{openReservedSlots.length === 1 ? '' : 's'} as ordinary byes now, rather than waiting.
        </p>
      )}
      {canAddLateEntrant && (
        <>
          <h3 style={{ marginBottom: 4 }}>Add a late entrant</h3>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8, fontSize: '0.8rem' }}>
            Adds a registered player to the draw and rebuilds the bracket around them, carrying forward any round 1
            results already recorded. Works right up until round 2 or the losers bracket has a result on it - once
            that happens, the bracket shape beyond round 1 can no longer be safely regenerated and this stops being
            offered; use Quick Add above (if a reserved slot is open) instead.
          </p>
          <form className="inline-form" onSubmit={onAddLateEntrant}>
            <select value={lateEntrantPlayerId} onChange={(e) => setLateEntrantPlayerId(e.target.value)} required>
              <option value="" disabled>
                {available.length === 0 ? 'No registered players available' : 'Select a registered player…'}
              </option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn btn-primary" type="submit" disabled={addingLateEntrant || !lateEntrantPlayerId}>
              {addingLateEntrant ? 'Adding…' : 'Add & rebuild bracket'}
            </button>
          </form>
          {lateEntrantResult && <p className="muted" style={{ fontSize: '0.85rem' }}>{lateEntrantResult}</p>}
        </>
      )}
      <ul className="player-list">
        {division.players.map((p, i) => (
          <li key={p.id}>
            <Link to={`/players/${p.id}`}>{p.name}</Link>
            {!division.fixturesGenerated && division.players.length > 1 && (
              <span>
                <button className="btn-link" disabled={i === 0} onClick={() => onMovePlayer(i, -1)} title="Move up (earlier seed)">&uarr;</button>
                <button className="btn-link" disabled={i === division.players.length - 1} onClick={() => onMovePlayer(i, 1)} title="Move down (later seed)">&darr;</button>
              </span>
            )}
            {!division.fixturesGenerated && (
              <button className="btn-link" onClick={() => onRemovePlayer(p.id)}>remove</button>
            )}
          </li>
        ))}
        {division.players.length === 0 && <li className="muted">No players registered yet</li>}
      </ul>

      {!division.fixturesGenerated ? (
        <GenerateFixturesButton
          division={division}
          disabled={division.players.length < 2}
          title={division.players.length < 2 ? 'Add at least 2 players first' : ''}
          onChange={onChange}
          setError={setError}
        />
      ) : (
        <>
          <p className="muted">
            Fixtures generated - the roster is locked, no further additions or removals
            {canQuickAddLateEntrant && canAddLateEntrant
              ? ' (aside from Quick Add or Add a late entrant, above).'
              : canQuickAddLateEntrant
                ? ' (aside from Quick Add above, while a reserved slot is still open).'
                : canAddLateEntrant
                  ? ' (aside from Add a late entrant, above, while nothing has been played yet).'
                  : '.'}
          </p>
          <GameTimeEstimate division={division} />
        </>
      )}

    </section>
  );
}

// Admin-only tool for handling a player dropping out mid-season: pick who's
// leaving and who's replacing them, and every fixture of theirs that hasn't
// been played yet gets handed to the replacement. Completed fixtures (and
// any that already have some frames recorded) are left untouched - the
// outgoing player's record up to that point stays exactly as it was, it just
// stops growing, while the incoming player picks up from there. Only shown
// once fixtures exist to reassign; before that, dropping someone and adding
// someone else through the roster list above does the same thing more
// directly.
function PlayerSubstitutionPanel({ division, registeredPlayers, onChange, setError }) {
  const [outgoingId, setOutgoingId] = useState('');
  const [incomingId, setIncomingId] = useState('');
  const [reason, setReason] = useState('substitution');
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const alreadyIn = new Set(division.players.map((p) => p.id));
  const available = registeredPlayers.filter((p) => !alreadyIn.has(p.id));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!outgoingId || !incomingId) return;
    setError('');
    setResult(null);
    setSubmitting(true);
    try {
      const res = await api.substitutePlayer(division.id, outgoingId, incomingId, reason);
      setResult(res);
      setOutgoingId('');
      setIncomingId('');
      setReason('substitution');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <h2>Substitute a Player</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        If a player drops out, swap them for a replacement here. Either way, only the outgoing
        player's remaining, not-yet-started fixtures move to the replacement - completed matches
        (and any already partway through) are left exactly as they are.
      </p>
      <form className="inline-form" onSubmit={onSubmit}>
        <select value={outgoingId} onChange={(e) => setOutgoingId(e.target.value)} required>
          <option value="" disabled>Player dropping out…</option>
          {division.players.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={incomingId} onChange={(e) => setIncomingId(e.target.value)} required>
          <option value="" disabled>
            {available.length === 0 ? 'No registered players available' : 'Replacement player…'}
          </option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={reason} onChange={(e) => setReason(e.target.value)} required>
          <option value="substitution">Temporary cover (stays on the table)</option>
          <option value="retirement">Leaving the league (remove from the table)</option>
        </select>
        <button className="btn btn-primary" type="submit" disabled={!outgoingId || !incomingId || submitting}>
          {submitting ? 'Swapping…' : 'Swap Player'}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 8, fontSize: '0.8rem' }}>
        <strong>Temporary cover</strong> keeps the outgoing player's row in the League Table with
        their played-so-far record frozen - use this when someone's just missing a few games.
        <strong> Leaving the league</strong> removes their row from the table entirely going
        forward - use this when someone's pulling out or retiring for good. Either way, matches
        they already completed stay exactly as recorded, so opponents' records aren't affected,
        and the outgoing player's own stats history is still there on their profile page.
      </p>

      {result && (
        <div className="banner banner-success" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            {result.swapped.length} remaining fixture{result.swapped.length === 1 ? '' : 's'} reassigned to the replacement.
            {result.reason === 'retirement' && ' The outgoing player has been removed from the League Table.'}
            {result.blockedInProgress.length > 0 && (
              <>
                {' '}{result.blockedInProgress.length} fixture{result.blockedInProgress.length === 1 ? '' : 's'} already had frames
                recorded and were left with the outgoing player - finish or override those first if they need to change hands too.
              </>
            )}
          </p>
        </div>
      )}

      {division.substitutions && division.substitutions.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)', marginTop: 16 }}>Substitution history</h3>
          <ul className="fixture-list">
            {division.substitutions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.outgoingPlayerName} &rarr; {s.incomingPlayerName} ({s.fixturesSwapped} fixture{s.fixturesSwapped === 1 ? '' : 's'})
                  {s.reason === 'retirement' ? ' · retired' : ''}
                </span>
                <span className="muted">{new Date(s.at).toLocaleDateString()} · {s.by}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TeamRoster({ division, registeredPlayers, onChange, setError }) {
  const [teamName, setTeamName] = useState('');
  const [playerIds, setPlayerIds] = useState({}); // teamId -> selected registered playerId
  // A player can only be on one roster within a division at a time.
  const assignedElsewhere = new Set(division.teams.flatMap((t) => t.players.map((p) => p.id)));

  const onAddTeam = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createTeam(division.id, teamName);
      setTeamName('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onRemoveTeam = async (teamId) => {
    setError('');
    try {
      await api.removeTeam(division.id, teamId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onAddTeamPlayer = async (e, teamId) => {
    e.preventDefault();
    const selected = playerIds[teamId];
    if (!selected) return;
    setError('');
    try {
      await api.addTeamPlayer(teamId, selected);
      setPlayerIds((prev) => ({ ...prev, [teamId]: '' }));
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onRemoveTeamPlayer = async (teamId, playerId) => {
    setError('');
    try {
      await api.removeTeamPlayer(teamId, playerId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  // Manual seeding: division.teamIds order is what a knockout bracket seeds
  // off (see server's reorder-entrants route) - moving a team card here
  // changes its seed position.
  const onMoveTeam = async (index, delta) => {
    const ids = division.teams.map((t) => t.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setError('');
    try {
      await api.reorderEntrants(division.id, ids);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const enoughPlayers = division.teams.every((t) => t.players.length >= 1);
  const canGenerate = division.teams.length >= 2 && enoughPlayers;

  return (
    <section className="card">
      <h2>Teams</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        Only people with a registered player account can be added to a team roster.
      </p>
      {!division.fixturesGenerated && (
        <form className="inline-form" onSubmit={onAddTeam}>
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="Team name"
            required
          />
          <button className="btn btn-primary" type="submit">Add Team</button>
        </form>
      )}

      <div className="card-grid">
        {division.teams.map((team, i) => (
          <div key={team.id} className="card">
            <div className="page-header">
              <h3 style={{ margin: 0 }}>{team.name}</h3>
              {!division.fixturesGenerated && (
                <span>
                  {division.teams.length > 1 && (
                    <>
                      <button className="btn-link" disabled={i === 0} onClick={() => onMoveTeam(i, -1)} title="Move up (earlier seed)">&uarr;</button>
                      <button className="btn-link" disabled={i === division.teams.length - 1} onClick={() => onMoveTeam(i, 1)} title="Move down (later seed)">&darr;</button>
                    </>
                  )}
                  <button className="btn-link" onClick={() => onRemoveTeam(team.id)}>remove team</button>
                </span>
              )}
            </div>
            <ul className="player-list">
              {team.players.map((p) => (
                <li key={p.id}>
                  <Link to={`/players/${p.id}`}>{p.name}</Link>
                  {!division.fixturesGenerated && (
                    <button className="btn-link" onClick={() => onRemoveTeamPlayer(team.id, p.id)}>remove</button>
                  )}
                </li>
              ))}
              {team.players.length === 0 && <li className="muted">No players yet</li>}
            </ul>
            {!division.fixturesGenerated && (() => {
              const teamAvailable = registeredPlayers.filter((p) => !assignedElsewhere.has(p.id));
              return (
                <form className="inline-form" onSubmit={(e) => onAddTeamPlayer(e, team.id)}>
                  <select
                    value={playerIds[team.id] || ''}
                    onChange={(e) => setPlayerIds((prev) => ({ ...prev, [team.id]: e.target.value }))}
                    required
                  >
                    <option value="" disabled>
                      {teamAvailable.length === 0 ? 'No registered players available' : 'Select a registered player…'}
                    </option>
                    {teamAvailable.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button className="btn btn-primary" type="submit" disabled={!playerIds[team.id]}>Add</button>
                </form>
              );
            })()}
          </div>
        ))}
        {division.teams.length === 0 && <p className="muted">No teams registered yet</p>}
      </div>

      {!division.fixturesGenerated ? (
        <GenerateFixturesButton
          division={division}
          disabled={!canGenerate}
          title={!canGenerate ? 'Add at least 2 teams, each with at least 1 player' : ''}
          onChange={onChange}
          setError={setError}
        />
      ) : (
        <>
          <p className="muted">Fixtures generated — team rosters are locked.</p>
          <GameTimeEstimate division={division} />
        </>
      )}
    </section>
  );
}

// Pairings (doubles/triples divisions): a named group of 2-3 registered
// players who play together, alternate-shot, as one side. Structurally the
// same UI shape as TeamRoster above, but capped at `division.pairingSize`
// players per pairing (2 for doubles, 3 for triples) instead of unlimited,
// and fixtures are scored like singles (no legs), so there's no per-leg
// nomination step - a pairing just needs to be full before fixtures can be
// generated.
function PairingRoster({ division, registeredPlayers, onChange, setError }) {
  const [pairingName, setPairingName] = useState('');
  const [playerIds, setPlayerIds] = useState({}); // pairingId -> selected registered playerId
  const assignedElsewhere = new Set(division.pairings.flatMap((p) => p.players.map((pl) => pl.id)));

  const onAddPairing = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createPairing(division.id, pairingName);
      setPairingName('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onRemovePairing = async (pairingId) => {
    setError('');
    try {
      await api.removePairing(division.id, pairingId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onAddPairingPlayer = async (e, pairingId) => {
    e.preventDefault();
    const selected = playerIds[pairingId];
    if (!selected) return;
    setError('');
    try {
      await api.addPairingPlayer(pairingId, selected);
      setPlayerIds((prev) => ({ ...prev, [pairingId]: '' }));
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const onRemovePairingPlayer = async (pairingId, playerId) => {
    setError('');
    try {
      await api.removePairingPlayer(pairingId, playerId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  // Manual seeding: division.pairingIds order is what a knockout bracket
  // seeds off (see server's reorder-entrants route) - moving a pairing card
  // here changes its seed position.
  const onMovePairing = async (index, delta) => {
    const ids = division.pairings.map((p) => p.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setError('');
    try {
      await api.reorderEntrants(division.id, ids);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const canGenerate = division.pairings.length >= 2 && division.pairings.every((p) => p.players.length === division.pairingSize);
  const noun = division.pairingSize === 3 ? 'Triples' : 'Doubles';

  return (
    <section className="card">
      <h2>Pairings</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        {noun} - each pairing needs exactly {division.pairingSize} registered players before fixtures can be generated.
      </p>
      {!division.fixturesGenerated && (
        <form className="inline-form" onSubmit={onAddPairing}>
          <input
            value={pairingName}
            onChange={(e) => setPairingName(e.target.value)}
            placeholder="Pairing name"
            required
          />
          <button className="btn btn-primary" type="submit">Add Pairing</button>
        </form>
      )}

      <div className="card-grid">
        {division.pairings.map((pairing, i) => (
          <div key={pairing.id} className="card">
            <div className="page-header">
              <h3 style={{ margin: 0 }}>{pairing.name}</h3>
              {!division.fixturesGenerated && (
                <span>
                  {division.pairings.length > 1 && (
                    <>
                      <button className="btn-link" disabled={i === 0} onClick={() => onMovePairing(i, -1)} title="Move up (earlier seed)">&uarr;</button>
                      <button className="btn-link" disabled={i === division.pairings.length - 1} onClick={() => onMovePairing(i, 1)} title="Move down (later seed)">&darr;</button>
                    </>
                  )}
                  <button className="btn-link" onClick={() => onRemovePairing(pairing.id)}>remove pairing</button>
                </span>
              )}
            </div>
            <ul className="player-list">
              {pairing.players.map((p) => (
                <li key={p.id}>
                  <Link to={`/players/${p.id}`}>{p.name}</Link>
                  {!division.fixturesGenerated && (
                    <button className="btn-link" onClick={() => onRemovePairingPlayer(pairing.id, p.id)}>remove</button>
                  )}
                </li>
              ))}
              {pairing.players.length === 0 && <li className="muted">No players yet</li>}
            </ul>
            {!division.fixturesGenerated && pairing.players.length < division.pairingSize && (() => {
              const pairingAvailable = registeredPlayers.filter((p) => !assignedElsewhere.has(p.id));
              return (
                <form className="inline-form" onSubmit={(e) => onAddPairingPlayer(e, pairing.id)}>
                  <select
                    value={playerIds[pairing.id] || ''}
                    onChange={(e) => setPlayerIds((prev) => ({ ...prev, [pairing.id]: e.target.value }))}
                    required
                  >
                    <option value="" disabled>
                      {pairingAvailable.length === 0 ? 'No registered players available' : 'Select a registered player…'}
                    </option>
                    {pairingAvailable.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button className="btn btn-primary" type="submit" disabled={!playerIds[pairing.id]}>Add</button>
                </form>
              );
            })()}
          </div>
        ))}
        {division.pairings.length === 0 && <p className="muted">No pairings registered yet</p>}
      </div>

      {!division.fixturesGenerated ? (
        <GenerateFixturesButton
          division={division}
          disabled={!canGenerate}
          title={!canGenerate ? `Add at least 2 pairings, each with exactly ${division.pairingSize} players` : ''}
          onChange={onChange}
          setError={setError}
        />
      ) : (
        <>
          <p className="muted">Fixtures generated — pairings are locked.</p>
          <GameTimeEstimate division={division} />
        </>
      )}
    </section>
  );
}

// Multi-stage competitions: rather than a whole new "groups then knockout"
// division type, this panel lets an admin auto-populate this division's
// (empty, not-yet-generated) roster from the top N finishers of one or more
// *other* divisions in the same league, pulled straight from their live
// standings - e.g. take the top 2 from each of several round-robin groups
// into this knockout. Groups stay ordinary round-robin divisions; nothing
// about generate-fixtures, scoring, or standings changes for the resulting
// division - it's just a division whose roster happened to be filled by
// group results instead of by hand. Hidden entirely once there's no other
// division of the same entry type in the league to seed from.
function SeedFromGroupsPanel({ division, onChange, setError }) {
  const [siblingDivisions, setSiblingDivisions] = useState([]);
  const [rows, setRows] = useState([{ divisionId: '', count: 2 }]);
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.getLeague(division.leagueId)
      .then((league) => {
        setSiblingDivisions(
          league.divisions.filter((d) => d.id !== division.id && d.entryType === division.entryType)
        );
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [division.leagueId, division.id]);

  if (siblingDivisions.length === 0) return null;

  const updateRow = (index, field, value) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const addRow = () => setRows((prev) => [...prev, { divisionId: '', count: 2 }]);
  const removeRow = (index) => setRows((prev) => prev.filter((_, i) => i !== index));

  const onSubmit = async (e) => {
    e.preventDefault();
    const sources = rows
      .filter((r) => r.divisionId && Number(r.count) > 0)
      .map((r) => ({ divisionId: r.divisionId, count: Number(r.count) }));
    if (sources.length === 0) return;
    setError('');
    setSummary(null);
    setSubmitting(true);
    try {
      const result = await api.seedFromGroups(division.id, sources);
      setSummary(result.seedSummary);
      setRows([{ divisionId: '', count: 2 }]);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <h2>Seed from Group Stage</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        For multi-stage competitions: pull the top finishers straight from another division's
        standings instead of adding entrants one at a time.
      </p>
      <form onSubmit={onSubmit}>
        {rows.map((row, i) => (
          <div key={i} className="inline-form" style={{ marginBottom: 8 }}>
            <select value={row.divisionId} onChange={(e) => updateRow(i, 'divisionId', e.target.value)}>
              <option value="">Select a group…</option>
              {siblingDivisions.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <input
              type="number"
              min="1"
              value={row.count}
              onChange={(e) => updateRow(i, 'count', e.target.value)}
              style={{ width: 70 }}
            />
            <span className="muted">advance</span>
            {rows.length > 1 && (
              <button type="button" className="btn-link" onClick={() => removeRow(i)}>remove</button>
            )}
          </div>
        ))}
        <button type="button" className="btn-link" onClick={addRow}>+ Add another group</button>
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Seeding…' : 'Seed Entrants'}
          </button>
        </div>
      </form>
      {summary && (
        <div className="banner banner-success" style={{ marginTop: 12 }}>
          {summary.map((s) => (
            <p key={s.divisionId} style={{ margin: 0 }}>
              {s.divisionName}: added {s.added} of top {s.requested} ({s.available} available)
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

// Admin-only, collapsed-by-default panel (same "Show/Hide" convention as
// the Admin Override panel on the fixture page) that groups this division's
// irreversible admin actions - Close Division Early and Delete Division -
// into one card, same as LeagueDetail's ManageLeaguePanel bundles Close
// League Early and Delete League one level up. `canCloseEarly` gates just
// the Close Division Early subsection (division must have fixtures
// generated and not already be completed); Delete Division is always
// available here since the parent only renders this panel for canManage.
// Available to an Overall Admin or a League Manager assigned to this
// division's league - see assertLeagueAccess in server/src/userAuth.js for
// the backend enforcement this mirrors.
function ManageDivisionPanel({ division, canCloseEarly, onChange, setError }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const onCloseEarly = async () => {
    setClosing(true);
    setError('');
    try {
      await api.closeDivisionEarly(division.id);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(false);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await api.deleteDivision(division.id);
      navigate(`/leagues/${division.leagueId}`);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Admin: Manage this Division</h2>
        <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          {canCloseEarly && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>Close Division Early</h3>
              <p className="muted">
                Force-completes every fixture in this division that isn't already finished at 0-0, with no
                winner - no confirmation from either side is needed. Use this to end a season early (a round
                robin that won't finish, a player pool that fell apart, running out of time). This can't be
                undone.
              </p>
              <button className="btn btn-primary" type="button" disabled={closing} onClick={onCloseEarly}>
                {closing ? 'Closing…' : 'Close this division now'}
              </button>
            </div>
          )}

          <div>
            <h3 style={{ marginBottom: '0.25rem' }}>Delete Division</h3>
            <p className="muted">
              Permanently deletes <strong>{division.name}</strong> and everything in it - every fixture,
              team and pairing, plus its roll-of-honour history. The rest of the league is untouched. This
              cannot be undone. To confirm, type the division's name below.
            </p>
            <label>
              Division name
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={division.name}
              />
            </label>
            <button
              className="btn btn-danger"
              type="button"
              disabled={deleting || confirmName.trim() !== division.name}
              onClick={onDelete}
            >
              {deleting ? 'Deleting…' : 'Delete this division permanently'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const KNOCKOUT_BRACKET_POLL_MS = 15000;

export default function DivisionDetail() {
  const { divisionId } = useParams();
  const { isAdmin, canManageLeague } = useAuth();
  const [division, setDivision] = useState(null);
  const [registeredPlayers, setRegisteredPlayers] = useState([]);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  const load = () => api.getDivision(divisionId).then(setDivision).catch((e) => setError(e.message));

  // Admin-only quick pick from the bracket chart below (BracketChart /
  // DoubleElimBracketChart's onSelectWinner prop) - lets an admin click a
  // player's name on a match that hasn't started yet and declare them the
  // winner directly, skipping frame-by-frame scoring entirely. `match` is
  // one of buildBracketMatches' normalized entries below (has homeId/awayId
  // alongside the display-only home/away name+score), `side` is whichever
  // entrant row was clicked. Confirms first since this bypasses the normal
  // submit/confirm handshake - see POST /api/fixtures/:id/select-winner.
  const handleSelectWinner = (match, side) => {
    const winner = side === 'home' ? match.home : match.away;
    const winnerId = side === 'home' ? match.homeId : match.awayId;
    if (!winnerId || !winner?.name) return;
    if (!window.confirm(`Set ${winner.name} as the winner of this match? No score will be recorded.`)) return;
    setError('');
    api.selectFixtureWinner(match.id, winnerId).then(load).catch((e) => setError(e.message));
  };

  useEffect(() => {
    mountedRef.current = true;
    load();
    api.getRegisteredPlayers().then(setRegisteredPlayers).catch((e) => setError(e.message));
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionId]);

  // Auto-refresh while a single-elimination knockout is live, so the
  // bracket chart below updates as results come in without a manual
  // reload - same "poll on an interval" approach as the Arena/public pages
  // rather than a websocket. Scoped to knockout divisions only (rather than
  // every division page) so round-robin admin workflows - editing a roster,
  // reordering entrants - don't get silently refreshed out from under
  // whoever's mid-edit.
  useEffect(() => {
    if (division?.scheduling !== 'knockout_single_elim') return undefined;
    const timer = setInterval(() => {
      if (mountedRef.current) load();
    }, KNOCKOUT_BRACKET_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [division?.scheduling, divisionId]);

  useSetBreadcrumbs(
    division
      ? [
          { label: 'Home', to: '/' },
          { label: division.leagueName || 'League', to: `/leagues/${division.leagueId}` },
          { label: division.name },
        ]
      : [{ label: 'Home', to: '/' }, { label: 'Loading…' }]
  );

  if (!division) return <p>Loading…</p>;

  // League Manager scoping - see hydrateDivision in server/src/index.js,
  // which embeds the owning league's managerUserIds onto the division
  // response specifically so this page doesn't need a second fetch.
  const canManage = canManageLeague({ managerUserIds: division.leagueManagerUserIds });

  const isTeams = division.entryType === 'teams';
  const isDoubles = division.entryType === 'doubles';
  const nameOf = (id) =>
    (isTeams ? division.teams : isDoubles ? division.pairings : division.players).find((x) => x.id === id)?.name || '—';

  // Double-elimination divisions carry a `bracketRole` on every fixture
  // ('winners' | 'losers' | 'grand_final' | 'grand_final_reset') - group by
  // that first, then by round within each group, so the winners bracket,
  // losers bracket and Grand Final render as clearly separate sections
  // instead of one interleaved round list. Everything else (round robin,
  // single-elimination) has bracketRole 'single' and renders exactly as
  // before - one flat list of rounds.
  const isDoubleElim = DOUBLE_ELIM_TYPES.includes(division.scheduling);
  const BRACKET_SECTION_LABEL = {
    winners: 'Winners Bracket',
    losers: 'Losers Bracket',
    grand_final: 'Grand Final',
    grand_final_reset: 'Grand Final — Bracket Reset (decider)',
  };

  function groupByRound(fixtures, useRawRoundNumber = false) {
    const byRound = {};
    for (const fixture of fixtures) {
      (byRound[fixture.round] ||= []).push(fixture);
    }
    // Relabel rounds 1, 2, 3... in order of appearance within this group
    // (rather than the raw, globally-offset round number) - used for the
    // Winners/Losers Bracket sections below, where round numbers are offset
    // by however many rounds came before them. The top-level flat list
    // (round robin / single elimination) passes useRawRoundNumber instead,
    // since a non-admin viewer may not have every round visible yet (see
    // "Manage Fixtures" / round release) - relabeling by position would
    // silently renumber Round 3 as "Round 1" once Rounds 1-2 are hidden from
    // them, which would be actively misleading rather than just cosmetic.
    return Object.keys(byRound)
      .map(Number)
      .sort((a, b) => a - b)
      .map((round, i) => ({ label: `Round ${useRawRoundNumber ? round : i + 1}`, fixtures: byRound[round] }));
  }

  // Single-elimination knockout: label rounds by their real distance from
  // the Final (Final, Semi-final, Quarter-final, Round of 16...) instead of
  // a raw round number - matches how a knockout bracket is normally talked
  // about (World Cup, FA Cup, etc). `division.totalRounds` (from
  // hydrateDivision) is the true round count even if an earlier round isn't
  // visible to this viewer yet, so this stays correct for non-admins too.
  // Anything beyond Round of 64 falls back to "Round N" rather than
  // guessing further names.
  const KNOCKOUT_ROUND_NAMES_FROM_FINAL = ['Final', 'Semi-final', 'Quarter-final', 'Round of 16', 'Round of 32', 'Round of 64'];
  const isSingleElimKnockout = division.scheduling === 'knockout_single_elim';
  function knockoutRoundLabel(round) {
    if (!division.totalRounds) return `Round ${round}`;
    const fromFinal = division.totalRounds - round;
    return KNOCKOUT_ROUND_NAMES_FROM_FINAL[fromFinal] || `Round ${round}`;
  }

  const fixturesByRound = groupByRound(division.fixtures, true).map((g) => [
    isSingleElimKnockout ? knockoutRoundLabel(g.fixtures[0].round) : g.label,
    g.fixtures,
  ]);

  const bracketSections = isDoubleElim
    ? ['winners', 'losers', 'grand_final', 'grand_final_reset']
        .map((role) => ({ role, fixtures: division.fixtures.filter((f) => f.bracketRole === role) }))
        .filter((s) => s.fixtures.length > 0)
    : [];

  return (
    <div>
      <p><Link to={`/leagues/${division.leagueId}`}>&larr; Back to league</Link></p>
      <h1>{division.name}</h1>
      <p className="muted">
        {isTeams
          ? `Team league · ${division.legsPerMatch} legs per match`
          : isDoubles
            ? `${division.pairingSize === 3 ? 'Triples' : 'Doubles'} league · ${division.pairingSize} players per pairing`
            : 'Singles league'}
      </p>
      {error && <p className="error">{error}</p>}

      {division.status === 'completed' && (
        <p className="banner banner-success">
          This division's season is complete{division.completedBy ? ` (closed by ${division.completedBy}${division.completedAt ? ` on ${new Date(division.completedAt).toLocaleDateString()}` : ''})` : ''}.
        </p>
      )}

      {division.leaguePayment?.required && (
        <p className="banner">
          This league requires a confirmed £{division.leaguePayment.amount} entry fee before a player can be
          added here. Manage payments from the{' '}
          <Link to={`/leagues/${division.leagueId}`}>league page</Link>.
        </p>
      )}

      {canManage && (
        <ManageDivisionPanel
          division={division}
          canCloseEarly={division.fixturesGenerated && division.status !== 'completed'}
          onChange={load}
          setError={setError}
        />
      )}

      {isTeams ? (
        <TeamRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      ) : isDoubles ? (
        <PairingRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      ) : (
        <SinglesRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} isAdmin={canManage} />
      )}

      {canManage && !division.fixturesGenerated && (
        <SeedFromGroupsPanel division={division} onChange={load} setError={setError} />
      )}

      {canManage && !isTeams && !isDoubles && division.fixturesGenerated && (
        <PlayerSubstitutionPanel division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      )}

      <section className="card">
        <h2>Standings</h2>
        <table className="standings-table">
          {isTeams ? (
            <>
              <thead>
                <tr>
                  <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>LF</th><th>LA</th><th>+/-</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>
                {division.standings.map((row, i) => (
                  <tr key={row.teamId}>
                    <td>{i + 1}</td>
                    <td>{row.teamName}</td>
                    <td>{row.played}</td>
                    <td>{row.won}</td>
                    <td>{row.drawn}</td>
                    <td>{row.lost}</td>
                    <td>{row.legsFor}</td>
                    <td>{row.legsAgainst}</td>
                    <td>{row.legDifference}</td>
                    <td><strong>{row.points}</strong></td>
                  </tr>
                ))}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <th>#</th><th>{isDoubles ? 'Pairing' : 'Player'}</th><th>P</th><th>W</th><th>L</th><th>F</th><th>A</th><th>+/-</th><th>Pts</th>
                </tr>
              </thead>
              <tbody>
                {division.standings.map((row, i) => (
                  <tr key={row.playerId}>
                    <td>{i + 1}</td>
                    <td>{isDoubles ? row.playerName : <Link to={`/players/${row.playerId}`}>{row.playerName}</Link>}</td>
                    <td>{row.played}</td>
                    <td>{row.won}</td>
                    <td>{row.lost}</td>
                    <td>{row.framesFor}</td>
                    <td>{row.framesAgainst}</td>
                    <td>{row.frameDifference}</td>
                    <td><strong>{row.points}</strong></td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </section>

      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Link className="btn btn-primary" to={`/public/divisions/${division.id}/table`}>View public Division Table &rarr;</Link>
        <Link className="btn btn-primary" to={`/public/divisions/${division.id}/fixtures`}>View public Division Fixtures &rarr;</Link>
      </p>
      {canManage && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          The two links above are live, unauthenticated pages meant to be embedded elsewhere (e.g. an
          &lt;iframe&gt; on another site) - copy either URL from your browser's address bar once you're on
          the page.
        </p>
      )}

      {isSingleElimKnockout && division.fixturesGenerated && division.fixtures.length > 0 && (
        <section className="card">
          <h2>Bracket</h2>
          {canManage && (
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: -4, marginBottom: 8 }}>
              Click a player's name on a match that hasn't started yet to set them as the winner directly - no score
              is recorded.
            </p>
          )}
          <BracketChart
            matches={buildBracketMatches(division.fixtures, isTeams, nameOf)}
            totalRounds={division.totalRounds}
            fixtureHref={(id) => `/fixtures/${id}`}
            onSelectWinner={canManage ? handleSelectWinner : undefined}
          />
          <p style={{ marginTop: 8 }}>
            <Link to={`/public/divisions/${division.id}/bracket`}>View public Bracket &rarr;</Link>
          </p>
          {canManage && (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              That link is a live, unauthenticated page meant to be embedded elsewhere (e.g. an
              &lt;iframe&gt; on another site) - copy the URL from your browser's address bar once you're on
              the page.
            </p>
          )}
        </section>
      )}

      {isDoubleElim && division.fixturesGenerated && division.fixtures.length > 0 && (
        <section className="card">
          <h2>Bracket</h2>
          {canManage && (
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: -4, marginBottom: 8 }}>
              Click a player's name on a match that hasn't started yet to set them as the winner directly - no score
              is recorded.
            </p>
          )}
          <DoubleElimBracketChart
            matches={buildDoubleElimMatches(division.fixtures, isTeams, nameOf)}
            fixtureHref={(id) => `/fixtures/${id}`}
            onSelectWinner={canManage ? handleSelectWinner : undefined}
          />
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
            Dashed lines show a loser dropping from the Winners Bracket into the Losers Bracket.
          </p>
          <p style={{ marginTop: 8 }}>
            <Link to={`/public/divisions/${division.id}/bracket`}>View public Bracket &rarr;</Link>
          </p>
          {canManage && (
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              That link is a live, unauthenticated page meant to be embedded elsewhere (e.g. an
              &lt;iframe&gt; on another site) - copy the URL from your browser's address bar once you're on
              the page.
            </p>
          )}
        </section>
      )}

      <section className="card">
        <div className="page-header">
          <h2>Fixtures</h2>
          {canManage && division.fixturesGenerated && (
            <Link to={`/admin/manage-fixtures/${division.id}`}>Manage round visibility</Link>
          )}
        </div>
        {canManage && division.fixturesGenerated && (
          <p className="muted" style={{ marginTop: -8, fontSize: '0.8rem' }}>
            Players currently see: {division.visibleRounds && division.visibleRounds.length > 0
              ? `Round${division.visibleRounds.length === 1 ? '' : 's'} ${[...division.visibleRounds].sort((a, b) => a - b).join(', ')}`
              : 'no rounds yet'}.
          </p>
        )}
        {division.fixtures.length === 0 && <p className="muted">No fixtures yet.</p>}
        {isDoubleElim
          ? bracketSections.map(({ role, fixtures }) => (
              <div key={role} className="bracket-section">
                <h3>{BRACKET_SECTION_LABEL[role]}</h3>
                {role === 'grand_final' || role === 'grand_final_reset' ? (
                  <FixtureList fixtures={fixtures} isTeams={isTeams} nameOf={nameOf} />
                ) : (
                  groupByRound(fixtures).map(({ label, fixtures: roundFixtures }) => (
                    <div key={label} className="round-block">
                      <h4>{label}</h4>
                      <FixtureList fixtures={roundFixtures} isTeams={isTeams} nameOf={nameOf} />
                    </div>
                  ))
                )}
              </div>
            ))
          : fixturesByRound.map(([label, fixtures]) => (
              <div key={label} className="round-block">
                <h3>{label}</h3>
                <FixtureList fixtures={fixtures} isTeams={isTeams} nameOf={nameOf} />
              </div>
            ))}
      </section>
    </div>
  );
}

// Normalizes a knockout division's raw fixtures into the shape
// BracketChart expects - same entrant-name/score lookups FixtureList uses
// below, just reshaped into { home, away } pairs plus a winnerSide so the
// chart can bold whoever won without re-deriving that from the raw IDs
// itself.
function buildBracketMatches(fixtures, isTeams, nameOf) {
  return fixtures.map((f) => {
    const homeId = isTeams ? f.homeTeamId : f.homePlayerId;
    const awayId = isTeams ? f.awayTeamId : f.awayPlayerId;
    const winnerId = isTeams ? f.winnerTeamId : f.winnerPlayerId;
    const homeScore = isTeams ? f.homeLegsWon : f.homeFrameScore;
    const awayScore = isTeams ? f.awayLegsWon : f.awayFrameScore;
    // f.scoreRecorded is only ever explicitly false for a fixture completed
    // via POST .../select-winner (see server/src/index.js) - everything
    // else (including a genuine 0-0 no-show walkover) leaves it undefined,
    // which is treated as "yes, show the score" exactly like before.
    const showScore = (f.status === 'completed' || f.bothEntrantsKnown) && f.scoreRecorded !== false;
    // Always-open round 1 slots (see MAX_RESERVED_BYE_COUNT, server-side)
    // held for a day-of late entrant, still unclaimed - shown as "Reserved"
    // rather than the usual blank/TBD side so it reads as "kept open on
    // purpose" instead of "waiting on an earlier round". Applies to both
    // single- and double-elimination brackets, since both use this
    // function (see buildDoubleElimMatches below, which layers its own
    // extra fields on top of this).
    const home = { name: homeId ? nameOf(homeId) : null, score: showScore ? homeScore : undefined };
    const away = {
      name: f.reserved ? 'Reserved' : (awayId ? nameOf(awayId) : null),
      score: showScore ? awayScore : undefined,
    };
    // Eligible for the bracket chart's "click a name to set the winner"
    // quick pick only when both entrants are known and nothing has been
    // recorded against it yet - mirrors POST .../select-winner's own
    // eligibility check server-side, so the UI never offers a click that
    // would just come back as a 400.
    const notStarted = isTeams ? (f.legs || []).every((l) => l.status === 'pending') : (f.frames || []).length === 0;
    const canSelectWinner = !!homeId && !!awayId && f.status === 'scheduled' && notStarted;
    return {
      id: f.id,
      round: f.round,
      home,
      away,
      homeId,
      awayId,
      status: f.status,
      bothEntrantsKnown: f.bothEntrantsKnown,
      winnerSide: f.status === 'completed' && winnerId ? (winnerId === homeId ? 'home' : 'away') : null,
      closedEarly: !!f.closedEarly,
      canSelectWinner,
      reserved: !!f.reserved,
    };
  });
}

// Same idea as buildBracketMatches above, but for a double-elimination
// division's chart (DoubleElimBracketChart) - it needs every raw
// fixture-to-fixture link (nextFixtureId, loserNextFixtureId,
// resetFixtureId) alongside the same display fields, since it positions
// and connects boxes by following those real ids rather than reconstructing
// structure from round numbers/array position the way BracketChart has to
// (see that component's header comment for why - it also has to render the
// public embed, which never gets these link fields; this chart never does).
function buildDoubleElimMatches(fixtures, isTeams, nameOf) {
  // Layers the extra link fields DoubleElimBracketChart needs on top of
  // buildBracketMatches above - to position and connect boxes by real
  // fixture id rather than round number/array position (see that
  // component's header comment for why).
  return buildBracketMatches(fixtures, isTeams, nameOf).map((m, i) => {
    const f = fixtures[i];
    return {
      ...m,
      bracketRole: f.bracketRole,
      nextFixtureId: f.nextFixtureId || null,
      loserNextFixtureId: f.loserNextFixtureId || null,
      resetFixtureId: f.resetFixtureId || null,
    };
  });
}

// A knockout fixture is created up front with `status: 'scheduled'` even
// before its two entrants are known (it's just waiting on an earlier
// round's winner to be filled in via propagateWinner - see
// server/src/index.js) - showing "scheduled" on it looks identical to a
// fixture that's genuinely ready to play right now, which is misleading.
// `bothEntrantsKnown` (added in hydrateDivision) distinguishes the two: a
// still-waiting fixture gets its own "awaiting result" badge instead.
function fixtureStatusLabel(f) {
  if (f.closedEarly) return 'closed early';
  if (f.status !== 'completed' && f.bothEntrantsKnown === false) return 'awaiting result';
  return f.status.replace('_', ' ');
}
function fixtureStatusClass(f) {
  if (!f.closedEarly && f.status !== 'completed' && f.bothEntrantsKnown === false) return 'status-awaiting';
  return `status-${f.status}`;
}

function FixtureList({ fixtures, isTeams, nameOf }) {
  return (
    <ul className="fixture-list">
      {fixtures.map((f) => {
        const homeId = isTeams ? f.homeTeamId : f.homePlayerId;
        const awayId = isTeams ? f.awayTeamId : f.awayPlayerId;
        const homeScore = isTeams ? f.homeLegsWon : f.homeFrameScore;
        const awayScore = isTeams ? f.awayLegsWon : f.awayFrameScore;
        return (
          <li key={f.id}>
            <Link to={`/fixtures/${f.id}`}>
              {nameOf(homeId)} <strong>{homeScore} - {awayScore}</strong> {nameOf(awayId)}
            </Link>
            <span className={`status ${fixtureStatusClass(f)}`}>
              {fixtureStatusLabel(f)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
