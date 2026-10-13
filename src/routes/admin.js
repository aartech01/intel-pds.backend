import { Router } from 'express';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { db, tx, audit, httpError, getSettings, DEFAULT_SETTINGS } from '../db.js';
import { requireUser, requireRole, resetTwoFactor, revokeAllSessions } from '../auth.js';
import { ADMIN_SETTABLE, ROLES, ROLE_LABELS, STATUSES, TYPE_KEYS, LIMITS, atLeast, isStaff } from '../constants.js';
import { cleanText, clientIp, requireText } from '../security.js';
import { decrypt, hmac, normEmail, normPhone, randomToken, temporaryPassword } from '../crypto.js';
import {
  changeStatus, getPdsByCode, getPdsById, pdsAttachments, pdsCard, pdsComments, pdsProgress, pdsRequirements, pdsTimeline, touch,
} from '../pds.js';
import {
  activeBooking, addWeeks, blockWeek, book, bookingFor, calendar, cancelBooking, capacity, completeBooking, currentWeek, estimateFor,
  moveBooking, queueView, releaseBooking, setCapacity, slotOptions, swapBookings, syncBookingStatus, unblockWeek,
} from '../slots.js';
import { notifyUser } from '../messaging.js';
import { BCRYPT_COST, PUBLIC_URL } from '../config.js';
import { labelFor } from './pds.js';
import { deleteAccount, isLastSuperAdmin } from './me.js';
import { deleteStoredFiles } from '../storage.js';

const router = Router();
router.use(requireUser, requireRole('team_member'));
const admin = requireRole('admin');
const superAdmin = requireRole('super_admin');

const log = (req, action, type, id, details) => audit(req.user, action, { type, id, details, ip: clientIp(req) });
const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a))[0];

function loadPds(req) {
  const p = getPdsByCode(req.params.code);
  if (!p || p.status === 'draft') throw httpError(404, 'PDS not found');
  return p;
}
const isAssigned = (req, p) => p.assigned_to === req.user.id;

// ===================== overview (AD-02) =====================
router.get('/overview', (req, res) => {
  const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM pds WHERE status != 'draft' GROUP BY status").all().map((r) => [r.status, r.n]));
  const c = (...s) => s.reduce((t, k) => t + (counts[k] ?? 0), 0);
  const cap = capacity();
  const week = currentWeek();
  const busyLanes = one("SELECT COUNT(DISTINCT lane) FROM slots WHERE week_start = ? AND status IN ('booked','in_development','testing')", week);
  const blockedLanes = one("SELECT COUNT(DISTINCT lane) FROM slots WHERE week_start = ? AND status = 'blocked'", week);
  const sla = Number(getSettings().review_sla_hours || 48);
  const publicTotal = one("SELECT COUNT(*) FROM pds WHERE visibility = 'public' AND status NOT IN ('draft','withdrawn')");
  const publicWithInput = one(
    `SELECT COUNT(*) FROM pds p WHERE p.visibility = 'public' AND p.status NOT IN ('draft','withdrawn')
       AND EXISTS (SELECT 1 FROM comments c WHERE c.pds_id = p.id AND c.user_id != p.user_id AND c.is_team = 0 AND c.is_deleted = 0)`,
  );
  res.json({
    cards: {
      new: c('submitted'),
      in_review: c('under_review', 'need_info'),
      approved: c('approved'),
      in_queue: c('queued'),
      in_development: c('in_development', 'testing'),
      delivered: c('delivered', 'closed'),
      rejected: c('rejected'),
    },
    slots: { capacity: cap.parallel_slots, hours_per_week: cap.hours_per_week, busy: busyLanes, blocked: blockedLanes, free: Math.max(cap.parallel_slots - busyLanes - blockedLanes, 0) },
    metrics: {
      avg_review_hours: one("SELECT ROUND(AVG((julianday(reviewed_at) - julianday(submitted_at)) * 24), 1) FROM pds WHERE reviewed_at IS NOT NULL AND submitted_at IS NOT NULL"),
      community_input_pct: publicTotal ? Math.round((publicWithInput / publicTotal) * 100) : null,
      users: one("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND role = 'user'"),
      users_from_qr: one('SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND source_qr_id IS NOT NULL'),
      qr_scans: one('SELECT COALESCE(SUM(scan_count), 0) FROM qr_codes'),
      avg_rating: one('SELECT ROUND(AVG(rating), 1) FROM pds WHERE rating IS NOT NULL'),
      open_reports: one("SELECT COUNT(*) FROM reports WHERE status = 'open'"),
      sla_hours: sla,
    },
    overdue: db
      .prepare(`SELECT pds_code, title, submitted_at FROM pds WHERE status = 'submitted' AND submitted_at <= datetime('now', ?) ORDER BY submitted_at LIMIT 10`)
      .all(`-${sla} hours`),
    recent: db.prepare("SELECT * FROM pds WHERE status != 'draft' ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 8").all().map((p) => pdsCard(p, req.user)),
  });
});

