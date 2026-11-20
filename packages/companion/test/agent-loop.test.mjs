import test from 'node:test';
import assert from 'node:assert/strict';
import AgentLoop, { AgentLoop as NamedAgentLoop } from '../src/agent-loop.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function collectIds(events) {
  return events.map((event) => event.eventId);
}

test('默认 turn 边界：开轮冻结当前批次，推理期间的新消息留到下一轮', async () => {
  const turns = [];
  let shape = null;
  const loop = new AgentLoop({
    key: 'private:batch',
    onTurn: async (inputs, ctx) => {
      turns.push({
        turn: ctx.turn,
        step: ctx.step,
        ids: collectIds(ctx.events),
        texts: inputs.map((input) => input.text),
      });
      if (ctx.turn === 1) {
        shape = {
          loop: ctx.loop === loop,
          signal: ctx.signal instanceof AbortSignal,
          batchId: ctx.batchId,
          frozenAt: ctx.frozenAt,
          attempts: ctx.attempts,
          task: ctx.task,
          tasks: ctx.tasks,
          inbox: ctx.inbox === loop.inbox,
        };
        loop.followup({ text: '推理中-1' }, { sequence: 2 });
        loop.followup({ text: '推理中-2' }, { sequence: 3 });
      }
    },
  });

  assert.equal(loop.followup({ text: '第一轮' }, { sequence: 1 }), true);
  await loop.whenIdle();
  await loop.close();

  assert.deepEqual(turns.map((turn) => turn.texts), [['第一轮'], ['推理中-1'], ['推理中-2']]);
  assert.deepEqual(turns.map((turn) => turn.step), [0, 0, 0]);
  assert.deepEqual(turns.flatMap((turn) => turn.ids), [
    'private:batch#1', 'private:batch#2', 'private:batch#3',
  ]);
  assert.equal(shape.loop, true);
  assert.equal(shape.signal, true);
  assert.equal(shape.inbox, true);
  assert.equal(shape.task, null);
  assert.deepEqual(shape.tasks, []);
  assert.equal(shape.attempts, 0);
  assert.match(shape.batchId, /^private:batch:b\d+$/);
  assert.match(shape.frozenAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('step-only 保持空闲：inject 不唤醒，steer 不单独开轮，下一次 followup 时并入同一批', async () => {
  const turns = [];
  const loop = new AgentLoop({
    key: 'private:step',
    onTurn: async (inputs, ctx) => {
      turns.push({
        turn: ctx.turn,
        step: ctx.step,
        ids: collectIds(ctx.events),
        texts: inputs.map((input) => input.text),
      });
      if (ctx.turn === 1 && ctx.step === 0) loop.steer({ text: '工具结果' }, { sequence: 3 });
    },
  });

  loop.inject({ text: '注入的上下文' }, { sequence: 1 });
  loop.steer({ text: '另一个 step' }, { sequence: 2 });
  await loop.whenIdle();

  assert.deepEqual(turns, [], '只有 step 事件时不能自己开轮');
  assert.equal(loop.pendingEvents().length, 2);
  assert.equal(loop.pendingEvents({ lane: 'step' }).length, 2);
  assert.equal(loop.pendingEvents({ lane: 'turn' }).length, 0);

  loop.followup({ text: '真正的用户消息' }, { sequence: 4 });
  await loop.whenIdle();
  await loop.close();

  assert.deepEqual(turns.map((turn) => turn.texts), [
    ['注入的上下文', '另一个 step', '真正的用户消息'],
    ['工具结果'],
  ]);
  assert.deepEqual(turns.map((turn) => turn.step), [0, 1]);
  assert.deepEqual(turns[0].ids, ['private:step#1', 'private:step#2', 'private:step#4']);
  assert.deepEqual(turns[1].ids, ['private:step#3']);
});

test('事件身份：meta 优先、原始消息兜底、重复投递只消费一次，ctx.events 只是快照', async () => {
  const rawLoop = new AgentLoop({
    key: 'private:adapter',
    onTurn: async (_inputs, ctx) => {
      ctx.events.length = 0;
    },
  });
  const message = {
    text: '在吗',
    receiveSequence: 21,
    receivedAt: '2026-10-29T09:10:11.000Z',
  };
  rawLoop.followup(message);
  await rawLoop.whenIdle();
  rawLoop.followup({ ...message });
  await rawLoop.whenIdle();
  assert.equal(rawLoop.inbox.has('private:adapter#21'), true);
  assert.equal(rawLoop.inbox.has('injected'), false);
  await rawLoop.close();

  const seen = [];
  const metaLoop = new AgentLoop({
    key: 'private:identity',
    onTurn: async (_inputs, ctx) => {
      seen.push(ctx.events.map((event) => ({ ...event })));
      if (seen.length === 1) {
        ctx.events.push({ eventId: 'injected', sequence: 999, receivedAt: 'x', lane: 'turn' });
        ctx.events.length = 0;
      }
    },
  });

  metaLoop.followup(
    { eventId: 'payload-id', receiveSequence: 5, receivedAt: '2000-01-01T00:00:00.000Z' },
    { eventId: 'meta-id', sequence: 9, receivedAt: 0 },
  );
  await metaLoop.whenIdle();
  assert.deepEqual(seen[0], [{
    eventId: 'meta-id',
    sequence: 9,
    receivedAt: new Date(0).toISOString(),
    lane: 'turn',
  }]);
  assert.equal(metaLoop.inbox.has('meta-id'), true);
  assert.equal(metaLoop.inbox.has('payload-id'), false);
  assert.equal(metaLoop.inbox.has('injected'), false);

  metaLoop.followup('not-an-object');
  await metaLoop.whenIdle();
  metaLoop.followup(['array-payload']);
  await metaLoop.whenIdle();
  metaLoop.followup({ eventId: 'payload-2' }, { eventId: '' });
  await metaLoop.whenIdle();
  await metaLoop.close();

  assert.deepEqual(seen.map((events) => events[0].eventId), [
    'meta-id', 'private:identity#10', 'private:identity#11', 'payload-2',
  ]);
});

test('同一时刻只有一个回调在跑，批次严格串行', async () => {
  const order = [];
  let running = 0;
  let maxConcurrent = 0;
  const loop = new AgentLoop({
    key: 'serial:one',
    onTurn: async (_inputs, ctx) => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      const id = ctx.events[0].eventId;
      order.push(`start:${id}`);
      await Promise.resolve();
      order.push(`end:${id}`);
      running -= 1;
    },
  });

  loop.followup({ text: 'a' }, { sequence: 1 });
  loop.followup({ text: 'b' }, { sequence: 2 });
  loop.followup({ text: 'c' }, { sequence: 3 });
  await loop.whenIdle();
  await loop.close();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, [
    'start:serial:one#1', 'end:serial:one#1',
    'start:serial:one#2', 'end:serial:one#2',
    'start:serial:one#3', 'end:serial:one#3',
  ]);
});

test('取消协作：中断当前轮并按已消费处理，不在失败区复活', async () => {
  const loop = new AgentLoop({
    key: 'private:abort',
    onTurn: (_inputs, ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });

  loop.followup({ text: '要中断的' }, { sequence: 1 });
  loop.cancel();
  await loop.whenIdle();

  assert.equal(loop.failedBatches().length, 0);
  assert.equal(loop.pendingEvents().length, 0);
  await loop.close();
});

test('取消默认清空队列，keepInbox 保留队列，空闲取消也安全', async () => {
  const batches = [];
  const loop = new AgentLoop({
    key: 'private:cancel',
    onTurn: async (inputs) => { batches.push(inputs.map((input) => input.text)); },
  });

  loop.cancel();
  await loop.whenIdle();
  loop.followup({ text: 'a' }, { sequence: 1 });
  await loop.whenIdle();

  loop.inject({ text: 'b' }, { sequence: 2 });
  loop.cancel({ keepInbox: true });
  assert.equal(loop.pendingEvents().length, 1, 'keepInbox 保留尚未冻结的输入');

  loop.followup({ text: 'c' }, { sequence: 3 });
  await loop.whenIdle();
  assert.deepEqual(batches, [['a'], ['b', 'c']]);

  loop.inject({ text: 'd' }, { sequence: 4 });
  loop.cancel();
  assert.equal(loop.pendingEvents().length, 0, '默认取消清空队列');
  await loop.close();
});

test('close 协作取消当前轮、清空收件箱，重复 close 幂等且拒绝后续入队', async () => {
  const active = new AgentLoop({
    key: 'private:close-active',
    onTurn: (_inputs, ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    }),
  });
  active.followup({ text: '运行中' }, { sequence: 1 });
  const closing = active.close();
  await closing;
  assert.equal(active.closed, true);
  assert.equal(active.pendingEvents().length, 0);
  assert.equal(active.failedBatches().length, 0);

  const idle = new AgentLoop({ key: 'private:close', onTurn: async () => {} });
  const first = idle.close();
  const second = idle.close();
  assert.equal(first, second, '重复 close 返回同一个活动 Promise');
  assert.equal(idle.followup({ text: 'late' }), false);
  assert.equal(idle.replayFailed(), 0);
  await idle.close();
});

test('失败默认留档，重复投递不增加第二份，显式 replayFailed 后只消费一次', async () => {
  const attempts = [];
  let failing = true;
  const loop = new AgentLoop({
    key: 'private:replay',
    onTurn: async (_inputs, ctx) => {
      attempts.push({ ids: collectIds(ctx.events), attempt: ctx.attempts });
      if (failing) throw new Error('模型超时');
    },
  });

  loop.followup({ text: '请回答' }, { sequence: 1 });
  await loop.whenIdle();

  assert.deepEqual(attempts, [{ ids: ['private:replay#1'], attempt: 0 }], '默认不自动重试');
  assert.equal(loop.pendingEvents().length, 0);
  assert.equal(loop.failedBatches().length, 1);
  assert.equal(loop.failedBatches()[0].error, '模型超时');
  assert.deepEqual(collectIds(loop.failedBatches()[0].events), ['private:replay#1']);

  loop.followup({ text: '请回答' }, { sequence: 1 });
  await loop.whenIdle();
  assert.equal(loop.failedBatches().length, 1, '失败区里的重复投递不能变成第二份');

  failing = false;
  assert.equal(loop.replayFailed(), 1);
  await loop.whenIdle();
  assert.equal(loop.replayFailed(), 0, '没有失败批次时返回 0');
  assert.deepEqual(attempts, [
    { ids: ['private:replay#1'], attempt: 0 },
    { ids: ['private:replay#1'], attempt: 0 },
  ]);
  assert.equal(loop.failedBatches().length, 0);
  await loop.close();
});

test('maxAttempts 显式放开才有界自动重试，重试次数用尽后留档', async () => {
  const attempts = [];
  const outcomes = [];
  const loop = new AgentLoop({
    key: 'private:retry',
    maxAttempts: 3,
    onTurn: async (_inputs, ctx) => {
      attempts.push(ctx.attempts);
      throw new Error('仍然失败');
    },
    onError: (_error, meta) => { outcomes.push(meta.outcome); },
  });

  loop.followup({ text: 'x' }, { sequence: 1 });
  await loop.whenIdle();
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(outcomes, ['requeued', 'requeued', 'failed']);
  assert.equal(loop.failedBatches().length, 1);
  assert.equal(loop.failedBatches()[0].attempts, 3);
  await loop.close();
});

test('收拢模式把排队期间的轮次输入合成一批，默认关闭时仍逐条开轮', async () => {
  const coalesced = [];
  const loop = new AgentLoop({
    key: 'private:coalesce',
    coalesceTurns: true,
    onTurn: async (inputs, ctx) => {
      coalesced.push(inputs.map((input) => input.text));
      if (ctx.turn === 1) {
        loop.followup({ text: '第二句' }, { sequence: 2 });
        loop.followup({ text: '第三句' }, { sequence: 3 });
        loop.followup({ text: '第四句' }, { sequence: 4 });
      }
    },
  });
  loop.followup({ text: '第一句' }, { sequence: 1 });
  await loop.whenIdle();
  await loop.close();
  assert.deepEqual(coalesced, [['第一句'], ['第二句', '第三句', '第四句']]);

  const discrete = [];
  const plain = new AgentLoop({
    key: 'private:no-coalesce',
    onTurn: async (inputs) => {
      discrete.push(inputs.map((input) => input.text));
      if (discrete.length === 1) {
        plain.followup({ text: 'b' }, { sequence: 2 });
        plain.followup({ text: 'c' }, { sequence: 3 });
      }
    },
  });
  plain.followup({ text: 'a' }, { sequence: 1 });
  await plain.whenIdle();
  await plain.close();
  assert.deepEqual(discrete, [['a'], ['b'], ['c']]);
});

test('收拢模式单批条数有上限，多出来的留给下一轮', async () => {
  const batches = [];
  const loop = new AgentLoop({
    key: 'private:coalesce-cap',
    coalesceTurns: true,
    maxTurnBatchItems: 3,
    onTurn: async (inputs) => { batches.push(inputs.map((input) => input.text)); },
  });

  for (let index = 1; index <= 7; index += 1) {
    loop.followup({ text: `m${index}` }, { sequence: index });
  }
  await loop.whenIdle();
  await loop.close();

  assert.deepEqual(batches, [['m1'], ['m2', 'm3', 'm4'], ['m5', 'm6', 'm7']]);
  assert.ok(batches.every((batch) => batch.length <= 3));
});

test('队列溢出返回 false，错误回调同步抛错和异步拒绝都不会造成未处理拒绝', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    const syncErrors = [];
    const syncLoop = new AgentLoop({
      key: 'private:overflow-sync',
      maxPending: 1,
      onTurn: async () => {},
      onError: (error, meta) => {
        syncErrors.push({ message: error.message, kind: meta.kind });
        throw new Error('同步上报失败');
      },
    });
    syncLoop.inject({ text: '占满队列' }, { sequence: 1 });
    assert.equal(syncLoop.followup({ text: '溢出' }, { sequence: 2 }), false);
    await syncLoop.whenIdle();
    await flush();
    assert.equal(syncErrors.length, 1);
    assert.match(syncErrors[0].message, /队列已满/);
    assert.equal(syncErrors[0].kind, 'queue-overflow');
    await syncLoop.close();

    const asyncErrors = [];
    const asyncLoop = new AgentLoop({
      key: 'private:overflow-async',
      maxPending: 1,
      onTurn: async () => {},
      onError: async (_error, meta) => {
        asyncErrors.push(meta.kind);
        throw new Error('异步上报失败');
      },
    });
    asyncLoop.inject({ text: '占满队列' }, { sequence: 1 });
    assert.equal(asyncLoop.followup({ text: '溢出' }, { sequence: 2 }), false);
    await asyncLoop.whenIdle();
    await flush();
    assert.deepEqual(asyncErrors, ['queue-overflow']);
    await asyncLoop.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(unhandled.length, 0, 'onError 自身失败不能变成未处理拒绝');
});

