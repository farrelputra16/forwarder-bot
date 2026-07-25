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
  channels[channel].target = target;
  saveChannels(channels);
  ctx.reply(`Target for ${channel} set to "${target}".`);
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
    state.target = ctx.message.text;
    state.step = 'TRACKING';
    ctx.reply('Enable price tracking?', Markup.inlineKeyboard([
      [Markup.button.callback('Yes (2X/3X/5X/10X, every 1h)', 'track_yes')],
      [Markup.button.callback('No', 'track_no')],
    ]));
  }
});

bot.action(/mode_(.+)/, (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.mode = ctx.match[1].replace('mode_', '');
  state.step = 'TARGET';
  ctx.editMessageText('Enter the target channel username (e.g., @target):');
});

bot.action('track_yes', (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.tracking = true;
  state.step = 'TRACKING_FINAL';
  ctx.editMessageText('Saving with tracking enabled...');
  processTrackingFinal(ctx, state);
});

bot.action('track_no', (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.tracking = false;
  state.step = 'TRACKING_FINAL';
  ctx.editMessageText('Saving without tracking...');
  processTrackingFinal(ctx, state);
});

async function processTrackingFinal(ctx, state) {
  const channels = loadChannels();
  const link = state.link;
  const entry = { mode: state.mode, target: state.target, active: true };
  if (state.tracking) {
    entry.tracking = { enabled: true, multipliers: [2, 3, 5, 10], interval: 3600 };
  }
  channels[link] = entry;
  saveChannels(channels);
  try {
    await addChannelListener(link);
    ctx.reply(`Success! Monitoring ${link}\nMode: ${state.mode}\nTarget: ${state.target}${state.tracking ? '\nTracking: ON' : ''}`);
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

bot.action(/manage_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const info = loadChannels()[channel];
  const track = info.tracking?.enabled ? `Tracking: ON (${info.tracking.multipliers.join('X/')}X, ${info.tracking.interval}s)` : 'Tracking: OFF';
  ctx.reply(`Manage ${channel}:\nMode: ${info.mode}\nTarget: ${info.target || 'Default'}\n${track}`, Markup.inlineKeyboard([
    [Markup.button.callback(info.active ? 'Pause' : 'Start', `toggle_${channel}`), Markup.button.callback('Delete', `delete_${channel}`)],
    [Markup.button.callback('Back', 'list_channels')]
  ]));
});

bot.action(/toggle_(.+)/, (ctx) => {
  const channel = ctx.match[1];
  const channels = loadChannels();
  channels[channel].active = !channels[channel].active;
  saveChannels(channels);
  ctx.answerCbQuery(`Channel ${channel} is now ${channels[channel].active ? 'active' : 'paused'}`);
  ctx.editMessageText(`Manage ${channel}:\nMode: ${channels[channel].mode}\nTarget: ${channels[channel].target || 'Default'}`, Markup.inlineKeyboard([
    [Markup.button.callback(channels[channel].active ? 'Pause' : 'Start', `toggle_${channel}`), Markup.button.callback('Delete', `delete_${channel}`)],
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


