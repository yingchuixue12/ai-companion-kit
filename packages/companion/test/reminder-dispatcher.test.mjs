/**
 * reminder-dispatcher · 派发一条提醒的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只验证 reminder-dispatcher.js 的对外行为，全部用临时目录、假时钟和假
 * sender；不联网、不起模型、不碰真实 data/。
 *
 * 覆盖：
 *   - 端到端：createReminderService 创建 → 到期派发 → 重启不再重发；
 *   - claim 在第一次 await 之前就已落盘（sender 里读盘可见 processing）；
 *   - claim 写失败返回 store 原错误且绝不调用 send；
 *   - 四类回执 sent/partial/failed/unknown，陌生返回值、带空白字符串、
 *     非字符串、抛错、拒绝一律记 unknown；
 *   - 终态、待查、已触发的记录在任何时刻都不发送；
 *   - 合并落账失败后记录留在 processing，重启后不自动重发；
 *   - await 期间并发创建 / 取消不被覆盖，同实例的重叠调用串行；
 *   - 到期排序（dueAt 升序、同值按 taskId）、过期、主动取消、空库、
 *     无效时钟、坏快照、claim 冲突（被改 / 被删 / 被别人重新认领）；
 *   - 构造参数校验，以及意外异常收敛为 internal-error 后仍能继续工作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReminderDispatcher } from '../src/reminder-dispatcher.js';
import { createReminderService } from '../src/reminder-service.js';
import { createReminderStore } from '../src/reminder-store.js';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KEY = 'private:1';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-dispatcher-'));
}

async function withDir(run) {
  const dir = tempDir();
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 一条完整合法的落盘记录；over 用来单独改字段。 */
function record(over = {}) {
  return {
    taskId: 'task-1',
    conversationKey: KEY,
    text: '喝水',
    dueAt: T0,
    status: 'due',
    attempt: 0,
    firedAt: null,
    proactive: false,
    ...over,
  };
}

function seed(file, records) {
  assert.deepEqual(createReminderStore(file).save(records), { ok: true });
}

/** 直接从盘上读回记录，顺带确认快照仍可读。 */
function load(file) {
  const loaded = createReminderStore(file).load();
  assert.equal(loaded.ok, true, '快照应该仍然可读');
  return loaded.records;
}

function bytesOf(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 目录里残留的暂存文件（'.<name>.<pid>-<hex>.tmp'）。 */
function staged(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** 让出若干轮事件循环，确认排队中的调用确实还没往下跑。 */
async function yieldTurns(n = 4) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/** taskId → status 的投影，方便断言「谁的终态变成了什么」。 */
function statuses(records) {
  return Object.fromEntries(records.map((item) => [item.taskId, item.status]));
}

/** 一路派发到空库，收集被处理的 taskId 顺序。 */
async function drain(dispatcher, limit = 6) {
  const picked = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await dispatcher.dispatchNext();
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.result === null) return picked;
    picked.push(result.result.taskId);
  }
  throw new Error('drain: 没有在预期次数内收敛');
}

// ── 1. 端到端：创建 → 派发 → 重启 ─────────────────────────────

