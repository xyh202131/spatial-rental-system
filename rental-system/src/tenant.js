import './style.css';
import './portal.css';
import { escapeHtml as h, viewingStatus, viewingTime } from './portal-format.js';

const root = document.querySelector('#tenant-app');
const listingId = new URLSearchParams(location.search).get('id');
const receiptId = new URLSearchParams(location.search).get('receipt');
const idPattern = /^[a-f0-9-]{36}$/;
const number = new Intl.NumberFormat('zh-CN');

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET', signal: options.signal,
    headers, body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成。');
  return data;
}

function listingFacts(listing) {
  return [listing.district, listing.area === null ? '' : `${listing.area} ㎡`,
    listing.rent === null ? '' : `${number.format(listing.rent)} 元/月`].filter(Boolean).map(h).join(' · ');
}

async function showCatalog() {
  const { listings } = await request('/api/portal/listings');
  root.innerHTML = `
    <section class="tenant-hero">
      <div>
        <h1>先走进房间，再约看房。</h1>
        <p>查看三维空间，试摆家具，把现场看房留给真正想看的房源。</p>
        <a href="#listings" class="btn primary">浏览房源</a>
      </div>
      <img class="tenant-hero-art" src="/cover/assets/artwork.png" width="1672" height="941" alt="">
    </section>
    <section class="tenant-catalog" id="listings">
      <h2>当前房源</h2>
      <div class="tenant-grid">${listings.map(item => `
        <article class="panel tenant-card">
          <p class="tenant-kind">${item.listingMode === 'showcase' || item.demoOnly && !item.acceptsViewings ? '展示样例' : '联调房源'}</p>
          <h3><a href="/tenant?id=${h(item.id)}">${h(item.title)}</a></h3>
          <p>${listingFacts(item)}</p>
          <p class="muted">${h(item.description)}</p>
          <a href="/tenant?id=${h(item.id)}" class="btn secondary">打开三维房间</a>
        </article>`).join('') || '<p class="muted">当前没有可查看的房源。</p>'}</div>
    </section>`;
}

function layoutClient(spaces, furniture) {
  const rooms = spaces.map(space => ({ ...space, sourceType: space.demoOnly ? 'builtin_sample' : 'reconstruction' }));
  const key = room => `rental.tenant.layout.v1.${room.id}.${room.sceneVersion}`;
  const empty = () => ({ revision: 0, floorY: null, placements: [] });
  function saved(room) {
    let value;
    try { value = localStorage.getItem(key(room)); }
    catch { return empty(); }
    if (!value) return empty();
    const layout = JSON.parse(value);
    if (!Number.isSafeInteger(layout.revision) || !Array.isArray(layout.placements)) {
      throw new Error('此浏览器的已保存布局无法读取。');
    }
    return layout;
  }
  return async (path, { method = 'GET', data, signal } = {}) => {
    signal?.throwIfAborted();
    if (path === '/api/furnishing/rooms') return { rooms, furniture };
    const room = rooms.find(room => path === `/api/furnishing/rooms/${room.id}${method === 'PUT' ? '/layout' : ''}`);
    if (room && method === 'GET') return { room, layout: saved(room) };
    if (room && method === 'PUT') {
      if (data.sceneVersion !== room.sceneVersion || data.revision !== saved(room).revision) {
        throw new Error('布局已在其他页面修改，请重新载入。');
      }
      const layout = { floorY: data.floorY, placements: data.placements, revision: data.revision + 1, updated: Date.now() };
      localStorage.setItem(key(room), JSON.stringify(layout));
      return { layout };
    }
    throw new Error('无法读取当前试摆空间。');
  };
}

const coverageLabels = { complete: '已采集本房间', partial: '部分采集', unknown: '覆盖待确认' };

function timeField(scheduling, slots, label) {
  if (!scheduling) return `<label>${label}<input name="requested" type="datetime-local" required></label>`;
  if (!slots.length) return '<p class="muted">当前没有可预约时段。</p>';
  return `<label>${label}<select name="requested" required><option value="">选择时段</option>
    ${slots.map(time => `<option value="${h(time)}">${h(viewingTime(time))}</option>`).join('')}</select></label>`;
}

