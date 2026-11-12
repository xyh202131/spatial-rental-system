import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.mjs';

const origin = 'https://landlord.example';
const password = 'studio-test-password-only';

async function fixture(t, env) {
  const prefix = resolve(tmpdir(), 'rental-studio-');
  const dir = await mkdtemp(prefix);
  const app = createApp({ dataDir: dir, password, samplesRoot: join(dir, 'samples'), env });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.db.close();
    assert.ok(resolve(dir).startsWith(prefix));
    await rm(dir, { recursive: true, force: true });
  });
  return (path, { method = 'GET', data, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path, method, headers: {
      Host: 'internal-proxy:7860', Origin: origin, 'Content-Type': 'application/json', ...headers,
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
        value: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data ? JSON.stringify(data) : undefined);
  });
}

test('default host protection ignores forwarded headers', async t => {
  const get = await fixture(t, { PUBLIC_ORIGIN: origin });
  assert.equal((await get('/api/health', { headers: { 'X-Forwarded-Host': 'landlord.example' } })).status, 403);
  const health = await get('/api/health', { headers: { Host: 'landlord.example' } });
  assert.equal(health.status, 200);
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.match(health.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('dedicated proxy accepts rewritten Host but keeps origin, login and CSRF checks', async t => {
  const get = await fixture(t, { PUBLIC_ORIGIN: origin, TRUST_PROXY: '1' });
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await get('/api/session')).status, 401);
  const loginData = { username: 'landlord', password };
  const rejected = await get('/api/login', { method: 'POST', data: loginData,
    headers: { Origin: 'https://attacker.example', 'X-Forwarded-Host': 'landlord.example', 'X-Forwarded-Proto': 'https' } });
  assert.equal(rejected.status, 403);
  const login = await get('/api/login', { method: 'POST', data: loginData });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict;.*Secure/);
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/api/session', { headers: { Cookie } })).status, 200);
  assert.equal((await get('/api/logout', { method: 'POST', data: {}, headers: { Cookie } })).status, 403);
  const draft = await get('/api/drafts', { method: 'POST', data: { property: '测试', room: '客厅' },
    headers: { Cookie, 'X-CSRF-Token': login.value.csrf } });
  assert.equal(draft.status, 403);
  assert.equal(draft.value.code, 'VERIFICATION_REQUIRED');
});

test('Studio embedding is limited to official parent origins and never grants API access', async t => {
  const get = await fixture(t, { PUBLIC_ORIGIN: origin, TRUST_PROXY: '1', MODELSCOPE_EMBED: '1' });
  const embedded = await get('/', { headers: { 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(embedded.status, 200);
  assert.match(embedded.text, /id="app"/);
  assert.equal(embedded.headers['x-frame-options'], undefined);
  assert.match(embedded.headers['content-security-policy'], /frame-ancestors https:\/\/modelscope\.cn https:\/\/www\.modelscope\.cn;/);
  const direct = await get('/');
  assert.equal(direct.status, 200);
  assert.match(direct.text, /id="app"/);
  const api = await get('/api/session', { headers: { 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(api.status, 401);
});
