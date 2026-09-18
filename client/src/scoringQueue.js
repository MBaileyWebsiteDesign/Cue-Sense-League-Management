// Optimistic UI + local retry queue for scoring actions (frame wins) on
// slow/flaky connections - see claude/optimistic-scoring-retry-queue-*.md
// in the project docs for the full design writeup.
//
// The problem this solves: this app is used on venue mobile data/wifi that
// can be slow or drop mid-request. Recording a frame today is fully
// pessimistic - the button click awaits the network round trip with no
// feedback, and if the connection drops, the click is simply lost unless
// the user notices the error and retries by hand.
//
// This module keeps a small, localStorage-backed queue of pending frame
// recordings. Each queued item carries a client-generated `clientRequestId`
// that the server (see server/src/index.js's frame routes) uses to make a
// retried request a safe no-op if the original attempt actually reached the
// server - so it's always safe to keep retrying a queued item rather than
// risk leaving a frame unrecorded.
//
// Pairs with the pure `applyOptimisticFrame`/`rollbackOptimisticFrame`
// helpers below, which FixtureDetail.jsx uses to show a frame's effect on
// the scoreboard instantly, before the network request (or its retries)
// actually confirms it.

import { api } from './api.js';

const STORAGE_KEY = 'cuesense_scoring_queue_v1';
// Backoff schedule for a failing/offline retry; holds at the last value
// (30s) rather than growing forever, since correctness (not speed) is what
// matters once we're clearly offline - the `online` event below still
// triggers an immediate retry the moment connectivity returns.
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];

function loadQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage can throw (private browsing, full quota) - the queue
    // still works in-memory for this page load, it just won't survive a
    // reload. Not fatal: the in-flight retry loop below keeps going either
    // way.
  }
}

let queue = loadQueue();
// clientRequestId -> pending setTimeout handle, so a manual/online-triggered
// retry can cancel a scheduled one instead of racing it.
const timers = new Map();
// clientRequestId -> onSettled callback. Kept out of `queue` itself (which
// is JSON-serialized to localStorage) since functions can't survive that -
// a callback only lives as long as the page that registered it.
const callbacks = new Map();
// Notified whenever the queue changes, so UI can show "saving.../offline,
// will retry" without polling.
const listeners = new Set();

function notify() {
  listeners.forEach((fn) => fn(queue));
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(queue);
  return () => listeners.delete(fn);
}

export function pendingCountFor(fixtureId) {
  return queue.filter((item) => item.fixtureId === fixtureId).length;
}

