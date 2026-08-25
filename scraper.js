import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';
import { loadUser } from './store.js';
import fs from 'fs';
import crypto from 'crypto';

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

async function _fetchDexScreener(ca, attempt = 0) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${ca}`);
    // Rate-limited / transient server errors → retry with backoff instead of giving up
    if (!res.ok) throw Object.assign(new Error(`dexscreener HTTP ${res.status}`), { retryable: res.status === 429 || res.status >= 500 });
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
  } catch (e) {
    if (attempt < 2 && e.retryable !== false) {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      return _fetchDexScreener(ca, attempt + 1);
    }
    console.error(`[DexScreener] failed for ${ca}: ${e.message}`);
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

// ── Multi-user Telegram clients ─────────────────────────────────
// Each logged-in account (own API ID/Hash + session) gets an isolated client,
// listener set and caches. Data isolation is enforced by scoping every store
// call to the account's telegram id.

const _clients = new Map(); // tid → state

function makeState(tid) {
  return {
    tid,
    client: null,
    apiId: 0,
    apiHash: '',
    sessionStr: '',
    dcId: 0,
    listeners: new Map(),   // entityIdStr → { handler, builder }
    peerCache: new Map(),   // markedId → entity
    dialogs: { data: null, ts: 0 },
    pingFails: 0,
    busy: false,
  };
}

let _bootOwner = null; // first connected account (env/boot session) — legacy & bot scope
export function getBootOwnerTid() { return _bootOwner; }

// Strict — only the exact user's state (web routes use this via tid param).
export function getStateExact(tid) {
  return tid ? (_clients.get(String(tid)) || null) : null;
}
// Graceful fallback keeps single-account flows (bot commands) working:
// explicit tid → boot owner → the only connected client → null.
function getState(tid) {
  const id = tid ? String(tid) : null;
  if (id) return _clients.get(id) || null;
  if (_bootOwner && _clients.has(_bootOwner)) return _clients.get(_bootOwner);
  if (_clients.size === 1) return [..._clients.values()][0];
  return null;
}
export function listClients() { return [..._clients.values()]; }

export async function initScraper(sessionStr, opts = {}) {
  if (!sessionStr) throw new Error('No session string');
  let stringSession;
  try { stringSession = new StringSession(sessionStr); } catch { throw new Error('Invalid session format'); }
  const apiId = parseInt(opts.apiId != null ? opts.apiId : config.telegram.apiId);
  const apiHash = opts.apiHash != null ? opts.apiHash : config.telegram.apiHash;
  const dcId = parseInt(opts.dcId) || 0;

  const cOpts = { connectionRetries: 5 };
  if (dcId > 0) cOpts.dcId = dcId;
  const client = new TelegramClient(stringSession, apiId, apiHash, cOpts);
  await client.connect();
  const me = await client.getMe();
  if (!me) { try { await client.destroy(); } catch {} throw new Error('Session expired'); }
  const tid = String(me.id);

  let st = _clients.get(tid);
  if (!st) { st = makeState(tid); _clients.set(tid, st); }
  if (st.client && st.client !== client) {
    try { await st.client.disconnect(); } catch {}
    st.listeners.clear();
    st.peerCache.clear();
    st.dialogs = { data: null, ts: 0 };
  }
  st.client = client;
  st.apiId = apiId;
  st.apiHash = apiHash;
  st.sessionStr = sessionStr;
  st.dcId = dcId;
  if (!_bootOwner) _bootOwner = tid;
  console.log(`[Scraper] Connected as @${me.username || tid} (${tid})`);
  return { tid, client };
}

export function getClient(tid) {
  return getState(tid)?.client || null;
}

export function isConnected(tid) {
  const st = getState(tid);
  return !!(st && st.client && st.client.connected);
}

// ── Keep-alive watchdog: never let any user's scraper go silently dead ──
let _kaTimer = null;

export function startKeepAlive() {
  if (_kaTimer) return;
  _kaTimer = setInterval(async () => {
    for (const st of _clients.values()) {
      if (st.busy || !st.sessionStr) continue;
      try {
        if (!st.client || !st.client.connected) throw new Error('disconnected');
        const { Api } = await import('telegram');
        await withTimeout(st.client.invoke(new Api.Ping({ pingId: BigInt(Date.now()) })), 10_000, 'Ping');
        st.pingFails = 0;
      } catch {
        if (++st.pingFails < 2) continue;
        st.pingFails = 0;
        st.busy = true;
        try {
          console.warn(`[Scraper] (${st.tid}) Connection lost — reconnecting...`);
          await initScraper(st.sessionStr, { apiId: st.apiId, apiHash: st.apiHash, dcId: st.dcId });
          const chs = loadUser(st.tid);
          for (const src of Object.keys(chs)) await addChannelListener(src, st.tid).catch(() => {});
          console.log(`[Scraper] (${st.tid}) ✅ Reconnected (${Object.keys(chs).length} listeners restored)`);
        } catch (e) {
          console.error(`[Scraper] (${st.tid}) Reconnect failed:`, e.message);
        } finally {
          st.busy = false;
        }
      }
    }
  }, 30_000);
}

// ── Accessible dialogs (per-account, cached 60s) ────────────────
const DIALOGS_TTL = 60_000;
const DIALOGS_TIMEOUT = 20_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out (${Math.round(ms / 1000)}s) — Telegram slow or disconnected`)), ms)),
  ]);
}

