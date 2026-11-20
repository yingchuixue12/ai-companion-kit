/**
 * reminder-runtime · 宿主定时派发的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只验证 index.js 的提醒装配与 reminder-runtime.js 的对外行为：
 * 全部用临时目录、假定时器、假 OneBot / 假 process；不联网、不读真实
 * 配置或 data/、不启动真实 OneBot。
 *
 * 覆盖：
 *   - --reminders 默认关闭、--check 提前退出、--dry-run 不建 runtime；
 *   - 空白名单不触发调度，构造参数与非法 dispatcher 校验；
 *   - 一轮 dispatchNext 彻底结束后才排下一轮（不重叠、不堆积）；
 *   - 失败只报固定文案（不出现异常正文）并继续下一轮；
 *   - stop 幂等：清掉已排定时器，in-flight 完成后也不重排；
 *   - 假 OneBot + 真实窗口 / dispatcher / store：到期投递并落盘 sent，
 *     SIGINT 先停再 exit。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createReminderRuntime } from '../src/reminder-runtime.js';
import { loadConfig, main } from '../src/index.js';

const OWNER = '10001';
const FIXED_ERROR = '[提醒] 派发失败';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-runtime-'));
}

function writeConfig(dir, overrides = {}) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    dataDir: './data',
    ownerIds: [OWNER],
    ...overrides,
  }));
  return file;
}

/** 一条到期、未触发过的提醒；over 用来单独改字段。 */
function dueRecord(over = {}) {
  return {
    taskId: 'task-1',
    conversationKey: 'private:' + OWNER,
    text: '喝水',
    dueAt: Date.now() - 1000,
    status: 'due',
    attempt: 0,
    firedAt: null,
    proactive: false,
    ...over,
  };
}

/** 把提醒快照写进临时 data 目录，返回文件路径。 */
function writeReminders(dir, records) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'reminders.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, records }));
  return file;
}

function readReminders(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).records;
}

/** 可控的假定时器：记录 delay、按需 fire、可 clear。 */
function createFakeTimers() {
  let nextId = 0;
  const pending = new Map();
  const delays = [];
  return {
    setTimeout(fn, delay) {
      const id = ++nextId;
      pending.set(id, { fn, delay });
      delays.push(delay);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    get size() { return pending.size; },
    get delays() { return delays.slice(); },
    fire() {
      const entry = pending.entries().next().value;
      if (!entry) throw new Error('没有待触发的假定时器');
      const [id, job] = entry;
      pending.delete(id);
      job.fn();
      return job.delay;
    },
  };
}

/** 让排队的微任务 / Promise 落定。 */
async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 轮询等待条件成立；超时抛错，避免测试静默挂住。 */
async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待条件超时');
}

/** 假 process 的最小外壳：argv / on / exit 都只记录。 */
function fakeProcess(argv) {
  const proc = new EventEmitter();
  proc.argv = argv;
  proc.exits = [];
  proc.exit = (code) => { proc.exits.push(code); };
  return proc;
}

/** 一个只做记录的假 OneBot。 */
function fakeBot() {
  const bot = {
    sent: [],
    async sendPrivateText(userId, text) {
      bot.sent.push({ userId, text });
      return { receipt: { status: 'confirmed' } };
    },
  };
  return bot;
}

