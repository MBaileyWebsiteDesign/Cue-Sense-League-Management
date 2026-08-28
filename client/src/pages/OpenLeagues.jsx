import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// A league marked "Open For Registration" doesn't have a roster of its
// own to join directly - a player here just registers interest in the
// league as a whole, and a
// League Manager splits interested players across whichever division(s)
// they choose (bulk or one at a time) from that league's "Admin: Manage
// this League" -> League Interests subsection whenever they're ready.

const SCHEDULING_LABELS = {
  knockout_single_elim: 'Knockout (single elim)',
  knockout_double_elim: 'Knockout (double elim)',
  knockout_double_elim_ally: 'Ally Knockout (double elim)',
  knockout_double_elim_test: 'Testing Double Elim',
  knockout_double_elim_pcdek: 'Pre Configured Double Elim Knockout',
  knockout_double_elim_adek: 'Adaptive Double Elim Knockout',
  round_robin_double: 'Round Robin - Double',
  round_robin_single: 'Round Robin - Single',
};

function schedulingLabel(scheduling) {
  return SCHEDULING_LABELS[scheduling] || 'Round Robin - Single';
}

function entryTypeLabel(division) {
  if (division.entryType === 'teams') {
    return `Teams · ${division.legsPerMatch} leg${division.legsPerMatch === 1 ? '' : 's'}/match`;
  }
  if (division.entryType === 'doubles') {
    return `${division.pairingSize === 3 ? 'Triples' : 'Doubles'} (${division.pairingSize} players/pairing)`;
  }
  return 'Singles';
}

function DivisionGameStyle({ division }) {
  return (
    <li>
      <strong>{division.name}</strong>{' '}
      <span className="muted">
        · {entryTypeLabel(division)} · race to {division.raceTo} · {schedulingLabel(division.scheduling)}
      </span>
    </li>
  );
}

function PaymentSummary({ payment }) {
  if (!payment || !payment.required) {
    return <span className="muted">Free to join</span>;
  }
  const amount = payment.currency === 'GBP' ? `£${payment.amount}` : `${payment.amount} ${payment.currency}`;
  return <span className="muted">Entry fee: {amount}</span>;
}

export default function OpenLeagues() {
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Open Leagues' }]);

  const load = () => api.getOpenLeagues().then(setLeagues).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const onRequest = async (leagueId) => {
    setRequesting(leagueId);
    setError('');
    try {
      await api.requestToJoinLeague(leagueId);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setRequesting(null);
    }
  };

  return (
    <div>
      <h1>Open Leagues</h1>
      <p className="muted">
        Leagues here are open for any registered player to register interest in. A League Manager will
        place you into a division once they're ready.
      </p>

      {error && <p className="error">{error}</p>}

      {!leagues ? (
        <p className="muted">Loading…</p>
      ) : leagues.length === 0 ? (
        <p className="muted">No leagues are open for interest registration right now.</p>
      ) : (
        <ul className="fixture-list">
          {leagues.map((l) => (
            <li key={l.leagueId} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  <Link to={`/leagues/${l.leagueId}`}>{l.leagueName}</Link>{' '}
                  <span className="muted">
                    · {l.divisionCount} division{l.divisionCount === 1 ? '' : 's'} ·{' '}
                  </span>
                  <PaymentSummary payment={l.payment} />
                </span>
                {l.requestStatus === 'assigned' ? (
                  <span className="muted">You're already registered</span>
                ) : l.requestStatus === 'pending' ? (
                  <span className="muted">Interest registered - awaiting placement</span>
                ) : (
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={requesting === l.leagueId}
                    onClick={() => onRequest(l.leagueId)}
                  >
                    {requesting === l.leagueId ? 'Registering…' : 'Register interest'}
                  </button>
                )}
              </div>
              {l.divisions && l.divisions.length > 0 && (
                <ul className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                  {l.divisions.map((d) => (
                    <DivisionGameStyle key={d.name} division={d} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
