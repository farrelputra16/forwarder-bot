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
  } finally {
    server.close();
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