// Channels & groups THIS account can actually access — the ONLY valid
// sources/targets for its forwards.
export async function getAccessibleChannels(force = false, tid) {
  const st = getState(tid);
  if (!st || !st.client) throw new Error('Telegram not connected');
  const now = Date.now();
  if (!force && st.dialogs.data && now - st.dialogs.ts < DIALOGS_TTL) return st.dialogs.data;
  const dialogs = await withTimeout(st.client.getDialogs({ limit: 100 }), DIALOGS_TIMEOUT, 'Fetching channels');
  const channels = dialogs
    .filter(d => d.isChannel || d.isGroup)
    .map(d => {
      const broadcast = d.entity?.broadcast === true;
      const id = d.id?.value?.toString() || String(d.id);
      const username = d.entity?.username || null;
      return {
        id,
        name: d.name || d.title || 'Unknown',
        title: d.title || d.name || '',
        username,
        identifier: username || id,
        participants: d.entity?.participantsCount || 0,
        type: broadcast ? 'channel' : 'group',
      };
    })
    .sort((a, b) => b.participants - a.participants);
  st.dialogs.data = channels;
  st.dialogs.ts = now;
  return channels;
}

export function invalidateDialogsCache(tid) {
  if (tid) {
    const st = _clients.get(String(tid));
    if (st) st.dialogs = { data: null, ts: 0 };
    return;
  }
  for (const st of _clients.values()) st.dialogs = { data: null, ts: 0 };
}

// Canonical storage key: prefer username, else marked "-100" / "-" id.
function canonicalIdentifier(entity) {
  if (entity?.username) return entity.username.replace(/^@/, '');
  const raw = entity?.id?.value ?? entity?.id;
  if (raw == null) throw new Error('Unresolvable channel');
  let s = raw.toString();
  if (/^\d+$/.test(s)) s = (entity.className === 'Chat' ? '-' : '-100') + s;
  return s;
}

function normalizeInput(s) {
  return String(s).replace(/^https?:\/\/[^\s/]*\.?(telegram\.me|t\.me)\//i, '').replace(/^t\.me\//i, '').replace(/^@/, '');
}

// Verify THIS account can access ANY identifier — dialog list first, then a
// live resolve/join (covers pasted invite links & fresh joins).
export async function ensureAccessible(identifier, tid) {
  const norm = String(identifier || '').trim();
  if (!norm) throw new Error('Empty channel identifier');
  const st = getState(tid);
  if (!st || !st.client) throw new Error('Telegram not connected');
  try {
    const list = await getAccessibleChannels(false, st.tid);
    const hit = list.find(a => a.identifier.toLowerCase() === norm.toLowerCase()
      || (a.username || '').toLowerCase() === normalizeInput(norm));
    if (hit) return hit.identifier;
  } catch { /* fall through to live resolve */ }
  const entity = await resolveAndJoin(st.client, norm);
  return canonicalIdentifier(entity);
}

// ── Channel profile photos (web avatars; disk-cached 24h) ────────
const PHOTO_DIR = './photo_cache';
const PHOTO_TTL = 24 * 3600 * 1000;

export async function getChannelPhotoBase64(identifier, tid) {
  const id = String(identifier || '').trim();
  if (!id) throw new Error('identifier required');
  const safe = crypto.createHash('md5').update(id).digest('hex');
  const file = `${PHOTO_DIR}/${safe}.jpg`;
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < PHOTO_TTL) return fs.readFileSync(file).toString('base64');
  } catch { /* cache miss */ }

  const pst = getState(tid);
  if (!pst || !pst.client || !pst.client.connected) throw new Error('Telegram not connected');
  let entity;
  try {
    entity = await pst.client.getEntity(await resolveTarget(id, tid));
  } catch (e) {
    throw new Error(`Cannot resolve "${id}": ${e.message}`);
  }
  let buf = null;
  try { buf = await client.downloadProfilePhoto(entity); } catch { buf = null; }
  if (!buf || !buf.length) return ''; // no photo set — '' is a valid "none"
  try {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
  } catch {}
  return buf.toString('base64');
}

