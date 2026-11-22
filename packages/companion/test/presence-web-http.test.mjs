import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPresenceWebHost } from '../src/lib.js';
import { createPresenceHttpHandler } from '../src/presence/web-http.js';

const signalPath = '/presence/signal';
const messagesPath = '/presence/messages';
const activity = '{"kind":"activity","active":true}';
const minute = 60_000;

async function serve(t, options) {
  const handler = createPresenceHttpHandler(options);
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, { method = 'GET', body, chunks, headers } = {}) => new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers,
      agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (part) => { data += part; });
      res.on('end', () => resolve({
        code: res.statusCode,
        headers: res.headers,
        data: data ? JSON.parse(data) : null,
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    req.end(body);
  });
}

const authHeaders = { 'x-test-auth': 'synthetic' };
const json = { ...authHeaders, 'content-type': 'application/json' };
const authorize = (req) => req.headers['x-test-auth'] === 'synthetic';

test('HTTP admission is opt-in and rejects invalid bodies before applying a signal', async (t) => {
  const host = createPresenceWebHost({ enabled: true });
  const closed = await serve(t, { host });
  assert.equal((await closed(signalPath, { method: 'POST', body: activity, headers: json })).code, 403);
  const call = await serve(t, {
    host,
    authorize(req) {
      if (req.headers['x-test-auth-error']) throw Error('private auth details');
      return authorize(req);
    },
  });
  const denied = await call(messagesPath, { headers: { 'x-test-auth-error': '1' } });
  assert.deepEqual(denied.data, { error: 'forbidden' });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal((await call('/other')).code, 404);
  assert.equal((await call(signalPath, { headers: json })).code, 405);
  assert.equal((await call(messagesPath, { method: 'POST', headers: json })).code, 405);
  assert.equal((await call(messagesPath + '?after=a&after=b', { headers: json })).code, 400);
  assert.equal((await call(signalPath + '?extra=1', { method: 'POST', body: activity, headers: json })).code, 400);
  assert.equal((await call(signalPath, { method: 'POST', body: activity, headers: authHeaders })).code, 415);
  assert.equal((await call(signalPath, { method: 'POST', body: 'x'.repeat(257), headers: json })).code, 413);
  assert.equal((await call(signalPath, { method: 'POST', chunks: ['x'.repeat(200), 'x'.repeat(57)], headers: json })).code, 413);
  for (const body of ['{', 'null', '[]', '{"kind":"constructor","active":true}',
    '{"kind":"activity","active":true,"at":0}', '{"kind":"activity","active":"true"}']) {
    assert.equal((await call(signalPath, { method: 'POST', body, headers: json })).code, 400);
  }
  assert.equal(host.state, 'unknown');
  assert.equal(host.pending, 0);
});

test('loopback host returns only new prompts, preserves cooldown and clears on disable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-web-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json');
  let clock = Date.UTC(2026, 0, 1);
  const options = {
    enabled: true,
    now: () => clock,
    stateFile,
    settings: { idleMs: 5 * minute, awayMs: 30 * minute, returnAfterMs: 5 * minute, cooldownMs: 90 * minute },
  };
  const host = createPresenceWebHost(options);
  const start = async (target) => {
    const call = await serve(t, { host: target, authorize });
    return {
      observe: () => call(signalPath, { method: 'POST', body: activity, headers: json }),
      read: (after) => call(messagesPath + (after ? '?after=' + encodeURIComponent(after) : ''), { headers: json }),
    };
  };
  const first = await start(host);
  const initial = await first.read();
  assert.equal(initial.headers['cache-control'], 'no-store');
  assert.deepEqual(initial.data.messages, []);
  assert.equal((await first.observe()).code, 200);
  clock += 31 * minute;
  host.settle();
  clock += 6 * minute;
  assert.deepEqual((await first.observe()).data, { ok: true, status: 'ok' });
  const welcome = (await first.read(initial.data.cursor)).data;
  assert.deepEqual(welcome.messages.map(({ kind }) => kind), ['welcome-back']);
  assert.deepEqual((await first.read(welcome.cursor)).data.messages, []);
  assert.equal(host.close().persisted, true);

  const restored = createPresenceWebHost(options);
  assert.equal(restored.restored, true);
  const second = await start(restored);
  const checkpoint = (await second.read(welcome.cursor)).data;
  assert.deepEqual(checkpoint.messages, []);
  clock += 31 * minute;
  restored.settle();
  clock += 6 * minute;
  assert.equal((await second.observe()).code, 200);
  assert.deepEqual((await second.read(checkpoint.cursor)).data.messages, []);
  assert.equal(restored.setEnabled(false).cleared, true);
  assert.equal(existsSync(stateFile), false);
  assert.equal((await second.observe()).code, 409);
});

test('HTTP exposes neither missing or failing hosts nor internal error details', async (t) => {
  const missing = await serve(t, { authorize });
  assert.deepEqual((await missing(messagesPath, { headers: json })).data, { error: 'presence-unavailable' });
  const failed = await serve(t, {
    authorize,
    host: { messages() { throw Error('private storage details'); } },
  });
  assert.deepEqual((await failed(messagesPath, { headers: json })).data, { error: 'presence-error' });
});

test('HTTP returns one break reminder during a continuous session', async (t) => {
  let clock = Date.UTC(2026, 0, 1);
  const host = createPresenceWebHost({
    enabled: true,
    now: () => clock,
    settings: { idleMs: 60 * minute, awayMs: 120 * minute, workAfterMs: 50 * minute },
  });
  const call = await serve(t, { host, authorize });
  const initial = (await call(messagesPath, { headers: json })).data;
  await call(signalPath, { method: 'POST', body: activity, headers: json });
  clock += 55 * minute;
  host.settle();
  const page = (await call(messagesPath + '?after=' + encodeURIComponent(initial.cursor), { headers: json })).data;
  assert.deepEqual(page.messages.map(({ kind }) => kind), ['break-reminder']);
  clock += minute;
  host.settle();
  const next = (await call(messagesPath + '?after=' + encodeURIComponent(page.cursor), { headers: json })).data;
  assert.deepEqual(next.messages, []);
});

test('an aborted upload cannot apply a partial signal', async (t) => {
  const host = createPresenceWebHost({ enabled: true });
  const handler = createPresenceHttpHandler({ host, authorize });
  let resolveHandled;
  const handled = new Promise((resolve) => { resolveHandled = resolve; });
  const server = createServer(async (req, res) => {
    const result = await handler(req, res);
    resolveHandled(result);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const arrived = once(server, 'request');
  const req = request({
    host: '127.0.0.1',
    port: server.address().port,
    path: signalPath,
    method: 'POST',
    headers: json,
  });
  req.on('error', () => {});
  req.write('{"kind":"activity",');
  await arrived;
  req.destroy();
  assert.equal(await handled, true);
  assert.equal(host.state, 'unknown');
  assert.equal(host.pending, 0);
  const call = await serve(t, { host, authorize });
  assert.equal((await call(signalPath, { method: 'POST', body: activity, headers: json })).code, 200);
  assert.equal(host.state, 'present');
});
