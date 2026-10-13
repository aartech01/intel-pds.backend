import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, db, newUser, makeStaff, totpCode, close, base } from './helpers.js';

after(close);

test('sign up stores personal data encrypted and the password as a bcrypt hash', async () => {
  const u = await newUser('Asha Rao');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes(u.email), 'email must not be stored readable');
  assert.ok(!raw.includes(u.phone.slice(3)), 'mobile must not be stored readable');
  assert.ok(!raw.includes('Asha Rao'), 'full name must not be stored readable');
  assert.match(row.password_hash, /^\$2[aby]\$/);
  const me = await u.client.get('/api/auth/me');
  assert.equal(me.data.user.email, u.email);
});

test('sign up accepts any password (no strength rules), still hashed; rejects empty and duplicates', async () => {
  const base = { full_name: 'Any Pass', accept_terms: true };
  const empty = await new Client().post('/api/auth/signup', { ...base, email: 'empty@mail.test', phone: '+919811111110', password: '', confirm_password: '' });
  assert.equal(empty.status, 400);
  assert.ok(empty.data.fields.password);
  const simple = await new Client().post('/api/auth/signup', { ...base, email: 'simple@mail.test', phone: '+919811111111', password: '1234', confirm_password: '1234' });
  assert.equal(simple.status, 201, JSON.stringify(simple.data));
  assert.match(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(simple.data.user.id).password_hash, /^\$2[aby]\$/);
  assert.equal((await new Client().post('/api/auth/login', { identifier: 'simple@mail.test', password: '1234' })).status, 200);
  const u = await newUser();
  const dup = await new Client().post('/api/auth/signup', { ...base, email: u.email.toUpperCase(), phone: '+919811111112', password: 'abc', confirm_password: 'abc' });
  assert.equal(dup.status, 409);
  assert.ok(dup.data.fields.email);
});

test('no email or SMS: a new account works at once, and the code endpoints are gone', async () => {
  const u = await newUser('Straight In');
  const form = new FormData();
  form.append('title', 'Draft right after sign up');
  form.append('action', 'draft');
  assert.equal((await u.client.req('POST', '/api/pds', undefined, { form })).status, 201, 'no verification step before a PDS');
  for (const url of ['/api/auth/verify', '/api/auth/resend', '/api/auth/forgot', '/api/auth/reset', '/api/auth/reset-otp', '/api/auth/mfa/email', '/api/auth/mfa/recover', '/api/me/contact/verify']) {
    assert.equal((await u.client.post(url, {})).status, 404, url);
  }
  for (const table of ['outbox', 'otp_codes', 'password_resets']) {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), undefined, `${table} dropped`);
  }
});

test('change email or mobile: the password confirms it, saved at once', async () => {
  const u = await newUser('Mover');
  assert.equal((await u.client.post('/api/me/contact', { channel: 'email', value: 'moved@mail.test', password: 'wrong-password' })).status, 400);
  const r = await u.client.post('/api/me/contact', { channel: 'email', value: 'moved@mail.test', password: u.password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.email, 'moved@mail.test');
  assert.equal((await new Client().post('/api/auth/login', { identifier: 'moved@mail.test', password: u.password })).status, 200);
  const other = await newUser('Taken');
  assert.equal((await other.client.post('/api/me/contact', { channel: 'email', value: 'moved@mail.test', password: other.password })).status, 409);
});

test('login with email or mobile; same error for unknown account; lock after 5 failures', async () => {
  const u = await newUser();
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { identifier: u.phone, password: u.password })).status, 200);
  assert.equal((await c.post('/api/auth/login', { identifier: u.email, password: u.password })).status, 200);

  const unknown = await new Client().post('/api/auth/login', { identifier: 'nobody@mail.test', password: 'Whatever-1' });
  const wrong = await new Client().post('/api/auth/login', { identifier: u.email, password: 'Wrong-pass-1' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error, wrong.data.error);

  for (let i = 0; i < 3; i++) await new Client().post('/api/auth/login', { identifier: u.email, password: 'Wrong-pass-1' });
  const locked = await new Client().post('/api/auth/login', { identifier: u.email, password: 'Wrong-pass-1' });
  assert.equal(locked.status, 429);
  const evenRight = await new Client().post('/api/auth/login', { identifier: u.email, password: u.password });
  assert.equal(evenRight.status, 429, 'locked for 15 minutes even with the right password');
});

