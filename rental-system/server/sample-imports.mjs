import { createReadStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { mkdir, open, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';

export const MAX_MODEL_BYTES = 150 * 1024 * 1024;
const MAX_POINTS = 5_000_000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const projectPattern = /^[A-Z0-9]{8,40}$/;

export function parseProjectLink(value) {
  let url;
  try { url = new URL(typeof value === 'string' && value.length <= 2048 ? value.trim() : ''); }
  catch { fail(400, '请粘贴完整的 Aholo 项目分享链接。'); }
  if (url.protocol !== 'https:' || !['studio.aholo3d.cn', 'studio.aholo3d.com'].includes(url.hostname) || url.port || url.username || url.password) fail(400, '仅支持 Aholo 官方项目分享链接。');
  const projectId = /^\/viewer\/?$/.test(url.pathname) ? url.searchParams.get('projectId') : /^\/3dgs-model\/([A-Z0-9]+)\/?$/.exec(url.pathname)?.[1];
  if (!projectPattern.test(projectId || '')) fail(400, '链接缺少有效的项目编号。');
  return { projectId, origin: url.origin, source: `${url.origin}/viewer?projectId=${projectId}` };
}

function modelOptions(data) {
  const title = data.title ?? '';
  if (typeof title !== 'string' || title.trim().length > 80) fail(400, '案例名称不能超过 80 个字。');
  if (!['Z', 'Y'].includes(data.upAxis || 'Z')) fail(400, '请选择有效的模型向上方向。');
  const note = data.note ?? '';
  if (typeof note !== 'string' || note.length > 500) fail(400, '案例备注不能超过 500 个字。');
  return { title: title.trim(), note:note.trim(), upAxis: data.upAxis || 'Z' };
}

// Check the on-disk payload, not the user-provided extension or MIME type.
export async function validateModel(path, format, signal) {
  if (format === 'spz') {
    const input = createReadStream(path, { signal }), decoder = createGunzip();
    input.on('error', error => decoder.destroy(error)); input.pipe(decoder);
    let header = Buffer.alloc(0), expanded = 0;
    try {
      for await (const chunk of decoder) {
        signal?.throwIfAborted(); expanded += chunk.length;
        if (expanded > 256 * 1024 * 1024) fail(413, '模型解压后过大，请导出较小的 SPZ。');
        if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
      }
    } catch (error) {
      if (error.status || signal?.aborted) throw error;
      fail(400, 'SPZ 无法解压，请选择完整的 SPZ 模型文件。');
    } finally { input.destroy(); decoder.destroy(); }
    if (header.length !== 16 || header.toString('ascii', 0, 4) !== 'NGSP') fail(400, '文件不是有效的 SPZ 高斯模型。');
    const version = header.readUInt32LE(4), count = header.readUInt32LE(8), degree = header[12];
    if (![2, 3].includes(version) || !count || count > MAX_POINTS || degree > 3 || expanded < 16 + count * 19) fail(400, 'SPZ 版本、点数或数据长度不受支持（支持 v2/v3，最多 500 万点）。');
    return count;
  }
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const bytes = prefix.subarray(0, bytesRead), end = /\nend_header\r?\n/.exec(bytes.toString('ascii'));
    const start = end ? end.index + end[0].length : 0;
    if (!start) fail(400, 'PLY 文件头不完整。');
    const lines = bytes.toString('ascii', 0, start).split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== 'ply' || !lines.includes('format binary_little_endian 1.0')) fail(400, '请选择标准二进制 Gaussian Splat PLY；暂不支持 ASCII、压缩 PLY 或普通网格。');
    const types = { char:1, uchar:1, short:2, ushort:2, int:4, uint:4, float:4, double:8 };
    const properties = new Set(); let count = 0, stride = 0, vertex = false;
    for (const line of lines) {
      const words = line.split(/\s+/);
      if (words[0] === 'element') {
        if (words[1] !== 'vertex' || vertex || words.length !== 3) fail(400, '仅支持单个 vertex 元素的 Gaussian Splat PLY。');
        count = Number(words[2]); vertex = true;
      }
      if (words[0] === 'property') {
        if (!vertex || !Object.hasOwn(types, words[1]) || words.length !== 3 || properties.has(words[2])) fail(400, 'PLY 属性格式不受支持。');
        stride += types[words[1]]; properties.add(words[2]);
      }
    }
    const required = ['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2'];
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_POINTS || !required.every(name => properties.has(name)) || start + count * stride !== (await file.stat()).size) fail(400, 'PLY 缺少高斯属性、点数超限或数据不完整。');
    signal?.throwIfAborted(); return count;
  } finally { await file.close(); }
}

