import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import fs from 'fs';
import { addChannelListener, resolveChain, fetchTokenInfo, formatTokenSummary } from './scraper.js';

export const bot = new Telegraf(config.botToken);

// File-based DB
const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};
const saveChannels = (channels) => fs.writeFileSync(DB_FILE, JSON.stringify(channels));

const userState = new Map();

bot.start((ctx) => {
  ctx.reply('Bot Menu:', Markup.inlineKeyboard([
    [Markup.button.callback('Add Channel', 'add_channel'), Markup.button.callback('List Channels', 'list_channels')]
  ]));
});

bot.command('add_channel', (ctx) => {
  userState.set(ctx.from.id, { step: 'LINK' });
  ctx.reply('Please send the channel link/username.');
});

bot.command('list_channels', (ctx) => {
  const channels = loadChannels();
  if (Object.keys(channels).length === 0) return ctx.reply('No channels added.');
  const buttons = Object.entries(channels).map(([ch, info]) => [
    Markup.button.callback(`${ch} (${info.active ? 'ON' : 'OFF'})`, `manage_${ch}`)
  ]);
  ctx.reply('Select a channel:', Markup.inlineKeyboard(buttons));
});

bot.command('set_mode', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /set_mode <channel> <extract|forward>\nExample: /set_mode @channelname extract');
  }
  const [channel, mode] = args;
  if (!['extract', 'forward'].includes(mode)) {
    return ctx.reply('Mode must be "extract" or "forward".');
  }
  const channels = loadChannels();
  if (!channels[channel]) {
    return ctx.reply(`Channel "${channel}" not found. Add it first with /add_channel`);
  }
  channels[channel].mode = mode;
  saveChannels(channels);
  ctx.reply(`Mode for ${channel} set to "${mode}".`);
});

bot.command('set_target', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /set_target <channel> <target>\nExample: /set_target @channelname @targetchannel');
  }
  const [channel, ...rest] = args;
  const target = rest.join(' ');
  const channels = loadChannels();
  if (!channels[channel]) {
    return ctx.reply(`Channel "${channel}" not found. Add it first with /add_channel`);
  }
  if (!channels[channel].targets) {
    channels[channel].targets = [channels[channel].target].filter(Boolean);
    delete channels[channel].target;
  }
  channels[channel].targets.push(target);
  saveChannels(channels);
  ctx.reply(`Target added for ${channel}: ${target}\n\nAll targets: ${channels[channel].targets.join(', ')}`);
});

bot.command('refresh', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /refresh <CA> [chain]\nExample: /refresh 0x0aCb834130D284BFfFa1C697f02DDDaFd8F50335 eth');
  }
  const [ca, chainArg] = args;
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);
  const isEVM = /^0x[a-fA-F0-9]{40}$/.test(ca);

  if (!isBase58 && !isEVM) {
    return ctx.reply('Invalid CA format.');
  }

  let chain = chainArg || (isBase58 ? 'sol' : null);
  if (!chain) {
    chain = await resolveChain(ca);
    if (!chain) return ctx.reply('Could not detect chain. Specify it manually: /refresh <CA> <chain>');
  }

  await ctx.reply(`🔍 Fetching ${ca.slice(0, 6)}...${ca.slice(-4)} (${chain})...`);
  const info = await fetchTokenInfo(ca, chain);
  const summary = formatTokenSummary(info);
  ctx.reply(summary || 'No data found.');
});

bot.action('add_channel', (ctx) => {
  userState.set(ctx.from.id, { step: 'LINK' });
  ctx.reply('Please send the channel link/username.');
});

