import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
  getAccessibleChannels,
  isConnected,
  addChannelListener,
  removeChannelListener,
} from './scraper.js';
import { loadChannels, saveChannels, channelTargets, logActivity, getActivity, normalizeIdentifier } from './store.js';
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

  // ── Accessible dialogs — the ONLY selectable sources/targets ──
  async function accessibleSet() {
    const acc = await getAccessibleChannels();
    return { list: acc, set: new Set(acc.map(a => normalizeIdentifier(a.identifier))) };
  }
  const findAccessible = (accList, raw) =>
    accList.find(a => normalizeIdentifier(a.identifier) === normalizeIdentifier(raw)) || null;

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
      const channels = await getAccessibleChannels();
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

  // ── Add channel: source + targets MUST come from accessible set ──
  app.post('/api/channels', async (req, res) => {
    try {
      const { source, targets = [], mode = 'extract', tracking } = req.body || {};
      if (!source) return res.status(400).json({ error: 'Source channel required' });
      if (!targets.length) return res.status(400).json({ error: 'Pick at least one target' });
      if (!['extract', 'forward'].includes(mode)) return res.status(400).json({ error: 'Mode must be extract or forward' });

      const chs = loadChannels();
      if (chs[source]) return res.status(400).json({ error: 'Channel already added' });

      let acc;
      try { acc = await accessibleSet(); }
      catch { return res.status(503).json({ error: 'Telegram not connected — cannot verify channel access' }); }
      const { list, set } = acc;
      const src = findAccessible(list, source);
      if (!src) return res.status(400).json({ error: `Source "${source}" is not accessible by your Telegram account` });
      const bad = targets.filter(t => !set.has(normalizeIdentifier(t)));
      if (bad.length) return res.status(400).json({ error: `Target(s) not accessible: ${bad.join(', ')}` });

      const entry = { mode, targets, active: true };
      if (tracking?.enabled) {
        const h = Math.max(1, parseInt(tracking.intervalHours) || 1);
        entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: h * 3600, xAlerts: 'on', periodic: 'on' };
      }

      // Store under the resolved identifier (username when public, marked id when private)
      const key = src.identifier;
      chs[key] = entry;
      saveChannels(chs);

      let joined = false;
      try { joined = await addChannelListener(key); } catch (e) { console.error(`[Web] listen failed ${key}:`, e.message); }
      logActivity('channel', `📡 Added ${key} → ${targets.join(', ')}`);
      res.json({ success: true, source: key, joined });
    } catch (err) {
      res.status(500).json({ error: err.message });
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

      let acc;
      try { acc = await accessibleSet(); }
      catch { return res.status(503).json({ error: 'Telegram not connected — cannot verify channel access' }); }
      const { list, set } = acc;
      const t = findAccessible(list, target);
      if (!t) return res.status(400).json({ error: `Target "${target}" is not accessible by your Telegram account` });

      if (!info.targets) { info.targets = [info.target].filter(Boolean); delete info.target; }
      if (info.targets.includes(t.identifier)) return res.status(400).json({ error: 'Target already added' });
      info.targets.push(t.identifier);
      saveChannels(chs);
      logActivity('channel', `🎯 Target ${t.identifier} → ${req.params.ch}`);
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
