import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Central runtime config. Secrets come only from the environment (PRD §13.4) - never from code.

const here = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env however the server is started (npm run dev, plain `node`, nodemon, pm2...).
// Values already in the environment win. Tests use their own settings, so they skip this.
const envFile = path.resolve(here, '..', '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const IS_PROD = process.env.NODE_ENV === 'production';
export const IS_TEST = process.env.NODE_ENV === 'test';
export const DATA_DIR = path.resolve(here, '..', process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:5180').replace(/\/$/, '');

/**
 * Keys: JWT_SECRET, ENCRYPTION_KEY (32 bytes hex), HMAC_KEY (32 bytes hex).
 * Production refuses to start without them. In development a key file is generated once in DATA_DIR
 * so local data stays decryptable across restarts.
 */
function loadKeys() {
  const fromEnv = { JWT_SECRET: process.env.JWT_SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, HMAC_KEY: process.env.HMAC_KEY };
  const missing = Object.entries(fromEnv).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) return fromEnv;
  if (IS_PROD) throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  const file = path.join(DATA_DIR, 'dev-keys.json');
  let dev = {};
  try { dev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const created = missing.filter((k) => !dev[k]);
  for (const k of created) dev[k] = crypto.randomBytes(32).toString('hex');
  // Only write when a key is new - rewriting on every start made file watchers (nodemon) restart forever.
  if (created.length) fs.writeFileSync(file, JSON.stringify(dev, null, 2), { mode: 0o600 });
  if (!IS_TEST) console.warn(`[config] ${missing.join(', ')} not set - using development keys from ${file}`);
  return { ...fromEnv, ...Object.fromEntries(missing.map((k) => [k, dev[k]])) };
}

const keys = loadKeys();
const hexKey = (name, v) => {
  const b = Buffer.from(v, 'hex');
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes as 64 hex characters`);
  return b;
};

export const JWT_SECRET = keys.JWT_SECRET;
export const HMAC_KEY = hexKey('HMAC_KEY', keys.HMAC_KEY);
// Key rotation: new data is written with ENCRYPTION_KEY (id ENCRYPTION_KEY_ID); older ciphertext is still
// readable while its key is listed in ENCRYPTION_KEYS_OLD as "id:hex,id:hex".
export const ENC_KEY_ID = process.env.ENCRYPTION_KEY_ID || 'k1';
export const ENC_KEYS = new Map([
  ...String(process.env.ENCRYPTION_KEYS_OLD || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, hex] = s.split(':');
      return [id, hexKey(`ENCRYPTION_KEYS_OLD (${id})`, hex)];
    }),
  [ENC_KEY_ID, hexKey('ENCRYPTION_KEY', keys.ENCRYPTION_KEY)],
]);

export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
export const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// ALLOW_2FA_SKIP=true: team accounts WITHOUT two-factor may skip the setup and use the team panel.
// Accounts that already turned 2FA on still have to enter their code.
export const ALLOW_2FA_SKIP = process.env.ALLOW_2FA_SKIP === 'true';

export const BCRYPT_COST = IS_TEST ? 4 : 12;
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_DAYS = { remember: 30, normal: 7 };
