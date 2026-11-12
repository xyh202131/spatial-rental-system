import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { passwordHash } from '../server/store.mjs';
import { basicReview, reconstructionInput } from '../server/providers.mjs';

const password = 'test-only-password-123';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7N8AAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000')]);

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rental-mvp-'));
  const appOptions = { dataDir: dir, samplesRoot: join(dir, 'samples'), password, env: {}, ...options };
  let app = createApp(appOptions);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '', csrf = '';
    return {
      async request(path, { method = 'GET', data, bytes, meta, mime, headers = {} } = {}) {
        const response = await fetch(base + path, { method, headers: {
          // A restarted test server reuses its port, but must not reuse the prior TCP connection.
          Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, Connection: 'close',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(bytes ? { 'Content-Type': mime || 'image/png', 'X-Capture-Meta': encodeURIComponent(JSON.stringify(meta)) } : {}), ...headers,
        }, body: bytes || (data === undefined ? undefined : JSON.stringify(data)) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const isJson = response.headers.get('content-type')?.includes('application/json');
        const value = isJson ? await response.json() : Buffer.from(await response.arrayBuffer());
        if (value.csrf) csrf = value.csrf;
        return { status: response.status, value, headers: response.headers };
      },
      async login(username = 'landlord') { return this.request('/api/login', { method: 'POST', data: { username, password } }); },
      async verify(result = 'pass', documents = { front: true, back: true, property: true }) {
        const session = await this.request('/api/session');
        return this.request('/api/verification/mock', { method: 'POST', data: { result, documents, revision: session.value.user.verification?.revision ?? 0 } });
      },
      async draft() {
        assert.equal((await this.verify()).status, 200);
        const res = await this.request('/api/drafts', { method: 'POST', data: { property: '测试公寓', room: '客厅' } });
        assert.equal(res.status, 201); return res.value;
      },
      async upload(id, overrides = {}) {
        return this.request(`/api/drafts/${id}/media`, { method: 'POST', bytes: png, meta: { source: 'live-camera', captureId: randomUUID(), purpose: 'reconstruction', capturedAt: new Date().toISOString(), metrics: { brightness: 30 } }, ...overrides });
      },
    };
  };
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.db.close(); await rm(dir, { recursive: true, force: true }); });
  const user = client(); await user.login();
  return { app, dir, client, user, async restart() {
    const port = app.server.address().port;
    await new Promise(resolve => app.server.close(resolve)); app.store.db.close();
    app = createApp(appOptions);
    await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  } };
}

const archiveSamples = join(import.meta.dirname, '../outputs/aholo');
const archiveFurniture = join(import.meta.dirname, '../materials/furniture');