test('创建后到期派发一次，重启不再重发', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    const service = createReminderService(file, { now: () => T0, newId: () => 'task-1' });
    assert.deepEqual(service.create(KEY, '5秒后提醒我喝水'), {
      ok: true,
      taskId: 'task-1',
      dueAt: T0 + 5000,
      status: 'queued',
    });

    // 还没到点：什么都不做，也不调用 send。
    const early = [];
    const beforeDue = createReminderDispatcher(file, {
      now: () => T0 + 4999,
      send: (delivery) => { early.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await beforeDue.dispatchNext(), { ok: true, result: null });
    assert.deepEqual(early, []);

    // 到点：恰好一条，载荷字段齐全。
    const sent = [];
    const dispatcher = createReminderDispatcher(file, {
      now: () => T0 + 5000,
      send: (delivery) => { sent.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await dispatcher.dispatchNext(), {
      ok: true,
      result: { taskId: 'task-1', status: 'sent' },
    });
    assert.deepEqual(sent, [{
      taskId: 'task-1',
      conversationKey: KEY,
      text: '喝水',
      dueAt: T0 + 5000,
      lateByMs: 0,
    }]);

    // 重启：新 dispatcher 面对同一份快照，已经发过的不再重发。
    const restartedCalls = [];
    const restarted = createReminderDispatcher(file, {
      now: () => T0 + 5000,
      send: (delivery) => { restartedCalls.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await restarted.dispatchNext(), { ok: true, result: null });
    assert.deepEqual(restartedCalls, []);

    // 状态对服务层与后续读都可见。
    assert.deepEqual(service.list(KEY), {
      ok: true,
      reminders: [{ taskId: 'task-1', text: '喝水', dueAt: T0 + 5000, status: 'sent' }],
      truncated: false,
    });
  });
});

// ── 2. 回执采纳 ───────────────────────────────────────────────

test('四类回执被采纳，其余返回值与异常一律记 unknown', async (t) => {
  const cases = [
    ['sent', () => 'sent', 'sent'],
    ['partial', () => 'partial', 'partial'],
    ['failed', () => 'failed', 'failed'],
    ['unknown', () => 'unknown', 'unknown'],
    ['返回 Promise 的 sent', async () => 'sent', 'sent'],
    ['陌生字符串', () => 'ok', 'unknown'],
    ['空字符串', () => '', 'unknown'],
    ['带空白的 sent', () => ' sent ', 'unknown'],
    ['大小写不同', () => 'SENT', 'unknown'],
    ['数字', () => 1, 'unknown'],
    ['undefined', () => undefined, 'unknown'],
    ['null', () => null, 'unknown'],
    ['抛 Error', () => { throw new Error('send boom'); }, 'unknown'],
    ['抛非 Error', () => { throw 'boom'; }, 'unknown'],
    ['拒绝的 Promise', async () => { throw new Error('rejected'); }, 'unknown'],
  ];

  for (const [label, send, expected] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, [record()]);
        const dispatcher = createReminderDispatcher(file, { now: () => T0, send });
        assert.deepEqual(await dispatcher.dispatchNext(), {
          ok: true,
          result: { taskId: 'task-1', status: expected },
        });
        assert.equal(load(file)[0].status, expected);
        assert.deepEqual(staged(dir), []);
      });
    });
  }
});

// ── 3. claim 与写失败 ─────────────────────────────────────────

test('send 之前 claim 已落盘：读盘可见 processing / attempt=1 / firedAt=now', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [record()]);

    let observed = null;
    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: async () => {
        // 从盘上读，而不是看内存：确认同步 claim 确实在第一次 await 之前完成。
        observed = load(file);
        assert.match(bytesOf(file), /"status":"processing"/);
        // 另一个实例此刻只会看到 processing，因此什么也不做。
        const other = createReminderDispatcher(file, { now: () => T0, send: () => 'sent' });
        assert.deepEqual(await other.dispatchNext(), { ok: true, result: null });
        return 'sent';
      },
    });

    assert.deepEqual(await dispatcher.dispatchNext(), {
      ok: true,
      result: { taskId: 'task-1', status: 'sent' },
    });
    assert.deepEqual(observed.map((item) => [item.taskId, item.status, item.attempt, item.firedAt]), [
      ['task-1', 'processing', 1, T0],
    ]);
  });
});

test('claim 写失败返回 store 原错误，且一次都不调用 send', async (t) => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [record()]);
    const before = bytesOf(file);
    const calls = [];

    // store 用 fd 写临时文件；只拦这一种成功写入。
    const originalWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', function injected(...args) {
      if (typeof args[0] === 'number') {
        const error = new Error('injected claim failure');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite.apply(fs, args);
    });

    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: (delivery) => { calls.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'write-failed' });
    assert.deepEqual(calls, [], 'claim 没落盘就不能发送');
    assert.equal(bytesOf(file), before, 'claim 失败不能改动旧快照');
    assert.deepEqual(staged(dir), [], '自己创建的临时文件必须清理');
  });
});

// ── 4. 合并落账失败 ───────────────────────────────────────────

test('合并落账失败返回 store 错误，记录留在 processing，重启后不重发', async (t) => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [record()]);
    const calls = [];

    // 第 1 次 fd 写是 claim（放行），第 2 次是合并结果（注入失败）。
    const originalWrite = fs.writeFileSync;
    let fdWrites = 0;
    t.mock.method(fs, 'writeFileSync', function injected(...args) {
      if (typeof args[0] === 'number') {
        fdWrites += 1;
        if (fdWrites === 2) {
          const error = new Error('injected merge failure');
          error.code = 'EIO';
          throw error;
        }
      }
      return originalWrite.apply(fs, args);
    });

    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: (delivery) => { calls.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'write-failed' });
    assert.equal(calls.length, 1, '结果落账失败发生在发送之后');
    assert.equal(fdWrites, 2);

    // 磁盘上仍是 claim 过的 processing：不能因为结果没写进去就重发。
    const onDisk = load(file);
    assert.deepEqual(onDisk.map((item) => [item.status, item.attempt, item.firedAt]), [
      ['processing', 1, T0],
    ]);

    const restartedCalls = [];
    const restarted = createReminderDispatcher(file, {
      now: () => T0 + HOUR,
      send: (delivery) => { restartedCalls.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await restarted.dispatchNext(), { ok: true, result: null });
    assert.deepEqual(restartedCalls, [], '未确认的 processing 不自动重发');
  });
});

