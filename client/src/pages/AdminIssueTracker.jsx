import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Read-only mirror of the project's GitHub Issues (admin-only) - see
// GET /api/admin/github-issues in server/src/index.js, which proxies
// GitHub's public REST API server-side (no token needed, the repo is
// public) with a short cache to stay well under GitHub's unauthenticated
// rate limit. Filing or commenting on an issue happens on GitHub itself -
// this page is a dashboard, not a second place to manage the tracker.
const REPO_ISSUES_URL = 'https://github.com/MBaileyWebsiteDesign/Cue-Sense-League-Management/issues';
const FILTERS = ['open', 'closed', 'all'];

export default function AdminIssueTracker() {
  const [issues, setIssues] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('open');

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Issue / Bug Tracker' }]);

  useEffect(() => {
    api.adminGetGithubIssues().then(setIssues).catch((e) => setError(e.message));
  }, []);

  const filtered = useMemo(() => {
    if (!issues) return null;
    return filter === 'all' ? issues : issues.filter((i) => i.state === filter);
  }, [issues, filter]);

  return (
    <div>
      <p><Link to="/admin">&larr; Admin Portal</Link></p>
      <h1>Issue / Bug Tracker</h1>
      <p className="muted">
        Live from the project's{' '}
        <a href={REPO_ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub Issues</a>
        {' '}&mdash; feature requests and bugs together, most recently updated first. File or
        comment on an issue directly on GitHub; this page is read-only.
      </p>

      {error && <p className="error">{error}</p>}

      <p>
        {FILTERS.map((f) => (
          <button
            key={f}
            className="btn-link"
            style={{
              marginRight: 16,
              fontWeight: filter === f ? 'bold' : 'normal',
              textDecoration: filter === f ? 'underline' : 'none',
            }}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </p>

      {!issues ? (
        <p>Loading&hellip;</p>
      ) : (
        <ul className="fixture-list">
          {filtered.map((issue) => (
            <li key={issue.number}>
              <span>
                <span
                  style={{
                    color: issue.state === 'open' ? '#1a7f37' : '#8250df',
                    fontWeight: 'bold',
                    marginRight: 6,
                  }}
                >
                  {issue.state === 'open' ? 'Open' : 'Closed'}
                </span>
                <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer">
                  #{issue.number} {issue.title}
                </a>
                {issue.labels.map((l) => (
                  <span
                    key={l.name}
                    style={{
                      marginLeft: 6,
                      fontSize: 12,
                      padding: '1px 6px',
                      borderRadius: 10,
                      background: `#${l.color}`,
                      color: '#1a1a1a',
                    }}
                  >
                    {l.name}
                  </span>
                ))}
              </span>
              <span className="muted">
                opened {new Date(issue.createdAt).toLocaleDateString()}
                {issue.commentCount > 0 ? ` \u00b7 ${issue.commentCount} comment${issue.commentCount === 1 ? '' : 's'}` : ''}
              </span>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted">No {filter === 'all' ? '' : filter} issues.</li>}
        </ul>
      )}
    </div>
  );
}
