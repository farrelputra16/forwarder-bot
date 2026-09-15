import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { addChannelListener, resolveChain, fetchTokenInfo, formatTokenSummary, getStateExact, getBootOwnerTid, listClients, ensureAccessible, getAccessibleChannels, initScraper } from './scraper.js';
import { updateTrackingPeriodicStatus, updateTrackingXStatus } from './tracking.js';
import { loadUser, saveUser, saveSession, deleteUser } from './store.js';
import { signLinkToken, publicBaseUrl } from './auth.js';

// Workspace scope: the bot user's OWN account when it exists in the store
// (same telegram id as a web login), else the boot/owner account.
function curTid(ctx) {
  const id = String(ctx?.from?.id || '');
  if (id && (getStateExact(id) || Object.keys(loadUser(id)).length)) return id;
  return getBootOwnerTid();
}

// Satu baris status scraper — ditempel di /start, menu, dashboard.
function scraperStatusLine() {
  let cs = [];
  try { cs = listClients().filter(s => { try { return s.client && s.client.connected; } catch { return false; } }); } catch {}
  if (!cs.length) return `\n\n⚠️ *Scraper OFFLINE* — forwarding is down.\nOn the server run: \`npm run login\``;
  return `\n\n🟢 Scraper: ${cs.map(s => '@' + (s.username || s.tid)).join(', ')}`;
}

export const bot = new Telegraf(config.botToken);

// Bot API identity (ready after launch). Web dashboard uses this for the
// Telegram Login Widget + deep links — no manual login needed.
export function getBotUsername() {
  try { return bot.botInfo?.username || ''; } catch { return ''; }
}
export function isBotActive() {
  try { return !!bot.botInfo; } catch { return false; }
}

const userState = new Map();
const PER_PAGE = 5;

function targets(info) {
  return info.targets ? info.targets.join(', ') : info.target || 'Default';
}

function stLabel(s) {
  if (s === 'paused') return '⏸ Paused';
  if (s === 'off') return '❌ Off';
  return '🟢 On';
}

function detail(ch, info) {
  const lines = [
    `📡 \`${ch}\``,
    '',
    `┃ Mode: ${info.mode === 'extract' ? '📋 Extract CA' : '📨 Forward All'}`,
    `┃ Targets: ${targets(info)}`,
    `┃ Status: ${info.active ? '🟢 Active' : '🔴 Paused'}`,
    `┃ Duplicate: ${info.ignoreDuplicate ? '✅ Ignored' : '❌ Pass Through'}`
  ];
  if (info.tracking?.enabled) {
    lines.push(`┃ Tracking: 📊 ON (${info.tracking.multipliers.join('X/')}X, ${info.tracking.interval / 3600}h)`);
    lines.push(`┃ X Alerts: ${stLabel(info.tracking.xAlerts)}  ·  🔄 Update: ${stLabel(info.tracking.periodic)}`);
  }
  return lines.join('\n');
}

function navRow(page, total, prefix) {
  const row = [];
  if (page > 0) row.push({ text: '◀️ Prev', callback_data: `${prefix}_${page - 1}` });
  row.push({ text: `📍 ${page + 1}/${total}`, callback_data: 'noop' });
  if (page < total - 1) row.push({ text: 'Next ▶️', callback_data: `${prefix}_${page + 1}` });
  return row;
}

function cycleLabel(what, s) {
  if (s === 'on') return `⏸ Pause ${what}`;
  if (s === 'paused') return `❌ Off ${what}`;
  return `🟢 On ${what}`;
}

function manageKb(ch, info) {
  const rows = [
    [
      { text: info.active ? '⏸ Pause' : '▶️ Resume', callback_data: `toggle_${ch}` },
      { text: info.ignoreDuplicate ? '🔁 Dup ON' : '🔁 Dup OFF', callback_data: `toggledup_${ch}` }
    ]
  ];
  if (info.tracking?.enabled) {
    rows.push([
      { text: cycleLabel('X Alerts', info.tracking.xAlerts), callback_data: `cyclex_${ch}` },
      { text: cycleLabel('Updates', info.tracking.periodic), callback_data: `cyclep_${ch}` }
    ]);
  }
  rows.push([
    { text: info.mode === 'extract' ? '📨 Switch to Forward' : '📋 Switch to Extract', callback_data: `switchmode_${ch}` },
    { text: '🎯 Add Target', callback_data: `addtarget_${ch}` }
  ]);
  const tgts = info.targets || (info.target ? [info.target] : []);
  if (tgts.length > 1) {
    rows.push(tgts.slice(0, 4).map((t, i) => ({ text: `❌ ${shortTitle(t, 12)}`, callback_data: `rmtgt_${ch}_${i}` })));
  }
  rows.push([
    { text: '🗑 Delete', callback_data: `delete_${ch}` },
    { text: '◀️ Channels', callback_data: 'list_channels_0' }
  ]);
  return { reply_markup: { inline_keyboard: rows } };
}

function menuKb(ctx) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📡 My Channels', callback_data: 'list_channels_0' }],
        [{ text: '➕ Add Channel', callback_data: 'add_channel' }],
        [{ text: '🌐 Open Dashboard (auto-login)', callback_data: 'open_web' }],
        [{ text: '📊 Dashboard', callback_data: 'dashboard' }],
        [{ text: '🔑 Connect Account', callback_data: 'login_start' }],
        [{ text: '❓ Help', callback_data: 'help' }]
      ]
    }
  };
}

// ── Start / Menu ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const chs = loadUser(curTid(ctx));
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;

  // Deep link from the web dashboard: ?start=web_<tid> — confirm the handshake
  // when the sender IS that account (ids match on both sides).
  let linkNote = '';
  if (String(ctx.payload || '') === `web_${ctx.from.id}`) {
    linkNote = `\n\n🔗 *Connected to your web dashboard!* Same account, same channels.`;
  }

  await ctx.reply(
    `👋 *Welcome to Forwarder Bot*\n\nI help you forward messages from Telegram channels — extract contract addresses or forward entire messages to your target channels.\n\n📡 ${a}/${e.length} channels active${linkNote}${scraperStatusLine()}`,
    { parse_mode: 'Markdown', ...menuKb(ctx) }
  );
});

