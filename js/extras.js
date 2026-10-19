import { $, $$, esc, clamp } from './util.js';
import { I } from './icons.js';

/* ── snap filters (a look applied when the snap is shown; the picture itself is untouched) ── */
export const FILTERS = [
  { id: 'none', name: 'Normal', css: '' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.8) contrast(1.1)' },
  { id: 'warm', name: 'Warm', css: 'sepia(.28) saturate(1.45) hue-rotate(-12deg) brightness(1.05)' },
  { id: 'cool', name: 'Cool', css: 'saturate(1.2) hue-rotate(18deg) brightness(1.03)' },
  { id: 'bw', name: 'B&W', css: 'grayscale(1) contrast(1.1)' },
  { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.55) brightness(.88)' },
  { id: 'sepia', name: 'Sepia', css: 'sepia(.9) contrast(1.05)' },
  { id: 'vintage', name: 'Vintage', css: 'sepia(.45) contrast(.9) saturate(1.25) brightness(1.06)' },
  { id: 'fade', name: 'Fade', css: 'contrast(.85) brightness(1.15) saturate(.75)' },
  { id: 'dream', name: 'Dream', css: 'brightness(1.12) saturate(1.3) contrast(.95) blur(.5px)' },
  { id: 'pop', name: 'Pop', css: 'contrast(1.35) saturate(1.55) hue-rotate(-8deg)' },
  { id: 'night', name: 'Night', css: 'brightness(.8) contrast(1.2) saturate(1.2) hue-rotate(190deg)' },
];
export const fxCss = id => (FILTERS.find(f => f.id === id) || FILTERS[0]).css;

/* ── stickers (big emoji) ── */
export const STICKER_PACKS = [
  { name: 'Faces', items: '😂 🥹 😍 🥰 😎 🤩 😭 😡 🥳 🤯 😴 🤔 🙄 😬 🤪 😇 🤭 😏 😱 🫠 🤗 😅 😘 🥶'.split(' ') },
  { name: 'Hearts', items: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💖 💘 💕 💞 💔 ❤️‍🔥 💋 ✨ 💫 🌈 ⭐ 🌟'.split(' ') },
  { name: 'Hype', items: '🔥 💯 🎉 🎊 👑 💎 🚀 ⚡ 💥 🏆 🎯 🙌 👏 💪 🤝 🫶 👍 👎 🙏 ✌️ 🤞 👀 🫡 💀'.split(' ') },
  { name: 'Animals', items: '🐶 🐱 🐻 🐼 🦊 🐸 🐵 🦄 🐯 🐰 🐧 🦁 🐙 🦋 🐢 🐳 🦖 🐝 🐥 🦦'.split(' ') },
  { name: 'Food', items: '🍕 🍔 🍟 🌮 🍣 🍩 🍪 🍦 🍓 🍉 🥑 🍿 ☕ 🧋 🍺 🥂 🍫 🥐 🍜 🍰'.split(' ') },
  { name: 'Vibes', items: '☀️ 🌙 🌸 🌴 🌊 🏖️ ⛄ 🎧 🎮 📸 ⚽ 🏀 🎸 ✈️ 🚗 🏠 🎁 🎈 💤 🍀'.split(' ') },
];
export const STICKER_SIZES = [1, 1.7, 2.6];

/** Stickers placed on a snap: positions are fractions of the picture, size is a multiplier. */
export const decorHtml = decor => (Array.isArray(decor) ? decor : []).map(d =>
  `<span class="dec" style="left:${clamp(+d.x || 0, 0, 1) * 100}%;top:${clamp(+d.y || 0, 0, 1) * 100}%;--s:${clamp(+d.s || 1, 0.5, 4)}">${esc(String(d.e))}</span>`).join('');

/* ── chat backgrounds ── */
export const BGS = [
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(165deg,#ff9a76 0%,#ff4f9a 52%,#4a2178 100%)' },
  { id: 'ocean', name: 'Ocean', css: 'linear-gradient(170deg,#0b3c6b 0%,#1fa2c4 62%,#8ee8d6 100%)' },
  { id: 'forest', name: 'Forest', css: 'linear-gradient(170deg,#0b2b1c 0%,#1f7a4a 60%,#b7e36b 100%)' },
  { id: 'candy', name: 'Candy', css: 'linear-gradient(160deg,#ffd1ec 0%,#c9a4ff 50%,#8fd3ff 100%)' },
  { id: 'lava', name: 'Lava', css: 'linear-gradient(170deg,#1a0508 0%,#c4160a 60%,#ffb02e 100%)' },
  { id: 'aurora', name: 'Aurora', css: 'linear-gradient(160deg,#071a2e 0%,#0e7c86 45%,#7a3df0 100%)' },
  { id: 'night', name: 'Night sky', css: 'radial-gradient(2px 2px at 20% 30%,#fff8,transparent),radial-gradient(1.5px 1.5px at 70% 20%,#fff8,transparent),radial-gradient(2px 2px at 40% 75%,#fff8,transparent),radial-gradient(1.5px 1.5px at 85% 65%,#fff8,transparent),linear-gradient(180deg,#05060f,#1a1650)' },
  { id: 'dots', name: 'Dots', css: 'radial-gradient(circle,rgba(255,255,255,.14) 2px,transparent 2.5px) 0 0/22px 22px,#15131f' },
  { id: 'grid', name: 'Grid', css: 'linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px) 0 0/26px 26px,linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px) 0 0/26px 26px,#10162b' },
  { id: 'stripes', name: 'Stripes', css: 'repeating-linear-gradient(135deg,#1c1530 0 18px,#251a40 18 36px)' },
  { id: 'paper', name: 'Paper', css: 'linear-gradient(180deg,#f6efe4,#e9dcc6)' },
  { id: 'mint', name: 'Mint', css: 'linear-gradient(170deg,#d9fff0 0%,#7fe0c0 100%)' },
];
export const bgOf = id => BGS.find(b => b.id === id);
const LIGHT_BGS = new Set(['paper', 'mint', 'candy']);

/** Apply a shared background ({kind, value, url} or nothing) to a chat's thread element. */
export function paintThreadBg(thread, bg) {
  const p = bg && bg.kind === 'preset' ? bgOf(bg.value) : null;
  const img = bg && bg.kind === 'image' && bg.url ? bg.url : null;
  thread.classList.toggle('custom', !!(p || img));
  thread.classList.toggle('bg-light', !!(p && LIGHT_BGS.has(p.id)));
  if (p) { thread.style.background = p.css; }
  else if (img) { thread.style.background = `center / cover no-repeat url("${img.replace(/"/g, '%22')}")`; }
  else thread.style.background = '';
}

/* ── small sheets ── */
function sheet(openOverlay, title, inner) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}"><div class="grab"></div><h3>${esc(title)}</h3>${inner}</div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  return { el, h };
}

