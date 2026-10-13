import { db, tx, httpError } from './db.js';
import { LIMITS } from './constants.js';
import { changeStatus, getPdsById } from './pds.js';
import { notifyUser } from './messaging.js';
import { EVERYONE, USERS, publish } from './live.js';

// ===================== Development slots (PRD §10) =====================
// A lane (A, B, ...) is one parallel slot. Time is counted in weeks starting on Monday (UTC).
// Each occupied or blocked lane-week is a row in `slots`, and UNIQUE(lane, week_start) makes it
// impossible for two bookings to take the same week - even when two users click at the same moment.
// Rule (SL-06): in each lane the next booking starts only when the running one is finished.

export const clock = { now: () => new Date() }; // tests replace this

// ---------- week maths ----------
const iso = (d) => d.toISOString().slice(0, 10);
export function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}
export const currentWeek = () => mondayOf(clock.now());
export function addWeeks(week, n) {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return iso(d);
}
export const weeksBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (7 * 864e5));
export const sizeOf = (b) => weeksBetween(b.start_week, b.end_week) + 1;
export function isoWeekNumber(week) {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3); // Thursday decides the ISO year
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}
export const fmtWeek = (w) => new Date(`${w}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekRange = (start, size) => Array.from({ length: size }, (_, i) => addWeeks(start, i));

// ---------- capacity ----------
export function capacity() {
  return db.prepare('SELECT parallel_slots, hours_per_week, effective_from FROM slot_settings ORDER BY id DESC LIMIT 1').get();
}
export const laneName = (i) => String.fromCharCode(65 + i);
export const activeLanes = () => Array.from({ length: capacity().parallel_slots }, (_, i) => laneName(i));

export function setCapacity(parallel, hours, actor) {
  const p = Number(parallel);
  const h = Number(hours);
  if (!Number.isInteger(p) || p < 1 || p > 10) throw httpError(400, 'Parallel slots must be between 1 and 10');
  if (!Number.isInteger(h) || h < 1 || h > 80) throw httpError(400, 'Hours per week must be between 1 and 80');
  const lanes = Array.from({ length: p }, (_, i) => laneName(i));
  const stranded = db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status IN ('booked','in_development','testing') AND lane NOT IN (${lanes.map(() => '?').join(',')})`)
    .get(...lanes).n;
  if (stranded) throw httpError(409, `${stranded} active booking(s) use a lane you are removing. Move them first.`);
  db.prepare('INSERT INTO slot_settings (parallel_slots, hours_per_week, created_by) VALUES (?, ?, ?)').run(p, h, actor?.id ?? null);
}

// ---------- occupancy ----------
function laneRows(lane, from, to) {
  return db.prepare('SELECT * FROM slots WHERE lane = ? AND week_start BETWEEN ? AND ?').all(lane, from, to);
}
function isFree(lane, start, size) {
  return laneRows(lane, start, addWeeks(start, size - 1)).length === 0;
}
/** Free start options for a PDS of `size` weeks (SL-04). */
export function slotOptions(size, { horizon = 12 } = {}) {
  const from = currentWeek();
  const out = [];
  for (let i = 0; i <= horizon; i++) {
    const start = addWeeks(from, i);
    for (const lane of activeLanes()) {
      if (isFree(lane, start, size)) out.push({ lane, start_week: start, end_week: addWeeks(start, size - 1), week_no: isoWeekNumber(start) });
    }
  }
  return out;
}