test('loadConfig：--reminders 默认关闭，显式给出才开启', () => {
  const dir = tempDir();
  try {
    const config = writeConfig(dir);
    assert.equal(loadConfig(config, ['node', 'index.js']).reminders, false);
    assert.equal(loadConfig(config, ['node', 'index.js', '--reminders']).reminders, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--check 提前退出：不构造 bot、不读提醒、不建 runtime', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir();
  try {
    const config = writeConfig(dir, { apiKey: 'x' });
    writeReminders(dir, [dueRecord()]);

    let built = 0;
    const proc = fakeProcess(['node', 'index.js', '--check', '--reminders', '--config', config]);
    // 用 process 别名注入，默认仍保持真实 process 路径。
    const result = await main({
      createBot: () => { built += 1; return fakeBot(); },
      process: proc,
    });

    assert.equal(result, undefined);
    assert.equal(built, 0);
    assert.equal(readReminders(path.join(dir, 'data', 'reminders.json'))[0].status, 'due');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认关闭、干跑、空白名单都不调度', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir();
  const runs = [];
  try {
    const config = writeConfig(dir);              // 没有 apiKey，覆盖启动警告分支
    const blankConfig = path.join(dir, 'config-blank.json');
    fs.writeFileSync(blankConfig, JSON.stringify({ dataDir: './data', ownerIds: ['abc', '01', 0] }));
    const bot = fakeBot();
    writeReminders(dir, [dueRecord()]);

    const off = await main({ createBot: () => bot, proc: fakeProcess(['node', 'index.js', '--config', config]) });
    runs.push(off);
    assert.equal(off.reminders, null, '默认关闭');

    const dry = await main({
      createBot: () => bot,
      proc: fakeProcess(['node', 'index.js', '--config', config, '--reminders', '--dry-run']),
    });
    runs.push(dry);
    assert.equal(dry.reminders, null, '干跑不建 runtime');

    const blank = await main({
      createBot: () => bot,
      proc: fakeProcess(['node', 'index.js', '--config', blankConfig, '--reminders']),
    });
    runs.push(blank);
    assert.ok(blank.reminders, '开启时返回 runtime 句柄');
    assert.equal(blank.reminders.active, false, '空白名单不可调度');
    assert.equal(blank.reminders.running, false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(bot.sent, [], '三条路径都不该发出提醒');
    assert.equal(readReminders(path.join(dir, 'data', 'reminders.json'))[0].status, 'due');
  } finally {
    for (const run of runs) run.reminders?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('空白名单归一化与构造校验', () => {
  const dir = tempDir();
  try {
    const timers = createFakeTimers();
    for (const ownerIds of [[], ['abc'], ['01'], [0], [1.5], null, undefined]) {
      const runtime = createReminderRuntime({
        ownerIds,
        dataDir: path.join(dir, 'data'),
        timers,
        dispatcher: { async dispatchNext() { return { ok: true, result: null }; } },
      });
      assert.equal(runtime.active, false);
      runtime.start();
      assert.equal(timers.size, 0, '没有有效白名单就不排定时器');
      runtime.stop();
    }

    // 合法数字与 Set 都归一化成字符串白名单。
    for (const ownerIds of [[OWNER], new Set([Number(OWNER)])]) {
      const runtime = createReminderRuntime({
        ownerIds,
        timers: createFakeTimers(),
        dispatcher: { async dispatchNext() { return { ok: true, result: null }; } },
      });
      assert.equal(runtime.active, true);
      runtime.stop();
    }

    assert.throws(
      () => createReminderRuntime({ ownerIds: [OWNER], dataDir: dir, timers }),
      /bot\.sendPrivateText must be a function/,
    );
    assert.throws(
      () => createReminderRuntime({
        ownerIds: [OWNER],
        bot: { sendPrivateText() {} },
        dataDir: dir,
        timers,
      }),
      /window\.runSerial must be a function/,
    );
    assert.throws(
      () => createReminderRuntime({ ownerIds: [OWNER], dispatcher: {}, timers }),
      /dispatcher\.dispatchNext must be a function/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非重叠调度：dispatchNext 完成后才排下一轮', async () => {
  const timers = createFakeTimers();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const runtime = createReminderRuntime({
    ownerIds: [OWNER],
    file: '/tmp/reminder-runtime-test-not-used.json',
    timers,
    dispatcher: {
      async dispatchNext() {
        calls += 1;
        if (calls === 1) await gate;
        return { ok: true, result: null };
      },
    },
  });

  runtime.start();
  runtime.start();                       // 幂等：不重复排
  assert.equal(timers.size, 1);
  assert.deepEqual(timers.delays, [1000]);

  assert.equal(timers.fire(), 1000);
  await settle(2);
  assert.equal(calls, 1);
  assert.equal(timers.size, 0, 'in-flight 期间没有下一轮定时器');

  release();
  await settle();
  assert.equal(timers.size, 1, '彻底完成后才排下一轮');
  assert.deepEqual(timers.delays, [1000, 1000]);

  timers.fire();
  await settle();
  assert.equal(calls, 2);
  assert.equal(timers.size, 1);
  runtime.stop();
  assert.equal(timers.size, 0);
});

test('派发失败只报固定文案并继续下一轮', async (t) => {
  const dir = tempDir();
  const logs = [];
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')); });
  try {
    const timers = createFakeTimers();
    let calls = 0;
    const runtime = createReminderRuntime({
      ownerIds: [OWNER],
      file: path.join(dir, 'never-used.json'),
      timers,
      dispatcher: {
        async dispatchNext() {
          calls += 1;
          if (calls === 1) return { ok: false, error: 'read-failed' };
          if (calls === 2) throw new Error('secret-reminder-text');
          return { ok: true, result: null };
        },
      },
    });

    runtime.start();
    timers.fire();
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers.size, 1, '失败后先排下一轮，不立即重发');
    assert.deepEqual(logs, [FIXED_ERROR], '固定文案，不含 store 错误 token');

    timers.fire();
    await settle();
    assert.equal(calls, 2);
    assert.equal(timers.size, 1);
    assert.deepEqual(logs, [FIXED_ERROR, FIXED_ERROR], '异常正文不进日志');

    // 非函数 onError 回落到默认固定文案。
    const fallbackTimers = createFakeTimers();
    const fallback = createReminderRuntime({
      ownerIds: [OWNER],
      file: path.join(dir, 'never-used-2.json'),
      timers: fallbackTimers,
      onError: 'not-a-function',
      dispatcher: { async dispatchNext() { return { ok: false, error: 'write-failed' }; } },
    });
    fallback.start();
    fallbackTimers.fire();
    await settle();
    assert.equal(logs.at(-1), FIXED_ERROR);
    fallback.stop();
    runtime.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop 幂等：清除定时器且阻止任何重排', async () => {
  // 已排未响：stop 清掉。
  const timers = createFakeTimers();
  const runtime = createReminderRuntime({
    ownerIds: [OWNER],
    file: '/tmp/reminder-runtime-test-stop.json',
    timers,
    dispatcher: { async dispatchNext() { return { ok: true, result: null }; } },
  });
  runtime.start();
  assert.equal(timers.size, 1);
  runtime.stop();
  assert.equal(timers.size, 0);
  assert.equal(runtime.running, false);
  runtime.stop();                        // 幂等
  runtime.start();                       // stop 之后不再启动
  assert.equal(timers.size, 0);

  // in-flight：stop 后完成回调也不能重排。
  const busyTimers = createFakeTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const busy = createReminderRuntime({
    ownerIds: [OWNER],
    file: '/tmp/reminder-runtime-test-stop-2.json',
    timers: busyTimers,
    dispatcher: { async dispatchNext() { await gate; return { ok: true, result: null }; } },
  });
  busy.start();
  busyTimers.fire();
  busy.stop();
  release();
  await settle();
  assert.equal(busyTimers.size, 0, '完成之后不重排');
  assert.equal(busy.running, false);
});

test('假 OneBot + 真实窗口/派发/存储：到期投递落盘，SIGINT 先停', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir();
  let run = null;
  try {
    const config = writeConfig(dir, { apiKey: 'x' });
    const file = writeReminders(dir, [dueRecord({ taskId: 'task-e2e', text: '喝水' })]);

    const bot = fakeBot();
    const proc = fakeProcess(['node', 'index.js', '--config', config, '--reminders']);
    run = await main({ createBot: () => bot, proc });
    assert.equal(run.reminders.active, true);
    assert.equal(run.reminders.running, true);

    await waitFor(() => {
      try { return readReminders(file)[0].status === 'sent'; } catch { return false; }
    });

    assert.deepEqual(bot.sent, [{ userId: OWNER, text: '喝水' }]);
    const saved = readReminders(file)[0];
    assert.equal(saved.taskId, 'task-e2e');
    assert.equal(saved.status, 'sent');
    assert.equal(saved.attempt, 1);
    assert.equal(typeof saved.firedAt, 'number');

    proc.emit('SIGINT');
    assert.equal(run.reminders.running, false);
    assert.deepEqual(proc.exits, [0]);
  } finally {
    run?.reminders?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});