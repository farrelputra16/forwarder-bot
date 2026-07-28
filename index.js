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
  const sourceName = sourceChannel.replace('@', '');
  const targetName = target.replace('@', '');

  if (channelInfo.mode === 'forward') {
      const formattedMessage = `📢 *NEW CALL BY "@${sourceName}"*\n\n${message.text}`;
      await forwardMessage(target, formattedMessage);
  } else if (channelInfo.mode === 'extract') {
    const cas = [...extractAddresses(message.text), ...extractEVMAddresses(message.text)];
    if (!cas.length) return;

    for (const ca of cas) {
      // Message 1: Instant
      const msg1 = `🚀 NEW CALL FROM "${sourceName}" TO "${targetName}"\n<code>${ca}</code>`;
      await forwardMessage(target, msg1, 'html');

      // Message 2: After Resolve
      const dexInfo = await fetchDexScreenerInfo(ca);
      if (dexInfo) {
        const mc = fmt(dexInfo.marketCap || 0);
        const p = parseFloat(dexInfo.price);
        const chg = dexInfo.priceChange1h !== undefined
          ? (dexInfo.priceChange1h > 0 ? `📈 +${dexInfo.priceChange1h.toFixed(1)}%` : `📉 ${dexInfo.priceChange1h.toFixed(1)}%`)
          : '';
        const msg2 = `⚡ Called ${mc}\n\n` +
                     `🪙 $${dexInfo.symbol || '?'} — ${dexInfo.name || '?'}\n` +
                     `⛓️ ${(dexInfo.chain || '?').toUpperCase()} · ${dexInfo.dexId || '?'}\n` +
                     `💵 $${dexInfo.price || '?'}  ${chg}\n` +
                     `💰 MC ${mc}  │  💧 Liq ${fmt(dexInfo.liquidity || 0)}\n` +
                     `📊 1h Vol ${fmt(dexInfo.volume1h || 0)}  │  24h Vol ${fmt(dexInfo.volume24h || 0)}\n\n` +
                     `🧠 0 Smart Money  ·  🏆 0 KOL\n` +
                     `Target: "${targetName}"`;
      }
      
      // Tracking logic
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
});

const channels = loadChannels();
for (const ch of Object.keys(channels)) {
    await addChannelListener(ch).catch(console.error);
}

bot.launch().catch(console.error);
console.log('Bot running...');
