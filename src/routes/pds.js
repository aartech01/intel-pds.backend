import { Router } from 'express';
import { db, tx, httpError, audit } from '../db.js';
import { requireUser } from '../auth.js';
import {
  COMMENT_TYPE_KEYS, EDITABLE_STATUSES, LIMITS, TYPE_KEYS, URGENCY, WITHDRAWABLE_STATUSES, atLeast, isStaff,
} from '../constants.js';
import { blockedWordIn, cleanText, clientIp, limits, requireText } from '../security.js';
import {
  canView, changeStatus, getPdsById, loadVisiblePds, nextPdsCode, openPdsCount, pdsAttachments, pdsCard, pdsComments, pdsProgress,
  pdsRequirements, pdsTimeline, touch,
} from '../pds.js';
import {
  activeBooking, bookingFor, calendar, cancelBooking, estimateFor, queueView,
} from '../slots.js';
import { upload, validateUploads, saveAttachments, deleteStoredFiles, removeTemp } from '../storage.js';
import { notifyAdmins, notifyUser } from '../messaging.js';
import { emit, pdsPayload } from '../webhooks.js';

const router = Router();
router.use(['/board', '/dashboard', '/pds-similar', '/pds', '/comments'], requireUser);

// ---------- helpers ----------
/** What a viewer may see about a PDS on the calendar / queue (private titles stay hidden). */
export const labelFor = (viewer) => (p) =>
  p.pds_code && (p.visibility === 'public' || isStaff(viewer) || p.user_id === viewer?.id)
    ? { code: p.pds_code, title: p.title, mine: p.user_id === viewer?.id }
    : { code: null, title: 'Private PDS', mine: false };

function readForm(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('title')) out.title = requireText(body.title, LIMITS.title, 'PDS title');
  if (has('type')) {
    if (!TYPE_KEYS.includes(body.type)) throw httpError(400, 'Choose a type', { fields: { type: 'Choose a type' } });
    out.type = body.type;
  }
  if (has('problem_statement')) out.problem_statement = requireText(body.problem_statement, LIMITS.problem, 'Problem statement');
  if (has('expected_result')) {
    const e = cleanText(body.expected_result);
    if (e.length > LIMITS.expected) throw httpError(400, `Expected result must be ${LIMITS.expected} characters or fewer`);
    out.expected_result = e || null;
  }
  if (has('urgency')) {
    if (!URGENCY.includes(body.urgency)) throw httpError(400, 'Choose the urgency', { fields: { urgency: 'Choose the urgency' } });
    out.urgency = body.urgency;
  }
  if (has('visibility')) out.visibility = body.visibility === 'private' ? 'private' : 'public';
  return out;
}

function checkOpenLimit(userId) {
  if (openPdsCount(userId) >= LIMITS.openPdsPerUser) {
    throw httpError(400, `You can have up to ${LIMITS.openPdsPerUser} open PDS at a time. Wait for one to finish or withdraw one first.`, { code: 'open_limit' });
  }
}

const recountComments = (pdsId) =>
  db.prepare('UPDATE pds SET comment_count = (SELECT COUNT(*) FROM comments WHERE pds_id = ? AND is_deleted = 0 AND is_hidden = 0) WHERE id = ?').run(pdsId, pdsId);

