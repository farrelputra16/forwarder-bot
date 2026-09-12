// npm run login — login Telegram lokal (API ID/Hash + OTP), session otomatis
// disimpan ke sessions.json dan TELEGRAM_SESSION di .env diperbarui.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

let apiId = parseInt(process.env.TELEGRAM_API_ID);
if (!apiId || isNaN(apiId)) {
  apiId = parseInt(await ask('API ID (dari my.telegram.org): '));
}
let apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
if (!apiHash) {
  apiHash = (await ask('API Hash: ')).trim();
}
if (!apiId || !apiHash) {
  console.log('❌ API ID / Hash wajib diisi. Ambil di https://my.telegram.org/apps');
  process.exit(1);
}

console.log('\nMenghubungkan ke Telegram…');
console.log('(kode OTP hanya diminta SEKALI — sesudah ini tersimpan permanen)\n');
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
try {
  await client.start({
    phoneNumber: async () => (await ask('Nomor HP (+62…): ')).trim(),
    phoneCode: async () => (await ask('Kode OTP (cek aplikasi Telegram): ')).trim(),
    password: async () => await ask('Password 2FA (Enter bila tidak ada): '),
    onError: (err) => console.log('[login]', err.message || err),
  });
} catch (e) {
  const msg = e.errorMessage || e.message || '';
  const secs = e.seconds || (/FLOOD_WAIT_(\d+)/.exec(msg)?.[1] * 1) || 0;
  if (/FLOOD/i.test(msg) || secs > 0) {
    const mins = Math.max(1, Math.ceil((secs || 300) / 60));
    console.log(`\n⏳ Telegram membatasi permintaan kode (anti-spam).`);
    console.log(`   Tunggu ±${mins} menit TANPA minta kode lagi, lalu ulangi: npm run login`);
    console.log('   (Setiap permintaan baru me-reset timer — jadi jangan spam.)');
  } else {
    console.log('❌ Login gagal:', msg);
  }
  process.exit(1);
}

const session = client.session.save();
const me = await client.getMe();
const tid = String(me.id);
console.log(`\n✅ Login sebagai @${me.username || tid} (${tid})`);

// 1) simpan ke sessions.json (sumber utama multi-user)
const { saveSession } = await import('./store.js');
saveSession(tid, { session, apiId, apiHash, dc: 0, username: me.username || '' });
console.log('✅ Session tersimpan di sessions.json');

// 2) sinkronkan .env agar konsisten
try {
  let env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const set = (k, v) => {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(env)) env = env.replace(re, `${k}=${v}`);
    else env += (env.endsWith('\n') || !env ? '' : '\n') + `${k}=${v}\n`;
  };
  set('TELEGRAM_API_ID', String(apiId));
  set('TELEGRAM_API_HASH', apiHash);
  set('TELEGRAM_SESSION', session);
  fs.writeFileSync('.env', env);
  console.log('✅ .env diperbarui (TELEGRAM_SESSION baru)');
} catch (e) {
  console.log('⚠️ Gagal update .env:', e.message);
}

await client.destroy().catch(() => {});
rl.close();
console.log('\nSelesai. Jalankan: npm start');
process.exit(0);
