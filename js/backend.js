import { CONFIG } from './config.js';
import { pickMime } from './util.js';

export const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
export const SAVE_WINDOW_MS = 5 * 60 * 1000;   // a snap can be saved in the chat for 5 min after opening it
export const EXPIRY_MS = 24 * 60 * 60 * 1000;   // unsaved chats, snaps and voice messages vanish after 24 hours
export const MAX_GROUP_FRIENDS = 9;          // + you = 10 people
const BUCKET = 'snaps';
const CHATBG = 'chatbg';
const AVATARS = 'avatars';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const uid = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
const nowIso = () => new Date().toISOString();
const pub = u => ({ id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar || null });
const pick = a => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.random() * (b - a);

/** Conversation keys: 'u:<userId>' for a 1-to-1 chat, 'g:<groupId>' for a group. */
/** Has this message outlived its 24 hours without being saved? */
export const expired = m => !m.saved_at && Date.now() - Date.parse(m.created_at) > EXPIRY_MS;
const isTextLike = k => k === 'text' || k === 'voice' || k === 'sticker' || k === 'poll';

/** Shared-background scope of a conversation: 'g:<group>' or 'd:<smaller id>:<larger id>' (same for both people). */
export const bgScope = (key, meId) => {
  const { group, id } = parseKey(key);
  if (group) return 'g:' + id;
  return 'd:' + (meId < id ? `${meId}:${id}` : `${id}:${meId}`);
};
/** Only keep what a snap needs besides its file: filter name, stickers placed on it, "from camera roll" flag. */
const snapExtras = (x = {}) => {
  const o = {};
  if (x.fx && /^[a-z0-9]{1,16}$/.test(x.fx)) o.fx = x.fx;
  if (Array.isArray(x.decor) && x.decor.length) {
    o.decor = x.decor.slice(0, 8).map(d => ({ e: String(d.e).slice(0, 8), x: +(+d.x).toFixed(4), y: +(+d.y).toFixed(4), s: +(+d.s || 1).toFixed(3) }));
  }
  if (x.fromRoll) o.from_roll = true;
  return o;
};
const cleanPoll = (question, options) => {
  const q = String(question || '').trim().slice(0, 200);
  const o = (options || []).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 6);
  if (!q) throw new Error('Type a question.');
  if (o.length < 2) throw new Error('Add at least 2 options.');
  return { q, o };
};

const parseKey = k => ({ group: k.startsWith('g:'), id: k.slice(2) });

/** Last message, unread count and unopened snaps (oldest first) per conversation. `msgs` must be newest-first. */
export function summarize(msgs, meId) {
  const out = {};
  for (const m of msgs) {
    const key = m.group_id ? 'g:' + m.group_id : 'u:' + (m.sender === meId ? m.recipient : m.sender);
    const c = out[key] || (out[key] = { last: m, unread: 0, snaps: [] });
    if (m.recipient === meId) {
      const unread = isTextLike(m.kind) ? !m.read_at : !m.opened_at;
      if (unread) { c.unread++; if (!isTextLike(m.kind)) c.snaps.push(m); }
    }
  }
  for (const c of Object.values(out)) c.snaps.reverse();
  return out;
}

export async function createBackend() {
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    const { createClient } = await import(SUPABASE_CDN);
    return new LiveBackend(createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY));
  }
  return new DemoBackend();
}

const extFor = (kind, type) => {
  if (kind === 'image') return 'jpg';
  if (kind === 'voice') return type.includes('mp4') || type.includes('m4a') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : 'webm';
  return type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm';
};
const typeFor = (kind, blob) => (kind === 'image' ? 'image/jpeg' : ((blob.type || '').split(';')[0] || (kind === 'voice' ? 'audio/webm' : 'video/webm')));

/* ════════════════════════════════════════════════════════════
   LIVE backend — Supabase (Auth + Postgres + Storage + Realtime)
   ════════════════════════════════════════════════════════════ */
function friendly(err) {
  const msg = (err && (err.message || err.error_description)) || String(err);
  if (/already (been )?registered/i.test(msg)) return new Error('That email already has an account — try logging in.');
  if (/invalid login credentials/i.test(msg)) return new Error('Wrong email or password.');
  if (/database error saving new user/i.test(msg)) return new Error('That username is taken or invalid. Try another one.');
  if (/mime type|not supported/i.test(msg)) return new Error('That file type isn’t supported.');
  if (/maximum allowed size|too large|413/i.test(msg)) return new Error('That file is too big (limit 50 MB).');
  if (/save window|too late/i.test(msg)) return new Error('It’s too late to save this snap (5 minute limit).');
  if (/row-level security|violates/i.test(msg)) return new Error('Not allowed — are you friends with this person yet?');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new Error('Can’t reach the server. Check your connection.');
  return new Error(msg);
}

class LiveBackend {
  constructor(sb) {
    this.sb = sb; this.me = null; this.mode = 'live'; this.needsEmail = true;
    this.subs = new Set(); this.channel = null; this.groups = [];
  }

  onChange(cb) { this.subs.add(cb); return () => this.subs.delete(cb); }
  _emit() { for (const f of this.subs) f(); }

  async init() {
    const { data: { session } } = await this.sb.auth.getSession();
    return session ? this._loadMe(session.user.id) : null;
  }

  /** Profile → what the app uses (adds the public picture URL). */
  _prof(p) {
    const path = p.avatar_path || null;
    const url = path ? this.sb.storage.from(AVATARS).getPublicUrl(path).data.publicUrl : null;
    return { id: p.id, username: p.username, display_name: p.display_name, avatar_path: path, avatar_url: url };
  }

  /** Run a profiles query; works even before migration 005 (no avatar column yet). */
  async _profQuery(build) {
    let r = await build(this._noAvatar ? 'id,username,display_name' : 'id,username,display_name,avatar_path');
    if (r.error && /avatar_path/.test(r.error.message || '')) {
      this._noAvatar = true;
      r = await build('id,username,display_name');
    }
    return r;
  }

  async _loadMe(id) {
    const { data, error } = await this._profQuery(cols => this.sb.from('profiles').select(cols).eq('id', id).maybeSingle());
    if (error) throw friendly(error);
    if (!data) { await this.sb.auth.signOut(); return null; }
    this.me = this._prof(data);
    this._listen();
    return data;
  }

