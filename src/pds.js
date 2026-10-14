import { db, httpError } from './db.js';
import { STATUSES, isStaff } from './constants.js';
import { notifyUser } from './messaging.js';
import { signedUrl } from './storage.js';
import { EVERYONE, either, pdsAudience, publish } from './live.js';
import { emit, pdsPayload } from './webhooks.js';

const sqlNow = () => db.prepare("SELECT datetime('now') AS t").get().t;
export const DELETED_NAME = 'Deleted user';

export function nextPdsCode() {
  const year = new Date().getUTCFullYear();
  const last = db.prepare('SELECT pds_code FROM pds WHERE pds_code LIKE ? ORDER BY id DESC LIMIT 1').get(`PDS-${year}-%`);
  const n = last ? Number(last.pds_code.split('-')[2]) + 1 : 1;
  return `PDS-${year}-${String(n).padStart(4, '0')}`;
}

export const getPdsByCode = (code) => db.prepare('SELECT * FROM pds WHERE pds_code = ?').get(String(code || '').toUpperCase());
export const getPdsById = (id) => db.prepare('SELECT * FROM pds WHERE id = ?').get(id);

/**
 * Who can see a PDS (CD-06, §13.4): drafts - owner only; private - owner and team;
 * public - any logged-in user. Callers answer 404 (not 403) so private PDS existence is not leaked.
 */
export function canView(pds, user) {
  if (!pds || !user) return false;
  if (pds.user_id === user.id) return true;
  if (pds.status === 'draft') return false;
  if (isStaff(user)) return true;
  return pds.visibility === 'public' && pds.status !== 'withdrawn';
}

export function loadVisiblePds(code, user) {
  const p = getPdsByCode(code);
  if (!canView(p, user)) throw httpError(404, 'PDS not found');
  return p;
}

/** Change status, record history and tell the owner (PRD §6 step 11: user notified at each step). */
export function changeStatus(pds, to, actor, { note = null, kind = 'team', notify = true } = {}) {
  if (!STATUSES[to]) throw httpError(400, 'Unknown status');
  if (pds.status === to) return pds;
  const now = sqlNow();
  const sets = ['status = ?', 'updated_at = ?'];
  const args = [to, now];
  const stamp = { submitted: 'submitted_at', under_review: 'reviewed_at', approved: 'approved_at', delivered: 'delivered_at', closed: 'closed_at' }[to];
  if (stamp) sets.push(`${stamp} = COALESCE(${stamp}, ?)`), args.push(now);
  if (['rejected', 'need_info'].includes(to)) sets.push('status_reason = ?'), args.push(note);
  if (to === 'delivered') sets.push('progress_percent = 100');
  db.prepare(`UPDATE pds SET ${sets.join(', ')} WHERE id = ?`).run(...args, pds.id);
  db.prepare('INSERT INTO status_history (pds_id, old_status, new_status, changed_by, actor, note) VALUES (?, ?, ?, ?, ?, ?)').run(pds.id, pds.status, to, actor?.id ?? null, kind, note);
  publish(['pds', `pds:${pds.pds_code}`], either(pdsAudience(pds), pdsAudience({ ...pds, status: to })));
  publish(['slots'], EVERYONE);
  // Automation (n8n). New submissions have their own richer 'pds.submitted' event.
  if (to !== 'submitted') {
    emit('pds.status_changed', () => ({ ...pdsPayload(getPdsById(pds.id)), from: pds.status, to, label: STATUSES[to].label, note, changed_by: kind }), {
      check: () => getPdsById(pds.id)?.status === to,
    });
  }

  if (notify && actor?.id !== pds.user_id) {
    const label = STATUSES[to].label;
    const extra = {
      queued: note,
      rejected: note ? `Reason: ${note}` : null,
      need_info: note ? `The team asked: ${note}` : 'Reply in the comments.',
      delivered: 'Please check it, then confirm and rate.',
    }[to];
    notifyUser(pds.user_id, { type: 'status', message: [`${pds.pds_code} is now "${label}".`, extra].filter(Boolean).join(' '), link: `/pds/${pds.pds_code}` });
  }
  return getPdsById(pds.id);
}

export function touch(pdsId) {
  db.prepare("UPDATE pds SET updated_at = datetime('now') WHERE id = ?").run(pdsId);
}

const authorName = (u) => (u == null || u.deleted_at ? DELETED_NAME : u.display_name);