// ── 5. 不发送的状态 ───────────────────────────────────────────

test('终态、待查、已触发的记录永远不发送', async (t) => {
  const cases = [
    ['processing', 'processing', 1, T0],
    ['delivery_pending', 'delivery_pending', 1, T0],
    ['unknown', 'unknown', 1, T0],
    ['pending', 'pending', 1, T0],
    ['sent', 'sent', 1, T0],
    ['partial', 'partial', 1, T0],
    ['failed', 'failed', 1, T0],
    ['canceled', 'canceled', 1, T0],
    ['expired', 'expired', 1, T0],
    ['due 但 attempt>0', 'due', 1, T0],
    ['due 但 firedAt 非空', 'due', 0, T0],
  ];

  for (const [label, status, attempt, firedAt] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, [record({ status, attempt, firedAt })]);
        const before = bytesOf(file);
        const calls = [];
        // 时钟远在未来：如果可以重排，它一定会被选中。
        const dispatcher = createReminderDispatcher(file, {
          now: () => T0 + 3 * DAY,
          send: (delivery) => { calls.push(delivery); return 'sent'; },
        });
        assert.deepEqual(await dispatcher.dispatchNext(), { ok: true, result: null });
        assert.deepEqual(calls, []);
        assert.equal(bytesOf(file), before, '不发送也不该写盘');
      });
    });
  }
});

// ── 6. 并发与串行 ─────────────────────────────────────────────

test('await 期间并发创建与取消不会被覆盖', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    const service = createReminderService(file, { now: () => T0, newId: () => 'task-3' });
    seed(file, [
      record({ taskId: 'task-1', dueAt: T0 }),
      record({ taskId: 'task-2', dueAt: T0 + 5000, status: 'queued' }),
    ]);

    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: async () => {
        // 发送途中：别的调用方新建一条、取消另一条。
        assert.equal(service.create(KEY, '10秒后提醒我收衣服').ok, true);
        assert.deepEqual(service.cancel(KEY, 'task-2'), {
          ok: true,
          taskId: 'task-2',
          status: 'canceled',
        });
        return 'sent';
      },
    });

    assert.deepEqual(await dispatcher.dispatchNext(), {
      ok: true,
      result: { taskId: 'task-1', status: 'sent' },
    });

    const after = load(file);
    assert.deepEqual(statuses(after), { 'task-1': 'sent', 'task-2': 'canceled', 'task-3': 'queued' });
    assert.deepEqual(after.map((item) => item.taskId), ['task-1', 'task-2', 'task-3'], '记录顺序与内容都不重建');
  });
});

test('同一实例的重叠调用排队执行，绝不并发派发', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [
      record({ taskId: 'a', dueAt: T0 }),
      record({ taskId: 'b', dueAt: T0 }),
      record({ taskId: 'c', dueAt: T0 }),
    ]);

    const gate = deferred();
    const order = [];
    let active = 0;
    let peak = 0;
    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: async (delivery) => {
        order.push(delivery.taskId);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return 'sent';
      },
    });

    const runs = [dispatcher.dispatchNext(), dispatcher.dispatchNext(), dispatcher.dispatchNext()];
    await yieldTurns();
    assert.deepEqual(order, ['a'], '前一条没结束，后一条不能开始');
    assert.equal(peak, 1);

    gate.resolve();
    const results = await Promise.all(runs);
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(peak, 1, '永远只有一条在发');
    assert.deepEqual(results.map((item) => item.result), [
      { taskId: 'a', status: 'sent' },
      { taskId: 'b', status: 'sent' },
      { taskId: 'c', status: 'sent' },
    ]);
    assert.deepEqual(statuses(load(file)), { a: 'sent', b: 'sent', c: 'sent' });
  });
});

// ── 7. 选哪一条 ───────────────────────────────────────────────

