import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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
import { WEB_PASSWORD, signToken, verifyToken, signLinkToken, publicBaseUrl } from './auth.js';

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
    res.json({ ok: true, token: signToken(getBootOwnerTid() || '_legacy') });
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
      res.json({ ok: true, token: signToken(tid), tid, username: me?.username || '' });
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
      const { getBotUsername, isBotActive } = await import('./telegram-bot.js');
      if (isBotActive()) botUsername = getBotUsername() || '';
    } catch {}
    res.json({ masterPassword: !!WEB_PASSWORD, botUsername, publicUrl: publicBaseUrl() });
  });

  // One-time hand-off: Telegram bot mints a short token → web exchanges it
  // for a standard session bound to the SAME telegram id.
  app.post('/api/auth/exchange', (req, res) => {
    const tid = verifyToken(String(req.body?.token || ''));
    if (!tid) return res.status(401).json({ error: 'Invalid or expired login link' });
    res.json({ ok: true, token: signToken(tid), tid });
  });

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
      const { getBotUsername, isBotActive } = await import('./telegram-bot.js');
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
