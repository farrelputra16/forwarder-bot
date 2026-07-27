import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, fetchDexScreenerInfo, fetchTokenInfo, fmt } from './scraper.js';
import { config } from './config.js';
import { initTrackings, addTracking, getActiveCount } from './tracking.js';
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
console.log(`[Tracking] ${getActiveCount()} active trackings loaded`);

const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};

onMessage(async (sourceChannel, message) => {
  if (!message?.text) return;

  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;

  const target = channelInfo.target || config.targetChannel;
  const channelName = target.replace(/^https:\/\/t\.me\//, '').replace('@', '');

  if (channelInfo.mode === 'forward') {
    await forwardMessage(target, `📢 *NEW CALL BY ${channelName}*\n\n${message.text}`);
  } else if (channelInfo.mode === 'extract') {
    const cas = [...extractAddresses(message.text), ...extractEVMAddresses(message.text)];
    if (!cas.length) return;

    await Promise.all(cas.map(async (ca) => {
      const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca);

      // Parallel: send CA + fetch DexScreener + fetch GMGN (Solana)
      const [_, dexInfo, tokenInfo] = await Promise.all([
        forwardMessage(target, `🚀 *NEW CALL BY ${channelName}*\n\`${ca}\``),
        fetchDexScreenerInfo(ca),
        isSol ? fetchTokenInfo(ca, 'sol') : null,
      ]);

      // EVM: chain unknown upfront, fetch GMGN after DexScreener resolves
      const finalTokenInfo = tokenInfo || (dexInfo?.chain ? await fetchTokenInfo(ca, dexInfo.chain) : null);

      // Follow-up message — fire-and-forget
      const price = dexInfo?.price ? parseFloat(dexInfo.price) : 0;
      const formattedPrice = price >= 1 ? price.toFixed(2) : price.toExponential(4);
      const formattedMC = dexInfo?.marketCap ? fmt(dexInfo.marketCap) : '?';
      const lines = [`⚡ Called ${formattedMC} | Price: $${formattedPrice}`];

      if (dexInfo) {
        const chg = dexInfo.priceChange1h !== undefined
          ? (dexInfo.priceChange1h > 0 ? `📈 +${dexInfo.priceChange1h.toFixed(1)}%` : `📉 ${dexInfo.priceChange1h.toFixed(1)}%`)
          : '';
        lines.push('', `🪙 $${dexInfo.symbol || '?'} — ${dexInfo.name || '?'}`);
        lines.push(`⛓️ ${(dexInfo.chain || '?').toUpperCase()} · ${dexInfo.dexId || '?'}`);
        lines.push(`💵 $${dexInfo.price || '?'}  ${chg}`);
        lines.push(`💰 ${fmt(dexInfo.marketCap || 0)}  │  💧 ${fmt(dexInfo.liquidity || 0)}`);
        if (dexInfo.volume1h || dexInfo.volume24h) {
          lines.push(`📊 1h Vol ${dexInfo.volume1h ? fmt(dexInfo.volume1h) : ''}  │  24h Vol ${dexInfo.volume24h ? fmt(dexInfo.volume24h) : ''}`);
        }
      }

      const sm = finalTokenInfo?.wallet_tags_stat?.smart_wallets ?? 0;
      const kol = finalTokenInfo?.wallet_tags_stat?.renowned_wallets ?? 0;
      lines.push('', `🧠 ${sm} Smart Money  ·  🏆 ${kol} KOL`);

      forwardMessage(target, lines.join('\n')).catch(() => {});

      if (channelInfo.tracking?.enabled && dexInfo) {
        const price = parseFloat(dexInfo.price);
        if (price > 0) {
          addTracking({
            ca,
            chain: dexInfo.chain || 'sol',
            calledAtPrice: price,
            calledAtMC: dexInfo.marketCap || 0,
            symbol: dexInfo.symbol || ca.slice(0, 6),
            target,
            multipliers: channelInfo.tracking.multipliers,
            alertInterval: channelInfo.tracking.interval,
          });
        }
      }
    }));
  }
});

const channels = loadChannels();
for (const ch of Object.keys(channels)) {
  await addChannelListener(ch).catch(console.error);
}

bot.launch().catch(console.error);
console.log('Bot running...');

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
