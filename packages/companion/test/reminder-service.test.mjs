/**
 * reminder-service · 会话内提醒服务的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只用临时目录和 node:test 的同步 mock，不联网、不读写生产 data/。
 *
 * 覆盖：
 *   - create 落盘 queued，跨实例 list / cancel 可见，重复取消幂等；
 *   - conversationKey 按原字符串精确隔离；跨会话取消等同于不存在；
 *   - 不可解析原文、非法会话键 / taskId、非法时钟 / 溢出、非法 newId；
 *   - 128 字符键 / id、now=0、1ms 下界、dueAt 恰好 MAX_SAFE_INTEGER；
 *   - dueAt 升序、taskId 破同分、最多 20 条与 truncated 边界；
 *   - 终态 / 待查状态、attempt>0、firedAt 非空均不可取消；
 *   - 重复 taskId 交给 store 拒绝；
 *   - 坏快照下三个操作都原样返回 invalid-snapshot，文件一字不动；
 *   - 写失败后 create / cancel 都返回 write-failed，磁盘记录保持原样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReminderService } from '../src/reminder-service.js';
import { createReminderStore } from '../src/reminder-store.js';

const T0 = 1_700_000_000_000;
const KEY = 'private:1';
const OTHER = 'private:2';
const VALID_RAW = '5秒后提醒我喝水';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-service-'));
}

function withDir(run) {
  const dir = tempDir();
  try {
    return run(dir);
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
    status: 'queued',
    attempt: 0,
    firedAt: null,
    proactive: false,
    ...over,
  };
}

/** list 对外公开的提醒形状。 */
function publicReminder(taskId, dueAt, text = taskId, status = 'queued') {
  return { taskId, text, dueAt, status };
}

/** 用 store 直接铺一份快照，作为 list / cancel 的测试夹具。 */
function seed(file, records) {
  assert.deepEqual(createReminderStore(file).save(records), { ok: true });
}

/** 抓住原函数：注入写失败之后，测试自己仍要能核对文件内容。 */
const readText = fs.readFileSync;

function bytes(file) {
  return readText(file, 'utf8');
}

/** 目录里残留的暂存文件（'.<name>.<pid>-<hex>.tmp'）。 */
function stagedFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

function idSequence(prefix = 'task') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

// ── 1. 创建 / 跨实例 / 重复取消 ─────────────────────────────────

test('create 落盘 queued；跨实例 list 与 cancel 可见，重复取消幂等不重写', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const first = createReminderService(file, { now: () => T0, newId: () => 'task-a' });

    assert.deepEqual(first.create(KEY, '30秒后提醒我  喝水。'), {
      ok: true,
      taskId: 'task-a',
      dueAt: T0 + 30_000,
      status: 'queued',
    });
    assert.deepEqual(createReminderStore(file).load().records, [
      record({ taskId: 'task-a', text: '喝水', dueAt: T0 + 30_000 }),
    ]);

    // 新实例必须从盘上读，而不是继承上一个实例的内存状态。
    const second = createReminderService(file, { now: () => T0 + 1, newId: () => 'unused' });
    const queued = {
      ok: true,
      reminders: [publicReminder('task-a', T0 + 30_000, '喝水')],
      truncated: false,
    };
    assert.deepEqual(second.list(KEY), queued);

    assert.deepEqual(second.cancel(KEY, 'task-a'), {
      ok: true,
      taskId: 'task-a',
      status: 'canceled',
    });
    assert.deepEqual(first.list(KEY), {
      ok: true,
      reminders: [publicReminder('task-a', T0 + 30_000, '喝水', 'canceled')],
      truncated: false,
    });

    const before = bytes(file);
    assert.deepEqual(first.cancel(KEY, 'task-a'), {
      ok: true,
      taskId: 'task-a',
      status: 'canceled',
    });
    assert.equal(bytes(file), before, '已经取消过的提醒不能再次写盘');
    assert.deepEqual(createReminderStore(file).load().records, [
      record({ taskId: 'task-a', text: '喝水', dueAt: T0 + 30_000, status: 'canceled' }),
    ]);
  });
});

// ── 2. 精确会话隔离 / 不存在 ─────────────────────────────────────

