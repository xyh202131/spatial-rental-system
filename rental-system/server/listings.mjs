import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_MODEL_BYTES, validateModel } from './sample-imports.mjs';
import { createViewingSchedule, inTransaction } from './viewing-schedule.mjs';
import { previewJpeg } from './listing-preview.mjs';

const archiveId = 'ARCHIVE20260912';
const modelHosts = new Set(['holo-cos.aholo3d.cn', 'holo-cos.aholo3d.com']);
const demoId = 'demo';
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
    demoOnly: room.demoOnly, metersPerUnit: room.metersPerUnit ?? null,
  };
}

function storedRooms(row) {
  const model = JSON.parse(row.model);
  return model.rooms ?? [{ ...model, roomId: row.room_id, asset: row.asset }];
}

function publicListing(row) {
  const details = JSON.parse(row.details);
  const spaces = storedRooms(row).map(({ roomId, asset, photo, ...room }, index) => ({
    ...room, id: index === 0 ? row.id : `${row.id}-${room.sceneVersion}`, title: room.label || details.title,
    modelUrl: `/api/portal/listings/${row.id}/model/${room.sceneVersion}`,
    previewUrl: photo ? `/api/portal/listings/${row.id}/photo/${room.sceneVersion}` : null,
  }));
  return {
    ...spaces[0], ...details, id: row.id, spaces,
    acceptsViewings: details.listingMode !== 'showcase',
    scheduling: details.scheduling === true,
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
      status TEXT NOT NULL, created INTEGER NOT NULL, manage_hash TEXT
    );
  `);
  const active = db.prepare('SELECT * FROM portal_listings WHERE id=? AND active=1');
  const own = db.prepare('SELECT * FROM portal_listings WHERE id=? AND user_id=?');
  const byRoom = db.prepare('SELECT * FROM portal_listings WHERE user_id=? AND room_id=?');
  const publishing = new Set();
  const schedule = createViewingSchedule(db, { detail, own });

  function demoListing() {
    const fromArchive = Boolean(samples.asset(archiveId, 'ply'));
    const sample = samples.list().find(item => item.id === (fromArchive ? archiveId : 'DEMOLOUNGE'));
    if (!sample?.assets.ply) return null;
    const sceneVersion = fromArchive ? 'archive-20260912' : 'synthetic-lounge-v1';
    return {
      id: demoId, title: sample.title, district: fromArchive ? '浙大群核实验材料' : '程序生成样例',
      rent: null, area: null, description: sample.description,
      format: 'ply', modelUrl: `/api/portal/listings/demo/model/${sceneVersion}`, sceneVersion,
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

  function model(id, sceneVersion, kind = 'model') {
    if (id === demoId) {
      if (kind === 'model' && detail(id).sceneVersion === sceneVersion) {
        return samples.asset(sceneVersion === 'archive-20260912' ? archiveId : 'DEMOLOUNGE', 'ply').path;
      }
      fail(404, '找不到此空间文件。');
    }
    const row = active.get(id);
    const room = row && storedRooms(row).find(item => item.sceneVersion === sceneVersion);
    const file = kind === 'photo' ? room?.photo : room?.asset;
    if (!file) fail(404, '找不到此空间文件，请刷新页面。');
    return join(directory, file);
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
      listings: rows.map(row => ({ ...publicListing(row), roomId: row.room_id, active: Boolean(row.active), revision: row.revision,
        roomSelections: storedRooms(row).map(({ roomId, label, coverage, reviewedAt, metersPerUnit, sceneVersion, photo }) =>
          ({ roomId, label, coverage, reviewedAt, metersPerUnit, sceneVersion, hasPreview: Boolean(photo) })),
        slots: schedule.ownerSlots(row.id) })),
      requests,
    };
  }

  async function publish(userId, data, verify) {
    const details = listingInfo(data);
    const room = furnishing.room(userId, field(data.roomId, '空间成果', 96));
    if (data.sceneVersion !== room.sceneVersion) fail(409, '空间成果已更新，请重新选择后发布。');
    const old = byRoom.get(userId, room.id);
    const previous = old ? JSON.parse(old.details) : {};
    const previousRooms = old ? storedRooms(old) : [];
    details.coverageNote = field(data.coverageNote ?? previous.coverageNote ?? '', '未采集区域说明', 500, false);
    details.listingMode = data.listingMode ?? previous.listingMode ?? 'trial';
    if (!['trial', 'showcase'].includes(details.listingMode)) fail(400, '请选择联调房源或展示样例。');
    details.scheduling = data.scheduling ?? previous.scheduling ?? false;
    if (typeof details.scheduling !== 'boolean') fail(400, '预约时段设置无效。');
    const explicitRooms = data.rooms !== undefined;
    const requested = data.rooms ?? (previousRooms.length > 1 ? previousRooms : [{ roomId: room.id, sceneVersion: room.sceneVersion }]);
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 8 || requested[0]?.roomId !== room.id) {
      fail(400, '请选择一个主空间，单套房源最多发布八个空间。');
    }
    const versions = new Set();
    const selected = requested.map(input => {
      const current = furnishing.room(userId, field(input?.roomId, '空间成果', 96));
      if (current.sceneVersion !== input.sceneVersion) fail(409, '空间成果已更新，请重新选择后发布。');
      if (versions.has(current.sceneVersion)) fail(400, '同一空间只能加入一次。');
      versions.add(current.sceneVersion);
      if (explicitRooms && input.reviewed !== true) fail(422, '请先验收每个空间的入口视角、画面和公开内容。');
      const previousRoom = previousRooms.find(item => item.roomId === current.id && item.sceneVersion === current.sceneVersion);
      const coverage = input.coverage ?? previousRoom?.coverage ?? 'unknown';
      if (!['complete', 'partial', 'unknown'].includes(coverage)) fail(400, '采集覆盖状态无效。');
      if (coverage === 'partial' && !details.coverageNote) fail(422, '请说明哪些区域尚未采集。');
      if (input.preview != null && input.previewConsent !== true) fail(422, '请确认实拍图允许随房源公开。');
      const metersPerUnit = Object.hasOwn(input, 'metersPerUnit') ? input.metersPerUnit : previousRoom?.metersPerUnit ?? null;
      if (metersPerUnit !== null && (!Number.isFinite(metersPerUnit) || metersPerUnit < .000001 || metersPerUnit > 1000)) fail(400, '标定比例无效。');
      return {
        current, input, previousRoom,
        label: field(input.label ?? previousRoom?.label ?? current.title, '房间名称', 160),
        coverage, metersPerUnit, reviewedAt: explicitRooms ? Date.now() : previousRoom?.reviewedAt ?? null,
      };
    });
    if (data.revision !== (old?.revision ?? 0)) fail(409, '发布记录已修改，请刷新后重试。');
    if (!old && db.prepare('SELECT COUNT(*) AS count FROM portal_listings WHERE user_id=?').get(userId).count >= 100) {
      fail(429, '本账号已达到本地房源上限。');
    }
    const key = userId + ':' + room.id;
    if (publishing.has(key)) fail(409, '此空间正在发布，请稍候。');
    publishing.add(key);
    const newFiles = [];
    let committed = false;
    try {
      const id = old?.id || randomUUID();
      const snapshots = [];
      for (const { current, input, previousRoom, label, coverage, metersPerUnit, reviewedAt } of selected) {
        let asset = previousRoom?.asset;
        if (!asset) {
          const source = current.sourceType === 'reconstruction'
            ? { url: current.modelUrl }
            : samples.asset(current.sourceId, current.format) || imports.asset(current.sourceId, current.format, userId);
          if (!source) fail(404, '空间模型文件已丢失。');
          asset = randomUUID() + '.' + current.format;
          const destination = join(directory, asset);
          newFiles.push(destination);
          await writeModel(source, destination, current.format, fetchAsset);
        }
        let photo = input.preview === null ? null : previousRoom?.photo ?? null;
        if (input.preview != null) {
          const bytes = previewJpeg(input.preview);
          photo = randomUUID() + '.jpg';
          const destination = join(directory, photo);
          newFiles.push(destination);
          await writeFile(destination, bytes, { flag: 'wx' });
        }
        snapshots.push({ ...publicationModel(current), roomId: current.id, label, coverage, metersPerUnit, reviewedAt, asset, photo });
      }
      verify();
      inTransaction(db, () => {
        if ((byRoom.get(userId, room.id)?.revision ?? 0) !== data.revision ||
            selected.some(({ current }) => furnishing.room(userId, current.id).sceneVersion !== current.sceneVersion)) {
          fail(409, '发布期间房源或空间成果发生变化，请刷新后重试。');
        }
        db.prepare(`INSERT INTO portal_listings(id,user_id,room_id,details,model,asset,active,revision,updated)
        VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET details=excluded.details,model=excluded.model,
        asset=excluded.asset,active=1,revision=excluded.revision,updated=excluded.updated`)
          .run(id, userId, room.id, JSON.stringify(details), JSON.stringify({ rooms: snapshots }), snapshots[0].asset, data.revision + 1, Date.now());
        if (details.listingMode === 'showcase' && previous.listingMode !== 'showcase') schedule.cancelListing(id);
      });
      committed = true;
      return publicListing(active.get(id));
    } finally {
      publishing.delete(key);
      // 失败时只清理本次新建的未发布快照。
      if (!committed) await Promise.all(newFiles.map(path => rm(path, { force: true })));
    }
  }

  function withdraw(userId, id, revision) {
    inTransaction(db, () => {
      const row = own.get(id, userId);
      if (!row) fail(404, '找不到此房源。');
      if (row.revision !== revision) fail(409, '发布记录已修改，请刷新后重试。');
      db.prepare('UPDATE portal_listings SET active=0, revision=revision+1, updated=? WHERE id=?').run(Date.now(), id);
      schedule.cancelListing(id);
    });
  }

  function isAccepted(userId, roomId) {
    return db.prepare('SELECT room_id,model,asset FROM portal_listings WHERE user_id=? AND active=1').all(userId)
      .some(row => storedRooms(row).some(room => room.roomId === roomId && room.reviewedAt));
  }

  return { list, detail, model, furniture, furnitureFile, dashboard, publish, withdraw, isAccepted, ...schedule };
}
