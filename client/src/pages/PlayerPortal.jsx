import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

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
    <form className="card form portal-card" onSubmit={onSubmit}>
      <h2>Your Details</h2>
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
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save Details'}
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
    <form className="card form portal-card" onSubmit={onSubmit}>
      <h2>Change Password</h2>
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
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Changing…' : 'Change Password'}
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

// Opponent name inside a My Fixtures row. Singles fixtures where the
// opponent has a messaging-eligible account (see opponentUserId, set by
// GET /api/users/me/fixtures) link straight into a conversation with them,
// so players can arrange a game without leaving the app. Team/doubles
// opponents (no single person to message) and opponents with no linkable
// account just render as plain text, same as before.
function OpponentName({ f }) {
  if (!f.opponentUserId) return f.opponentName;
  return (
    <Link
      to={`/messages/${f.opponentUserId}`}
      onClick={(e) => e.stopPropagation()}
      title={`Message ${f.opponentName}`}
    >
      {f.opponentName}
    </Link>
  );
}

function MyFixtures() {
  const [fixtures, setFixtures] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.getMyFixtures().then(setFixtures).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!fixtures) return <p>Loading…</p>;

  const upcoming = fixtures.filter((f) => f.status !== 'completed' && f.status !== 'pending_confirmation');
  const pendingConfirmation = fixtures.filter((f) => f.status === 'pending_confirmation');
  const recent = fixtures.filter((f) => f.status === 'completed').slice(-10).reverse();

  return (
    <section className="card portal-card">
      <h2>My Fixtures</h2>
      {fixtures.length === 0 && (
        <p className="muted">You're not registered in any division or team yet - an admin or captain can add you from Manage Users / a division's roster.</p>
      )}

      {upcoming.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>Upcoming</h3>
          <ul className="fixture-list">
            {upcoming.map((f) => (
              <li key={f.id}>
                <div
                  className="fixture-info fixture-row-link"
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/fixtures/${f.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/fixtures/${f.id}`); }}
                >
                  <span className="fixture-line">{f.leagueName}</span>
                  <span className="fixture-line">{f.divisionName}</span>
                  <span className="fixture-line">Round {f.round}</span>
                  <span className="fixture-line">vs <OpponentName f={f} /></span>
                </div>
                {f.scheduledDate ? (
                  <span className="muted">{f.scheduledDate}</span>
                ) : (
                  <Link to={`/fixtures/${f.id}`} className="btn btn-primary">Click to play</Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {pendingConfirmation.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>Waiting Confirmation</h3>
          <ul className="fixture-list">
            {pendingConfirmation.map((f) => (
              <li key={f.id}>
                <div
                  className="fixture-info fixture-row-link"
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/fixtures/${f.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/fixtures/${f.id}`); }}
                >
                  <span className="fixture-line">{f.leagueName}</span>
                  <span className="fixture-line">{f.divisionName}</span>
                  <span className="fixture-line">Round {f.round}</span>
                  <span className="fixture-line">vs <OpponentName f={f} /></span>
                </div>
                <span className="btn btn-danger" style={{ cursor: 'default' }}>Waiting Confirmation</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {recent.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>Recent results</h3>
          <ul className="fixture-list">
            {recent.map((f) => (
              <li key={f.id}>
                <div
                  className="fixture-info fixture-row-link"
                  role="link"
                  tabIndex={0}
                  onClick={() => navigate(`/fixtures/${f.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/fixtures/${f.id}`); }}
                >
                  <span className="fixture-line">{f.leagueName}</span>
                  <span className="fixture-line">{f.divisionName}</span>
                  <span className="fixture-line">Round {f.round}</span>
                  <span className="fixture-line">vs <OpponentName f={f} /></span>
                </div>
                <span className="status status-completed">completed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// NQT: "Add a section in the player portal below fixtures that lists
// divisions/leagues or any other competitions they are in or have been
// in." Uses the same getMyLeagueMembership() data - that endpoint never
// drops a division from the list when it completes, so this already
// covers past divisions, not just the ones currently running. This is
// now the only place the player's league/division membership is shown -
// ProfileForm's "Your Details" used to repeat it inline but that was
// removed as a redundant duplicate.
//
// 2026-09-16: split into three subsections under one heading/card - "My
// Leagues" (each distinct league the player has a division in, deduped by
// leagueId, linking to /leagues/:id), "Divisions" (every standard division
// entry, same shape as the original single list), and "Ad Hoc/Quick Games"
// (entries whose league is the shared hidden "Ad Hoc Games" pool - see
// POST /api/adhoc-games in server/src/index.js). The split relies on the
// server's isAdHocPool flag (added alongside this change to GET
// /api/users/me/leagues) rather than matching on the league's name.
function MyLeaguesAndDivisions({ leagues }) {
  if (!leagues || leagues.length === 0) {
    return (
      <section className="card portal-card">
        <h2>My Leagues, Divisions &amp; Ad Hoc/Head-to-Head Games</h2>
        <p className="muted">You're not registered in any leagues, divisions, or ad hoc/head-to-head games yet.</p>
      </section>
    );
  }

  const standard = leagues.filter((l) => !l.isAdHocPool);
  const adHocGames = leagues.filter((l) => l.isAdHocPool);

  const myLeagues = [];
  const seenLeagueIds = new Set();
  standard.forEach((l) => {
    if (l.leagueId && !seenLeagueIds.has(l.leagueId)) {
      seenLeagueIds.add(l.leagueId);
      myLeagues.push(l);
    }
  });

  return (
    <section className="card portal-card">
      <h2>My Leagues, Divisions &amp; Ad Hoc/Head-to-Head Games</h2>

      <h3 style={{ fontSize: '1rem', color: 'var(--muted)' }}>My Leagues</h3>
      {myLeagues.length === 0 ? (
        <p className="muted">You're not registered in any leagues yet.</p>
      ) : (
        <ul className="plain-list">
          {myLeagues.map((l) => (
            <li key={l.leagueId}>
              <Link to={`/leagues/${l.leagueId}`}>{l.leagueName}</Link>
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ fontSize: '1rem', color: 'var(--muted)', marginTop: '1rem' }}>Divisions</h3>
      {standard.length === 0 ? (
        <p className="muted">You're not registered in any divisions yet.</p>
      ) : (
        <ul className="plain-list">
          {standard.map((l, i) => (
            <li key={l.divisionId || i}>
              {l.divisionId ? (
                <Link to={`/divisions/${l.divisionId}`}>{l.leagueName} - {l.divisionName}</Link>
              ) : (
                <span>{l.leagueName} - {l.divisionName}</span>
              )}
              {l.status === 'completed' && <span className="muted"> · season complete</span>}
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ fontSize: '1rem', color: 'var(--muted)', marginTop: '1rem' }}>Ad Hoc/Head-to-Head Games</h3>
      {adHocGames.length === 0 ? (
        <p className="muted">You haven't created or played in any Ad Hoc or Head-to-Head Games yet.</p>
      ) : (
        <ul className="plain-list">
          {adHocGames.map((l, i) => (
            <li key={l.divisionId || i}>
              {l.divisionId ? (
                <Link to={`/divisions/${l.divisionId}`}>{l.divisionName}</Link>
              ) : (
                <span>{l.divisionName}</span>
              )}
              {l.status === 'completed' && <span className="muted"> · completed</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The Player Management Portal - every account's home base: profile details,
// password, and a personal fixture list (upcoming + recent results) across
// every division/team they're registered in. Admins and captains land here
// too via "My Account" in the header; their extra Admin/Captain Portal links
// sit alongside this rather than replacing it, since every account is a
// player account first.
// Messages card: pale green when nothing is unread, pale red when there is
// at least one unread message - the same pale traffic-light shades as the
// Venue Manager Portal tiles (#d1fae5 green / #fee2e2 red). Polls once a
// minute while the portal is open. Quietly hides itself if the messaging
// API isn't available (static demo build).
const MESSAGES_TINT_NONE = '#d1fae5';
const MESSAGES_TINT_UNREAD = '#fee2e2';

function MessagesCard() {
  const [unread, setUnread] = useState(null);

  useEffect(() => {
    if (!api.getMessageSummary) return undefined;
    let cancelled = false;
    const load = () => api.getMessageSummary().then((r) => { if (!cancelled) setUnread(r.unread); }).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (unread === null) return null;
  const hasUnread = unread > 0;
  return (
    <Link
      to="/messages"
      className="card"
      style={{
        display: 'block',
        textDecoration: 'none',
        color: '#1f2937',
        background: hasUnread ? MESSAGES_TINT_UNREAD : MESSAGES_TINT_NONE,
        textAlign: 'center',
      }}
    >
      <h2 style={{ margin: 0 }}>Messages</h2>
      <p style={{ margin: '0.25rem 0 0' }}>
        {hasUnread ? `${unread} new message${unread === 1 ? '' : 's'}` : 'No new messages'}
      </p>
    </Link>
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

export default function PlayerPortal() {
  const { user, updateUser, isAdmin, isCaptain, isLeagueManager } = useAuth();
  const [leagues, setLeagues] = useState([]);
  // A plain player's Home crumb points at their own portal rather than the
  // general leagues list - harmless here since it's the same page, but
  // keeps the crumb consistent with every other page they visit.
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'My Account' }]);

  useEffect(() => {
    api.getMyLeagueMembership().then(setLeagues).catch(() => setLeagues([]));
  }, []);

  if (!user) return <p>Loading…</p>;

  const badges = [user.isAdmin && 'Admin', user.isCaptain && 'Captain'].filter(Boolean);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>My Account</h1>
          {badges.length > 0 && <p className="muted">{badges.join(' & ')}</p>}
        </div>
      </div>

      <MySubmissions />

      <MessagesCard />

      <div className="inline-form account-quick-actions" style={{ justifyContent: 'center', margin: '1rem 0' }}>
        {user.playerId && (
          <Link className="btn btn-primary" to={`/players/${user.playerId}`}>View my stats &amp; match history</Link>
        )}
        <Link className="btn btn-primary" to="/adhoc-game/new">Ad Hoc Game</Link>
        {/* Skips the Ad Hoc Game wizard entirely - straight to a Free Play,
            2-player game pre-named "<Player Name> - <Date Created>" (see
            AdHocGame.jsx's quickStart prop / /adhoc-game/quick route). */}
        <Link className="btn btn-primary" to="/adhoc-game/quick">Head-to-Head</Link>
        <Link className="btn btn-primary" to="/open-leagues">Leagues I can Join</Link>
        {(isAdmin || isLeagueManager) && <MessageReportsLink />}
      </div>

      <MyFixtures />
      <MyLeaguesAndDivisions leagues={leagues} />

      <ProfileForm player={user} onSaved={updateUser} />
      <ChangePasswordForm />
    </div>
  );
}