// ── Open Web Dashboard (auto-login hand-off) ─────────────────────
bot.action('open_web', async (ctx) => {
  const base = publicBaseUrl().replace(/\/$/, '');
  const token = signLinkToken(String(ctx.from.id));
  // Telegram rejects localhost URLs in buttons — send a paste-able code instead.
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    await ctx.editMessageText(
      `🌐 *Web Dashboard — local login*\n━━━━━━━━━━━━━━━━━━━━\nURL buttons don't work for localhost, so copy this code and paste it in the dashboard (*Paste bot code* field):\n\n\`${token}\`\n\nValid for *5 minutes*, this account only.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]] } }
    );
    return;
  }
  await ctx.editMessageText(
    `🌐 *Web Dashboard*\n━━━━━━━━━━━━━━━━━━━━\nTap the button below — the dashboard opens **already logged in as this account**.\n\n🔗 Login link valid for *5 minutes*.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🌐 Open Dashboard', url: `${base}/?auth=${token}` }],
        [{ text: '🏠 Menu', callback_data: 'menu' }]
      ] }
    }
  );
});

bot.action('menu', async (ctx) => {
  const chs = loadUser(curTid(ctx));
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;
  await ctx.editMessageText(
    `🤖 *Forwarder Bot*\n\n📡 ${a}/${e.length} channels active${scraperStatusLine()}`,
    { parse_mode: 'Markdown', ...menuKb(ctx) }
  );
});

bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// ── Dashboard ────────────────────────────────────────────────────

bot.action('dashboard', async (ctx) => {
  const chs = loadUser(curTid(ctx));
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;
  const p = e.length - a;
  const ext = e.filter(([, v]) => v.mode === 'extract').length;
  const fwd = e.filter(([, v]) => v.mode !== 'extract').length;
  const trk = e.filter(([, v]) => v.tracking?.enabled).length;
  const dup = e.filter(([, v]) => v.ignoreDuplicate).length;

  await ctx.editMessageText(
    `📊 *Dashboard*\n━━━━━━━━━━━━━━━━━━━━\nTotal Channels: *${e.length}*\n🟢 Active: *${a}*  ·  🔴 Paused: *${p}*\n📋 Extract: *${ext}*  ·  📨 Forward: *${fwd}*\n📊 Tracking: *${trk}*  ·  🔁 Dup Ignore: *${dup}*\n━━━━━━━━━━━━━━━━━━━━${scraperStatusLine()}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'dashboard' }],
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      }
    }
  );
});

// ── Help ─────────────────────────────────────────────────────────

bot.action('help', async (ctx) => {
  await ctx.editMessageText(
    `❓ *Help & Commands*\n━━━━━━━━━━━━━━━━━━━━\n\n*/start* — Open main menu\n*/login* — Connect your Telegram account (tap-to-approve, no OTP typing)\n*/cancel* — Cancel the running process\n*/refresh \\<CA\\> [chain]* — Look up token info\n*/track \\<channel\\> \\<on|off\\>* — Toggle price tracking\n*/track\\_set \\<channel\\> \\<mults\\> \\<sec\\>* — Configure tracking\n\n💡 Use the buttons below to manage everything.\n━━━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      }
    }
  );
});

// ── Account Login (tap-to-approve, never type OTP codes) ──────────
// Security: Telegram permanently blocks login codes that are typed into
// any chat (anti-phishing). So this bot NEVER asks for OTP codes — login
// is approved by tapping a tg://login link (same mechanism as QR scan).
// Only the static 2FA cloud password may be typed here (auto-deleted).

// Build a tappable native login URL from a gramjs QR-login token.
export function buildTgLoginUrl(token) {
  const buf = Buffer.isBuffer(token) ? token : Buffer.from(token);
  return `tg://login?token=${buf.toString('base64url')}`;
}

const loginPending = new Map(); // tgUserId -> { client, apiId, apiHash, mode, done, pwResolve, pwReject, msgId, timer }
const LOGIN_TTL = 5 * 60 * 1000; // QR login links expire after ~5 min

function clearLogin(uid, destroy = true) {
  const st = loginPending.get(String(uid));
  if (!st) return;
  loginPending.delete(String(uid));
  if (st.timer) clearTimeout(st.timer);
  if (destroy) st.client?.destroy?.().catch(() => {});
}

async function finalizeBotLogin(ctx, st) {
  const uid = String(ctx.from.id);
  const me = await st.client.getMe().catch(() => null);
  // Isolation guard: the stored session MUST belong to this chat's sender.
  if (!me || String(me.id) !== uid) {
    try { await st.client.destroy().catch(() => {}); } catch {}
    clearLogin(uid, false);
    return ctx.reply('⚠️ Login must use the *same Telegram account* as this chat. Start over with /login.', { parse_mode: 'Markdown' });
  }
  const sessionStr = st.client.session.save();
  try { await st.client.destroy().catch(() => {}); } catch {}
  clearLogin(uid, false);

  const { tid } = await initScraper(sessionStr, { apiId: st.apiId, apiHash: st.apiHash, dcId: 0 });
  saveSession(tid, { session: sessionStr, apiId: st.apiId, apiHash: st.apiHash, dc: 0, username: me?.username || '' });
  if (!Object.keys(loadUser(tid)).length) {
    const legacy = loadUser('_legacy');
    if (Object.keys(legacy).length) { saveUser(tid, legacy); deleteUser('_legacy'); }
  }
  const chs = loadUser(tid);
  let n = 0;
  for (const src of Object.keys(chs)) {
    try { await addChannelListener(src, tid); n++; } catch {}
  }
  await ctx.reply(
    `✅ *Connected as @${me?.username || tid}!*\n\nThis account's scraper is active${n ? ` — ${n} channel(s) listening` : ''}.\nOpen the dashboard with the button below (auto-login, no password).`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🌐 Open Dashboard', callback_data: 'open_web' }], [{ text: '🏠 Menu', callback_data: 'menu' }]] },
    }
  );
}

