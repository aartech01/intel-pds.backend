import { Router } from 'express';
import { db, audit, getSettings } from '../db.js';
import { safeEqual } from '../crypto.js';
import { STATUSES } from '../constants.js';
import { cleanText, limits } from '../security.js';
import { capacity, currentWeek, queueView } from '../slots.js';
import { getPdsByCode } from '../pds.js';
import { pdsPayload } from '../webhooks.js';
import { PUBLIC_URL } from '../config.js';

// Endpoints for automation (n8n), outside the cookie/CSRF session flow.
// Every call needs "Authorization: Bearer <N8N_API_TOKEN>". Without the env var the routes do not exist.
// Like the outgoing events, nothing here returns an email, mobile number or full name.

const TOKEN = process.env.N8N_API_TOKEN || '';
const router = Router();

router.use(limits.integration, (req, res, next) => {
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN || !given || !safeEqual(given, TOKEN)) return res.status(TOKEN ? 401 : 404).json({ error: TOKEN ? 'Invalid token' : 'Not found' });
  next();
});

const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) ?? {})[0] ?? 0;

/** Daily or weekly digest: what happened in the period and what needs attention now. */
router.get('/report', (req, res) => {
  const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
  const since = period === 'weekly' ? '-7 days' : '-1 day';
  const sla = Number(getSettings().review_sla_hours || 48);
  const byStatus = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM pds WHERE status != 'draft' GROUP BY status").all().map((r) => [STATUSES[r.status]?.label ?? r.status, r.n]),
  );
  const cap = capacity();
  const week = currentWeek();
  const busy = one("SELECT COUNT(DISTINCT lane) FROM slots WHERE week_start = ? AND status IN ('booked','in_development','testing')", week);
  const blocked = one("SELECT COUNT(DISTINCT lane) FROM slots WHERE week_start = ? AND status = 'blocked'", week);
  const q = queueView();
  const brief = (p) => ({ code: p.pds_code, title: p.title, urgency: p.urgency, url: `${PUBLIC_URL}/admin/pds/${p.pds_code}` });

  res.json({
    period,
    generated_at: new Date().toISOString(),
    in_period: {
      new_pds: db.prepare("SELECT * FROM pds WHERE submitted_at >= datetime('now', ?) ORDER BY submitted_at").all(since).map(brief),
      approved: one("SELECT COUNT(*) FROM status_history WHERE new_status = 'approved' AND created_at >= datetime('now', ?)", since),
      rejected: one("SELECT COUNT(*) FROM status_history WHERE new_status = 'rejected' AND created_at >= datetime('now', ?)", since),
      delivered: one("SELECT COUNT(*) FROM status_history WHERE new_status = 'delivered' AND created_at >= datetime('now', ?)", since),
      closed: one("SELECT COUNT(*) FROM status_history WHERE new_status = 'closed' AND created_at >= datetime('now', ?)", since),
      comments: one("SELECT COUNT(*) FROM comments WHERE is_deleted = 0 AND created_at >= datetime('now', ?)", since),
      new_users: one("SELECT COUNT(*) FROM users WHERE role = 'user' AND deleted_at IS NULL AND created_at >= datetime('now', ?)", since),
    },
    now: {
      by_status: byStatus,
      in_development: db
        .prepare("SELECT * FROM pds WHERE status IN ('in_development','testing') ORDER BY updated_at DESC")
        .all()
        .map((p) => ({ ...brief(p), status: STATUSES[p.status].label, progress: p.progress_percent ?? 0 })),
      waiting_for_slot: q.waiting.map((w) => ({ ...brief(w.pds), size_weeks: w.pds.size_weeks, estimated_start: w.estimate?.start_week ?? null })),
      overdue_reviews: db
        .prepare("SELECT * FROM pds WHERE status = 'submitted' AND submitted_at <= datetime('now', ?) ORDER BY submitted_at")
        .all(`-${sla} hours`)
        .map((p) => ({ ...brief(p), submitted_at: p.submitted_at })),
      need_more_info: one("SELECT COUNT(*) FROM pds WHERE status = 'need_info'"),
      open_reports: one("SELECT COUNT(*) FROM reports WHERE status = 'open'"),
      slots_this_week: { teams: cap.parallel_slots, busy, blocked, free: Math.max(cap.parallel_slots - busy - blocked, 0) },
      avg_rating: one('SELECT ROUND(AVG(rating), 1) FROM pds WHERE rating IS NOT NULL') || null,
      review_target_hours: sla,
    },
  });
});

/** One PDS with its visible comments - the input for an AI summary. */
router.get('/pds/:code', (req, res) => {
  const p = getPdsByCode(req.params.code);
  if (!p || p.status === 'draft') return res.status(404).json({ error: 'PDS not found' });
  const comments = db
    .prepare(
      `SELECT c.id, c.comment_type AS type, c.text, c.is_team AS team, c.parent_id, c.created_at,
              CASE WHEN u.deleted_at IS NOT NULL OR u.id IS NULL THEN 'Deleted user' ELSE u.display_name END AS by
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.pds_id = ? AND c.is_deleted = 0 AND c.is_hidden = 0 ORDER BY c.id`,
    )
    .all(p.id)
    .map((c) => ({ ...c, team: !!c.team }));
  res.json({ ...pdsPayload(p, { withText: true }), comments });
});

/** AI summary written back as an internal team note (never shown to users). */
router.post('/pds/:code/summary', (req, res) => {
  const p = getPdsByCode(req.params.code);
  if (!p) return res.status(404).json({ error: 'PDS not found' });
  const text = cleanText(req.body?.text, 4000);
  if (!text) return res.status(400).json({ error: 'Summary text is required' });
  db.prepare('INSERT INTO pds_notes (pds_id, user_id, text) VALUES (?, NULL, ?)').run(p.id, `AI summary (n8n):\n${text}`);
  audit(null, 'ai_summary', { type: 'pds', id: p.pds_code, ip: req.ip });
  res.status(201).json({ ok: true });
});

router.use((_req, res) => res.status(404).json({ error: 'Not found' }));

export default router;
