import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const BRACKET_ROLE_LABEL = {
  winners: 'Winners Bracket',
  losers: 'Losers Bracket',
  grand_final: 'Grand Final',
  grand_final_reset: 'Grand Final — Bracket Reset',
};

// Groups a division's fixtures by round number (each round number belongs to
// exactly one bracket section on a double-elimination division, since
// generateDoubleElimFixtures assigns each section its own non-overlapping
// range of round numbers - see server/src/index.js) and reports each round's
// fixture count and current visibility, sorted by round number.
function summarizeRounds(division) {
  const byRound = new Map();
  for (const f of division.fixtures) {
    if (!byRound.has(f.round)) byRound.set(f.round, { round: f.round, count: 0, bracketRole: f.bracketRole });
    byRound.get(f.round).count += 1;
  }
  const visible = new Set(division.visibleRounds || []);
  return Array.from(byRound.values())
    .sort((a, b) => a.round - b.round)
    .map((r) => ({ ...r, visible: visible.has(r.round) }));
}

function RoundRow({ round, divisionId, onChanged, setError }) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setError('');
    setBusy(true);
    try {
      await api.setRoundVisibility(divisionId, round.round, !round.visible);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <span>
        Round {round.round}
        {round.bracketRole && round.bracketRole !== 'single' && (
          <span className="muted"> · {BRACKET_ROLE_LABEL[round.bracketRole] || round.bracketRole}</span>
        )}
        <span className="muted"> · {round.count} fixture{round.count === 1 ? '' : 's'}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status status-${round.visible ? 'completed' : 'scheduled'}`}>
          {round.visible ? 'Visible to players' : 'Hidden from players'}
        </span>
        <button className="btn" disabled={busy} onClick={toggle}>
          {busy ? 'Saving…' : round.visible ? 'Hide from Players' : 'Make Visible'}
        </button>
      </span>
    </li>
  );
}

function DivisionRounds({ divisionId }) {
  const [division, setDivision] = useState(null);
  const [error, setError] = useState('');
  const [hidingAll, setHidingAll] = useState(false);

  const load = () => api.getDivision(divisionId).then(setDivision).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [divisionId]);

  if (error) return <p className="error">{error}</p>;
  if (!division) return <p>Loading…</p>;

  if (!division.fixturesGenerated) {
    return (
      <p className="muted">
        Fixtures haven't been generated for this division yet - do that from{' '}
        <Link to={`/divisions/${division.id}`}>its own page</Link> first.
      </p>
    );
  }

  const rounds = summarizeRounds(division);
  const anyVisible = rounds.some((r) => r.visible);

  // Fixes a division where every round somehow ended up visible before an
  // admin was ready (e.g. legacy data saved before fixtures started
  // defaulting to hidden) - one click instead of hiding each round by hand.
  const hideAll = async () => {
    setError('');
    setHidingAll(true);
    try {
      await api.hideAllRounds(division.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setHidingAll(false);
    }
  };

  return (
    <section className="card">
      <p><Link to="/admin/manage-fixtures">&larr; Back to Manage Fixtures</Link></p>
      <div className="page-header">
        <h2>{division.name} — Rounds</h2>
        <Link to={`/divisions/${division.id}`}>Open division page</Link>
      </div>
      <p className="muted">
        Players never see the whole season up front - a round's fixtures (and the ability to
        play or score them) only appear in the Player Portal once you release that round here.
        Release Round 1 now, then come back and release Round 2 the following week, and so on.
      </p>
      {error && <p className="error">{error}</p>}
      {anyVisible && (
        <p>
          <button className="btn" disabled={hidingAll} onClick={hideAll}>
            {hidingAll ? 'Hiding…' : 'Hide All Rounds'}
          </button>
        </p>
      )}
      <ul className="fixture-list">
        {rounds.map((round) => (
          <RoundRow key={round.round} round={round} divisionId={division.id} onChanged={load} setError={setError} />
        ))}
        {rounds.length === 0 && <li className="muted">No fixtures in this division yet.</li>}
      </ul>
    </section>
  );
}

// Admin tool for controlling, week by week, which rounds of a division's
// fixtures players can actually see and play - see division.visibleRounds /
// isRoundVisible in server/src/index.js. Reached either from the Admin
// Portal (pick a league, then a division) or directly from a division's own
// page via its "Manage round visibility" link (which lands straight on step
// 3 below, skipping the picker).
export default function ManageFixtures() {
  const { divisionId: routedDivisionId } = useParams();
  const navigate = useNavigate();
  const [leagues, setLeagues] = useState([]);
  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [league, setLeague] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getLeagues().then(setLeagues).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedLeagueId) {
      setLeague(null);
      return;
    }
    api.getLeague(selectedLeagueId).then(setLeague).catch((e) => setError(e.message));
  }, [selectedLeagueId]);

  useSetBreadcrumbs([
    { label: 'Home', to: '/' },
    { label: 'Admin Portal', to: '/admin' },
    { label: 'Manage Fixtures' },
  ]);

  const selectLeague = (e) => {
    setError('');
    setSelectedLeagueId(e.target.value);
    if (routedDivisionId) navigate('/admin/manage-fixtures');
  };

  const selectDivision = (division) => {
    setError('');
    navigate(`/admin/manage-fixtures/${division.id}`);
  };

  return (
    <div>
      <h1>Manage Fixtures</h1>
      <p className="muted">
        Control which rounds of a division's fixtures are visible to players. Only admins ever
        see the whole season's fixtures at once - everyone else only sees the rounds you've
        released here.
      </p>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>1. Pick a league</h2>
        <select value={selectedLeagueId} onChange={selectLeague}>
          <option value="" disabled>Select a league…</option>
          {leagues.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </section>

      {league && !routedDivisionId && (
        <section className="card">
          <h2>2. Pick a division</h2>
          {league.divisions.length === 0 ? (
            <p className="muted">This league has no divisions yet.</p>
          ) : (
            <ul className="fixture-list">
              {league.divisions.map((d) => (
                <li key={d.id}>
                  <button className="btn" onClick={() => selectDivision(d)}>{d.name}</button>
                  <span className={`status status-${d.fixturesGenerated ? 'completed' : 'scheduled'}`}>
                    {d.fixturesGenerated ? 'Fixtures generated' : 'No fixtures yet'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {routedDivisionId && <DivisionRounds divisionId={routedDivisionId} />}
    </div>
  );
}
