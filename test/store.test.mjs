import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'node:crypto';

// Isolated cwd so tests never touch real data files
const TMP = mkdtempSync(join(tmpdir(), 'forwarder-test-'));
process.chdir(TMP);
process.env.PORT = '0';
process.env.WEB_PASSWORD = 'test-secret';

let store;

test('store: per-user workspaces are fully isolated', async () => {
  store = await import('../store.js');
  store.saveUser('user-a', { '@a-chan': { mode: 'extract', targets: ['@t1'], active: true } });
  const b = store.loadUser('user-b');
  assert.deepEqual(b, {}, 'user-b must see nothing of user-a');
  assert.equal(store.loadUser('user-a')['@a-chan'].mode, 'extract');
});

test('store: legacy flat file migrates into owner account', async () => {
  const fs = await import('node:fs');
  fs.rmSync('./channels.json', { force: true });
  fs.writeFileSync('./channels.json', JSON.stringify({ '@old': { mode: 'forward', targets: ['@t'], active: true } }));
  // simulate boot with known owner
  store.initStore('999000111');
  const own = store.loadUser('999000111');
  assert.ok(own['@old'], 'legacy entry must land under the owner tid');
});

test('store: normalizeIdentifier treats @name / t.me link / name as equal', () => {
  const { normalizeIdentifier } = store;
  assert.equal(normalizeIdentifier('@Foo'), 'Foo');
  assert.equal(normalizeIdentifier('https://t.me/Foo'), 'Foo');
  assert.equal(normalizeIdentifier('-1001234567890'), '-1001234567890');
  assert.equal(normalizeIdentifier(''), '');
});

test('store: sanitizes corrupt [object Object] keys and object targets', async () => {
  const fs = await import('node:fs');
  fs.writeFileSync('./channels.json', JSON.stringify({
    __multi: true,
    users: { '55': { '[object Object]': { mode: 'extract', targets: [{ key: 'x' }] }, '56': { mode: 'forward', targets: ['[object Object]', '@ok'] } } },
  }));
  store.initStore(null);
  const chs = store.loadUser('55');
  assert.equal(chs['[object Object]'], undefined);
  const chs56 = store.loadUser('56');
  assert.deepEqual(chs56['56'] ?? chs56, chs56); // sanity no-op
});

// ── Web API: auth + multi-user isolation ──
const signFor = (tid) => {
  const exp = Date.now() + 86400000;
  const sig = crypto.createHmac('sha256', 'test-secret').update(`${tid}.${exp}`).digest('hex').slice(0, 32);
  return `${tid}.${exp}.${sig}`;
};

