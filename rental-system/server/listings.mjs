import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_MODEL_BYTES, validateModel } from './sample-imports.mjs';

const archiveId = 'ARCHIVE20260912';
const modelHosts = new Set(['holo-cos.aholo3d.cn', 'holo-cos.aholo3d.com']);
const demoId = 'demo';
const requestStates = ['confirmed', 'declined'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function field(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(400, `${label}为空或超出长度限制。`);
  }
  return value.trim();
}

function listingInfo(data) {
  const rent = data.rent;
  const area = data.area;
  if (!Number.isSafeInteger(rent) || rent < 1 || rent > 1_000_000) fail(400, '月租须为 1–1000000 元的整数。');
  if (!Number.isFinite(area) || area <= 0 || area > 10_000) fail(400, '面积须大于 0，且不超过 10000 平方米。');
  return {
    title: field(data.title, '房源名称', 80),
    district: field(data.district, '片区', 80),
    rent, area,
    description: field(data.description ?? '', '房源介绍', 600, false),
  };
}

function publicationModel(room) {
  return {
    format: room.format, sceneVersion: room.sceneVersion,
    upAxis: room.upAxis, rotationX: room.rotationX, initialView: room.initialView,
    demoOnly: room.demoOnly,
  };
}

function publicListing(row) {
  const model = JSON.parse(row.model);
  return {
    id: row.id, ...JSON.parse(row.details), ...model,
    modelUrl: `/api/portal/listings/${row.id}/model/${model.sceneVersion}`,
    acceptsViewings: true,
  };
}

async function writeModel(asset, destination, format, fetchAsset) {
  const signal = AbortSignal.timeout(90_000);
  let source;
  if (asset.path) {
    if (statSync(asset.path).size > MAX_MODEL_BYTES) fail(413, '模型超过本地发布大小限制。');
    source = createReadStream(asset.path);
  } else {
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !modelHosts.has(url.hostname) || !url.pathname.endsWith('.' + format)) {
      fail(422, '该云端模型无法直接发布，请下载后从重建样例导入。');
    }
    let response;
    try { response = await fetchAsset(url, { signal, redirect: 'error' }); }
    catch { fail(502, '下载云端模型失败，请刷新成果状态后重试。'); }
    if (!response.ok || !response.body) fail(502, '云端模型暂不可下载，请刷新成果状态后重试。');
    if (Number(response.headers.get('content-length')) > MAX_MODEL_BYTES) {
      await response.body.cancel();
      fail(413, '模型超过本地发布大小限制。');
    }
    source = response.body;
  }
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > MAX_MODEL_BYTES) return done(Object.assign(new Error('模型超过本地发布大小限制。'), { status: 413 }));
      done(null, chunk);
    },
  });
  await pipeline(source, limit, createWriteStream(destination, { flags: 'wx' }), { signal });
  await validateModel(destination, format, signal);
}

