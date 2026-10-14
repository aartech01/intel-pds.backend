import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { db } from './db.js';
import { IS_PROD } from './config.js';
import { securityHeaders, parseCookies, ensureCsrfCookie, csrfProtect } from './security.js';
import { authenticate } from './auth.js';
import { cloudEnabled } from './storage.js';
import { keepaliveStatus } from './keepalive.js';
import { announceWrites, liveStream } from './live.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import pdsRoutes from './routes/pds.js';
import adminRoutes from './routes/admin.js';
import integrationRoutes from './routes/integrations.js';
import { LIMITS } from './constants.js';

export function createApp() {
  const app = express();
  // Proxy hops in front of the app: 1 = host only (Railway); 2 = Vercel rewrite + Railway, so rate limits see the real client IP.
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  if (IS_PROD) {
    // HTTPS only (§13.4) - behind a proxy such as Render / Railway the original scheme is in x-forwarded-proto.
    app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
  }

  // Health check for uptime monitors and the keep-alive pinger. 503 if the database is down.
  const startedAt = Date.now();
  app.get('/api/health', (_req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      database = 'error';
    }
    const ok = database === 'ok';
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? 'healthy' : 'degraded',
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
      checks: {
        database,
        storage: cloudEnabled ? 'cloudinary' : 'local',
        keepalive: { enabled: keepaliveStatus.enabled, interval_min: keepaliveStatus.interval_min, last_run: keepaliveStatus.last_run },
      },
    });
  });

  // QR scan entry point (PRD §1): count the scan, then open sign up / login with the source attached.
  app.get('/q/:slug', (req, res) => {
    const qr = db.prepare('SELECT * FROM qr_codes WHERE slug = ?').get(req.params.slug);
    if (!qr || !qr.is_active) return res.redirect('/');
    db.prepare('UPDATE qr_codes SET scan_count = scan_count + 1 WHERE id = ?').run(qr.id);
    res.redirect(`/start?src=${encodeURIComponent(qr.slug)}`);
  });

  // Automation (n8n): bearer-token API, no cookies or CSRF. Mounted before the session middleware.
  app.use('/api/integrations', express.json({ limit: '200kb' }), integrationRoutes);

  app.use('/api', parseCookies, express.json({ limit: '200kb' }), ensureCsrfCookie, csrfProtect, authenticate, announceWrites);
  app.get('/api/live', liveStream);
  app.use('/api', publicRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', pdsRoutes);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built client in production.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(clientDist)) {
    // Hashed build files never change: cache them for a year. Everything else (index.html, logos) is revalidated,
    // so a new deploy shows up on the next visit.
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders: (res, file) =>
          res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(clientDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be ${LIMITS.fileBytes / 1024 / 1024} MB or smaller` : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${LIMITS.filesPerPds} files` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const body = { error: status >= 500 && !err.expose ? 'Something went wrong' : err.message };
    if (err.code && typeof err.code === 'string' && err.expose) body.code = err.code;
    if (err.fields) body.fields = err.fields;
    res.status(status).json(body);
  });

  return app;
}
