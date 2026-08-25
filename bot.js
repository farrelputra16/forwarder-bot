import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { addChannelListener, resolveChain, fetchTokenInfo, formatTokenSummary } from './scraper.js';
import { updateTrackingPeriodicStatus, updateTrackingXStatus } from './tracking.js';
import { loadChannels, saveChannels } from './store.js';

export const bot = new Telegraf(config.botToken);

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
  rows.push([
    { text: '🗑 Delete', callback_data: `delete_${ch}` },
    { text: '◀️ Channels', callback_data: 'list_channels_0' }
  ]);
  return { reply_markup: { inline_keyboard: rows } };
}

function menuKb() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📡 My Channels', callback_data: 'list_channels_0' }],
        [{ text: '➕ Add Channel', callback_data: 'add_channel' }],
        [{ text: '📊 Dashboard', callback_data: 'dashboard' }],
        [{ text: '❓ Help', callback_data: 'help' }]
      ]
    }
  };
}

// ── Start / Menu ─────────────────────────────────────────────────

bot.start(async (ctx) => {
  const chs = loadChannels();
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;
  await ctx.reply(
    `👋 *Welcome to Forwarder Bot*\n\nI help you forward messages from Telegram channels — extract contract addresses or forward entire messages to your target channels.\n\n📡 ${a}/${e.length} channels active`,
    { parse_mode: 'Markdown', ...menuKb() }
  );
});

bot.action('menu', async (ctx) => {
  const chs = loadChannels();
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;
  await ctx.editMessageText(
    `🤖 *Forwarder Bot*\n\n📡 ${a}/${e.length} channels active`,
    { parse_mode: 'Markdown', ...menuKb() }
  );
});

bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// ── Dashboard ────────────────────────────────────────────────────

bot.action('dashboard', async (ctx) => {
  const chs = loadChannels();
  const e = Object.entries(chs);
  const a = e.filter(([, v]) => v.active).length;
  const p = e.length - a;
  const ext = e.filter(([, v]) => v.mode === 'extract').length;
  const fwd = e.filter(([, v]) => v.mode !== 'extract').length;
  const trk = e.filter(([, v]) => v.tracking?.enabled).length;
  const dup = e.filter(([, v]) => v.ignoreDuplicate).length;

  await ctx.editMessageText(
    `📊 *Dashboard*\n━━━━━━━━━━━━━━━━━━━━\nTotal Channels: *${e.length}*\n🟢 Active: *${a}*  ·  🔴 Paused: *${p}*\n📋 Extract: *${ext}*  ·  📨 Forward: *${fwd}*\n📊 Tracking: *${trk}*  ·  🔁 Dup Ignore: *${dup}*\n━━━━━━━━━━━━━━━━━━━━`,
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
    `❓ *Help & Commands*\n━━━━━━━━━━━━━━━━━━━━\n\n*/start* — Open main menu\n*/refresh \\<CA\\> [chain]* — Look up token info\n*/track \\<channel\\> \\<on|off\\>* — Toggle price tracking\n*/track\\_set \\<channel\\> \\<mults\\> \\<sec\\>* — Configure tracking\n\n💡 Use the buttons below to manage everything.\n━━━━━━━━━━━━━━━━━━━━`,
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

// ── Channel List (paginated) ─────────────────────────────────────

bot.action(/^list_channels_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  const chs = loadChannels();
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
  const chs = loadChannels();
  const info = chs[ch];
  if (!info) return ctx.answerCbQuery('Not found');
  await ctx.editMessageText(detail(ch, info), {
    parse_mode: 'Markdown',
    ...manageKb(ch, info)
  });
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadChannels();
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].active = !chs[ch].active;
  saveChannels(chs);
  await ctx.answerCbQuery(chs[ch].active ? '▶️ Resumed' : '⏸ Paused');
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^toggledup_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadChannels();
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].ignoreDuplicate = !chs[ch].ignoreDuplicate;
  if (!chs[ch].seenCAs) chs[ch].seenCAs = [];
  saveChannels(chs);
  await ctx.answerCbQuery(chs[ch].ignoreDuplicate ? '✅ Dup Ignored' : '❌ Dup Pass Through');
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^switchmode_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadChannels();
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  chs[ch].mode = chs[ch].mode === 'extract' ? 'forward' : 'extract';
  saveChannels(chs);
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
  const chs = loadChannels();
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  const next = cycle(chs[ch].tracking?.xAlerts);
  if (!chs[ch].tracking) chs[ch].tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
  chs[ch].tracking.xAlerts = next;
  saveChannels(chs);
  updateTrackingXStatus(chs[ch].targets || (chs[ch].target ? [chs[ch].target] : []), next);
  await ctx.answerCbQuery(`X Alerts: ${next === 'on' ? '🟢 On' : next === 'paused' ? '⏸ Paused' : '❌ Off'}`);
  await ctx.editMessageText(detail(ch, chs[ch]), {
    parse_mode: 'Markdown',
    ...manageKb(ch, chs[ch])
  });
});

