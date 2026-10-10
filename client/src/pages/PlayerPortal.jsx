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
            <div className="cs-tiles cs-tiles-compact" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <div className="cs-tile"><span className="cs-tile-value">{career.played}</span><span className="cs-tile-label">Played</span></div>
              <div className="cs-tile cs-tile-win"><span className="cs-tile-value cs-tone-win">{career.won}</span><span className="cs-tile-label">Won</span></div>
              <div className="cs-tile cs-tile-draw"><span className="cs-tile-value cs-tone-draw">{career.drawn || 0}</span><span className="cs-tile-label">Drawn</span></div>
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
            {next.scanCardAvailable && <Link to={`/fixtures/${next.id}?scan=1`} className="btn">Scan score card</Link>}
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
              {[f.leagueName, f.divisionName, `Round ${f.round}`].filter(Boolean).map((t) => (
                <span key={t} className="muted">{t}</span>
              ))}
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
                {[r.leagueName, r.divisionName, round != null ? `Round ${round}` : null, r.context && r.context !== 'singles' ? r.context : null].filter(Boolean).map((t) => (
                  <span key={t} className="muted">{t}</span>
                ))}
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
        <div className="cs-small" style={{ margin: '10px 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>League pages:</span>
          {uniqueLeagues.map((l) => (
            <Link key={l.leagueId} to={`/leagues/${l.leagueId}`}>{l.leagueName}</Link>
          ))}
        </div>
      )}
    </section>
  );
}

// My Bookings (Matt, 2026-09-26): a player's own table bookings, across
// every venue linked to a Wix booking site (see wixSiteIdForVenue in
// server/src/index.js - Top Spin only for now, more venues will show here
// automatically as they're linked the same way). Matched to this account
// purely by email, today onward - mirrors the Venue Manager's own Table
// bookings card (VenueManagerPortal.jsx's BookingsCard), reusing its
// vm-bk-* styling. Hidden entirely on the GitHub Pages demo build, which
// has no live Wix connection (api.getMyBookings doesn't exist there).
const MY_BOOKING_STATUS = {
  CONFIRMED: { label: 'Confirmed', cls: 'status-completed' },
  PENDING: { label: 'Pending', cls: '' },
  WAITING_LIST: { label: 'Waiting list', cls: '' },
  CANCELED: { label: 'Cancelled', cls: 'status-disputed' },
  DECLINED: { label: 'Declined', cls: 'status-disputed' },
};

function myBookingDayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function myBookingTime(iso) {
  return iso
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
    : '';
}
function myBookingDayHeading(key) {
  const today = myBookingDayKey(new Date().toISOString());
  const tomorrow = myBookingDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  const [y, m, d] = key.split('-').map(Number);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
  if (key === today) return `Today \u00b7 ${label}`;
  if (key === tomorrow) return `Tomorrow \u00b7 ${label}`;
  return label;
}

// Book a table (Matt, 2026-09-30): shown inside My Bookings only when the
// player has an active membership at a venue that has table booking set up
// (api.getMyBookingVenues - active membership + a linked Wix site). Reuses
// the exact same start-time/day/length picker and Wix rules as the Venue
// Manager's "Book walk-in" form (VenueManagerPortal.jsx's WalkinForm), just
// without the player-details fieldset since the booking is for yourself.
const BOOK_LENGTH_LABEL = { 60: '1 hr', 120: '2 hrs', 180: '3 hrs' };
// Fallback if the server doesn't send opening hours (minutes after midnight,
// 0 = Sunday): Mon-Sat 11:00-24:00, Sun 11:00-22:00.
const BOOK_DEFAULT_OPENING_HOURS = [
  { open: 660, close: 1320 },
  { open: 660, close: 1440 }, { open: 660, close: 1440 }, { open: 660, close: 1440 },
  { open: 660, close: 1440 }, { open: 660, close: 1440 }, { open: 660, close: 1440 },
];

