/**
 * 提醒命令 · issue #44（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只覆盖三份产品文件的提醒命令接线：
 *
 *   reminder-commands.js  识别 / 澄清 / 确认
 *   reminder-service.js   list 的 pendingOnly 过滤
 *   index.js              私聊 onFlush 的分流与失败留档
 *
 * 边界：临时目录、假 OneBot / 模型，不联网、不碰真实 data/。
 * 窗口用显式 flush 推进，不依赖墙钟；关闭统一交给 t.after。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReminderCommands, parseReminderCommand } from '../src/reminder-commands.js';
import { createReminderService } from '../src/reminder-service.js';
import { createReminderStore } from '../src/reminder-store.js';
import { createPrivateTurnWindow, pushPrivateMessage } from '../src/index.js';

const T0 = 1_700_000_000_000;
const KEY = 'private:7001';

function tempDir(t, prefix = 'reminder-command-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function privateMsg({
  text,
  userId = '7001',
  key = KEY,
  isGroup = false,
  messageId = 'm-1',
  name = '主人',
} = {}) {
  return {
    key,
    isGroup,
    groupId: isGroup ? '88' : '',
    userId,
    name,
    text,
    messageId,
    time: T0,
  };
}

/** 一条 schema 合法的提醒记录；over 单独改字段。 */
function record(taskId, over = {}) {
  return {
    taskId,
    conversationKey: KEY,
    text: taskId,
    dueAt: T0,
    status: 'queued',
    attempt: 0,
    firedAt: null,
    proactive: false,
    ...over,
  };
}

function seed(dir, records) {
  assert.deepEqual(createReminderStore(path.join(dir, 'reminders.json')).save(records), { ok: true });
}

function readRecords(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8')).records;
}

/** 假 OneBot / 模型 / 人体化 / 记忆，全部只进内存。 */
function makeWindow(t, { root, cfg = {}, reply } = {}) {
  const normalSent = [];
  const privateSent = [];
  const replies = [];
  const errors = [];
  const drops = [];

  const brain = {
    async reply(input) {
      replies.push({ ...input });
      if (reply) return reply(input, replies.length);
      return { text: '收到' };
    },
  };
  const human = {
    async say(text, io) {
      const parts = [text];
      for (const part of parts) await io.send(part);
      return { sent: parts.length, parts };
    },
  };
  const bot = {
    async send(key, text) { normalSent.push({ key, text }); return { ok: true }; },
    async sendPrivateText(userId, text) { privateSent.push({ userId, text }); return { ok: true }; },
    async setTyping() {},
  };
  const memory = { touch() {}, remember() {}, logTurn() {} };
  const waker = { wake() {} };

  const window = createPrivateTurnWindow({
    deps: { bot, brain, human, memory, waker },
    cfg: {
      dryRun: false,
      reminders: true,
      dataDir: root,
      ownerIds: ['7001'],
      wake: { privateWindowMs: 60_000 },
      ...cfg,
    },
    windowMs: 60_000,
    onError: (error, context) => { errors.push({ error, context }); },
  });
  window.onDrop = (reason, meta) => { drops.push({ reason, key: meta?.key }); };
  t.after(() => window.close());

  return { window, normalSent, privateSent, replies, errors, drops };
}

// ── 1. 命令识别 ─────────────────────────────────────────────

test('parseReminderCommand：只认明确形状，模糊命令固定澄清', () => {
  assert.equal(parseReminderCommand(123), null);
  assert.equal(parseReminderCommand('   '), null);
  assert.equal(parseReminderCommand('5分钟后提醒我喝水\n第二行'), null);

  assert.equal(parseReminderCommand('5分钟后提醒我喝水').kind, 'create');
  assert.equal(parseReminderCommand('查看提醒').kind, 'list');

  assert.equal(parseReminderCommand('取消提醒').kind, 'clarify');
  assert.equal(parseReminderCommand('取消提醒：').kind, 'clarify');
  assert.equal(parseReminderCommand('取消提醒 task 1').kind, 'clarify');
  assert.equal(parseReminderCommand('取消提醒 ' + 'x'.repeat(129)).kind, 'clarify');
  assert.equal(parseReminderCommand('取消提醒 task-1').taskId, 'task-1');
  assert.equal(parseReminderCommand('取消提醒：task-1').taskId, 'task-1');
  assert.equal(parseReminderCommand('取消提醒 : task-1').taskId, 'task-1');
  assert.equal(parseReminderCommand('取消提醒我喝水'), null);
  assert.equal(parseReminderCommand('取消提醒task-1'), null);

  assert.equal(parseReminderCommand('提醒我喝水').kind, 'clarify');
  assert.equal(parseReminderCommand('请提醒我喝水').kind, 'clarify');
  assert.equal(parseReminderCommand('5分钟后提醒我').kind, 'clarify');
  assert.equal(parseReminderCommand('半小时后提醒我喝水').kind, 'clarify');

  assert.equal(parseReminderCommand('他提醒我今天带伞'), null);
  assert.equal(parseReminderCommand('提醒一下他'), null);
});

