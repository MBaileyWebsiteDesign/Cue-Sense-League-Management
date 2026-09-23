import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Was AdminIssueTracker.jsx / admin-only /admin/issues, then briefly open
// to every logged-in account. Split into two halves with different
// audiences:
//   1. Issue / Bug Tracker - a read-only mirror of the project's GitHub
//      Issues (see GET /api/github-issues in server/src/index.js, which
//      proxies GitHub's public REST API server-side with a short cache to
//      stay under GitHub's unauthenticated rate limit). Filing or
//      commenting on an issue still happens on GitHub itself.
//      Overall-Admin-only (per Matt's request) - hidden entirely for plain
//      players, captains and League Managers.
//   2. Feature / Requests - lightweight in-app requests, no GitHub account
//      needed. Anyone logged in can submit one and see everyone else's;
//      only an Overall Admin can remove one (e.g. a duplicate). Each
//      submission is also filed on GitHub as an "Enhancement"-labeled issue
//      server-side (see POST /api/feature-requests) - the link back to it
//      shows up next to the request once that's happened. Stays visible to
//      every account type.
const FILTERS = ['open', 'closed', 'all'];

// The actual Issue/Bug Tracker + Feature/Requests markup and logic, split
// out from the standalone page below so the Help page (Help.jsx) can embed
// the same live content directly - one feature-request/bug system, reused
// rather than duplicated. No breadcrumbs or <h1> here; those are the
// standalone page's job.
export function IssuesBugsFeaturesBody() {
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
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    // Issue / Bug Tracker is Overall-Admin-only (see the note above the
    // FILTERS constant) - skip the fetch entirely for anyone else, since
    // the section below never renders for them.
    if (!isAdmin) return;
    api.getGithubIssues().then(setIssues).catch((e) => setIssuesError(e.message));
  }, [isAdmin]);

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

  const countOf = (f) => (issues ? (f === 'all' ? issues.length : issues.filter((i) => i.state === f).length) : 0);

  return (
    <div className="sx-stack dv-page">
      {isAdmin && (
      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Issue / Bug tracker</h2>
          <span className="muted sx-small">from GitHub</span>
        </div>

        {issuesError && <p className="error">{issuesError}</p>}

        <div className="division-tabs" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`division-tab${filter === f ? ' division-tab-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}{issues ? ` (${countOf(f)})` : ''}
            </button>
          ))}
        </div>

        {!issues && !issuesError ? (
          <p className="muted">Loading&hellip;</p>
        ) : filtered ? (
          <ul className="sx-issues">
            {filtered.map((issue) => (
              <li key={issue.number}>
                <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer" className="sx-issue">
                  <span className="sx-issue-top">
                    <span className={`sx-state sx-state-${issue.state}`}>{issue.state === 'open' ? 'Open' : 'Closed'}</span>
                    <span className="muted sx-small">#{issue.number}</span>
                  </span>
                  <strong className="sx-issue-title">{issue.title}</strong>
                  <span className="sx-issue-meta">
                    {issue.labels.map((l) => (
                      <span key={l.name} className="sx-label" style={{ background: `#${l.color}` }}>{l.name}</span>
                    ))}
                    <span className="muted sx-small">
                      opened {new Date(issue.createdAt).toLocaleDateString('en-GB')}
                      {issue.commentCount > 0 ? ` · ${issue.commentCount} comment${issue.commentCount === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                </a>
              </li>
            ))}
            {filtered.length === 0 && <li className="muted">No {filter === 'all' ? '' : filter} issues.</li>}
          </ul>
        ) : null}
      </section>
      )}

      <section className="card sx-card">
        <div className="sx-card-head">
          <h2>Feature requests</h2>
          {requests && <span className="muted">{requests.length}</span>}
        </div>

        <div className="ah-walkin sx-request">
          <button type="button" className="ah-walkin-toggle" aria-expanded={formOpen} onClick={() => setFormOpen((o) => !o)}>
            <span>Request a feature</span>
            <span aria-hidden="true">{formOpen ? '−' : '+'}</span>
          </button>
          {formOpen && (
            <form className="sx-form" onSubmit={onSubmit}>
              <label className="ll-field">
                Title
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
              </label>
              <label className="ll-field">
                <span>Details</span>
                <textarea className="sx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={5} required />
              </label>
              {submitError && <p className="error">{submitError}</p>}
              <button className="btn btn-primary cs-btn-block" type="submit" disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          )}
        </div>

        {requestsError && <p className="error">{requestsError}</p>}

        {!requests ? (
          <p className="muted">Loading&hellip;</p>
        ) : requests.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No requests yet &mdash; be the first.</p>
        ) : (
          <ul className="sx-issues">
            {requests.map((r) => (
              <li key={r.id} className="sx-request-row">
                <strong className="sx-issue-title">{r.title}</strong>
                {r.description && <span className="muted sx-small sx-request-desc">{r.description}</span>}
                <span className="sx-issue-meta">
                  <span className="muted sx-small">{r.createdByName} &middot; {new Date(r.createdAt).toLocaleDateString('en-GB')}</span>
                  {r.githubIssueUrl && (
                    <a className="sx-small" href={r.githubIssueUrl} target="_blank" rel="noopener noreferrer">GitHub #{r.githubIssueNumber}</a>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-danger dv-small-btn"
                      onClick={() => { if (window.confirm(`Remove request "${r.title}"?`)) onDelete(r.id); }}
                      disabled={deletingId === r.id}
                    >
                      {deletingId === r.id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// The standalone /issues-bugs-features page: same body as above, plus the
// page heading and breadcrumbs.
export default function IssuesBugsFeatures() {
  const { isAdmin, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'Issues / Bugs / Features' }]);

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to={isPlayerSession ? '/account' : '/'} className="msg-icon-btn" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Issues &amp; features</h1>
      </div>
      <IssuesBugsFeaturesBody />
    </div>
  );
}