function bookSlotInfo(value, hours) {
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const day = hours[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || { open: 0, close: 0 };
  return { startMin: h * 60 + mi, open: day.open, close: day.close };
}

// Start-time choices: every half-hour start over the next 7 days (the
// current half hour first, as "Now") that falls inside opening hours and
// leaves at least an hour before closing. Each option carries its UK day so
// the form can show a Day picker and then that day's times. Values are UK
// wall-clock "YYYY-MM-DDTHH:MM".
function bookStartOptions(hours = BOOK_DEFAULT_OPENING_HOURS) {
  const step = 30 * 60 * 1000;
  const first = Math.floor(Date.now() / step) * step;
  const opts = [];
  for (let i = 0; i < 7 * 48; i++) {
    const d = new Date(first + i * step);
    const iso = d.toISOString();
    const day = myBookingDayKey(iso);
    const value = `${day}T${myBookingTime(iso)}`;
    const { startMin, open, close } = bookSlotInfo(value, hours);
    if (startMin < open || startMin + 60 > close) continue;
    opts.push({ value, day, ms: d.getTime(), label: i === 0 ? `Now (${myBookingTime(iso)})` : myBookingTime(iso) });
  }
  return opts;
}

// Day picker choices: the UK days that have at least one start option.
function bookDayOptions(startOpts) {
  const todayKey = myBookingDayKey(new Date(Date.now()).toISOString());
  const tomorrowKey = myBookingDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  const seen = [];
  startOpts.forEach((o) => { if (!seen.includes(o.day)) seen.push(o.day); });
  return seen.map((day) => {
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(date);
    const label = day === todayKey ? `Today (${name})` : day === tomorrowKey ? `Tomorrow (${name})` : name;
    return { value: day, label };
  });
}

function BookTableForm({ venues, onDone, onClose }) {
  const [venueId, setVenueId] = useState(() => (venues[0] ? venues[0].id : ''));
  const [tables, setTables] = useState(null);
  const [lengths, setLengths] = useState([60, 120, 180]);
  const [tableId, setTableId] = useState('');
  const [openingHours, setOpeningHours] = useState(BOOK_DEFAULT_OPENING_HOURS);
  const [startOpts, setStartOpts] = useState(() => bookStartOptions());
  const [start, setStart] = useState(() => (startOpts[0] ? startOpts[0].value : ''));
  const [day, setDay] = useState(() => (startOpts[0] ? startOpts[0].day : ''));
  // Times already taken on the chosen table (ms intervals), so only free
  // start times and lengths are offered. null = not known yet / couldn't be
  // loaded, in which case nothing is hidden and the server still checks.
  const [taken, setTaken] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const isFree = (ms, mins) => !taken || !taken.some((t) => t.s < ms + mins * 60 * 1000 && t.e > ms);
  const freeOpts = taken ? startOpts.filter((o) => isFree(o.ms, 60)) : startOpts;
  const dayOpts = bookDayOptions(freeOpts);
  const dayStarts = freeOpts.filter((o) => o.day === day);
  const pickDay = (value) => {
    setDay(value);
    const firstOfDay = freeOpts.find((o) => o.day === value);
    setStart(firstOfDay ? firstOfDay.value : '');
  };
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const minutesToClose = start ? (() => { const i = bookSlotInfo(start, openingHours); return i.close - i.startMin; })() : 0;
  const startMs = (startOpts.find((o) => o.value === start) || {}).ms;
  const fitsLen = (m) => m <= minutesToClose && (startMs === undefined || isFree(startMs, m));
  useEffect(() => {
    if (fitsLen(minutes)) return;
    const fit = lengths.filter(fitsLen);
    if (fit.length) setMinutes(fit[fit.length - 1]);
  }, [start, minutesToClose, taken]);

  useEffect(() => {
    setTaken(null);
    if (!venueId || !tableId || typeof api.getMyBookingBusy !== 'function') return undefined;
    let cancelled = false;
    api.getMyBookingBusy(venueId, tableId)
      .then((d) => {
        if (cancelled) return;
        setTaken((d.busy || [])
          .map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }))
          .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [venueId, tableId, reloadKey]);

  // If the chosen start time was just taken (table changed, or the list
  // refreshed), move to the nearest free one.
  useEffect(() => {
    if (!taken || freeOpts.some((o) => o.value === start)) return;
    const next = freeOpts.find((o) => o.day === day) || freeOpts[0];
    setStart(next ? next.value : '');
    setDay(next ? next.day : '');
  }, [taken, startOpts]);

  useEffect(() => {
    setTables(null);
    setTableId('');
    if (!venueId) return;
    api.getMyBookingTables(venueId)
      .then((d) => {
        setTables(d.tables || []);
        if (Array.isArray(d.lengths) && d.lengths.length) setLengths(d.lengths);
        if (Array.isArray(d.openingHours) && d.openingHours.length === 7) {
          setOpeningHours(d.openingHours);
          const opts = bookStartOptions(d.openingHours);
          setStartOpts(opts);
          setStart((cur) => {
            const keep = opts.find((o) => o.value === cur);
            const next = keep || opts[0];
            setDay(next ? next.day : '');
            return next ? next.value : '';
          });
        }
      })
      .catch((e) => setError(e.message));
  }, [venueId]);

  const submit = (e) => {
    e.preventDefault();
    if (!tableId) { setError('Choose a table.'); return; }
    if (!start) { setError('Choose a start time.'); return; }
    if (minutes > minutesToClose) { setError('That would run past closing time - choose a shorter length.'); return; }
    if (!fitsLen(minutes)) { setError('That table is booked for part of that time - choose a shorter length or another time.'); return; }
    setBusy(true);
    setError('');
    api.bookMyTable(venueId, tableId, start, minutes)
      .then((r) => {
        onDone(`${r.table} booked ${myBookingTime(r.start)}–${myBookingTime(r.end)} on ${myBookingDayHeading(myBookingDayKey(r.start))}.`);
      })
      .catch((err) => { setError(err.message); setReloadKey((k) => k + 1); })
      .finally(() => setBusy(false));
  };

  return (
    <form className="vm-wi" onSubmit={submit}>
      {venues.length > 1 && (
        <label className="vm-wi-field">
          <span>Venue</span>
          <select className="mm-input" value={venueId} onChange={(e) => setVenueId(e.target.value)} disabled={busy}>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      )}
      <label className="vm-wi-field">
        <span>Table</span>
        <select className="mm-input" value={tableId} onChange={(e) => setTableId(e.target.value)} disabled={!tables || busy}>
          <option value="">{tables ? 'Choose a table' : 'Loading tables…'}</option>
          {(tables || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {taken && freeOpts.length === 0 && (
        <p className="vm-small">No free times on this table in the next 7 days - try another table.</p>
      )}
      <div className="vm-wi-daytime">
        <label className="vm-wi-field">
          <span>Day</span>
          <select className="mm-input" value={day} onChange={(e) => pickDay(e.target.value)} disabled={busy}>
            {dayOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="vm-wi-field">
          <span>Start</span>
          <select className="mm-input" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy}>
            {dayStarts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <div className="vm-wi-field">
        <span>How long</span>
        <div className="vm-wi-lengths" role="group" aria-label="How long">
          {lengths.map((m) => (
            <button
              key={m}
              type="button"
              className={`vm-wi-len${minutes === m ? ' vm-wi-len-on' : ''}`}
              aria-pressed={minutes === m}
              onClick={() => setMinutes(m)}
              disabled={busy || !fitsLen(m)}
              title={m > minutesToClose ? 'Would run past closing time' : !fitsLen(m) ? 'Table is booked during part of that time' : undefined}
            >
              {BOOK_LENGTH_LABEL[m] || `${m} min`}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="error vm-small">{error}</p>}
      <div className="vm-wi-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !tables}>
          {busy ? 'Booking…' : 'Book table'}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Close</button>
      </div>
    </form>
  );
}

function MyBookings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [armedCancel, setArmedCancel] = useState(null); // booking id waiting for a second tap
  const [cancelling, setCancelling] = useState(null);
  const [bookVenues, setBookVenues] = useState(null); // null = loading, [] = none eligible
  const [bookOpen, setBookOpen] = useState(false);

  const load = () => {
    if (typeof api.getMyBookings !== 'function') return;
    setError('');
    api.getMyBookings().then((r) => setData(r.bookings || [])).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  // "Book a table" only shows at all once we know whether this player has
  // an active membership at a venue that has table booking set up.
  useEffect(() => {
    if (typeof api.getMyBookingVenues !== 'function') { setBookVenues([]); return; }
    api.getMyBookingVenues().then(setBookVenues).catch(() => setBookVenues([]));
  }, []);

  // Two taps to cancel, same pattern as the Venue Manager's Table bookings card.
  useEffect(() => {
    if (!armedCancel) return undefined;
    const t = setTimeout(() => setArmedCancel(null), 5000);
    return () => clearTimeout(t);
  }, [armedCancel]);

  const onCancel = (b) => {
    if (armedCancel !== b.id) { setArmedCancel(b.id); return; }
    setArmedCancel(null);
    setCancelling(b.id);
    setError('');
    api.cancelMyBooking(b.venueId, b.id)
      .then(() => {
        setNotice(`Your booking for ${b.table} at ${myBookingTime(b.start)} on ${myBookingDayHeading(myBookingDayKey(b.start))} has been cancelled.`);
        load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setCancelling(null));
  };

  if (typeof api.getMyBookings !== 'function') return null;
  if (!data) return null;

  const groups = [];
  for (const b of data) {
    const key = myBookingDayKey(b.start);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(b);
    else groups.push({ key, items: [b] });
  }

  return (
    <section className="card">
      <h2>My Bookings</h2>
      {error && <p className="error">{error}</p>}
      {notice && <p className="banner banner-success">{notice}</p>}
      {bookVenues && bookVenues.length > 0 && (
        bookOpen ? (
          <BookTableForm
            venues={bookVenues}
            onClose={() => setBookOpen(false)}
            onDone={(msg) => {
              setBookOpen(false);
              setNotice(msg);
              load();
            }}
          />
        ) : (
          <div className="vm-bk-actions">
            <button type="button" className="btn vm-act vm-act-primary" onClick={() => { setNotice(''); setBookOpen(true); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Book a table
            </button>
          </div>
        )
      )}
      {data.length === 0 ? (
        <p className="muted">No table bookings today or coming up.</p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="vm-bk-day">
            <h3 className="vm-bk-day-head">{myBookingDayHeading(g.key)}</h3>
            <ul className="vm-bk-list">
              {g.items.map((b) => {
                const st = MY_BOOKING_STATUS[b.status] || { label: b.status || 'Unknown', cls: '' };
                const cancelled = b.status === 'CANCELED' || b.status === 'DECLINED';
                const tone = cancelled ? 'cancelled' : b.status === 'CONFIRMED' ? 'confirmed' : 'pending';
                return (
                  <li key={b.id} className={`vm-bk vm-bk-${tone}`}>
                    <span className="vm-bk-time">
                      <strong>{myBookingTime(b.start)}</strong>
                      {b.end && <span>{myBookingTime(b.end)}</span>}
                    </span>
                    <span className="vm-bk-main">
                      <strong>{b.table}</strong>
                      <span>{b.venueName}</span>
                    </span>
                    <span className="vm-bk-chips">
                      <span className={`status ${st.cls}`}>{st.label}</span>
                      {!cancelled && (
                        <button
                          type="button"
                          className={`vm-bk-cancel${armedCancel === b.id ? ' vm-bk-cancel-armed' : ''}`}
                          onClick={() => onCancel(b)}
                          disabled={cancelling === b.id}
                          aria-label={armedCancel === b.id ? `Confirm cancelling ${b.table} at ${myBookingTime(b.start)}` : `Cancel ${b.table} at ${myBookingTime(b.start)}`}
                        >
                          {cancelling === b.id ? 'Cancelling\u2026' : armedCancel === b.id ? 'Tap to confirm' : 'Cancel'}
                        </button>
                      )}
                    </span>
                    {armedCancel === b.id && (
                      <span className="vm-bk-cancel-hint">Wix will email/text you to confirm it's cancelled.</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

// Account settings > My venues (Matt, 2026-09-25): a player can belong to
// more than one venue. They can add any venue and remove one, except while a
// membership there is still active (the venue has to remove that).
function ukDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}
function todayUk() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

function MyVenuesForm({ player, onSaved }) {
  const [venues, setVenues] = useState(null);
  const [addId, setAddId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmLeave, setConfirmLeave] = useState('');

  const loadVenues = () => {
    if (typeof api.listVenuesPublic !== 'function') { setVenues([]); return; }
    api.listVenuesPublic().then(setVenues).catch((e) => setError(e.message));
  };
  useEffect(loadVenues, []);

  const memberships = Array.isArray(player.venueMemberships) ? player.venueMemberships : [];
  const nameOf = (id) => (venues || []).find((v) => v.id === id)?.name || 'Venue';
  const notMember = (venues || []).filter((v) => !memberships.some((m) => m.venueId === v.id));
  // Venues that need approval show their pending requests separately and
  // can't be picked again until the request is decided or withdrawn.
  const pendingVenues = notMember.filter((v) => v.requestPending);
  const available = notMember.filter((v) => !v.requestPending);
  const addVenue = (venues || []).find((v) => v.id === addId);
  const needsApproval = !!addVenue && addVenue.joinPolicy === 'approval';
  const today = todayUk();
  // Venues left while the membership was still running: details kept until
  // the end date, restored if the venue is added again before then.
  const leftKept = (Array.isArray(player.leftVenueMemberships) ? player.leftVenueMemberships : [])
    .filter((m) => m.renewalDate && m.renewalDate >= today && !memberships.some((x) => x.venueId === m.venueId));

  const runRequest = (fn, msg) => {
    setBusy(true);
    setError('');
    setSuccess('');
    fn()
      .then(() => { setSuccess(msg); setAddId(''); loadVenues(); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const run = (fn, msg) => {
    setBusy(true);
    setError('');
    setSuccess('');
    fn()
      .then((updated) => { onSaved(updated); setSuccess(msg); setAddId(''); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="form cs-settings-form cs-venues">
      {memberships.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>You haven't added a venue yet.</p>
      ) : (
        <ul className="cs-venue-list">
          {memberships.map((m) => {
            const active = !!m.renewalDate && m.renewalDate >= today;
            return (
              <li key={m.venueId} className="cs-venue-row">
                <span className="cs-venue-main">
                  <strong>{nameOf(m.venueId)}</strong>
                  <span className="muted">
                    {m.renewalDate
                      ? `${active ? 'Member' : 'Membership ended'}${m.startDate ? ` ${ukDate(m.startDate)}` : ''} – ${ukDate(m.renewalDate)}`
                      : 'No membership dates'}
                  </span>
                  {active && confirmLeave === m.venueId && (
                    <span className="muted">Your membership details are kept until {ukDate(m.renewalDate)}. Add the venue again before then to get them back.</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn cs-venue-remove"
                  disabled={busy}
                  onClick={() => {
                    if (active && confirmLeave !== m.venueId) { setConfirmLeave(m.venueId); return; }
                    setConfirmLeave('');
                    run(
                      () => api.leaveMyVenue(m.venueId),
                      active
                        ? `You've left ${nameOf(m.venueId)}. Your membership details are kept until ${ukDate(m.renewalDate)}.`
                        : `${nameOf(m.venueId)} removed.`,
                    );
                  }}
                >
                  {active ? (confirmLeave === m.venueId ? 'Tap again to leave' : 'Leave') : 'Remove'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {leftKept.length > 0 && (
        <ul className="cs-venue-list">
          {leftKept.map((m) => (
            <li key={`left-${m.venueId}`} className="cs-venue-row">
              <span className="cs-venue-main">
                <strong>{nameOf(m.venueId)}</strong>
                <span className="muted">Left – membership kept until {ukDate(m.renewalDate)}. Add the venue again to restore it.</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {pendingVenues.length > 0 && (
        <ul className="cs-venue-list">
          {pendingVenues.map((v) => (
            <li key={v.id} className="cs-venue-row">
              <span className="cs-venue-main">
                <strong>{v.name}</strong>
                <span className="muted">Waiting for approval</span>
              </span>
              <button
                type="button"
                className="btn cs-venue-remove"
                disabled={busy}
                onClick={() => runRequest(() => api.cancelMyVenueRequest(v.id), `Request to join ${v.name} cancelled.`)}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      {venues && available.length > 0 && (
        <label>
          Add a venue
          <select value={addId} onChange={(e) => setAddId(e.target.value)} disabled={busy}>
            <option value="">Choose a venue</option>
            {available.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.joinPolicy === 'approval' ? ' (needs approval)' : ''}</option>
            ))}
          </select>
        </label>
      )}
      {addId && needsApproval && (
        <button
          type="button"
          className="btn btn-primary cs-btn-block"
          disabled={busy}
          onClick={() => runRequest(() => api.requestMyVenue(addId), `Request sent to ${nameOf(addId)} - you'll get an email when it's decided.`)}
        >
          {busy ? 'Sending…' : 'Request to join'}
        </button>
      )}
      {addId && !needsApproval && (
        <button
          type="button"
          className="btn btn-primary cs-btn-block"
          disabled={busy}
          onClick={() => run(() => api.joinMyVenue(addId), `${nameOf(addId)} added.`)}
        >
          {busy ? 'Saving…' : 'Add venue'}
        </button>
      )}
      {error && <p className="error">{error}</p>}
      {success && <p className="banner banner-success">{success}</p>}
    </div>
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
      <MyBookings />

      <section className="card cs-settings">
        <h2>Account settings</h2>
        <SettingsSection title="Your details">
          <ProfileForm player={user} onSaved={updateUser} />
        </SettingsSection>
        <SettingsSection title="My venues">
          <MyVenuesForm player={user} onSaved={updateUser} />
        </SettingsSection>
        <SettingsSection title="Change password">
          <ChangePasswordForm />
        </SettingsSection>
      </section>
    </div>
  );
}