test('conversationKey 按原字符串隔离；跨会话取消视同 not-found', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const padded = ' private:1 ';
    const service = createReminderService(file, { now: () => T0, newId: idSequence() });

    assert.equal(service.create(padded, '5秒后提醒我带伞').ok, true);
    assert.equal(service.create(KEY, '10秒后提醒我收衣服').ok, true);
    assert.equal(service.create(OTHER, '15秒后提醒我关灯').ok, true);

    assert.deepEqual(service.list(padded), {
      ok: true,
      reminders: [publicReminder('task-1', T0 + 5000, '带伞')],
      truncated: false,
    });
    assert.deepEqual(service.list(KEY), {
      ok: true,
      reminders: [publicReminder('task-2', T0 + 10_000, '收衣服')],
      truncated: false,
    });
    assert.deepEqual(service.list(OTHER), {
      ok: true,
      reminders: [publicReminder('task-3', T0 + 15_000, '关灯')],
      truncated: false,
    });

    // task-1 属于 padded，不属于 KEY / OTHER；跨会话必须当作不存在。
    assert.deepEqual(service.cancel(KEY, 'task-1'), { ok: false, error: 'not-found' });
    assert.deepEqual(service.cancel(OTHER, 'task-1'), { ok: false, error: 'not-found' });
    assert.deepEqual(service.list(padded).reminders[0].status, 'queued');
  });
});

// ── 3. 非法输入 / 失败路径 ───────────────────────────────────────

test('create 拒绝不可解析原文、非法时钟与非法 newId，且不落盘', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');

    const invalidRaws = [
      ['普通叙述', '我30秒后去洗衣服'],
      ['空串', ''],
      ['缺正文', '5秒后提醒我'],
      ['正文超 500', `5秒后提醒我${'长'.repeat(501)}`],
      ['0ms', '0秒后提醒我喝水'],
      ['超过 7 天', '604800.1秒后提醒我喝水'],
      ['多行', '5秒后提醒我喝水\n第二行'],
      ['非字符串', 5],
      ['null', null],
      ['对象', {}],
      ['数组', ['5秒后提醒我喝水']],
    ];
    const rejectingRaws = createReminderService(file, { now: () => T0, newId: () => 'unused' });
    for (const [label, raw] of invalidRaws) {
      assert.deepEqual(rejectingRaws.create(KEY, raw), { ok: false, error: 'invalid-reminder' }, label);
    }

    const invalidClocks = [
      ['抛出', () => { throw new Error('clock failed'); }, VALID_RAW],
      ['负数', () => -1, VALID_RAW],
      ['小数', () => 1.5, VALID_RAW],
      ['NaN', () => NaN, VALID_RAW],
      ['Infinity', () => Infinity, VALID_RAW],
      ['不安全整数', () => Number.MAX_SAFE_INTEGER + 1, VALID_RAW],
      ['非数字', () => '0', VALID_RAW],
      ['相加溢出', () => Number.MAX_SAFE_INTEGER - 1, '604800秒后提醒我喝水'],
    ];
    for (const [label, now, raw] of invalidClocks) {
      const service = createReminderService(file, { now, newId: () => 'clock-task' });
      assert.deepEqual(service.create(KEY, raw), { ok: false, error: 'invalid-clock' }, label);
    }

    const invalidIds = [
      ['抛出', () => { throw new Error('id failed'); }],
      ['空串', () => ''],
      ['纯空白', () => ' \t\n '],
      ['非字符串', () => 123],
      ['129 字符', () => 'i'.repeat(129)],
    ];
    for (const [label, newId] of invalidIds) {
      const service = createReminderService(file, { now: () => T0, newId });
      assert.deepEqual(service.create(KEY, VALID_RAW), { ok: false, error: 'invalid-task-id' }, label);
    }

    assert.equal(fs.existsSync(file), false, '所有拒绝路径都不能顺手建出文件');
  });
});

test('三个公开操作统一拒绝非法会话键与非法 taskId，且不读盘不落盘', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const service = createReminderService(file, { now: () => T0, newId: () => 'unused' });

    const invalidKeys = [
      ['空串', ''],
      ['纯空白', ' \t\n '],
      ['129 字符', 'k'.repeat(129)],
      ['null', null],
      ['undefined', undefined],
      ['数字', 1],
      ['对象', {}],
      ['String 对象', new String(KEY)],
    ];
    for (const [label, key] of invalidKeys) {
      assert.deepEqual(service.create(key, VALID_RAW), { ok: false, error: 'invalid-conversation-key' }, label);
      assert.deepEqual(service.list(key), { ok: false, error: 'invalid-conversation-key' }, label);
      assert.deepEqual(service.cancel(key, 'task-1'), { ok: false, error: 'invalid-conversation-key' }, label);
    }

    const invalidTaskIds = [
      ['空串', ''],
      ['纯空白', '   '],
      ['129 字符', 't'.repeat(129)],
      ['null', null],
      ['undefined', undefined],
      ['数字', 1],
      ['对象', {}],
      ['String 对象', new String('task-1')],
    ];
    for (const [label, taskId] of invalidTaskIds) {
      assert.deepEqual(service.cancel(KEY, taskId), { ok: false, error: 'invalid-task-id' }, label);
    }

    assert.equal(fs.existsSync(file), false);
  });
});

