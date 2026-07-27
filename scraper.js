import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';

let client = null;
let forwardHandler = null;

// ── Address Extraction ──────────────────────────────────────────

const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;
const EVM_REGEX = /0x[a-fA-F0-9]{40}/g;
const DEXSCREENER_REGEX = /https:\/\/dexscreener\.com\/(\w+)\/([A-Za-z0-9]{32,48})/g;
const BS58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BS58_MAP = {};
for (let i = 0; i < BS58_ALPHA.length; i++) BS58_MAP[BS58_ALPHA[i]] = i;

const CHAIN_MAP = {
  solana: 'sol',
  bsc: 'bsc',
  base: 'base',
  ethereum: 'eth',
  robinhood: 'robinhood',
  polygon: 'polygon',
  avalanche: 'avalanche',
  fantom: 'fantom',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  tron: 'tron',
  monad: 'monad',
};

const GMGN_CHAINS = new Set(['sol', 'bsc', 'base', 'eth']);

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
  const clean = text.replace(DEXSCREENER_REGEX, '');
  const addresses = [];
  const solMatches = clean.match(BASE58_REGEX) || [];
  for (const addr of solMatches) {
    if (isValidSolAddress(addr)) {
      addresses.push(addr);
    }
  }
  return [...new Set(addresses)];
}

export function extractEVMAddresses(text) {
  const matches = text.match(EVM_REGEX) || [];
  return [...new Set(matches)];
}

// ── Chain Resolution via DexScreener ────────────────────────────

export async function resolveChain(ca) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`);
    const data = await res.json();
    if (!data.pairs?.length) return null;
    const pair = data.pairs.find(p => p.baseToken?.address?.toLowerCase() === ca.toLowerCase());
    return pair ? CHAIN_MAP[pair.chainId] || pair.chainId : null;
  } catch {
    return null;
  }
}

export async function extractCAFromDexScreener(text) {
  const pairs = [];
  let match;
  while ((match = DEXSCREENER_REGEX.exec(text)) !== null) {
    pairs.push({ pair: match[2], chain: CHAIN_MAP[match[1]] || match[1] });
  }
  if (pairs.length === 0) return [];

  const results = await Promise.all(pairs.map(async ({ pair, chain }) => {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${pair}`);
      const data = await res.json();
      const ca = data.pairs?.[0]?.baseToken?.address;
      return ca ? { ca, chain } : null;
    } catch {
      return null;
    }
  }));

  return results.filter(Boolean);
}

// ── Fetch: GMGN ─────────────────────────────────────────────────

export async function fetchTokenInfo(ca, chain) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  let data = null;
  if (GMGN_CHAINS.has(chain)) {
    try {
      const { stdout } = await execAsync(`gmgn-cli token info --chain ${chain} --address ${ca} --raw`);
      data = JSON.parse(stdout);
    } catch {}
  }

  const isEmpty = !data || !data.price || data.price.price === '0';
  if (isEmpty) {
    const dex = await fetchDexScreenerInfo(ca);
    if (dex) {
      data = { ...(data || {}), _dex: dex, _fallback: true };
    }
  }

  return data;
}

export async function fetchTokenHolders(ca, chain, tag = 'smart_degen', limit = 5) {
  if (!GMGN_CHAINS.has(chain)) return [];
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      `gmgn-cli token holders --chain ${chain} --address ${ca} --tag ${tag} --limit ${limit} --raw`
    );
    const data = JSON.parse(stdout);
    return data.list || [];
  } catch {
    return [];
  }
}

// ── Fetch: DexScreener (promise-cached) ─────────────────────────

const dexCache = new Map();

export async function fetchDexScreenerInfo(ca) {
  if (dexCache.has(ca)) return dexCache.get(ca);
  const promise = _fetchDexScreener(ca).finally(() => dexCache.delete(ca));
  dexCache.set(ca, promise);
  return promise;
}

