import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// In-app popup for new messages and replies (Matt, 2026-11-26). Polls the
// caller's message threads while they are logged in and the tab is visible; the
// first load only records what is already there (no popup for old unread
// messages), after that any thread whose latest message is a new incoming one
// pops a banner that opens the chat. No popup while that chat is already open.
const POLL_MS = 30000;
const SHOW_MS = 9000;

export default function MessageToast() {
  const { isLoggedIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [toast, setToast] = useState(null);
  const seen = useRef(null);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    // The static demo build has no messaging API.
    if (!isLoggedIn || !api.getMessageThreads) {
      seen.current = null;
      setToast(null);
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const threads = await api.getMessageThreads();
        if (cancelled || !Array.isArray(threads)) return;
        const next = new Map();
        const fresh = [];
        for (const t of threads) {
          next.set(t.userId, t.lastMessageAt);
          if (
            seen.current &&
            t.unread > 0 &&
            !t.lastFromMe &&
            !t.blockedByMe &&
            seen.current.get(t.userId) !== t.lastMessageAt &&
            pathRef.current !== `/messages/${t.userId}`
          ) {
            fresh.push(t);
          }
        }
        seen.current = next;
        if (fresh.length > 0) {
          fresh.sort((x, y) => (x.lastMessageAt < y.lastMessageAt ? 1 : -1));
          const latest = fresh[0];
          setToast({
            userId: latest.userId,
            name: latest.name,
            preview: latest.lastMessage,
            more: fresh.length - 1,
            key: `${latest.userId}-${latest.lastMessageAt}`,
          });
        }
      } catch {
        // Offline or signed out: try again on the next poll.
      }
    };
    check();
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;

  const open = () => {
    const id = toast.userId;
    setToast(null);
    navigate(`/messages/${id}`);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 16,
        margin: '0 auto',
        maxWidth: 420,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'stretch',
        background: '#166534',
        color: '#fff',
        borderLeft: '4px solid #c9a227',
        borderRadius: 10,
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
      }}
    >
      <button
        type="button"
        onClick={open}
        style={{
          flex: 1,
          minHeight: 44,
          textAlign: 'left',
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          padding: '10px 12px',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        <strong style={{ display: 'block' }}>New message from {toast.name}</strong>
        <span style={{ display: 'block', fontSize: 14, opacity: 0.92, overflowWrap: 'anywhere' }}>{toast.preview}</span>
        {toast.more > 0 && (
          <span style={{ display: 'block', fontSize: 13, marginTop: 4, opacity: 0.85 }}>
            + {toast.more} more {toast.more === 1 ? 'conversation' : 'conversations'} with new messages
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setToast(null)}
        aria-label="Dismiss"
        style={{
          minWidth: 44,
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          fontSize: 22,
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
