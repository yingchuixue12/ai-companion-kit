/**
 * 私聊失败批次重放 · issue #28（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证 index.js 的私聊装配与 private-turn-replay.js：
 *
 *   ConversationWindow → handleTurn → 生成失败留档 → 宿主显式 replay
 *
 * 边界：不联网、不起模型、不碰真实 data/。brain / human / bot / memory / waker
 * 全部是内存替身；窗口用显式 flush 推进，不依赖墙钟。
 *
 * 覆盖点：
 *   1. 普通私聊生成拒绝：onError 收到原异常与原批次，failedPrivateTurns 只给元数据；
 *   2. 同一 batch 并发 replay：第二个请求在进 FIFO 前就被拒绝；
 *   3. replay 与同一会话的普通批次共用 window.runSerial 的 FIFO；
 *   4. replay 再次生成失败：同 batchId 保留，attempts 递增，且不经过 onError；
 *   5. replay 生成成功后记录消失，再次 replay 为 not-found；
 *   6. 生成成功但后续发送失败：记录已移除，不再重放；
 *   7. 生成成功但后续记忆提交失败：记录已移除，不再重放；
 *   8. 容量淘汰最老的空闲批次，并保护 inFlight 的批次；
 *   9. 容量已满且全部在途时，新失败不淘汰在途批次；
 *  10. 错 key / 未知 batchId 都以 not-found 拒绝，且不误删记录；
 *  11. 窗口 close 后 replay 以 window-closed 拒绝，记录保留且 inFlight 已清除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPrivateTurnWindow, pushPrivateMessage } from '../src/index.js';

/** 可控等待：用 deferred 表达“某个异步阶段已经开始/可以放行”。 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** 让出若干轮事件循环，确认某个队列确实没有继续往下跑。 */
async function yieldTurns(n = 4) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/** 造一条合成 OneBot 私聊消息（字段形状与 transport-onebot.js 的 #handle 产出一致）。 */
function privateMsg({
  key = 'private:10001',
  text = '在吗',
  messageId = 'msg-1',
  name = '小满',
} = {}) {
  const userId = key.startsWith('private:') ? key.slice('private:'.length) : '10001';
  return {
    key,
    isGroup: false,
    groupId: '',
    userId,
    name,
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId: String(messageId),
    time: 1_700_000_000_000,
  };
}

/**
 * 一组内存替身：brain / human / bot / memory / waker 都只记录，不联网、不落盘。
 * reply(input, nth) 里的 nth 是本窗口第几次生成调用，方便按顺序安排失败/成功。
 */
function makeHarness({ reply, say, dryRun = false, maxFailedPrivateTurns } = {}) {
  const replies = [];
  const sent = [];
  const writes = [];
  const errors = [];

  const brain = {
    async reply(input) {
      replies.push({ ...input });
      if (reply) return reply(input, replies.length);
      return { text: '默认回复' };
    },
  };

  const human = {
    async say(text, io) {
      if (say) return say(text, io, { sent, writes });
      const parts = [String(text)];
      for (const part of parts) await io.send(part);
      return { sent: parts.length, parts };
    },
  };

  const bot = {
    async send(key, text) { sent.push({ key, text }); return { ok: true }; },
    async setTyping() { return { ok: true }; },
  };

  const memory = {
    touch(userId, meta) { writes.push({ kind: 'touch', userId, ...meta }); },
    remember() {},
    logTurn(record) { writes.push({ kind: 'logTurn', record }); },
  };

  const waker = { wake(key) { writes.push({ kind: 'wake', key }); } };

  const window = createPrivateTurnWindow({
    deps: { bot, brain, human, memory, waker },
    cfg: { dryRun, wake: { privateWindowMs: 60_000 } },
    windowMs: 60_000,
    onError: (error, context) => { errors.push({ error, context }); },
    maxFailedPrivateTurns,
  });

  return { window, deps: { bot, brain, human, memory, waker }, replies, sent, writes, errors };
}

// ── 1. 普通私聊生成拒绝 ──────────────────────────────────────

