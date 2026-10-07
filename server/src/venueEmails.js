// Venue membership emails (Matt, 2026-10-06 / 2026-10-07).
//
// Email 1: "your membership expires in N days" - sent automatically, once per
// membership end date, when a player's end date is 1-5 days away. Sent through
// the same MailerSend sendMail() as the password reset emails.
//
// How it runs:
//  - Per venue switch: venue.expiryEmailsEnabled (Venue Manager Portal tickbox,
//    off by default). Nothing is sent for a venue until its switch is on.
//  - The Fly.io machine sleeps when idle, so this checks shortly after start-up
//    and then every 15 minutes while awake. It only sends between 09:00 and
//    20:00 UK time, never at night.
//  - "Already sent" is recorded on the player's membership entry as
//    expiryEmailSentFor (the end date it was sent for) + expiryEmailSentAt.
//    Renewing changes the end date, so the next cycle emails again, once.
//  - Production only: it does nothing when not running on Fly.io, or on an app
//    whose name contains "staging", so a copy of live data can never email players.
//  - A failed send is retried (at most 3 attempts, 6 hours apart).

import { escapeHtml } from './mailer.js';

export const TEST_RECIPIENT = 'matt.bailey1985@gmail.com';

const MAX_DAYS_BEFORE = 5;
const SEND_FROM_HOUR_UK = 9;
const SEND_BEFORE_HOUR_UK = 20;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
const MAX_FAILURES = 3;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const TOP_SPIN_LOGO = 'https://static.wixstatic.com/media/d2bbc3_44bda9c9a0a448f19a49310ddaca41e6~mv2.png';

// Branding by venue name. Top Spin has its own logo and wording; any other
// venue whose switch is on gets a plain version using its own name.
export function venueBranding(venueName) {
  if (/top\s*spin/i.test(venueName || '')) {
    return { shortName: 'Top Spin', longName: 'Top Spin Pool & Sports Bar', logoUrl: TOP_SPIN_LOGO, logoAlt: 'Top Spin Pool and Sports Bar' };
  }
  const n = (venueName || 'the venue').trim();
  return { shortName: n, longName: n, logoUrl: null, logoAlt: n };
}

export function formatUkLongDate(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}

