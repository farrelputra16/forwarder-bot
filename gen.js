import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {});
await client.start({
  phoneNumber: () => ask('Phone number: '),
  phoneCode: () => ask('Code: '),
  password: () => ask('Password: '),
  onError: (err) => console.log(err),
});

console.log('SESSION STRING:', client.session.save());
process.exit(0);
