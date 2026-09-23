import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { useIsAdminSession } from '../useAdminSession.js';
import { FormStrip, SplitBar, WinRing, StatTiles, ResultBadge, Chevron, formatFixtureDate } from '../components/StatsUI.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

// Same labels used on the Roll of Honour page, duplicated locally rather
// than importing across pages for one small constant.
const SCHEDULING_LABEL = {
  round_robin_single: 'Standard League - Single Leg',
  round_robin_double: 'Standard League - Double Leg',
  knockout_single_elim: 'Knockout (single elim)',
  knockout_double_elim: 'Knockout (double elim)',
  knockout_double_elim_pcdek: 'Pre Configured Double Elim Knockout',
  knockout_double_elim_adek: 'Adaptive Double Elim Knockout',
  killer_classic: 'Killer Classic',
  cards_killer: 'Cards Killer',
  free_play: 'Free Play',
};

// Admin-only panel shown above Career - lets an admin edit the account
// linked to this player (name/email/phone/team/classification, reusing
// the same PATCH /api/admin/users/:id route as the Manage Users edit screen)
// without leaving the stats page, plus a read-only list of the leagues this
// player is currently registered in ("League" context) and a button to
// generate a password reset link. Not every Player has a linked account
// (older seed/demo rows can be bare names with no registered user) - in that
// case there's nothing to edit here, so the panel just says so.
function AdminAccountPanel({ playerId, divisions }) {
  const [linkedUser, setLinkedUser] = useState(undefined); // undefined = loading, null = none
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resetLink, setResetLink] = useState(null);
  const [sendingReset, setSendingReset] = useState(false);

  useEffect(() => {
    setLinkedUser(undefined);
    setResetLink(null);
    api.adminGetUserByPlayer(playerId).then(({ user }) => {
      setLinkedUser(user);
      if (user) {
        setForm({
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone || '',
          teamName: user.teamName,
          classification: user.classification || '',
        });
      }
    }).catch((e) => setError(e.message));
  }, [playerId]);

  if (linkedUser === undefined) return null; // still loading - avoid a flash of "no account"

  if (!linkedUser) {
    return (
      <section className="card">
        <h2>Admin: Account Details</h2>
        <p className="muted">
          This player isn't linked to a registered user account (common for older seed
          data), so there's nothing to edit here.
        </p>
      </section>
    );
  }

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.adminUpdateUser(linkedUser.id, { ...form, classification: form.classification || null });
      setLinkedUser(updated);
      setSuccess('Account details updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onSendResetLink = async () => {
    setError('');
    setSuccess('');
    setSendingReset(true);
    try {
      const result = await api.adminSendResetLink(linkedUser.id);
      setResetLink(result.resetLink);
    } catch (err) {
      setError(err.message);
    } finally {
      setSendingReset(false);
    }
  };

  return (
    <section className="card form">
      <h2>Admin: Account Details</h2>
      <p className="muted">
        Editing the registered account linked to this player. <Link to={`/admin/users/${linkedUser.id}`}>Open in Manage Users</Link>
      </p>
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}

      <form onSubmit={onSubmit}>
        <label>First name<input value={form.firstName} onChange={set('firstName')} required /></label>
        <label>Last name<input value={form.lastName} onChange={set('lastName')} required /></label>
        <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
        <label>Phone <span className="muted">(optional)</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
        <label>Team name<input value={form.teamName} onChange={set('teamName')} required /></label>
        <label>
          Classification <span className="muted">(optional)</span>
          <select value={form.classification} onChange={set('classification')}>
            <option value="">Not set</option>
            {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          League(s)
          {divisions.length === 0 ? (
            <p className="muted" style={{ marginTop: 4 }}>Not currently registered in any league/division.</p>
          ) : (
            <p className="muted" style={{ marginTop: 4 }}>
              {divisions.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ', '}
                  <Link to={`/divisions/${d.id}`}>{d.leagueName ? `${d.leagueName} - ` : ''}{d.name}</Link>
                </span>
              ))}
            </p>
          )}
        </label>
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save Account Details'}
        </button>
      </form>

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border, #333)' }}>
        <p className="muted">
          To change this player's password, send them a reset link rather than setting one
          directly - they'll use it to choose their own new password.
        </p>
        <button className="btn" type="button" onClick={onSendResetLink} disabled={sendingReset}>
          {sendingReset ? 'Generating…' : 'Send Password Reset Link'}
        </button>
        {resetLink && (
          <p className="banner banner-success" style={{ marginTop: 8, wordBreak: 'break-all' }}>
            Reset link generated (expires in 1 hour) - copy and send this to {linkedUser.email}:
            <br />
            <code>{resetLink}</code>
          </p>
        )}
      </div>
    </section>
  );
}

