import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses } from './scraper.js';
import { config } from './config.js';
import fs from 'fs';
import http from 'http';

// Create a dummy HTTP server to satisfy Render's port binding requirement
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

// Initialize
await initScraper(config.telegram.session);

const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};

// Forwarding Logic
onMessage(async (sourceChannel, message) => {
  if (!message.text) return;
  
  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;
  
  // Use specific target if set, else fallback to config default
  const target = channelInfo.target || config.targetChannel;
  const channelName = sourceChannel.replace('@', '');

  if (channelInfo.mode === 'forward') {
      const formattedMessage = `📢 *NEW CALL BY "@${channelName}"*\n\n${message.text}`;
      await forwardMessage(target, formattedMessage);
  } else if (channelInfo.mode === 'extract') {
      const cas = extractAddresses(message.text);
      if (cas.length > 0) {
          for(const ca of cas) {
            const formattedCA = `💎 *NEW CALL BY "@${channelName}"*\n\n` +
                                `Contract Address:\n\`${ca}\`\n\n` +
                                `[Solscan](https://solscan.io/token/${ca})`;
            await forwardMessage(target, formattedCA);
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