test('普通私聊生成拒绝：onError 原样，保留原批次，failedPrivateTurns 只给元数据', async () => {
  const failure = new Error('模型返回 500：绝密异常正文');
  const h = makeHarness({ reply: () => { throw failure; } });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '绝密用户正文', messageId: 'm-1' }));
    await h.window.flush(key);

    assert.equal(h.replies.length, 1, '只生成一次，不自动重试');
    assert.equal(h.errors.length, 1, '生成失败交给窗口 onError 一次');
    assert.equal(h.errors[0].error, failure, 'onError 收到同一个异常对象');
    assert.equal(h.errors[0].context.key, key);
    assert.deepEqual(h.errors[0].context.items.map((item) => item.text), ['绝密用户正文']);

    const meta = h.window.failedPrivateTurns(key);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].batchId, h.errors[0].context.batch.batchId, '保留的是原窗口 batchId');
    assert.equal(meta[0].key, key);
    assert.equal(meta[0].attempts, 1);
    assert.match(meta[0].failedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(meta[0]).sort(), ['attempts', 'batchId', 'failedAt', 'key']);

    // 只给元数据：正文、原批次、异常都不从 failedPrivateTurns 露出。
    assert.equal(meta[0].items, undefined);
    assert.equal(meta[0].batch, undefined);
    assert.equal(meta[0].error, undefined);
    assert.equal(JSON.stringify(meta).includes('绝密用户正文'), false);
    assert.equal(JSON.stringify(meta).includes('绝密异常正文'), false);

    // key 过滤与不传 key 两个入口都能用。
    assert.deepEqual(h.window.failedPrivateTurns('private:other'), []);
    assert.equal(h.window.failedPrivateTurns().length, 1);
  } finally {
    await h.window.close();
  }
});

// ── 2. 同批并发 ──────────────────────────────────────────────

test('同一 batch 并发 replay：第二个请求在进 FIFO 前被拒绝', async () => {
  const gate = deferred();
  const started = deferred();
  let replayCalls = 0;
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      replayCalls += 1;
      started.resolve();
      await gate.promise;
      return { text: '重放成功' };
    },
  });
  const key = 'private:10001';
  let replay;

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    replay = h.window.replayPrivateTurn(key, batchId);
    await started.promise;

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'private-batch-in-flight',
    );
    assert.equal(replayCalls, 1, '并发请求没有多排一次生成');

    gate.resolve();
    await replay;
    assert.deepEqual(h.window.failedPrivateTurns(key), [], '成功后记录消失');
  } finally {
    gate.resolve();
    await replay?.catch(() => {});
    await h.window.close();
  }
});

// ── 3. replay 与普通窗口串行 ─────────────────────────────────

test('replay 与同一会话的普通批次共用 FIFO：普通批次等重放结束才生成', async () => {
  const gate = deferred();
  const replayStarted = deferred();
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      if (nth === 2) {
        replayStarted.resolve();
        await gate.promise;
        return { text: '重放回复' };
      }
      return { text: '普通回复' };
    },
  });
  const key = 'private:10001';
  let replay;
  let normalFlush;

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原消息', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    replay = h.window.replayPrivateTurn(key, batchId);
    await replayStarted.promise;

    await pushPrivateMessage(h.window, privateMsg({ key, text: '新消息', messageId: 'm-2' }));
    normalFlush = h.window.flush(key);
    await yieldTurns();
    assert.equal(h.replies.length, 2, '重放未完成前，普通批次不得开始生成');

    gate.resolve();
    await Promise.all([replay, normalFlush]);

    assert.equal(h.replies.length, 3);
    assert.equal(h.replies[1].text, h.replies[0].text, '重放使用原批次正文');
    assert.match(h.replies[2].text, /新消息/);
    assert.equal(h.replies[2].text.includes('原消息'), false, '新批次不重复原批次');
    assert.deepEqual(h.sent.map((item) => item.text), ['重放回复', '普通回复']);
    assert.deepEqual(h.window.failedPrivateTurns(key), []);
  } finally {
    gate.resolve();
    await replay?.catch(() => {});
    await normalFlush?.catch(() => {});
    await h.window.close();
  }
});

// ── 4. 重放再次生成失败 ──────────────────────────────────────

