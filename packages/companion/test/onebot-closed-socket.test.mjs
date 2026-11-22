/**
 * OneBot 失效连接 · 断线/重连的重复与迟到事件（SOP06 缺陷修复节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证 transport-onebot.js 的连接身份语义，两条绑定分支（ws 的 EventEmitter /
 * 原生 EventTarget）走同一套断言：
 *
 *   1. 同一条连接上第一次 close 使它失效，并且只排一次 5000ms 重连
 *      （第二次 close 不再排队 → 时钟走满只多出一个 socket）；
 *   2. 失效连接（等待重连期间，以及新连接建立之后）的迟到
 *      open / close / message / error 一律无效：不改 this.connected、
 *      不再排重连、不把帧交给业务入口；
 *   3. 重连出来的新连接照常工作：open 正常、消息照常进入真实私聊入口并被消费一次。
 *
 * 边界：不联网、不连真实 OneBot、不调模型、不读私有配置。
 *   - 内存 WebSocket：动态 import('ws') 用 registerHooks 换成 data URL stub；
 *     帧由用例手动 emit / dispatch，socket 构造时打信号（nextSocket）供等待；
 *   - 假定时器：t.mock.timers 只接管 setTimeout，重连延时按毫秒推进；
 *   - 假模型 / 假投递：brain.reply 记下每次业务消费，bot.send 记下每次投递。
 *
 * 等待只依赖现成信号与已有 Promise：socket 构造信号、pushPrivateMessage 的返回值、
 * window.flush(key) 的返回值；没有固定次数的 setImmediate。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { OneBot } from '../src/transport-onebot.js';
import { createPrivateTurnWindow, pushPrivateMessage } from '../src/index.js';

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);

// ws 的 EventEmitter 形状（装了 ws 时 production 走这条）。
const emitterStub = dataUrl(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.handlers = {};
    (globalThis.__onebotSockets ||= []).push(this);
    globalThis.__onebotOnSocket?.(this);
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

// 原生 EventTarget 形状（没有 ws 时 production 走这条）。
const nativeStub = dataUrl(`
export class WebSocket extends EventTarget {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.binaryType = 'blob';
    (globalThis.__onebotSockets ||= []).push(this);
    globalThis.__onebotOnSocket?.(this);
  }
}
`);

let wsTarget = emitterStub;
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
const KEY = 'private:42';
const RECONNECT_MS = 5000;

/** 一个只 resolve 一次的 promise，用来等外部事件。 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** 等到下一个 WebSocket 实例出现（stub 构造时回调）。 */
function nextSocket() {
  const { promise, resolve } = deferred();
  globalThis.__onebotOnSocket = (sock) => { globalThis.__onebotOnSocket = null; resolve(sock); };
  return promise;
}

/** 合成一条 OneBot v11 私聊消息（字段形状与 transport-onebot.js 的 #handle 一致）。 */
function privateEvent({ userId = '42', text = '在吗', messageId = 'm-1', name = '阿蓝' } = {}) {
  return {
    post_type: 'message',
    self_id: 10001,
    message_type: 'private',
    user_id: userId,
    sender: { nickname: name },
    message: [{ type: 'text', data: { text } }],
    message_id: messageId,
    time: 1_700_000_000,
  };
}

/** 统一两种事件 API：同一个 socket 上怎么发 open / close / message / error。 */
function clientOf(sock, kind) {
  const json = (event) => JSON.stringify(event);
  return kind === 'emitter'
    ? {
      open: () => sock.emit('open'),
      close: () => sock.emit('close'),
      error: () => sock.emit('error', new Error('boom')),
      message: (event) => sock.emit('message', Buffer.from(json(event))),
    }
    : {
      open: () => sock.dispatchEvent(new Event('open')),
      close: () => sock.dispatchEvent(new Event('close')),
      error: () => sock.dispatchEvent(new Event('error')),
      message: (event) => sock.dispatchEvent(new MessageEvent('message', { data: json(event) })),
    };
}

/** 假模型 + 假投递：只记调用，不生成、不发网络。 */
function fakeDeps() {
  const replies = [];
  const sent = [];
  const deps = {
    bot: {
      async send(key, text) { sent.push({ key, text }); return { ok: true }; },
      async setTyping() { return { ok: true }; },
    },
    brain: {
      async reply(input) {
        replies.push({ key: input.key, text: input.text });
        return { text: '回：' + input.text };
      },
    },
    human: {
      async say(text, io) {
        await io.send(text);
        return { sent: 1, parts: [text] };
      },
    },
    memory: { touch() {} },
    waker: { wake() {} },
  };
  return { deps, replies, sent };
}

