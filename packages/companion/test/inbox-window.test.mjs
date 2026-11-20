import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationWindow } from '../src/conversation-window.js';

/** 可控等待：让「等到某个回调发生」不依赖 sleep 的具体毫秒数。 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('同一会话连续三条消息全部保留，并各自带上事件身份', async () => {
  const flushes = [];
  const flushed = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    maxItems: 12,
    onFlush: async (items, batch) => { flushes.push({ items, batch }); flushed.resolve(); },
  });
  const key = 'private:window-one';
  window.push(key, { key, text: '第一句', receiveSequence: 11 }, { eligible: true });
  window.push(key, { key, text: '第二句', receiveSequence: 12 }, { eligible: true });
  window.push(key, { key, text: '第三句', receiveSequence: 13 }, { eligible: true });

  assert.equal(window.pending(key), 3);
  await flushed.promise;
  await window.close();

  assert.equal(flushes.length, 1);
  assert.deepEqual(flushes[0].items.map((item) => item.text), ['第一句', '第二句', '第三句']);
  const events = flushes[0].batch.events;
  assert.deepEqual(events.map((event) => event.eventId), [
    'private:window-one#11', 'private:window-one#12', 'private:window-one#13',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [11, 12, 13]);
  for (const event of events) assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(flushes[0].batch.batchId, /^private:window-one:w\d+$/);
  assert.equal(window.pending(key), 0);
});

test('重复投递的同一条消息只进入窗口一次', async () => {
  const flushes = [];
  const duplicates = [];
  const flushed = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async (items) => { flushes.push(items.map((item) => item.text)); flushed.resolve(); },
    onDuplicate: (identity) => duplicates.push(identity.eventId),
  });
  window.push('group:dup', { text: '在吗', receiveSequence: 5 }, { eligible: true });
  window.push('group:dup', { text: '在吗', receiveSequence: 5 }, { eligible: true });
  window.push('group:dup', { text: '带显式 id', eventId: 'dup-event' }, { eligible: true });
  window.push('group:dup', { text: '带显式 id', eventId: 'dup-event' }, { eligible: true });

  assert.equal(window.pending('group:dup'), 2);
  await flushed.promise;
  await window.close();

  assert.deepEqual(flushes, [['在吗', '带显式 id']]);
  assert.deepEqual(duplicates, ['group:dup#5', 'dup-event']);
});

test('上一批处理期间到达的消息进入下一批，既不丢失也不并进当前批', async () => {
  const flushes = [];
  const first = deferred();
  const second = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async (items) => {
      flushes.push(items.map((item) => item.text));
      if (flushes.length === 1) {
        first.resolve();
        window.push('private:next-batch', { text: '第二批-1', receiveSequence: 3 }, { eligible: true });
        window.push('private:next-batch', { text: '第二批-2', receiveSequence: 4 }, { eligible: true });
      } else {
        second.resolve();
      }
    },
  });
  window.push('private:next-batch', { text: '第一批-1', receiveSequence: 1 }, { eligible: true });
  window.push('private:next-batch', { text: '第一批-2', receiveSequence: 2 }, { eligible: true });

  await first.promise;
  await second.promise;
  await window.close();

  assert.deepEqual(flushes, [['第一批-1', '第一批-2'], ['第二批-1', '第二批-2']]);
});

test('同一会话串行：上一批没处理完不会并发进入下一批', async () => {
  const order = [];
  const done = deferred();
  let running = 0;
  let maxConcurrent = 0;
  const window = new ConversationWindow({
    windowMs: 5,
    maxItems: 1,
    onFlush: async (items) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      const label = items[0].text;
      order.push(`start:${label}`);
      // 让出若干轮事件循环，模拟真正处理一批的异步过程，不用墙钟等待。
      await new Promise((resolve) => { setImmediate(resolve); });
      order.push(`end:${label}`);
      running -= 1;
      if (order.length === 6) done.resolve();
    },
  });
  window.push('serial:one', { text: 'a', receiveSequence: 1 }, { eligible: true });
  window.push('serial:one', { text: 'b', receiveSequence: 2 }, { eligible: true });
  window.push('serial:one', { text: 'c', receiveSequence: 3 }, { eligible: true });

  await done.promise;
  await window.close();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('未命中唤醒条件的窗口仍然保留消息，只是走 onIgnore', async () => {
  const ignored = [];
  const ignoredDone = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async () => { assert.fail('不该调用 onFlush'); },
    onIgnore: async (items, batch) => {
      ignored.push({ count: items.length, batchId: batch.batchId });
      ignoredDone.resolve();
    },
  });
  window.push('group:quiet', { text: '普通闲聊', receiveSequence: 1 });
  window.push('group:quiet', { text: '还在闲聊', receiveSequence: 2 });

  await ignoredDone.promise;
  await window.close();

  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].count, 2);
  assert.match(ignored[0].batchId, /^group:quiet:w\d+$/);
});

test('冻结批次不可变：批次、事件身份和原文列表都冻结，晚到的消息只进下一批', async () => {
  const flushes = [];
  const second = deferred();
  const window = new ConversationWindow({
    windowMs: 1,
    onFlush: async (items, batch) => {
      flushes.push({ items, batch });
      if (flushes.length === 1) {
        // 处理这一批的时候用户又说话了：只能进下一批，不能改写这一批
        window.push('private:frozen', { text: '晚到的', receiveSequence: 2 }, { eligible: true });
      } else {
        second.resolve();
      }
    },
  });
  window.push('private:frozen', { text: '第一批', receiveSequence: 1 }, { eligible: true });

  await second.promise;
  await window.close();

  assert.equal(flushes.length, 2);
  const [first, following] = flushes;
  assert.ok(Object.isFrozen(first.batch), '批次信封要冻结');
  assert.ok(Object.isFrozen(first.batch.events), '批次事件列表要冻结');
  assert.ok(first.batch.events.every((event) => Object.isFrozen(event)), '每条事件身份要冻结');
  assert.ok(Object.isFrozen(first.items), '交给上层的原文列表要冻结');
  assert.equal(first.batch.events.length, 1);
  assert.deepEqual(first.items.map((item) => item.text), ['第一批']);
  assert.deepEqual(following.items.map((item) => item.text), ['晚到的']);
  assert.deepEqual(following.batch.events.map((event) => event.eventId), ['private:frozen#2']);

  // 冻结之后调用方改不动已经交出的上下文，也不会波及窗口内部状态
  assert.throws(() => { first.batch.events[0].eventId = 'tampered'; }, TypeError);
  assert.throws(() => { first.batch.batchId = 'tampered'; }, TypeError);
  assert.throws(() => { first.items.push({ text: '篡改' }); }, TypeError);
});

test('关闭时还没到计时器的待处理消息照常交出，不丢', async () => {
  const flushed = [];
  const ignored = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    onFlush: async (items, batch) => { flushed.push({ texts: items.map((item) => item.text), batch }); },
    onIgnore: async (items) => { ignored.push(items.map((item) => item.text)); },
  });
  window.push('private:closing', { text: '未到计时器-1', receiveSequence: 1 }, { eligible: true });
  window.push('private:closing', { text: '未到计时器-2', receiveSequence: 2 }, { eligible: true });
  window.push('private:closing-quiet', { text: '不该接话', receiveSequence: 1 });

  assert.equal(window.pending('private:closing'), 2);
  await window.close();

  assert.deepEqual(flushed.map((entry) => entry.texts), [['未到计时器-1', '未到计时器-2']]);
  assert.deepEqual(ignored, [['不该接话']]);
  assert.deepEqual(window.pendingKeys(), []);
});

test('关闭之后到达的消息会显式报告，不静默丢弃', async () => {
  const drops = [];
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async () => { assert.fail('关闭之后不该再成批'); },
    onDrop: (reason, meta) => { drops.push([reason, meta.key, meta.item.text]); },
  });
  await window.close();
  await window.push('private:after-close', { text: '关掉之后才到', receiveSequence: 1 }, { eligible: true });

  assert.deepEqual(drops, [['closed', 'private:after-close', '关掉之后才到']]);
  assert.equal(window.pending('private:after-close'), 0);
});

test('同一 eventId 在批次交出之后重复投递不会再次消费', async () => {
  const flushes = [];
  const duplicates = [];
  const flushed = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async (_items, batch) => {
      flushes.push(batch.events.map((event) => event.eventId));
      flushed.resolve();
    },
    onDuplicate: (identity) => { duplicates.push(identity.eventId); },
  });
  window.push('private:redeliver', { text: '一', eventId: 'onebot-77' }, { eligible: true });

  await flushed.promise;
  // 平台把同一条消息又投递了一次，此时上一批早就交出去了
  await window.push('private:redeliver', { text: '一', eventId: 'onebot-77' }, { eligible: true });
  await window.close();

  assert.deepEqual(flushes, [['onebot-77']]);
  assert.deepEqual(duplicates, ['onebot-77']);
  assert.equal(window.pending('private:redeliver'), 0);
});

test('合成对话：同会话串行、原文与身份、晚到下一批、去重与关闭排空', async () => {
  const batches = [];
  const duplicates = [];
  const firstStarted = deferred();
  const secondDone = deferred();
  const gate = deferred();
  const key = 'private:synth';
  let running = 0;
  let maxConcurrent = 0;

  const window = new ConversationWindow({
    windowMs: 5,
    maxItems: 12,
    onFlush: async (items, batch) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      batches.push({
        texts: items.map((item) => item.text),
        events: batch.events.map((event) => ({ id: event.eventId, sequence: event.sequence })),
      });
      if (batches.length === 1) {
        firstStarted.resolve();
        await gate.promise; // 第一批仍然挂在处理中
      } else if (batches.length === 2) {
        secondDone.resolve();
      }
      running -= 1;
    },
    onDuplicate: (identity) => duplicates.push(identity.eventId),
  });

  window.push(key, { key, text: '第一句', receiveSequence: 1 }, { eligible: true });
  window.push(key, { key, text: '第二句', receiveSequence: 2 }, { eligible: true });
  window.push(key, { key, text: '第三句', receiveSequence: 3 }, { eligible: true });
  await firstStarted.promise;

  // 第一批未处理完：重复投递被挡住，新到的只能排进下一批。
  await window.push(key, { key, text: '第二句', receiveSequence: 2 }, { eligible: true });
  await window.push(key, { key, text: '晚到的一句', receiveSequence: 4 }, { eligible: true });
  gate.resolve();
  await secondDone.promise;

  // 关闭时把还在超长计时器里的消息排空，验证轮次边界不丢消息。
  await window.push(key, { key, text: '关前未到计时器', receiveSequence: 5 }, { eligible: true, windowMs: 60_000 });
  await window.close();

  assert.equal(maxConcurrent, 1, '同一会话必须串行');
  assert.deepEqual(
    batches.map((batch) => batch.texts),
    [['第一句', '第二句', '第三句'], ['晚到的一句'], ['关前未到计时器']],
  );
  assert.deepEqual(batches[0].events.map((event) => event.id), [`${key}#1`, `${key}#2`, `${key}#3`]);
  assert.deepEqual(batches[0].events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(duplicates, [`${key}#2`]);
  assert.deepEqual(window.pendingKeys(), []);
});

test('身份归一：显式序号、可解析/不可解析时间与 Date 都产出稳定身份', async () => {
  const batches = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    onFlush: async (_items, batch) => { batches.push(batch); },
  });
  const key = 'identity:one';
  window.push(key, { text: 'a', receiveSequence: 1 }, { eligible: true });
  window.push(key, { text: 'b' }, { eligible: true, sequence: '2' });
  window.push(key, { text: 'c' }, { eligible: true, receivedAt: 1700000000000 });
  window.push(key, { text: 'd' }, { eligible: true, receivedAt: '2024-01-02T03:04:05Z' });
  window.push(key, { text: 'e' }, { eligible: true, receivedAt: 'not-a-date' });
  window.push(key, { text: 'f' }, { eligible: true, receivedAt: new Date('invalid') });
  window.push(key, { text: 'g' }, { eligible: true, receivedAt: new Date(0) });
  window.push(key, { text: 'h' }, { eligible: true, receivedAt: '' });

  await window.flush(key);

  const events = batches[0].events;
  assert.deepEqual(events.map((event) => event.eventId), [
    `${key}#1`, `${key}#2`, `${key}#3`, `${key}#4`,
    `${key}#5`, `${key}#6`, `${key}#7`, `${key}#8`,
  ]);
  assert.deepEqual(events.slice(0, 2).map((event) => event.sequence), [1, 2]);
  assert.equal(events[2].receivedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(events[3].receivedAt, '2024-01-02T03:04:05.000Z');
  assert.equal(events[4].receivedAt, 'not-a-date');
  assert.match(events[5].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(events[6].receivedAt, '1970-01-01T00:00:00.000Z');
  assert.match(events[7].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('去重窗口只保留最近 maxSeen 条：淘汰后的老 eventId 可以重新进入', async () => {
  const batches = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    maxSeen: 2,
    onFlush: async (_items, batch) => { batches.push(batch); },
  });
  const key = 'evict:one';
  window.push(key, { text: 'a' }, { eligible: true, eventId: 'evict-a' });
  window.push(key, { text: 'b' }, { eligible: true, eventId: 'evict-b' });
  window.push(key, { text: 'c' }, { eligible: true, eventId: 'evict-c' });
  window.push(key, { text: 'a-again' }, { eligible: true, eventId: 'evict-a' });

  assert.equal(window.pending(key), 4);
  await window.flush(key);

  assert.deepEqual(batches[0].events.map((event) => event.eventId),
    ['evict-a', 'evict-b', 'evict-c', 'evict-a']);
});

test('批次处理抛错交给 onError，计时器刷出不留下未处理的拒绝', async () => {
  const errors = [];
  const reported = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async () => { throw new Error('boom'); },
    onError: (error, context) => {
      errors.push([error.message, context.key]);
      reported.resolve();
    },
  });
  window.push('error:one', { text: 'x' }, { eligible: true });

  await reported.promise;
  await window.close();

  assert.deepEqual(errors, [['boom', 'error:one']]);
});

test('onError 自己抛错也不会破坏窗口，后续批次照常串行', async () => {
  const seen = [];
  const reported = deferred();
  const window = new ConversationWindow({
    windowMs: 5,
    onFlush: async (items) => {
      seen.push(items.map((item) => item.text));
      if (seen.length === 1) throw new Error('boom');
    },
    onError: () => {
      reported.resolve();
      throw new Error('reporting failed');
    },
  });
  window.push('error:two', { text: 'first' }, { eligible: true });

  await reported.promise;
  await window.push('error:two', { text: 'second' }, { eligible: true });
  await window.close();

  assert.deepEqual(seen, [['first'], ['second']]);
});

test('原文按快照冻结交出：调用方改原对象不影响已收下的上下文', async () => {
  const batches = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    onFlush: async (items, batch) => { batches.push({ items, batch }); },
  });
  const payload = { text: '对象', extra: 1 };
  window.push('raw:one', payload, { eligible: true });
  window.push('raw:one', '纯字符串', { eligible: true });
  window.push('raw:one', ['数组', 1], { eligible: true });
  // 顶层字段是快照：改原对象/加字段都不影响窗口里已收下的副本
  payload.text = '改过';
  payload.added = true;

  await window.flush('raw:one');

  const [first] = batches;
  assert.ok(Object.isFrozen(first.items));
  assert.equal(first.items[0].text, '对象');
  assert.equal(first.items[0].extra, 1);
  assert.equal(first.items[0].added, undefined);
  assert.throws(() => { first.items[0].text = '篡改'; }, TypeError);
  assert.equal(first.items[1], '纯字符串');
  assert.deepEqual(first.items[2], ['数组', 1]);
  assert.deepEqual(first.batch.events.map((event) => event.eventId),
    ['raw:one#1', 'raw:one#2', 'raw:one#3']);
});

test('空窗口 flush 与重复 close 幂等，不产生额外批次', async () => {
  const flushes = [];
  const window = new ConversationWindow({
    windowMs: 60_000,
    onFlush: async (_items, batch) => { flushes.push(batch.batchId); },
  });

  await window.flush('missing:key');
  assert.deepEqual(window.pendingKeys(), []);

  await window.close();
  await window.close();

  assert.deepEqual(flushes, []);
});