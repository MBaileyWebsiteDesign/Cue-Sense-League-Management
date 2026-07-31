import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Named physical tables for this league - see server/src/index.js's
// POST /api/leagues/:id/tables and the Arena display, which shows what's
// currently assigned to each one.
function TablesPanel({ league, onChange, setError }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onAdd = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setSubmitting(true);
    try {
      await api.addTable(league.id, name.trim());
      setName('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (tableId) => {
    setError('');
    try {
      await api.removeTable(league.id, tableId);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card">
      <h2>Tables</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
        Named physical tables fixtures can be scheduled onto (see a fixture's own page) -
        shown live on the <Link to={`/arena/${league.id}`}>Arena display</Link> for a venue TV.
      </p>
      <ul className="player-list">
        {league.tables.map((t) => (
          <li key={t.id}>
            {t.name}
            <button className="btn-link" onClick={() => onRemove(t.id)}>remove</button>
          </li>
        ))}
        {league.tables.length === 0 && <li className="muted">No tables added yet</li>}
      </ul>
      <form className="inline-form" onSubmit={onAdd} style={{ marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Table 1" />
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || submitting}>
          Add Table
        </button>
      </form>
    </section>
  );
}

// Admin-only, collapsed-by-default panel of league-wide destructive admin
// actions - closing the season early (force-completes outstanding fixtures,
// but the league and its history stick around) and, below that, permanently
// deleting the league altogether (removes the league and everything scoped
// to it: divisions, fixtures, teams, pairings, roll-of-honour entries). Same
// two-step "Show" then confirm pattern as the rest of the app's irreversible
// actions, with an extra type-the-league-name confirmation before delete
// specifically, since that one can't be recovered from at all.
function ManageLeaguePanel({ league, canCloseEarly, onChange, setError }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const onCloseEarly = async () => {
    setClosing(true);
    setError('');
    try {
      await api.closeLeagueEarly(league.id);
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
      await api.deleteLeague(league.id);
      navigate('/');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <section className="card">
      <div className="page-header">
        <h2 style={{ margin: 0 }}>Admin: Manage this League</h2>
        <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          {canCloseEarly && (
            <div style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>Close League Early</h3>
              <p className="muted">
                Force-completes every outstanding fixture across <strong>every division</strong> in this
                league at 0-0, with no winner - no confirmation from either side is needed. Use this to end
                the whole league's season early rather than closing each division one at a time. This can't
                be undone.
              </p>
              <button className="btn btn-primary" type="button" disabled={closing} onClick={onCloseEarly}>
                {closing ? 'Closing…' : 'Close the whole league now'}
              </button>
            </div>
          )}

          <div>
            <h3 style={{ marginBottom: '0.25rem' }}>Delete League</h3>
            <p className="muted">
              Permanently deletes <strong>{league.name}</strong> and everything in it - every division,
              fixture, team and pairing, plus its roll-of-honour history. This cannot be undone. To
              confirm, type the league's name below.
            </p>
            <label>
              League name
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={league.name}
              />
            </label>
            <button
              className="btn btn-danger"
              type="button"
              disabled={deleting || confirmName.trim() !== league.name}
              onClick={onDelete}
            >
              {deleting ? 'Deleting…' : 'Delete this league permanently'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

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
              <option value="knockout_double_elim">Knockout (double elimination)</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit">
            Add Division
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <p><Link to={`/arena/${league.id}`}>View Arena display &rarr;</Link></p>
      <p>
        <Link to={`/public/leagues/${league.id}/table`}>View public League Table &rarr;</Link>
        {' · '}
        <Link to={`/public/leagues/${league.id}/fixtures`}>View public League Fixtures &rarr;</Link>
      </p>
      {isAdmin && (
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          The two links above are live, unauthenticated pages meant to be embedded elsewhere (e.g. an
          &lt;iframe&gt; on another site) - copy either URL from your browser's address bar once you're on
          the page.
        </p>
      )}

      {isAdmin && <TablesPanel league={league} onChange={load} setError={setError} />}

      {isAdmin && (
        <ManageLeaguePanel
          league={league}
          canCloseEarly={league.divisions.some((d) => d.fixturesGenerated && d.status !== 'completed')}
          onChange={load}
          setError={setError}
        />
      )}

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
              {division.status === 'completed' && ' · season complete'}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
