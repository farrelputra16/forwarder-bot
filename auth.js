import fs from 'fs';
import * as crypto from 'crypto';

// Shared HMAC auth used by BOTH the web dashboard and the Telegram bot,
// so each side can mint/verify tokens for the same accounts.

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const LINK_TTL = 5 * 60 * 1000;
export const WEB_PASSWORD = process.env.WEB_PASSWORD || '';

const SECRET = (() => {
  const pw = process.env.WEB_PASSWORD;
  if (pw) return pw;
  try { return fs.readFileSync('./.web_secret', 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync('./.web_secret', s); } catch {}
  return s;
})();

function _sig(tid, exp) {
  return crypto.createHmac('sha256', SECRET).update(`${tid}.${exp}`).digest('hex').slice(0, 32);
}

export function signToken(tid, exp = Date.now() + SESSION_TTL) {
  return `${tid}.${exp}.${_sig(tid, exp)}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [tid, exp] = parts;
  if (!tid || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  return _sig(tid, exp) === parts[2] ? tid : null;
}

// Short-lived cross-app login token (Telegram bot → web hand-off)
export function signLinkToken(tid) {
  return signToken(tid, Date.now() + LINK_TTL);
}

// ── Long-lived device refresh tokens ("remember me") ────────────
// Format: r.<tid>.<deviceId>.<exp>.<sig> — revocable by deleting the
// device record server-side, so a lost laptop can be logged out remotely.
const REFRESH_TTL = 180 * 24 * 3600 * 1000; // 180 days

export function signRefresh(tid, deviceId, exp = Date.now() + REFRESH_TTL) {
  const sig = crypto.createHmac('sha256', SECRET).update(`r:${tid}:${deviceId}:${exp}`).digest('hex').slice(0, 32);
  return `r.${tid}.${deviceId}.${exp}.${sig}`;
}

export function verifyRefresh(token) {
  const p = String(token || '').split('.');
  if (p.length !== 5 || p[0] !== 'r') return null;
  const [, tid, deviceId, exp] = p;
  if (!tid || !deviceId || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const sig = crypto.createHmac('sha256', SECRET).update(`r:${tid}:${deviceId}:${exp}`).digest('hex').slice(0, 32);
  return sig === p[4] ? { tid, deviceId } : null;
}

// ── Telegram Login Widget verification ──────────────────────────
// Proves account ownership with ZERO credentials typed: Telegram signs
// {id, first_name, …, auth_date} with HMAC-SHA256 keyed by the bot token.
// Pure function — unit-testable, no network.
export function verifyTelegramWidget(data, botToken, maxAgeSec = 86400) {
  try {
    if (!data || !botToken || !data.id || !data.hash || !data.auth_date) return null;
    const age = Math.abs(Date.now() / 1000 - Number(data.auth_date));
    if (!Number.isFinite(age) || age > maxAgeSec) return null; // stale / replay
    const check = Object.keys(data)
      .filter(k => k !== 'hash' && data[k] !== undefined && data[k] !== null && data[k] !== '')
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join('\n');
    const secret = crypto.createHash('sha256').update(String(botToken)).digest();
    const hmac = crypto.createHmac('sha256', secret).update(check).digest('hex');
    const a = Buffer.from(hmac, 'hex');
    const b = Buffer.from(String(data.hash).toLowerCase(), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return String(data.id);
  } catch {
    return null;
  }
}

export function publicBaseUrl() {
  // Lokal: kosongkan env → otomatis localhost. Hosting (Render) isi sendiri.
  return process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.BASE_WEB_URL || `http://localhost:${process.env.PORT || 3000}`;
}
