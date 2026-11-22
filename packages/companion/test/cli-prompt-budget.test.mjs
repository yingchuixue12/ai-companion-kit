/**
 * companion CLI · 提示词预算接线 · 离线验收
 * ─────────────────────────────────────────────────────────────
 * 只从真实入口 `main()` 出发，外部世界全部换成可审计的替身：
 *
 *   - 真 OneBot 传输 + 假 WebSocket：合成 OneBot v11 原始事件，不连真 QQ；
 *   - 假模型 / 假 OneBot HTTP：globalThis.fetch 只回内存响应，记录实际请求体；
 *   - 临时目录：config.json / role.md / data/ 全在 mkdtemp 里，不读真实配置；
 *   - 假 process：argv / on / exit 只记录，SIGINT 仍走 main 里的真实处理。
 *
 * 覆盖点：
 *   1. 省略 memory.systemBudgetChars：Role 非分层、请求体与旧装配逐字节一致、
 *      不出现 memory-budget 日志；
 *   2. 显式提供：Role 分层、Brain 用 systemBudgetChars + onMemoryBudget，
 *      实际模型请求被削减，CLI 打出脱敏的诊断 v2（无账号/正文/URL/路径）；
 *   3. 非法值在角色卡 / Memory / OneBot / 模型副作用之前失败，宽松与
 *      --owner-private 走同一份检查，固定报错不复述输入；
 *   4. 硬上限 24000 与 Brain 默认 maxInputChars 不漂移；CLI 非零退出。
 *
 * 不联网、不读真实配置与真实 data/、不调用真实模型、不发送 QQ 消息。
 * 本文件只证明合成离线链路，不代表芙兰宿主或真实 QQ 已验收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  MAX_SYSTEM_BUDGET_CHARS,
  SYSTEM_BUDGET_CODES,
  SYSTEM_BUDGET_CONFIG_ERROR,
  main,
  validateSystemBudgetChars,
} from '../src/index.js';
import { Brain } from '../src/brain.js';
import { OneBot } from '../src/transport-onebot.js';
import { Role } from '../src/role.js';
import { Waker } from '../src/wake.js';

const OWNER = '10001';
const START = 1_760_000_000_000;
const MODEL = 'fake-model';
const SENTINEL = 'SENTINEL_BUDGET_8848';
const ROLE_TEXT = '# 角色卡\n测试角色：说话短、别客套。\n';
const INDEX_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));

// data URL 内联 WebSocket stub：构造时记录参数与事件处理器，不建立任何连接。
const wsStubUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.handlers = new Map();
    (globalThis.__cliBudgetSockets ||= []).push(this);
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
  emit(event, payload) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }
}
`);

// 只替换 transport-onebot.js 发出的 import('ws')，其余模块解析保持原样。
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'ws' && context.parentURL?.includes('/transport-onebot.js')) {
      return { url: wsStubUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

test.after(() => hooks.deregister());

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-budget-'));
}

/** 与 config.example.json 同形；模型与 OneBot 都指向不会真连的域名。 */
function baseConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://model.invalid/v1',
    model: MODEL,
    roleCard: 'role.md',
    names: ['小满'],
    ownerIds: [OWNER],
    dataDir: './data',
    onebot: {
      wsUrl: 'ws://onebot.invalid',
      httpUrl: 'http://onebot.invalid',
      accessToken: '',
    },
    wake: { probability: 0, privateWindowMs: 0, groupWindowMs: 0 },
    humanize: { enabled: false },
    ...overrides,
  };
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'role.md'), ROLE_TEXT);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { file, roleCard: path.join(dir, 'role.md') };
}

function makeProc(argv) {
  const proc = new EventEmitter();
  proc.argv = ['node', 'src/index.js', ...argv];
  proc.exits = [];
  proc.exit = (code) => { proc.exits.push(code); };
  return proc;
}

/** 让出若干轮事件循环；不睡眠。 */
async function settle(times = 10) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/** 推进 0ms 的会话窗口定时器，再让异步生成/发送跑完。 */
async function flushWindow(t) {
  t.mock.timers.tick(0);
  await settle(12);
}

async function startRealOneBotMain({ configPath, argv = [] } = {}) {
  const built = [];
  const proc = makeProc(['--config', configPath, ...argv]);
  const run = await main({
    createBot: (options) => {
      const bot = new OneBot(options);
      built.push(bot);
      return bot;
    },
    proc,
  });
  await settle(8);
  const bot = built[0] || null;
  return { run, proc, built, bot, socket: bot?.ws || null };
}

