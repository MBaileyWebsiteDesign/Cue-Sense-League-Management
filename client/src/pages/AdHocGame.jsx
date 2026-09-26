import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const KILLER_SCHEDULING = ['killer_classic', 'cards_killer'];
const FREE_PLAY_SCHEDULING = 'free_play';

// Step 1: game setup - deliberately the same fields and behaviour as
// LeagueDetail.jsx's "+ New Division" form (see its onAddDivision/showForm
// section), just relabelled for a player audience ("Game Name" instead of
// "Division name", "Select Players" instead of "Add Division") and with no
// league picker - every ad hoc game lands in the shared system league
// automatically (see server/src/index.js's POST /api/adhoc-games).
// Format cards (mobile redesign, 2026-09-23; expanded to show every format
// as a card, 2026-09-26 - Matt asked to drop the "More formats" toggle and
// give the rest of the list the same icon + colour treatment as the first
// four rather than a plain text row).
// Colour families (UI polish, 2026-09-26) reuse the site's existing
// status-chip tints rather than introducing new colours - see
// .fam-free/.fam-killer/.fam-knockout/.fam-league in styles.css.
const FORMATS = [
  { value: 'free_play', title: 'Free Play', desc: '2 players, no frame target', family: 'free' },
  { value: 'killer_classic', title: 'Killer', desc: 'Everyone in, play in order', family: 'killer' },
  { value: 'knockout_single_elim', title: 'Knockout', desc: 'Single elimination', family: 'knockout' },
  { value: 'round_robin_single', title: 'League', desc: 'Everyone plays each other once', family: 'league' },
  { value: 'cards_killer', title: 'Killer Random', desc: 'Player order randomised on each turn', family: 'killer' },
  { value: 'knockout_double_elim', title: 'Knockout (double elimination)', desc: 'Two losses and you are out', family: 'knockout' },
  { value: 'round_robin_double', title: 'League – double leg', desc: 'Everyone plays each other twice, home and away', family: 'league' },
  { value: 'knockout_double_elim_pcdek', title: 'Pre Configured Double Elimination Knockout', family: 'knockout' },
  { value: 'knockout_double_elim_adek', title: 'Adaptive Double Elimination Knockout', desc: 'No rematches before the finals', family: 'knockout' },
];
const ENTRY_TYPES = [
  { value: 'singles', label: 'Singles' },
  { value: 'teams', label: 'Teams' },
  { value: 'doubles', label: 'Doubles' },
];

