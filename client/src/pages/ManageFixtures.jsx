import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
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

function RoundCard({ round, divisionId, onChanged, setError }) {
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
    <div className="mf-round">
      <div className="mf-round-top">
        <strong>Round {round.round}</strong>
        <span className={`mf-vis-chip ${round.visible ? 'mf-vis-yes' : 'mf-vis-no'}`}>
          {round.visible ? 'Visible to players' : 'Hidden from players'}
        </span>
      </div>
      <p className="muted mf-round-meta">
        {round.bracketRole && round.bracketRole !== 'single' && `${BRACKET_ROLE_LABEL[round.bracketRole] || round.bracketRole} · `}
        {round.count} fixture{round.count === 1 ? '' : 's'}
      </p>
      <button className="btn cs-btn-block" disabled={busy} onClick={toggle}>
        {busy ? 'Saving…' : round.visible ? 'Hide from Players' : 'Make Visible'}
      </button>
    </div>
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
      <section className="card mf-panel">
        <p className="mf-back-links">
          <Link to="/admin/manage-fixtures">&larr; Manage Fixtures</Link>
        </p>
        <p className="muted">
          Fixtures haven't been generated for this division yet - do that from{' '}
          <Link to={`/divisions/${division.id}`}>its own page</Link> first.
        </p>
      </section>
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
    <section className="card mf-panel">
      <p className="mf-back-links muted">
        <Link to="/admin/manage-fixtures">&larr; Manage Fixtures</Link>
        {' · '}
        <Link to={`/divisions/${division.id}`}>&larr; {division.name}</Link>
      </p>
      <div className="page-header">
        <h2>{division.name} — Rounds</h2>
      </div>
      <p className="mf-open-link"><Link to={`/divisions/${division.id}`}>Open division page &rarr;</Link></p>
      <p className="muted mf-intro">
        Players never see the whole season up front - a round's fixtures (and the ability to
        play or score them) only appear in the Player Portal once you release that round here.
        Release Round 1 now, then come back and release Round 2 the following week, and so on.
      </p>
      {error && <p className="error">{error}</p>}
      {anyVisible && (
        <button className="btn cs-btn-block mf-hide-all" disabled={hidingAll} onClick={hideAll}>
          {hidingAll ? 'Hiding…' : 'Hide All Rounds'}
        </button>
      )}
      <div className="mf-round-list">
        {rounds.map((round) => (
          <RoundCard key={round.round} round={round} divisionId={division.id} onChanged={load} setError={setError} />
        ))}
        {rounds.length === 0 && <p className="muted">No fixtures in this division yet.</p>}
      </div>
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
  const { isAdmin, canManageLeague } = useAuth();
  const [leagues, setLeagues] = useState([]);
  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [league, setLeague] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // A League Manager only ever gets here for a league they're assigned to
    // (the direct "Manage round visibility" link from a division page skips
    // this picker entirely) - but if they land on the bare picker anyway,
    // only list leagues they can actually act on, rather than every league
    // in the app.
    api.getLeagues()
      .then((all) => setLeagues(isAdmin ? all : all.filter((l) => canManageLeague(l))))
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    isAdmin ? { label: 'Admin Portal', to: '/admin' } : { label: 'League Manager Portal', to: '/league-manager' },
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

  const backTo = isAdmin ? '/admin' : '/league-manager';

  return (
    <div className="mf-page">
      <div className="mf-head">
        <Link to={backTo} className="msg-icon-btn" aria-label="Back to the portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <div className="mf-head-text">
          <h1>Manage Fixtures</h1>
          <p className="muted">
            Control which rounds of a division's fixtures are visible to players. Only admins
            ever see the whole season's fixtures at once - everyone else only sees the rounds
            you've released here.
          </p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <section className="card mf-panel">
        <h2>1. Pick a league</h2>
        <select className="mm-input" value={selectedLeagueId} onChange={selectLeague}>
          <option value="" disabled>Select a league…</option>
          {leagues.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </section>

      {league && !routedDivisionId && (
        <section className="card mf-panel">
          <h2>2. Pick a division</h2>
          {league.divisions.length === 0 ? (
            <p className="muted">This league has no divisions yet.</p>
          ) : (
            <div className="lg-div-list mf-div-list">
              {league.divisions.map((d) => (
                <button key={d.id} type="button" className="lg-div-row mf-div-row" onClick={() => selectDivision(d)}>
                  <span className="lg-div-main">
                    <strong>{d.name}</strong>
                  </span>
                  <span className={`lg-div-status lg-div-status-${d.fixturesGenerated ? 'live' : 'idle'}`}>
                    {d.fixturesGenerated ? 'Fixtures generated' : 'No fixtures yet'}
                  </span>
                  <svg className="lg-div-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {routedDivisionId && <DivisionRounds divisionId={routedDivisionId} />}
    </div>
  );
}