/** 假模型 / 假 OneBot HTTP：只回内存响应，并记录每次请求。 */
function installFetch(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, body: typeof init.body === 'string' ? init.body : '' });
    if (target.endsWith('/send_private_msg')
      || target.endsWith('/send_group_msg')
      || target.endsWith('/set_input_status')) {
      return new Response(JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { message_id: 'sent-' + calls.length },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '离线回复' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return {
    calls,
    model: () => calls.filter((call) => call.url.includes('/chat/completions')),
    sends: () => calls.filter((call) => call.url.endsWith('/send_private_msg')
      || call.url.endsWith('/send_group_msg')),
  };
}

let eventSequence = 100;
/** 一条合成 OneBot v11 私聊事件（字段形状与真实 OneBot 上报一致）。 */
function privateEvent({ userId = OWNER, text = '在吗', name = '小满' } = {}) {
  eventSequence += 1;
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 99999,
    user_id: Number(userId),
    message_id: eventSequence,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    sender: { user_id: Number(userId), nickname: name, card: '' },
    time: Math.floor(START / 1000),
  };
}

function emit(socket, event) {
  socket.emit('message', JSON.stringify(event));
}

function budgetLines(logs) {
  return logs.filter((line) => line.startsWith('[memory-budget] '));
}

function budgetEvent(logs) {
  const [line, extra] = budgetLines(logs);
  assert.equal(extra, undefined, '一次模型请求只应有一条预算诊断');
  assert.ok(line, '启用预算后，每次请求前都要有诊断');
  return JSON.parse(line.slice('[memory-budget] '.length));
}

