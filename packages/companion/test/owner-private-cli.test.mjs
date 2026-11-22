/**
 * 主人私聊准入 · owner-private 离线验收
 * ─────────────────────────────────────────────────────────────
 * 只从真实入口 `main()` 出发，外部世界全部换成可审计的替身：
 *
 *   - 真 OneBot 传输 + 假 WebSocket：合成事件用 OneBot v11 的原始 JSON 形状
 *     （post_type / message_type / user_id / group_id / message 段 / sender），
 *     由 transport-onebot.js 自己归一化后进入入口；不连真 QQ、不开端口。
 *   - 假模型：globalThis.fetch 只回内存响应；模型请求体、发送请求体都可检查。
 *   - 临时目录：config.json / role.md / data/ 全在 mkdtemp 里，不读真实配置，
 *     不碰仓库 data/。
 *   - 假 process：argv / on / exit 只记录；SIGINT 仍走 main 里的真实处理。
 *
 * 覆盖点：
 *   1. 配置不可读 / 非 JSON / 非 object / 无有效 ownerIds → 在 Memory 与 OneBot
 *      之前失败，固定文案不回显配置或路径，CLI 非零退出；
 *   2. 带 flag 时，群聊、非主人私聊、缺失或矛盾的会话标识都在入口拒绝，
 *      不进入 presence / waker / 模型 / 记忆 / 任务 / 发送，日志不含正文；
 *   3. 白名单私聊正常进入：presence 刷新、模型调用、记忆落账、私聊发送；
 *   4. 任务路径同样受入口闸门保护：被拒消息不建提醒，白名单消息可以建；
 *   5. 不带 flag 时旧行为不变：群聊主人消息仍会回，非主人私聊仍按活跃模式回。
 *
 * 不联网、不读真实配置与真实 data/、不调用真实模型、不发送 QQ 消息。
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

import { main } from '../src/index.js';
import { OneBot } from '../src/transport-onebot.js';
import {
  OWNER_PRIVATE_CONFIG_CODES,
  OWNER_PRIVATE_CONFIG_ERROR,
  OWNER_PRIVATE_REJECTIONS,
  createOwnerPrivateGate,
  loadOwnerPrivateConfig,
} from '../src/owner-private.js';

const OWNER = '10001';
const OTHER = '10002';
const STRANGER = '20002';
const GROUP_ID = '9001';
const START = 1_760_000_000_000;
const SECRET = '配置里的秘密-不能回显-8848';

const INDEX_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));

// data URL 内联 WebSocket stub：构造时记录参数与事件处理器，不建立任何连接。
// OneBot 的 #connect 会走 ws 的 EventEmitter 分支，因此只实现 on() 即可。
const wsStubUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.handlers = new Map();
    (globalThis.__ownerPrivateSockets ||= []).push(this);
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'owner-private-'));
}

function writeRole(dir) {
  fs.writeFileSync(path.join(dir, 'role.md'), '# 角色卡\n离线 owner-private 测试用的角色卡。\n');
}

function writeConfig(dir, cfg) {
  writeRole(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** 与 config.example.json 同形；模型与 OneBot 都指向不会真连的域名。 */
function baseConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://model.invalid/v1',
    model: 'fake-model',
    names: ['小满'],
    keywords: [],
    ownerIds: [OWNER, OTHER],
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

function presenceConfig(overrides = {}) {
  return {
    enabled: true,
    ownerId: OWNER,
    idleMs: 1000,
    awayMs: 5000,
    returnAfterMs: 0,
    workAfterMs: 1_000_000,
    cooldownMs: 0,
    minGapMs: 0,
    maxPerDay: 0,   // 不让 presence 主动发送，避免与入口发送断言混在一起
    quietHours: null,
    intentTtlMs: 10 * 60 * 1000,
    maxPending: 8,
    ...overrides,
  };
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

/**
 * 起一次真实 main()，createBot 注入「真 OneBot + 假 WebSocket」。
 * 这样合成的是 OneBot v11 原始事件，而不是直接喂归一化后的消息。
 */
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

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function memoryText(dir) {
  return readText(path.join(dir, 'data', 'turns.jsonl'))
    + readText(path.join(dir, 'data', 'people.json'));
}

function reminderFile(dir) {
  return path.join(dir, 'data', 'reminders.json');
}

/** 一条合成 OneBot v11 私聊事件（字段形状与真实 OneBot 上报一致）。 */
let eventSequence = 100;
function privateEvent({ userId = OWNER, text = '在吗', messageId, name = '小满' } = {}) {
  eventSequence += 1;
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 99999,
    user_id: Number(userId),
    message_id: messageId ?? eventSequence,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
    sender: { user_id: Number(userId), nickname: name, card: '' },
    time: Math.floor(START / 1000),
  };
}