async function showListing(id) {
  const { listing, furniture, slots } = await request(`/api/portal/listings/${id}`);
  const spaces = listing.spaces ?? [listing];
  const photos = spaces.some(space => space.previewUrl);
  root.innerHTML = `
    <a class="tenant-back" href="/tenant">← 返回房源</a>
    <header class="tenant-detail">
      <p class="tenant-kind">${listing.acceptsViewings ? '联调房源' : '展示样例'}</p>
      <h1>${h(listing.title)}</h1>
      <p>${listingFacts(listing)}</p>
      <p class="muted">${h(listing.description)}</p>
      ${listing.coverageNote ? `<p class="notice">${h(listing.coverageNote)}</p>` : ''}
      ${listing.acceptsViewings ? '<a class="btn primary" href="#viewing">预约看房</a>' : ''}
    </header>
    <section class="panel"><h2>房间导览</h2><div class="tenant-room-grid">
      ${spaces.map(space => `<article class="tenant-room">
        <h3>${h(space.title)}</h3>
        <p class="muted">${h(coverageLabels[space.coverage] || coverageLabels.unknown)}${space.reviewedAt ? ' · 已人工验收' : ''}</p>
        ${space.previewUrl ? `<img src="${h(space.previewUrl)}" loading="lazy" alt="${h(space.title)}实拍图">` : ''}
        <button class="btn secondary" type="button" data-space="${h(space.id)}">查看三维 · ${h(space.title)}</button>
      </article>`).join('')}
    </div></section>
    <div id="tenant-furnishing"></div>
    ${furniture.some(item => item.arUrl) ? `<section class="panel tenant-assets">
      <h2>家具 AR 文件</h2>
      <div class="portal-actions">${furniture.filter(item => item.arUrl).map(item =>
        `<a class="btn secondary" href="${h(item.arUrl)}" download>下载 ${h(item.name)} USDZ</a>`).join('')}</div>
    </section>` : ''}
    ${listing.acceptsViewings ? `
    <section class="panel tenant-booking" id="viewing">
      <h2>预约看房</h2>
      <form class="portal-form" id="viewing-form">
        <div class="portal-fields">
          <label>称呼<input name="name" autocomplete="name" maxlength="40" required></label>
          <label>联系方式<input name="contact" maxlength="80" required></label>
        </div>
        ${timeField(listing.scheduling, slots, '希望看房时间（北京时间）')}
        <button class="btn primary" type="submit" ${listing.scheduling && !slots.length ? 'disabled' : ''}>提交预约</button>
      </form>
      <p id="viewing-status" role="status"></p>
      <div id="receipt-panel"></div>
    </section>` : ''}`;
  const controller = new AbortController();
  const host = root.querySelector('#tenant-furnishing');
  let workspace, starting = false;
  async function openRoom(roomId) {
    if (starting) return;
    if (workspace) { await workspace.openRoom(roomId); return; }
    starting = true;
    host.innerHTML = '<p role="status">正在准备三维房间…</p>';
    const fallback = photos ? '三维房间暂时无法加载。仍可查看上方实拍图和提交预约。' : '三维房间暂时无法加载。仍可查看房源信息。';
    try {
      const { mountFurnishing } = await import('./furnishing.js');
      controller.signal.throwIfAborted();
      workspace = mountFurnishing(host, {
        api: layoutClient(spaces, furniture), initialRoomId: roomId, signal: controller.signal, onRoomChange: () => {},
        onError: error => console.warn(error.message), unavailableMessage: fallback,
      });
    } catch {
      host.innerHTML = `<p role="status">${fallback}</p>`;
    } finally { starting = false; }
  }
  root.addEventListener('click', event => {
    const room = event.target.closest('[data-space]');
    if (!room) return;
    void openRoom(room.dataset.space);
    host.scrollIntoView({ block: 'start' });
  }, { signal: controller.signal });
  window.addEventListener('beforeunload', event => {
    if (workspace?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) controller.abort(); });
  if (listing.acceptsViewings) bindViewing(listing);
  if (!photos) void openRoom(spaces[0].id);
}