// ===================== PDS list + export (AD-03, AD-12) =====================
function pdsFilters(q) {
  const where = ["p.status != 'draft'"];
  const args = [];
  const list = (v) => String(v).split(',').filter(Boolean);
  if (q.status) where.push(`p.status IN (${list(q.status).map(() => '?').join(',')})`), args.push(...list(q.status));
  if (q.type && TYPE_KEYS.includes(q.type)) where.push('p.type = ?'), args.push(q.type);
  if (q.visibility === 'public' || q.visibility === 'private') where.push('p.visibility = ?'), args.push(q.visibility);
  if (q.urgency) where.push('p.urgency = ?'), args.push(q.urgency);
  if (q.assigned === 'me') where.push('p.assigned_to = ?'), args.push(Number(q.me));
  else if (q.assigned === 'none') where.push('p.assigned_to IS NULL');
  else if (q.assigned) where.push('p.assigned_to = ?'), args.push(Number(q.assigned));
  if (q.q) {
    const like = `%${String(q.q).trim().slice(0, 80)}%`;
    where.push('(p.pds_code LIKE ? OR p.title LIKE ? OR p.problem_statement LIKE ? OR u.display_name LIKE ?)');
    args.push(like, like, like, like);
  }
  const order = {
    oldest: 'COALESCE(p.submitted_at, p.created_at) ASC',
    upvotes: 'p.upvote_count DESC',
    comments: 'p.comment_count DESC',
    urgency: "CASE p.urgency WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 ELSE 1 END DESC, p.submitted_at",
    updated: 'p.updated_at DESC',
  }[q.sort] || 'COALESCE(p.submitted_at, p.created_at) DESC';
  return { where: `WHERE ${where.join(' AND ')}`, args, order: `ORDER BY ${order}, p.id DESC` };
}
const FROM = 'FROM pds p JOIN users u ON u.id = p.user_id LEFT JOIN users a ON a.id = p.assigned_to';