/** 一条合成 OneBot v11 群聊事件。 */
function groupEvent({ userId = OWNER, groupId = GROUP_ID, text = '群里说话', name = '群友' } = {}) {
  eventSequence += 1;
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 99999,
    group_id: Number(groupId),
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

/** 直接喂归一化后的消息，用来构造传输层不会产出的坏会话标识。 */
function directMsg({ key, userId, isGroup = false, groupId = '', text = '坏会话' }) {
  return { key, userId, isGroup, groupId, text, name: '直接注入', messageId: '', time: START };
}

// ── 1. 配置闸门（单元）────────────────────────────────────────

test('loadOwnerPrivateConfig：严格读取，四类失败都返回固定码', () => {
  const dir = makeTempDir();
  try {
    const validPath = path.join(dir, 'valid.json');
    fs.writeFileSync(validPath, JSON.stringify({
      ownerIds: [10001, ' 10002 ', '', null, 10001, 0, -1, 1.5, '0', '001', 'abc'],
    }));
    const valid = loadOwnerPrivateConfig(validPath);
    assert.equal(valid.ok, true);
    assert.equal(valid.file, validPath);
    assert.deepEqual(valid.ownerIds, [OWNER, OTHER], '规范十进制、去空白、去重、忽略非法项');
    assert.deepEqual(
      valid.config.ownerIds,
      [10001, ' 10002 ', '', null, 10001, 0, -1, 1.5, '0', '001', 'abc'],
      '原始配置不被改写',
    );

    assert.deepEqual(loadOwnerPrivateConfig(path.join(dir, 'missing.json')), {
      ok: false,
      code: OWNER_PRIVATE_CONFIG_CODES.UNREADABLE,
    });

    const badJson = path.join(dir, 'bad.json');
    fs.writeFileSync(badJson, '{"ownerIds":["' + OWNER + '"],');
    assert.deepEqual(loadOwnerPrivateConfig(badJson), {
      ok: false,
      code: OWNER_PRIVATE_CONFIG_CODES.INVALID_JSON,
    });

    const notObjects = [[], 'x', 42, null, true];
    for (let i = 0; i < notObjects.length; i += 1) {
      const file = path.join(dir, 'not-object-' + i + '.json');
      fs.writeFileSync(file, JSON.stringify(notObjects[i]));
      assert.deepEqual(loadOwnerPrivateConfig(file), {
        ok: false,
        code: OWNER_PRIVATE_CONFIG_CODES.NOT_OBJECT,
      });
    }

    const noOwnerIds = [
      {},
      { ownerIds: [] },
      { ownerIds: ['', '  ', null, {}, [], true] },
      { ownerIds: [0, -1, 1.5, '0', '001', 'abc'] },
      { ownerIds: '10001' },
    ];
    for (let i = 0; i < noOwnerIds.length; i += 1) {
      const file = path.join(dir, 'no-owner-' + i + '.json');
      fs.writeFileSync(file, JSON.stringify(noOwnerIds[i]));
      assert.deepEqual(loadOwnerPrivateConfig(file), {
        ok: false,
        code: OWNER_PRIVATE_CONFIG_CODES.NO_OWNER_IDS,
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. 入口准入（单元）────────────────────────────────────────

test('createOwnerPrivateGate：只放行白名单私聊，拒绝群聊 / 非主人 / 坏会话标识', () => {
  const gate = createOwnerPrivateGate({ ownerIds: [OWNER, OTHER, OWNER, '', null, 0, 'abc'] });
  assert.deepEqual(gate.ownerIds, [OWNER, OTHER]);

  const good = (overrides = {}) => ({
    key: 'private:' + OWNER,
    isGroup: false,
    groupId: '',
    userId: OWNER,
    ...overrides,
  });

  assert.deepEqual(gate.admit(good()), { ok: true, userId: OWNER, key: 'private:' + OWNER });
  assert.deepEqual(
    gate.admit(good({ userId: OTHER, key: 'private:' + OTHER })),
    { ok: true, userId: OTHER, key: 'private:' + OTHER },
  );

  const rejected = [
    [null, OWNER_PRIVATE_REJECTIONS.NOT_OBJECT],
    ['not-an-object', OWNER_PRIVATE_REJECTIONS.NOT_OBJECT],
    [good({ isGroup: true }), OWNER_PRIVATE_REJECTIONS.GROUP],
    [good({ isGroup: undefined }), OWNER_PRIVATE_REJECTIONS.GROUP],
    [good({ isGroup: 0 }), OWNER_PRIVATE_REJECTIONS.GROUP],
    [good({ userId: '' }), OWNER_PRIVATE_REJECTIONS.MISSING_USER],
    [good({ userId: {} }), OWNER_PRIVATE_REJECTIONS.MISSING_USER],
    [good({ key: '' }), OWNER_PRIVATE_REJECTIONS.MISSING_SESSION],
    [good({ key: undefined }), OWNER_PRIVATE_REJECTIONS.MISSING_SESSION],
    [good({ key: 'group:' + GROUP_ID }), OWNER_PRIVATE_REJECTIONS.NOT_PRIVATE],
    [good({ key: 'private:' }), OWNER_PRIVATE_REJECTIONS.MISSING_SESSION],
    [good({ key: 'private:' + OTHER }), OWNER_PRIVATE_REJECTIONS.SESSION_MISMATCH],
    [good({ groupId: GROUP_ID }), OWNER_PRIVATE_REJECTIONS.SESSION_MISMATCH],
    [good({ groupId: Number(GROUP_ID) }), OWNER_PRIVATE_REJECTIONS.SESSION_MISMATCH],
    [good({ userId: STRANGER, key: 'private:' + STRANGER }), OWNER_PRIVATE_REJECTIONS.NOT_OWNER],
  ];
  for (const [msg, reason] of rejected) {
    assert.deepEqual(gate.admit(msg), { ok: false, reason });
  }
});

// ── 3. 配置失败：Memory / OneBot 之前停下 ─────────────────────

test('--owner-private 配置失败：不建 Memory、不建 OneBot、固定文案不回显', async (t) => {
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });

  const cases = [
    {
      name: 'missing',
      write: () => {},
      code: OWNER_PRIVATE_CONFIG_CODES.UNREADABLE,
    },
    {
      name: 'invalid-json',
      write: (dir) => fs.writeFileSync(
        path.join(dir, 'config.json'),
        '{"ownerIds":["' + OWNER + '"],"apiKey":"' + SECRET,
      ),
      code: OWNER_PRIVATE_CONFIG_CODES.INVALID_JSON,
    },
    {
      name: 'array',
      write: (dir) => fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify([{ apiKey: SECRET }]),
      ),
      code: OWNER_PRIVATE_CONFIG_CODES.NOT_OBJECT,
    },
    {
      name: 'no-owner-ids',
      write: (dir) => fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ apiKey: SECRET, dataDir: './data' }),
      ),
      code: OWNER_PRIVATE_CONFIG_CODES.NO_OWNER_IDS,
    },
    {
      name: 'blank-owner-ids',
      write: (dir) => fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ apiKey: SECRET, dataDir: './data', ownerIds: ['', '  ', null, {}, true] }),
      ),
      code: OWNER_PRIVATE_CONFIG_CODES.NO_OWNER_IDS,
    },
    {
      name: 'owner-ids-not-array',
      write: (dir) => fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ apiKey: SECRET, dataDir: './data', ownerIds: OWNER }),
      ),
      code: OWNER_PRIVATE_CONFIG_CODES.NO_OWNER_IDS,
    },
  ];

  for (const item of cases) {
    const dir = makeTempDir();
    try {
      item.write(dir);
      const logBefore = logs.length;
      const errorBefore = errors.length;
      const proc = makeProc(['--config', path.join(dir, 'config.json'), '--owner-private']);
      let botCalls = 0;
      const result = await main({
        createBot: () => { botCalls += 1; return {}; },
        proc,
      });

      assert.equal(result.ok, false, item.name + '：返回失败');
      assert.deepEqual(result.ownerPrivate, { enabled: true, ok: false, code: item.code });
      assert.equal(result.bot, null);
      assert.equal(botCalls, 0, item.name + '：没有构造 OneBot');
      assert.equal(fs.existsSync(path.join(dir, 'data')), false, item.name + '：没有构造 Memory');
      assert.equal(logs.length, logBefore, item.name + '：失败不打印启动横幅');
      assert.equal(errors.length, errorBefore + 1, item.name + '：只报一条固定错误');
      assert.equal(errors.at(-1), '[owner-private] ' + OWNER_PRIVATE_CONFIG_ERROR);
      assert.equal(errors.at(-1).includes(SECRET), false, item.name + '：不回显配置内容');
      assert.equal(errors.at(-1).includes(dir), false, item.name + '：不回显配置路径');
      assert.deepEqual(proc.exits, [], item.name + '：main 自己不算退出');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('CLI --owner-private 配置失败：退出码 1，stderr 只有固定文案', () => {
  const dir = makeTempDir();
  try {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ apiKey: SECRET, ownerIds: [] }));
    const result = spawnSync(
      process.execPath,
      [INDEX_PATH, '--owner-private', '--config', configPath],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.status, 1, '配置闸门失败必须非零退出');
    assert.equal(result.stderr.trim(), '[owner-private] ' + OWNER_PRIVATE_CONFIG_ERROR);
    assert.equal(result.stderr.includes(SECRET), false, 'stderr 不回显配置');
    assert.equal(result.stdout.includes(SECRET), false, 'stdout 不回显配置');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 入口闸门 + 下游零接触 ─────────────────────────────────

test('--owner-private：被拒消息不进入 presence/waker/模型/记忆/发送，白名单私聊正常', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, baseConfig({
    presenceQQ: presenceConfig(),
  }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  const net = installFetch(t);

  let started = null;
  try {
    started = await startRealOneBotMain({ configPath, argv: ['--owner-private'] });
    const { run, proc, bot, socket } = started;
    assert.equal(run.ok, true);
    assert.deepEqual(run.ownerPrivate, {
      enabled: true,
      ok: true,
      ownerIds: [OWNER, OTHER],
    });
    assert.equal(run.presence.status, 'ready');
    assert.equal(run.presence.state, 'unknown');
    assert.equal(typeof bot?.onMessage, 'function');
    assert.ok(socket, '真 OneBot 已用假 WebSocket 构造');

    const allLogs = () => logs.concat(errors);

    // ── 4.1 先来三条被拒消息：presence 仍是 unknown，模型/发送/记忆全为零 ──
    const rejectedBefore = [
      {
        label: '群聊（主人）',
        deliver: () => emit(socket, groupEvent({ userId: OWNER, text: '群聊暗号-拒绝-一' })),
        body: '群聊暗号-拒绝-一',
      },
      {
        label: '非主人私聊',
        deliver: () => emit(socket, privateEvent({ userId: STRANGER, text: '陌生人暗号-拒绝-一' })),
        body: '陌生人暗号-拒绝-一',
      },
      {
        label: '缺会话标识',
        deliver: () => bot.onMessage(directMsg({ key: '', userId: OWNER, text: '缺会话-拒绝-一' })),
        body: '缺会话-拒绝-一',
      },
      {
        label: '会话与用户不一致',
        deliver: () => bot.onMessage(directMsg({ key: 'private:' + OTHER, userId: OWNER, text: '错会话-拒绝-一' })),
        body: '错会话-拒绝-一',
      },
      {
        label: '私聊带群号',
        deliver: () => bot.onMessage(directMsg({
          key: 'private:' + OWNER,
          userId: OWNER,
          groupId: GROUP_ID,
          text: '带群号-拒绝-一',
        })),
        body: '带群号-拒绝-一',
      },
      {
        label: '缺 isGroup',
        deliver: () => bot.onMessage({
          key: 'private:' + OWNER,
          userId: OWNER,
          text: '缺isGroup-拒绝-一',
        }),
        body: '缺isGroup-拒绝-一',
      },
    ];

    for (const item of rejectedBefore) {
      item.deliver();
      await flushWindow(t);
      assert.equal(net.model().length, 0, item.label + '：没有进入模型');
      assert.equal(net.sends().length, 0, item.label + '：没有发送');
      assert.equal(run.presence.state, 'unknown', item.label + '：没有进入 presence');
      assert.equal(memoryText(dir).includes(item.body), false, item.label + '：没有进入记忆');
      assert.equal(allLogs().some((line) => line.includes(item.body)), false, item.label + '：日志不含正文');
    }
    assert.equal(fs.existsSync(path.join(dir, 'data', 'turns.jsonl')), false, '被拒消息没有落任何对话');

    // ── 4.2 白名单私聊：presence / 模型 / 记忆 / 发送全部正常 ──
    const firstBody = '主人暗号-放行-一';
    emit(socket, privateEvent({ userId: OWNER, text: firstBody }));
    await flushWindow(t);

    assert.equal(net.model().length, 1, '白名单私聊进入模型');
    assert.match(net.model()[0].body, new RegExp(firstBody, 'u'));
    assert.equal(net.sends().length, 1, '模型回复发出一次');
    assert.equal(JSON.parse(net.sends()[0].body).user_id, OWNER, '私聊发回主人');
    assert.equal(run.presence.state, 'present', 'presence 刷新为 present');
    assert.match(memoryText(dir), new RegExp(firstBody, 'u'), '记忆落账');
    assert.match(memoryText(dir), /离线回复/u);

    // ── 4.3 另一个白名单账号也可进入（白名单不是「只有 presence owner」）──
    const otherBody = '白名单二号-放行';
    emit(socket, privateEvent({ userId: OTHER, text: otherBody }));
    await flushWindow(t);
    assert.equal(net.model().length, 2);
    assert.equal(net.sends().length, 2);
    assert.equal(JSON.parse(net.sends()[1].body).user_id, OTHER);
    assert.match(memoryText(dir), new RegExp(otherBody, 'u'));
    assert.equal(run.presence.state, 'present', '非 presence owner 的白名单消息不会破坏状态');

    // ── 4.4 离开后再来被拒消息：presence 仍是 away，不被刷新 ──
    const away = await run.presence.settle({ at: START + 6000 });
    assert.equal(away.state, 'away');
    t.mock.timers.tick(6000);   // 让 Date.now 也到 START+6000
    await settle(2);

    const rejectedAfter = [
      {
        label: '离开后的群聊',
        deliver: () => emit(socket, groupEvent({ userId: OWNER, text: '群聊暗号-拒绝-二' })),
        body: '群聊暗号-拒绝-二',
      },
      {
        label: '离开后的非主人',
        deliver: () => emit(socket, privateEvent({ userId: STRANGER, text: '陌生人暗号-拒绝-二' })),
        body: '陌生人暗号-拒绝-二',
      },
    ];
    for (const item of rejectedAfter) {
      item.deliver();
      await flushWindow(t);
      assert.equal(run.presence.state, 'away', item.label + '：没有刷新 presence');
      assert.equal(net.model().length, 2, item.label + '：没有进入模型');
      assert.equal(net.sends().length, 2, item.label + '：没有发送');
      assert.equal(memoryText(dir).includes(item.body), false, item.label + '：没有进入记忆');
      assert.equal(allLogs().some((line) => line.includes(item.body)), false, item.label + '：日志不含正文');
    }

    // ── 4.5 白名单私聊把 away 拉回 present，闸门没有卡死 ──
    const secondBody = '主人暗号-放行-二';
    emit(socket, privateEvent({ userId: OWNER, text: secondBody }));
    await flushWindow(t);
    assert.equal(run.presence.state, 'present');
    assert.equal(net.model().length, 3);
    assert.equal(net.sends().length, 3);
    assert.match(memoryText(dir), new RegExp(secondBody, 'u'));

    // 全程：被拒正文没有出现在任何模型请求或发送请求里。
    const allRequestText = net.calls.map((call) => call.body).join('\n');
    for (const item of rejectedBefore.concat(rejectedAfter)) {
      assert.equal(allRequestText.includes(item.body), false, item.label + '：请求体不含被拒正文');
    }

    proc.emit('SIGINT');
    assert.deepEqual(proc.exits, [0]);
  } finally {
    started?.proc?.emit('SIGINT');
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. 任务路径同样受入口闸门保护 ────────────────────────────

test('--owner-private + --reminders：被拒消息不建提醒，白名单消息可以建', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, baseConfig({ ownerIds: [OWNER] }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const errors = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  const net = installFetch(t);

  let started = null;
  try {
    started = await startRealOneBotMain({
      configPath,
      argv: ['--owner-private', '--reminders'],
    });
    const { run, proc, bot, socket } = started;
    assert.equal(run.ok, true);
    assert.equal(run.reminders?.active, true);
    assert.equal(run.reminders?.running, true);
    assert.equal(fs.existsSync(reminderFile(dir)), false, '开始时没有提醒快照');

    const command = '5分钟后提醒我喝水';

    // 群聊 / 非主人 / 坏会话：都不应进入命令分类，也不落盘。
    emit(socket, groupEvent({ userId: OWNER, text: command }));
    await flushWindow(t);
    emit(socket, privateEvent({ userId: STRANGER, text: command }));
    await flushWindow(t);
    bot.onMessage(directMsg({ key: 'private:' + OWNER, userId: OTHER, text: command }));
    await flushWindow(t);

    assert.equal(fs.existsSync(reminderFile(dir)), false, '被拒消息没有建提醒');
    assert.equal(net.sends().length, 0, '被拒消息没有确认发送');
    assert.equal(net.model().length, 0, '被拒命令没有掉进模型');
    assert.equal(errors.some((line) => line.includes(command)), false, '拒绝日志不含正文');

    // 白名单私聊：命令落盘 + 确认发送，不走模型。
    emit(socket, privateEvent({ userId: OWNER, text: command }));
    await flushWindow(t);

    const file = reminderFile(dir);
    assert.equal(fs.existsSync(file), true, '白名单命令已落盘');
    const records = JSON.parse(fs.readFileSync(file, 'utf8')).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].conversationKey, 'private:' + OWNER);
    assert.equal(records[0].text, '喝水');
    assert.equal(records[0].status, 'queued');

    assert.equal(net.sends().length, 1, '只回一条确认');
    assert.equal(JSON.parse(net.sends()[0].body).user_id, OWNER);
    assert.match(net.sends()[0].body, /好，到点提醒你：喝水/u);
    assert.equal(net.model().length, 0, '命令没有进入模型');

    run.reminders.stop();
    assert.equal(run.reminders.running, false);
    proc.emit('SIGINT');
    assert.deepEqual(proc.exits, [0]);
  } finally {
    started?.run?.reminders?.stop();
    started?.proc?.emit('SIGINT');
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. 不带 flag：旧行为不变 ─────────────────────────────────

test('不带 --owner-private：群聊主人仍会回，非主人私聊仍按活跃模式回', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, baseConfig({ ownerIds: [OWNER] }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const net = installFetch(t);

  let started = null;
  try {
    started = await startRealOneBotMain({ configPath, argv: [] });
    const { run, proc, socket } = started;
    assert.equal(run.ok, true);
    assert.equal(run.ownerPrivate, null, '没有 flag 时不启用准入器');

    // 旧行为：群聊里的主人消息命中 owner 规则 → 合并窗口后回一条群消息。
    emit(socket, groupEvent({ userId: OWNER, text: '旧行为-群主人' }));
    await flushWindow(t);
    assert.equal(net.model().length, 1, '群聊主人仍进入模型');
    assert.equal(net.sends().length, 1);
    assert.equal(JSON.parse(net.sends()[0].body).group_id, GROUP_ID, '仍发回群里');

    // 旧行为：私聊默认活跃模式，非主人私聊也会回。
    emit(socket, privateEvent({ userId: STRANGER, text: '旧行为-非主人私聊' }));
    await flushWindow(t);
    assert.equal(net.model().length, 2, '非主人私聊仍进入模型');
    assert.equal(net.sends().length, 2);
    assert.equal(JSON.parse(net.sends()[1].body).user_id, STRANGER, '仍发回私聊对方');

    // 旧行为：群聊非主人、无 @/名字/关键词 → 静音，不进入模型。
    emit(socket, groupEvent({ userId: STRANGER, text: '旧行为-群静音' }));
    await flushWindow(t);
    assert.equal(net.model().length, 2, '群聊静音规则不变');
    assert.equal(net.sends().length, 2);

    proc.emit('SIGINT');
    assert.deepEqual(proc.exits, [0]);
  } finally {
    started?.proc?.emit('SIGINT');
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
