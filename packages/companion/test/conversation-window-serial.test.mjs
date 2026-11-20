import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationWindow } from '../src/conversation-window.js';

/** 可控等待：用 deferred 表达“某个异步阶段已经开始/可以放行”，不靠墙钟。 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

test('同一会话 flush→runSerial→flush 严格按 FIFO 执行', async () => {
  const order = [];
  const firstStarted = deferred();
  const gate = deferred();
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    onFlush: async (items) => {
      order.push(`flush:${items[0].text}`);
      if (items[0].text === 'a') {
        firstStarted.resolve();
        await gate.promise;
      }
    },
  });
  const key = 'serial:fifo';
  window.push(key, { text: 'a', receiveSequence: 1 }, { eligible: true });
  const first = window.flush(key);
  const explicit = window.runSerial(key, async () => {
    order.push('explicit');
    return 'explicit-result';
  });
  window.push(key, { text: 'b', receiveSequence: 2 }, { eligible: true });
  const second = window.flush(key);

  await firstStarted.promise;
  assert.deepEqual(order, ['flush:a'], '第一批未完成时显式工作不能插队');
  assert.equal(window.pending(key), 0, '两个批次都已被各自的 flush 取走');

  gate.resolve();
  assert.equal(await explicit, 'explicit-result');
  await Promise.all([first, second]);
  assert.deepEqual(order, ['flush:a', 'explicit', 'flush:b']);
  await window.close();
});

test('runSerial 不提前刷出待定时的消息，也不改动 pending', async () => {
  const flushes = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    onFlush: async (items) => { flushes.push(items.map((item) => item.text)); },
  });
  const key = 'serial:pending';
  window.push(key, { text: '定时窗口里的一条', receiveSequence: 1 }, { eligible: true });
  assert.equal(window.pending(key), 1);

  const observed = await window.runSerial(key, async () => ({
    pending: window.pending(key),
    flushed: [...flushes],
  }));
  assert.deepEqual(observed, { pending: 1, flushed: [] });
  assert.equal(window.pending(key), 1);
  assert.deepEqual(window.pendingKeys(), [key]);

  await window.flush(key);
  assert.deepEqual(flushes, [['定时窗口里的一条']]);
  await window.close();
});

test('不同会话的显式工作互不串行，可以并行完成', async () => {
  const order = [];
  const gate = deferred();
  const window = new ConversationWindow();
  const slow = window.runSerial('serial:key-a', async () => {
    await gate.promise;
    order.push('a');
    return 'slow-result';
  });
  const fast = window.runSerial('serial:key-b', async () => {
    order.push('b');
    return 'fast-result';
  });

  assert.equal(await fast, 'fast-result');
  assert.deepEqual(order, ['b'], 'a 还没放行，b 已经完成');
  gate.resolve();
  assert.equal(await slow, 'slow-result');
  assert.deepEqual(order, ['b', 'a']);
  await window.close();
});

test('显式工作的异常原样交回且不触发 onError；普通批次失败走 onError 后可继续', async () => {
  const flushFailures = [];
  const goodBatches = [];
  let failNext = true;
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    onFlush: async (items) => {
      if (failNext) {
        failNext = false;
        throw new Error('batch-failed');
      }
      goodBatches.push(items.map((item) => item.text));
    },
    onError: (error, context) => { flushFailures.push([error.message, context.key]); },
  });
  const key = 'serial:errors';

  const original = new Error('explicit-failed');
  await assert.rejects(
    window.runSerial(key, async () => { throw original; }),
    (error) => error === original,
  );
  assert.deepEqual(flushFailures, [], '显式工作的错误不交给 onError');

  window.push(key, { text: 'bad-batch', receiveSequence: 1 }, { eligible: true });
  assert.equal(await window.flush(key), undefined, '普通批次失败仍 resolve');
  assert.deepEqual(flushFailures, [['batch-failed', key]]);

  window.push(key, { text: 'good-batch', receiveSequence: 2 }, { eligible: true });
  await window.flush(key);
  assert.deepEqual(goodBatches, [['good-batch']]);

  assert.equal(await window.runSerial(key, async () => 'after-failures'), 'after-failures');
  await window.close();
});

test('close 等待已接受的显式工作与待刷批次，之后以 window-closed 拒绝', async () => {
  const events = [];
  const gate = deferred();
  const jobStarted = deferred();
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    onFlush: async (items) => { events.push(`flush:${items[0].text}`); },
  });
  const key = 'serial:close';
  window.push(key, { text: '关前未刷', receiveSequence: 1 }, { eligible: true });
  const explicit = window.runSerial(key, async () => {
    events.push('job:start');
    jobStarted.resolve();
    await gate.promise;
    events.push('job:end');
    return 'job-result';
  });
  const closing = window.close();

  await jobStarted.promise;
  assert.deepEqual(events, ['job:start'], '待刷批次排在已接受的显式工作之后');

  let settled = false;
  closing.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, '显式工作未落定时 close 不能完成');

  gate.resolve();
  assert.equal(await explicit, 'job-result');
  await closing;
  assert.deepEqual(events, ['job:start', 'job:end', 'flush:关前未刷']);
  assert.equal(window.pending(key), 0);
  assert.deepEqual(window.pendingKeys(), []);

  await assert.rejects(
    window.runSerial(key, async () => {}),
    (error) => error?.code === 'window-closed',
  );
});

test('非函数工作以 TypeError 拒绝，且不影响后续显式工作', async () => {
  const window = new ConversationWindow();
  await assert.rejects(
    window.runSerial('serial:type', 'not-a-function'),
    (error) => error instanceof TypeError,
  );
  await assert.rejects(
    window.runSerial('serial:type'),
    (error) => error instanceof TypeError,
  );

  assert.equal(await window.runSerial('serial:type', async () => 'still-works'), 'still-works');
  await window.close();
});
test('收消息时间归一：Date、ISO 字符串与空白时间都经 batch.events 交出', async () => {
  const flushes = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    onFlush: async (_items, batch) => { flushes.push(batch); },
  });
  const key = 'serial:time';
  window.push(key, { text: '有效 Date', receiveSequence: 1 }, {
    eligible: true,
    receivedAt: new Date('2024-01-02T03:04:05Z'),
  });
  window.push(key, { text: '无效 Date', receiveSequence: 2 }, {
    eligible: true,
    receivedAt: new Date('not-a-date'),
  });
  window.push(key, { text: '带空白的 ISO', receiveSequence: 3 }, {
    eligible: true,
    receivedAt: ' 2024-02-03T04:05:06.789Z ',
  });
  window.push(key, { text: '只有空白', receiveSequence: 4 }, {
    eligible: true,
    receivedAt: '   ',
  });

  assert.equal(window.pending(key), 4);
  await window.flush(key);

  assert.equal(flushes.length, 1);
  const times = flushes[0].events.map((event) => event.receivedAt);
  assert.equal(times[0], '2024-01-02T03:04:05.000Z');
  assert.match(times[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '无效 Date 回落到当前时间');
  assert.equal(times[2], '2024-02-03T04:05:06.789Z');
  assert.match(times[3], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '空白时间回落到当前时间');
  await window.close();
});

test('小 maxSeen 下重复被挡、过期后可再接受，close 后的丢弃回调不破坏窗口', async () => {
  const flushes = [];
  const duplicates = [];
  const drops = [];
  let dropReporterThrows = true;
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxItems: 100,
    maxSeen: 2,
    onFlush: async (_items, batch) => { flushes.push(batch.events.map((event) => event.eventId)); },
    onDuplicate: (identity, meta) => { duplicates.push([identity.eventId, meta.key]); },
    onDrop: (reason, meta) => {
      drops.push([reason, meta.key, meta.item.text]);
      if (dropReporterThrows) {
        dropReporterThrows = false;
        throw new Error('drop reporter failed');
      }
    },
  });
  const key = 'serial:seen';
  window.push(key, { text: 'a', eventId: 'seen-a' }, { eligible: true });
  window.push(key, { text: 'a 重复', eventId: 'seen-a' }, { eligible: true });
  window.push(key, { text: 'b', eventId: 'seen-b' }, { eligible: true });
  window.push(key, { text: 'c', eventId: 'seen-c' }, { eligible: true });
  window.push(key, { text: 'a 过期后重来', eventId: 'seen-a' }, { eligible: true });

  assert.equal(window.pending(key), 4, '重复的一条被挡住，其余都保留');
  assert.deepEqual(duplicates, [['seen-a', key]]);

  await window.flush(key);
  assert.deepEqual(flushes, [['seen-a', 'seen-b', 'seen-c', 'seen-a']]);

  await window.close();
  await window.push(key, { text: '关闭后第一条' }, { eligible: true });
  await window.push(key, { text: '关闭后第二条' }, { eligible: true });

  assert.deepEqual(drops, [
    ['closed', key, '关闭后第一条'],
    ['closed', key, '关闭后第二条'],
  ]);
  assert.equal(window.pending(key), 0);
  assert.deepEqual(window.pendingKeys(), []);
});
