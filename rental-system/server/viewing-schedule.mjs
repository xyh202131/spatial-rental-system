import { randomBytes, randomUUID } from 'node:crypto';
import { tokenHash } from './store.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const day = 86_400_000;
const beijing = 8 * 3_600_000;
const viewingSeconds = 30 * 60;

function input(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(400, `${label}为空或超出长度限制。`);
  return value.trim();
}

function nowInBeijing() {
  return new Date(Date.now() + beijing).toISOString().slice(0, 16);
}

function futureTime(value) {
  const requested = input(value, '预约时间', 16);
  const time = Date.parse(requested + ':00+08:00');
  const now = Date.now();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(requested) || !Number.isFinite(time) || time <= now ||
      time > now + 90 * day || new Date(time + beijing).toISOString().slice(0, 16) !== requested) {
    fail(400, '请选择未来 90 天内的有效北京时间。');
  }
  return requested;
}

export function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createViewingSchedule(db, { detail, own }) {
  if (!db.prepare('PRAGMA table_info(portal_viewings)').all().some(column => column.name === 'manage_hash')) {
    db.exec('ALTER TABLE portal_viewings ADD COLUMN manage_hash TEXT');
  }
  if (db.prepare('PRAGMA index_list(portal_viewings)').all().some(index => index.origin === 'u')) {
    // 旧的全量去重约束会阻止已取消时段被同一租客重新预约。迁移保留旧回执 ID。
    inTransaction(db, () => db.exec(`
      ALTER TABLE portal_viewings RENAME TO portal_viewings_legacy;
      CREATE TABLE portal_viewings (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES portal_listings(id),
        name TEXT NOT NULL, contact TEXT NOT NULL, requested TEXT NOT NULL,
        status TEXT NOT NULL, created INTEGER NOT NULL, manage_hash TEXT
      );
      INSERT INTO portal_viewings(id,listing_id,name,contact,requested,status,created,manage_hash)
        SELECT id,listing_id,name,contact,requested,status,created,manage_hash FROM portal_viewings_legacy;
      DROP TABLE portal_viewings_legacy;
    `));
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_viewing_slots (
      listing_id TEXT NOT NULL REFERENCES portal_listings(id),
      requested TEXT NOT NULL, PRIMARY KEY(listing_id, requested)
    );
    CREATE INDEX IF NOT EXISTS portal_viewings_by_listing ON portal_viewings(listing_id, status, requested);
    CREATE UNIQUE INDEX IF NOT EXISTS portal_viewings_active_contact ON portal_viewings(listing_id, contact, requested)
      WHERE status IN ('pending','confirmed');
  `);
  const ownerListing = db.prepare('SELECT user_id, active FROM portal_listings WHERE id=?');
  const findSlot = db.prepare('SELECT requested FROM portal_viewing_slots WHERE listing_id=? AND requested=?');
  const findViewing = db.prepare('SELECT * FROM portal_viewings WHERE id=?');
  const sameRequest = db.prepare("SELECT id FROM portal_viewings WHERE listing_id=? AND contact=? AND requested=? AND status IN ('pending','confirmed')");
  const conflict = db.prepare(`SELECT 1 FROM portal_viewings v JOIN portal_listings l ON l.id=v.listing_id
    WHERE l.user_id=? AND v.status='confirmed' AND v.id<>?
      AND abs(unixepoch(v.requested)-unixepoch(?))<? LIMIT 1`);
  const available = db.prepare(`SELECT s.requested FROM portal_viewing_slots s
    WHERE s.listing_id=? AND s.requested>? AND NOT EXISTS (
      SELECT 1 FROM portal_viewings v JOIN portal_listings l ON l.id=v.listing_id
      WHERE l.user_id=? AND v.status='confirmed' AND v.id<>?
        AND abs(unixepoch(v.requested)-unixepoch(s.requested))<?
    ) ORDER BY s.requested`);

  function slots(listingId, ignoreId = '') {
    const row = ownerListing.get(listingId);
    if (!row?.active) return [];
    return available.all(listingId, nowInBeijing(), row.user_id, ignoreId, viewingSeconds).map(row => row.requested);
  }

  function ownerSlots(listingId) {
    return db.prepare('SELECT requested FROM portal_viewing_slots WHERE listing_id=? AND requested>? ORDER BY requested')
      .all(listingId, nowInBeijing()).map(row => row.requested);
  }

  function setSlot(userId, listingId, data) {
    const requested = futureTime(data.requested);
    if (typeof data.open !== 'boolean') fail(400, '请选择开放或关闭时段。');
    return inTransaction(db, () => {
      if (!own.get(listingId, userId)?.active) fail(404, '未找到已发布房源。');
      const listing = detail(listingId);
      if (!listing.scheduling || !listing.acceptsViewings) fail(409, '请先为房源启用预约时段。');
      if (data.open) {
        if (findSlot.get(listingId, requested)) return;
        if (ownerSlots(listingId).length >= 60) fail(429, '最多开放 60 个未来时段。');
        const overlap = db.prepare(`SELECT 1 FROM portal_viewing_slots WHERE listing_id=?
          AND abs(unixepoch(requested)-unixepoch(?))<? LIMIT 1`).get(listingId, requested, viewingSeconds);
        if (overlap) fail(409, '此房源已有重叠的 30 分钟时段。');
        db.prepare('INSERT INTO portal_viewing_slots VALUES (?,?)').run(listingId, requested);
        return;
      }
      if (db.prepare("SELECT 1 FROM portal_viewings WHERE listing_id=? AND requested=? AND status='confirmed'").get(listingId, requested)) {
        fail(409, '此时段已有已确认预约，请先取消预约。');
      }
      db.prepare('DELETE FROM portal_viewing_slots WHERE listing_id=? AND requested=?').run(listingId, requested);
      db.prepare("UPDATE portal_viewings SET status='cancelled' WHERE listing_id=? AND requested=? AND status='pending'").run(listingId, requested);
    });
  }

  function requireAvailable(listingId, requested, ignoreId = '') {
    const listing = detail(listingId);
    if (!listing.acceptsViewings) fail(400, '此房源当前不接受预约。');
    if (listing.scheduling && !findSlot.get(listingId, requested)) fail(409, '此时段未开放，请重新选择。');
    if (conflict.get(ownerListing.get(listingId).user_id, ignoreId, requested, viewingSeconds)) fail(409, '此时段已有确认的看房预约。');
  }

  function requestViewing(listingId, data) {
    const name = input(data.name, '称呼', 40);
    const contact = input(data.contact, '联系方式', 80);
    const requested = futureTime(data.requested);
    return inTransaction(db, () => {
      const prior = sameRequest.get(listingId, contact, requested);
      if (prior) {
        if (!detail(listingId).acceptsViewings) fail(400, '此房源当前不接受预约。');
        return { id: prior.id };
      }
      requireAvailable(listingId, requested);
      const pending = db.prepare("SELECT COUNT(*) AS count FROM portal_viewings WHERE listing_id=? AND status='pending' AND requested>?")
        .get(listingId, nowInBeijing());
      if (pending.count >= 100) fail(429, '此房源待处理预约已满。');
      const id = randomUUID(), manageToken = randomBytes(32).toString('base64url');
      db.prepare(`INSERT INTO portal_viewings(id,listing_id,name,contact,requested,status,created,manage_hash)
        VALUES(?,?,?,?,?,'pending',?,?)`).run(id, listingId, name, contact, requested, Date.now(), tokenHash(manageToken));
      return { id, manageToken };
    });
  }

  function respond(userId, id, status) {
    if (!['confirmed', 'declined', 'cancelled'].includes(status)) fail(400, '预约处理状态无效。');
    inTransaction(db, () => {
      const row = findViewing.get(id);
      if (!row || !own.get(row.listing_id, userId)) fail(404, '找不到此预约。');
      if (row.status !== 'pending' && !(row.status === 'confirmed' && status === 'cancelled')) fail(409, '预约已经处理。');
      if (status === 'confirmed') {
        if (row.requested <= nowInBeijing()) fail(409, '此预约时间已过。');
        requireAvailable(row.listing_id, row.requested, id);
      }
      db.prepare('UPDATE portal_viewings SET status=? WHERE id=?').run(status, id);
    });
  }

  function receipt(id, manageToken) {
    const row = findViewing.get(id);
    if (!row) fail(404, '找不到此预约回执。');
    const result = { status: row.status, requested: row.requested };
    if (typeof manageToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(manageToken) &&
        row.manage_hash === tokenHash(manageToken) && ownerListing.get(row.listing_id)?.active &&
        row.requested > nowInBeijing() && ['pending', 'confirmed'].includes(row.status)) {
      result.canManage = true;
      result.scheduling = detail(row.listing_id).scheduling;
      result.slots = slots(row.listing_id, id).filter(time => time !== row.requested);
    }
    return result;
  }

  function manage(id, data) {
    inTransaction(db, () => {
      const record = receipt(id, data.manageToken);
      if (!record.canManage) fail(403, '此回执当前不能修改。');
      if (data.action === 'cancel') {
        db.prepare("UPDATE portal_viewings SET status='cancelled' WHERE id=?").run(id);
        return;
      }
      if (data.action !== 'reschedule') fail(400, '请选择取消或改期。');
      const requested = futureTime(data.requested);
      const row = findViewing.get(id);
      if (requested === row.requested) fail(400, '请选择其他时段。');
      requireAvailable(row.listing_id, requested, id);
      if (sameRequest.get(row.listing_id, row.contact, requested)) fail(409, '该时段已有同一联系方式的预约记录。');
      db.prepare("UPDATE portal_viewings SET requested=?,status='pending' WHERE id=?").run(requested, id);
    });
    return receipt(id, data.manageToken);
  }

  function cancelListing(listingId) {
    db.prepare("UPDATE portal_viewings SET status='cancelled' WHERE listing_id=? AND requested>? AND status IN ('pending','confirmed')")
      .run(listingId, nowInBeijing());
    db.prepare('DELETE FROM portal_viewing_slots WHERE listing_id=?').run(listingId);
  }

  return { slots, ownerSlots, setSlot, requestViewing, respond, receipt, manage, cancelListing };
}
