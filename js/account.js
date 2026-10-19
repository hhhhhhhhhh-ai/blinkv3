import { THEMES, applyTheme, loadTheme } from './themes.js';
import { $, $$, esc, avatar, squareImage } from './util.js';
import { I } from './icons.js';

/**
 * The Account screen: display name, theme, password, blocked people, log out.
 * deps: { be, getMe, setMe, openOverlay, toast, refresh, logout }
 */
export function openAccount(d) {
  const { be } = d;
  const me = d.getMe();
  const el = document.createElement('div');
  el.className = 'overlay chat account';
  el.innerHTML = `
    <header class="chat-bar">
      <button class="icon-btn" data-x aria-label="Back">${I.back}</button>
      <div class="item-main"><b>Account</b><small>@${esc(me.username)}</small></div>
    </header>
    <div class="acct">
      <div class="acct-head"><span data-av>${avatar(me, 64)}</span>
        <div><b data-nm>${esc(me.display_name || me.username)}</b><span class="muted">@${esc(me.username)}</span></div></div>

      <section class="card"><h4>Profile picture</h4>
        <div class="row2"><button class="btn small primary" data-pick>Choose photo</button>
          <button class="btn small" data-rmpic ${me.avatar_url ? '' : 'hidden'}>Remove</button></div>
        <input type="file" accept="image/*" data-file hidden>
        <p class="err" data-pcerr></p></section>

      <section class="card"><h4>Display name</h4>
        <div class="row2"><input name="dn" maxlength="30" autocomplete="nickname" value="${esc(me.display_name || '')}" placeholder="Your name">
          <button class="btn small primary" data-savename>Save</button></div>
        <p class="err" data-nmerr></p><p class="ok" data-nmok></p></section>

      <section class="card"><h4>Theme</h4>
        <div class="themes">${THEMES.map(t => `
          <button class="theme" data-theme="${t.id}" aria-label="${t.name} theme">
            <span class="sw">${t.preview.map(c => `<i style="background:${c}"></i>`).join('')}</span>
            ${t.name}<span class="tick">${I.check}</span></button>`).join('')}</div></section>

      <section class="card"><h4>Password</h4>
        <input name="pw0" type="password" autocomplete="current-password" placeholder="Current password">
        <input name="pw1" type="password" autocomplete="new-password" placeholder="New password (6+ characters)">
        <input name="pw2" type="password" autocomplete="new-password" placeholder="New password again">
        <p class="err" data-pwerr></p><p class="ok" data-pwok></p>
        <button class="btn primary wide" data-savepw>Change password</button></section>

      <section class="card"><h4>Blocked people</h4>
        <div data-blocked><p class="muted">Loading…</p></div>
        <div class="row2"><input name="bu" placeholder="Block by username" maxlength="21" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off">
          <button class="btn small" data-block>Block</button></div>
        <p class="fine left">Blocked people are removed from your friends, can’t add you again, and you won’t see what they send you.</p>
        <p class="err" data-bkerr></p></section>

      <button class="btn danger wide" data-logout>Log out</button>
    </div>`;
  const h = d.openOverlay(el);
  $('[data-x]', el).addEventListener('click', () => h.close());

  /* profile picture */
  const file = $('[data-file]', el), rm = $('[data-rmpic]', el), pcErr = $('[data-pcerr]', el);
  const showAv = u => { $('[data-av]', el).innerHTML = avatar(u, 64); rm.hidden = !u.avatar_url; };
  $('[data-pick]', el).addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    pcErr.textContent = '';
    try {
      const u = await be.setAvatar(await squareImage(f));
      d.setMe(u); showAv(u); d.refresh();
    } catch (e) { pcErr.textContent = e.message || 'Couldn’t upload that picture'; }
  });
  rm.addEventListener('click', async () => {
    pcErr.textContent = '';
    try { const u = await be.removeAvatar(); d.setMe(u); showAv(u); d.refresh(); }
    catch (e) { pcErr.textContent = e.message || 'Couldn’t remove it'; }
  });

  /* name */
  const dn = $('input[name=dn]', el), nmErr = $('[data-nmerr]', el), nmOk = $('[data-nmok]', el);
  const saveName = async () => {
    nmErr.textContent = ''; nmOk.textContent = '';
    try {
      const u = await be.updateName(dn.value);
      d.setMe(u);
      $('[data-nm]', el).textContent = u.display_name || u.username;
      $('[data-av]', el).innerHTML = avatar(u, 64);
      nmOk.textContent = 'Name updated ✓';
    } catch (e) { nmErr.textContent = e.message || 'Couldn’t save.'; }
  };
  $('[data-savename]', el).addEventListener('click', saveName);
  dn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); dn.blur(); saveName(); } });

  /* theme */
  const paintThemes = () => {
    const cur = loadTheme();
    $$('.theme', el).forEach(b => b.classList.toggle('on', b.dataset.theme === cur));
  };
  paintThemes();
  $('.themes', el).addEventListener('click', e => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    applyTheme(b.dataset.theme);
    paintThemes();
  });

  /* password */
  const pwErr = $('[data-pwerr]', el), pwOk = $('[data-pwok]', el), pwBtn = $('[data-savepw]', el);
  pwBtn.addEventListener('click', async () => {
    pwErr.textContent = ''; pwOk.textContent = '';
    const a = $('input[name=pw0]', el).value, b = $('input[name=pw1]', el).value, c = $('input[name=pw2]', el).value;
    if (!a) return (pwErr.textContent = 'Type your current password.');
    if (b.length < 6) return (pwErr.textContent = 'The new password needs at least 6 characters.');
    if (b !== c) return (pwErr.textContent = 'The two new passwords don’t match.');
    pwBtn.disabled = true;
    try {
      await be.changePassword(a, b);
      $$('input[type=password]', el).forEach(i => { i.value = ''; });
      pwOk.textContent = 'Password changed ✓';
    } catch (e) { pwErr.textContent = e.message || 'Couldn’t change the password.'; }
    pwBtn.disabled = false;
  });

  /* blocked people */
  const list = $('[data-blocked]', el), bkErr = $('[data-bkerr]', el);
  const paintBlocked = async () => {
    try {
      const people = await be.listBlocked();
      list.innerHTML = people.length ? people.map(u => `
        <div class="blocked-item">${avatar(u, 38)}
          <span class="item-main"><b>${esc(u.display_name || u.username)}</b><small>@${esc(u.username)}</small></span>
          <button class="btn small" data-unblock="${esc(u.id)}">Unblock</button></div>`).join('')
        : '<p class="muted">Nobody blocked.</p>';
    } catch (e) { list.innerHTML = `<p class="err">${esc(e.message || 'Couldn’t load.')}</p>`; }
  };
  paintBlocked();
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-unblock]');
    if (!b) return;
    b.disabled = true;
    try { await be.unblockUser(b.dataset.unblock); d.toast('Unblocked'); await paintBlocked(); d.refresh(); }
    catch (x) { bkErr.textContent = x.message; b.disabled = false; }
  });
  const bu = $('input[name=bu]', el);
  const doBlock = async () => {
    bkErr.textContent = '';
    const name = bu.value.trim().replace(/^@/, '').toLowerCase();
    if (!name) return;
    try {
      await be.blockByUsername(name);
      bu.value = '';
      d.toast(`Blocked @${name}`);
      await paintBlocked(); d.refresh();
    } catch (x) { bkErr.textContent = x.message || 'Couldn’t block.'; }
  };
  $('[data-block]', el).addEventListener('click', doBlock);
  bu.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doBlock(); } });

  $('[data-logout]', el).addEventListener('click', () => d.logout());
  return h;
}