/** 写入合成的跨场合对话与话题，供预算裁剪；不经过产品写入路径。 */
function seedBudgetData(dir) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const longTopic = 'SEEDED_LONG_TOPIC ' + '话'.repeat(280);
  fs.writeFileSync(path.join(dataDir, 'people.json'), JSON.stringify({
    [OWNER]: {
      name: '小满',
      traits: [],
      facts: [],
      topics: [longTopic],
      pending: [],
      interactions: 1,
      firstSeenAt: START,
      lastSeenAt: START,
    },
  }, null, 2));
  const rows = [
    { t: START, where: 'private:old', who: '小满', text: 'SEEDED_OLD_ROUND ' + '甲'.repeat(300), reply: '旧回复 ' + '乙'.repeat(120) },
    { t: START + 1, where: 'private:old', who: '小满', text: 'SEEDED_NEWEST_ROUND 记得', reply: '好' },
  ];
  fs.writeFileSync(path.join(dataDir, 'turns.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

// ── 1. 校验契约与漂移守卫（纯函数）────────────────────────────

test('validateSystemBudgetChars：省略 / 合法 / 非法，且硬上限与 Brain 默认一致', () => {
  assert.deepEqual(validateSystemBudgetChars(undefined), { ok: true, value: null });
  for (const value of [1, 1200, MAX_SYSTEM_BUDGET_CHARS]) {
    assert.deepEqual(validateSystemBudgetChars(value), { ok: true, value });
  }
  const invalid = [
    null, 0, -1, 1.5, '1200', true, false, {}, [], NaN, Infinity, -Infinity,
    MAX_SYSTEM_BUDGET_CHARS + 1, Number.MAX_SAFE_INTEGER, 1e9,
  ];
  for (const value of invalid) {
    assert.deepEqual(
      validateSystemBudgetChars(value),
      { ok: false, code: SYSTEM_BUDGET_CODES.INVALID },
      '非法值必须返回固定原因码：' + String(value),
    );
  }

  // 漂移守卫：入口常量就是 Brain 的默认请求硬上限，不允许两个数各写各的。
  const memory = { renderPerson: () => '', renderRecent: () => '' };
  assert.equal(new Brain({ apiKey: 'k', role: new Role(), memory }).maxInputChars, MAX_SYSTEM_BUDGET_CHARS);
  const layered = new Role({ layered: true });
  assert.equal(
    new Brain({ apiKey: 'k', role: layered, memory, systemBudgetChars: MAX_SYSTEM_BUDGET_CHARS }).systemBudgetChars,
    MAX_SYSTEM_BUDGET_CHARS,
  );
  assert.throws(
    () => new Brain({ apiKey: 'k', role: layered, memory, systemBudgetChars: MAX_SYSTEM_BUDGET_CHARS + 1 }),
    /systemBudgetChars/,
    '超过硬上限必须被 Brain 拒绝，入口与 Brain 的口径一致',
  );
});

// ── 2. 省略配置：旧模型请求与旧日志 ────────────────────────────

test('省略 systemBudgetChars：模型请求逐字节沿用旧装配，且没有预算日志', async (t) => {
  const dir = makeTempDir();
  const { file, roleCard } = writeConfig(dir, baseConfig());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  const net = installFetch(t);

  let started = null;
  try {
    started = await startRealOneBotMain({ configPath: file });
    const { run, proc, socket } = started;
    assert.equal(run.ok, true);
    assert.deepEqual(run.systemBudget, { enabled: false, chars: null }, '省略时预算关闭');
    assert.equal(logs.some((line) => line.includes('提示词预算')), false, '旧启动横幅不多一行');

    const text = '默认请求-预算关闭';
    const joined = Waker.joinBatch([{ name: '小满', userId: OWNER, text }]);
    emit(socket, privateEvent({ text }));
    await flushWindow(t);

    assert.equal(net.model().length, 1, '私聊进入模型一次');
    assert.equal(net.sends().length, 1, '回复正常发出');
    const request = JSON.parse(net.model()[0].body);
    const expectedSystem = new Role({ cardPath: roleCard }).build({
      situation: '你在跟 小满 私聊。',
      memory: '',
      recent: '',
    });
    // 旧装配顺序：situation 在最前；分层装配会以【基本规矩】开头。
    assert.equal(request.messages[0].content, expectedSystem, 'system prompt 与旧 Role 逐字节一致');
    assert.ok(request.messages[0].content.startsWith('你在跟 小满 私聊。'), '非分层顺序保留 situation 在前');
    assert.equal(net.model()[0].body, JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: expectedSystem },
        { role: 'user', content: joined },
      ],
      temperature: 1.1,
      stream: false,
    }), '模型请求体与旧装配逐字节一致');
    assert.deepEqual(budgetLines(logs), [], '省略配置不得产生 memory-budget 日志');
    assert.equal(errors.length, 0);

    proc.emit('SIGINT');
    assert.deepEqual(proc.exits, [0]);
  } finally {
    started?.proc?.emit('SIGINT');
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. 显式启用：真实请求被预算裁剪，日志是脱敏 v2 ─────────────

test('显式 systemBudgetChars：分层请求实际裁剪 recent/memory，并打出脱敏 v2 诊断', async (t) => {
  const dir = makeTempDir();
  const { file } = writeConfig(dir, baseConfig({
    memory: { systemBudgetChars: 1200 },
  }));
  seedBudgetData(dir);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  const net = installFetch(t);

  let started = null;
  try {
    started = await startRealOneBotMain({ configPath: file });
    const { run, proc, socket } = started;
    assert.equal(run.ok, true);
    assert.deepEqual(run.systemBudget, { enabled: true, chars: 1200 });
    assert.ok(logs.some((line) => line.includes('提示词预算  1200 字')), '启用后横幅显示生效值');

    const text = '启用请求-预算开启';
    const joined = Waker.joinBatch([{ name: '小满', userId: OWNER, text }]);
    emit(socket, privateEvent({ text }));
    await flushWindow(t);

    assert.equal(net.model().length, 1, '私聊进入模型一次');
    assert.equal(net.sends().length, 1, '回复正常发出');
    const body = net.model()[0].body;
    const request = JSON.parse(body);
    const system = request.messages[0].content;
    assert.ok(system.startsWith('【基本规矩】'), '分层人格层必须最前');
    assert.ok(system.includes('【完整设定】'), '角色卡仍在稳定层');
    assert.ok(system.indexOf('【完整设定】') < system.indexOf('你在跟 小满 私聊。'), '人格优先于参考块');
    assert.ok(system.length <= 1200, '实际请求的 system 部分落在预算内');
    assert.equal(request.messages[1].content, joined);

    // 实际模型请求：最旧一轮和超长话题被裁掉，最新一轮保留。
    assert.equal(system.includes('SEEDED_OLD_ROUND'), false, '最旧一轮没有进入请求');
    assert.ok(system.includes('SEEDED_NEWEST_ROUND'), '最新一轮保留');
    assert.equal(system.includes('SEEDED_LONG_TOPIC'), false, '超长话题被预算裁掉');

    const event = budgetEvent(logs);
    assert.equal(event.event, 'memory-budget');
    assert.equal(event.version, 2, '启用分层预算时使用已有的 v2 诊断');
    assert.equal(event.maxChars, 24000, '请求硬上限仍是 Brain 的 24000');
    assert.equal(event.withinBudget, true);
    assert.equal(event.quotas.systemBudgetChars, 1200);
    assert.equal(event.quotas.systemCharsUsed, system.length, '诊断报的 system 字符数就是实际请求');
    assert.equal(event.charsUsed, body.length, '诊断报的请求体长度就是实际请求');
    assert.deepEqual(event.quotas.dropped, ['recent', 'memory'], '预算按顺序裁掉 recent 与 memory');
    assert.equal(event.roundsAvailable, 2);
    assert.equal(event.roundsKept, 1);
    assert.equal(event.roundsDropped, 1);
    assert.equal(event.topicsDropped, 1);

    // 脱敏：诊断行不能带账号、正文、URL 或路径。
    const line = budgetLines(logs)[0];
    for (const marker of [
      OWNER,
      'SEEDED_',
      text,
      'role.md',
      'model.invalid',
      dir,
      'private:',
    ]) {
      assert.equal(line.includes(marker), false, '预算日志不得包含：' + marker);
    }
    assert.equal(errors.length, 0);

    proc.emit('SIGINT');
    assert.deepEqual(proc.exits, [0]);
  } finally {
    started?.proc?.emit('SIGINT');
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 非法值：宽松与 owner-private 都在副作用前停下 ───────────

test('非法 systemBudgetChars：宽松与 --owner-private 同检查，且不读角色卡/不建 Memory/不连 OneBot', async (t) => {
  const invalid = [
    null, 0, -1, 1.5, '1200', true, false, [], {}, 24001, 1e9, SENTINEL,
  ];
  const modes = [
    { label: '宽松', argv: [] },
    { label: 'owner-private', argv: ['--owner-private'] },
  ];

  const logs = [];
  const errors = [];
  let fetchCalls = 0;
  t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('非法预算不得走到模型或 OneBot');
  });
  const originalRead = fs.readFileSync;
  const readPaths = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    readPaths.push(path.resolve(String(file)));
    return originalRead(file, ...args);
  });

  for (const mode of modes) {
    for (const value of invalid) {
      const dir = makeTempDir();
      try {
        const { file, roleCard } = writeConfig(dir, baseConfig({
          memory: { systemBudgetChars: value },
        }));
        const logBefore = logs.length;
        const errorBefore = errors.length;
        const readBefore = readPaths.length;
        const fetchBefore = fetchCalls;
        let botCalls = 0;

        const result = await main({
          createBot: () => { botCalls += 1; return {}; },
          proc: makeProc(['--config', file, ...mode.argv]),
        });

        const label = mode.label + ' / ' + String(value);
        assert.equal(result.ok, false, label + '：返回失败');
        assert.equal(result.bot, null, label + '：不返回 bot');
        assert.deepEqual(result.systemBudget, {
          enabled: false,
          ok: false,
          code: SYSTEM_BUDGET_CODES.INVALID,
        }, label + '：固定原因码');
        if (mode.argv.includes('--owner-private')) {
          assert.deepEqual(result.ownerPrivate, { enabled: true, ok: true, ownerIds: [OWNER] }, label + '：配置闸门本身已通过');
        } else {
          assert.equal(result.ownerPrivate, null, label + '：宽松路径没有准入器');
        }
        assert.equal(botCalls, 0, label + '：没有构造 OneBot');
        assert.equal(fs.existsSync(path.join(dir, 'data')), false, label + '：没有创建 Memory/data');
        assert.equal(fetchCalls, fetchBefore, label + '：没有模型/OneBot 请求');
        assert.equal(logs.length, logBefore, label + '：不打印启动横幅');
        assert.equal(errors.length, errorBefore + 1, label + '：只报一条固定错误');
        assert.equal(errors.at(-1), '[配置] ' + SYSTEM_BUDGET_CONFIG_ERROR, label + '：完整固定文案');
        assert.equal(errors.at(-1).includes(SENTINEL), false, label + '：不复述唯一哨兵值');
        assert.equal(errors.at(-1).includes(dir), false, label + '：不回显路径或配置');
        assert.equal(readPaths.slice(readBefore).includes(roleCard), false, label + '：失败发生在读角色卡之前');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  assert.equal(logs.length, 0, '所有失败都没有启动横幅');
});

// ── 5. CLI 退出码：固定错误、非零退出、不回显值 ────────────────

test('CLI 非法 systemBudgetChars：exit=1，stderr 只有固定文案', () => {
  const dir = makeTempDir();
  try {
    const { file } = writeConfig(dir, baseConfig({
      memory: { systemBudgetChars: 24001 },
    }));
    const result = spawnSync(
      process.execPath,
      [INDEX_PATH, '--owner-private', '--config', file],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.status, 1, '预算闸门失败必须非零退出');
    assert.equal(result.stderr.trim(), '[配置] ' + SYSTEM_BUDGET_CONFIG_ERROR);
    assert.equal(result.stderr.includes('24001'), false, 'stderr 不复述非法值');
    assert.equal(result.stderr.includes(dir), false, 'stderr 不回显路径');
    assert.equal(result.stdout.includes('════'), false, '失败前不打印启动横幅');
    assert.equal(result.stdout.includes('提示词预算'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});