async function _fetchDexScreener(ca) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`);
    const data = await res.json();
    if (!data.pairs?.length) return null;
    const pair = data.pairs.find(p => p.baseToken?.address?.toLowerCase() === ca.toLowerCase())
      || data.pairs[0];
    return {
      chain: CHAIN_MAP[pair.chainId] || pair.chainId,
      symbol: pair.baseToken?.symbol || '',
      name: pair.baseToken?.name || '',
      price: pair.priceUsd || '0',
      marketCap: pair.marketCap || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      volume1h: pair.volume?.h1 || 0,
      priceChange1h: pair.priceChange?.h1,
      priceChange6h: pair.priceChange?.h6,
      priceChange24h: pair.priceChange?.h24,
      fdv: pair.fdv || 0,
      url: pair.url || '',
      pairAddress: pair.pairAddress || '',
      dexId: pair.dexId || '',
      imageUrl: pair.info?.imageUrl || '',
      socials: pair.info?.socials || [],
    };
  } catch {
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────

export function fmt(n, digits = 2) {
  if (n === undefined || n === null || isNaN(n)) return '?';
  if (Math.abs(n) >= 1_000_000_000) return '$' + (n / 1_000_000_000).toFixed(1) + 'B';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + Number(n).toFixed(digits);
}

function priceChange(current, previous) {
  if (!current || !previous || parseFloat(previous) === 0) return null;
  return ((parseFloat(current) - parseFloat(previous)) / parseFloat(previous)) * 100;
}

function changeEmoji(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct > 0) return `📈 +${pct.toFixed(1)}%`;
  if (pct < 0) return `📉 ${pct.toFixed(1)}%`;
  return `➡️ 0.0%`;
}

function shortAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

export function formatWalletLines(wallets, chain, tag) {
  if (!wallets.length) return [];
  const emoji = tag === 'smart_degen' ? '🧠' : '🏆';
  const label = tag === 'smart_degen' ? 'Smart Money' : 'KOL';
  const lines = [`${emoji} ${label} Top ${wallets.length}:`];

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const addr = w.address || '';
    const gmgnUrl = `https://gmgn.ai/${chain}/address/${addr}`;
    const display = w.name || shortAddr(addr);
    const profit = w.realized_profit || w.profit || 0;
    const holdPct = w.amount_percentage ? (parseFloat(w.amount_percentage) * 100).toFixed(1) + '%' : '';
    const profitStr = profit > 0 ? `+$${Number(profit).toLocaleString()}` : profit < 0 ? `-$${Math.abs(profit).toLocaleString()}` : '';
    const tagLabel = w.maker_token_tags?.includes('bundler') ? ' ⚠️bundler' : '';
    const meta = [profitStr, holdPct, tagLabel].filter(Boolean).join(' · ');
    lines.push(`${medals[i] || '•'} ${display}${meta ? ` — ${meta}` : ''}\n   ${gmgnUrl}`);
  }

  return lines;
}

export function formatTokenSummary(data) {
  if (!data) return null;

  // DexScreener fallback
  if (data._dex) {
    const d = data._dex;
    const p = parseFloat(d.price);
    const mc = d.marketCap ? fmt(d.marketCap) : '?';
    const liq = d.liquidity ? fmt(d.liquidity) : '?';
    const vol1h = d.volume1h ? fmt(d.volume1h) : '';
    const vol24h = d.volume24h ? fmt(d.volume24h) : '';
    const holders = data.holder_count?.toLocaleString() ?? '?';
    const sm = data.wallet_tags_stat?.smart_wallets ?? 0;
    const kol = data.wallet_tags_stat?.renowned_wallets ?? 0;

    let lines = [];
    lines.push(`🪙 $${d.symbol} — ${d.name}`);
    lines.push(`⛓️ ${d.chain.toUpperCase()} · ${d.dexId}`);
    lines.push(`💵 $${d.price}  ${d.priceChange1h !== undefined ? changeEmoji(d.priceChange1h) : ''}`);
    lines.push(`💰 MC ${mc}  │  💧 Liq ${liq}`);
    if (holders !== '?') lines.push(`👥 ${holders}  │  🧠 SM ${sm}  │  🏆 KOL ${kol}`);
    if (vol1h || vol24h) lines.push(`📊 1h Vol ${vol1h}  │  24h Vol ${vol24h}`);

    const socials = d.socials || [];
    const parts = [];
    for (const s of socials) {
      if (s.type === 'twitter') parts.push(`🐦 [X](${s.url})`);
      else if (s.type === 'telegram') parts.push(`💬 [TG](${s.url})`);
      else if (s.type === 'website') parts.push(`🌐 [Web](${s.url})`);
    }
    if (parts.length) lines.push(parts.join('  │  '));

    return lines.join('\n');
  }

  // GMGN data
  const p = data.price || {};
  const price = p.price || '?';
  const mc = data.circulating_supply && p.price
    ? fmt(parseFloat(p.price) * parseFloat(data.circulating_supply), 0)
    : '?';
  const liq = data.liquidity ? fmt(Number(data.liquidity)) : '?';
  const holders = data.holder_count?.toLocaleString() ?? '?';
  const sm = data.wallet_tags_stat?.smart_wallets ?? 0;
  const kol = data.wallet_tags_stat?.renowned_wallets ?? 0;
  const creation = data.creation_timestamp
    ? Math.floor((Date.now() / 1000 - data.creation_timestamp) / 3600) + 'h ago'
    : '';
  const launchpad = data.launchpad_platform || data.launchpad || '';

  const change1h = priceChange(p.price, p.price_1h);
  const change6h = priceChange(p.price, p.price_6h);
  const change24h = priceChange(p.price, p.price_24h);

  const vol1h = p.volume_1h ? fmt(Number(p.volume_1h)) : '';
  const vol24h = p.volume_24h ? fmt(Number(p.volume_24h)) : '';

  const social = [];
  if (data.link?.twitter_username) social.push(`🐦 @${data.link.twitter_username}`);
  if (data.link?.telegram) social.push(`💬 TG`);
  if (data.link?.website) social.push(`🌐 Web`);

  const lines = [];
  lines.push(`🪙 $${data.symbol} — ${data.name}`);
  if (launchpad) lines.push(`🏭 ${launchpad}${creation ? ` · ${creation}` : ''}`);
  lines.push(`💵 $${price}  ${change1h !== null ? changeEmoji(change1h) : ''}`);
  lines.push(`💰 MC ${mc}  │  💧 Liq ${liq}  │  👥 ${holders}`);
  lines.push(`🧠 SM ${sm}  │  🏆 KOL ${kol}`);
  if (vol1h || vol24h) lines.push(`📊 1h Vol ${vol1h}  │  24h Vol ${vol24h}`);
  if (social.length > 0) lines.push(social.join('  │  '));

  return lines.join('\n');
}

