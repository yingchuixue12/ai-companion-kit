/**
 * OneBot 断线 / 重连 · B-12（SOP06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证本仓库已经接好的两段现成代码，不改生产逻辑：
 *
 *   OneBot（transport-onebot.js）：断线 → setTimeout(5000) → 重连
 *        ↓ onMessage
 *   pushPrivateMessage（index.js）→ ConversationWindow 的 `seen` 去重
 *        ↓ onFlush → handleTurn → 假模型 → 投递（deps.bot.send）
 *
 * 一个贯穿场景：连上 → 消费一条 → 断线 → 4999ms 不重连、整 5000ms 重连
 *   → 重放已消费的 messageId（到达私聊入口，但不再进入第二次业务消费，也不复投）
 *   → 新 messageId 照常只消费一次。
 *
 * 边界：不联网、不连真实 OneBot、不调模型、不读私有配置。
 *   - 内存 WebSocket：动态 import('ws') 用 registerHooks 换成 data URL stub
 *     （只有 on() 的 EventEmitter 形状，与装了 ws 时 production 走的分支一致）；
 *     帧由用例手动 emit；
 *   - 假定时器：t.mock.timers 只接管 setTimeout，重连延时按毫秒断言，不真等 5 秒；
 *   - 假模型：brain.reply 返回固定文本并记下每次业务消费；human / bot / memory /
 *     waker 也都是替身，只记调用。
 *
 * 等待只依赖现成信号，不靠固定次数的 setImmediate：
 *   - 「新 socket 建出来了」用 stub 在构造时打出的信号（nextSocket）；
 *   - 「这一帧处理完了」直接 await pushPrivateMessage 返回的 Promise；
 *   - 「这一批生成并投递完了」直接 await window.flush(key) 返回的 Promise。
 *
 * 不断言、也不制造新的去重：去重键 `onebot:<key, messageId>` 完全来自
 * src/index.js 的 pushPrivateMessage 与 ConversationWindow#seen。
 *
 * 本文件只覆盖「重连后的业务去重」这一层；连接身份（同一条连接只失效一次、
 * 失效连接的迟到事件无效、重连只排一次）由 transport-onebot.js 的连接代际守卫
 * 保证，断言在 onebot-closed-socket.test.mjs 里，这里不重复。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { OneBot } from '../src/transport-onebot.js';
import { createPrivateTurnWindow, pushPrivateMessage } from '../src/index.js';

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);

// ws 的 EventEmitter 形状；构造时打一个信号，用例据此「等到新 socket 真的建出来」。
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

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'ws' && context.parentURL?.includes('/transport-onebot.js')) {
      return { url: emitterStub, shortCircuit: true };
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

/** 一帧 WS 数据（ws 分支拿到的是 Buffer）。 */
const frame = (event) => Buffer.from(JSON.stringify(event));

/**
 * 一组替身：假模型记下每次业务消费，bot 记下每次投递，memory / waker 记下落地。
 * 一次成功轮次固定：brain.reply → human.say → bot.send → waker.wake → memory.touch。
 */
function fakeDeps() {
  const replies = [];
  const sent = [];
  const writes = [];
  const deps = {
    bot: {
      async send(key, text) { sent.push({ key, text }); return { ok: true }; },
      async setTyping() { return { ok: true }; },
    },
    brain: {
      async reply(input) {
        replies.push({ key: input.key, userId: input.userId, text: input.text });
        return { text: '回：' + input.text };
      },
    },
    human: {
      async say(text, io) {
        await io.send(text);
        return { sent: 1, parts: [text] };
      },
    },
    memory: { touch(userId, meta) { writes.push({ kind: 'touch', userId, name: meta?.name }); } },
    waker: { wake(key) { writes.push({ kind: 'wake', key }); } },
  };
  return { deps, replies, sent, writes };
}

/**
 * 按 index.js main() 的方式把传输层接到私聊窗口：onMessage → pushPrivateMessage。
 * 同时记下每一次业务入口收到的事件和它返回的 Promise，供用例直接 await。
 */
async function wire(fake) {
  globalThis.__onebotSockets = [];
  const errors = [];
  const frames = [];
  const pushes = [];
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
  const socket = await firstSocket;
  return { transport, window, socket, frames, pushes, errors };
}