function insertRows(booking, status = 'booked') {
  const ins = db.prepare('INSERT INTO slots (lane, week_start, status, pds_id, booking_id) VALUES (?, ?, ?, ?, ?)');
  try {
    for (const w of weekRange(booking.start_week, sizeOf(booking))) ins.run(booking.lane, w, status, booking.pds_id, booking.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw httpError(409, 'That slot is no longer free. Please pick another one.', { code: 'slot_taken' });
    throw e;
  }
}
const clearRows = (bookingId) => db.prepare("DELETE FROM slots WHERE booking_id = ? AND status != 'completed'").run(bookingId);
export const activeBooking = (pdsId) => db.prepare("SELECT * FROM bookings WHERE pds_id = ? AND status IN ('booked','in_development','testing')").get(pdsId);

function notifyDateChange(booking, reason) {
  const pds = getPdsById(booking.pds_id);
  notifyUser(pds.user_id, {
    type: 'slot',
    message: `${pds.pds_code}: development now starts the week of ${fmtWeek(booking.start_week)}.${reason ? ` Reason: ${reason}` : ''}`,
    link: `/pds/${pds.pds_code}`,
  });
}

// ---------- booking ----------
/** Book a start week + lane for an approved PDS (SL-04, SL-05). by: user | admin | system. */
export function book(pdsId, lane, startWeek, by, actor = null) {
  return tx(() => {
    const pds = getPdsById(pdsId);
    if (!pds || !['approved', 'queued'].includes(pds.status)) throw httpError(400, 'Only an approved PDS can book a slot');
    if (!pds.size_weeks) throw httpError(400, 'The team has not set the size of this PDS yet');
    if (activeBooking(pds.id)) throw httpError(409, 'This PDS already has a booking. Cancel or change it instead.');
    if (!activeLanes().includes(lane)) throw httpError(400, 'Unknown slot');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startWeek)) || mondayOf(new Date(`${startWeek}T00:00:00Z`)) !== startWeek) throw httpError(400, 'Start must be a Monday');
    if (startWeek < currentWeek()) throw httpError(400, 'That week has already started');
    const end = addWeeks(startWeek, pds.size_weeks - 1);
    let r;
    try {
      r = db.prepare('INSERT INTO bookings (pds_id, lane, start_week, end_week, booked_by) VALUES (?, ?, ?, ?, ?)').run(pds.id, lane, startWeek, end, by);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw httpError(409, 'This PDS already has a booking');
      throw e;
    }
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid);
    insertRows(booking);
    db.prepare('UPDATE pds SET choose_by = NULL WHERE id = ?').run(pds.id);
    changeStatus(pds, 'queued', actor, { kind: by === 'user' ? 'user' : by, note: `Development planned from the week of ${fmtWeek(startWeek)} (${pds.size_weeks} week${pds.size_weeks > 1 ? 's' : ''}).`, notify: by !== 'user' });
    return booking;
  });
}

/** SL-08: the owner may cancel up to 48 hours before the start; admins any time before it starts. */
export function cancelBooking(pdsId, actor, { byAdmin = false, reason = null } = {}) {
  return tx(() => {
    const b = activeBooking(pdsId);
    if (!b) throw httpError(404, 'No active booking');
    if (b.status !== 'booked') throw httpError(400, 'Work has already started on this slot');
    const hoursLeft = (Date.parse(`${b.start_week}T00:00:00Z`) - clock.now().getTime()) / 36e5;
    if (!byAdmin && hoursLeft < LIMITS.cancelBookingHours) throw httpError(400, `Bookings can only be changed up to ${LIMITS.cancelBookingHours} hours before they start`);
    clearRows(b.id);
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(b.id);
    const pds = getPdsById(pdsId);
    changeStatus(pds, 'approved', actor, { kind: byAdmin ? 'team' : 'user', note: reason || 'Booking cancelled', notify: byAdmin });
    return b;
  });
}

/** SL-09: admin moves a not-yet-started booking. */
export function moveBooking(bookingId, lane, startWeek, reason, actor) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b || b.status !== 'booked') throw httpError(400, 'Only bookings that have not started can be moved');
    if (!activeLanes().includes(lane)) throw httpError(400, 'Unknown slot');
    if (startWeek < currentWeek() || mondayOf(new Date(`${startWeek}T00:00:00Z`)) !== startWeek) throw httpError(400, 'Pick a Monday from this week onwards');
    clearRows(b.id);
    const moved = { ...b, lane, start_week: startWeek, end_week: addWeeks(startWeek, sizeOf(b) - 1) };
    db.prepare('UPDATE bookings SET lane = ?, start_week = ?, end_week = ?, reminded_at = NULL WHERE id = ?').run(moved.lane, moved.start_week, moved.end_week, b.id);
    insertRows(moved);
    notifyDateChange(moved, reason);
    return moved;
  });
}

/** SL-09: swap two not-yet-started bookings (each keeps its own length). */
export function swapBookings(aId, bId, reason) {
  return tx(() => {
    const a = db.prepare('SELECT * FROM bookings WHERE id = ?').get(aId);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bId);
    if (!a || !b || a.status !== 'booked' || b.status !== 'booked' || a.id === b.id) throw httpError(400, 'Pick two different bookings that have not started');
    clearRows(a.id);
    clearRows(b.id);
    const na = { ...a, lane: b.lane, start_week: b.start_week, end_week: addWeeks(b.start_week, sizeOf(a) - 1) };
    const nb = { ...b, lane: a.lane, start_week: a.start_week, end_week: addWeeks(a.start_week, sizeOf(b) - 1) };
    const up = db.prepare('UPDATE bookings SET lane = ?, start_week = ?, end_week = ?, reminded_at = NULL WHERE id = ?');
    up.run(na.lane, na.start_week, na.end_week, na.id);
    up.run(nb.lane, nb.start_week, nb.end_week, nb.id);
    insertRows(na);
    insertRows(nb);
    notifyDateChange(na, reason);
    notifyDateChange(nb, reason);
  });
}

