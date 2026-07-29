import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

function generateFixturesLabel(division) {
  if (division.scheduling === 'knockout_single_elim') return 'Generate Fixtures (single-elimination knockout)';
  if (division.scheduling === 'knockout_double_elim') return 'Generate Fixtures (double-elimination knockout)';
  if (division.scheduling === 'round_robin_double') return 'Generate Fixtures (Round Robin - Double, home and away)';
  return 'Generate Fixtures (Round Robin - Single, play each other once)';
}

function SinglesRoster({ division, registeredPlayers, onChange, setError }) {
  const [playerId, setPlayerId] = useState('');
  const alreadyIn = new Set(division.players.map((p) => p.id));
  const available = registeredPlayers.filter((p) => !alreadyIn.has(p.id));

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

  const onRemovePlayer = async (playerId) => {
    setError('');
    try {
      await api.removePlayer(division.id, playerId);
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
        Only people with a registered player account can be added - see "My Account" to register.
      </p>
      <ul className="player-list">
        {division.players.map((p) => (
          <li key={p.id}>
            <Link to={`/players/${p.id}`}>{p.name}</Link>
            {!division.fixturesGenerated && (
              <button className="btn-link" onClick={() => onRemovePlayer(p.id)}>remove</button>
            )}
          </li>
        ))}
        {division.players.length === 0 && <li className="muted">No players registered yet</li>}
      </ul>

      {!division.fixturesGenerated ? (
        <button
          className="btn btn-primary"
          disabled={division.players.length < 2}
          onClick={() => api.generateFixtures(division.id).then(onChange).catch((e) => setError(e.message))}
          title={division.players.length < 2 ? 'Add at least 2 players first' : ''}
        >
          {generateFixturesLabel(division)}
        </button>
      ) : (
        <p className="muted">Fixtures generated — player list is locked.</p>
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
        {division.teams.map((team) => (
          <div key={team.id} className="card">
            <div className="page-header">
              <h3 style={{ margin: 0 }}>{team.name}</h3>
              {!division.fixturesGenerated && (
                <button className="btn-link" onClick={() => onRemoveTeam(team.id)}>remove team</button>
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
        <button
          className="btn btn-primary"
          disabled={!canGenerate}
          onClick={() => api.generateFixtures(division.id).then(onChange).catch((e) => setError(e.message))}
          title={!canGenerate ? 'Add at least 2 teams, each with at least 1 player' : ''}
        >
          {generateFixturesLabel(division)}
        </button>
      ) : (
        <p className="muted">Fixtures generated — team rosters are locked.</p>
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
        {division.pairings.map((pairing) => (
          <div key={pairing.id} className="card">
            <div className="page-header">
              <h3 style={{ margin: 0 }}>{pairing.name}</h3>
              {!division.fixturesGenerated && (
                <button className="btn-link" onClick={() => onRemovePairing(pairing.id)}>remove pairing</button>
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
        <button
          className="btn btn-primary"
          disabled={!canGenerate}
          onClick={() => api.generateFixtures(division.id).then(onChange).catch((e) => setError(e.message))}
          title={!canGenerate ? `Add at least 2 pairings, each with exactly ${division.pairingSize} players` : ''}
        >
          {generateFixturesLabel(division)}
        </button>
      ) : (
        <p className="muted">Fixtures generated — pairings are locked.</p>
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

export default function DivisionDetail() {
  const { divisionId } = useParams();
  const { isAdmin } = useAuth();
  const [division, setDivision] = useState(null);
  const [registeredPlayers, setRegisteredPlayers] = useState([]);
  const [error, setError] = useState('');

  const load = () => api.getDivision(divisionId).then(setDivision).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api.getRegisteredPlayers().then(setRegisteredPlayers).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionId]);

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
  const isDoubleElim = division.scheduling === 'knockout_double_elim';
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

  const fixturesByRound = groupByRound(division.fixtures, true).map((g) => [g.label, g.fixtures]);

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

      {isTeams ? (
        <TeamRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      ) : isDoubles ? (
        <PairingRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      ) : (
        <SinglesRoster division={division} registeredPlayers={registeredPlayers} onChange={load} setError={setError} />
      )}

      {isAdmin && !division.fixturesGenerated && (
        <SeedFromGroupsPanel division={division} onChange={load} setError={setError} />
      )}

      {isAdmin && !isTeams && !isDoubles && division.fixturesGenerated && (
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

      <section className="card">
        <div className="page-header">
          <h2>Fixtures</h2>
          {isAdmin && division.fixturesGenerated && (
            <Link to={`/admin/manage-fixtures/${division.id}`}>Manage round visibility</Link>
          )}
        </div>
        {isAdmin && division.fixturesGenerated && (
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
            <span className={`status status-${f.status}`}>{f.status.replace('_', ' ')}</span>
          </li>
        );
      })}
    </ul>
  );
}
