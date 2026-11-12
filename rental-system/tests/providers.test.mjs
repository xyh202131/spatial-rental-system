import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviders } from '../server/providers.mjs';

test('vision adapter uses provided evidence IDs and rejects fabricated associations and malformed output', async t => {
  let reply = { summary: '检查所给画面', issues: [{ mediaId: 'real-photo', title: '窗边偏亮', evidence: '窗边细节不清楚', action: '换角度补拍' }] };
  let received;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'rental-vision-test-'));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { force: true, recursive: true }); });
  await writeFile(join(dir, 'photo.jpg'), Buffer.from('test-frame'));
  const providers = createProviders({ VISION_CHAT_URL: `http://127.0.0.1:${server.address().port}/chat/completions`, VISION_MODEL: 'stub-vision', VISION_API_KEY: 'test-only' });
  const draft = { media: [{ id: 'real-photo', filename: 'photo.jpg', kind: 'photo', mime: 'image/jpeg' }] };
  const result = await providers.review(draft, f => join(dir, f));
  assert.equal(result.mode, 'vision'); assert.equal(result.issues[0].mediaId, 'real-photo');
  assert.equal(received.model, 'stub-vision'); assert.equal(received.messages[0].content[2].type, 'image_url');
  reply.issues[0].mediaId = 'invented-photo';
  await assert.rejects(providers.review(draft, f => join(dir, f)), /证据关联无效/);
  reply = null;
  await assert.rejects(providers.live('data:image/jpeg;base64,AA=='), /格式无效/);
  reply = { tip: '慢慢转向窗边，避开反光。' };
  assert.equal((await providers.live('data:image/jpeg;base64,AA==')).tip, reply.tip);
});

test('Aholo keeps the saved indoor camera when available and still returns an asset when it is private', async t => {
  const worldId = '3FO4TESTROOM';
  const spz = 'https://holo-cos.aholo3d.cn/room.spz';
  let status = 'RUNNING', readable = true, cameraRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url === `https://api.aholo3d.cn/world/v1/${worldId}`) {
      return Response.json({ status, assets: { splats: { urls: { spzPath: spz } } } });
    }
    assert.equal(options.headers.Authorization, undefined);
    cameraRequests++;
    if (url === `https://studio.aholo3d.cn/aholo/api/project/info?projectId=${worldId}`) {
      return readable ? Response.json({ c: '0', d: { id: worldId, dataId: 'TESTCAMERA', task: { status: 3 } } }) : new Response(null, { status: 403 });
    }
    assert.equal(url, 'https://studio.aholo3d.cn/holo/project/data/share/v2/TESTCAMERA');
    return Response.json({ c: '0', d: { camera: { position: { x: 1, y: 2, z: 3 }, lookAt: { x: 3, y: 4, z: 5 } } } });
  });
  const provider = createProviders({ AHOLO_API_KEY: 'test-only' });
  assert.equal((await provider.status(worldId)).initialView, undefined);
  assert.equal(cameraRequests, 0);
  status = 'SUCCEEDED';
  const ready = await provider.status(worldId);
  assert.deepEqual(ready.initialView, { position: [1, 2, 3], target: [3, 4, 5] });
  assert.equal(cameraRequests, 2);
  readable = false;
  const withoutCamera = await provider.status(worldId);
  assert.equal(withoutCamera.initialView, undefined);
  assert.equal(withoutCamera.spz, spz);
});
