import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Player messaging (private 1-to-1 chat for arranging games). Two views on
// one component: /messages (inbox + start a new chat + blocked players) and
// /messages/:userId (a single conversation with block/report controls).
// Server rules live in the "Player messaging" section of server/src/index.js.

const POLL_MS = 15000;
const MAX_LEN = 1000;

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
}

function Avatar({ name, size = 'md' }) {
  return (
    <span className={`msg-avatar msg-avatar-${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Inbox row time: just the time for today, otherwise the day and month.
function formatListWhen(iso) {
  const d = new Date(iso);
  if (sameDay(d, new Date())) return formatTime(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

function Inbox() {
  const [threads, setThreads] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [emailAlerts, setEmailAlerts] = useState(null);

  const load = useCallback(() => {
    api.getMessageThreads().then(setThreads).catch((e) => setError(e.message));
    api.getMessageBlocks().then(setBlocks).catch(() => setBlocks([]));
  }, []);

  useEffect(() => {
    load();
    api.getMessageContacts('').then(setContacts).catch(() => setContacts([]));
    api.getMessageEmailPreference().then((p) => setEmailAlerts(p.emailMessageAlerts)).catch(() => setEmailAlerts(null));
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const unblock = async (userId) => {
    try {
      await api.unblockUser(userId);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleEmailAlerts = async (value) => {
    const previous = emailAlerts;
    setEmailAlerts(value);
    try {
      const p = await api.setMessageEmailPreference(value);
      setEmailAlerts(p.emailMessageAlerts);
    } catch (e) {
      setEmailAlerts(previous);
      setError(e.message);
    }
  };

  const shownContacts = contacts.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="msg-page">
      <div className="msg-intro">
        <h1>Messages</h1>
        <p className="muted">Arrange games with players you share a league or venue with.</p>
      </div>
      {error && <p className="error">{error}</p>}

      <section className="msg-card">
        <h2>Conversations</h2>
        {threads === null ? (
          <p className="muted">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="muted msg-empty">No conversations yet - start one below.</p>
        ) : (
          <ul className="msg-list">
            {threads.map((t) => (
              <li key={t.userId}>
                <Link to={`/messages/${t.userId}`} className={`msg-thread${t.unread > 0 ? ' msg-thread-unread' : ''}`}>
                  <Avatar name={t.name} />
                  <span className="msg-thread-main">
                    <span className="msg-thread-top">
                      <strong className="msg-name">{t.name}</strong>
                      {t.blockedByMe && <span className="msg-tag">Blocked</span>}
                      <span className="msg-when">{formatListWhen(t.lastMessageAt)}</span>
                    </span>
                    <span className="msg-thread-bottom">
                      <span className="msg-preview">
                        {t.lastFromMe ? 'You: ' : ''}
                        {t.lastMessage}
                      </span>
                      {t.unread > 0 && <span className="msg-unread">{t.unread} new</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="msg-card">
        <h2>Start a new conversation</h2>
        <input
          type="search"
          className="msg-search"
          aria-label="Search players you can message"
          placeholder="Search players you can message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {contacts.length === 0 ? (
          <p className="muted msg-empty">
            No players available yet. You can message players who are in the same league as you, or registered at the same venue.
          </p>
        ) : shownContacts.length === 0 ? (
          <p className="muted msg-empty">No players match “{query.trim()}”.</p>
        ) : (
          <ul className="msg-list">
            {shownContacts.slice(0, 50).map((c) => (
              <li key={c.userId} className="msg-contact">
                <Avatar name={c.name} />
                <span className="msg-contact-main">
                  <strong className="msg-name">{c.name}</strong>
                  {c.via && (
                    <span className="muted msg-via" title={c.via}>
                      {c.via}
                    </span>
                  )}
                </span>
                <Link className="btn btn-brand-green msg-contact-btn" to={`/messages/${c.userId}`}>
                  Message
                </Link>
              </li>
            ))}
          </ul>
        )}
        {shownContacts.length > 50 && <p className="muted">Showing the first 50 - refine your search to see more.</p>}
      </section>

      {emailAlerts !== null && (
        <section className="msg-card msg-setting">
          <span className="msg-setting-text">
            <strong>Email alerts</strong>
            <span className="muted">Email me when I get a new message</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={!!emailAlerts}
            aria-label="Email me when I get a new message"
            className={`cs-switch${emailAlerts ? ' cs-switch-on' : ''}`}
            onClick={() => toggleEmailAlerts(!emailAlerts)}
          >
            <span />
          </button>
        </section>
      )}

      {blocks.length > 0 && (
        <section className="msg-card">
          <h2>Blocked players</h2>
          <ul className="msg-list">
            {blocks.map((b) => (
              <li key={b.userId} className="msg-contact">
                <Avatar name={b.name} />
                <span className="msg-contact-main">
                  <strong className="msg-name">{b.name}</strong>
                </span>
                <button type="button" className="btn msg-contact-btn" onClick={() => unblock(b.userId)}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ThreadMenu({ blockedByMe, onToggleBlock, onReport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
    };
  }, [open]);

  return (
    <div className="msg-menu" ref={ref}>
      <button
        type="button"
        className="msg-icon-btn"
        aria-label="Conversation options"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div className="msg-menu-pop">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onToggleBlock();
            }}
          >
            {blockedByMe ? 'Unblock' : 'Block'}
          </button>
          <button
            type="button"
            className="msg-menu-danger"
            onClick={() => {
              setOpen(false);
              onReport();
            }}
          >
            Report abuse
          </button>
        </div>
      )}
    </div>
  );
}

function Thread({ userId }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const load = useCallback(() => {
    api.getMessageThread(userId).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  }, [userId]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const count = data ? data.messages.length : 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);

  // Grow the compose box with its content (up to about 5 lines).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await api.sendMessage(userId, text.trim());
      setText('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const toggleBlock = async () => {
    setError('');
    try {
      if (data.blockedByMe) await api.unblockUser(userId);
      else await api.blockUser(userId);
      setNotice(data.blockedByMe ? 'Player unblocked.' : 'Player blocked. They can no longer message you, and they are not told.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitReport = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.reportMessageUser(userId, reason.trim());
      setReporting(false);
      setReason('');
      setNotice('Thanks - your report has been sent to the league manager.');
    } catch (err) {
      setError(err.message);
    }
  };

  if (!data) return error ? <p className="error">{error}</p> : <p>Loading…</p>;

  // Group messages under a divider for each day.
  const items = [];
  let lastDay = null;
  for (const m of data.messages) {
    const d = new Date(m.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (key !== lastDay) {
      items.push({ type: 'day', key: `day-${key}`, label: dayLabel(m.createdAt) });
      lastDay = key;
    }
    items.push({ type: 'msg', key: m.id, m });
  }

  return (
    <div className="msg-page msg-thread-page">
      <div className="msg-thread-head">
        <Link to="/messages" className="msg-icon-btn" aria-label="All messages">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <Avatar name={data.other.name} />
        <h1 className="msg-thread-name">{data.other.name}</h1>
        <ThreadMenu blockedByMe={data.blockedByMe} onToggleBlock={toggleBlock} onReport={() => setReporting(true)} />
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="banner banner-success">{notice}</p>}

      {reporting && (
        <form className="msg-card form" onSubmit={submitReport}>
          <h2>Report {data.other.name}</h2>
          <p className="muted">
            This conversation will be sent to the league manager(s) of the league(s) you share, and to the site admins.
          </p>
          <label>
            What happened?
            <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="msg-report-actions">
            <button type="submit" className="btn btn-danger" disabled={!reason.trim()}>Send report</button>
            <button type="button" className="btn" onClick={() => setReporting(false)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="msg-card msg-bubbles" aria-label={`Messages with ${data.other.name}`}>
        {data.messages.length === 0 ? (
          <p className="muted msg-empty msg-empty-thread">No messages yet - say hello and suggest a time.</p>
        ) : (
          items.map((it) =>
            it.type === 'day' ? (
              <div key={it.key} className="msg-day"><span>{it.label}</span></div>
            ) : (
              <div key={it.key} className={`msg-row${it.m.mine ? ' msg-row-mine' : ''}`}>
                <div className={`msg-bubble${it.m.mine ? ' msg-bubble-mine' : ''}`}>
                  {it.m.body}
                  <span className="msg-time">{formatTime(it.m.createdAt)}</span>
                </div>
              </div>
            )
          )
        )}
      </section>

      {data.canSend ? (
        <form className="msg-compose" onSubmit={send}>
          <div className="msg-compose-row">
            <textarea
              ref={inputRef}
              className="msg-compose-input"
              aria-label="Type a message"
              rows={1}
              maxLength={MAX_LEN}
              placeholder="Type a message…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className="msg-send" aria-label="Send" disabled={sending || !text.trim()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2.5-6.5z" />
              </svg>
            </button>
          </div>
          {text.length >= MAX_LEN - 100 && (
            <span className={`msg-count${text.length >= MAX_LEN ? ' msg-count-max' : ''}`}>
              {text.length}/{MAX_LEN}
            </span>
          )}
        </form>
      ) : (
        <div className="msg-card msg-cant-send">
          <p className="muted">
            {data.blockedByMe
              ? 'You have blocked this player. Unblock them to send a message.'
              : 'You can no longer message this player (you no longer share a league, venue, or ad hoc/head-to-head game).'}
          </p>
          {data.blockedByMe && (
            <button type="button" className="btn cs-btn-block" onClick={toggleBlock}>Unblock</button>
          )}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

export default function Messages() {
  const { userId } = useParams();
  useSetBreadcrumbs([
    { label: 'Home', to: '/account' },
    userId ? { label: 'Messages', to: '/messages' } : { label: 'Messages' },
    ...(userId ? [{ label: 'Conversation' }] : []),
  ]);
  return userId ? <Thread key={userId} userId={userId} /> : <Inbox />;
}