router.get('/pds', (req, res) => {
  const { where, args, order } = pdsFilters({ ...req.query, me: req.user.id });
  const pageSize = Math.min(Number(req.query.pageSize) || 25, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = one(`SELECT COUNT(*) ${FROM} ${where}`, ...args);
  const rows = db.prepare(`SELECT p.*, a.display_name AS assignee ${FROM} ${where} ${order} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, rows: rows.map((p) => ({ ...pdsCard(p, req.user), assignee: p.assignee, priority_boost: p.priority_boost })) });
});

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // no spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/pds-export', admin, (req, res) => {
  const withContacts = atLeast(req.user, 'super_admin') && req.query.contacts === '1';
  const { where, args, order } = pdsFilters({ ...req.query, me: req.user.id });
  const rows = db.prepare(`SELECT p.*, u.display_name, u.full_name_enc, u.email_enc, u.phone_enc, a.display_name AS assignee ${FROM} ${where} ${order}`).all(...args);
  const head = ['PDS ID', 'Title', 'Type', 'Status', 'Urgency', 'Visibility', 'Size (weeks)', 'Upvotes', 'Comments', 'Progress %', 'Slot', 'Assigned to', 'Submitted', 'Updated', 'Rating', 'Problem statement', 'Expected result', 'Display name'];
  if (withContacts) head.push('Full name', 'Email', 'Mobile');
  const lines = [head.join(',')];
  for (const p of rows) {
    const b = activeBooking(p.id) || db.prepare("SELECT * FROM bookings WHERE pds_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1").get(p.id);
    const cells = [p.pds_code, p.title, p.type, STATUSES[p.status]?.label, p.urgency, p.visibility, p.size_weeks, p.upvote_count, p.comment_count, p.progress_percent,
      b ? `${b.lane} ${b.start_week} to ${b.end_week}` : '', p.assignee, p.submitted_at, p.updated_at, p.rating, p.problem_statement, p.expected_result, p.display_name];
    if (withContacts) cells.push(decrypt(p.full_name_enc), decrypt(p.email_enc), decrypt(p.phone_enc));
    lines.push(cells.map(csvCell).join(','));
  }
  log(req, withContacts ? 'export_with_contacts' : 'export', 'pds', null, `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="intelsquad-pds-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join('\r\n')}`); // BOM so Excel reads UTF-8
});

// ===================== PDS detail + actions (AD-04, AD-05, AD-10) =====================
router.get('/pds/:code', (req, res) => {
  const p = loadPds(req);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
  const showContact = atLeast(req.user, 'admin') && !owner.deleted_at;
  res.json({
    pds: { ...pdsCard(p, req.user), problem_statement: p.problem_statement, expected_result: p.expected_result, status_reason: p.status_reason, size_weeks: p.size_weeks, assigned_to: p.assigned_to, priority_boost: p.priority_boost, priority_reason: p.priority_reason, choose_by: p.choose_by, rating: p.rating, feedback: p.feedback, approved_at: p.approved_at },
    owner: {
      id: owner.id,
      display_name: owner.deleted_at ? 'Deleted user' : owner.display_name,
      ...(showContact ? { full_name: decrypt(owner.full_name_enc), email: decrypt(owner.email_enc), phone: decrypt(owner.phone_enc) } : {}),
      open_pds: one("SELECT COUNT(*) FROM pds WHERE user_id = ? AND status NOT IN ('draft','closed','rejected','withdrawn')", owner.id),
      is_blocked: !!owner.is_blocked,
    },
    attachments: pdsAttachments(p.id),
    comments: pdsComments(p, req.user),
    timeline: pdsTimeline(p.id, { staff: true }),
    progress: pdsProgress(p.id),
    requirements: pdsRequirements(p.id),
    notes: db.prepare('SELECT n.id, n.text, n.created_at, u.display_name AS by_name FROM pds_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.pds_id = ? ORDER BY n.id DESC').all(p.id),
    booking: bookingFor(p.id),
    estimate: p.status === 'approved' ? estimateFor(p.id) : null,
    options: atLeast(req.user, 'admin') && p.size_weeks && ['approved', 'queued'].includes(p.status) && !activeBooking(p.id) ? slotOptions(p.size_weeks).slice(0, 24) : [],
    team: db.prepare("SELECT id, display_name, role FROM users WHERE role != 'user' AND deleted_at IS NULL AND is_blocked = 0 ORDER BY display_name").all(),
    can: { admin: atLeast(req.user, 'admin'), progress: atLeast(req.user, 'admin') || isAssigned(req, p) },
  });
});

/** Status change (PRD §11). Team members may only move their assigned PDS to Testing. */
router.post('/pds/:code/status', (req, res) => {
  const p = loadPds(req);
  const to = String(req.body?.status || '');
  const note = cleanText(req.body?.note, 1000) || null;
  const isAdmin = atLeast(req.user, 'admin');
  if (!isAdmin && !(to === 'testing' && isAssigned(req, p))) return res.status(403).json({ error: 'Only admins can make this change' });
  if (!ADMIN_SETTABLE.includes(to)) return res.status(400).json({ error: 'This status is set by the system or the user' });
  if (to === 'approved') return res.status(400).json({ error: 'Use Approve (it needs the size in weeks)' });
  if (to === 'rejected' && !note) return res.status(400).json({ error: 'Add a reason - it is shown to the user' });
  if (to === 'need_info' && !note) return res.status(400).json({ error: 'Write the question for the user' });
  if (['closed', 'rejected', 'withdrawn'].includes(p.status)) return res.status(400).json({ error: 'This PDS is already finished' });
  tx(() => {
    if (['in_development', 'testing'].includes(to)) {
      if (!activeBooking(p.id)) throw httpError(400, 'Book a slot for this PDS first (Slots > Assign)');
      syncBookingStatus(p.id, to);
    }
    if (to === 'rejected' && activeBooking(p.id)) cancelBooking(p.id, req.user, { byAdmin: true, reason: 'PDS rejected' });
    if (to === 'need_info') {
      db.prepare("INSERT INTO comments (pds_id, user_id, comment_type, text, is_team) VALUES (?, ?, 'question', ?, 1)").run(p.id, req.user.id, note);
      db.prepare('UPDATE pds SET comment_count = comment_count + 1 WHERE id = ?').run(p.id);
    }
    changeStatus(getPdsById(p.id), to, req.user, { note });
    if (to === 'delivered') completeBooking(p.id);
  });
  log(req, 'pds_status', 'pds', p.pds_code, `${p.status} -> ${to}${note ? `: ${note}` : ''}`);
  res.json({ ok: true });
});

router.post('/pds/:code/approve', admin, (req, res) => {
  const p = loadPds(req);
  const size = Number(req.body?.size_weeks);
  if (!Number.isInteger(size) || size < 1 || size > LIMITS.maxSizeWeeks) return res.status(400).json({ error: `Set the size from 1 to ${LIMITS.maxSizeWeeks} weeks` });
  if (!['submitted', 'under_review', 'need_info'].includes(p.status)) return res.status(400).json({ error: 'Only PDS waiting for review can be approved' });
  const lane = String(req.body?.lane || '');
  const start = String(req.body?.start_week || '');
  if (!lane || !start) return res.status(400).json({ error: 'Choose when the team starts the work' });
  tx(() => {
    db.prepare('UPDATE pds SET size_weeks = ?, status_reason = NULL WHERE id = ?').run(size, p.id);
    // The owner gets one notification: the "queued" one with the planned dates.
    changeStatus(getPdsById(p.id), 'approved', req.user, { note: cleanText(req.body?.note, 1000) || `Estimated size: ${size} week${size > 1 ? 's' : ''}`, notify: false });
    book(p.id, lane, start, 'admin', req.user);
  });
  log(req, 'pds_approve', 'pds', p.pds_code, `${size} weeks, ${lane} ${start}`);
  res.json({ ok: true });
});

/** Free start weeks (and teams) for a project of `size` weeks - for the approve form. */
router.get('/slots/options', admin, (req, res) => {
  const size = Number(req.query.size);
  if (!Number.isInteger(size) || size < 1 || size > LIMITS.maxSizeWeeks) return res.status(400).json({ error: 'Unknown size' });
  res.json({ current_week: currentWeek(), options: slotOptions(size).slice(0, 30) });
});

router.patch('/pds/:code', (req, res) => {
  const p = loadPds(req);
  if (!atLeast(req.user, 'admin')) return res.status(403).json({ error: 'Only admins can change this' });
  const changes = [];
  tx(() => {
    if (req.body?.size_weeks !== undefined) {
      const size = Number(req.body.size_weeks);
      if (!Number.isInteger(size) || size < 1 || size > LIMITS.maxSizeWeeks) throw httpError(400, `Size must be 1 to ${LIMITS.maxSizeWeeks} weeks`);
      if (activeBooking(p.id)) throw httpError(400, 'Change the size before booking, or cancel the booking first');
      db.prepare('UPDATE pds SET size_weeks = ? WHERE id = ?').run(size, p.id);
      changes.push(`size ${p.size_weeks ?? '-'} -> ${size}`);
    }
    if (req.body?.assigned_to !== undefined) {
      const uid = req.body.assigned_to ? Number(req.body.assigned_to) : null;
      const member = uid && db.prepare("SELECT * FROM users WHERE id = ? AND role != 'user' AND deleted_at IS NULL").get(uid);
      if (uid && !member) throw httpError(400, 'Pick a team member');
      db.prepare('UPDATE pds SET assigned_to = ? WHERE id = ?').run(uid, p.id);
      changes.push(`assigned to ${member?.display_name ?? 'nobody'}`);
      if (member && member.id !== req.user.id) notifyUser(member, { type: 'assigned', message: `${p.pds_code} was assigned to you`, link: `/admin/pds/${p.pds_code}` });
    }
  });
  touch(p.id);
  if (changes.length) log(req, 'pds_update', 'pds', p.pds_code, changes.join('; '));
  res.json({ ok: true });
});

router.post('/pds/:code/notes', (req, res) => {
  const p = loadPds(req);
  db.prepare('INSERT INTO pds_notes (pds_id, user_id, text) VALUES (?, ?, ?)').run(p.id, req.user.id, requireText(req.body?.text, 2000, 'Note'));
  log(req, 'pds_note', 'pds', p.pds_code);
  res.status(201).json({ ok: true });
});

/** SL-12: progress (percentage + short note) shown on the dashboard. */
router.post('/pds/:code/progress', (req, res) => {
  const p = loadPds(req);
  if (!atLeast(req.user, 'admin') && !isAssigned(req, p)) return res.status(403).json({ error: 'Only the assigned team member or an admin can update progress' });
  if (!['in_development', 'testing'].includes(p.status)) return res.status(400).json({ error: 'Progress is updated while the PDS is in development or testing' });
  const percent = Math.round(Number(req.body?.percent));
  if (!(percent >= 0 && percent <= 100)) return res.status(400).json({ error: 'Percent must be 0 to 100' });
  const note = cleanText(req.body?.note, 300) || null;
  db.prepare('INSERT INTO progress_updates (pds_id, percent, note, created_by) VALUES (?, ?, ?, ?)').run(p.id, percent, note, req.user.id);
  db.prepare("UPDATE pds SET progress_percent = ?, updated_at = datetime('now') WHERE id = ?").run(percent, p.id);
  notifyUser(p.user_id, { type: 'progress', message: `${p.pds_code} is ${percent}% done${note ? ` - ${note}` : ''}`, link: `/pds/${p.pds_code}` });
  log(req, 'pds_progress', 'pds', p.pds_code, `${percent}%`);
  res.status(201).json({ ok: true });
});

router.post('/pds/:code/requirements', admin, (req, res) => {
  const p = loadPds(req);
  let text = cleanText(req.body?.text, 1000);
  let commentId = null;
  if (req.body?.comment_id) {
    const c = db.prepare('SELECT * FROM comments WHERE id = ? AND pds_id = ? AND is_deleted = 0').get(req.body.comment_id, p.id);
    if (!c) return res.status(404).json({ error: 'Comment not found' });
    if (db.prepare('SELECT 1 FROM pds_requirements WHERE comment_id = ?').get(c.id)) return res.status(409).json({ error: 'Already in the requirement list' });
    commentId = c.id;
    text ||= c.text;
    db.prepare('UPDATE comments SET is_useful = 1 WHERE id = ?').run(c.id);
  }
  if (!text) return res.status(400).json({ error: 'Write the requirement' });
  db.prepare('INSERT INTO pds_requirements (pds_id, comment_id, text, added_by) VALUES (?, ?, ?, ?)').run(p.id, commentId, text, req.user.id);
  log(req, 'requirement_add', 'pds', p.pds_code, text.slice(0, 120));
  res.status(201).json(pdsRequirements(p.id));
});

router.delete('/requirements/:id', admin, (req, res) => {
  const r = db.prepare('SELECT * FROM pds_requirements WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM pds_requirements WHERE id = ?').run(r.id);
  log(req, 'requirement_remove', 'pds', getPdsById(r.pds_id)?.pds_code, r.text.slice(0, 120));
  res.json(pdsRequirements(r.pds_id));
});

// ===================== slots + queue (AD-06, AD-07) =====================
router.get('/slots', (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : currentWeek();
  const weeks = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 26);
  const label = labelFor(req.user);
  res.json({ ...calendar({ from, weeks, label }), current_week: currentWeek(), queue: queueShape(req.user) });
});

function queueShape(user) {
  const q = queueView();
  const label = labelFor(user);
  return {
    waiting: q.waiting.map(({ pds: p, estimate }, i) => ({ position: i + 1, ...label(p), size_weeks: p.size_weeks, priority_boost: p.priority_boost, priority_reason: p.priority_reason, approved_at: p.approved_at, choose_by: p.choose_by, estimate })),
    booked: q.booked.map((b) => ({ booking_id: b.id, lane: b.lane, start_week: b.start_week, end_week: b.end_week, booked_by: b.booked_by, ...label(getPdsById(b.pds_id)) })),
  };
}
router.get('/queue', (req, res) => res.json(queueShape(req.user)));

router.put('/slots/capacity', admin, (req, res) => {
  setCapacity(req.body?.parallel_slots, req.body?.hours_per_week, req.user);
  log(req, 'slot_capacity', 'slots', null, `${req.body.parallel_slots} slots x ${req.body.hours_per_week} h/week`);
  res.json(capacity());
});

router.post('/slots/assign', admin, (req, res) => {
  const p = getPdsByCode(req.body?.code);
  if (!p) return res.status(404).json({ error: 'PDS not found' });
  const b = book(p.id, String(req.body?.lane || ''), String(req.body?.start_week || ''), 'admin', req.user);
  log(req, 'slot_assign', 'pds', p.pds_code, `${b.lane} ${b.start_week}`);
  res.status(201).json(b);
});

router.post('/slots/move', admin, (req, res) => {
  const reason = requireText(req.body?.reason, 300, 'Reason');
  const b = moveBooking(Number(req.body?.booking_id), String(req.body?.lane || ''), String(req.body?.start_week || ''), reason, req.user);
  log(req, 'slot_move', 'booking', b.id, `${b.lane} ${b.start_week}: ${reason}`);
  res.json(b);
});

router.post('/slots/swap', admin, (req, res) => {
  const reason = requireText(req.body?.reason, 300, 'Reason');
  swapBookings(Number(req.body?.a), Number(req.body?.b), reason);
  log(req, 'slot_swap', 'booking', `${req.body.a},${req.body.b}`, reason);
  res.json({ ok: true });
});

router.post('/slots/block', admin, (req, res) => {
  const reason = requireText(req.body?.reason, 300, 'Reason');
  blockWeek(String(req.body?.lane || ''), String(req.body?.week_start || ''), reason);
  log(req, 'slot_block', 'slot', `${req.body.lane} ${req.body.week_start}`, reason);
  res.status(201).json({ ok: true });
});

router.delete('/slots/block/:id', admin, (req, res) => {
  unblockWeek(Number(req.params.id));
  log(req, 'slot_unblock', 'slot', req.params.id);
  res.json({ ok: true });
});

router.post('/slots/cancel', admin, (req, res) => {
  const p = getPdsByCode(req.body?.code);
  if (!p) return res.status(404).json({ error: 'PDS not found' });
  const reason = requireText(req.body?.reason, 300, 'Reason');
  cancelBooking(p.id, req.user, { byAdmin: true, reason });
  log(req, 'slot_cancel', 'pds', p.pds_code, reason);
  res.json({ ok: true });
});

/** SL-10: raise priority for urgent cases - always with a reason. */
router.post('/queue/:code/priority', admin, (req, res) => {
  const p = loadPds(req);
  const boost = Math.round(Number(req.body?.boost));
  if (!(boost >= 0 && boost <= 10)) return res.status(400).json({ error: 'Priority must be 0 to 10' });
  const reason = boost ? requireText(req.body?.reason, 300, 'Reason') : null;
  db.prepare('UPDATE pds SET priority_boost = ?, priority_reason = ? WHERE id = ?').run(boost, reason, p.id);
  log(req, 'queue_priority', 'pds', p.pds_code, `${p.priority_boost} -> ${boost}${reason ? `: ${reason}` : ''}`);
  res.json(queueShape(req.user));
});

// ===================== moderation (AD-08, CM-07) =====================
router.get('/moderation', admin, (_req, res) => {
  const reported = db
    .prepare(
      `SELECT c.id, c.text, c.is_hidden, c.created_at, c.user_id, u.display_name AS author, u.is_blocked AS author_blocked, p.pds_code, p.title,
              COUNT(r.id) AS reports, GROUP_CONCAT(DISTINCT r.reason) AS reasons, MAX(r.created_at) AS last_report
       FROM reports r JOIN comments c ON c.id = r.comment_id JOIN pds p ON p.id = c.pds_id LEFT JOIN users u ON u.id = c.user_id
       WHERE r.status = 'open' AND c.is_deleted = 0 GROUP BY c.id ORDER BY reports DESC, last_report DESC`,
    )
    .all();
  const hidden = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, u.display_name AS author, p.pds_code FROM comments c JOIN pds p ON p.id = c.pds_id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.is_hidden = 1 AND c.is_deleted = 0 ORDER BY c.id DESC LIMIT 50`,
    )
    .all();
  res.json({ reported, hidden });
});

function recount(pdsId) {
  db.prepare('UPDATE pds SET comment_count = (SELECT COUNT(*) FROM comments WHERE pds_id = ? AND is_deleted = 0 AND is_hidden = 0) WHERE id = ?').run(pdsId, pdsId);
}

router.post('/comments/:id/hide', admin, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const hidden = req.body?.hidden === false ? 0 : 1;
  tx(() => {
    db.prepare('UPDATE comments SET is_hidden = ? WHERE id = ?').run(hidden, c.id);
    db.prepare(`UPDATE reports SET status = ? WHERE comment_id = ? AND status = 'open'`).run('actioned', c.id);
    recount(c.pds_id);
  });
  log(req, hidden ? 'comment_hide' : 'comment_unhide', 'comment', c.id, cleanText(req.body?.reason, 300) || null);
  res.json({ ok: true });
});

router.delete('/comments/:id', admin, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  tx(() => {
    db.prepare("UPDATE comments SET is_deleted = 1, text = '' WHERE id = ?").run(c.id);
    db.prepare("UPDATE reports SET status = 'actioned' WHERE comment_id = ? AND status = 'open'").run(c.id);
    recount(c.pds_id);
  });
  log(req, 'comment_delete', 'comment', c.id, c.text.slice(0, 200));
  res.json({ ok: true });
});

router.post('/comments/:id/dismiss', admin, (req, res) => {
  db.prepare("UPDATE reports SET status = 'dismissed' WHERE comment_id = ? AND status = 'open'").run(req.params.id);
  log(req, 'report_dismiss', 'comment', req.params.id);
  res.json({ ok: true });
});

// ===================== delete a PDS =====================
/** Removes the PDS in any status (even in development or closed) with its comments, upvotes, files and slot booking. The owner gets a notification. */
router.delete('/pds/:code', admin, (req, res) => {
  const p = loadPds(req);
  const files = db.prepare('SELECT * FROM attachments WHERE pds_id = ?').all(p.id);
  const owner = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(p.user_id);
  tx(() => {
    // Releasing first lets the slot engine move the queue up before the rows disappear.
    releaseBooking(p.id);
    db.prepare('DELETE FROM pds WHERE id = ?').run(p.id);
  });
  deleteStoredFiles(files);
  if (owner && owner.id !== req.user.id) {
    notifyUser(owner, { type: 'status', message: `Your PDS ${p.pds_code} "${p.title}" was removed by the team.` });
  }
  log(req, 'pds_delete', 'pds', p.id, `${p.pds_code} ${p.title}`.slice(0, 200));
  res.json({ ok: true });
});

// ===================== users (AD-09) =====================
router.get('/users', admin, (req, res) => {
  const where = ['u.deleted_at IS NULL'];
  const args = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    // Exact email / mobile match through the HMAC, or a display-name search.
    if (q.includes('@')) where.push('u.email_hmac = ?'), args.push(hmac(normEmail(q), 'email'));
    else if (/^[+\d][\d\s-]{7,}$/.test(q)) where.push('u.phone_hmac = ?'), args.push(hmac(normPhone(q), 'phone'));
    else where.push('u.display_name LIKE ?'), args.push(`%${q}%`);
  }
  if (req.query.role && ROLES.includes(req.query.role)) where.push('u.role = ?'), args.push(req.query.role);
  if (req.query.blocked === '1') where.push('u.is_blocked = 1');
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM pds WHERE user_id = u.id AND status != 'draft') AS pds_count,
              (SELECT COUNT(*) FROM comments WHERE user_id = u.id AND is_deleted = 0) AS comment_count,
              q.label AS source
       FROM users u LEFT JOIN qr_codes q ON q.id = u.source_qr_id WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT 200`,
    )
    .all(...args);
  log(req, 'users_view', 'user', null, q ? `search` : null);
  res.json(
    rows.map((u) => ({
      id: u.id,
      display_name: u.display_name,
      full_name: decrypt(u.full_name_enc),
      email: decrypt(u.email_enc),
      phone: decrypt(u.phone_enc),
      must_change_password: !!u.must_change_password,
      role: u.role,
      mfa_enabled: !!u.mfa_enabled,
      is_blocked: !!u.is_blocked,
      block_reason: u.block_reason,
      pds_count: u.pds_count,
      comment_count: u.comment_count,
      source: u.source,
      last_login_at: u.last_login_at,
      created_at: u.created_at,
    })),
  );
});

