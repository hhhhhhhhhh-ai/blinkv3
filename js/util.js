export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const truncate = (s = '', n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function hue(str = '') {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function avatar(user, size = 44, extra = '') {
  const st = `--h:${hue(user.username)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`;
  if (user.avatar_url) {
    return `<span class="avatar has-img ${extra}" style="${st}"><img src="${esc(user.avatar_url)}" alt="" draggable="false" loading="lazy"></span>`;
  }
  const initial = esc((user.display_name || user.username || '?').trim().charAt(0).toUpperCase());
  return `<span class="avatar ${extra}" style="${st}">${initial}</span>`;
}

/** Centre-crop a picture to a small square JPEG (for profile pictures). */
export async function squareImage(file, size = 320) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const k = Math.max(size / bmp.width, size / bmp.height);
  c.getContext('2d').drawImage(bmp, (size - bmp.width * k) / 2, (size - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not read that picture'))), 'image/jpeg', 0.85));
}

export function fmtTime(ts, long = false) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  const days = (now - d) / 864e5;
  const day = days < 6
    ? d.toLocaleDateString([], { weekday: 'short' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return long ? `${day} ${hm}` : day;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function haptic(p = 10) {
  try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ }
}

/** Best video container this browser can record (mp4 first: plays everywhere). */
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

/**
 * Draw `src` into a (outW × outH) canvas context so it fills it completely ("cover").
 * When the output has the same aspect ratio as the source nothing is cropped.
 */
export function drawCover(ctx, src, sw, sh, outW, outH, mirror = false) {
  const s = Math.max(outW / sw, outH / sh);
  const dw = sw * s, dh = sh * s;
  ctx.save();
  if (mirror) { ctx.translate(outW, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  ctx.restore();
}

/** Keep the source's own aspect ratio, never upscale, cap the long side. */
export function fitSize(sw, sh, maxSide = 1920, even = false) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  let w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh * k));
  if (even) { w -= w % 2; h -= h % 2; }
  return [w, h];
}

/** Re-encode a photo at its own aspect ratio (no cropping), honouring EXIF rotation, max 1920px on the long side. */
export async function normalizeImage(src, { mirror = false } = {}) {
  let bmp;
  try { bmp = await createImageBitmap(src, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(src); }
  const [w, h] = fitSize(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawCover(c.getContext('2d'), bmp, bmp.width, bmp.height, w, h, mirror);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('Could not process that image'))), 'image/jpeg', 0.88));
}

/** Read a video file's length in seconds (Infinity/NaN → null). */
export function videoDuration(blob) {
  return new Promise(res => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = d => { URL.revokeObjectURL(url); res(Number.isFinite(d) ? d : null); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}