test('replay 再次生成失败：同 batchId 保留，attempts 递增，不经过 onError', async () => {
  const firstFailure = new Error('首次生成失败');
  const secondFailure = new Error('重放再次失败');
  let calls = 0;
  const h = makeHarness({
    reply: () => {
      calls += 1;
      throw calls === 1 ? firstFailure : secondFailure;
    },
  });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const before = h.window.failedPrivateTurns(key);
    assert.equal(before.length, 1);
    const batchId = before[0].batchId;

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error === secondFailure,
    );

    let after = h.window.failedPrivateTurns(key);
    assert.equal(after.length, 1, '再次失败仍保留同一批');
    assert.equal(after[0].batchId, batchId, 'batchId 不换');
    assert.equal(after[0].attempts, 2);
    assert.equal(h.errors.length, 1, 'replay 失败不触发窗口 onError');

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error === secondFailure,
    );
    after = h.window.failedPrivateTurns(key);
    assert.equal(after[0].batchId, batchId);
    assert.equal(after[0].attempts, 3);
  } finally {
    await h.window.close();
  }
});

// ── 5. 成功后消失 ────────────────────────────────────────────

test('replay 生成成功后记录消失，再次 replay 为 not-found', async () => {
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      return { text: '重放成功' };
    },
  });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    await h.window.replayPrivateTurn(key, batchId);
    assert.deepEqual(h.window.failedPrivateTurns(key), []);
    assert.deepEqual(h.sent.map((item) => item.text), ['重放成功']);
    assert.deepEqual(h.writes.map((item) => item.kind), ['wake', 'touch']);

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'private-batch-not-found',
    );
  } finally {
    await h.window.close();
  }
});

// ── 6. 发送失败不重放 ────────────────────────────────────────

test('replay 生成成功但发送失败：记录已移除，不再重放', async () => {
  const sendFailure = new Error('发送未确认');
  sendFailure.code = 'delivery-unconfirmed';
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      return { text: '生成成功' };
    },
    say: async () => { throw sendFailure; },
  });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error === sendFailure,
    );
    assert.deepEqual(h.window.failedPrivateTurns(key), [], '发送失败不回填重放记录');
    assert.equal(h.sent.length, 0);

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'private-batch-not-found',
    );
  } finally {
    await h.window.close();
  }
});

// ── 7. 记忆提交失败不重放 ────────────────────────────────────

test('replay 生成成功但记忆提交失败：记录已移除，不再重放', async () => {
  const commitFailure = new Error('写记忆失败');
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      return {
        text: '生成成功',
        commit: () => { throw commitFailure; },
      };
    },
  });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error === commitFailure,
    );
    assert.deepEqual(h.window.failedPrivateTurns(key), [], '记忆提交失败不回填重放记录');
    assert.deepEqual(h.sent.map((item) => item.text), ['生成成功']);

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'private-batch-not-found',
    );
  } finally {
    await h.window.close();
  }
});

// ── 8. 容量淘汰与在途保护 ────────────────────────────────────

test('容量淘汰最老的空闲批次，并保护 inFlight 的批次', async () => {
  const gate = deferred();
  const started = deferred();
  const counts = new Map();
  const keyA = 'private:a';
  const keyB = 'private:b';
  const keyC = 'private:c';

  const h = makeHarness({
    maxFailedPrivateTurns: 2,
    reply: async (input) => {
      const nth = (counts.get(input.key) || 0) + 1;
      counts.set(input.key, nth);
      if (input.key === keyA) {
        if (nth === 1) throw new Error('A 首次生成失败');
        started.resolve();
        await gate.promise;
        return { text: 'A 重放成功' };
      }
      throw new Error(input.key + ' 首次生成失败');
    },
  });
  let replayA;

  try {
    await pushPrivateMessage(h.window, privateMsg({ key: keyA, text: 'A 原批次', messageId: 'a-1' }));
    await h.window.flush(keyA);
    const batchA = h.window.failedPrivateTurns(keyA)[0].batchId;

    replayA = h.window.replayPrivateTurn(keyA, batchA);
    await started.promise;

    await pushPrivateMessage(h.window, privateMsg({ key: keyB, text: 'B 原批次', messageId: 'b-1' }));
    await h.window.flush(keyB);
    await pushPrivateMessage(h.window, privateMsg({ key: keyC, text: 'C 原批次', messageId: 'c-1' }));
    await h.window.flush(keyC);

    assert.equal(h.window.failedPrivateTurns(keyA).length, 1, 'inFlight 的 A 不被淘汰');
    assert.equal(h.window.failedPrivateTurns(keyB).length, 0, '最老的空闲 B 被淘汰');
    assert.equal(h.window.failedPrivateTurns(keyC).length, 1, '新失败 C 进入容量');
    assert.equal(h.errors.length, 3, 'A/B/C 都实际发生了生成拒绝');

    gate.resolve();
    await replayA;
    assert.equal(h.window.failedPrivateTurns(keyA).length, 0, 'A 成功后移除');
  } finally {
    gate.resolve();
    await replayA?.catch(() => {});
    await h.window.close();
  }
});