router.post('/users/:id/block', admin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot block yourself' });
  if (atLeast(u, 'admin') && !atLeast(req.user, 'super_admin')) return res.status(403).json({ error: 'Only a Super Admin can block an admin' });
  const blocked = req.body?.blocked === false ? 0 : 1;
  const reason = blocked ? requireText(req.body?.reason, 300, 'Reason') : null;
  db.prepare('UPDATE users SET is_blocked = ?, block_reason = ? WHERE id = ?').run(blocked, reason, u.id);
  if (blocked) revokeAllSessions(u.id);
  log(req, blocked ? 'user_block' : 'user_unblock', 'user', u.id, reason);
  res.json({ ok: true });
});

router.post('/users/:id/warn', admin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const message = requireText(req.body?.message, 600, 'Message');
  notifyUser(u, { type: 'warning', message: `Message from the moderators: ${message}` });
  log(req, 'user_warn', 'user', u.id, message.slice(0, 200));
  res.json({ ok: true });
});

router.patch('/users/:id/role', superAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const role = String(req.body?.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  revokeAllSessions(u.id); // new permissions (and the 2FA requirement) apply from the next login
  if (role !== 'user') notifyUser(u, { type: 'security', message: `You are now a ${ROLE_LABELS[role]}. Log in again to open the team panel.`, link: '/admin/is/login' });
  log(req, 'user_role', 'user', u.id, `${u.role} -> ${role}`);
  res.json({ ok: true });
});

