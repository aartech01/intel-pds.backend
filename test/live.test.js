import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { base, newUser, createPds, makeStaff, Client, slots, close } from './helpers.js';

const streams = [];
after(async () => {
  for (const s of streams) s.abort();
  await close();
});

/** Opens /api/live as `client` and collects every topic it hears. Resolves once the stream is ready. */
async function listen(client) {
  const ctrl = new AbortController();
  streams.push(ctrl);
  const res = await fetch(`${base}/api/live`, { headers: { cookie: client.cookieHeader() }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const heard = new Set();
  let ready;
  const isReady = new Promise((r) => (ready = r));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: ready')) ready();
          else if (block.startsWith('data: ')) JSON.parse(block.slice(6)).topics.forEach((t) => heard.add(t));
        }
      }
    } catch {
      // aborted at the end of the run
    }
  })();
  await isReady;
  return heard;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

test('a comment on a public PDS reaches other users live, but not guests', async () => {
  const owner = await newUser('Live Owner');
  const viewer = await newUser('Live Viewer');
  const code = await createPds(owner.client);
  const seen = await listen(viewer.client);
  const guest = await listen(new Client());

  const r = await viewer.client.post(`/api/pds/${code}/comments`, { text: 'We have the same problem', comment_type: 'point' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await settle();
  assert.ok(seen.has(`pds:${code}`), [...seen].join());
  assert.ok(seen.has('pds'));
  assert.ok(![...guest].some((t) => t.startsWith('pds')), `guest heard ${[...guest]}`);
});

test('a private PDS is only announced to its owner and the team', async () => {
  const owner = await newUser('Private Owner');
  const stranger = await newUser('Stranger');
  const admin = await newUser('Live Admin');
  await makeStaff(admin, 'admin');
  const code = await createPds(owner.client, { visibility: 'private' });
  const [heardOwner, heardStranger, heardAdmin] = await Promise.all([listen(owner.client), listen(stranger.client), listen(admin.client)]);

  const r = await admin.client.post(`/api/admin/pds/${code}/status`, { status: 'under_review' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.ok(heardOwner.has(`pds:${code}`), 'owner hears it');
  assert.ok(heardOwner.has('notifications'), 'owner gets the notification badge update');
  assert.ok(heardAdmin.has(`pds:${code}`), 'team hears it');
  assert.ok(!heardStranger.has(`pds:${code}`), 'other users do not learn the private PDS exists');
});

test('guests hear slot calendar changes, including ones made by the scheduler', async () => {
  const admin = await newUser('Slot Live Admin');
  await makeStaff(admin, 'admin');
  const owner = await newUser('Slot Live Owner');
  const code = await createPds(owner.client);
  const r = await admin.client.post(`/api/admin/pds/${code}/approve`, { size_weeks: 1, lane: 'A', start_week: slots.currentWeek() });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const guest = await listen(new Client());
  slots.tick(); // starts the booking: the calendar changes without any request
  await settle();
  assert.ok(guest.has('slots'), `guest heard ${[...guest]}`);
});

/** Opens /api/live for one browser tab and keeps every event it receives, in order. */
async function listenTab(client, tab) {
  const ctrl = new AbortController();
  streams.push(ctrl);
  const res = await fetch(`${base}/api/live?tab=${tab}`, { headers: { cookie: client.cookieHeader() }, signal: ctrl.signal });
  const events = [];
  let ready;
  const isReady = new Promise((r) => (ready = r));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: ready')) ready();
          else if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
        }
      }
    } catch {
      // aborted at the end of the run
    }
  })();
  await isReady;
  return events;
}

/** A write sent from a specific tab, like the browser client does. */
const postFromTab = (client, tab, url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { cookie: client.cookieHeader(), 'x-csrf-token': client.jar.get('sd_csrf'), 'x-tab': tab, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the echo of a tab\'s own write is marked own; other tabs and other people get a normal event', async () => {
  const owner = await newUser('Echo Owner');
  const other = await newUser('Echo Other');
  const code = await createPds(owner.client);
  await settle(); // let the set-up announcements go out first
  const [mine, myOtherTab, theirs] = await Promise.all([
    listenTab(owner.client, 'tab-owner-aaaa'),
    listenTab(owner.client, 'tab-owner-bbbb'),
    listenTab(other.client, 'tab-other-cccc'),
  ]);

  const r = await postFromTab(owner.client, 'tab-owner-aaaa', `/api/pds/${code}/comments`, { text: 'Adding one more detail', comment_type: 'point' });
  assert.equal(r.status, 201);
  await settle();
  const hit = (events) => events.find((e) => e.topics.includes(`pds:${code}`));
  assert.equal(hit(mine)?.own, true, JSON.stringify(mine));
  assert.ok(hit(myOtherTab) && !hit(myOtherTab).own, 'the same user in another tab must still reload');
  assert.ok(hit(theirs) && !hit(theirs).own);

  // Someone else's write in the same moment is never marked own.
  mine.length = 0;
  await Promise.all([
    postFromTab(owner.client, 'tab-owner-aaaa', `/api/pds/${code}/comments`, { text: 'Second detail', comment_type: 'point' }),
    other.client.post(`/api/pds/${code}/comments`, { text: 'Me too', comment_type: 'point' }),
  ]);
  await settle();
  assert.ok(mine.some((e) => e.topics.includes(`pds:${code}`)));
  assert.ok(mine.filter((e) => e.topics.includes(`pds:${code}`)).some((e) => !e.own), JSON.stringify(mine));
});

test('a login tells staff "logins" only; a sign-up tells them "users"', async () => {
  const admin = await newUser('Login Watcher');
  await makeStaff(admin, 'admin');
  const heard = await listen(admin.client);
  const u = await newUser('Fresh Signup');
  await settle();
  assert.ok(heard.has('users'));
  heard.clear();
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { identifier: u.email, password: u.password })).status, 200);
  await settle();
  assert.ok(heard.has('logins') && !heard.has('users'), [...heard].join());
});