async function startBotLogin(ctx, viaButton) {
  const uid = String(ctx.from.id);
  clearLogin(uid);
  userState.set(ctx.from.id, { step: 'LOGIN_API_ID' });
  const text =
    `🔑 *Connect Account — 1/3*\n\nSend your *API ID* (number, from my.telegram.org/apps).\n\nEach user logs in with their *own* credentials — nothing shared.\n\nCancel anytime: /cancel`;
  if (viaButton) await ctx.editMessageText(text, { parse_mode: 'Markdown' });
  else await ctx.reply(text, { parse_mode: 'Markdown' });
}

// Runs the QR-link login flow: Telegram shows its own approval screen,
// the user taps approve — no code is ever typed, so nothing can be blocked.
async function startQrLogin(ctx, apiId, apiHash) {
  const uid = String(ctx.from.id);
  clearLogin(uid);
  let client;
  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    client = new TelegramClient(new StringSession(''), Number(apiId), String(apiHash), { connectionRetries: 3 });
    await client.connect();
  } catch (err) {
    userState.delete(ctx.from.id);
    return ctx.reply(`⚠️ Connection failed: ${err.errorMessage || err.message}\n\nCheck the API ID/Hash, then /login again.`);
  }
  const rec = { client, apiId: Number(apiId), apiHash: String(apiHash), mode: 'qr', done: false, pwResolve: null, pwReject: null, msgId: null, timer: null };
  const timer = setTimeout(() => {
    if (loginPending.get(uid) === rec) {
      clearLogin(uid);
      userState.delete(ctx.from.id);
      ctx.reply('⚠️ Login link expired (5 min) — tap /login for a fresh one.').catch(() => {});
    }
  }, LOGIN_TTL);
  rec.timer = timer;
  loginPending.set(uid, rec);

  let statusMsg = null;
  try {
    statusMsg = await ctx.reply('🔑 *Connect Account — 3/3*\n\nGenerating your secure login link…', { parse_mode: 'Markdown' });
    rec.msgId = statusMsg?.message_id;
  } catch {}

  client.signInUserWithQrCode(
    { apiId: Number(apiId), apiHash: String(apiHash) },
    {
      qrCode: async ({ token }) => {
        if (loginPending.get(uid) !== rec || rec.done) return;
        const url = buildTgLoginUrl(token);
        const text =
          `🔑 *Connect Account — tap to approve*\n\n` +
          `Tap the button below. It opens Telegram's *own* login screen — approve it there. You type *nothing*.\n\n` +
          `⚠️ *Never type login codes into any chat* — Telegram blocks codes that get shared.`;
        const kb = { inline_keyboard: [[{ text: '✅ Approve Login', url }], [{ text: '🚫 Cancel', callback_data: 'login_cancel' }]] };
        try {
          if (rec.msgId) await ctx.telegram.editMessageText(ctx.chat.id, rec.msgId, undefined, text, { parse_mode: 'Markdown', reply_markup: kb });
          else {
            const m = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
            rec.msgId = m?.message_id;
          }
        } catch {}
      },
      password: async () => {
        if (loginPending.get(uid) !== rec) throw new Error('cancelled');
        userState.set(ctx.from.id, { step: 'LOGIN_PASSWORD' });
        await ctx.reply('🔐 This account uses *2FA*. Send your *cloud password*.\n\n_(I will auto-delete it.)_', { parse_mode: 'Markdown' }).catch(() => {});
        return new Promise((resolve, reject) => { rec.pwResolve = resolve; rec.pwReject = reject; });
      },
      onError: async () => true, // stop on error; reported below
    }
  ).then(async () => {
    if (loginPending.get(uid) !== rec || rec.done) return;
    rec.done = true;
    userState.delete(ctx.from.id);
    await finalizeBotLogin(ctx, rec);
  }).catch(async (err) => {
    if (loginPending.get(uid) !== rec || rec.done) return; // cancelled/timeout already handled
    if (/cancelled/i.test(err?.message || '')) return;
    clearLogin(uid);
    userState.delete(ctx.from.id);
    await ctx.reply(`⚠️ Login failed: ${err?.errorMessage || err?.message || 'unknown error'}\n\nTry /login again.`).catch(() => {});
  });
}

bot.action('login_cancel', async (ctx) => {
  const uid = String(ctx.from.id);
  const rec = loginPending.get(uid);
  if (rec) { try { rec.pwReject?.(new Error('cancelled')); } catch {} }
  clearLogin(uid);
  userState.delete(ctx.from.id);
  try { await ctx.answerCbQuery('Cancelled'); } catch {}
  await ctx.reply('🚫 Cancelled.').catch(() => {});
});

bot.action('login_start', (ctx) => startBotLogin(ctx, true));
bot.command('login', (ctx) => startBotLogin(ctx, false));
bot.command('cancel', (ctx) => {
  const rec = loginPending.get(String(ctx.from.id));
  if (rec) { try { rec.pwReject?.(new Error('cancelled')); } catch {} }
  clearLogin(ctx.from.id);
  userState.delete(ctx.from.id);
  ctx.reply('🚫 Cancelled.');
});

// ── Channel List (paginated) ─────────────────────────────────────

