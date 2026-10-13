import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, db, newUser, createPds, makeStaff, close, base } from './helpers.js';

after(close);

test('PDS form: required fields, limits, draft then submit', async () => {
  const u = await newUser();
  const empty = new FormData();
  empty.append('title', 'Only a title');
  const bad = await u.client.req('POST', '/api/pds', undefined, { form: empty });
  assert.equal(bad.status, 400, 'submit needs the required fields');

  const long = new FormData();
  for (const [k, v] of Object.entries({ title: 'x'.repeat(101), type: 'idea', problem_statement: 'p', urgency: 'Low' })) long.append(k, v);
  assert.equal((await u.client.req('POST', '/api/pds', undefined, { form: long })).status, 400, 'title over 100 chars');

  const draft = new FormData();
  draft.append('title', 'Half-written idea');
  draft.append('action', 'draft');
  const d = await u.client.req('POST', '/api/pds', undefined, { form: draft });
  assert.equal(d.status, 201);
  assert.equal(d.data.status, 'draft');
  assert.equal((await u.client.post(`/api/pds/${d.data.code}/submit`)).status, 400, 'cannot submit until required fields are filled');
  await u.client.patch(`/api/pds/${d.data.code}`, { type: 'idea', problem_statement: 'People cannot find tutors.', urgency: 'Low' });
  const s = await u.client.post(`/api/pds/${d.data.code}/submit`);
  assert.equal(s.status, 200);
  assert.match(s.data.code, /^PDS-\d{4}-\d{4}$/);
});

test('private PDS are never visible to other users, even by changing the link', async () => {
  const owner = await newUser();
  const other = await newUser();
  const code = await createPds(owner.client, { visibility: 'private', title: 'Secret payroll fix' });
  assert.equal((await owner.client.get(`/api/pds/${code}`)).status, 200);
  assert.equal((await other.client.get(`/api/pds/${code}`)).status, 404);
  assert.equal((await other.client.post(`/api/pds/${code}/comments`, { text: 'hi' })).status, 404);
  assert.equal((await other.client.post(`/api/pds/${code}/upvote`)).status, 404);
  const board = await other.client.get('/api/board?q=payroll');
  assert.equal(board.data.rows.length, 0);
  const dash = await other.client.get('/api/dashboard');
  assert.ok(!JSON.stringify(dash.data).includes('Secret payroll'));

  // Switching to public (PF-05) makes it visible.
  await owner.client.patch(`/api/pds/${code}`, { visibility: 'public' });
  assert.equal((await other.client.get(`/api/pds/${code}`)).status, 200);
});

test('contact details are never shown to other users (CD-05)', async () => {
  const owner = await newUser();
  const other = await newUser();
  const code = await createPds(owner.client);
  await owner.client.post(`/api/pds/${code}/comments`, { text: 'More details: it is an Excel file' });
  const seen = JSON.stringify((await other.client.get(`/api/pds/${code}`)).data) + JSON.stringify((await other.client.get('/api/board')).data);
  assert.ok(!seen.includes(owner.email));
  assert.ok(!seen.includes(owner.phone));
});

test('owner can edit until review starts, then only add comments', async () => {
  const owner = await newUser();
  const admin = await newUser('Admin One');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client);
  assert.equal((await owner.client.patch(`/api/pds/${code}`, { title: 'Better title' })).status, 200);
  assert.equal((await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'under_review' })).status, 200);
  assert.equal((await owner.client.patch(`/api/pds/${code}`, { title: 'Too late' })).status, 400);
  assert.equal((await owner.client.patch(`/api/pds/${code}`, { visibility: 'private' })).status, 200, 'visibility can change any time');
});

test('maximum 3 open PDS per user', async () => {
  const u = await newUser();
  for (let i = 0; i < 3; i++) await createPds(u.client, { title: `Open PDS ${i}` });
  await assert.rejects(createPds(u.client, { title: 'Fourth' }), /open_limit|up to 3 open/);
});

test('upvote once per user; not on your own PDS', async () => {
  const owner = await newUser();
  const fan = await newUser();
  const code = await createPds(owner.client);
  assert.equal((await owner.client.post(`/api/pds/${code}/upvote`)).status, 400);
  await fan.client.post(`/api/pds/${code}/upvote`);
  const twice = await fan.client.post(`/api/pds/${code}/upvote`);
  assert.equal(twice.data.upvotes, 1);
  const off = await fan.client.del(`/api/pds/${code}/upvote`);
  assert.equal(off.data.upvotes, 0);
});

