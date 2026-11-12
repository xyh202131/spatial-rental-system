// Importing an existing model is independent of the live-camera capture workflow.
export function openSampleImport({ csrf, maxBytes, onImported, onError, onClose, onCancel }) {
  const limit = maxBytes || 150 * 1024 * 1024;
  const dialog = document.createElement('dialog');
  dialog.id = 'dialog'; dialog.className = 'sample-import-dialog';
  dialog.setAttribute('aria-labelledby', 'import-title');
  dialog.setAttribute('aria-describedby', 'import-description');
  dialog.innerHTML = `
    <button type="button" class="btn dialog-close icon-button" data-import-close aria-label="关闭导入弹窗">×</button>
    <span class="eyebrow">重建案例 / 导入</span>
    <h2 id="import-title">把已有空间带进来</h2>
    <p id="import-description" class="muted small">选择模型，设置名称和备注，保存后即可预览。</p>
    <form id="sample-import-form">
      <div class="import-modes" role="group" aria-label="导入方式">
        <button type="button" data-import-mode="file" aria-pressed="true"><strong>PLY / SPZ 文件</strong><small>选择本地高斯模型</small></button>
        <button type="button" data-import-mode="link" aria-pressed="false"><strong>项目链接</strong><small>读取 Aholo 已完成的模型</small></button>
      </div>
      <fieldset class="import-fields" data-import-fields="link" hidden disabled>
        <legend class="sr-only">通过 Aholo 链接导入</legend>
        <label for="import-url">Aholo 项目链接</label>
        <input id="import-url" name="url" type="url" maxlength="2048" required placeholder="https://studio.aholo3d.com/viewer?projectId=…" aria-describedby="import-link-hint"/>
        <p id="import-link-hint" class="small muted form-hint">支持 .com / .cn 分享链接，项目需公开且已完成。</p>
        <label for="import-link-name">案例名称 <span class="muted">（选填）</span></label>
        <input id="import-link-name" maxlength="80" placeholder="留空使用平台项目名称"/>
      </fieldset>
      <fieldset class="import-fields" data-import-fields="file">
        <legend class="sr-only">通过模型文件导入</legend>
        <label for="import-file">模型文件</label>
        <div class="import-file-zone"><input id="import-file" type="file" accept=".spz,.ply" required autofocus aria-describedby="import-file-hint import-file-info"/>
        <p id="import-file-info" class="small muted" aria-live="polite">还没有选择文件</p></div>
        <p id="import-file-hint" class="small muted form-hint">单个文件不超过 ${Math.round(limit / 1024 / 1024)} MB。支持 SPZ v2/v3、标准二进制 Gaussian Splat PLY。</p>
        <label for="import-file-name">案例名称</label>
        <input id="import-file-name" maxlength="80" required placeholder="例如：湖畔公寓 · 客厅"/>
        <label for="import-up-axis">模型向上方向</label>
        <select id="import-up-axis"><option value="Z">Z 轴向上（Aholo 常用）</option><option value="Y">Y 轴向上</option></select>
      </fieldset>
      <label for="import-case-note">案例备注 <span class="muted">（选填）</span></label>
      <textarea id="import-case-note" rows="2" maxlength="500" placeholder="例如：客厅全景，窗边区域需要重点查看"></textarea>
      <p class="import-note small muted">这里只导入已有模型，不会发起新的重建任务。导入案例仍需人工验收。</p>
      <p class="error" id="import-error" role="alert" tabindex="-1" hidden></p>
      <div class="import-progress" role="status" hidden><progress aria-label="模型导入中"></progress><p class="small"></p></div>
      <div class="dialog-actions"><button type="button" class="btn secondary" data-import-close>取消</button><button type="submit" class="btn primary">导入并预览</button></div>
    </form>`;
  const find = selector => dialog.querySelector(selector);
  const form = find('form'), errorBox = find('#import-error'), progress = find('.import-progress');
  const fileInput = find('#import-file'), fileName = find('#import-file-name'), submit = find('[type=submit]');
  let mode = 'file', busy = false, request = null, suggestedName = '';
  function error(message) { errorBox.textContent = message; errorBox.hidden = false; errorBox.focus(); }
  function updateFields() {
    for (const fields of dialog.querySelectorAll('[data-import-fields]')) {
      fields.hidden = fields.dataset.importFields !== mode;
      fields.disabled = busy || fields.hidden;
    }
    for (const button of dialog.querySelectorAll('[data-import-mode]')) {
      button.disabled = busy; button.setAttribute('aria-pressed', String(button.dataset.importMode === mode));
    }
    submit.disabled = busy; submit.textContent = busy ? '正在导入…' : '导入并预览';
    find('#import-case-note').disabled = busy;
    form.setAttribute('aria-busy', String(busy)); progress.hidden = !busy;
    find('.dialog-actions [data-import-close]').textContent = busy ? '取消导入' : '取消';
  }
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-import-close]')) dialog.close();
    const button = event.target.closest('[data-import-mode]');
    if (button && !busy) { mode = button.dataset.importMode; errorBox.hidden = true; updateFields(); }
  });
  dialog.addEventListener('close', () => {
    if (busy) { request?.abort(); onCancel?.(); }
    dialog.remove(); onClose?.();
  }, { once:true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0]; errorBox.hidden = true;
    find('#import-file-info').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '还没有选择文件';
    if (!fileName.value || fileName.value === suggestedName) {
      suggestedName = file ? file.name.replace(/\.(spz|ply)$/i, '').slice(0, 80) : ''; fileName.value = suggestedName;
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    errorBox.hidden = true;
    const headers = { 'X-CSRF-Token':csrf }, note = find('#import-case-note').value.trim(); let body;
    if (mode === 'file') {
      const file = fileInput.files[0], format = /\.(spz|ply)$/i.exec(file?.name || '')?.[1].toLowerCase();
      if (!format || !file.size || file.size > limit) return error(`请选择非空的 SPZ / PLY 模型，单个不超过 ${Math.round(limit / 1024 / 1024)} MB。`);
      if (!fileName.value.trim()) return error('请填写案例名称。');
      headers['Content-Type'] = 'application/octet-stream';
      headers['X-Model-Meta'] = encodeURIComponent(JSON.stringify({ title:fileName.value.trim(), note, format, upAxis:find('#import-up-axis').value }));
      body = file;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ url:find('#import-url').value.trim(), title:find('#import-link-name').value.trim(), note });
    }
    busy = true; request = new AbortController(); updateFields();
    progress.querySelector('p').textContent = mode === 'link' ? '正在读取项目、下载并检查模型，请稍候…' : '正在上传并检查模型，请稍候…';
    let result;
    try {
      const response = await fetch(`/api/samples/import-${mode}`, { method:'POST', headers, body, credentials:'same-origin', signal:AbortSignal.any([request.signal, AbortSignal.timeout(120000)]) });
      try { result = await response.json(); } catch { throw new Error('服务响应中断，请重新打开案例列表确认保存情况后再试。'); }
      if (!response.ok) throw Object.assign(new Error(result.error || '导入未完成，请重试。'), { status:response.status });
      if (!result.sample?.id) throw new Error('导入结果不完整，请刷新案例列表。');
    } catch (cause) {
      if (!dialog.open) return;
      if (cause.status === 401) { busy = false; dialog.close(); await onError(cause); return; }
      error(cause.name === 'TimeoutError' ? '等待超时，请重新打开案例列表确认保存情况后再试。' : cause.name === 'TypeError' ? '连接中断，请重新打开案例列表确认保存情况后再试。' : cause.message);
      return;
    } finally { busy = false; request = null; if (dialog.isConnected) updateFields(); }
    if (!dialog.open) return;
    dialog.close();
    try { await onImported(result); } catch (cause) { await onError(cause); }
  });
  document.body.append(dialog); dialog.showModal();
  return { get busy() { return busy; }, close() { dialog.close(); } };
}
