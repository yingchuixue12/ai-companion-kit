/**
 * reminder-store · 快照文件的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只用临时目录和 node:test 的同步 mock，不联网、不读写生产 data/。
 *
 * 覆盖：
 *   - 缺文件 → 空账；跨实例往返保留投递事实（status/attempt/firedAt/proactive）；
 *   - 落盘只有白名单八字段（缺省值会被写成 0 / null / false）；
 *   - 任何成功或失败的写都不留暂存文件；
 *   - 坏 JSON / 错误版本 / 结构错 / 超限文件 → invalid-snapshot，且不能被 save 覆盖；
 *   - 非法 / 重复 / 超限输入 → invalid-records，现有快照一字不动；
 *   - 目标是目录、stat 抛非 ENOENT 错误 → read-failed（不可读不等于没有）；
 *     父目录缺失 → write-failed 且不 mkdir；
 *   - 注入真实 I/O 错误（readFile / writeFile / rename 抛 EIO）：原快照保持、
 *     自己创建的临时文件被清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReminderStore } from '../src/reminder-store.js';

const T0 = 1_700_000_000_000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-store-'));
}

function withDir(run) {
  const dir = tempDir();
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 一条合法记录；over 用来单独打坏某一个字段。 */
function record(over = {}) {
  return { taskId: 'task-1', conversationKey: 'private:10001', text: '该喝水了', dueAt: T0, status: 'queued', ...over };
}

function writeRaw(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

/** 目录里残留的暂存文件（'.<name>.<pid>-<hex>.tmp'）。 */
function stagedFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

/** 抓住原函数：注入 readFileSync 失败之后，测试自己仍要能核对文件内容。 */
const readText = fs.readFileSync;

function bytes(file) {
  return readText(file, 'utf8');
}

/** 注入同步 I/O 错误：命中 predicate 的调用抛 EIO，其余照常走真实实现。 */
function failWith(t, method, predicate) {
  const original = fs[method];
  t.mock.method(fs, method, function injected(...args) {
    if (predicate(...args)) {
      const error = new Error('injected ' + method + ' failure');
      error.code = 'EIO';
      throw error;
    }
    return original.apply(fs, args);
  });
}

/** 256 条「各字段顶到长度上限、全是控制字符」的记录：JSON 转义后必超 1 MiB。 */
function oversizedRecords() {
  const control = '\u0001';
  return Array.from({ length: 256 }, (_, index) => ({
    taskId: control.repeat(120) + String(index).padStart(3, '0'),
    conversationKey: control.repeat(128),
    text: control.repeat(500),
    dueAt: T0,
    status: 'queued',
  }));
}

const oversizedSnapshot = JSON.stringify({ version: 1, records: oversizedRecords() });

// ── 1. 缺文件 / 往返 ─────────────────────────────────────────────

test('文件不存在时 load 返回空账，且不会顺手建出文件', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);

    assert.deepEqual(store.load(), { ok: true, records: [] });
    assert.equal(fs.existsSync(file), false);
  });
});

test('跨实例往返：投递事实原样保留，缺省字段被落成 0 / null / false', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const delivered = {
      taskId: 'task-sent',
      conversationKey: 'group:20002',
      text: '记得收衣服',
      dueAt: T0 + 60_000,
      status: 'sent',
      attempt: 2,
      firedAt: T0 + 61_000,
      proactive: true,
    };
    const queued = record({ taskId: 'task-queued' });

    assert.deepEqual(createReminderStore(file).save([delivered, queued]), { ok: true });

    const reopened = createReminderStore(file).load();
    assert.equal(reopened.ok, true);
    assert.deepEqual(reopened.records, [
      delivered,
      { ...queued, attempt: 0, firedAt: null, proactive: false },
    ]);

    const raw = JSON.parse(bytes(file));
    assert.deepEqual(Object.keys(raw), ['version', 'records']);
    assert.equal(raw.version, 1);
    assert.deepEqual(Object.keys(raw.records[1]), [
      'taskId', 'conversationKey', 'text', 'dueAt', 'status', 'attempt', 'firedAt', 'proactive',
    ]);
  });
});

test('成功的 save 不留暂存文件', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);

    assert.deepEqual(store.save([record()]), { ok: true });
    assert.deepEqual(stagedFiles(dir), []);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
  });
});

// ── 2. 读不懂的文件：不覆盖、不删除 ──────────────────────────────

