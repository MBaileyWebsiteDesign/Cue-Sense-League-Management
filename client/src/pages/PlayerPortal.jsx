import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { FormStrip, WinRing, ResultBadge, Chevron, formatFixtureDate } from '../components/StatsUI.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

function ProfileForm({ player, onSaved }) {
  const [form, setForm] = useState({
    firstName: player.firstName,
    lastName: player.lastName,
    email: player.email,
    phone: player.phone || '',
    teamName: player.teamName,
    classification: player.classification || '',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const updated = await api.updateMe({ ...form, classification: form.classification || null });
      onSaved(updated);
      setSuccess('Details updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="form cs-settings-form" onSubmit={onSubmit}>
      <label>
        First name
        <input value={form.firstName} onChange={set('firstName')} required />
      </label>
      <label>
        Last name
        <input value={form.lastName} onChange={set('lastName')} required />
      </label>
      <label>
        Email
        <input type="email" value={form.email} onChange={set('email')} required />
      </label>
      <label>
        Phone <span className="muted">(optional)</span>
        <input type="tel" value={form.phone} onChange={set('phone')} />
      </label>
      <label>
        Team name
        <input value={form.teamName} onChange={set('teamName')} required />
      </label>
      <label>
        Classification <span className="muted">(optional)</span>
        <select value={form.classification} onChange={set('classification')}>
          <option value="">Not set</option>
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}
      <button className="btn btn-primary cs-btn-block" type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save details'}
      </button>
    </form>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Password changed.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="form cs-settings-form" onSubmit={onSubmit}>
      <label>
        Current password
        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
      </label>
      <label>
        New password
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
      </label>
      <label>
        Confirm new password
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
      </label>
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}
      <button className="btn btn-primary cs-btn-block" type="submit" disabled={submitting}>
        {submitting ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

// Inline "why are you disputing this" prompt - collapsed to a single Dispute
// button until clicked, then expands to a required reason field so the
// admin resolving it (Game Adjustments) has context to work from.
function DisputeControl({ onDispute }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return <button className="btn" onClick={() => setOpen(true)}>Dispute</button>;
  }

  const submit = async () => {
    if (!reason.trim()) {
      setError('Please explain why you’re disputing this result.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onDispute(reason.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 6, width: '100%' }}>
      <div className="inline-form" style={{ flexWrap: 'wrap', marginBottom: error ? 4 : 0 }}>
        <input
          type="text"
          placeholder="Why are you disputing this result?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ flex: '1 1 220px' }}
          autoFocus
        />
        <button className="btn btn-primary" disabled={submitting} onClick={submit}>Submit Dispute</button>
        <button className="btn" disabled={submitting} onClick={() => { setOpen(false); setReason(''); setError(''); }}>Cancel</button>
      </div>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

// Played games sitting at `pending_confirmation` where YOUR side hasn't
// confirmed the score yet - either because you just submitted it and your
// opponent hasn't acted, or your opponent submitted it and it's waiting on
// you. Both players have to independently confirm before a result counts
// (see homeConfirmed/awayConfirmed in server/src/index.js's "Result
// confirmation" section) - the player-facing counterpart to the admin's
// Game Adjustments "Games disputed" list. Shown at the very top of the
// page, above the quick actions, so a pending confirmation is the first
// thing a player sees; renders nothing at all once there's nothing
// pending, to keep the page uncluttered.
function MySubmissions() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState('');

  const load = () => {
    api.getMyPendingConfirmations().then(setItems).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const onConfirm = async (item) => {
    setError('');
    setBanner('');
    try {
      if (item.legNumber) await api.confirmLegResult(item.fixtureId, item.legNumber);
      else await api.confirmResult(item.fixtureId);
      setBanner('Result confirmed.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const onDispute = async (item, reason) => {
    if (item.legNumber) await api.disputeLegResult(item.fixtureId, item.legNumber, reason);
    else await api.disputeResult(item.fixtureId, reason);
    setBanner('Result disputed - an admin will review it.');
    load();
  };

  if (error) return <p className="error">{error}</p>;
  if (!items || items.length === 0) return null;

  return (
    <section className="card portal-card">
      <h2>My Submissions</h2>
      <p className="muted">
        This is a list of played games waiting for confirmation of the score.
      </p>
      {banner && <p className="banner banner-success">{banner}</p>}
      <ul className="fixture-list">
        {items.map((item) => (
          <li key={`${item.fixtureId}-${item.legNumber ?? 'main'}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Link to={`/fixtures/${item.fixtureId}`}>
                vs {item.opponentName} <strong>{item.scoreLabel}</strong>
                <span className="muted"> · {item.leagueName} / {item.divisionName} · Round {item.round}</span>
              </Link>
            </div>
            <div className="inline-form" style={{ marginTop: 6, marginBottom: 0 }}>
              <button className="btn btn-primary" onClick={() => onConfirm(item)}>Confirm</button>
              <DisputeControl onDispute={(reason) => onDispute(item, reason)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------
// Mobile redesign (2026-09-23): stats snapshot, quick-action tile grid,
// Next match, result cards, league rows with position, and collapsible
// account settings. Shared visuals come from components/StatsUI.jsx (same
// pieces as the player profile).
// ---------------------------------------------------------------------

function StatsSnapshot({ playerId, profile }) {
  if (!playerId) return null;
  const career = profile?.career;
  const winPct = career && career.played > 0 ? Math.round((career.won / career.played) * 100) : 0;
  return (
    <Link to={`/players/${playerId}`} className="card cs-snapshot">
      <div className="cs-snapshot-head">
        <span className="cs-snapshot-title">My stats</span>
        <span className="cs-snapshot-more">Full stats &amp; history <Chevron /></span>
      </div>
      {!career ? (
        <p className="muted" style={{ margin: 0 }}>Loading…</p>
      ) : (
        <div className="cs-snapshot-body">
          <WinRing pct={winPct} size={76} />
          <div className="cs-grow" style={{ gap: 10 }}>
            <div className="cs-tiles cs-tiles-compact">
              <div className="cs-tile"><span className="cs-tile-value">{career.played}</span><span className="cs-tile-label">Played</span></div>
              <div className="cs-tile cs-tile-win"><span className="cs-tile-value cs-tone-win">{career.won}</span><span className="cs-tile-label">Won</span></div>
              <div className="cs-tile cs-tile-loss"><span className="cs-tile-value cs-tone-loss">{career.lost}</span><span className="cs-tile-label">Lost</span></div>
            </div>
            {profile.formGuide && profile.formGuide.length > 0 && <FormStrip form={profile.formGuide} note={null} />}
          </div>
        </div>
      )}
    </Link>
  );
}

// Messages tile: "No new" / "N new" badge (red when unread). Polls once a
// minute while the portal is open; no badge if the messaging API isn't
// available (static demo build).
function MessagesTile() {
  const [unread, setUnread] = useState(null);
  useEffect(() => {
    if (!api.getMessageSummary) return undefined;
    let cancelled = false;
    const load = () => api.getMessageSummary().then((r) => { if (!cancelled) setUnread(r.unread); }).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return (
    <Link to="/messages" className="cs-action cs-action-outline">
      <span className="cs-action-top">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>
        {unread !== null && (
          <span className={`cs-action-badge${unread > 0 ? ' cs-action-badge-hot' : ''}`}>{unread > 0 ? `${unread} new` : 'No new'}</span>
        )}
      </span>
      <span className="cs-action-label">Messages</span>
    </Link>
  );
}

function QuickActions({ showReports }) {
  return (
    <>
      <div className="cs-actions">
        <Link to="/adhoc-game/new" className="cs-action cs-action-solid">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></svg>
          <span className="cs-action-label">Ad Hoc Game</span>
        </Link>
        {/* Skips the Ad Hoc Game wizard entirely - straight to a Free Play,
            2-player game (see AdHocGame.jsx's quickStart / /adhoc-game/quick). */}
        <Link to="/adhoc-game/quick" className="cs-action cs-action-solid">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="8" r="3" /><circle cx="17" cy="8" r="3" /><path d="M2 20c0-3 2.5-5 5-5s5 2 5 5M12 20c0-3 2.5-5 5-5s5 2 5 5" /></svg>
          <span className="cs-action-label">Head-to-Head</span>
        </Link>
        <Link to="/open-leagues" className="cs-action cs-action-outline">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21V4h11l-1 4 5 1-2 5H6" /></svg>
          <span className="cs-action-label">Leagues I can Join</span>
        </Link>
        <MessagesTile />
      </div>
      {showReports && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <MessageReportsLink />
        </div>
      )}
    </>
  );
}

function NextMatch({ fixtures }) {
  if (!fixtures) return null;
  const upcoming = fixtures.filter((f) => f.status !== 'completed' && f.status !== 'pending_confirmation');
  const next = upcoming[0];
  return (
    <section className="card">
      <div className="cs-card-head">
        <h2>Next match</h2>
        {next && <span className="cs-next-date">{formatFixtureDate(next.scheduledDate) || `Round ${next.round}`}</span>}
      </div>
      {!next ? (
        <div className="cs-empty cs-empty-dashed">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
          <div>
            <strong>No upcoming matches</strong>
            <span>
              {fixtures.length === 0
                ? "You're not registered in any division or team yet - an admin or captain can add you. "
                : 'Your next league fixture will show here. '}
              <Link to="/adhoc-game/new">Start an Ad Hoc Game</Link>
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="cs-next">
            <span className="cs-next-vs" aria-hidden="true">VS</span>
            <div className="cs-grow">
              <strong className="cs-next-name">{next.opponentName}</strong>
              <span className="muted cs-small">{[next.leagueName, next.divisionName, `Round ${next.round}`].filter(Boolean).join(' · ')}</span>
            </div>
          </div>
          <div className="cs-next-actions">
            <Link to={`/fixtures/${next.id}`} className="btn btn-primary">Start game</Link>
            {next.opponentUserId && <Link to={`/messages/${next.opponentUserId}`} className="btn btn-brand-green">Message opponent</Link>}
          </div>
          {upcoming.length > 1 && (
            <div className="cs-rows" style={{ marginTop: 10 }}>
              <span className="cs-kicker">Also coming up</span>
              {upcoming.slice(1, 4).map((f) => (
                <Link key={f.id} to={`/fixtures/${f.id}`} className="cs-row cs-row-link cs-row-inline">
                  <span className="cs-grow">
                    <strong>vs {f.opponentName}</strong>
                    <span className="muted cs-small">{[f.divisionName, `Round ${f.round}`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="muted cs-small">{formatFixtureDate(f.scheduledDate) || ''}</span>
                  <Chevron />
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Recent results: scores/result come from the player profile (the fixtures
// endpoint doesn't carry them), limited to fixtures that endpoint returns so
// results in rounds that haven't been released to players stay hidden, same
// as the old My Fixtures list.
function RecentResults({ fixtures, profile }) {
  if (!fixtures) return <p>Loading…</p>;
  const visibleIds = new Set(fixtures.map((f) => f.id));
  const pending = fixtures.filter((f) => f.status === 'pending_confirmation');
  const results = (profile?.results || []).filter((r) => visibleIds.has(r.fixtureId)).slice(0, 5);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  if (pending.length === 0 && results.length === 0) return null;
  return (
    <section className="card">
      <h2>Recent results</h2>
      <div className="cs-results">
        {pending.map((f) => (
          <Link key={`p-${f.id}`} to={`/fixtures/${f.id}`} className="cs-result">
            <span className="cs-badge cs-chip-V" aria-label="Awaiting confirmation">?</span>
            <div className="cs-result-body">
              <strong>vs {f.opponentName}</strong>
              <span className="muted">{[f.leagueName, f.divisionName, `Round ${f.round}`].filter(Boolean).join(' · ')}</span>
              <span className="cs-await">Waiting confirmation</span>
            </div>
            <Chevron />
          </Link>
        ))}
        {results.map((r, i) => {
          const f = byId.get(r.fixtureId);
          const round = r.round ?? f?.round;
          return (
            <Link key={`${r.fixtureId}-${i}`} to={`/fixtures/${r.fixtureId}`} className="cs-result">
              <ResultBadge result={r.result} />
              <div className="cs-result-body">
                <strong>vs {r.opponentName}</strong>
                <span className="muted">{[r.leagueName, r.divisionName, round != null ? `Round ${round}` : null].filter(Boolean).join(' · ')}{r.context && r.context !== 'singles' ? ` · ${r.context}` : ''}</span>
              </div>
              <span className="cs-result-score">{r.forScore}–{r.againstScore}</span>
              <Chevron />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// My leagues: one row per division (league name as a small kicker), with the
// player's position from that division's standings when it's a singles
// division that has started. Ad hoc / head-to-head games listed separately.
function MyLeagues({ leagues, playerId }) {
  const [info, setInfo] = useState({});
  const standard = (leagues || []).filter((l) => !l.isAdHocPool && l.divisionId);
  const adHoc = (leagues || []).filter((l) => l.isAdHocPool);
  const key = standard.map((l) => l.divisionId).join(',');

  useEffect(() => {
    let cancelled = false;
    standard.forEach((l) => {
      api.getDivision(l.divisionId).then((d) => {
        if (cancelled) return;
        const rows = d.standings || [];
        const idx = d.entryType === 'singles' || !d.entryType ? rows.findIndex((r) => r.playerId === playerId) : -1;
        setInfo((cur) => ({
          ...cur,
          [l.divisionId]: {
            count: rows.length,
            started: !!d.fixturesGenerated,
            pos: idx >= 0 ? idx + 1 : null,
            points: idx >= 0 ? rows[idx].points : null,
          },
        }));
      }).catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, playerId]);

  const uniqueLeagues = [...new Map(standard.filter((l) => l.leagueId).map((l) => [l.leagueId, l])).values()];

  return (
    <section className="card">
      <h2>My leagues</h2>
      {standard.length === 0 && adHoc.length === 0 && (
        <p className="muted">You're not registered in any leagues, divisions, or ad hoc/head-to-head games yet.</p>
      )}
      {standard.length > 0 && (
        <div className="cs-rows">
          {standard.map((l) => {
            const d = info[l.divisionId];
            return (
              <Link key={l.divisionId} to={`/divisions/${l.divisionId}`} className="cs-row cs-row-link cs-row-inline">
                <span className="cs-grow">
                  <span className="cs-kicker">{l.leagueName}</span>
                  <strong>{l.divisionName}</strong>
                </span>
                <span className="cs-league-meta">
                  {l.status === 'completed' ? (
                    <span className="muted cs-small">Season complete</span>
                  ) : d && d.started && d.pos ? (
                    <>
                      <span className="cs-league-pos">{ordinal(d.pos)} <span className="muted cs-small">of {d.count}</span></span>
                      <span className="muted cs-small">{d.points} pts</span>
                    </>
                  ) : d && !d.started ? (
                    <>
                      <span className="muted cs-small">{d.count} player{d.count === 1 ? '' : 's'}</span>
                      <span className="muted cs-small">not started</span>
                    </>
                  ) : null}
                </span>
                <Chevron />
              </Link>
            );
          })}
        </div>
      )}
      {adHoc.length > 0 && (
        <div className="cs-rows" style={{ marginTop: 10 }}>
          <span className="cs-kicker">Ad hoc / head-to-head games</span>
          {adHoc.map((l, i) => (
            l.divisionId ? (
              <Link key={l.divisionId} to={`/divisions/${l.divisionId}`} className="cs-row cs-row-link cs-row-inline">
                <strong className="cs-grow">{l.divisionName}</strong>
                {l.status === 'completed' && <span className="muted cs-small">Completed</span>}
                <Chevron />
              </Link>
            ) : (
              <div key={i} className="cs-row cs-row-inline"><strong className="cs-grow">{l.divisionName}</strong></div>
            )
          ))}
        </div>
      )}
      {uniqueLeagues.length > 0 && (
        <p className="cs-small" style={{ margin: '10px 0 0' }}>
          League pages:{' '}
          {uniqueLeagues.map((l, i) => (
            <span key={l.leagueId}>{i > 0 && ' · '}<Link to={`/leagues/${l.leagueId}`}>{l.leagueName}</Link></span>
          ))}
        </p>
      )}
    </section>
  );
}

function SettingsSection({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cs-settings-item">
      <button type="button" className="cs-settings-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <svg className={open ? 'cs-rot' : ''} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && <div className="cs-settings-body">{children}</div>}
    </div>
  );
}

// League Managers / Overall Admins: link to abuse reports raised from
// player messages, with the open count (server already scopes it to the
// leagues they manage).
function MessageReportsLink() {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api.getMessageReportSummary?.().then((r) => setOpen(r.open)).catch(() => {});
  }, []);
  return (
    <Link className="btn btn-primary" to="/message-reports">
      Message Reports{open ? ` (${open} open)` : ''}
    </Link>
  );
}

// The Player Management Portal - every account's home base. Admins and
// captains land here too via "My Account" in the header; their extra
// Admin/Captain Portal links sit alongside this rather than replacing it,
// since every account is a player account first.
export default function PlayerPortal() {
  const { user, updateUser, isAdmin, isCaptain, isLeagueManager } = useAuth();
  const [leagues, setLeagues] = useState([]);
  const [fixtures, setFixtures] = useState(null);
  const [fixturesError, setFixturesError] = useState('');
  const [profile, setProfile] = useState(null);
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'My Account' }]);

  useEffect(() => {
    api.getMyLeagueMembership().then(setLeagues).catch(() => setLeagues([]));
    api.getMyFixtures().then(setFixtures).catch((e) => { setFixtures([]); setFixturesError(e.message); });
  }, []);

  useEffect(() => {
    if (!user?.playerId) return;
    api.getPlayerProfile(user.playerId).then(setProfile).catch(() => {});
  }, [user?.playerId]);

  if (!user) return <p>Loading…</p>;

  const badges = [user.isAdmin && 'Admin', user.isCaptain && 'Captain'].filter(Boolean);

  return (
    <div className="cs-portal">
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 4 }}>My Account</h1>
          {badges.length > 0 && <p className="muted" style={{ marginTop: 0 }}>{badges.join(' & ')}</p>}
        </div>
      </div>

      <MySubmissions />

      <StatsSnapshot playerId={user.playerId} profile={profile} />

      <QuickActions showReports={isAdmin || isLeagueManager} />

      {fixturesError && <p className="error">{fixturesError}</p>}
      <NextMatch fixtures={fixtures} />
      <RecentResults fixtures={fixtures} profile={profile} />
      <MyLeagues leagues={leagues} playerId={user.playerId} />

      <section className="card cs-settings">
        <h2>Account settings</h2>
        <SettingsSection title="Your details">
          <ProfileForm player={user} onSaved={updateUser} />
        </SettingsSection>
        <SettingsSection title="Change password">
          <ChangePasswordForm />
        </SettingsSection>
      </section>
    </div>
  );
}
