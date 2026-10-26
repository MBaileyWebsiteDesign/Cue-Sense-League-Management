import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './virtualTraining.css';

// My Account > "Virtual Training" (read-only, added 2026-10-25). Shows what the
// separate CueSense Virtual Training app has recorded on this account. Nothing
// here can be edited; the numbers come from the server (user.virtualTraining).

const nice = (id) => String(id).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const score = (s) => (s ? `${s.score} / ${s.max}` : '—');
const val = (n) => (n === null || n === undefined ? '—' : n);

function mins(seconds) {
  if (!seconds) return '0 min';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Stat({ label, value }) {
  return (
    <div className="vt-stat">
      <div className="vt-stat-value">{value}</div>
      <div className="vt-stat-label">{label}</div>
    </div>
  );
}

function Group({ title, children }) {
  return (
    <div className="vt-group">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export default function VirtualTrainingCard() {
  const [vt, setVt] = useState(null);
  const [failed, setFailed] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    // The static demo build has no such call: show nothing there.
    if (typeof api.getMyVirtualTraining !== 'function') return;
    api.getMyVirtualTraining()
      .then((r) => (r.locked ? setLocked(true) : setVt(r.virtualTraining)))
      .catch(() => setFailed(true));
  }, []);

  if (typeof api.getMyVirtualTraining !== 'function') return null;
  if (locked) {
    return (
      <section className="card vt-locked">
        <h2>Virtual Training</h2>
        <p className="vt-lock-line"><span aria-hidden="true">🔒</span> Virtual Training is a paid feature.</p>
        <p className="muted">It is not switched on for your account. Contact Cue Sense to have it added.</p>
      </section>
    );
  }
  if (failed) {
    return (
      <section className="card">
        <h2>Virtual Training</h2>
        <p className="muted">Your Virtual Training results could not be loaded right now.</p>
      </section>
    );
  }
  if (!vt) return null;

  if (!vt.eventCount) {
    return (
      <section className="card">
        <h2>Virtual Training</h2>
        <p className="muted">No Virtual Training results have been recorded on this account yet.</p>
      </section>
    );
  }

  const exercises = Object.entries(vt.training.exercises).sort(([a], [b]) => a.localeCompare(b));
  const ladder = Object.entries(vt.challenges.ladder.levels).sort(([a], [b]) => Number(a) - Number(b));
  const runs = Object.entries(vt.challenges.runs).sort(([a], [b]) => a.localeCompare(b));
  const dailyDates = Object.entries(vt.challenges.daily.byDate).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);

  return (
    <section className="card vt-card">
      <h2>Virtual Training</h2>
      <p className="muted vt-sub">Recorded by the CueSense Virtual Training app. First played {day(vt.firstPlayedAt)}, last played {day(vt.lastPlayedAt)}.</p>

      <div className="vt-stats">
        <Stat label="Matches won" value={`${vt.matches.won} of ${vt.matches.played}`} />
        <Stat label="Practice time" value={mins(vt.practice.seconds)} />
        <Stat label="Ladder level unlocked" value={vt.challenges.ladder.unlockedLevel} />
        <Stat label="Best pot streak" value={val(vt.challenges.streak.bestStreak)} />
      </div>

      {exercises.length > 0 && (
        <Group title="Training exercises">
          <div className="vt-table-wrap">
            <table className="vt-table">
              <thead><tr><th>Exercise</th><th>Attempts</th><th>Best attempt</th><th>Best session</th><th>Medal</th></tr></thead>
              <tbody>
                {exercises.map(([id, e]) => (
                  <tr key={id}>
                    <td>{nice(id)}</td>
                    <td>{e.attempts}</td>
                    <td>{score(e.bestAttempt)}</td>
                    <td>{score(e.bestSession)}</td>
                    <td>{e.bestMedal ? nice(e.bestMedal) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {vt.training.rounds.played > 0 && (
            <p className="vt-note">Mixed rounds: {vt.training.rounds.played} played, best {score(vt.training.rounds.best)}.</p>
          )}
        </Group>
      )}

      <Group title="Challenges">
        {ladder.length > 0 && (
          <div className="vt-table-wrap">
            <table className="vt-table">
              <thead><tr><th>Ladder level</th><th>Plays</th><th>Cleared</th><th>Best (fewest shots)</th></tr></thead>
              <tbody>
                {ladder.map(([level, e]) => (
                  <tr key={level}><td>Level {level}</td><td>{e.plays}</td><td>{e.completions}</td><td>{val(e.bestShots)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className="vt-list">
          <li>Daily challenge: {vt.challenges.daily.played} played, {vt.challenges.daily.passed} passed.</li>
          {runs.map(([id, e]) => (
            <li key={id}>{nice(id)}: {e.plays} played, {e.completions} cleared, best {val(e.bestShots)} shots.</li>
          ))}
          <li>Timed challenge: {vt.challenges.timed.plays} played, best {val(vt.challenges.timed.bestPots)} pots.</li>
          <li>Pot streak: {vt.challenges.streak.plays} played, best {val(vt.challenges.streak.bestStreak)}.</li>
          {vt.challenges.breakRun && vt.challenges.breakRun.plays > 0 && (
            <li>Break and pot: {vt.challenges.breakRun.plays} played, best {val(vt.challenges.breakRun.bestPots)} balls potted, table cleared {vt.challenges.breakRun.cleared}x.</li>
          )}
        </ul>
        {dailyDates.length > 0 && (
          <p className="vt-note">
            Recent daily tables: {dailyDates.map(([date, e]) => `${day(date)} ${e.passed ? `${e.shots} shots` : 'not cleared'}`).join(' · ')}
          </p>
        )}
      </Group>

      <Group title="Matches and practice">
        <ul className="vt-list">
          <li>Matches: {vt.matches.played} played, {vt.matches.won} won, {vt.matches.lost} lost. Frames {vt.matches.framesWon} won, {vt.matches.framesLost} lost.</li>
          <li>Practice: {vt.practice.sessions} {vt.practice.sessions === 1 ? 'session' : 'sessions'}, {vt.practice.shots} shots, {vt.practice.pots} pots, {vt.practice.scratches} scratches.</li>
        </ul>
      </Group>

      <Group title="Settings kept with your account">
        <ul className="vt-list">
          <li>Table size: {vt.settings.tableSize}. Cue view: {vt.settings.cueView ? 'on' : 'off'}.</li>
          {(vt.settings.assistance || vt.settings.camera || vt.settings.quality) && (
            <li>
              {[vt.settings.assistance && `Assistance ${vt.settings.assistance}`, vt.settings.camera && `Camera ${vt.settings.camera}`, vt.settings.quality && `Graphics ${vt.settings.quality}`].filter(Boolean).join(' · ')}
            </li>
          )}
        </ul>
      </Group>
    </section>
  );
}
