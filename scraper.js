import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';

let client = null;
let forwardHandler = null;

// Logic extracted from original SniperBot
const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;
const BS58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BS58_MAP = {};
for (let i = 0; i < BS58_ALPHA.length; i++) BS58_MAP[BS58_ALPHA[i]] = i;

function bs58Decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BS58_MAP[c]);
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  return Buffer.from(bytes);
}

function isValidSolAddress(addr) {
  if (addr.length < 32 || addr.length > 44) return false;
  try {
    const decoded = bs58Decode(addr);
    return decoded.length === 32;
  } catch { return false; }
}

export function extractAddresses(text) {
  const addresses = [];
  const solMatches = text.match(BASE58_REGEX) || [];
  for (const addr of solMatches) {
    if (isValidSolAddress(addr)) {
      addresses.push(addr);
    }
  }
  return [...new Set(addresses)]; // Unique
}
// End extracted logic

export async function initScraper(sessionStr) {
  const { apiId, apiHash } = config.telegram;
  const stringSession = new StringSession(sessionStr || '');
  client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log('[Scraper] Connected');
  return client;
}

export function onMessage(cb) {
  forwardHandler = cb;
}

export async function resolveAndJoin(identifier) {
  if (!client) throw new Error('Telegram not connected');
  const { Api } = await import('telegram');

  // Try fetching directly first
  try {
    const entity = await client.getEntity(identifier);
    console.log(`[Scraper] Resolved ${identifier} directly.`);
    return entity;
  } catch (e) {
    console.log(`[Scraper] getEntity failed for ${identifier}, trying invite link...`);
  }

  // Handle invite link
  let hash = identifier.includes('t.me/+') ? identifier.split('t.me/+')[1] : identifier;
  if (hash.startsWith('+')) hash = hash.slice(1);

  try {
    const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    if (imported.chats?.length) {
      console.log(`[Scraper] Joined ${identifier} via invite link.`);
      return await client.getEntity(imported.chats[0]);
    }
  } catch (e) {
    // If error is USER_ALREADY_PARTICIPANT, it's actually fine, we just need to get it
    if (e.errorMessage === 'USER_ALREADY_PARTICIPANT') {
        console.log(`[Scraper] Already participant of ${identifier}, resolving again...`);
        // Try resolving again after realizing we are a participant
        return await client.getEntity(identifier).catch(() => {
            // If direct resolution still fails, we might need to search dialogs
            return client.getDialogs({ limit: 100 }).then(dialogs => {
                const found = dialogs.find(d => d.entity?.username === hash || d.entity?.title === hash);
                if (found) return found.entity;
                throw new Error('User is participant but cannot resolve entity');
            });
        });
    }
    console.log(`[Scraper] ImportChatInvite failed: ${e.message}`);
  }

  throw new Error(`Could not resolve or join: ${identifier}`);
}

export async function addChannelListener(identifier) {
  if (!client) throw new Error('Client not initialized');
  
  const entity = await resolveAndJoin(identifier);
  
  // Clean previous handler if needed (simplified)
  client.addEventHandler(async (event) => {
    if (forwardHandler) await forwardHandler(identifier, event.message);
  }, new NewMessage({ chats: [entity.id] }));
  
  console.log(`[Scraper] Listening to ${identifier}`);
  return true;
}

export async function forwardMessage(targetChannel, text) {
  if (!client) throw new Error('Client not initialized');
  await client.sendMessage(targetChannel, { message: text });
}
