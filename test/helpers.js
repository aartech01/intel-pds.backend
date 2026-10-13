// Shared test harness: boots the app in-process on a random port with a throwaway data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squaddesk-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dir,
  KEEPALIVE_ENABLED: 'false',
  TURNSTILE_SECRET_KEY: '',
  CLOUDINARY_CLOUD_NAME: '',
});

const { createApp } = await import('../src/app.js');
export const { db } = await import('../src/db.js');
export const slots = await import('../src/slots.js');
export const { totpCode } = await import('../src/crypto.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
export const base = `http://127.0.0.1:${server.address().port}`;
export const close = () => new Promise((r) => server.close(r));

/** Minimal browser: keeps cookies and sends the CSRF header like the real client does. */
export class Client {
  constructor() {
    this.jar = new Map();
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a) || /max-age=0/i.test(a.trim()));
      if (expired || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async req(method, url, body, { form } = {}) {
    if (!this.jar.has('sd_csrf') && method !== 'GET') await this.req('GET', '/api/config');
    const headers = { cookie: this.cookieHeader(), 'user-agent': this.ua || 'test-agent' };
    if (this.jar.has('sd_csrf')) headers['x-csrf-token'] = this.jar.get('sd_csrf');
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  patch(u, b) { return this.req('PATCH', u, b ?? {}); }
  put(u, b) { return this.req('PUT', u, b ?? {}); }
  del(u, b) { return this.req('DELETE', u, b); }
}

let seq = 0;

/** Sign up (accounts work straight away - there is no email/SMS verification). Returns { client, email, phone, password, id }. */
export async function newUser(name = 'Test User') {
  seq++;
  const c = new Client();
  const email = `user${seq}-${Date.now()}@mail.test`;
  const phone = `+9198${String(Date.now() + seq).slice(-8)}`;
  const password = 'Sturdy-pass-42';
  const r = await c.post('/api/auth/signup', { full_name: name, display_name: `${name.split(' ')[0]}${seq}`, email, phone, password, confirm_password: password, accept_terms: true });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return { client: c, email, phone, password, id: r.data.user.id };
}

/** Make a user staff and walk through mandatory 2FA setup. Returns the TOTP secret. */
export async function makeStaff(u, role = 'admin') {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  const setup = await u.client.post('/api/me/mfa/setup');
  const r = await u.client.post('/api/me/mfa/enable', { code: totpCode(setup.data.secret, Math.floor(Date.now() / 30000)) });
  if (r.status !== 200) throw new Error(`mfa enable failed: ${JSON.stringify(r.data)}`);
  return setup.data.secret;
}

export const pdsBody = (over = {}) => ({
  title: 'Automate my weekly report',
  type: 'automation',
  problem_statement: 'We copy numbers by hand every Friday and it takes two hours.',
  expected_result: 'A report that builds itself.',
  urgency: 'Medium',
  visibility: 'public',
  ...over,
});

export async function createPds(client, over) {
  const form = new FormData();
  for (const [k, v] of Object.entries(pdsBody(over))) form.append(k, v);
  const r = await client.req('POST', '/api/pds', undefined, { form });
  if (r.status !== 201) throw new Error(`create pds failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.code;
}
