import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { DEFAULT_BLOCKED_WORDS } from './constants.js';

export { DATA_DIR };
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// v2 uses its own database file; the v1 request data (squaddesk.db) is left untouched.
export const db = new DatabaseSync(path.join(DATA_DIR, process.env.DB_FILE || 'squaddesk-v2.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Schema follows PRD v2 §14. *_enc = AES-256-GCM ciphertext, *_hmac = keyed lookup hash, *_hash = one-way.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name_enc TEXT,
  display_name TEXT NOT NULL,
  email_enc TEXT,
  email_hmac TEXT UNIQUE,
  phone_enc TEXT,
  phone_hmac TEXT UNIQUE,
  password_hash TEXT,
  email_verified INTEGER NOT NULL DEFAULT 1,   -- legacy: there is no verification step any more
  phone_verified INTEGER NOT NULL DEFAULT 1,   -- legacy
  must_change_password INTEGER NOT NULL DEFAULT 0, -- set when an admin gives a temporary password
  role TEXT NOT NULL DEFAULT 'user',
  is_blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  mfa_secret_enc TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_last_step INTEGER,
  mfa_recovery_hashes TEXT,
  source_qr_id INTEGER REFERENCES qr_codes(id) ON DELETE SET NULL,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);


CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_info TEXT,
  device_hash TEXT,
  ip_address TEXT,
  remember INTEGER NOT NULL DEFAULT 0,
  mfa_passed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  prev_refresh_hash TEXT,                      -- the token just replaced, honoured briefly (see refreshSession)
  rotated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);


CREATE TABLE IF NOT EXISTS qr_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  scan_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_code TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  expected_result TEXT,
  urgency TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',   -- public | private
  status TEXT NOT NULL DEFAULT 'draft',
  status_reason TEXT,                          -- rejection reason etc., shown to the user
  size_weeks INTEGER,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  queue_position INTEGER,
  priority_boost INTEGER NOT NULL DEFAULT 0,
  priority_reason TEXT,
  upvote_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  reviewed_at TEXT,
  approved_at TEXT,
  choose_by TEXT,
  delivered_at TEXT,
  closed_at TEXT,
  rating INTEGER,
  feedback TEXT,
  source_qr_id INTEGER REFERENCES qr_codes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pds_status ON pds(status);
CREATE INDEX IF NOT EXISTS idx_pds_user ON pds(user_id);
CREATE INDEX IF NOT EXISTS idx_pds_board ON pds(visibility, status, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'local',       -- local | cloudinary
  resource_type TEXT,
  format TEXT,
  file_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scan_status TEXT NOT NULL DEFAULT 'signature_ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  comment_type TEXT,
  text TEXT NOT NULL,
  is_team INTEGER NOT NULL DEFAULT 0,
  is_useful INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_pds ON comments(pds_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id, created_at);

CREATE TABLE IF NOT EXISTS upvotes (
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pds_id, user_id)
);

-- AD-10 / CM-05: useful comments (or admin text) added to the PDS requirement list.
CREATE TABLE IF NOT EXISTS pds_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AD-04 internal notes (team only, never shown to users).
CREATE TABLE IF NOT EXISTS pds_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT 'system',        -- user | team | system
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slot_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parallel_slots INTEGER NOT NULL,
  hours_per_week INTEGER NOT NULL,
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  start_week TEXT NOT NULL,                    -- Monday, YYYY-MM-DD
  end_week TEXT NOT NULL,                      -- Monday of the last week (inclusive)
  status TEXT NOT NULL DEFAULT 'booked',       -- booked | in_development | testing | completed | cancelled
  booked_by TEXT NOT NULL DEFAULT 'user',      -- user | admin | system
  reminded_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
-- SL-05: one active booking per PDS.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_active ON bookings(pds_id) WHERE status IN ('booked','in_development','testing');

-- One row per occupied/blocked lane-week. UNIQUE(lane, week_start) is what makes double booking impossible (§13.4).
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  week_start TEXT NOT NULL,
  status TEXT NOT NULL,                        -- booked | in_development | testing | completed | blocked
  pds_id INTEGER REFERENCES pds(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  block_reason TEXT,
  UNIQUE (lane, week_start)
);

CREATE TABLE IF NOT EXISTS progress_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pds_id INTEGER NOT NULL REFERENCES pds(id) ON DELETE CASCADE,
  percent INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',         -- open | actioned | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comment_id, reported_by)
);

-- In-app notifications.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);


CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

export const DEFAULT_SETTINGS = {
  team_name: 'Intelligent Squad',
  product_name: 'IntelSquad',
  review_sla_hours: '48',
  blocked_words: DEFAULT_BLOCKED_WORDS.join(', '),
  require_team_2fa: 'true', // 'false': team accounts may use the admin panel without two-factor
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
// No email or SMS any more: drop the tables that held queued messages, one-time codes and reset links,
// and make every existing account usable (there is no verification step).
db.exec('DROP TABLE IF EXISTS outbox; DROP TABLE IF EXISTS otp_codes; DROP TABLE IF EXISTS password_resets;');
db.prepare("DELETE FROM settings WHERE key = 'notify_admin_email'").run();
// The product was renamed from SquadDesk to IntelSquad.
db.prepare("UPDATE settings SET value = 'IntelSquad' WHERE key = 'product_name' AND value = 'SquadDesk'").run();
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'must_change_password'").get()) {
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'prev_refresh_hash'").get()) {
  db.exec('ALTER TABLE sessions ADD COLUMN prev_refresh_hash TEXT; ALTER TABLE sessions ADD COLUMN rotated_at TEXT;');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh ON sessions(prev_refresh_hash)');
db.prepare('UPDATE users SET email_verified = 1, phone_verified = 1 WHERE email_verified = 0 OR phone_verified = 0').run();

if (!db.prepare('SELECT 1 FROM slot_settings').get()) {
  db.prepare('INSERT INTO slot_settings (parallel_slots, hours_per_week) VALUES (2, 20)').run();
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

let depth = 0;
/** Run fn in a transaction (nested calls join the outer one). */
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

/** AD-13 / §13.4: audit every login, password change, admin action and export. */
export function audit(actor, action, { type = null, id = null, details = null, ip = null } = {}) {
  db.prepare('INSERT INTO audit_logs (actor_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)').run(
    actor?.id ?? null,
    action,
    type,
    id == null ? null : String(id),
    details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
    ip,
  );
}

export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
