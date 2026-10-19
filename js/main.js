import { createBackend, USERNAME_RE, MAX_GROUP_FRIENDS, expired, bgScope } from './backend.js';
import {
  FILTERS, fxCss, decorHtml, STICKER_SIZES, paintThreadBg, openStickerTray, openPollMaker, openBgPicker, openActionSheet,
} from './extras.js';
import { openAccount } from './account.js';
import { applyTheme, loadTheme } from './themes.js';
import { startVoice } from './voice.js';
import { recent } from './recent.js';
import { createCamera } from './camera.js';
import {
  $, $$, esc, avatar, fmtTime, toast, haptic, debounce, truncate, hue, clamp, normalizeImage, videoDuration,
} from './util.js';
import { I, LOGO } from './icons.js';

applyTheme(loadTheme(), false);
const app = $('#app');
const isTextLike = k => k === 'text' || k === 'voice' || k === 'sticker' || k === 'poll';
const fxStyle = x => (x && x.fx && fxCss(x.fx) ? ` style="filter:${fxCss(x.fx)}"` : '');
/** Put the "Media" label on the picture's top-left corner (or just under the header if the picture reaches the top). */
function placeRoll(el) {
  const tag = $('.v-roll', el), stage = $('.stage', el);
  if (!tag || !stage) return;
  const go = () => {
    const r = stage.getBoundingClientRect(), hd = $('.v-head', el) || $('[data-x]', el);
    tag.style.top = `${Math.max(r.top + 8, hd ? hd.getBoundingClientRect().bottom + 8 : 0)}px`;
    tag.style.left = `${Math.max(r.left + 8, 8)}px`;
  };
  requestAnimationFrame(go); setTimeout(go, 200); setTimeout(go, 600);
}
const rollTag = x => (x && x.from_roll ? '<div class="v-roll">Media</div>' : '');
const fmtDur = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;
const EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥'];
const hm = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const emptyData = () => ({ friends: [], incoming: [], outgoing: [], groups: [], stories: [], bestFriends: [], bgs: {}, convos: {} });
const isBest = id => data.bestFriends.includes(id);

let be = null, me = null, camera = null, main = null;
let data = emptyData();
let loaded = false, tab = 'camera', replyTo = null, chat = null, viewing = false, swiped = false;
let unsub = null, poll = null, purgeTimer = null, refreshing = false, again = false;

/* ═══════════ overlays (with Android back-button support) ═══════════ */
const stack = [];
const SID = Math.random().toString(36).slice(2);

function openOverlay(el, onClose) {
  const entry = { el, onClose, closing: false };
  stack.push(entry);
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  history.pushState({ ov: stack.length, sid: SID }, '');
  syncCamera();
  return {
    close() {
      const i = stack.indexOf(entry);
      if (i < 0 || entry.closing) return;
      entry.closing = true;
      history.go(-(stack.length - i));
    },
  };
}