function bindViewing(listing) {
  const form = root.querySelector('#viewing-form');
  const status = root.querySelector('#viewing-status');
  const receipt = root.querySelector('#receipt-panel');
  function showReceipt(id, token = '') {
    receipt.innerHTML = `<a class="btn secondary" href="/tenant?receipt=${h(id)}${token ? '#manage=' + h(token) : ''}">查看预约回执</a>`;
  }
  const key = 'rental.tenant.receipt.' + listing.id;
  try {
    const previous = localStorage.getItem(key);
    if (previous && idPattern.test(previous)) showReceipt(previous);
  } catch { /* 当前浏览器仍可通过预约回执链接查看。 */ }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = '正在提交预约…';
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await request(`/api/portal/listings/${listing.id}/viewings`, { method: 'POST', data });
      status.textContent = '预约已提交，等待房东确认。';
      try {
        localStorage.setItem(key, result.id);
        if (result.manageToken) localStorage.setItem(`rental.tenant.manage.${result.id}`, result.manageToken);
        showReceipt(result.id);
      } catch { showReceipt(result.id, result.manageToken); }
      form.reset();
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

async function showReceipt(id) {
  const path = `/api/portal/viewings/${id}`;
  let token = new URLSearchParams(location.hash.slice(1)).get('manage') || '';
  try {
    if (token) localStorage.setItem(`rental.tenant.manage.${id}`, token);
    else token = localStorage.getItem(`rental.tenant.manage.${id}`) || '';
  } catch { /* 无法保存时，管理凭据仍可从原回执链接使用。 */ }
  const { requested, status, canManage, scheduling, slots } = await request(path, { headers: token ? { 'X-Viewing-Token': token } : {} });
  root.innerHTML = `
    <a class="tenant-back" href="/tenant">← 返回房源</a>
    <section class="panel tenant-booking">
      <h1>预约回执</h1>
      <p>${h(viewingTime(requested))}</p>
      <p id="receipt-status" role="status">${h(viewingStatus[status])}</p>
      <button type="button" class="btn secondary" id="refresh-receipt">刷新预约状态</button>
      ${canManage ? `<form class="portal-form" id="manage-viewing">
        ${timeField(scheduling, slots, '改约时间（北京时间）')}
        <div class="portal-actions">
          <button class="btn secondary" type="submit" value="reschedule" ${scheduling && !slots.length ? 'disabled' : ''}>提交改期</button>
          <button class="btn secondary" type="submit" value="cancel" formnovalidate>取消预约</button>
        </div>
        <p role="status" id="manage-status"></p>
      </form>` : ''}
    </section>`;
  const refresh = root.querySelector('#refresh-receipt');
  const form = root.querySelector('#manage-viewing');
  refresh.addEventListener('click', async () => {
    if (form?.dataset.busy) return;
    refresh.disabled = true;
    try { await showReceipt(id); }
    catch (error) { root.querySelector('#receipt-status').textContent = error.message; }
    finally { refresh.disabled = false; }
  });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    if (!button || refresh.disabled || form.dataset.busy) return;
    form.dataset.busy = '1';
    try {
      await request(path, { method: 'PATCH', data: { action: button.value, manageToken: token, requested: form.elements.requested?.value } });
      await showReceipt(id);
    } catch (error) { root.querySelector('#manage-status').textContent = error.message; }
    finally { delete form.dataset.busy; }
  });
}

let entry = showCatalog;
if (listingId && (listingId === 'demo' || idPattern.test(listingId))) entry = () => showListing(listingId);
else if (receiptId && idPattern.test(receiptId)) entry = () => showReceipt(receiptId);
entry().catch(error => {
  root.innerHTML = `<div class="panel"><p role="alert">${h(error.message)}</p><a href="/tenant">返回房源</a></div>`;
});
