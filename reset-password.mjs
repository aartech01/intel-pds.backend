// Forgotten password with nobody to reset it (e.g. the only Super Admin). There is no email or SMS, so this
// prints a temporary password; the person must choose a new one right after logging in.
// Needs access to the server, so only whoever runs IntelSquad can use it.
//   npm run reset-password -- you@example.com
import bcrypt from 'bcryptjs';
import { db, audit } from './src/db.js';
import { BCRYPT_COST } from './src/config.js';
import { hmac, normEmail, temporaryPassword } from './src/crypto.js';
import { revokeAllSessions } from './src/auth.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run reset-password -- <email>');
  process.exit(1);
}
const user = db.prepare('SELECT * FROM users WHERE email_hmac = ? AND deleted_at IS NULL').get(hmac(normEmail(email), 'email'));
if (!user) {
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
const password = temporaryPassword();
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(await bcrypt.hash(password, BCRYPT_COST), user.id);
revokeAllSessions(user.id);
audit(null, 'user_temp_password_cli', { type: 'user', id: user.id, details: 'Temporary password from the server command line' });
console.log(`Temporary password for ${user.display_name} (${user.role}):\n\n    ${password}\n`);
console.log('Log in with it; you will be asked to choose a new password straight away. All devices were logged out.');