test('分类只认主人私聊：规范 id、key 对应与白名单', (t) => {
  const dir = tempDir(t);
  const send = async () => {};

  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001', 7002, '07003', 0, -1, 1.5, ' '],
    send,
  });
  assert.equal(handler.classify(privateMsg({ text: '5分钟后提醒我喝水' })).kind, 'create');
  assert.equal(handler.classify(privateMsg({
    text: '5分钟后提醒我喝水',
    userId: '7002',
    key: 'private:7002',
  })).kind, 'create');
  assert.equal(handler.classify(privateMsg({
    text: '5分钟后提醒我喝水',
    userId: '7003',
    key: 'private:7003',
  })), null);
  assert.equal(handler.classify(privateMsg({
    text: '5分钟后提醒我喝水',
    userId: '07001',
    key: 'private:07001',
  })), null);
  assert.equal(handler.classify(privateMsg({
    text: '5分钟后提醒我喝水',
    key: 'private:7002',
  })), null);
  assert.equal(handler.classify(privateMsg({ text: '5分钟后提醒我喝水', isGroup: true })), null);
  assert.equal(handler.classify(privateMsg({ text: '5分钟后提醒我喝水', userId: 7001 })), null);
  assert.equal(handler.classify(null), null);

  const setHandler = createReminderCommands({ dataDir: dir, ownerIds: new Set(['7001']), send });
  assert.ok(setHandler.classify(privateMsg({ text: '查看提醒' })));
  const noOwners = createReminderCommands({ dataDir: dir, send });
  assert.equal(noOwners.classify(privateMsg({ text: '查看提醒' })), null);
});

// ── 2. 创建、查询、取消 ──────────────────────────────────────

test('创建落盘后确认；查询限当前会话；只按完整 ID 取消', async (t) => {
  const dir = tempDir(t);
  const sent = [];
  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001', '7002'],
    send: async (userId, text) => { sent.push({ userId, text }); },
  });
  const run = async (text, userId = '7001') => {
    const plan = handler.classify(privateMsg({ text, userId, key: 'private:' + userId }));
    assert.ok(plan, '应为命令：' + text);
    await handler.handle(plan);
  };

  await run('查看提醒');
  assert.match(sent.at(-1).text, /没有/);

  await run('提醒我喝水');
  assert.match(sent.at(-1).text, /例如/);
  await run('取消提醒');
  assert.match(sent.at(-1).text, /完整/);
  await run('取消提醒：');
  assert.match(sent.at(-1).text, /完整/);

  await run('5分钟后提醒我喝水');
  assert.match(sent.at(-1).text, /任务 ID：/);
  let records = readRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].conversationKey, KEY);
  assert.equal(records[0].text, '喝水');

  await run('10分钟后提醒我收衣服', '7002');
  records = readRecords(dir);
  const other = records.find((item) => item.conversationKey === 'private:7002');
  const taskId = records.find((item) => item.conversationKey === KEY).taskId;

  await run('查看提醒');
  const listed = sent.at(-1).text;
  assert.match(listed, /喝水/);
  assert.doesNotMatch(listed, /收衣服/);

  await run('取消提醒 ' + other.taskId);
  assert.match(sent.at(-1).text, /没找到/);
  assert.equal(readRecords(dir).find((item) => item.taskId === other.taskId).status, 'queued');

  await run('取消提醒 ' + taskId.slice(0, 8));
  assert.match(sent.at(-1).text, /没找到/);
  assert.equal(readRecords(dir).find((item) => item.taskId === taskId).status, 'queued');

  await run('取消提醒 ' + taskId);
  assert.match(sent.at(-1).text, /已取消/);
  assert.equal(readRecords(dir).find((item) => item.taskId === taskId).status, 'canceled');

  await run('查看提醒');
  assert.match(sent.at(-1).text, /没有/);
});

