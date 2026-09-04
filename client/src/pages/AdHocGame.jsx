import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const KILLER_SCHEDULING = ['killer_classic', 'cards_killer'];
const FREE_PLAY_SCHEDULING = 'free_play';

// Step 1: game setup - deliberately the same fields and behaviour as
// LeagueDetail.jsx's "+ New Division" form (see its onAddDivision/showForm
// section), just relabelled for a player audience ("Game Name" instead of
// "Division name", "Select Players" instead of "Add Division") and with no
// league picker - every ad hoc game lands in the shared system league
// automatically (see server/src/index.js's POST /api/adhoc-games).
function GameSetupForm({ onCreated }) {
  const [name, setName] = useState('');
  const [entryType, setEntryType] = useState('singles');
  const [legsPerMatch, setLegsPerMatch] = useState(5);
  const [pairingSize, setPairingSize] = useState(2);
  const [scheduling, setScheduling] = useState('round_robin_single');
  // Match length - see LeagueDetail.jsx's identical raceTo/bestOf comment
  // for why two input modes are offered; only the resulting raceTo is sent.
  const [formatMode, setFormatMode] = useState('raceTo');
  const [formatValue, setFormatValue] = useState(6);
  const [startingLives, setStartingLives] = useState(3);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isKiller = KILLER_SCHEDULING.includes(scheduling);
  const isFreePlay = scheduling === FREE_PLAY_SCHEDULING;

  const onSchedulingChange = (value) => {
    setScheduling(value);
    // No fixed sides in a free-for-all/2-player game.
    if (KILLER_SCHEDULING.includes(value) || value === FREE_PLAY_SCHEDULING) setEntryType('singles');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    let raceTo;
    if (!isKiller && !isFreePlay) {
      const numericFormatValue = Number(formatValue);
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
    } else if (!Number.isInteger(Number(startingLives)) || Number(startingLives) < 1) {
      setError('Starting lives must be a whole number of 1 or more');
      return;
    }
    setSubmitting(true);
    try {
      const division = await api.createAdHocGame({
        name,
        entryType,
        scheduling,
        ...(isKiller ? { startingLives: Number(startingLives) } : { raceTo }),
        ...(entryType === 'teams' ? { legsPerMatch: Number(legsPerMatch) } : {}),
        ...(entryType === 'doubles' ? { pairingSize: Number(pairingSize) } : {}),
      });
      onCreated(division);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <label>
        Game Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Friday Night Decider"
          required
        />
      </label>
      <label>
        Entry type
        <select value={entryType} onChange={(e) => setEntryType(e.target.value)} disabled={isKiller || isFreePlay}>
          {isKiller ? (
            <option value="singles">Singles (one player at a time, everyone in the game together)</option>
          ) : isFreePlay ? (
            <option value="singles">Singles (one player vs one player)</option>
          ) : (
            <>
              <option value="singles">Singles (one player vs one player)</option>
              <option value="teams">Teams (team vs team, made up of legs)</option>
              <option value="doubles">Doubles/Triples (2-3 player pairing vs pairing, alternate-shot)</option>
            </>
          )}
        </select>
        {isKiller && (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            Killer Classic/Cards Killer are free-for-all games with no fixed sides, so this is locked to Singles.
          </span>
        )}
        {isFreePlay && (
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            Free Play is a 2-player game, so this is locked to Singles.
          </span>
        )}
      </label>
      {entryType === 'teams' && !isKiller && !isFreePlay && (
        <label>
          Legs per match
          <input
            type="number"
            min="1"
            value={legsPerMatch}
            onChange={(e) => setLegsPerMatch(e.target.value)}
            required
          />
        </label>
      )}
      {entryType === 'doubles' && !isKiller && !isFreePlay && (
        <label>
          Players per pairing
          <select value={pairingSize} onChange={(e) => setPairingSize(e.target.value)}>
            <option value={2}>2 (doubles)</option>
            <option value={3}>3 (triples)</option>
          </select>
        </label>
      )}
      <label>
        Format
        <select value={scheduling} onChange={(e) => onSchedulingChange(e.target.value)}>
          <option value="free_play">Free Play (2 player free style, no frame count target)</option>
          <option value="killer_classic">Killer Classic (Players play in order)</option>
          <option value="cards_killer">Killer Random (Player order randomised on each turn)</option>
          <option value="knockout_single_elim">Knockout (single elimination)</option>
          <option value="knockout_double_elim">Knockout (double elimination)</option>
          <option value="round_robin_single">Standard League - Single Leg (Everyone plays each other once)</option>
          <option value="round_robin_double">Standard League - Double Leg (Everyone plays each other twice, home and away)</option>
        </select>
      </label>
      {isKiller ? (
        <label>
          Starting lives
          <input
            type="number"
            min="1"
            value={startingLives}
            onChange={(e) => setStartingLives(e.target.value)}
            required
          />
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            Every player starts the game with this many lives - there's no per-match race to a number of frames in
            {' '}{scheduling === 'cards_killer' ? 'Cards Killer' : 'Killer Classic'}, so Match format/Race to don't apply.
          </span>
        </label>
      ) : isFreePlay ? (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          Free Play has no frame count target, so Match format/Race to don't apply - frames are still recorded one
          at a time, and either player can finish the match themselves whenever the scores aren't level.
        </p>
      ) : (
        <>
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
            {formatMode === 'bestOf' && (() => {
              const v = Number(formatValue);
              if (!Number.isInteger(v) || v < 1) return null;
              return v % 2 === 0 ? (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  Best of must be an odd number, so it can't end level.
                </span>
              ) : (
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  = Race to {(v + 1) / 2} - first to {(v + 1) / 2} frame{(v + 1) / 2 === 1 ? '' : 's'} wins the
                  match; any frames that can no longer affect the result aren't played.
                </span>
              );
            })()}
          </label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={submitting || !name.trim()}>
        {submitting ? 'Creating…' : 'Select Players'}
      </button>
    </form>
  );
}

// Simple flat player search/add - singles entry type only. Trimmed-down
// version of DivisionDetail.jsx's SinglesRoster: no walk-in quick add, late
// entrant handling, or manual seeding, none of which apply before a first
// ad hoc game roster even has two names in it.
function SinglesPicker({ division, registeredPlayers, onChange, setError }) {
  const [playerId, setPlayerId] = useState('');
  const alreadyIn = new Set(division.players.map((p) => p.id));
  const available = registeredPlayers.filter((p) => !alreadyIn.has(p.id));

  const onAdd = async (e) => {
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

  const onRemove = async (id) => {
    setError('');
    try {
      await api.removePlayer(division.id, id);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Players</h3>
      <form className="inline-form" onSubmit={onAdd}>
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
      <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: '0.8rem' }}>
        Only people with a registered player account can be added - see "My Account" to register.
      </p>
      <ul className="player-list">
        {division.players.map((p) => (
          <li key={p.id}>
            {p.name}
            <button className="btn-link" onClick={() => onRemove(p.id)}>remove</button>
          </li>
        ))}
        {division.players.length === 0 && <li className="muted">No players added yet</li>}
      </ul>
    </section>
  );
}

// Team roster builder - teams entry type only. Trimmed-down version of
// DivisionDetail.jsx's TeamRoster (no manual seed reordering, which only
// matters once there are enough entrants that seed order is worth
// controlling by hand - not a concern for a first ad hoc game roster).
function TeamsPicker({ division, registeredPlayers, onChange, setError }) {
  const [teamName, setTeamName] = useState('');
  const [playerIds, setPlayerIds] = useState({}); // teamId -> selected registered playerId
  const assignedElsewhere = new Set(division.teams.flatMap((t) => t.players.map((p) => p.id)));

  const onAddTeam = async (e) => {
    e.preventDefault();
    if (!teamName.trim()) return;
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

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Teams</h3>
      <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: '0.8rem' }}>
        Only people with a registered player account can be added to a team roster.
      </p>
      <form className="inline-form" onSubmit={onAddTeam}>
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" required />
        <button className="btn btn-primary" type="submit">Add Team</button>
      </form>

      <div className="card-grid">
        {division.teams.map((team) => (
          <div key={team.id} className="card">
            <div className="page-header">
              <h4 style={{ margin: 0 }}>{team.name}</h4>
              <button className="btn-link" onClick={() => onRemoveTeam(team.id)}>remove team</button>
            </div>
            <ul className="player-list">
              {team.players.map((p) => (
                <li key={p.id}>
                  {p.name}
                  <button className="btn-link" onClick={() => onRemoveTeamPlayer(team.id, p.id)}>remove</button>
                </li>
              ))}
              {team.players.length === 0 && <li className="muted">No players yet</li>}
            </ul>
            {(() => {
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
        {division.teams.length === 0 && <p className="muted">No teams added yet</p>}
      </div>
    </section>
  );
}

// Pairing (doubles/triples) roster builder - doubles entry type only.
// Trimmed-down version of DivisionDetail.jsx's PairingRoster, same
// simplifications as TeamsPicker above.
function PairingsPicker({ division, registeredPlayers, onChange, setError }) {
  const [pairingName, setPairingName] = useState('');
  const [playerIds, setPlayerIds] = useState({}); // pairingId -> selected registered playerId
  const assignedElsewhere = new Set(division.pairings.flatMap((p) => p.players.map((pl) => pl.id)));
  const noun = division.pairingSize === 3 ? 'Triples' : 'Doubles';

  const onAddPairing = async (e) => {
    e.preventDefault();
    if (!pairingName.trim()) return;
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

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Pairings</h3>
      <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: '0.8rem' }}>
        {noun} - each pairing needs exactly {division.pairingSize} registered players before the game can start.
      </p>
      <form className="inline-form" onSubmit={onAddPairing}>
        <input value={pairingName} onChange={(e) => setPairingName(e.target.value)} placeholder="Pairing name" required />
        <button className="btn btn-primary" type="submit">Add Pairing</button>
      </form>

      <div className="card-grid">
        {division.pairings.map((pairing) => (
          <div key={pairing.id} className="card">
            <div className="page-header">
              <h4 style={{ margin: 0 }}>{pairing.name}</h4>
              <button className="btn-link" onClick={() => onRemovePairing(pairing.id)}>remove pairing</button>
            </div>
            <ul className="player-list">
              {pairing.players.map((p) => (
                <li key={p.id}>
                  {p.name}
                  <button className="btn-link" onClick={() => onRemovePairingPlayer(pairing.id, p.id)}>remove</button>
                </li>
              ))}
              {pairing.players.length === 0 && <li className="muted">No players yet</li>}
            </ul>
            {pairing.players.length < division.pairingSize && (() => {
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
        {division.pairings.length === 0 && <p className="muted">No pairings added yet</p>}
      </div>
    </section>
  );
}

// Step 2: pick who's playing, then start. Re-fetches the (hydrated) division
// itself on mount and after every roster change - `justCreated` (the raw,
// unhydrated record POST /api/adhoc-games returns) only ever supplies the id
// to fetch by.
function SelectPlayers({ justCreated, onStarted }) {
  const [division, setDivision] = useState(null);
  const [registeredPlayers, setRegisteredPlayers] = useState([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const reload = () => api.getDivision(justCreated.id).then(setDivision).catch((e) => setError(e.message));

  useEffect(() => {
    api.getRegisteredPlayers().then(setRegisteredPlayers).catch(() => setRegisteredPlayers([]));
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!division) return <p>Loading…</p>;

  const isKiller = KILLER_SCHEDULING.includes(division.scheduling);
  const canStart =
    division.entryType === 'teams'
      ? division.teams.length >= 2 && division.teams.every((t) => t.players.length >= 1)
      : division.entryType === 'doubles'
        ? division.pairings.length >= 2 && division.pairings.every((p) => p.players.length === division.pairingSize)
        : division.players.length >= 2;

  const onStart = async () => {
    setError('');
    setStarting(true);
    try {
      if (isKiller) {
        await api.startKiller(division.id);
      } else {
        await api.generateFixtures(division.id, { visibleByDefault: true });
      }
      onStarted(division.id);
    } catch (err) {
      setError(err.message);
      setStarting(false);
    }
  };

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>{division.name}</h2>
      <p className="muted" style={{ marginTop: 0 }}>Add everyone who's playing, then start the game.</p>

      {division.entryType === 'singles' && (
        <SinglesPicker division={division} registeredPlayers={registeredPlayers} onChange={reload} setError={setError} />
      )}
      {division.entryType === 'teams' && (
        <TeamsPicker division={division} registeredPlayers={registeredPlayers} onChange={reload} setError={setError} />
      )}
      {division.entryType === 'doubles' && (
        <PairingsPicker division={division} registeredPlayers={registeredPlayers} onChange={reload} setError={setError} />
      )}

      {error && <p className="error">{error}</p>}
      <button
        className="btn btn-primary"
        type="button"
        disabled={!canStart || starting}
        onClick={onStart}
        title={canStart ? '' : 'Add enough players first'}
      >
        {starting ? 'Starting…' : 'Start Game'}
      </button>
    </div>
  );
}

// A player-initiated, one-off game - see PlayerPortal.jsx's "+ Ad Hoc Game"
// button. Two steps: set the game up (same fields as a League Manager's
// "+ New Division" form, see GameSetupForm), then add players and start
// (see SelectPlayers). "Start Game" lands on the resulting division's own
// page (/divisions/:id) - from there on, it behaves exactly like any other
// division (results, standings, disputes, the lot), just without a real
// league season around it.
export default function AdHocGame() {
  const navigate = useNavigate();
  const [createdDivision, setCreatedDivision] = useState(null);
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'My Account', to: '/account' }, { label: 'Ad Hoc Game' }]);

  return (
    <div>
      {!createdDivision && <p><Link to="/account">&larr; My Account</Link></p>}
      <div className="page-header">
        <div>
          <h1>Ad Hoc Game</h1>
          {!createdDivision && (
            <p className="muted">Set up a one-off game - not tied to any league season.</p>
          )}
        </div>
      </div>

      {!createdDivision ? (
        <GameSetupForm onCreated={setCreatedDivision} />
      ) : (
        <SelectPlayers justCreated={createdDivision} onStarted={(id) => navigate(`/divisions/${id}`)} />
      )}
    </div>
  );
}