function initialCamera(camera) {
  const vector = item => ['x', 'y', 'z'].map(axis => item?.[axis]);
  const position = vector(camera?.position), target = vector(camera?.lookAt);
  if (![...position, ...target].every(value => Number.isFinite(value) && Math.abs(value) < 1e6) || Math.hypot(...position.map((v, i) => v - target[i])) < .0001) return undefined;
  return { position, target };
}

async function remote(fetchImpl, url, signal, json = false) {
  let response;
  try { response = await fetchImpl(url, { signal, redirect:'error', headers:{ Accept:json ? 'application/json' : 'application/octet-stream' } }); }
  catch { signal.throwIfAborted(); fail(502, '暂时无法连接 Aholo，请稍后重试，或改用本地文件导入。'); }
  if (!response.ok || !response.body) { await response.body?.cancel(); fail(502, 'Aholo 项目不可读取，请确认链接已公开且任务已完成。'); }
  if (!json) return response;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 2 * 1024 * 1024) fail(502, '平台项目信息过大，无法导入。'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(502, '平台返回的信息无法解析。'); }
}

export async function readAholoInitialView(project, { signal, fetchImpl = fetch, info } = {}) {
  const { origin, projectId } = project;
  if (!['https://studio.aholo3d.cn', 'https://studio.aholo3d.com'].includes(origin) || !projectPattern.test(projectId)) return undefined;
  const timeout = AbortSignal.timeout(8000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const details = info ?? await remote(fetchImpl, `${origin}/aholo/api/project/info?projectId=${projectId}`, deadline, true);
    const item = details?.d;
    if (String(details?.c) !== '0' || item?.id !== projectId || item.task?.status !== 3 || !projectPattern.test(item.dataId || '')) return undefined;
    const saved = await remote(fetchImpl, `${origin}/holo/project/data/share/v2/${item.dataId}`, deadline, true);
    if (String(saved?.c) === '0') return initialCamera(saved.d?.camera);
  } catch {
    // 平台相机是可选信息。读取失败时仍可使用模型自带的整体视角。
    signal?.throwIfAborted();
  }
  return undefined;
}