/** SL-09: block a lane-week (holiday, leave). Bookings waiting in that lane are pushed later. */
export function blockWeek(lane, week, reason) {
  return tx(() => {
    if (!reason) throw httpError(400, 'Add a reason (it is sent to affected users)');
    if (mondayOf(new Date(`${week}T00:00:00Z`)) !== week) throw httpError(400, 'Week must start on a Monday');
    const row = db.prepare('SELECT s.*, b.status AS booking_status FROM slots s LEFT JOIN bookings b ON b.id = s.booking_id WHERE s.lane = ? AND s.week_start = ?').get(lane, week);
    if (row?.status === 'blocked') throw httpError(409, 'This week is already blocked');
    if (row && row.booking_status !== 'booked') throw httpError(409, 'A project is running in this week. Finish or move it first.');
    const waiting = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status = 'booked' AND end_week >= ? ORDER BY start_week").all(lane, week);
    for (const b of waiting) clearRows(b.id);
    db.prepare("INSERT INTO slots (lane, week_start, status, block_reason) VALUES (?, ?, 'blocked', ?)").run(lane, week, reason);
    placeInOrder(lane, waiting, 'push', reason);
  });
}

export function unblockWeek(slotId) {
  const r = db.prepare("DELETE FROM slots WHERE id = ? AND status = 'blocked'").run(slotId);
  if (!r.changes) throw httpError(404, 'Blocked week not found');
}

/** First start >= desired where `size` weeks are free in the lane. */
function firstFit(lane, desired, size) {
  let start = desired;
  for (let guard = 0; guard < 520; guard++, start = addWeeks(start, 1)) if (isFree(lane, start, size)) return start;
  throw httpError(500, 'No free slot found within 10 years');
}

/**
 * Re-place waiting bookings in a lane, in order (SL-07).
 * push: never earlier than before (a project ran late / a week got blocked).
 * pack: as early as possible (a project finished early, so the next one starts early).
 */
function placeInOrder(lane, bookings, mode, reason) {
  const running = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status IN ('in_development','testing')").get(lane);
  let cursor = running ? addWeeks(running.end_week, 1) : currentWeek();
  if (cursor < currentWeek()) cursor = currentWeek();
  for (const b of bookings) {
    const size = sizeOf(b);
    const desired = mode === 'pack' || b.start_week < cursor ? cursor : b.start_week;
    const start = firstFit(lane, desired, size);
    const moved = { ...b, start_week: start, end_week: addWeeks(start, size - 1) };
    if (start !== b.start_week) db.prepare('UPDATE bookings SET start_week = ?, end_week = ?, reminded_at = NULL WHERE id = ?').run(moved.start_week, moved.end_week, b.id);
    insertRows(moved);
    if (start !== b.start_week) notifyDateChange(moved, reason);
    cursor = addWeeks(moved.end_week, 1);
  }
}

function repackLane(lane, mode, reason) {
  const waiting = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status = 'booked' ORDER BY start_week, id").all(lane);
  for (const b of waiting) clearRows(b.id);
  placeInOrder(lane, waiting, mode, reason);
}

// ---------- lifecycle ----------
function startBooking(b) {
  db.prepare("UPDATE bookings SET status = 'in_development', started_at = datetime('now') WHERE id = ?").run(b.id);
  db.prepare("UPDATE slots SET status = 'in_development' WHERE booking_id = ?").run(b.id);
  const pds = getPdsById(b.pds_id);
  changeStatus(pds, 'in_development', null, { kind: 'system', note: 'Development started' });
}

/** Keep slot rows in step with the PDS (In Development -> Testing). */
export function syncBookingStatus(pdsId, status) {
  const b = activeBooking(pdsId);
  if (!b || !['in_development', 'testing'].includes(status) || b.status === status) return;
  if (b.status === 'booked') {
    // Admin started it by hand - only allowed when nothing else runs in the lane.
    const running = db.prepare("SELECT 1 FROM bookings WHERE lane = ? AND status IN ('in_development','testing') AND id != ?").get(b.lane, b.id);
    if (running) throw httpError(409, `Slot ${b.lane} is still busy with another project. Finish it first or move this booking.`);
    tx(() => {
      clearRows(b.id);
      const start = currentWeek();
      const moved = { ...b, start_week: start, end_week: addWeeks(start, sizeOf(b) - 1) };
      db.prepare("UPDATE bookings SET start_week = ?, end_week = ?, status = ?, started_at = datetime('now') WHERE id = ?").run(moved.start_week, moved.end_week, status, b.id);
      insertRows(moved, status);
      repackLane(b.lane, 'push', 'An earlier project started in this slot');
    });
    return;
  }
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, b.id);
  db.prepare('UPDATE slots SET status = ? WHERE booking_id = ?').run(status, b.id);
}

