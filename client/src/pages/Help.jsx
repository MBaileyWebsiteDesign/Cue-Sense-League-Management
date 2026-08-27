import { Link } from 'react-router-dom';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Reached via the "?" icon in the top-right of the header (see App.jsx).
// Deliberately simple: a short intro, then a card pointing at the existing
// Issues / Bugs / Features page (IssuesBugsFeatures.jsx) rather than
// re-implementing a second feature-request/bug form here - that page is
// already the app's one feature-request/bug logging system (live GitHub
// Issues plus in-app Feature / Requests), reachable from the main nav and
// the Admin/League Manager portals too.
export default function Help() {
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Help' }]);

  return (
    <div>
      <section className="card">
        <h1>Help</h1>
        <p className="muted">This is the help section.</p>
      </section>

      <Link to="/issues-bugs-features" className="card card-link">
        <h2>Log a feature request or bug</h2>
        <p className="muted">Spotted a bug, or have an idea for something new?</p>
      </Link>
    </div>
  );
}
