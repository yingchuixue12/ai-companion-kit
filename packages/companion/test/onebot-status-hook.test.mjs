import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/index.js';
import { OneBot } from '../src/transport-onebot.js';

const wsUrl = 'ws://synthetic-address.invalid';
const prefix = '[onebot-status] ';
const syntheticError = 'synthetic-credential-in-error';

test('CLI logs redacted status for a failed handshake and a successful retry', async (t) => {
  const sockets = [];
  const webSocket = t.mock.method(globalThis, 'WebSocket', function FakeSocket() {
    const socket = new EventEmitter();
    sockets.push(socket);
    return socket;
  });
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'ws' && context.parentURL?.endsWith('/transport-onebot.js')
        ? { url: 'data:text/javascript,export%20const%20WebSocket%20%3D%20globalThis.WebSocket', shortCircuit: true }
        : next(specifier, context);
    },
  });
  t.after(() => hook.deregister());
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-status-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ onebot: { wsUrl, statusDiagnostics: true } }));

  const logs = [];
  t.mock.method(console, 'log', (line) => {
    logs.push(String(line));
    if (typeof line === 'string' && line.includes('"disconnected"')) {
      throw new Error('synthetic log failure');
    }
  });
  const proc = Object.assign(new EventEmitter(), { argv: ['node', 'entry', '--config', config], exit() {} });
  let options;
  const runtime = await main({ proc, createBot: (value) => {
    options = value;
    return new OneBot(value);
  } });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();
  assert.equal(webSocket.mock.callCount(), 1);
  sockets[0].emit('error', new Error(syntheticError));
  sockets[0].emit('close');
  sockets[0].emit('error', new Error(syntheticError));
  t.mock.timers.tick(4_999);
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(sockets.length, 2);
  sockets[1].emit('open');
  assert.equal(runtime.bot.connected, true);

  options.onStatus({ state: 'unknown', error: syntheticError });
  options.onStatus({ state: 'error', attempt: 'bad', retryInMs: -1, error: syntheticError });
  assert.deepEqual(logs.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length))), [
    { state: 'error', attempt: 1, retryInMs: 0 },
    { state: 'disconnected', attempt: 1, retryInMs: 5000 },
    { state: 'connected', attempt: 2, retryInMs: 0 },
    { state: 'error', attempt: 0, retryInMs: 0 },
  ]);
  assert.ok(!logs.join('\n').includes(wsUrl));
  assert.ok(!logs.join('\n').includes(syntheticError));

  fs.writeFileSync(config, JSON.stringify({ onebot: { wsUrl } }));
  const legacy = await main({ proc, createBot: (value) => {
    assert.equal(Object.hasOwn(value, 'onStatus'), false);
    return new OneBot(value);
  } });
  await settle();
  assert.equal(sockets.length, 3);
  sockets[2].emit('open');
  assert.equal(legacy.bot.connected, true);
  assert.ok(logs.includes('[onebot] 已连接 ' + wsUrl));
});
