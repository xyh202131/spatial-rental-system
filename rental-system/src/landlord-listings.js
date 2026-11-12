import { escapeHtml as h, viewingStatus, viewingTime } from './portal-format.js';

async function encodePreview(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('原始实拍图请控制在 25 MiB 内。');
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.82, .68, .52, .36, .22]) {
      const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      if (data?.length <= 262144) return data;
    }
    throw new Error('实拍图压缩后仍过大，请选择另一张图。');
  } finally {
    image.close();
  }
}

export function mountListings(root, { api, signal, initialRoom, verified, onError }) {
  root.innerHTML = `
    <div class="portal-management">
      <section class="panel">
        <h2>发布房源</h2>
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
          <label>用途<select name="listingMode"><option value="trial">联调房源 · 接受演示预约</option><option value="showcase">展示样例 · 只供查看</option></select></label>
          <p class="small muted">当前账号核验为模拟，已发布内容均用于联调或展示。</p>
          <label>预约方式<select name="scheduling"><option value="slots">从房东开放的时段选择</option><option value="legacy">自由填写意向时间</option></select></label>
          <label>未采集区域说明<textarea name="coverageNote" rows="2" maxlength="500" placeholder="例如 卧室已采集，厨房和阳台尚未采集"></textarea></label>
          <div id="published-rooms"></div>
          <div class="portal-actions"><select id="extra-space" aria-label="其他空间成果"></select><button type="button" class="btn secondary" data-room-action="add">加入房间</button></div>
          <button type="submit" class="btn primary" disabled>发布到租客端</button>
        </form>
        <p id="publish-status" role="status">正在读取空间成果…</p>
      </section>
      <div>
        <section class="panel"><h2>我的房源</h2><div id="published-list"></div></section>
        <section class="panel"><h2>开放预约时段</h2>
          <form class="portal-form" id="slot-form">
            <label>安排房源<select name="listingId" required></select></label>
            <label>新看房时段（北京时间）<input name="requested" type="datetime-local" required></label>
            <button type="submit" class="btn secondary">开放 30 分钟时段</button>
          </form>
          <div id="slot-list"></div>
        </section>
        <section class="panel"><h2>看房预约</h2><div id="viewing-list"></div></section>
      </div>
    </div>`;
  const form = root.querySelector('#publish-form');
  const status = root.querySelector('#publish-status');
  const submit = form.querySelector('button[type=submit]');
  const select = form.elements.roomId;
  const roomEditors = root.querySelector('#published-rooms');
  const extraSpace = root.querySelector('#extra-space');
  const slotForm = root.querySelector('#slot-form');
  const slotSelect = slotForm.elements.listingId;
  let dashboard;
  let roomEntries = [];
  let busy = false;

  function catalogRoom(id) {
    return dashboard.rooms.find(item => item.id === id);
  }

  function readRoomEditors() {
    for (const [index, editor] of Array.from(roomEditors.children).entries()) {
      const entry = roomEntries[index];
      entry.label = editor.querySelector('[data-room-field=label]').value;
      entry.coverage = editor.querySelector('[data-room-field=coverage]').value;
      entry.reviewed = editor.querySelector('[data-room-field=reviewed]').checked;
      entry.metersPerUnit = editor.querySelector('[data-room-field=scale]').value;
      entry.previewConsent = editor.querySelector('[data-room-field=consent]').checked;
      entry.removePreview = editor.querySelector('[data-room-field=remove]')?.checked ?? false;
      entry.file = editor.querySelector('[data-room-field=photo]').files[0] ?? entry.file;
    }
  }

  function renderRoomEditors() {
    roomEditors.innerHTML = roomEntries.map((entry, index) => `
      <fieldset class="listing-room">
        <legend>${index === 0 ? '主空间' : '附加空间'} · ${h(catalogRoom(entry.roomId)?.title ?? entry.label)}</legend>
        <label>房间名称<input data-room-field="label" value="${h(entry.label)}" maxlength="160" required></label>
        <label>采集覆盖<select data-room-field="coverage">
          <option value="unknown" ${entry.coverage === 'unknown' ? 'selected' : ''}>未确认覆盖</option>
          <option value="partial" ${entry.coverage === 'partial' ? 'selected' : ''}>部分采集</option>
          <option value="complete" ${entry.coverage === 'complete' ? 'selected' : ''}>已采集本房间</option>
        </select></label>
        <label>标定比例（每模型单位米数，可选）<input data-room-field="scale" type="number" min="0.000001" max="1000" step="any" value="${h(entry.metersPerUnit)}"></label>
        <label>公开实拍图（可选）<input data-room-field="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
        ${entry.file ? `<p class="small muted">已选 ${h(entry.file.name)}</p>` : ''}
        ${entry.hasPreview ? `<label class="listing-checkbox"><input data-room-field="remove" type="checkbox" ${entry.removePreview ? 'checked' : ''}>移除已公开实拍图</label>` : ''}
        <label class="listing-checkbox"><input data-room-field="consent" type="checkbox" ${entry.previewConsent ? 'checked' : ''}>确认所选实拍图可公开</label>
        <label class="listing-checkbox"><input data-room-field="reviewed" type="checkbox" ${entry.reviewed ? 'checked' : ''}>已验收入口视角、画面和公开内容</label>
        ${index > 0 ? `<button type="button" class="btn secondary small-btn" data-room-action="remove" data-index="${index}">移除此房间</button>` : ''}
      </fieldset>`).join('');
    const options = dashboard.rooms.filter(room => !roomEntries.some(entry => entry.roomId === room.id));
    extraSpace.innerHTML = '<option value="">选择附加空间</option>' + options.map(room => `<option value="${h(room.id)}">${h(room.title)}</option>`).join('');
    extraSpace.disabled = !roomEntries.length || roomEntries.length >= 8 || !options.length;
    root.querySelector('[data-room-action=add]').disabled = extraSpace.disabled;
  }

  function newRoom(room) {
    return { roomId: room.id, label: room.title, sceneVersion: room.sceneVersion, coverage: 'unknown' };
  }

  function setRoom(id) {
    const room = catalogRoom(id);
    const listing = dashboard.listings.find(item => item.roomId === id);
    form.elements.title.value = listing?.title || room?.title || '';
    form.elements.district.value = listing?.district || '';
    form.elements.rent.value = listing?.rent ?? '';
    form.elements.area.value = listing?.area ?? '';
    form.elements.description.value = listing?.description ?? '';
    form.elements.coverageNote.value = listing?.coverageNote ?? '';
    form.elements.listingMode.value = listing?.listingMode ?? 'trial';
    form.elements.scheduling.value = listing && !listing.scheduling ? 'legacy' : 'slots';
    submit.textContent = listing?.active ? '更新已发布房源' : '发布到租客端';
    roomEntries = listing?.roomSelections?.map(entry => ({
      ...entry, label: entry.label || catalogRoom(entry.roomId)?.title || '房间',
      coverage: entry.coverage || 'unknown',
      reviewed: Boolean(entry.reviewedAt && catalogRoom(entry.roomId)?.sceneVersion === entry.sceneVersion),
    })) ?? (room ? [newRoom(room)] : []);
    submit.disabled = !verified || !room;
    renderRoomEditors();
  }

  function renderSlots(listingId) {
    const listing = dashboard.listings.find(item => item.id === listingId);
    root.querySelector('#slot-list').innerHTML = listing?.slots.map(time => `
      <p class="portal-row">${h(viewingTime(time))}
      <button type="button" class="btn secondary small-btn" data-slot-time="${h(time)}">关闭时段</button></p>`).join('') || '<p class="muted">暂无已开放的未来时段。</p>';
  }

  async function refresh(roomId, slotListingId) {
    dashboard = await api('/api/landlord/portal', { signal });
    signal.throwIfAborted();
    select.innerHTML = '<option value="">选择空间成果</option>' +
      dashboard.rooms.map(room => `<option value="${h(room.id)}">${h(room.title)}${room.demoOnly ? '（样例）' : ''}</option>`).join('');
    if (catalogRoom(roomId)) select.value = roomId;
    setRoom(select.value);
    const scheduled = dashboard.listings.filter(item => item.active && item.scheduling && item.acceptsViewings);
    slotSelect.innerHTML = scheduled.map(item => `<option value="${h(item.id)}">${h(item.title)}</option>`).join('');
    if (scheduled.some(item => item.id === slotListingId)) slotSelect.value = slotListingId;
    slotForm.querySelector('button').disabled = !scheduled.length;
    renderSlots(slotSelect.value);
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
      const button = (action, text) => `<button class="btn secondary small-btn" data-portal-action="${action}" data-id="${h(request.id)}">${text}</button>`;
      return `<article class="portal-row">
        <strong>${h(request.name)} · ${h(listing?.title)}</strong>
        <p>${h(viewingTime(request.requested))} · ${h(viewingStatus[request.status])}</p>
        <p>联系 ${h(request.contact)}</p>
        ${request.status === 'pending' ? button('confirmed', '确认看房') + button('declined', '婉拒') : ''}
        ${request.status === 'confirmed' ? button('cancelled', '取消预约') : ''}
      </article>`;
    }).join('') || '<p class="muted">还没有预约。</p>';
  }

  function report(error) {
    if (signal.aborted) return;
    status.textContent = error.message;
    if (error.status === 401 || error.code === 'VERIFICATION_REQUIRED') onError(error);
  }

  async function setSlot(requested, open) {
    if (busy || !slotSelect.value) return;
    const listingId = slotSelect.value;
    busy = true;
    try {
      await api(`/api/landlord/listings/${listingId}/slots`, { method: 'PUT', data: { requested, open }, signal });
      await refresh(select.value, listingId);
      status.textContent = open ? '已开放看房时段。' : '已关闭看房时段。';
    } catch (error) { report(error); }
    finally { busy = false; }
  }

  select.addEventListener('change', () => { if (!busy) setRoom(select.value); }, { signal });
  slotSelect.addEventListener('change', () => renderSlots(slotSelect.value), { signal });
  slotForm.addEventListener('submit', event => {
    event.preventDefault();
    setSlot(slotForm.elements.requested.value, true);
  }, { signal });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !dashboard || !verified || !catalogRoom(select.value)) return;
    const listing = dashboard.listings.find(item => item.roomId === select.value);
    const data = Object.fromEntries(new FormData(form));
    readRoomEditors();
    const primary = catalogRoom(data.roomId);
    Object.assign(data, {
      rent: Number(data.rent), area: Number(data.area), revision: listing?.revision ?? 0, sceneVersion: primary.sceneVersion,
      scheduling: data.scheduling === 'slots' && data.listingMode === 'trial',
    });
    busy = true;
    submit.disabled = true;
    status.textContent = '正在保存房源和可公开的模型…';
    try {
      data.rooms = await Promise.all(roomEntries.map(async entry => {
        const current = catalogRoom(entry.roomId);
        if (!current) throw new Error('请移除无法访问的空间后再发布。');
        if (!entry.reviewed) throw new Error('请先验收每个空间的入口视角、画面和公开内容。');
        if (entry.file && !entry.previewConsent) throw new Error('请确认实拍图允许随房源公开。');
        return {
          roomId: current.id, sceneVersion: current.sceneVersion, label: entry.label, coverage: entry.coverage,
          reviewed: true, metersPerUnit: entry.metersPerUnit ? Number(entry.metersPerUnit) : null,
          previewConsent: entry.previewConsent, preview: entry.file ? await encodePreview(entry.file) : entry.removePreview ? null : undefined,
        };
      }));
      const result = await api('/api/landlord/listings', { method: 'POST', data, signal });
      await refresh(primary.id, result.listing.id);
      status.textContent = '房源已发布，可以从租客端查看。';
    } catch (error) { report(error); }
    finally { busy = false; submit.disabled = !verified || !catalogRoom(select.value); }
  }, { signal });

  root.addEventListener('click', async event => {
    if (busy || !dashboard) return;
    const roomAction = event.target.closest('[data-room-action]');
    if (roomAction) {
      readRoomEditors();
      if (roomAction.dataset.roomAction === 'add' && catalogRoom(extraSpace.value) && roomEntries.length < 8) {
        roomEntries.push(newRoom(catalogRoom(extraSpace.value)));
      } else if (roomAction.dataset.roomAction === 'remove') {
        roomEntries.splice(Number(roomAction.dataset.index), 1);
      }
      renderRoomEditors();
      return;
    }
    const slotButton = event.target.closest('[data-slot-time]');
    if (slotButton) return setSlot(slotButton.dataset.slotTime, false);
    const button = event.target.closest('[data-portal-action]');
    if (!button) return;
    const { portalAction: action, id } = button.dataset;
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
        status.textContent = '房源已下架，未来预约已取消。';
      } else {
        await api(`/api/landlord/viewings/${id}`, { method: 'PATCH', data: { status: action }, signal });
        status.textContent = '预约状态已更新。';
      }
      await refresh(select.value, slotSelect.value);
    } catch (error) { report(error); }
    finally { busy = false; button.disabled = false; }
  }, { signal });
  refresh(initialRoom).then(() => {
    status.textContent = dashboard.rooms.length ? '' : '暂无可用空间。请先导入样例或完成重建。';
  }).catch(report);
}
