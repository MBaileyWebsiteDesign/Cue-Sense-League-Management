import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

// Player messaging (private 1-to-1 chat for arranging games). Two views on
// one component: /messages (inbox + start a new chat + blocked players) and
// /messages/:userId (a single conversation with block/report controls).
// Server rules live in the "Player messaging" section of server/src/index.js.

const POLL_MS = 15000;

function formatWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function Inbox() {
  const [threads, setThreads] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.getMessageThreads().then(setThreads).catch((e) => setError(e.message));
    api.getMessageBlocks().then(setBlocks).catch(() => setBlocks([]));
  }, []);

  useEffect(() => {
    load();
    api.getMessageContacts('').then(setContacts).catch(() => setContacts([]));
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

  const shownContacts = contacts.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Messages</h1>
          <p className="muted">Arrange games with players you share a league or venue with.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Conversations</h2>
        {threads === null ? (
          <p className="muted">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="muted">No conversations yet - start one below.</p>
        ) : (
          <table>
            <tbody>
              {threads.map((t) => (
                <tr key={t.userId}>
                  <td>
                    <Link to={`/messages/${t.userId}`}>
                      <strong>{t.name}</strong>
                    </Link>
                    {t.unread > 0 && (
                      <span style={{ marginLeft: 8, background: '#fee2e2', color: '#991b1b', borderRadius: 10, padding: '1px 8px', fontSize: '0.8rem' }}>
                        {t.unread} new
                      </span>
                    )}
                    {t.blockedByMe && <span className="muted"> (blocked)</span>}
                  </td>
                  <td className="muted">{t.lastFromMe ? 'You: ' : ''}{t.lastMessage}</td>
                  <td className="muted">{formatWhen(t.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Start a new conversation</h2>
        <input
          type="search"
          placeholder="Search players you can message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: '0.75rem', width: '100%', maxWidth: 360 }}
        />
        {contacts.length === 0 ? (
          <p className="muted">
            No players available yet. You can message players who are in the same league as you, or registered at the same venue.
          </p>
        ) : (
          <table>
            <tbody>
              {shownContacts.slice(0, 50).map((c) => (
                <tr key={c.userId}>
                  <td style={{ padding: '0.6rem 0.75rem', verticalAlign: 'middle' }}><strong>{c.name}</strong></td>
                  <td className="muted" style={{ padding: '0.6rem 0.75rem', verticalAlign: 'middle' }}>{c.via}</td>
                  <td style={{ textAlign: 'right', padding: '0.6rem 0.75rem', verticalAlign: 'middle' }}>
                    <Link className="btn btn-primary" style={{ display: 'inline-block' }} to={`/messages/${c.userId}`}>Message</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {shownContacts.length > 50 && <p className="muted">Showing the first 50 - refine your search to see more.</p>}
      </section>

      {blocks.length > 0 && (
        <section className="card">
          <h2>Blocked players</h2>
          <table>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.userId}>
                  <td>{b.name}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn" onClick={() => unblock(b.userId)}>Unblock</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
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

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{data.other.name}</h1>
          <p><Link to="/messages">&larr; All messages</Link></p>
        </div>
        <div className="inline-form">
          <button type="button" className="btn" onClick={toggleBlock}>{data.blockedByMe ? 'Unblock' : 'Block'}</button>
          <button type="button" className="btn btn-danger" onClick={() => setReporting((r) => !r)}>Report abuse</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="banner banner-success">{notice}</p>}

      {reporting && (
        <form className="card form" onSubmit={submitReport}>
          <h2>Report {data.other.name}</h2>
          <p className="muted">
            This conversation will be sent to the league manager(s) of the league(s) you share, and to the site admins.
          </p>
          <label>
            What happened?
            <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="inline-form">
            <button type="submit" className="btn btn-danger" disabled={!reason.trim()}>Send report</button>
            <button type="button" className="btn" onClick={() => setReporting(false)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="card" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {data.messages.length === 0 ? (
          <p className="muted">No messages yet - say hello and suggest a time.</p>
        ) : (
          data.messages.map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: m.mine ? 'flex-end' : 'flex-start', margin: '0.35rem 0' }}>
              <div
                style={{
                  maxWidth: '80%',
                  padding: '0.5rem 0.75rem',
                  borderRadius: 12,
                  background: m.mine ? '#d1fae5' : '#f3f4f6',
                  color: '#111827',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {m.body}
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: 2 }}>{formatWhen(m.createdAt)}</div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </section>

      {data.canSend ? (
        <form className="card form" onSubmit={send}>
          <textarea
            rows={2}
            maxLength={1000}
            placeholder="Type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="inline-form">
            <button type="submit" className="btn btn-primary" disabled={sending || !text.trim()}>Send</button>
          </div>
        </form>
      ) : (
        <p className="muted">
          {data.blockedByMe
            ? 'You have blocked this player. Unblock them to send a message.'
            : 'You can no longer message this player (you no longer share a league or venue).'}
        </p>
      )}
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
