import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, newUser, makeStaff, totpCode, Client, close } from './helpers.js';

after(close);

/** Log in up to the two-factor step and return its token. */
async function passwordStep(u) {
  const c = new Client();
  const r = await c.post('/api/auth/team-login', { identifier: u.email, password: u.password });
  assert.equal(r.data.mfa_required, true, JSON.stringify(r.data));
  return { c, token: r.data.mfa_token };
}

test('a Super Admin can turn the team two-factor rule off; admins can then turn off their own', async () => {
  const boss = await newUser('Rule Boss');
  await makeStaff(boss, 'super_admin');
  const admin = await newUser('Rule Admin');
  await makeStaff(admin, 'admin');

  assert.equal((await admin.client.put('/api/admin/settings', { require_team_2fa: false })).status, 403, 'only a Super Admin');
  assert.equal((await admin.client.post('/api/me/mfa/disable', { password: admin.password })).status, 400, 'blocked while required');

  const set = await boss.client.put('/api/admin/settings', { require_team_2fa: false });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal((await new Client().get('/api/config')).data.team_2fa_required, false);

  const off = await admin.client.post('/api/me/mfa/disable', { password: admin.password });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  // Fresh login: no two-factor step, and the panel opens.
  const c = new Client();
  const login = await c.post('/api/auth/team-login', { identifier: admin.email, password: admin.password });
  assert.equal(login.data.mfa_required, undefined);
  assert.equal((await c.get('/api/admin/overview')).status, 200);

  await boss.client.put('/api/admin/settings', { require_team_2fa: true });
  assert.equal((await c.get('/api/admin/overview')).data.code, 'mfa_setup_required', 'rule back on');
});

test('new recovery codes replace the old ones', async () => {
  const admin = await newUser('Codes Admin');
  await makeStaff(admin, 'admin');
  assert.equal((await admin.client.post('/api/me/mfa/recovery-codes', { password: 'wrong-password' })).status, 400);
  const r = await admin.client.post('/api/me/mfa/recovery-codes', { password: admin.password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.recovery_codes.length, 8);

  const { c, token } = await passwordStep(admin);
  const ok = await c.post('/api/auth/mfa', { mfa_token: token, code: r.data.recovery_codes[0] });
  assert.equal(ok.status, 200, 'a new code logs in');
});

test('server command lists team accounts and resets one', async () => {
  const admin = await newUser('Cli Admin');
  await makeStaff(admin, 'admin');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../reset-2fa.mjs');
  const run = (...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: process.env, encoding: 'utf8' });

  assert.match(run(), new RegExp(`2FA on .*${admin.email.replace(/[.+]/g, '\\$&')}`));
  assert.match(run(admin.email), /now OFF/);
  assert.equal(db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(admin.id).mfa_enabled, 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'user_mfa_reset_cli' AND target_id = ?").get(String(admin.id)));
});

test('connect a new phone: scan a new QR code, the old app stops working', async () => {
  const admin = await newUser('New Phone');
  const oldSecret = await makeStaff(admin, 'admin');
  const step = Math.floor(Date.now() / 30000);

  assert.equal((await admin.client.post('/api/me/mfa/new-phone', { password: 'wrong-password' })).status, 400);
  const start = await admin.client.post('/api/me/mfa/new-phone', { password: admin.password });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.match(start.data.qr, /^data:image\/png;base64,/);
  assert.notEqual(start.data.secret, oldSecret);

  const wrong = await admin.client.post('/api/me/mfa/new-phone/confirm', { token: start.data.token, code: totpCode(oldSecret, step) });
  assert.equal(wrong.status, 400, 'a code from the old app does not confirm the new one');
  const ok = await admin.client.post('/api/me/mfa/new-phone/confirm', { token: start.data.token, code: totpCode(start.data.secret, step) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  // Next login: the old app is refused, the new one works (next 30-second window, so it is not a replay).
  const { c, token } = await passwordStep(admin);
  assert.equal((await c.post('/api/auth/mfa', { mfa_token: token, code: totpCode(oldSecret, step + 1) })).status, 401);
  assert.equal((await c.post('/api/auth/mfa', { mfa_token: token, code: totpCode(start.data.secret, step + 1) })).status, 200);
});

test('a Super Admin without two-factor can still turn the team rule off (never stuck)', async () => {
  const boss = await newUser('Stuck Boss');
  await makeStaff(boss, 'super_admin');
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL WHERE id = ?').run(boss.id); // lost the phone
  const admin = await newUser('Plain Admin');
  await makeStaff(admin, 'admin');

  assert.equal((await boss.client.get('/api/admin/overview')).data.code, 'mfa_setup_required');
  assert.equal((await admin.client.post('/api/me/team-2fa-rule', { required: false, password: admin.password })).status, 403, 'only a Super Admin');
  assert.equal((await boss.client.post('/api/me/team-2fa-rule', { required: false, password: 'wrong-password' })).status, 400);
  const off = await boss.client.post('/api/me/team-2fa-rule', { required: false, password: boss.password });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.team_2fa_required, false);
  assert.equal((await boss.client.get('/api/admin/overview')).status, 200, 'panel opens with just the password');

  assert.equal((await boss.client.post('/api/me/team-2fa-rule', { required: true, password: boss.password })).data.team_2fa_required, true);
});