// ---------- community board (CD-01, CD-02) ----------
router.get('/board', (req, res) => {
  const q = req.query;
  const where = ["p.visibility = 'public'", "p.status NOT IN ('draft','withdrawn')"];
  const args = [];
  if (q.status) {
    const s = String(q.status).split(',').filter(Boolean);
    where.push(`p.status IN (${s.map(() => '?').join(',')})`);
    args.push(...s);
  } else where.push("p.status != 'rejected'");
  if (q.type && TYPE_KEYS.includes(q.type)) where.push('p.type = ?'), args.push(q.type);
  if (q.q) {
    const like = `%${String(q.q).trim().slice(0, 80).replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.problem_statement LIKE ? ESCAPE '\\' OR p.pds_code LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const order = { upvoted: 'p.upvote_count DESC, p.submitted_at DESC', discussed: 'p.comment_count DESC, p.submitted_at DESC' }[q.sort] || 'p.submitted_at DESC';
  const pageSize = 12;
  const page = Math.max(1, Number(q.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM pds p WHERE ${where.join(' AND ')}`).get(...args).n;
  const rows = db.prepare(`SELECT p.* FROM pds p WHERE ${where.join(' AND ')} ORDER BY ${order}, p.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  const voted = new Set(db.prepare('SELECT pds_id FROM upvotes WHERE user_id = ?').all(req.user.id).map((r) => r.pds_id));
  res.json({ total, page, pageSize, rows: rows.map((p) => ({ ...pdsCard(p, req.user), upvoted: voted.has(p.id) })) });
});

// ---------- dashboard (PRD §9.1) ----------
router.get('/dashboard', (req, res) => {
  const label = labelFor(req.user);
  const now = db
    .prepare(
      `SELECT b.*, p.pds_code, p.title, p.visibility, p.user_id, p.progress_percent, p.type FROM bookings b JOIN pds p ON p.id = b.pds_id
       WHERE b.status IN ('in_development','testing') ORDER BY b.lane`,
    )
    .all()
    .map((b) => ({ lane: b.lane, status: b.status, start_week: b.start_week, end_week: b.end_week, progress: b.progress_percent, type: b.type, ...label(b) }));
  const q = queueView();
  const upNext = [
    ...q.booked.map((b) => {
      const p = getPdsById(b.pds_id);
      return { kind: 'booked', lane: b.lane, start_week: b.start_week, end_week: b.end_week, type: p.type, ...label(p) };
    }),
    ...q.waiting.map(({ pds: p, estimate }, i) => ({ kind: 'waiting', position: i + 1, estimate, size_weeks: p.size_weeks, type: p.type, ...label(p) })),
  ];
  const mine = db.prepare("SELECT * FROM pds WHERE user_id = ? AND status != 'withdrawn' ORDER BY updated_at DESC").all(req.user.id).map((p) => ({
    ...pdsCard(p, req.user),
    estimate: p.status === 'approved' ? estimateFor(p.id) : null,
    choose_by: p.choose_by,
    status_reason: p.status_reason,
  }));
  res.json({ now, up_next: upNext, calendar: calendar({ label }), mine });
});

// ---------- similar PDS while writing (feature idea §18) ----------
router.get('/pds-similar', (req, res) => {
  const words = [...new Set((String(req.query.q || '').toLowerCase().match(/[a-zऀ-ॿ]{4,}/g) ?? []))].slice(0, 8);
  if (!words.length) return res.json([]);
  const rows = db.prepare("SELECT * FROM pds WHERE visibility = 'public' AND status NOT IN ('draft','withdrawn','rejected') ORDER BY id DESC LIMIT 400").all();
  const scored = rows
    .map((p) => {
      const text = `${p.title} ${p.problem_statement}`.toLowerCase();
      return { p, score: words.filter((w) => text.includes(w)).length + words.filter((w) => p.title.toLowerCase().includes(w)).length };
    })
    .filter((x) => x.score >= 2 && x.p.user_id !== req.user.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  res.json(scored.map(({ p }) => ({ code: p.pds_code, title: p.title, status: p.status, comments: p.comment_count, upvotes: p.upvote_count })));
});

// ---------- create / edit (PRD §8) ----------
// Admins review and manage PDS; they do not submit their own.
const notAdmin = (req, res, next) =>
  atLeast(req.user, 'admin') ? res.status(403).json({ error: 'Admins manage requests from the admin panel and cannot share a problem', code: 'admin_cannot_share' }) : next();

router.post('/pds', limits.write, notAdmin, upload.array('files', LIMITS.filesPerPds), validateUploads, async (req, res) => {
  const submit = req.body?.action !== 'draft';
  let fields;
  try {
    // Drafts only need a title; any other field is checked only if filled in.
    const filled = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k, v]) => k !== 'title' && String(v ?? '').trim() !== ''));
    fields = submit
      ? readForm(req.body ?? {})
      : { title: requireText(req.body?.title, LIMITS.title, 'PDS title'), ...readForm(filled, { partial: true }) };
    if (submit) checkOpenLimit(req.user.id);
  } catch (e) {
    removeTemp(req.files);
    throw e;
  }
  const pdsId = tx(() => {
    const r = db
      .prepare(
        `INSERT INTO pds (pds_code, user_id, title, type, problem_statement, expected_result, urgency, visibility, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      )
      .run(nextPdsCode(), req.user.id, fields.title, fields.type || 'other', fields.problem_statement || '', fields.expected_result ?? null, fields.urgency || 'Medium', fields.visibility || 'public');
    return Number(r.lastInsertRowid);
  });
  try {
    await saveAttachments(pdsId, req.files, req.user.id);
  } catch (e) {
    db.prepare('DELETE FROM pds WHERE id = ?').run(pdsId);
    throw e;
  }
  let p = getPdsById(pdsId);
  if (submit) p = submitPds(p, req.user);
  res.status(201).json({ code: p.pds_code, status: p.status });
});

