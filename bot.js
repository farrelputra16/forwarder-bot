import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import fs from 'fs';
import { addChannelListener } from './scraper.js';

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
    const channels = loadChannels();
    const link = state.link;
    
    channels[link] = { mode: state.mode, target: ctx.message.text, active: true };
    saveChannels(channels);
    try {
      await addChannelListener(link);
      ctx.reply(`Success! Monitoring ${link}\nMode: ${state.mode}\nTarget: ${ctx.message.text}`);
    } catch (err) {
      ctx.reply(`Error starting listener: ${err.message}`);
    }
    userState.delete(ctx.from.id);
  }
});

bot.action(/mode_(.+)/, (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;
  state.mode = ctx.match[1].replace('mode_', '');
  state.step = 'TARGET';
  ctx.editMessageText('Enter the target channel username (e.g., @target):');
});

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
  ctx.reply(`Manage ${channel}:\nMode: ${info.mode}\nTarget: ${info.target || 'Default'}`, Markup.inlineKeyboard([
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