test('mobile numbers are read the same however they are typed', async () => {
  const { normPhone } = await import('../src/crypto.js');
  for (const typed of ['+91 98765 43210', '+91-98765-43210', '9876543210', '09876543210', '919876543210', '+91 09876543210', '0091 98765 43210']) {
    assert.equal(normPhone(typed), '+919876543210', typed);
  }
  assert.equal(normPhone('+44 7700 900123'), '+447700900123');
  const u = await newUser();
  const local = u.phone.replace('+91', '0');
  assert.equal((await new Client().post('/api/auth/login', { identifier: local, password: u.password })).status, 200, 'login with a leading 0');
});

test('CSRF token is required on writes', async () => {
  const c = new Client();
  await c.get('/api/config');
  const post = (headers) => fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: c.cookieHeader(), 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post({})).status, 403, 'no header');
  assert.equal((await post({ 'x-csrf-token': 'forged' })).status, 403, 'wrong header');
  assert.equal((await post({ 'x-csrf-token': c.jar.get('sd_csrf') })).status, 200, 'matching header');
});

test('logout revokes the session on the server; password change logs out other devices', async () => {
  const u = await newUser();
  const other = new Client();
  await other.post('/api/auth/login', { identifier: u.email, password: u.password });
  assert.ok((await other.get('/api/auth/me')).data.user);

  const stolen = new Map(u.client.jar);
  const ch = await u.client.post('/api/me/password', { current: u.password, next: 'Brand-new-pass-7' });
  assert.equal(ch.status, 200);
  assert.equal((await other.get('/api/board')).status, 401, 'other device logged out');
  assert.equal((await u.client.get('/api/board')).status, 200, 'this device stays logged in');

  await u.client.post('/api/auth/logout');
  const replay = new Client();
  replay.jar = stolen;
  assert.equal((await replay.get('/api/board')).status, 401, 'old cookies stop working after logout');
});

test('forgotten password: an admin gives a temporary password, which must be changed at once', async () => {
  const u = await newUser('Forgetful');
  const admin = await newUser('Helper Admin');
  await makeStaff(admin, 'admin');
  const other = await newUser('Other Admin');
  await makeStaff(other, 'admin');

  assert.equal((await u.client.post(`/api/admin/users/${u.id}/temp-password`)).status, 403, 'users cannot');
  assert.equal((await admin.client.post(`/api/admin/users/${admin.id}/temp-password`)).status, 400, 'not your own');
  assert.equal((await admin.client.post(`/api/admin/users/${other.id}/temp-password`)).status, 403, 'only a Super Admin resets an admin');

  const r = await admin.client.post(`/api/admin/users/${u.id}/temp-password`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.password, /^Temp-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await u.client.get('/api/board')).status, 401, 'old sessions logged out');
  assert.equal((await new Client().post('/api/auth/login', { identifier: u.email, password: u.password })).status, 401, 'old password stops working');

  const c = new Client();
  const login = await c.post('/api/auth/login', { identifier: u.email, password: r.data.password });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.must_change_password, true);
  const blocked = await c.get('/api/board');
  assert.equal(blocked.status, 403, 'nothing else works until the password is changed');
  assert.equal(blocked.data.code, 'password_change_required');
  assert.equal((await c.post('/api/me/password', { current: r.data.password, next: 'Brand-new-pass-7' })).status, 200);
  assert.equal((await c.get('/api/board')).status, 200);
  assert.equal((await c.get('/api/auth/me')).data.user.must_change_password, false);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'user_temp_password' AND target_id = ?").get(String(u.id)));
});

