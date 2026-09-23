import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Admin tool for finding and directly correcting a specific result: search
// for a player, pick one of their fixtures, then either override the final
// score outright (same POST /api/fixtures/:id/override used by the
// per-fixture Admin Override panel) or, if the result is stuck in
// `pending_confirmation`/`disputed`, reopen it back to in_progress so it can
// be scored again normally. This is the tool the "Result disputed" banner on
// FixtureDetail.jsx points admins at.
//
// Mobile layout (2026-09-23): numbered step cards, dispute cards with the
// reason quoted, a searchable player picker, fixture rows with status chips,
// and a two-sided -/+ score editor instead of bare number inputs. Behaviour
// and API calls are unchanged.

function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ');
}

function StatusChip({ status }) {
  return <span className={`status status-${status}`}>{statusLabel(status)}</span>;
}

function ScoreStepper({ label, value, onChange }) {
  const n = Math.max(0, Number(value) || 0);
  return (
    <div className="ga-side">
      <span className="ga-side-name">{label}</span>
      <div className="ah-stepper ga-stepper">
        <button type="button" aria-label={`Decrease ${label}`} disabled={n <= 0} onClick={() => onChange(String(Math.max(0, n - 1)))}>−</button>
        <input
          type="number"
          min="0"
          inputMode="numeric"
          aria-label={`${label} score`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        />
        <button type="button" aria-label={`Increase ${label}`} onClick={() => onChange(String(n + 1))}>+</button>
      </div>
    </div>
  );
}

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
    <div className="ga-override">
      {error && <p className="error">{error}</p>}
      <form onSubmit={onSubmit} className="ga-override-form">
        <span className="ga-unit muted">{isTeams ? 'Legs won' : 'Frames won'}</span>
        <div className="ga-sides">
          <ScoreStepper label={homeName || 'Home'} value={homeScore} onChange={setHomeScore} />
          <span className="ga-vs" aria-hidden="true">vs</span>
          <ScoreStepper label={awayName || 'Away'} value={awayScore} onChange={setAwayScore} />
        </div>
        <button className="btn btn-primary cs-btn-block" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : `Override score to ${Number(homeScore) || 0}–${Number(awayScore) || 0}`}
        </button>
      </form>
      {(fixture.status === 'pending_confirmation' || fixture.status === 'disputed') && (
        <div className="ga-reopen">
          <button className="btn cs-btn-block" disabled={reopening} onClick={onReopen}>
            {reopening ? 'Reopening…' : 'Reopen for scoring instead'}
          </button>
          <p className="muted ga-small">Unlocks frame entry again - doesn't set a score.</p>
        </div>
      )}
    </div>
  );
}

