/**
 * QQ 在场入口接线 · 离线验收
 * ─────────────────────────────────────────────────────────────
 * 只碰临时目录、假 OneBot、假 process、可注入时钟与合成信号：
 *   - 默认关闭 / --dry-run / owner 缺失或不在白名单 → 不建发送、不落盘、不广播；
 *   - 显式开启 + 合成信号 → 完整 presence 管线生成 intent，只投递给唯一 owner，
 *     状态文件只含 PresenceStateStore 的白名单字段，不含任何正文；
 *   - 重启后冷却与 ledger 仍然生效，不重放旧事件、不补发旧欢迎；
 *   - 选定 owner 的普通私聊会作废旧 pending intent、刷新活动，但不自指欢迎；
 *     群聊 / 非 owner 私聊不触发任何 presence 主动发送；
 *   - failed / unknown 回执不重试；写盘失败绝不发送，并返回固定诊断码。
 *
 * 不联网、不读真实配置与真实 data/、不调用模型、不发送 QQ 消息。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { main } from '../src/index.js';
import { Humanizer } from '../src/humanize.js';
import { PresenceStateStore } from '../src/presence/persistence.js';
import {
  PRESENCE_QQ_DIAGNOSTIC_CODES,
  PRESENCE_QQ_STATE_FILE,
  createPresenceQQHost,
} from '../src/presence-qq-runtime.js';

const OWNER = '10001';
const OTHER = '10002';
const STRANGER = '20002';
const START = 1_760_000_000_000;
const WELCOME_TEXT = '你回来啦，我在呢。';
/** PresenceStateStore.save() 允许出现的全部顶层字段（白名单）。 */
const STATE_KEYS = [
  'activeMs',
  'cooldowns',
  'deliveredIds',
  'kind',
  'sessionStartedAt',
  'state',
  'updatedAt',
  'version',
];
const COOLDOWN_MS = 90 * 60 * 1000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'index-presence-'));
}

/** 与 config.example.json 同形的 presenceQQ 配置；测试里把时间压小。 */
function basePresenceQQ(overrides = {}) {
  return {
    enabled: true,
    ownerId: OWNER,
    idleMs: 1000,
    awayMs: 5000,
    returnAfterMs: 0,
    workAfterMs: 1_000_000,
    cooldownMs: 0,
    minGapMs: 0,
    maxPerDay: 5,
    quietHours: null,
    intentTtlMs: 10 * 60 * 1000,
    maxPending: 8,
    ...overrides,
  };
}

function writeConfig(dir, { presenceQQ, ownerIds = [OWNER, OTHER] } = {}) {
  fs.writeFileSync(path.join(dir, 'role.md'), '# 角色卡\n离线入口测试用的角色卡。\n');
  const cfg = {
    // 模型永远不会被调用；留空只为覆盖「没配 apiKey」的启动分支。
    apiKey: '',
    names: ['小满'],
    ownerIds,
    dataDir: './data',
    // 私聊窗口故意拉长：owner 消息只验证 presence 钩子，不触发 Brain。
    wake: { probability: 0, privateWindowMs: 600_000, groupWindowMs: 600_000 },
    humanize: { enabled: false },
  };
  if (presenceQQ !== undefined) cfg.presenceQQ = presenceQQ;
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return configPath;
}

function makeBot(receipt = () => ({ receipt: { status: 'confirmed', messageId: '9001' } })) {
  const sentPrivate = [];
  const sentChat = [];
  const typing = [];
  return {
    sentPrivate,
    sentChat,
    typing,
    async sendPrivateText(userId, text) {
      sentPrivate.push({ userId, text });
      return receipt(userId, text);
    },
    async send(key, text) {
      sentChat.push({ key, text });
      return { receipt: { status: 'confirmed', messageId: '9002' } };
    },
    async setTyping(key, on) {
      typing.push({ key, on });
      return { ok: true };
    },
  };
}

async function startMain(configPath, { argv = [], bot = makeBot() } = {}) {
  const builds = [];
  const proc = new EventEmitter();
  proc.argv = ['node', 'src/index.js', '--config', configPath, ...argv];
  proc.exits = [];
  proc.exit = (code) => { proc.exits.push(code); };
  const run = await main({ createBot: (options) => { builds.push(options); return bot; }, proc });
  return { run, bot, proc, builds };
}

