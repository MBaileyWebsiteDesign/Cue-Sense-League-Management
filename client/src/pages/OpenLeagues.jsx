import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
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
  knockout_double_elim_pcdek: 'Pre Configured Double Elim Knockout',
  knockout_double_elim_adek: 'Adaptive Double Elim Knockout',
  round_robin_double: 'Standard League - Double Leg',
  round_robin_single: 'Standard League - Single Leg',
  killer_classic: 'Killer Classic',
  cards_killer: 'Cards Killer',
  free_play: 'Free Play',
};

const KILLER_SCHEDULING_TYPES = ['killer_classic', 'cards_killer'];

function schedulingLabel(scheduling) {
  return SCHEDULING_LABELS[scheduling] || 'Standard League - Single Leg';
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

// One line describing how a division plays, e.g.
// "Singles · Race to 6 · Standard League - Double Leg".
function divisionFormat(division) {
  const isKiller = KILLER_SCHEDULING_TYPES.includes(division.scheduling);
  const parts = [];
  if (isKiller) {
    parts.push(`${division.startingLives || 3} lives each`);
  } else {
    parts.push(entryTypeLabel(division));
    if (division.raceTo) parts.push(`Race to ${division.raceTo}`);
  }
  parts.push(schedulingLabel(division.scheduling));
  return parts.join(' · ');
}

function paymentLabel(payment) {
  if (!payment || !payment.required) return 'Free to join';
  const amount = payment.currency === 'GBP' ? `£${payment.amount}` : `${payment.amount} ${payment.currency}`;
  return `${amount} entry`;
}

function StatusBadge({ status }) {
  if (status === 'assigned') return <span className="ol-status ol-status-in">Registered</span>;
  if (status === 'pending') return <span className="ol-status ol-status-wait">Awaiting placement</span>;
  return null;
}

function DivisionsBlock({ divisions }) {
  if (!divisions || divisions.length === 0) return null;
  const formats = divisions.map(divisionFormat);
  const allSame = formats.every((f) => f === formats[0]);

  if (allSame) {
    return (
      <div className="ol-divs">
        <p className="ol-divs-format">
          <span className="ol-divs-label">{divisions.length === 1 ? 'Format' : 'All divisions'}</span>
          {formats[0]}
        </p>
        <div className="ol-div-chips">
          {divisions.map((d) => (
            <span key={d.name} className="ol-div-chip">{d.name}</span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <ul className="ol-div-rows">
      {divisions.map((d, i) => (
        <li key={d.name}>
          <strong>{d.name}</strong>
          <span className="muted">{formats[i]}</span>
        </li>
      ))}
    </ul>
  );
}

function LeagueCard({ league, requesting, onRequest }) {
  const l = league;
  const isRequesting = requesting === l.leagueId;
  return (
    <li className="ol-card">
      <div className="ol-card-head">
        <div className="ol-card-title">
          <Link to={`/leagues/${l.leagueId}`} className="ol-name">{l.leagueName}</Link>
          {l.sport && <span className="muted ol-sport">{l.sport}</span>}
        </div>
        <StatusBadge status={l.requestStatus} />
      </div>

      <div className="ol-chips">
        <span className="ol-chip">
          {l.divisionCount} division{l.divisionCount === 1 ? '' : 's'}
        </span>
        <span className={`ol-chip${l.payment && l.payment.required ? '' : ' ol-chip-free'}`}>
          {paymentLabel(l.payment)}
        </span>
      </div>

      <DivisionsBlock divisions={l.divisions} />

      {l.requestStatus === 'pending' && (
        <p className="muted ol-note">Interest registered - a League Manager will place you in a division.</p>
      )}

      <div className="ol-actions">
        {l.requestStatus !== 'assigned' && l.requestStatus !== 'pending' && (
          <button
            className="btn btn-primary cs-btn-block"
            type="button"
            disabled={isRequesting}
            onClick={() => onRequest(l.leagueId)}
          >
            {isRequesting ? 'Registering…' : 'Register interest'}
          </button>
        )}
        <Link to={`/leagues/${l.leagueId}`} className="btn cs-btn-block ol-view">
          View league
        </Link>
      </div>
    </li>
  );
}

export default function OpenLeagues() {
  const [leagues, setLeagues] = useState(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(null);
  const { isAdmin, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  const homePath = isPlayerSession ? '/account' : '/';

  useSetBreadcrumbs([{ label: 'Home', to: homePath }, { label: 'Open Leagues' }]);

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
    <div className="ol-page">
      <h1>Open Leagues</h1>
      <ol className="ol-how" aria-label="How it works">
        <li><span className="ol-how-num">1</span>Register your interest in a league</li>
        <li><span className="ol-how-num">2</span>A League Manager places you in a division</li>
      </ol>

      {error && <p className="error">{error}</p>}

      {!leagues ? (
        <p className="muted">Loading…</p>
      ) : leagues.length === 0 ? (
        <div className="card ol-empty">
          <p><strong>No leagues are open right now.</strong></p>
          <p className="muted">Check back soon - new leagues appear here when they open for registration.</p>
          <Link to={homePath} className="btn cs-btn-block">
            {isPlayerSession ? 'Back to my account' : 'Back to home'}
          </Link>
        </div>
      ) : (
        <ul className="ol-list">
          {leagues.map((l) => (
            <LeagueCard key={l.leagueId} league={l} requesting={requesting} onRequest={onRequest} />
          ))}
        </ul>
      )}
    </div>
  );
}
