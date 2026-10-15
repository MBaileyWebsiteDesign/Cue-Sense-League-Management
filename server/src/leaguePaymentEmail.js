// League entry-fee payment request email (Matt, 2026-10-14) - first used for the
// Top Spin Singles League.
//
// What it does:
//  - Each league can hold bank details for its entry fee (account name, account
//    number, sort code). They are kept in their own list (db.leaguePaymentEmails),
//    NOT on the league record, so they can never be returned by a league lookup.
//  - A TEST send always goes to TEST_RECIPIENT only, with sample data ("Sam").
//  - "Email unpaid players" sends the same email to every player whose League
//    Interests row shows the red Unpaid chip (pending interest, payment wall on,
//    no Paid / Waived record). It is blocked until a test has been sent with the
//    current bank details (saving different details clears the test).
//  - Each interest is emailed once (interest.paymentEmailSentAt), so pressing the
//    button again only reaches anyone new or anyone whose send failed.
//  - Players on placeholder @cuesense.co.uk addresses, suspended accounts and
//    no-login accounts are skipped and listed so they can be chased by hand.
//  - Real sends only happen on the live Fly.io app (never on staging or locally);
//    the test button works everywhere.
//  - Sending runs in the background (one run per league at a time); the page polls
//    GET .../payment-email for progress.
// Sent through the same MailerSend sendMail() as every other app email.

import { escapeHtml } from './mailer.js';
import { TEST_RECIPIENT, isPlaceholderEmail, venueBranding } from './venueEmails.js';

function sendingAllowedHere() {
  const app = process.env.FLY_APP_NAME;
  return !!app && !/staging/i.test(app);
}

function formatAmount(amount, currency) {
  const cur = (currency || 'GBP').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${cur}`;
  }
}

// Builds { subject, text, html }. bank = { accountName, accountNumber, sortCode }.
export function leaguePaymentEmail({ firstName, leagueName, venueName, amount, currency, bank }) {
  const b = venueBranding(venueName || leagueName);
  const name = escapeHtml(firstName || 'there');
  const league = leagueName || 'the league';
  const subject = `${league} - Payments`;
  const amountText = formatAmount(amount, currency);
  const leagueShort = String(league).replace(/\s+League$/i, '');

  const text = [
    `Hi ${firstName || 'there'},`,
    '',
    `We are now ready to accept payments for the ${league}. Please use the details below to make payments.`,
    '',
    'Bank details:',
    `Account name: ${bank.accountName}`,
    `Account number: ${bank.accountNumber}`,
    `Sort code: ${bank.sortCode}`,
    `Amount: ${amountText}`,
    `League: ${leagueShort}`,
    'Reference: Your Name',
    '',
    'Please use your name as reference.',
    '',
    'Thank you',
    '',
    league,
    'Please do not reply to this email.',
  ].join('\n');

  const header = b.logoUrl
    ? `<img src="${b.logoUrl}" width="160" alt="${escapeHtml(b.logoAlt)}" style="display:block;border:0;outline:none;height:auto;max-width:160px;">`
    : `<span style="font-size:22px;font-weight:bold;color:#ffffff;">${escapeHtml(league)}</span>`;

  const row = (label, value) => `<tr><td style="padding:6px 0;font-size:14px;color:#6b7280;width:140px;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:17px;font-weight:bold;color:#111827;">${escapeHtml(value)}</td></tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f6;">Time to start making payments for ${escapeHtml(league)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <tr><td align="center" style="background:#000000;padding:22px 16px;">
      ${header}
    </td></tr>
    <tr><td style="background:#1d4ed8;padding:14px 24px;text-align:center;">
      <span style="font-size:18px;font-weight:bold;color:#ffffff;letter-spacing:0.3px;">${escapeHtml(league)} - Payments</span>
    </td></tr>
    <tr><td style="padding:28px 28px 8px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">Hi ${name},</p>
      <p style="margin:0 0 6px 0;">We are now ready to accept payments for the ${escapeHtml(league)}. Please use the details below to make payments.</p>
    </td></tr>
    <tr><td style="padding:8px 28px 4px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:#eff6ff;border-left:5px solid #1d4ed8;border-radius:6px;padding:14px 16px;">
          <div style="font-size:13px;font-weight:bold;letter-spacing:0.5px;color:#1d4ed8;text-transform:uppercase;margin-bottom:6px;">Bank details</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row('Account name', bank.accountName)}
            ${row('Account number', bank.accountNumber)}
            ${row('Sort code', bank.sortCode)}
            ${row('Amount', amountText)}
            ${row('League', leagueShort)}
            ${row('Reference', 'Your Name')}
          </table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 28px 28px 28px;font-size:16px;line-height:1.55;">
      <p style="margin:0 0 14px 0;">Please use your name as reference.</p>
      <p style="margin:0;">Thank you</p>
    </td></tr>
    <tr><td style="background:#f3f4f6;padding:14px 28px;text-align:center;font-size:12px;color:#6b7280;">
      ${escapeHtml(league)}<br>Please do not reply to this email.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