test('comments: types, one reply level, edit marker, delete, team badge, plain text', async () => {
  const owner = await newUser();
  const a = await newUser();
  const team = await newUser('Team Mate');
  await makeStaff(team, 'team_member');
  const code = await createPds(owner.client);

  let r = await a.client.post(`/api/pds/${code}/comments`, { text: '<script>alert(1)</script> use a form', type: 'idea' });
  assert.equal(r.status, 201);
  const top = r.data[0];
  assert.equal(top.type, 'idea');
  assert.equal(top.text, '<script>alert(1)</script> use a form', 'stored and returned as plain text, never rendered as HTML');

  r = await team.client.post(`/api/pds/${code}/comments`, { text: 'Good idea', parent_id: top.id });
  const reply = r.data[0].replies[0];
  assert.equal(reply.is_team, true);
  r = await owner.client.post(`/api/pds/${code}/comments`, { text: 'Reply to a reply', parent_id: reply.id });
  assert.equal(r.data[0].replies.length, 2, 'reply-to-reply is attached to the top comment (one level)');

  r = await a.client.patch(`/api/comments/${top.id}`, { text: 'Use a Google form instead' });
  assert.equal(r.data[0].edited, true);
  assert.equal((await owner.client.patch(`/api/comments/${top.id}`, { text: 'hijack' })).status, 403);

  r = await owner.client.post(`/api/comments/${top.id}/useful`);
  assert.equal(r.data[0].is_useful, true);

  r = await a.client.del(`/api/comments/${top.id}`);
  assert.equal(r.data[0].state, 'deleted', 'deleted parent stays as a placeholder while replies exist');

  assert.equal((await a.client.post(`/api/pds/${code}/comments`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await a.client.post(`/api/pds/${code}/comments`, { text: 'you bastard' })).status, 400, 'blocked words');
});

test('comment rate limit: 10 per user per hour', async () => {
  const owner = await newUser();
  const chatty = await newUser();
  const code = await createPds(owner.client);
  for (let i = 0; i < 10; i++) assert.equal((await chatty.client.post(`/api/pds/${code}/comments`, { text: `point ${i}` })).status, 201);
  assert.equal((await chatty.client.post(`/api/pds/${code}/comments`, { text: 'one more' })).status, 429);
});

test('report a comment; admin hides it; non-staff then see it masked', async () => {
  const owner = await newUser();
  const troll = await newUser();
  const reporter = await newUser();
  const admin = await newUser('Mod');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client);
  const r = await troll.client.post(`/api/pds/${code}/comments`, { text: 'Buy cheap followers at my site' });
  const id = r.data[0].id;
  assert.equal((await reporter.client.post(`/api/comments/${id}/report`, { reason: 'spam' })).status, 200);
  const mod = await admin.client.get('/api/admin/moderation');
  assert.equal(mod.data.reported[0].id, id);
  await admin.client.post(`/api/admin/comments/${id}/hide`, { hidden: true });
  const view = await reporter.client.get(`/api/pds/${code}`);
  assert.equal(view.data.comments[0].state, 'hidden');
  assert.equal(view.data.comments[0].text, null);
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'comment_hide'").get();
  assert.ok(audit, 'admin action audited');
});

test('need more info: team asks, owner replies, PDS returns to review', async () => {
  const owner = await newUser();
  const admin = await newUser('Lead');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client);
  await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'need_info', note: 'Which billing software do you use?' });
  let d = await owner.client.get(`/api/pds/${code}`);
  assert.equal(d.data.pds.status, 'need_info');
  assert.equal(d.data.comments.at(-1).is_team, true);
  await owner.client.post(`/api/pds/${code}/comments`, { text: 'We use Tally' });
  d = await owner.client.get(`/api/pds/${code}`);
  assert.equal(d.data.pds.status, 'under_review');
});

test('reject needs a reason, which the user sees', async () => {
  const owner = await newUser();
  const admin = await newUser('Lead Two');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client);
  assert.equal((await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'rejected' })).status, 400);
  await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'rejected', note: 'Out of scope for our team' });
  const d = await owner.client.get(`/api/pds/${code}`);
  assert.equal(d.data.pds.status_reason, 'Out of scope for our team');
});

test('export: contact details only for Super Admin', async () => {
  const owner = await newUser();
  await createPds(owner.client);
  const admin = await newUser('Plain Admin');
  await makeStaff(admin, 'admin');
  const sa = await newUser('Super');
  await makeStaff(sa, 'super_admin');
  const a = await admin.client.get('/api/admin/pds-export?contacts=1');
  assert.ok(!a.data.includes(owner.email));
  const s = await sa.client.get('/api/admin/pds-export?contacts=1');
  assert.ok(s.data.includes(owner.email));
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'export_with_contacts'").get());
});

test('uploads: only real JPG/PNG/PDF files, max 3', async () => {
  const u = await newUser();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');
  const ok = new FormData();
  ok.append('title', 'With screenshot');
  ok.append('action', 'draft');
  ok.append('files', new Blob([png], { type: 'image/png' }), 'shot.png');
  const r = await u.client.req('POST', '/api/pds', undefined, { form: ok });
  assert.equal(r.status, 201);
  const d = await u.client.get(`/api/pds/${r.data.code}`);
  assert.equal(d.data.attachments.length, 1);
  const url = d.data.attachments[0].url;
  const file = await fetch(base + url);
  assert.equal(file.status, 200, 'signed link opens the file');
  assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), png), 0);
  assert.equal((await fetch(base + url.replace(/sig=\w+/, 'sig=forged'))).status, 403, 'tampered link refused');
  assert.equal((await fetch(base + url.replace(/exp=\d+/, 'exp=1000'))).status, 403, 'expired link refused');

  const fake = new FormData();
  fake.append('title', 'Fake pdf');
  fake.append('action', 'draft');
  fake.append('files', new Blob(['MZ this is an exe'], { type: 'application/pdf' }), 'invoice.pdf');
  assert.equal((await u.client.req('POST', '/api/pds', undefined, { form: fake })).status, 400);

  const exe = new FormData();
  exe.append('title', 'Exe');
  exe.append('action', 'draft');
  exe.append('files', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'run.exe');
  assert.equal((await u.client.req('POST', '/api/pds', undefined, { form: exe })).status, 400);
});