/** 按 index.js main() 的方式接起来：OneBot → pushPrivateMessage → 私聊窗口。 */
async function start(fake) {
  globalThis.__onebotSockets = [];
  const frames = [];
  const pushes = [];
  const errors = [];
  const firstSocket = nextSocket();
  const window = createPrivateTurnWindow({
    deps: fake.deps,
    cfg: { dryRun: false, ownerIds: [], wake: { privateWindowMs: 60_000 }, humanize: {}, reminders: false },
    windowMs: 60_000,
    onError: (error) => { errors.push(error); },
  });
  const transport = new OneBot({
    wsUrl: WS_URL,
    httpUrl: '',
    accessToken: TOKEN,
    onMessage: (msg) => {
      frames.push(msg);
      const push = Promise.resolve(pushPrivateMessage(window, msg));
      pushes.push(push);
      push.catch((error) => { errors.push(error); });
    },
  });
  const first = await firstSocket;
  return { transport, window, frames, pushes, errors, first, sockets: globalThis.__onebotSockets };
}

/** 跑一遍完整场景；两种绑定分支各跑一次，断言完全一致。 */
async function exercise(t, kind) {
  wsTarget = kind === 'emitter' ? emitterStub : nativeStub;
  const fake = fakeDeps();
  const { transport, window, frames, pushes, errors, first, sockets } = await start(fake);
  const where = '[' + kind + '] ';

  // ── 正常连上并消费一条（确认修复没有动正常路径）────────────────
  assert.equal(sockets.length, 1, where + '构造时建出一个 socket');
  const current = clientOf(first, kind);
  current.open();
  assert.equal(transport.connected, true, where + 'open 置 connected');

  current.message(privateEvent({ text: '断线前的话', messageId: 'c-1' }));
  await pushes.at(-1);
  assert.equal(frames.length, 1, where + '正常帧到了私聊入口');
  await window.flush(KEY);
  assert.deepEqual(fake.sent, [{ key: KEY, text: '回：阿蓝：断线前的话' }], where + '正常投递一次');

  // ── 同一条连接两次 close：失效一次，只排一次重连 ───────────────
  current.close();
  assert.equal(transport.connected, false, where + '首个 close 清 connected');
  current.close();
  assert.equal(transport.connected, false, where + '第二个 close 不改状态');

  // 失效连接上的迟到事件：不复活、不推进业务
  current.open();
  assert.equal(transport.connected, false, where + '失效连接的迟到 open 不复活');
  current.error();
  current.message(privateEvent({ text: '失效连接上的新 id', messageId: 'c-stale' }));
  assert.equal(frames.length, 1, where + '失效连接的帧不再交给业务入口');
  assert.equal(window.pending(KEY), 0, where + '失效连接的帧不进窗口');

  // 时钟走满：只多出一个 socket（两次 close 没有排两次重连）
  const reconnected = nextSocket();
  t.mock.timers.tick(RECONNECT_MS);
  const second = await reconnected;
  assert.equal(sockets.length, 2, where + '两次 close 只重连一次');
  assert.equal(transport.ws, second, where + 'transport.ws 指向新连接');

  // ── 新连接正常 ────────────────────────────────────────────
  const fresh = clientOf(second, kind);
  fresh.open();
  assert.equal(transport.connected, true, where + '新连接的 open 正常置 connected');
  fresh.message(privateEvent({ text: '重连后的话', messageId: 'c-2' }));
  await pushes.at(-1);
  assert.equal(frames.length, 2, where + '新连接的帧进入私聊入口');
  assert.equal(window.pending(KEY), 1, where + '新连接的帧进窗口');
  await window.flush(KEY);
  assert.deepEqual(
    fake.sent.map((delivery) => delivery.text),
    ['回：阿蓝：断线前的话', '回：阿蓝：重连后的话'],
    where + '新连接的消息照常消费并投递一次',
  );

  // ── 新连接建立之后，旧连接的迟到事件仍然无效 ─────────────────
  current.message(privateEvent({ text: '旧连接又一条', messageId: 'c-3' }));
  current.close();
  current.open();
  current.error();
  assert.equal(transport.connected, true, where + '旧连接的 close 不会把新连接置为断开');
  assert.equal(frames.length, 2, where + '旧连接的帧仍不进入业务入口');
  assert.equal(window.pending(KEY), 0, where + '旧连接的帧仍不进窗口');

  t.mock.timers.tick(RECONNECT_MS);
  assert.equal(sockets.length, 2, where + '旧连接的迟到事件不再排重连');

  assert.deepEqual(errors, [], where + '整条链路没有异常上报');
  await window.close();
}

test('B-12 同一连接只失效一次、只重连一次；失效连接的迟到事件不推进业务，新连接正常', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 只静音输出，不断言日志文案（那不是契约）。
  t.mock.method(console, 'log', () => {});
  await exercise(t, 'emitter');
  await exercise(t, 'native');
});
