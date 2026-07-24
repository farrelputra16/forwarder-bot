import { bot } from './bot.js';
import { initScraper, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, extractCAFromDexScreener, resolveChain, fetchTokenInfo, fetchTokenHolders, formatTokenSummary, formatWalletLines } from './scraper.js';
import { config } from './config.js';
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

onMessage(async (sourceChannel, message) => {
  if (!message.text) return;
  
  const channels = loadChannels();
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;
  
  const target = channelInfo.target || config.targetChannel;

  if (channelInfo.mode === 'forward') {
    await forwardMessage(target, message.text);
  } else if (channelInfo.mode === 'extract') {
    const t0 = Date.now();

    const solCAs = extractAddresses(message.text);
    const evmCAs = extractEVMAddresses(message.text);
    const dexResults = await extractCAFromDexScreener(message.text);

    const seen = new Set();
    const allItems = [];

    for (const ca of solCAs) { seen.add(ca); allItems.push({ ca, chain: 'sol' }); }
    for (const ca of evmCAs) { seen.add(ca); allItems.push({ ca, chain: null }); }
    for (const { ca, chain } of dexResults) {
      if (seen.has(ca)) continue;
      seen.add(ca);
      allItems.push({ ca, chain });
    }

    for (const ca of evmCAs) {
      const chain = await resolveChain(ca);
      const item = allItems.find(i => i.ca === ca);
      if (item && chain) item.chain = chain;
    }

    const unique = [];
    const dedup = new Set();
    for (const item of allItems) {
      if (!dedup.has(item.ca)) { dedup.add(item.ca); unique.push(item); }
    }

    if (unique.length === 0) return;

    const infoResults = await Promise.all(
      unique.map(async ({ ca, chain }) => {
        if (!chain) return { ca, chain: null, info: null };
        const info = await fetchTokenInfo(ca, chain);
        return { ca, chain, info };
      })
    );

    for (const { ca, chain, info } of infoResults) {
      if (!info || !chain) continue;

      const elapsed = Date.now() - t0;

      const mc = info._dex
        ? info._dex.marketCap
        : (info.circulating_supply && info.price?.price
            ? parseFloat(info.price.price) * parseFloat(info.circulating_supply)
            : 0);

      const mcLabel = mc > 0
        ? (mc >= 1_000_000 ? '$' + (mc / 1_000_000).toFixed(1) + 'M' :
           mc >= 1_000 ? '$' + (mc / 1_000).toFixed(1) + 'K' :
           '$' + Number(mc).toFixed(2))
        : null;

      const [smWallets, kolWallets] = await Promise.all([
        fetchTokenHolders(ca, chain, 'smart_degen', 5),
        fetchTokenHolders(ca, chain, 'renowned', 5),
      ]);

      const smCount = info.wallet_tags_stat?.smart_wallets ?? smWallets.length;
      const kolCount = info.wallet_tags_stat?.renowned_wallets ?? kolWallets.length;

      const summary = formatTokenSummary(info);

      let msg = `<code>${ca}</code>`;
      if (mcLabel) msg += `\n⚡ Called at ${mcLabel}`;
      msg += `  |  ⏱ ${elapsed}ms`;
      if (summary) msg += '\n\n' + summary;
      msg += `\n\n🧠 SM ${smCount}  🏆 KOL ${kolCount}`;

      const walletLines = [
        ...formatWalletLines(smWallets, chain, 'smart_degen'),
        ...formatWalletLines(kolWallets, chain, 'renowned'),
      ];
      if (walletLines.length) msg += '\n\n' + walletLines.join('\n');

      await forwardMessage(target, msg, 'html');
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

bot.launch().catch((err) => {
  console.log('[Bot API]', err.message, '— commands disabled, MTProto still active');
});
console.log('Bot running...');
