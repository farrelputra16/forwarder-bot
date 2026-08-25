import fs from 'fs';

const DB_FILE = './channels.json';

// ── Hot-path optimized channel store ─────────────────────────────
// The scraper hits loadChannels() on EVERY incoming message. Reading and
// parsing JSON from disk each time blocked the event loop, adding latency
// to forwards. Now: in-memory object served instantly, revalidated against
// the file mtime (a cheap stat) so manual edits still show up, and writes
// are async + serialized (never block message handling, last-write-wins).

let _cache = null;
let _mtimeMs = 0;
let _writeChain = Promise.resolve();

function _refreshFromDisk() {
  let st;
  try { st = fs.statSync(DB_FILE); } catch {
    _cache = _cache || {};
    return _cache;
  }
  if (_cache === null || st.mtimeMs !== _mtimeMs) {
    try {
      _cache = JSON.parse(fs.readFileSync(DB_FILE));
      _mtimeMs = st.mtimeMs;
    } catch (e) {
      console.error('[Store] read failed:', e.message);
      _cache = _cache || {};
    }
  }
  return _cache;
}

export function loadChannels() {
  // Mutating the returned object does NOT persist until saveChannels() is called.
  return _refreshFromDisk();
}

export function saveChannels(channels) {
  _cache = channels;
  _writeChain = _writeChain.then(async () => {
    await fs.promises.writeFile(DB_FILE, JSON.stringify(channels));
    try { _mtimeMs = fs.statSync(DB_FILE).mtimeMs; } catch {}
  }).catch(e => console.error('[Store] write failed:', e.message));
  return _writeChain;
}

// Await this in tests/shutdown if durable state matters right now.
export function flushChannels() {
  return _writeChain;
}

export function channelTargets(info) {
  return info.targets || (info.target ? [info.target] : []);
}

// "@name", "https://t.me/name" → comparable key ("+hash" & numeric ids untouched)
export function normalizeIdentifier(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\/[^\s/]*\.?(telegram\.me|t\.me)\//i, '').replace(/^t\.me\//i, '');
  return s.replace(/^@/, '');
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
