import { escapeHtml as h, viewingStatus, viewingTime } from './portal-format.js';

export function mountListings(root, { api, signal, initialRoom, verified, onError }) {
  root.innerHTML = `
    <div class="portal-management">
      <section class="panel">
        <h2>发布房源</h2>
        <p class="muted">选择已经可以查看的空间。发布后，租客可查看三维模型、试摆家具并预约。</p>
        ${!verified ? '<p class="notice warning">请先在用户中心完成本地模拟核验。</p>' : ''}
        <form class="portal-form" id="publish-form">
          <label>空间成果<select name="roomId" required></select></label>
          <label>房源名称<input name="title" maxlength="80" required></label>
          <label>片区<input name="district" maxlength="80" required placeholder="例如 杨浦 · 五角场"></label>
          <div class="portal-fields">
            <label>月租（元）<input name="rent" type="number" min="1" max="1000000" step="1" required></label>
            <label>面积（㎡）<input name="area" type="number" min="0.01" max="10000" step="0.01" required></label>
          </div>
          <label>房源介绍<textarea name="description" rows="3" maxlength="600"></textarea></label>
          <button type="submit" class="btn primary" disabled>发布到租客端</button>
        </form>
        <p id="publish-status" role="status">正在读取空间成果…</p>
      </section>
      <div>
        <section class="panel"><h2>我的房源</h2><div id="published-list"></div></section>
        <section class="panel"><h2>看房预约</h2><div id="viewing-list"></div></section>
      </div>
    </div>`;
  const form = root.querySelector('#publish-form');
  const status = root.querySelector('#publish-status');
  const submit = form.querySelector('button');
  const select = form.elements.roomId;
  let dashboard;
  let busy = false;

  function setRoom(id) {
    const room = dashboard.rooms.find(item => item.id === id);
    const listing = dashboard.listings.find(item => item.roomId === id);
    form.elements.title.value = listing?.title || room?.title || '';
    form.elements.district.value = listing?.district || '';
    form.elements.rent.value = listing?.rent ?? '';
    form.elements.area.value = listing?.area ?? '';
    form.elements.description.value = listing?.description ?? '';
    submit.textContent = listing?.active ? '更新已发布房源' : '发布到租客端';
  }

  async function refresh(roomId) {
    dashboard = await api('/api/landlord/portal', { signal });
    signal.throwIfAborted();
    select.innerHTML = '<option value="">选择空间成果</option>' +
      dashboard.rooms.map(room => `<option value="${h(room.id)}">${h(room.title)}${room.demoOnly ? '（样例）' : ''}</option>`).join('');
    if (dashboard.rooms.some(room => room.id === roomId)) select.value = roomId;
    setRoom(select.value);
    submit.disabled = !verified || !dashboard.rooms.length;
    root.querySelector('#published-list').innerHTML = dashboard.listings.map(item => `
      <article class="portal-row">
        <strong>${h(item.title)}</strong>
        <p>${item.active ? '已发布' : '已下架'} · ${h(item.district)} · ${item.rent} 元/月</p>
        <div class="portal-actions">
          <button class="btn secondary small-btn" data-portal-action="edit" data-id="${h(item.id)}">编辑</button>
          ${item.active ? `<a class="btn secondary small-btn" href="/tenant?id=${h(item.id)}">租客视角</a>
          <button class="btn secondary small-btn" data-portal-action="withdraw" data-id="${h(item.id)}">下架</button>` : ''}
        </div>
      </article>`).join('') || '<p class="muted">还没有发布记录。</p>';
    root.querySelector('#viewing-list').innerHTML = dashboard.requests.map(request => {
      const listing = dashboard.listings.find(item => item.id === request.listing_id);
      return `<article class="portal-row">
        <strong>${h(request.name)} · ${h(listing?.title)}</strong>
        <p>${h(viewingTime(request.requested))} · ${h(viewingStatus[request.status])}</p>
        <p>联系 ${h(request.contact)}</p>
        ${request.status === 'pending' ? `<div class="portal-actions">
          <button class="btn secondary small-btn" data-portal-action="confirmed" data-id="${h(request.id)}">确认看房</button>
          <button class="btn secondary small-btn" data-portal-action="declined" data-id="${h(request.id)}">婉拒</button>
        </div>` : ''}
      </article>`;
    }).join('') || '<p class="muted">还没有预约。</p>';
  }

  function report(error) {
    if (signal.aborted) return;
    status.textContent = error.message;
    if (error.status === 401 || error.code === 'VERIFICATION_REQUIRED') onError(error);
  }

  select.addEventListener('change', () => setRoom(select.value), { signal });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !dashboard || !verified) return;
    const room = dashboard.rooms.find(item => item.id === select.value);
    if (!room) return;
    const listing = dashboard.listings.find(item => item.roomId === room.id);
    const data = Object.fromEntries(new FormData(form));
    Object.assign(data, { rent: Number(data.rent), area: Number(data.area), revision: listing?.revision ?? 0, sceneVersion: room.sceneVersion });
    busy = true;
    submit.disabled = true;
    status.textContent = '正在保存房源和可公开的模型…';
    try {
      await api('/api/landlord/listings', { method: 'POST', data, signal });
      await refresh(room.id);
      status.textContent = '房源已发布，可以从租客端查看。';
    } catch (error) { report(error); }
    finally { busy = false; submit.disabled = false; }
  }, { signal });
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-portal-action]');
    if (!button || busy || !dashboard) return;
    const action = button.dataset.portalAction;
    const id = button.dataset.id;
    const listing = dashboard.listings.find(item => item.id === id);
    if (action === 'edit') {
      if (listing) { select.value = listing.roomId; setRoom(listing.roomId); form.elements.title.focus(); }
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      if (action === 'withdraw' && listing) {
        await api(`/api/landlord/listings/${id}/withdraw`, { method: 'POST', data: { revision: listing.revision }, signal });
        status.textContent = '房源已下架。';
      } else {
        await api(`/api/landlord/viewings/${id}`, { method: 'PATCH', data: { status: action }, signal });
        status.textContent = '预约状态已更新。';
      }
      await refresh(select.value);
    } catch (error) { report(error); }
    finally { busy = false; button.disabled = false; }
  }, { signal });
  refresh(initialRoom).then(() => {
    status.textContent = dashboard.rooms.length ? '' : '暂无可用空间。请先导入样例或完成重建。';
  }).catch(report);
}