addEventListener('popstate', e => {
  // history entries left over from before a page reload carry another session id → treat them as 'no overlay'
  const depth = e.state && e.state.sid === SID ? e.state.ov || 0 : 0;
  while (stack.length > depth) {
    const { el, onClose } = stack.pop();
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  syncCamera();
});

const closeAllOverlays = () => { if (stack.length) history.go(-stack.length); };
const closeThen = (handle, fn) => { handle.close(); setTimeout(fn, 320); };

function syncCamera() {
  if (!camera) return;
  if (tab === 'camera' && stack.length === 0 && document.visibilityState === 'visible') camera.start();
  else camera.stop();
}
document.addEventListener('visibilitychange', syncCamera);

/* keep the layout above the on-screen keyboard (iOS + Android) */
function viewportVars() {
  const vv = window.visualViewport;
  const set = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv ? vv.height : innerHeight)}px`);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  };
  set();
  (vv || window).addEventListener('resize', set);
  if (vv) vv.addEventListener('scroll', set);
}

/* ═══════════ people & conversations ═══════════ */
const nameOf = u => u.display_name || u.username;

function person(id) {
  if (id === me.id) return me;
  const f = data.friends.find(x => x.id === id);
  if (f) return f;
  for (const g of data.groups) {
    const u = g.members.find(x => x.id === id);
    if (u) return u;
  }
  return { id, username: '?', display_name: 'Someone' };
}

/** key: 'u:<friendId>' or 'g:<groupId>' */
function convoOf(key) {
  if (key.startsWith('g:')) {
    const g = data.groups.find(x => 'g:' + x.id === key);
    return g && {
      key, type: 'group', id: g.id, name: g.name, sub: `${g.members.length} members`, group: g,
      avatarUser: { username: g.name, display_name: g.name },
    };
  }
  const f = data.friends.find(x => 'u:' + x.id === key);
  return f && { key, type: 'dm', id: f.id, name: nameOf(f), sub: '@' + f.username, user: f, avatarUser: f };
}

/* ═══════════ boot ═══════════ */
boot();

async function boot() {
  viewportVars();
  recent.purge();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  app.innerHTML = `<div class="splash">${LOGO}</div>`;
  try {
    be = await createBackend();
    me = await be.init();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="fatal"><h2>Can’t start Blink</h2><p>${esc(e.message || 'Unknown error')}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  me ? showMain() : showAuth();
}

/* ═══════════ auth ═══════════ */
function showAuth(mode = 'signup') {
  const live = be.needsEmail;
  const signup = mode === 'signup';
  app.innerHTML = `
    <div class="auth">
      <div class="auth-top">${LOGO}<h1>Blink</h1><p>Send a snap. They watch it once.</p></div>
      <form class="auth-form" novalidate>
        <div class="seg">
          <button type="button" data-m="signup" class="${signup ? 'on' : ''}">Sign up</button>
          <button type="button" data-m="login" class="${signup ? '' : 'on'}">Log in</button>
        </div>
        ${signup ? `<label>Display name<input name="display" maxlength="30" autocomplete="nickname" placeholder="Alex"></label>` : ''}
        ${live ? `<label>Email<input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" placeholder="you@email.com"></label>` : ''}
        ${signup || !live ? `<label>Username<input name="username" maxlength="20" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="alex_99"></label>` : ''}
        <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters"></label>
        <p class="err" role="alert"></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        ${signup && live ? `<p class="fine">Friends find you by your <b>username</b>.</p>` : ''}
      </form>
      ${!live ? `<p class="demo-note"><b>Demo mode</b> — everything stays in this browser. Three friends are waiting for you. Connect Supabase (see README) to chat with real people.</p>` : ''}
    </div>`;
  const form = $('.auth-form'), errEl = $('.err', form), btn = $('button[type=submit]', form);
  $$('.seg button', form).forEach(b => b.addEventListener('click', () => showAuth(b.dataset.m)));
  const fail = msg => { errEl.textContent = msg; };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    fail('');
    const f = Object.fromEntries(new FormData(form));
    const username = (f.username || '').trim().toLowerCase().replace(/^@/, '');
    const email = (f.email || '').trim();
    if (live && !/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
    if ((signup || !live) && !USERNAME_RE.test(username)) return fail('Username: 3–20 characters — letters, numbers, _ or .');
    if (!f.password || f.password.length < 6) return fail('Password needs at least 6 characters.');
    btn.disabled = true; btn.textContent = 'One sec…';
    try {
      me = signup
        ? await be.signUp({ username, displayName: (f.display || '').trim(), email, password: f.password })
        : await be.signIn({ username, email, password: f.password });
      showMain();
    } catch (ex) {
      fail(ex.message || 'Something went wrong.');
      btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Log in';
    }
  });
}

/* ═══════════ main shell ═══════════ */
function showMain() {
  tab = 'camera'; loaded = false; replyTo = null;
  app.innerHTML = `
    <div class="main" data-tab="camera">
      <section class="pane pane-chats"></section>
      <section class="pane pane-camera"></section>
      <section class="pane pane-friends"></section>
      <nav class="nav">
        <button data-tab="chats">${I.chat}<span>Chats</span><i class="badge" hidden></i></button>
        <button data-tab="camera" class="on">${I.camera}<span>Camera</span></button>
        <button data-tab="friends">${I.friends}<span>Friends</span><i class="badge" hidden></i></button>
      </nav>
    </div>`;
  main = $('.main');
  camera = createCamera($('.pane-camera'), {
    onCapture: showPreview,
    onFile: (f, roll) => handleFile(f, null, !!roll),
    onClearReply: () => { replyTo = null; camera.setReply(null); },
  });
  $('.nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  main.addEventListener('click', onMainClick);
  main.addEventListener('submit', onMainSubmit);
  initSwipe($('.pane-chats'));
  unsub = be.onChange(debounce(refresh, 150));
  poll = setInterval(refresh, be.mode === 'live' ? 10000 : 60000);   // safety net if realtime drops (also drops expired messages)
  if (be.purgeExpired) { be.purgeExpired(); purgeTimer = setInterval(() => be.purgeExpired(), 30 * 60e3); }
  setTab('camera');
  refresh();
}

function setTab(t) {
  tab = t;
  if (!main) return;
  main.dataset.tab = t;
  $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  syncCamera();
}

async function logout() {
  closeAllOverlays();
  if (unsub) unsub();
  clearInterval(poll); clearInterval(purgeTimer);
  if (camera) camera.stop();
  await be.signOut();
  recent.clear();
  me = null; main = null; camera = null; chat = null; replyTo = null;
  data = emptyData();
  document.title = 'Blink';
  showAuth('login');
}

/* ═══════════ data refresh ═══════════ */
async function refresh() {
  if (!me) return;
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const next = await be.loadAll();
    const prev = data;
    data = next;
    notifyNew(prev, next);
    loaded = true;
    renderChats(); renderFriends(); renderBadges();
    if (chat) await refreshChat();
  } catch (e) {
    console.warn('refresh failed', e);
  } finally {
    refreshing = false;
    if (again) { again = false; refresh(); }
  }
}

const unreadTotal = d => Object.values(d.convos).reduce((a, c) => a + c.unread, 0);

function notifyNew(prev, next) {
  if (!loaded) return;
  if (unreadTotal(next) > unreadTotal(prev)) {
    const key = Object.keys(next.convos).find(k => next.convos[k].unread > ((prev.convos[k] && prev.convos[k].unread) || 0));
    if (key && !(chat && chat.convo.key === key)) {
      const cv = convoOf(key);
      const kind = next.convos[key].last.kind;
      toast(`${isTextLike(kind) ? 'New message' : 'New snap'} from ${cv ? cv.name : 'a friend'}`);
      haptic([20, 40, 20]);
    }
  }
  if (next.incoming.length > prev.incoming.length) { toast('You have a new friend request'); haptic(20); }
}

function renderBadges() {
  const n = unreadTotal(data), r = data.incoming.length;
  const set = (t, v) => {
    const b = $(`.nav button[data-tab=${t}] .badge`);
    if (!b) return;
    b.hidden = !v; b.textContent = v > 9 ? '9+' : v;
  };
  set('chats', n); set('friends', r);
  document.title = n ? `(${n}) Blink` : 'Blink';
}

/* ═══════════ chats tab ═══════════ */
const snapChip = (kind, hollow) => `<span class="chip ${kind}${hollow ? ' hollow' : ''}"></span>`;

function lastLine(last, cv) {
  if (!last) return '<span class="muted">Tap to start chatting</span>';
  const mine = last.sender === me.id;
  const who = cv.type === 'group' && !mine ? `${esc(nameOf(person(last.sender)).split(' ')[0])}: ` : '';
  if (last.kind === 'text') return `${mine ? 'You: ' : who}${esc(truncate(last.body, 38))}`;
  if (last.kind === 'voice') return `${mine ? 'You: ' : who}🎤 Voice message`;
  if (last.kind === 'sticker') return `${mine ? 'You: ' : who}${esc(last.body)} Sticker`;
  if (last.kind === 'poll') return `${mine ? 'You: ' : who}📊 ${esc(truncate(last.body, 32))}`;
  const label = last.kind === 'image' ? 'Photo' : 'Video';
  if (last.saved_at) return `${snapChip(last.kind, true)}Saved · ${label}`;
  if (mine) return `${snapChip(last.kind, true)}${last.opened_at ? 'Opened' : 'Delivered'} · ${label}`;
  return last.opened_at
    ? `${snapChip(last.kind, true)}${who}Opened · ${label}`
    : `${snapChip(last.kind, false)}<b>${who}New ${label} Snap</b>`;
}

function chatRows() {
  const rows = [
    ...data.friends.map(f => convoOf('u:' + f.id)),
    ...data.groups.map(g => convoOf('g:' + g.id)),
  ];
  const ts = r => { const c = data.convos[r.key]; return c && c.last ? Date.parse(c.last.created_at) : 0; };
  return rows.sort((a, b) => ts(b) - ts(a) || a.name.localeCompare(b.name));
}

function renderChats() {
  const pane = $('.pane-chats');
  if (!pane) return;
  const rows = chatRows();
  pane.innerHTML = `
    <header class="bar"><div class="bar-left"><button class="icon-btn" data-act="account" aria-label="Your account">${avatar(me, 38)}</button><h2>Chats</h2></div>
      <div class="bar-actions">
        <button class="icon-btn" data-act="new-group" aria-label="New group">${I.groupPlus}</button>
        <button class="icon-btn" data-act="goto-friends" aria-label="Add friends">${I.plus}</button>
      </div></header>
    <div class="scroll">${storiesStrip()}${rows.length ? rows.map(r => {
    const c = data.convos[r.key];
    const hasSnap = c && c.snaps && c.snaps.length;
    return `
      <div class="swipe"><div class="swipe-bg">${I.chat}<span>Chat</span></div>
        <button class="item ${c && c.unread ? 'unread' : ''}" data-conv="${r.key}" aria-label="${esc(r.name)}${hasSnap ? ', new snap' : ''}">
          ${r.type === 'dm' && storiesOf(r.id).length
    ? `<span class="ringwrap ${hasUnseen(r.id) ? 'new' : 'seen'}" role="button" data-story="${esc(r.id)}" aria-label="Watch ${esc(r.name)}’s story">${avatar(r.avatarUser, 44)}</span>`
    : avatar(r.avatarUser, 50)}
          <span class="item-main"><b>${esc(r.name)}${r.type === 'dm' && isBest(r.id) ? ' <i class="bf">★</i>' : ''}</b><small>${lastLine(hasSnap ? c.snaps[c.snaps.length - 1] : c && c.last, r)}</small></span>
          <span class="item-side">${c && c.last ? fmtTime(c.last.created_at) : ''}${c && c.unread ? '<i class="dot"></i>' : ''}</span>
        </button></div>`;
  }).join('') : `
      <div class="empty"><div class="empty-ic">${I.friends}</div>
        <h3>No chats yet</h3><p>Add someone by their username to start sending snaps.</p>
        <button class="btn primary" data-act="goto-friends">Add a friend</button></div>`}
    </div>`;
}

/* ═══════════ stories ═══════════ */
const storiesOf = id => data.stories.filter(s => s.user_id === id);
const hasUnseen = id => storiesOf(id).some(s => !s.seen);

/** Friends with a story: ones you haven't watched first, then newest first. */
function storyUsers() {
  const ids = [...new Set(data.stories.filter(s => s.user_id !== me.id).map(s => s.user_id))];
  const last = id => Math.max(...storiesOf(id).map(s => Date.parse(s.created_at)));
  return ids.sort((a, b) => (hasUnseen(b) - hasUnseen(a)) || last(b) - last(a));
}

function storiesStrip() {
  const mine = storiesOf(me.id);
  const cls = mine.length ? 'seen' : 'none';
  const others = storyUsers();
  return `<div class="stories" aria-label="Stories">
    <div class="sb"><span class="ringwrap ${cls}" role="button" data-story="${esc(me.id)}" aria-label="My story">${avatar(me, 54)}</span>
      <span class="plus" role="button" data-act="story-add" aria-label="Add to my story">+</span><small>My Story</small></div>
    ${others.map(id => { const u = person(id); return `<div class="sb"><span class="ringwrap ${hasUnseen(id) ? 'new' : 'seen'}" role="button" data-story="${esc(id)}" aria-label="${esc(nameOf(u))}’s story">${avatar(u, 54)}</span><small>${esc(nameOf(u).split(' ')[0])}</small></div>`; }).join('')}
  </div>`;
}

async function openStories(startId) {
  if (viewing) return;
  if (!storiesOf(startId).length) { if (startId === me.id) { setTab('camera'); toast('Take a snap, then choose “My Story”'); } return; }
  viewing = true;
  const firstUnseen = id => Math.max(0, storiesOf(id).findIndex(s => !s.seen));
  const order = startId === me.id ? [me.id] : [startId, ...storyUsers().filter(id => id !== startId && hasUnseen(id))];
  let ui = 0, si = firstUnseen(order[0]), timer = null, vid = null, closed = false, paused = false, token = 0;
  let t0 = 0, spent = 0, total = 5000, segEl = null;
  const urls = new Map();
  const el = document.createElement('div');
  el.className = 'overlay viewer story';
  el.innerHTML = '<div class="v-load"><span class="spinner"></span></div>';
  const onHide = () => { if (document.visibilityState === 'hidden') h.close(); };
  document.addEventListener('visibilitychange', onHide);
  const h = openOverlay(el, () => {
    closed = true; clearTimeout(timer); if (vid) vid.pause();
    for (const u of urls.values()) URL.revokeObjectURL(u);
    document.removeEventListener('visibilitychange', onHide);
    viewing = false; refresh();
  });

  const pause = () => {
    if (paused) return;
    paused = true; clearTimeout(timer); spent += Date.now() - t0;
    if (segEl) segEl.style.animationPlayState = 'paused';
    if (vid) vid.pause();
  };
  const resume = () => {
    if (!paused) return;
    paused = false; t0 = Date.now();
    if (segEl) segEl.style.animationPlayState = 'running';
    if (vid) vid.play().catch(() => {});
    else timer = setTimeout(next, Math.max(300, total - spent));
  };
  function next() {
    const items = storiesOf(order[ui]);
    if (si + 1 < items.length) si++;
    else { ui++; si = ui < order.length ? firstUnseen(order[ui]) : 0; }
    if (ui >= order.length) { h.close(); return; }
    show();
  }
  function prev() {
    if (si > 0) si--;
    else if (ui > 0) { ui--; si = 0; }
    show();
  }

  async function show() {
    const my = ++token;
    clearTimeout(timer); if (vid) { vid.pause(); vid = null; }
    paused = false; spent = 0;
    const uid_ = order[ui], items = storiesOf(uid_);
    if (!items.length) { if (ui + 1 < order.length) { ui++; si = firstUnseen(order[ui]); return show(); } h.close(); return; }
    si = clamp(si, 0, items.length - 1);
    const s = items[si], user = person(uid_), own = uid_ === me.id;
    let url = urls.get(s.id);
    if (!url) {
      try { url = URL.createObjectURL(await be.fetchStory(s)); urls.set(s.id, url); }
      catch (e) { if (closed || my !== token) return; toast(e.message || 'Couldn’t load this story'); next(); return; }
    }
    if (closed || my !== token) return;
    const capY = clamp(Number.isFinite(+s.cap_y) ? +s.cap_y : 0.6, 0, 1);
    el.innerHTML = `
      <div class="stage">
        ${s.kind === 'image' ? `<img class="v-media" src="${url}" alt="" draggable="false"${fxStyle(s)}>` : `<video class="v-media" src="${url}" playsinline autoplay${fxStyle(s)}></video>`}
        ${decorHtml(s.decor)}
        ${s.body ? `<div class="v-cap" style="top:${capY * 100}%"><span>${esc(s.body)}</span></div>` : ''}
      </div>
      ${rollTag(s)}
      <div class="s-zones"><i data-z="prev"></i><i data-z="next"></i></div>
      <div class="v-top">
        <div class="sbars">${items.map((_, i) => `<span class="sseg ${i < si ? 'done' : ''}"><i></i></span>`).join('')}</div>
        <div class="v-head">${avatar(user, 36)}
          <div class="item-main"><b>${esc(own ? 'My Story' : nameOf(user))}</b><small>${fmtTime(s.created_at)}</small></div>
          <button class="icon-btn" data-x aria-label="Close">${I.close}</button></div>
      </div>
      ${own
    ? `<div class="s-own"><button class="s-views" data-views>${I.eye}<span>…</span></button><button class="s-del" data-del aria-label="Delete this story">${I.trash}</button></div>`
    : `<form class="v-reply"><input name="r" placeholder="Reply to ${esc(nameOf(user).split(' ')[0])}…" maxlength="1000" autocomplete="off" enterkeyhint="send"><button aria-label="Send reply">${I.send}</button></form>`}`;
    const media = $('.v-media', el), stage = $('.stage', el);
    const setAr = () => { const w = media.naturalWidth || media.videoWidth, hh = media.naturalHeight || media.videoHeight; if (w && hh) { stage.style.setProperty('--ar', (w / hh).toFixed(4)); placeRoll(el); } };
    media.addEventListener('load', setAr); media.addEventListener('loadedmetadata', setAr);
    placeRoll(el);
    segEl = $$(".sseg i", el)[si];
    t0 = Date.now();
    if (s.kind === 'image') {
      total = Math.max(1, Math.min(30, s.duration || 5)) * 1000;
      segEl.style.animation = `v-fill ${total / 1000}s linear forwards`;
      timer = setTimeout(next, total);
    } else {
      vid = media; total = 31000;
      vid.onended = next;
      vid.ontimeupdate = () => { const d = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 5; segEl.style.width = `${Math.min(100, (vid.currentTime / d) * 100)}%`; };
      timer = setTimeout(next, total);
      vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); });
    }
    if (!own && !s.seen) { s.seen = true; be.viewStory(s.id); }

    $('[data-x]', el).addEventListener('click', () => h.close());
    $$('.s-zones i', el).forEach(z => z.addEventListener('click', () => (z.dataset.z === 'next' ? next() : prev())));
    if (own) {
      be.storyViewers(s.id).then(list => { if (my === token && !closed) $('.s-views span', el).textContent = `${list.length} view${list.length === 1 ? '' : 's'}`; })
        .catch(() => { if (my === token && !closed) $('.s-views span', el).textContent = 'Views'; });
      $('[data-views]', el).addEventListener('click', () => openViewers(s, pause, resume));
      $('[data-del]', el).addEventListener('click', async () => {
        if (!confirm('Delete this story?')) return;
        try {
          await be.deleteStory(s);
          data.stories = data.stories.filter(x => x.id !== s.id);
          toast('Story deleted');
          show();
        } catch (e) { toast(e.message || 'Couldn’t delete'); }
      });
    } else {
      const f = $('.v-reply', el), inp = $('input', f);
      inp.addEventListener('focus', pause); inp.addEventListener('blur', resume);
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const body = inp.value.trim();
        if (!body) return;
        inp.disabled = true;
        try { await be.sendText('u:' + uid_, body, { id: null, preview: s.kind === 'image' ? '📷 Story' : '🎥 Story' }); toast('Reply sent'); haptic(12); inp.value = ''; }
        catch (x) { toast(x.message || 'Couldn’t send'); }
        inp.disabled = false; inp.blur();
      });
    }
  }
  show();
}

/** Who watched my story (sheet). */
async function openViewers(story, pause, resume) {
  pause();
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `<div class="sheet" role="dialog" aria-label="Story views"><div class="grab"></div><h3>Seen by</h3>
    <div class="sheet-list"><p class="muted pad-s">Loading…</p></div></div>`;
  const h = openOverlay(el, resume);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  try {
    const list = await be.storyViewers(story.id);
    $('.sheet-list', el).innerHTML = list.length ? list.map(u => `
      <div class="item static">${avatar(u, 42)}<span class="item-main"><b>${esc(nameOf(u))}</b><small>@${esc(u.username)} · ${fmtTime(u.viewed_at, true)}</small></span></div>`).join('')
      : '<p class="muted pad-s">Nobody has watched this story yet.</p>';
  } catch (e) { $('.sheet-list', el).innerHTML = `<p class="err">${esc(e.message || 'Couldn’t load')}</p>`; }
}

/** Tap a row: new snaps open right away (all of them, one after another); otherwise open the chat. */
function tapConvo(key) {
  const c = data.convos[key];
  if (c && c.snaps && c.snaps.length) openViewer(c.snaps[0], c.snaps.slice(1));
  else openChat(key);
}

/** Swipe a row to the right → open the chat *without* opening the snap. */
function initSwipe(pane) {
  let s = null;
  pane.addEventListener('pointerdown', e => {
    const item = e.target.closest('.swipe .item');
    if (!item || (e.pointerType === 'mouse' && e.button !== 0)) return;
    s = { item, wrap: item.parentElement, key: item.dataset.conv, x0: e.clientX, y0: e.clientY, dx: 0, drag: false, id: e.pointerId };
  });
  pane.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.drag) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.drag = true;
        s.item.classList.add('dragging'); s.wrap.classList.add('pulling');
        try { pane.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    s.dx = Math.max(0, dx);
    s.item.style.transform = `translateX(${s.dx}px)`;
    s.wrap.classList.toggle('armed', s.dx > 90);
  });
  const end = e => {
    if (!s) return;
    const st = s; s = null;
    if (!st.drag) return;
    swiped = true; setTimeout(() => { swiped = false; }, 350);
    st.item.classList.remove('dragging'); st.wrap.classList.remove('pulling', 'armed');
    st.item.style.transform = '';
    if (st.dx > 90 && e.type === 'pointerup') { haptic(10); openChat(st.key); }
  };
  pane.addEventListener('pointerup', end);
  pane.addEventListener('pointercancel', end);
}

/* ═══════════ friends tab ═══════════ */
function renderFriends() {
  const pane = $('.pane-friends');
  if (!pane) return;
  const prevInput = $('input[name=u]', pane);
  const keep = prevInput ? { v: prevInput.value, focus: document.activeElement === prevInput } : null;
  const person_ = (u, actions) => `
    <div class="item static">${avatar(u, 46)}
      <span class="item-main"><b>${esc(u.display_name || u.username)}${isBest(u.id) ? ' <i class="bf">★</i>' : ''}</b><small>@${esc(u.username)}</small></span>
      <span class="item-actions">${actions}</span></div>`;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  pane.innerHTML = `
    <header class="bar"><h2>Friends</h2></header>
    <div class="scroll pad">
      <div class="me-card">${avatar(me, 58)}
        <div class="item-main"><b>${esc(nameOf(me))}</b><small>@${esc(me.username)}</small></div>
        <button class="btn small" data-act="account">${I.user}Account</button>
        <button class="btn small" data-act="share">${I.share}Share</button></div>
      <form class="add" data-form="add">
        <span class="at">@</span>
        <input name="u" placeholder="Add friend by username" maxlength="21" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="go">
        <button class="btn primary small">Add</button></form>
      <p class="err" id="add-msg"></p>
      ${data.incoming.length ? `<h4>Requests</h4>${data.incoming.map(u => person_(u,
    `<button class="btn primary small" data-accept="${u.friendshipId}">Accept</button><button class="btn small" data-decline="${u.friendshipId}">Ignore</button>`)).join('')}` : ''}
      ${data.outgoing.length ? `<h4>Sent</h4>${data.outgoing.map(u => person_(u,
    `<span class="muted">Pending</span><button class="btn small" data-decline="${u.friendshipId}">Cancel</button>`)).join('')}` : ''}
      <h4>Groups · ${data.groups.length}</h4>
      <button class="btn wide new-group" data-act="new-group">${I.groupPlus}New group</button>
      ${data.groups.map(g => `
        <div class="item static">${avatar({ username: g.name, display_name: g.name }, 46)}
          <span class="item-main"><b>${esc(g.name)}</b><small>${g.members.length} members</small></span>
          <span class="item-actions"><button class="btn small" data-chat="g:${g.id}">Chat</button></span></div>`).join('')}
      <h4>My friends · ${data.friends.length}</h4>
      ${data.friends.length ? [...data.friends].sort((a, b) => isBest(b.id) - isBest(a.id)).map(u => person_(u,
    `<button class="icon-btn small star ${isBest(u.id) ? 'on' : ''}" data-best="${u.id}" aria-pressed="${isBest(u.id)}" aria-label="${isBest(u.id) ? 'Remove from' : 'Add to'} best friends">${isBest(u.id) ? I.starOn : I.star}</button><button class="btn small" data-chat="u:${u.id}">Chat</button><button class="icon-btn small" data-block="${u.id}" data-name="${esc(u.username)}" aria-label="Block @${esc(u.username)}">${I.block}</button><button class="icon-btn small" data-remove="${u.friendshipId}" data-name="${esc(u.username)}" aria-label="Remove @${esc(u.username)}">${I.close}</button>`)).join('')
    : '<p class="muted pad-s">No friends yet — type a username above.</p>'}
      <button class="btn ghost wide" data-act="logout">Log out</button>
      ${!standalone ? `<p class="fine">Tip: use your browser’s <b>Add to Home Screen</b> to open Blink like a real app.</p>` : ''}
    </div>`;
  if (keep) {
    const inp = $('input[name=u]', pane);
    inp.value = keep.v;
    if (keep.focus) inp.focus();
  }
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); refresh(); }
  catch (e) { toast(e.message || 'Something went wrong'); }
}

function onMainClick(e) {
  const t = e.target.closest('[data-story],[data-conv],[data-best],[data-chat],[data-act],[data-accept],[data-decline],[data-remove],[data-block]');
  if (!t) return;
  const d = t.dataset;
  if (d.story) { if (swiped) return; return openStories(d.story); }
  if (d.best) return act(() => be.setBestFriend(d.best, !isBest(d.best)), isBest(d.best) ? 'Removed from best friends' : 'Added to best friends ★');
  if (d.conv) { if (swiped) return; return tapConvo(d.conv); }
  if (d.chat) return openChat(d.chat);
  if (d.accept) return act(() => be.respond(d.accept, true), 'Friend added');
  if (d.decline) return act(() => be.respond(d.decline, false));
  if (d.block) { if (confirm(`Block @${d.name}? They’ll be removed from your friends and you won’t see what they send.`)) act(() => be.blockUser(d.block), `Blocked @${d.name}`); return; }
  if (d.remove) { if (confirm(`Remove @${d.name} from your friends?`)) act(() => be.removeFriend(d.remove)); return; }
  if (d.act === 'goto-friends') setTab('friends');
  else if (d.act === 'new-group') openNewGroup();
  else if (d.act === 'share') share();
  else if (d.act === 'account') openAccountScreen();
  else if (d.act === 'story-add') { setTab('camera'); toast('Take a snap, then choose “My Story”'); }
  else if (d.act === 'logout') logout();
}

async function onMainSubmit(e) {
  if (!e.target.matches('[data-form=add]')) return;
  e.preventDefault();
  const input = $('input[name=u]', e.target), msg = $('#add-msg');
  const name = input.value.trim();
  if (!name) return;
  msg.textContent = '';
  try {
    const res = await be.addFriend(name);
    input.value = '';
    toast(res);
    refresh();
  } catch (ex) { msg.textContent = ex.message; }
}

function openAccountScreen() {
  openAccount({
    be, getMe: () => me, openOverlay,
    setMe: u => { me = u; renderChats(); renderFriends(); },
    toast, refresh, logout,
  });
}

async function share() {
  const text = `Add me on Blink — my username is @${me.username}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Blink', text, url: location.href.split('#')[0] }); return; }
    await navigator.clipboard.writeText(`${text} ${location.href.split('#')[0]}`);
    toast('Copied to clipboard');
  } catch { /* cancelled */ }
}