test('pendingOnly：20 条旧终态先截断也不挤掉当前待办', async (t) => {
  const dir = tempDir(t);
  const old = Array.from({ length: 20 }, (_, index) => record('old-' + index, {
    text: 'old-' + index,
    dueAt: T0 + index,
    status: 'sent',
  }));
  const pending = record('pending-1', { text: '喝水', dueAt: T0 + 100_000 });
  seed(dir, [...old, pending]);

  const service = createReminderService(path.join(dir, 'reminders.json'));
  const legacy = service.list(KEY);
  assert.equal(legacy.reminders.length, 20);
  assert.equal(legacy.truncated, true);
  assert.equal(legacy.reminders.some((item) => item.taskId === 'pending-1'), false);

  const onlyPending = service.list(KEY, { pendingOnly: true });
  assert.deepEqual(onlyPending.reminders.map((item) => item.taskId), ['pending-1']);
  assert.equal(onlyPending.truncated, false);

  const sent = [];
  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001'],
    send: async (userId, text) => { sent.push({ userId, text }); },
  });
  await handler.handle(handler.classify(privateMsg({ text: '查看提醒' })));
  assert.match(sent.at(-1).text, /pending-1/);
  assert.doesNotMatch(sent.at(-1).text, /old-0/);
  assert.doesNotMatch(sent.at(-1).text, /还有更多/);

  await handler.handle(handler.classify(privateMsg({ text: '取消提醒 old-0' })));
  assert.match(sent.at(-1).text, /已经触发/);
});

test('待办超过 20 条时提示截断', async (t) => {
  const dir = tempDir(t);
  const pending = Array.from({ length: 25 }, (_, index) => record(
    'p-' + String(index).padStart(2, '0'),
    { text: '待办' + index, dueAt: T0 + index },
  ));
  seed(dir, pending);

  const sent = [];
  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001'],
    send: async (userId, text) => { sent.push({ userId, text }); },
  });
  await handler.handle(handler.classify(privateMsg({ text: '查看提醒' })));
  const listed = sent.at(-1).text;
  assert.match(listed, /还有更多，只显示前 20 条/);
  assert.match(listed, /p-19/);
  assert.doesNotMatch(listed, /p-20/);
});

// ── 3. 失败路径 ────────────────────────────────────────────

test('损坏存储只回固定失败，不抛异常也不改文件', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'reminders.json');
  const body = '{"version":1,"records":[';
  fs.writeFileSync(file, body, 'utf8');

  const sent = [];
  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001'],
    send: async (userId, text) => { sent.push({ userId, text }); },
  });
  for (const text of ['5分钟后提醒我喝水', '查看提醒', '取消提醒 task-1']) {
    await handler.handle(handler.classify(privateMsg({ text })));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.match(sent[0].text, /没能记下/);
  assert.match(sent[1].text, /暂时查不了/);
  assert.match(sent[2].text, /暂时取消不了/);
});

test('确认发送异常只尝试一次，默认日志不泄漏异常', async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const errors = [];
  const handler = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001'],
    send: async () => { calls.push(1); throw new Error('绝密发送异常'); },
    onError: () => { errors.push(1); },
  });
  await handler.handle(handler.classify(privateMsg({ text: '查看提醒' })));
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);

  const logs = [];
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')); });
  const bare = createReminderCommands({
    dataDir: dir,
    ownerIds: ['7001'],
    send: async () => { throw new Error('绝密发送异常'); },
  });
  await bare.handle(bare.classify(privateMsg({ text: '查看提醒' })));
  assert.deepEqual(logs, ['[提醒] 命令处理失败']);
});

// ── 4. 私聊窗口接线 ─────────────────────────────────────────

test('窗口：先落盘再确认；重复 messageId 不重复创建', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  const app = makeWindow(t, { root: dir });

  await pushPrivateMessage(app.window, privateMsg({ text: '5分钟后提醒我喝水', messageId: 'dup-1' }));
  await pushPrivateMessage(app.window, privateMsg({ text: '5分钟后提醒我喝水', messageId: 'dup-1' }));
  assert.equal(app.window.pending(KEY), 1);

  await app.window.flush(KEY);
  assert.equal(app.replies.length, 0, '纯命令批次不进入生成');
  assert.equal(app.privateSent.length, 1);
  assert.match(app.privateSent[0].text, /任务 ID：/);
  const records = readRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].conversationKey, KEY);
});