  _listen() {
    if (this.channel) return;
    const emit = () => this._emit();
    let ch = this.sb.channel('blink-' + this.me.id);
    for (const table of ['messages', 'friendships', 'groups', 'group_members', 'reactions', 'stories']) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, emit);
    }
    this.channel = ch.subscribe();
    // (separate channel: if migration 006 hasn't been run yet, this one can fail without breaking the main one)
    this.channel2 = this.sb.channel('blink2-' + this.me.id);
    for (const table of ['poll_votes', 'chat_backgrounds']) {
      this.channel2 = this.channel2.on('postgres_changes', { event: '*', schema: 'public', table }, emit);
    }
    this.channel2.subscribe();
  }

  async signUp({ username, displayName, email, password }) {
    const { data: free, error: e1 } = await this.sb.rpc('username_available', { p_username: username });
    if (e1) throw friendly(e1);
    if (free === false) throw new Error('That username is taken.');
    const { data, error } = await this.sb.auth.signUp({
      email, password,
      options: { data: { username, display_name: displayName || username } },
    });
    if (error) throw friendly(error);
    if (!data.session) {
      throw new Error('Account created, but Supabase wants an email confirmation first. In Supabase turn off “Confirm email” (Authentication → Sign In / Providers → Email), then log in.');
    }
    return this._loadMe(data.user.id);
  }

  async signIn({ email, password }) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw friendly(error);
    return this._loadMe(data.user.id);
  }

  async signOut() {
    if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
    this.me = null; this.groups = [];
    await this.sb.auth.signOut();
  }

  async loadAll() {
    const { sb, me } = this;
    const { data: fr, error: e1 } = await sb.from('friendships').select('id,requester,addressee,status')
      .or(`requester.eq.${me.id},addressee.eq.${me.id}`);
    if (e1) throw friendly(e1);
    const { data: gs, error: e2 } = await sb.from('groups').select('id,name,created_by');
    if (e2) throw friendly(e2);
    let gm = [];
    if (gs.length) {
      const { data, error } = await sb.from('group_members').select('group_id,user_id').in('group_id', gs.map(g => g.id));
      if (error) throw friendly(error);
      gm = data;
    }
    const ids = new Set(gm.map(x => x.user_id));
    for (const f of fr) ids.add(f.requester === me.id ? f.addressee : f.requester);
    ids.delete(me.id);
    let profs = [];
    if (ids.size) {
      const { data, error } = await this._profQuery(cols => sb.from('profiles').select(cols).in('id', [...ids]));
      if (error) throw friendly(error);
      profs = data.map(p => this._prof(p));
    }
    const byId = Object.fromEntries(profs.map(p => [p.id, p]));
    byId[me.id] = me;
    const friends = [], incoming = [], outgoing = [];
    for (const f of fr) {
      const other = byId[f.requester === me.id ? f.addressee : f.requester];
      if (!other) continue;
      const item = { ...other, friendshipId: f.id };
      if (f.status === 'accepted') friends.push(item);
      else if (f.addressee === me.id) incoming.push(item);
      else outgoing.push(item);
    }
    const groups = gs.map(g => ({
      ...g,
      members: gm.filter(x => x.group_id === g.id).map(x => byId[x.user_id]).filter(Boolean),
    }));
    this.groups = groups;
    const { data: msgs, error: e3 } = await sb.from('messages').select('*')
      .or(`sender.eq.${me.id},recipient.eq.${me.id}`)
      .order('created_at', { ascending: false }).limit(500);
    if (e3) throw friendly(e3);
    const stories = await this._loadStories();
    const [bestFriends, bgs] = await Promise.all([this._loadBest(), this._loadBgs()]);
    return { friends, incoming, outgoing, groups, stories, bestFriends, bgs, convos: summarize(msgs.filter(m => !expired(m)), me.id) };
  }

  /* — best friends (private list) — */
  async _loadBest() {
    try {
      const { data, error } = await this.sb.from('best_friends').select('friend_id');
      return error ? [] : data.map(x => x.friend_id);
    } catch { return []; }
  }
  async setBestFriend(friendId, on) {
    const { sb, me } = this;
    const { error } = on
      ? await sb.from('best_friends').upsert({ user_id: me.id, friend_id: friendId }, { onConflict: 'user_id,friend_id', ignoreDuplicates: true })
      : await sb.from('best_friends').delete().eq('user_id', me.id).eq('friend_id', friendId);
    if (error) throw new Error(on ? 'Couldn’t add — you can have up to 8 best friends (and did you run migration 006?).' : friendly(error).message);
  }

  /* — chat backgrounds shared by everyone in the chat — */
  _bgUrl(path) { return this.sb.storage.from(CHATBG).getPublicUrl(path).data.publicUrl; }
  async _loadBgs() {
    try {
      const { data, error } = await this.sb.from('chat_backgrounds').select('scope,kind,value,updated_at');
      if (error) return {};
      const out = {};
      for (const r of data) out[r.scope] = { kind: r.kind, value: r.value, url: r.kind === 'image' ? this._bgUrl(r.value) + '?v=' + Date.parse(r.updated_at) : null };
      return out;
    } catch { return {}; }
  }
  /** spec: { kind: 'preset', value } or { kind: 'image', blob } */
  async setChatBg(key, spec) {
    const { sb, me } = this, scope = bgScope(key, me.id);
    const { data: old } = await sb.from('chat_backgrounds').select('kind,value').eq('scope', scope).maybeSingle();
    let value = spec.value;
    if (spec.kind === 'image') {
      value = `${scope.replace(/:/g, '_')}/${uid()}.jpg`;
      const up = await sb.storage.from(CHATBG).upload(value, spec.blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
      if (up.error) throw new Error('Couldn’t upload the picture. Did you run migration 006 in Supabase?');
    }
    const { error } = await sb.from('chat_backgrounds').upsert({ scope, kind: spec.kind, value, set_by: me.id, updated_at: nowIso() }, { onConflict: 'scope' });
    if (error) { if (spec.kind === 'image') await sb.storage.from(CHATBG).remove([value]); throw new Error('Couldn’t change the background. Did you run migration 006 in Supabase?'); }
    if (old && old.kind === 'image') await sb.storage.from(CHATBG).remove([old.value]).catch(() => {});
  }
  async clearChatBg(key) {
    const { sb, me } = this, scope = bgScope(key, me.id);
    const { data: old } = await sb.from('chat_backgrounds').select('kind,value').eq('scope', scope).maybeSingle();
    const { error } = await sb.from('chat_backgrounds').delete().eq('scope', scope);
    if (error) throw friendly(error);
    if (old && old.kind === 'image') await sb.storage.from(CHATBG).remove([old.value]).catch(() => {});
  }

  /* — stickers + polls — */
  async sendSticker(key, sticker, reply = null) {
    const t = await this._targets([key]);
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    const rows = t.map(x => ({ sender: this.me.id, kind: 'sticker', body: String(sticker).slice(0, 16), ...extra, ...x }));
    const { error } = await this.sb.from('messages').insert(rows);
    if (error) throw new Error('Couldn’t send the sticker. Did you run migration 006 in Supabase?');
  }
  async sendPoll(key, question, options) {
    const { q, o } = cleanPoll(question, options);
    const t = await this._targets([key]);
    const id = uid();
    const a = await this.sb.from('polls').insert({ id, created_by: this.me.id, question: q, options: o });
    if (a.error) throw new Error('Couldn’t create the poll. Did you run migration 006 in Supabase?');
    const rows = t.map(x => ({ sender: this.me.id, kind: 'poll', body: q, poll_id: id, ...x }));
    const { error } = await this.sb.from('messages').insert(rows);
    if (error) { await this.sb.from('polls').delete().eq('id', id); throw friendly(error); }
  }
  /** { pollId: { id, question, options, votes: [{ voter, opt }] } } */
  async getPolls(ids) {
    const out = {};
    if (!ids.length) return out;
    const [{ data: ps, error }, { data: vs }] = await Promise.all([
      this.sb.from('polls').select('id,question,options').in('id', ids),
      this.sb.from('poll_votes').select('poll_id,voter,opt').in('poll_id', ids),
    ]);
    if (error) throw friendly(error);
    for (const p of ps) out[p.id] = { ...p, votes: [] };
    for (const v of vs || []) if (out[v.poll_id]) out[v.poll_id].votes.push({ voter: v.voter, opt: v.opt });
    return out;
  }
  async votePoll(pollId, opt) {
    const { error } = await this.sb.rpc('vote_poll', { p_poll: pollId, p_opt: opt });
    if (error) throw friendly(error);
  }

  async getMessages(key) {
    const { sb, me } = this;
    const { group, id } = parseKey(key);
    let q = sb.from('messages').select('*');
    q = group
      ? q.eq('group_id', id).or(`sender.eq.${me.id},recipient.eq.${me.id}`)
      : q.is('group_id', null).or(`and(sender.eq.${me.id},recipient.eq.${id}),and(sender.eq.${id},recipient.eq.${me.id})`);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(300);
    if (error) throw friendly(error);
    return data.filter(m => !expired(m)).reverse();
  }

  /* — stories — */
  async _loadStories() {
    const { sb, me } = this;
    try {
      const { data, error } = await sb.from('stories').select('*').order('created_at', { ascending: true });
      if (error) return [];            // (migration 005 not run yet)
      const live = data.filter(s => Date.now() - Date.parse(s.created_at) < EXPIRY_MS);
      let seen = new Set();
      if (live.length) {
        const { data: v } = await sb.from('story_views').select('story_id').eq('viewer', me.id).in('story_id', live.map(s => s.id));
        seen = new Set((v || []).map(x => x.story_id));
      }
      return live.map(s => ({ ...s, seen: s.user_id === me.id || seen.has(s.id) }));
    } catch { return []; }
  }

  async postStory(blob, kind, caption, duration, capY = 0.6, extra = {}) {
    const { sb, me } = this;
    const contentType = typeFor(kind, blob), path = `${me.id}/${uid()}.${extFor(kind, contentType)}`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType, cacheControl: '3600', upsert: false });
    if (up.error) throw friendly(up.error);
    const { error } = await sb.from('stories').insert({ user_id: me.id, kind, media_path: path, body: (caption || '').slice(0, 200), cap_y: capY, duration: duration || 5, ...snapExtras(extra) });
    if (error) { await sb.storage.from(BUCKET).remove([path]); throw new Error('Couldn’t post your story. Did you run the latest migration in Supabase?'); }
  }
  fetchStory(s) { return this._download(s.media_path); }
  async viewStory(id) { try { await this.sb.rpc('view_story', { p_id: id }); } catch { /* ignore */ } }
  async storyViewers(id) {
    const { data, error } = await this.sb.from('story_views').select('viewer,viewed_at').eq('story_id', id).order('viewed_at', { ascending: false });
    if (error) throw friendly(error);
    if (!data.length) return [];
    const { data: profs } = await this._profQuery(cols => this.sb.from('profiles').select(cols).in('id', data.map(x => x.viewer)));
    const by = Object.fromEntries((profs || []).map(p => [p.id, this._prof(p)]));
    return data.map(x => ({ ...(by[x.viewer] || { id: x.viewer, username: '?', display_name: 'Someone' }), viewed_at: x.viewed_at }));
  }
  async deleteStory(s) {
    await this.sb.storage.from(BUCKET).remove([s.media_path]);
    const { error } = await this.sb.from('stories').delete().eq('id', s.id);
    if (error) throw friendly(error);
  }

  /* — profile picture — */
  async setAvatar(blob) {
    const { sb, me } = this;
    const path = `${me.id}/${uid()}.jpg`;
    const up = await sb.storage.from(AVATARS).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
    if (up.error) throw new Error('Couldn’t upload the picture. Did you run migration 005 in Supabase?');
    const { error } = await sb.from('profiles').update({ avatar_path: path }).eq('id', me.id);
    if (error) { await sb.storage.from(AVATARS).remove([path]); throw friendly(error); }
    if (me.avatar_path) await sb.storage.from(AVATARS).remove([me.avatar_path]);
    this.me = this._prof({ ...me, avatar_path: path });
    return this.me;
  }
  async removeAvatar() {
    const { sb, me } = this;
    const { error } = await sb.from('profiles').update({ avatar_path: null }).eq('id', me.id);
    if (error) throw friendly(error);
    if (me.avatar_path) await sb.storage.from(AVATARS).remove([me.avatar_path]);
    this.me = this._prof({ ...me, avatar_path: null });
    return this.me;
  }

  /** Delete what's older than 24 hours and not saved: files first (while the rules still let us see them), then the rows. */
  async purgeExpired() {
    const { sb, me } = this;
    try {
      const cutoff = new Date(Date.now() - EXPIRY_MS).toISOString();
      const { data, error } = await sb.from('messages').select('id,media_path')
        .is('saved_at', null).lt('created_at', cutoff)
        .or(`sender.eq.${me.id},recipient.eq.${me.id}`).limit(500);
      if (error || !data || !data.length) return;
      const paths = data.map(m => m.media_path).filter(Boolean);
      if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      await sb.rpc('purge_expired');
    } catch (e) { console.warn('purge failed', e); }
    try {   // my own stories older than 24 h
      const cutoff = new Date(Date.now() - EXPIRY_MS).toISOString();
      const { data } = await sb.from('stories').select('id,media_path').eq('user_id', me.id).lt('created_at', cutoff).limit(200);
      if (data && data.length) {
        await sb.storage.from(BUCKET).remove(data.map(x => x.media_path));
        await sb.from('stories').delete().in('id', data.map(x => x.id));
      }
    } catch { /* ignore */ }
  }

  async _members(gid) {
    const g = this.groups.find(x => x.id === gid);
    if (g) return g.members;
    const { data, error } = await this.sb.from('group_members').select('user_id').eq('group_id', gid);
    if (error) throw friendly(error);
    return data.map(x => ({ id: x.user_id }));
  }

  /** Turn conversation keys into one row-template per recipient (groups fan out to every other member). */
  async _targets(keys) {
    const out = [];
    for (const key of keys) {
      const { group, id } = parseKey(key);
      if (!group) { out.push({ recipient: id, group_id: null, batch_id: null }); continue; }
      const batch = uid();
      for (const u of await this._members(id)) {
        if (u.id !== this.me.id) out.push({ recipient: u.id, group_id: id, batch_id: batch });
      }
    }
    return out;
  }

  async sendText(key, body, reply = null) {
    const t = await this._targets([key]);
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    const rows = t.map(x => ({ sender: this.me.id, kind: 'text', body: body.slice(0, 1000), ...extra, ...x }));
    const { error } = await this.sb.from('messages').insert(rows);
    if (error) throw friendly(error);
  }

  /** { messageId: [{ user_id, emoji }] } for the given message ids. */
  async getReactions(ids) {
    const out = {};
    if (!ids.length) return out;
    const { data, error } = await this.sb.from('reactions').select('message_id,user_id,emoji').in('message_id', ids);
    if (error) throw friendly(error);
    for (const r of data) (out[r.message_id] || (out[r.message_id] = [])).push({ user_id: r.user_id, emoji: r.emoji });
    return out;
  }

  /** Add, change or (same emoji again) remove my reaction on a message. */
  async react(messageId, emoji) {
    const { sb, me } = this;
    const { data: cur } = await sb.from('reactions').select('emoji').eq('message_id', messageId).eq('user_id', me.id).maybeSingle();
    const q = cur && cur.emoji === emoji
      ? sb.from('reactions').delete().eq('message_id', messageId).eq('user_id', me.id)
      : sb.from('reactions').upsert({ message_id: messageId, user_id: me.id, emoji }, { onConflict: 'message_id,user_id' });
    const { error } = await q;
    if (error) throw friendly(error);
  }

  async sendSnap(keys, blob, kind, caption, duration, capY = 0.6, extra = {}) {
    return this._sendMedia(keys, blob, kind, { body: caption || '', duration, cap_y: capY, ...snapExtras(extra) });
  }

  /** Voice message (a chat message that plays any number of times — not view-once). */
  sendVoice(key, blob, duration, reply = null) {
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    return this._sendMedia([key], blob, 'voice', { body: '', duration: Math.max(1, Math.min(120, Math.round(duration || 1))), ...extra });
  }

  async _sendMedia(keys, blob, kind, fields) {
    const { sb, me } = this;
    const targets = await this._targets(keys);
    if (!targets.length) throw new Error('There is nobody to send this to.');
    const contentType = typeFor(kind, blob), ext = extFor(kind, contentType);
    const store = sb.storage.from(BUCKET);
    const upload = async path => {
      const up = await store.upload(path, blob, { contentType, cacheControl: '0', upsert: false });
      if (up.error) throw friendly(up.error);
    };
    // One private copy per recipient (so each person's copy can be deleted independently).
    // Upload once, then let the server duplicate it — far cheaper than uploading N times.
    const first = `${me.id}/${uid()}.${ext}`;
    await upload(first);
    const paths = await Promise.all(targets.map(async (_, i) => {
      if (i === 0) return first;
      const p = `${me.id}/${uid()}.${ext}`;
      const cp = await store.copy(first, p);
      if (cp.error) await upload(p);
      return p;
    }));
    const results = await Promise.allSettled(targets.map(async (t, i) => {
      const ins = await sb.from('messages').insert({ sender: me.id, kind, media_path: paths[i], ...fields, ...t });
      if (ins.error) { await store.remove([paths[i]]); throw friendly(ins.error); }
    }));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length === results.length) throw failed[0].reason;
    if (failed.length) throw new Error(`Sent to ${results.length - failed.length}, but ${failed.length} failed.`);
  }

  async _download(path) {
    const { data, error } = await this.sb.storage.from(BUCKET).download(path);
    if (error || !data) {
      const msg = String((error && error.message) || '');
      if (/failed to fetch|network|load failed/i.test(msg)) throw new Error('Can’t reach the server. Check your connection.');
      const e = new Error('This snap is gone or was already opened.');
      e.gone = true;
      throw e;
    }
    return data;
  }

  fetchSnap(m) { return this._download(m.media_path); }
  fetchSaved(m) { return this._download(m.media_path); }
  fetchVoice(m) { return this._download(m.media_path); }

  /** Keep (or un-keep) text / voice messages. `ids` = every row of the message. */
  async setSaved(ids, saved) {
    const { error } = await this.sb.rpc('set_saved', { p_ids: ids, p_saved: saved });
    if (error) throw friendly(error);
  }

  /* — account — */
  async updateName(name) {
    const n = String(name || '').trim().slice(0, 30);
    if (!n) throw new Error('Type a name first.');
    const { error } = await this.sb.from('profiles').update({ display_name: n }).eq('id', this.me.id);
    if (error) throw friendly(error);
    this.me = { ...this.me, display_name: n };
    return this.me;
  }

  async changePassword(current, next) {
    if (!next || next.length < 6) throw new Error('The new password needs at least 6 characters.');
    const { data: { user } } = await this.sb.auth.getUser();
    const { error: e1 } = await this.sb.auth.signInWithPassword({ email: user && user.email, password: current });
    if (e1) throw new Error('Your current password is wrong.');
    const { error } = await this.sb.auth.updateUser({ password: next });
    if (error) throw friendly(error);
  }

  /* — blocking — */
  async listBlocked() {
    const { data, error } = await this.sb.from('blocks').select('blocked');
    if (error) throw friendly(error);
    if (!data.length) return [];
    const { data: profs, error: e2 } = await this._profQuery(cols => this.sb.from('profiles').select(cols).in('id', data.map(x => x.blocked)));
    if (e2) throw friendly(e2);
    return profs.map(p => this._prof(p));
  }
  async blockByUsername(uname) {
    const n = String(uname).trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(n)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (n === this.me.username) throw new Error('You can’t block yourself 🙂');
    const { data, error } = await this.sb.from('profiles').select('id').eq('username', n).maybeSingle();
    if (error) throw friendly(error);
    if (!data) throw new Error(`Nobody has the username @${n}.`);
    return this.blockUser(data.id);
  }
  async blockUser(id) {
    const { error } = await this.sb.rpc('block_user', { p_user: id });
    if (error) throw friendly(error);
  }
  async unblockUser(id) {
    const { error } = await this.sb.from('blocks').delete().eq('blocker', this.me.id).eq('blocked', id);
    if (error) throw friendly(error);
  }

  async openSnap(id) {
    const { error } = await this.sb.rpc('open_snap', { p_id: id });
    if (error) throw friendly(error);
  }

  async discardSnap(m) {
    if (m.recipient === this.me.id) await this.sb.storage.from(BUCKET).remove([m.media_path]);
  }

  /** Keep a snap you received in the chat: re-upload it into your own folder and flag the message as saved. */
  async saveSnap(m, blob) {
    const contentType = typeFor(m.kind, blob);
    const path = `${this.me.id}/${uid()}.${extFor(m.kind, contentType)}`;
    const up = await this.sb.storage.from(BUCKET).upload(path, blob, { contentType, cacheControl: '3600', upsert: false });
    if (up.error) throw friendly(up.error);
    const { error } = await this.sb.rpc('save_snap', { p_id: m.id, p_path: path });
    const { data: chk } = error ? { data: null } : await this.sb.from('messages').select('saved_at,media_path').eq('id', m.id).maybeSingle();
    if (error || !chk || !chk.saved_at || chk.media_path !== path) {
      await this.sb.storage.from(BUCKET).remove([path]);
      throw error ? friendly(error) : new Error('It’s too late to save this snap (5 minute limit).');
    }
  }

  async markRead(key) {
    const { group, id } = parseKey(key);
    if (group) await this.sb.rpc('mark_read_group', { p_group: id });
    else await this.sb.rpc('mark_read', { p_friend: id });
  }

  async addFriend(input) {
    const { sb, me } = this;
    const uname = input.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(uname)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (uname === me.username) throw new Error('That’s your own username 🙂');
    const { data: target, error: e1 } = await sb.from('profiles').select('id,username').eq('username', uname).maybeSingle();
    if (e1) throw friendly(e1);
    if (!target) throw new Error(`Nobody has the username @${uname}.`);
    const { data: ex, error: e2 } = await sb.from('friendships').select('id,requester,status')
      .or(`and(requester.eq.${me.id},addressee.eq.${target.id}),and(requester.eq.${target.id},addressee.eq.${me.id})`);
    if (e2) throw friendly(e2);
    if (ex.length) {
      const f = ex[0];
      if (f.status === 'accepted') return `You’re already friends with @${uname}.`;
      if (f.requester === me.id) return `Your request to @${uname} is still pending.`;
      await this.respond(f.id, true);
      return `You and @${uname} are now friends!`;
    }
    const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: target.id });
    if (error) throw (/row-level security/i.test(error.message || '') ? new Error(`Couldn’t send a friend request to @${uname}.`) : friendly(error));
    return `Friend request sent to @${uname}.`;
  }

  async respond(friendshipId, accept) {
    const q = accept
      ? this.sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId)
      : this.sb.from('friendships').delete().eq('id', friendshipId);
    const { error } = await q;
    if (error) throw friendly(error);
  }

  removeFriend(friendshipId) { return this.respond(friendshipId, false); }

  async createGroup(name, memberIds) {
    const { data, error } = await this.sb.rpc('create_group', { p_name: name, p_members: memberIds });
    if (error) throw friendly(error);
    return data;
  }

  async leaveGroup(groupId) {
    const { error } = await this.sb.from('group_members').delete().eq('group_id', groupId).eq('user_id', this.me.id);
    if (error) throw friendly(error);
  }
}