export default function GameAdjustments() {
  const { isAdmin } = useAuth();
  useSetBreadcrumbs([
    { label: 'Home', to: '/' },
    isAdmin ? { label: 'Admin', to: '/admin' } : { label: 'League Manager Portal', to: '/league-manager' },
    { label: 'Game Adjustments' },
  ]);

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
  const adjustRef = useRef(null);

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

  // Bring the adjust card into view when a fixture is picked - on a phone it
  // otherwise opens below the fold.
  const selectedId = selectedFixture?.id;
  useEffect(() => {
    if (selectedId) adjustRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

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

  const clearPlayer = () => {
    setSelectedPlayerId('');
    setQuery('');
    setPlayerFixtures([]);
    setSelectedFixture(null);
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
  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);

  return (
    <div className="ga-page">
      <div className="ga-head">
        <Link to={isAdmin ? '/admin' : '/league-manager'} className="msg-icon-btn" aria-label={isAdmin ? 'Back to Admin Portal' : 'Back to League Manager Portal'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Game Adjustments</h1>
      </div>
      <p className="muted ga-intro">Resolve disputed results, or find a player to correct or reopen one of their fixtures.</p>
      {error && <p className="error">{error}</p>}
      {banner && <p className="banner banner-success">{banner}</p>}

      <section className="card ga-card">
        <div className="ga-card-head">
          <span className="ga-step">1</span>
          <h2>Disputed &amp; no-show claims</h2>
          {!loadingAttention && <span className={`ga-count${disputedGames.length ? ' ga-count-on' : ''}`}>{disputedGames.length}</span>}
        </div>
        {loadingAttention ? (
          <p className="muted">Loading…</p>
        ) : disputedGames.length === 0 ? (
          <p className="muted ga-empty">Nothing disputed right now.</p>
        ) : (
          <ul className="ga-disputes">
            {disputedGames.map((item) => {
              const key = `${item.fixtureId}-${item.legNumber ?? 'main'}`;
              return (
                <li key={key} className="ga-dispute">
                  <div className="ga-dispute-top">
                    <span className="ga-dispute-label">{item.label}</span>
                    <strong className="ga-dispute-score">{item.scoreLabel}</strong>
                  </div>
                  <span className="muted ga-small">
                    {item.leagueName} / {item.divisionName} · Round {item.round}
                    {item.legNumber ? ` · Leg ${item.legNumber}` : ''}
                  </span>
                  {item.disputeReason && (
                    <blockquote className="ga-reason">
                      <span className="ga-reason-label">Reason given</span>
                      {item.disputeReason}
                    </blockquote>
                  )}
                  {item.noShowClaim && (
                    <div className="ga-noshow">
                      <span className="status status-disputed">Non-contactable / No Show claim</span>
                      <button className="btn btn-primary cs-btn-block" disabled={authorizing === key} onClick={() => authorizeNoShow(item)}>
                        {authorizing === key ? 'Authorising…' : 'Authorise No-Show Win'}
                      </button>
                    </div>
                  )}
                  {item.legNumber ? (
                    <Link to={`/fixtures/${item.fixtureId}`} className="btn cs-btn-block ga-action">Open fixture to resolve this leg</Link>
                  ) : (
                    <button type="button" className="btn btn-brand-green cs-btn-block ga-action" onClick={() => resolveDirectly(item.fixtureId)}>
                      Resolve this result
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card ga-card">
        <div className="ga-card-head">
          <span className="ga-step">2</span>
          <h2>Find a player</h2>
        </div>
        {selectedPlayerId ? (
          <div className="ga-picked">
            <span className="dv-avatar" aria-hidden="true">
              {(selectedPlayer?.name || query).split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
            </span>
            <strong className="ga-picked-name">{selectedPlayer?.name || query}</strong>
            <button type="button" className="btn dv-small-btn" onClick={clearPlayer}>Change</button>
          </div>
        ) : (
          <>
            <input
              type="search"
              className="ah-search"
              aria-label="Search players by name"
              placeholder="Search by name…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedPlayerId(''); setSelectedFixture(null); }}
            />
            {query && (
              <ul className="ga-rows">
                {filteredPlayers.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="ga-row" onClick={() => selectPlayer(p)}>
                      <span className="dv-avatar dv-avatar-light" aria-hidden="true">
                        {p.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                      </span>
                      <span className="ga-row-main">{p.name}</span>
                      <svg className="ll-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                    </button>
                  </li>
                ))}
                {filteredPlayers.length === 0 && <li className="muted ga-empty">No matching registered players.</li>}
              </ul>
            )}
          </>
        )}
      </section>

      {selectedPlayerId && (
        <section className="card ga-card">
          <div className="ga-card-head">
            <span className="ga-step">3</span>
            <h2>Pick a fixture</h2>
          </div>
          {loadingFixtures ? (
            <p className="muted">Loading…</p>
          ) : playerFixtures.length === 0 ? (
            <p className="muted ga-empty">No fixtures found for this player.</p>
          ) : (
            <ul className="ga-rows">
              {playerFixtures.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className={`ga-row${selectedFixture?.id === f.id ? ' ga-row-on' : ''}`}
                    onClick={() => loadFixture(f.id)}
                  >
                    <span className="ga-row-main">
                      <span className="ga-row-top">
                        <span>vs {f.opponentName}</span>
                        <strong>{f.scoreLabel}</strong>
                      </span>
                      <span className="muted ga-small">{f.leagueName} / {f.divisionName} · Round {f.round}</span>
                    </span>
                    <StatusChip status={f.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selectedFixture && (
        <section className="card ga-card" ref={adjustRef}>
          <div className="ga-card-head">
            <span className="ga-step">{selectedPlayerId ? 4 : 2}</span>
            <h2>Adjust the result</h2>
            <StatusChip status={selectedFixture.status} />
          </div>
          <OverrideForm
            key={selectedFixture.id}
            fixture={selectedFixture}
            isTeams={isTeams}
            onChange={() => { loadFixture(selectedFixture.id); loadNeedsAttention(); }}
            setBanner={setBanner}
          />
          <Link to={`/fixtures/${selectedFixture.id}`} className="ga-open-link">Open full fixture page →</Link>
        </section>
      )}
    </div>
  );
}
