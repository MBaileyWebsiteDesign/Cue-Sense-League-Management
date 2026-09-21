// Outbound email via the MailerSend HTTP API (https://developers.mailersend.com).
//
// Config (environment variables - never committed):
//   MAILERSEND_API_KEY     API token from MailerSend (Email > send access). If unset,
//                          sending is skipped and callers get { sent: false, skipped: true }.
//   MAILERSEND_FROM_EMAIL  Sender address. Default noreply@cuesense.co.uk. Its domain must be
//                          verified in MailerSend or the API rejects the send.
//   MAILERSEND_FROM_NAME   Sender display name. Default "Cue Sense".
//   APP_BASE_URL           Optional override for links in emails (e.g. https://app.cuesense.co.uk).
//                          Otherwise derived from the incoming request's Host header.
//
// sendMail() never throws or rejects - email is best-effort and must never break the
// action that triggered it. Check the returned { sent, skipped, error }.

const API_URL = 'https://api.mailersend.com/v1/email';
const TIMEOUT_MS = 10000;

// In-memory record of the last sends (newest first) so an admin can see why an
// email didn't arrive without needing server logs. Resets on restart/redeploy.
// Recipient addresses are masked; no message content is kept.
const recentMail = [];
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  return d ? `${u.slice(0, 1)}***@${d}` : '(none)';
}
function record(to, subject, outcome) {
  recentMail.unshift({ at: new Date().toISOString(), to: maskEmail(to), subject, ...outcome });
  if (recentMail.length > 30) recentMail.length = 30;
  return outcome;
}
export function getMailLog() {
  return recentMail.slice();
}
export function mailSettings() {
  return {
    configured: !!process.env.MAILERSEND_API_KEY,
    fromEmail: process.env.MAILERSEND_FROM_EMAIL || 'noreply@cuesense.co.uk',
    fromName: process.env.MAILERSEND_FROM_NAME || 'Cue Sense',
    baseUrlOverride: process.env.APP_BASE_URL || null,
  };
}

export function mailConfigured() {
  return !!process.env.MAILERSEND_API_KEY;
}

export function baseUrlFor(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  const host = req.get('host') || '';
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  return `${local ? req.protocol : 'https'}://${host}`;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Minimal shared HTML wrapper so every email looks consistent.
export function emailHtml(heading, innerHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#111">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
${innerHtml}
<p style="color:#666;font-size:12px;margin-top:24px">Sent by Cue Sense League Management. Please do not reply to this email.</p>
</div>`;
}

export async function sendMail({ to, toName, subject, text, html }) {
  const apiKey = process.env.MAILERSEND_API_KEY;
  if (!apiKey) {
    console.warn(`[mail] MAILERSEND_API_KEY not set - skipped "${subject}" to ${to}`);
    return record(to, subject, { sent: false, skipped: true, error: 'MAILERSEND_API_KEY is not set on this server' });
  }
  if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) return record(to, subject, { sent: false, skipped: true, error: 'no valid recipient address' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        from: {
          email: process.env.MAILERSEND_FROM_EMAIL || 'noreply@cuesense.co.uk',
          name: process.env.MAILERSEND_FROM_NAME || 'Cue Sense',
        },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        text,
        html,
      }),
    });
    if (res.ok) return record(to, subject, { sent: true, status: res.status });
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    let message = detail;
    try { message = JSON.parse(detail).message || detail; } catch { /* keep raw */ }
    console.error(`[mail] MailerSend rejected "${subject}" to ${to}: HTTP ${res.status} ${detail}`);
    return record(to, subject, { sent: false, status: res.status, error: `MailerSend HTTP ${res.status}: ${message}`.slice(0, 300) });
  } catch (err) {
    console.error(`[mail] send failed for "${subject}" to ${to}:`, err?.message || err);
    return record(to, subject, { sent: false, error: err?.name === 'AbortError' ? 'MailerSend timed out' : `Could not reach MailerSend: ${String(err?.message || err)}`.slice(0, 300) });
  } finally {
    clearTimeout(timer);
  }
}
