import { Router } from 'express';
import { db, getSettings } from '../db.js';
import { COMMENT_TYPES, LIMITS, PDS_TYPES, ROLE_LABELS, SLOT_STATUSES, STATUSES, URGENCY } from '../constants.js';
import { ALLOW_2FA_SKIP, TURNSTILE_SITE_KEY } from '../config.js';
import { teamTwoFactorRequired } from '../auth.js';
import { calendar, capacity } from '../slots.js';
import { serveSignedFile } from '../storage.js';

const router = Router();

// Everything the client needs to render forms and labels (no secrets).
router.get('/config', (_req, res) => {
  const s = getSettings();
  res.json({
    branding: { team_name: s.team_name, product_name: s.product_name },
    types: PDS_TYPES,
    urgency: URGENCY,
    statuses: Object.fromEntries(Object.entries(STATUSES).map(([k, v]) => [k, v.label])),
    slot_statuses: SLOT_STATUSES,
    comment_types: COMMENT_TYPES,
    roles: ROLE_LABELS,
    limits: LIMITS,
    captcha_site_key: TURNSTILE_SITE_KEY || null,
    allow_2fa_skip: ALLOW_2FA_SKIP,
    team_2fa_required: teamTwoFactorRequired(),
  });
});

/** Guest view (PRD §5): slot calendar summary - which weeks are busy or free, no project details. */
router.get('/public/summary', (_req, res) => {
  const cal = calendar({ label: () => null });
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  res.json({
    capacity: capacity(),
    weeks: cal.weeks.map((w) => ({ week_start: w.week_start, week_no: w.week_no, cells: w.cells.map((c) => ({ lane: c.lane, status: c.status, from: c.from, to: c.to })) })),
    stats: {
      delivered: one("SELECT COUNT(*) FROM pds WHERE status IN ('delivered','closed')"),
      in_development: one("SELECT COUNT(*) FROM pds WHERE status IN ('in_development','testing')"),
      community: one("SELECT COUNT(*) FROM pds WHERE visibility = 'public' AND status NOT IN ('draft','withdrawn','rejected')"),
    },
  });
});

router.get('/files/:id', serveSignedFile);

export default router;