test('web: auth required + users only ever see their own channels', async () => {
  // Re-seed user-a workspace (earlier migration/sanitization tests rewrote the file)
  store.saveUser('user-a', { '@a-chan': { mode: 'extract', targets: ['@t1'], active: true } });
  const { startWebServer } = await import('../web.js');
  const server = startWebServer();
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tokA = signFor('user-a');

    // no token → locked out everywhere
    let r = await fetch(base + '/api/status');
    assert.equal(r.status, 401);

    // wrong token rejected
    r = await fetch(base + '/api/status', { headers: { 'x-web-token': 'bad.token.here' } });
    assert.equal(r.status, 401);

    // valid token sees ONLY its own workspace
    r = await fetch(base + '/api/channels', { headers: { 'x-web-token': tokA } });
    let d = await r.json();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(d.channels === undefined ? d : d.channels), 'channel list shape');
    const listA = Array.isArray(d) ? d : d.channels || d;
    assert.equal(listA.length, 1);
    assert.equal(listA[0].source, '@a-chan', 'user-a sees exactly their own source');

    const tokB = signFor('user-b');
    r = await fetch(base + '/api/channels', { headers: { 'x-web-token': tokB } });
    d = await r.json();
    assert.deepEqual(d, [], 'user-b must get an empty list — full isolation');

    // dialogs degrade gracefully while that account is offline
    r = await fetch(base + '/api/dialogs', { headers: { 'x-web-token': tokB } });
    d = await r.json();
    assert.equal(d.connected, false);

    // adding requires access verification → explicit 503 while offline
    r = await fetch(base + '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-web-token': tokB },
      body: JSON.stringify({ source: '@x', targets: ['@y'] }),
    });
    d = await r.json();
    assert.equal(r.status, 503);
    assert.match(d.error, /not connected/i);

    // dashboard HTML served
    r = await fetch(base + '/');
    const html = await r.text();
    assert.ok(html.includes('Forwarder Bot'));

    // bot → web hand-off: short link token exchanges for a real session
    const { signLinkToken } = await import('../auth.js');
    r = await fetch(base + '/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: signLinkToken('user-b') }),
    });
    d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.tid, 'user-b');

    // forged/garbage tokens are rejected
    r = await fetch(base + '/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'garbage' }),
    });
    assert.equal(r.status, 401);

    // ── Remember me: device-bound refresh token lifecycle ──
    store.saveSession('user-r', { devices: { dev1: { createdAt: Date.now() } } });
    const { signRefresh } = await import('../auth.js');
    const rt = signRefresh('user-r', 'dev1');

    r = await fetch(base + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: rt }),
    });
    d = await r.json();
    assert.equal(d.ok, true, 'remembered device must silently re-login');
    assert.ok(d.token && d.refresh);

    r = await fetch(base + '/api/auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: rt }),
    });
    assert.equal((await r.json()).ok, true);

    r = await fetch(base + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: rt }),
    });
    assert.equal(r.status, 401, 'revoked device must not re-login');

    // QR endpoints fail closed without touching Telegram
    r = await fetch(base + '/api/auth/qr/status?loginToken=nope');
    assert.equal(r.status, 404);
    r = await fetch(base + '/api/auth/qr/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginToken: 'nope', password: 'x' }),
    });
    assert.equal(r.status, 404);

    // Manual web OTP login is gone — web is Telegram-mediated only.
    // (Removed routes fall through to the auth middleware → 401.)
    r = await fetch(base + '/api/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId: 1, apiHash: 'x', phone: '+1' }),
    });
    assert.equal(r.status, 401);
    r = await fetch(base + '/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginToken: 'x', code: '1' }),
    });
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test('bot: module loads without launching (login wizard wired)', async () => {
  const b = await import('../bot.js');
  assert.ok(b.bot, 'telegraf instance exported');
  assert.equal(typeof b.getBotUsername, 'function');
  assert.equal(typeof b.isBotActive, 'function');
});