let messageSequence = 0;
function privateMsg({ userId = OWNER, text = '在吗' } = {}) {
  messageSequence += 1;
  return {
    key: 'private:' + userId,
    isGroup: false,
    groupId: '',
    userId,
    name: '小满',
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId: 'p-' + userId + '-' + messageSequence,
    time: Math.floor(START / 1000),
  };
}

function groupMsg({ userId = OWNER, text = '群里说话' } = {}) {
  messageSequence += 1;
  return {
    key: 'group:9',
    isGroup: true,
    groupId: '9',
    userId,
    name: '群友',
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId: 'g-' + messageSequence,
    time: Math.floor(START / 1000),
  };
}

function unitConfig(dir, { presenceQQ = {}, ownerIds = [OWNER, OTHER], dataDir, dryRun = false } = {}) {
  return {
    dataDir: dataDir === undefined ? path.join(dir, 'data') : dataDir,
    dryRun,
    ownerIds,
    presenceQQ: basePresenceQQ(presenceQQ),
  };
}

function unitHost(cfg, { receipt = () => undefined, store = null, nowRef = { value: START }, human, bot } = {}) {
  const sent = [];
  const typing = [];
  const fakeBot = bot || {
    async sendPrivateText(userId, text) {
      sent.push({ userId, text });
      return receipt(userId, text);
    },
    async setTyping(key, on) {
      typing.push({ key, on });
      return { ok: true };
    },
  };
  const host = createPresenceQQHost({
    cfg,
    bot: fakeBot,
    human: human === undefined ? new Humanizer({ enabled: false }) : human,
    now: () => nowRef.value,
    store,
  });
  return { host, sent, typing, bot: fakeBot };
}

/**
 * 仍然是一个真的 PresenceStateStore（白名单 schema 由父类保管），只把 load/save
 * 换成可编程的替身，用来构造「读不出来 / 写不进去」的失败路径。
 */
class StubStore extends PresenceStateStore {
  constructor(file, {
    loadResult = { ok: true, state: null, diagnostics: [{ code: 'absent' }] },
    saveResult = { ok: true, persisted: true },
    throwOnLoad = false,
    throwOnSave = false,
    errorMessage = 'stub-store-failure',
  } = {}) {
    super({ file, now: () => START });
    this.loadResult = loadResult;
    this.saveResult = saveResult;
    this.throwOnLoad = throwOnLoad;
    this.throwOnSave = throwOnSave;
    this.errorMessage = errorMessage;
  }

  load() {
    if (this.throwOnLoad) throw new Error(this.errorMessage);
    return this.loadResult;
  }

  save() {
    if (this.throwOnSave) throw new Error(this.errorMessage);
    return this.saveResult;
  }
}

function memoryStore(file) {
  return new StubStore(file);
}

/** 一次完整的「离开 → 回来」：产生 welcome-back intent 并尝试投递。 */
async function driveAwayAndBack(host, base = START) {
  await host.observe({ kind: 'activity', at: base });
  await host.settle({ at: base + 6000 });
  return host.observe({ kind: 'activity', at: base + 12000 });
}