// ── Telegram Client ─────────────────────────────────────────────

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

  const inviteMatch = identifier.match(/t\.me\/(\+[\w]+)/);
  const isInvite = !!inviteMatch;
  const hash = isInvite ? inviteMatch[1] : identifier.replace(/^@/, '');

  if (isInvite) {
    const cleanHash = hash.replace('+', '');
    try {
      const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash: cleanHash }));
      if (invite.chat) {
        console.log(`[Scraper] Resolved ${identifier} via CheckChatInvite.`);
        return invite.chat;
      }
    } catch (e) {
      console.log(`[Scraper] CheckChatInvite failed, trying ImportChatInvite...`);
    }

    try {
      const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash: cleanHash }));
      if (imported.chats?.length) {
        console.log(`[Scraper] Joined ${identifier} via invite link.`);
        return imported.chats[0];
      }
    } catch (e) {
      if (e.errorMessage === 'USER_ALREADY_PARTICIPANT') {
        const dialogs = await client.getDialogs({ limit: 200 });
        const found = dialogs.find(d => {
          if (!d.entity) return false;
          const title = d.entity.title || '';
          return title === (invite?.chat?.title || '') ||
                 d.entity.username === cleanHash;
        });
        if (found) return found.entity;
        throw new Error(`Already participant but cannot find "${identifier}" in dialogs`);
      }
      console.log(`[Scraper] ImportChatInvite failed: ${e.message}`);
      throw e;
    }
  } else {
    const username = identifier.includes('t.me/')
      ? identifier.split('t.me/').pop()
      : identifier;
    try {
      return await client.getEntity(username);
    } catch (e) {
      console.log(`[Scraper] getEntity failed for ${username}`);
      throw e;
    }
  }

  throw new Error(`Could not resolve or join: ${identifier}`);
}

export async function addChannelListener(identifier) {
  if (!client) throw new Error('Client not initialized');
  
  const entity = await resolveAndJoin(identifier);
  
  client.addEventHandler(async (event) => {
    if (forwardHandler) await forwardHandler(identifier, event.message);
  }, new NewMessage({ chats: [entity.id] }));
  
  console.log(`[Scraper] Listening to ${identifier}`);
  return true;
}

export async function forwardMessage(targetChannel, text, parseMode) {
  if (!client) throw new Error('Telegram not initialized');
  const opts = { message: text };
  if (parseMode) opts.parseMode = parseMode;
  await client.sendMessage(targetChannel, opts);
}