test('坏 JSON / 错版本 / 结构错 / 超限 → invalid-snapshot，且 save 绝不覆盖', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);

    const fixtures = [
      ['坏 JSON', '{not json'],
      ['不是对象', '[]'],
      ['缺版本', JSON.stringify({ records: [] })],
      ['错误版本', JSON.stringify({ version: 2, records: [] })],
      ['版本是字符串', JSON.stringify({ version: '1', records: [] })],
      ['顶层多余字段', JSON.stringify({ version: 1, records: [], extra: true })],
      ['records 不是数组', JSON.stringify({ version: 1, records: {} })],
      ['记录多余字段', JSON.stringify({ version: 1, records: [{ ...record(), extra: 1 }] })],
      ['记录缺字段', JSON.stringify({ version: 1, records: [{ taskId: 'a', text: 'x', dueAt: T0, status: 'queued' }] })],
      ['记录重复 taskId', JSON.stringify({ version: 1, records: [record(), record()] })],
      ['超限（1 MiB 以上但每条都合法）', oversizedSnapshot],
    ];

    for (const [label, body] of fixtures) {
      writeRaw(file, body);
      assert.deepEqual(store.load(), { ok: false, error: 'invalid-snapshot' }, label);
      assert.deepEqual(store.save([record({ taskId: 'other' })]), { ok: false, error: 'invalid-snapshot' }, label);
      assert.equal(bytes(file), body, label + '：原文件必须一字不动');
      assert.deepEqual(stagedFiles(dir), [], label);
    }
  });
});

// ── 3. 非法输入 ─────────────────────────────────────────────────

test('非法 / 重复 / 超限输入 → invalid-records，现有快照不动', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);
    assert.deepEqual(store.save([record()]), { ok: true });
    const before = bytes(file);

    const cases = [
      ['不是数组', record()],
      ['null', null],
      ['记录不是对象', ['task-1']],
      ['记录是数组', [[record()]]],
      ['多余字段', [{ ...record(), extra: 1 }]],
      ['taskId 非字符串', [record({ taskId: 123 })]],
      ['taskId 空白', [record({ taskId: '   ' })]],
      ['taskId 空串', [record({ taskId: '' })]],
      ['taskId 129 字符', [record({ taskId: 'x'.repeat(129) })]],
      ['conversationKey 空白', [record({ conversationKey: '\t\n' })]],
      ['conversationKey 129 字符', [record({ conversationKey: 'k'.repeat(129) })]],
      ['text 空白', [record({ text: ' \n ' })]],
      ['text 501 字符', [record({ text: 'x'.repeat(501) })]],
      ['缺 text', [{ taskId: 'a', conversationKey: 'c', dueAt: T0, status: 'queued' }]],
      ['dueAt 字符串', [record({ dueAt: String(T0) })]],
      ['dueAt 负数', [record({ dueAt: -1 })]],
      ['dueAt 非整数', [record({ dueAt: T0 + 0.5 })]],
      ['status 未知', [record({ status: 'sending' })]],
      ['status 非字符串', [record({ status: 1 })]],
      ['attempt 负数', [record({ attempt: -1 })]],
      ['attempt 小数', [record({ attempt: 1.5 })]],
      ['attempt 字符串', [record({ attempt: '0' })]],
      ['firedAt 字符串', [record({ firedAt: String(T0) })]],
      ['firedAt 负数', [record({ firedAt: -1 })]],
      ['proactive 字符串', [record({ proactive: 'false' })]],
      ['proactive 数字', [record({ proactive: 1 })]],
      ['重复 taskId', [record(), record()]],
      ['257 条', Array.from({ length: 257 }, (_, i) => record({ taskId: 'task-' + i }))],
      ['256 条但编码后超 1 MiB', oversizedRecords()],
    ];

    for (const [label, input] of cases) {
      assert.deepEqual(store.save(input), { ok: false, error: 'invalid-records' }, label);
      assert.equal(bytes(file), before, label + '：原快照不能被改写');
      assert.deepEqual(store.load(), { ok: true, records: [{ ...record(), attempt: 0, firedAt: null, proactive: false }] }, label);
      assert.deepEqual(stagedFiles(dir), [], label);
    }
  });
});