test('archive models, USDZ and a published room work with separated access and appointment receipts', async t => {
  const { app, user, client, restart } = await fixture(t, {
    samplesRoot: archiveSamples, furnitureDir: archiveFurniture, arDir: archiveFurniture,
  });
  const tenant = client();
  const other = client();
  app.store.db.prepare('INSERT INTO users (id,username,password) VALUES (?,?,?)').run(randomUUID(), 'another', passwordHash(password));
  assert.equal((await other.login('another')).status, 200);

  const demo = (await tenant.request('/api/portal/listings/demo')).value;
  assert.equal(demo.listing.acceptsViewings, false);
  assert.equal(demo.listing.rotationX, Math.PI);
  assert.equal((await tenant.request(demo.listing.modelUrl, { headers: { Range: 'bytes=0-2' } })).value.toString(), 'ply');
  const plant = demo.furniture.find(item => item.id === 'plant');
  assert.equal((await tenant.request(plant.url, { headers: { Range: 'bytes=0-3' } })).value.toString(), 'glTF');
  assert.equal((await tenant.request(plant.arUrl, { headers: { Range: 'bytes=0-3' } })).status, 206);
  assert.equal((await tenant.request('/api/landlord/portal')).status, 401);

  const dashboard = (await user.request('/api/landlord/portal')).value;
  const room = dashboard.rooms.find(item => item.id === 'sample-ARCHIVE20260912');
  const payload = {
    roomId: room.id, sceneVersion: room.sceneVersion, revision: 0,
    title: '集成测试空间', district: '课程样例', rent: 3200, area: 42, description: '演示数据',
  };
  const publish = data => user.request('/api/landlord/listings', { method: 'POST', data });
  assert.equal((await publish(payload)).status, 403);
  assert.equal((await user.verify()).status, 200);
  assert.equal((await publish({ ...payload, sceneVersion: 'stale' })).status, 409);
  const published = await publish(payload);
  assert.equal(published.status, 201);
  const listing = published.value.listing;
  assert.equal((await publish(payload)).status, 409);
  assert.equal((await tenant.request(listing.modelUrl, { headers: { Range: 'bytes=0-2' } })).status, 206);
  assert.equal((await tenant.request('/api/samples/ARCHIVE20260912/model.ply')).status, 401);

  const requested = new Date(Date.now() + 33 * 3600_000).toISOString().slice(0, 16);
  const booking = { name: '测试租客', contact: 'test@example.invalid', requested };
  const postBooking = data => tenant.request(`/api/portal/listings/${listing.id}/viewings`, { method: 'POST', data });
  assert.equal((await postBooking({ ...booking, requested: '2026-02-30T12:00' })).status, 400);
  const booked = await postBooking(booking);
  assert.equal(booked.status, 201);
  assert.equal((await postBooking(booking)).value.id, booked.value.id);
  const receiptPath = `/api/portal/viewings/${booked.value.id}`;
  assert.deepEqual((await tenant.request(receiptPath)).value, { status: 'pending', requested });
  assert.equal((await other.request('/api/landlord/portal')).value.requests.length, 0);
  const reviewPath = `/api/landlord/viewings/${booked.value.id}`;
  assert.equal((await other.request(reviewPath, { method: 'PATCH', data: { status: 'confirmed' } })).status, 404);
  assert.equal((await user.request(reviewPath, { method: 'PATCH', data: { status: 'confirmed' } })).status, 200);
  await restart();
  assert.deepEqual((await tenant.request(receiptPath)).value, { status: 'confirmed', requested });
  assert.equal((await tenant.request(listing.modelUrl, { headers: { Range: 'bytes=0-2' } })).status, 206);
  const withdraw = `/api/landlord/listings/${listing.id}/withdraw`;
  assert.equal((await other.request(withdraw, { method: 'POST', data: { revision: 1 } })).status, 404);
  assert.equal((await user.request(withdraw, { method: 'POST', data: { revision: 1 } })).status, 200);
  assert.equal((await tenant.request(listing.modelUrl)).status, 404);
  assert.equal((await postBooking(booking)).status, 404);
  assert.equal((await tenant.request(receiptPath)).value.status, 'confirmed');
});

