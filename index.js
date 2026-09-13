import { bot } from './bot.js';
import { initScraper, startKeepAlive, addChannelListener, forwardMessage, onMessage, extractAddresses, extractEVMAddresses, fetchDexScreenerInfo, fetchFallbackMarketData, firstGood, waitForDexData, fmt, listClients } from './scraper.js';
import { config } from './config.js';
import { initTrackings, addTracking } from './tracking.js';
import { startWebServer } from './web.js';
import { initStore, loadUser, saveUser, getSessions, saveSession, deleteSession, listUserIds, logActivity } from './store.js';
import fs from 'fs';

// ── Single-instance lock: dua proses dengan session yang sama akan
// saling menendang koneksinya (offline terus) — tolak start kedua. ──
const LOCK_FILE = './bot.lock';
(function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (pid) {
      try {
        process.kill(pid, 0);
        console.error(`\n❌ Bot sudah berjalan (PID ${pid}). Hentikan dulu (Ctrl+C di terminal itu) lalu start lagi.\n   Menjalankan 2x dengan session yang sama = koneksi saling tendang = offline terus.\n`);
        process.exit(1);
      } catch (e) {
        if (e.code !== 'ESRCH') {
          console.error(`\n❌ Ada proses lain memakai lock (PID ${pid}).\n`);
          process.exit(1);
        }
        // ESRCH = PID mati → lock basi, ambil alih
      }
    }
  } catch {}
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
  const release = () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
})();

// ── Boot: restore EVERY saved Telegram account (multi-user) ──────
// sessions.json is the source of truth. A fresh deployment seeds it from
// the legacy env TELEGRAM_SESSION so old setups keep working untouched.

// Session yang dicabut server (logout dari HP / terminate all sessions) tidak
// akan pernah bisa dipakai lagi — buang otomatis agar tidak di-retry tiap boot.
const DEAD_SESSION = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|SESSION_EXPIRED/i;
function clearEnvSession() {
  try {
    if (!fs.existsSync('.env')) return;
    let env = fs.readFileSync('.env', 'utf8');
    env = env.replace(/^TELEGRAM_SESSION=.*$/m, 'TELEGRAM_SESSION=');
    fs.writeFileSync('.env', env);
  } catch {}
}

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
      const msg = e.errorMessage || e.message || '';
      console.warn('[Boot] Env session failed:', msg);
      if (DEAD_SESSION.test(msg)) {
        console.warn('[Boot] Session .env sudah mati di server — dibersihkan. Login ulang via: npm run login');
        clearEnvSession();
      }
    }
    return bootTid;
  }

  for (const [tid, sess] of Object.entries(sessions)) {
    if (!sess?.session) continue;
    try {
      const r = await initScraper(sess.session, { apiId: sess.apiId, apiHash: sess.apiHash, dcId: sess.dc || 0 });
      if (!bootTid) bootTid = r.tid;
    } catch (e) {
      const msg = e.errorMessage || e.message || '';
      console.warn(`[Boot] Session ${tid} failed: ${msg}`);
      if (DEAD_SESSION.test(msg)) {
        deleteSession(tid);
        console.warn(`[Boot] Session ${tid} yang mati dihapus dari sessions.json — login ulang via: npm run login`);
      }
    }
  }
  return bootTid;
}

const bootOwner = await bootAccounts();
initStore(bootOwner); // legacy flat channels.json migrates into this account
initTrackings();
// Web dashboard is OFF by default — full control lives in the Telegram bot.
// Re-enable anytime with: ENABLE_WEB=1 npm start
if (process.env.ENABLE_WEB === '1' || String(process.env.ENABLE_WEB).toLowerCase() === 'true') {
  startWebServer();
} else {
  console.log('[Web] Disabled — bot-only mode (set ENABLE_WEB=1 to enable dashboard)');
}
startKeepAlive();

// Banner jelas bila tidak ada akun yang terhubung (jalur lokal).
try {
  const up = listClients().filter(s => { try { return s.client && s.client.connected; } catch { return false; } });
  if (!up.length) {
    console.log('\n⚠️  TIDAK ADA AKUN TELEGRAM YANG TERHUBUNG');
    console.log('   Scraper MATI — bot & web hanya bisa atur setting, tidak bisa forward.');
    console.log('   Perbaiki dengan:  npm run login');
    console.log('   (masukkan kode OTP dari aplikasi Telegram)\n');
  } else {
    console.log(`[Boot] Akun aktif: ${up.map(s => '@' + (s.username || s.tid)).join(', ')}`);
  }
} catch {}

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
      // Semua sumber ditembak PARALEL sejak detik-0 (bersamaan kirim msg1):
      // Dex (kaya data) dan Jupiter+on-chain (biasanya lebih cepat).
      const dexP = fetchDexScreenerInfo(ca);
      const fastP = fetchFallbackMarketData(ca);
      await sendAll(targets, msg1, 'html', ownerTid);

      // BASELINE "called at" = data pertama yang ada harganya (t≈0, bukan t≈60s).
      // Tracking didaftarkan SECEPATNYA — tidak menunggu kartu lengkap.
      let tracked = false;
      const registerTracking = (info) => {
        if (tracked) return;
        const px = parseFloat(info?.price) || 0;
        if (!(channelInfo.tracking?.enabled && px > 0)) return;
        tracked = true;
        addTracking({
            ca,
            chain: info.chain || 'sol',
            calledAtPrice: px,
            calledAtMC: info.marketCap ? fmt(info.marketCap) : '?',
            symbol: info.symbol || ca.slice(0, 6),
            target: targets[0],
            owner: ownerTid,
            multipliers: channelInfo.tracking.multipliers || [2, 3, 5, 10],
            alertInterval: (channelInfo.tracking.interval || 3600),
            periodic: channelInfo.tracking.periodic || 'on',
            xAlerts: channelInfo.tracking.xAlerts || 'on',
        });
      };
      registerTracking(await firstGood([dexP, fastP]));

      // Kartu: Dex diutamakan (paling kaya), lalu fallback, lalu tunggu.
      // Kalau baseline tadi gagal total, enrichment jadi kesempatan terakhir.
      let dexInfo = null;
      try { dexInfo = await dexP; } catch {}
      if (!(dexInfo && parseFloat(dexInfo.price) > 0)) {
        try { dexInfo = await fastP; } catch {}
      }
      if (!(dexInfo && parseFloat(dexInfo.price) > 0)) {
        dexInfo = await waitForDexData(ca); // token baru: beri waktu ter-index
      }
      registerTracking(dexInfo);
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
    }
  }
});

// ── Register listeners for every connected account ───────────────
{
  const tids = listUserIds().filter(tid => Object.keys(loadUser(tid)).length);
  if (!tids.length) {
    console.log('[Boot] No channels configured yet — add some from the bot.');
  } else if (listClients().length === 0) {
    console.log(`[Boot] ${tids.length} akun punya channel tapi tidak ada client — listener dilewati (login dulu untuk mengaktifkan).`);
  } else {
    for (const tid of tids) {
      const chs = loadUser(tid);
      for (const src of Object.keys(chs)) {
        await addChannelListener(src, tid).catch(e =>
          console.warn(`[Boot] (${tid}) listener ${src}: ${e.message}`));
      }
    }
  }
}

bot.launch().catch(console.error);
console.log('Bot running...');
