import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { db, tx } from './db.js';
import { BCRYPT_COST, IS_PROD } from './config.js';
import { encrypt, hmac, normEmail, normPhone } from './crypto.js';
import { nextPdsCode, changeStatus, getPdsById } from './pds.js';
import { book, currentWeek, addWeeks, tick, syncBookingStatus } from './slots.js';

const ADMIN_EMAIL = normEmail(process.env.ADMIN_EMAIL || 'admin@squaddesk.local');
const ADMIN_PHONE = normPhone(process.env.ADMIN_PHONE || '+919000000001');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DEMO_PASSWORD = 'DemoUser2026';

async function createUser({ full_name, display_name, email, phone, role = 'user', password }) {
  const r = db
    .prepare(
      `INSERT INTO users (full_name_enc, display_name, email_enc, email_hmac, phone_enc, phone_hmac, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(encrypt(full_name), display_name, encrypt(email), hmac(email, 'email'), encrypt(phone), hmac(phone, 'phone'), await bcrypt.hash(password, BCRYPT_COST), role);
  return Number(r.lastInsertRowid);
}

/** First Super Admin (from ADMIN_* env) when there is none; demo community data in development. */
export async function ensureSeed() {
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'super_admin' AND deleted_at IS NULL").get()) {
    await createUser({ full_name: 'Squad Admin', display_name: 'Squad Admin', email: ADMIN_EMAIL, phone: ADMIN_PHONE, role: 'super_admin', password: ADMIN_PASSWORD });
    console.log(`[seed] Super Admin created: ${ADMIN_EMAIL} (set up two-factor authentication at first login)`);
  }
  if (!db.prepare('SELECT 1 FROM qr_codes').get()) {
    db.prepare("INSERT INTO qr_codes (label, slug) VALUES ('Office poster', 'office-poster')").run();
  }
  // Demo data only on a brand-new database, and only once. "No PDS" alone is not enough: after an admin deletes every
  // PDS the demo users still exist, and re-creating them crashed the server on start-up.
  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'demo_seeded'").get();
  const brandNew = !db.prepare("SELECT 1 FROM users WHERE role != 'super_admin'").get() && !db.prepare('SELECT 1 FROM pds').get();
  if (!seeded && brandNew && !IS_PROD && process.env.SEED_DEMO !== 'false') await seedDemo();
  if (!seeded) db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('demo_seeded', '1')").run();
}

async function seedDemo() {
  const people = [
    ['Riya Sharma', 'Riya', 'riya@demo.squaddesk.local', '+919000000011'],
    ['Arjun Mehta', 'Arjun', 'arjun@demo.squaddesk.local', '+919000000012'],
    ['Neha Verma', 'Neha', 'neha@demo.squaddesk.local', '+919000000013'],
    ['Kabir Singh', 'Kabir', 'kabir@demo.squaddesk.local', '+919000000014'],
  ];
  const ids = [];
  for (const [full_name, display_name, email, phone] of people) ids.push(await createUser({ full_name, display_name, email, phone, password: DEMO_PASSWORD }));
  const dev = await createUser({ full_name: 'Dev Patel', display_name: 'Dev', email: 'dev@demo.squaddesk.local', phone: '+919000000021', role: 'team_member', password: DEMO_PASSWORD });

  const make = (userId, title, type, problem, expected, urgency, visibility = 'public') =>
    Number(
      db
        .prepare(`INSERT INTO pds (pds_code, user_id, title, type, problem_statement, expected_result, urgency, visibility, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
        .run(nextPdsCode(), userId, title, type, problem, expected, urgency, visibility).lastInsertRowid,
    );
  const to = (id, status, note) => changeStatus(getPdsById(id), status, null, { kind: 'system', note, notify: false });
  const approve = (id, size) => {
    to(id, 'submitted');
    to(id, 'under_review');
    db.prepare('UPDATE pds SET size_weeks = ? WHERE id = ?').run(size, id);
    to(id, 'approved');
  };
  const comment = (pdsId, userId, text, type = null, extra = {}) => {
    const r = db.prepare('INSERT INTO comments (pds_id, user_id, comment_type, text, is_team, parent_id, is_useful) VALUES (?, ?, ?, ?, ?, ?, ?)').run(pdsId, userId, type, text, extra.team ? 1 : 0, extra.parent ?? null, extra.useful ? 1 : 0);
    db.prepare('UPDATE pds SET comment_count = comment_count + 1 WHERE id = ?').run(pdsId);
    return Number(r.lastInsertRowid);
  };
  const upvote = (pdsId, userIds) => {
    for (const u of userIds) db.prepare('INSERT OR IGNORE INTO upvotes (pds_id, user_id) VALUES (?, ?)').run(pdsId, u);
    db.prepare('UPDATE pds SET upvote_count = (SELECT COUNT(*) FROM upvotes WHERE pds_id = ?) WHERE id = ?').run(pdsId, pdsId);
  };
  const week = currentWeek();

  tx(() => {
    const sales = make(ids[0], 'Automate daily sales report', 'automation', 'Every evening our shop staff copy sales from the billing software into an Excel sheet and WhatsApp it to the owner. It takes about an hour and has mistakes.', 'A report that builds itself from the billing data and is sent to the owner at 9 pm.', 'High');
    approve(sales, 2);
    book(sales, 'A', week, 'admin');
    syncBookingStatus(sales, 'in_development');
    to(sales, 'in_development');
    db.prepare("INSERT INTO progress_updates (pds_id, percent, note, created_by) VALUES (?, 45, 'Billing export connected, report layout in review', ?)").run(sales, dev);
    db.prepare('UPDATE pds SET progress_percent = 45, assigned_to = ? WHERE id = ?').run(dev, sales);
    const pdfIdea = comment(sales, ids[1], 'We have the same problem. Please also send the report as a PDF, not only Excel.', 'point', { useful: true });
    comment(sales, dev, 'Good point - PDF is now in the plan.', null, { team: true, parent: pdfIdea });
    db.prepare('INSERT INTO pds_requirements (pds_id, comment_id, text) VALUES (?, ?, ?)').run(sales, pdfIdea, 'Send the report as a PDF as well as Excel');
    upvote(sales, [ids[1], ids[2], ids[3]]);

    const billing = make(ids[1], 'Simple billing app for my shop', 'software', 'I run a small hardware shop and write bills by hand. I need GST bills on my phone and a daily total.', 'Android app that prints or shares GST bills on WhatsApp.', 'Medium');
    approve(billing, 3);
    book(billing, 'B', week, 'admin');
    syncBookingStatus(billing, 'in_development');
    to(billing, 'in_development');
    db.prepare('UPDATE pds SET progress_percent = 70 WHERE id = ?').run(billing);
    upvote(billing, [ids[0], ids[3]]);

    const attendance = make(ids[2], 'Student attendance bot', 'automation', 'Teachers take attendance on paper and enter it into a spreadsheet at the end of the week. Parents only learn about absences much later.', 'A WhatsApp bot where teachers mark attendance and parents get a message the same day.', 'Medium');
    approve(attendance, 2);
    book(attendance, 'A', addWeeks(week, 2), 'user');
    comment(attendance, ids[0], 'Could it also show a monthly summary per student?', 'idea');
    comment(attendance, ids[3], 'Our school tried a paid app - the hard part was teachers with old phones. Keep it simple.', 'suggestion');
    upvote(attendance, [ids[0], ids[1], ids[3]]);

    const leave = make(ids[3], 'Leave requests on WhatsApp get lost', 'problem', 'Our team of 25 asks for leave on WhatsApp. Messages get lost and nobody knows who is on leave next week.', 'One place to request and approve leave, with a calendar of who is away.', 'Medium');
    approve(leave, 1);

    const idea = make(ids[0], 'Marketplace for local tutors', 'idea', 'Parents in small towns find tutors only through word of mouth. Good tutors stay unknown.', null, 'Low');
    to(idea, 'submitted');
    to(idea, 'under_review');
    comment(idea, ids[2], 'Verification of tutors will matter a lot for parents.', 'point');
    upvote(idea, [ids[2]]);

    const stock = make(ids[2], 'Stock alerts for our pharmacy', 'automation', 'We run out of fast-moving medicines because nobody checks stock levels until a customer asks.', 'A daily alert listing medicines below the minimum stock.', 'High');
    to(stock, 'submitted');

    const priv = make(ids[1], 'Payroll sheet clean-up', 'automation', 'Private: our payroll sheet has formulas that break every month.', null, 'Low', 'private');
    to(priv, 'submitted');
  });
  tick();
  console.log(`[seed] Demo data added: 4 users + 1 team member (password ${DEMO_PASSWORD}), 7 PDS, bookings and comments`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureSeed();
  console.log('Seed complete');
}
