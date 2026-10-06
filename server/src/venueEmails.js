// Venue membership emails (Matt, 2026-10-06).
//
// First email: "your membership expires in 5 days" for Top Spin Pool & Sports Bar.
// Sent through the same MailerSend sendMail() as the password reset emails.
//
// TEST MODE: nothing here emails real players yet. The only sender is the admin
// test route below, which always goes to TEST_RECIPIENT with sample data. The
// automated, end-date-driven sending will be added once Matt approves this email.

import { escapeHtml } from './mailer.js';

export const TEST_RECIPIENT = 'matt.bailey1985@gmail.com';

const LOGO_URL = 'https://static.wixstatic.com/media/d2bbc3_44bda9c9a0a448f19a49310ddaca41e6~mv2.png';
const VENUE_NAME = 'Top Spin Pool & Sports Bar';

export function formatUkLongDate(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
}

// Builds { subject, text, html } for the 5-day expiry warning.
// expiryDate is already-formatted display text (e.g. "Sunday 11 October 2026").
export function membershipExpiryEmail({ firstName, expiryDate, daysLeft = 5 }) {
  const name = escapeHtml(firstName || 'there');
  const when = escapeHtml(expiryDate);
  const subject = `Your Top Spin membership expires in ${daysLeft} days`;

  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    `Just a quick heads-up from all of us at ${VENUE_NAME}: your membership is due to expire in ${daysLeft} days, on ${expiryDate}.`,
    '',
    'Once it expires, you have two options on your next visit:',
    '',
    '1. Renew your membership - just pay at the bar when you next come in.',
    '2. Pay by the hour - you can pay for the table by the hour each time you play.',
    '',
    "We'd love to keep seeing you at the tables. If you have any questions, just ask any of the team at the bar.",
    '',
    'See you soon,',
    'The Top Spin Team',
    '',
    'Please do not reply to this email.',
  ].join('\n');

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
      <img src="${LOGO_URL}" width="160" alt="Top Spin Pool and Sports Bar" style="display:block;border:0;outline:none;height:auto;max-width:160px;">
    </td></tr>
    <tr><td style="background:#1d4ed8;padding:14px 24px;text-align:center;">
      <span style="font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:0.3px;">Your membership expires in ${daysLeft} days</span>
    </td></tr>
    <tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">Hi ${name},</p>
      <p style="margin:0 0 14px 0;">Just a quick heads-up from all of us at ${escapeHtml(VENUE_NAME)}: your membership is due to expire in <strong>${daysLeft} days</strong>, on <strong>${when}</strong>.</p>
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
      <p style="margin:0;">See you soon,<br><strong>The Top Spin Team</strong></p>
    </td></tr>
    <tr><td style="background:#f3f4f6;padding:14px 28px;text-align:center;font-size:12px;color:#6b7280;">
      ${escapeHtml(VENUE_NAME)}<br>Please do not reply to this email.
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
    const msg = membershipExpiryEmail({ firstName: 'Sam', expiryDate: formatUkLongDate(expiry), daysLeft: 5 });
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