/* ════════════════════════════════════════════════════════════
   DEMO backend — a tiny fake "server" in localStorage + IndexedDB.
   Several tabs of the same browser share it, so you can sign up
   two users in two tabs and really chat with yourself. Three bots
   (mia, leo, zoe) are pre-friended so the app isn't empty.
   NOT secure — for trying the UI only.
   ════════════════════════════════════════════════════════════ */
const DB_KEY = 'blink_demo_db_v1';
const SESSION_KEY = 'blink_demo_uid';
const BOTS = [
  { id: 'bot-mia', username: 'mia', display_name: 'Mia', hue: 330 },
  { id: 'bot-leo', username: 'leo', display_name: 'Leo', hue: 210 },
  { id: 'bot-zoe', username: 'zoe', display_name: 'Zoe', hue: 150 },
];
const isBot = id => BOTS.some(b => b.id === id);
const TEXT_REPLIES = [
  'haha yes 😂', 'omg same', 'wait what?! tell me more', 'lol 💀', 'okay okay I’m listening 👀',
  'that’s so good', 'send a snap!', 'brb 2 min', 'no way', 'I was literally just thinking that',
];
const SNAP_REPLIES = ['haha love it 😂', 'okay that’s a good one', 'lmaooo', 'saw it! 👀', 'so pretty 😍'];

