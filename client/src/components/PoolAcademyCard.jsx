import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './poolAcademy.css';

// My Account > "Pool Academy" (read-only, added 2026-10-26). Shows the progress the
// CueSense Pool Academy (cuesense.co.uk/academy) has recorded on this account.
// Nothing here can be edited; the numbers come from the server (user.academy).
// Level 1 is free. Levels 2-5 show as locked until an admin switches them on.

const LEVELS = [
  { n: 1, name: 'Beginner' },
  { n: 2, name: 'Casual Player' },
  { n: 3, name: 'Intermediate Player' },
  { n: 4, name: 'Advanced Player' },
  { n: 5, name: 'Professional Player' },
];
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const score = (s) => (s ? `${s.score} / ${s.max}` : '—');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function Stat({ label, value }) {
  return (
    <div className="pa-stat">
      <div className="pa-stat-value">{value}</div>
      <div className="pa-stat-label">{label}</div>
    </div>
  );
}

export default function PoolAcademyCard() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  // Starts minimized (2026-10-26); tap the title to open or close.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // The static demo build has no such call: show nothing there.
    if (typeof api.getMyAcademy !== 'function') return;
    api.getMyAcademy().then(setData).catch(() => setFailed(true));
  }, []);

  if (typeof api.getMyAcademy !== 'function') return null;
  if (failed) {
    return (
      <section className="card">
        <h2>Pool Academy</h2>
        <p className="muted">Your Pool Academy progress could not be loaded right now.</p>
      </section>
    );
  }
  if (!data) return null;

  const a = data.academy;
  const unlocked = data.levelsUnlocked;
  const quizzes = Object.values(a.quizzes);
  const passedQuizzes = quizzes.filter((q) => q.passed).length;
  const lessonsDone = Object.keys(a.lessons).length;

  return (
    <section className="card pa-card">
      <h2>
        <button type="button" className="pa-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Pool Academy</span>
          <span className="pa-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
      </h2>
      {open && (
        <>
      {!a.eventCount ? (
        <p className="muted">No Pool Academy progress has been recorded on this account yet. Level 1 is free.</p>
      ) : (
        <p className="muted pa-sub">Recorded by the CueSense Pool Academy. First active {day(a.firstActiveAt)}, last active {day(a.lastActiveAt)}.</p>
      )}

      {a.eventCount > 0 && (
        <div className="pa-stats">
          <Stat label="Lessons completed" value={lessonsDone} />
          <Stat label="Quizzes passed" value={passedQuizzes} />
          <Stat label="Highest level reached" value={a.highestLevel || '—'} />
          {unlocked && <Stat label="Practice challenge days" value={a.practice.daysDone} />}
        </div>
      )}

      <div className="pa-group">
        <h3>Levels</h3>
        <div className="pa-table-wrap">
          <table className="pa-table">
            <thead><tr><th>Level</th><th>Lessons done</th><th>Quizzes passed</th><th>Last active</th></tr></thead>
            <tbody>
              {LEVELS.map(({ n, name }) => {
                const row = a.levels[String(n)];
                if (!row) {
                  return (
                    <tr key={n} className="pa-locked-row">
                      <td><span aria-hidden="true">🔒</span> Level {n}: {name}</td>
                      <td colSpan={3}>Paid. Not switched on for your account.</td>
                    </tr>
                  );
                }
                return (
                  <tr key={n}>
                    <td>Level {n}: {name}</td>
                    <td>{row.lessonsCompleted}</td>
                    <td>{row.quizzesPassed}</td>
                    <td>{day(row.lastActivityAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!unlocked && (
          <p className="pa-note">Level 1 is free. Levels 2 to 5 are a paid feature. Contact Cue Sense to have them added to your account.</p>
        )}
      </div>

      {quizzes.length > 0 && (
        <div className="pa-group">
          <h3>Quizzes</h3>
          <div className="pa-table-wrap">
            <table className="pa-table">
              <thead><tr><th>Quiz</th><th>Level</th><th>Attempts</th><th>Best score</th><th>Passed</th></tr></thead>
              <tbody>
                {Object.entries(a.quizzes).sort(([x], [y]) => x.localeCompare(y)).map(([key, q]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>{q.level}</td>
                    <td>{q.attempts}</td>
                    <td>{score(q.best)}</td>
                    <td>{q.passed ? 'Yes' : 'Not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unlocked && a.practice.daysDone > 0 && (
        <div className="pa-group">
          <h3>30-day practice challenge</h3>
          <ul className="pa-list">
            <li>{plural(a.practice.daysDone, 'day', 'days')} checked off, first on {day(a.practice.firstDay)}, last on {day(a.practice.lastDay)}.</li>
          </ul>
        </div>
      )}

      {a.lastVisited && (
        <p className="pa-note">Last lesson opened: Level {a.lastVisited.level}, {a.lastVisited.lessonKey}, on {day(a.lastVisited.at)}.</p>
      )}
        </>
      )}
    </section>
  );
}
