  });
}

// ---------- Error handling ----------

app.use((err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ---------- Bootstrap accounts ----------
// Ensures two known accounts exist every time the server boots (a fresh
// deploy, a restart, a new environment) - idempotent, so once both exist
// this is just a couple of cheap reads on every subsequent boot. A temp
// password is only ever set at creation time - if an account already
// exists, whatever password is on it (including one the owner has since
// changed via the normal change-password flow) is left untouched, so a
// redeploy can never silently reset a real password back to the default.
//
// admin@cuesense.co.uk is the one account guaranteed to always be an
// admin - the break-glass login if every other admin account is ever
// suspended or demoted by mistake. This is enforced every boot (granted
// back if it's ever found not-admin), the same way the old bootstrap
// account used to be.
//
// matt.bailey1985@gmail.com is a normal default player account and is
// explicitly NOT an admin - enforced the other way every boot, so it can
// never end up admin again by accident (an old backup, a manual mistake).
// It's still guaranteed to exist, just as a player only.
function ensureBootstrapAccounts() {
  const db = readDb();
  let changed = false;

  const adminEmail = 'admin@cuesense.co.uk';
  const normalizedAdminEmail = adminEmail.toLowerCase();
  let admin = db.users.find((u) => u.email.toLowerCase() === normalizedAdminEmail);
  if (admin) {
    if (!admin.isAdmin) {
      admin.isAdmin = true;
      changed = true;
      console.log(`Bootstrap: granted admin to existing account ${adminEmail}`);
    }
  } else {
    admin = createUserAccount(db, {
      firstName: 'Admin',
      lastName: 'Cue Sense',
      email: adminEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: true,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created admin account ${adminEmail}`);
  }

  const playerEmail = 'matt.bailey1985@gmail.com';
  const normalizedPlayerEmail = playerEmail.toLowerCase();
  let player = db.users.find((u) => u.email.toLowerCase() === normalizedPlayerEmail);
  if (player) {
    if (player.isAdmin) {
      player.isAdmin = false;
      changed = true;
      console.log(`Bootstrap: removed admin from ${playerEmail} - player only now`);
    }
  } else {
    player = createUserAccount(db, {
      firstName: 'Matt',
      lastName: 'Bailey',
      email: playerEmail,
      passwordHash: hashPassword('CueSense12!@'),
      phone: '',
      teamName: '',
      classification: null,
      isAdmin: false,
      isCaptain: false,
    });
    changed = true;
    console.log(`Bootstrap: created player account ${playerEmail}`);
  }

  if (changed) writeDb(db);
}
ensureBootstrapAccounts();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Cue Sense API listening on http://localhost:${PORT}`);
});
