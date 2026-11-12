import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, encoded) {
  const [salt, digest] = encoded.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function openStore(directory, options = {}) {
  const dir = resolve(directory);
  mkdirSync(join(dir, 'media'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'rental.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      identity_mock INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_verifications (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','passed','failed')),
      front INTEGER NOT NULL DEFAULT 0, back INTEGER NOT NULL DEFAULT 0,
      property INTEGER NOT NULL DEFAULT 0, result TEXT, checked_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      property TEXT NOT NULL, room TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      review TEXT, review_revision INTEGER, confirmed_revision INTEGER
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, purpose TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      filename TEXT NOT NULL, captured TEXT NOT NULL, duration REAL NOT NULL DEFAULT 0,
      metrics TEXT NOT NULL, parent_id TEXT,
      source TEXT NOT NULL DEFAULT 'live-camera' CHECK(source IN ('live-camera','file-upload'))
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), revision INTEGER NOT NULL,
      state TEXT NOT NULL, world_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      message TEXT NOT NULL DEFAULT '', result TEXT, media_ids TEXT NOT NULL,
      submission_phase TEXT NOT NULL DEFAULT 'unknown', uploaded_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(draft_id, revision)
    );
    CREATE INDEX IF NOT EXISTS drafts_owner ON drafts(user_id);
    CREATE INDEX IF NOT EXISTS media_draft ON media(draft_id);
    CREATE TABLE IF NOT EXISTS sample_imports (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      source_key TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('spz','ply')),
      metadata TEXT NOT NULL, created INTEGER NOT NULL,
      UNIQUE(user_id, source_key)
    );
    CREATE TABLE IF NOT EXISTS sample_settings (
      user_id TEXT NOT NULL REFERENCES users(id), sample_id TEXT NOT NULL,
      title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      up_axis TEXT NOT NULL CHECK(up_axis IN ('Z','Y')), revision INTEGER NOT NULL,
      PRIMARY KEY(user_id, sample_id)
    );
  `);
  if (!db.prepare('PRAGMA table_info(media)').all().some(column => column.name === 'source')) {
    db.exec("ALTER TABLE media ADD COLUMN source TEXT NOT NULL DEFAULT 'live-camera' CHECK(source IN ('live-camera','file-upload'))");
  }
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(column => column.name));
  if (!jobColumns.has('submission_phase')) db.exec("ALTER TABLE jobs ADD COLUMN submission_phase TEXT NOT NULL DEFAULT 'unknown'");
  if (!jobColumns.has('uploaded_count')) db.exec('ALTER TABLE jobs ADD COLUMN uploaded_count INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    const username = options.username || 'landlord';
    const password = options.password || randomBytes(12).toString('base64url');
    if (password.length < 6) throw new Error('Initial password must contain at least 6 characters.');
    db.prepare('INSERT INTO users (id,username,password) VALUES (?,?,?)').run(randomUUID(), username, passwordHash(password));
    if (!options.password) {
      writeFileSync(join(dir, 'local-login.txt'), `本机 MVP 登录账号\n地址：http://localhost:${options.port || 4317}\n账号：${username}\n密码：${password}\n\n仅供本机体验。不要提交此文件。\n`, { mode: 0o600, flag: 'wx' });
    }
  }
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  // 已记录尚未发出创建请求的任务可以重传，其余中断任务保留待核对。
  db.prepare("UPDATE jobs SET state='FAILED', message='素材上传因服务中断，可重传同一批素材。' WHERE state='SUBMITTING' AND submission_phase='upload'").run();
  db.prepare("UPDATE jobs SET state='UNKNOWN', message='服务在提交过程中中断；请先核对平台任务，避免重复扣费。' WHERE state='SUBMITTING'").run();
  const mediaPath = file => join(dir, 'media', file);
  // Legacy identity_mock approvals did not include a property certificate. Never migrate them as passed.
  function verification(userId) {
    const row = db.prepare('SELECT * FROM user_verifications WHERE user_id=?').get(userId);
    return {
      mode: 'mock', status: row?.status || 'unverified', revision: row?.revision || 0,
      documents: { front: Boolean(row?.front), back: Boolean(row?.back), property: Boolean(row?.property) },
      result: row?.result || null, checkedAt: row?.checked_at || null,
    };
  }
  const publicUser = user => ({ id: user.id, username: user.username, verification: verification(user.id) });
  function draft(id, owner) {
    const row = db.prepare('SELECT * FROM drafts WHERE id=? AND user_id=?').get(id, owner);
    if (!row) return null;
    return {
      ...row,
      review: row.review ? JSON.parse(row.review) : null,
      media: db.prepare('SELECT * FROM media WHERE draft_id=? ORDER BY captured,id').all(id).map(m => ({ ...m, metrics: JSON.parse(m.metrics), url: `/api/media/${m.id}` })),
      jobs: db.prepare('SELECT * FROM jobs WHERE draft_id=? ORDER BY created DESC').all(id).map(j => ({ ...j, result: j.result ? JSON.parse(j.result) : null, media_ids: JSON.parse(j.media_ids) })),
    };
  }
  function touch(id) {
    db.prepare('UPDATE drafts SET revision=revision+1,updated=?,confirmed_revision=NULL WHERE id=?').run(Date.now(), id);
  }
  return { db, dir, mediaPath, publicUser, verification, draft, touch, credentialFile: existsSync(join(dir, 'local-login.txt')) ? join(dir, 'local-login.txt') : null };
}
