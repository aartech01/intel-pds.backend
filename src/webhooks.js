import { db } from './db.js';
import { PUBLIC_URL } from './config.js';

// Outgoing events for automation (n8n). Off unless N8N_WEBHOOK_URL is set.
// Each event is POSTed as JSON with the shared secret in the X-IntelSquad-Token header
// (n8n's Webhook node checks it with "Header Auth"). Sending never blocks or breaks a request:
// it runs after the current request finishes, retries 3 times, then gives up with a log line.
// Privacy: no email, mobile or full name is ever sent - only display names, as on the public board.

const URL_ = process.env.N8N_WEBHOOK_URL || '';
const SECRET = process.env.N8N_WEBHOOK_SECRET || '';
const TIMEOUT_MS = 10_000;
export const webhooksEnabled = !!(URL_ && SECRET);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(body) {
  let problem = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intelsquad-token': SECRET },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
      problem = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break; // wrong URL or token: retrying will not help
    } catch (e) {
      problem = e.message;
    }
    if (attempt < 3) await sleep(attempt * 2000);
  }
  console.warn(`[n8n] ${body.event} not delivered: ${problem}`);
}

/** Public-safe view of a PDS for automation. `withText` adds the problem and expected result. */
export function pdsPayload(pds, { withText = false } = {}) {
  const owner = db.prepare('SELECT display_name, deleted_at FROM users WHERE id = ?').get(pds.user_id);
  const assignee = pds.assigned_to ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(pds.assigned_to) : null;
  const b = db.prepare("SELECT lane, start_week, end_week FROM bookings WHERE pds_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1").get(pds.id);
  const sunday = (monday) => new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10);
  return {
    code: pds.pds_code,
    title: pds.title,
    type: pds.type,
    urgency: pds.urgency,
    visibility: pds.visibility,
    status: pds.status,
    owner: owner && !owner.deleted_at ? owner.display_name : 'Deleted user',
    assigned_to: assignee?.display_name ?? null,
    upvotes: pds.upvote_count ?? 0,
    comments: pds.comment_count ?? 0,
    progress: pds.progress_percent ?? 0,
    schedule: b ? { team: `Team ${b.lane.charCodeAt(0) - 64}`, start: b.start_week, end: sunday(b.end_week) } : null,
    admin_url: `${PUBLIC_URL}/admin/pds/${pds.pds_code}`,
    url: `${PUBLIC_URL}/pds/${pds.pds_code}`,
    ...(withText ? { problem_statement: pds.problem_statement, expected_result: pds.expected_result } : {}),
  };
}

/**
 * Queue an event for n8n. `check` runs just before sending; return false to drop the event
 * (used to skip events whose database transaction was rolled back).
 */
export function emit(event, data, { check } = {}) {
  if (!webhooksEnabled) return;
  setImmediate(() => {
    try {
      if (check && !check()) return;
      const payload = typeof data === 'function' ? data() : data;
      send({ event, at: new Date().toISOString(), source: 'intelsquad', data: payload });
    } catch (e) {
      console.warn(`[n8n] ${event} skipped: ${e.message}`);
    }
  });
}
