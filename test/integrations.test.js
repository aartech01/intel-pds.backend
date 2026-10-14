import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake n8n webhook that records what IntelSquad sends. It must be listening, and the env set,
// before the app is imported, because the webhook and token settings are read at start-up.
const received = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ token: req.headers['x-intelsquad-token'], ...JSON.parse(body) });
    res.end('ok');
  });
});
await new Promise((r) => hook.listen(0, r));
Object.assign(process.env, {
  N8N_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/webhook/intelsquad`,
  N8N_WEBHOOK_SECRET: 'hook-secret-123',
  N8N_API_TOKEN: 'api-token-456',
});

const { db, base, newUser, makeStaff, createPds, close } = await import('./helpers.js');
after(async () => {
  await close();
  hook.close();
});

const api = (path, { method = 'GET', token = 'api-token-456', body } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = received.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('event not received');
}

test('events reach the webhook with the secret and no personal data', async () => {
  const owner = await newUser('Hook Owner');
  const admin = await newUser('Hook Admin');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client, { title: 'Hook test PDS' });

  const submitted = await waitFor((e) => e.event === 'pds.submitted' && e.data.code === code);
  assert.equal(submitted.token, 'hook-secret-123');
  assert.equal(submitted.data.title, 'Hook test PDS');
  assert.ok(submitted.data.problem_statement, 'new PDS carry the problem text for the AI summary');
  const raw = JSON.stringify(submitted);
  assert.ok(!raw.includes(owner.email) && !raw.includes(owner.phone) && !raw.includes('Hook Owner'), 'no email, mobile or full name');
  assert.ok(!received.some((e) => e.event === 'pds.status_changed' && e.data.code === code && e.data.to === 'submitted'), 'no duplicate status event for submit');

  await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'need_info', note: 'Which tool do you use?' });
  const changed = await waitFor((e) => e.event === 'pds.status_changed' && e.data.code === code && e.data.to === 'need_info');
  assert.equal(changed.data.from, 'submitted');
  assert.equal(changed.data.note, 'Which tool do you use?');

  const other = await newUser('Hook Commenter');
  await other.client.post(`/api/pds/${code}/comments`, { text: 'Try a spreadsheet macro', type: 'idea' });
  const comment = await waitFor((e) => e.event === 'comment.created' && e.data.pds.code === code);
  assert.equal(comment.data.comment.text, 'Try a spreadsheet macro');
  assert.equal(comment.data.comment.team, false);
});

test('integration API needs the bearer token', async () => {
  assert.equal((await api('/api/integrations/report', { token: null })).status, 401);
  assert.equal((await api('/api/integrations/report', { token: 'wrong' })).status, 401);
  const ok = await api('/api/integrations/report?period=weekly');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.period, 'weekly');
  assert.ok(Array.isArray(ok.data.in_period.new_pds));
  assert.ok(ok.data.now.slots_this_week.teams >= 1);
});

test('AI summary round trip: read a PDS, write the summary back as a team note', async () => {
  const owner = await newUser('Summary Owner');
  const code = await createPds(owner.client, { title: 'Summarise me' });
  await (await newUser('Summary Fan')).client.post(`/api/pds/${code}/comments`, { text: 'Add an export button', type: 'suggestion' });

  const pds = await api(`/api/integrations/pds/${code}`);
  assert.equal(pds.status, 200);
  assert.equal(pds.data.comments.length, 1);
  assert.ok(!JSON.stringify(pds.data).includes(owner.email));

  const w = await api(`/api/integrations/pds/${code}/summary`, { method: 'POST', body: { text: 'Owner wants a weekly report; community suggests export.' } });
  assert.equal(w.status, 201);
  const note = db.prepare('SELECT n.* FROM pds_notes n JOIN pds p ON p.id = n.pds_id WHERE p.pds_code = ?').get(code);
  assert.match(note.text, /^AI summary \(n8n\):/);
  assert.equal(note.user_id, null);

  // Internal notes stay hidden from the owner.
  const view = await owner.client.get(`/api/pds/${code}`);
  assert.ok(!JSON.stringify(view.data).includes('community suggests export'));

  assert.equal((await api('/api/integrations/pds/PDS-1999-9999')).status, 404);
  assert.equal((await api(`/api/integrations/pds/${code}/summary`, { method: 'POST', body: { text: '' } })).status, 400);
});