test('到期记录按 dueAt 升序、同值按 taskId 稳定处理', async (t) => {
  const cases = [
    ['乱序插入按 dueAt 升序', [
      record({ taskId: 'z', dueAt: 3000 }),
      record({ taskId: 'a', dueAt: 1000 }),
      record({ taskId: 'm', dueAt: 2000 }),
    ], ['a', 'm', 'z']],
    ['同 dueAt 按 taskId 码元顺序', [
      record({ taskId: 'b', dueAt: 1000 }),
      record({ taskId: 'a', dueAt: 1000 }),
      record({ taskId: 'c', dueAt: 1000 }),
    ], ['a', 'b', 'c']],
    ['未到期的 queued 不参与', [
      record({ taskId: 'a', dueAt: 1000 }),
      record({ taskId: 'b', dueAt: 9999, status: 'queued' }),
    ], ['a']],
    ['全部未到期时什么都不做', [
      record({ taskId: 'a', dueAt: 12_000, status: 'queued' }),
      record({ taskId: 'b', dueAt: 13_000, status: 'queued' }),
    ], []],
  ];

  for (const [label, records, expected] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, records);
        const calls = [];
        const dispatcher = createReminderDispatcher(file, {
          now: () => 9000,
          send: (delivery) => { calls.push(delivery); return 'sent'; },
        });
        assert.deepEqual(await drain(dispatcher, records.length + 1), expected);
        assert.equal(calls.length, expected.length);
      });
    });
  }
});

// ── 8. 终态落盘 ───────────────────────────────────────────────

test('过期与主动取消落终态、不发送；正常到期才发送', async (t) => {
  const cases = [
    ['逾期超过 24h 落 expired', record({ status: 'queued' }), T0 + 25 * HOUR, 'expired'],
    ['未来超过 7 天落 expired', record({ dueAt: T0 + 8 * DAY, status: 'queued' }), T0, 'expired'],
    ['主动回访逾期落 canceled', record({ status: 'queued', proactive: true }), T0 + HOUR, 'canceled'],
    ['窗口内逾期仍然发送', record({ status: 'queued' }), T0 + HOUR, 'sent'],
  ];

  for (const [label, fixture, now, expected] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, [fixture]);
        const calls = [];
        const dispatcher = createReminderDispatcher(file, {
          now: () => now,
          send: (delivery) => { calls.push(delivery); return 'sent'; },
        });
        assert.deepEqual(await dispatcher.dispatchNext(), {
          ok: true,
          result: { taskId: 'task-1', status: expected },
        });

        const onDisk = load(file);
        assert.equal(onDisk[0].status, expected);
        if (expected === 'sent') {
          assert.equal(calls.length, 1);
          assert.equal(calls[0].lateByMs, HOUR);
        } else {
          assert.deepEqual(calls, [], '终态不需要发送');
          assert.equal(onDisk[0].attempt, 0, '落终态不该伪造尝试次数');
          // 下一次 tick 也不再选中它。
          assert.deepEqual(await dispatcher.dispatchNext(), { ok: true, result: null });
        }
        assert.deepEqual(staged(dir), []);
      });
    });
  }
});

// ── 9. 空库、坏快照、无效时钟 ─────────────────────────────────

test('没有快照文件时返回空结果', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'missing.json');
    const calls = [];
    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: (delivery) => { calls.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await dispatcher.dispatchNext(), { ok: true, result: null });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(file), false, '空库不该被凭空写出来');
  });
});

test('坏快照原样返回 invalid-snapshot，不写盘也不发送', async (t) => {
  const bodies = [
    ['坏 JSON', '{ not json'],
    ['版本不认识', JSON.stringify({ version: 2, records: [] })],
    ['记录夹带未定义字段', JSON.stringify({
      version: 1,
      records: [{ ...record(), extra: true }],
    })],
  ];

  for (const [label, body] of bodies) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        fs.writeFileSync(file, body, 'utf8');
        const calls = [];
        const dispatcher = createReminderDispatcher(file, {
          now: () => T0,
          send: (delivery) => { calls.push(delivery); return 'sent'; },
        });
        assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'invalid-snapshot' });
        assert.deepEqual(calls, []);
        assert.equal(bytesOf(file), body, '坏文件是诊断证据，不能被抹掉');
        assert.deepEqual(staged(dir), []);
      });
    });
  }
});

