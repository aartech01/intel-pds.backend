import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { isStaff } from '../constants.js';
import { BCRYPT_COST, JWT_SECRET } from '../config.js';
import { decrypt, encrypt, hmac, normEmail, normPhone, sha256, verifyTotp, safeEqual } from '../crypto.js';
import { limits, verifyCaptcha, captchaEnabled, passwordProblem, cleanText, clientIp } from '../security.js';
import {
  issueSession, refreshSession, revokeSession, revokeAllSessions, clearAuthCookies, requireUser, selfView, auditAuth, RT_COOKIE,
} from '../auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+\d{10,15}$/;
const LOCK_AFTER = 5;
const CAPTCHA_AFTER = 3;
const LOCK_MIN = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-1', 4);

export const me = (user) => selfView(user, { decrypt });
const unread = (userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
export const meResponse = (req, user) => ({
  user: me(user),
  mfa_passed: !!req.session?.mfa_passed,
  unread: unread(user.id),
});

/** Find a user by email or mobile number (via their HMAC - nothing is decrypted). */
export function findByIdentifier(identifier) {
  const id = String(identifier ?? '').trim();
  const isEmail = id.includes('@');
  const key = isEmail ? hmac(normEmail(id), 'email') : hmac(normPhone(id), 'phone');
  const user = db.prepare(`SELECT * FROM users WHERE ${isEmail ? 'email_hmac' : 'phone_hmac'} = ? AND deleted_at IS NULL`).get(key);
  return { user, key, isEmail };
}

// Failed-login counters for identifiers that have no account, so responses look the same either way.
const ghosts = new Map();

// ===================== sign up (AC-01) =====================
router.post('/signup', limits.signup, async (req, res) => {
  const b = req.body ?? {};
  const fields = {};
  const full_name = cleanText(b.full_name, 100);
  const display_name = cleanText(b.display_name || full_name.split(/\s+/)[0], 60);
  const email = normEmail(b.email);
  const phone = normPhone(b.phone);
  if (full_name.length < 2 || full_name.length > 60) fields.full_name = 'Enter your full name (2 to 60 characters)';
  if (display_name.length < 2 || display_name.length > 30) fields.display_name = 'Display name must be 2 to 30 characters';
  if (!EMAIL_RE.test(email) || email.length > 254) fields.email = 'Enter a valid email address';
  if (!PHONE_RE.test(phone)) fields.phone = 'Enter a valid mobile number with country code';
  const pwProblem = passwordProblem(b.password);
  if (pwProblem) fields.password = pwProblem;
  else if (b.password !== b.confirm_password) fields.confirm_password = 'Passwords do not match';
  if (!b.accept_terms) fields.accept_terms = 'Please accept the terms and privacy policy';
  if (Object.keys(fields).length) return res.status(400).json({ error: 'Please fix the highlighted fields', fields });

  if (!(await verifyCaptcha(b.captcha, clientIp(req)))) return res.status(400).json({ error: 'Please complete the CAPTCHA', code: 'captcha_required' });

  const email_hmac = hmac(email, 'email');
  const phone_hmac = hmac(phone, 'phone');
  const clash = db.prepare('SELECT email_hmac, phone_hmac FROM users WHERE email_hmac = ? OR phone_hmac = ?').get(email_hmac, phone_hmac);
  if (clash) {
    const which = { ...(clash.email_hmac === email_hmac ? { email: 'This email is already registered' } : {}), ...(clash.phone_hmac === phone_hmac ? { phone: 'This mobile number is already registered' } : {}) };
    return res.status(409).json({ error: 'You already have an account. Log in instead.', fields: which });
  }

  const qr = b.src ? db.prepare('SELECT id FROM qr_codes WHERE slug = ?').get(String(b.src)) : null;
  const password_hash = await bcrypt.hash(b.password, BCRYPT_COST);
  const r = db
    .prepare(
      `INSERT INTO users (full_name_enc, display_name, email_enc, email_hmac, phone_enc, phone_hmac, password_hash, source_qr_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(encrypt(full_name), display_name, encrypt(email), email_hmac, encrypt(phone), phone_hmac, password_hash, qr?.id ?? null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  auditAuth(req, user, 'signup', qr ? { source: b.src } : null);
  issueSession(req, res, user, { remember: !!b.remember });
  res.status(201).json(meResponse({ session: null }, user));
});

// ===================== login (AC-03, AC-06, AC-07) =====================
// Two doors: /login is for users only, /team-login (the team page at /admin/is/login) for team accounts only.
// Knocking on the wrong door with the right password gets the same answer as a wrong password.
router.post('/login', limits.login, (req, res) => login(req, res, { team: false }));
router.post('/team-login', limits.login, (req, res) => login(req, res, { team: true }));

async function login(req, res, { team }) {
  const { identifier, password, remember, captcha } = req.body ?? {};
  if (!identifier || !password) return res.status(400).json({ error: 'Enter your email or mobile number and password' });
  const { user, key } = findByIdentifier(identifier);

  const nowRow = db.prepare("SELECT datetime('now') AS t").get().t;
  const state = user ? { count: user.failed_login_count, locked: user.locked_until } : ghosts.get(key) ?? { count: 0, locked: null };
  if (state.locked && state.locked > nowRow) {
    const mins = Math.max(1, Math.ceil((Date.parse(`${state.locked.replace(' ', 'T')}Z`) - Date.now()) / 60000));
    return res.status(429).json({ error: `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, code: 'locked' });
  }
  if (captchaEnabled && state.count >= CAPTCHA_AFTER && !(await verifyCaptcha(captcha, clientIp(req)))) {
    return res.status(400).json({ error: 'Please complete the CAPTCHA', code: 'captcha_required', captcha_required: true });
  }

  const ok = await bcrypt.compare(String(password), user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    const count = state.count + 1;
    const lock = count >= LOCK_AFTER;
    const lockedUntil = lock ? db.prepare(`SELECT datetime('now', '+${LOCK_MIN} minutes') AS t`).get().t : null;
    if (user) {
      db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : count, lockedUntil, user.id);
      auditAuth(req, user, lock ? 'login_locked' : 'login_failed');
    } else {
      ghosts.set(key, { count: lock ? 0 : count, locked: lockedUntil });
      if (ghosts.size > 10_000) ghosts.delete(ghosts.keys().next().value);
    }
    if (lock) return res.status(429).json({ error: `Too many wrong attempts. Try again in ${LOCK_MIN} minutes.`, code: 'locked' });
    // Same message whether the account exists or not (§13.3).
    return res.status(401).json({ error: 'Wrong email / mobile number or password', captcha_required: captchaEnabled && count >= CAPTCHA_AFTER });
  }
  if (isStaff(user) !== team) {
    auditAuth(req, user, 'login_wrong_portal', { portal: team ? 'team' : 'user' });
    return res.status(401).json({ error: 'Wrong email / mobile number or password', captcha_required: captchaEnabled && state.count >= CAPTCHA_AFTER });
  }
  if (user.is_blocked) return res.status(403).json({ error: 'This account is blocked. Contact the team if you think this is a mistake.', code: 'blocked' });
  db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);

  if (user.mfa_enabled) {
    const mfa_token = jwt.sign({ sub: user.id, purpose: 'mfa', remember: !!remember }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ mfa_required: true, mfa_token });
  }
  issueSession(req, res, user, { remember: !!remember });
  auditAuth(req, user, 'login');
  res.json(meResponse({ session: null }, user));
}