function cleanBank(body) {
  const accountName = String(body.accountName || '').replace(/\s+/g, ' ').trim();
  const accountNumber = String(body.accountNumber || '').replace(/[\s-]/g, '');
  const sortDigits = String(body.sortCode || '').replace(/[\s-]/g, '');
  return { accountName, accountNumber, sortDigits };
}

// jobs[leagueId] = { total, sent, failed: [{ name, error }], running, startedAt, finishedAt }
const jobs = new Map();

export function registerLeaguePaymentEmailRoutes(app, deps) {
  const { requireAnyAdmin, assertLeagueAccess, asyncRoute, ApiError, readDb, writeDb, sendMail, canEmail, recordAudit } = deps;

  const findLeague = (db, req) => {
    const league = db.leagues.find((l) => l.id === req.params.id);
    if (!league) throw new ApiError(404, 'League not found');
    assertLeagueAccess(req, league);
    return league;
  };
  const recordFor = (db, leagueId) => (db.leaguePaymentEmails || []).find((r) => r.leagueId === leagueId) || null;
  const venueNameOf = (db, league) => {
    const v = league.venueId ? (db.venues || []).find((x) => x.id === league.venueId) : null;
    return v ? v.name : null;
  };
  const bankOf = (rec) => (rec && rec.accountName && rec.accountNumber && rec.sortCode
    ? { accountName: rec.accountName, accountNumber: rec.accountNumber, sortCode: rec.sortCode }
    : null);

  // Everyone with the red Unpaid chip on the League Interests page, split into
  // who can be emailed and who can't.
  function unpaidSplit(db, league) {
    const result = { unpaid: 0, toEmail: [], alreadyEmailed: 0, skipped: [] };
    if (!league.payment?.required) return result;
    const pending = db.leagueInterests.filter((r) => r.leagueId === league.id && r.status === 'pending');
    for (const r of pending) {
      const pay = db.leaguePayments.find((p) => p.leagueId === league.id && p.playerId === r.playerId);
      if (pay && ['confirmed', 'waived'].includes(pay.status)) continue;
      result.unpaid += 1;
      const player = db.players.find((p) => p.id === r.playerId);
      const playerName = player?.name || 'Unknown player';
      const user = db.users.find((u) => u.id === r.userId) || db.users.find((u) => u.playerId === r.playerId);
      if (!user || !canEmail(user) || isPlaceholderEmail(user.email)) {
        result.skipped.push(playerName);
        continue;
      }
      if (r.paymentEmailSentAt) { result.alreadyEmailed += 1; continue; }
      result.toEmail.push({
        interestId: r.id,
        userId: user.id,
        email: user.email,
        playerName,
        firstName: user.firstName || String(playerName).split(' ')[0],
      });
    }
    return result;
  }

  function status(db, league) {
    const rec = recordFor(db, league.id);
    const split = unpaidSplit(db, league);
    const job = jobs.get(league.id) || null;
    return {
      leagueName: league.name,
      payment: {
        required: !!league.payment?.required,
        amount: league.payment ? league.payment.amount : 0,
        currency: league.payment ? league.payment.currency : 'GBP',
      },
      bank: {
        accountName: rec?.accountName || '',
        accountNumber: rec?.accountNumber || '',
        sortCode: rec?.sortCode || '',
        saved: !!bankOf(rec),
      },
      testRecipient: TEST_RECIPIENT,
      testSentAt: rec?.testSentAt || null,
      canSendHere: sendingAllowedHere(),
      counts: {
        unpaid: split.unpaid,
        toEmail: split.toEmail.length,
        alreadyEmailed: split.alreadyEmailed,
        skipped: split.skipped.length,
      },
      skippedNames: split.skipped,
      job: job ? { running: job.running, total: job.total, sent: job.sent, failed: job.failed, finishedAt: job.finishedAt } : null,
    };
  }

  app.get('/api/leagues/:id/payment-email', requireAnyAdmin, asyncRoute((req, res) => {
    const db = readDb();
    res.json(status(db, findLeague(db, req)));
  }));

  app.put('/api/leagues/:id/payment-email', requireAnyAdmin, asyncRoute((req, res) => {
    const db = readDb();
    const league = findLeague(db, req);
    const { accountName, accountNumber, sortDigits } = cleanBank(req.body || {});
    if (!accountName || accountName.length > 80) throw new ApiError(400, 'Enter the account name (up to 80 characters)');
    if (!/^\d{6,12}$/.test(accountNumber)) throw new ApiError(400, 'The account number should be 6 to 12 digits');
    if (!/^\d{6}$/.test(sortDigits)) throw new ApiError(400, 'The sort code should be 6 digits, e.g. 60 18 46');
    const sortCode = `${sortDigits.slice(0, 2)} ${sortDigits.slice(2, 4)} ${sortDigits.slice(4, 6)}`;

    if (!Array.isArray(db.leaguePaymentEmails)) db.leaguePaymentEmails = [];
    let rec = recordFor(db, league.id);
    if (!rec) {
      rec = { leagueId: league.id };
      db.leaguePaymentEmails.push(rec);
    }
    const changed = rec.accountName !== accountName || rec.accountNumber !== accountNumber || rec.sortCode !== sortCode;
    rec.accountName = accountName;
    rec.accountNumber = accountNumber;
    rec.sortCode = sortCode;
    // Different details => test again before anything goes to players.
    if (changed) rec.testSentAt = null;
    recordAudit(db, {
      actor: req.adminSession.label,
      action: 'league.paymentEmailSettings',
      targetType: 'league',
      targetId: league.id,
      details: `Payment email bank details ${changed ? 'updated' : 'saved (unchanged)'} for "${league.name}"`,
    });
    writeDb(db);
    res.json(status(db, league));
  }));

  app.post('/api/leagues/:id/payment-email/test', requireAnyAdmin, asyncRoute((req, res) => {
    const db = readDb();
    const league = findLeague(db, req);
    const bank = bankOf(recordFor(db, league.id));
    if (!bank) throw new ApiError(400, 'Save the bank details first');
    if (!league.payment?.required || !(league.payment.amount > 0)) {
      throw new ApiError(400, "Turn on this league's payment wall with an amount first - the email quotes that amount");
    }
    const msg = leaguePaymentEmail({
      firstName: 'Sam',
      leagueName: league.name,
      venueName: venueNameOf(db, league),
      amount: league.payment.amount,
      currency: league.payment.currency,
      bank,
    });
    const leagueId = league.id;
    sendMail({ to: TEST_RECIPIENT, subject: `[TEST] ${msg.subject}`, text: msg.text, html: msg.html })
      .then((result) => {
        const sent = !!(result && result.sent);
        const db2 = readDb();
        const rec2 = recordFor(db2, leagueId);
        if (sent && rec2) {
          rec2.testSentAt = new Date().toISOString();
          writeDb(db2);
        }
        const league2 = db2.leagues.find((l) => l.id === leagueId) || league;
        res.json({ sent, error: result && result.error ? result.error : null, sentTo: TEST_RECIPIENT, status: status(readDb(), league2) });
      })
      .catch((err) => {
        res.status(500).json({ sent: false, error: (err && err.message) || 'send failed' });
      });
  }));

  app.post('/api/leagues/:id/payment-email/send', requireAnyAdmin, asyncRoute((req, res) => {
    const db = readDb();
    const league = findLeague(db, req);
    if (!req.body || req.body.confirm !== true) throw new ApiError(400, 'Confirmation required');
    if (!sendingAllowedHere()) throw new ApiError(400, 'Emails to players only go out from the live app. Use the test button here.');
    const rec = recordFor(db, league.id);
    const bank = bankOf(rec);
    if (!bank) throw new ApiError(400, 'Save the bank details first');
    if (!rec.testSentAt) throw new ApiError(400, 'Send the test email and check it first');
    if (!league.payment?.required || !(league.payment.amount > 0)) throw new ApiError(400, "This league's payment wall is not on");
    const existing = jobs.get(league.id);
    if (existing && existing.running) throw new ApiError(409, 'Emails are already being sent for this league');

    const targets = unpaidSplit(db, league).toEmail;
    if (targets.length === 0) throw new ApiError(400, 'Nobody to email: every unpaid player has already been emailed or has no usable email address');

    const job = { running: true, total: targets.length, sent: 0, failed: [], startedAt: new Date().toISOString(), finishedAt: null };
    jobs.set(league.id, job);
    const actor = req.adminSession.label;
    const venueName = venueNameOf(db, league);
    const { amount, currency } = league.payment;
    const leagueId = league.id;
    const leagueName = league.name;

    (async () => {
      try {
        for (const t of targets) {
          const msg = leaguePaymentEmail({ firstName: t.firstName, leagueName, venueName, amount, currency, bank });
          let result;
          try {
            result = await sendMail({ to: t.email, toName: t.playerName, subject: msg.subject, text: msg.text, html: msg.html });
          } catch (err) {
            result = { sent: false, error: err && err.message };
          }
          if (result && result.sent) {
            job.sent += 1;
            const db2 = readDb();
            const r2 = db2.leagueInterests.find((x) => x.id === t.interestId);
            if (r2) r2.paymentEmailSentAt = new Date().toISOString();
            try {
              recordAudit(db2, {
                actor,
                action: 'league.paymentEmailSent',
                targetType: 'user',
                targetId: t.userId,
                details: `Sent "${msg.subject}" to ${t.playerName} (unpaid, ${leagueName})`,
              });
            } catch (e) { /* audit is best-effort */ }
            writeDb(db2);
          } else {
            job.failed.push({ name: t.playerName, error: (result && result.error) || 'send failed' });
          }
        }
      } finally {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        console.log(`League payment emails (${leagueId}): ${job.sent} sent, ${job.failed.length} failed`);
      }
    })().catch((err) => console.warn('League payment email run error:', err && err.message));

    res.status(202).json({ started: true, total: targets.length });
  }));
}
