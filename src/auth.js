import jwt from 'jsonwebtoken';
import { db, audit, getSettings } from './db.js';
import { ACCESS_TTL_S, ALLOW_2FA_SKIP, JWT_SECRET, REFRESH_TTL_DAYS } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { cookieBase, clientIp } from './security.js';
import { atLeast, isStaff } from './constants.js';
import { notifyUser } from './messaging.js';

// PRD §13.3: short-lived access token (15 min) + refresh token (7-30 days), both in HttpOnly cookies.
// Only the SHA-256 of the refresh token is stored, and every request re-checks the session row,
// so logout / "log out everywhere" / password change take effect immediately.

export const AT_COOKIE = 'sd_at';
export const RT_COOKIE = 'sd_rt';
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

function setAuthCookies(res, sessionId, userId, refresh, remember) {
  const maxAge = remember ? REFRESH_TTL_DAYS.remember * 864e5 : undefined; // no maxAge = ends with the browser
  const access = jwt.sign({ sid: sessionId, sub: userId }, JWT_SECRET, { expiresIn: ACCESS_TTL_S });
  res.cookie(AT_COOKIE, access, { ...cookieBase, maxAge });
  res.cookie(RT_COOKIE, refresh, { ...cookieBase, path: '/api/auth', maxAge });
}

export function clearAuthCookies(res) {
  res.clearCookie(AT_COOKIE, { ...cookieBase });
  res.clearCookie(RT_COOKIE, { ...cookieBase, path: '/api/auth' });
}

/** Create a session and set cookies. Sends a new-device alert (AC-11) when the device is new. */
export function issueSession(req, res, user, { remember = false, mfaPassed = false } = {}) {
  const refresh = randomToken(32);
  const ua = String(req.get('user-agent') || '').slice(0, 300);
  const deviceHash = sha256(ua);
  const known = db.prepare('SELECT COUNT(*) AS all_n, SUM(device_hash = ?) AS same FROM sessions WHERE user_id = ?').get(deviceHash, user.id);
  const days = remember ? REFRESH_TTL_DAYS.remember : REFRESH_TTL_DAYS.normal;
  const r = db
    .prepare('INSERT INTO sessions (user_id, refresh_token_hash, device_info, device_hash, ip_address, remember, mfa_passed, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, sha256(refresh), ua, deviceHash, clientIp(req), remember ? 1 : 0, mfaPassed ? 1 : 0, sqlTime(new Date(Date.now() + days * 864e5)));
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  setAuthCookies(res, Number(r.lastInsertRowid), user.id, refresh, remember);
  if (known.all_n > 0 && !known.same) {
    notifyUser(user, {
      type: 'security',
      message: `New login from ${ua || 'an unknown device'}. Not you? Change your password and log out all devices.`,
      link: '/profile',
    });
  }
  return Number(r.lastInsertRowid);
}

/** Rotate the refresh token. Returns the user or null. */
export function refreshSession(req, res) {
  const token = req.cookies[RT_COOKIE];
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')").get(sha256(token));
  if (!s) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_blocked = 0').get(s.user_id);
  if (!user) return null;
  const next = randomToken(32);
  db.prepare("UPDATE sessions SET refresh_token_hash = ?, last_used_at = datetime('now') WHERE id = ?").run(sha256(next), s.id);
  setAuthCookies(res, s.id, user.id, next, !!s.remember);
  return user;
}

export function revokeSession(id) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(id);
}

/** Turn two-factor off and forget the old authenticator and recovery codes; other devices are logged out. */
export function resetTwoFactor(userId) {
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_recovery_hashes = NULL, mfa_last_step = NULL WHERE id = ?').run(userId);
  revokeAllSessions(userId);
}

export function revokeAllSessions(userId, exceptId = null) {
  db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?").run(userId, exceptId);
}

/** Reads the access cookie; sets req.user / req.session when valid. Never rejects. */
export function authenticate(req, _res, next) {
  const token = req.cookies[AT_COOKIE];
  if (!token) return next();
  try {
    const { sid, sub } = jwt.verify(token, JWT_SECRET);
    const s = db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')").get(sid, sub);
    const user = s && db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(sub);
    if (!user) req.authError = 'unauthenticated';
    else if (user.is_blocked) req.authError = 'blocked';
    else {
      req.session = s;
      req.user = user;
    }
  } catch (e) {
    req.authError = e.name === 'TokenExpiredError' ? 'token_expired' : 'unauthenticated';
  }
  next();
}

// After logging in with a temporary password from an admin, the only thing allowed is choosing a new one.
const TEMP_PASSWORD_ALLOWED = new Set(['/api/me/password', '/api/auth/logout', '/api/auth/logout-all']);

export function requireUser(req, res, next) {
  if (req.user?.must_change_password && !TEMP_PASSWORD_ALLOWED.has(req.originalUrl.split('?')[0])) {
    return res.status(403).json({ error: 'Choose a new password first', code: 'password_change_required' });
  }
  if (req.user) return next();
  if (req.authError === 'blocked') return res.status(403).json({ error: 'This account is blocked. Contact the team if you think this is a mistake.', code: 'blocked' });
  res.status(401).json({ error: 'Please log in to continue', code: req.authError || 'unauthenticated' });
}

/** Staff routes: role check + mandatory two-factor authentication (AD-01, §13.3). */
/** Team accounts must use two-factor unless a Super Admin turned the rule off in Settings (or ALLOW_2FA_SKIP is set). */
export const teamTwoFactorRequired = () => !ALLOW_2FA_SKIP && getSettings().require_team_2fa !== 'false';

export function requireRole(role) {
  return (req, res, next) => {
    if (!atLeast(req.user, role)) return res.status(403).json({ error: 'You do not have permission for this', code: 'forbidden' });
    if (!req.user.mfa_enabled) {
      if (!teamTwoFactorRequired()) return next();
      return res.status(403).json({ error: 'Set up two-factor authentication to use the team panel', code: 'mfa_setup_required' });
    }
    if (!req.session.mfa_passed) return res.status(403).json({ error: 'Two-factor check required', code: 'mfa_required' });
    next();
  };
}

/** Shape of the logged-in user sent to the browser (own account only). */
export function selfView(user, { decrypt }) {
  return {
    id: user.id,
    display_name: user.display_name,
    full_name: decrypt(user.full_name_enc),
    email: decrypt(user.email_enc),
    phone: decrypt(user.phone_enc),
    must_change_password: !!user.must_change_password,
    role: user.role,
    is_staff: isStaff(user),
    mfa_enabled: !!user.mfa_enabled,
    created_at: user.created_at,
  };
}

export function auditAuth(req, user, action, details) {
  audit(user, action, { type: 'user', id: user?.id, details, ip: clientIp(req) });
}
