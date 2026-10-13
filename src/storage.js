import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db, UPLOAD_DIR, httpError } from './db.js';
import { hmac, randomToken, safeEqual } from './crypto.js';
import { LIMITS } from './constants.js';

// Attachments (PRD §8, §13.4): JPG / PNG / PDF only, up to 5 MB, 1-3 per PDS, random file names,
// private storage, opened only through short-lived signed links.
// Cloudinary when configured (assets are `authenticated`, never public), local disk otherwise.

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
export const cloudEnabled = !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) && process.env.NODE_ENV !== 'test';
const FOLDER = (process.env.CLOUDINARY_FOLDER || 'squaddesk').replace(/\/+$/, '');
if (cloudEnabled) cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true });

const TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'application/pdf': { ext: '.pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
};

export const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (_req, _file, cb) => cb(null, `tmp-${randomToken(16)}`) }),
  limits: { fileSize: LIMITS.fileBytes, files: LIMITS.filesPerPds, fields: 20 },
  // Skip (rather than throw on) disallowed files so the body is fully read and the client gets a clean 400.
  fileFilter: (req, file, cb) => {
    if (TYPES[file.mimetype]) return cb(null, true);
    (req.rejectedFiles ??= []).push(file.originalname);
    cb(null, false);
  },
});

export const removeTemp = (files = []) => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));

/**
 * After multer: reject blocked types, and check each file's real signature (a renamed .exe is not a PDF).
 * Virus scanning: files are marked 'signature_ok'. Plug a scanner (e.g. ClamAV) in here before launch.
 */
export function validateUploads(req, _res, next) {
  const files = req.files ?? [];
  if (req.rejectedFiles?.length) {
    removeTemp(files);
    return next(httpError(400, `Only JPG, PNG or PDF files are allowed (${req.rejectedFiles.join(', ')})`));
  }
  for (const f of files) {
    const fd = fs.openSync(f.path, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    if (!TYPES[f.mimetype].magic(head)) {
      removeTemp(files);
      return next(httpError(400, `"${f.originalname}" does not look like a real ${TYPES[f.mimetype].ext.slice(1).toUpperCase()} file`));
    }
  }
  next();
}

const cleanName = (n) => String(n).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';

/** Persist validated temp files. All-or-nothing: on failure uploaded assets are removed. */
async function storeFiles(files) {
  const base = (f) => ({ file_name: cleanName(f.originalname), file_type: f.mimetype, size: f.size });
  if (!cloudEnabled) {
    return files.map((f) => {
      const key = `${randomToken(18)}${TYPES[f.mimetype].ext}`;
      fs.renameSync(f.path, path.join(UPLOAD_DIR, key));
      return { ...base(f), storage: 'local', storage_key: key, resource_type: null, format: null };
    });
  }
  const results = await Promise.allSettled(
    files.map((f) =>
      cloudinary.uploader.upload(f.path, {
        folder: `${FOLDER}/pds`,
        resource_type: f.mimetype === 'application/pdf' ? 'raw' : 'image',
        type: 'authenticated',
        public_id: `${randomToken(18)}${f.mimetype === 'application/pdf' ? '.pdf' : ''}`,
      }),
    ),
  );
  removeTemp(files);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    await deleteRemote(results.filter((r) => r.status === 'fulfilled').map((r) => ({ storage_key: r.value.public_id, resource_type: r.value.resource_type })));
    console.error('[storage] Cloudinary upload failed:', failed.reason?.message || failed.reason);
    throw httpError(502, 'We could not save your files right now. Please try again.');
  }
  return results.map((r, i) => ({ ...base(files[i]), storage: 'cloudinary', storage_key: r.value.public_id, resource_type: r.value.resource_type, format: r.value.format || null }));
}

/** Store files and insert attachment rows; cleans up stored files if the DB write fails. */
export async function saveAttachments(pdsId, files, userId) {
  if (!files?.length) return [];
  const stored = await storeFiles(files);
  try {
    const ins = db.prepare('INSERT INTO attachments (pds_id, file_name, storage_key, storage, resource_type, format, file_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of stored) ins.run(pdsId, s.file_name, s.storage_key, s.storage, s.resource_type, s.format, s.file_type, s.size, userId);
  } catch (e) {
    deleteStoredFiles(stored);
    throw e;
  }
  return stored;
}

async function deleteRemote(items) {
  await Promise.allSettled(items.map((i) => cloudinary.uploader.destroy(i.storage_key, { resource_type: i.resource_type, type: 'authenticated', invalidate: true })));
}

/** Best-effort removal of stored files (call after deleting the rows). */
export function deleteStoredFiles(rows = []) {
  for (const a of rows.filter((x) => x.storage !== 'cloudinary')) fs.rm(path.join(UPLOAD_DIR, a.storage_key), { force: true }, () => {});
  const remote = rows.filter((a) => a.storage === 'cloudinary');
  if (remote.length && cloudEnabled) deleteRemote(remote).catch((e) => console.error('[storage] Cloudinary delete failed:', e.message));
}

// ---------- short-lived signed links ----------
const LINK_TTL_S = 10 * 60;
const sig = (id, exp) => hmac(`${id}.${exp}`, 'file-link').slice(0, 32);

export function signedUrl(attachmentId) {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  return `/api/files/${attachmentId}?exp=${exp}&sig=${sig(attachmentId, exp)}`;
}

function contentDisposition(a, download) {
  const ascii = a.file_name.replace(/[^\x20-\x7e]|"/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.file_name)}`;
}

/** GET /api/files/:id?exp&sig - only valid, unexpired signatures are served. */
export async function serveSignedFile(req, res) {
  const id = Number(req.params.id);
  const exp = Number(req.query.exp);
  if (!id || !exp || exp < Date.now() / 1000 || !safeEqual(String(req.query.sig || ''), sig(id, exp))) {
    return res.status(403).json({ error: 'This file link has expired. Reload the page to get a new one.' });
  }
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: 'File not found' });
  const download = !!req.query.download;
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Type', a.file_type);
  res.setHeader('Content-Disposition', contentDisposition(a, download));
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (a.storage !== 'cloudinary') return res.sendFile(path.join(UPLOAD_DIR, a.storage_key));
  if (!cloudEnabled) return res.status(503).json({ error: 'File storage is not configured' });
  const url = cloudinary.utils.private_download_url(a.storage_key, a.resource_type === 'raw' ? '' : a.format || '', {
    resource_type: a.resource_type,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  const upstream = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!upstream.ok && upstream.status !== 206) {
    console.error(`[storage] Cloudinary fetch ${upstream.status} for attachment ${a.id}`);
    return res.status(502).json({ error: 'Could not load this file' });
  }
  res.status(upstream.status);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  Readable.fromWeb(upstream.body).pipe(res);
}