test('server command gives a temporary password when nobody can help', async () => {
  const boss = await newUser('Only Boss');
  await makeStaff(boss, 'super_admin');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../reset-password.mjs');
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, boss.email], { env: process.env, encoding: 'utf8' });
  const temp = out.match(/Temp-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
  assert.ok(temp, out);
  const login = await new Client().post('/api/auth/team-login', { identifier: boss.email, password: temp });
  assert.equal(login.status, 200);
});

test('team accounts must use two-factor authentication', async () => {
  const u = await newUser('Admin Person');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
  const blocked = await u.client.get('/api/admin/overview');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'mfa_setup_required');

  const secret = await makeStaff(u, 'admin');
  assert.equal((await u.client.get('/api/admin/overview')).status, 200);

  const c = new Client();
  const step1 = await c.post('/api/auth/team-login', { identifier: u.email, password: u.password });
  assert.equal(step1.data.mfa_required, true);
  assert.equal((await c.get('/api/admin/overview')).status, 401, 'no session before the second step');
  const bad = await c.post('/api/auth/mfa', { mfa_token: step1.data.mfa_token, code: '000000' });
  assert.equal(bad.status, 401);
  const step2 = await c.post('/api/auth/mfa', { mfa_token: step1.data.mfa_token, code: totpCode(secret, Math.floor(Date.now() / 30000) + 1) });
  assert.equal(step2.status, 200, JSON.stringify(step2.data));
  assert.equal((await c.get('/api/admin/overview')).status, 200);
});

test('two login doors: team accounts only at the team login, users only at the user login', async () => {
  const user = await newUser('Door User');
  const admin = await newUser('Door Admin');
  await makeStaff(admin, 'admin');
  const member = await newUser('Door Member');
  await makeStaff(member, 'team_member');
  const wrongPassword = await new Client().post('/api/auth/login', { identifier: user.email, password: 'not-the-password' });

  for (const staff of [admin, member]) {
    const c = new Client();
    const r = await c.post('/api/auth/login', { identifier: staff.email, password: staff.password });
    assert.equal(r.status, wrongPassword.status, 'same status as a wrong password');
    assert.equal(r.data.error, wrongPassword.data.error, 'same message as a wrong password');
    assert.equal(r.data.mfa_required, undefined);
    assert.equal((await c.get('/api/auth/me')).data.user, null, 'no session');
    assert.equal((await new Client().post('/api/auth/team-login', { identifier: staff.email, password: staff.password })).data.mfa_required, true, 'the team door works');
  }
  const viaTeam = await new Client().post('/api/auth/team-login', { identifier: user.email, password: user.password });
  assert.equal(viaTeam.status, wrongPassword.status);
  assert.equal(viaTeam.data.error, wrongPassword.data.error);
  assert.equal((await new Client().post('/api/auth/login', { identifier: user.email, password: user.password })).status, 200, 'the user door works');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'login_wrong_portal' AND target_id = ?").get(String(admin.id)), 'recorded');
});

test('a normal user cannot reach admin routes', async () => {
  const u = await newUser();
  assert.equal((await u.client.get('/api/admin/pds')).status, 403);
  assert.equal((await new Client().get('/api/admin/pds')).status, 401);
});

test('delete account removes personal data and keeps public content as "Deleted user"', async () => {
  const u = await newUser();
  const { createPds } = await import('./helpers.js');
  const code = await createPds(u.client);
  const viewer = await newUser();
  await viewer.client.post(`/api/pds/${code}/comments`, { text: 'Nice one' });
  const r = await u.client.del('/api/me', { password: u.password });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  assert.equal(row.email_enc, null);
  assert.equal(row.phone_hmac, null);
  assert.equal(row.display_name, 'Deleted user');
  const seen = await viewer.client.get('/api/board');
  const card = seen.data.rows.find((x) => x.code === code);
  assert.ok(!card, 'open PDS of a deleted account is withdrawn from the board');
});
