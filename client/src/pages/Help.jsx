import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';
import { IssuesBugsFeaturesBody } from './IssuesBugsFeatures.jsx';

// Reached via the "?" icon in the top-right of the header (see App.jsx).
// A short intro and quick-link tiles, then the Feature requests / Issue
// tracker content (IssuesBugsFeaturesBody, shared with the standalone
// /issues-bugs-features page) embedded below - requests first here, and the
// admin-only GitHub tracker collapsed. Requires login (see the /help route in
// App.jsx) because that embedded content does.
export default function Help() {
  const { isAdmin, isCaptain, isLeagueManager } = useAuth();
  const isPlayerSession = !isAdmin && !isCaptain && !isLeagueManager;
  useSetBreadcrumbs([{ label: 'Home', to: isPlayerSession ? '/account' : '/' }, { label: 'Help' }]);

  const [guideCount, setGuideCount] = useState(null);
  const [openFormToken, setOpenFormToken] = useState(0);

  useEffect(() => {
    api.getGuides().then((g) => setGuideCount(Array.isArray(g) ? g.length : null)).catch(() => setGuideCount(null));
  }, []);

  return (
    <div className="sx-page">
      <div className="au-head">
        <Link to={isPlayerSession ? '/account' : '/'} className="msg-icon-btn" aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <h1>Help</h1>
      </div>
      <p className="muted mm-intro">Guides, and a place to ask for new features or report a problem.</p>

      <div className="ap-grid">
        <Link to="/guides" className="ap-tile">
          <span className="ap-tile-top">
            <span className="ap-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" /><path d="M20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" /></svg>
            </span>
          </span>
          <strong className="ap-tile-title">Guides</strong>
          <span className="ap-tile-desc">
            {guideCount === null ? 'Reference documents' : `${guideCount} guide${guideCount === 1 ? '' : 's'} available`}
          </span>
        </Link>
        <button type="button" className="ap-tile sx-tile-btn" onClick={() => setOpenFormToken((t) => t + 1)}>
          <span className="ap-tile-top">
            <span className="ap-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /><path d="M12 8v5" /><path d="M9.5 10.5h5" /></svg>
            </span>
          </span>
          <strong className="ap-tile-title">Request a feature</strong>
          <span className="ap-tile-desc">Or report a problem</span>
        </button>
      </div>

      <IssuesBugsFeaturesBody requestsFirst trackerCollapsed openFormToken={openFormToken} />
    </div>
  );
}