function submitPds(p, user) {
  const pds = changeStatus(p, 'submitted', user, { kind: 'user' });
  notifyAdmins(`New PDS ${pds.pds_code}: ${pds.title} (${pds.urgency} urgency)`, `/admin/pds/${pds.pds_code}`);
  emit('pds.submitted', () => pdsPayload(getPdsById(pds.id), { withText: true }));
  notifyUser(user, { type: 'status', message: `${pds.pds_code} submitted. The team reviews new PDS within 48 hours.`, link: `/pds/${pds.pds_code}` });
  return pds;
}

function ownPds(req) {
  const p = loadVisiblePds(req.params.code, req.user);
  if (p.user_id !== req.user.id) throw httpError(403, 'Only the owner can do this');
  return p;
}

router.patch('/pds/:code', limits.write, (req, res) => {
  const p = ownPds(req);
  let body = req.body ?? {};
  // Drafts may be saved half-filled: blank optional answers are simply skipped.
  if (p.status === 'draft') body = Object.fromEntries(Object.entries(body).filter(([k, v]) => k === 'title' || k === 'expected_result' || String(v ?? '').trim() !== ''));
  const contentKeys = ['title', 'type', 'problem_statement', 'expected_result', 'urgency'];
  const editsContent = contentKeys.some((k) => body[k] !== undefined);
  if (editsContent && !EDITABLE_STATUSES.includes(p.status)) {
    return res.status(400).json({ error: 'The team has started reviewing this PDS. Add new details as a comment instead.' });
  }
  const fields = readForm(body, { partial: true });
  if (p.status !== 'draft' && Object.keys(fields).some((k) => contentKeys.includes(k) && !fields[k] && k !== 'expected_result')) {
    return res.status(400).json({ error: 'Required fields cannot be empty' });
  }
  const keys = Object.keys(fields);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE pds SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), p.id);
  res.json({ ok: true });
});

router.post('/pds/:code/submit', limits.write, (req, res) => {
  const p = ownPds(req);
  if (p.status !== 'draft') return res.status(400).json({ error: 'Already submitted' });
  readForm(p); // all required fields present?
  checkOpenLimit(req.user.id);
  const out = submitPds(p, req.user);
  res.json({ code: out.pds_code, status: out.status });
});

