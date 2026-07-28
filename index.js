import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, fetchDexScreenerInfo, fmt } from './scraper.js';
import { config } from './config.js';
import { initTrackings, addTracking } from './tracking.js';
import fs from 'fs';
import http from 'http';

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

await initScraper(config.telegram.session);
initTrackings();

const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};

// Forwarding Logic
onMessage(async (sourceChannel, message) => {
  if (!message.text) return;
  
  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;
  
  const target = channelInfo.target || config.targetChannel;
  const channelName = sourceChannel.replace('@', '');

  if (channelInfo.mode === 'forward') {
      const formattedMessage = `📢 *NEW CALL BY "@${channelName}"*\n\n${message.text}`;
      await forwardMessage(target, formattedMessage);
  } else if (channelInfo.mode === 'extract') {
      const cas = [...extractAddresses(message.text), ...extractEVMAddresses(message.text)];
      if (cas.length > 0) {
          for(const ca of cas) {
            const dexInfo = await fetchDexScreenerInfo(ca);
            const mc = dexInfo?.marketCap ? fmt(dexInfo.marketCap) : '?';
            const formattedCA = `💎 *NEW CALL BY "@${channelName}"*\n\n` +
                                `Contract Address:\n\`${ca}\`\n` +
                                `Called MC: ${mc}\n` +
                                `[Solscan](https://solscan.io/token/${ca})`;
            await forwardMessage(target, formattedCA);
            
            if (channelInfo.tracking?.enabled && dexInfo) {
              const price = parseFloat(dexInfo.price);
              if (price > 0) {
                addTracking({
                  ca,
                  chain: dexInfo.chain || 'sol',
                  calledAtPrice: price,
                  calledAtMC: mc,
                  symbol: dexInfo.symbol || ca.slice(0, 6),
                  target,
                  multipliers: channelInfo.tracking.multipliers || [2, 3, 5, 10],
                  alertInterval: (channelInfo.tracking.interval || 3600),
                });
              }
            }
          }
      }
  }
});

const channels = loadChannels();
for (const ch of Object.keys(channels)) {
    await addChannelListener(ch).catch(console.error);
}

bot.launch().catch(console.error);
console.log('Bot running...');