test('completed reconstruction publishes an independent local snapshot through the allowed CDN only', async t => {
  const downloaded = await readFile(join(archiveSamples, 'ARCHIVE20260912/room.ply'));
  const calls = [];
  const { app, user, client } = await fixture(t, {
    publishFetch: async (url, options) => {
      calls.push([url.hostname, options.redirect]);
      return new Response(downloaded);
    },
  });
  const draft = await user.draft();
  const id = randomUUID();
  app.store.db.prepare(`INSERT INTO jobs(id,draft_id,revision,state,world_id,created,updated,result,media_ids)
    VALUES(?,?,0,'SUCCEEDED','world-test',?,?,?, '[]')`)
    .run(id, draft.id, Date.now(), Date.now(), JSON.stringify({ ply: 'https://example.invalid/model.ply', upAxis: 'Y' }));
  const publish = async () => {
    const { rooms } = (await user.request('/api/landlord/portal')).value;
    const room = rooms.find(item => item.id === 'job-' + id);
    return user.request('/api/landlord/listings', { method: 'POST', data: {
      roomId: room.id, sceneVersion: room.sceneVersion, revision: 0, title: '重建成果测试', district: '演示', rent: 1, area: 1,
    } });
  };
  assert.equal((await publish()).status, 422);
  assert.deepEqual(calls, []);
  const initialView = { position: [1, 2, 3], target: [3, 4, 5] };
  app.store.db.prepare('UPDATE jobs SET result=? WHERE id=?')
    .run(JSON.stringify({ ply: 'https://holo-cos.aholo3d.cn/model.ply?signature=test', upAxis: 'Y', initialView }), id);
  const published = await publish();
  assert.equal(published.status, 201);
  assert.deepEqual(calls, [['holo-cos.aholo3d.cn', 'error']]);
  assert.deepEqual((await client().request(`/api/portal/listings/${published.value.listing.id}`)).value.listing.initialView, initialView);
  assert.ok(!JSON.stringify(published.value).includes('signature'));
  app.store.db.prepare("UPDATE jobs SET state='FAILED' WHERE id=?").run(id);
  assert.equal((await client().request(published.value.listing.modelUrl, { headers: { Range: 'bytes=0-2' } })).value.toString(), 'ply');
});