test('边界值本身合法：128 / 128 / 500、attempt 0、firedAt null、proactive false、256 条', () => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);

    const edge = record({
      taskId: 'x'.repeat(128),
      conversationKey: 'y'.repeat(128),
      text: 'z'.repeat(500),
      attempt: 0,
      firedAt: null,
      proactive: false,
    });
    assert.deepEqual(store.save([edge]), { ok: true });
    assert.deepEqual(store.load().records, [edge]);

    const many = Array.from({ length: 256 }, (_, i) => record({ taskId: 'task-' + i, text: 'x'.repeat(500) }));
    assert.deepEqual(store.save(many), { ok: true });
    assert.equal(store.load().records.length, 256);

    assert.deepEqual(store.save([]), { ok: true });
    assert.deepEqual(store.load(), { ok: true, records: [] });
  });
});

// ── 4. 路径与 I/O 失败 ──────────────────────────────────────────

test('目标是目录 → read-failed，不当成空账', () => {
  withDir((dir) => {
    const directory = path.join(dir, 'is-a-dir');
    fs.mkdirSync(directory);
    const store = createReminderStore(directory);

    assert.deepEqual(store.load(), { ok: false, error: 'read-failed' });
    assert.deepEqual(store.save([record()]), { ok: false, error: 'read-failed' });
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test('stat 抛非 ENOENT 错误 → read-failed（不可读不等于没有）', (t) => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);
    assert.deepEqual(store.save([record()]), { ok: true });
    const before = bytes(file);

    failWith(t, 'statSync', () => true);

    assert.deepEqual(store.load(), { ok: false, error: 'read-failed' });
    assert.deepEqual(store.save([record({ text: '新的' })]), { ok: false, error: 'read-failed' });
    assert.equal(bytes(file), before, '看不清文件时绝不写');
    assert.deepEqual(stagedFiles(dir), []);
  });
});

test('父目录不存在 → write-failed，不 mkdir、不留暂存', () => {
  withDir((dir) => {
    const file = path.join(dir, 'missing', 'reminders.json');
    assert.deepEqual(createReminderStore(file).save([record()]), { ok: false, error: 'write-failed' });
    assert.equal(fs.existsSync(path.dirname(file)), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('空路径直接抛 TypeError（构造期错误，不是数据错误）', () => {
  assert.throws(() => createReminderStore(''), TypeError);
  assert.throws(() => createReminderStore('   '), TypeError);
  assert.throws(() => createReminderStore(undefined), TypeError);
});

test('readFile 抛 EIO → load/save 都是 read-failed，原快照保持', (t) => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);
    assert.deepEqual(store.save([record()]), { ok: true });
    const before = bytes(file);

    failWith(t, 'readFileSync', (target) => target === file);

    assert.deepEqual(store.load(), { ok: false, error: 'read-failed' });
    assert.deepEqual(store.save([record({ text: '新的' })]), { ok: false, error: 'read-failed' });
    assert.equal(bytes(file), before, '读失败时不能写，快照必须保持');
    assert.deepEqual(stagedFiles(dir), []);
  });
});

test('writeFile 抛 EIO → write-failed，原快照保持、临时文件被清理', (t) => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);
    assert.deepEqual(store.save([record()]), { ok: true });
    const before = bytes(file);

    // 走到这里时临时文件已经用 'wx' 独占创建、写的是 fd，所以只拦成功的写。
    failWith(t, 'writeFileSync', (...args) => typeof args[0] === 'number');

    assert.deepEqual(store.save([record({ text: '新的' })]), { ok: false, error: 'write-failed' });
    assert.equal(bytes(file), before, '写失败不能动原快照');
    assert.deepEqual(stagedFiles(dir), [], '自己创建的临时文件必须清理');
  });
});

test('rename 抛 EIO → write-failed，原快照保持、临时文件被清理', (t) => {
  withDir((dir) => {
    const file = path.join(dir, 'reminders.json');
    const store = createReminderStore(file);
    assert.deepEqual(store.save([record()]), { ok: true });
    const before = bytes(file);

    failWith(t, 'renameSync', () => true);

    assert.deepEqual(store.save([record({ text: '新的' })]), { ok: false, error: 'write-failed' });
    assert.equal(bytes(file), before, '原子替换没成功，旧快照必须还在');
    assert.deepEqual(stagedFiles(dir), [], '自己创建的临时文件必须清理');
    assert.deepEqual(createReminderStore(file).load().records[0].text, '该喝水了');
  });
});
