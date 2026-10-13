import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, newUser, createPds, makeStaff, slots, close, base } from './helpers.js';

after(close);

const realNow = slots.clock.now;
beforeEach(() => {
  slots.clock.now = realNow;
  db.exec("DELETE FROM slots; DELETE FROM bookings; UPDATE pds SET status = 'closed' WHERE status NOT IN ('closed');");
});

let admin;
async function getAdmin() {
  if (!admin) {
    admin = await newUser('Slot Admin');
    await makeStaff(admin, 'admin');
  }
  return admin;
}

/** The admin schedules a PDS (users no longer pick their own slot). */
async function assign(code, lane, start_week) {
  return (await getAdmin()).client.post('/api/admin/slots/assign', { code, lane, start_week });
}

/** A user with an approved PDS of `size` weeks that is not scheduled yet (as if approved before this change). */
async function approvedPds(size = 1) {
  const a = await getAdmin();
  const owner = await newUser();
  const code = await createPds(owner.client);
  db.prepare("UPDATE pds SET status = 'approved', size_weeks = ?, approved_at = datetime('now') WHERE pds_code = ?").run(size, code);
  assert.ok(a);
  return { owner, code };
}

test('approving schedules the work; users cannot book, change or cancel slots', async () => {
  const ad = await getAdmin();
  const owner = await newUser('Scheduled Owner');
  const code = await createPds(owner.client);
  assert.equal((await ad.client.post(`/api/admin/pds/${code}/approve`, { size_weeks: 2 })).status, 400, 'a start week is required');
  const opts = await ad.client.get('/api/admin/slots/options?size=2');
  assert.equal(opts.status, 200);
  const pick = opts.data.options[0];
  const r = await ad.client.post(`/api/admin/pds/${code}/approve`, { size_weeks: 2, lane: pick.lane, start_week: pick.start_week });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await owner.client.get(`/api/pds/${code}`);
  assert.equal(d.data.pds.status, 'queued');
  assert.equal(d.data.booking.start_week, pick.start_week);
  assert.equal(d.data.can.book, undefined);
  const notes = db.prepare('SELECT message FROM notifications WHERE user_id = ? ORDER BY id').all(owner.id).map((n) => n.message);
  const about = notes.filter((m) => m.includes(code) && !m.includes('submitted'));
  assert.equal(about.length, 1, `one notification with the dates: ${about}`);
  assert.match(about[0], /Development planned from the week of/);
  assert.doesNotMatch(about[0], /Slot [AB]/, 'users never see slot letters');
  for (const [method, url] of [['GET', `/api/pds/${code}/slots`], ['POST', `/api/pds/${code}/booking`], ['DELETE', `/api/pds/${code}/booking`]]) {
    assert.equal((await owner.client.req(method, url, method === 'GET' ? undefined : {})).status, 404, `${method} ${url}`);
  }
});

test('week maths', () => {
  assert.equal(slots.mondayOf(new Date('2026-10-10T12:00:00Z')), '2026-10-05');
  assert.equal(slots.mondayOf(new Date('2026-10-12T00:00:00Z')), '2026-10-12');
  assert.equal(slots.addWeeks('2026-12-28', 1), '2027-01-04');
  assert.equal(slots.isoWeekNumber('2026-10-12'), 42);
});