// "Best table" only counts tables with at least this many recorded frames,
// so one lucky frame can't put a table at the top (Matt, 2026-09-22).
const BEST_TABLE_MIN_FRAMES = 10;
// The win-rate trend line unlocks once a player has this many decided
// (win/loss) results (Matt, 2026-09-22).
const TREND_MIN_GAMES = 5;

const INFO = {
  bnd: 'Break and Dish - breaks and clears the whole rack including the black without missing, opponent gets no visit.',
  rnd: 'Reverse Break and Dish - the breaker misses, then this player clears the whole rack including the black on their first visit without missing.',
  noShows: "Games this player didn't turn up for, reported by their opponent and authorised by an admin or League Manager.",
};

// Cumulative win % after each decided result, oldest first.
function WinTrend({ results }) {
  const decided = results.filter((r) => r.result === 'win' || r.result === 'loss').slice().reverse();
  if (decided.length < TREND_MIN_GAMES) {
    const left = TREND_MIN_GAMES - decided.length;
    return (
      <section className="card cs-locked">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18l5-6 4 3 7-9" /></svg>
        <strong>Win-rate trend</strong>
        <span className="muted">Play {left} more game{left === 1 ? '' : 's'} to unlock the trend line.</span>
      </section>
    );
  }
  let wins = 0;
  const points = decided.map((r, i) => {
    if (r.result === 'win') wins += 1;
    return Math.round((wins / (i + 1)) * 100);
  });
  const W = 320;
  const H = 140;
  const pad = 12;
  const x = (i) => pad + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - pad * 2));
  const y = (v) => pad + (1 - v / 100) * (H - pad * 2);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <section className="card">
      <div className="cs-card-head">
        <h2>Win-rate trend</h2>
        <span className="muted">Now {last}% after {points.length} games</span>
      </div>
      <svg className="cs-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Win rate over ${points.length} games, now ${last} percent`}>
        <line x1={pad} x2={W - pad} y1={y(50)} y2={y(50)} className="cs-trend-grid" />
        <text x={W - pad} y={y(50) - 4} textAnchor="end" className="cs-trend-axis">50%</text>
        <path d={d} className="cs-trend-line" fill="none" />
        <circle cx={x(points.length - 1)} cy={y(last)} r="4" className="cs-trend-dot" />
      </svg>
      <div className="cs-trend-foot muted"><span>First game</span><span>Latest</span></div>
    </section>
  );
}