/** PDS delivered: free the slot. Unused weeks are released and the lane's queue moves up (SL-06/07). */
export function completeBooking(pdsId) {
  return tx(() => {
    const b = activeBooking(pdsId);
    if (!b) return;
    // The current week is released too, so the next project in the lane can start right away.
    const now = currentWeek();
    const lastWeek = addWeeks(now, -1);
    const end = b.end_week < now ? b.end_week : lastWeek < b.start_week ? b.start_week : lastWeek;
    db.prepare('DELETE FROM slots WHERE booking_id = ? AND week_start >= ?').run(b.id, b.end_week < now ? addWeeks(b.end_week, 1) : now);
    db.prepare("UPDATE slots SET status = 'completed' WHERE booking_id = ?").run(b.id);
    db.prepare("UPDATE bookings SET status = 'completed', end_week = ?, completed_at = datetime('now') WHERE id = ?").run(end, b.id);
    repackLane(b.lane, 'pack', 'The project before yours finished early');
    advanceLane(b.lane);
  });
}

/**
 * PDS deleted by an admin: drop its booking whatever state it is in. A running project frees its
 * slot like an early finish, so the lane's queue moves up; a not-yet-started one just frees its weeks.
 */
export function releaseBooking(pdsId) {
  return tx(() => {
    const b = activeBooking(pdsId);
    if (!b) return;
    clearRows(b.id);
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(b.id);
    if (b.status === 'booked') return;
    repackLane(b.lane, 'pack', 'The project before yours was removed');
    advanceLane(b.lane);
  });
}

function advanceLane(lane) {
  const now = currentWeek();
  const running = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status IN ('in_development','testing')").get(lane);
  if (running) {
    if (running.end_week < now) {
      // Running late (SL-07): extend it to this week and push everyone waiting in the lane.
      const waiting = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status = 'booked' ORDER BY start_week, id").all(lane);
      for (const b of waiting) clearRows(b.id);
      const ins = db.prepare('INSERT INTO slots (lane, week_start, status, pds_id, booking_id) VALUES (?, ?, ?, ?, ?)');
      for (let w = addWeeks(running.end_week, 1); w <= now; w = addWeeks(w, 1)) {
        const blocked = db.prepare('SELECT id FROM slots WHERE lane = ? AND week_start = ?').get(lane, w);
        if (!blocked) ins.run(lane, w, running.status, running.pds_id, running.id);
      }
      db.prepare('UPDATE bookings SET end_week = ? WHERE id = ?').run(now, running.id);
      placeInOrder(lane, waiting, 'push', 'The project before yours is taking longer than planned');
    }
    return;
  }
  const next = db.prepare("SELECT * FROM bookings WHERE lane = ? AND status = 'booked' ORDER BY start_week, id LIMIT 1").get(lane);
  if (next && next.start_week <= now) startBooking(next);
}

/**
 * Scheduler tick (every few minutes): start due bookings, handle overruns, send reminders (SL-11),
 * auto-close delivered PDS after 7 days (§11). Slots are chosen by the admin when approving (or on the Schedule page).
 */
const calendarSignature = () =>
  db.prepare("SELECT (SELECT group_concat(id || status || lane || week_start) FROM slots) || '|' || (SELECT group_concat(id || status || start_week) FROM bookings) AS s").get().s;

export function tick() {
  const before = calendarSignature();
  try {
    runTick();
  } finally {
    if (calendarSignature() !== before) {
      publish(['slots'], EVERYONE);
      publish(['pds'], USERS);
    }
  }
}

function runTick() {
  const lanes = new Set([...activeLanes(), ...db.prepare("SELECT DISTINCT lane FROM bookings WHERE status IN ('booked','in_development','testing')").all().map((r) => r.lane)]);
  for (const lane of lanes) tx(() => advanceLane(lane));

  const now = clock.now().getTime();
  for (const b of db.prepare("SELECT * FROM bookings WHERE status = 'booked' AND reminded_at IS NULL").all()) {
    const until = Date.parse(`${b.start_week}T00:00:00Z`) - now;
    if (until > 0 && until <= 864e5) {
      const pds = getPdsById(b.pds_id);
      notifyUser(pds.user_id, {
        type: 'slot',
        message: `${pds.pds_code}: development starts tomorrow`,
        link: `/pds/${pds.pds_code}`,
      });
      db.prepare("UPDATE bookings SET reminded_at = datetime('now') WHERE id = ?").run(b.id);
    }
  }


  for (const p of db.prepare(`SELECT * FROM pds WHERE status = 'delivered' AND delivered_at <= datetime('now', '-${LIMITS.autoCloseDays} days')`).all()) {
    changeStatus(p, 'closed', null, { kind: 'system', note: `Closed automatically ${LIMITS.autoCloseDays} days after delivery` });
  }
}

