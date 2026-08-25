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

export function publicBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.BASE_WEB_URL || '';
}