function todayUkIso(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
}
function ukHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(now)) % 24;
}
function daysBetweenIso(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// The "email sent" time to show in the Venue Manager Portal - only while the
// marker still matches the player's current end date (renewing clears it).
export function expiryEmailSentAt(m) {
  if (!m || !m.renewalDate) return null;
  return m.expiryEmailSentFor && m.expiryEmailSentFor === m.renewalDate ? (m.expiryEmailSentAt || null) : null;
}

// Builds { subject, text, html } for the expiry warning.
// expiryDate is already-formatted display text (e.g. "Sunday 11 October 2026").
export function membershipExpiryEmail({ firstName, expiryDate, daysLeft = 5, venueName = 'Top Spin' }) {
  const b = venueBranding(venueName);
  const name = escapeHtml(firstName || 'there');
  const when = escapeHtml(expiryDate);
  const dayWord = daysLeft === 1 ? 'day' : 'days';
  const subject = `Your ${b.shortName} membership expires in ${daysLeft} ${dayWord}`;

  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    `Just a quick heads-up from all of us at ${b.longName}: your membership is due to expire in ${daysLeft} ${dayWord}, on ${expiryDate}.`,
    '',
    'Once it expires, you have two options on your next visit:',
    '',
    '1. Renew your membership - just pay at the bar when you next come in.',
    '2. Pay by the hour - you can pay for the table by the hour each time you play.',
    '',
    "We'd love to keep seeing you at the tables. If you have any questions, just ask any of the team at the bar.",
    '',
    'See you soon,',
    `The ${b.shortName} Team`,
    '',
    'Please do not reply to this email.',
  ].join('\n');

  const header = b.logoUrl
    ? `<img src="${b.logoUrl}" width="160" alt="${escapeHtml(b.logoAlt)}" style="display:block;border:0;outline:none;height:auto;max-width:160px;">`
    : `<span style="font-size:22px;font-weight:bold;color:#ffffff;">${escapeHtml(b.longName)}</span>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f6;">Your membership expires on ${when}. Renew at the bar or pay by the hour.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <tr><td align="center" style="background:#000000;padding:22px 16px;">
      ${header}
    </td></tr>
    <tr><td style="background:#1d4ed8;padding:14px 24px;text-align:center;">
      <span style="font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:0.3px;">Your membership expires in ${daysLeft} ${dayWord}</span>
    </td></tr>
    <tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">Hi ${name},</p>
      <p style="margin:0 0 14px 0;">Just a quick heads-up from all of us at ${escapeHtml(b.longName)}: your membership is due to expire in <strong>${daysLeft} ${dayWord}</strong>, on <strong>${when}</strong>.</p>
      <p style="margin:0 0 6px 0;">Once it expires, you have two options on your next visit:</p>
    </td></tr>
    <tr><td style="padding:8px 28px 4px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#eff6ff;border-left:5px solid #1d4ed8;border-radius:6px;padding:14px 16px;font-size:16px;line-height:1.5;">
          <strong style="color:#1d4ed8;">Renew your membership</strong><br>Just pay at the bar when you next come in.
        </td></tr>
        <tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="background:#f3f4f6;border-left:5px solid #111827;border-radius:6px;padding:14px 16px;font-size:16px;line-height:1.5;">
          <strong style="color:#111827;">Pay by the hour</strong><br>You can pay for the table by the hour each time you play.
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 28px 28px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">We'd love to keep seeing you at the tables. If you have any questions, just ask any of the team at the bar.</p>
      <p style="margin:0;">See you soon,<br><strong>The ${escapeHtml(b.shortName)} Team</strong></p>
    </td></tr>
    <tr><td style="background:#f3f4f6;padding:14px 28px;text-align:center;font-size:12px;color:#6b7280;">
      ${escapeHtml(b.longName)}<br>Please do not reply to this email.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}


// Email 2: "your membership has expired" - same look as the 5-day alert.
export function membershipExpiredEmail({ firstName, venueName = 'Top Spin' }) {
  const b = venueBranding(venueName);
  const name = escapeHtml(firstName || 'there');
  const subject = `Your ${b.shortName} membership has expired`;

  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    `Your membership at ${b.longName} has expired.`,
    '',
    'We would love to see you rejoin for unlimited pool.',
    '',
    'See you soon,',
    `The ${b.shortName} Team`,
    '',
    'Please do not reply to this email.',
  ].join('\n');

  const header = b.logoUrl
    ? `<img src="${b.logoUrl}" width="160" alt="${escapeHtml(b.logoAlt)}" style="display:block;border:0;outline:none;height:auto;max-width:160px;">`
    : `<span style="font-size:22px;font-weight:bold;color:#ffffff;">${escapeHtml(b.longName)}</span>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f6;">Your membership has expired. We would love to see you rejoin for unlimited pool.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <tr><td align="center" style="background:#000000;padding:22px 16px;">
      ${header}
    </td></tr>
    <tr><td style="background:#1d4ed8;padding:14px 24px;text-align:center;">
      <span style="font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:0.3px;">Your membership has expired</span>
    </td></tr>
    <tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">Hi ${name},</p>
      <p style="margin:0 0 6px 0;">Your membership at ${escapeHtml(b.longName)} has expired.</p>
    </td></tr>
    <tr><td style="padding:8px 28px 4px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#eff6ff;border-left:5px solid #1d4ed8;border-radius:6px;padding:14px 16px;font-size:16px;line-height:1.5;">
          <strong style="color:#1d4ed8;">Rejoin for unlimited pool</strong><br>We would love to see you rejoin for unlimited pool.
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 28px 28px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0;">See you soon,<br><strong>The ${escapeHtml(b.shortName)} Team</strong></p>
    </td></tr>
    <tr><td style="background:#f3f4f6;padding:14px 28px;text-align:center;font-size:12px;color:#6b7280;">
      ${escapeHtml(b.longName)}<br>Please do not reply to this email.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

// Admin-only TEST send. Always goes to TEST_RECIPIENT with sample data - the
// caller cannot choose the recipient or the content.
export function registerVenueEmailTestRoute(app, deps) {
  const { requireAdmin, asyncRoute, sendMail, getMailLog, mailSettings } = deps;
  app.post('/api/admin/mail/test-membership-expiry', requireAdmin, asyncRoute((req, res) => {
    const expiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const msg = membershipExpiryEmail({ firstName: 'Sam', expiryDate: formatUkLongDate(expiry), daysLeft: 5, venueName: 'Top Spin' });
    sendMail({
      to: TEST_RECIPIENT,
      subject: `[TEST] ${msg.subject}`,
      text: msg.text,
      html: msg.html,
    }).then((result) => {
      res.json({ ...result, sentTo: TEST_RECIPIENT, ...mailSettings(), recent: getMailLog() });
    });
  }));

  app.post('/api/admin/mail/test-membership-expired', requireAdmin, asyncRoute((req, res) => {
    const msg = membershipExpiredEmail({ firstName: 'Sam', venueName: 'Top Spin' });
    sendMail({
      to: TEST_RECIPIENT,
      subject: `[TEST] ${msg.subject}`,
      text: msg.text,
      html: msg.html,
    }).then((result) => {
      res.json({ ...result, sentTo: TEST_RECIPIENT, ...mailSettings(), recent: getMailLog() });
    });
  }));
}

function sendingAllowedHere() {
  const app = process.env.FLY_APP_NAME;
  return !!app && !/staging/i.test(app);
}

let running = false;

// One pass. Safe to call repeatedly: a player is emailed once per end date.
// deps: { readDb, writeDb, sendMail, membershipAt, canEmail, recordAudit }
export async function runMembershipExpiryEmailsOnce(deps, now = new Date()) {
  const { readDb, writeDb, sendMail, membershipAt, canEmail, recordAudit } = deps;
  const summary = { skipped: null, sent: 0, failed: 0 };
  if (!sendingAllowedHere()) { summary.skipped = 'not-production'; return summary; }
  const hour = ukHour(now);
  if (hour < SEND_FROM_HOUR_UK || hour >= SEND_BEFORE_HOUR_UK) { summary.skipped = 'outside-hours'; return summary; }
  if (running) { summary.skipped = 'already-running'; return summary; }
  running = true;
  try {
    const todayIso = todayUkIso(now);
    const nowIso = now.toISOString();
    // 1. Work out who is due from one read.
    const db0 = readDb();
    const due = [];
    for (const venue of db0.venues || []) {
      if (venue.expiryEmailsEnabled !== true) continue;
      for (const u of db0.users || []) {
        const m = membershipAt(u, venue.id);
        if (!m || !m.renewalDate || !/^\d{4}-\d{2}-\d{2}$/.test(m.renewalDate)) continue;
        if (!canEmail(u)) continue;
        const daysLeft = daysBetweenIso(todayIso, m.renewalDate);
        if (daysLeft < 1 || daysLeft > MAX_DAYS_BEFORE) continue;
        if (m.expiryEmailSentFor === m.renewalDate) continue;
        if ((m.expiryEmailFailures || 0) >= MAX_FAILURES) continue;
        if (m.expiryEmailFailedAt && now - new Date(m.expiryEmailFailedAt) < RETRY_AFTER_MS) continue;
        due.push({ userId: u.id, venueId: venue.id, renewalDate: m.renewalDate, daysLeft });
      }
    }
    // 2. For each: claim it (sync write, so it can never be sent twice), send, then record the outcome.
    for (const item of due) {
      const db = readDb();
      const venue = (db.venues || []).find((v) => v.id === item.venueId);
      const user = (db.users || []).find((u) => u.id === item.userId);
      const m = user && membershipAt(user, item.venueId);
      if (!venue || !user || !m || m.renewalDate !== item.renewalDate || m.expiryEmailSentFor === item.renewalDate || venue.expiryEmailsEnabled !== true) continue;
      m.expiryEmailSentFor = item.renewalDate;
      m.expiryEmailSentAt = nowIso;
      writeDb(db);

      const msg = membershipExpiryEmail({
        firstName: user.firstName,
        expiryDate: formatUkLongDate(new Date(`${item.renewalDate}T12:00:00Z`)),
        daysLeft: item.daysLeft,
        venueName: venue.name,
      });
      let result;
      try {
        result = await sendMail({
          to: user.email,
          toName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || undefined,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
      } catch (err) {
        result = { sent: false, error: err && err.message };
      }

      const db2 = readDb();
      const user2 = (db2.users || []).find((u) => u.id === item.userId);
      const m2 = user2 && membershipAt(user2, item.venueId);
      if (result && result.sent) {
        summary.sent += 1;
        if (m2 && m2.expiryEmailSentFor === item.renewalDate) { m2.expiryEmailFailures = 0; delete m2.expiryEmailFailedAt; }
        try {
          recordAudit(db2, {
            actor: 'system',
            action: 'venue.expiryEmailSent',
            targetType: 'user',
            targetId: item.userId,
            details: `Sent "${msg.subject}" to ${user.firstName || ''} ${user.lastName || ''} (${venue.name} membership ends ${item.renewalDate})`,
          });
        } catch (e) { /* audit is best-effort */ }
        writeDb(db2);
      } else {
        summary.failed += 1;
        if (m2 && m2.expiryEmailSentFor === item.renewalDate && m2.expiryEmailSentAt === nowIso) {
          delete m2.expiryEmailSentFor;
          delete m2.expiryEmailSentAt;
          m2.expiryEmailFailures = (m2.expiryEmailFailures || 0) + 1;
          m2.expiryEmailFailedAt = nowIso;
          writeDb(db2);
        }
        console.warn('Membership expiry email failed:', result && result.error);
      }
    }
    if (summary.sent || summary.failed) console.log(`Membership expiry emails: ${summary.sent} sent, ${summary.failed} failed`);
    return summary;
  } finally {
    running = false;
  }
}

export function startMembershipExpiryEmailJob(deps) {
  if (!sendingAllowedHere()) return;
  const tick = () => {
    runMembershipExpiryEmailsOnce(deps).catch((err) => console.warn('Membership expiry email job error:', err && err.message));
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