/* ═══════════ pick lists (used by "Send to" and "New group") ═══════════ */
const pickRow = (value, u, sub, checked = false) => `
  <label class="pick"><input type="checkbox" value="${esc(value)}" ${checked ? 'checked' : ''}>
    <span class="check">${I.check}</span>${avatar(u, 42)}
    <span class="item-main"><b>${esc(nameOf(u))}</b><small>${esc(sub)}</small></span></label>`;

/* ═══════════ new group ═══════════ */
function openNewGroup() {
  if (data.friends.length < 2) { toast('Add at least 2 friends first, then you can make a group.'); return; }
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="New group">
      <div class="grab"></div><h3>New group</h3>
      <input class="g-name" maxlength="40" placeholder="Group name" autocomplete="off" enterkeyhint="done">
      <p class="fine left">Pick 2–${MAX_GROUP_FRIENDS} friends.</p>
      <div class="sheet-list">${data.friends.map(f => pickRow('u:' + f.id, f, '@' + f.username)).join('')}</div>
      <p class="err"></p>
      <button class="btn primary wide" data-go disabled>Create group</button>
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  const nameIn = $('.g-name', el), go = $('[data-go]', el), err = $('.err', el);
  const chosen = () => $$('input:checked', el).map(i => i.value.slice(2));
  const update = () => {
    const n = chosen().length;
    go.disabled = !nameIn.value.trim() || n < 2 || n > MAX_GROUP_FRIENDS;
    err.textContent = n > MAX_GROUP_FRIENDS ? `A group can have up to ${MAX_GROUP_FRIENDS + 1} people.` : '';
  };
  nameIn.addEventListener('input', update);
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') nameIn.blur(); });
  $$('input[type=checkbox]', el).forEach(i => i.addEventListener('change', update));
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Creating…'; err.textContent = '';
    try {
      const gid = await be.createGroup(nameIn.value.trim(), chosen());
      await refresh();
      closeThen(h, () => { setTab('chats'); openChat('g:' + gid); });
    } catch (e) {
      err.textContent = e.message || 'Couldn’t create the group.';
      go.textContent = 'Create group'; update();
    }
  });
}