bot.action(/^list_channels_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  const chs = loadUser(curTid(ctx));
  const e = Object.entries(chs);
  const total = e.length;
  const tp = Math.ceil(total / PER_PAGE) || 1;
  const p = Math.min(page, tp - 1);
  const start = p * PER_PAGE;
  const pe = e.slice(start, start + PER_PAGE);

  const lines = [`📡 *My Channels* — Page ${p + 1}/${tp}\n━━━━━━━━━━━━━━━━━━━━`];
  for (let i = 0; i < pe.length; i++) {
    const [ch, info] = pe[i];
    const n = start + i + 1;
    const t = targets(info);
    const tr = info.tracking?.enabled ? ' 📊' : '';
    lines.push(`\n${n}. ${info.active ? '🟢' : '🔴'} \`${ch}\`${tr}`);
    lines.push(`   ${info.mode === 'extract' ? '📋' : '📨'} → ${t}`);
  }
  if (!pe.length) lines.push('\nNo channels yet. Tap ➕ below to add one!');

  const btns = [];
  const nr = navRow(p, tp, 'list_channels');
  if (nr.length) btns.push(nr);
  if (pe.length) {
    btns.push(pe.map(([ch]) => ({
      text: `✏️ ${ch.length > 25 ? ch.slice(0, 22) + '...' : ch}`,
      callback_data: `channel_${ch}`
    })));
  }
  btns.push([{ text: '➕ Add Channel', callback_data: 'add_channel' }]);
  btns.push([{ text: '🏠 Menu', callback_data: 'menu' }]);

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: btns }
  });
});

// ── Channel Detail / Manage ──────────────────────────────────────

bot.action(/^channel_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  const info = chs[ch];
  if (!info) return ctx.answerCbQuery('Not found');
  await ctx.editMessageText(detail(ch, info), {
    parse_mode: 'Markdown',
    ...manageKb(ch, info)
  });
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].active = !chs[ch].active;
  saveUser(curTid(ctx), chs);
  await ctx.answerCbQuery(chs[ch].active ? '▶️ Resumed' : '⏸ Paused');
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^toggledup_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].ignoreDuplicate = !chs[ch].ignoreDuplicate;
  if (!chs[ch].seenCAs) chs[ch].seenCAs = [];
  saveUser(curTid(ctx), chs);
  await ctx.answerCbQuery(chs[ch].ignoreDuplicate ? '✅ Dup Ignored' : '❌ Dup Pass Through');
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^switchmode_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].mode = chs[ch].mode === 'extract' ? 'forward' : 'extract';
  saveUser(curTid(ctx), chs);
  await ctx.answerCbQuery(`Mode: ${chs[ch].mode === 'extract' ? '📋 Extract' : '📨 Forward'}`);
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

function cycle(s) {
  return s === 'on' ? 'paused' : s === 'paused' ? 'off' : 'on';
}

bot.action(/^cyclex_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  const next = cycle(chs[ch].tracking?.xAlerts);
  if (!chs[ch].tracking) chs[ch].tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
  chs[ch].tracking.xAlerts = next;
  saveUser(curTid(ctx), chs);
  updateTrackingXStatus(chs[ch].targets || (chs[ch].target ? [chs[ch].target] : []), next, curTid(ctx));
  await ctx.answerCbQuery(`X Alerts: ${next === 'on' ? '🟢 On' : next === 'paused' ? '⏸ Paused' : '❌ Off'}`);
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^cyclep_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  const next = cycle(chs[ch].tracking?.periodic);
  if (!chs[ch].tracking) chs[ch].tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
  chs[ch].tracking.periodic = next;
  saveUser(curTid(ctx), chs);
  updateTrackingPeriodicStatus(chs[ch].targets || (chs[ch].target ? [chs[ch].target] : []), next, curTid(ctx));
  await ctx.answerCbQuery(`Updates: ${next === 'on' ? '🟢 On' : next === 'paused' ? '⏸ Paused' : '❌ Off'}`);
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^delete_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  await ctx.editMessageText(
    `⚠️ *Delete Channel*\n\nAre you sure you want to delete \`${ch}\`?\n\nThis cannot be undone.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗑 Yes, Delete', callback_data: `confirm_delete_${ch}` },
            { text: '↩️ Cancel', callback_data: `channel_${ch}` }
          ]
        ]
      }
    }
  );
});

bot.action(/^confirm_delete_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  delete chs[ch];
  saveUser(curTid(ctx), chs);
  await ctx.answerCbQuery('🗑 Deleted');
  await ctx.editMessageText(
    `🗑 *Deleted*\n\n\`${ch}\` has been removed.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📡 My Channels', callback_data: 'list_channels_0' }],
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      }
    }
  );
});

// ── Legacy manage_ prefix (backward compat) ──────────────────────

bot.action(/^manage_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  const info = chs[ch];
  if (!info) return ctx.answerCbQuery('Not found');
  await ctx.editMessageText(detail(ch, info), {
    parse_mode: 'Markdown',
    ...manageKb(ch, info)
  });
});

// ── Add Target from Manage ───────────────────────────────────────

bot.action(/^addtarget_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadUser(curTid(ctx));
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  userState.set(ctx.from.id, { step: 'ADD_TARGET', channel: ch });
  await ctx.editMessageText(
    `🎯 *Add Target*\n\nSend the target username for \`${ch}\`:\n(e.g. \`@targetchannel\`)`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('addtarget_done', (ctx) => {
  userState.delete(ctx.from.id);
  ctx.editMessageText('✅ Done.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📡 My Channels', callback_data: 'list_channels_0' }]
      ]
    }
  });
});

// ── Add Channel Wizard ───────────────────────────────────────────