export function createSampleImports(store, { fetchImpl = fetch } = {}) {
  const { db } = store, root = join(store.dir, 'imports'), active = new Set();
  mkdirSync(root, { recursive: true });
  function asset(id, format, userId) {
    if (!/^I[A-F0-9]{32}$/.test(id) || !['spz', 'ply'].includes(format)) return null;
    const row = db.prepare('SELECT format FROM sample_imports WHERE id=? AND user_id=?').get(id, userId);
    const name = `model.${format}`, path = join(root, id, name);
    const file = row?.format === format && existsSync(path) ? statSync(path) : null;
    return file?.isFile() && file.size > 0 ? { path, name } : null;
  }
  function entry(row) {
    const metadata = JSON.parse(row.metadata), available = Boolean(asset(row.id, row.format, row.user_id));
    return { ...metadata, id: row.id, isImported: true, available, assets: { spz:null, ply:null, [row.format]:available ? `/api/samples/${row.id}/model.${row.format}` : null } };
  }
  const list = userId => db.prepare('SELECT * FROM sample_imports WHERE user_id=? ORDER BY created DESC,id').all(userId).map(entry);
  function existing(userId, key) {
    const row = db.prepare('SELECT * FROM sample_imports WHERE user_id=? AND source_key=?').get(userId, key);
    if (!row) return null;
    if (!asset(row.id, row.format, userId)) fail(409, '这个案例的模型文件已丢失，请先恢复本机导入目录。');
    return { sample:entry(row), duplicate:true };
  }
  function checkCapacity(userId) {
    if (db.prepare('SELECT COUNT(*) AS n FROM sample_imports WHERE user_id=?').get(userId).n >= 30) fail(409, '本版最多保存 30 个导入案例。');
  }
  async function save(stream, { userId, format, title, note, upAxis, source, projectId, initialView, signal, authorize, sourceKey }) {
    const id = `I${randomUUID().replaceAll('-', '').toUpperCase()}`, dir = join(root, id);
    await mkdir(dir);
    let committed = false, file;
    try {
      const temporary = join(dir, 'upload.part'), hash = createHash('sha256'); let size = 0;
      file = await open(temporary, 'wx');
      for await (const chunk of stream) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > MAX_MODEL_BYTES) fail(413, '单个模型不能超过 150 MB。');
        hash.update(chunk); await file.writeFile(chunk);
      }
      await file.close(); file = null;
      if (!size) fail(400, '文件为空，请重新选择。');
      const count = await validateModel(temporary, format, signal);
      const digest = hash.digest('hex'), key = sourceKey || `file:${digest}:${upAxis}`;
      authorize(); signal.throwIfAborted();
      const duplicate = existing(userId, key); if (duplicate) return duplicate;
      checkCapacity(userId);
      const metadata = {
        title, name:title, note, upAxis, source:source || null, initialView, kind:source ? '链接导入' : '文件导入',
        description:initialView ? '已保留平台初始位置，可以移动查看空间细节。' : '从整体视角打开，可使用移动键查看；初始点可帮助你返回。',
        notice:'这是导入的已有模型，独立于现场采集；空间完整性与重建质量仍需人工验收。',
        facts:[['来源', source ? 'Aholo 已有项目' : '本地模型文件'], ...(projectId ? [['项目编号', projectId]] : []), ['模型格式', format.toUpperCase()], ['高斯点数', count.toLocaleString('zh-CN')], ['质量状态', '待人工验收']],
      };
      await rename(temporary, join(dir, `model.${format}`));
      authorize(); signal.throwIfAborted();
      db.prepare('INSERT INTO sample_imports(id,user_id,source_key,format,metadata,created) VALUES (?,?,?,?,?,?)').run(id, userId, key, format, JSON.stringify(metadata), Date.now());
      committed = true;
      return { sample:entry(db.prepare('SELECT * FROM sample_imports WHERE id=?').get(id)), duplicate:false };
    } finally {
      await file?.close();
      if (!committed) {
        // Only remove the two files this import can create, then its empty directory.
        for (const name of ['upload.part', `model.${format}`]) {
          try { await unlink(join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await rmdir(dir);
      }
    }
  }
  async function run(userId, work) {
    if (active.has(userId) || active.size >= 2) fail(409, '已有模型正在导入，请等待完成后再试。');
    active.add(userId);
    try { return await work(); }
    catch (error) { if (['AbortError','TimeoutError'].includes(error.name)) fail(408, '导入已中断或超时，未完成的文件不会加入案例。'); throw error; }
    finally { active.delete(userId); }
  }
  async function fromFile(userId, data, stream, context) {
    const options = modelOptions(data);
    if (!options.title || !['spz', 'ply'].includes(data.format)) fail(400, '请填写案例名称并选择 SPZ 或 PLY 模型。');
    return run(userId, () => save(stream, { ...options, ...context, userId, format:data.format }));
  }
  async function fromLink(userId, data, context) {
    const options = modelOptions(data), project = parseProjectLink(data.url), key = `aholo:${project.projectId}`;
    return run(userId, async () => {
      const duplicate = existing(userId, key); if (duplicate) return duplicate;
      checkCapacity(userId);
      const info = await remote(fetchImpl, `${project.origin}/aholo/api/project/info?projectId=${project.projectId}`, context.signal, true);
      const item = info?.d;
      if (String(info?.c) !== '0' || item?.id !== project.projectId || item.task?.status !== 3) fail(400, '项目未公开、尚未完成或没有可导入的模型。');
      const result = item.task.result, format = result?.spzPath ? 'spz' : 'ply';
      let url;
      try { url = new URL(result?.[`${format}Path`] || ''); } catch { fail(400, '项目没有可用的 SPZ 或 PLY 模型。'); }
      if (url.protocol !== 'https:' || url.hostname !== 'holo-cos.aholo3d.cn' || url.port || url.username || url.password || !url.pathname.endsWith(`.${format}`)) fail(400, '该项目资源地址暂不支持链接导入，请下载后使用文件导入。');
      const initialView = await readAholoInitialView(project, { signal: context.signal, fetchImpl, info });
      const response = await remote(fetchImpl, url.href, context.signal);
      if (Number(response.headers.get('content-length')) > MAX_MODEL_BYTES) { await response.body.cancel(); fail(413, '平台模型超过 150 MB，请导出较小的模型后导入。'); }
      return save(response.body, { ...context, userId, format, title:options.title || String(item.name || '导入案例').slice(0, 80), note:options.note, upAxis:'Z', source:project.source, projectId:project.projectId, initialView, sourceKey:key });
    });
  }
  return { list, asset, fromFile, fromLink };
}