function openGroupInfo(g) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Group info">
      <div class="grab"></div><h3>${esc(g.name)}</h3>
      <p class="fine left">${g.members.length} members</p>
      <div class="sheet-list">${g.members.map(u => `
        <div class="item static">${avatar(u, 42)}
          <span class="item-main"><b>${esc(nameOf(u))}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</b><small>@${esc(u.username)}</small></span></div>`).join('')}
      </div>
      <button class="btn danger wide" data-leave>Leave group</button>
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  $('[data-leave]', el).addEventListener('click', async () => {
    if (!confirm(`Leave “${g.name}”? You won’t get its messages anymore.`)) return;
    try {
      await be.leaveGroup(g.id);
      closeAllOverlays();
      toast('You left the group');
      refresh();
    } catch (e) { toast(e.message || 'Couldn’t leave the group'); }
  });
}

/* ═══════════ a friend's profile (from the chat) ═══════════ */
async function openProfile(convo) {
  const u = convo.user;
  if (!u) return;
  const el = document.createElement('div');
  el.className = 'overlay chat profile';
  const story = storiesOf(u.id).length;
  el.innerHTML = `
    <header class="chat-bar"><button class="icon-btn" data-x aria-label="Back">${I.back}</button><div class="item-main"><b>Profile</b></div></header>
    <div class="acct">
      <div class="prof-head">
        ${story ? `<span class="ringwrap big ${hasUnseen(u.id) ? 'new' : 'seen'}" role="button" data-story="${esc(u.id)}" aria-label="Watch story">${avatar(u, 92)}</span>` : avatar(u, 100)}
        <b>${esc(nameOf(u))}</b><span class="muted">@${esc(u.username)}</span>
        <div class="prof-actions">
          ${story ? `<button class="btn small primary" data-story="${esc(u.id)}">${I.camera2}Watch story</button>` : '<span class="muted">No story right now</span>'}
          <button class="btn small" data-pbest>${isBest(u.id) ? I.starOn : I.star}<span>${isBest(u.id) ? 'Best friend' : 'Add to best friends'}</span></button>
          <button class="btn small danger" data-pblock>${I.block}Block</button>
        </div>
      </div>
      <section class="card"><h4>Saved snaps</h4><div data-snaps class="saved-list"><p class="muted">Loading…</p></div></section>
      <section class="card"><h4>Saved messages</h4><div data-msgs class="saved-list"><p class="muted">Loading…</p></div></section>
    </div>`;
  const h = openOverlay(el);
  $('[data-x]', el).addEventListener('click', () => h.close());
  el.addEventListener('click', e => {
    const st = e.target.closest('[data-story]');
    if (st) { openStories(st.dataset.story); return; }
    const op = e.target.closest('[data-open]');
    if (op && el._msgs) { const m = el._msgs.find(x => x.id === op.dataset.open); if (m) openViewer(m); }
  });
  $('[data-pbest]', el).addEventListener('click', async ev => {
    const btn = ev.currentTarget, on = !isBest(u.id);
    try {
      await be.setBestFriend(u.id, on);
      if (on) data.bestFriends.push(u.id); else data.bestFriends = data.bestFriends.filter(x => x !== u.id);
      btn.innerHTML = `${on ? I.starOn : I.star}<span>${on ? 'Best friend' : 'Add to best friends'}</span>`;
      toast(on ? 'Added to best friends ★' : 'Removed from best friends');
      refresh();
    } catch (e) { toast(e.message || 'Couldn’t change that'); }
  });
  $('[data-pblock]', el).addEventListener('click', async () => {
    if (!confirm(`Block @${u.username}? They’ll be removed from your friends and you won’t see what they send.`)) return;
    try { await be.blockUser(u.id); toast(`Blocked @${u.username}`); closeAllOverlays(); refresh(); }
    catch (e) { toast(e.message || 'Couldn’t block'); }
  });
  try {
    const msgs = (await be.getMessages(convo.key)).filter(m => m.saved_at);
    el._msgs = msgs;
    const first = x => (x.sender === me.id ? 'you' : nameOf(person(x.sender)).split(' ')[0]);
    const snaps = msgs.filter(isSnap).reverse();
    $('[data-snaps]', el).innerHTML = snaps.length ? snaps.map(m => `
      <button class="snap-btn" data-open="${esc(m.id)}"><span class="snap ${m.kind} saved"><span class="snap-ic"></span><span>${m.kind === 'image' ? 'Photo' : 'Video'}</span><small>${fmtTime(m.saved_at, true)} · sent by ${esc(first(m))}</small></span></button>`).join('')
      : '<p class="muted">Nothing yet. After you watch a snap, tap <b>Save in chat</b> (or long-press it in the chat within 5 minutes).</p>';
    const texts = msgs.filter(m => isTextLike(m.kind)).reverse();
    $('[data-msgs]', el).innerHTML = texts.length ? texts.map(m => `
      <div class="saved-msg"><small>${esc(first(m))} · ${fmtTime(m.created_at, true)}</small><div>${m.kind === 'voice' ? `🎤 Voice message (${fmtDur(m.duration || 1)})` : esc(m.body)}</div></div>`).join('')
      : '<p class="muted">Nothing yet. Tap a message in the chat to save it.</p>';
  } catch (e) {
    $('[data-snaps]', el).innerHTML = `<p class="err">${esc(e.message || 'Couldn’t load')}</p>`;
    $('[data-msgs]', el).innerHTML = '';
  }
}

/* ═══════════ chat thread ═══════════ */
/** Group messages you sent are stored once per member; show them as one bubble. */
function collapse(msgs) {
  const out = [], seen = new Map();
  for (const m of msgs) {
    if (m.group_id && m.sender === me.id) {
      const head = seen.get(m.batch_id);
      if (head) {
        head.rows.push(m);
        if (isTextLike(m.kind) && m.saved_at && !head.saved_at) { head.saved_at = m.saved_at; head.saved_by = m.saved_by; }
        continue;
      }
      const h = { ...m, rows: [m], saved_at: isTextLike(m.kind) ? m.saved_at : null };
      seen.set(m.batch_id, h); out.push(h);
    } else out.push(m);
  }
  return out;
}