bot.action('add_channel', (ctx) => {
  userState.set(ctx.from.id, { step: 'LINK' });
  ctx.editMessageText(
    `➕ *Add Channel — Step 1/4*\n\nSend the channel *link or username*.\n\nExamples:\n\`@channelname\`\n\`https://t.me/channelname\`\n\`https://t.me/+invitehash\`\n\n…or pick from channels your account has joined:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📋 Browse My Channels', callback_data: 'browse_src' }]] }
    }
  );
});

bot.action('target_add', (ctx) => {
  ctx.editMessageText(
    `➕ *Add Target*\n\nSend another target username:\n(e.g. \`@targetchannel\`)`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('target_done', (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;
  s.step = 'TRACKING';
  ctx.editMessageText(
    `➕ *Add Channel — Step 4/4*\n\nEnable *price tracking*?\n\nSends multiplier alerts (2X, 3X...) and periodic price updates for each CA.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, Enable', callback_data: 'track_yes' }],
          [{ text: '❌ No, Skip', callback_data: 'track_no' }]
        ]
      }
    }
  );
});

bot.action('track_yes', (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;
  s.tracking = true;
  s.step = 'INTERVAL';
  ctx.editMessageText(
    `➕ *Add Channel — Interval*\n\nEnter update interval in *hours* (e.g. \`1\`, \`6\`, \`12\`):`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('track_no', (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;
  s.tracking = false;
  s.step = 'TRACKING_FINAL';
  processTrackingFinal(ctx, s);
});

bot.action(/mode_(.+)/, (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;
  s.mode = ctx.match[1];
  s.step = 'TARGET';
  ctx.editMessageText(
    `➕ *Add Channel — Step 3/4*\n\nSend the *target channel username* where messages will be forwarded.\n(e.g. \`@targetchannel\`)\n\nMode: ${s.mode === 'extract' ? '📋 Extract CA' : '📨 Forward All'}`,
    { parse_mode: 'Markdown' }
  );
});

// ── Browse accessible dialogs (source/target picker) ─────────────
const browseCache = new Map(); // uid -> { list, ts }
const BROWSE_TTL = 5 * 60 * 1000;
const BROWSE_PER = 8;

async function getBrowseList(ctx) {
  const uid = ctx.from.id;
  const cached = browseCache.get(uid);
  if (cached && Date.now() - cached.ts < BROWSE_TTL) return cached.list;
  const list = await getAccessibleChannels(false, curTid(ctx));
  browseCache.set(uid, { list, ts: Date.now() });
  return list;
}

function browseKb(list, page, pickPrefix, navPrefix, picked = new Set(), extraRows = []) {
  const tp = Math.ceil(list.length / BROWSE_PER) || 1;
  const p = Math.min(Math.max(page, 0), tp - 1);
  const slice = list.slice(p * BROWSE_PER, p * BROWSE_PER + BROWSE_PER);
  const kb = [];
  for (let i = 0; i < slice.length; i++) {
    const d = slice[i];
    const idx = p * BROWSE_PER + i;
    const mark = picked.has(d.identifier) ? '✅ ' : '';
    kb.push([{ text: `${mark}${d.type === 'group' ? '👥' : '📢'} ${shortTitle(d.title || d.name)}`, callback_data: `${pickPrefix}_${idx}` }]);
  }
  const nr = navRow(p, tp, navPrefix);
  if (nr.length) kb.push(nr);
  for (const r of extraRows) kb.push(r);
  return kb;
}

async function renderBrowse(ctx, page, mode) {
  // mode: 'src' | 'tgt' | 'atgt'
  const titles = {
    src: '📋 *Pick Source* — channels your account has joined:',
    tgt: '🎯 *Pick Targets* — tap to toggle, then Done:',
    atgt: '🎯 *Pick Target* — tap one to add:',
  };
  const cfg = {
    src: ['picksrc', 'bsrc', [[{ text: '✍️ Type link instead', callback_data: 'browse_typelink' }]]],
    tgt: ['picktgt', 'btgt', [[{ text: '✅ Done', callback_data: 'tgtdone' }]]],
    atgt: ['pickatgt', 'batgt', []],
  }[mode];
  try {
    const list = await getBrowseList(ctx);
    if (!list.length) {
      return ctx.editMessageText('📭 No channels/groups found on this account.\nJoin some in Telegram first, then try again.', { parse_mode: 'Markdown' });
    }
    const s = userState.get(ctx.from.id) || {};
    if (mode === 'tgt') {
      // mark current picks
      const picked = new Set([...(s.targets || []), ...((s.pickSet instanceof Set) ? [...s.pickSet] : [])]);
      list._picked = picked;
    }
    await ctx.editMessageText(`${titles[mode]}\n\n_Page ${page + 1}/${Math.ceil(list.length / BROWSE_PER) || 1}_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: browseKb(list, page, cfg[0], cfg[1], cfg[2]) } });
  } catch (e) {
    await ctx.editMessageText(`⚠️ ${e.message}\n\nMake sure the scraper account is connected (\`npm run login\`).`, { parse_mode: 'Markdown' });
  }
}

bot.action('browse_src', (ctx) => {
  const s = userState.get(ctx.from.id) || {};
  s.step = 'LINK';
  userState.set(ctx.from.id, s);
  renderBrowse(ctx, 0, 'src');
});
bot.action(/^bsrc_(\d+)$/, (ctx) => renderBrowse(ctx, parseInt(ctx.match[1]), 'src'));
bot.action('browse_typelink', (ctx) => {
  const s = userState.get(ctx.from.id) || {};
  s.step = 'LINK';
  userState.set(ctx.from.id, s);
  ctx.editMessageText(`✍️ Send the channel *link or username*.\n\nExamples:\n\`@channelname\`\n\`https://t.me/channelname\`\n\`https://t.me/+invitehash\``, { parse_mode: 'Markdown' });
});
bot.action(/^picksrc_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  let list;
  try { list = await getBrowseList(ctx); } catch (e) { return ctx.answerCbQuery('⚠️ ' + e.message); }
  const d = list[idx];
  if (!d) return ctx.answerCbQuery('Gone — tap Browse again');
  const s = userState.get(ctx.from.id) || {};
  s.link = d.identifier;
  s.step = 'MODE';
  userState.set(ctx.from.id, s);
  await ctx.answerCbQuery(`✅ ${d.title || d.identifier}`);
  await ctx.editMessageText(
    `✅ Source: \`${d.identifier}\`\n\n➕ *Add Channel — Step 2/4*\n\nChoose forwarding mode:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Extract CA — token addresses only', callback_data: 'mode_extract' }],
          [{ text: '📨 Forward All — entire messages', callback_data: 'mode_forward' }]
        ]
      }
    }
  );
});

bot.action('browse_tgt', (ctx) => {
  const s = userState.get(ctx.from.id) || {};
  if (!s.pickSet) s.pickSet = new Set();
  s.pickPage = 0;
  userState.set(ctx.from.id, s);
  renderBrowse(ctx, 0, 'tgt');
});
bot.action(/^btgt_(\d+)$/, (ctx) => {
  const s = userState.get(ctx.from.id) || {};
  s.pickPage = parseInt(ctx.match[1]);
  userState.set(ctx.from.id, s);
  renderBrowse(ctx, s.pickPage, 'tgt');
});
bot.action(/^picktgt_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const s = userState.get(ctx.from.id) || {};
  if (!s.pickSet) s.pickSet = new Set();
  let list;
  try { list = await getBrowseList(ctx); } catch (e) { return ctx.answerCbQuery('⚠️ ' + e.message); }
  const d = list[idx];
  if (!d) return ctx.answerCbQuery('Gone — tap Browse again');
  if (d.identifier === s.link) return ctx.answerCbQuery('⚠️ Target must differ from source');
  if (s.pickSet.has(d.identifier)) { s.pickSet.delete(d.identifier); await ctx.answerCbQuery('➖ Removed'); }
  else { s.pickSet.add(d.identifier); await ctx.answerCbQuery(`✅ ${d.title || d.identifier}`); }
  userState.set(ctx.from.id, s);
  renderBrowse(ctx, s.pickPage || 0, 'tgt');
});
bot.action('tgtdone', async (ctx) => {
  const s = userState.get(ctx.from.id) || {};
  const picked = [...(s.pickSet instanceof Set ? [...s.pickSet] : [])].filter(t => t !== s.link && !(s.targets || []).includes(t));
  if (!s.targets) s.targets = [];
  s.targets.push(...picked);
  delete s.pickSet;
  userState.set(ctx.from.id, s);
  if (!picked.length && !s.targets.length) return ctx.answerCbQuery('Pick at least one target');
  await askMoreTargets(ctx, picked.length ? `${picked.length} picked: \`${picked.join(', ')}\`` : 'current selection');
});

bot.action('browse_atgt', (ctx) => renderBrowse(ctx, 0, 'atgt'));
bot.action(/^batgt_(\d+)$/, (ctx) => renderBrowse(ctx, parseInt(ctx.match[1]), 'atgt'));
bot.action(/^pickatgt_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const s = userState.get(ctx.from.id) || {};
  let list;
  try { list = await getBrowseList(ctx); } catch (e) { return ctx.answerCbQuery('⚠️ ' + e.message); }
  const d = list[idx];
  if (!d) return ctx.answerCbQuery('Gone — tap Browse again');
  const tid = curTid(ctx);
  const chs = loadUser(tid);
  const chKey = s.channel;
  if (!chKey || !chs[chKey]) return ctx.answerCbQuery('Channel gone');
  if (!chs[chKey].targets) { chs[chKey].targets = [chs[chKey].target].filter(Boolean); delete chs[chKey].target; }
  if (d.identifier === chKey) return ctx.answerCbQuery('⚠️ Target must differ from source');
  if (chs[chKey].targets.includes(d.identifier)) return ctx.answerCbQuery('Already added');
  chs[chKey].targets.push(d.identifier);
  saveUser(tid, chs);
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery(`✅ Target added`);
  await ctx.editMessageText(detail(chKey, chs[chKey]), { parse_mode: 'Markdown', ...manageKb(chKey, chs[chKey]) });
});

// ── Remove a single target from the manage screen ──
bot.action(/^rmtgt_(.+)_(\d+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const i = parseInt(ctx.match[2]);
  const tid = curTid(ctx);
  const chs = loadUser(tid);
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  if (!chs[ch].targets) { chs[ch].targets = [chs[ch].target].filter(Boolean); delete chs[ch].target; }
  if (chs[ch].targets.length <= 1) return ctx.answerCbQuery('⚠️ Channel needs at least one target');
  const gone = chs[ch].targets.splice(i, 1)[0];
  if (gone === undefined) return ctx.answerCbQuery('Not found');
  saveUser(tid, chs);
  await ctx.answerCbQuery(`🗑 Removed ${gone}`);
  await ctx.editMessageText(detail(ch, chs[ch]), { parse_mode: 'Markdown', ...manageKb(ch, chs[ch]) });
});

// ── Text Input (Wizard) ──────────────────────────────────────────

async function askMoreTargets(ctx, addedLabel) {
  const s = userState.get(ctx.from.id);
  await ctx.reply(
    `✅ Target added: ${addedLabel}\n\nAll targets: ${(s?.targets || []).join(', ') || '—'}\n\nAdd another target?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, add another', callback_data: 'target_add' }],
          [{ text: '📋 Browse My Channels', callback_data: 'browse_tgt' }],
          [{ text: '➡️ No, continue', callback_data: 'target_done' }]
        ]
      }
    }
  );
}

function shortTitle(t, n = 26) {
  t = String(t || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

bot.on('text', async (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;

  // ── Login wizard steps (didahulukan) ──
  // Each user brings their OWN API ID/Hash — the server never needs yours.
  if (s.step === 'LOGIN_API_ID') {
    const apiId = parseInt((ctx.message.text || '').trim());
    if (!apiId) return ctx.reply('⚠️ API ID must be a number. Try again, or /cancel to abort.');
    s.apiId = apiId;
    s.step = 'LOGIN_API_HASH';
    await ctx.reply('🔑 *Connect Account — 2/3*\n\nSend your *API Hash*.\n\n_(This message auto-deletes after reading.)_', { parse_mode: 'Markdown' });
    return;
  }
  if (s.step === 'LOGIN_API_HASH') {
    const apiHash = (ctx.message.text || '').trim();
    if (apiHash.length < 8) return ctx.reply('⚠️ Invalid API Hash. Try again, or /cancel to abort.');
    try { await ctx.deleteMessage().catch(() => {}); } catch {}
    userState.delete(ctx.from.id);
    await startQrLogin(ctx, s.apiId, apiHash);
    return;
  }

  if (s.step === 'LOGIN_PASSWORD') {
    // 2FA cloud password for the QR-link flow: pass it to the waiting
    // sign-in. gramjs re-invokes its password callback on a wrong password,
    // so the user is re-prompted automatically (state stays until success).
    const password = ctx.message.text || '';
    if (!password) return;
    const st = loginPending.get(String(ctx.from.id));
    if (!st || !st.pwResolve) { userState.delete(ctx.from.id); return ctx.reply('⚠️ Login session expired — /login again.'); }
    try { await ctx.deleteMessage().catch(() => {}); } catch {}
    const resolve = st.pwResolve;
    st.pwResolve = null;
    st.pwReject = null;
    resolve(String(password));
    return;
  }

  if (s.step === 'LINK') {
    const raw = (ctx.message.text || '').trim();
    if (!raw) return;
    await ctx.reply('🔍 Checking access…');
    try {
      s.link = await ensureAccessible(raw, curTid(ctx));
    } catch (e) {
      return ctx.reply(`⚠️ ${e.message}\n\nTry another link/username, or tap 📋 Browse to pick from your channels.`);
    }
    s.step = 'MODE';
    await ctx.reply(
      `✅ Source: \`${s.link}\`\n\n➕ *Add Channel — Step 2/4*\n\nChoose forwarding mode:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Extract CA — token addresses only', callback_data: 'mode_extract' }],
            [{ text: '📨 Forward All — entire messages', callback_data: 'mode_forward' }]
          ]
        }
      }
    );
  } else if (s.step === 'TARGET') {
    const raw = (ctx.message.text || '').trim();
    if (!raw) return;
    let key;
    try {
      key = await ensureAccessible(raw, curTid(ctx));
    } catch (e) {
      return ctx.reply(`⚠️ ${e.message}\n\nTry another target, or tap 📋 Browse to pick from your channels.`);
    }
    if (key === s.link) return ctx.reply('⚠️ Target must differ from the source.');
    if (!s.targets) s.targets = [];
    if (s.targets.includes(key)) return ctx.reply('⚠️ Target already added.');
    s.targets.push(key);
    await askMoreTargets(ctx, `\`${key}\``);
  } else if (s.step === 'INTERVAL') {
    const h = parseInt(ctx.message.text);
    if (isNaN(h) || h < 1) {
      return ctx.reply('⚠️ Enter a valid number of hours (e.g. 1, 6, 12).');
    }
    s.interval = h * 3600;
    s.step = 'TRACKING_FINAL';
    processTrackingFinal(ctx, s);
  } else if (s.step === 'ADD_TARGET') {
    const raw = (ctx.message.text || '').trim();
    if (!raw) return;
    let key;
    try {
      key = await ensureAccessible(raw, curTid(ctx));
    } catch (e) {
      return ctx.reply(`⚠️ ${e.message}`);
    }
    const chs = loadUser(curTid(ctx));
    if (!chs[s.channel]) return ctx.reply('⚠️ Channel not found.');
    if (!chs[s.channel].targets) {
      chs[s.channel].targets = [chs[s.channel].target].filter(Boolean);
      delete chs[s.channel].target;
    }
    if (chs[s.channel].targets.includes(key)) return ctx.reply('⚠️ Target already added.');
    chs[s.channel].targets.push(key);
    saveUser(curTid(ctx), chs);
    await ctx.reply(
      `✅ *Target Added*\n\n\`${key}\`\n\nAll targets: ${chs[s.channel].targets.join(', ')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Another', callback_data: `addtarget_${s.channel}` }],
            [{ text: '📋 Browse My Channels', callback_data: `browse_atgt` }],
            [{ text: '✅ Done', callback_data: 'addtarget_done' }]
          ]
        }
      }
    );
  }
});

// ── Process Tracking Final ───────────────────────────────────────

async function processTrackingFinal(ctx, s) {
  const tid = curTid(ctx);
  if (!s.link) {
    userState.delete(ctx.from.id);
    return ctx.reply('⚠️ Session expired — tap ➕ Add Channel to start over.', {
      reply_markup: { inline_keyboard: [[{ text: '➕ Add Channel', callback_data: 'add_channel' }]] }
    });
  }
  if (!s.targets || !s.targets.length) {
    s.step = 'TARGET';
    userState.set(ctx.from.id, s);
    return ctx.reply('⚠️ Add at least one target first — send a @username/link or tap Browse:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📋 Browse My Channels', callback_data: 'browse_tgt' }]] }
    });
  }
  const chs = loadUser(tid);
  if (chs[s.link]) {
    userState.delete(ctx.from.id);
    return ctx.reply(`⚠️ \`${s.link}\` is already added — manage it from My Channels.`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📡 My Channels', callback_data: 'list_channels_0' }]] }
    });
  }
  const entry = { mode: s.mode, targets: s.targets || [s.target].filter(Boolean), active: true };
  if (s.tracking) {
    entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: s.interval, xAlerts: 'on', periodic: 'on' };
  }
  chs[s.link] = entry;
  saveUser(curTid(ctx), chs);
  try {
    await addChannelListener(s.link, curTid(ctx));
    const sum = [
      '✅ *Channel Added*',
      '━━━━━━━━━━━━━━━━━━━━',
      `Source: \`${s.link}\``,
      `Mode: ${entry.mode === 'extract' ? '📋 Extract' : '📨 Forward'}`,
      `Targets: ${entry.targets.join(', ')}`,
      entry.tracking ? `Tracking: 📊 ON (${entry.tracking.multipliers.join('X/')}X, ${entry.tracking.interval / 3600}h)` : 'Tracking: ❌ OFF',
      entry.tracking ? `X Alerts: ${stLabel(entry.tracking.xAlerts)}  ·  🔄 Update: ${stLabel(entry.tracking.periodic)}` : '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');
    await ctx.reply(sum, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📡 My Channels', callback_data: 'list_channels_0' }],
          [{ text: '➕ Add Another', callback_data: 'add_channel' }],
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      }
    });
  } catch (err) {
    await ctx.reply(`⚠️ *Error*: ${err.message}`, { parse_mode: 'Markdown' });
  }
  userState.delete(ctx.from.id);
}

// ── Legacy Commands ──────────────────────────────────────────────

bot.command('list_channels', (ctx) => {
  const chs = loadUser(curTid(ctx));
  if (!Object.keys(chs).length) {
    return ctx.reply('📡 No channels yet.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add Channel', callback_data: 'add_channel' }]
        ]
      }
    });
  }
  ctx.reply('📡 *My Channels*', {
    parse_mode: 'Markdown',
    ...menuKb(ctx)
  });
});

