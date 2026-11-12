const cover = document.querySelector('#cover');
const canvas = document.querySelector('#effects');
const context = canvas.getContext('2d');
const pauseButton = document.querySelector('#pause');
const phaseButtons = [...document.querySelectorAll('[data-phase-button]')];
const dialog = document.querySelector('#scene');
const openScene = document.querySelector('#open-scene');
const sceneView = document.querySelector('#scene-view');
const sceneStatus = document.querySelector('#scene-status');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phaseLength = 4600;
const cycleLength = phaseLength * phaseButtons.length;
const points = Array.from({ length: 76 }, (_, index) => ({
  x: .08 + (Math.sin(index * 121.8) + 1) * .20,
  y: .28 + (Math.sin(index * 87.7) + 1) * .22,
  offset: index * 1.76,
}));

let playing = !reduceMotion.matches;
let phase = 0;
let elapsed = 0;
let previousFrame = 0;
let frame = 0;
let viewerAssets;
let closeViewer;
let sceneRequest = 0;

function showPhase(nextPhase, progress) {
  if (nextPhase !== phase) {
    phase = nextPhase;
    cover.dataset.phase = phase;
    phaseButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === phase)));
  }
  phaseButtons[phase].style.setProperty('--progress', String(Math.max(.08, progress)));
}

function drawEffects(time, progress) {
  if (!context) return;
  const { clientWidth: width, clientHeight: height } = canvas;
  const density = Math.min(devicePixelRatio, 1.5);
  if (canvas.width !== Math.round(width * density) || canvas.height !== Math.round(height * density)) {
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
  }
  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  if (reduceMotion.matches) return;

  if (phase < 2) {
    for (const point of points) {
      const flicker = (Math.sin(time * .002 + point.offset) + 1) / 2;
      context.fillStyle = `rgba(154, 196, 255, ${flicker * (phase === 0 ? .76 : .50)})`;
      context.beginPath();
      context.arc(point.x * width + Math.sin(time * .001 + point.offset) * 12, point.y * height, 1 + flicker, 0, Math.PI * 2);
      context.fill();
    }
    if (phase === 0) {
      const beamX = (.12 + progress * .54) * width;
      const beam = context.createLinearGradient(0, height * .20, 0, height * .82);
      beam.addColorStop(0, 'transparent');
      beam.addColorStop(.45, '#a3ccffc9');
      beam.addColorStop(1, 'transparent');
      context.fillStyle = beam;
      context.fillRect(beamX, height * .20, 1.5, height * .62);
      return;
    }

    // 重建阶段沿剖视图的墙面和地板边缘描线。
    context.strokeStyle = `rgba(166, 203, 255, ${.16 + Math.sin(progress * Math.PI) * .54})`;
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(width * .10, height * .66);
    context.lineTo(width * .20, height * .58);
    context.lineTo(width * .20, height * .29);
    context.lineTo(width * .52, height * .15);
    context.moveTo(width * .10, height * .66);
    context.lineTo(width * .51, height * .88);
    context.lineTo(width * .83, height * .75);
    context.setLineDash([16, 9]);
    context.lineDashOffset = -progress * 90;
    context.stroke();
    context.setLineDash([]);
    return;
  }

  const ringScale = Math.min(1, width / 650);
  for (const offset of [0, .5]) {
    const pulse = (progress * 1.8 + offset) % 1;
    context.strokeStyle = `rgba(166, 203, 255, ${(1 - pulse) * .8})`;
    context.lineWidth = 1.4;
    context.beginPath();
    context.ellipse(width * .65, height * .66, (10 + pulse * 67) * ringScale, (5 + pulse * 22) * ringScale, -.18, 0, Math.PI * 2);
    context.stroke();
  }
}

function tick(now) {
  frame = 0;
  if (!playing || document.hidden || dialog.open) return;
  if (previousFrame) elapsed = (elapsed + Math.min(now - previousFrame, 100)) % cycleLength;
  previousFrame = now;
  const progress = (elapsed % phaseLength) / phaseLength;
  showPhase(Math.floor(elapsed / phaseLength), progress);
  drawEffects(elapsed, progress);
  frame = requestAnimationFrame(tick);
}

function refreshPlayback() {
  const label = playing ? '暂停动效' : '播放动效';
  cover.classList.toggle('is-paused', !playing);
  pauseButton.setAttribute('aria-label', label);
  pauseButton.title = label;
  cancelAnimationFrame(frame);
  previousFrame = 0;
  if (playing && !document.hidden && !dialog.open) frame = requestAnimationFrame(tick);
}

pauseButton.addEventListener('click', () => {
  playing = !playing;
  refreshPlayback();
});
reduceMotion.addEventListener('change', () => {
  playing = !reduceMotion.matches;
  drawEffects(elapsed, 0);
  refreshPlayback();
});
document.addEventListener('visibilitychange', refreshPlayback);

for (const button of phaseButtons) {
  button.addEventListener('click', () => {
    const selected = Number(button.dataset.phaseButton);
    elapsed = selected * phaseLength;
    showPhase(selected, playing ? .08 : 1);
    drawEffects(elapsed, 0);
  });
}

cover.addEventListener('pointermove', event => {
  if (!playing || dialog.open || reduceMotion.matches || event.pointerType !== 'mouse') return;
  cover.style.setProperty('--pan-x', `${(event.clientX / innerWidth - .5) * -12}px`);
  cover.style.setProperty('--pan-y', `${(event.clientY / innerHeight - .5) * -8}px`);
});
cover.addEventListener('pointerleave', () => {
  cover.style.setProperty('--pan-x', '0px');
  cover.style.setProperty('--pan-y', '0px');
});

function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = path;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(`无法读取 ${path}`));
    };
    document.head.append(script);
  });
}

openScene.addEventListener('click', async () => {
  const request = ++sceneRequest;
  dialog.showModal();
  refreshPlayback();
  sceneStatus.textContent = '正在加载本地三维模型…';
  try {
    viewerAssets ??= Promise.all([loadScript('./assets/scene.bundle.js'), loadScript('./assets/scene-data.js')]).catch(error => {
      viewerAssets = undefined;
      throw error;
    });
    await viewerAssets;
    if (request !== sceneRequest) return;
    const viewer = window.openRoomScene(sceneView, window.coverSceneData);
    closeViewer = viewer.dispose;
    await viewer.ready;
    if (request !== sceneRequest) return;
    sceneStatus.textContent = '本地 Aholo 3DGS 场景已载入';
  } catch (error) {
    if (request !== sceneRequest) return;
    closeViewer?.();
    closeViewer = undefined;
    sceneStatus.textContent = '三维样例未能加载。请确认浏览器支持 WebGL，且封面文件夹完整。';
    console.warn(error);
  }
});

document.querySelector('#close-scene').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  sceneRequest++;
  closeViewer?.();
  closeViewer = undefined;
  refreshPlayback();
});

showPhase(0, playing ? .08 : 1);
refreshPlayback();
