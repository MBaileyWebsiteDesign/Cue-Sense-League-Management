import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { useIsAdminSession } from '../useAdminSession.js';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];

// Same labels used on the Roll of Honour page, duplicated locally rather
// than importing across pages for one small constant.
const SCHEDULING_LABEL = {
  round_robin_single: 'Round Robin - Single',
  round_robin_double: 'Round Robin - Double',
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

export default function PlayerProfile() {
  const { playerId } = useParams();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const isAdmin = useIsAdminSession();

  useEffect(() => {
    api.getPlayerProfile(playerId).then(setProfile).catch((e) => setError(e.message));
  }, [playerId]);

  useSetBreadcrumbs(
    profile
      ? [{ label: 'Home', to: '/' }, { label: profile.name }]
      : [{ label: 'Home', to: '/' }, { label: 'Loading…' }]
  );

  if (error) return <p className="error">{error}</p>;
  if (!profile) return <p>Loading…</p>;

  const { career } = profile;
  const winPct = career.played > 0 ? Math.round((career.won / career.played) * 100) : 0;

  return (
    <div>
      <h1>{profile.name}</h1>
      <p className="muted">Career record across every league and division</p>

      {isAdmin && <AdminAccountPanel playerId={profile.id} divisions={profile.divisions || []} />}

      <section className="card">
        <h2>Career</h2>
        <div className="card-grid">
          <div><strong>{career.played}</strong><div className="muted">Played</div></div>
          <div><strong>{career.won}</strong><div className="muted">Won</div></div>
          <div><strong>{career.lost}</strong><div className="muted">Lost</div></div>
          <div><strong>{winPct}%</strong><div className="muted">Win rate</div></div>
          <div><strong>{career.framesFor}-{career.framesAgainst}</strong><div className="muted">Frames for/against</div></div>
          <div><strong>{career.frameDifference > 0 ? '+' : ''}{career.frameDifference}</strong><div className="muted">Frame diff</div></div>
        </div>
        {profile.formGuide && profile.formGuide.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ marginBottom: 4 }}>Form (most recent first)</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {profile.formGuide.map((g, i) => (
                <span key={i} className={`status ${g === 'W' ? 'status-completed' : ''}`} style={{ fontWeight: 700 }}>{g}</span>
              ))}
            </div>
          </div>
        )}
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
        <h2>Head-to-head</h2>
        {profile.headToHead.length === 0 ? (
          <p className="muted">No completed matches yet.</p>
        ) : (
          <table className="standings-table">
            <thead>
              <tr><th>Opponent</th><th>P</th><th>W</th><th>L</th></tr>
            </thead>
            <tbody>
              {profile.headToHead.map((h) => (
                <tr key={h.opponentId}>
                  <td style={{ textAlign: 'left' }}>{h.opponentName}</td>
                  <td>{h.played}</td>
                  <td>{h.won}</td>
                  <td>{h.lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Match history</h2>
        {profile.results.length === 0 ? (
          <p className="muted">No completed matches yet.</p>
        ) : (
          <ul className="fixture-list">
            {profile.results.map((r, i) => (
              <li key={i}>
                <Link to={`/fixtures/${r.fixtureId}`}>
                  vs {r.opponentName} <strong>{r.forScore}-{r.againstScore}</strong>
                  <span className="muted"> · {r.leagueName} / {r.divisionName} ({r.context})</span>
                </Link>
                <span className={`status ${r.result === 'win' ? 'status-completed' : ''}`}>{r.result}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