/**
 * Forgotten password: an admin gives the person a temporary password (shown once) and tells them in person
 * or on WhatsApp. They must choose a new password right after logging in. Only a Super Admin may do this for an admin.
 */
router.post('/users/:id/temp-password', admin, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Change your own password from your Profile' });
  if (atLeast(u, 'admin') && !atLeast(req.user, 'super_admin')) return res.status(403).json({ error: 'Only a Super Admin can reset an admin\'s password' });
  const password = temporaryPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(await bcrypt.hash(password, BCRYPT_COST), u.id);
  revokeAllSessions(u.id);
  log(req, 'user_temp_password', 'user', u.id);
  res.json({ password });
});

router.post('/users/:id/reset-mfa', superAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Ask another Super Admin to reset your two-factor authentication' });
  resetTwoFactor(u.id);
  log(req, 'user_mfa_reset', 'user', u.id);
  res.json({ ok: true });
});

/** Same as the user deleting their own account: personal data removed, public posts stay as "Deleted user". */
router.delete('/users/:id', admin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account here. Use your Profile page.' });
  if (atLeast(u, 'admin') && !atLeast(req.user, 'super_admin')) return res.status(403).json({ error: 'Only a Super Admin can delete an admin' });
  if (isLastSuperAdmin(u)) return res.status(400).json({ error: 'This is the only Super Admin. Give the role to someone else first.' });
  deleteAccount(u, 'Account deleted by the team');
  log(req, 'user_delete', 'user', u.id, u.display_name);
  res.json({ ok: true });
});

