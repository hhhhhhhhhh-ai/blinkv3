import { toast, pickMime, esc, wait, drawCover, fitSize } from './util.js';
import { I } from './icons.js';

const MAX_REC_SECONDS = 15;
const GLOW_KEY = 'blink_glow';

/**
 * Full-screen camera. The frame has the camera's own aspect ratio (same as your phone's normal
 * camera — nothing is cropped or zoomed). Tap the shutter for a photo, hold it for a video,
 * double-tap the picture (or press the flip button) to switch cameras — also while recording.
 * handlers: { onCapture({blob, kind, duration?}), onFile(file), onClearReply() }
 */
export function createCamera(root, h) {
  root.innerHTML = `
    <div class="cam-frame">
      <video class="cam-video" playsinline muted autoplay></video>
      <video class="cam-video cam-video2" playsinline muted autoplay hidden></video>
      <div class="cam-flash"></div>
      <div class="cam-glow"></div>
      <div class="cam-fallback" hidden>
        <p class="cf-msg"></p>
        <button class="btn primary" data-open>Open camera</button>
        <button class="btn ghost" data-pick>Choose photo or video</button>
      </div>
      <div class="cam-top">
        <button class="reply-pill" hidden></button>
        <div class="cam-side">
          <button class="icon-btn glass cam-flip" aria-label="Flip camera">${I.flip}</button>
          <button class="icon-btn glass cam-flashbtn" aria-label="Flash" aria-pressed="false"></button>
          <button class="icon-btn glass cam-dual" aria-label="Front and back camera together" aria-pressed="false">${I.dual}</button>
          <div class="cam-slider" hidden>
            <input type="range" min="0.15" max="1" step="0.01" value="0.7" aria-label="Flash brightness">
          </div>
        </div>
      </div>
      <div class="cam-rec" hidden><i></i><span>0:00</span></div>
      <div class="cam-bottom">
        <button class="icon-btn glass big cam-gallery" aria-label="Choose from gallery">${I.image}</button>
        <button class="shutter" aria-label="Tap for a photo, hold to record a video">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-bg" cx="50" cy="50" r="44"/><circle class="ring" cx="50" cy="50" r="44"/></svg><i></i>
        </button>
        <span></span>
      </div>
      <p class="cam-hint">Tap for photo · Hold for video · Double-tap to flip</p>
      <input class="f-pick" type="file" accept="image/*,video/*" hidden>
      <input class="f-cap" type="file" accept="image/*,video/*" capture="environment" hidden>
    </div>`;

  const q = s => root.querySelector(s);
  const frame = q('.cam-frame'), video = q('.cam-video'), video2 = q('.cam-video2'), dualBtn = q('.cam-dual'), shutter = q('.shutter'), fallback = q('.cam-fallback');
  const recBadge = q('.cam-rec'), fPick = q('.f-pick'), fCap = q('.f-cap'), replyPill = q('.reply-pill');
  const flashBtn = q('.cam-flashbtn'), glow = q('.cam-glow'), sliderBox = q('.cam-slider'), slider = q('input[type=range]', sliderBox);

  let stream = null, starting = false, facing = 'environment', flipping = false;
  let holdTimer = null, pressing = false, capturing = false;
  let recorder = null, chunks = [], t0 = 0, tick = null, autoStop = null, recMime = '', canvasTimer = null, canvasRec = false;
  let flashOn = false, torchOk = false, lastTap = null;
  let dual = false, stream2 = null, dualPref = false;   // dualPref: stays on between snaps until you turn it off

  /* ---------- picture format: follow the camera's own aspect ratio ---------- */
  function syncRatio() {
    if (dual) return;
    if (video.videoWidth && video.videoHeight) frame.style.setProperty('--ar', (video.videoWidth / video.videoHeight).toFixed(4));
  }
  video.addEventListener('loadedmetadata', syncRatio);
  video.addEventListener('resize', syncRatio);

  /* ---------- flash ---------- */
  let glowLevel = 0.7;
  try { const v = parseFloat(localStorage.getItem(GLOW_KEY)); if (v >= 0.15 && v <= 1) glowLevel = v; } catch { /* ignore */ }
  slider.value = String(glowLevel);
  const applyGlow = () => frame.style.setProperty('--gi', String(glowLevel));
  applyGlow();
  slider.addEventListener('input', () => {
    glowLevel = parseFloat(slider.value) || 0.7;
    applyGlow();
    try { localStorage.setItem(GLOW_KEY, String(glowLevel)); } catch { /* ignore */ }
  });
  // sliding the brightness must never start a tap/double-tap/swipe on the camera
  for (const ev of ['pointerdown', 'pointerup', 'click']) sliderBox.addEventListener(ev, e => e.stopPropagation());

  function updateFlashUI() {
    flashBtn.classList.toggle('on', flashOn);
    flashBtn.setAttribute('aria-pressed', String(flashOn));
    flashBtn.innerHTML = flashOn ? I.bolt : I.boltOff;
    const show = flashOn && (facing === 'user' || dual);   // front camera: the screen itself is the light
    glow.classList.toggle('on', show);
    sliderBox.hidden = !show;
  }
  updateFlashUI();

  const vtrack = () => (stream && stream.getVideoTracks()[0]) || null;

  async function setTorch(on) {
    const t = vtrack();
    if (!t || !torchOk) return false;
    try { await t.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }

  /** Rear camera → real torch (where the browser allows it). Front camera → the glow is already on screen. */
  async function lightOn(settle) {
    if (!flashOn) return false;
    if (facing === 'user' || dual) { if (settle) await wait(120); return true; }
    if (torchOk && await setTorch(true)) { if (settle) await wait(380); return true; }
    return false;
  }
  function lightOff() { if (torchOk && facing === 'environment') setTorch(false); }

  flashBtn.addEventListener('click', () => {
    if (!flashOn && facing === 'environment' && stream && !torchOk) {
      toast('This browser doesn’t allow the rear flash. Flip to the front camera for a screen flash.', 3600);
      return;
    }
    flashOn = !flashOn;
    updateFlashUI();
  });

  /* ---------- stream ---------- */
  const videoConstraints = f => ({
    facingMode: { ideal: f },
    // the same 3:4 / 4:3 picture the phone's own camera app takes — the browser picks the orientation
    width: { ideal: 1440 }, height: { ideal: 1080 }, aspectRatio: { ideal: 4 / 3 },
  });
  const getStream = (audio, f = facing) => navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints(f) });

  function showFallback(msg) {
    q('.cf-msg').textContent = msg;
    fallback.hidden = false;
  }

  function readCaps() {
    const t = vtrack();
    let caps = {};
    try { caps = (t && t.getCapabilities && t.getCapabilities()) || {}; } catch { /* ignore */ }
    torchOk = !!caps.torch;
  }

  async function start() {
    if (stream || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showFallback('The live camera isn’t available in this browser.');
    }
    starting = true;
    try {
      try { stream = await getStream(true); }
      catch (e) { stream = await getStream(false); }   // no mic? still allow photos/silent video
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      fallback.hidden = true;
      readCaps();
      updateFlashUI();
      await video.play().catch(() => {});
      syncRatio();
    } catch (e) {
      stream = null; torchOk = false;
      showFallback('Camera access is blocked. Allow it in your browser settings, or use your phone’s camera instead.');
    } finally {
      starting = false;
    }
    if (stream && dualPref && !dual) toggleDual();
  }

  function stop() {
    exitDualNow();
    if (recorder) { try { recorder.onstop = null; recorder.stop(); } catch { /* ignore */ } cleanupRec(); }
    lightOff();
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; torchOk = false;
    video.srcObject = null;
  }

  /* ---------- switch camera (works while recording: the mic stream and the recorder keep running) ---------- */
  async function flip() {
    if (flipping) return;
    const next = facing === 'user' ? 'environment' : 'user';
    if (!stream) { facing = next; updateFlashUI(); return start(); }
    if (dual && stream2) {          // two cameras on screen: flipping swaps which one is on top
      const a = vtrack(), b = stream2.getVideoTracks()[0];
      stream.removeTrack(a); stream.addTrack(b);
      stream2.removeTrack(b); stream2.addTrack(a);
      facing = next;
      video.srcObject = new MediaStream([b]); video2.srcObject = new MediaStream([a]);
      video.classList.toggle('mirror', facing === 'user'); video2.classList.toggle('mirror', facing !== 'user');
      readCaps(); updateFlashUI();
      await Promise.all([video.play().catch(() => {}), video2.play().catch(() => {})]);
      return;
    }
    if (recorder && !canvasRec) { toast('Switching cameras while recording isn’t supported in this browser'); return; }
    flipping = true;
    const old = vtrack();
    try {
      await setTorch(false);
      if (old) { stream.removeTrack(old); old.stop(); }   // many phones can't open two cameras at once
      let vs;
      try { vs = await getStream(false, next); }
      catch (e) {
        vs = await getStream(false, facing);               // couldn't open the other one → go back to the first
        next === facing || toast('Couldn’t switch cameras');
      }
      const nt = vs.getVideoTracks()[0];
      if (nt) { facing = vs.getVideoTracks()[0].getSettings().facingMode === (next === 'user' ? 'environment' : 'user') ? facing : next; stream.addTrack(nt); }
      video.srcObject = new MediaStream(nt ? [nt] : []);
      video.classList.toggle('mirror', facing === 'user');
      readCaps();
      await video.play().catch(() => {});
      syncRatio();
      if (flashOn && facing === 'environment' && !torchOk) { flashOn = false; toast('Rear flash isn’t available in this browser'); }
      updateFlashUI();
      if (recorder && flashOn && facing === 'environment') setTorch(true);
    } catch (e) {
      console.warn('flip failed', e);
      stop(); start();
    } finally {
      flipping = false;
    }
  }
  q('.cam-flip').addEventListener('click', flip);

  /* ---------- both cameras at once (front + back, stacked) ---------- */
  function exitDualNow() {
    if (stream2) stream2.getTracks().forEach(t => t.stop());
    stream2 = null; video2.srcObject = null; video2.hidden = true;
    const was = dual;
    dual = false;
    frame.classList.remove('dual');
    dualBtn.classList.remove('on'); dualBtn.setAttribute('aria-pressed', 'false');
    if (was) { syncRatio(); updateFlashUI(); }
  }

  async function toggleDual() {
    if (flipping || recorder) return;
    if (dual) { dualPref = false; exitDualNow(); return; }
    dualPref = true;
    if (!stream) { toast('Open the camera first'); return; }
    flipping = true;
    try {
      const other = facing === 'user' ? 'environment' : 'user';
      let vs;
      try { vs = await getStream(false, other); }
      catch (e) { dualPref = false; toast('Your phone can’t open both cameras at once.', 3400); return; }
      stream2 = vs;
      video2.srcObject = vs;
      video2.classList.toggle('mirror', other === 'user');
      video2.hidden = false; dual = true;
      frame.classList.add('dual'); frame.style.setProperty('--ar', '0.75');
      dualBtn.classList.add('on'); dualBtn.setAttribute('aria-pressed', 'true');
      await Promise.all([video.play().catch(() => {}), video2.play().catch(() => {})]);
      await wait(350);
      // some phones close the first camera when a second one opens → undo and say so
      const t = vtrack(), t2 = stream2 && stream2.getVideoTracks()[0];
      if (!t || t.readyState !== 'live' || !t2 || t2.readyState !== 'live') {
        dualPref = false; exitDualNow(); stop(); await start();
        toast('Your phone can’t use both cameras at once.', 3400);
        return;
      }
      updateFlashUI();
    } finally {
      flipping = false;
    }
  }
  dualBtn.addEventListener('click', toggleDual);

  /** Draw the current camera picture (one camera, or both stacked) into a canvas. */
  function drawInto(ctx, v, x, y, w, hh, mirror) {
    if (!v.videoWidth) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
    ctx.translate(x, y);
    drawCover(ctx, v, v.videoWidth, v.videoHeight, w, hh, mirror);
    ctx.restore();
  }
  function paint(ctx, cw, ch) {
    if (dual) {
      drawInto(ctx, video, 0, 0, cw, ch / 2, facing === 'user');
      drawInto(ctx, video2, 0, ch / 2, cw, ch / 2, facing !== 'user');
    } else if (video.videoWidth) {
      drawCover(ctx, video, video.videoWidth, video.videoHeight, cw, ch, facing === 'user');
    }
  }

  // double-tap the picture to switch cameras
  frame.addEventListener('pointerup', e => {
    if (e.target.closest('button, input, .cam-slider, .shutter, .cam-fallback')) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = null;
      try { navigator.vibrate && navigator.vibrate(8); } catch { /* ignore */ }
      flip();
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  });

  /* ---------- photo (the camera's own format — no crop) ---------- */
  async function takePhoto() {
    if (capturing || !stream) return;
    capturing = true;
    try {
      await lightOn(true);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const [w, hh] = dual ? [1080, 1440] : fitSize(vw, vh, 1920);
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      paint(c.getContext('2d'), w, hh);
      root.classList.add('flash');
      setTimeout(() => root.classList.remove('flash'), 160);
      lightOff();
      c.toBlob(b => b && h.onCapture({ blob: b, kind: 'image' }), 'image/jpeg', 0.9);
    } finally {
      lightOff();
      capturing = false;
    }
  }

  /* ---------- video (recorded through a canvas so the camera can change mid-recording) ---------- */
  async function startRec() {
    if (!stream || typeof MediaRecorder === 'undefined') {
      toast('Video recording isn’t supported in this browser');
      return;
    }
    const mime = pickMime();
    let src = stream;
    canvasRec = false;
    if (HTMLCanvasElement.prototype.captureStream && video.videoWidth) {
      const [cw, ch] = dual ? [720, 960] : fitSize(video.videoWidth, video.videoHeight, 1280, true);
      const cvs = document.createElement('canvas');
      cvs.width = cw; cvs.height = ch;
      const ctx = cvs.getContext('2d');
      const draw = () => { if (video.videoWidth && video.readyState >= 2) paint(ctx, cw, ch); };
      draw();
      canvasTimer = setInterval(draw, 1000 / 30);
      src = cvs.captureStream(30);
      stream.getAudioTracks().forEach(t => src.addTrack(t));
      canvasRec = true;
    }
    try {
      recorder = new MediaRecorder(src, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : {});
    } catch (e) {
      clearInterval(canvasTimer);
      recorder = null;
      toast('Couldn’t start recording');
      return;
    }
    recMime = (recorder.mimeType || mime || 'video/webm').split(';')[0];
    chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const elapsed = (Date.now() - t0) / 1000;
      const blob = new Blob(chunks, { type: recMime });
      cleanupRec();
      if (elapsed < 0.8 || !blob.size) { toast('Hold a little longer to record'); return; }
      h.onCapture({ blob, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(elapsed))) });
    };
    t0 = Date.now();
    recorder.start(250);
    lightOn(false);
    shutter.classList.add('rec');
    dualBtn.disabled = true;
    recBadge.hidden = false;
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      recBadge.querySelector('span').textContent = `0:${String(s).padStart(2, '0')}`;
    }, 250);
    autoStop = setTimeout(stopRec, MAX_REC_SECONDS * 1000);
    try { navigator.vibrate && navigator.vibrate(12); } catch { /* ignore */ }
  }

  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function cleanupRec() {
    clearInterval(tick); clearTimeout(autoStop); clearInterval(canvasTimer);
    shutter.classList.remove('rec');
    dualBtn.disabled = false;
    recBadge.hidden = true;
    recBadge.querySelector('span').textContent = '0:00';
    recorder = null; canvasRec = false;
    lightOff();
  }

  /* ---------- shutter: tap = photo, hold = video ---------- */
  shutter.addEventListener('pointerdown', e => {
    if (!stream) return;
    e.preventDefault();
    pressing = true;
    shutter.classList.add('down');
    if (shutter.setPointerCapture) { try { shutter.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    holdTimer = setTimeout(() => { holdTimer = null; startRec(); }, 320);
  });
  const release = () => {
    if (!pressing) return;
    pressing = false;
    shutter.classList.remove('down');
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; takePhoto(); }
    else if (recorder) stopRec();
  };
  shutter.addEventListener('pointerup', release);
  shutter.addEventListener('pointercancel', release);
  shutter.addEventListener('contextmenu', e => e.preventDefault());
  shutter.addEventListener('click', () => { if (!stream) fCap.click(); });   // no live camera → system camera

  /* ---------- other controls ---------- */
  q('.cam-gallery').addEventListener('click', () => fPick.click());
  fallback.querySelector('[data-open]').addEventListener('click', () => fCap.click());
  fallback.querySelector('[data-pick]').addEventListener('click', () => fPick.click());
  for (const inp of [fPick, fCap]) {
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (f) h.onFile(f, inp === fPick);   // library picks are labelled “Media”; the system camera isn’t
    });
  }
  replyPill.addEventListener('click', () => h.onClearReply && h.onClearReply());

  /** r = { label } or null */
  function setReply(r) {
    replyPill.hidden = !r;
    if (r) replyPill.innerHTML = `To <b>${esc(r.label)}</b> ${I.close}`;
  }

  return { start, stop, setReply };
}