const mk = (sender, recipient, kind, extra = {}) => ({
  id: uid(), sender, recipient, kind, body: '', media_path: null, duration: 5, cap_y: 0.6,
  group_id: null, batch_id: null, saved_at: null, saved_by: null, reply_to: null, reply_preview: null,
  created_at: nowIso(), opened_at: null, read_at: null, fx: null, decor: [], from_roll: false, poll_id: null, ...extra,
});

async function hashPw(pw) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blink:' + pw));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'plain:' + pw; }
}

/* IndexedDB blob store (snaps are binary — too big for localStorage) */
let idbPromise;
const idb = () => idbPromise || (idbPromise = new Promise((res, rej) => {
  const r = indexedDB.open('blink-demo', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('media');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const mediaTx = async (mode, fn) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('media', mode);
    const req = fn(tx.objectStore('media'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
};
const mediaPut = (k, blob) => mediaTx('readwrite', s => s.put(blob, k));
const mediaGet = k => mediaTx('readonly', s => s.get(k));
const mediaDel = k => mediaTx('readwrite', s => s.delete(k));

/* Generated "photos" and "videos" for the bots */
function paintScene(ctx, w, h, hue, t = 0) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${hue} 85% 58%)`);
  g.addColorStop(0.55, `hsl(${(hue + 40) % 360} 90% 66%)`);
  g.addColorStop(1, `hsl(${(hue + 70) % 360} 80% 30%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  for (let i = 0; i < 40; i++) ctx.fillRect((i * 97) % w, (i * 53) % (h * 0.3), 2, 2);
  const sx = w / 2, sy = h * (0.42 + Math.sin(t * 1.2) * 0.015), sr = w * 0.2;
  const sg = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 2.2);
  sg.addColorStop(0, 'rgba(255,255,255,.95)'); sg.addColorStop(0.3, 'rgba(255,240,200,.55)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, sr * 2.2, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff7e0'; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 7); ctx.fill();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `hsl(${(hue + 200 + i * 20) % 360} 40% ${22 - i * 6}%)`;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 20) {
      ctx.lineTo(x, h * (0.68 + i * 0.08) + Math.sin((x / w) * 6 + i * 2 + t * (0.6 + i * 0.2)) * h * 0.03);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
}

function botImage(hue) {
  const c = document.createElement('canvas'); c.width = 720; c.height = 1280;
  paintScene(c.getContext('2d'), 720, 1280, hue);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

async function botVideo(hue) {
  const mime = pickMime();
  if (!mime || !HTMLCanvasElement.prototype.captureStream) return null;
  const c = document.createElement('canvas'); c.width = 360; c.height = 640;
  const ctx = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(200);
  const t0 = performance.now();
  await new Promise(res => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      paintScene(ctx, 360, 640, hue, t);
      if (t < 3) setTimeout(draw, 33); else res();
    };
    draw();
  });
  rec.stop(); await stopped;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

class DemoBackend {
  constructor() {
    this.mode = 'demo'; this.needsEmail = false; this.me = null; this.subs = new Set();
    window.addEventListener('storage', e => { if (e.key === DB_KEY) this._emit(); });
  }

  /* — storage helpers — */
  _db() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DB_KEY)); } catch { /* fresh */ }
    if (!d || !d.users) {
      d = { users: BOTS.map(b => ({ id: b.id, username: b.username, display_name: b.display_name, bot: true })), friendships: [], messages: [] };
    }
    d.groups = d.groups || [];
    d.members = d.members || [];
    d.reactions = d.reactions || [];
    d.blocks = d.blocks || [];
    d.stories = d.stories || [];
    d.story_views = d.story_views || [];
    d.polls = d.polls || [];
    d.poll_votes = d.poll_votes || [];
    d.best_friends = d.best_friends || [];
    d.chat_bgs = d.chat_bgs || [];
    return d;
  }
  _save(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); this._emit(); }
  _emit() { for (const f of this.subs) f(); }
  onChange(cb) { this.subs.add(cb); return () => this.subs.delete(cb); }
  _findFriendship(db, a, b) {
    return db.friendships.find(f => (f.requester === a && f.addressee === b) || (f.requester === b && f.addressee === a));
  }
  _assertFriends(db, other) {
    const f = this._findFriendship(db, this.me.id, other);
    if (!f || f.status !== 'accepted') throw new Error('You can only message friends.');
  }
  _memberIds(db, gid) { return db.members.filter(x => x.group_id === gid).map(x => x.user_id); }
  _assertMember(db, gid) {
    if (!this._memberIds(db, gid).includes(this.me.id)) throw new Error('You’re not in this group.');
  }

  /* — auth — */
  async init() {
    const id = sessionStorage.getItem(SESSION_KEY);
    const u = id && this._db().users.find(x => x.id === id);
    if (!u) return null;
    this.me = pub(u);
    return this.me;
  }

  async signUp({ username, displayName, password }) {
    const db = this._db();
    if (db.users.some(u => u.username === username)) throw new Error('That username is taken.');
    const user = { id: uid(), username, display_name: displayName || username, pw: await hashPw(password) };
    db.users.push(user);
    for (const b of BOTS) db.friendships.push({ id: uid(), requester: b.id, addressee: user.id, status: 'accepted' });
    const t = Date.now();
    const at = ms => new Date(t - ms).toISOString();
    db.messages.push(mk('bot-mia', user.id, 'text', { body: 'hey! welcome to Blink 👋', created_at: at(240000) }));
    db.messages.push(mk('bot-leo', user.id, 'text', { body: 'psst — hold the shutter button to record a video', created_at: at(150000) }));
    const path = `bot-mia/${uid()}`;
    await mediaPut(path, await botImage(330));
    db.messages.push(mk('bot-mia', user.id, 'image', { media_path: path, body: 'good vibes only ✨', duration: 6, cap_y: 0.72, created_at: at(60000) }));
    const gid = uid();
    db.groups.push({ id: gid, name: 'Squad 🎉', created_by: 'bot-zoe' });
    for (const u of ['bot-mia', 'bot-leo', 'bot-zoe', user.id]) db.members.push({ group_id: gid, user_id: u });
    db.messages.push(mk('bot-zoe', user.id, 'text', { body: 'welcome to the group chat! 🎉', group_id: gid, batch_id: uid(), created_at: at(20000) }));
    for (const [bot, hue, cap, ms] of [['bot-mia', 330, 'sunset walk 🌅', 2 * 3600e3], ['bot-zoe', 150, 'new day, new me ✨', 40 * 60e3]]) {
      const sp = `${bot}/${uid()}`;
      await mediaPut(sp, await botImage(hue + 20));
      db.stories.push({ id: uid(), user_id: bot, kind: 'image', media_path: sp, body: cap, cap_y: 0.8, duration: 5, created_at: at(ms) });
    }
    this._save(db);
    sessionStorage.setItem(SESSION_KEY, user.id);
    this.me = pub(user);
    this._laterVideo(user.id);
    return this.me;
  }

  async signIn({ username, password }) {
    const u = this._db().users.find(x => x.username === username && !x.bot);
    if (!u || u.pw !== await hashPw(password)) throw new Error('Wrong username or password.');
    sessionStorage.setItem(SESSION_KEY, u.id);
    this.me = pub(u);
    return this.me;
  }

  async signOut() { sessionStorage.removeItem(SESSION_KEY); this.me = null; }

  _laterVideo(userId) {
    setTimeout(async () => {
      try {
        if (!this.me || this.me.id !== userId) return;
        const blob = await withTimeout(botVideo(262), 10000);
        if (!blob || !this.me || this.me.id !== userId) return;
        const path = `bot-leo/${uid()}`;
        await mediaPut(path, blob);
        const db = this._db();
        db.messages.push(mk('bot-leo', userId, 'video', { media_path: path, body: 'golden hour 🌇', duration: 3, cap_y: 0.3 }));
        this._save(db);
      } catch (e) { console.warn('demo video skipped:', e.message); }
    }, 5000);
  }

  /* — reads — */
  /** Delete unsaved messages older than 24 hours (and their files). */
  _purge() {
    const db = this._db();
    const oldStories = db.stories.filter(st => Date.now() - Date.parse(st.created_at) > EXPIRY_MS);
    if (oldStories.length) {
      const ids = new Set(oldStories.map(x => x.id));
      db.stories = db.stories.filter(x => !ids.has(x.id));
      db.story_views = db.story_views.filter(v => !ids.has(v.story_id));
      for (const st of oldStories) mediaDel(st.media_path).catch(() => {});
      this._save(db);
    }
    const gone = db.messages.filter(expired);
    if (!gone.length) return;
    const ids = new Set(gone.map(m => m.id));
    db.messages = db.messages.filter(m => !ids.has(m.id));
    db.reactions = db.reactions.filter(r => !ids.has(r.message_id));
    for (const m of gone) if (m.media_path) mediaDel(m.media_path).catch(() => {});
    const used = new Set(db.messages.map(m => m.poll_id).filter(Boolean));
    db.polls = db.polls.filter(p => used.has(p.id) || Date.now() - Date.parse(p.created_at) < EXPIRY_MS);
    db.poll_votes = db.poll_votes.filter(v => db.polls.some(p => p.id === v.poll_id));
    this._save(db);
  }
  async purgeExpired() { this._purge(); }

  /** ids of people I blocked */
  _blocked(db) { return new Set(db.blocks.filter(b => b.blocker === this.me.id).map(b => b.blocked)); }

  async loadAll() {
    this._purge();
    const db = this._db(), me = this.me.id, blocked = this._blocked(db);
    const byId = Object.fromEntries(db.users.map(u => [u.id, u]));
    const friends = [], incoming = [], outgoing = [];
    for (const f of db.friendships) {
      if (f.requester !== me && f.addressee !== me) continue;
      const o = byId[f.requester === me ? f.addressee : f.requester];
      if (!o) continue;
      const item = { ...pub(o), friendshipId: f.id };
      if (f.status === 'accepted') friends.push(item);
      else if (f.addressee === me) incoming.push(item);
      else outgoing.push(item);
    }
    const groups = db.groups
      .filter(g => this._memberIds(db, g.id).includes(me))
      .map(g => ({ ...g, members: this._memberIds(db, g.id).map(id => byId[id]).filter(Boolean).map(pub) }));
    const msgs = db.messages.filter(m => (m.sender === me || m.recipient === me) && !blocked.has(m.sender))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const friendIds = new Set(friends.map(f => f.id));
    const seen = new Set(db.story_views.filter(v => v.viewer === me).map(v => v.story_id));
    const stories = db.stories.filter(st => st.user_id === me || friendIds.has(st.user_id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(st => ({ ...st, seen: st.user_id === me || seen.has(st.id) }));
    const bestFriends = db.best_friends.filter(b => b.user_id === me && friendIds.has(b.friend_id)).map(b => b.friend_id);
    const bgs = {};
    for (const r of db.chat_bgs) {
      if (!this._canBg(db, r.scope)) continue;
      bgs[r.scope] = { kind: r.kind, value: r.value, url: r.kind === 'image' ? await this._bgUrl(r.value, r.updated_at) : null };
    }
    return { friends, incoming, outgoing, groups, stories, bestFriends, bgs, convos: summarize(msgs, me) };
  }

  async getMessages(key) {
    const me = this.me.id, { group, id } = parseKey(key);
    const db = this._db(), blocked = this._blocked(db);
    return db.messages
      .filter(m => !blocked.has(m.sender) && !expired(m))
      .filter(m => (group
        ? m.group_id === id && (m.sender === me || m.recipient === me)
        : !m.group_id && ((m.sender === me && m.recipient === id) || (m.sender === id && m.recipient === me))))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /* — best friends / shared backgrounds / stickers / polls (demo) — */
  async setBestFriend(friendId, on) {
    const db = this._db(), me = this.me.id;
    this._assertFriends(db, friendId);
    db.best_friends = db.best_friends.filter(b => !(b.user_id === me && b.friend_id === friendId));
    if (on) {
      if (db.best_friends.filter(b => b.user_id === me).length >= 8) throw new Error('You can have up to 8 best friends.');
      db.best_friends.push({ user_id: me, friend_id: friendId });
    }
    this._save(db);
  }
  _canBg(db, scope) {
    const me = this.me.id, [t, a, b] = scope.split(':');
    if (t === 'g') return this._memberIds(db, a).includes(me);
    return (a === me || b === me) && (this._findFriendship(db, a, b) || {}).status === 'accepted';
  }
  async _bgUrl(path, version) {
    this._bgCache = this._bgCache || new Map();
    const k = path + version;
    if (!this._bgCache.has(k)) {
      const blob = await mediaGet(path);
      this._bgCache.set(k, blob ? URL.createObjectURL(blob) : null);
    }
    return this._bgCache.get(k);
  }
  async setChatBg(key, spec) {
    const db = this._db(), scope = bgScope(key, this.me.id);
    if (!this._canBg(db, scope)) throw new Error('Not allowed.');
    const old = db.chat_bgs.find(r => r.scope === scope);
    let value = spec.value;
    if (spec.kind === 'image') { value = `bg/${uid()}`; await mediaPut(value, spec.blob); }
    db.chat_bgs = db.chat_bgs.filter(r => r.scope !== scope);
    db.chat_bgs.push({ scope, kind: spec.kind, value, set_by: this.me.id, updated_at: nowIso() });
    if (old && old.kind === 'image') mediaDel(old.value).catch(() => {});
    this._save(db);
  }
  async clearChatBg(key) {
    const db = this._db(), scope = bgScope(key, this.me.id);
    if (!this._canBg(db, scope)) throw new Error('Not allowed.');
    const old = db.chat_bgs.find(r => r.scope === scope);
    db.chat_bgs = db.chat_bgs.filter(r => r.scope !== scope);
    if (old && old.kind === 'image') mediaDel(old.value).catch(() => {});
    this._save(db);
  }
  async sendSticker(key, sticker, reply = null) {
    const db = this._db();
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    db.messages.push(...this._targets(db, key).map(t => mk(this.me.id, t.recipient, 'sticker', { body: String(sticker).slice(0, 16), ...extra, ...t })));
    this._save(db);
    const { group, id } = parseKey(key);
    this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null);
  }
  async sendPoll(key, question, options) {
    const { q, o } = cleanPoll(question, options);
    const db = this._db(), pid = uid();
    db.polls.push({ id: pid, created_by: this.me.id, question: q, options: o, created_at: nowIso() });
    db.messages.push(...this._targets(db, key).map(t => mk(this.me.id, t.recipient, 'poll', { body: q, poll_id: pid, ...t })));
    this._save(db);
    // bots answer after a few seconds
    const { group, id } = parseKey(key);
    const bots = group ? this._memberIds(db, id).filter(isBot) : [id].filter(isBot);
    bots.forEach(b => setTimeout(() => {
      const d = this._db();
      if (!d.polls.some(x => x.id === pid) || d.poll_votes.some(v => v.poll_id === pid && v.voter === b)) return;
      d.poll_votes.push({ poll_id: pid, voter: b, opt: Math.floor(Math.random() * o.length), voted_at: nowIso() });
      this._save(d);
    }, between(2500, 6500)));
  }
  async getPolls(ids) {
    const db = this._db(), me = this.me.id, out = {};
    const mine = new Set(db.messages.filter(m => m.poll_id && ids.includes(m.poll_id) && (m.sender === me || m.recipient === me)).map(m => m.poll_id));
    for (const p of db.polls) if (mine.has(p.id)) out[p.id] = { id: p.id, question: p.question, options: p.options, votes: [] };
    for (const v of db.poll_votes) if (out[v.poll_id]) out[v.poll_id].votes.push({ voter: v.voter, opt: v.opt });
    return out;
  }
  async votePoll(pollId, opt) {
    const db = this._db(), me = this.me.id, p = db.polls.find(x => x.id === pollId);
    if (!p || !db.messages.some(m => m.poll_id === pollId && (m.sender === me || m.recipient === me))) throw new Error('You can’t vote in this poll.');
    if (!Number.isInteger(opt) || opt < 0 || opt >= p.options.length) throw new Error('Pick one of the options.');
    const cur = db.poll_votes.find(v => v.poll_id === pollId && v.voter === me);
    if (cur && cur.opt === opt) db.poll_votes = db.poll_votes.filter(v => v !== cur);
    else if (cur) { cur.opt = opt; cur.voted_at = nowIso(); }
    else db.poll_votes.push({ poll_id: pollId, voter: me, opt, voted_at: nowIso() });
    this._save(db);
  }

  /** Row templates (one per recipient) for a conversation key. */
  _targets(db, key) {
    const { group, id } = parseKey(key);
    if (!group) { this._assertFriends(db, id); return [{ recipient: id, group_id: null, batch_id: null }]; }
    this._assertMember(db, id);
    const batch = uid();
    return this._memberIds(db, id).filter(u => u !== this.me.id).map(u => ({ recipient: u, group_id: id, batch_id: batch }));
  }

  /* — writes — */
  async getReactions(ids) {
    const db = this._db(), me = this.me.id, out = {};
    const blocked = this._blocked(db);
    const visible = new Set(db.messages.filter(m => ids.includes(m.id) && (m.sender === me || m.recipient === me) && !blocked.has(m.sender)).map(m => m.id));
    for (const r of db.reactions) if (visible.has(r.message_id) && !blocked.has(r.user_id)) (out[r.message_id] || (out[r.message_id] = [])).push({ user_id: r.user_id, emoji: r.emoji });
    return out;
  }

  async react(messageId, emoji) {
    const db = this._db(), me = this.me.id;
    const m = db.messages.find(x => x.id === messageId && (x.sender === me || x.recipient === me));
    if (!m) throw new Error('Not allowed.');
    const cur = db.reactions.find(r => r.message_id === messageId && r.user_id === me);
    if (cur && cur.emoji === emoji) db.reactions = db.reactions.filter(r => r !== cur);
    else if (cur) cur.emoji = emoji;
    else db.reactions.push({ message_id: messageId, user_id: me, emoji });
    this._save(db);
  }

  async sendText(key, body, reply = null) {
    const db = this._db();
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    const rows = this._targets(db, key).map(t => mk(this.me.id, t.recipient, 'text', { body: body.slice(0, 1000), ...extra, ...t }));
    db.messages.push(...rows); this._save(db);
    const { group, id } = parseKey(key);
    this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null);
  }

  async sendVoice(key, blob, duration, reply = null) {
    const db0 = this._db();
    const extra = reply ? { reply_to: reply.id || null, reply_preview: String(reply.preview || '').slice(0, 120) } : {};
    const rows = [];
    for (const t of this._targets(db0, key)) {
      const path = `${this.me.id}/${uid()}`;
      await mediaPut(path, blob);
      rows.push(mk(this.me.id, t.recipient, 'voice', { media_path: path, duration: Math.max(1, Math.min(120, Math.round(duration || 1))), ...extra, ...t }));
    }
    const db = this._db();
    db.messages.push(...rows); this._save(db);
    const { group, id } = parseKey(key);
    this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null);
  }

  /* — stories — */
  _canSeeStory(db, st) {
    const me = this.me.id;
    return st.user_id === me || (this._findFriendship(db, me, st.user_id) || {}).status === 'accepted';
  }
  async postStory(blob, kind, caption, duration, capY = 0.6, extra = {}) {
    const path = `${this.me.id}/${uid()}`;
    await mediaPut(path, blob);
    const db = this._db();
    db.stories.push({ id: uid(), user_id: this.me.id, kind, media_path: path, body: (caption || '').slice(0, 200), cap_y: capY, duration: duration || 5, created_at: nowIso(), fx: null, decor: [], from_roll: false, ...snapExtras(extra) });
    this._save(db);
  }
  async fetchStory(s) {
    const db = this._db(), cur = db.stories.find(x => x.id === s.id);
    if (!cur || !this._canSeeStory(db, cur)) throw new Error('This story is gone.');
    const blob = await mediaGet(cur.media_path);
    if (!blob) throw new Error('This story is gone.');
    return blob;
  }
  async viewStory(id) {
    const db = this._db(), me = this.me.id, st = db.stories.find(x => x.id === id);
    if (!st || st.user_id === me || !this._canSeeStory(db, st)) return;
    if (!db.story_views.some(v => v.story_id === id && v.viewer === me)) { db.story_views.push({ story_id: id, viewer: me, viewed_at: nowIso() }); this._save(db); }
  }
  async storyViewers(id) {
    const db = this._db(), st = db.stories.find(x => x.id === id);
    if (!st || st.user_id !== this.me.id) return [];
    const byId = Object.fromEntries(db.users.map(u => [u.id, u]));
    return db.story_views.filter(v => v.story_id === id).sort((a, b) => b.viewed_at.localeCompare(a.viewed_at))
      .map(v => ({ ...pub(byId[v.viewer] || { id: v.viewer, username: '?', display_name: 'Someone' }), viewed_at: v.viewed_at }));
  }
  async deleteStory(s) {
    const db = this._db(), st = db.stories.find(x => x.id === s.id && x.user_id === this.me.id);
    if (!st) return;
    db.stories = db.stories.filter(x => x !== st);
    db.story_views = db.story_views.filter(v => v.story_id !== st.id);
    mediaDel(st.media_path).catch(() => {});
    this._save(db);
  }

  /* — profile picture (kept as a small data URL in this demo) — */
  async setAvatar(blob) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
    const db = this._db(), u = db.users.find(x => x.id === this.me.id);
    u.avatar = url; this._save(db);
    this.me = pub(u);
    return this.me;
  }
  async removeAvatar() {
    const db = this._db(), u = db.users.find(x => x.id === this.me.id);
    delete u.avatar; this._save(db);
    this.me = pub(u);
    return this.me;
  }

  async fetchVoice(m) {
    const cur = this._db().messages.find(x => x.id === m.id);
    if (!cur || (cur.sender !== this.me.id && cur.recipient !== this.me.id)) throw new Error('This voice message is gone.');
    const blob = await mediaGet(cur.media_path);
    if (!blob) throw new Error('This voice message is gone.');
    return blob;
  }

  async setSaved(ids, saved) {
    const db = this._db(), me = this.me.id;
    for (const m of db.messages) {
      if (!ids.includes(m.id) || !isTextLike(m.kind) || (m.sender !== me && m.recipient !== me)) continue;
      if (saved && !m.saved_at) { m.saved_at = nowIso(); m.saved_by = me; }
      else if (!saved && m.saved_by === me) { m.saved_at = null; m.saved_by = null; }
    }
    this._save(db);
  }

  async updateName(name) {
    const n = String(name || '').trim().slice(0, 30);
    if (!n) throw new Error('Type a name first.');
    const db = this._db(), u = db.users.find(x => x.id === this.me.id);
    u.display_name = n; this._save(db);
    this.me = pub(u);
    return this.me;
  }

  async changePassword(current, next) {
    if (!next || next.length < 6) throw new Error('The new password needs at least 6 characters.');
    const db = this._db(), u = db.users.find(x => x.id === this.me.id);
    if (u.pw !== await hashPw(current)) throw new Error('Your current password is wrong.');
    u.pw = await hashPw(next); this._save(db);
  }

  async listBlocked() {
    const db = this._db(), set = this._blocked(db);
    return db.users.filter(u => set.has(u.id)).map(pub);
  }
  async blockByUsername(uname) {
    const n = String(uname).trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(n)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (n === this.me.username) throw new Error('You can’t block yourself 🙂');
    const u = this._db().users.find(x => x.username === n);
    if (!u) throw new Error(`Nobody has the username @${n}.`);
    return this.blockUser(u.id);
  }
  async blockUser(id) {
    const db = this._db(), me = this.me.id;
    if (id === me) throw new Error('Can’t block that person.');
    if (!db.blocks.some(b => b.blocker === me && b.blocked === id)) db.blocks.push({ blocker: me, blocked: id });
    db.friendships = db.friendships.filter(f => !((f.requester === me && f.addressee === id) || (f.requester === id && f.addressee === me)));
    this._save(db);
  }
  async unblockUser(id) {
    const db = this._db();
    db.blocks = db.blocks.filter(b => !(b.blocker === this.me.id && b.blocked === id));
    this._save(db);
  }

  async sendSnap(keys, blob, kind, caption, duration, capY = 0.6, extra = {}) {
    const ex = snapExtras(extra);
    for (const key of keys) {
      const templates = this._targets(this._db(), key);
      const rows = [];
      for (const t of templates) {
        const path = `${this.me.id}/${uid()}`;
        await mediaPut(path, blob);
        rows.push(mk(this.me.id, t.recipient, kind, { media_path: path, body: caption || '', duration, cap_y: capY, ...ex, ...t }));
      }
      const db = this._db();
      db.messages.push(...rows); this._save(db);
      // bots "look at" the snap a few seconds later, then react
      for (const r of rows.filter(x => isBot(x.recipient))) {
        setTimeout(() => {
          const d = this._db();
          const cur = d.messages.find(x => x.id === r.id);
          if (cur && !cur.opened_at) { cur.opened_at = nowIso(); }
          if (cur && Math.random() < 0.6) d.reactions.push({ message_id: cur.id, user_id: cur.recipient, emoji: pick(['❤️', '😂', '🔥', '👍']) });
          if (cur) this._save(d);
          mediaDel(r.media_path).catch(() => {});
        }, between(2500, 4000));
      }
      const { group, id } = parseKey(key);
      this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null, true);
    }
  }

  _botTextReact(botIds, gid, snap = false) {
    if (!botIds.length) return;
    const botId = pick(botIds);
    setTimeout(() => this._botSay(botId, pick(snap ? SNAP_REPLIES : TEXT_REPLIES), gid), between(snap ? 5200 : 1400, snap ? 7000 : 3200));
  }

  _botSay(botId, body, gid) {
    if (!this.me) return;
    const db = this._db();
    if (gid) {
      const batch = uid();
      for (const u of this._memberIds(db, gid)) {
        if (u !== botId && !isBot(u)) db.messages.push(mk(botId, u, 'text', { body, group_id: gid, batch_id: batch }));
      }
    } else {
      if (!this._findFriendship(db, this.me.id, botId)) return;
      db.messages.push(mk(botId, this.me.id, 'text', { body }));
    }
    this._save(db);
  }

  async fetchSnap(m) {
    const cur = this._db().messages.find(x => x.id === m.id);
    if (!cur || cur.recipient !== this.me.id || cur.opened_at) {
      const e = new Error('This snap is gone or was already opened.'); e.gone = true; throw e;
    }
    const blob = await mediaGet(cur.media_path);
    if (!blob) { const e = new Error('This snap is gone or was already opened.'); e.gone = true; throw e; }
    return blob;
  }

  async fetchSaved(m) {
    const cur = this._db().messages.find(x => x.id === m.id);
    if (!cur || !cur.saved_at || (cur.sender !== this.me.id && cur.recipient !== this.me.id)) throw new Error('This snap isn’t saved.');
    const blob = await mediaGet(cur.media_path);
    if (!blob) throw new Error('This saved snap is gone.');
    return blob;
  }

  async openSnap(id) {
    const db = this._db();
    const m = db.messages.find(x => x.id === id && x.recipient === this.me.id && !x.opened_at);
    if (m) { m.opened_at = nowIso(); this._save(db); }
  }

  async discardSnap(m) { if (m.recipient === this.me.id) await mediaDel(m.media_path); }

  async saveSnap(m, blob) {
    const path = `${this.me.id}/${uid()}`;
    await mediaPut(path, blob);
    const db = this._db();
    const cur = db.messages.find(x => x.id === m.id && x.recipient === this.me.id && x.opened_at && !x.saved_at
      && Date.now() - Date.parse(x.opened_at) <= SAVE_WINDOW_MS);
    if (!cur) { await mediaDel(path); throw new Error('It’s too late to save this snap (5 minute limit).'); }
    cur.media_path = path; cur.saved_at = nowIso(); cur.saved_by = this.me.id;
    this._save(db);
  }

  async markRead(key) {
    const db = this._db(), me = this.me.id, { group, id } = parseKey(key);
    let changed = false;
    for (const m of db.messages) {
      const mine = m.recipient === me && isTextLike(m.kind) && !m.read_at;
      if (mine && (group ? m.group_id === id : (!m.group_id && m.sender === id))) { m.read_at = nowIso(); changed = true; }
    }
    if (changed) this._save(db);
  }

  async addFriend(input) {
    const me = this.me, db = this._db();
    const uname = input.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(uname)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (uname === me.username) throw new Error('That’s your own username 🙂');
    const target = db.users.find(u => u.username === uname);
    if (!target) throw new Error(`Nobody has the username @${uname}.`);
    if (db.blocks.some(b => (b.blocker === me.id && b.blocked === target.id) || (b.blocker === target.id && b.blocked === me.id))) {
      throw new Error(`Couldn’t send a friend request to @${uname}.`);
    }
    const ex = this._findFriendship(db, me.id, target.id);
    if (ex) {
      if (ex.status === 'accepted') return `You’re already friends with @${uname}.`;
      if (ex.requester === me.id) return `Your request to @${uname} is still pending.`;
      ex.status = 'accepted'; this._save(db);
      return `You and @${uname} are now friends!`;
    }
    db.friendships.push({ id: uid(), requester: me.id, addressee: target.id, status: target.bot ? 'accepted' : 'pending' });
    this._save(db);
    return target.bot ? `You and @${uname} are now friends!` : `Friend request sent to @${uname}.`;
  }

  async respond(friendshipId, accept) {
    const db = this._db();
    if (accept) { const f = db.friendships.find(x => x.id === friendshipId); if (f) f.status = 'accepted'; }
    else db.friendships = db.friendships.filter(x => x.id !== friendshipId);
    this._save(db);
  }
  removeFriend(id) { return this.respond(id, false); }

  async createGroup(name, memberIds) {
    const db = this._db();
    const ids = [...new Set(memberIds)].filter(x => x !== this.me.id);
    if (!name.trim()) throw new Error('Give the group a name.');
    if (ids.length < 2) throw new Error('Pick at least 2 friends.');
    if (ids.length > MAX_GROUP_FRIENDS) throw new Error(`Groups can have up to ${MAX_GROUP_FRIENDS + 1} people.`);
    for (const id of ids) this._assertFriends(db, id);
    const gid = uid();
    db.groups.push({ id: gid, name: name.trim().slice(0, 40), created_by: this.me.id });
    for (const u of [this.me.id, ...ids]) db.members.push({ group_id: gid, user_id: u });
    this._save(db);
    return gid;
  }

  async leaveGroup(gid) {
    const db = this._db();
    db.members = db.members.filter(x => !(x.group_id === gid && x.user_id === this.me.id));
    if (!this._memberIds(db, gid).some(u => !isBot(u))) {
      db.groups = db.groups.filter(g => g.id !== gid);
      db.members = db.members.filter(x => x.group_id !== gid);
      db.messages = db.messages.filter(m => m.group_id !== gid);
    }
    this._save(db);
  }
}
