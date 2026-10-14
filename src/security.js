import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { IS_PROD, IS_TEST, TURNSTILE_SECRET_KEY } from './config.js';
import { randomToken, safeEqual } from './crypto.js';
import { getSettings, httpError } from './db.js';

// ---------- HTTP headers (PRD §13.4) ----------
export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ---------- cookies ----------
export function parseCookies(req, _res, next) {
  req.cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try { req.cookies[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ }
    }
  }
  next();
}

export const cookieBase = { httpOnly: true, secure: IS_PROD, sameSite: 'strict', path: '/' };

// ---------- CSRF: double-submit token (cookie readable by our page + matching header) ----------
export const CSRF_COOKIE = 'sd_csrf';
export function ensureCsrfCookie(req, res, next) {
  if (!req.cookies[CSRF_COOKIE]) {
    const t = randomToken(24);
    req.cookies[CSRF_COOKIE] = t;
    res.cookie(CSRF_COOKIE, t, { ...cookieBase, httpOnly: false, maxAge: 365 * 864e5 });
  }
  next();
}

export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(header, req.cookies[CSRF_COOKIE] || '')) {
    return res.status(403).json({ error: 'Your session token is out of date. Refresh the page and try again.', code: 'csrf' });
  }
  next();
}

// ---------- rate limits (PRD §13.3: login, sign up, OTP and password reset) ----------
// Many people at one event share a Wi-Fi IP (QR codes!), so per-IP caps are generous and
// signed-in actions are also limited per account.
const limiter = (windowMin, limit, message, { perAccount = false } = {}) =>
  rateLimit({
    windowMs: windowMin * 60_000,
    limit: IS_TEST ? 10_000 : limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    keyGenerator: (req) => (perAccount && req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip || '')),
  });
const otpIp = limiter(15, 150, 'Too many code requests from this network. Try again in a few minutes.');
const otpAccount = limiter(15, 15, 'Too many code requests. Try again in a few minutes.', { perAccount: true });
export const limits = {
  login: limiter(15, 100, 'Too many login attempts from this network. Try again in a few minutes.'),
  signup: limiter(60, 60, 'Too many sign ups from this network. Try again later.'),
  otp: [otpIp, otpAccount],
  reset: limiter(60, 30, 'Too many reset requests. Try again later.'),
  write: limiter(1, 60, 'You are doing that too often. Slow down a little.', { perAccount: true }),
  integration: limiter(1, 60, 'Too many automation requests. Slow down a little.'),
};

// ---------- CAPTCHA (Cloudflare Turnstile) ----------
export const captchaEnabled = !!TURNSTILE_SECRET_KEY;
export async function verifyCaptcha(token, ip) {
  if (!captchaEnabled) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: String(token), remoteip: ip || '' }),
      signal: AbortSignal.timeout(8000),
    });
    return !!(await res.json()).success;
  } catch (e) {
    console.error('[captcha] verification failed:', e.message);
    return false;
  }
}

// ---------- passwords ----------
// Any password is accepted (team decision - no strength rules). It is still stored only as a bcrypt hash.
// The one limit is technical: bcrypt reads only the first 72 bytes, so longer input would be silently cut.
export function passwordProblem(pw) {
  const p = String(pw ?? '');
  if (!p) return 'Enter a password';
  if (Buffer.byteLength(p, 'utf8') > 72) return 'Password is too long (72 characters at most)';
  return null;
}

// ---------- user text (PRD CM-10, §13.4): plain text only ----------
/** Trim, normalise newlines, drop control characters. Output is still escaped by React on display. */
export function cleanText(v, max) {
  const s = String(v ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return max ? s.slice(0, max) : s;
}

export function requireText(v, max, label) {
  const s = cleanText(v);
  if (!s) throw httpError(400, `${label} is required`, { field: label });
  if (s.length > max) throw httpError(400, `${label} must be ${max} characters or fewer`);
  return s;
}

export function blockedWordIn(text) {
  const words = String(getSettings().blocked_words || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const t = ` ${String(text).toLowerCase().replace(/[^a-zऀ-ॿ0-9]+/g, ' ')} `;
  return words.find((w) => t.includes(` ${w} `)) ?? null;
}

export const clientIp = (req) => req.ip || req.socket?.remoteAddress || null;
