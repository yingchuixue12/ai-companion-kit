/**
 * 提醒投递 · OneBot 私聊适配 · issue #40（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证提醒发送这一小段的行为，全部离线：
 *
 *   createOneBotReminderSender({ bot, window, ownerIds }).send(...)
 *     → 严格私聊 key + ownerIds 白名单
 *     → window.runSerial(key, job)
 *     → bot.sendPrivateText(userId, text)
 *     → confirmed / rejected / unknown
 *
 * 覆盖点：
 *   1. 构造边界：bot / window 能力缺失抛 TypeError；ownerIds 只认规范十进制；
 *   2. 严格 key：只接受 private:<十进制正整数>，拒绝群聊、空白、前导零、
 *      尾换行、非字符串，且被拒绝时零入队、零发送；
 *   3. 空正文 / 非字符串正文：failed 且零调用；有效正文不 trim，原样下发；
 *   4. 回执映射：confirmed → sent，rejected → failed，其余回执、异常、
 *      runSerial 拒绝（窗口关闭）→ unknown；
 *   5. 共享 ConversationWindow 队列：批次未完成时提醒不插队，同会话提醒
 *      按 FIFO 串行、不同会话可并行；
 *   6. OneBot.sendPrivateText：只发一个 text 段、正文原样、回执复用；
 *      用假 api 调 OneBot.prototype.sendPrivateText.call，全程零网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOneBotReminderSender } from '../src/reminder-onebot.js';
import { OneBot } from '../src/transport-onebot.js';
import { ConversationWindow } from '../src/conversation-window.js';

const KEY = 'private:10001';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** 假 bot：记录每次发送；receipt 由用例决定。 */
function fakeBot(receipt = { status: 'confirmed', messageId: 'm-1' }, onSend) {
  const calls = [];
  const bot = {
    async sendPrivateText(userId, text) {
      calls.push({ userId, text });
      return onSend ? onSend({ userId, text }) : { ok: true, receipt };
    },
  };
  return { bot, calls };
}

/** 假窗口：记录入队 key；默认立即执行 job。 */
function fakeWindow(runSerial) {
  const serials = [];
  const window = {
    runSerial(key, job) {
      serials.push(key);
      return runSerial ? runSerial(key, job) : Promise.resolve().then(job);
    },
  };
  return { window, serials };
}

function harness({ receipt, ownerIds = ['10001'], runSerial, onSend, bot: injected } = {}) {
  const tracked = injected ? { bot: injected, calls: [] } : fakeBot(receipt, onSend);
  const { window, serials } = fakeWindow(runSerial);
  const sender = createOneBotReminderSender({ bot: tracked.bot, window, ownerIds });
  return { sender, bot: tracked.bot, calls: tracked.calls, serials, window };
}

test('构造边界：bot / window 能力必备，ownerIds 只认规范十进制', async () => {
  assert.throws(() => createOneBotReminderSender(), TypeError);
  assert.throws(() => createOneBotReminderSender({}), TypeError);
  assert.throws(() => createOneBotReminderSender({ bot: {}, window: { runSerial() {} } }), TypeError);
  assert.throws(() => createOneBotReminderSender({ bot: { sendPrivateText() {} } }), TypeError);
  assert.throws(() => createOneBotReminderSender({ bot: { sendPrivateText() {} }, window: {} }), TypeError);

  // 未给白名单、给成字符串、或全是非法项：一律 failed，零入队零发送。
  const unusable = [
    undefined, null, '10001', [], [null, {}, true, 0, -1, 1.5, '010001', '10001 ', 'abc'],
  ];
  for (const ownerIds of unusable) {
    const { bot, calls } = fakeBot();
    const { window, serials } = fakeWindow();
    const sender = createOneBotReminderSender({ bot, window, ownerIds });
    assert.equal(await sender.send({ conversationKey: KEY, text: 'hi' }), 'failed', String(ownerIds));
    assert.equal(calls.length, 0, '零发送');
    assert.equal(serials.length, 0, '零入队');
  }
});

test('白名单完整匹配：数字/字符串等价，非法项不放宽', async () => {
  const { sender, calls, serials } = harness({
    ownerIds: [10001, '10002', '010003', '10003 ', 0, -1, 1.5, null, {}, true, 'abc'],
  });
  assert.equal(await sender.send({ conversationKey: 'private:10001', text: 'a' }), 'sent');
  assert.equal(await sender.send({ conversationKey: 'private:10002', text: 'b' }), 'sent');
  // 前导零项、带尾空白项、超集 / 前缀都不能命中。
  assert.equal(await sender.send({ conversationKey: 'private:10003', text: 'c' }), 'failed');
  assert.equal(await sender.send({ conversationKey: 'private:1000', text: 'd' }), 'failed');
  assert.equal(await sender.send({ conversationKey: 'private:100011', text: 'e' }), 'failed');
  assert.deepEqual(calls.map((call) => call.userId), ['10001', '10002']);
  assert.deepEqual(serials, ['private:10001', 'private:10002']);

  // Set 也可用，重复项不会重复发送。
  const setHarness = harness({ ownerIds: new Set(['10005', '10005']) });
  assert.equal(await setHarness.sender.send({ conversationKey: 'private:10005', text: 'x' }), 'sent');
  assert.equal(setHarness.calls.length, 1);
});

