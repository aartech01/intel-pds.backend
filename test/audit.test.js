import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, newUser, makeStaff, close } from './helpers.js';

after(close);

test('audit log is paginated, filterable and admin-only', async () => {
  const admin = await newUser('Audit Admin');
  await makeStaff(admin, 'admin');
  const insert = db.prepare("INSERT INTO audit_logs (actor_id, action, details) VALUES (?, ?, 'paging test')");
  for (let i = 0; i < 60; i++) insert.run(admin.id, i % 2 ? 'paging_odd' : 'paging_even');
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;

  const p1 = await admin.client.get('/api/admin/audit?pageSize=25');
  assert.equal(p1.status, 200);
  assert.equal(p1.data.total, total);
  assert.equal(p1.data.pageSize, 25);
  assert.equal(p1.data.pages, Math.ceil(total / 25));
  assert.equal(p1.data.rows.length, 25);
  const p2 = await admin.client.get('/api/admin/audit?pageSize=25&page=2');
  assert.ok(p1.data.rows.at(-1).id > p2.data.rows[0].id, 'page 2 continues after page 1, newest first');

  const lastPage = await admin.client.get('/api/admin/audit?pageSize=25&page=999');
  assert.equal(lastPage.data.page, p1.data.pages, 'a page past the end shows the last page');
  assert.equal(lastPage.data.rows.length, total - (p1.data.pages - 1) * 25);

  assert.equal((await admin.client.get('/api/admin/audit?pageSize=7')).data.pageSize, 50, 'unknown page sizes fall back to 50');

  const odd = await admin.client.get('/api/admin/audit?action=paging_odd&pageSize=100');
  assert.equal(odd.data.total, 30);
  assert.ok(odd.data.rows.every((r) => r.action === 'paging_odd'));
  assert.equal((await admin.client.get('/api/admin/audit?action=%25')).data.total, 0, 'a % in the filter is matched literally');
  const name = db.prepare('SELECT display_name FROM users WHERE id = ?').get(admin.id).display_name;
  assert.equal((await admin.client.get(`/api/admin/audit?actor=${encodeURIComponent(name)}&action=paging`)).data.total, 60);

  const user = await newUser('Audit Peeker');
  assert.equal((await user.client.get('/api/admin/audit')).status, 403);
});
