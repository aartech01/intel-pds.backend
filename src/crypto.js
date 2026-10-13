import crypto from 'node:crypto';
import { ENC_KEYS, ENC_KEY_ID, HMAC_KEY } from './config.js';

// PRD §13.1: AES-256-GCM for personal data that must be read back, HMAC-SHA256 for lookups,
// SHA-256 for random single-use tokens.

/** Encrypt a string. Format: keyId:iv:tag:ciphertext (base64url). null stays null. */
export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEYS.get(ENC_KEY_ID), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [ENC_KEY_ID, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(value) {
  if (value == null) return null;
  const [kid, iv, tag, ct] = String(value).split(':');
  const key = ENC_KEYS.get(kid);
  if (!key) throw new Error(`Unknown encryption key id "${kid}"`);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Keyed hash for lookup / uniqueness without storing the readable value. */
export const hmac = (value, purpose = 'lookup') => crypto.createHmac('sha256', HMAC_KEY).update(`${purpose}:${value}`).digest('hex');

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const randomDigits = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- normalisation (so the same email/number always hashes the same) ----------
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();

/**
 * "+91 98765-43210" -> "+919876543210". Numbers without a country code default to +91,
 * and the Indian trunk 0 is dropped ("09876543210", "+91 098765 43210").
 */
export function normPhone(p) {
  const raw = String(p ?? '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits.replace(/^910(?=\d{10}$)/, '91')}`;
  if (raw.startsWith('00')) return `+${digits.slice(2)}`;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

/** Readable temporary password, e.g. "Temp-K7QM-4XWP": no look-alike characters. */
export function temporaryPassword() {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alpha[b % alpha.length]).join('');
  return `Temp-${pick()}-${pick()}`;
}

export const maskPhone = (p) => (p ? `${p.slice(0, 3)}******${p.slice(-2)}` : '');

// ---------- TOTP (RFC 6238) for admin / team two-factor authentication ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** Returns the matched time-step (for replay protection) or null. Accepts ±1 step of clock drift. */
export function verifyTotp(secretB32, code, now = Date.now()) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpCode(secretB32, s), c)) return s;
  return null;
}
