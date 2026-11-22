/**
 * OneBot WebSocket 回退 · SOP06 测试节点
 * ─────────────────────────────────────────────────────────────
 * 只验证 transport-onebot.js 的连接建立分支：
 *
 *   import('ws') 成功 → ws EventEmitter（on / Buffer）
 *   import('ws') 失败 → 全局 WebSocket（addEventListener / MessageEvent）
 *
 * 边界：不联网、不连真实 WebSocket、不连真实 OneBot 实现。
 *   - 动态 import('ws') 用 registerHooks 换成 data URL 内存 stub：
 *       · broken：求值即抛错，模拟本地没装 ws；
 *       · emitter：只有 on() 的 EventEmitter 形状；
 *       · bare：既没有 on 也没有 addEventListener。
 *   - 原生分支用 EventTarget 子类，手动 dispatch open / close / error / message。
 *   - 重连延时用 mock 定时器断言到毫秒，不真的等 5 秒。
 *
 * 覆盖点：
 *   1. 原生分支：open / close 改 connected，重连延时正好 5000，下一个 socket 能收消息；
 *   2. MessageEvent 字符串 / ArrayBuffer / TypedArray 视图都解析，畸形帧忽略；
 *   3. ws 分支：仍是 on('message') + Buffer，构造选项带同一份鉴权头；
 *   4. error 两条分支都不抛；
 *   5. 两种事件 API 都没有时安静返回，不抛错。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { OneBot } from '../src/transport-onebot.js';

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);

// 模拟「本地没有 ws」：模块求值就抛，import('ws') 的 promise 必 reject。
const brokenStub = dataUrl(`throw new Error("Cannot find package 'ws'");`);

// ws 的 EventEmitter 形状：没有 addEventListener，只有 on()。
const emitterStub = dataUrl(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.handlers = {};
    (globalThis.__onebotSockets ||= []).push(this);
  }
  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }
  emit(event, arg) {
    for (const fn of this.handlers[event] || []) fn(arg);
  }
}
`);

// 既不是 EventEmitter 也不是 EventTarget：两条绑定分支都不该走进去。
const bareStub = dataUrl(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    (globalThis.__onebotSockets ||= []).push(this);
  }
}
`);

// Node 内置 WebSocket 的形状：EventTarget + binaryType。
class NativeSocket extends EventTarget {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.binaryType = 'blob';
    (globalThis.__onebotSockets ||= []).push(this);
  }
}

let wsTarget = brokenStub;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'ws' && context.parentURL?.includes('/transport-onebot.js')) {
      return { url: wsTarget, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
after(() => hooks.deregister());

const WS_URL = 'ws://stub.invalid';
const TOKEN = 'test-token';

/** 合成一条 OneBot v11 私聊消息。 */
const PRIVATE_EVENT = {
  post_type: 'message',
  self_id: 10001,
  message_type: 'private',
  user_id: '42',
  sender: { nickname: '阿蓝' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  message_id: 'm-1',
  time: Date.parse('2023-11-14T22:13:20Z') / 1000,
};
const privateJson = JSON.stringify(PRIVATE_EVENT);

/** 让构造里的 async #connect 与动态 import 落地。 */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** 构造真实 OneBot，返回它和它创建的 socket 列表。 */
async function makeBot({ onMessage } = {}) {
  globalThis.__onebotSockets = [];
  const bot = new OneBot({ wsUrl: WS_URL, httpUrl: '', accessToken: TOKEN, onMessage });
  await settle();
  return { bot, sockets: globalThis.__onebotSockets };
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

test('原生 EventTarget 回退：open/close、5000ms 重连、MessageEvent 三种载荷', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wsTarget = brokenStub;         // import('ws') 失败 → 走 globalThis.WebSocket
  globalThis.WebSocket = NativeSocket;

  const received = [];
  const { bot, sockets } = await makeBot({ onMessage: (m) => received.push(m) });

  assert.equal(sockets.length, 1, '构造出一个 socket');
  const first = sockets[0];
  assert.equal(first.url, WS_URL);
  assert.equal(first.opts.headers.authorization, 'Bearer ' + TOKEN, '鉴权选项原样传递');
  assert.equal(first.binaryType, 'arraybuffer', '原生分支把二进制改成交付 ArrayBuffer');
  assert.equal(typeof first.on, 'undefined', '原生 socket 确实没有 on');

  first.dispatchEvent(new Event('open'));
  assert.equal(bot.connected, true, 'open 置 connected');

  first.dispatchEvent(new MessageEvent('message', { data: privateJson }));
  first.dispatchEvent(new MessageEvent('message', { data: bytesOf(privateJson).buffer }));
  first.dispatchEvent(new MessageEvent('message', { data: bytesOf(privateJson) }));
  assert.equal(received.length, 3, '字符串 / ArrayBuffer / 视图都喂给业务校验');
  assert.deepEqual(
    received.map((m) => [m.key, m.text, m.messageId]),
    [['private:42', '在吗', 'm-1'], ['private:42', '在吗', 'm-1'], ['private:42', '在吗', 'm-1']],
  );

  first.dispatchEvent(new MessageEvent('message', { data: '{"post_type":' }));
  first.dispatchEvent(new MessageEvent('message', { data: undefined }));
  assert.equal(received.length, 3, '畸形帧与非文本帧都忽略');

  first.dispatchEvent(new Event('error'));
  assert.doesNotThrow(() => first.dispatchEvent(new Event('error')), 'error 分支不抛');

  first.dispatchEvent(new Event('close'));
  assert.equal(bot.connected, false, 'close 清 connected');

  t.mock.timers.tick(4999);
  await settle();
  assert.equal(sockets.length, 1, '4999ms 内不重连');

  t.mock.timers.tick(1);
  await settle();
  assert.equal(sockets.length, 2, '整 5000ms 后重连');

  const second = sockets[1];
  assert.equal(second.url, WS_URL);
  assert.equal(second.opts.headers.authorization, 'Bearer ' + TOKEN);
  second.dispatchEvent(new Event('open'));
  assert.equal(bot.connected, true, '新 socket 的 open 也生效');
  second.dispatchEvent(new MessageEvent('message', { data: privateJson }));
  assert.equal(received.length, 4, '新 socket 能继续收消息');
});

test('ws EventEmitter 分支：on + Buffer + 同一份鉴权头', async () => {
  wsTarget = emitterStub;
  const received = [];
  const { bot, sockets } = await makeBot({ onMessage: (m) => received.push(m) });

  const sock = sockets[0];
  assert.equal(typeof sock.on, 'function');
  assert.equal(sock.opts.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(sock.binaryType, undefined, 'ws 分支不改 binaryType');
  assert.deepEqual(Object.keys(sock.handlers).sort(), ['close', 'error', 'message', 'open']);

  sock.emit('open');
  assert.equal(bot.connected, true);
  sock.emit('message', Buffer.from(privateJson));
  assert.equal(received.length, 1);
  assert.equal(received[0].text, '在吗');

  sock.emit('message', Buffer.from('not json'));
  assert.equal(received.length, 1, 'ws 分支同样忽略畸形帧');
  assert.doesNotThrow(() => sock.emit('error', new Error('boom')), 'ws error 不抛');
});

test('两种事件 API 都没有：安静返回，不抛错', async () => {
  wsTarget = bareStub;
  const bot = await makeBot().then((r) => r.bot);
  assert.equal(bot.connected, false);
  assert.equal(globalThis.__onebotSockets.length, 1);
});