test('轮次失败时错误回调同步/异步失败也不会停掉驱动或产生未处理拒绝', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  try {
    const syncLoop = new AgentLoop({
      key: 'private:onerror-sync',
      onTurn: async () => { throw new Error('模型挂了'); },
      onError: () => { throw new Error('同步上报失败'); },
    });
    syncLoop.followup({ text: 'x' }, { sequence: 1 });
    await syncLoop.whenIdle();
    assert.equal(syncLoop.failedBatches().length, 1);
    await syncLoop.close();

    const asyncLoop = new AgentLoop({
      key: 'private:onerror-async',
      onTurn: async () => { throw new Error('模型挂了'); },
      onError: async () => { throw new Error('异步上报失败'); },
    });
    asyncLoop.followup({ text: 'x' }, { sequence: 1 });
    await asyncLoop.whenIdle();
    await flush();
    assert.equal(asyncLoop.failedBatches().length, 1);
    await asyncLoop.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(unhandled.length, 0);
});

test('构造契约：onTurn 必填，非法选项回退默认值，默认导出与命名导出一致', async () => {
  assert.equal(AgentLoop, NamedAgentLoop);
  assert.throws(() => new AgentLoop(), TypeError);
  assert.throws(() => new AgentLoop({ onTurn: 'not-a-function' }), TypeError);

  const loop = new AgentLoop({
    onTurn: async () => { throw new Error('默认 onError'); },
    key: null,
    maxPending: 0,
    maxFailed: 0,
    maxAttempts: 0,
    coalesceTurns: 'yes',
    maxTurnBatchItems: 0,
    onError: 'not-a-function',
  });

  assert.equal(loop.key, '');
  assert.equal(loop.maxPending, 64);
  assert.equal(loop.maxAttempts, 1);
  assert.equal(loop.coalesceTurns, false);
  assert.equal(loop.maxTurnBatchItems, 12);
  assert.equal(loop.inbox.maxPending, 64);
  assert.equal(loop.inbox.maxFailed, 64);
  assert.equal(loop.running, false);
  assert.equal(loop.closed, false);
  assert.equal(loop.turn, 0);
  assert.equal(loop.abortController, null);

  await loop.whenIdle();
  loop.followup({ text: 'x' }, { sequence: 1 });
  await loop.whenIdle();
  assert.equal(loop.failedBatches().length, 1, '默认 onError 是安全的空实现');
  await loop.close();
});

test('防御分支：收件箱冻结返回 null 时驱动不空转，遗留 turn 事件会被重新唤醒', async () => {
  const handled = [];
  const loop = new AgentLoop({
    key: 'private:null-batch',
    onTurn: async (inputs, ctx) => {
      handled.push([ctx.turn, inputs.map((input) => input.text)]);
    },
  });

  // 正常收件箱不会在存在 turn 事件时冻出 null；这里只注入一次防御路径，
  // 验证驱动不会空转，且 finally 里的重新唤醒能接住遗留的 turn 事件。
  const realFreeze = loop.inbox.freezeBatch.bind(loop.inbox);
  let calls = 0;
  loop.inbox.freezeBatch = (options) => {
    calls += 1;
    if (calls === 1) return null;
    return realFreeze(options);
  };

  loop.followup({ text: 'x' }, { sequence: 1 });
  await loop.whenIdle();
  await loop.close();

  assert.ok(calls >= 2, '冻结为空后 finally 会重新唤醒驱动');
  assert.deepEqual(handled, [[1, ['x']]]);
});
