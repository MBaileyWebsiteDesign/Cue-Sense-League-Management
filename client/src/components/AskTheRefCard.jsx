import './virtualTraining.css';

// Player Portal > "Ask the Ref" placeholder (2026-10-27). Will become a rules
// Q&A: a player describes a shot, picks a ruleset and gets a ruling. For now it
// only says it is under development. Shown inside the sub-app gate in
// PlayerPortal.jsx (owner only) until it works. Reuses the Virtual Training
// card styling.
export default function AskTheRefCard() {
  return (
    <section className="card vt-locked">
      <h2>Ask the Ref</h2>
      <p className="vt-lock-line"><span aria-hidden="true">🛠️</span> Ask the Ref is under development.</p>
      <p className="muted">It is not available yet.</p>
    </section>
  );
}
