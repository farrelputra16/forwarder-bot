import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// GANTI DENGAN API_ID DAN HASH ANDA DI SINI
const apiId = 20222905; 
const apiHash = '7571ef94581e7bc53900a6f7db4bff34';

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {});
await client.start({
  phoneNumber: () => ask('Phone number: '),
  phoneCode: () => ask('Code: '),
  password: () => ask('Password: '),
  onError: (err) => console.log(err),
});

console.log('SESSION STRING:', client.session.save());
process.exit(0);