router.post('/pds/:code/withdraw', (req, res) => {
  const p = ownPds(req);
  if (!WITHDRAWABLE_STATUSES.includes(p.status)) return res.status(400).json({ error: 'This PDS can no longer be withdrawn' });
  tx(() => {
    if (activeBooking(p.id)) cancelBooking(p.id, req.user, { byAdmin: true, reason: 'Withdrawn by the owner' });
    changeStatus(getPdsById(p.id), 'withdrawn', req.user, { kind: 'user', note: cleanText(req.body?.reason, 500) || null });
  });
  res.json({ ok: true });
});

router.delete('/pds/:code', (req, res) => {
  const p = ownPds(req);
  if (p.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be deleted. Withdraw it instead.' });
  const files = db.prepare('SELECT * FROM attachments WHERE pds_id = ?').all(p.id);
  db.prepare('DELETE FROM pds WHERE id = ?').run(p.id);
  deleteStoredFiles(files);
  res.json({ ok: true });
});

router.post('/pds/:code/attachments', limits.write, upload.array('files', LIMITS.filesPerPds), validateUploads, async (req, res) => {
  let p;
  try {
    p = ownPds(req);
    if (!EDITABLE_STATUSES.includes(p.status)) throw httpError(400, 'Files can only be changed before the review starts');
    const have = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE pds_id = ?').get(p.id).n;
    if (!req.files?.length) throw httpError(400, 'Choose a file');
    if (have + req.files.length > LIMITS.filesPerPds) throw httpError(400, `A PDS can have up to ${LIMITS.filesPerPds} files`);
  } catch (e) {
    removeTemp(req.files);
    throw e;
  }
  await saveAttachments(p.id, req.files, req.user.id);
  touch(p.id);
  res.status(201).json(pdsAttachments(p.id));
});

router.delete('/pds/:code/attachments/:id', (req, res) => {
  const p = ownPds(req);
  if (!EDITABLE_STATUSES.includes(p.status)) return res.status(400).json({ error: 'Files can only be changed before the review starts' });
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND pds_id = ?').get(req.params.id, p.id);
  if (!a) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  deleteStoredFiles([a]);
  res.json(pdsAttachments(p.id));
});

// ---------- detail (CD-03) ----------
router.get('/pds/:code', (req, res) => {
  const p = loadVisiblePds(req.params.code, req.user);
  const mine = p.user_id === req.user.id;
  const staff = isStaff(req.user);
  const upvoted = !!db.prepare('SELECT 1 FROM upvotes WHERE pds_id = ? AND user_id = ?').get(p.id, req.user.id);
  const booking = bookingFor(p.id);
  res.json({
    pds: {
      ...pdsCard(p, req.user),
      problem_statement: p.problem_statement,
      expected_result: p.expected_result,
      status_reason: p.status_reason,
      rating: p.rating,
      feedback: mine || staff ? p.feedback : undefined,
      assigned_to: staff && p.assigned_to ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(p.assigned_to)?.display_name : undefined,
    },
    upvoted,
    attachments: pdsAttachments(p.id),
    comments: pdsComments(p, req.user),
    timeline: pdsTimeline(p.id, { staff }),
    progress: pdsProgress(p.id),
    requirements: pdsRequirements(p.id),
    booking: booking && { lane: booking.lane, start_week: booking.start_week, end_week: booking.end_week, status: booking.status, week_no: booking.week_no },
    estimate: p.status === 'approved' ? estimateFor(p.id) : null,
    can: {
      edit: mine && EDITABLE_STATUSES.includes(p.status),
      change_visibility: mine && !['withdrawn'].includes(p.status),
      submit: mine && p.status === 'draft',
      withdraw: mine && WITHDRAWABLE_STATUSES.includes(p.status) && p.status !== 'draft',
      delete: mine && p.status === 'draft',
      comment: p.status !== 'draft' && p.status !== 'withdrawn' && (p.visibility === 'public' || mine || staff),
      upvote: !mine && p.visibility === 'public' && p.status !== 'draft',
      mark_useful: mine,
      confirm: mine && p.status === 'delivered',
    },
  });
});

// ---------- upvotes (CD-04) ----------
router.post('/pds/:code/upvote', (req, res) => {
  const p = loadVisiblePds(req.params.code, req.user);
  if (p.user_id === req.user.id || p.visibility !== 'public') return res.status(400).json({ error: 'You cannot upvote this PDS' });
  tx(() => {
    const r = db.prepare('INSERT OR IGNORE INTO upvotes (pds_id, user_id) VALUES (?, ?)').run(p.id, req.user.id);
    if (r.changes) db.prepare('UPDATE pds SET upvote_count = upvote_count + 1 WHERE id = ?').run(p.id);
  });
  res.json({ upvotes: getPdsById(p.id).upvote_count, upvoted: true });
});

router.delete('/pds/:code/upvote', (req, res) => {
  const p = loadVisiblePds(req.params.code, req.user);
  tx(() => {
    const r = db.prepare('DELETE FROM upvotes WHERE pds_id = ? AND user_id = ?').run(p.id, req.user.id);
    if (r.changes) db.prepare('UPDATE pds SET upvote_count = MAX(upvote_count - 1, 0) WHERE id = ?').run(p.id);
  });
  res.json({ upvotes: getPdsById(p.id).upvote_count, upvoted: false });
});

// ---------- comments (PRD §9.3) ----------
function commentText(raw) {
  const text = requireText(raw, LIMITS.comment, 'Comment');
  const bad = blockedWordIn(text);
  if (bad) throw httpError(400, 'Please keep comments friendly - your comment contains a blocked word.');
  return text;
}

router.post('/pds/:code/comments', (req, res) => {
  const p = loadVisiblePds(req.params.code, req.user);
  const staff = isStaff(req.user);
  const mine = p.user_id === req.user.id;
  if (p.status === 'draft' || p.status === 'withdrawn' || (p.visibility === 'private' && !mine && !staff)) return res.status(403).json({ error: 'You cannot comment on this PDS' });
  if (!staff) {
    const recent = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > datetime('now', '-1 hour')").get(req.user.id).n;
    if (recent >= LIMITS.commentsPerHour) return res.status(429).json({ error: `You can post up to ${LIMITS.commentsPerHour} comments an hour. Please try again later.` });
  }
  const text = commentText(req.body?.text);
  const type = COMMENT_TYPE_KEYS.includes(req.body?.type) ? req.body.type : null;
  let parent = null;
  if (req.body?.parent_id) {
    parent = db.prepare('SELECT * FROM comments WHERE id = ? AND pds_id = ?').get(req.body.parent_id, p.id);
    if (!parent || parent.is_deleted) return res.status(400).json({ error: 'That comment no longer exists' });
    if (parent.parent_id) parent = db.prepare('SELECT * FROM comments WHERE id = ?').get(parent.parent_id); // one level only (CM-03)
  }
  const id = tx(() => {
    const r = db.prepare('INSERT INTO comments (pds_id, user_id, parent_id, comment_type, text, is_team) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, req.user.id, parent?.id ?? null, parent ? null : type, text, staff ? 1 : 0);
    recountComments(p.id);
    touch(p.id);
    return Number(r.lastInsertRowid);
  });

  // CM-08: tell the owner. Replies also tell the parent comment's author.
  const who = staff ? `${req.user.display_name} (Team)` : req.user.display_name;
  if (!mine) {
    notifyUser(p.user_id, { type: 'comment', message: `${who} commented on ${p.pds_code}`, link: `/pds/${p.pds_code}#c${id}` });
  }
  if (parent && parent.user_id && parent.user_id !== req.user.id && parent.user_id !== p.user_id) {
    notifyUser(parent.user_id, { type: 'comment', message: `${who} replied to your comment on ${p.pds_code}`, link: `/pds/${p.pds_code}#c${id}` });
  }
  emit('comment.created', () => ({
    pds: pdsPayload(getPdsById(p.id)),
    comment: { id, by: req.user.display_name, team: staff, owner: mine, type, reply: !!parent, text },
  }));
  // The owner answering a team question moves the PDS back to review.
  if (mine && p.status === 'need_info') {
    changeStatus(p, 'under_review', req.user, { kind: 'user', note: 'Owner replied' });
    notifyAdmins(`${p.pds_code}: the owner replied to your question`, `/admin/pds/${p.pds_code}`);
  }
  res.status(201).json(pdsComments(getPdsById(p.id), req.user));
});

function loadComment(req) {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c || c.is_deleted) throw httpError(404, 'Comment not found');
  const p = getPdsById(c.pds_id);
  if (!canView(p, req.user)) throw httpError(404, 'Comment not found');
  return { c, p };
}

router.patch('/comments/:id', (req, res) => {
  const { c, p } = loadComment(req);
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own comments' });
  if (c.is_hidden) return res.status(400).json({ error: 'This comment was hidden by a moderator' });
  const text = commentText(req.body?.text);
  db.prepare("UPDATE comments SET text = ?, edited_at = datetime('now') WHERE id = ?").run(text, c.id);
  res.json(pdsComments(p, req.user));
});

router.delete('/comments/:id', (req, res) => {
  const { c, p } = loadComment(req);
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments' });
  tx(() => {
    db.prepare("UPDATE comments SET is_deleted = 1, text = '' WHERE id = ?").run(c.id);
    recountComments(p.id);
  });
  res.json(pdsComments(getPdsById(p.id), req.user));
});

router.post('/comments/:id/report', (req, res) => {
  const { c, p } = loadComment(req);
  if (c.user_id === req.user.id) return res.status(400).json({ error: 'You cannot report your own comment' });
  const reason = ['spam', 'abusive', 'other'].includes(req.body?.reason) ? req.body.reason : 'other';
  db.prepare('INSERT OR IGNORE INTO reports (comment_id, reported_by, reason) VALUES (?, ?, ?)').run(c.id, req.user.id, reason);
  notifyAdmins(`Comment reported on ${p.pds_code} (${reason})`, '/admin/moderation');
  emit('comment.reported', () => ({
    pds: pdsPayload(p),
    comment: { id: c.id, text: c.text },
    reason,
    open_reports: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n,
  }));
  res.json({ ok: true });
});

router.post('/comments/:id/useful', (req, res) => {
  const { c, p } = loadComment(req);
  if (p.user_id !== req.user.id && !isStaff(req.user)) return res.status(403).json({ error: 'Only the PDS owner can mark comments as useful' });
  const useful = req.body?.useful === false ? 0 : 1;
  db.prepare('UPDATE comments SET is_useful = ? WHERE id = ?').run(useful, c.id);
  if (useful && c.user_id && c.user_id !== req.user.id) {
    notifyUser(c.user_id, { type: 'comment', message: `Your comment on ${p.pds_code} was marked useful`, link: `/pds/${p.pds_code}#c${c.id}` });
  }
  res.json(pdsComments(p, req.user));
});

// ---------- delivery confirmation (§6 step 12) ----------
router.post('/pds/:code/confirm', (req, res) => {
  const p = ownPds(req);
  if (p.status !== 'delivered') return res.status(400).json({ error: 'Nothing to confirm yet' });
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose a rating from 1 to 5' });
  db.prepare('UPDATE pds SET rating = ?, feedback = ? WHERE id = ?').run(rating, cleanText(req.body?.feedback, 1000) || null, p.id);
  changeStatus(getPdsById(p.id), 'closed', req.user, { kind: 'user', note: `Rated ${rating}/5` });
  notifyAdmins(`${p.pds_code} closed - rated ${rating}/5`, `/admin/pds/${p.pds_code}`);
  res.json({ ok: true });
});

export default router;
