import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Admin tool for finding and directly correcting a specific result: search
// for a player, pick one of their fixtures, then either override the final
// score outright (same POST /api/fixtures/:id/override used by the
// per-fixture Admin Override panel) or, if the result is stuck in
// `pending_confirmation`/`disputed`, reopen it back to in_progress so it can
// be scored again normally. This is the tool the "Result disputed" banner on
// FixtureDetail.jsx points admins at.
function OverrideForm({ fixture, isTeams, onChange, setBanner }) {
  const homeName = isTeams ? fixture.homeTeam?.name : (fixture.homePairing ? fixture.homePairing.name : fixture.homePlayer?.name);
  const awayName = isTeams ? fixture.awayTeam?.name : (fixture.awayPairing ? fixture.awayPairing.name : fixture.awayPlayer?.name);
  const [homeScore, setHomeScore] = useState(String(isTeams ? fixture.homeLegsWon ?? 0 : fixture.homeFrameScore ?? 0));
  const [awayScore, setAwayScore] = useState(String(isTeams ? fixture.awayLegsWon ?? 0 : fixture.awayFrameScore ?? 0));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reopening, setReopening] = useState(false);

  if (!fixture.bothEntrantsKnown) {
    return <p className="muted">Both sides aren't known yet for this fixture (waiting on an earlier round).</p>;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.overrideFixture(fixture.id, Number(homeScore), Number(awayScore));
      setBanner('Result overridden.');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onReopen = async () => {
    setError('');
    setReopening(true);
    try {
      await api.adminReopenFixture(fixture.id);
      setBanner('Fixture reopened for scoring.');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setReopening(false);
    }
  };

  return (
    <div>
      {error && <p className="error">{error}</p>}
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
      {(fixture.status === 'pending_confirmation' || fixture.status === 'disputed') && (
        <p className="muted" style={{ marginTop: 8 }}>
          Or <button className="btn" disabled={reopening} onClick={onReopen}>reopen this fixture for scoring</button>{' '}
          instead of overriding it directly (unlocks frame entry again, doesn't set a score).
        </p>
      )}
    </div>
  );
}

export default function GameAdjustments() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Game Adjustments' }]);

  const [players, setPlayers] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [playerFixtures, setPlayerFixtures] = useState([]);
  const [selectedFixture, setSelectedFixture] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState('');
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [needsAttention, setNeedsAttention] = useState([]);
  const [loadingAttention, setLoadingAttention] = useState(true);

  const loadNeedsAttention = () => {
    setLoadingAttention(true);
    api.adminGetFixturesNeedingAttention()
      .then(setNeedsAttention)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingAttention(false));
  };

  useEffect(() => {
    api.getRegisteredPlayers().then(setPlayers).catch((e) => setError(e.message));
    loadNeedsAttention();
  }, []);

  const filteredPlayers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20);
  }, [players, query]);

  const selectPlayer = async (player) => {
    setError('');
    setBanner('');
    setSelectedPlayerId(player.id);
    setQuery(player.name);
    setSelectedFixture(null);
    setLoadingFixtures(true);
    try {
      const fixtures = await api.adminGetPlayerFixtures(player.id);
      setPlayerFixtures(fixtures);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingFixtures(false);
    }
  };

  const loadFixture = async (fixtureId) => {
    setError('');
    setBanner('');
    try {
      const fixture = await api.getFixture(fixtureId);
      setSelectedFixture(fixture);
    } catch (err) {
      setError(err.message);
    }
  };

  // Approves a player's "Non-contactable / No Show" claim (see
  // POST .../no-show/authorize in server/src/index.js): the reporting player
  // is awarded the game win with a 0-0 frame score, and the fixture/leg
  // moves straight to completed - added to the table exactly like any other
  // admin-resolved result.
  const [authorizing, setAuthorizing] = useState('');
  const authorizeNoShow = async (item) => {
    setError('');
    setBanner('');
    setAuthorizing(`${item.fixtureId}-${item.legNumber ?? 'main'}`);
    try {
      await api.authorizeNoShow(item.fixtureId, item.legNumber ?? undefined);
      setBanner(`Non-contactable/No Show win authorised for ${item.noShowClaim?.claimedByName || 'the reporting player'}.`);
      loadNeedsAttention();
      if (selectedFixture?.id === item.fixtureId) loadFixture(item.fixtureId);
    } catch (err) {
      setError(err.message);
    } finally {
      setAuthorizing('');
    }
  };

  // Jumping straight to a fixture from the Needs Attention list - clears any
  // in-progress player search so step 2's fixture list (which is scoped to
  // whichever player was searched for) doesn't linger stale on screen.
  const resolveDirectly = (fixtureId) => {
    setSelectedPlayerId('');
    setQuery('');
    setPlayerFixtures([]);
    loadFixture(fixtureId);
  };

  const isTeams = selectedFixture ? Array.isArray(selectedFixture.legs) : false;

  // Section 1 is specifically disputed games - pending_confirmation results
  // aren't a dispute yet (the away side just hasn't acted on them), so they're
  // left out of this list rather than lumped in with genuine disputes. The
  // underlying endpoint still returns both (adminGetFixturesNeedingAttention
  // is a general "needs an admin's eyes" feed), this just narrows what
  // Section 1 displays to match its "Games disputed" heading.
  const disputedGames = useMemo(() => needsAttention.filter((item) => item.status === 'disputed'), [needsAttention]);

  return (
    <div>
      <h1>Game Adjustments</h1>
      <p className="muted">
        Resolve disputed results directly, or search for a player to correct or reopen any of
        their fixtures. Use this for anything a "Result disputed" banner points you at, or for a
        straightforward scoring mistake.
      </p>
      {error && <p className="error">{error}</p>}
      {banner && <p className="banner banner-success">{banner}</p>}

      <section className="card">
        <h2>1. Games disputed and Non-contactable/No Show</h2>
        <p className="muted">
          Every result currently disputed, across every league - resolve one directly here
          without searching for the player first. This includes "Non-contactable / No Show"
          walkover claims (tagged below), which need one click to authorise before the 0-0
          win counts toward the table.
        </p>
        {loadingAttention ? (
          <p>Loading…</p>
        ) : disputedGames.length === 0 ? (
          <p className="muted">No disputed games right now.</p>
        ) : (
          <ul className="fixture-list">
            {disputedGames.map((item) => (
              <li key={`${item.fixtureId}-${item.legNumber ?? 'main'}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  {item.legNumber ? (
                    <Link to={`/fixtures/${item.fixtureId}`} style={{ flex: 1 }}>
                      {item.label} <strong>{item.scoreLabel}</strong>
                      <span className="muted"> · {item.leagueName} / {item.divisionName} · Round {item.round}</span>
                    </Link>
                  ) : (
                    <button className="btn" style={{ width: '100%', textAlign: 'left' }} onClick={() => resolveDirectly(item.fixtureId)}>
                      {item.label} <strong>{item.scoreLabel}</strong>
                      <span className="muted"> · {item.leagueName} / {item.divisionName} · Round {item.round}</span>
                    </button>
                  )}
                  <span className={`status status-${item.status}`}>{item.status.replace('_', ' ')}</span>
                </div>
                {item.disputeReason && (
                  <p className="muted" style={{ fontSize: '0.85rem', margin: '4px 0 0' }}>
                    <strong>Reason given:</strong> {item.disputeReason}
                  </p>
                )}
                {item.noShowClaim && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <span className="status status-disputed">Non-contactable / No Show claim</span>
                    <button
                      className="btn btn-primary"
                      disabled={authorizing === `${item.fixtureId}-${item.legNumber ?? 'main'}`}
                      onClick={() => authorizeNoShow(item)}
                    >
                      {authorizing === `${item.fixtureId}-${item.legNumber ?? 'main'}` ? 'Authorising…' : 'Authorise No-Show Win'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {disputedGames.some((item) => !!item.legNumber) && (
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: 8 }}>
            Team-fixture legs open on that fixture's own page - reopen or override an individual leg from there.
          </p>
        )}
      </section>

      <section className="card">
        <h2>2. Find a player</h2>
        <input
          type="text"
          placeholder="Search by name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedPlayerId(''); setSelectedFixture(null); }}
          style={{ width: '100%', maxWidth: 400 }}
        />
        {query && !selectedPlayerId && (
          <ul className="fixture-list" style={{ marginTop: 8 }}>
            {filteredPlayers.map((p) => (
              <li key={p.id}>
                <button className="btn" style={{ width: '100%', textAlign: 'left' }} onClick={() => selectPlayer(p)}>
                  {p.name}
                </button>
              </li>
            ))}
            {filteredPlayers.length === 0 && <li className="muted">No matching registered players.</li>}
          </ul>
        )}
      </section>

      {selectedPlayerId && (
        <section className="card">
          <h2>3. Pick a fixture</h2>
          {loadingFixtures ? (
            <p>Loading…</p>
          ) : playerFixtures.length === 0 ? (
            <p className="muted">No fixtures found for this player.</p>
          ) : (
            <ul className="fixture-list">
              {playerFixtures.map((f) => (
                <li key={f.id}>
                  <button className="btn" style={{ width: '100%', textAlign: 'left' }} onClick={() => loadFixture(f.id)}>
                    vs {f.opponentName} <strong>{f.scoreLabel}</strong>
                    <span className="muted"> · {f.leagueName} / {f.divisionName} · Round {f.round}</span>
                  </button>
                  <span className={`status status-${f.status}`}>{f.status.replace('_', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selectedFixture && (
        <section className="card">
          <div className="page-header">
            <h2>4. Adjust the result</h2>
            <Link to={`/fixtures/${selectedFixture.id}`}>Open full fixture page</Link>
          </div>
          <p className="muted">
            Current status: <span className={`status status-${selectedFixture.status}`}>{selectedFixture.status.replace('_', ' ')}</span>
          </p>
          <OverrideForm
            fixture={selectedFixture}
            isTeams={isTeams}
            onChange={() => { loadFixture(selectedFixture.id); loadNeedsAttention(); }}
            setBanner={setBanner}
          />
        </section>
      )}
    </div>
  );
}