test('严格私聊 key：群聊、空白、前导零、尾换行、非字符串一律 failed 且零调用', async () => {
  const keys = [
    'private:010001', 'private:0', 'private:-1', 'private:1.5', 'private:10001\n',
    'private:10001 ', 'private: 10001', 'private:10001\t', 'private:10001x',
    'private:', 'private', 'Private:10001', 'private:１０００１',
    'group:10001', 'private:10002', '',
  ];
  const { sender, calls, serials } = harness();
  for (const key of keys) {
    assert.equal(await sender.send({ conversationKey: key, text: 'hi' }), 'failed', JSON.stringify(key));
  }
  for (const key of [10001, null, undefined, true, {}, [], new String(KEY)]) {
    assert.equal(await sender.send({ conversationKey: key, text: 'hi' }), 'failed', String(key));
  }
  assert.equal(calls.length, 0, '拒绝时绝不发送');
  assert.equal(serials.length, 0, '拒绝时绝不入队');
});

test('空正文 / 非字符串正文：failed 且零调用；有效正文原样下发、不 trim', async () => {
  const { sender, calls, serials } = harness();
  for (const text of ['', '   ', '\n', '\t \n', new String('hi'), 0, 1, null, undefined, {}, [], true]) {
    assert.equal(await sender.send({ conversationKey: KEY, text }), 'failed', String(text));
  }
  assert.equal(await sender.send({ conversationKey: KEY }), 'failed');
  assert.equal(await sender.send({}), 'failed');
  assert.equal(await sender.send(), 'failed');
  assert.equal(calls.length, 0, '拒绝时绝不发送');
  assert.equal(serials.length, 0, '拒绝时绝不入队');

  // 两侧空白与换行都属于正文，必须原样保留。
  const ok = harness();
  assert.equal(await ok.sender.send({ conversationKey: KEY, text: '  第一行\n第二行\n' }), 'sent');
  assert.deepEqual(ok.calls, [{ userId: '10001', text: '  第一行\n第二行\n' }]);
  assert.deepEqual(ok.serials, [KEY], '与普通批次共用同一个会话 key');
});

test('回执映射：confirmed → sent，rejected → failed，其余与异常 → unknown', async () => {
  const receipts = [
    [{ status: 'confirmed', messageId: 'm-9' }, 'sent'],
    [{ status: 'rejected' }, 'failed'],
    [{ status: 'unknown' }, 'unknown'],
    [{ status: 'confirmed ' }, 'unknown'],
    [{ status: 'sent' }, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [receipt, expected] of receipts) {
    const { sender } = harness({ receipt });
    assert.equal(await sender.send({ conversationKey: KEY, text: 't' }), expected, JSON.stringify(receipt));
  }

  // 结果不是对象、没有回执、状态陌生 → unknown。
  for (const result of [null, undefined, {}, { receipt: null }, { receipt: { status: 'ok' } }]) {
    const { sender } = harness({ onSend: () => result });
    assert.equal(await sender.send({ conversationKey: KEY, text: 't' }), 'unknown', JSON.stringify(result));
  }

  // 传输层抛错、runSerial 同步抛错 / 拒绝（含窗口已关闭）→ unknown，且不发送。
  const throwing = harness({ onSend: () => { throw new Error('boom'); } });
  assert.equal(await throwing.sender.send({ conversationKey: KEY, text: 't' }), 'unknown');
  for (const runSerial of [
    () => { throw new Error('sync'); },
    () => Promise.reject(Object.assign(new Error('closed'), { code: 'window-closed' })),
    () => Promise.reject('nope'),
  ]) {
    const closed = harness({ runSerial });
    assert.equal(await closed.sender.send({ conversationKey: KEY, text: 't' }), 'unknown');
    assert.equal(closed.calls.length, 0, '入队失败时不发送');
  }
});

test('共享 ConversationWindow 队列：批次未完成时提醒不插队', async () => {
  const order = [];
  const started = deferred();
  const gate = deferred();
  const window = new ConversationWindow({
    windowMs: 60_000,
    onFlush: async () => {
      order.push('flush:start');
      started.resolve();
      await gate.promise;
      order.push('flush:end');
    },
  });
  window.push(KEY, { text: 'hi', receiveSequence: 1 }, { eligible: true });
  const flushed = window.flush(KEY);

  const { bot, calls } = fakeBot();
  const sender = createOneBotReminderSender({ bot, window, ownerIds: ['10001'] });
  const sent = sender.send({ conversationKey: KEY, text: '提醒' });

  await started.promise;
  await tick();
  assert.deepEqual(order, ['flush:start'], '批次未完成，提醒不能开始');
  assert.equal(calls.length, 0, '提醒没有绕过队列');

  gate.resolve();
  assert.equal(await sent, 'sent');
  await flushed;
  assert.deepEqual(order, ['flush:start', 'flush:end']);
  await window.close();
});

test('同一会话提醒按 FIFO 串行，不同会话可并行', async () => {
  const gate = deferred();
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const bot = {
    async sendPrivateText(userId, text) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push('start:' + text);
      if (text === 'slow') await gate.promise;
      order.push('end:' + text);
      inFlight -= 1;
      return { ok: true, receipt: { status: 'confirmed' } };
    },
  };
  const window = new ConversationWindow();
  const sender = createOneBotReminderSender({ bot, window, ownerIds: ['10001', '10002'] });
  const slow = sender.send({ conversationKey: 'private:10001', text: 'slow' });
  const fast = sender.send({ conversationKey: 'private:10001', text: 'fast' });
  await tick();
  assert.equal(maxInFlight, 1, '同一会话不能并发');
  gate.resolve();
  assert.equal(await slow, 'sent');
  assert.equal(await fast, 'sent');
  assert.deepEqual(order, ['start:slow', 'end:slow', 'start:fast', 'end:fast']);
  await window.close();

  // 跨会话各走各的队尾，可以同时挂起、互不阻塞。
  const gate2 = deferred();
  const parallelOrder = [];
  let inFlight2 = 0;
  let max2 = 0;
  const bot2 = {
    async sendPrivateText(userId, text) {
      inFlight2 += 1;
      max2 = Math.max(max2, inFlight2);
      parallelOrder.push('start:' + text);
      if (text === 'a') await gate2.promise;
      parallelOrder.push('end:' + text);
      inFlight2 -= 1;
      return { ok: true, receipt: { status: 'confirmed' } };
    },
  };
  const window2 = new ConversationWindow();
  const sender2 = createOneBotReminderSender({ bot: bot2, window: window2, ownerIds: ['10001', '10002'] });
  const a = sender2.send({ conversationKey: 'private:10001', text: 'a' });
  const b = sender2.send({ conversationKey: 'private:10002', text: 'b' });
  await tick();
  assert.equal(max2, 2, '不同会话可以并行');
  gate2.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(parallelOrder, ['start:a', 'start:b', 'end:b', 'end:a']);
  await window2.close();
});

