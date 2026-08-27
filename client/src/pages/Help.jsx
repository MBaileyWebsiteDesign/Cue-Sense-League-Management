import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { IssuesBugsFeaturesBody } from './IssuesBugsFeatures.jsx';

// Reached via the "?" icon in the top-right of the header (see App.jsx).
// A short intro, then the actual Issue/Bug Tracker + Feature/Requests
// content (IssuesBugsFeaturesBody, shared with the standalone
// /issues-bugs-features page) embedded directly below it - the same
// feature-request/bug system, reused in place rather than just linked to.
// Requires login (see the /help route in App.jsx) because that embedded
// content does.
export default function Help() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Help' }]);

  return (
    <div>
      <section className="card">
        <h1>Help</h1>
        <p className="muted">This is the help section.</p>
      </section>

      <section className="card">
        <h2>Log a feature request or bug</h2>
        <p className="muted">Spotted a bug, or have an idea for something new?</p>
      </section>

      <IssuesBugsFeaturesBody />
    </div>
  );
}