export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older mobile browsers without crypto.randomUUID - doesn't
  // need to be cryptographically strong, just unique enough per device.
  return `cr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clearTimer(clientRequestId) {
  const handle = timers.get(clientRequestId);
  if (handle) {
    clearTimeout(handle);
    timers.delete(clientRequestId);
  }
}

function remove(clientRequestId) {
  clearTimer(clientRequestId);
  queue = queue.filter((i) => i.clientRequestId !== clientRequestId);
  saveQueue();
  notify();
}

function scheduleRetry(item) {
  clearTimer(item.clientRequestId);
  const delay = RETRY_DELAYS_MS[Math.min(item.attempts, RETRY_DELAYS_MS.length - 1)];
  const handle = setTimeout(() => attempt(item), delay);
  timers.set(item.clientRequestId, handle);
}

async function attempt(item) {
  try {
    if (item.type === 'recordFrame') {
      await api.recordFrame(item.fixtureId, item.winnerPlayerId, item.method, item.breaker, item.clientRequestId);
    } else {
      await api.recordLegFrame(item.fixtureId, item.legNumber, item.winnerPlayerId, item.method, item.breaker, item.clientRequestId);
    }
    const onSettled = callbacks.get(item.clientRequestId);
    callbacks.delete(item.clientRequestId);
    remove(item.clientRequestId);
    onSettled?.(null);
  } catch (err) {
    // Retry on anything that might not have reached the server, or a
    // transient server-side failure - both safe to retry given the
    // server's clientRequestId dedupe. A definite 4xx rejection (bad
    // request, match state has genuinely moved on, permission denied) is
    // not retried - that attempt truly failed and needs the user to decide
    // what to do next.
    const retryable = err.isNetworkError || (typeof err.status === 'number' && err.status >= 500);
    if (!retryable) {
      const onSettled = callbacks.get(item.clientRequestId);
      callbacks.delete(item.clientRequestId);
      remove(item.clientRequestId);
      onSettled?.(err);
      return;
    }
    item.attempts = (item.attempts || 0) + 1;
    saveQueue();
    notify();
    scheduleRetry(item);
  }
}

function enqueue(item, onSettled) {
  callbacks.set(item.clientRequestId, onSettled);
  queue = [...queue, item];
  saveQueue();
  notify();
  attempt(item);
}

// Queues a singles/doubles fixture frame recording. `onSettled(err)` is
// called once with `err === null` on success (caller should then refetch
// the canonical fixture) or the definitive error on non-retryable failure
// (caller should roll back the optimistic update and show it).
export function enqueueFrame({ fixtureId, winnerPlayerId, method, breaker, clientRequestId, onSettled }) {
  enqueue({ type: 'recordFrame', fixtureId, winnerPlayerId, method, breaker, clientRequestId, attempts: 0, createdAt: Date.now() }, onSettled);
}

// Queues a team-fixture leg's frame recording. See enqueueFrame above.
export function enqueueLegFrame({ fixtureId, legNumber, winnerPlayerId, method, breaker, clientRequestId, onSettled }) {
  enqueue({ type: 'recordLegFrame', fixtureId, legNumber, winnerPlayerId, method, breaker, clientRequestId, attempts: 0, createdAt: Date.now() }, onSettled);
}

// Re-attaches an onSettled callback to any already-queued items for a
// fixture - used when a page mounts (e.g. after a reload) and finds items
// left over from before, so their eventual resolution still refreshes the
// UI even though the original callback was lost when the page reloaded.
export function reattachFixture(fixtureId, onSettled) {
  queue.filter((i) => i.fixtureId === fixtureId).forEach((i) => callbacks.set(i.clientRequestId, onSettled));
}

// Resume any items left over from a previous page load (e.g. the tab was
// closed or reloaded mid-retry) - fire them immediately rather than waiting
// out their backoff delay again.
queue.forEach((item) => attempt(item));

// The moment connectivity returns, retry everything immediately instead of
// waiting out whatever backoff delay is currently scheduled.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    queue.forEach((item) => attempt(item));
  });
}

// --- Pure optimistic-update helpers -----------------------------------
//
// Mirrors exactly the scoring math the server performs when a frame is
// recorded (see server/src/index.js's POST .../frames routes) so the local
// optimistic state and the server's eventual real state agree. Works on
// either a singles/doubles fixture or a single team-fixture leg - both
// shapes carry frames/homePlayerId/awayPlayerId/homeFrameScore/
// awayFrameScore.

export function applyOptimisticFrame(entity, { winnerPlayerId, method, breaker, clientRequestId }) {
  const frames = [
    ...entity.frames,
    {
      frameNumber: entity.frames.length + 1,
      winnerPlayerId,
      method: method || undefined,
      breakerPlayerId: breaker || undefined,
      clientRequestId,
      pending: true, // not yet confirmed by the server - see the render side in FixtureDetail.jsx
    },
  ];
  return {
    ...entity,
    frames,
    homeFrameScore: frames.filter((f) => f.winnerPlayerId === entity.homePlayerId).length,
    awayFrameScore: frames.filter((f) => f.winnerPlayerId === entity.awayPlayerId).length,
    status: entity.status === 'scheduled' ? 'in_progress' : entity.status,
  };
}

export function rollbackOptimisticFrame(entity, clientRequestId) {
  const frames = entity.frames.filter((f) => f.clientRequestId !== clientRequestId);
  return {
    ...entity,
    frames,
    homeFrameScore: frames.filter((f) => f.winnerPlayerId === entity.homePlayerId).length,
    awayFrameScore: frames.filter((f) => f.winnerPlayerId === entity.awayPlayerId).length,
  };
}