// ===================== QR codes (AD-11) =====================
const qrUrl = (slug) => `${PUBLIC_URL}/q/${slug}`;

router.get('/qr', admin, (_req, res) => {
  const rows = db
    .prepare('SELECT q.*, (SELECT COUNT(*) FROM users u WHERE u.source_qr_id = q.id) AS signups, (SELECT COUNT(*) FROM pds p WHERE p.source_qr_id = q.id) AS pds_count FROM qr_codes q ORDER BY q.id DESC')
    .all();
  res.json(rows.map((q) => ({ ...q, url: qrUrl(q.slug) })));
});

router.post('/qr', admin, (req, res) => {
  const label = cleanText(req.body?.label, 80);
  if (!label) return res.status(400).json({ error: 'Add a label, e.g. "College event"' });
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'qr';
  const slug = `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'x'}`;
  const r = db.prepare('INSERT INTO qr_codes (label, slug) VALUES (?, ?)').run(label, slug);
  log(req, 'qr_create', 'qr', r.lastInsertRowid, label);
  res.status(201).json({ id: Number(r.lastInsertRowid), slug, url: qrUrl(slug) });
});

router.patch('/qr/:id', admin, (req, res) => {
  const q = db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const label = req.body?.label !== undefined ? cleanText(req.body.label, 80) || q.label : q.label;
  const active = req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : q.is_active;
  db.prepare('UPDATE qr_codes SET label = ?, is_active = ? WHERE id = ?').run(label, active, q.id);
  log(req, 'qr_update', 'qr', q.id, `${label} (${active ? 'on' : 'off'})`);
  res.json({ ok: true });
});

