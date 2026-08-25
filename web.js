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
} from './scraper.js';
import { loadChannels, saveChannels, channelTargets, logActivity, getActivity } from './store.js';
import { getActiveCount } from './tracking.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const statelessToken = () =>
  crypto.createHmac('sha256', 'forwarder-web').update(WEB_PASSWORD).digest('hex');

export function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // ── Auth (only when WEB_PASSWORD is set) ──
  app.post('/api/login', (req, res) => {
    if (!WEB_PASSWORD) return res.json({ ok: true, token: '' });
    if (String(req.body?.password || '') === WEB_PASSWORD) return res.json({ ok: true, token: statelessToken() });
    res.status(401).json({ ok: false, error: 'Wrong password' });
  });

  app.use('/api', (req, res, next) => {
    if (!WEB_PASSWORD) return next();
    if ((req.headers['x-web-token'] || '') === statelessToken()) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/api/status', async (req, res) => {
    const chs = loadChannels();
    const entries = Object.entries(chs);
    res.json({
      connected: isConnected(),
      passwordRequired: !!WEB_PASSWORD,
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
      if (!isConnected()) return res.json({ connected: false, error: 'Telegram not connected', channels: [] });
      const channels = await getAccessibleChannels(req.query.refresh === '1');
      res.json({ connected: true, channels });
    } catch (err) {
      res.json({ connected: false, error: err.message, channels: [] });
    }
  });

  app.get('/api/channels', async (req, res) => {
    const chs = loadChannels();
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
      const data = await getChannelPhotoBase64(id);
      res.json({ ok: true, data }); // data may be '' when the channel has no photo
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Add channel: source + targets must be ACCESSIBLE (dialog list OR live
  //    resolve/join — so pasted @usernames / t.me links / +invites work too) ──
  // Returns a PLAIN STRING canonical identifier (never wrap it in an object).
  const verifyAccess = async (identifier, role) => {
    try {
      return await ensureAccessible(identifier);
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

      const srcKey = await verifyAccess(source, 'Source');

      const chs = loadChannels();
      if (chs[srcKey]) return res.status(400).json({ error: 'Channel already added' });

      // Resolve every target to its canonical key; dedupe & drop self-target
      const tKeys = [];
      for (const t of targets) {
        const k = await verifyAccess(t, 'Target');
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
      saveChannels(chs);
      invalidateDialogsCache();

      let joined = false;
      try { joined = await addChannelListener(srcKey); } catch (e) { console.error(`[Web] listen failed ${srcKey}:`, e.message); }
      logActivity('channel', `📡 Added ${srcKey} → ${tKeys.join(', ')}`);
      res.json({ success: true, source: srcKey, targets: tKeys, joined });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Per-channel actions ──
  app.patch('/api/channels/:ch', async (req, res) => {
    const chs = loadChannels();
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
    saveChannels(chs);
    logActivity('channel', `${info.active ? '🟢' : '⏸'} ${req.params.ch} ${action}`);
    res.json({ success: true });
  });

  app.post('/api/channels/:ch/targets', async (req, res) => {
    try {
      const { target } = req.body || {};
      if (!target) return res.status(400).json({ error: 'Target required' });
      const chs = loadChannels();
      const info = chs[req.params.ch];
      if (!info) return res.status(404).json({ error: 'Channel not found' });

      const tKey = await verifyAccess(target, 'Target');
      if (tKey === req.params.ch) return res.status(400).json({ error: 'Target must differ from the source' });

      if (!info.targets) { info.targets = [info.target].filter(Boolean); delete info.target; }
      if (info.targets.includes(tKey)) return res.status(400).json({ error: 'Target already added' });
      info.targets.push(tKey);
      saveChannels(chs);
      invalidateDialogsCache();
      logActivity('channel', `🎯 Target ${tKey} → ${req.params.ch}`);
      res.json({ success: true, targets: info.targets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/channels/:ch/targets', (req, res) => {
    const chs = loadChannels();
    const info = chs[req.params.ch];
    if (!info) return res.status(404).json({ error: 'Channel not found' });
    const target = String(req.query.target || '');
    if (!info.targets) { info.targets = [info.target].filter(Boolean); delete info.target; }
    info.targets = info.targets.filter(t => t !== target);
    if (!info.targets.length) return res.status(400).json({ error: 'Channel needs at least one target' });
    saveChannels(chs);
    res.json({ success: true, targets: info.targets });
  });

  app.delete('/api/channels/:ch', async (req, res) => {
    const chs = loadChannels();
    if (!chs[req.params.ch]) return res.status(404).json({ error: 'Channel not found' });
    delete chs[req.params.ch];
    saveChannels(chs);
    removeChannelListener(req.params.ch).catch(() => {});
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
