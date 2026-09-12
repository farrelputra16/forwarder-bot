import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
  getAccessibleChannels,
  isConnected,
  addChannelListener,
  removeChannelListener,
  ensureAccessible,
  invalidateDialogsCache,
  getChannelPhotoBase64,
  initScraper,
  getBootOwnerTid,
} from './scraper.js';
import { loadUser, saveUser, deleteUser, channelTargets, logActivity, getActivity, normalizeIdentifier, getSession, saveSession, deleteSession } from './store.js';
import { getActiveCount } from './tracking.js';
import { WEB_PASSWORD, signToken, verifyToken, signLinkToken, signRefresh, verifyRefresh, verifyTelegramWidget, publicBaseUrl } from './auth.js';
import { config } from './config.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ── Pending interactive MTProto logins (API ID/Hash + OTP) ──────
const PENDING = new Map();

export function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // ── Legacy master password (owner scope; optional convenience) ──
  app.post('/api/login', (req, res) => {
    if (!WEB_PASSWORD) return res.status(400).json({ error: 'Master password disabled' });
    if (String(req.body?.password || '') !== WEB_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    const ownerTid = getBootOwnerTid() || '_legacy';
    let refresh = null;
    if (req.body?.remember !== false) {
      const deviceId = _registerDevice(ownerTid);
      refresh = signRefresh(ownerTid, deviceId);
    }
    res.json({ ok: true, token: signToken(ownerTid), refresh });
  });

  app.get('/api/auth/options', (req, res) => {
    res.json({ masterPassword: !!WEB_PASSWORD });
  });

  // ── Per-account Telegram login (API ID/Hash + phone + OTP) ─────
  app.post('/api/auth/start', async (req, res) => {
    const { apiId, apiHash, phone, dcId } = req.body || {};
    if (!apiId || !apiHash || !phone) return res.status(400).json({ error: 'apiId, apiHash, phone required' });
    try {
      const { Api } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const clientOpts = { connectionRetries: 3 };
      if (parseInt(dcId) > 0) clientOpts.dcId = parseInt(dcId);
      const client = new (await import('telegram')).TelegramClient(new StringSession(''), Number(apiId), String(apiHash), clientOpts);
      await client.connect();
      const sent = await client.invoke(new Api.auth.SendCode({
        phoneNumber: String(phone).trim(),
        apiId: Number(apiId),
        apiHash: String(apiHash),
        settings: new Api.CodeSettings({ allowFlashcall: true, currentNumber: true, appHash: '' }),
      }));
      const loginToken = crypto.randomUUID();
      PENDING.set(loginToken, {
        client, phone: String(phone).trim(),
        phoneCodeHash: sent.phoneCodeHash,
        apiId: Number(apiId), apiHash: String(apiHash),
        dcId: parseInt(dcId) || 0, state: 'code',
      });
      setTimeout(() => PENDING.delete(loginToken), 10 * 60 * 1000);
      res.json({ ok: true, loginToken });
    } catch (err) {
      const sec = err.seconds || (err.errorMessage === 'FLOOD' ? 300 : 0);
      if (sec > 0) return res.status(429).json({ error: `Telegram flood wait: ${Math.ceil(sec / 60)} min`, waitSeconds: sec });
      res.status(400).json({ error: err.errorMessage || err.message });
    }
  });

  app.post('/api/auth/verify', async (req, res) => {
    const { loginToken, code, password } = req.body || {};
    const st = PENDING.get(String(loginToken || ''));
    if (!st) return res.status(404).json({ error: 'Login session expired — start again' });
    try {
      const { Api } = await import('telegram');
      if (st.state === 'password') {
        const pwd = await st.client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import('telegram/Password.js');
        await st.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, String(password)) }));
      } else {
        await st.client.invoke(new Api.auth.SignIn({
          phoneNumber: st.phone, phoneCodeHash: st.phoneCodeHash, phoneCode: String(code),
        }));
      }
      const me = await st.client.getMe().catch(() => null);
      const sessionStr = st.client.session.save();
      await st.client.destroy().catch(() => {});

      // Register the persistent scraper client under this account
      const { tid } = await initScraper(sessionStr, { apiId: st.apiId, apiHash: st.apiHash, dcId: st.dcId });
      saveSession(tid, { session: sessionStr, apiId: st.apiId, apiHash: st.apiHash, dc: st.dcId || 0, username: me?.username || '' });

      // First real login claims any pre-multi-user data
      const chs = loadUser(tid);
      if (!Object.keys(chs).length) {
        const legacy = loadUser('_legacy');
        if (Object.keys(legacy).length) {
          console.log(`[Auth] ${tid} claimed legacy workspace`);
          saveUser(tid, legacy); deleteUser('_legacy');
        }
      }

      PENDING.delete(loginToken);
      logActivity('channel', `👤 @${me?.username || tid} logged in`);
      // Remember-me: register this browser as a revocable device
      let refresh = null;
      if (req.body?.remember !== false) {
        const deviceId = _registerDevice(tid);
        refresh = signRefresh(tid, deviceId);
      }
      res.json({ ok: true, token: signToken(tid), refresh, tid, username: me?.username || '' });
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        st.state = 'password';
        return res.json({ ok: true, twoFactor: true });
      }
      if (err.errorMessage === 'PHONE_CODE_INVALID' || err.errorMessage === 'PHONE_CODE_EXPIRED') {
        return res.status(400).json({ error: 'Invalid or expired code' });
      }
      if (err.errorMessage === 'PASSWORD_HASH_INVALID') return res.status(400).json({ error: 'Wrong 2FA password' });
      res.status(500).json({ error: err.errorMessage || err.message });
    }
  });

  // ── Auth middleware ────────────────────────────────────────────
  app.get('/api/auth/options', async (req, res) => {
    let botUsername = '';
    try {
      const { getBotUsername, isBotActive } = await import('./bot.js');
      if (isBotActive()) botUsername = getBotUsername() || '';
    } catch {}
    res.json({ masterPassword: !!WEB_PASSWORD, botUsername, publicUrl: publicBaseUrl() });
  });

  // Register a "remember me" device for an account and mint its refresh token
  const _registerDevice = (tid) => {
    const sess = getSession(tid) || {};
    const devices = sess.devices || {};
    const deviceId = 'd' + crypto.randomBytes(8).toString('hex');
    devices[deviceId] = { createdAt: Date.now() };
    saveSession(tid, { devices });
    return deviceId;
  };

  // One-time hand-off: Telegram bot mints a short token → web exchanges it
  // for a standard session bound to the SAME telegram id.
  app.post('/api/auth/exchange', (req, res) => {
    const tid = verifyToken(String(req.body?.token || ''));
    if (!tid) return res.status(401).json({ error: 'Invalid or expired login link' });
    const deviceId = _registerDevice(tid);
    res.json({ ok: true, token: signToken(tid), refresh: signRefresh(tid, deviceId), tid });
  });

  // Silent re-login from a remembered device — no OTP, no Telegram calls.
  app.post('/api/auth/refresh', (req, res) => {
    const dec = verifyRefresh(req.body?.refresh);
    if (!dec) return res.status(401).json({ error: 'Invalid refresh token' });
    const sess = getSession(dec.tid);
    const dev = sess?.devices?.[dec.deviceId];
    if (!dev) return res.status(401).json({ error: 'Device revoked — login again' });
    // sliding window: both tokens renewed on each use
    saveSession(dec.tid, { devices: { ...sess.devices, [dec.deviceId]: { ...dev, lastUsed: Date.now() } } });
    res.json({ ok: true, token: signToken(dec.tid), refresh: signRefresh(dec.tid, dec.deviceId), tid: dec.tid });
  });

  // Revoke a remembered device (logout / stolen device)
  app.post('/api/auth/revoke', (req, res) => {
    const dec = verifyRefresh(req.body?.refresh);
    if (!dec) return res.status(401).json({ error: 'Invalid refresh token' });
    const sess = getSession(dec.tid);
    if (sess?.devices?.[dec.deviceId]) {
      const devices = { ...sess.devices };
      delete devices[dec.deviceId];
      saveSession(dec.tid, { devices });
    }
    res.json({ ok: true });
  });

  // Telegram Login Widget — one click, zero credentials typed: Telegram itself
  // proves the account. No OTP, no flood risk. Works on localhost too.
  app.post('/api/auth/widget', (req, res) => {
    const d = req.body || {};
    const tid = verifyTelegramWidget(d, config.botToken);
    if (!tid) return res.status(401).json({ error: 'Invalid Telegram login — try again' });
    if (d.username) {
      try { const s = getSession(tid) || {}; if (!s.username) saveSession(tid, { username: String(d.username) }); } catch {}
    }
    const deviceId = _registerDevice(tid);
    logActivity('channel', `\u{1F464} @${d.username || tid} logged in (Telegram)`);
    res.json({ ok: true, token: signToken(tid), refresh: signRefresh(tid, deviceId), tid, username: d.username || '' });
  });

  // ── QR login: scan with the phone app, zero typing ──────────────
  // The QR token is rendered by the dashboard; Telegram's own app (already
  // logged in) approves it. No OTP, no flood. Works on localhost.
  const PENDING_QR = new Map();

  app.post('/api/auth/qr/start', async (req, res) => {
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) return res.status(400).json({ error: 'TELEGRAM_API_ID/HASH missing in server .env' });
    try {
      const { StringSession } = await import('telegram/sessions/index.js');
      const { TelegramClient } = await import('telegram');
      const QRCode = (await import('qrcode')).default;
      const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
      await client.connect();

      const loginToken = crypto.randomUUID();
      const rec = { client, apiId, apiHash, state: 'waiting', currentToken: '', sentToken: '', sessionStr: '', tid: '', error: '', pwResolve: null, startedAt: Date.now() };
      PENDING_QR.set(loginToken, rec);
      setTimeout(() => { PENDING_QR.delete(loginToken); client.destroy().catch(() => {}); }, 5 * 60 * 1000);

      rec.runner = (async () => {
        try {
          await client.signInUserWithQrCode({ apiId, apiHash }, {
            qrCode: async ({ token }) => {
              rec.currentToken = Buffer.from(token).toString('base64url');
              // hold until superseded (~20s) so the loop exports a fresh token
              await new Promise(r => setTimeout(r, 20_000));
            },
            password: async () => {
              rec.state = 'password';
              return new Promise((resolve, reject) => { rec.pwResolve = resolve; rec.pwReject = reject; });
            },
            onError: async () => false,
          });
          rec.state = 'done';
          rec.sessionStr = client.session.save();
          const me = await client.getMe().catch(() => null);
          rec.tid = me ? String(me.id) : '';
          rec.username = me?.username || '';
        } catch (e) {
          rec.state = 'error';
          rec.error = e.errorMessage || e.message || 'QR login failed';
        }
      })();
      // wait briefly for the first token so the response includes a QR
      for (let i = 0; i < 40 && !rec.currentToken && rec.state === 'waiting'; i++) {
        await new Promise(r => setTimeout(r, 250));
      }
      if (!rec.currentToken) {
        const err = rec.error || 'Timed out waiting for QR token';
        PENDING_QR.delete(loginToken);
        await client.destroy().catch(() => {});
        return res.status(500).json({ error: err });
      }
      const qr = await QRCode.toDataURL('tg://login?token=' + rec.currentToken, { width: 280, margin: 1 });
      rec.sentToken = rec.currentToken;
      res.json({ ok: true, loginToken, qr });
    } catch (e) {
      res.status(500).json({ error: e.errorMessage || e.message });
    }
  });

  app.get('/api/auth/qr/status', async (req, res) => {
    const rec = PENDING_QR.get(String(req.query.loginToken || ''));
    if (!rec) return res.status(404).json({ error: 'QR session expired — start again' });
    try {
      if (rec.state === 'password') return res.json({ ok: true, status: 'password' });
      if (rec.state === 'error') { PENDING_QR.delete(String(req.query.loginToken)); return res.status(400).json({ error: rec.error }); }
      if (rec.state === 'done') {
        PENDING_QR.delete(String(req.query.loginToken));
        if (!rec.sessionStr || !rec.tid) return res.status(400).json({ error: 'Login incomplete — try again' });
        const { tid } = await initScraper(rec.sessionStr, { apiId: rec.apiId, apiHash: rec.apiHash, dcId: 0 });
        saveSession(tid, { session: rec.sessionStr, apiId: rec.apiId, apiHash: rec.apiHash, dc: 0, username: rec.username || '' });
        try { await rec.client.destroy().catch(() => {}); } catch {}
        // first real login claims any legacy workspace
        if (!Object.keys(loadUser(tid)).length) {
          const legacy = loadUser('_legacy');
          if (Object.keys(legacy).length) { saveUser(tid, legacy); deleteUser('_legacy'); }
        }
        const deviceId = _registerDevice(tid);
        await addChannelListenerBulk(tid);
        logActivity('channel', `👤 @${rec.username || tid} logged in (QR)`);
        return res.json({ ok: true, status: 'done', token: signToken(tid), refresh: signRefresh(tid, deviceId), tid, username: rec.username || '' });
      }
      // still waiting — send a fresh QR only when the token rotated
      if (rec.currentToken && rec.currentToken !== rec.sentToken) {
        const QRCode = (await import('qrcode')).default;
        const qr = await QRCode.toDataURL('tg://login?token=' + rec.currentToken, { width: 280, margin: 1 });
        rec.sentToken = rec.currentToken;
        return res.json({ ok: true, status: 'waiting', qr });
      }
      return res.json({ ok: true, status: 'waiting' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/qr/password', (req, res) => {
    const rec = PENDING_QR.get(String(req.body?.loginToken || ''));
    if (!rec) return res.status(404).json({ error: 'QR session expired — start again' });
    if (rec.state !== 'password' || !rec.pwResolve) return res.status(400).json({ error: 'No password requested' });
    rec.pwResolve(String(req.body?.password || ''));
    rec.state = 'waiting';
    res.json({ ok: true });
  });

  // Register listeners for a freshly connected account
  async function addChannelListenerBulk(tid) {
    try {
      const chs = loadUser(tid);
      for (const src of Object.keys(chs)) await addChannelListener(src, tid).catch(() => {});
    } catch {}
  }

  app.use('/api', (req, res, next) => {
    const tid = verifyToken(req.headers['x-web-token']);
    if (!tid) return res.status(401).json({ error: 'unauthorized' });
    req.tid = tid;
    next();
  });

  app.get('/api/me', (req, res) => {
    const sess = getSession(req.tid);
    res.json({ tid: req.tid, username: sess?.username || '', isOwner: req.tid === getBootOwnerTid() });
  });

  // Deep link into the bot as THIS account — ids match on both sides.
  app.get('/api/bot/link', async (req, res) => {
    try {
      const { getBotUsername, isBotActive } = await import('./bot.js');
      const u = isBotActive() ? getBotUsername() : '';
      if (!u) return res.json({ url: '', error: 'Bot not active' });
      res.json({ url: `https://t.me/${u}?start=web_${req.tid}` });
    } catch { res.json({ url: '', error: 'Bot unavailable' }); }
  });

  // Mint a short-lived dashboard login link for the CURRENT account
  app.post('/api/web/login-link', (req, res) => {
    const base = publicBaseUrl();
    if (!base) return res.json({ ok: false, error: 'PUBLIC_URL/RENDER_EXTERNAL_URL not configured' });
    res.json({ ok: true, url: `${base.replace(/\/$/, '')}/?auth=${signLinkToken(req.tid)}` });
  });

  app.get('/api/status', async (req, res) => {
    const chs = loadUser(req.tid);
    const entries = Object.entries(chs);
    res.json({
      connected: isConnected(req.tid),
      user: { tid: req.tid, username: getSession(req.tid)?.username || '' },
      stats: {
        total: entries.length,
        active: entries.filter(([, v]) => v.active).length,
        extract: entries.filter(([, v]) => v.mode === 'extract').length,
        forward: entries.filter(([, v]) => v.mode !== 'extract').length,
        tracking: getActiveCount(),
      },
    });
  });

  app.get('/api/dialogs', async (req, res) => {
    try {
      if (!isConnected(req.tid)) return res.json({ connected: false, error: 'Your Telegram is not connected', channels: [] });
      const channels = await getAccessibleChannels(req.query.refresh === '1', req.tid);
      res.json({ connected: true, channels });
    } catch (err) {
      res.json({ connected: false, error: err.message, channels: [] });
    }
  });

  app.get('/api/channels', async (req, res) => {
    const chs = loadUser(req.tid);
    res.json(Object.entries(chs).map(([source, info]) => ({
      source,
      mode: info.mode || 'forward',
      targets: channelTargets(info),
      active: !!info.active,
      ignoreDuplicate: !!info.ignoreDuplicate,
      tracking: info.tracking ? {
        enabled: !!info.tracking.enabled,
        multipliers: info.tracking.multipliers || [],
        intervalHours: Math.round((info.tracking.interval || 3600) / 3600),
        xAlerts: info.tracking.xAlerts || 'on',
        periodic: info.tracking.periodic || 'on',
      } : null,
    })));
  });

  app.get('/api/activity', (req, res) => res.json(getActivity()));

  // Profile photo per channel (base64 JSON so the auth header still applies)
  app.get('/api/photo', async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const data = await getChannelPhotoBase64(id, req.tid);
      res.json({ ok: true, data });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Add channel: source + targets must be accessible by THIS account ──
  const verifyAccess = async (identifier, role, tid) => {
    try {
      return await ensureAccessible(identifier, tid);
    } catch (e) {
      const msg = e.message || '';
      if (/not connected/i.test(msg)) {
        throw Object.assign(new Error('Telegram not connected — cannot verify channel access'), { status: 503 });
      }
      throw Object.assign(new Error(`${role} "${identifier}" is not accessible by your Telegram account (${msg})`), { status: 400 });
    }
  };

  app.post('/api/channels', async (req, res) => {
    try {
      const { source, targets = [], mode = 'extract', tracking } = req.body || {};
      if (!source) return res.status(400).json({ error: 'Source channel required' });
      if (!targets.length) return res.status(400).json({ error: 'Pick at least one target' });
      if (!['extract', 'forward'].includes(mode)) return res.status(400).json({ error: 'Mode must be extract or forward' });

      const srcKey = await verifyAccess(source, 'Source', req.tid);

      const chs = loadUser(req.tid);
      if (chs[srcKey]) return res.status(400).json({ error: 'Channel already added' });

      const tKeys = [];
      for (const t of targets) {
        const k = await verifyAccess(t, 'Target', req.tid);
        if (k === srcKey) continue;
        if (!tKeys.includes(k)) tKeys.push(k);
      }
      if (!tKeys.length) return res.status(400).json({ error: 'Targets must differ from the source' });

      const entry = { mode, targets: tKeys, active: true };
      if (tracking?.enabled) {
        const h = Math.max(1, parseInt(tracking.intervalHours) || 1);
        entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: h * 3600, xAlerts: 'on', periodic: 'on' };
      }

      chs[srcKey] = entry;
      saveUser(req.tid, chs);
      invalidateDialogsCache(req.tid);

      let joined = false;
      try { joined = await addChannelListener(srcKey, req.tid); } catch (e) { console.error(`[Web] listen failed ${srcKey}:`, e.message); }
      logActivity('channel', `📡 Added ${srcKey} → ${tKeys.join(', ')}`);
      res.json({ success: true, source: srcKey, targets: tKeys, joined });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch('/api/channels/:ch', async (req, res) => {
    const chs = loadUser(req.tid);
    const info = chs[req.params.ch];
    if (!info) return res.status(404).json({ error: 'Channel not found' });
    const { action } = req.body || {};
    if (action === 'toggle') info.active = !info.active;
    else if (action === 'dup') {
      info.ignoreDuplicate = !info.ignoreDuplicate;
      if (info.ignoreDuplicate && !info.seenCAs) info.seenCAs = [];
    } else if (action === 'mode') info.mode = info.mode === 'extract' ? 'forward' : 'extract';
    else if (action === 'track-toggle') {
      if (info.tracking) info.tracking.enabled = !info.tracking.enabled;
      else info.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600, xAlerts: 'on', periodic: 'on' };
    } else return res.status(400).json({ error: 'Unknown action' });
    saveUser(req.tid, chs);
    logActivity('channel', `${info.active ? '🟢' : '⏸'} ${req.params.ch} ${action}`);
    res.json({ success: true });
  });

  app.post('/api/channels/:ch/targets', async (req, res) => {
    try {
      const { target } = req.body || {};
      if (!target) return res.status(400).json({ error: 'Target required' });
      const chs = loadUser(req.tid);
      const info = chs[req.params.ch];
      if (!info) return res.status(404).json({ error: 'Channel not found' });

      const tKey = await verifyAccess(target, 'Target', req.tid);
      if (tKey === req.params.ch) return res.status(400).json({ error: 'Target must differ from the source' });

      if (!info.targets) { info.targets = [info.target].filter(Boolean); delete info.target; }
      if (info.targets.includes(tKey)) return res.status(400).json({ error: 'Target already added' });
      info.targets.push(tKey);
      saveUser(req.tid, chs);
      invalidateDialogsCache(req.tid);
      logActivity('channel', `🎯 Target ${tKey} → ${req.params.ch}`);
      res.json({ success: true, targets: info.targets });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete('/api/channels/:ch/targets', (req, res) => {
    const chs = loadUser(req.tid);
    const info = chs[req.params.ch];
    if (!info) return res.status(404).json({ error: 'Channel not found' });
    const target = String(req.query.target || '');
    if (!info.targets) { info.targets = [info.target].filter(Boolean); delete info.target; }
    info.targets = info.targets.filter(t => t !== target);
    if (!info.targets.length) return res.status(400).json({ error: 'Channel needs at least one target' });
    saveUser(req.tid, chs);
    res.json({ success: true, targets: info.targets });
  });

  app.delete('/api/channels/:ch', async (req, res) => {
    const chs = loadUser(req.tid);
    if (!chs[req.params.ch]) return res.status(404).json({ error: 'Channel not found' });
    delete chs[req.params.ch];
    saveUser(req.tid, chs);
    removeChannelListener(req.params.ch, req.tid).catch(() => {});
    logActivity('channel', `🗑 Removed ${req.params.ch}`);
    res.json({ success: true });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[Web] error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  let port = parseInt(process.env.PORT);
  if (isNaN(port)) port = 3000;
  const server = app.listen(port, () => console.log(`[Web] Dashboard: http://0.0.0.0:${port}`));
  return server;
}