function FormatIcon({ value }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (value === 'free_play') return <svg {...common}><circle cx="8" cy="12" r="3" /><circle cx="16" cy="12" r="3" /></svg>;
  if (value === 'killer_classic') return <svg {...common}><path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" /></svg>;
  if (value === 'knockout_single_elim') return <svg {...common}><path d="M4 5h5v6h6M4 19h5v-8M15 11h5" /></svg>;
  if (value === 'round_robin_single') return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
  // Killer Random - the classic Killer heart, with a shuffle mark to show the
  // turn order is randomised rather than fixed.
  if (value === 'cards_killer') {
    return (
      <svg {...common}>
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    );
  }
  // Double-elimination variants - two overlapping brackets, standing for the
  // winners and losers brackets a double-elim format runs side by side.
  if (value === 'knockout_double_elim' || value === 'knockout_double_elim_pcdek' || value === 'knockout_double_elim_adek') {
    return (
      <svg {...common}>
        <path d="M3 5h4v5h5" />
        <path d="M3 14h4v5h5" />
        <path d="M12 7.5h4" />
        <path d="M12 16.5h4" />
        <path d="M16 7.5v9" />
        {value === 'knockout_double_elim_pcdek' && <rect x="18" y="3" width="4" height="4" rx="1" />}
        {value === 'knockout_double_elim_adek' && <path d="M19 3.5a3 3 0 1 1-2.6 1.5" strokeWidth="1.6" />}
      </svg>
    );
  }
  // League - double leg: the league's three lines, played through twice.
  return (
    <svg {...common}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function StepIndicator({ step }) {
  return (
    <ol className="ah-steps" aria-label="Setup steps">
      <li className={step === 1 ? 'ah-step-on' : 'ah-step-done'}><span>1</span> Game</li>
      <li className={step === 2 ? 'ah-step-on' : ''}><span>2</span> Players</li>
    </ol>
  );
}

function GameSetupForm({ onCreated }) {
  const { user } = useAuth();
  const defaultName = `${`${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Player'} - ${new Date().toLocaleDateString()}`;
  const [name, setName] = useState(defaultName);
  const [entryType, setEntryType] = useState('singles');
  const [legsPerMatch, setLegsPerMatch] = useState(5);
  const [pairingSize, setPairingSize] = useState(2);
  const [scheduling, setScheduling] = useState(FREE_PLAY_SCHEDULING);
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

  const step = (setter, value, delta, min) => setter(Math.max(min, (Number(value) || min) + delta));

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
        name: name.trim(),
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

  const FormatCard = ({ f }) => (
    <button
      type="button"
      className={`ah-format${scheduling === f.value ? ' ah-format-on' : ''}`}
      aria-pressed={scheduling === f.value}
      onClick={() => onSchedulingChange(f.value)}
    >
      {scheduling === f.value && (
        <span className="ah-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      )}
      <span className={`ah-badge fam-${f.family}`}>
        <FormatIcon value={f.value} />
      </span>
      <strong>{f.title}</strong>
      {f.desc && <span className="desc">{f.desc}</span>}
    </button>
  );

  return (
    <form className="card ah-form" onSubmit={onSubmit}>
      <h2>Game details</h2>
      <label className="ah-field">
        <span className="ah-label">Game name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday Night Decider" required />
      </label>

      <div className="ah-field">
        <span className="ah-label">Format</span>
        <div className="ah-formats">
          {FORMATS.map((f) => <FormatCard key={f.value} f={f} />)}
        </div>
        <span className="ah-hint">
          {isFreePlay
            ? 'No frame target - finish whenever someone is ahead.'
            : isKiller
              ? 'Free-for-all - everyone plays in one game, no fixed sides.'
              : ''}
        </span>
      </div>

      {isKiller || isFreePlay ? (
        <div className="ah-field">
          <span className="ah-label">Entry type</span>
          <span className="ah-chip">Singles</span>
        </div>
      ) : (
        <div className="ah-field">
          <span className="ah-label">Entry type</span>
          <div className="ah-pills" role="group" aria-label="Entry type">
            {ENTRY_TYPES.map((t) => (
              <button key={t.value} type="button" className={entryType === t.value ? 'ah-pill-on' : ''} aria-pressed={entryType === t.value} onClick={() => setEntryType(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
          {entryType === 'teams' && (
            <div className="ah-stepper-row">
              <span>Legs per match</span>
              <div className="ah-stepper">
                <button type="button" aria-label="Fewer legs" onClick={() => step(setLegsPerMatch, legsPerMatch, -1, 1)}>−</button>
                <output>{legsPerMatch}</output>
                <button type="button" aria-label="More legs" onClick={() => step(setLegsPerMatch, legsPerMatch, 1, 1)}>+</button>
              </div>
            </div>
          )}
          {entryType === 'doubles' && (
            <div className="ah-pills" role="group" aria-label="Players per pairing" style={{ marginTop: 8 }}>
              <button type="button" className={Number(pairingSize) === 2 ? 'ah-pill-on' : ''} aria-pressed={Number(pairingSize) === 2} onClick={() => setPairingSize(2)}>Doubles (2)</button>
              <button type="button" className={Number(pairingSize) === 3 ? 'ah-pill-on' : ''} aria-pressed={Number(pairingSize) === 3} onClick={() => setPairingSize(3)}>Triples (3)</button>
            </div>
          )}
        </div>
      )}

      {isKiller && (
        <div className="ah-field">
          <div className="ah-stepper-row">
            <span className="ah-label">Starting lives</span>
            <div className="ah-stepper">
              <button type="button" aria-label="Fewer lives" onClick={() => step(setStartingLives, startingLives, -1, 1)}>−</button>
              <output>{startingLives}</output>
              <button type="button" aria-label="More lives" onClick={() => step(setStartingLives, startingLives, 1, 1)}>+</button>
            </div>
          </div>
        </div>
      )}

      {!isKiller && !isFreePlay && (
        <div className="ah-field">
          <span className="ah-label">Match length</span>
          <div className="ah-pills" role="group" aria-label="Match format">
            <button type="button" className={formatMode === 'raceTo' ? 'ah-pill-on' : ''} aria-pressed={formatMode === 'raceTo'} onClick={() => setFormatMode('raceTo')}>Race to</button>
            <button
              type="button"
              className={formatMode === 'bestOf' ? 'ah-pill-on' : ''}
              aria-pressed={formatMode === 'bestOf'}
              onClick={() => { setFormatMode('bestOf'); if (Number(formatValue) % 2 === 0) setFormatValue(Number(formatValue) + 1); }}
            >
              Best of
            </button>
          </div>
          <div className="ah-stepper-row">
            <span>{formatMode === 'bestOf' ? 'Best of' : 'Race to'} (frames)</span>
            <div className="ah-stepper">
              <button type="button" aria-label="Fewer frames" onClick={() => step(setFormatValue, formatValue, formatMode === 'bestOf' ? -2 : -1, 1)}>−</button>
              <output>{formatValue}</output>
              <button type="button" aria-label="More frames" onClick={() => step(setFormatValue, formatValue, formatMode === 'bestOf' ? 2 : 1, 1)}>+</button>
            </div>
          </div>
          {formatMode === 'bestOf' && Number(formatValue) % 2 === 1 && (
            <span className="ah-hint">= Race to {(Number(formatValue) + 1) / 2}</span>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary ah-next" type="submit" disabled={submitting || !name.trim()}>
        {submitting ? 'Creating…' : 'Next: add players'}
      </button>
    </form>
  );
}

// Simple flat player search/add - singles entry type only. Trimmed-down
// version of DivisionDetail.jsx's SinglesRoster: includes walk-in quick add
// (a player building their own ad hoc roster needs a way to add someone
// without a CueSense account), but no late entrant/reserved slot handling
// or manual seeding - fixtures aren't generated until "Start Game", so none
// of that applies before a first ad hoc game roster even has two names in it.

function SinglesPicker({ division, registeredPlayers, onChange, setError }) {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [quickFirstName, setQuickFirstName] = useState('');
  const [quickLastName, setQuickLastName] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  const alreadyIn = new Set(division.players.map((p) => p.id));
  const available = registeredPlayers.filter((p) => !alreadyIn.has(p.id));
  const isFreePlay = division.scheduling === FREE_PLAY_SCHEDULING;
  // Free Play is a 2-player match - both add paths below hide once the 2nd
  // is in, matching DivisionDetail.jsx's SinglesRoster and the server-side
  // cap on POST /divisions/:id/players and /quick-add-player.
  const freePlayFull = isFreePlay && division.players.length >= 2;
  const q = search.trim().toLowerCase();
  const matches = q ? available.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20) : available.slice(0, 8);

  const onAdd = async (id) => {
    setError('');
    setBusyId(id);
    try {
      await api.addPlayer(division.id, id);
      setSearch('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const onQuickAdd = async (e) => {
    e.preventDefault();
    if (!quickFirstName.trim()) return;
    setError('');
    setQuickAdding(true);
    try {
      await api.quickAddPlayer(division.id, quickFirstName.trim(), quickLastName.trim() || null);
      setQuickFirstName('');
      setQuickLastName('');
      setWalkInOpen(false);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setQuickAdding(false);
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

  const opponent = isFreePlay ? division.players.find((p) => p.id !== user?.playerId) : null;
  const me = isFreePlay ? division.players.find((p) => p.id === user?.playerId) : null;

  return (
    <section className="card ah-players">
      {isFreePlay && (
        <div className="ah-vs">
          <div className="ah-vs-side ah-vs-home"><span className="ah-vs-bar" /><strong>{me ? me.name : (division.players[0]?.name || 'Player 1')}</strong></div>
          <span className="ah-vs-mid">vs</span>
          <div className="ah-vs-side ah-vs-away"><span className="ah-vs-bar" /><strong>{opponent ? opponent.name : (division.players.length >= 2 ? division.players[1].name : '?')}</strong></div>
        </div>
      )}

      <h3 className="ah-h3">Players <span className="muted">({division.players.length}{isFreePlay ? ' of 2' : ''})</span></h3>
      <ul className="ah-list">
        {division.players.map((p) => (
          <li key={p.id}>
            <span className="ah-avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
            <span className="ah-grow">{p.name}{p.id === user?.playerId ? <span className="muted"> (you)</span> : null}</span>
            <button type="button" className="ah-remove" aria-label={`Remove ${p.name}`} onClick={() => onRemove(p.id)}>×</button>
          </li>
        ))}
        {division.players.length === 0 && <li className="muted">No players added yet</li>}
      </ul>

      {freePlayFull ? (
        <p className="muted ah-hint" style={{ marginTop: 8 }}>Free Play is a 2-player match - remove a player above to swap who's in it.</p>
      ) : (
        <>
          <h3 className="ah-h3" style={{ marginTop: 16 }}>{isFreePlay ? 'Choose your opponent' : 'Add players'}</h3>
          <input
            type="search"
            className="ah-search"
            placeholder="Search registered players"
            aria-label="Search registered players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="ah-list ah-results">
            {matches.map((p) => (
              <li key={p.id}>
                <span className="ah-avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="ah-grow">{p.name}</span>
                <button type="button" className="btn btn-primary ah-add" disabled={busyId === p.id} onClick={() => onAdd(p.id)}>
                  {busyId === p.id ? 'Adding…' : 'Add'}
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="muted">{available.length === 0 ? 'No registered players available' : 'No players match that search'}</li>
            )}
          </ul>
          {!q && available.length > matches.length && (
            <p className="muted ah-hint">Showing {matches.length} of {available.length} - search to find someone else.</p>
          )}

          <div className="ah-walkin">
            <button type="button" className="ah-walkin-toggle" aria-expanded={walkInOpen} onClick={() => setWalkInOpen((o) => !o)}>
              <span>+ Add a walk-in</span>
              <span className="muted ah-hint">No account needed</span>
            </button>
            {walkInOpen && (
              <form className="ah-walkin-form" onSubmit={onQuickAdd}>
                <input type="text" placeholder="First name *" aria-label="First name (required)" value={quickFirstName} onChange={(e) => setQuickFirstName(e.target.value)} required />
                <input type="text" placeholder="Last name (optional)" aria-label="Last name (optional)" value={quickLastName} onChange={(e) => setQuickLastName(e.target.value)} />
                <button className="btn btn-primary" type="submit" disabled={quickAdding || !quickFirstName.trim()}>
                  {quickAdding ? 'Adding…' : 'Add walk-in'}
                </button>
              </form>
            )}
          </div>
        </>
      )}
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
  const { user } = useAuth();

  const reload = () => api.getDivision(justCreated.id).then(setDivision).catch((e) => setError(e.message));

  useEffect(() => {
    api.getRegisteredPlayers().then(setRegisteredPlayers).catch(() => setRegisteredPlayers([]));
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Free Play is just the creator vs one opponent - pre-add the creator
  // themselves the moment the (still-empty) roster loads, so all that's
  // left for them to do is add the other player. Only ever fires while the
  // roster is empty, so it can't run twice: once the add succeeds and
  // `division` reloads, `division.players.length` is 1 and this condition
  // no longer holds. Skipped entirely if the logged-in account has no
  // player profile of its own (e.g. an admin with no player record).
  useEffect(() => {
    if (
      division &&
      division.scheduling === FREE_PLAY_SCHEDULING &&
      division.entryType === 'singles' &&
      division.players.length === 0 &&
      user?.playerId
    ) {
      api.addPlayer(division.id, user.playerId).then(reload).catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [division]);

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
        onStarted(`/divisions/${division.id}`);
      } else {
        const updated = await api.generateFixtures(division.id, { visibleByDefault: true });
        // Free Play always generates exactly one fixture (see FREE_PLAY in
        // server/src/index.js and the 2-player roster cap this wizard's
        // SinglesPicker enforces) - send the player straight into it rather
        // than the division overview, since there's nothing else on that
        // page for a 2-player one-off match to show them.
        if (division.scheduling === FREE_PLAY_SCHEDULING && updated.fixtures?.length === 1) {
          onStarted(`/fixtures/${updated.fixtures[0].id}`);
        } else {
          onStarted(`/divisions/${division.id}`);
        }
      }
    } catch (err) {
      setError(err.message);
      setStarting(false);
    }
  };

  return (
    <div>
      <StepIndicator step={2} />
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
        className="btn btn-primary ah-next"
        type="button"
        disabled={!canStart || starting}
        onClick={onStart}
        title={canStart ? '' : 'Add enough players first'}
      >
        {starting ? 'Starting…' : canStart ? 'Start game' : 'Add players to start'}
      </button>
    </div>
  );
}

// A player-initiated, one-off game - see PlayerPortal.jsx's "+ Ad Hoc Game"
// and "Quick Game" buttons. Two steps: set the game up (same fields as a
// League Manager's "+ New Division" form, see GameSetupForm), then add
// players and start (see SelectPlayers). "Start Game" normally lands on the
// resulting division's own page (/divisions/:id) - from there on, it
// behaves exactly like any other division (results, standings, disputes,
// the lot), just without a real league season around it. Free Play is the
// one exception: SelectPlayers' onStart sends it straight to /fixtures/:id
// instead, since a Free Play "division" is just the one 2-player match and
// there's nothing else on the division overview worth stopping at first.
//
// `quickStart` (set by the "Quick Game" button/route, /adhoc-game/quick)
// skips GameSetupForm entirely: on mount it calls createAdHocGame itself
// with a Free Play/Singles game pre-named "<Player Name> - <Date Created>"
// (the logged-in user's name and the date the button was clicked), landing
// the player straight on SelectPlayers with only the opponent left to add -
// SelectPlayers' own pre-add effect (above) still adds the creator
// themselves.
export default function AdHocGame({ quickStart = false }) {
  const navigate = useNavigate();
  const [createdDivision, setCreatedDivision] = useState(null);
  const [quickError, setQuickError] = useState('');
  // Players landing on this page have no leagues section to browse back to
  // (it's just a one-off 2-player Free Play game), so their Home crumb goes
  // straight to their own portal instead of the general leagues list.
  const { user, isAdmin, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  const pageTitle = quickStart ? 'Head-to-Head' : 'Ad Hoc Game';
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'My Account', to: '/account' }, { label: pageTitle }]);

  useEffect(() => {
    if (!quickStart || createdDivision) return;
    let cancelled = false;
    const playerName = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Player';
    const dateCreated = new Date().toLocaleDateString();
    api.createAdHocGame({
      name: `${playerName} - ${dateCreated}`,
      entryType: 'singles',
      scheduling: FREE_PLAY_SCHEDULING,
    }).then((division) => {
      if (!cancelled) setCreatedDivision(division);
    }).catch((err) => {
      if (!cancelled) setQuickError(err.message);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickStart]);

  return (
    <div className="ah-page">
      <div className="au-head">
        <Link to="/account" className="msg-icon-btn" aria-label="Back to my account">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>{pageTitle}</h1>
      </div>
      {!createdDivision && !quickStart && (
        <p className="muted">Set up a one-off game - not tied to any league season.</p>
      )}
      {!createdDivision && quickStart && !quickError && (
        <p className="muted">Setting up your Free Play game…</p>
      )}

      {quickStart && !createdDivision ? (
        quickError ? <p className="error">{quickError}</p> : <p>Creating your game…</p>
      ) : !createdDivision ? (
        <>
          <StepIndicator step={1} />
          <GameSetupForm onCreated={setCreatedDivision} />
        </>
      ) : (
        <SelectPlayers justCreated={createdDivision} onStarted={(path) => navigate(path)} />
      )}
    </div>
  );
}