test('two admins scheduling the same slot at the same moment: only one succeeds', async () => {
  const a = await approvedPds(1);
  const b = await approvedPds(1);
  const week = slots.addWeeks(slots.currentWeek(), 3);
  const [ra, rb] = await Promise.all([
    assign(a.code, 'A', week),
    assign(b.code, 'A', week),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slots WHERE lane = 'A' AND week_start = ?").get(week).n, 1);
});

test('overlapping multi-week bookings are refused', async () => {
  const a = await approvedPds(3);
  const b = await approvedPds(2);
  const w = slots.addWeeks(slots.currentWeek(), 2);
  assert.equal((await assign(a.code, 'B', w)).status, 201);
  const clash = await assign(b.code, 'B', slots.addWeeks(w, 2));
  assert.equal(clash.status, 409);
});

test('next booking starts only when the running one finishes; early finish pulls the queue forward', async () => {
  const ad = await getAdmin();
  const first = await approvedPds(3);
  const second = await approvedPds(2);
  const now = slots.currentWeek();
  await assign(first.code, 'A', now);
  await assign(second.code, 'A', slots.addWeeks(now, 3));

  slots.tick();
  assert.equal(db.prepare('SELECT status FROM pds WHERE pds_code = ?').get(first.code).status, 'in_development');
  assert.equal(db.prepare('SELECT status FROM pds WHERE pds_code = ?').get(second.code).status, 'queued');

  // Finished in week 1 of 3 -> the second project moves up to start next... right away.
  const r = await ad.client.post(`/api/admin/pds/${first.code}/status`, { status: 'delivered' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b2 = db.prepare("SELECT b.* FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE p.pds_code = ? AND b.status != 'cancelled'").get(second.code);
  assert.equal(b2.status, 'in_development', 'started as soon as the lane was free');
  assert.equal(b2.start_week, now);
  const note = db.prepare("SELECT message FROM notifications WHERE message LIKE ? ORDER BY id DESC").get(`%${second.code}%`);
  assert.ok(note, 'owner notified');
});

test('admin deletes a PDS in development: slot freed, next project in the lane starts', async () => {
  const ad = await getAdmin();
  const first = await approvedPds(3);
  const second = await approvedPds(1);
  const now = slots.currentWeek();
  await assign(first.code, 'A', now);
  await assign(second.code, 'A', slots.addWeeks(now, 3));
  slots.tick();
  assert.equal(db.prepare('SELECT status FROM pds WHERE pds_code = ?').get(first.code).status, 'in_development');

  const r = await ad.client.req('DELETE', `/api/admin/pds/${first.code}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pds WHERE pds_code = ?').get(first.code).n, 0);
  const b2 = db.prepare("SELECT b.* FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE p.pds_code = ? AND b.status != 'cancelled'").get(second.code);
  assert.equal(b2.status, 'in_development', 'the waiting project took over the freed slot');
  assert.equal(b2.start_week, now);
});

test('admin deletes a PDS in testing, a booked one and finished ones', async () => {
  const ad = await getAdmin();
  const now = slots.currentWeek();
  const testing = await approvedPds(1);
  await assign(testing.code, 'B', now);
  slots.tick();
  assert.equal((await ad.client.post(`/api/admin/pds/${testing.code}/status`, { status: 'testing' })).status, 200);

  const booked = await approvedPds(1);
  const later = slots.addWeeks(now, 4);
  await assign(booked.code, 'A', later);

  const delivered = await approvedPds(1);
  await assign(delivered.code, 'A', now);
  slots.tick();
  assert.equal((await ad.client.post(`/api/admin/pds/${delivered.code}/status`, { status: 'delivered' })).status, 200);

  const closed = await approvedPds(1);
  db.prepare("UPDATE pds SET status = 'closed' WHERE pds_code = ?").run(closed.code);

  for (const { code } of [testing, booked, delivered, closed]) {
    const r = await ad.client.req('DELETE', `/api/admin/pds/${code}`);
    assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.data)}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pds WHERE pds_code = ?').get(code).n, 0);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slots WHERE lane = 'A' AND week_start = ?").get(later).n, 0, 'booked weeks are free again');
});

test('a late project pushes everyone waiting in its lane and they are notified', async () => {
  const first = await approvedPds(1);
  const second = await approvedPds(1);
  const now = slots.currentWeek();
  await assign(first.code, 'B', now);
  await assign(second.code, 'B', slots.addWeeks(now, 1));
  slots.tick();
  // Jump 8 days ahead: the first project should have ended but is still running.
  slots.clock.now = () => new Date(Date.now() + 8 * 864e5);
  slots.tick();
  const b1 = db.prepare("SELECT b.* FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE p.pds_code = ?").get(first.code);
  const b2 = db.prepare("SELECT b.* FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE p.pds_code = ?").get(second.code);
  assert.equal(b1.end_week, slots.addWeeks(now, 1), 'running project extended');
  assert.equal(b2.start_week, slots.addWeeks(now, 2), 'waiting project pushed back');
  assert.equal(b2.status, 'booked', 'and it does not start while the lane is busy');
  const owner2 = db.prepare('SELECT user_id FROM pds WHERE pds_code = ?').get(second.code).user_id;
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'slot'").get(owner2));
});

test('admin: block a week pushes waiting bookings; capacity; priority needs a reason', async () => {
  const ad = await getAdmin();
  const p = await approvedPds(1);
  const w = slots.addWeeks(slots.currentWeek(), 2);
  await assign(p.code, 'A', w);
  assert.equal((await ad.client.post('/api/admin/slots/block', { lane: 'A', week_start: w })).status, 400, 'reason required');
  assert.equal((await ad.client.post('/api/admin/slots/block', { lane: 'A', week_start: w, reason: 'Team leave' })).status, 201);
  const b = db.prepare("SELECT b.* FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE p.pds_code = ?").get(p.code);
  assert.equal(b.start_week, slots.addWeeks(w, 1));

  assert.equal((await ad.client.put('/api/admin/slots/capacity', { parallel_slots: 3, hours_per_week: 25 })).status, 200);
  const cal = await ad.client.get('/api/admin/slots');
  assert.deepEqual(cal.data.lanes, ['A', 'B', 'C']);
  await ad.client.put('/api/admin/slots/capacity', { parallel_slots: 2, hours_per_week: 20 });

  const q = await approvedPds(1);
  assert.equal((await ad.client.post(`/api/admin/queue/${q.code}/priority`, { boost: 5 })).status, 400);
  assert.equal((await ad.client.post(`/api/admin/queue/${q.code}/priority`, { boost: 5, reason: 'Hospital needs it' })).status, 200);
});

test('guests get the calendar summary without project names', async () => {
  const p = await approvedPds(1);
  await assign(p.code, 'A', slots.addWeeks(slots.currentWeek(), 1));
  const r = await fetch(`${base}/api/public/summary`).then((x) => x.json());
  assert.equal(r.weeks.length, 5);
  assert.ok(!JSON.stringify(r).includes(p.code));
  assert.equal(r.weeks[1].cells.find((c) => c.lane === 'A').status, 'booked');
});