bot.action(/^cyclep_(.+)$/, async (ctx) => {
  const ch = ctx.match[1];
  const chs = loadChannels();
  if (!chs[ch]) return ctx.answerCbQuery('Not found');
  const next = cycle(chs[ch].tracking?.periodic);
  if (!chs[ch].tracking) chs[ch].tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
  chs[ch].tracking.periodic = next;
  saveChannels(chs);
  updateTrackingPeriodicStatus(chs[ch].targets || (chs[ch].target ? [chs[ch].target] : []), next);
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
  const chs = loadChannels();
  delete chs[ch];
  saveChannels(chs);
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
  const chs = loadChannels();
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
  const chs = loadChannels();
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
    `➕ *Add Channel — Step 1/4*\n\nSend the channel *link or username*.\n\nExamples:\n\`@channelname\`\n\`https://t.me/channelname\`\n\`https://t.me/+invitehash\``,
    { parse_mode: 'Markdown' }
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

// ── Text Input (Wizard) ──────────────────────────────────────────

bot.on('text', async (ctx) => {
  const s = userState.get(ctx.from.id);
  if (!s) return;

  if (s.step === 'LINK') {
    s.link = ctx.message.text;
    s.step = 'MODE';
    await ctx.reply(
      `➕ *Add Channel — Step 2/4*\n\nChoose forwarding mode:`,
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
    if (!s.targets) s.targets = [];
    s.targets.push(ctx.message.text);
    await ctx.reply(
      `✅ Target added: \`${ctx.message.text}\`\n\nAdd another target?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Yes, add another', callback_data: 'target_add' }],
            [{ text: '➡️ No, continue', callback_data: 'target_done' }]
          ]
        }
      }
    );
  } else if (s.step === 'INTERVAL') {
    const h = parseInt(ctx.message.text);
    if (isNaN(h) || h < 1) {
      return ctx.reply('⚠️ Enter a valid number of hours (e.g. 1, 6, 12).');
    }
    s.interval = h * 3600;
    s.step = 'TRACKING_FINAL';
    processTrackingFinal(ctx, s);
  } else if (s.step === 'ADD_TARGET') {
    const chs = loadChannels();
    if (!chs[s.channel]) return ctx.reply('⚠️ Channel not found.');
    if (!chs[s.channel].targets) {
      chs[s.channel].targets = [chs[s.channel].target].filter(Boolean);
      delete chs[s.channel].target;
    }
    chs[s.channel].targets.push(ctx.message.text);
    saveChannels(chs);
    await ctx.reply(
      `✅ *Target Added*\n\n\`${ctx.message.text}\`\n\nAll targets: ${chs[s.channel].targets.join(', ')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Another', callback_data: `addtarget_${s.channel}` }],
            [{ text: '✅ Done', callback_data: 'addtarget_done' }]
          ]
        }
      }
    );
  }
});

// ── Process Tracking Final ───────────────────────────────────────

async function processTrackingFinal(ctx, s) {
  const chs = loadChannels();
  const entry = { mode: s.mode, targets: s.targets || [s.target].filter(Boolean), active: true };
  if (s.tracking) {
    entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: s.interval, xAlerts: 'on', periodic: 'on' };
  }
  chs[s.link] = entry;
  saveChannels(chs);
  try {
    await addChannelListener(s.link);
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
  const chs = loadChannels();
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
    ...menuKb()
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
  const chs = loadChannels();
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  chs[channel].mode = mode;
  saveChannels(chs);
  ctx.reply(`✅ Mode for ${channel} → ${mode}.`);
});

bot.command('set_target', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /set_target <channel> <target>\nExample: `/set_target @channelname @target`', { parse_mode: 'Markdown' });
  }
  const [channel, ...rest] = args;
  const target = rest.join(' ');
  const chs = loadChannels();
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  if (!chs[channel].targets) {
    chs[channel].targets = [chs[channel].target].filter(Boolean);
    delete chs[channel].target;
  }
  chs[channel].targets.push(target);
  saveChannels(chs);
  ctx.reply(`✅ Target added for ${channel}: ${target}\nAll targets: ${chs[channel].targets.join(', ')}`);
});

// ── Tracking Commands ────────────────────────────────────────────

bot.command('track', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /track <channel> <on|off>\nExample: `/track @channel on`', { parse_mode: 'Markdown' });
  }
  const [channel, action] = args;
  const chs = loadChannels();
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
  saveChannels(chs);
  ctx.reply(`📊 Tracking for ${channel} → *${action}*.`, { parse_mode: 'Markdown' });
});

bot.command('track_set', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Usage: /track_set <channel> <multipliers> <interval_sec>\nExample: `/track_set @channel 2,3,5,10 3600`', { parse_mode: 'Markdown' });
  }
  const [channel, multStr, intervalStr] = args;
  const chs = loadChannels();
  if (!chs[channel]) return ctx.reply(`⚠️ "${channel}" not found.`);
  const multipliers = multStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  const interval = parseInt(intervalStr);
  if (!multipliers.length || isNaN(interval) || interval < 60) {
    return ctx.reply('⚠️ Invalid multipliers or interval (min 60s).');
  }
  chs[channel].tracking = { enabled: true, multipliers, interval, xAlerts: 'on', periodic: 'on' };
  saveChannels(chs);
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