test('B-12 断线重连后重放已消费的 messageId 不复投，新消息只消费一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 只静音 transport / handleTurn 的输出，不断言日志文案（那不是契约）。
  t.mock.method(console, 'log', () => {});
  const fake = fakeDeps();
  const { transport, window, socket, frames, pushes, errors } = await wire(fake);
  const sockets = globalThis.__onebotSockets;

  // ── 连上并消费一条消息 ────────────────────────────────────
  assert.equal(sockets.length, 1, '构造时建出一个 socket');
  assert.equal(socket.url, WS_URL);
  assert.equal(socket.opts.headers.authorization, 'Bearer ' + TOKEN);
  socket.emit('open');
  assert.equal(transport.connected, true, 'open 置 connected');

  const before = privateEvent({ text: '断线前的话', messageId: 'm-1' });
  socket.emit('message', frame(before));
  await pushes.at(-1);
  assert.equal(frames.length, 1, '这一帧到了私聊入口');
  assert.equal(window.pending(KEY), 1, '进了窗口，还没生成');
  assert.equal(fake.replies.length, 0);

  await window.flush(KEY);
  assert.equal(fake.replies.length, 1, '消费一次');
  assert.match(fake.replies[0].text, /断线前的话/);
  assert.deepEqual(fake.sent, [{ key: KEY, text: '回：阿蓝：断线前的话' }], '投递一次');
  assert.deepEqual(fake.writes.map((w) => w.kind), ['wake', 'touch'], '成功轮次才叫醒 waker、才 touch 记忆');

  // ── 断线：4999ms 不重连，整 5000ms 重连 ────────────────────
  socket.emit('close');
  assert.equal(transport.connected, false, 'close 清 connected');

  t.mock.timers.tick(RECONNECT_MS - 1);
  assert.equal(sockets.length, 1, '4999ms 内不重连（定时器还没到，没有任何在飞的重连）');
  assert.equal(transport.connected, false);

  const reconnected = nextSocket();
  t.mock.timers.tick(1);
  const second = await reconnected;
  assert.equal(sockets.length, 2, '整 5000ms 建出新 socket');
  assert.equal(second.url, WS_URL, '重连沿用同一 wsUrl');
  assert.equal(second.opts.headers.authorization, 'Bearer ' + TOKEN, '重连沿用同一鉴权头');
  assert.equal(transport.ws, second, 'transport.ws 指向新 socket');

  second.emit('open');
  assert.equal(transport.connected, true, '新 socket 的 open 重新置 connected');

  // ── 平台重放断线前已经消费过的同一条 messageId ─────────────
  second.emit('message', frame(before));
  await pushes.at(-1);
  assert.equal(frames.length, 2, '重放帧确实又到了私聊入口');
  assert.equal(window.pending(KEY), 0, '业务去重挡住：不进窗口');
  await window.flush(KEY);
  assert.equal(fake.replies.length, 1, '不生成第二次');
  assert.equal(fake.sent.length, 1, '不第二次投递');
  assert.equal(fake.writes.length, 2, '不重复落地');

  // ── 重连之后的新消息照常进入，且只消费一次 ─────────────────
  const after1 = privateEvent({ text: '重连后的话', messageId: 'm-2' });
  second.emit('message', frame(after1));
  await pushes.at(-1);
  assert.equal(frames.length, 3);
  assert.equal(window.pending(KEY), 1, '新 messageId 正常进窗口');
  assert.equal(fake.replies.length, 1, '窗口内还没生成');

  await window.flush(KEY);
  assert.equal(fake.replies.length, 2);
  assert.match(fake.replies[1].text, /重连后的话/);
  assert.equal(fake.replies[1].text.includes('断线前的话'), false, '新批次不重放旧内容');
  assert.deepEqual(
    fake.sent,
    [
      { key: KEY, text: '回：阿蓝：断线前的话' },
      { key: KEY, text: '回：阿蓝：重连后的话' },
    ],
    '两条消息各投递一次，没有重复',
  );

  // ── 再重放一次旧 id：去重不因重连或后续消费而失效 ───────────
  second.emit('message', frame(before));
  await pushes.at(-1);
  await window.flush(KEY);
  assert.equal(frames.length, 4, '第四帧照样到达入口');
  assert.equal(fake.replies.length, 2, '业务消费仍然是 2 次');
  assert.equal(fake.sent.length, 2, '投递仍然是 2 次');

  assert.deepEqual(errors, [], '整条链路没有异常上报');
  await window.close();
});
