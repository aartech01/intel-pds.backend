import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { db, tx, httpError } from '../db.js';
import { BCRYPT_COST, JWT_SECRET } from '../config.js';
import { base32Encode, decrypt, encrypt, hmac, normEmail, normPhone, sha256, verifyTotp } from '../crypto.js';
import { cleanText, limits, passwordProblem } from '../security.js';
import { requireUser, revokeAllSessions, revokeSession, clearAuthCookies, auditAuth, teamTwoFactorRequired } from '../auth.js';
import { notifyUser } from '../messaging.js';
import { meResponse } from './auth.js';
import { DELETED_NAME, changeStatus, getPdsById } from '../pds.js';
import { activeBooking, cancelBooking } from '../slots.js';
import { deleteStoredFiles } from '../storage.js';
import { WITHDRAWABLE_STATUSES } from '../constants.js';

const router = Router();
router.use(requireUser);

const reload = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
async function checkPassword(user, password) {
  if (!user.password_hash || !(await bcrypt.compare(String(password ?? ''), user.password_hash))) throw httpError(400, 'Your current password is not correct', { fields: { password: 'Wrong password' } });
}

// ---------- profile (AC-08) ----------
router.patch('/', (req, res) => {
  const name = cleanText(req.body?.display_name, 60);
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Display name must be 2 to 30 characters', fields: { display_name: 'Display name must be 2 to 30 characters' } });
  if (name.toLowerCase() === DELETED_NAME.toLowerCase()) return res.status(400).json({ error: 'Please choose another display name' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
  res.json(meResponse(req, reload(req.user.id)));
});

router.post('/password', limits.reset, async (req, res) => {
  await checkPassword(req.user, req.body?.current);
  const problem = passwordProblem(req.body?.next);
  if (problem) return res.status(400).json({ error: problem, fields: { next: problem } });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await bcrypt.hash(req.body.next, BCRYPT_COST), req.user.id);
  // §13.2: on password change, log out all other devices and send an alert.
  revokeAllSessions(req.user.id, req.session.id);
  auditAuth(req, req.user, 'password_change');
  notifyUser(req.user, { type: 'security', message: 'Your password was changed and all other devices were logged out. Not you? Tell the team now.', link: '/profile' });
  res.json({ ok: true });
});

/** Change email or mobile: the password confirms it is really you. */
router.post('/contact', limits.write, async (req, res) => {
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email';
  await checkPassword(req.user, req.body?.password);
  const value = channel === 'sms' ? normPhone(req.body?.value) : normEmail(req.body?.value);
  if (channel === 'sms' ? !/^\+\d{10,15}$/.test(value) : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    return res.status(400).json({ error: channel === 'sms' ? 'Enter a valid mobile number with country code' : 'Enter a valid email address' });
  }
  const col = channel === 'sms' ? 'phone_hmac' : 'email_hmac';
  if (db.prepare(`SELECT 1 FROM users WHERE ${col} = ? AND id != ?`).get(hmac(value, channel === 'sms' ? 'phone' : 'email'), req.user.id)) {
    return res.status(409).json({ error: `This ${channel === 'sms' ? 'mobile number' : 'email'} is already used by an account` });
  }
  try {
    if (channel === 'sms') db.prepare('UPDATE users SET phone_enc = ?, phone_hmac = ? WHERE id = ?').run(encrypt(value), hmac(value, 'phone'), req.user.id);
    else db.prepare('UPDATE users SET email_enc = ?, email_hmac = ? WHERE id = ?').run(encrypt(value), hmac(value, 'email'), req.user.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw httpError(409, 'This value is already used by another account');
    throw e;
  }
  auditAuth(req, req.user, channel === 'sms' ? 'phone_change' : 'email_change');
  notifyUser(req.user, { type: 'security', message: `Your ${channel === 'sms' ? 'mobile number' : 'email'} was changed. Not you? Change your password now.`, link: '/profile' });
  res.json(meResponse(req, reload(req.user.id)));
});

// ---------- devices (AC-09) ----------
router.get('/sessions', (req, res) => {
  res.json(
    db
      .prepare("SELECT id, device_info, ip_address, created_at, last_used_at, remember FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_used_at DESC")
      .all(req.user.id)
      .map((s) => ({ ...s, current: s.id === req.session.id })),
  );
});

router.delete('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  revokeSession(s.id);
  if (s.id === req.session.id) clearAuthCookies(res);
  res.json({ ok: true });
});

// ---------- notifications ----------
router.get('/notifications', (req, res) => {
  res.json(db.prepare('SELECT id, type, message, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(req.user.id));
});
router.post('/notifications/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  if (ids?.length) db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids);
  else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
  res.json({ ok: true });
});

// ---------- two-factor authentication (required for team unless turned off in Settings, optional for users) ----------
const newRecoveryCodes = () =>
  Array.from({ length: 8 }, () => {
    const c = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });

/** A new authenticator secret and the QR code to scan it. */
async function newAuthenticator(user) {
  const secret = base32Encode(crypto.randomBytes(20));
  const label = encodeURIComponent(`IntelSquad:${user.display_name}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=IntelSquad&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#070139', light: '#FFFFFF' } }) };
}

router.post('/mfa/setup', async (req, res) => {
  if (req.user.mfa_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });
  const a = await newAuthenticator(req.user);
  db.prepare('UPDATE users SET mfa_secret_enc = ? WHERE id = ?').run(encrypt(a.secret), req.user.id);
  res.json(a);
});

/**
 * Connect a new phone, step 1 (password needed): a new QR code. The current app keeps working until
 * step 2 confirms a code from the new one, so a half-finished change never locks anyone out.
 */
router.post('/mfa/new-phone', async (req, res) => {
  if (!req.user.mfa_enabled) return res.status(400).json({ error: 'Two-factor authentication is off. Turn it on instead.' });
  await checkPassword(req.user, req.body?.password);
  const a = await newAuthenticator(req.user);
  const token = jwt.sign({ sub: req.user.id, purpose: 'mfa_new_phone', s: encrypt(a.secret) }, JWT_SECRET, { expiresIn: '15m' });
  res.json({ ...a, token });
});

/** Connect a new phone, step 2: a code from the new app replaces the old app. */
router.post('/mfa/new-phone/confirm', limits.otp, (req, res) => {
  let p;
  try {
    p = jwt.verify(String(req.body?.token || ''), JWT_SECRET);
    if (p.purpose !== 'mfa_new_phone' || p.sub !== req.user.id) throw new Error('bad token');
  } catch {
    return res.status(400).json({ error: 'This QR code expired. Start again.', code: 'expired' });
  }
  const secret = decrypt(p.s);
  const step = verifyTotp(secret, req.body?.code);
  if (step == null) return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try again.' });
  db.prepare('UPDATE users SET mfa_secret_enc = ?, mfa_last_step = ? WHERE id = ?').run(encrypt(secret), step, req.user.id);
  auditAuth(req, req.user, 'mfa_new_phone');
  notifyUser(req.user, { type: 'security', message: 'A new phone was connected for two-factor login. The old app no longer works.', link: '/profile' });
  res.json(meResponse(req, reload(req.user.id)));
});

/** Super Admin: require two-factor for the team or not. Works without two-factor so a Super Admin is never stuck. */
router.post('/team-2fa-rule', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change the two-factor rule' });
  await checkPassword(req.user, req.body?.password);
  const required = req.body?.required !== false;
  db.prepare("INSERT INTO settings (key, value) VALUES ('require_team_2fa', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(required ? 'true' : 'false');
  auditAuth(req, req.user, required ? 'team_2fa_rule_on' : 'team_2fa_rule_off');
  res.json({ team_2fa_required: teamTwoFactorRequired() });
});

router.post('/mfa/enable', limits.otp, (req, res) => {
  if (req.user.mfa_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });
  if (!req.user.mfa_secret_enc) return res.status(400).json({ error: 'Start the setup first' });
  const step = verifyTotp(decrypt(req.user.mfa_secret_enc), req.body?.code);
  if (step == null) return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try again.' });
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_last_step = ?, mfa_recovery_hashes = ? WHERE id = ?').run(step, JSON.stringify(codes.map((c) => sha256(c.replace('-', '')))), req.user.id);
  db.prepare('UPDATE sessions SET mfa_passed = 1 WHERE id = ?').run(req.session.id);
  req.session.mfa_passed = 1;
  auditAuth(req, req.user, 'mfa_enabled');
  res.json({ ...meResponse(req, reload(req.user.id)), recovery_codes: codes });
});

router.post('/mfa/disable', async (req, res) => {
  if (req.user.role !== 'user' && teamTwoFactorRequired()) {
    return res.status(400).json({ error: 'Two-factor authentication is required for team accounts. A Super Admin can change this in Settings.' });
  }
  await checkPassword(req.user, req.body?.password);
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_recovery_hashes = NULL WHERE id = ?').run(req.user.id);
  auditAuth(req, req.user, 'mfa_disabled');
  res.json(meResponse(req, reload(req.user.id)));
});

/** Replace the recovery codes (the old ones stop working). Needs the password. */
router.post('/mfa/recovery-codes', async (req, res) => {
  if (!req.user.mfa_enabled) return res.status(400).json({ error: 'Two-factor authentication is off' });
  await checkPassword(req.user, req.body?.password);
  const codes = newRecoveryCodes();
  db.prepare('UPDATE users SET mfa_recovery_hashes = ? WHERE id = ?').run(JSON.stringify(codes.map((c) => sha256(c.replace('-', '')))), req.user.id);
  auditAuth(req, req.user, 'mfa_recovery_codes_renewed');
  res.json({ recovery_codes: codes });
});

// ---------- my data (§13.5) ----------
router.get('/export', (req, res) => {
  const u = req.user;
  const data = {
    exported_at: new Date().toISOString(),
    account: { display_name: u.display_name, full_name: decrypt(u.full_name_enc), email: decrypt(u.email_enc), mobile: decrypt(u.phone_enc), role: u.role, created_at: u.created_at },
    pds: db.prepare('SELECT pds_code, title, type, problem_statement, expected_result, urgency, visibility, status, created_at, updated_at FROM pds WHERE user_id = ?').all(u.id),
    comments: db.prepare('SELECT c.text, c.comment_type, c.created_at, p.pds_code FROM comments c JOIN pds p ON p.id = c.pds_id WHERE c.user_id = ? AND c.is_deleted = 0').all(u.id),
    upvotes: db.prepare('SELECT p.pds_code, v.created_at FROM upvotes v JOIN pds p ON p.id = v.pds_id WHERE v.user_id = ?').all(u.id),
    notifications: db.prepare('SELECT message, created_at FROM notifications WHERE user_id = ?').all(u.id),
  };
  auditAuth(req, u, 'data_export_self');
  res.setHeader('Content-Disposition', 'attachment; filename="my-intelsquad-data.json"');
  res.json(data);
});

/**
 * Removes an account's personal data. Drafts and private PDS are deleted; public PDS still in progress are withdrawn;
 * public PDS and comments stay as "Deleted user". Used by "delete my account" and by admins (Users page).
 */
export function deleteAccount(user, reason = 'Account deleted') {
  const files = [];
  tx(() => {
    for (const p of db.prepare('SELECT * FROM pds WHERE user_id = ?').all(user.id)) {
      if (p.status === 'draft' || p.visibility === 'private') {
        if (activeBooking(p.id)?.status === 'booked') cancelBooking(p.id, null, { byAdmin: true, reason });
        files.push(...db.prepare('SELECT * FROM attachments WHERE pds_id = ?').all(p.id));
        db.prepare('DELETE FROM slots WHERE pds_id = ?').run(p.id);
        db.prepare('DELETE FROM pds WHERE id = ?').run(p.id);
      } else if (WITHDRAWABLE_STATUSES.includes(p.status)) {
        if (activeBooking(p.id)) cancelBooking(p.id, null, { byAdmin: true, reason });
        changeStatus(getPdsById(p.id), 'withdrawn', null, { kind: 'system', note: reason, notify: false });
      }
    }
    db.prepare(
      `UPDATE users SET full_name_enc = NULL, display_name = ?, email_enc = NULL, email_hmac = NULL, phone_enc = NULL, phone_hmac = NULL,
         password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled = 0, mfa_recovery_hashes = NULL, deleted_at = datetime('now') WHERE id = ?`,
    ).run(DELETED_NAME, user.id);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id);
  });
  deleteStoredFiles(files);
  revokeAllSessions(user.id);
}

export const isLastSuperAdmin = (user) =>
  user.role === 'super_admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND deleted_at IS NULL").get().n < 2;

/** AC-10: delete account - personal data removed, public PDS and comments stay as "Deleted user". */
router.delete('/', async (req, res) => {
  await checkPassword(req.user, req.body?.password);
  if (isLastSuperAdmin(req.user)) return res.status(400).json({ error: 'You are the only Super Admin. Give the role to someone else first.' });
  deleteAccount(req.user);
  auditAuth(req, req.user, 'account_deleted');
  clearAuthCookies(res);
  res.json({ ok: true });
});

export default router;