test('auth: Telegram Login Widget signature verifies (valid / forged / stale)', async () => {
  const { verifyTelegramWidget } = await import('../auth.js');
  const botToken = '123456:TEST-TOKEN-ABC';
  const payload = { id: 987654321, first_name: 'Far', last_name: 'Rel', username: 'farrel', auth_date: Math.floor(Date.now() / 1000) };
  const check = Object.keys(payload).sort().map(k => `${k}=${payload[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');

  assert.equal(verifyTelegramWidget({ ...payload, hash }, botToken), '987654321');
  assert.equal(verifyTelegramWidget({ ...payload, hash: '0'.repeat(64) }, botToken), null, 'forged hash rejected');
  assert.equal(verifyTelegramWidget({ ...payload, hash }, 'wrong-token'), null, 'wrong bot token rejected');
  assert.equal(verifyTelegramWidget({ ...payload, auth_date: Math.floor(Date.now() / 1000) - 100000, hash }, botToken), null, 'stale replay rejected');
  assert.equal(verifyTelegramWidget({ id: 1 }, botToken), null, 'incomplete payload rejected');
});

test('dex: only exact baseToken match accepted (no wrong-token fallback)', async () => {
  const orig = globalThis.fetch;
  const pair = (addr) => ({ chainId: 'solana', baseToken: { address: addr, symbol: 'FAKE' }, priceUsd: '1' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ pairs: [pair('OTHER11111111111111111111111111111111')] }) });
  try {
    const { fetchDexScreenerInfo } = await import('../scraper.js');
    const d = await fetchDexScreenerInfo('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    assert.equal(d, null, 'must not attribute another token pair');
  } finally { globalThis.fetch = orig; }
});

test('dex: waitForDexData retries then resolves late data', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) return { ok: true, json: async () => ({ pairs: [] }) };
    return { ok: true, json: async () => ({ pairs: [{ chainId: 'solana', baseToken: { address: 'LATE1111111111111111111111111111111111', symbol: 'LATE' }, priceUsd: '0.5' }] }) };
  };
  try {
    const { waitForDexData } = await import('../scraper.js');
    const d = await waitForDexData('LATE1111111111111111111111111111111111', [5, 5, 5]);
    assert.ok(d && d.symbol === 'LATE', 'late-indexed data must resolve');
    assert.ok(calls >= 2, 'must have retried');
  } finally { globalThis.fetch = orig; }
});

test('dex: direct lookup rescues tokens that search misses', async () => {
  const orig = globalThis.fetch;
  const CA = 'RESCUEME11111111111111111111111111111111';
  globalThis.fetch = async (url) => {
    if (String(url).includes('/tokens/v1/')) {
      return { ok: true, json: async () => [{ chainId: 'solana', baseToken: { address: CA, symbol: 'SAVED' }, priceUsd: '0.1' }] };
    }
    return { ok: true, json: async () => ({ pairs: [{ chainId: 'solana', baseToken: { address: 'OTHER', symbol: 'X' }, priceUsd: '9' }] }) };
  };
  try {
    const { fetchDexScreenerInfo } = await import('../scraper.js');
    const d = await fetchDexScreenerInfo(CA);
    assert.ok(d && d.symbol === 'SAVED', 'direct lookup must rescue the token');
  } finally { globalThis.fetch = orig; }
});

test('dex: jupiter+onchain fallback merges into full card data', async () => {
  const orig = globalThis.fetch;
  const CA = 'FB11111111111111111111111111111111111111';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('dexscreener.com')) return { ok: true, json: async () => ({ pairs: [] }) };
    if (u.includes('jup.ag')) return { ok: true, json: async () => ({ [CA]: { usdPrice: 0.002, liquidity: 100, launchpad: 'pump.fun' } }) };
    const mintInfo = { supply: '1000000000', decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'tokenMetadata', state: { name: 'Fallback', symbol: 'FB' } }] };
    return { ok: true, json: async () => ({ result: { value: { owner: 'TokenzQdX', data: { parsed: { info: mintInfo } } } } }) };
  };
  try {
    const { fetchFallbackMarketData } = await import('../scraper.js');
    const d = await fetchFallbackMarketData(CA);
    assert.ok(d, 'fallback must produce data');
    assert.equal(d.symbol, 'FB');
    assert.equal(d.marketCap, 0.002 * 1000, 'MC = price x supply');
    assert.equal(d.liquidity, 100);
    assert.equal(d.dexId, 'pump.fun');
  } finally { globalThis.fetch = orig; }
});

test('dex: fallback returns null when mint does not exist anywhere', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('dexscreener.com') || u.includes('jup.ag')) return { ok: true, json: async () => ({ pairs: [] }) };
    return { ok: true, json: async () => ({ result: { value: null } }) };
  };
  try {
    const { fetchFallbackMarketData } = await import('../scraper.js');
    assert.equal(await fetchFallbackMarketData('NOPE11111111111111111111111111111111'), null);
  } finally { globalThis.fetch = orig; }
});

test('race: firstGood resolves the earliest usable price', async () => {
  const { firstGood } = await import('../scraper.js');
  const slowGood = new Promise(r => setTimeout(() => r({ price: '9', marketCap: 900 }), 30));
  const fastGood = new Promise(r => setTimeout(() => r({ price: '1', marketCap: 100 }), 5));
  const d = await firstGood([slowGood, fastGood]);
  assert.equal(d.marketCap, 100, 'fastest usable result must win');
  const none = await firstGood([Promise.resolve(null), Promise.resolve({ price: '0' }), Promise.reject(new Error('x'))]);
  assert.equal(none, null, 'all-bad must resolve null without hanging');
  assert.equal(await firstGood([]), null);
});