test('窗口：混合批次命令分流，普通消息仍交给生成链', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  const app = makeWindow(t, { root: dir });

  await pushPrivateMessage(app.window, privateMsg({ text: '今天天气不错', messageId: 'mix-1' }));
  await pushPrivateMessage(app.window, privateMsg({ text: '5分钟后提醒我喝水', messageId: 'mix-2' }));
  await app.window.flush(KEY);

  assert.equal(app.replies.length, 1);
  assert.match(app.replies[0].text, /今天天气不错/);
  assert.doesNotMatch(app.replies[0].text, /提醒我/);
  assert.equal(app.normalSent.length, 1);
  assert.equal(app.privateSent.length, 1);
  assert.equal(readRecords(dir).length, 1);
});

test('窗口：混合批次失败只留档普通消息，重放不重做命令', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  const app = makeWindow(t, {
    root: dir,
    reply: async (_input, nth) => {
      if (nth === 1) throw new Error('生成失败');
      return { text: '重放回复' };
    },
  });

  await pushPrivateMessage(app.window, privateMsg({ text: '普通一句', messageId: 'fail-1' }));
  await pushPrivateMessage(app.window, privateMsg({ text: '5分钟后提醒我喝水', messageId: 'fail-2' }));
  await app.window.flush(KEY);

  assert.equal(app.errors.length, 1);
  assert.equal(app.privateSent.length, 1);
  assert.equal(readRecords(dir).length, 1);
  const meta = app.window.failedPrivateTurns(KEY);
  assert.equal(meta.length, 1);

  await app.window.replayPrivateTurn(KEY, meta[0].batchId);
  assert.equal(app.replies.length, 2);
  assert.match(app.replies[1].text, /普通一句/);
  assert.doesNotMatch(app.replies[1].text, /提醒我/);
  assert.equal(app.privateSent.length, 1, '重放不再发命令确认');
  assert.equal(readRecords(dir).length, 1, '重放不再创建提醒');
  assert.equal(app.normalSent.length, 1);
});

test('窗口：非主人和普通上下文都不触发命令', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  const app = makeWindow(t, { root: dir });

  await pushPrivateMessage(app.window, privateMsg({
    text: '5分钟后提醒我喝水',
    userId: '7002',
    key: 'private:7002',
    messageId: 'other-1',
  }));
  await pushPrivateMessage(app.window, privateMsg({ text: '他提醒我今天带伞', messageId: 'plain-1' }));
  await app.window.flush('private:7002');
  await app.window.flush(KEY);

  assert.equal(app.privateSent.length, 0);
  assert.equal(app.replies.length, 2);
  assert.equal(app.replies.some((item) => item.text.includes('5分钟后提醒我喝水')), true);
  assert.equal(app.replies.some((item) => item.text.includes('他提醒我今天带伞')), true);
  assert.equal(fs.existsSync(path.join(dir, 'reminders.json')), false);
});

test('窗口：干跑、未开启提醒、无 dataDir 都保持普通生成', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);

  for (const [index, cfg] of [{ dryRun: true }, { reminders: false }, { dataDir: '' }].entries()) {
    const app = makeWindow(t, { root: dir, cfg });
    await pushPrivateMessage(app.window, privateMsg({
      text: '5分钟后提醒我喝水',
      messageId: 'cfg-' + index,
    }));
    await app.window.flush(KEY);
    assert.equal(app.privateSent.length, 0);
    assert.equal(app.replies.length, 1);
    assert.equal(app.normalSent.length, cfg.dryRun ? 0 : 1);
    await app.window.close();
  }
  assert.equal(fs.existsSync(path.join(dir, 'reminders.json')), false);
});

test('窗口：关闭后命令消息只走 onDrop', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  const app = makeWindow(t, { root: dir });

  await app.window.close();
  await pushPrivateMessage(app.window, privateMsg({ text: '5分钟后提醒我喝水', messageId: 'closed-1' }));

  assert.deepEqual(app.drops.map((item) => item.reason), ['closed']);
  assert.equal(app.privateSent.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'reminders.json')), false);
});