test('容量已满且全部在途时，新失败不淘汰在途批次', async () => {
  const gate = deferred();
  const started = deferred();
  const counts = new Map();
  const keyA = 'private:a';
  const keyB = 'private:b';

  const h = makeHarness({
    maxFailedPrivateTurns: 1,
    reply: async (input) => {
      const nth = (counts.get(input.key) || 0) + 1;
      counts.set(input.key, nth);
      if (input.key === keyA) {
        if (nth === 1) throw new Error('A 首次生成失败');
        started.resolve();
        await gate.promise;
        return { text: 'A 重放成功' };
      }
      throw new Error('B 首次生成失败');
    },
  });
  let replayA;

  try {
    await pushPrivateMessage(h.window, privateMsg({ key: keyA, text: 'A 原批次', messageId: 'a-1' }));
    await h.window.flush(keyA);
    const batchA = h.window.failedPrivateTurns(keyA)[0].batchId;

    replayA = h.window.replayPrivateTurn(keyA, batchA);
    await started.promise;

    await pushPrivateMessage(h.window, privateMsg({ key: keyB, text: 'B 原批次', messageId: 'b-1' }));
    await h.window.flush(keyB);

    assert.equal(h.window.failedPrivateTurns(keyA).length, 1, '在途 A 保留');
    assert.equal(h.window.failedPrivateTurns(keyB).length, 0, '容量满且无空闲可淘汰时 B 不进入记录');
    assert.equal(h.errors.length, 2, 'A/B 都实际发生了生成拒绝');

    gate.resolve();
    await replayA;
    assert.equal(h.window.failedPrivateTurns(keyA).length, 0, 'A 成功后移除');
  } finally {
    gate.resolve();
    await replayA?.catch(() => {});
    await h.window.close();
  }
});

// ── 9. 错 key / 未知 batchId ─────────────────────────────────

test('错 key 与未知 batchId 都以 not-found 拒绝，且不误删记录', async () => {
  const h = makeHarness({
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('首次生成失败');
      return { text: '重放成功' };
    },
  });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    await assert.rejects(
      () => h.window.replayPrivateTurn('private:other', batchId),
      (error) => error.code === 'private-batch-not-found',
    );
    await assert.rejects(
      () => h.window.replayPrivateTurn(key, 'missing-batch'),
      (error) => error.code === 'private-batch-not-found',
    );
    assert.equal(h.window.failedPrivateTurns(key).length, 1, '错 key / 未知 id 都不误删记录');

    await h.window.replayPrivateTurn(key, batchId);
    assert.deepEqual(h.window.failedPrivateTurns(key), []);
  } finally {
    await h.window.close();
  }
});

// ── 10. close 后拒绝 ────────────────────────────────────────

test('窗口 close 后 replay 以 window-closed 拒绝，记录保留且 inFlight 已清除', async () => {
  const h = makeHarness({ reply: () => { throw new Error('首次生成失败'); } });
  const key = 'private:10001';

  try {
    await pushPrivateMessage(h.window, privateMsg({ key, text: '原批次', messageId: 'm-1' }));
    await h.window.flush(key);
    const batchId = h.window.failedPrivateTurns(key)[0].batchId;

    await h.window.close();

    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'window-closed',
    );
    assert.equal(h.window.failedPrivateTurns(key).length, 1, '没生成成功的批次仍保留');

    // 如果 finally 没清 inFlight，第二次会先撞上 in-flight 而不是 window-closed。
    await assert.rejects(
      () => h.window.replayPrivateTurn(key, batchId),
      (error) => error.code === 'window-closed',
    );
    assert.equal(h.window.failedPrivateTurns(key).length, 1);
  } finally {
    await h.window.close();
  }
});
