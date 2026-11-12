import './style.css';
import './portal.css';
import { escapeHtml as h, viewingStatus, viewingTime } from './portal-format.js';

const root = document.querySelector('#tenant-app');
const listingId = new URLSearchParams(location.search).get('id');
const receiptId = new URLSearchParams(location.search).get('receipt');
const idPattern = /^[a-f0-9-]{36}$/;
const number = new Intl.NumberFormat('zh-CN');

async function request(path, options = {}) {
  const headers = options.data === undefined ? undefined : { 'Content-Type': 'application/json' };
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
          <p class="tenant-kind">${item.demoOnly ? '实验样例' : '三维房源'}</p>
          <h3><a href="/tenant?id=${h(item.id)}">${h(item.title)}</a></h3>
          <p>${listingFacts(item)}</p>
          <p class="muted">${h(item.description)}</p>
          <a href="/tenant?id=${h(item.id)}" class="btn secondary">打开三维房间</a>
        </article>`).join('') || '<p class="muted">当前没有可查看的房源。</p>'}</div>
    </section>`;
}

function layoutClient(listing, furniture) {
  const room = { ...listing, sourceType: listing.demoOnly ? 'builtin_sample' : 'reconstruction' };
  const key = `rental.tenant.layout.v1.${listing.id}.${listing.sceneVersion}`;
  const empty = () => ({ revision: 0, floorY: null, placements: [] });
  function saved() {
    const value = localStorage.getItem(key);
    if (!value) return empty();
    const layout = JSON.parse(value);
    if (!Number.isSafeInteger(layout.revision) || !Array.isArray(layout.placements)) {
      throw new Error('此浏览器的已保存布局无法读取。');
    }
    return layout;
  }
  return async (path, { method = 'GET', data, signal } = {}) => {
    signal?.throwIfAborted();
    if (path === '/api/furnishing/rooms') return { rooms: [room], furniture };
    if (method === 'GET' && path === `/api/furnishing/rooms/${room.id}`) return { room, layout: saved() };
    if (method === 'PUT' && path === `/api/furnishing/rooms/${room.id}/layout`) {
      if (data.sceneVersion !== room.sceneVersion || data.revision !== saved().revision) {
        throw new Error('布局已在其他页面修改，请重新载入。');
      }
      const layout = { floorY: data.floorY, placements: data.placements, revision: data.revision + 1, updated: Date.now() };
      localStorage.setItem(key, JSON.stringify(layout));
      return { layout };
    }
    throw new Error('无法读取当前试摆空间。');
  };
}

async function showListing(id) {
  const { listing, furniture } = await request(`/api/portal/listings/${id}`);
  root.innerHTML = `
    <a class="tenant-back" href="/tenant">← 返回房源</a>
    <header class="tenant-detail">
      <p class="tenant-kind">${listing.demoOnly ? '实验样例' : '三维房源'}</p>
      <h1>${h(listing.title)}</h1>
      <p>${listingFacts(listing)}</p>
      <p class="muted">${h(listing.description)}</p>
      ${listing.acceptsViewings ? '<a class="btn primary" href="#viewing">预约看房</a>' : ''}
    </header>
    <div id="tenant-furnishing"><p>正在准备三维房间…</p></div>
    <section class="panel tenant-assets">
      <h2>家具 AR 文件</h2>
      <div class="portal-actions">${furniture.filter(item => item.arUrl).map(item =>
        `<a class="btn secondary" href="${h(item.arUrl)}" download>下载 ${h(item.name)} USDZ</a>`).join('')}</div>
    </section>
    ${listing.acceptsViewings ? `
    <section class="panel tenant-booking" id="viewing">
      <h2>预约看房</h2>
      <form class="portal-form" id="viewing-form">
        <div class="portal-fields">
          <label>称呼<input name="name" autocomplete="name" maxlength="40" required></label>
          <label>联系方式<input name="contact" maxlength="80" required></label>
        </div>
        <label>希望看房时间（北京时间）<input name="requested" type="datetime-local" required></label>
        <button class="btn primary" type="submit">提交预约</button>
      </form>
      <p id="viewing-status" role="status"></p>
      <div id="receipt-panel"></div>
    </section>` : ''}`;
  const { mountFurnishing } = await import('./furnishing.js');
  const controller = new AbortController();
  const workspace = mountFurnishing(root.querySelector('#tenant-furnishing'), {
    api: layoutClient(listing, furniture), initialRoomId: listing.id, signal: controller.signal, onRoomChange: () => {},
    onError: error => console.warn(error.message),
  });
  window.addEventListener('beforeunload', event => {
    if (workspace.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) controller.abort(); });
  if (listing.acceptsViewings) bindViewing(listing);
}

function bindViewing(listing) {
  const form = root.querySelector('#viewing-form');
  const status = root.querySelector('#viewing-status');
  const receipt = root.querySelector('#receipt-panel');
  function showReceipt(id) {
    receipt.innerHTML = `<a class="btn secondary" href="/tenant?receipt=${h(id)}">查看预约回执</a>`;
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
      showReceipt(result.id);
      status.textContent = '预约已提交，等待房东确认。';
      try { localStorage.setItem(key, result.id); } catch { /* 回执已经显示。 */ }
      form.reset();
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

async function showReceipt(id) {
  const { requested, status } = await request(`/api/portal/viewings/${id}`);
  root.innerHTML = `
    <a class="tenant-back" href="/tenant">← 返回房源</a>
    <section class="panel tenant-booking">
      <h1>预约回执</h1>
      <p>${h(viewingTime(requested))}</p>
      <p role="status">${h(viewingStatus[status])}</p>
      <a href="/tenant?receipt=${h(id)}" class="btn secondary">刷新预约状态</a>
    </section>`;
}

let entry = showCatalog;
if (listingId && (listingId === 'demo' || idPattern.test(listingId))) entry = () => showListing(listingId);
else if (receiptId && idPattern.test(receiptId)) entry = () => showReceipt(receiptId);
entry().catch(error => {
  root.innerHTML = `<div class="panel"><p role="alert">${h(error.message)}</p><a href="/tenant">返回房源</a></div>`;
});
