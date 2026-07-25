import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, extractCAFromDexScreener, resolveChain, fetchTokenInfo, fetchDexScreenerInfo, formatTokenSummary } from './scraper.js';
import { config } from './config.js';
import { addTracking, initTrackings } from './tracking.js';
import fs from 'fs';
import http from 'http';


http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

await initScraper(config.telegram.session);

const DB_FILE = './channels.json';
const loadChannels = () => fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : {};

function fmtMC(n) {
  if (!n || isNaN(n)) return null;
  return n >= 1_000_000 ? '$' + (n / 1_000_000).toFixed(1) + 'M' :
         n >= 1_000 ? '$' + (n / 1_000).toFixed(1) + 'K' :
         '$' + Number(n).toFixed(2);
}

onMessage(async (sourceChannel, message) => {
  if (!message.text) return;
  
  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;
  
  const target = channelInfo.target || config.targetChannel;

  if (channelInfo.mode === 'forward') {
    await forwardMessage(target, message.text);
  } else if (channelInfo.mode === 'extract') {
    const solCAs = extractAddresses(message.text);
    const evmCAs = extractEVMAddresses(message.text);

    await Promise.all([
      ...solCAs.map(ca => forwardMessage(target, ca)),
      ...evmCAs.map(ca => forwardMessage(target, ca)),
    ]);

    const seen = new Set();
    const allItems = [];

    for (const ca of solCAs) { seen.add(ca); allItems.push({ ca, chain: 'sol' }); }
    for (const ca of evmCAs) { seen.add(ca); allItems.push({ ca, chain: null }); }

    const [dexResults, chainResults] = await Promise.all([
      extractCAFromDexScreener(message.text),
      Promise.all(evmCAs.map(ca => resolveChain(ca))),
    ]);

    for (let i = 0; i < evmCAs.length; i++) {
      const item = allItems.find(it => it.ca === evmCAs[i]);
      if (item && chainResults[i]) item.chain = chainResults[i];
    }

    const newDex = dexResults.filter(({ ca }) => !seen.has(ca));
    if (newDex.length) {
      await Promise.all(newDex.map(({ ca }) => forwardMessage(target, ca)));
      for (const { ca, chain } of newDex) { seen.add(ca); allItems.push({ ca, chain }); }
    }

    if (allItems.length === 0) return;

    const infoResults = await Promise.all(
      allItems.map(async ({ ca, chain }) => {
        if (!chain) return { ca, mcLabel: null, info: null, dexPrice: null };

        const [dexInfo, info] = await Promise.all([
          fetchDexScreenerInfo(ca),
          fetchTokenInfo(ca, chain),
        ]);

        const mcLabel = dexInfo?.marketCap ? fmtMC(dexInfo.marketCap) : null;
        const dexPrice = dexInfo?.price ? parseFloat(dexInfo.price) : null;

        return { ca, mcLabel, info, dexPrice };
      })
    );

    for (const { ca, mcLabel, info, dexPrice } of infoResults) {
      if (!info) continue;

      const smCount = info.wallet_tags_stat?.smart_wallets ?? 0;
      const kolCount = info.wallet_tags_stat?.renowned_wallets ?? 0;

      const summary = formatTokenSummary(info);
      if (!summary) continue;

      let msg = mcLabel ? `⚡ Called at ${mcLabel}\n\n` : '';
      msg += summary;
      msg += `\n\n🧠 SM ${smCount}  🏆 KOL ${kolCount}`;
      await forwardMessage(target, msg, 'html');

      if (channelInfo.tracking?.enabled && dexPrice > 0) {
        addTracking({
          ca, chain,
          calledAtPrice: dexPrice,
          calledAtMC: mcLabel || '',
          symbol: info.symbol || '',
          target,
          multipliers: channelInfo.tracking.multipliers,
          alertInterval: channelInfo.tracking.interval,
        });
      }
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.log('[unhandledRejection]', err.message || err);
});
process.on('uncaughtException', (err) => {
  console.log('[uncaughtException]', err.message || err);
});

const channels = loadChannels();
for (const ch of Object.keys(channels)) {
  await addChannelListener(ch).catch(console.error);
}

initTrackings();

bot.launch().catch((err) => {
  console.log('[Bot API]', err.message, '— commands disabled, MTProto still active');
});
console.log('Bot running...');
