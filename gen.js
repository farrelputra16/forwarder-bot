// npm run login — local Telegram login (API ID/Hash + OTP); session auto-
// saved to sessions.json and TELEGRAM_SESSION in .env gets updated.
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
  apiId = parseInt(await ask('API ID (from my.telegram.org): '));
}
let apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
if (!apiHash) {
  apiHash = (await ask('API Hash: ')).trim();
}
if (!apiId || !apiHash) {
  console.log('❌ API ID / Hash are required. Get them at https://my.telegram.org/apps');
  process.exit(1);
}

console.log('\nConnecting to Telegram…');
console.log('(OTP code is asked only ONCE — it is stored permanently after this)\n');
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
try {
  await client.start({
    phoneNumber: async () => (await ask('Phone number (+62…): ')).trim(),
    phoneCode: async () => (await ask('OTP code (check the Telegram app): ')).trim(),
    password: async () => await ask('2FA password (Enter if none): '),
    onError: (err) => console.log('[login]', err.message || err),
  });
} catch (e) {
  const msg = e.errorMessage || e.message || '';
  const secs = e.seconds || (/FLOOD_WAIT_(\d+)/.exec(msg)?.[1] * 1) || 0;
  if (/FLOOD/i.test(msg) || secs > 0) {
    const mins = Math.max(1, Math.ceil((secs || 300) / 60));
    console.log(`\n⏳ Telegram is rate-limiting code requests (anti-spam).`);
    console.log(`   Wait ±${mins} min WITHOUT requesting another code, then retry: npm run login`);
    console.log('   (Every new request resets the timer — so do not spam.)');
  } else {
    console.log('❌ Login failed:', msg);
  }
  process.exit(1);
}

const session = client.session.save();
const me = await client.getMe();
const tid = String(me.id);
console.log(`\n✅ Logged in as @${me.username || tid} (${tid})`);

// 1) save to sessions.json (primary multi-user source)
const { saveSession } = await import('./store.js');
saveSession(tid, { session, apiId, apiHash, dc: 0, username: me.username || '' });
console.log('✅ Session saved to sessions.json');

// 2) sync .env to stay consistent
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
  console.log('✅ .env updated (new TELEGRAM_SESSION)');
} catch (e) {
  console.log('⚠️ Failed to update .env:', e.message);
}

await client.destroy().catch(() => {});
rl.close();
console.log('\nDone. Run: npm start');
process.exit(0);