/** Second step for accounts with two-factor authentication: authenticator code or a recovery code. */
router.post('/mfa', limits.login, (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.body?.mfa_token || ''), JWT_SECRET);
    if (payload.purpose !== 'mfa') throw new Error('bad purpose');
  } catch {
    return res.status(401).json({ error: 'Your login step expired. Please log in again.', code: 'mfa_expired' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_blocked = 0').get(payload.sub);
  if (!user?.mfa_enabled) return res.status(401).json({ error: 'Please log in again' });
  if (user.locked_until && user.locked_until > db.prepare("SELECT datetime('now') AS t").get().t) return res.status(429).json({ error: 'Too many wrong attempts. Try again later.', code: 'locked' });

  const code = String(req.body?.code || '').trim();
  let ok = false;
  const step = verifyTotp(decrypt(user.mfa_secret_enc), code);
  if (step != null && step > (user.mfa_last_step ?? -1)) {
    db.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').run(step, user.id);
    ok = true;
  } else if (/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code)) {
    const hashes = JSON.parse(user.mfa_recovery_hashes || '[]');
    const h = sha256(code.replace('-', '').toUpperCase());
    const i = hashes.findIndex((x) => safeEqual(x, h));
    if (i >= 0) {
      hashes.splice(i, 1);
      db.prepare('UPDATE users SET mfa_recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
      auditAuth(req, user, 'mfa_recovery_code_used', { remaining: hashes.length });
      ok = true;
    }
  }
  if (!ok) {
    const count = user.failed_login_count + 1;
    const lock = count >= LOCK_AFTER;
    db.prepare(`UPDATE users SET failed_login_count = ?, locked_until = ${lock ? `datetime('now', '+${LOCK_MIN} minutes')` : 'NULL'} WHERE id = ?`).run(lock ? 0 : count, user.id);
    auditAuth(req, user, 'mfa_failed');
    return res.status(401).json({ error: 'That code is not right. Check the time on your phone and try again.' });
  }
  db.prepare('UPDATE users SET failed_login_count = 0 WHERE id = ?').run(user.id);
  issueSession(req, res, user, { remember: !!payload.remember, mfaPassed: true });
  auditAuth(req, user, 'login', { mfa: true });
  res.json({ ...meResponse({ session: { mfa_passed: 1 } }, user) });
});

// ===================== session (AC-07, AC-09) =====================
router.get('/me', (req, res) => {
  let user = req.user;
  if (!user && req.cookies[RT_COOKIE]) {
    user = refreshSession(req, res);
    if (user) req.session = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC, id DESC LIMIT 1').get(user.id);
  }
  if (!user) return res.json({ user: null });
  res.json(meResponse(req, user));
});

router.post('/refresh', (req, res) => {
  const user = refreshSession(req, res);
  if (!user) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Please log in again', code: 'unauthenticated' });
  }
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  if (req.session) revokeSession(req.session.id);
  else if (req.cookies[RT_COOKIE]) db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_token_hash = ?").run(sha256(req.cookies[RT_COOKIE]));
  if (req.user) auditAuth(req, req.user, 'logout');
  clearAuthCookies(res);
  res.json({ ok: true });
});

router.post('/logout-all', requireUser, (req, res) => {
  revokeAllSessions(req.user.id);
  auditAuth(req, req.user, 'logout_all');
  clearAuthCookies(res);
  res.json({ ok: true });
});

export default router;