test('imported samples are separate authenticated assets with ranges, downloads and a fixed catalog', async t => {
  const { user, client, dir } = await fixture(t);
  const meetingDir = join(dir, 'samples', '3FO4K4VCF7LG');
  const workbenchDir = join(dir, 'samples', '3FO4K4XNH9NX');
  const path = '/api/samples/3FO4K4VCF7LG/model.spz';
  await mkdir(meetingDir, { recursive: true });
  await mkdir(workbenchDir, { recursive: true });
  await writeFile(join(meetingDir, 'meeting-room.spz'), 'meeting-room-spz');
  await writeFile(join(meetingDir, 'meeting-room.ply'), 'meeting-room-ply');
  await writeFile(join(workbenchDir, 'workbench.spz'), 'workbench-spz');
  assert.equal((await client().request(path)).status, 401);
  const config = (await user.request('/api/config')).value;
  assert.equal(config.samples[0].id, '3FO4K4VCF7LG');
  assert.equal(config.samples[0].name, 'Modern Office Meeting Room');
  assert.equal(config.samples[0].source, 'https://studio.aholo3d.com/viewer?projectId=3FO4K4VCF7LG');
  assert.equal(config.samples[0].assets.spz, path);
  assert.equal(config.samples[0].available, true);
  assert.equal(config.samples[1].assets.ply, null);
  const range = await user.request(path, { headers: { Range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(range.value.toString(), 'meeting');
  assert.equal(range.headers.get('content-range'), 'bytes 0-6/16');
  const head = await user.request(path, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.value.length, 0);
  assert.equal(head.headers.get('content-length'), '16');
  const download = await user.request('/api/samples/3FO4K4VCF7LG/model.ply?download=1');
  assert.equal(download.value.toString(), 'meeting-room-ply');
  assert.match(download.headers.get('content-disposition'), /meeting-room\.ply/);
  assert.equal((await user.request('/api/sample/model.spz')).value.toString(), 'workbench-spz');
  assert.equal((await user.request(path, { headers: { Range: 'bytes=999-1000' } })).status, 416);
  for (const invalid of ['/api/samples/unknown/model.spz', '/api/samples/%2e%2e%2f/model.spz', '/api/samples/3FO4K4VCF7LG/model.env', '/api/samples/3FO4K4XNH9NX/model.ply']) {
    assert.equal((await user.request(invalid)).status, 404);
  }
  await unlink(join(meetingDir, 'meeting-room.spz'));
  await unlink(join(meetingDir, 'meeting-room.ply'));
  assert.equal((await user.request(path)).status, 404);
  assert.equal((await user.request('/api/config')).value.samples[0].available, false);
  assert.deepEqual((await user.request('/api/drafts')).value.drafts, []);
  assert.equal((await user.request('/api/drafts', { method: 'POST', data: { property: 'a', room: 'b' } })).status, 403);
});

test('session is server-validated; CSRF, origin, logout and expiry are enforced', async t => {
  const { user, client, app } = await fixture(t);
  const anon = client();
  assert.equal((await anon.request('/api/drafts')).status, 401);
  const wrong = await anon.request('/api/login', { method: 'POST', data: { username: 'landlord', password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const login = await anon.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await user.request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await user.request('/api/logout', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await user.request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await user.request('/api/session')).status, 401);
  app.store.db.prepare('UPDATE sessions SET expires=0').run();
  assert.equal((await anon.request('/api/session')).status, 401);
});

test('account verification requires both ID sides and a property certificate, never certificate bytes or fields', async t => {
  const { user, dir } = await fixture(t);
  const blocked = await user.request('/api/drafts', { method: 'POST', data: { property: 'a', room: 'b' } });
  assert.equal(blocked.status, 403); assert.equal(blocked.value.code, 'VERIFICATION_REQUIRED');
  assert.equal((await user.verify('pass', { front: true, back: true })).status, 400);
  assert.equal((await user.verify('pass', { front: true, back: true, property: false })).status, 400);
  for (const extra of [{ image: 'data:image/png;base64,private' }, { name: 'someone' }]) {
    assert.equal((await user.request('/api/verification/mock', { method: 'POST', data: { result: 'pass', documents: { front: true, back: true, property: true }, revision: 0, ...extra } })).status, 400);
  }
  const verified = await user.verify();
  assert.equal(verified.status, 200); assert.equal(verified.value.user.verification.status, 'passed');
  assert.equal(verified.value.user.verification.mode, 'mock');
  assert.deepEqual(verified.value.user.verification.documents, { front: true, back: true, property: true });
  assert.deepEqual(await readdir(join(dir, 'media')), []);
});

test('failed or reset verification blocks every main workflow mutation while retaining saved records', async t => {
  let providerCalls = 0;
  const providers = { visionEnabled: true, reconstructionEnabled: true, review: basicReview, async live() { providerCalls++; }, async reconstruct() { providerCalls++; }, async status() { providerCalls++; } };
  const { user, app } = await fixture(t, { providers }), draft = await user.draft();
  const saved = await user.upload(draft.id);
  const jobId = randomUUID(), now = Date.now();
  app.store.db.prepare('INSERT INTO jobs (id,draft_id,revision,state,world_id,created,updated,media_ids) VALUES (?,?,?,?,?,?,?,?)').run(jobId, draft.id, 1, 'RUNNING', 'test-world', now, now, '[]');
  for (const reset of [() => user.verify('property'), () => user.request('/api/verification/reset', { method: 'POST' })]) {
    assert.equal((await reset()).status, 200);
    for (const [path, method, data] of [
      ['/api/drafts', 'POST', { property: 'a', room: 'b' }],
      [`/api/drafts/${draft.id}`, 'PATCH', { notes: 'must not save' }],
      [`/api/drafts/${draft.id}/review`, 'POST', { allowExternal: true }],
      [`/api/drafts/${draft.id}/issues`, 'PATCH', {}],
      [`/api/drafts/${draft.id}/confirm`, 'POST', { manual: true }],
      [`/api/drafts/${draft.id}/jobs`, 'POST', { confirmCost: true }],
      [`/api/media/${saved.value.id}`, 'DELETE'],
      [`/api/jobs/${jobId}/refresh`, 'POST'],
      ['/api/guidance/live', 'POST', { frame: 'data:image/jpeg;base64,aaaa' }],
    ]) {
      const result = await user.request(path, { method, data });
      assert.equal(result.status, 403, path); assert.equal(result.value.code, 'VERIFICATION_REQUIRED', path);
    }
    assert.equal((await user.upload(draft.id)).status, 403);
    assert.equal((await user.request('/api/drafts')).value.drafts.length, 1);
    assert.equal((await user.request(`/api/drafts/${draft.id}`)).value.revision, 1);
    assert.equal((await user.request(`/api/media/${saved.value.id}`)).status, 200);
    assert.equal((await user.request('/api/config')).status, 200);
  }
  assert.equal(providerCalls, 0);
  assert.equal((await user.verify()).status, 200);
  assert.equal((await user.upload(draft.id)).status, 201);
});

test('legacy ID approval does not grant new access; verification survives restart and rejects stale submissions', async t => {
  const { user, app, restart } = await fixture(t);
  app.store.db.prepare('UPDATE users SET identity_mock=1').run();
  await restart();
  assert.equal((await user.request('/api/session')).value.user.verification.status, 'unverified');
  assert.equal((await user.request('/api/identity-mock', { method: 'POST', data: { result: 'mock-pass' } })).status, 410);
  assert.equal((await user.request('/api/drafts', { method: 'POST', data: { property: 'a', room: 'b' } })).status, 403);
  const passed = await user.verify();
  await restart();
  assert.equal((await user.request('/api/session')).value.user.verification.status, 'passed');
  await user.request('/api/verification/reset', { method: 'POST' });
  const stale = await user.request('/api/verification/mock', { method: 'POST', data: { result: 'pass', documents: { front: true, back: true, property: true }, revision: passed.value.user.verification.revision } });
  assert.equal(stale.status, 409);
  assert.equal((await user.request('/api/session')).value.user.verification.status, 'unverified');
  assert.equal((await user.verify('failed')).value.user.verification.status, 'failed');
  await restart();
  assert.equal((await user.request('/api/session')).value.user.verification.status, 'failed');
});

test('revoking verification during asynchronous review prevents the result from advancing the draft', async t => {
  let release, started;
  const reviewing = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const providers = { visionEnabled: false, reconstructionEnabled: false, async review(draft) { started(); await barrier; return basicReview(draft); } };
  const { user } = await fixture(t, { providers }), draft = await user.draft();
  await user.upload(draft.id);
  const pending = user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  await reviewing;
  await user.request('/api/verification/reset', { method: 'POST' });
  release();
  assert.equal((await pending).status, 403);
  assert.equal((await user.request(`/api/drafts/${draft.id}`)).value.review, null);
});

test('drafts, media, review and reports cannot be accessed by another account', async t => {
  const { app, user, client } = await fixture(t);
  const draft = await user.draft(), media = await user.upload(draft.id);
  assert.equal(media.status, 201);
  app.store.db.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(randomUUID(), 'another', passwordHash(password));
  const other = client(); await other.login('another');
  await other.verify();
  for (const path of [`/api/drafts/${draft.id}`, `/api/media/${media.value.id}`, `/api/drafts/${draft.id}/report`]) assert.equal((await other.request(path)).status, 404);
  assert.equal((await other.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} })).status, 404);
  assert.equal((await other.request('/api/drafts')).value.drafts.length, 0);
});

test('same capture can be retried without creating duplicate files or a new revision', async t => {
  const { user, dir } = await fixture(t);
  const draft = await user.draft();
  const meta = { source: 'live-camera', captureId: randomUUID(), purpose: 'check', capturedAt: new Date().toISOString() };
  const first = await user.upload(draft.id, { meta }), retry = await user.upload(draft.id, { meta });
  assert.equal(first.status, 201); assert.equal(retry.status, 200);
  assert.equal(first.value.id, retry.value.id); assert.equal(retry.value.draft.revision, 1);
  assert.equal(retry.value.draft.media.length, 1); assert.equal((await readdir(join(dir, 'media'))).length, 1);
  const changed = Buffer.concat([png, Buffer.from('changed')]);
  assert.equal((await user.upload(draft.id, { meta, bytes: changed })).status, 409);
});

test('media rejects invalid capture metadata, spoofed content and orphan frames', async t => {
  const { user } = await fixture(t), draft = await user.draft();
  assert.equal((await user.upload(draft.id, { meta: { source: 'gallery' } })).status, 400);
  assert.equal((await user.upload(draft.id, { bytes: Buffer.from('not-a-real-image-buffer') })).status, 415);
  assert.equal((await user.upload(draft.id, { meta: { source: 'live-camera', captureId: randomUUID(), purpose: 'video-frame', parentId: randomUUID(), capturedAt: new Date().toISOString() } })).status, 400);
  const saved = await user.upload(draft.id);
  const partial = await user.request(`/api/media/${saved.value.id}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(partial.status, 206); assert.deepEqual(partial.value, png.subarray(0, 8));
  assert.equal((await user.request(`/api/media/${saved.value.id}`, { headers: { Range: 'bytes=99999-' } })).status, 416);
});

test('file uploads preserve provenance and retry safely without impersonating camera media', async t => {
  const { user } = await fixture(t), draft = await user.draft();
  const meta = { source: 'file-upload', captureId: randomUUID(), purpose: 'reconstruction', capturedAt: new Date().toISOString() };
  const first = await user.upload(draft.id, { meta });
  assert.equal(first.status, 201);
  assert.equal(first.value.draft.media[0].source, 'file-upload');
  assert.equal((await user.upload(draft.id, { meta })).status, 200);
  assert.equal((await user.upload(draft.id, { meta: { ...meta, source: 'live-camera' } })).status, 409);
  assert.equal((await user.upload(draft.id, { meta: { ...meta, purpose: 'video-frame' } })).status, 400);
  const report = await user.request(`/api/drafts/${draft.id}/report`);
  assert.equal(report.value.media[0].source, 'file-upload');
  assert.equal(report.value.revision, 1);
});

test('supplementing and deleting media invalidate review and manual confirmation', async t => {
  const { user } = await fixture(t), draft = await user.draft();
  assert.equal((await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} })).status, 422);
  const saved = await user.upload(draft.id);
  let res = await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  assert.equal(res.value.review.mode, 'local');
  assert.ok(res.value.review.issues.some(i => i.mediaId === saved.value.id));
  assert.equal((await user.request(`/api/drafts/${draft.id}/confirm`, { method: 'POST', data: { manual: true } })).status, 200);
  const added = await user.upload(draft.id);
  assert.notEqual(added.value.draft.review_revision, added.value.draft.revision);
  assert.equal(added.value.draft.confirmed_revision, null);
  assert.equal((await user.request(`/api/drafts/${draft.id}/confirm`, { method: 'POST', data: { manual: true } })).status, 409);
  res = await user.request(`/api/media/${added.value.id}`, { method: 'DELETE' });
  assert.equal(res.value.media.length, 1); assert.equal(res.value.revision, 3);
});

test('report includes evidence and issue notes, excludes private field notes', async t => {
  const { user } = await fixture(t), draft = await user.draft(); await user.upload(draft.id);
  const reviewed = await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  await user.request(`/api/drafts/${draft.id}`, { method: 'PATCH', data: { notes: 'PRIVATE_INTERNAL_NOTE' } });
  const issue = reviewed.value.review.issues[0];
  assert.equal((await user.request(`/api/drafts/${draft.id}/issues`, { method: 'PATCH', data: { id: issue.id, status: 'noted', note: '' } })).status, 400);
  await user.request(`/api/drafts/${draft.id}/issues`, { method: 'PATCH', data: { id: issue.id, status: 'noted', note: '明天补拍窗边' } });
  const report = await user.request(`/api/drafts/${draft.id}/report`);
  assert.equal(report.value.reconstructionAccepted, false);
  assert.equal(report.value.review.issues[0].note, '明天补拍窗边');
  assert.equal(JSON.stringify(report.value).includes('PRIVATE_INTERNAL_NOTE'), false);
});

test('same-version paid submission is never repeated, including ambiguous create results', async t => {
  let calls = 0;
  const providers = { visionEnabled: false, reconstructionEnabled: true, review: basicReview, async reconstruct(_d, _p, creating) { calls++; creating(); throw new Error('connection lost'); } };
  const { user, app } = await fixture(t, { providers });
  const draft = await user.draft(); await user.upload(draft.id, { bytes: mp4, mime: 'video/mp4' });
  await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  await user.request(`/api/drafts/${draft.id}/confirm`, { method: 'POST', data: { manual: true } });
  assert.equal((await user.request(`/api/drafts/${draft.id}/jobs`, { method: 'POST', data: { confirmCost: false } })).status, 400);
  assert.equal((await user.request(`/api/drafts/${draft.id}/jobs`, { method: 'POST', data: { confirmCost: true } })).status, 202);
  assert.equal((await user.request(`/api/drafts/${draft.id}/jobs`, { method: 'POST', data: { confirmCost: true } })).status, 409);
  assert.equal(calls, 1); assert.equal(app.store.db.prepare('SELECT state FROM jobs').get().state, 'UNKNOWN');
});

test('platform preprocessing is preserved and success without a model requires an asset', async t => {
  let status = 'PREPROCESSING';
  const providers = { visionEnabled: false, reconstructionEnabled: true, review: basicReview, async reconstruct(_d, _p, creating) { creating(); return 'test-world'; }, async status() { return { status, spz: null, ply: null }; } };
  const { user } = await fixture(t, { providers }), draft = await user.draft();
  const media = await user.upload(draft.id, { bytes: mp4, mime: 'video/mp4' });
  await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  await user.request(`/api/drafts/${draft.id}/confirm`, { method: 'POST', data: { manual: true } });
  const job = await user.request(`/api/drafts/${draft.id}/jobs`, { method: 'POST', data: { confirmCost: true } });
  const processing = await user.request(`/api/jobs/${job.value.jobId}/refresh`, { method: 'POST' });
  assert.equal(processing.value.jobs[0].state, 'PREPROCESSING');
  status = 'SUCCEEDED';
  const result = await user.request(`/api/jobs/${job.value.jobId}/refresh`, { method: 'POST' });
  assert.equal(result.value.jobs[0].state, 'ASSET_MISSING');
  assert.equal((await user.request(`/api/media/${media.value.id}`, { method: 'DELETE' })).status, 409);
});

test('selection excludes independent checks and video frames; WebM is not renamed MP4', () => {
  const check = { id: 'check', kind: 'photo', purpose: 'check' };
  const frame = { id: 'frame', kind: 'photo', purpose: 'video-frame' };
  const webm = { id: 'video', kind: 'video', mime: 'video/webm' };
  assert.throws(() => reconstructionInput([check, frame, webm]), /20/);
  const photos = Array.from({ length: 20 }, (_, i) => ({ id: String(i), kind: 'photo', purpose: 'reconstruction' }));
  assert.deepEqual(reconstructionInput([...photos, check, frame, webm]), photos);
});

test('saved originals, review and sessions survive a complete server restart', async t => {
  const { user, restart } = await fixture(t), draft = await user.draft();
  const saved = await user.upload(draft.id);
  await user.request(`/api/drafts/${draft.id}/review`, { method: 'POST', data: {} });
  await restart();
  const restored = await user.request(`/api/drafts/${draft.id}`);
  assert.equal(restored.status, 200); assert.equal(restored.value.media.length, 1);
  assert.equal(restored.value.review_revision, restored.value.revision);
  assert.deepEqual((await user.request(`/api/media/${saved.value.id}`)).value, png);
});
