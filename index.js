import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses } from './scraper.js';
import { config } from './config.js';
import fs from 'fs';

// Initialize
await initScraper(config.telegram.session);

const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};

// Forwarding Logic
onMessage(async (sourceChannel, message) => {
  if (!message.text) return;
  
  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return; // Added check
  
  // Use specific target if set, else fallback to config default
  const target = channelInfo.target || config.targetChannel;

  if (channelInfo.mode === 'forward') {
      await forwardMessage(target, `${message.text}`);
  } else if (channelInfo.mode === 'extract') {
      const cas = extractAddresses(message.text);
      if (cas.length > 0) {
          for(const ca of cas) {
            await forwardMessage(target, `${ca}`);
          }
      }
  }
});

// Start listeners from saved file
const channels = loadChannels();
for (const ch of Object.keys(channels)) {
    await addChannelListener(ch).catch(console.error);
}

// Start Bot
bot.launch();
console.log('Bot running...');