bot.command('add_channel', (ctx) => {
  userState.set(ctx.from.id, { step: 'LINK' });
  ctx.reply(
    `➕ *Add Channel — Step 1/4*\n\nSend the channel *link or username*.\n\nExamples:\n\`@channelname\`\n\`https://t.me/channelname\`\n\`https://t.me/+invitehash\``,
    { parse_mode: 'Markdown' }
  );
});

// ── Set Mode / Set Target (power-user commands) ──────────────────

bot.command('set_mode', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /set_mode <channel> <extract|forward>\nExample: `/set_mode @channelname extract`', { parse_mode: 'Markdown' });
  }
  const [channel, mode] = args;
  if (!['extract', 'forward'].includes(mode)) {
    return ctx.reply('Mode must be "extract" or "forward".');
  }
  const chs = loadUser(curTid(ctx));
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  chs[channel].mode = mode;
  saveUser(curTid(ctx), chs);
  ctx.reply(`✅ Mode for ${channel} → ${mode}.`);
});

bot.command('set_target', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /set_target <channel> <target>\nExample: `/set_target @channelname @target`', { parse_mode: 'Markdown' });
  }
  const [channel, ...rest] = args;
  const target = rest.join(' ');
  const chs = loadUser(curTid(ctx));
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  if (!chs[channel].targets) {
    chs[channel].targets = [chs[channel].target].filter(Boolean);
    delete chs[channel].target;
  }
  chs[channel].targets.push(target);
  saveUser(curTid(ctx), chs);
  ctx.reply(`✅ Target added for ${channel}: ${target}\nAll targets: ${chs[channel].targets.join(', ')}`);
});

