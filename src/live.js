import { db } from './db.js';
import { isStaff } from './constants.js';

/*
  Live updates over Server-Sent Events (GET /api/live).
  Events only name what changed - "pds", "pds:PDS-2026-0007", "slots", "notifications" ... - never the data.
  Pages refetch through the normal API, so every permission check still applies; the audience rules
  below only stop people hearing that a private PDS exists.
*/

const clients = new Set();
const MAX_PER_KEY = 8; // open tabs per user (or per IP for guests)
let pending = [];
let timer = null;
let origin = null; // browser tab whose request is being announced (X-Tab header), so its own echo can be marked

export const EVERYONE = { all: true };
export const USERS = { users: true };
export const STAFF = { staff: true };
export const onlyUsers = (...ids) => ({ userIds: ids.filter(Boolean) });

/** A public, submitted PDS is news for every logged-in user; drafts and private ones only for the owner and the team. */
export function pdsAudience(p) {
  if (!p) return STAFF;
  return p.visibility === 'public' && p.status !== 'draft' ? USERS : { staff: true, userIds: [p.user_id] };
}

export const either = (a, b) => ({ all: a.all || b.all, users: a.users || b.users, staff: a.staff || b.staff, userIds: [...(a.userIds ?? []), ...(b.userIds ?? [])] });

function hears(c, a) {
  return !!(a.all || (a.users && c.userId) || (a.staff && c.staff) || (c.userId && a.userIds?.includes(c.userId)));
}

/** Queue topics for an audience. Everything published within 50 ms goes out as one event per connection. */
export function publish(topics, audience) {
  if (!clients.size) return;
  pending.push({ topics, audience, origin });
  timer ??= setTimeout(flush, 50);
}

function flush() {
  timer = null;
  const batch = pending;
  pending = [];
  for (const c of clients) {
    const topics = new Set();
    let own = !!c.tab;
    for (const { topics: t, audience, origin: from } of batch) {
      if (!hears(c, audience)) continue;
      t.forEach((x) => topics.add(x));
      if (from !== c.tab) own = false;
    }
    // own: every change in this event came from this tab's own requests, which already reloaded what they changed.
    if (topics.size) c.res.write(`data: ${JSON.stringify(own ? { topics: [...topics], own } : { topics: [...topics] })}\n\n`);
  }
}

/** GET /api/live - the stream. Guests get public news (the slot calendar); logged-in users get theirs too. */
export function liveStream(req, res) {
  // An expired access token would silently connect as a guest; the client refreshes and reconnects instead.
  if (req.authError === 'token_expired') return res.status(401).json({ error: 'Session expired', code: 'token_expired' });
  const key = req.user ? `u${req.user.id}` : `ip${req.ip}`;
  let open = 0;
  for (const c of clients) if (c.key === key) open++;
  if (open >= MAX_PER_KEY) return res.status(429).json({ error: 'Too many live connections' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: ready\ndata: {}\n\n');
  const c = { res, key, userId: req.user?.id ?? null, staff: isStaff(req.user), tab: tabId(req.query.tab) };
  clients.add(c);
  // Comment lines keep proxies (Render, nginx) from closing an idle stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
  });
}

/** Close a user's streams (role change, block, delete, log out everywhere); their tabs reconnect as who they are now. */
export function disconnectUser(userId) {
  for (const c of clients) if (c.userId === userId) c.res.end();
}

const tabId = (v) => (typeof v === 'string' && /^[\w-]{8,64}$/.test(v) ? v : null);

// ---------- every successful write announces what it changed ----------
const CODE = /(PDS-\d{4}-\d+)/i;
const pdsRow = (where, arg) => db.prepare(`SELECT p.id, p.pds_code, p.user_id, p.visibility, p.status FROM pds p ${where}`).get(arg);

/** The PDS a request touches, looked up before the handler runs (a delete removes it). */
function pdsFor(path) {
  const code = path.match(CODE)?.[1];
  if (code) return pdsRow('WHERE p.pds_code = ?', code.toUpperCase());
  const comment = path.match(/^\/(?:admin\/)?comments\/(\d+)/)?.[1];
  if (comment) return pdsRow('JOIN comments c ON c.pds_id = p.id WHERE c.id = ?', comment);
  const reqmt = path.match(/^\/admin\/requirements\/(\d+)/)?.[1];
  if (reqmt) return pdsRow('JOIN pds_requirements r ON r.pds_id = p.id WHERE r.id = ?', reqmt);
  return null;
}

/** Express middleware, mounted after `authenticate` on /api. */
export function announceWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/auth/refresh' || req.path === '/live') return next();
  const path = req.path;
  const before = pdsFor(path);
  const actor = req.user?.id ?? null;
  const tab = tabId(req.get('x-tab'));
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    origin = tab;
    try {
      announce(req.method, path, before, actor);
    } catch (e) {
      console.error('[live]', e.message);
    } finally {
      origin = null;
    }
  });
  next();
}

function announce(method, path, before, actor) {
  publish(['audit'], STAFF);

  if (path.startsWith('/auth/')) {
    // A sign-up changes the user counts (Users page + admin home); a login only the Users page's "last login".
    publish([path === '/auth/signup' ? 'users' : 'logins'], STAFF);
    if (path === '/auth/logout-all') disconnectUser(actor);
    return;
  }
  if (path.startsWith('/me')) {
    publish([path.startsWith('/me/notifications') ? 'notifications' : 'me'], onlyUsers(actor));
    if (path === '/me/team-2fa-rule') publish(['config', 'settings'], EVERYONE);
    if (method === 'DELETE' && path === '/me') {
      publish(['pds', 'users'], USERS);
      publish(['slots'], EVERYONE);
    }
    return;
  }

  if (before) {
    const after = db.prepare('SELECT id, pds_code, user_id, visibility, status FROM pds WHERE id = ?').get(before.id);
    // A visibility change is news for both the old and the new audience.
    const audience = after ? either(pdsAudience(before), pdsAudience(after)) : pdsAudience(before);
    publish(['pds', `pds:${before.pds_code}`], audience);
    if (path.includes('/comments')) publish(['moderation'], STAFF);
  } else if (method === 'POST' && path === '/pds') {
    publish(['pds'], { staff: true, userIds: [actor] });
  }

  const touchesSlots =
    /\/(booking|approve|status|withdraw|confirm|submit)$/.test(path) ||
    /^\/admin\/(slots|queue)\//.test(path) ||
    (before && method !== 'POST' && /^\/(admin\/)?pds\/[^/]+$/.test(path)); // delete, or a size change
  if (touchesSlots) {
    publish(['slots'], EVERYONE);
    publish(['pds'], USERS);
  }

  const userId = Number(path.match(/^\/admin\/users\/(\d+)/)?.[1]);
  if (userId) {
    publish(['users'], STAFF);
    publish(['me'], onlyUsers(userId));
    if (/\/(role|block)$/.test(path) || method === 'DELETE') disconnectUser(userId);
    if (method === 'DELETE') {
      publish(['pds'], USERS);
      publish(['slots'], EVERYONE);
    }
  }
  if (path.startsWith('/admin/comments/')) publish(['moderation'], STAFF);
  if (path.startsWith('/admin/qr')) publish(['qr'], STAFF);
  if (path.startsWith('/admin/settings')) {
    publish(['settings'], STAFF);
    publish(['config'], EVERYONE);
  }
}
