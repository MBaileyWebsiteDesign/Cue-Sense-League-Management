import './virtualTraining.css';

// My Account > "AI Coaching" placeholder (2026-10-26). Looks like the locked
// Virtual Training card and does nothing yet - it only says it is under
// development. Reuses the Virtual Training card styling.
export default function AiCoachingCard() {
  return (
    <section className="card vt-locked">
      <h2>AI Coaching</h2>
      <p className="vt-lock-line"><span aria-hidden="true">🛠️</span> AI Coaching is under development.</p>
      <p className="muted">It is not available yet.</p>
    </section>
  );
}