// ── Tracking Commands ────────────────────────────────────────────

bot.command('track', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /track <channel> <on|off>\nExample: `/track @channel on`', { parse_mode: 'Markdown' });
  }
  const [channel, action] = args;
  const chs = loadUser(curTid(ctx));
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  if (action === 'on') {
    chs[channel].tracking = chs[channel].tracking || { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
    if (!chs[channel].tracking.xAlerts) chs[channel].tracking.xAlerts = 'on';
    if (!chs[channel].tracking.periodic) chs[channel].tracking.periodic = 'on';
    chs[channel].tracking.enabled = true;
  } else if (action === 'off') {
    if (chs[channel].tracking) chs[channel].tracking.enabled = false;
  } else {
    return ctx.reply('Action must be "on" or "off".');
  }
  saveUser(curTid(ctx), chs);
  ctx.reply(`📊 Tracking for ${channel} → *${action}*.`, { parse_mode: 'Markdown' });
});

bot.command('track_set', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Usage: /track_set <channel> <multipliers> <interval_sec>\nExample: `/track_set @channel 2,3,5,10 3600`', { parse_mode: 'Markdown' });
  }
  const [channel, multStr, intervalStr] = args;
  const chs = loadUser(curTid(ctx));
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  const multipliers = multStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  const interval = parseInt(intervalStr);
  if (!multipliers.length || isNaN(interval) || interval < 60) {
    return ctx.reply('⚠️ Invalid multipliers or interval (min 60s).');
  }
  chs[channel].tracking = { enabled: true, multipliers, interval, xAlerts: 'on', periodic: 'on' };
  saveUser(curTid(ctx), chs);
  ctx.reply(`📊 Tracking for ${channel}: ${multipliers.join('X, ')}X, ${interval}s interval.`);
});

