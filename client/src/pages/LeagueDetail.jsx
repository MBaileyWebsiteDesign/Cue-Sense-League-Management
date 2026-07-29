import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

export default function LeagueDetail() {
  const { isAdmin } = useAuth();
  const { leagueId } = useParams();
  const [league, setLeague] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [entryType, setEntryType] = useState('singles');
  const [legsPerMatch, setLegsPerMatch] = useState(5);
  const [pairingSize, setPairingSize] = useState(2);
  const [scheduling, setScheduling] = useState('round_robin_single');
  const [showForm, setShowForm] = useState(false);

  useSetBreadcrumbs(
    league
      ? [{ label: 'Home', to: '/' }, { label: league.name }]
      : [{ label: 'Home', to: '/' }, { label: 'Loading…' }]
  );

  const load = () => api.getLeague(leagueId).then(setLeague).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId]);

  const onAddDivision = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.createDivision(leagueId, {
        name,
        order: league.divisions.length,
        entryType,
        scheduling,
        ...(entryType === 'teams' ? { legsPerMatch: Number(legsPerMatch) } : {}),
        ...(entryType === 'doubles' ? { pairingSize: Number(pairingSize) } : {}),
      });
      setName('');
      setEntryType('singles');
      setLegsPerMatch(5);
      setPairingSize(2);
      setScheduling('round_robin_single');
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!league) return <p>Loading…</p>;

  return (
    <div>
      <p><Link to="/">&larr; All leagues</Link></p>
      <div className="page-header">
        <div>
          <h1>{league.name}</h1>
          <p className="muted">
            {league.sport} · {league.format.matchFormat}, race to {league.format.raceTo}, single round robin
          </p>
        </div>
        {isAdmin && (
          <button className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ New Division'}
          </button>
        )}
      </div>

      {showForm && isAdmin && (
        <form className="card form" onSubmit={onAddDivision}>
          <label>
            Division name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Division 1" required />
          </label>
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
              <input
                type="number"
                min="1"
                value={legsPerMatch}
                onChange={(e) => setLegsPerMatch(e.target.value)}
                required
              />
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
            Format
            <select value={scheduling} onChange={(e) => setScheduling(e.target.value)}>
              <option value="round_robin_single">Round Robin - Single (everyone plays each other once)</option>
              <option value="round_robin_double">Round Robin - Double (everyone plays each other twice, home and away)</option>
              <option value="knockout_single_elim">Knockout (single elimination)</option>
              <option value="knockout_double_elim">Knockout (double elimination - needs 4/8/16/32 entrants)</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit">
            Add Division
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card-grid">
        {league.divisions.map((division) => (
          <Link key={division.id} to={`/divisions/${division.id}`} className="card card-link">
            <h2>{division.name}</h2>
            <p className="muted">
              {division.entryType === 'teams'
                ? `${division.teamIds.length} team${division.teamIds.length === 1 ? '' : 's'} · ${division.legsPerMatch} legs/match`
                : division.entryType === 'doubles'
                  ? `${division.pairingIds.length} pairing${division.pairingIds.length === 1 ? '' : 's'} · ${division.pairingSize} players/pairing`
                  : `${division.playerIds.length} player${division.playerIds.length === 1 ? '' : 's'}`}
              {' · '}
              {division.scheduling === 'knockout_single_elim'
                ? 'Knockout (single elim)'
                : division.scheduling === 'knockout_double_elim'
                  ? 'Knockout (double elim)'
                  : division.scheduling === 'round_robin_double'
                    ? 'Round Robin - Double'
                    : 'Round Robin - Single'}
              {' · '}
              {division.fixturesGenerated ? 'fixtures generated' : 'not started'}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
