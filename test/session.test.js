import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { Client, db, newUser, makeStaff, totpCode, close } from './helpers.js';
import { JWT_SECRET } from '../src/config.js';

after(close);

/** A second "tab": same browser cookies, its own request flow. */
const sameBrowser = (c) => {
  const t = new Client();
  t.jar = new Map(c.jar);
  return t;
};

/** Pretend the 15-minute access token ran out (the refresh cookie is still there). */
function expireAccess(c) {
  const { sid, sub } = jwt.decode(c.jar.get('sd_at'));
  c.jar.set('sd_at', jwt.sign({ sid, sub }, JWT_SECRET, { expiresIn: -10 }));
}

test('page reload after the access token expired: racing refreshes keep you logged in', async () => {
  const u = await newUser('Race Reload');
  await u.client.post('/api/auth/logout');
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { identifier: u.email, password: u.password, remember: true })).status, 200);
  expireAccess(c);

  // What a reload sends at the same moment: /auth/me (refreshes on the server) and a page request that hits
  // token_expired and calls /auth/refresh - both with the same refresh cookie.
  const tabA = sameBrowser(c);
  const tabB = sameBrowser(c);
  const [me, page] = await Promise.all([tabA.get('/api/auth/me'), tabB.get('/api/dashboard')]);
  assert.equal(me.data.user?.id, u.id, 'reload shows the user as logged in');
  assert.equal(page.status, 401);
  assert.equal(page.data.code, 'token_expired');
  const late = await tabB.post('/api/auth/refresh');
  assert.equal(late.status, 200, `late refresh with the just-replaced token must not log out: ${JSON.stringify(late.data)}`);
  assert.ok(!late.headers.getSetCookie().some((x) => /^sd_rt=;|sd_rt=.*Expires=Thu, 01 Jan 1970/i.test(x)), 'the new refresh cookie is not cleared');
  assert.equal((await tabB.get('/api/dashboard')).status, 200, 'the late tab works with its new access token');

  // The winner's cookies keep working afterwards, including the next rotation.
  expireAccess(tabA);
  assert.equal((await tabA.get('/api/auth/me')).data.user?.id, u.id);
  assert.equal((await tabA.get('/api/dashboard')).status, 200);
});

test('two tabs refreshing at once both stay logged in', async () => {
  const u = await newUser('Two Tabs');
  const t1 = sameBrowser(u.client);
  const t2 = sameBrowser(u.client);
  const [a, b] = await Promise.all([t1.post('/api/auth/refresh'), t2.post('/api/auth/refresh')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal((await t1.get('/api/dashboard')).status, 200);
  assert.equal((await t2.get('/api/dashboard')).status, 200);
});

test('the replaced refresh token only works briefly, and never after logout', async () => {
  const u = await newUser('Grace Limit');
  const old = sameBrowser(u.client);
  assert.equal((await u.client.post('/api/auth/refresh')).status, 200);

  db.prepare("UPDATE sessions SET rotated_at = datetime('now', '-2 minutes') WHERE user_id = ?").run(u.id);
  const stale = await old.post('/api/auth/refresh');
  assert.equal(stale.status, 401, 'an old refresh token outside the grace window is refused');

  const again = sameBrowser(u.client);
  assert.equal((await u.client.post('/api/auth/refresh')).status, 200);
  assert.equal((await u.client.post('/api/auth/logout')).status, 200);
  assert.equal((await again.post('/api/auth/refresh')).status, 401, 'logout also ends the grace token');
});

test('/auth/me after a refresh reports two-factor for this session, not another device', async () => {
  const admin = await newUser('MFA Session');
  const secret = await makeStaff(admin, 'admin');
  const ok = await new Client().post('/api/auth/team-login', { identifier: admin.email, password: admin.password });
  const c = new Client();
  const step = Math.floor(Date.now() / 30000) + 1;
  const done = await c.post('/api/auth/mfa', { mfa_token: ok.data.mfa_token, code: totpCode(secret, step) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  // Another device of the same admin that has not passed two-factor, used more recently than this one.
  db.prepare("INSERT INTO sessions (user_id, refresh_token_hash, mfa_passed, expires_at, last_used_at) VALUES (?, 'other-device', 0, datetime('now', '+1 day'), datetime('now', '+1 minute'))").run(admin.id);
  expireAccess(c);
  const me = await c.get('/api/auth/me');
  assert.equal(me.data.mfa_passed, true, 'uses the refreshed session, not the most recently used one');
});
