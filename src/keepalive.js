import { PUBLIC_URL } from './config.js';

// Keep-alive / uptime monitor.
// Free hosts (e.g. Render) put a service to sleep after ~15 min without inbound traffic.
// Every KEEPALIVE_INTERVAL_MIN (default 13) minutes we call our own *public* health URL
// (plus any extra KEEPALIVE_URLS, e.g. a separately hosted frontend) so the host sees traffic.
// Note: this keeps a running server awake; it cannot wake one that is already asleep.

const INTERVAL_MIN = Number(process.env.KEEPALIVE_INTERVAL_MIN || 13);
const TIMEOUT_MS = 30_000;

function targets() {
  const extra = (process.env.KEEPALIVE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([`${PUBLIC_URL}/api/health`, ...extra])];
}

const isLocal = (url) => /\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/.test(url);

export const keepaliveStatus = { enabled: false, interval_min: INTERVAL_MIN, last_run: null, results: [] };

async function ping(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'IntelSquad-KeepAlive/1.0' } });
    return { url, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { url, ok: false, status: 0, ms: Date.now() - started, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

async function runOnce() {
  const results = await Promise.all(keepaliveStatus.urls.map(ping));
  const prev = new Map(keepaliveStatus.results.map((r) => [r.url, r.ok]));
  keepaliveStatus.last_run = new Date().toISOString();
  keepaliveStatus.results = results;
  for (const r of results) {
    // Log failures, and recoveries - not every successful ping.
    if (!r.ok) console.warn(`[keepalive] ${r.url} -> ${r.status || r.error} (${r.ms} ms)`);
    else if (prev.get(r.url) === false || !prev.has(r.url)) console.log(`[keepalive] ${r.url} -> ${r.status} OK (${r.ms} ms)`);
  }
}

export function startKeepAlive() {
  if (process.env.KEEPALIVE_ENABLED === 'false') return;
  const urls = targets().filter((u) => process.env.KEEPALIVE_FORCE === 'true' || !isLocal(u));
  if (!urls.length) {
    console.log('[keepalive] off (PUBLIC_URL is local - set PUBLIC_URL to your deployed URL to enable)');
    return;
  }
  Object.assign(keepaliveStatus, { enabled: true, urls });
  console.log(`[keepalive] pinging ${urls.length} URL(s) every ${INTERVAL_MIN} min: ${urls.join(', ')}`);
  // First ping shortly after boot (lets the server finish starting), then on the interval.
  setTimeout(runOnce, Math.min(60_000, INTERVAL_MIN * 60_000)).unref();
  setInterval(runOnce, INTERVAL_MIN * 60_000).unref();
}