// ── Refresh Command ──────────────────────────────────────────────

bot.command('refresh', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /refresh <CA> [chain]\nExample: `/refresh 0x0aCb834130D284BFfFa1C697f02DDDaFd8F50335 eth`', { parse_mode: 'Markdown' });
  }
  const [ca, chainArg] = args;
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);
  const isEVM = /^0x[a-fA-F0-9]{40}$/.test(ca);
  if (!isBase58 && !isEVM) return ctx.reply('⚠️ Invalid CA format.');

  let chain = chainArg || (isBase58 ? 'sol' : null);
  if (!chain) {
    chain = await resolveChain(ca);
    if (!chain) return ctx.reply('⚠️ Could not detect chain. Specify: /refresh <CA> <chain>');
  }

  await ctx.reply(`🔍 Fetching \`${ca.slice(0, 6)}...${ca.slice(-4)}\` (${chain})...`, { parse_mode: 'Markdown' });
  const info = await fetchTokenInfo(ca, chain);
  const summary = formatTokenSummary(info);
  ctx.reply(summary || '⚠️ No data found.', { parse_mode: 'Markdown' });
});

// ── Global Error Handler ─────────────────────────────────────────
// Swallows harmless "message is not modified" errors (e.g. tapping a
// button that produces identical content), logs nothing else.

bot.catch((err, ctx) => {
  const msg = err?.message || String(err);
  if (msg.toLowerCase().includes('message is not modified')) return;
  console.error(`[bot] error on ${ctx?.updateType ?? 'unknown'}:`, msg);
});
