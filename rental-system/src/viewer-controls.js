import { MOUSE, TOUCH } from 'three';

const icons = {
  orbit: '<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-35 12 12)"/>',
  pan: '<path d="M12 2v20M2 12h20m-13-7 3-3 3 3m-6 14 3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>',
  walk: '<circle cx="14" cy="4" r="2"/><path d="m7 12 3-4 4 1 2 5 4 1M12 10l-2 7-4 5m5-7 5 3v4"/>',
  full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  reset: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  point: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 2v1"/>',
  left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const command = (name, label, glyph) => `<button type="button" class="viewer-icon-button" data-viewer-command="${name}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;
const move = (name, key, label) => `<button type="button" class="viewer-move-key ${name}" data-viewer-motion="${name}" aria-label="${label} (${key})" title="${label} (${key})"><kbd>${key}</kbd><span>${label}</span></button>`;
const motion = (name, label, glyph) => `<button type="button" class="viewer-icon-button" data-viewer-motion="${name}" aria-label="${label}" title="${label}">${icon(glyph)}</button>`;

export function viewerMarkup({ hasInitialView = false } = {}) {
  return `<div class="viewer-toolbar"><fieldset disabled aria-label="三维查看工具">
    <div class="viewer-mode-switch" role="group" aria-label="操作模式">
      <button type="button" data-viewer-mode="orbit" aria-pressed="true">${icon('orbit')}环绕</button>
      <button type="button" data-viewer-mode="pan" aria-pressed="false">${icon('pan')}平移</button>
      <button type="button" data-viewer-mode="walk" aria-pressed="false">${icon('walk')}漫游</button>
    </div>
    <div class="viewer-options"><label><span class="viewer-label">预设视角</span><select data-viewer-preset aria-label="预设视角"><option value="overall">${hasInitialView ? '初始视角' : '整体视角'}</option><option value="front">正面视角</option><option value="side">侧面视角</option><option value="top">俯视视角</option></select></label>
    <label><span class="viewer-label">移动速度</span><select data-viewer-speed aria-label="移动速度"><option value=".35">慢速</option><option value="1" selected>标准速度</option><option value="2">快速</option></select></label>
    ${command('reset', '重置视角 (R)', 'reset')}${command('help', '操作说明', 'help')}${command('fullscreen', '进入全屏 (F)', 'full')}</div>
  </fieldset></div>
  <div class="viewer-viewport"><div class="viewer-loading" role="status">正在读取三维模型…</div>
    <div class="viewer-stage-label"><span class="viewer-ready-dot"></span><span data-viewer-mode-label>环绕查看</span><span class="viewer-model-tag">3D 实景</span></div>
    <fieldset class="viewer-waypoints" disabled aria-label="预览点位"><button type="button" class="viewer-home-point" data-viewer-command="home" aria-label="回到初始点" title="回到初始位置和朝向 (R)">${icon('point')}<span>初始点</span><kbd>R</kbd></button></fieldset>
    <section class="viewer-help" aria-label="三维操作说明" hidden><strong>把视角移到你想看的位置</strong><dl>
      <div><dt><kbd>W A S D</kbd></dt><dd>前后左右移动</dd></div><div><dt><kbd>Q / E</kbd></dt><dd>下降 / 升高</dd></div>
      <div><dt><kbd>↑ ↓ ← →</kbd></dt><dd>调整观察方向</dd></div><div><dt><kbd>+ / −</kbd></dt><dd>拉近 / 拉远</dd></div>
      <div><dt><kbd>R</kbd> / <kbd>F</kbd></dt><dd>复位 / 全屏</dd></div></dl>
      <p>点击画面后可用键盘；也可长按画面下方按钮。环绕时拖动旋转，右键或双指平移、双指缩放；漫游时拖动转头。</p><p>自由漫游不含碰撞限制。点击右上角“初始点”或按 R，可回到最初的位置和朝向。</p><button type="button" data-viewer-command="help" class="viewer-help-close">收起说明</button></section>
    <fieldset class="viewer-navigation" disabled aria-label="空间移动控制"><div class="viewer-move-cluster"><div class="viewer-pad-caption">移动 <span>长按连续移动</span></div><div class="viewer-move-row"><div class="viewer-direction-pad">${move('forward','W','前进')}${move('left','A','向左')}${move('backward','S','后退')}${move('right','D','向右')}</div><div class="viewer-height-pad">${move('up','E','升高')}${move('down','Q','下降')}</div></div></div>
    <div class="viewer-look-cluster"><div class="viewer-pad-caption">转向 / 缩放</div><div class="viewer-look-pad">${motion('turn-left','向左旋转','left')}${motion('turn-right','向右旋转','right')}${motion('zoom-in','拉近','plus')}${motion('zoom-out','拉远','minus')}</div></div></fieldset>
  </div><div class="viewer-caption"><span data-viewer-hint>拖动旋转 · 右键平移 · 滚轮缩放</span><span class="viewer-keyboard-hint">点击画面，启用键盘</span></div>`;
}

export function bindViewerControls(element, canvas, navigation, controls, { onStatus = () => {} } = {}) {
  const events = new AbortController();
  const listen = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: events.signal });
  const keys = new Set(), pointers = new Map(), touches = new Map();
  let mode = 'orbit', speed = 1, expanded = false, disposed = false, gesture = null;
  const query = selector => element.querySelector(selector);
  const keyActions = { KeyW:'forward', KeyS:'backward', KeyA:'left', KeyD:'right', KeyQ:'down', KeyE:'up', ArrowLeft:'turn-left', ArrowRight:'turn-right', ArrowUp:'look-up', ArrowDown:'look-down', Equal:'zoom-in', NumpadAdd:'zoom-in', Minus:'zoom-out', NumpadSubtract:'zoom-out' };
  const preset = query('[data-viewer-preset]');
  function stop() {
    keys.clear(); pointers.clear(); touches.clear(); gesture = null;
    element.querySelectorAll('.is-pressed').forEach(button => button.classList.remove('is-pressed'));
  }
  function setMode(value) {
    stop(); mode = value; navigation.setMode(mode === 'walk' ? 'walk' : 'orbit');
    controls.mouseButtons.LEFT = mode === 'pan' ? MOUSE.PAN : MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = mode === 'pan' ? MOUSE.ROTATE : MOUSE.PAN;
    controls.touches.ONE = mode === 'pan' ? TOUCH.PAN : TOUCH.ROTATE;
    element.dataset.viewerMode = value;
    for (const button of element.querySelectorAll('[data-viewer-mode]')) button.setAttribute('aria-pressed', String(button.dataset.viewerMode === value));
    query('[data-viewer-mode-label]').textContent = { orbit:'环绕查看', pan:'平移画面', walk:'自由漫游' }[value];
    query('[data-viewer-hint]').textContent = { orbit:'拖动旋转 · 右键 / 双指平移 · 滚轮缩放', pan:'拖动画面平移 · 右键旋转 · 滚轮缩放', walk:'拖动转头 · WASD 移动 · QE 升降' }[value];
    canvas.setAttribute('aria-label', `三维空间预览，${query('[data-viewer-hint]').textContent}，R 复位`);
  }
  function reset() {
    setMode('orbit'); navigation.reset(); preset.value = 'overall';
    onStatus('已回到初始点 · 可继续移动或转向');
  }
  function updateFullscreen() {
    const active = document.fullscreenElement === element || expanded;
    const button = query('[data-viewer-command="fullscreen"]');
    button.setAttribute('aria-label', active ? '退出全屏 (F)' : '进入全屏 (F)');
    button.setAttribute('title', active ? '退出全屏 (F)' : '进入全屏 (F)');
    button.setAttribute('aria-pressed', String(active));
  }
  function closeExpanded() {
    expanded = false; element.classList.remove('viewer-expanded'); document.body.classList.remove('viewer-modal-open');
    updateFullscreen();
  }
  async function fullscreen() {
    stop();
    if (expanded) return closeExpanded();
    if (document.fullscreenElement === element) return document.exitFullscreen();
    try {
      if (!element.requestFullscreen) throw new Error('Fullscreen unavailable');
      await element.requestFullscreen();
    } catch {
      if (disposed) return;
      expanded = true; element.classList.add('viewer-expanded'); document.body.classList.add('viewer-modal-open'); updateFullscreen();
      onStatus('浏览器全屏不可用，已展开大画面。按 Esc 或全屏按钮收起。');
    }
  }
  function help() {
    const panel = query('.viewer-help'); panel.hidden = !panel.hidden;
    query('[data-viewer-command="help"]').setAttribute('aria-expanded', String(!panel.hidden));
  }
  function execute(command) {
    if (command === 'reset' || command === 'home') reset();
    if (command === 'help') help();
    if (command === 'fullscreen') fullscreen().catch(() => onStatus('全屏切换未完成，请重试。'));
  }
  query('[data-viewer-command="reset"]').dataset.action = 'reset-view';
  query('[data-viewer-command="help"]').setAttribute('aria-expanded', 'false');
  listen(element, 'click', event => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    event.stopPropagation();
    if (button.dataset.viewerMode) setMode(button.dataset.viewerMode);
    if (button.dataset.viewerCommand) execute(button.dataset.viewerCommand);
    // Keyboard/assistive clicks have no pointerdown; pointer presses are already handled below.
    if (button.dataset.viewerMotion && event.detail === 0) navigation.update(.08, new Set([button.dataset.viewerMotion]), speed);
  });
  listen(preset, 'change', () => { stop(); setMode('orbit'); navigation.preset(preset.value); });
  listen(query('[data-viewer-speed]'), 'change', event => { stop(); speed = Number(event.target.value); });
  for (const button of element.querySelectorAll('[data-viewer-motion]')) {
    listen(button, 'pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); button.focus({ preventScroll: true }); button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, button.dataset.viewerMotion); button.classList.add('is-pressed');
      navigation.update(.045, new Set([button.dataset.viewerMotion]), speed);
    });
    const release = event => { pointers.delete(event.pointerId); button.classList.remove('is-pressed'); };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(button, name, release);
  }
  listen(element, 'keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    const action = keyActions[event.code];
    const shortcut = { KeyR:'reset', KeyF:'fullscreen', KeyH:'help' }[event.code];
    if (action || shortcut) event.preventDefault();
    if (action) keys.add(action);
    if (shortcut && !event.repeat) execute(shortcut);
  });
  listen(window, 'keyup', event => { keys.delete(keyActions[event.code]); });
  listen(window, 'blur', stop);
  listen(document, 'visibilitychange', stop);
  listen(element, 'focusout', event => { if (!element.contains(event.relatedTarget)) stop(); });
  listen(document, 'keydown', event => { if (event.key === 'Escape') { stop(); if (expanded) closeExpanded(); query('.viewer-help').hidden = true; query('[data-viewer-command="help"]').setAttribute('aria-expanded', 'false'); } });
  listen(document, 'fullscreenchange', () => { stop(); updateFullscreen(); });

  const sampleGesture = () => {
    const values = [...touches.values()];
    return values.length === 1 ? { x:values[0].x, y:values[0].y, distance:0 } : {
      x:(values[0].x + values[1].x)/2, y:(values[0].y + values[1].y)/2,
      distance:Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y),
    };
  };
  listen(canvas, 'pointerdown', event => {
    canvas.focus({ preventScroll: true });
    if (mode !== 'walk' || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId); touches.set(event.pointerId, { x:event.clientX, y:event.clientY }); gesture = sampleGesture();
  });
  listen(canvas, 'pointermove', event => {
    if (mode !== 'walk' || !touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x:event.clientX, y:event.clientY }); const current = sampleGesture();
    if (gesture) {
      if (touches.size === 1) navigation.rotate(-(current.x - gesture.x) * .002, -(current.y - gesture.y) * .002);
      else {
        navigation.pan(current.x - gesture.x, current.y - gesture.y, canvas.clientHeight);
        if (gesture.distance > 0 && current.distance > 0) navigation.zoom(gesture.distance / current.distance);
      }
    }
    gesture = current;
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, name, event => {
    touches.delete(event.pointerId); gesture = touches.size ? sampleGesture() : null;
  });
  listen(canvas, 'wheel', event => {
    if (mode !== 'walk') return;
    event.preventDefault(); navigation.zoom(Math.exp(Math.max(-.3, Math.min(.3, event.deltaY * .001))));
  }, { passive:false });
  canvas.tabIndex = 0;
  element.querySelectorAll('fieldset').forEach(fieldset => { fieldset.disabled = false; });
  setMode('orbit'); updateFullscreen();
  return {
    reset,
    tick: seconds => navigation.update(seconds, new Set([...keys, ...pointers.values()]), speed),
    dispose() {
      disposed = true; stop(); events.abort();
      if (document.fullscreenElement === element) document.exitFullscreen().catch(() => {});
      if (expanded) closeExpanded();
    },
  };
}
