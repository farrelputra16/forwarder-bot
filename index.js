import { bot } from './bot.js';
import { initScraper, startKeepAlive, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, fetchDexScreenerInfo, fmt } from './scraper.js';
import { config } from './config.js';
import { initTrackings, addTracking } from './tracking.js';
import { startWebServer } from './web.js';
import { initStore, loadUser, saveUser, getSessions, saveSession, listUserIds, logActivity } from './store.js';

// ── Boot: restore EVERY saved Telegram account (multi-user) ──────
// sessions.json is the source of truth. A fresh deployment seeds it from
// the legacy env TELEGRAM_SESSION so old setups keep working untouched.

async function bootAccounts() {
  const sessions = getSessions();
  let bootTid = null;

  if (!Object.keys(sessions).length && config.telegram.session) {
    console.log('[Boot] Seeding sessions.json from legacy TELEGRAM_SESSION…');
    try {
      const r = await initScraper(config.telegram.session);
      bootTid = r.tid;
      saveSession(r.tid, {
        session: config.telegram.session,
        apiId: config.telegram.apiId,
        apiHash: config.telegram.apiHash,
        dc: 0,
        username: '',
      });
    } catch (e) {
      console.warn('[Boot] Env session failed:', e.message);
    }
    return bootTid;
  }

  for (const [tid, sess] of Object.entries(sessions)) {
    if (!sess?.session) continue;
    try {
      const r = await initScraper(sess.session, { apiId: sess.apiId, apiHash: sess.apiHash, dcId: sess.dc || 0 });
      if (!bootTid) bootTid = r.tid;
    } catch (e) {
      console.warn(`[Boot] Session ${tid} failed: ${e.message}`);
    }
  }
  return bootTid;
}

const bootOwner = await bootAccounts();
initStore(bootOwner); // legacy flat channels.json migrates into this account
initTrackings();
startWebServer();
startKeepAlive();

// ── Forwarding Logic — hot path: zero blocking IO, targets fanned out in parallel ──
const sendAll = async (targets, text, parseMode, tid) => {
  const results = await Promise.allSettled(targets.map(t => forwardMessage(t, text, parseMode, tid)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[Forward] (${tid}) → ${targets[i]} failed: ${r.reason?.message || r.reason}`);
      logActivity('error', `⚠️ Gagal kirim ke ${targets[i]}: ${r.reason?.message || r.reason}`);
    }
  });
};

onMessage(async (ownerTid, sourceChannel, message) => {
  if (!message.text) return;

  const channels = loadUser(ownerTid);
  const channelInfo = channels[sourceChannel];
  if (!channelInfo || !channelInfo.active) return;

  const targets = channelInfo.targets || (channelInfo.target ? [channelInfo.target] : [config.targetChannel]);

  if (channelInfo.mode === 'forward') {
    await sendAll(targets, message.text, null, ownerTid);
    logActivity('forward', `📨 [${ownerTid}] ${sourceChannel} → ${targets.join(', ')}`);
  } else if (channelInfo.mode === 'extract') {
    const cas = [...extractAddresses(message.text), ...extractEVMAddresses(message.text)];
    if (!cas.length) return;

    for (const ca of cas) {
      let isDup = false;
      if (channelInfo.ignoreDuplicate) {
        if (!channelInfo.seenCAs) channelInfo.seenCAs = [];
        if (channelInfo.seenCAs.includes(ca)) { isDup = true; }
        else {
          channelInfo.seenCAs.push(ca);
          saveUser(ownerTid, channels); // async — never blocks the loop
        }
      }
      if (isDup) continue;

      const msg1 = `NEW CALL\n<code>${ca}</code>`;
      await sendAll(targets, msg1, 'html', ownerTid);

      // The detail card ALWAYS goes out — rich data when DexScreener responds,
      // a graceful fallback card when it doesn't. Never silently skipped.
      const dexInfo = await fetchDexScreenerInfo(ca);
      const price = dexInfo ? parseFloat(dexInfo.price) : 0;
      let msg2;
      let mc = '?';
      if (dexInfo && price > 0) {
        mc = fmt(dexInfo.marketCap || 0);
        const chg = dexInfo.priceChange1h !== undefined
          ? (dexInfo.priceChange1h > 0 ? `📈 +${dexInfo.priceChange1h.toFixed(1)}%` : `📉 ${dexInfo.priceChange1h.toFixed(1)}%`)
          : '';
        msg2 = `⚡ Called ${mc}\n\n` +
               `🪙 $${dexInfo.symbol || '?'} — ${dexInfo.name || '?'}\n` +
               `⛓️ ${(dexInfo.chain || '?').toUpperCase()} · ${dexInfo.dexId || '?'}\n` +
               `💵 $${dexInfo.price || '?'}  ${chg}\n` +
               `💰 MC ${mc}  │  💧 Liq ${fmt(dexInfo.liquidity || 0)}\n` +
               `📊 1h Vol ${fmt(dexInfo.volume1h || 0)}  │  24h Vol ${fmt(dexInfo.volume24h || 0)}\n\n` +
               `🧠 0 Smart Money  ·  🏆 0 KOL`;
      } else {
        const sym = (dexInfo && dexInfo.symbol) || ca.slice(0, 4).toUpperCase();
        msg2 = `⚡ Called\n\n` +
               `🪙 $${sym}\n<code>${ca}</code>\n` +
               `⚠️ Market data unavailable — will not track this call`;
        logActivity('error', `⚠️ DexScreener no data for $${sym} (${ca.slice(0, 6)}…)`);
      }
      await sendAll(targets, msg2, 'html', ownerTid);
      logActivity('ca', `⚡ $${(dexInfo && dexInfo.symbol) || ca.slice(0, 6)} (${mc}) [${ownerTid}] → ${targets[0]}`);

      if (channelInfo.tracking?.enabled && price > 0) {
        addTracking({
            ca,
            chain: dexInfo.chain || 'sol',
            calledAtPrice: price,
            calledAtMC: mc,
            symbol: dexInfo.symbol || ca.slice(0, 6),
            target: targets[0],
            owner: ownerTid,
            multipliers: channelInfo.tracking.multipliers || [2, 3, 5, 10],
            alertInterval: (channelInfo.tracking.interval || 3600),
            periodic: channelInfo.tracking.periodic || 'on',
            xAlerts: channelInfo.tracking.xAlerts || 'on',
        });
      }
    }
  }
});

// ── Register listeners for every connected account ───────────────
for (const tid of listUserIds()) {
  const chs = loadUser(tid);
  for (const src of Object.keys(chs)) {
    await addChannelListener(src, tid).catch(e =>
      console.warn(`[Boot] (${tid}) listener ${src}: ${e.message}`));
  }
}

bot.launch().catch(console.error);
console.log('Bot running...');