async function openChat(key) {
  const convo = convoOf(key);
  if (!convo || chat) return;
  const el = document.createElement('div');
  el.className = 'overlay chat';
  el.innerHTML = `
    <header class="chat-bar">
      <button class="icon-btn" data-x aria-label="Back">${I.back}</button>
      <button class="who-btn" data-prof aria-label="Open profile">${storiesOf(convo.id).length && convo.type === 'dm' ? `<span class="ringwrap ${hasUnseen(convo.id) ? 'new' : 'seen'}">${avatar(convo.avatarUser, 34)}</span>` : avatar(convo.avatarUser, 40)}
        <span class="item-main"><b>${esc(convo.name)}</b><small>${esc(convo.sub)}</small></span></button>
      ${convo.type === 'group' ? `<button class="icon-btn" data-info aria-label="Group info">${I.more}</button>` : ''}
    </header>
    <div class="thread" role="log" aria-live="polite"><div class="tl"></div></div>
    <div class="reply-bar" hidden><div class="rb-main"><b></b><small></small></div><button type="button" class="icon-btn" data-unreply aria-label="Cancel reply">${I.close}</button></div>
    <form class="composer">
      <button type="button" class="icon-btn" data-cam aria-label="Send a snap">${I.camera}</button>
      <button type="button" class="icon-btn" data-more aria-label="More: photo, poll, background">${I.plus}</button>
      <input name="t" placeholder="Send a chat" maxlength="1000" autocomplete="off" enterkeyhint="send">
      <button type="button" class="icon-btn" data-sticker aria-label="Stickers">${I.smile}</button>
      <button type="button" class="icon-btn mic" data-mic aria-label="Hold to record a voice message">${I.mic}</button>
      <button class="send" aria-label="Send">${I.send}</button>
      <input type="file" accept="image/*,video/*" hidden>
    </form>`;
  chat = { convo, el, messages: [], first: true, handle: null, reply: null, reacts: {}, polls: {} };
  const c = chat;
  c.handle = openOverlay(el, () => {
    if (vrec && vrec.ctl) vrec.ctl.cancel();
    stopVoice(true); chat = null; refresh();
  });

  $('[data-x]', el).addEventListener('click', () => c.handle.close());
  $('[data-prof]', el).addEventListener('click', () => {
    if (convo.type === 'dm') openProfile(convoOf(key) || convo);
    else { const g = convoOf(key); if (g) openGroupInfo(g.group); }
  });
  const info = $('[data-info]', el);
  if (info) info.addEventListener('click', () => { const g = convoOf(key); if (g) openGroupInfo(g.group); });
  const input = $('input[name=t]', el), file = $('input[type=file]', el);
  $('[data-cam]', el).addEventListener('click', () => {
    replyTo = { key, label: convo.name }; camera.setReply(replyTo); setTab('camera'); c.handle.close();
  });
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) handleFile(f, convo, true); });
  const scrollEnd = () => { const tb = $('.thread', el); tb.scrollTop = tb.scrollHeight; };
  $('[data-sticker]', el).addEventListener('click', () => openStickerTray({
    openOverlay,
    onPick: async e => {
      const reply = c.reply; setReply(null);
      try { await be.sendSticker(key, e, reply); haptic(12); } catch (ex) { toast(ex.message || 'Couldn’t send the sticker'); }
      await refreshChat(); scrollEnd();
    },
  }));
  $('[data-more]', el).addEventListener('click', () => openActionSheet({
    openOverlay, title: 'Add to chat',
    items: [
      { icon: I.image, label: 'Photo or video', sub: 'From your library — it’s labelled “Media”', act: () => file.click() },
      { icon: I.poll, label: 'Poll', sub: 'Ask a question, everyone votes', act: () => openPollMaker({
        openOverlay, toast,
        onSend: async (q, opts) => { await be.sendPoll(key, q, opts); haptic(12); await refreshChat(); scrollEnd(); },
      }) },
      { icon: I.palette, label: 'Chat background', sub: `Same for everyone in ${convo.type === 'group' ? 'the group' : 'this chat'}`, act: () => openBgPicker({
        openOverlay, toast, who: convo.type === 'group' ? 'this group' : 'this chat', current: data.bgs[bgScope(key, me.id)],
        onPreset: async id => { await be.setChatBg(key, { kind: 'preset', value: id }); await refresh(); toast('Background changed for everyone in this chat'); },
        onImage: async f => { await be.setChatBg(key, { kind: 'image', blob: await normalizeImage(f) }); await refresh(); toast('Background changed for everyone in this chat'); },
        onClear: async () => { await be.clearChatBg(key); await refresh(); toast('Back to the normal background'); },
      }) },
    ],
  }));
  $('.composer', el).addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = ''; input.focus(); syncHasText();
    const reply = c.reply; setReply(null);
    const tmp = { id: 'tmp-' + Date.now(), sender: me.id, kind: 'text', body, created_at: new Date().toISOString(), group_id: convo.type === 'group' ? convo.id : null, reply_preview: reply ? reply.preview : null };
    c.messages.push(tmp); renderThread(true);
    try { await be.sendText(key, body, reply); }
    catch (ex) {
      toast(ex.message || 'Couldn’t send');
      c.messages = c.messages.filter(m => m !== tmp); renderThread(); input.value = body;
    }
    refreshChat();
  });
  const composer = $('.composer', el), mic = $('[data-mic]', el);
  const syncHasText = () => composer.classList.toggle('has-text', !!input.value.trim());
  input.addEventListener('input', syncHasText);

  /* hold the mic to record a voice message; slide left to cancel */
  const recBar = document.createElement('div');
  recBar.className = 'rec-bar'; recBar.hidden = true;
  recBar.innerHTML = '<i></i><span>0:00</span><small>◀ Slide to cancel</small>';
  composer.insertBefore(recBar, mic);
  let vrec = null;
  const uiReset = () => {
    if (vrec) clearInterval(vrec.tick);
    composer.classList.remove('recording'); recBar.hidden = true; mic.classList.remove('rec'); recBar.classList.remove('cancel');
    $('small', recBar).textContent = '◀ Slide to cancel';
    vrec = null;
  };
  async function endVoice(send) {
    const st = vrec;
    if (!st || st.ending) return;
    if (!st.ctl) { st.pending = send; return; }          // still waiting for the microphone
    st.ending = true;
    if (!send) { st.ctl.cancel(); uiReset(); return; }
    let res;
    try { res = await st.ctl.stop(); } catch { uiReset(); return; }
    uiReset();
    if (res.secs < 0.7) { toast('Hold the mic to record a voice message'); return; }
    const reply = c.reply; setReply(null);
    try { await be.sendVoice(key, res.blob, res.secs, reply); haptic(12); }
    catch (ex) { toast(ex.message || 'Couldn’t send the voice message'); }
    await refreshChat();
    const tb = $('.thread', el); tb.scrollTop = tb.scrollHeight;
  }
  mic.addEventListener('contextmenu', e => e.preventDefault());
  mic.addEventListener('pointerdown', async e => {
    if (vrec || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try { mic.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const st = { x0: e.clientX, cancel: false, ctl: null, pending: undefined, ending: false, tick: null };
    vrec = st;
    composer.classList.add('recording'); recBar.hidden = false; mic.classList.add('rec');
    try { st.ctl = await startVoice({ maxSeconds: 60, onLimit: () => endVoice(true) }); }
    catch (ex) { uiReset(); toast(ex.message || 'Couldn’t start recording'); return; }
    haptic(12);
    st.tick = setInterval(() => { $('span', recBar).textContent = fmtDur(st.ctl.elapsed()); }, 200);
    if (st.pending !== undefined) endVoice(st.pending);
  });
  mic.addEventListener('pointermove', e => {
    if (!vrec) return;
    vrec.cancel = e.clientX - vrec.x0 < -80;
    recBar.classList.toggle('cancel', vrec.cancel);
    $('small', recBar).textContent = vrec.cancel ? 'Release to cancel' : '◀ Slide to cancel';
  });
  mic.addEventListener('pointerup', () => endVoice(vrec ? !vrec.cancel : false));
  mic.addEventListener('pointercancel', () => endVoice(false));

  const bar = $('.reply-bar', el);
  function setReply(r) {
    c.reply = r;
    bar.hidden = !r;
    if (r) { $('b', bar).textContent = `Replying to ${r.name}`; $('small', bar).textContent = r.preview; input.focus(); }
  }
  c.setReply = setReply;
  $('[data-unreply]', el).addEventListener('click', () => setReply(null));
  $('.thread', el).addEventListener('click', e => {
    if (gestureBlock) return;
    const vt = e.target.closest('[data-vote]');
    if (vt) {
      const [pid, idx] = vt.dataset.vote.split('|');
      be.votePoll(pid, +idx).then(refreshChat).catch(x => toast(x.message || 'Couldn’t vote'));
      return;
    }
    const rc = e.target.closest('[data-react]');
    if (rc) { const [id, emoji] = rc.dataset.react.split('|'); be.react(id, emoji).then(refreshChat).catch(x => toast(x.message)); return; }
    const pv = e.target.closest('[data-voice]');
    if (pv) { const vm = c.messages.find(x => x.id === pv.dataset.voice); if (vm) toggleVoice(vm); return; }
    const t = e.target.closest('[data-open]');
    if (t) {
      const m = c.messages.find(x => x.id === t.dataset.open);
      if (m) openViewer(m);
      return;
    }
    const bub = e.target.closest('.bubble[data-mid]');          // tap a message once → save / unsave it
    if (bub) { const sm = c.messages.find(x => String(x.id) === bub.dataset.mid); if (sm) toggleSave(sm); }
  });
  initThreadGestures($('.thread', el), c);
  await refreshChat();
}

async function refreshChat() {
  const c = chat;
  if (!c) return;
  try {
    const msgs = await be.getMessages(c.convo.key);
    if (chat !== c) return;
    c.messages = c.convo.type === 'group' ? collapse(msgs) : msgs;
    try { c.reacts = await be.getReactions(msgs.map(m => m.id)); } catch { /* keep old */ }
    const pids = [...new Set(msgs.map(m => m.poll_id).filter(Boolean))];
    if (pids.length) { try { c.polls = await be.getPolls(pids); } catch { /* keep old */ } } else c.polls = {};
    if (chat !== c) return;
    renderThread();
    if (msgs.some(m => m.recipient === me.id && isTextLike(m.kind) && !m.read_at)) await be.markRead(c.convo.key);
  } catch (e) { console.warn('chat refresh failed', e); }
}

const isSnap = m => m.kind === 'image' || m.kind === 'video';
const snapLabel = m => (m.kind === 'image' ? '📷 Photo' : '🎥 Video');
const msgPreview = m => (m.kind === 'text' ? truncate(m.body, 80) : m.kind === 'voice' ? '🎤 Voice message' : m.kind === 'sticker' ? `${m.body} Sticker` : m.kind === 'poll' ? `📊 ${truncate(m.body, 70)}` : snapLabel(m));

/** Every reaction on a message (a group message you sent is stored once per member — count them all). */
function reactionsOf(m) {
  return (m.rows || [m]).flatMap(r => (chat.reacts[r.id] || []));
}

/** Reaction chips on the bottom corner of a bubble. Tapping your own one removes it. */
function reactsHtml(m) {
  const ids = (m.rows || [m]).map(r => r.id);
  const all = reactionsOf(m);
  if (!all.length) return '';
  const by = new Map();
  for (const r of all) { const e = by.get(r.emoji) || { n: 0, mine: false }; e.n++; if (r.user_id === me.id) e.mine = true; by.set(r.emoji, e); }
  return `<span class="reacts">${[...by].map(([emoji, v]) => {
    const own = ids.find(id => (chat.reacts[id] || []).some(r => r.user_id === me.id && r.emoji === emoji));
    const tid = own || (m.sender === me.id ? ids[0] : m.id);
    return `<span class="react ${v.mine ? 'mine' : ''}" role="button" data-react="${tid}|${emoji}">${emoji}${v.n > 1 ? `<small>${v.n}</small>` : ''}</span>`;
  }).join('')}</span>`;
}

const canSaveLater = m => isSnap(m) && m.recipient === me.id && !m.saved_at && !!m.opened_at && recent.has(m.id);

function savedTag(m) {
  if (!m.saved_at) return '';
  const who = m.saved_by === me.id ? 'you' : esc(nameOf(person(m.saved_by)).split(' ')[0]);
  return `<div class="saved-tag">Saved by ${who}</div>`;
}

function renderMsg(m, isLastMine, group) {
  const mine = m.sender === me.id;
  const side = mine ? 'me' : 'them';
  const sender = group && !mine ? person(m.sender) : null;
  const who = sender ? `<div class="who" style="--h:${hue(sender.username)}">${esc(nameOf(sender))}</div>` : '';
  const ts = `<time class="ts">${hm(m.created_at)}</time>`;
  const quote = m.reply_preview ? `<div class="quote">↩ ${esc(m.reply_preview)}</div>` : '';
  const mid = `data-mid="${esc(m.id)}"`;
  const reacts = reactsHtml(m);
  const hasr = reacts ? ' hasr' : '';
  if (isTextLike(m.kind)) {
    let meta = '';
    if (mine && isLastMine) {
      const rows = m.rows || [m];
      meta = `<div class="meta">${String(m.id).startsWith('tmp-') ? 'Sending…' : rows.every(r => r.read_at) ? 'Read' : 'Delivered'}</div>`;
    }
    const sv = m.saved_at ? ' saved' : '', bm = m.saved_at ? '<i class="bm"></i>' : '';
    const inner = m.kind === 'sticker'
      ? `<div class="bubble sticker${sv}" ${mid}>${esc(m.body)}${bm}</div>`
      : m.kind === 'poll' ? pollHtml(m, sv, mid, bm)
        : m.kind === 'voice'
      ? `<div class="bubble voice${sv}" ${mid}><button type="button" class="vplay" data-voice="${esc(m.id)}" aria-label="Play voice message">${I.play}</button><span class="vwrap"><span class="vwave"></span><span class="vprog"></span></span><small>${fmtDur(m.duration || 1)}</small>${bm}</div>`
      : `<div class="bubble${sv}" ${mid}>${esc(m.body)}${bm}</div>`;
    return `<div class="row ${side}"><div class="col">${who}${quote}<div class="bw${hasr}">${inner}${reacts}</div>${savedTag(m)}${meta}</div>${ts}</div>`;
  }
  const label = m.kind === 'image' ? 'Photo' : 'Video';
  const ic = '<span class="snap-ic"></span>';
  if (m.saved_at) {
    return `<button class="row ${side} snap-btn" data-open="${m.id}"><span class="col">${who}<span class="bw${hasr}"><span class="snap ${m.kind} saved" ${mid}>${ic}<span>Saved ${label}</span><small>Tap to view</small></span>${reacts}</span></span>${ts}</button>`;
  }
  if (mine) {
    const rows = m.rows || [m];
    const opened = rows.filter(r => r.opened_at).length;
    const status = !opened ? 'Delivered' : opened === rows.length ? 'Opened' : `Opened by ${opened}/${rows.length}`;
    return `<div class="row me"><div class="col"><div class="bw${hasr}"><div class="snap ${m.kind} sent" ${mid}>${ic}<span>${status}</span><small>${label}</small></div>${reacts}</div></div>${ts}</div>`;
  }
  return m.opened_at
    ? `<div class="row them"><span class="col">${who}<span class="bw${hasr}"><span class="snap ${m.kind} done" ${mid}>${ic}<span>Opened</span><small>${canSaveLater(m) ? 'Hold to save' : label}</small></span>${reacts}</span></span>${ts}</div>`
    : `<button class="row them snap-btn" data-open="${m.id}"><span class="col">${who}<span class="bw${hasr}"><span class="snap ${m.kind} new" ${mid}>${ic}<span>New ${label} Snap</span><small>Tap to view</small></span>${reacts}</span></span>${ts}</button>`;
}

/** A poll card: tap an option to vote (tap it again to take the vote back). */
function pollHtml(m, sv, mid, bm) {
  const p = chat.polls[m.poll_id];
  if (!p) return `<div class="bubble poll${sv}" ${mid}><div class="pq">📊 ${esc(m.body)}</div><small class="pn2">Loading…</small>${bm}</div>`;
  const total = p.votes.length, mineV = p.votes.find(v => v.voter === me.id);
  const opts = p.options.map((o, i) => {
    const n = p.votes.filter(v => v.opt === i).length, pct = total ? Math.round((n / total) * 100) : 0;
    return `<button type="button" class="po${mineV && mineV.opt === i ? ' on' : ''}" data-vote="${esc(p.id)}|${i}" style="--p:${pct}%"><span class="pb"></span><span class="pt">${mineV && mineV.opt === i ? '✓ ' : ''}${esc(o)}</span><span class="pn">${n}</span></button>`;
  }).join('');
  return `<div class="bubble poll${sv}" ${mid}><div class="pq">📊 ${esc(p.question)}</div>${opts}<small class="pn2">${total} vote${total === 1 ? '' : 's'} · ${mineV ? 'tap to change' : 'tap to vote'} · hold to see who voted</small>${bm}</div>`;
}

/* ── voice playback (one at a time) ── */
const voiceUrls = new Map();
let vp = null;
function paintVoice() {
  if (!chat) return;
  for (const b of $$('.bubble.voice', chat.el)) {
    const id = b.dataset.mid, on = vp && vp.id === id;
    const btn = $('.vplay', b);
    btn.innerHTML = on && !vp.audio.paused ? I.pause : I.play;
    const total = on && Number.isFinite(vp.audio.duration) && vp.audio.duration > 0 ? vp.audio.duration : (on ? vp.dur : 1);
    b.style.setProperty('--p', on ? String(Math.min(1, vp.audio.currentTime / total)) : '0');
  }
}
function stopVoice(release = false) {
  if (vp) { try { vp.audio.pause(); vp.audio.src = ''; } catch { /* ignore */ } vp = null; }
  if (release) { for (const u of voiceUrls.values()) URL.revokeObjectURL(u); voiceUrls.clear(); }
  paintVoice();
}
async function toggleVoice(m) {
  if (vp && vp.id === m.id) { if (vp.audio.paused) vp.audio.play().catch(() => {}); else vp.audio.pause(); paintVoice(); return; }
  stopVoice();
  let url = voiceUrls.get(m.id);
  try {
    if (!url) { url = URL.createObjectURL(await be.fetchVoice(m)); voiceUrls.set(m.id, url); }
  } catch (e) { toast(e.message || 'Couldn’t load this voice message'); return; }
  const audio = new Audio(url);
  const mine = { id: m.id, audio, dur: m.duration || 1 };
  vp = mine;
  for (const ev of ['timeupdate', 'play', 'pause']) audio.addEventListener(ev, () => { if (vp === mine) paintVoice(); });
  audio.addEventListener('ended', () => { if (vp === mine) stopVoice(); });
  audio.play().then(paintVoice).catch(() => { toast('Couldn’t play this voice message'); if (vp === mine) stopVoice(); });
  paintVoice();
}

/** Tap a text / voice message once to keep it (it then never disappears). Tap again to un-keep. */
async function toggleSave(m) {
  const c = chat;
  if (!c || String(m.id).startsWith('tmp-') || !isTextLike(m.kind)) return;
  const saving = !m.saved_at;
  if (!saving && m.saved_by && m.saved_by !== me.id) { toast(`Only ${nameOf(person(m.saved_by)).split(' ')[0]} can unsave this`); return; }
  const ids = (m.rows || [m]).map(r => r.id);
  const prev = { at: m.saved_at, by: m.saved_by };
  m.saved_at = saving ? new Date().toISOString() : null; m.saved_by = saving ? me.id : null;
  renderThread();
  haptic(10);
  try {
    await be.setSaved(ids, saving);
    toast(saving ? 'Saved — it won’t disappear after 24 h' : 'Unsaved — it disappears 24 h after it was sent');
    refreshChat();
  } catch (e) {
    m.saved_at = prev.at; m.saved_by = prev.by; renderThread();
    toast(e.message || 'Couldn’t save');
  }
}

/* long-press menu: reactions + reply / copy / save in chat */
function openMessageMenu(m, c) {
  if (String(m.id).startsWith('tmp-')) return;
  haptic(18);
  const list = reactionsOf(m);
  const mineEmoji = list.find(r => r.user_id === me.id);
  const canTapSave = isTextLike(m.kind);
  const el = document.createElement('div');
  el.className = 'overlay menu-wrap';
  const save = canSaveLater(m);
  el.innerHTML = `<div class="menu">
    <div class="m-emojis">${EMOJIS.map(e => `<button data-e="${e}" class="${mineEmoji && mineEmoji.emoji === e ? 'mine' : ''}">${e}</button>`).join('')}</div>
    ${m.kind === 'poll' && c.polls[m.poll_id] ? `<div class="m-who"><h5>Votes</h5>${c.polls[m.poll_id].votes.length ? c.polls[m.poll_id].votes.map(v => { const u = person(v.voter); return `<div>${avatar(u, 28)}${esc(v.voter === me.id ? 'You' : nameOf(u))}<span class="vt">${esc(c.polls[m.poll_id].options[v.opt] || '')}</span></div>`; }).join('') : '<div class="muted">No votes yet</div>'}</div>` : ''}
    ${list.length ? `<div class="m-who"><h5>Reactions</h5>${list.map(r => { const u = person(r.user_id); return `<div>${avatar(u, 28)}${esc(r.user_id === me.id ? 'You' : nameOf(u))}<span>${r.emoji}</span></div>`; }).join('')}</div>` : ''}
    <div class="m-actions">
      <button data-a="reply">${I.reply}Reply</button>
      ${m.kind === 'text' ? `<button data-a="copy">${I.copy}Copy</button>` : ''}
      ${canTapSave ? `<button data-a="tsave">${I.bookmark}${m.saved_at ? 'Unsave' : 'Save in chat'}</button>` : ''}
      ${save ? `<button data-a="save">${I.bookmark}Save in chat</button>` : ''}
      ${isSnap(m) && m.recipient === me.id && !m.saved_at && !save && m.opened_at ? `<button disabled style="opacity:.5">${I.bookmark}Too late to save (5 min)</button>` : ''}
    </div></div>`;
  const h = openOverlay(el);
  el.addEventListener('click', async e => {
    const em = e.target.closest('[data-e]'), a = e.target.closest('[data-a]');
    if (!em && !a) { if (e.target === el || e.target.classList.contains('menu')) h.close(); return; }
    h.close();
    try {
      if (em) {
        const own = (m.rows || [m]).find(r => (chat.reacts[r.id] || []).some(x => x.user_id === me.id));
        const target = (own || (m.rows ? m.rows[0] : m)).id;
        await be.react(target, em.dataset.e);
        refreshChat();
      } else if (a.dataset.a === 'reply') {
        c.setReply({ id: m.id, name: m.sender === me.id ? 'yourself' : nameOf(person(m.sender)), preview: msgPreview(m) });
      } else if (a.dataset.a === 'tsave') {
        await toggleSave(m);
      } else if (a.dataset.a === 'copy') {
        try { await navigator.clipboard.writeText(m.body); toast('Copied'); } catch { toast('Couldn’t copy'); }
      } else if (a.dataset.a === 'save') {
        const blob = await recent.get(m.id);
        if (!blob) throw new Error('It’s too late to save this snap.');
        await be.saveSnap(m, blob);
        recent.drop(m.id);
        toast('Saved in chat'); haptic(15);
        refresh();
      }
    } catch (x) { toast(x.message || 'Something went wrong'); }
  });
}

/** Long-press a message → menu. Drag the thread sideways → message times slide into view on the right. */
let gestureBlock = false;
function initThreadGestures(box, c) {
  const tl = $('.tl', box);
  let g = null, lp = null;
  const block = () => { gestureBlock = true; setTimeout(() => { gestureBlock = false; }, 300); };
  box.addEventListener('contextmenu', e => { if (e.target.closest('[data-mid]')) e.preventDefault(); });
  box.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    g = { x0: e.clientX, y0: e.clientY, id: e.pointerId, drag: false };
    const t = e.target.closest('[data-mid]');
    if (t) {
      const m = c.messages.find(x => String(x.id) === t.dataset.mid);
      lp = setTimeout(() => {
        lp = null;
        if (!m || !g || g.drag) return;
        t.classList.add('pressing'); setTimeout(() => t.classList.remove('pressing'), 200);
        block(); g = null;
        openMessageMenu(m, c);
      }, 420);
    }
  });
  box.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (lp && Math.hypot(dx, dy) > 10) { clearTimeout(lp); lp = null; }
    if (!g.drag) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        g.drag = true; tl.classList.add('dragging');
        try { box.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    const shift = Math.min(56, Math.abs(dx) * 0.7);
    tl.style.setProperty('--shift', shift.toFixed(1));
  });
  const end = () => {
    clearTimeout(lp); lp = null;
    if (g && g.drag) { block(); }
    g = null;
    tl.classList.remove('dragging');
    tl.style.setProperty('--shift', '0');
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function renderThread(forceBottom = false) {
  if (!chat) return;
  const box = $('.thread', chat.el), tl = $('.tl', box);
  paintThreadBg(box, data.bgs[bgScope(chat.convo.key, me.id)]);
  const group = chat.convo.type === 'group';
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  let html = '<div class="chat-note">Chats disappear after 24 h · tap a message to save it</div>', prev = 0;
  chat.messages = chat.messages.filter(m => !expired(m));
  const lastMineIdx = chat.messages.map(m => m.sender === me.id).lastIndexOf(true);
  chat.messages.forEach((m, i) => {
    const t = Date.parse(m.created_at);
    if (t - prev > 15 * 60e3) html += `<div class="divider" style="align-self:center">${fmtTime(m.created_at, true)}</div>`;
    prev = t;
    html += renderMsg(m, i === lastMineIdx, group);
  });
  if (!chat.messages.length) {
    html = `<div class="empty small"><p>Say hi to <b>${esc(chat.convo.name)}</b> 👋<br>or send a snap with the camera button.</p></div>`;
  }
  tl.innerHTML = html;
  paintVoice();
  if (atBottom || forceBottom || chat.first) box.scrollTop = box.scrollHeight;
  chat.first = false;
}

/* ═══════════ snap viewer (view once — unless you save it in the chat) ═══════════ */
async function openViewer(m, queue = []) {
  if (viewing) return;
  viewing = true;
  const sender = person(m.sender);
  const saved = !!m.saved_at;
  const canSave = !saved && m.recipient === me.id;
  const el = document.createElement('div');
  el.className = 'overlay viewer';
  el.innerHTML = `<div class="v-load"><span class="spinner"></span></div>`;
  let url = null, timer = null, vid = null, advance = false, closed = false, saving = false;
  const onHide = () => { if (document.visibilityState === 'hidden') h.close(); };
  document.addEventListener('visibilitychange', onHide);
  const h = openOverlay(el, () => {
    closed = true;
    clearTimeout(timer);
    if (vid) vid.pause();
    if (url) URL.revokeObjectURL(url);
    document.removeEventListener('visibilitychange', onHide);
    viewing = false;
    refresh();
    // tapping / finishing continues with the next unopened snap; the X button and Back stop here
    if (advance && queue.length) setTimeout(() => openViewer(queue[0], queue.slice(1)), 260);
  });
  const next = () => { advance = true; h.close(); };
  el.addEventListener('contextmenu', e => e.preventDefault());

  let blob;
  try {
    blob = saved ? await be.fetchSaved(m) : await be.fetchSnap(m);
    if (closed) return;
    if (!saved) {
      await be.discardSnap(m);          // delete the file first (the server only allows it while unopened)...
      await be.openSnap(m.id);          // ...then mark it opened: it can never be opened again
      if (m.recipient === me.id) recent.put(m.id, blob);   // kept on this phone for 5 min so you can still save it
    }
  } catch (e) {
    if (e.gone && !saved) be.openSnap(m.id).catch(() => {});   // file already gone → stop showing it as new
    toast(e.message || 'Couldn’t load this snap');
    next();
    return;
  }
  if (closed) return;
  url = URL.createObjectURL(blob);
  const dur = Math.max(1, Math.min(30, m.duration || 5));
  const capY = clamp(Number.isFinite(+m.cap_y) ? +m.cap_y : 0.6, 0, 1);
  el.innerHTML = `
    <div class="stage">
      ${m.kind === 'image'
    ? `<img class="v-media" src="${url}" alt="" draggable="false"${fxStyle(m)}>`
    : `<video class="v-media" src="${url}" playsinline autoplay${fxStyle(m)}></video>`}
      ${decorHtml(m.decor)}
      ${m.body ? `<div class="v-cap" style="top:${capY * 100}%"><span>${esc(m.body)}</span></div>` : ''}
    </div>
    ${rollTag(m)}
    <div class="v-top">
      <div class="v-bar"><i></i></div>
      <div class="v-head">${avatar(sender, 36)}
        <div class="item-main"><b>${esc(nameOf(sender))}</b><small>${fmtTime(m.created_at)}</small></div>
        <button class="icon-btn" data-x aria-label="Close">${I.close}</button></div>
    </div>
    <button class="v-sound" hidden>${I.sound}Tap for sound</button>
    <form class="v-reply"><input name="r" placeholder="Reply…" maxlength="1000" autocomplete="off" enterkeyhint="send"><button aria-label="Send reply">${I.send}</button></form>
    ${canSave ? `<button class="v-save">${I.bookmark}<span>Save in chat</span></button>`
    : saved ? `<div class="v-saved">${I.bookmark}Saved in chat</div>` : ''}
    <p class="v-hint">${queue.length ? `Tap for the next snap · ${queue.length} more` : 'Tap anywhere to close'}</p>`;
  const bar = $('.v-bar i', el);
  const stageEl = $('.stage', el), media = $('.v-media', el);
  const setAr = () => {
    const w = media.naturalWidth || media.videoWidth, hh = media.naturalHeight || media.videoHeight;
    if (w && hh) { stageEl.style.setProperty('--ar', (w / hh).toFixed(4)); placeRoll(el); }
  };
  media.addEventListener('load', setAr); media.addEventListener('loadedmetadata', setAr);
  // replying: pause the snap while you type, close it after sending
  const rForm = $('.v-reply', el), rIn = $('input', rForm);
  for (const ev of ['click', 'pointerdown']) rForm.addEventListener(ev, e => e.stopPropagation());
  rIn.addEventListener('focus', () => {
    clearTimeout(timer); timer = null;
    $('.v-bar i', el).style.animationPlayState = 'paused';
    if (vid) vid.pause();
  });
  rForm.addEventListener('submit', async e => {
    e.preventDefault();
    const body = rIn.value.trim();
    if (!body) return;
    rIn.disabled = true;
    try {
      await be.sendText(m.group_id ? 'g:' + m.group_id : 'u:' + m.sender, body, { id: m.id, preview: snapLabel(m) });
      toast('Reply sent'); haptic(12);
      h.close();
    } catch (x) { toast(x.message || 'Couldn’t send'); rIn.disabled = false; }
  });
  if (m.kind === 'image') {
    if (saved) $('.v-bar', el).style.visibility = 'hidden';      // saved photos stay until you tap
    else { bar.style.animation = `v-fill ${dur}s linear forwards`; timer = setTimeout(next, dur * 1000); }
  } else {
    vid = $('video', el);
    vid.onended = next;
    vid.ontimeupdate = () => {
      const total = Number.isFinite(vid.duration) ? vid.duration : dur;
      bar.style.width = `${Math.min(100, (vid.currentTime / total) * 100)}%`;
    };
    timer = setTimeout(next, 31000);
    vid.play().catch(() => {
      vid.muted = true; vid.play().catch(() => {});
      const s = $('.v-sound', el); s.hidden = false;
      s.addEventListener('click', ev => { ev.stopPropagation(); vid.muted = false; s.hidden = true; });
    });
  }
  $('[data-x]', el).addEventListener('click', ev => { ev.stopPropagation(); h.close(); });
  const saveBtn = $('.v-save', el);
  if (saveBtn) {
    saveBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (saving) return;
      saving = true;
      saveBtn.disabled = true; $('span', saveBtn).textContent = 'Saving…';
      try {
        await be.saveSnap(m, blob);
        recent.drop(m.id);
        saveBtn.classList.add('done'); $('span', saveBtn).textContent = 'Saved in chat';
        toast('Saved in chat — you can open it again anytime');
        haptic(15);
      } catch (e) {
        saving = false; saveBtn.disabled = false; $('span', saveBtn).textContent = 'Save in chat';
        toast(e.message || 'Couldn’t save this snap');
      }
    });
  }
  el.addEventListener('click', next);
}

