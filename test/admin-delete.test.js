import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, newUser, createPds, makeStaff, close } from './helpers.js';
import { ensureSeed } from '../src/seed.js';

after(close);

test('admin deletes a PDS: row, comments and upvotes gone, owner notified, audited', async () => {
  const owner = await newUser('Owner Del');
  const fan = await newUser('Fan Del');
  const code = await createPds(owner.client);
  await fan.client.post(`/api/pds/${code}/upvote`);
  await fan.client.post(`/api/pds/${code}/comments`, { text: 'Same problem here', comment_type: 'point' });
  const id = db.prepare('SELECT id FROM pds WHERE pds_code = ?').get(code).id;

  assert.equal((await fan.client.req('DELETE', `/api/admin/pds/${code}`)).status, 403, 'normal users cannot delete');

  const admin = await newUser('Admin Del');
  await makeStaff(admin, 'admin');
  assert.equal((await admin.client.req('DELETE', `/api/admin/pds/${code}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pds WHERE id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE pds_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upvotes WHERE pds_id = ?').get(id).n, 0);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND message LIKE '%removed by the team%'").get(owner.id), 'owner notified');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'pds_delete'").get(), 'audited');
  assert.equal((await admin.client.req('DELETE', `/api/admin/pds/${code}`)).status, 404);
});

test('admin deletes a user: personal data removed, cannot log in, admins protected', async () => {
  const victim = await newUser('Victim Del');
  const admin = await newUser('Admin Two Del');
  await makeStaff(admin, 'admin');

  assert.equal((await admin.client.req('DELETE', `/api/admin/users/${admin.id}`)).status, 400, 'not yourself');

  const other = await newUser('Other Admin Del');
  await makeStaff(other, 'admin');
  assert.equal((await admin.client.req('DELETE', `/api/admin/users/${other.id}`)).status, 403, 'admin cannot delete an admin');

  assert.equal((await admin.client.req('DELETE', `/api/admin/users/${victim.id}`)).status, 200);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(victim.id);
  assert.ok(row.deleted_at);
  assert.equal(row.email_enc, null);
  assert.equal(row.display_name, 'Deleted user');
  const login = await victim.client.post('/api/auth/login', { identifier: victim.email, password: victim.password });
  assert.equal(login.status, 401);
});

test('admins cannot share a problem; team members and users still can', async () => {
  const admin = await newUser('Admin Share');
  await makeStaff(admin, 'admin');
  await assert.rejects(createPds(admin.client), /403/);
  const superAdmin = await newUser('Super Share');
  await makeStaff(superAdmin, 'super_admin');
  await assert.rejects(createPds(superAdmin.client), /403/);
  const member = await newUser('Member Share');
  await makeStaff(member, 'team_member');
  assert.match(await createPds(member.client), /^PDS-/);
  const user = await newUser('User Share');
  assert.match(await createPds(user.client), /^PDS-/);
});

test('the server still starts after every PDS has been deleted (no demo re-seed crash)', async () => {
  const u = await newUser('Last One');
  await createPds(u.client);
  db.exec('DELETE FROM pds');
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  await ensureSeed(); // used to try to re-create the demo users and crash on their phone numbers
  await ensureSeed();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pds').get().n, 0, 'no demo PDS re-added');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n <= users + 1, 'at most the first Super Admin is added');
});
