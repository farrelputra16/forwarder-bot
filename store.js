import fs from 'fs';
import crypto from 'crypto';

const DB_FILE = './channels.json';
const SESSIONS_FILE = './sessions.json';

// ── Multi-user channel store (no external DB — plain JSON) ───────
// Shape v2: { __multi: true, users: { <telegramId>: { <source>: entry } } }
// Legacy flat files ({ source: entry }) are migrated once into the
// owner account (env session / first login).

let _cache = null;          // full parsed v2 object (users map lives at _cache.users)
let _mtimeMs = 0;
let _legacyOwner = null;    // tid that inherits pre-multi-user data
let _writeChain = Promise.resolve();

function _readDisk() {
  try {
    const st = fs.statSync(DB_FILE);
    if (_cache !== null && st.mtimeMs === _mtimeMs) return _cache;
    const raw = JSON.parse(fs.readFileSync(DB_FILE));
    _mtimeMs = st.mtimeMs;
    if (raw && raw.__multi && raw.users) {
      _cache = { __multi: true, users: raw.users };
    } else {
      // Legacy flat file → nest under the designated owner
      const owner = _legacyOwner || '_legacy';
      console.log(`[Store] Migrating legacy channels.json → user ${owner}`);
      _cache = { __multi: true, users: { [owner]: raw || {} } };
    }
    return _cache;
  } catch {
    _cache = _cache || { __multi: true, users: {} };
    return _cache;
  }
}

function _sanitizeUser(chs) {
  for (const k of Object.keys(chs)) {
    if (k === '[object Object]' || k === 'undefined' || k === 'null') {
      console.warn(`[Store] Dropping corrupt channel entry "${k}"`);
      delete chs[k];
      continue;
    }
    const v = chs[k];
    if (!v || typeof v !== 'object') { delete chs[k]; continue; }
    if (Array.isArray(v.targets)) {
      v.targets = v.targets
        .map(t => typeof t === 'string' ? t : (t && t.key) ? String(t.key) : String(t))
        .filter(t => t && t !== '[object Object]');
    }
    if (v.target != null && typeof v.target === 'object') {
      v.target = (v.target.key != null) ? String(v.target.key) : '';
      if (!v.target) delete v.target;
    }
  }
  return chs;
}

// Called once at boot with the env-session account id (may be null until
// the first real login, which then claims the legacy bucket).
export function initStore(legacyOwnerTid) {
  if (legacyOwnerTid) _legacyOwner = String(legacyOwnerTid);
  _readDisk();
}

export function loadUser(tid) {
  const db = _readDisk();
  const id = String(tid || '_legacy');
  if (!db.users[id]) db.users[id] = {};
  return _sanitizeUser(db.users[id]);
}

export function saveUser(tid, channels) {
  const db = _readDisk();
  _sanitizeUser(channels);
  db.users[String(tid || '_legacy')] = channels;
  _persist(JSON.stringify(db));
  return _writeChain;
}

export function deleteUser(tid) {
  const db = _readDisk();
  delete db.users[String(tid)];
  _persist(JSON.stringify(db));
  return _writeChain;
}

export function listUserIds() {
  return Object.keys(_readDisk().users);
}

export function flushStore() {
  return _writeChain;
}

function _persist(json) {
  _writeChain = _writeChain.then(async () => {
    await fs.promises.writeFile(DB_FILE, json);
    try { _mtimeMs = fs.statSync(DB_FILE).mtimeMs; } catch {}
  }).catch(e => console.error('[Store] write failed:', e.message));
}

// ── Per-user helpers kept for backward compatibility ─────────────
export function loadChannels(tid) { return loadUser(tid); }
export function saveChannels(channels, tid) { return saveUser(tid, channels); }

export function channelTargets(info) {
  return info.targets || (info.target ? [info.target] : []);
}

// "@name", "https://t.me/name" → comparable key ("+hash" & numeric ids untouched)
export function normalizeIdentifier(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\/[^\s/]*\.?(telegram\.me|t\.me)\//i, '').replace(/^t\.me\//i, '');
  return s.replace(/^@/, '');
}

// ── Telegram session store (replaces external DB entirely) ───────
// sessions.json: { <tid>: { session, apiId, apiHash, dc, username, updatedAt } }
export function getSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE)); } catch { return {}; }
}
export function getSession(tid) {
  return getSessions()[String(tid)] || null;
}
export function saveSession(tid, data) {
  const all = getSessions();
  all[String(tid)] = { ...all[String(tid)], ...data, updatedAt: Date.now() };
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2));
  return all[String(tid)];
}
export function deleteSession(tid) {
  const all = getSessions();
  delete all[String(tid)];
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2));
}

// ── In-memory activity feed (powers the web dashboard live view) ──
const ACTIVITY_MAX = 60;
let activity = [];

export function logActivity(type, text) {
  activity.unshift({ type, text, ts: Date.now() });
  if (activity.length > ACTIVITY_MAX) activity.length = ACTIVITY_MAX;
}

export function getActivity() {
  return activity.slice(0, ACTIVITY_MAX);
}
