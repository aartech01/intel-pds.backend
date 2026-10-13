import { db } from './db.js';
import { onlyUsers, publish } from './live.js';

// Notifications live in the app only (the bell and the Notifications page). There is no email or SMS.

/** Notify a user in the app. `link` is an app path, e.g. /pds/PDS-2026-0042. */
export function notifyUser(userOrId, { type, message, link = null }) {
  const user = typeof userOrId === 'object' ? userOrId : db.prepare('SELECT * FROM users WHERE id = ?').get(userOrId);
  if (!user || user.deleted_at) return;
  db.prepare('INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)').run(user.id, type, message, link);
  publish(['notifications'], onlyUsers(user.id));
}

/** Notify every active admin in the app. */
export function notifyAdmins(message, link = null) {
  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin') AND is_blocked = 0 AND deleted_at IS NULL").all();
  const add = db.prepare("INSERT INTO notifications (user_id, type, message, link) VALUES (?, 'admin', ?, ?)");
  for (const a of admins) add.run(a.id, message, link);
  publish(['notifications'], onlyUsers(...admins.map((a) => a.id)));
}