bot.on('text', async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;

  if (state.step === 'LINK') {
    state.link = ctx.message.text;
    state.step = 'MODE';
    ctx.reply('Choose mode:', Markup.inlineKeyboard([
      [Markup.button.callback('Extract CA', 'mode_extract'), Markup.button.callback('Forward All', 'mode_forward')]
    ]));
  } else if (state.step === 'TARGET') {
    if (!state.targets) state.targets = [];
    state.targets.push(ctx.message.text);
    ctx.reply(`✓ Target added: ${ctx.message.text}\n\nAdd another target?`, Markup.inlineKeyboard([
      [Markup.button.callback('Yes, add another', 'target_add')],
      [Markup.button.callback('No, done', 'target_done')],
    ]));
  } else if (state.step === 'INTERVAL') {
    const intervalHours = parseInt(ctx.message.text);
    if (isNaN(intervalHours) || intervalHours < 1) {
      return ctx.reply('Please enter a valid number of hours (e.g., 1, 6, 12).');
    }
    state.interval = intervalHours * 3600;
    state.step = 'TRACKING_FINAL';
    processTrackingFinal(ctx, state);
  } else if (state.step === 'ADD_TARGET') {
    const channels = loadChannels();
    if (!channels[state.channel]) return ctx.reply('Channel not found.');
    if (!channels[state.channel].targets) {
      channels[state.channel].targets = [channels[state.channel].target].filter(Boolean);
      delete channels[state.channel].target;
    }
    channels[state.channel].targets.push(ctx.message.text);
    saveChannels(channels);
    ctx.reply(`✓ Target added: ${ctx.message.text}\n\nAll targets: ${channels[state.channel].targets.join(', ')}`, Markup.inlineKeyboard([
      [Markup.button.callback('Add Another', `addtarget_${state.channel}`)],
      [Markup.button.callback('Done', 'addtarget_done')],
    ]));
  }
});

bot.action('track_yes', (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.tracking = true;
  state.step = 'INTERVAL';
  ctx.editMessageText('Enter update interval in hours (e.g., 1, 6, 12):');
});

bot.action('track_no', (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.tracking = false;
  state.step = 'TRACKING_FINAL';
  ctx.editMessageText('Saving without tracking...');
  processTrackingFinal(ctx, state);
});

bot.action(/mode_(.+)/, (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.mode = ctx.match[1].replace('mode_', '');
  state.step = 'TARGET';
  ctx.editMessageText('Enter the target channel username (e.g., @target):');
});

bot.action('target_add', (ctx) => {
  ctx.editMessageText('Enter another target channel username:');
});

bot.action('target_done', (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.step = 'TRACKING';
  ctx.editMessageText('Enable price tracking?', Markup.inlineKeyboard([
    [Markup.button.callback('Yes', 'track_yes'), Markup.button.callback('No', 'track_no')],
  ]));
});

async function processTrackingFinal(ctx, state) {
  const channels = loadChannels();
  const link = state.link;
  const entry = { mode: state.mode, targets: state.targets, active: true };
  if (state.tracking) {
    entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: state.interval };
  }
  channels[link] = entry;
  saveChannels(channels);
  try {
    await addChannelListener(link);
    ctx.reply(`Success! Monitoring ${link}\nMode: ${state.mode}\nTargets: ${state.targets.join(', ')}${state.tracking ? '\nTracking: ON' : ''}`);
  } catch (err) {
    ctx.reply(`Error starting listener: ${err.message}`);
  }
  userState.delete(ctx.from.id);
}

bot.action('list_channels', (ctx) => {
  const channels = loadChannels();
  if (Object.keys(channels).length === 0) return ctx.reply('No channels added.');
  const buttons = Object.entries(channels).map(([ch, info]) => [
    Markup.button.callback(`${ch} (${info.active ? 'ON' : 'OFF'})`, `manage_${ch}`)
  ]);
  ctx.reply('Select a channel:', Markup.inlineKeyboard(buttons));
});

function targetsDisplay(info) {
  return info.targets ? info.targets.join(', ') : info.target || 'Default';
}

bot.action(/manage_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const info = loadChannels()[channel];
  const track = info.tracking?.enabled ? `Tracking: ON (${info.tracking.multipliers.join('X/')}X, ${info.tracking.interval/3600}h)` : 'Tracking: OFF';
  ctx.reply(`Manage ${channel}:\nMode: ${info.mode}\nTargets: ${targetsDisplay(info)}\n${track}\nIgnore Duplicate: ${info.ignoreDuplicate ? 'ON' : 'OFF'}`, Markup.inlineKeyboard([
    [Markup.button.callback(info.active ? 'Pause Listener' : 'Start Listener', `toggle_${channel}`), Markup.button.callback(info.ignoreDuplicate ? 'Ignore Dup OFF' : 'Ignore Dup ON', `toggledup_${channel}`)],
    [Markup.button.callback('Add Target', `addtarget_${channel}`), Markup.button.callback('Delete', `delete_${channel}`)],
    [Markup.button.callback('Back', 'list_channels')]
  ]));
});

