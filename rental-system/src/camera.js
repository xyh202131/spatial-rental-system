export function frameMetrics(canvas) {
  const small = document.createElement('canvas');
  small.width = 96; small.height = 54;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 96, 54);
  const pixels = ctx.getImageData(0, 0, 96, 54).data;
  let brightness = 0, bright = 0, detail = 0, prior = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
    brightness += luma; if (luma > 245) bright++;
    detail += Math.abs(luma - prior); prior = luma;
  }
  const count = pixels.length / 4;
  return { brightness: brightness / count, overexposure: bright / count, detail: detail / count };
}
export const cameraError = error => ({
  NotAllowedError: '相机权限未开启。请在浏览器地址栏允许使用相机，然后重试。',
  NotFoundError: '没有找到可用相机。请连接摄像头，或在支持相机的设备上打开。',
  NotReadableError: '相机可能被其他程序占用，请关闭占用它的应用后重试。',
  OverconstrainedError: '当前相机不支持请求的参数，请换一个相机重试。',
}[error.name] || '相机暂时无法打开，请检查设备和浏览器权限后重试。');

export class CaptureCamera {
  constructor(video, { onState, onCapture, onTip, requestTip }) {
    Object.assign(this, { video, onState, onCapture, onTip, requestTip });
    this.stream = null; this.recorder = null; this.tipEnabled = true;
    this.remoteEnabled = false; this.closed = false; this.facing = 'environment';
    this.count = 0; this.tipBusy = false; this.recordFrames = [];
  }
  async open() {
    if (this.stream?.active) { this.onState({ ready: true }); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.onState({ error: '相机需要安全连接。请在本机 localhost 或已配置 HTTPS 的地址打开。' });
      return;
    }
    this.closed = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: this.facing } }, audio: false });
      if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        this.onState({ error: '相机连接已中断，已保存素材仍然保留。请重新开启相机。' });
        if (this.recorder?.state !== 'inactive') this.recorder?.stop();
      });
      this.onState({ ready: true, recording: false });
      clearInterval(this.tipTimer);
      this.tipTimer = setInterval(() => this.guide(), 10000);
      this.guide();
    } catch (error) { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.onState({ ready: false, error: cameraError(error) }); }
  }
  snapshot(width = 1280) {
    if (!this.video.videoWidth || !this.stream?.active) throw new Error('相机画面尚未准备好。');
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(width, this.video.videoWidth);
    canvas.height = Math.round(canvas.width * this.video.videoHeight / this.video.videoWidth);
    canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  async photo(purpose) {
    const canvas = this.snapshot();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
    if (!blob) throw new Error('照片生成失败，请重试。');
    await this.onCapture({ blob, purpose, capturedAt: new Date().toISOString(), metrics: frameMetrics(canvas), duration: 0 });
  }
  async guide() {
    if (this.closed || !this.stream?.active || !this.tipEnabled || this.tipBusy) return;
    this.tipBusy = true;
    try {
      const canvas = this.snapshot(640);
      if (this.remoteEnabled) {
        try {
          const result = await this.requestTip(canvas.toDataURL('image/jpeg', .7));
          if (!this.closed && this.tipEnabled && this.remoteEnabled) this.onTip(result.tip, 'Agent 实时指导');
        } catch { if (!this.closed && this.tipEnabled) this.onTip('Agent 暂不可用，可继续拍摄或稍后重试。', '指导连接中断'); }
      } else {
        const stats = frameMetrics(canvas);
        const tips = ['拍摄建议：移动慢一点，保持画面稳定。', '拍摄建议：相邻视角保留重叠区域。', '拍摄建议：不要遗漏墙角、门窗和遮挡位置。', '拍摄建议：另外拍摄设施近照，用于后续对照。'];
        this.onTip(stats.brightness < 45 ? '画面亮度偏低，请检查现场光照。' : stats.overexposure > .35 ? '过亮区域较多，请检查曝光和拍摄角度。' : tips[this.count++ % tips.length], '本地基础指导');
      }
    } catch { if (!this.closed && this.tipEnabled) this.onTip('当前画面暂不可分析，请检查相机连接。', '指导暂不可用'); }
    finally { this.tipBusy = false; }
  }
  startRecording() {
    if (!this.stream?.active) throw new Error('请先开启相机。');
    if (typeof MediaRecorder === 'undefined') throw new Error('此浏览器暂不支持录像，请使用实时拍照。');
    const mimeType = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('此浏览器没有可用的录像格式，请使用实时拍照。');
    this.chunks = []; this.bytes = 0; this.recordFrames = [];
    this.started = Date.now(); this.pausedMs = 0; this.pausedAt = null;
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 2_000_000 });
    this.recorder.ondataavailable = event => {
      if (event.data.size) { this.chunks.push(event.data); this.bytes += event.data.size; }
      if (this.bytes > 45 * 1024 * 1024 && this.recorder.state !== 'inactive') this.recorder.stop();
    };
    this.finished = new Promise((resolve, reject) => {
      this.recorder.onerror = () => reject(new Error('录像中断，请保留页面并检查已保存素材。'));
      this.recorder.onstop = async () => {
        clearInterval(this.recordTimer);
        this.onState({ ready: true, recording: false, saving: true });
        try {
          this.collectFrame();
          const duration = this.elapsed();
          const blob = new Blob(this.chunks, { type: mimeType.split(';')[0] });
          if (!blob.size) throw new Error('未录制到有效视频。');
          await this.onCapture({ blob, purpose: 'reconstruction', capturedAt: new Date(this.started).toISOString(), duration, metrics: {}, frames: this.recordFrames });
          resolve();
        } catch (error) { reject(error); }
        finally { this.chunks = []; this.onState({ ready: Boolean(this.stream?.active), recording: false, saving: false }); }
      };
    });
    // The stop caller also awaits this promise; this handler prevents an unhandled rejection on automatic stop.
    this.finished.catch(error => this.onState({ error: error.message, ready: Boolean(this.stream?.active), recording: false }));
    this.recorder.start(1000);
    this.collectFrame();
    this.recordTimer = setInterval(() => {
      const elapsed = this.elapsed();
      this.onState({ ready: true, recording: true, paused: this.recorder.state === 'paused', elapsed });
      if (elapsed >= 25 && this.recordFrames.length === 1) this.collectFrame();
      if (elapsed >= 60 && this.recorder.state !== 'inactive') this.recorder.stop();
    }, 500);
    this.onState({ ready: true, recording: true, paused: false, elapsed: 0 });
    return mimeType;
  }
  collectFrame() {
    if (this.recordFrames.length >= 3) return;
    try {
      const canvas = this.snapshot(960);
      this.recordFrames.push({ data: canvas.toDataURL('image/jpeg', .8), metrics: frameMetrics(canvas), capturedAt: new Date().toISOString() });
    } catch { /* A disconnected camera may not supply a final frame. The video remains independently reviewable. */ }
  }
  elapsed() { return ((this.pausedAt || Date.now()) - this.started - this.pausedMs) / 1000; }
  pause() {
    if (this.recorder?.state === 'recording') { this.recorder.pause(); this.pausedAt = Date.now(); }
    else if (this.recorder?.state === 'paused') { this.pausedMs += Date.now() - this.pausedAt; this.pausedAt = null; this.recorder.resume(); }
    this.onState({ recording: true, paused: this.recorder?.state === 'paused', elapsed: this.elapsed() });
  }
  async stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    try { if (this.finished) await this.finished; }
    finally { this.finished = null; }
  }
  async close() {
    this.closed = true; clearInterval(this.tipTimer);
    try { await this.stopRecording(); }
    finally { clearInterval(this.recordTimer); this.stream?.getTracks().forEach(t => t.stop()); this.video.srcObject = null; this.stream = null; }
  }
}
