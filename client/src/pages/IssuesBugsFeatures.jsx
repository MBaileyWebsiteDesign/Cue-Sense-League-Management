import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Was AdminIssueTracker.jsx / admin-only /admin/issues. Now open to every
// logged-in account (players, League Managers and Overall Admins alike) and
// split into two halves:
//   1. Issue / Bug Tracker - a read-only mirror of the project's GitHub
//      Issues (see GET /api/github-issues in server/src/index.js, which
//      proxies GitHub's public REST API server-side with a short cache to
//      stay under GitHub's unauthenticated rate limit). Filing or
//      commenting on an issue still happens on GitHub itself.
//   2. Feature / Requests - lightweight in-app requests, no GitHub account
//      needed. Anyone logged in can submit one and see everyone else's;
//      only an Overall Admin can remove one (e.g. a duplicate).
const REPO_ISSUES_URL = 'https://github.com/MBaileyWebsiteDesign/Cue-Sense-League-Management/issues';
const FILTERS = ['open', 'closed', 'all'];

export default function IssuesBugsFeatures() {
  const { isAdmin } = useAuth();
  const [issues, setIssues] = useState(null);
  const [issuesError, setIssuesError] = useState('');
  const [filter, setFilter] = useState('open');

  const [requests, setRequests] = useState(null);
  const [requestsError, setRequestsError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Issues / Bugs / Features' }]);

  useEffect(() => {
    api.getGithubIssues().then(setIssues).catch((e) => setIssuesError(e.message));
  }, []);

  const loadRequests = () => api.getFeatureRequests().then(setRequests).catch((e) => setRequestsError(e.message));
  useEffect(() => {
    loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!issues) return null;
    return filter === 'all' ? issues : issues.filter((i) => i.state === filter);
  }, [issues, filter]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitError('');
    setSubmitting(true);
    try {
      await api.submitFeatureRequest(title, description);
      setTitle('');
      setDescription('');
      await loadRequests();
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id) => {
    setDeletingId(id);
    try {
      await api.adminDeleteFeatureRequest(id);
      await loadRequests();
    } catch (err) {
      setRequestsError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <h1>Issues / Bugs / Features</h1>

      <section className="card">
        <h2>Issue / Bug Tracker</h2>
        <p className="muted">
          Live from the project's{' '}
          <a href={REPO_ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub Issues</a>
          {' '}&mdash; feature requests and bugs together, most recently updated first. File or
          comment on an issue directly on GitHub; this list is read-only.
        </p>

        {issuesError && <p className="error">{issuesError}</p>}

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

        {!issues && !issuesError ? (
          <p>Loading&hellip;</p>
        ) : filtered ? (
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
        ) : null}
      </section>

      <section className="card">
        <h2>Feature / Requests</h2>
        <p className="muted">
          Don't have (or don't want to set up) a GitHub account? Put a feature idea or other
          request here instead &mdash; visible to everyone, players and league admins included.
        </p>

        <form className="form" onSubmit={onSubmit} style={{ marginBottom: 24 }}>
          <label>
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
            />
          </label>
          <label>
            Details (optional)
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
              rows={4}
            />
          </label>
          {submitError && <p className="error">{submitError}</p>}
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? 'Submitting\u2026' : 'Submit request'}
          </button>
        </form>

        {requestsError && <p className="error">{requestsError}</p>}

        {!requests ? (
          <p>Loading&hellip;</p>
        ) : (
          <ul className="fixture-list">
            {requests.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>{r.title}</strong>
                  {r.description && <div className="muted">{r.description}</div>}
                </span>
                <span className="muted">
                  {r.createdByName} &middot; {new Date(r.createdAt).toLocaleDateString()}
                  {isAdmin && (
                    <>
                      {' '}&middot;{' '}
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => onDelete(r.id)}
                        disabled={deletingId === r.id}
                      >
                        {deletingId === r.id ? 'Removing\u2026' : 'Remove'}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
            {requests.length === 0 && <li className="muted">No requests yet &mdash; be the first.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
