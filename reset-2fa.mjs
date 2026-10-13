// Emergency two-factor reset for when nobody can log in to the team panel (lost phone, no recovery codes).
// Needs access to the server, so only whoever runs IntelSquad can use it.
//   npm run reset-2fa                     list team accounts and whether two-factor is on
//   npm run reset-2fa -- you@example.com  turn two-factor off for that account (it can be set up again after login)
import { db, audit } from './src/db.js';
import { decrypt, hmac, normEmail } from './src/crypto.js';
import { resetTwoFactor } from './src/auth.js';

const email = process.argv[2];

if (!email) {
  const team = db.prepare("SELECT * FROM users WHERE role != 'user' AND deleted_at IS NULL ORDER BY role DESC, display_name").all();
  if (!team.length) console.log('No team accounts yet.');
  for (const u of team) console.log(`${u.mfa_enabled ? '2FA on ' : '2FA off'}  ${u.role.padEnd(12)} ${u.display_name.padEnd(20)} ${decrypt(u.email_enc) ?? '-'}`);
  console.log('\nTo reset one: npm run reset-2fa -- <email>');
  process.exit(0);
}

const user = db.prepare('SELECT * FROM users WHERE email_hmac = ? AND deleted_at IS NULL').get(hmac(normEmail(email), 'email'));
if (!user) {
  console.error(`No account with the email ${email}. Run "npm run reset-2fa" to list team accounts.`);
  process.exit(1);
}
if (!user.mfa_enabled) {
  console.log(`${user.display_name} already has two-factor turned off. Log in with the password.`);
  process.exit(0);
}
resetTwoFactor(user.id);
audit(null, 'user_mfa_reset_cli', { type: 'user', id: user.id, details: 'Reset from the server command line' });
console.log(`Two-factor login is now OFF for ${user.display_name} (${user.role}). All their devices were logged out.`);
console.log('Log in with the password; you will be asked to scan a new QR code with your authenticator app.');