// Numeric marked IDs ("-100…") resolve through that account's own session cache.
export async function resolveTarget(t, tid) {
  t = String(t || '').trim();
  if (!/^-?\d{6,}$/.test(t)) return t;
  const st = getState(tid);
  if (!st || !st.client) throw new Error('Telegram not connected');
  if (st.peerCache.has(t)) return st.peerCache.get(t);
  const { Api } = await import('telegram');
  let peer;
  if (t.startsWith('-100')) peer = new Api.PeerChannel({ channelId: BigInt(t.slice(4)) });
  else if (t.startsWith('-')) peer = new Api.PeerChat({ channelId: BigInt(t.slice(1)) });
  else peer = new Api.PeerChannel({ channelId: BigInt(t) });
  const entity = await st.client.getEntity(peer);
  st.peerCache.set(t, entity);
  return entity;
}

export function onMessage(cb) {
  forwardHandler = cb; // cb(tid, sourceChannel, message)
}

export async function resolveAndJoin(client, identifier) {
  if (!client) throw new Error('Telegram not connected');
  const { Api } = await import('telegram');

  // Numeric marked IDs — private sources picked from the account's own dialogs.
  if (/^-?\d{6,}$/.test(identifier)) {
    let peer;
    if (identifier.startsWith('-100')) peer = new Api.PeerChannel({ channelId: BigInt(identifier.slice(4)) });
    else if (identifier.startsWith('-')) peer = new Api.PeerChat({ channelId: BigInt(identifier.slice(1)) });
    else peer = new Api.PeerChannel({ channelId: BigInt(identifier) });
    return client.getEntity(peer);
  }

  const inviteMatch = identifier.match(/t\.me\/(\+[\w]+)/);
  const isInvite = !!inviteMatch;
  const hash = isInvite ? inviteMatch[1] : identifier.replace(/^@/, '');

  if (isInvite) {
    const cleanHash = hash.replace('+', '');
    try {
      const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash: cleanHash }));
      if (invite.chat) return invite.chat;
    } catch { /* fall through */ }
    try {
      const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash: cleanHash }));
      if (imported.chats?.length) return imported.chats[0];
    } catch (e) {
      if (e.errorMessage === 'USER_ALREADY_PARTICIPANT') {
        const dialogs = await client.getDialogs({ limit: 200 });
        const found = dialogs.find(d => {
          if (!d.entity) return false;
          return (d.entity.title || '') === (invite?.chat?.title || '') || d.entity.username === cleanHash;
        });
        if (found) return found.entity;
        throw new Error(`Already participant but cannot find "${identifier}" in dialogs`);
      }
      throw e;
    }
  } else {
    const username = identifier.includes('t.me/') ? identifier.split('t.me/').pop().replace(/\/$/, '') : identifier;
    return client.getEntity(username);
  }
  throw new Error(`Could not resolve or join: ${identifier}`);
}

export async function addChannelListener(identifier, tid) {
  const st = getStateExact(tid) || getState(tid);
  if (!st || !st.client) throw new Error('Client not initialized');

  const entity = await resolveAndJoin(st.client, identifier);

  const handler = async (event) => {
    if (forwardHandler) await forwardHandler(st.tid, identifier, event.message);
  };
  const builder = new NewMessage({ chats: [entity.id] });
  st.client.addEventHandler(handler, builder);
  st.listeners.set(String(entity.id), { handler, builder });

  console.log(`[Scraper] (${st.tid}) Listening to ${identifier}`);
  return true;
}

export async function removeChannelListener(identifier, tid) {
  const st = getState(tid);
  if (!st || !st.client) return;
  try {
    const entity = await resolveAndJoin(st.client, identifier);
    const rec = st.listeners.get(String(entity.id));
    if (rec) {
      st.client.removeEventHandler(rec.handler, rec.builder);
      st.listeners.delete(String(entity.id));
      console.log(`[Scraper] (${st.tid}) Stopped listening to ${identifier}`);
    }
  } catch { /* unresolvable — nothing registered */ }
}

export async function forwardMessage(targetChannel, text, parseMode, tid) {
  const st = getState(tid);
  if (!st || !st.client) throw new Error('Telegram not initialized');
  const target = await resolveTarget(String(targetChannel), st.tid);
  const opts = { message: text };
  if (parseMode) opts.parseMode = parseMode;
  await st.client.sendMessage(target, opts);
}