export function createListings({ store, furnishing, samples, imports, arDir, fetchAsset = fetch }) {
  const { db } = store;
  const directory = join(store.dir, 'published');
  mkdirSync(directory, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_listings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), room_id TEXT NOT NULL,
      details TEXT NOT NULL, model TEXT NOT NULL, asset TEXT NOT NULL,
      active INTEGER NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(user_id, room_id)
    );
    CREATE TABLE IF NOT EXISTS portal_viewings (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL REFERENCES portal_listings(id),
      name TEXT NOT NULL, contact TEXT NOT NULL, requested TEXT NOT NULL,
      status TEXT NOT NULL, created INTEGER NOT NULL,
      UNIQUE(listing_id, contact, requested)
    );
  `);
  const active = db.prepare('SELECT * FROM portal_listings WHERE id=? AND active=1');
  const own = db.prepare('SELECT * FROM portal_listings WHERE id=? AND user_id=?');
  const byRoom = db.prepare('SELECT * FROM portal_listings WHERE user_id=? AND room_id=?');
  const publishing = new Set();

  function demoListing() {
    const model = samples.asset(archiveId, 'ply');
    if (!model) return null;
    const sample = samples.list().find(item => item.id === archiveId);
    return {
      id: demoId, title: '云谷魔搭会议室', district: '浙大群核实验材料',
      rent: null, area: null, description: '查看材料包中的三维空间，试摆盆栽与蓝色猫咪摆件。',
      format: 'ply', modelUrl: '/api/portal/listings/demo/model/archive-20260912', sceneVersion: 'archive-20260912',
      upAxis: sample.upAxis, rotationX: sample.rotationX, initialView: sample.initialView, demoOnly: true, acceptsViewings: false,
    };
  }

  function list() {
    const rows = db.prepare('SELECT * FROM portal_listings WHERE active=1 ORDER BY updated DESC LIMIT 100').all();
    return [...rows.map(publicListing), demoListing()].filter(Boolean);
  }

  function detail(id) {
    const row = id === demoId ? demoListing() : active.get(id);
    if (!row) fail(404, '房源已下架或不存在。');
    return id === demoId ? row : publicListing(row);
  }

  function model(id, sceneVersion) {
    if (detail(id).sceneVersion !== sceneVersion) fail(404, '该房源模型版本已更换，请刷新页面。');
    if (id === demoId) return samples.asset(archiveId, 'ply').path;
    return join(directory, active.get(id).asset);
  }

  function furniture() {
    return furnishing.furniture().map(item => ({
      ...item, url: `/api/portal/furniture/${item.id}.glb`,
      arUrl: furnitureFile(item.id, 'usdz') ? `/api/portal/furniture/${item.id}.usdz` : null,
    }));
  }

  function furnitureFile(id, format) {
    if (!['plant', 'blue-cat'].includes(id)) return null;
    if (format === 'glb') return furnishing.furnitureAsset(id)?.path || null;
    if (format !== 'usdz' || !arDir) return null;
    const path = join(arDir, id + '.usdz');
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : null;
  }

  function dashboard(userId) {
    const rows = db.prepare('SELECT * FROM portal_listings WHERE user_id=? ORDER BY updated DESC').all(userId);
    const requests = db.prepare(`SELECT v.id,v.listing_id,v.name,v.contact,v.requested,v.status,v.created
      FROM portal_viewings v JOIN portal_listings l ON l.id=v.listing_id
      WHERE l.user_id=? ORDER BY v.created DESC LIMIT 200`).all(userId);
    return {
      rooms: furnishing.rooms(userId).map(({ id, title, sceneVersion, demoOnly }) => ({ id, title, sceneVersion, demoOnly })),
      listings: rows.map(row => ({ ...publicListing(row), roomId: row.room_id, active: Boolean(row.active), revision: row.revision })),
      requests,
    };
  }

  async function publish(userId, data, verify) {
    const details = listingInfo(data);
    const room = furnishing.room(userId, field(data.roomId, '空间成果', 96));
    if (data.sceneVersion !== room.sceneVersion) fail(409, '空间成果已更新，请重新选择后发布。');
    const old = byRoom.get(userId, room.id);
    if (data.revision !== (old?.revision ?? 0)) fail(409, '发布记录已修改，请刷新后重试。');
    if (!old && db.prepare('SELECT COUNT(*) AS count FROM portal_listings WHERE user_id=?').get(userId).count >= 100) {
      fail(429, '本账号已达到本地房源上限。');
    }
    const key = userId + ':' + room.id;
    if (publishing.has(key)) fail(409, '此空间正在发布，请稍候。');
    publishing.add(key);
    let newFile;
    try {
      const model = publicationModel(room);
      const id = old?.id || randomUUID();
      let assetName = old?.asset;
      if (!old || JSON.parse(old.model).sceneVersion !== room.sceneVersion) {
        const asset = room.sourceType === 'reconstruction'
          ? { url: room.modelUrl }
          : samples.asset(room.sourceId, room.format) || imports.asset(room.sourceId, room.format, userId);
        if (!asset) fail(404, '空间模型文件已丢失。');
        assetName = randomUUID() + '.' + room.format;
        newFile = join(directory, assetName);
        await writeModel(asset, newFile, room.format, fetchAsset);
      }
      verify();
      if (furnishing.room(userId, room.id).sceneVersion !== room.sceneVersion ||
          (byRoom.get(userId, room.id)?.revision ?? 0) !== data.revision) {
        fail(409, '发布期间房源或空间成果发生变化，请刷新后重试。');
      }
      db.prepare(`INSERT INTO portal_listings(id,user_id,room_id,details,model,asset,active,revision,updated)
        VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET details=excluded.details,model=excluded.model,
        asset=excluded.asset,active=1,revision=excluded.revision,updated=excluded.updated`)
        .run(id, userId, room.id, JSON.stringify(details), JSON.stringify(model), assetName, data.revision + 1, Date.now());
      newFile = null;
      return publicListing(active.get(id));
    } finally {
      publishing.delete(key);
      // 失败时只清理本次新建的未发布快照。
      if (newFile) await rm(newFile, { force: true });
    }
  }

  function withdraw(userId, id, revision) {
    const row = own.get(id, userId);
    if (!row) fail(404, '找不到此房源。');
    if (row.revision !== revision) fail(409, '发布记录已修改，请刷新后重试。');
    db.prepare('UPDATE portal_listings SET active=0, revision=revision+1, updated=? WHERE id=?').run(Date.now(), id);
  }

  function requestViewing(id, data) {
    if (!detail(id).acceptsViewings) fail(400, '此空间是展示样例。');
    const name = field(data.name, '称呼', 40);
    const contact = field(data.contact, '联系方式', 80);
    const requested = field(data.requested, '预约时间', 16);
    const time = Date.parse(requested + ':00+08:00');
    const now = Date.now();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(requested) || !Number.isFinite(time) ||
        time <= now || time > now + 90 * 86400_000 ||
        new Date(time + 8 * 3600_000).toISOString().slice(0, 16) !== requested) {
      fail(400, '请选择未来 90 天内的有效北京时间。');
    }
    const existing = db.prepare('SELECT id FROM portal_viewings WHERE listing_id=? AND contact=? AND requested=?').get(id, contact, requested);
    if (existing) return existing;
    const pending = db.prepare("SELECT COUNT(*) AS count FROM portal_viewings WHERE listing_id=? AND status='pending'").get(id);
    if (pending.count >= 100) fail(429, '此房源待处理预约已满。');
    const request = randomUUID();
    db.prepare('INSERT INTO portal_viewings VALUES(?,?,?,?,?,?,?)').run(request, id, name, contact, requested, 'pending', now);
    return { id: request };
  }

  function respond(userId, id, status) {
    if (!requestStates.includes(status)) fail(400, '预约处理状态无效。');
    const row = db.prepare(`SELECT v.status FROM portal_viewings v JOIN portal_listings l ON l.id=v.listing_id
      WHERE v.id=? AND l.user_id=?`).get(id, userId);
    if (!row) fail(404, '找不到此预约。');
    if (row.status !== 'pending') fail(409, '预约已经处理。');
    db.prepare('UPDATE portal_viewings SET status=? WHERE id=?').run(status, id);
  }

  function receipt(id) {
    const row = db.prepare('SELECT status,requested FROM portal_viewings WHERE id=?').get(id);
    if (!row) fail(404, '找不到此预约回执。');
    return row;
  }

  return { list, detail, model, furniture, furnitureFile, dashboard, publish, withdraw, requestViewing, respond, receipt };
}