function TableRecordCard({ tableRecord, isOwnProfile }) {
  const [sort, setSort] = useState('played');
  const rows = tableRecord || [];
  if (rows.length === 0) {
    return (
      <section className="card">
        <h2 style={{ marginBottom: 2 }}>Table record</h2>
        <p className="muted cs-sub">Frames won and lost on each table</p>
        <div className="cs-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="3.5" cy="6.5" r="1" /><circle cx="20.5" cy="6.5" r="1" /><circle cx="3.5" cy="17.5" r="1" /><circle cx="20.5" cy="17.5" r="1" /></svg>
          <div>
            <strong>No table data yet</strong>
            <span>
              {isOwnProfile
                ? 'When you score a match, add the table number in Live Match Controls. Your wins and losses on each table will show here, so you can see which tables suit you best.'
                : 'No frames with a table number have been recorded for this player yet.'}
            </span>
          </div>
        </div>
      </section>
    );
  }
  const sorted = [...rows].sort((a, b) => (sort === 'best'
    ? b.winPct - a.winPct || b.played - a.played
    : b.played - a.played || b.winPct - a.winPct));
  const eligible = rows.filter((r) => r.played >= BEST_TABLE_MIN_FRAMES);
  const best = eligible.length > 0 ? [...eligible].sort((a, b) => b.winPct - a.winPct || b.played - a.played)[0] : null;
  return (
    <section className="card">
      <h2 style={{ marginBottom: 2 }}>Table record</h2>
      <p className="muted cs-sub">Frames won and lost on each table</p>
      <div className="cs-toggle" role="group" aria-label="Sort tables">
        <button type="button" className={sort === 'played' ? 'cs-toggle-on' : ''} aria-pressed={sort === 'played'} onClick={() => setSort('played')}>Most played</button>
        <button type="button" className={sort === 'best' ? 'cs-toggle-on' : ''} aria-pressed={sort === 'best'} onClick={() => setSort('best')}>Best win %</button>
      </div>
      {best ? (
        <div className="cs-best">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></svg>
          <div className="cs-grow">
            <span className="cs-best-kicker">{isOwnProfile ? 'YOUR BEST TABLE' : 'BEST TABLE'}</span>
            <strong>{best.table}{best.venue ? ` · ${best.venue}` : ''}</strong>
          </div>
          <span className="cs-best-pct">{best.winPct}%</span>
        </div>
      ) : (
        <p className="muted cs-note">A best table appears once a table has at least {BEST_TABLE_MIN_FRAMES} frames recorded.</p>
      )}
      <div className="cs-rows">
        {sorted.map((t) => (
          <div key={t.table} className="cs-row">
            <div className="cs-row-top">
              <div className="cs-row-name">
                <strong>{t.table}</strong>
                {t.venue && <span className="muted">{t.venue}</span>}
              </div>
              <span className="cs-row-score">{t.winPct}%</span>
            </div>
            <SplitBar a={t.wins} b={t.losses} label={`${t.wins} frames won, ${t.losses} lost on ${t.table}`} height={10} />
            <span className="muted cs-small">{t.played} frame{t.played === 1 ? '' : 's'} · {t.wins} won · {t.losses} lost</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function PlayerProfile() {
  const { playerId } = useParams();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [h2hVisible, setH2hVisible] = useState(5);
  const isAdmin = useIsAdminSession();
  const { user, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;

  useEffect(() => {
    api.getPlayerProfile(playerId).then(setProfile).catch((e) => setError(e.message));
  }, [playerId]);

  useSetBreadcrumbs(
    profile
      ? [{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: profile.name }]
      : [{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'Loading…' }]
  );

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p>Loading…</p>;

  const { career } = profile;
  const isOwnProfile = !!user?.playerId && user.playerId === profile.id;
  const winPct = career.played > 0 ? Math.round((career.won / career.played) * 100) : 0;
  // Break vs non-break win split - only counts frames that actually have a
  // recorded breaker (see server/src/services/playerProfile.js), so this can
  // be smaller than `career.won` for players with older, unbreaker-tagged history.
  const breakTrackedTotal = (career.breakWins || 0) + (career.nonBreakWins || 0);
  const diff = career.frameDifference;

  return (
    <div className="cs-profile">
      <h1 className="cs-title">{profile.name}</h1>
      <p className="muted" style={{ marginTop: 0 }}>Career record across every league and division</p>
      <p style={{ marginTop: -4, marginBottom: 12 }}>
        <Link to="/account">&larr; Back to my account</Link>
      </p>
      <FormStrip form={profile.formGuide} />

      {isAdmin && <AdminAccountPanel playerId={profile.id} divisions={profile.divisions || []} />}

      <section className="card">
        <h2>Career</h2>
        <div className="cs-career-top">
          <WinRing pct={winPct} />
          <StatTiles
            tiles={[
              { key: 'played', label: 'Played', value: career.played },
              { key: 'won', label: 'Won', value: career.won, tone: 'win' },
              { key: 'lost', label: 'Lost', value: career.lost, tone: 'loss' },
            ]}
          />
        </div>
        <div className="cs-block">
          <div className="cs-block-head">
            <strong>Frames</strong>
            <span className="muted"><strong className="cs-tone-win">{career.framesFor} won</strong> · <strong className="cs-tone-loss">{career.framesAgainst} lost</strong></span>
          </div>
          <SplitBar a={career.framesFor} b={career.framesAgainst} label={`${career.framesFor} frames won, ${career.framesAgainst} frames lost`} />
          <div className="cs-right">
            <span className={`cs-pill ${diff > 0 ? 'cs-pill-win' : diff < 0 ? 'cs-pill-loss' : ''}`}>Frame diff {diff > 0 ? '+' : diff < 0 ? '−' : ''}{Math.abs(diff)}</span>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Breaking</h2>
        <div className="cs-block" style={{ marginTop: 0 }}>
          <div className="cs-block-head muted">
            <span><span className="cs-swatch cs-fill-s1" aria-hidden="true" /> Break + Win <strong className="cs-ink">{career.breakWins || 0}</strong></span>
            <span><span className="cs-swatch cs-fill-s2" aria-hidden="true" /> Non-breaking + Win <strong className="cs-ink">{career.nonBreakWins || 0}</strong></span>
          </div>
          <SplitBar
            a={career.breakWins || 0}
            b={career.nonBreakWins || 0}
            aClass="cs-fill-s1"
            bClass="cs-fill-s2"
            label={`Break and win ${career.breakWins || 0} frames, non-breaking and win ${career.nonBreakWins || 0} frames`}
          />
          <span className="muted cs-small">
            {breakTrackedTotal > 0
              ? `Based on ${breakTrackedTotal} won frame${breakTrackedTotal === 1 ? '' : 's'} with a recorded breaker.`
              : 'No break data recorded yet. The bar fills in once frames are scored with the Break button.'}
          </span>
        </div>
        <StatTiles
          tiles={[
            { key: 'bnd', label: 'BND', value: career.bnd || 0, info: INFO.bnd, infoTitle: 'Break and Dish (BND)' },
            { key: 'rnd', label: 'RND', value: career.rnd || 0, info: INFO.rnd, infoTitle: 'Reverse Break and Dish (RND)' },
            { key: 'ns', label: 'No-shows', value: career.noShows || 0, info: INFO.noShows },
          ]}
        />
      </section>

      {profile.trophies && profile.trophies.length > 0 && (
        <section className="card">
          <h2>Trophy Cabinet</h2>
          <p className="muted" style={{ marginTop: -8, marginBottom: 12, fontSize: '0.8rem' }}>
            Every division title this player has won, across every season - see Roll of Honour for the full league-wide list.
          </p>
          <ul className="fixture-list">
            {profile.trophies.map((t) => (
              <li key={t.id}>
                <span>
                  <strong>{t.divisionName}</strong>
                  <span className="muted"> ({SCHEDULING_LABEL[t.scheduling] || t.scheduling})</span>
                </span>
                <span className="muted">
                  <Link to={`/leagues/${t.leagueId}`}>{t.leagueName}</Link>
                  {' · '}
                  {new Date(t.recordedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Head to head</h2>
        {profile.headToHead.length === 0 ? (
          <p className="muted">No completed matches yet.</p>
        ) : (
          <div className="cs-rows">
            {profile.headToHead.slice(0, h2hVisible).map((h) => (
              <Link key={h.opponentId} to={`/players/${h.opponentId}`} className="cs-row cs-row-link">
                <div className="cs-row-top">
                  <strong className="cs-row-name">{h.opponentName}</strong>
                  <span className="cs-row-score">{h.won}–{h.lost}</span>
                </div>
                <SplitBar a={h.won} b={h.lost} height={8} label={`${h.won} won, ${h.lost} lost against ${h.opponentName}`} />
                <span className="muted cs-small">{h.played} played{h.played - h.won - h.lost > 0 ? ` · ${h.played - h.won - h.lost} void` : ''}</span>
              </Link>
            ))}
          </div>
        )}
        {profile.headToHead.length > h2hVisible && (
          <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setH2hVisible((n) => n + 5)}>
            View more
          </button>
        )}
      </section>

      <TableRecordCard tableRecord={profile.tableRecord} isOwnProfile={isOwnProfile} />

      <section className="card">
        <h2>Match history</h2>
        {profile.results.length === 0 ? (
          <p className="muted">No completed matches yet.</p>
        ) : (
          <div className="cs-results">
            {profile.results.map((r, i) => {
              const when = formatFixtureDate(r.scheduledDate) || (r.round != null ? `Round ${r.round}` : null);
              return (
                <Link key={i} to={`/fixtures/${r.fixtureId}`} className="cs-result">
                  <ResultBadge result={r.result} />
                  <div className="cs-result-body">
                    <strong>vs {r.opponentName}</strong>
                    <span className="muted">{[r.leagueName, r.divisionName].filter(Boolean).join(' · ')}{r.context && r.context !== 'singles' ? ` · ${r.context}` : ''}</span>
                    {when && <span className="muted">{when}</span>}
                  </div>
                  <span className="cs-result-score">{r.forScore}–{r.againstScore}</span>
                  <Chevron />
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <WinTrend results={profile.results} />
    </div>
  );
}