test('窗口已关闭：runSerial 拒绝 → unknown，且不发送', async () => {
  const window = new ConversationWindow();
  await window.close();
  const { bot, calls } = fakeBot();
  const sender = createOneBotReminderSender({ bot, window, ownerIds: ['10001'] });
  assert.equal(await sender.send({ conversationKey: KEY, text: 'hi' }), 'unknown');
  assert.equal(calls.length, 0);
});

test('sendPrivateText：单个 text 段、正文原样、回执复用；零网络', async (t) => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('network'); });

  for (const text of ['  第一行\n第二行\n', 'plain', '  ']) {
    const seen = [];
    const transport = {
      async api(action, params) {
        seen.push({ action, params });
        return { ok: true, data: { status: 'ok', retcode: 0, data: { message_id: '42' } } };
      },
    };
    const result = await OneBot.prototype.sendPrivateText.call(transport, '10001', text);
    assert.deepEqual(seen, [{
      action: 'send_private_msg',
      params: { user_id: '10001', message: [{ type: 'text', data: { text } }] },
    }], text);
    assert.deepEqual(result.receipt, { status: 'confirmed', messageId: '42' });
    assert.equal(result.ok, true);
  }

  const rejected = { async api() { return { ok: false, data: { status: 'failed', retcode: 120 } }; } };
  assert.deepEqual(
    (await OneBot.prototype.sendPrivateText.call(rejected, '1', 'x')).receipt,
    { status: 'rejected' },
  );
  const unknown = { async api() { return { ok: true, data: { status: 'ok', retcode: 1 } }; } };
  assert.deepEqual(
    (await OneBot.prototype.sendPrivateText.call(unknown, '1', 'x')).receipt,
    { status: 'unknown' },
  );
  assert.equal(fetchSpy.mock.callCount(), 0, '全程没有网络调用');
});

test('端到端：sender → 共享窗口 → 真实 sendPrivateText，零网络', async (t) => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('network'); });
  const apiCalls = [];
  const transport = {
    async api(action, params) {
      apiCalls.push({ action, params });
      return { ok: true, data: { status: 'ok', retcode: 0, data: { message_id: '99' } } };
    },
  };
  const bot = {
    sendPrivateText: (userId, text) => OneBot.prototype.sendPrivateText.call(transport, userId, text),
  };
  const window = new ConversationWindow();
  const sender = createOneBotReminderSender({ bot, window, ownerIds: ['10001'] });

  assert.equal(await sender.send({ conversationKey: 'private:10001', text: ' 喝水\n' }), 'sent');
  assert.deepEqual(apiCalls, [{
    action: 'send_private_msg',
    params: { user_id: '10001', message: [{ type: 'text', data: { text: ' 喝水\n' } }] },
  }]);
  assert.equal(fetchSpy.mock.callCount(), 0);
  await window.close();
});