router.delete('/qr/:id', admin, (req, res) => {
  db.prepare('DELETE FROM qr_codes WHERE id = ?').run(req.params.id);
  log(req, 'qr_delete', 'qr', req.params.id);
  res.json({ ok: true });
});

router.get('/qr/:id/image', admin, async (req, res) => {
  const q = db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).end();
  const opts = { margin: 2, width: Math.min(Number(req.query.size) || 1024, 2048), color: { dark: '#0A0A0B', light: '#FFFFFF' }, errorCorrectionLevel: 'H' };
  const name = `intelsquad-qr-${q.slug}`;
  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${name}.svg"`);
    return res.send(await QRCode.toString(qrUrl(q.slug), { ...opts, type: 'svg' }));
  }
  res.setHeader('Content-Type', 'image/png');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${name}.png"`);
  res.send(await QRCode.toBuffer(qrUrl(q.slug), opts));
});

// ===================== audit log (AD-13) + settings =====================
router.get('/audit', admin, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.action) where.push('a.action LIKE ?'), args.push(`%${req.query.action}%`);
  if (req.query.actor) where.push('u.display_name LIKE ?'), args.push(`%${req.query.actor}%`);
  const rows = db
    .prepare(`SELECT a.*, u.display_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 300`)
    .all(...args);
  res.json(rows);
});

router.get('/settings', admin, (_req, res) => res.json({ ...getSettings(), capacity: capacity() }));

router.put('/settings', admin, (req, res) => {
  if (req.body?.require_team_2fa !== undefined) {
    if (!atLeast(req.user, 'super_admin')) return res.status(403).json({ error: 'Only a Super Admin can change the two-factor rule' });
    req.body.require_team_2fa = req.body.require_team_2fa === false || req.body.require_team_2fa === 'false' ? 'false' : 'true';
  }
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (req.body?.[k] !== undefined) up.run(k, cleanText(req.body[k], 2000));
  log(req, 'settings_update', 'settings', null, Object.keys(req.body ?? {}).join(', '));
  res.json(getSettings());
});

router.get('/meta', (_req, res) => {
  res.json({
    team: db.prepare("SELECT id, display_name, role FROM users WHERE role != 'user' AND deleted_at IS NULL AND is_blocked = 0 ORDER BY display_name").all(),
    current_week: currentWeek(),
    next_weeks: Array.from({ length: 12 }, (_, i) => addWeeks(currentWeek(), i)),
  });
});

export default router;
