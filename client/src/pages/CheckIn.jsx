import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { api } from '../api.js';

// Opened by a player's phone tapping the NFC tag on the bar (the tag holds
// this page's link - see BarTagPanel in VenueManagerPortal.jsx). Checks the
// logged-in player in at that venue and shows their membership status there.
// Renewing isn't offered: membership is paid at the venue, so the page asks
// them to see the bar staff instead.
function formatDateUK(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
function ukTime(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export default function CheckIn() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const sent = useRef(false);
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Check in' }]);

  useEffect(() => {
    if (sent.current) return; // React strict mode runs effects twice in dev
    sent.current = true;
    if (typeof api.selfCheckin !== 'function') { setError('Check-in is not available here.'); return; }
    api.selfCheckin(token).then(setData).catch((e) => setError(e.message));
  }, [token]);

  let tone = 'red';
  let headline = '';
  let detail = '';
  if (data) {
    const end = data.membership && data.membership.renewalDate;
    if (data.membershipStatus === 'active') {
      tone = 'green';
      headline = 'Membership active';
      detail = `Your membership at ${data.venueName} runs to ${formatDateUK(end)}.`;
    } else if (data.membershipStatus === 'expired') {
      headline = 'Membership ended';
      detail = `Your membership at ${data.venueName} ended on ${formatDateUK(end)}. Please see the bar staff to renew.`;
    } else if (data.membershipStatus === 'no-dates') {
      tone = 'amber';
      headline = 'Membership not set up yet';
      detail = `You're registered at ${data.venueName} but there are no membership dates yet. Please see the bar staff.`;
    } else {
      headline = 'Not a member here';
      detail = `You're not a member of ${data.venueName}. Please see the bar staff to join.`;
    }
  }

  return (
    <div className="sx-page">
      <section className="card sx-card ci-self">
        {!data && !error && <p>Checking you in…</p>}
        {error && (
          <>
            <h1>Couldn't check you in</h1>
            <p className="error">{error}</p>
          </>
        )}
        {data && (
          <>
            <p className="muted">{data.venueName}</p>
            <h1>{data.repeat ? `You're checked in, ${data.firstName}` : `Welcome, ${data.firstName}`}</h1>
            <p className="muted">Checked in at {ukTime(data.at)}</p>
            <div className={`ci-self-status ci-self-${tone}`}>
              <strong>{headline}</strong>
              <span>{detail}</span>
            </div>
          </>
        )}
        <p><Link to="/" className="btn">Go to my portal</Link></p>
      </section>
    </div>
  );
}