test('无效时钟返回 invalid-clock，不读不写也不发送', async (t) => {
  const cases = [
    ['负数', () => -1],
    ['小数', () => 1.5],
    ['字符串', () => '1700000000000'],
    ['NaN', () => NaN],
    ['Infinity', () => Infinity],
    ['抛错', () => { throw new Error('clock boom'); }],
  ];

  for (const [label, now] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, [record()]);
        const before = bytesOf(file);
        const calls = [];
        const dispatcher = createReminderDispatcher(file, {
          now,
          send: (delivery) => { calls.push(delivery); return 'sent'; },
        });
        assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'invalid-clock' });
        assert.deepEqual(calls, []);
        assert.equal(bytesOf(file), before);
      });
    });
  }
});

// ── 10. claim 冲突 ────────────────────────────────────────────

test('await 之后记录被改、被删或已被别人认领时返回 claim-conflict，不覆盖', async (t) => {
  const cases = [
    [
      '被改成别的状态',
      (file) => seed(file, [record({ status: 'canceled', attempt: 1, firedAt: T0 - 1 })]),
      (records) => statuses(records),
      { 'task-1': 'canceled' },
    ],
    [
      '被别人重新认领（firedAt 不同）',
      (file) => seed(file, [record({ status: 'processing', attempt: 1, firedAt: T0 + 1 })]),
      (records) => records.map((item) => item.firedAt),
      [T0 + 1],
    ],
    [
      '会话键被改',
      (file) => seed(file, [record({
        status: 'processing',
        attempt: 1,
        firedAt: T0,
        conversationKey: 'private:2',
      })]),
      (records) => records.map((item) => item.conversationKey),
      ['private:2'],
    ],
    [
      '记录消失',
      (file) => seed(file, []),
      (records) => records.length,
      0,
    ],
  ];

  for (const [label, rewrite, probe, expected] of cases) {
    await t.test(label, async () => {
      await withDir(async (dir) => {
        const file = path.join(dir, 'reminders.json');
        seed(file, [record()]);
        const dispatcher = createReminderDispatcher(file, {
          now: () => T0,
          send: async () => {
            rewrite(file);
            return 'sent';
          },
        });

        assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'claim-conflict' });
        // 对方的版本必须原样留着：不合并、不回滚、不重写。
        assert.deepEqual(probe(load(file)), expected);
        assert.deepEqual(staged(dir), []);
      });
    });
  }
});

// ── 11. 构造校验与意外异常 ────────────────────────────────────

test('send / now 不是函数时构造直接抛 TypeError', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    const build = (options) => () => createReminderDispatcher(file, options);
    assert.throws(build(), { name: 'TypeError' });
    assert.throws(build({ send: 'sent' }), { name: 'TypeError' });
    assert.throws(build({ send: () => 'sent', now: 'now' }), { name: 'TypeError' });
    assert.throws(build({}), { name: 'TypeError' });
    // 合法参数不抛。
    assert.doesNotThrow(build({ send: () => 'sent' }));
  });
});

test('意外异常收敛为 internal-error，之后仍能继续派发', async (t) => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [record()]);

    // 让 store 的 stat 结果不是可用的 fs.Stats：读取阶段抛出非预期异常。
    t.mock.method(fs, 'statSync', () => ({
      isFile() { throw new Error('unexpected stat'); },
    }));

    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: () => 'sent',
    });
    assert.deepEqual(await dispatcher.dispatchNext(), { ok: false, error: 'internal-error' });

    // 恢复后同一个实例必须能继续工作（排队尾不会卡死）。
    t.mock.restoreAll();
    assert.deepEqual(await dispatcher.dispatchNext(), {
      ok: true,
      result: { taskId: 'task-1', status: 'sent' },
    });
    assert.equal(load(file)[0].status, 'sent');
  });
});

// ── 12. 一条调用只处理一条 ────────────────────────────────────

test('每次调用最多推进一条提醒', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'reminders.json');
    seed(file, [
      record({ taskId: 'a', dueAt: T0 }),
      record({ taskId: 'b', dueAt: T0 }),
      record({ taskId: 'c', dueAt: T0 }),
    ]);
    const calls = [];
    const dispatcher = createReminderDispatcher(file, {
      now: () => T0,
      send: (delivery) => { calls.push(delivery.taskId); return 'sent'; },
    });

    assert.deepEqual(await dispatcher.dispatchNext(), { ok: true, result: { taskId: 'a', status: 'sent' } });
    assert.deepEqual(calls, ['a']);
    assert.deepEqual(statuses(load(file)), { a: 'sent', b: 'due', c: 'due' });
  });
});