// ── 4. 构造参数 / 合法边界 ───────────────────────────────────────

test('now / newId 必须是函数；128 字符键与 id、now=0、dueAt 恰好 MAX_SAFE_INTEGER 可用', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');

    assert.throws(() => createReminderService(file, { now: null }), TypeError);
    assert.throws(() => createReminderService(file, { newId: null }), TypeError);

    const key = 'k'.repeat(128);
    const taskId = 'i'.repeat(128);
    const service = createReminderService(file, { now: () => 0, newId: () => taskId });
    assert.deepEqual(service.create(key, '1毫秒后提醒我喝水'), {
      ok: true,
      taskId,
      dueAt: 1,
      status: 'queued',
    });
    assert.deepEqual(service.list(key), {
      ok: true,
      reminders: [publicReminder(taskId, 1, '喝水')],
      truncated: false,
    });
    assert.deepEqual(service.cancel(key, taskId), { ok: true, taskId, status: 'canceled' });

    // 两个安全整数相加恰好等于 MAX_SAFE_INTEGER：这是允许的上界。
    const maxService = createReminderService(file, {
      now: () => Number.MAX_SAFE_INTEGER - 604_800_000,
      newId: () => 'max-task',
    });
    assert.deepEqual(maxService.create(key, '604800秒后提醒我喝水'), {
      ok: true,
      taskId: 'max-task',
      dueAt: Number.MAX_SAFE_INTEGER,
      status: 'queued',
    });
  });
});

// ── 5. 排序 / 截断 ──────────────────────────────────────────────

test('list 按 dueAt 升序、taskId 破同分，只取当前会话，最多 20 条并报告 truncated', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const late = Array.from({ length: 19 }, (_, index) => record({
      taskId: `late-${String(index).padStart(2, '0')}`,
      conversationKey: KEY,
      text: `late-${index}`,
      dueAt: T0 + 10_000 + index,
    }));
    const fixtures = [
      ...late,
      record({ taskId: 'b', conversationKey: KEY, text: 'b', dueAt: T0 + 1000 }),
      record({ taskId: 'a', conversationKey: KEY, text: 'a', dueAt: T0 + 1000 }),
      record({ taskId: 'other-early', conversationKey: OTHER, text: 'other', dueAt: T0 }),
    ];
    seed(file, fixtures);

    const service = createReminderService(file, { now: () => T0, newId: () => 'unused' });
    const expected = [
      publicReminder('a', T0 + 1000, 'a'),
      publicReminder('b', T0 + 1000, 'b'),
      ...late.slice(0, 18).map((item) => publicReminder(item.taskId, item.dueAt, item.text)),
    ];

    const truncated = service.list(KEY);
    assert.equal(truncated.ok, true);
    assert.equal(truncated.truncated, true, '21 条本会话记录应报告截断');
    assert.deepEqual(truncated.reminders, expected);
    assert.deepEqual(Object.keys(truncated.reminders[0]), ['taskId', 'text', 'dueAt', 'status']);
    assert.equal(truncated.reminders.some((item) => item.taskId === 'other-early'), false);

    // 恰好 20 条：仍返回 20 条，但 truncated 必须为 false。
    seed(file, fixtures.filter((item) => item.taskId !== 'late-18'));
    const exact = service.list(KEY);
    assert.equal(exact.truncated, false, '恰好 20 条不应报告截断');
    assert.deepEqual(exact.reminders, expected);
  });
});

// ── 6. 终态 / 已触发 / 可取消状态 ───────────────────────────────