/* ═══════════ capture → preview → send ═══════════ */
async function handleFile(file, convo, roll = false) {
  if (convo) { replyTo = { key: convo.key, label: convo.name }; camera && camera.setReply(replyTo); }
  try {
    if (file.type.startsWith('image/')) {
      showPreview({ blob: await normalizeImage(file), kind: 'image', fromRoll: roll });
    } else if (file.type.startsWith('video/')) {
      if (file.size > MAX_VIDEO_BYTES) return toast('That video is too big — keep it under 45 MB.');
      const d = await videoDuration(file);
      showPreview({ blob: file, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(d || 10))), fromRoll: roll });
    } else {
      toast('Please choose a photo or a video.');
    }
  } catch (e) {
    console.error(e);
    toast('Couldn’t open that file.');
  }
}

function showPreview({ blob, kind, duration = 5, fromRoll = false }) {
  const url = URL.createObjectURL(blob);
  const st = { caption: '', dur: 5, capY: 0.6, fx: 'none', decor: [], fromRoll };
  const type = (blob.type || '').split(';')[0];
  const ext = kind === 'image' ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm';
  const el = document.createElement('div');
  el.className = 'overlay preview';
  el.innerHTML = `
    <div class="stage">
      ${kind === 'image'
    ? `<img class="v-media" src="${url}" alt="Your snap">`
    : `<video class="v-media" src="${url}" playsinline autoplay loop muted></video>`}
      <div class="decs"></div>
      <div class="cap" hidden style="top:60%"><input maxlength="80" placeholder="Add a caption" autocomplete="off" enterkeyhint="done"></div>
    </div>
    ${fromRoll ? '<div class="v-roll">Media</div>' : ''}
    <div class="p-top">
      <button class="icon-btn glass" data-x aria-label="Discard">${I.close}</button>
      <div class="p-tools">
        ${kind === 'image' ? `<button class="tool" data-dur aria-label="Viewing time">${I.timer}<span>5s</span></button>` : ''}
        <button class="tool" data-cap aria-label="Add caption"><b>Aa</b></button>
        <button class="tool" data-stk aria-label="Add a sticker">${I.smile}</button>
        <button class="tool" data-fx aria-label="Filters">${I.wand}</button>
        <a class="tool" href="${url}" download="blink-${Date.now()}.${ext}" aria-label="Save to your device">${I.download}</a>
      </div>
    </div>
    <div class="p-filters" hidden>${FILTERS.map(f => `<button type="button" data-f="${f.id}" class="${f.id === 'none' ? 'on' : ''}"><span class="fp"${f.css ? ` style="filter:${f.css}"` : ''}></span>${f.name}</button>`).join('')}</div>
    <p class="p-hint" hidden>Drag the caption up or down</p>
    <div class="p-bottom"><button class="btn primary send-to">Send to ${I.send}</button></div>`;
  const h = openOverlay(el, () => URL.revokeObjectURL(url));
  $('[data-x]', el).addEventListener('click', () => h.close());
  const pm = $('.v-media', el);
  const pAr = () => {
    const w = pm.naturalWidth || pm.videoWidth, hh = pm.naturalHeight || pm.videoHeight;
    if (w && hh) { $('.stage', el).style.setProperty('--ar', (w / hh).toFixed(4)); placeRoll(el); }
  };
  pm.addEventListener('load', pAr); pm.addEventListener('loadedmetadata', pAr);

  /* caption: tap to edit, drag to move up/down */
  const stage = $('.stage', el), cap = $('.cap', el), capIn = $('input', cap), hint = $('.p-hint', el);
  let drag = null, justDragged = false;
  const showCap = () => { cap.hidden = false; hint.hidden = false; capIn.focus(); };
  $('[data-cap]', el).addEventListener('click', showCap);
  capIn.addEventListener('input', () => { st.caption = capIn.value; });
  capIn.addEventListener('blur', () => { if (!capIn.value.trim()) { cap.hidden = true; hint.hidden = true; } });
  capIn.addEventListener('keydown', e => { if (e.key === 'Enter') capIn.blur(); });
  cap.addEventListener('pointerdown', e => {
    drag = { y0: e.clientY, top0: st.capY, moved: false, id: e.pointerId };
    try { cap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  cap.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const r = stage.getBoundingClientRect();
    st.capY = clamp(drag.top0 + dy / r.height, 0.07, 0.93);
    cap.style.top = `${(st.capY * 100).toFixed(2)}%`;
  });
  const endDrag = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 250); }
    else if (e.type === 'pointerup') capIn.focus();
  };
  cap.addEventListener('pointerup', endDrag);
  cap.addEventListener('pointercancel', endDrag);
  cap.addEventListener('click', e => { if (justDragged) e.preventDefault(); });

  const durBtn = $('[data-dur]', el);
  if (durBtn) {
    const opts = [3, 5, 10];
    durBtn.addEventListener('click', () => {
      st.dur = opts[(opts.indexOf(st.dur) + 1) % opts.length];
      $('span', durBtn).textContent = `${st.dur}s`;
    });
  }
  /* filters */
  const fbar = $('.p-filters', el);
  $('[data-fx]', el).addEventListener('click', () => { fbar.hidden = !fbar.hidden; });
  fbar.addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    st.fx = b.dataset.f; pm.style.filter = fxCss(st.fx);
    $$('button', fbar).forEach(x => x.classList.toggle('on', x === b));
    haptic(8);
  });

  /* stickers: drag to move · tap to make bigger · tap again to remove */
  const decs = $('.decs', el);
  const paintDecs = () => {
    decs.innerHTML = st.decor.map((d, i) => `<span class="dec live" data-i="${i}" style="left:${d.x * 100}%;top:${d.y * 100}%;--s:${d.s}">${d.e.replace(/[&<>]/g, '')}</span>`).join('');
  };
  $('[data-stk]', el).addEventListener('click', () => openStickerTray({
    openOverlay, title: 'Add a sticker',
    onPick: e => {
      if (st.decor.length >= 8) return toast('That’s the maximum — 8 stickers');
      st.decor.push({ e, x: 0.5, y: 0.45, s: STICKER_SIZES[0] });
      paintDecs();
      if (st.decor.length === 1) toast('Drag to move · tap to resize · tap again to remove');
    },
  }));
  let sd = null;
  decs.addEventListener('pointerdown', e => {
    const t = e.target.closest('.dec'); if (!t) return;
    e.preventDefault();
    const d = st.decor[+t.dataset.i];
    sd = { t, d, x0: e.clientX, y0: e.clientY, px: d.x, py: d.y, moved: false, id: e.pointerId };
    try { t.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  decs.addEventListener('pointermove', e => {
    if (!sd || e.pointerId !== sd.id) return;
    const dx = e.clientX - sd.x0, dy = e.clientY - sd.y0;
    if (!sd.moved && Math.hypot(dx, dy) > 6) sd.moved = true;
    if (!sd.moved) return;
    const r = stage.getBoundingClientRect();
    sd.d.x = clamp(sd.px + dx / r.width, 0.03, 0.97); sd.d.y = clamp(sd.py + dy / r.height, 0.03, 0.97);
    sd.t.style.left = `${sd.d.x * 100}%`; sd.t.style.top = `${sd.d.y * 100}%`;
  });
  const sEnd = e => {
    if (!sd || e.pointerId !== sd.id) return;
    const { d, moved } = sd; sd = null;
    if (e.type === 'pointercancel' || moved) return;
    const k = STICKER_SIZES.indexOf(d.s);
    if (k >= 0 && k < STICKER_SIZES.length - 1) d.s = STICKER_SIZES[k + 1];
    else st.decor = st.decor.filter(x => x !== d);
    paintDecs(); haptic(8);
  };
  decs.addEventListener('pointerup', sEnd); decs.addEventListener('pointercancel', sEnd);

  $('.send-to', el).addEventListener('click', () => openSendSheet(st, blob, kind, kind === 'image' ? null : duration));
}

function openSendSheet(st, blob, kind, videoSecs) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  const empty = !data.friends.length;
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Send to">
      <div class="grab"></div><h3>Send to</h3>
      <div class="sheet-list">
        ${pickRow('story', { ...me, display_name: 'My Story' }, 'All your friends · 24 hours', false)}
        ${data.friends.some(f => isBest(f.id)) ? `<h4 class="sh">Best friends ★ <button type="button" class="linkbtn" data-allbest>Select all</button></h4>${data.friends.filter(f => isBest(f.id)).map(f => pickRow('u:' + f.id, f, '@' + f.username, replyTo && replyTo.key === 'u:' + f.id)).join('')}` : ''}
        ${data.groups.length ? '<h4 class="sh">Groups</h4>' : ''}
        ${data.groups.map(g => pickRow('g:' + g.id, { username: g.name, display_name: g.name }, `${g.members.length} members`, replyTo && replyTo.key === 'g:' + g.id)).join('')}
        <h4 class="sh">Friends</h4>
        ${empty ? '<p class="muted pad-s">No friends yet — add someone from the Friends tab.</p>' : data.friends.filter(f => !isBest(f.id)).map(f => pickRow('u:' + f.id, f, '@' + f.username, replyTo && replyTo.key === 'u:' + f.id)).join('')}
      </div>
      <button class="btn primary wide" data-go disabled>Send</button>
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  const go = $('[data-go]', el);
  const update = () => {
    const n = $$('input:checked', el).length;
    go.disabled = !n;
    go.textContent = n ? `Send to ${n} ${n > 1 ? 'places' : 'place'}` : 'Send';
  };
  $$('input', el).forEach(i => i.addEventListener('change', update));
  const allBest = $('[data-allbest]', el);
  if (allBest) allBest.addEventListener('click', ev => {
    ev.preventDefault();
    const boxes = data.friends.filter(f => isBest(f.id)).map(f => $(`input[value="u:${f.id}"]`, el)).filter(Boolean);
    const on = boxes.some(b => !b.checked);
    boxes.forEach(b => { b.checked = on; });
    update();
  });
  update();
  go.addEventListener('click', async () => {
    const picked = $$('input:checked', el).map(i => i.value);
    if (!picked.length) return;
    const story = picked.includes('story'), keys = picked.filter(k => k !== 'story');
    go.disabled = true; go.textContent = 'Sending…';
    try {
      const secs = kind === 'image' ? st.dur : videoSecs;
      const extras = { fx: st.fx === 'none' ? null : st.fx, decor: st.decor, fromRoll: st.fromRoll };
      if (keys.length) await be.sendSnap(keys, blob, kind, st.caption.trim(), secs, st.capY, extras);
      if (story) await be.postStory(blob, kind, st.caption.trim(), secs, st.capY, extras);
      toast(story && !keys.length ? 'Posted to your story' : story ? 'Sent, and posted to your story' : `Snap sent to ${keys.length} chat${keys.length > 1 ? 's' : ''}`);
      haptic(15);
      replyTo = null; camera.setReply(null);
      closeAllOverlays();
      setTab('chats');
      refresh();
    } catch (e) {
      toast(e.message || 'Couldn’t send');
      update();
    }
  });
}