// Prepared once: pdsCard runs for every card on every board and list page.
const ownerStmt = db.prepare('SELECT display_name, deleted_at FROM users WHERE id = ?');
const latestBookingStmt = db.prepare("SELECT lane, start_week, end_week, status FROM bookings WHERE pds_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1");

/** Card / list shape - only the display name is public (CD-05). */
export function pdsCard(p, viewer) {
  const owner = ownerStmt.get(p.user_id);
  const booking = latestBookingStmt.get(p.id);
  return {
    code: p.pds_code,
    title: p.title,
    type: p.type,
    problem_short: p.problem_statement.length > 180 ? `${p.problem_statement.slice(0, 177)}...` : p.problem_statement,
    urgency: p.urgency,
    visibility: p.visibility,
    status: p.status,
    author: authorName(owner),
    is_mine: viewer?.id === p.user_id,
    upvotes: p.upvote_count,
    comments: p.comment_count,
    progress: p.progress_percent,
    size_weeks: p.size_weeks,
    booking: booking ?? null,
    created_at: p.created_at,
    submitted_at: p.submitted_at,
    updated_at: p.updated_at,
  };
}

export function pdsAttachments(pdsId) {
  return db
    .prepare('SELECT id, file_name, file_type, size, created_at FROM attachments WHERE pds_id = ? ORDER BY id')
    .all(pdsId)
    .map((a) => ({ ...a, url: signedUrl(a.id) }));
}

/** Comments with one level of replies (CM-03). Hidden comments are masked for non-staff. */
export function pdsComments(pds, viewer) {
  const staff = isStaff(viewer);
  const rows = db
    .prepare(
      `SELECT c.*, u.display_name, u.deleted_at AS author_deleted,
              (SELECT COUNT(*) FROM reports r WHERE r.comment_id = c.id AND r.status = 'open') AS open_reports,
              (SELECT 1 FROM reports r WHERE r.comment_id = c.id AND r.reported_by = ?) AS reported_by_me
       FROM comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.pds_id = ? ORDER BY c.created_at, c.id`,
    )
    .all(viewer?.id ?? null, pds.id);
  const shape = (c) => {
    const masked = c.is_deleted || (c.is_hidden && !staff);
    return {
      id: c.id,
      parent_id: c.parent_id,
      type: c.comment_type,
      text: c.is_deleted ? null : masked ? null : c.text,
      state: c.is_deleted ? 'deleted' : c.is_hidden ? 'hidden' : 'visible',
      author: c.author_deleted || !c.user_id ? DELETED_NAME : c.display_name,
      is_team: !!c.is_team,
      is_owner: c.user_id === pds.user_id,
      is_mine: !!viewer && c.user_id === viewer.id,
      is_useful: !!c.is_useful,
      edited: !!c.edited_at,
      reported_by_me: !!c.reported_by_me,
      open_reports: staff ? c.open_reports : undefined,
      created_at: c.created_at,
    };
  };
  const top = rows.filter((c) => !c.parent_id).map((c) => ({ ...shape(c), replies: [] }));
  const byId = new Map(top.map((c) => [c.id, c]));
  for (const r of rows.filter((c) => c.parent_id)) byId.get(r.parent_id)?.replies.push(shape(r));
  // Drop deleted top-level comments that have no replies left to give context to.
  return top.filter((c) => c.state !== 'deleted' || c.replies.length);
}

export function pdsTimeline(pdsId, { staff }) {
  return db
    .prepare(
      `SELECT h.old_status, h.new_status, h.note, h.actor, h.created_at, u.display_name AS by_name
       FROM status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.pds_id = ? ORDER BY h.id`,
    )
    .all(pdsId)
    .map((h) => ({ ...h, label: STATUSES[h.new_status]?.label, by_name: staff ? h.by_name : undefined }));
}

export function pdsProgress(pdsId) {
  return db
    .prepare('SELECT p.percent, p.note, p.created_at, u.display_name AS by_name FROM progress_updates p LEFT JOIN users u ON u.id = p.created_by WHERE p.pds_id = ? ORDER BY p.id DESC')
    .all(pdsId);
}

export function pdsRequirements(pdsId) {
  return db.prepare('SELECT id, comment_id, text, created_at FROM pds_requirements WHERE pds_id = ? ORDER BY id').all(pdsId);
}

export function openPdsCount(userId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM pds WHERE user_id = ? AND status NOT IN ('draft','closed','rejected','withdrawn')`)
    .get(userId).n;
}