test('终态、待查状态与已触发记录不能取消；created/queued/due 可取消', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const blocked = [
      ['sent', 'sent'],
      ['partial', 'partial'],
      ['failed', 'failed'],
      ['expired', 'expired'],
      ['processing', 'processing'],
      ['delivery_pending', 'delivery_pending'],
      ['unknown', 'unknown'],
      ['pending', 'pending'],
      ['queued 已尝试', 'queued', { attempt: 1 }],
      ['created 已尝试', 'created', { attempt: 1 }],
      ['queued 已触发', 'queued', { firedAt: T0 }],
      ['due 已触发', 'due', { firedAt: T0 }],
    ];
    const records = blocked.map(([label, status, over = {}], index) => record({
      taskId: `blocked-${index}`,
      text: label,
      status,
      dueAt: T0 + 100 + index,
      ...over,
    }));
    seed(file, records);

    const service = createReminderService(file, { now: () => T0, newId: () => 'unused' });
    const before = bytes(file);
    for (const item of records) {
      assert.deepEqual(service.cancel(KEY, item.taskId), { ok: false, error: 'not-cancelable' }, item.text);
      assert.equal(bytes(file), before, item.text + '：不可取消时不能写盘');
    }
    assert.deepEqual(createReminderStore(file).load().records, records);

    for (const status of ['created', 'queued', 'due']) {
      const one = record({ taskId: `allowed-${status}`, status, dueAt: T0 + 1 });
      seed(file, [one]);
      assert.deepEqual(service.cancel(KEY, one.taskId), {
        ok: true,
        taskId: one.taskId,
        status: 'canceled',
      }, status);
      assert.deepEqual(createReminderStore(file).load().records, [{ ...one, status: 'canceled' }], status);
    }
  });
});

// ── 7. 重复 id / 坏快照 ─────────────────────────────────────────

test('重复 taskId 由 store 拒绝，原快照保持', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const service = createReminderService(file, { now: () => T0, newId: () => 'same-id' });
    assert.equal(service.create(KEY, VALID_RAW).ok, true);
    const before = bytes(file);

    const duplicate = createReminderService(file, { now: () => T0, newId: () => 'same-id' });
    assert.deepEqual(duplicate.create(OTHER, '10秒后提醒我收衣服'), {
      ok: false,
      error: 'invalid-records',
    });
    assert.equal(bytes(file), before);
  });
});

test('坏快照下 create / list / cancel 都原样返回 invalid-snapshot，文件不动', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const body = '{"version":1,"records":[';
    fs.writeFileSync(file, body, 'utf8');
    const service = createReminderService(file, { now: () => T0, newId: () => 'task-1' });

    const operations = [
      ['create', () => service.create(KEY, VALID_RAW)],
      ['list', () => service.list(KEY)],
      ['cancel', () => service.cancel(KEY, 'task-1')],
    ];
    for (const [label, run] of operations) {
      assert.deepEqual(run(), { ok: false, error: 'invalid-snapshot' }, label);
      assert.equal(bytes(file), body, label + '：坏文件不能被覆盖');
      assert.deepEqual(stagedFiles(path.dirname(file)), [], label);
    }
  });
});

// ── 8. 写失败 ──────────────────────────────────────────────────

test('写失败后 create 与 cancel 都返回 write-failed，磁盘记录保持原样', (t) => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const service = createReminderService(file, { now: () => T0, newId: idSequence() });
    assert.equal(service.create(KEY, VALID_RAW).ok, true);
    const before = bytes(file);
    const queued = {
      ok: true,
      reminders: [publicReminder('task-1', T0 + 5000, '喝水')],
      truncated: false,
    };
    assert.deepEqual(service.list(KEY), queued);

    // 走到这里时临时文件已经用 'wx' 独占创建、写的是 fd，所以只拦成功的写。
    const originalWrite = fs.writeFileSync;
    let failing = true;
    t.mock.method(fs, 'writeFileSync', function injected(...args) {
      if (failing && typeof args[0] === 'number') {
        const error = new Error('injected write failure');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite.apply(fs, args);
    });

    assert.deepEqual(service.create(KEY, '10秒后提醒我收衣服'), {
      ok: false,
      error: 'write-failed',
    });
    assert.equal(bytes(file), before, 'create 失败不能改动旧快照');
    assert.deepEqual(service.list(KEY), queued);

    assert.deepEqual(service.cancel(KEY, 'task-1'), {
      ok: false,
      error: 'write-failed',
    });
    assert.equal(bytes(file), before, 'cancel 失败不能改动旧快照');
    assert.deepEqual(service.list(KEY), queued);
    assert.deepEqual(stagedFiles(dir), [], '自己创建的临时文件必须清理');
  });
});