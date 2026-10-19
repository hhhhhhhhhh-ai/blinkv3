/**
 * Short-lived local copy of snaps you just opened, so "Save in chat" still works for a few minutes
 * after the snap itself is gone from the server. Everything is wiped after the save window.
 */
import { SAVE_WINDOW_MS } from './backend.js';

let dbp;
const open = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open('blink-recent', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('r');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction('r', mode);
    const req = fn(t.objectStore('r'));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
};

const ids = new Map();   // message id → time it was opened (ms), mirrors the store for synchronous checks

export const recent = {
  /** Remember a snap that was just opened. */
  async put(id, blob) {
    ids.set(id, Date.now());
    try { await tx('readwrite', s => s.put({ blob, at: Date.now() }, id)); } catch { /* private mode: memory only */ this._mem = this._mem || new Map(); this._mem.set(id, blob); }
  },
  /** Can this snap still be saved (synchronous, based on the local copy)? */
  has(id) {
    const at = ids.get(id);
    return !!at && Date.now() - at <= SAVE_WINDOW_MS;
  },
  async get(id) {
    if (!this.has(id)) return null;
    try {
      const r = await tx('readonly', s => s.get(id));
      if (r && r.blob) return r.blob;
    } catch { /* fall through */ }
    return (this._mem && this._mem.get(id)) || null;
  },
  async drop(id) {
    ids.delete(id);
    if (this._mem) this._mem.delete(id);
    try { await tx('readwrite', s => s.delete(id)); } catch { /* ignore */ }
  },
  /** Load the ids that are still valid and delete everything older than the window. */
  async purge() {
    try {
      const db = await open();
      await new Promise(res => {
        const t = db.transaction('r', 'readwrite'), s = t.objectStore('r');
        const req = s.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          const v = c.value;
          if (!v || Date.now() - v.at > SAVE_WINDOW_MS) c.delete(); else ids.set(c.key, v.at);
          c.continue();
        };
        t.oncomplete = res; t.onerror = res;
      });
    } catch { /* ignore */ }
    for (const [k, at] of ids) if (Date.now() - at > SAVE_WINDOW_MS) ids.delete(k);
  },
  clear() { ids.clear(); open().then(() => tx('readwrite', s => s.clear())).catch(() => {}); },
};