test('入口：没有 presenceQQ 配置时完全关闭，旧返回值形状不变', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir);
  t.mock.method(console, 'log', () => {});
  const { run, bot, proc } = await startMain(configPath);
  try {
    assert.equal(run.bot, bot, '旧的 { bot } 仍然返回');
    assert.equal(run.reminders, null, '旧的 { reminders } 仍然返回');
    assert.equal(run.presence.enabled, false);
    assert.equal(run.presence.status, 'disabled');
    assert.equal(run.presence.ownerId, null);
    assert.deepEqual(run.presence.diagnostics, [{ code: PRESENCE_QQ_DIAGNOSTIC_CODES.DISABLED }]);

    const observed = await run.presence.observe({ kind: 'activity', at: START });
    assert.equal(observed.ok, false);
    assert.equal(observed.status, 'disabled');
    const settled = await run.presence.settle({ at: START + 1 });
    assert.equal(settled.status, 'disabled');
    const ticked = await run.presence.tick(START);
    assert.equal(ticked.status, 'disabled');
    assert.equal(run.presence.onIncomingMessage({ isGroup: false, userId: OWNER, text: 'hi' }).ignored, true);

    assert.deepEqual(bot.sentPrivate, [], '默认关闭不发送私聊');
    assert.deepEqual(bot.sentChat, [], '默认关闭不掉进普通发送');
    assert.equal(fs.existsSync(path.join(dir, 'data', PRESENCE_QQ_STATE_FILE)), false, '默认关闭不落盘');
    assert.deepEqual(run.presence.close(), { ok: true, persisted: false, dropped: 0, alreadyClosed: true });
    assert.deepEqual(run.presence.close(), { ok: true, persisted: false, dropped: 0, alreadyClosed: true });
  } finally {
    proc.emit('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('入口：--dry-run 即使显式开启也不建 adapter、不落盘、不发送', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, { presenceQQ: basePresenceQQ() });
  t.mock.method(console, 'log', () => {});
  const { run, bot, proc } = await startMain(configPath, { argv: ['--dry-run'] });
  try {
    assert.equal(run.presence.status, 'dry-run');
    assert.equal(run.presence.enabled, false);
    assert.equal(run.presence.stateFile, null);
    assert.deepEqual(run.presence.diagnostics, [{ code: PRESENCE_QQ_DIAGNOSTIC_CODES.DRY_RUN }]);
    assert.equal((await driveAwayAndBack(run.presence)).ok, false);
    assert.deepEqual(bot.sentPrivate, []);
    assert.equal(fs.existsSync(path.join(dir, 'data', PRESENCE_QQ_STATE_FILE)), false, '干跑不落盘');
  } finally {
    proc.emit('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('入口：owner 缺失 / 不在白名单时 fail-closed，多人白名单也不广播', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cases = [
    { presenceQQ: basePresenceQQ({ ownerId: '' }), status: 'owner-missing', code: PRESENCE_QQ_DIAGNOSTIC_CODES.OWNER_MISSING },
    { presenceQQ: basePresenceQQ({ ownerId: STRANGER }), status: 'owner-not-whitelisted', code: PRESENCE_QQ_DIAGNOSTIC_CODES.OWNER_NOT_WHITELISTED },
  ];
  for (const item of cases) {
    const dir = makeTempDir();
    const configPath = writeConfig(dir, { presenceQQ: item.presenceQQ });
    const { run, bot, proc } = await startMain(configPath);
    try {
      assert.equal(run.presence.status, item.status);
      assert.equal(run.presence.enabled, false);
      assert.equal(run.presence.ownerId, null);
      assert.deepEqual(run.presence.diagnostics, [{ code: item.code }]);
      const settled = await run.presence.settle({ at: START + 12000 });
      assert.equal(settled.ok, false);
      assert.deepEqual(bot.sentPrivate, [], '绝不退而求其次发给白名单里的其他人');
      assert.equal(fs.existsSync(path.join(dir, 'data', PRESENCE_QQ_STATE_FILE)), false);
    } finally {
      proc.emit('SIGINT');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('入口：显式开启 + 合成信号 → 只投递给唯一 owner，状态文件只含白名单字段', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, { presenceQQ: basePresenceQQ() });
  t.mock.method(console, 'log', () => {});
  const { run, bot, proc } = await startMain(configPath);
  try {
    assert.equal(run.presence.status, 'ready');
    assert.equal(run.presence.enabled, true);
    assert.equal(run.presence.ownerId, OWNER);
    assert.equal(run.presence.stateFile, path.join(dir, 'data', PRESENCE_QQ_STATE_FILE));

    const entered = await run.presence.observe({ kind: 'activity', at: START });
    assert.equal(entered.ok, true);
    assert.equal(entered.state, 'present');
    assert.deepEqual(entered.intents, []);

    const away = await run.presence.settle({ at: START + 6000 });
    assert.equal(away.state, 'away');
    assert.deepEqual(away.intents, []);

    const returned = await run.presence.observe({ kind: 'activity', at: START + 12000 });
    assert.equal(returned.state, 'present');
    assert.equal(returned.intents.length, 1, 'away → returned 产生一条 welcome-back');
    assert.equal(returned.intents[0].kind, 'welcome-back');
    assert.equal(returned.intents[0].id, 'presence-interaction:welcome-back:1');
    assert.deepEqual(returned.intents[0].text, undefined, '控制面不暴露 intent 正文');
    assert.equal(returned.routed.length, 1);
    assert.equal(returned.routed[0].accepted, true);
    assert.equal(returned.delivery.status, 'sent', '真实 confirmed 回执 → sent');

    assert.equal(bot.sentPrivate.length, 1, '只发一条主动消息');
    assert.equal(bot.sentPrivate[0].userId, OWNER, '目标只能是显式配置的 ownerId');
    assert.equal(bot.sentPrivate[0].text, WELCOME_TEXT);
    assert.deepEqual(bot.sentChat, [], '主动消息不走群聊/普通 send 通道');

    const idleTick = await run.presence.tick(START + 20000);
    assert.equal(idleTick.status, 'idle', '队列已空，宿主节拍不重发');

    const file = path.join(dir, 'data', PRESENCE_QQ_STATE_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    const state = JSON.parse(raw);
    assert.deepEqual(Object.keys(state).sort(), STATE_KEYS, '状态文件只有白名单字段');
    assert.equal(state.state, 'present');
    assert.equal(state.cooldowns.welcome, START + 12000, '欢迎冷却已落盘');
    assert.ok(
      state.deliveredIds.some((entry) => entry.endsWith('|sent|presence-interaction:welcome-back:1')),
      '投递台账已落盘',
    );
    assert.equal(raw.includes(WELCOME_TEXT), false, '状态文件不含正文');
    assert.equal(raw.includes('我在呢'), false, '状态文件不含正文片段');

    const closed = run.presence.close();
    assert.equal(closed.ok, true);
    assert.equal(closed.persisted, true);
    assert.equal(run.presence.closed, true);
  } finally {
    proc.emit('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重启：显式恢复冷却与 ledger，不重放事件、不补发旧欢迎', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, { presenceQQ: basePresenceQQ({ cooldownMs: COOLDOWN_MS }) });
  t.mock.method(console, 'log', () => {});
  const first = await startMain(configPath);
  try {
    const welcome = await driveAwayAndBack(first.run.presence);
    assert.equal(welcome.delivery.status, 'sent');
    assert.equal(first.bot.sentPrivate.length, 1);
    const closed = first.run.presence.close();
    assert.equal(closed.ok, true);
    assert.equal(closed.persisted, true);
    first.proc.emit('SIGINT');
    assert.equal(first.run.presence.closed, true);
    assert.deepEqual(first.proc.exits, [0], 'SIGINT 先关 presence 再退出');

    const file = path.join(dir, 'data', PRESENCE_QQ_STATE_FILE);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.cooldowns.welcome, START + 12000);

    const second = await startMain(configPath);
    try {
      assert.equal(second.run.presence.status, 'ready');
      assert.equal(second.run.presence.enabled, true);
      const stats = second.run.presence.stats;
      assert.equal(stats.session.restored, true, '启动时显式恢复成功');
      assert.equal(stats.session.ledgerEntries, persisted.deliveredIds.length, 'ledger 恢复');
      assert.equal(stats.session.cooldowns.welcome, START + 12000, '冷却恢复');
      assert.equal(stats.runtime.pendingEvents, 0, '未消费事件不重放');
      assert.deepEqual(second.bot.sentPrivate, [], '重启本身不发旧欢迎');

      // 第一轮：policy 重新从 :1 计数，ledger 里已有 → duplicate。
      const base = START + 30000;
      await second.run.presence.observe({ kind: 'activity', at: base });
      await second.run.presence.settle({ at: base + 6000 });
      const duplicateRound = await second.run.presence.observe({ kind: 'activity', at: base + 12000 });
      assert.deepEqual(duplicateRound.intents, [], 'ledger 命中，不出新 intent');

      // 第二轮：新的 intent id，但冷却仍在 90 分钟内 → 被会话闸门扣下。
      await second.run.presence.settle({ at: base + 24000 });
      const cooledRound = await second.run.presence.observe({ kind: 'activity', at: base + 30000 });
      assert.deepEqual(cooledRound.intents, [], '冷却命中，不出新 intent');
      assert.deepEqual(second.bot.sentPrivate, [], '重启后不补发、不重放');
      assert.equal(second.run.presence.pending, 0);
      assert.equal(second.run.presence.stats.session.ledgerEntries, persisted.deliveredIds.length, 'ledger 不增长');
    } finally {
      second.run.presence.close();
      second.proc.emit('SIGINT');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner 私聊：作废旧 pending、刷新活动且不自指欢迎；群聊/非 owner 不触发', async (t) => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    presenceQQ: basePresenceQQ({ maxPerDay: 0, cooldownMs: 0 }),
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  t.mock.method(console, 'log', () => {});
  const { run, bot, proc, builds } = await startMain(configPath);
  try {
    const presence = run.presence;
    assert.equal(presence.status, 'ready');
    const receive = builds[0].onMessage;
    assert.equal(typeof receive, 'function');

    // 日限额 0：intent 会一直排队，正是「陈旧待发」的场景。
    await presence.observe({ kind: 'activity', at: START });
    await presence.settle({ at: START + 6000 });
    const queued = await presence.observe({ kind: 'activity', at: START + 12000 });
    assert.equal(queued.delivery.status, 'daily-cap');
    assert.equal(presence.pending, 1);
    assert.deepEqual(bot.sentPrivate, []);

    t.mock.timers.tick(12000);
    receive(privateMsg({ text: '我回来了' }));
    assert.equal(presence.pending, 0, 'owner 消息作废了此前的 pending intent');
    assert.equal(presence.state, 'present', 'owner 消息刷新了活动状态');
    assert.deepEqual(bot.sentPrivate, [], 'owner 消息不生成自指欢迎');

    // 再造一条 pending，验证群聊 / 非 owner 私聊都不会动它。
    await presence.settle({ at: START + 18000 });
    const queuedAgain = await presence.observe({ kind: 'activity', at: START + 24000 });
    assert.equal(queuedAgain.delivery.status, 'daily-cap');
    assert.equal(presence.pending, 1);
    t.mock.timers.tick(12000);

    receive(groupMsg());
    assert.equal(presence.pending, 1, '群聊不能触发 presence 主动发送');
    receive(privateMsg({ userId: STRANGER, text: '你好' }));
    assert.equal(presence.pending, 1, '非 owner 私聊不能触发 presence 主动发送');
    assert.deepEqual(bot.sentPrivate, []);

    receive(privateMsg({ text: '还在吗' }));
    assert.equal(presence.pending, 0, 'owner 新消息再次作废旧 pending');
    assert.deepEqual(bot.sentPrivate, []);
  } finally {
    t.mock.timers.reset();
    proc.emit('SIGINT');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('投递回执：failed / unknown 不自动重试，缺回执最多 accepted', async () => {
  const dir = makeTempDir();
  try {
    const rejected = unitHost(unitConfig(path.join(dir, 'rejected')), { receipt: () => ({ ok: false, receipt: { status: 'rejected' } }) });
    const rejectedRound = await driveAwayAndBack(rejected.host);
    assert.equal(rejectedRound.delivery.status, 'failed');
    assert.equal(rejectedRound.delivery.sent, 0);
    assert.equal(rejected.sent.length, 1);
    assert.equal(rejected.sent[0].userId, OWNER);
    const afterRejected = await rejected.host.tick(START + 20000);
    assert.equal(afterRejected.status, 'idle');
    assert.equal(rejected.sent.length, 1, 'failed 不重试');

    const unknown = unitHost(unitConfig(path.join(dir, 'unknown')), { receipt: () => ({ ok: true, receipt: { status: 'unknown' } }) });
    const unknownRound = await driveAwayAndBack(unknown.host);
    assert.equal(unknownRound.delivery.status, 'unknown');
    assert.equal(unknown.sent.length, 1);
    await unknown.host.tick(START + 20000);
    assert.equal(unknown.sent.length, 1, 'unknown 不重试');

    // 本 fork 的 Humanizer.say 成功形状没有 message id：最多 accepted，绝不谎称 sent。
    const accepted = unitHost(unitConfig(path.join(dir, 'accepted')), { receipt: () => undefined });
    const acceptedRound = await driveAwayAndBack(accepted.host);
    assert.equal(acceptedRound.delivery.status, 'accepted');
    assert.equal(acceptedRound.delivery.confirmed, false);
    assert.equal(accepted.sent.length, 1);
    assert.equal(accepted.sent[0].userId, OWNER);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('发送始终经过 Humanizer（enabled 时先 setTyping，再走私聊通道）', async () => {
  const dir = makeTempDir();
  try {
    const human = new Humanizer({
      enabled: true,
      minMs: 0,
      maxMs: 0,
      msPerChar: 0,
      jitter: 0,
      gapRange: [0, 0],
      longGapChance: 0,
    });
    const { host, sent, typing } = unitHost(unitConfig(dir), {
      human,
      store: memoryStore(path.join(dir, 'humanizer-state.json')),
      receipt: () => ({ receipt: { status: 'confirmed', messageId: '77' } }),
    });
    const round = await driveAwayAndBack(host);
    assert.equal(round.delivery.status, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, OWNER);
    assert.deepEqual(typing, [
      { key: 'private:' + OWNER, on: true },
      { key: 'private:' + OWNER, on: false },
    ], 'Humanizer 的正在输入状态走同一个 owner 会话');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写盘失败：绝不发送，返回固定诊断码且不泄露异常 message', async () => {
  const dir = makeTempDir();
  try {
    const failing = unitHost(unitConfig(dir), {
      store: new StubStore(path.join(dir, 'failing-state.json'), {
        saveResult: { ok: false, persisted: false, error: 'io-error' },
      }),
    });
    assert.equal(failing.host.status, 'ready');
    const observed = await failing.host.observe({ kind: 'activity', at: START });
    assert.equal(observed.ok, false);
    assert.equal(observed.status, 'state-save-failed');
    assert.deepEqual(observed.diagnostics, [{ code: PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_SAVE_FAILED }]);
    assert.deepEqual(failing.sent, [], '落盘失败绝不发送');

    // 让 owner 消息真的触发状态变化（away → present），确认这一拍也不会发送。
    await failing.host.settle({ at: START + 6000 });
    const ownerMessage = failing.host.onIncomingMessage({ isGroup: false, userId: OWNER, text: '在吗' });
    assert.equal(ownerMessage.status, 'state-save-failed');
    assert.equal(ownerMessage.suppressedIntents, 1, '自指欢迎被扣下且没有发送');
    assert.deepEqual(failing.sent, []);

    const closed = failing.host.close();
    assert.equal(closed.ok, false);
    assert.equal(closed.persisted, false);
    assert.deepEqual(failing.host.close(), { ok: true, persisted: false, dropped: 0, alreadyClosed: true });

    const throwing = unitHost(unitConfig(dir), {
      store: new StubStore(path.join(dir, 'throwing-state.json'), {
        throwOnSave: true,
        errorMessage: 'secret-store-message',
      }),
    });
    const thrownObserve = await throwing.host.observe({ kind: 'activity', at: START });
    assert.equal(thrownObserve.status, 'state-save-failed');
    assert.equal(JSON.stringify(thrownObserve).includes('secret-store-message'), false);
    await throwing.host.settle({ at: START + 6000 });
    const thrownOwner = throwing.host.onIncomingMessage({ isGroup: false, userId: OWNER, text: '在吗' });
    assert.equal(thrownOwner.status, 'state-save-failed');
    assert.equal(JSON.stringify(thrownOwner).includes('secret-store-message'), false);
    assert.deepEqual(throwing.sent, []);
    assert.equal(throwing.host.close().ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('读盘失败：不启动发送、固定诊断码；absent/expired 按干净启动继续', async () => {
  const dir = makeTempDir();
  try {
    const corrupt = unitHost(unitConfig(dir), {
      store: new StubStore(path.join(dir, 'corrupt-state.json'), {
        loadResult: { ok: false, state: null, diagnostics: [{ code: 'corrupt', detail: 'secret-detail' }] },
      }),
    });
    assert.equal(corrupt.host.status, 'state-load-failed');
    assert.equal(corrupt.host.enabled, false);
    assert.deepEqual(corrupt.host.diagnostics, [
      { code: PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_LOAD_FAILED, detail: 'corrupt' },
    ]);
    assert.equal(JSON.stringify(corrupt.host.diagnostics).includes('secret-detail'), false);
    assert.equal((await corrupt.host.observe({ kind: 'activity', at: START })).status, 'state-load-failed');
    assert.equal((await corrupt.host.settle({ at: START + 1 })).status, 'state-load-failed');
    assert.equal((await corrupt.host.tick(START)).status, 'state-load-failed');
    assert.equal(corrupt.host.onIncomingMessage({ isGroup: false, userId: OWNER }).ignored, true);
    assert.deepEqual(corrupt.sent, []);
    assert.deepEqual(corrupt.host.close(), { ok: true, persisted: false, dropped: 0, alreadyClosed: true });

    const throwing = unitHost(unitConfig(dir), {
      store: new StubStore(path.join(dir, 'throwing-load-state.json'), {
        throwOnLoad: true,
        errorMessage: 'secret-load-message',
      }),
    });
    assert.equal(throwing.host.status, 'state-load-failed');
    assert.deepEqual(throwing.host.diagnostics, [
      { code: PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_LOAD_FAILED, detail: 'load-failed' },
    ]);
    assert.equal(JSON.stringify(throwing.host.diagnostics).includes('secret-load-message'), false);

    const expired = unitHost(unitConfig(dir), {
      store: new StubStore(path.join(dir, 'expired-state.json'), {
        loadResult: { ok: true, state: null, diagnostics: [{ code: 'expired' }] },
      }),
    });
    assert.equal(expired.host.status, 'ready', 'TTL 过期按干净启动继续');
    assert.equal(expired.host.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('其余闸门：无 dataDir / 无发送通道 / 非法信号 / 时钟异常都 fail-closed', async () => {
  const dir = makeTempDir();
  try {
    const noDataDir = createPresenceQQHost({
      cfg: unitConfig(dir, { dataDir: '' }),
      bot: { sendPrivateText: async () => undefined },
      human: new Humanizer({ enabled: false }),
      now: () => START,
    });
    assert.equal(noDataDir.status, 'no-data-dir');
    assert.deepEqual(noDataDir.diagnostics, [{ code: PRESENCE_QQ_DIAGNOSTIC_CODES.NO_DATA_DIR }]);

    const noBot = createPresenceQQHost({
      cfg: unitConfig(dir),
      bot: {},
      human: new Humanizer({ enabled: false }),
      now: () => START,
    });
    assert.equal(noBot.status, 'unavailable');
    assert.deepEqual(noBot.diagnostics, [{ code: PRESENCE_QQ_DIAGNOSTIC_CODES.UNAVAILABLE }]);

    const noPresenceConfig = createPresenceQQHost({
      cfg: { dataDir: path.join(dir, 'data'), ownerIds: [OWNER] },
      bot: { sendPrivateText: async () => undefined },
      human: new Humanizer({ enabled: false }),
      now: () => START,
    });
    assert.equal(noPresenceConfig.status, 'disabled');

    // 数字型 ownerId 与白名单字符串比较（loadConfig 也会转成字符串）。
    const numericOwner = createPresenceQQHost({
      cfg: {
        dataDir: path.join(dir, 'data2'),
        ownerIds: [OWNER],
        presenceQQ: basePresenceQQ({ ownerId: Number(OWNER) }),
      },
      bot: { sendPrivateText: async () => undefined, setTyping: async () => ({ ok: true }) },
      human: new Humanizer({ enabled: false }),
      now: () => START,
      store: memoryStore(path.join(dir, 'numeric-owner-state.json')),
    });
    assert.equal(numericOwner.status, 'ready');
    assert.equal(numericOwner.ownerId, OWNER);
    assert.equal(numericOwner.onIncomingMessage({ isGroup: false, userId: {} }).ignored, true);

    const invalid = unitHost(unitConfig(dir), { store: memoryStore(path.join(dir, 'invalid-state.json')) });
    const badSignal = await invalid.host.observe({ kind: 'bogus' });
    assert.equal(badSignal.ok, false);
    assert.equal(badSignal.status, 'invalid-signal');
    const badAt = await invalid.host.settle({ at: 'not-a-timestamp' });
    assert.equal(badAt.status, 'invalid-at');
    const missingSignal = await invalid.host.observe(null);
    assert.equal(missingSignal.status, 'invalid-signal');

    const brokenClock = unitHost(unitConfig(dir), {
      store: memoryStore(path.join(dir, 'broken-clock-state.json')),
      nowRef: { get value() { throw new Error('clock-down'); } },
    });
    const clockDown = brokenClock.host.onIncomingMessage({ isGroup: false, userId: OWNER, text: '在吗' });
    assert.equal(clockDown.ignored, false);
    assert.equal(clockDown.invalidated, 0, '时钟不可用时不会假装作废了东西');
    assert.equal(clockDown.state, 'unknown', '状态机把无效时间当成被拒绝的观测');
    assert.deepEqual(brokenClock.sent, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