export function openStickerTray({ openOverlay, title = 'Stickers', onPick }) {
  const { el, h } = sheet(openOverlay, title, `
    <div class="st-tabs">${STICKER_PACKS.map((p, i) => `<button type="button" data-tab="${i}" class="${i ? '' : 'on'}">${esc(p.name)}</button>`).join('')}</div>
    <div class="st-grid"></div>`);
  const grid = $('.st-grid', el);
  const show = i => {
    $$('.st-tabs button', el).forEach((b, j) => b.classList.toggle('on', i === j));
    grid.innerHTML = STICKER_PACKS[i].items.map(e => `<button type="button" data-s="${esc(e)}" aria-label="Sticker ${esc(e)}">${esc(e)}</button>`).join('');
  };
  show(0);
  el.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]'); if (t) { show(+t.dataset.tab); return; }
    const s = e.target.closest('[data-s]'); if (s) { h.close(); onPick(s.dataset.s); }
  });
}

export function openPollMaker({ openOverlay, onSend, toast }) {
  const { el, h } = sheet(openOverlay, 'New poll', `
    <p class="muted pad-s">Everyone in this chat can vote. Tap your answer again to take your vote back.</p>
    <input class="pl-q" name="q" maxlength="200" placeholder="Ask a question…" autocomplete="off">
    <div class="pl-opts"></div>
    <button type="button" class="btn small" data-addopt>${I.plus}Add option</button>
    <button type="button" class="btn primary wide" data-go>Send poll</button>`);
  const box = $('.pl-opts', el), add = $('[data-addopt]', el);
  const addOpt = () => {
    const n = $$('input', box).length;
    if (n >= 6) return;
    const i = document.createElement('input');
    i.maxLength = 60; i.placeholder = `Option ${n + 1}`; i.autocomplete = 'off';
    box.appendChild(i);
    add.hidden = n + 1 >= 6;
  };
  addOpt(); addOpt();
  add.addEventListener('click', () => { addOpt(); $$('input', box).pop().focus(); });
  $('[data-go]', el).addEventListener('click', async ev => {
    const q = $('.pl-q', el).value.trim(), opts = $$('input', box).map(i => i.value.trim()).filter(Boolean);
    if (!q) return toast('Type a question first');
    if (opts.length < 2) return toast('Add at least 2 options');
    ev.target.disabled = true;
    try { await onSend(q, opts); h.close(); }
    catch (e) { ev.target.disabled = false; toast(e.message || 'Couldn’t send the poll'); }
  });
  setTimeout(() => $('.pl-q', el).focus(), 300);
}

/** current = {kind,value} | undefined. onPreset(id) / onImage(file) / onClear() each return a promise. */
export function openBgPicker({ openOverlay, current, who, onPreset, onImage, onClear, toast }) {
  const { el, h } = sheet(openOverlay, 'Chat background', `
    <p class="muted pad-s">Everyone in ${esc(who)} sees the same background.</p>
    <div class="bg-grid">
      <button type="button" data-bg="" class="bgc ${current ? '' : 'on'}"><span class="bgp def"></span><small>Default</small></button>
      ${BGS.map(b => `<button type="button" data-bg="${b.id}" class="bgc ${current && current.kind === 'preset' && current.value === b.id ? 'on' : ''}"><span class="bgp" style="background:${esc(b.css)}"></span><small>${esc(b.name)}</small></button>`).join('')}
      <button type="button" data-own class="bgc ${current && current.kind === 'image' ? 'on' : ''}"><span class="bgp own">${I.image}</span><small>My photo</small></button>
    </div>
    <input type="file" accept="image/*" hidden>`);
  const file = $('input[type=file]', el);
  const run = async fn => { try { await fn(); h.close(); } catch (e) { toast(e.message || 'Couldn’t change the background'); } };
  el.addEventListener('click', e => {
    if (e.target.closest('[data-own]')) { file.click(); return; }
    const b = e.target.closest('[data-bg]');
    if (b) run(() => (b.dataset.bg ? onPreset(b.dataset.bg) : onClear()));
  });
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) run(() => onImage(f)); });
}

/** Little action sheet: items = [{ icon, label, act }] */
/** (the next sheet opens a moment later so this one can finish closing first) */
export function openActionSheet({ openOverlay, title, items }) {
  const { el, h } = sheet(openOverlay, title, `<div class="as-list">${items.map((it, i) => `<button type="button" class="item" data-i="${i}"><span class="as-ic">${it.icon}</span><span class="item-main"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('')}</div>`);
  el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { h.close(); setTimeout(items[+b.dataset.i].act, 380); } });
}
