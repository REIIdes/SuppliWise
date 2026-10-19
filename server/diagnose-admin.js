// Read-only diagnostic: compare the admin credentials in server/.env
// against the AdminAccount documents actually stored in MongoDB.
// Prints NO secret values — only match/mismatch and code equality.
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const mongoose = require('mongoose');
const totpRfc = require('./utils/totpRfc');
const adminAccounts = require('./utils/adminAccounts');
const adminTotp = require('./utils/adminTotp');

(async () => {
  const accounts = adminAccounts.configuredAdminAccounts();
  console.log(`Configured in .env: ${accounts.length} admin account(s)\n`);

  let db;
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    db = mongoose.connection;
    console.log('Connected to MongoDB.\n');
  } catch (err) {
    console.log('Could not reach MongoDB:', err.message);
    process.exit(0);
  }

  const AdminAccount = require('./models/AdminAccount');
  const now = Date.now();

  for (const cfg of accounts) {
    const rec = await AdminAccount.findOne({ alias: cfg.alias })
      .select(`alias enabled passwordHash mustChangePassword lastLoginAt ${adminTotp.SECRET_FIELDS}`);
    if (!rec) {
      console.log(`[${cfg.alias}] NOT IN DATABASE (seeder will insert from .env on next boot)`);
      continue;
    }
    // `readSeed` unseals `totpSecretEnc` and falls back to the legacy plaintext
    // field, so this compares SEEDS, not storage formats. Reading
    // `rec.totpSecret` directly would report MISMATCH for every account that has
    // signed in since the seeds were encrypted — a diagnostic that cries wolf is
    // a diagnostic nobody runs.
    const dbSeed = adminTotp.readSeed(rec);
    const secretMatch = String(dbSeed || '') === String(cfg.totpSecret);
    const hashMatch = String(rec.passwordHash || '') === String(cfg.passwordHash);
    const codeEnv = totpRfc.totp({ secret: cfg.totpSecret, encoding: 'base32' });
    const codeDb = dbSeed ? totpRfc.totp({ secret: String(dbSeed), encoding: 'base32' }) : '(none)';
    console.log(`[${cfg.alias}]`);
    console.log(`   enabled=${rec.enabled} mustChangePassword=${!!rec.mustChangePassword} lastLoginAt=${rec.lastLoginAt || 'never'}`);
    console.log(`   seed stored: ${adminTotp.storageState(rec).sealed ? 'sealed envelope (totpSecretEnc)' : (dbSeed ? '*** PLAINTEXT (legacy field) ***' : 'NONE')}`);
    console.log(`   totpSecret: .env vs DB -> ${secretMatch ? 'MATCH' : '*** MISMATCH ***'}`);
    console.log(`   passwordHash: .env vs DB -> ${hashMatch ? 'MATCH' : '*** MISMATCH (DB hash wins at login) ***'}`);
    console.log(`   code from .env seed now: ${codeEnv}   code from DB seed now: ${codeDb}`);
    console.log(`   -> If your authenticator app shows neither, the app is seeded with a THIRD (old) secret.`);
    console.log('');
  }

  // Any admin docs in the DB that .env no longer lists?
  const all = await AdminAccount.find().select('alias enabled');
  const configured = new Set(accounts.map(a => a.alias));
  const orphans = all.filter(a => !configured.has(a.alias));
  if (orphans.length) {
    console.log('Admin docs in DB NOT listed in .env:', orphans.map(o => `${o.alias}(enabled=${o.enabled})`).join(', '));
  }

  await db.dropDatabase ? null : null; // no-op, read-only intent
  await mongoose.disconnect();
})();