bot.action(/toggledup_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const channels = loadChannels();
  channels[channel].ignoreDuplicate = !channels[channel].ignoreDuplicate;
  saveChannels(channels);
  ctx.answerCbQuery(`Duplicate ignore is now ${channels[channel].ignoreDuplicate ? 'ON' : 'OFF'}`);
  const info = channels[channel];
  const track = info.tracking?.enabled ? `Tracking: ON (${info.tracking.multipliers.join('X/')}X, ${info.tracking.interval/3600}h)` : 'Tracking: OFF';
  ctx.editMessageText(`Manage ${channel}:\nMode: ${info.mode}\nTargets: ${targetsDisplay(info)}\n${track}\nIgnore Duplicate: ${info.ignoreDuplicate ? 'ON' : 'OFF'}`, Markup.inlineKeyboard([
    [Markup.button.callback(info.active ? 'Pause Listener' : 'Start Listener', `toggle_${channel}`), Markup.button.callback(info.ignoreDuplicate ? 'Ignore Dup OFF' : 'Ignore Dup ON', `toggledup_${channel}`)],
    [Markup.button.callback('Add Target', `addtarget_${channel}`), Markup.button.callback('Delete', `delete_${channel}`)],
    [Markup.button.callback('Back', 'list_channels')]
  ]));
});

bot.action(/toggle_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const channels = loadChannels();
  channels[channel].active = !channels[channel].active;
  saveChannels(channels);
  ctx.answerCbQuery(`Channel ${channel} is now ${channels[channel].active ? 'active' : 'paused'}`);
  const info = channels[channel];
  ctx.editMessageText(`Manage ${channel}:\nMode: ${info.mode}\nTargets: ${targetsDisplay(info)}`, Markup.inlineKeyboard([
    [Markup.button.callback(info.active ? 'Pause Listener' : 'Start Listener', `toggle_${channel}`), Markup.button.callback(info.ignoreDuplicate ? 'Ignore Dup OFF' : 'Ignore Dup ON', `toggledup_${channel}`)],
    [Markup.button.callback('Add Target', `addtarget_${channel}`), Markup.button.callback('Delete', `delete_${channel}`)],
    [Markup.button.callback('Back', 'list_channels')]
  ]));
});

bot.action(/delete_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const channels = loadChannels();
  delete channels[channel];
  saveChannels(channels);
  ctx.answerCbQuery('Deleted');
  ctx.editMessageText('Channel deleted.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'list_channels')]]));
});

bot.action(/addtarget_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const channels = loadChannels();
  if (!channels[channel]) return ctx.answerCbQuery('Channel not found');
  userState.set(ctx.from.id, { step: 'ADD_TARGET', channel });
  ctx.editMessageText(`Send the new target username for ${channel}:`);
});

bot.action('addtarget_done', (ctx) => {
  userState.delete(ctx.from.id);
  ctx.editMessageText('Done.');
});

// ── Price Tracking ──────────────────────────────────────────────

bot.command('track', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /track <channel> <on|off>\nExample: /track @channel on');
  }
  const [channel, action] = args;
  const channels = loadChannels();
  if (!channels[channel]) {
    return ctx.reply(`Channel "${channel}" not found.`);
  }
  if (action === 'on') {
    channels[channel].tracking = channels[channel].tracking || { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
    channels[channel].tracking.enabled = true;
  } else if (action === 'off') {
    if (channels[channel].tracking) channels[channel].tracking.enabled = false;
  } else {
    return ctx.reply('Action must be "on" or "off".');
  }
  saveChannels(channels);
  ctx.reply(`Tracking for ${channel} is now ${action}.`);
});

bot.command('track_set', (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 3) {
    return ctx.reply('Usage: /track_set <channel> <multipliers> <interval_sec>\nExample: /track_set @channel 2,3,5,10 3600');
  }
  const [channel, multStr, intervalStr] = args;
  const channels = loadChannels();
  if (!channels[channel]) {
    return ctx.reply(`Channel "${channel}" not found.`);
  }
  const multipliers = multStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  const interval = parseInt(intervalStr);
  if (!multipliers.length || isNaN(interval) || interval < 60) {
    return ctx.reply('Invalid multipliers (comma-separated) or interval (min 60s).');
  }
  channels[channel].tracking = { enabled: true, multipliers, interval };
  saveChannels(channels);
  ctx.reply(`Tracking for ${channel}: multipliers ${multipliers.join('X, ')}X, interval ${interval}s.`);
});


