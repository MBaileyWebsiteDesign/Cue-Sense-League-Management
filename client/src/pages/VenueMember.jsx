import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

// Venue Manager Portal > Tap to check in > Today's check-ins > a player's
// name. Shows that player's membership at this venue (not their playing
// stats) with Add 1 month / Add 1 year buttons, their recent visits here and
// linked cards. Date rule (server, POST /api/venue-manager/players/:id/renew):
// an active membership is extended from its end date; an ended one, one with
// no dates, or no membership at all starts today.
function formatDateUK(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function ukDateTime(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(/\//g, '-');
}

const STATUS = {
  active: { cls: 'ci-self-green', title: 'Membership active', text: (m) => `Runs to ${formatDateUK(m.renewalDate)}.` },
  expired: { cls: 'ci-self-red', title: 'Membership ended', text: (m) => `Ended on ${formatDateUK(m.renewalDate)}.` },
  'no-dates': { cls: 'ci-self-amber', title: 'No membership dates', text: () => 'Registered here, but no membership dates have been set.' },
  'not-member': { cls: 'ci-self-red', title: 'Not a member here', text: () => 'Not a member of this venue yet.' },
};

const PLANS = [
  { months: 1, label: 'Add 1 month', cls: 'btn-renew-yellow' },
  { months: 12, label: 'Add 1 year', cls: 'btn-renew-green' },
];

export default function VenueMember() {
  const { userId } = useParams();
  const [params] = useSearchParams();
  const venueId = params.get('venueId') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(0); // months being added
  const [armed, setArmed] = useState(0); // months waiting for the confirm tap
  const [notice, setNotice] = useState('');
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Venue Manager Portal', to: '/venue-manager' }, { label: 'Membership' }]);

  const load = () => api.getVenueMember(venueId, userId).then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    if (!venueId) { setError('No venue was chosen - go back to the Venue Manager Portal and try again.'); return; }
    load();
  }, [venueId, userId]);

  const add = (months) => {
    if (armed !== months) { setArmed(months); return; }
    setArmed(0); setBusy(months); setError(''); setNotice('');
    api.renewVenuePlayer(venueId, userId, months)
      .then((u) => {
        setNotice(`${months === 12 ? '1 year' : '1 month'} added. Membership now ${formatDateUK(u.membershipStartDate)} to ${formatDateUK(u.membershipRenewalDate)}.`);
        return load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(0));
  };

  const [joining, setJoining] = useState(false);
  const [armJoin, setArmJoin] = useState(false);
  const addToVenue = () => {
    if (!armJoin) { setArmJoin(true); return; }
    setArmJoin(false); setJoining(true); setError(''); setNotice('');
    api.addPlayerToVenue(venueId, userId)
      .then(() => { setNotice(`Added to ${data.venueName}. They're now in Registered players, with no membership dates yet.`); return load(); })
      .catch((e) => setError(e.message))
      .finally(() => setJoining(false));
  };

  const p = data && data.player;
  const m = (p && p.membership) || {};
  const st = p ? (STATUS[p.membershipStatus] || STATUS['not-member']) : null;
  const willExtend = p && p.membershipStatus === 'active';

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to="/venue-manager" className="msg-icon-btn" aria-label="Back to the Venue Manager Portal">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <span className="vm-title">
          <h1>{p ? `${p.firstName} ${p.lastName}` : 'Membership'}</h1>
          {data && <span className="muted">{data.venueName}</span>}
        </span>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {p && (
        <>
          <section className="card sx-card vm-panel">
            <div className="vm-panel-body vmm-body">
              <p className="muted vm-small vmm-email">{p.email}</p>
              {p.status === 'suspended' && <p><span className="status status-disputed">suspended account</span></p>}
              <div className={`ci-self-status ${st.cls}`}>
                <strong>{st.title}</strong>
                <span>{st.text(m)}</span>
              </div>
              <dl className="vmm-dates">
                <div><dt>Start</dt><dd>{formatDateUK(m.startDate) || '—'}</dd></div>
                <div><dt>End</dt><dd>{formatDateUK(m.renewalDate) || '—'}</dd></div>
                <div><dt>Visits here</dt><dd>{p.visitCount}</dd></div>
              </dl>

              {notice && <p className="vm-wi-notice" role="status">{notice}</p>}
              {p.membershipStatus === 'not-member' && (
                <div className="vmm-join">
                  <button type="button" className={`btn ${armJoin ? 'btn-primary' : ''} cs-btn-block`} disabled={joining || !!busy} onClick={addToVenue}>
                    {joining ? 'Adding…' : armJoin ? 'Tap again to confirm' : `Add to ${data.venueName}`}
                  </button>
                  <p className="muted vm-small">Adds them to this venue's Registered players with no membership dates. Use Add 1 month or Add 1 year below when they pay.</p>
                </div>
              )}
              <div className="vmm-plans">
                {PLANS.map((plan) => (
                  <button
                    key={plan.months}
                    type="button"
                    className={`btn ${armed === plan.months ? 'btn-primary' : plan.cls}`}
                    disabled={!!busy}
                    onClick={() => add(plan.months)}
                  >
                    {busy === plan.months ? 'Adding…' : armed === plan.months ? `Tap again to confirm` : plan.label}
                  </button>
                ))}
              </div>
              <p className="muted vm-small">
                {willExtend
                  ? `Adds to the current end date (${formatDateUK(m.renewalDate)}).`
                  : 'Starts today.'}
                {' '}Take payment first - adding it here doesn't charge the player.
              </p>
              {p.playerId && <p className="vm-small"><Link to={`/players/${p.playerId}`}>View playing stats</Link></p>}
            </div>
          </section>

          <section className="card sx-card vm-panel">
            <div className="vm-bk-band"><span className="vm-bk-band-title"><h2>Recent visits</h2></span></div>
            <div className="vm-panel-body">
              {data.visits.length === 0 ? <p className="muted vm-small">No visits logged here yet.</p> : (
                <ul className="ci-today">
                  {data.visits.map((v) => (
                    <li key={v.id} className="vmm-visit">
                      <span className="ci-time">{ukDateTime(v.at)}</span>
                      <span className="muted vm-small">{v.source === 'tag' ? 'Bar tag' : 'Card'}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted vm-small vmm-cards">
                Linked cards: {p.cards.length ? p.cards.map((c) => c.uid).join(', ') : 'none'}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