export function startScheduler() {
  const run = () => {
    try { tick(); } catch (e) { console.error('[slots] tick failed:', e); }
  };
  setInterval(run, 5 * 60_000).unref();
  setTimeout(run, 2000).unref();
}

// ---------- views ----------
/** Calendar for `weeks` weeks from the current one (SL-03). `label(pds)` decides what a viewer may see. */
export function calendar({ weeks = LIMITS.calendarWeeks, from = currentWeek(), label }) {
  const to = addWeeks(from, weeks - 1);
  const rows = db
    .prepare(
      `SELECT s.*, p.pds_code, p.title, p.visibility, p.user_id, p.progress_percent, b.start_week AS booking_start, b.end_week AS booking_end
       FROM slots s LEFT JOIN pds p ON p.id = s.pds_id LEFT JOIN bookings b ON b.id = s.booking_id
       WHERE s.week_start BETWEEN ? AND ?`,
    )
    .all(from, to);
  const lanes = [...new Set([...activeLanes(), ...rows.map((r) => r.lane)])].sort();
  const byKey = new Map(rows.map((r) => [`${r.lane}|${r.week_start}`, r]));
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const w = addWeeks(from, i);
    const cells = lanes.map((lane) => {
      const r = byKey.get(`${lane}|${w}`);
      if (!r) return { lane, status: activeLanes().includes(lane) ? 'available' : 'closed' };
      if (r.status === 'blocked') return { lane, status: 'blocked', id: r.id, reason: r.block_reason };
      return { lane, status: r.status, booking_id: r.booking_id, from: r.booking_start, to: r.booking_end, ends: r.booking_end === w, pds: label(r), progress: r.status === 'in_development' ? r.progress_percent : undefined };
    });
    out.push({ week_start: w, week_end: iso(new Date(Date.parse(`${w}T00:00:00Z`) + 6 * 864e5)), week_no: isoWeekNumber(w), cells, free: cells.filter((c) => c.status === 'available').map((c) => c.lane) });
  }
  return { capacity: capacity(), lanes, weeks: out };
}

/**
 * Queue (SL-10): approved PDS without a booking, first approved first served (priority boost first),
 * with an estimated start found by simulating bookings in that order. Booked ones follow by start date.
 */
export function queueView() {
  const waiting = db
    .prepare("SELECT * FROM pds WHERE status = 'approved' ORDER BY priority_boost DESC, approved_at, id")
    .all();
  const taken = new Set(db.prepare("SELECT lane || '|' || week_start AS k FROM slots").all().map((r) => r.k));
  const lanes = activeLanes();
  const estimates = waiting.map((p) => {
    if (!p.size_weeks) return { pds: p, estimate: null };
    for (let i = 0; i < 520; i++) {
      const start = addWeeks(currentWeek(), i);
      const lane = lanes.find((l) => weekRange(start, p.size_weeks).every((w) => !taken.has(`${l}|${w}`)));
      if (lane) {
        weekRange(start, p.size_weeks).forEach((w) => taken.add(`${lane}|${w}`));
        return { pds: p, estimate: { lane, start_week: start, end_week: addWeeks(start, p.size_weeks - 1) } };
      }
    }
    return { pds: p, estimate: null };
  });
  const booked = db
    .prepare("SELECT b.*, p.pds_code FROM bookings b JOIN pds p ON p.id = b.pds_id WHERE b.status = 'booked' ORDER BY b.start_week, b.lane")
    .all();
  return { waiting: estimates, booked };
}

export function bookingFor(pdsId) {
  const b = db.prepare("SELECT * FROM bookings WHERE pds_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1").get(pdsId);
  if (!b) return null;
  const hoursLeft = (Date.parse(`${b.start_week}T00:00:00Z`) - clock.now().getTime()) / 36e5;
  return { ...b, week_no: isoWeekNumber(b.start_week), can_change: b.status === 'booked' && hoursLeft >= LIMITS.cancelBookingHours };
}

export function estimateFor(pdsId) {
  return queueView().waiting.find((w) => w.pds.id === pdsId)?.estimate ?? null;
}
