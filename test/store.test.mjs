import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated cwd so tests never touch the real channels.json
const TMP = mkdtempSync(join(tmpdir(), 'forwarder-test-'));
process.chdir(TMP);
process.env.PORT = '0';

let store;

test('store: channels round-trip (memory cache + async durable write)', async () => {
  store = await import('../store.js');
  assert.deepEqual(store.loadChannels(), {});
  store.saveChannels({ '@foo': { mode: 'extract', targets: ['@bar'], active: true } });
  const chs = store.loadChannels();
  assert.equal(chs['@foo'].mode, 'extract');
  // instant in-memory read — no disk hit
  assert.deepEqual(store.channelTargets(chs['@foo']), ['@bar']);
  assert.deepEqual(store.channelTargets({ target: '@legacy' }), ['@legacy']);
  assert.deepEqual(store.channelTargets({}), []);
  await store.flushChannels();
});

test('store: normalizeIdentifier treats @name / t.me link / name as equal', async () => {
  const { normalizeIdentifier } = store;
  assert.equal(normalizeIdentifier('@Foo'), 'Foo');
  assert.equal(normalizeIdentifier('https://t.me/Foo'), 'Foo');
  assert.equal(normalizeIdentifier('-1001234567890'), '-1001234567890');
  assert.equal(normalizeIdentifier(''), '');
});

test('store: activity feed is capped and newest-first', async () => {
  for (let i = 0; i < 70; i++) store.logActivity('forward', `evt-${i}`);
  const acts = store.getActivity();
  assert.ok(acts.length <= 60);
  assert.equal(acts[0].text, 'evt-69');
});

test('store: loadChannels picks up external file edits (mtime revalidate)', async () => {
  // Simulate another process / manual edit touching the file
  const fs = await import('node:fs');
  fs.writeFileSync('./channels.json', JSON.stringify({ '@edited': { mode: 'forward', targets: ['@t'], active: true } }));
  const chs = store.loadChannels();
  assert.ok(chs['@edited'], 'external edit must appear after mtime change');
});

test('store: sanitizes corrupt [object Object] keys and object targets', async () => {
  const fs = await import('node:fs');
  fs.writeFileSync('./channels.json', JSON.stringify({
    '[object Object]': { mode: 'extract', targets: [{ key: 'spongesolana' }], active: true },
    '@good': { mode: 'forward', targets: [{ key: 'x' }, '@ok', '[object Object]'], active: true },
  }));
  const chs = store.loadChannels();
  assert.equal(chs['[object Object]'], undefined, 'corrupt key must be dropped');
  assert.deepEqual(chs['@good'].targets, ['x', '@ok'], '{key} objects coerced to strings, garbage filtered');
  await store.flushChannels();
});

// ── Web API smoke (no Telegram connect needed) ──

test('web: status, dialogs degrade gracefully + accessible-only validation enforced server-side', async () => {
  const { startWebServer } = await import('../web.js');
  const server = startWebServer();
  try {
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    let r = await fetch(base + '/api/status');
    let d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.connected, false);

    r = await fetch(base + '/api/dialogs');
    d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.connected, false);
    assert.deepEqual(d.channels, []);

    // Telegram down → cannot verify access → explicit 503, never a silent add
    r = await fetch(base + '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '@somewhere', targets: ['@elsewhere'], mode: 'extract' }),
    });
    d = await r.json();
    assert.ok([503].includes(r.status), `expected 503 got ${r.status}: ${JSON.stringify(d)}`);
    assert.match(d.error, /not connected/i);

    r = await fetch(base + '/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '@somewhere', targets: [] }),
    });
    assert.equal(r.status, 400);

    r = await fetch(base + '/api/activity');
    assert.equal(r.status, 200);

    // photo endpoint degrades gracefully while Telegram is down
    r = await fetch(base + '/api/photo?id=@whatever');
    d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.ok, false);

    r = await fetch(base + '/');
    const html = await r.text();
    assert.ok(html.includes('Forwarder Bot'));
  } finally {
    server.close();
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
