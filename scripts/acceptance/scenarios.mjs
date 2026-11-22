/**
 * T4 离线验收 · 场景表
 * ─────────────────────────────────────────────────────────────
 * 每个条目只有两种状态：
 *   covered      —— 有**可执行**证据：跑的是本 checkout 里真实存在的产品模块
 *                   （handleTurn / Humanizer / ConversationWindow / Waker / Memory /
 *                   Role / context-budget / reminder-* / reminder-commands /
 *                   index.js#main / tools/registry / tools/host-bridge /
 *                   media/*（含 voice-runtime）/ presence-qq-runtime.js），
 *                   外部世界一律用假 bot、脚本化假 brain、临时目录、虚拟时钟。
 *   not-covered  —— 依赖本 checkout 里**不存在**的东西（宿主集成、QQ/OneBot 集成），
 *                   因此**没有**执行证据；不用纯桩断言冒充验收。
 *
 * C 门离线 presence（C-01…C-09）都在 presence-scenarios.mjs：
 *   C-01/C-02 用真实 web-host.js + 真实 web-http.js 挂临时回环 HTTP server（#96/#100
 *   已合入），HTTP 客户端只打 /presence/signal 与 /presence/messages；
 *   C-03…C-09 用合成 OneBot + 虚拟时钟。C 门当前没有 not-covered 项。
 *
 * D/E 离线契约：D-01…D-04 复用 media/* 的 ASR/TTS 桩与 voice-runtime 公开入口，
 * D-05 复用 lib.js#createAttachmentHost 的附件元数据入口（只到 U2 前的离线契约），
 * E-01…E-05 复用 tools/registry 的 fake tool 与 host-bridge 公开入口。
 * 这些是离线契约证据，不是真实语音/附件理解/工具/供应商验收。
 *
 * 约定（写新场景时请守住）：
 *   1. 只填合成输入：`input.synthetic` 由框架强制为 true，写 false 会直接失败；
 *   2. 每一步都用 harness.step 记齐 8 个事实槽位，期望与实际分开写，差异由框架算；
 *   3. 不读仓库 data/、真实配置、私密记忆或日志；一切路径来自 harness.tempRoot；
 *   4. 不联网、不调真实模型；需要特定发送回执时用 harness.setSendBehavior；
 *   5. 错误只用闭合码，绝不在 step / diagnostics 里放异常 message 或正文。
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createPrivateTurnWindow, handleTurn, pushPrivateMessage } from '../../packages/companion/src/index.js';
import { Humanizer } from '../../packages/companion/src/humanize.js';
import { Role } from '../../packages/companion/src/role.js';
import { Waker } from '../../packages/companion/src/wake.js';
import { planContextBudget } from '../../packages/companion/src/context-budget.js';
import { createPresenceQQHost } from '../../packages/companion/src/presence-qq-runtime.js';
import { createReminderDispatcher } from '../../packages/companion/src/reminder-dispatcher.js';
import { createOneBotReminderSender } from '../../packages/companion/src/reminder-onebot.js';
import { classifyReminderRecovery } from '../../packages/companion/src/reminder-recovery.js';
import { createReminderService } from '../../packages/companion/src/reminder-service.js';
import { createReminderStore } from '../../packages/companion/src/reminder-store.js';
import { createToolRegistry } from '../../packages/companion/src/tools/registry.js';
import { ingestAudio, renderVoice } from '../../packages/companion/src/media/pipeline.js';
import { createOfflineAsrStub, createOfflineTtsStub } from '../../packages/companion/src/media/offline-stub.js';
import { createMediaStore } from '../../packages/companion/src/media/store.js';
import {
  createAttachmentHost,
  createToolHostBridge,
  createVoiceRuntime,
} from '../../packages/companion/src/lib.js';

import { C_SCENARIOS } from './presence-scenarios.mjs';
import { OWNER_PRIVATE_SCENARIOS } from './owner-private-scenarios.mjs';

/** 合成会话键 / 对方 id：全部是占位值，不对应任何真实账号。 */
const KEY = 'private:visitor-1';
const VISITOR = 'visitor-1';
const VISITOR_NAME = '访客';

/** handleTurn 需要的最小 cfg；dryRun 默认关，必要时逐场景覆盖。 */
function baseCfg(overrides = {}) {
  return { dryRun: false, wake: { privateWindowMs: 1500 }, ...overrides };
}

/** 合成一条私聊消息。 */
function privateMessage(text, extra = {}) {
  return { key: KEY, userId: VISITOR, name: VISITOR_NAME, text, isGroup: false, ...extra };
}

/** 只读 Memory 事实（不产生副作用）。 */
function facts(harness, memory) {
  return harness.memoryFacts(memory, VISITOR);
}

/** 统一说明：为什么用 enabled:false 的 Humanizer（不影响分条与回执判定）。 */
const HUMANIZER_NOTE = 'enabled=false：只跳过"正在输入"时长与条间停顿（避免真实等待），'
  + '分条逻辑与回执判定仍走 humanize.js 真实代码。';

/* ══════════════════════ B-01 打招呼 ══════════════════════ */

/**
 * B-01：一条私聊消息进来 → 唤醒判定 → handleTurn 生成 → 拟人化发送 → 延迟提交记忆。
 * 真实模块：Waker.shouldWake、handleTurn、Humanizer.say/split、Memory、Waker.joinBatch。
 */
async function runB01(harness) {
  const memory = harness.makeMemory('b01');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ names: ['小鱼'], probability: 0 });
  waker.setConfig(KEY, { mode: 'active', anyMessage: true });

  const message = privateMessage('在吗');
  const verdict = waker.shouldWake(message);
  harness.step({
    title: '唤醒判定：私聊活跃模式下任何消息都醒',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }] },
    expected: { wake: true, reason: 'anyMessage' },
    actual: { wake: verdict.wake === true, reason: verdict.reason },
  });

  const brain = harness.makeBrain({ memory, replies: [{ text: '在呢，刚看到消息' }] });
  await handleTurn({ bot: harness.bot, brain, human, memory, waker }, [message], baseCfg());

  const delivered = harness.bot.deliveries;
  const memoryFacts = facts(harness, memory);
  harness.step({
    title: 'handleTurn：生成 → 分条发送 → 送达后才提交记忆',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }] },
    model: {
      calls: brain.calls.length,
      joined: brain.calls[0]?.joined,
      deferred: brain.calls[0]?.record === 'deferred',
      committed: memoryFacts.personKnown,
    },
    memory: { ...memoryFacts, committed: memoryFacts.personKnown },
    delivery: {
      attempted: delivered.length,
      sent: delivered.length,
      receipts: delivered.map((item) => (item.mode === 'confirmed' ? 'confirmed' : item.mode)),
      texts: delivered.map((item) => item.text),
      channel: 'qq-private-synthetic',
    },
    expected: {
      calls: 1,
      joined: '访客：在吗',
      deferred: true,
      committed: true,
      people: 1,
      turns: 1,
      personKnown: true,
      interactions: 2,
      attempted: 1,
      sent: 1,
      receipts: ['confirmed'],
      texts: ['在呢，刚看到消息'],
    },
    actual: {
      calls: brain.calls.length,
      joined: brain.calls[0]?.joined ?? '',
      deferred: brain.calls[0]?.record === 'deferred',
      committed: memoryFacts.personKnown,
      people: memoryFacts.people,
      turns: memoryFacts.turns,
      personKnown: memoryFacts.personKnown,
      interactions: memoryFacts.interactions,
      attempted: delivered.length,
      sent: delivered.length,
      receipts: delivered.map((item) => (item.mode === 'confirmed' ? 'confirmed' : item.mode)),
      texts: delivered.map((item) => item.text),
    },
  });

  return { modules: ['wake.js', 'index.js#handleTurn', 'humanize.js', 'memory.js'], note: HUMANIZER_NOTE };
}

/* ══════════════════════ B-02 连发三条 ══════════════════════ */

/**
 * B-02：同一会话连发三条 → 窗口收齐 → 按到达顺序合成一轮 → 只回一次；
 * 同一条重复投递（eventId 相同）不再消费第二次。
 * 真实模块：createPrivateTurnWindow、ConversationWindow、pushPrivateMessage、
 * Waker.joinBatch、handleTurn。
 */
async function runB02(harness) {
  const memory = harness.makeMemory('b02');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ names: ['小鱼'], probability: 0 });
  waker.setConfig(KEY, { mode: 'active', anyMessage: true });
  const brain = harness.makeBrain({ memory, replies: [{ text: '收到，我一条条看' }] });

  const failures = [];
  const window = createPrivateTurnWindow({
    deps: { bot: harness.bot, brain, human, memory, waker },
    cfg: baseCfg(),
    windowMs: 1500,
    onError: (error) => failures.push(error && typeof error.code === 'string' ? error.code : 'unknown'),
  });

  const messages = [1, 2, 3].map((n) => privateMessage('第' + n + '句', { messageId: 'm-' + n }));
  for (const message of messages) await pushPrivateMessage(window, message);
  const pendingBefore = window.pending(KEY);
  await pushPrivateMessage(window, messages[1]);
  const pendingAfterDuplicate = window.pending(KEY);
  // close() 把「待刷出」当成一次轮次边界：等于把 debounce 计时器推进到底，且不用真等。
  await window.close();

  const delivered = harness.bot.deliveries;
  const joined = brain.calls[0]?.joined ?? '';
  const order = joined.split('\n').join('|');
  harness.step({
    title: '三条连发：一次生成、顺序保全、重复投递只消费一次',
    input: {
      kind: 'private-message-burst',
      items: messages.map((message) => ({ text: message.text, userId: message.userId })),
      note: '第三条之后重复投递第二条（messageId 相同）',
    },
    model: { calls: brain.calls.length, joined },
    delivery: {
      attempted: delivered.length,
      sent: delivered.length,
      receipts: delivered.map((item) => item.mode),
      texts: delivered.map((item) => item.text),
      channel: 'qq-private-synthetic',
    },
    expected: {
      pendingBefore: 3,
      pendingAfterDuplicate: 3,
      calls: 1,
      lineCount: 3,
      order: '访客：第1句|访客：第2句|访客：第3句',
      sent: 1,
      failures: 0,
    },
    actual: {
      pendingBefore,
      pendingAfterDuplicate,
      calls: brain.calls.length,
      lineCount: joined === '' ? 0 : joined.split('\n').length,
      order,
      sent: delivered.length,
      failures: failures.length,
    },
  });

  return { modules: ['index.js#createPrivateTurnWindow', 'conversation-window.js', 'wake.js#joinBatch'], note: HUMANIZER_NOTE };
}

/* ══════════════════════ B-06 提醒生命周期 ══════════════════════ */

/**
 * B-06：提醒创建 → 未到期不发 → 到期发一次 → 落终态 → 再派发不重发。
 * 真实模块：reminder-service（含 relative-reminder 解析）、reminder-store（原子落盘）、
 * reminder-dispatcher（claim + 回执词表）。时钟与 send 全部注入。
 */
async function runB06(harness) {
  harness.dirOf('b06');
  const file = harness.pathOf('b06', 'reminders.json');
  let counter = 0;
  const service = createReminderService(file, {
    now: () => harness.now(),
    newId: () => 'task-' + (counter += 1),
  });

  const startedAt = harness.now();
  const created = service.create(KEY, '30分钟后提醒我收衣服');
  const listed = service.list(KEY);
  harness.step({
    title: '创建：只有明确「N单位后提醒我X」才落盘为 queued',
    input: { kind: 'reminder-command', items: [{ text: '30分钟后提醒我收衣服', userId: VISITOR }] },
    task: { id: created.taskId, status: created.status, kind: 'queued' },
    expected: { ok: true, status: 'queued', dueOffsetMs: 30 * 60 * 1000, listedCount: 1, listedStatus: 'queued' },
    actual: {
      ok: created.ok === true,
      status: created.status,
      dueOffsetMs: created.dueAt - startedAt,
      listedCount: listed.ok ? listed.reminders.length : -1,
      listedStatus: listed.ok && listed.reminders[0] ? listed.reminders[0].status : '',
    },
  });
  harness.assert(created.ok === true, 'reminder-create-failed');

  const sends = [];
  const dispatcher = createReminderDispatcher(file, {
    now: () => harness.now(),
    send: (delivery) => {
      sends.push({ taskId: delivery.taskId, textChars: [...delivery.text].length, lateByMs: delivery.lateByMs });
      return 'sent';
    },
  });

  const early = await dispatcher.dispatchNext();
  harness.step({
    title: '未到期：派发器选不到候选，一次发送都不发生',
    input: { kind: 'scheduler-tick', note: '时钟推进前的一次派发' },
    expected: { ok: true, result: 'null', sends: 0 },
    actual: { ok: early.ok === true, result: early.result === null ? 'null' : 'record', sends: sends.length },
  });

  harness.advanceClock(30 * 60 * 1000);
  const fired = await dispatcher.dispatchNext();
  const store = createReminderStore(file);
  const snapshot = store.load();
  const record = snapshot.ok ? snapshot.records.find((item) => item.taskId === created.taskId) : null;
  harness.step({
    title: '到期：claim → 发送一次 → 按回执落终态',
    input: { kind: 'reminder-due', items: [{ text: '收衣服', userId: VISITOR }] },
    task: {
      id: created.taskId,
      status: record?.status ?? '',
      attempt: record?.attempt ?? null,
      firedAtSet: Boolean(record && record.firedAt !== null && record.firedAt !== undefined),
      kind: fired.result?.status ?? '',
    },
    expected: { ok: true, resultStatus: 'sent', status: 'sent', attempt: 1, firedAtSet: true, sends: 1, lateByMs: 0 },
    actual: {
      ok: fired.ok === true,
      resultStatus: fired.result?.status ?? '',
      status: record?.status ?? '',
      attempt: record?.attempt ?? null,
      firedAtSet: Boolean(record && record.firedAt !== null && record.firedAt !== undefined),
      sends: sends.length,
      lateByMs: sends[0]?.lateByMs ?? null,
    },
  });

  const again = await dispatcher.dispatchNext();
  harness.step({
    title: '终态不重发：再派发一次仍是空结果',
    input: { kind: 'scheduler-tick', note: '终态之后的又一次派发' },
    expected: { ok: true, result: 'null', sends: 1 },
    actual: { ok: again.ok === true, result: again.result === null ? 'null' : 'record', sends: sends.length },
  });

  return { modules: ['reminder-service.js', 'relative-reminder.js', 'reminder-store.js', 'reminder-dispatcher.js'] };
}

/* ══════════════════════ B-07 模糊提醒 ══════════════════════ */

/** 合成主人账号：必须是规范十进制（命令层只认 `private:<十进制正整数>`）。 */
const B07_OWNER = '10001';
const B07_KEY = 'private:' + B07_OWNER;

/** 命令层的固定澄清文案 / "已创建"回执开头（字面量，不从产品常量借）。 */
const B07_CLARIFY = '我还不太明白这条提醒：请说清多久之后、提醒你什么，例如：5分钟后提醒我喝水。';
const B07_CREATED_PREFIX = '好，到点提醒你：';

/** 合成一条 OneBot 私聊消息（字段形状与 transport-onebot.js 的产出一致）。 */
function b07Message(text, messageId) {
  return {
    key: B07_KEY,
    isGroup: false,
    groupId: '',
    userId: B07_OWNER,
    name: '主人',
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId,
    time: 0,
  };
}

/**
 * B-07：模糊提醒先澄清——不猜时间、不建任务、不回"已创建"。
 *
 * 一次装配（CLI 的私聊装配层 createPrivateTurnWindow + 假传输 + 脚本化 brain）
 * 连续跑两批，用显式 flush 推进，不依赖任何计时器：
 *   ① 白名单内两条模糊提醒 → 只回两句澄清：0 次生成、0 条快照、0 次聊天发送；
 *   ② 正对照：同一装配换成一条明确提醒 → 真的新建 1 条 queued 并回复任务 ID。
 * 没有②，①的"零任务"可能只是"命令层没接线"。
 *
 * 真实 main()/OneBot 的明确提醒路径另由 packages/companion/test/cli-reminder-e2e.test.mjs
 * 覆盖；真实 QQ 仍属人工清单。
 */
async function runB07(harness) {
  const memory = harness.makeMemory('b07/memory');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ probability: 0 });
  const brain = harness.makeBrain({ memory, replies: [{ text: '不该走到生成链' }] });
  const failures = [];
  const snapshot = harness.pathOf('b07/data', 'reminders.json');
  const window = createPrivateTurnWindow({
    deps: { bot: harness.bot, brain, human, memory, waker },
    cfg: {
      ...baseCfg(),
      reminders: true,
      dataDir: harness.dirOf('b07/data'),
      ownerIds: [B07_OWNER],
    },
    onError: (error) => failures.push(error && typeof error.code === 'string' ? error.code : 'unknown'),
  });

  /** 直接读盘取快照记录：文件不存在算 0 条，不经过被测模块的 store（避免自己验自己）。 */
  const records = () => (fs.existsSync(snapshot) ? JSON.parse(fs.readFileSync(snapshot, 'utf8')).records : []);

  try {
    /* ── ① 模糊提醒：只澄清 ── */
    const ambiguousTexts = ['一会儿提醒我喝水', '半小时后提醒我收衣服'];
    for (const [index, text] of ambiguousTexts.entries()) {
      await pushPrivateMessage(window, b07Message(text, 'b07-ambiguous-' + index));
    }
    await window.flush(B07_KEY);
    const ambiguousReplies = harness.bot.privateDeliveries.slice();

    harness.step({
      title: '模糊提醒：只回澄清，0 次生成、0 条任务、无已创建回执',
      input: {
        kind: 'reminder-command',
        items: ambiguousTexts.map((text) => ({ text, userId: B07_OWNER })),
        note: '白名单内主人私聊；两条都是"能被猜出时间"的形状（一会儿 / 半小时后）',
      },
      model: { calls: brain.calls.length },
      task: { id: '', status: 'none', attempt: null, firedAtSet: false, kind: 'clarify' },
      delivery: {
        attempted: ambiguousReplies.length,
        sent: ambiguousReplies.length,
        receipts: ambiguousReplies.map((item) => item.mode),
        texts: ambiguousReplies.map((item) => item.text),
        channel: 'qq-private-synthetic',
      },
      expected: {
        calls: 0,
        replies: 2,
        clarifyReplies: 2,
        createdReplies: 0,
        taskIdMentions: 0,
        chatSends: 0,
        snapshotExists: false,
        records: 0,
        failures: 0,
      },
      actual: {
        calls: brain.calls.length,
        replies: ambiguousReplies.length,
        clarifyReplies: ambiguousReplies.filter((item) => item.text === B07_CLARIFY).length,
        createdReplies: ambiguousReplies.filter((item) => item.text.startsWith(B07_CREATED_PREFIX)).length,
        taskIdMentions: ambiguousReplies.filter((item) => item.text.includes('任务 ID：')).length,
        chatSends: harness.bot.deliveries.length,
        snapshotExists: fs.existsSync(snapshot),
        records: records().length,
        failures: failures.length,
      },
    });

    /* ── ② 正对照：同一装配，明确提醒确实建出任务 ── */
    await pushPrivateMessage(window, b07Message('5分钟后提醒我喝水', 'b07-explicit-1'));
    await window.flush(B07_KEY);
    const allReplies = harness.bot.privateDeliveries.slice();
    const newReplies = allReplies.slice(ambiguousReplies.length);
    const record = records()[0] ?? null;

    harness.step({
      title: '正对照：同一装配里明确提醒新建 1 条 queued，并回复任务 ID',
      input: {
        kind: 'reminder-command',
        items: [{ text: '5分钟后提醒我喝水', userId: B07_OWNER }],
        note: '只把模糊换成明确，装配与存储都不变；回执含随机 taskId，正文不进证据',
      },
      model: { calls: brain.calls.length },
      task: {
        id: '',
        status: record?.status ?? '',
        attempt: record?.attempt ?? null,
        firedAtSet: Boolean(record && record.firedAt !== null && record.firedAt !== undefined),
        kind: record ? 'queued' : 'none',
      },
      delivery: {
        attempted: allReplies.length,
        sent: allReplies.length,
        receipts: allReplies.map((item) => item.mode),
        texts: [],
        channel: 'qq-private-synthetic',
      },
      expected: {
        calls: 0,
        replies: 3,
        newReplies: 1,
        createdReplies: 1,
        taskIdMentions: 1,
        chatSends: 0,
        snapshotExists: true,
        records: 1,
        recordText: '喝水',
        status: 'queued',
        failures: 0,
      },
      actual: {
        calls: brain.calls.length,
        replies: allReplies.length,
        newReplies: newReplies.length,
        createdReplies: newReplies.filter((item) => item.text.startsWith(B07_CREATED_PREFIX)).length,
        taskIdMentions: newReplies.filter((item) => item.text.includes('任务 ID：')).length,
        chatSends: harness.bot.deliveries.length,
        snapshotExists: fs.existsSync(snapshot),
        records: records().length,
        recordText: record?.text ?? '',
        status: record?.status ?? '',
        failures: failures.length,
      },
    });
  } finally {
    await window.close();
  }

  return {
    modules: [
      'index.js#createPrivateTurnWindow',
      'reminder-commands.js',
      'relative-reminder.js',
      'reminder-service.js',
      'reminder-store.js',
    ],
    limitation: 'cli-assembly-offline-synthetic-transport',
    note: '真实 main()/OneBot 的明确提醒路径由 packages/companion/test/cli-reminder-e2e.test.mjs '
      + '互补覆盖；真实 QQ 上的同一行为仍属人工清单。模糊时间词表是固定正则，'
      + '词典外的新口语形状会落回普通叙述交给生成链（本场景未覆盖）。',
  };
}

/* ══════════════════════ B-08 消息与到期提醒同时发生 ══════════════════════ */

/** 合成主人账号：提醒发送器只认 `private:<十进制正整数>`，且必须在白名单里。 */
const B08_OWNER = '10001';
const B08_KEY = 'private:' + B08_OWNER;

/** 可控 Promise barrier：只由显式 release 推进，不 sleep、不猜 tick。 */
function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * B-08：新消息与到期提醒同时发生——消息不被提醒覆盖，提醒也不因消息在途而丢。
 * 装配是真的：createPrivateTurnWindow（真实 ConversationWindow 的每会话串行队列）
 * + createOneBotReminderSender（提醒走同一条 runSerial 队列）+ 到期 reminder-dispatcher。
 * 时钟、传输、回执全部注入；推进只靠显式 flush 与 barrier，不 sleep、不猜 tick：
 *   ① 消息先到、生成被 barrier 卡住：回复一条都没发；
 *   ② 同一虚拟时刻提醒到期：派发器已同步 claim（processing）并排进同一队列，
 *      但提醒一条都没发（队列前面的聊天批次还没结束）；
 *   ③ 放行生成：回复先发、提醒后发各一次，提醒按回执落终态 sent；
 *   ④ 终态之后再派发：空结果、状态不变、不重发。
 * 只证明通用 CLI 组件的离线并发层：假传输 + 合成账号，不是宿主集成，也不是真实
 * QQ / OneBot；真实 QQ 上的同一行为仍属人工清单。
 */
async function runB08(harness) {
  const memory = harness.makeMemory('b08/memory');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ probability: 0 });
  const snapshot = harness.pathOf('b08/data', 'reminders.json');
  harness.dirOf('b08/data');

  let counter = 0;
  const service = createReminderService(snapshot, {
    now: () => harness.now(),
    newId: () => 'task-' + (counter += 1),
  });
  const created = service.create(B08_KEY, '5分钟后提醒我喝水');
  harness.assert(created.ok === true, 'reminder-create-failed');
  const dueOffsetMs = created.dueAt - harness.now();

  // 生成侧的可控 barrier：brain.reply 一进来就报到，然后停在这里等放行。
  const generationStarted = barrier();
  const generationGate = barrier();
  const brain = harness.makeBrain({
    memory,
    replies: async () => {
      generationStarted.release();
      await generationGate.promise;
      return { text: '在呢' };
    },
  });

  /** 假传输：聊天记进 harness 的假 bot 台账；提醒回 OneBot 形状的 confirmed 回执。 */
  const order = [];
  const reminderSends = [];
  const bot = {
    send: (key, text) => { order.push('chat'); return harness.bot.send(key, text); },
    setTyping: (key, on) => harness.bot.setTyping(key, on),
    sendPrivateText: async (userId, text) => {
      order.push('reminder');
      reminderSends.push({ userId, text });
      return { ok: true, receipt: { status: 'confirmed' } };
    },
  };

  const failures = [];
  const window = createPrivateTurnWindow({
    deps: { bot, brain, human, memory, waker },
    cfg: baseCfg(),
    onError: (error) => failures.push(error && typeof error.code === 'string' ? error.code : 'unknown'),
  });

  // 只观测真实窗口的 runSerial 何时被调用；排队本身仍由 ConversationWindow 完成。
  const reminderQueued = barrier();
  const sender = createOneBotReminderSender({
    bot,
    window: { runSerial: (key, job) => { reminderQueued.release(); return window.runSerial(key, job); } },
    ownerIds: [B08_OWNER],
  });
  const dispatcher = createReminderDispatcher(snapshot, { now: () => harness.now(), send: sender.send });

  /** 直接读盘取记录：不经过被测 store，避免自己验自己。 */
  const record = () => (fs.existsSync(snapshot)
    ? JSON.parse(fs.readFileSync(snapshot, 'utf8')).records[0] ?? null
    : null);
  const firedAtSet = (item) => item?.firedAt !== null && item?.firedAt !== undefined;

  let dispatchSettled = false;
  try {
    /* ── ① 消息到达 + 提醒到期：生成在途，提醒只 claim 不发送 ── */
    harness.advanceClock(5 * 60 * 1000);
    await pushPrivateMessage(window, {
      key: B08_KEY, userId: B08_OWNER, name: '主人', text: '在吗', isGroup: false, messageId: 'b08-1',
    });
    const flushed = window.flush(B08_KEY);
    await Promise.race([
      generationStarted.promise,
      flushed.then(() => { throw new Error('b08-generation-not-started'); }),
    ]);
    const dispatched = dispatcher.dispatchNext().then((result) => { dispatchSettled = true; return result; });
    await Promise.race([
      reminderQueued.promise,
      dispatched.then(() => { throw new Error('b08-reminder-not-queued'); }),
    ]);
    const claimed = record();

    harness.step({
      title: '同时发生：回复在途，提醒已 claim 并入队但一条都没发',
      input: { kind: 'private-message+reminder-due', items: [{ text: '在吗', userId: B08_OWNER }], note: '消息到达与提醒到期在同一虚拟时刻；生成被可控 barrier 卡住' },
      model: { calls: brain.calls.length },
      task: { id: created.taskId, status: claimed?.status ?? '', attempt: claimed?.attempt ?? null, firedAtSet: firedAtSet(claimed), kind: 'processing' },
      delivery: { attempted: reminderSends.length, sent: reminderSends.length, receipts: [], texts: [], channel: 'qq-private-synthetic' },
      expected: { calls: 1, dueOffsetMs: 300000, chatSends: 0, reminderSends: 0, dispatchSettled: false, claimStatus: 'processing', claimAttempt: 1, failures: 0 },
      actual: {
        calls: brain.calls.length, dueOffsetMs, chatSends: harness.bot.deliveries.length,
        reminderSends: reminderSends.length, dispatchSettled,
        claimStatus: claimed?.status ?? '', claimAttempt: claimed?.attempt ?? null, failures: failures.length,
      },
    });

    /* ── ② 放行：回复先发、提醒后发；终态之后再派发不重发 ── */
    generationGate.release();
    await flushed;
    const fired = await dispatched;
    const settled = record();
    const again = await dispatcher.dispatchNext();
    harness.step({
      title: '放行后：两项各一次、提醒落终态，再派发不重发',
      input: { kind: 'reminder-due', items: [{ text: '喝水', userId: B08_OWNER }], note: '放行被卡住的生成后等派发彻底结束，再显式派发一次' },
      model: { calls: brain.calls.length },
      task: { id: created.taskId, status: settled?.status ?? '', attempt: settled?.attempt ?? null, firedAtSet: firedAtSet(settled), kind: fired.result?.status ?? '' },
      delivery: { attempted: reminderSends.length, sent: reminderSends.length, receipts: reminderSends.map(() => 'confirmed'), texts: reminderSends.map((item) => item.text), channel: 'qq-private-synthetic' },
      expected: {
        calls: 1, order: 'chat|reminder', chatSends: 1, chatTexts: '在呢',
        reminderSends: 1, reminderUserId: B08_OWNER, resultStatus: 'sent', status: 'sent', attempt: 1, firedAtSet: true,
        redispatch: 'null', statusAfter: 'sent', reminderSendsAfter: 1, failures: 0,
      },
      actual: {
        calls: brain.calls.length, order: order.join('|'), chatSends: harness.bot.deliveries.length,
        chatTexts: harness.bot.deliveries.map((item) => item.text).join('|'),
        reminderSends: reminderSends.length, reminderUserId: reminderSends[0]?.userId ?? '',
        resultStatus: fired.result?.status ?? '', status: settled?.status ?? '', attempt: settled?.attempt ?? null,
        firedAtSet: firedAtSet(settled), redispatch: again.result === null ? 'null' : 'record',
        statusAfter: record()?.status ?? '', reminderSendsAfter: reminderSends.length, failures: failures.length,
      },
    });
  } finally {
    // 幂等放行：断言提前失败时也不能把在途批次永远挂在 barrier 上。
    generationGate.release();
    await window.close();
  }

  return {
    modules: ['index.js#createPrivateTurnWindow', 'conversation-window.js', 'index.js#handleTurn', 'reminder-dispatcher.js', 'reminder-onebot.js', 'reminder-store.js'],
    limitation: 'cli-assembly-offline-synthetic-transport',
    note: '只证明通用 CLI 组件的离线并发层（真实窗口串行队列 + 到期派发 + OneBot 发送适配）；'
      + '宿主集成与真实 QQ / OneBot 不在本场景内，仍属人工清单。',
  };
}

/* ══════════════════════ B-09 重启恢复 ══════════════════════ */

/**
 * B-09：进程重启后只看盘上快照——未触发的重排、在途的不重发、终态不复活、
 * 过期太久的落 expired。
 * 真实模块：reminder-recovery.classifyReminderRecovery、reminder-store、reminder-dispatcher。
 */
async function runB09(harness) {
  harness.dirOf('b09');
  const file = harness.pathOf('b09', 'reminders.json');
  const store = createReminderStore(file);
  const now = harness.now();

  const seedRecords = [
    { taskId: 't-future', conversationKey: KEY, text: '未来的提醒', dueAt: now + 60 * 60 * 1000, status: 'queued' },
    { taskId: 't-due', conversationKey: KEY, text: '刚过期的提醒', dueAt: now - 5 * 60 * 1000, status: 'queued' },
    { taskId: 't-inflight', conversationKey: KEY, text: '发送中（结果未确认）', dueAt: now - 2 * 60 * 1000, status: 'processing', attempt: 1, firedAt: now - 2 * 60 * 1000 },
    { taskId: 't-terminal', conversationKey: KEY, text: '已经发过', dueAt: now - 60 * 60 * 1000, status: 'sent', attempt: 1, firedAt: now - 60 * 60 * 1000 },
    { taskId: 't-stale', conversationKey: KEY, text: '过期太久', dueAt: now - 25 * 60 * 60 * 1000, status: 'queued' },
  ];
  const saved = store.save(seedRecords);
  harness.assert(saved.ok === true, 'snapshot-save-failed');

  const kinds = {};
  for (const record of seedRecords) kinds[record.taskId] = classifyReminderRecovery(record, harness.now()).kind;
  harness.step({
    title: '重启第一步：按恢复规则给每条记录分类',
    input: { kind: 'persisted-snapshot', note: '五条合成记录：未来/到期/在途/终态/过期太久' },
    expected: { 't-future': 'queued', 't-due': 'due', 't-inflight': 'pending', 't-terminal': 'terminal', 't-stale': 'expired' },
    actual: kinds,
  });

  const sends = [];
  const dispatcher = createReminderDispatcher(file, {
    now: () => harness.now(),
    send: (delivery) => {
      sends.push(delivery.taskId);
      return 'sent';
    },
  });
  const outcomes = [];
  for (let index = 0; index < 10; index += 1) {
    const next = await dispatcher.dispatchNext();
    if (!next.ok) {
      outcomes.push('error:' + (typeof next.error === 'string' ? next.error : 'unknown'));
      break;
    }
    if (next.result === null) {
      outcomes.push('null');
      break;
    }
    outcomes.push(next.result.status);
  }

  const after = store.load();
  const statuses = {};
  if (after.ok) for (const record of after.records) statuses[record.taskId] = record.status;
  harness.step({
    title: '重启第二步：只补发该发的，在途与终态一律不动',
    input: { kind: 'scheduler-tick', note: '重启后连续派发直到没有候选' },
    expected: {
      outcomes: 'expired|sent|null',
      sends: 't-due',
      statuses: 't-due=sent,t-future=queued,t-inflight=processing,t-stale=expired,t-terminal=sent',
    },
    actual: {
      outcomes: outcomes.join('|'),
      sends: sends.join(','),
      statuses: Object.keys(statuses).sort().map((id) => id + '=' + statuses[id]).join(','),
    },
  });

  return { modules: ['reminder-recovery.js', 'reminder-store.js', 'reminder-dispatcher.js'] };
}

/* ══════════════════════ B-10 工具失败 ══════════════════════ */

/**
 * B-10：工具 handler 抛错 → 只回闭合码 handler-failed，不重试、不伪成功；
 * failurePolicy=rollback 时补偿恰好执行一次。
 * 真实模块：tools/registry.js（纯内存、离线）。
 */
async function runB10(harness) {
  const registry = createToolRegistry({ now: () => harness.now() });
  // 只用来验证「异常文本不进结果、不进审计」的哨兵串（合成内容）。
  const sentinel = 'SENTINEL-do-not-leak';
  let stopCalls = 0;
  let rollbackCalls = 0;
  let compensateCalls = 0;

  const emptySchema = { type: 'object', additionalProperties: false, properties: {} };

  registry.register({
    name: 'demo_fail_read',
    description: '演示：handler 同步抛错的只读工具（纯内存）',
    parameters: emptySchema,
    risk: 'read-only',
    permissions: ['note:read'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['durationMs'],
    handler() {
      stopCalls += 1;
      throw new Error('synthetic handler failure ' + sentinel);
    },
  });
  registry.register({
    name: 'demo_fail_write',
    description: '演示：失败后走补偿的可逆工具（纯内存）',
    parameters: emptySchema,
    risk: 'reversible',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'rollback',
    compensate() {
      compensateCalls += 1;
    },
    schedulable: false,
    auditFields: ['durationMs'],
    handler() {
      rollbackCalls += 1;
      return Promise.reject(new Error('synthetic handler failure ' + sentinel));
    },
  });

  const stopped = await registry.execute('demo_fail_read', {}, { permissions: ['note:read'] });
  const rolledBack = await registry.execute('demo_fail_write', {}, { permissions: ['note:write'] });
  const executeCodes = registry.audit()
    .filter((entry) => entry.event === 'execute')
    .map((entry) => entry.code);

  harness.step({
    title: '工具失败：stop 直接失败，rollback 只补偿一次，异常文本不外泄',
    input: { kind: 'tool-call', items: [{ text: 'demo_fail_read / demo_fail_write', userId: 'system' }] },
    tools: [
      { name: 'demo_fail_read', ok: stopped.ok === true, code: stopped.code, policy: 'stop' },
      { name: 'demo_fail_write', ok: rolledBack.ok === true, code: rolledBack.code, policy: 'rollback' },
    ],
    expected: {
      // 期望值一律写字面量，不引用产品常量：否则产品改了码值，场景会跟着"自动仍然通过"。
      stopCode: 'handler-failed',
      stopCalls: 1,
      rollbackCode: 'handler-failed',
      compensated: true,
      compensateCalls: 1,
      rollbackCalls: 1,
      auditCodes: 'handler-failed|handler-failed',
      leaked: false,
    },
    actual: {
      stopCode: stopped.code ?? '',
      stopCalls,
      rollbackCode: rolledBack.code ?? '',
      compensated: rolledBack.compensated === true,
      compensateCalls,
      rollbackCalls,
      auditCodes: executeCodes.join('|'),
      leaked: JSON.stringify([stopped, rolledBack, registry.audit()]).includes(sentinel),
    },
  });

  return { modules: ['tools/registry.js'] };
}

/* ══════════════════════ B-11 模型失败 ══════════════════════ */

/**
 * B-11：生成阶段失败 → 一个字段都不落（无投递、无记忆提交），原始异常原样抛给上层，
 * onGenerationError 恰好触发一次（宿主可据此留档重放）。
 * 真实模块：index.js#handleTurn 的失败语义。模型传输是脚本化替身（见 harness 文件头）。
 */
async function runB11(harness) {
  const memory = harness.makeMemory('b11');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ probability: 0 });
  const brain = harness.makeBrain({ memory, replies: [{ fail: 'model-unavailable' }] });
  const message = privateMessage('在吗');

  let generationErrors = 0;
  let thrown = null;
  try {
    await handleTurn({ bot: harness.bot, brain, human, memory, waker }, [message], baseCfg(), {
      onGenerationError: () => { generationErrors += 1; },
    });
  } catch (error) {
    thrown = error;
  }

  const memoryFacts = facts(harness, memory);
  harness.step({
    title: '生成失败：不发送、不提交记忆、异常原样上抛',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }] },
    model: { calls: brain.calls.length, failed: true, failCode: thrown?.code },
    memory: { ...memoryFacts, committed: memoryFacts.personKnown },
    delivery: { attempted: harness.bot.deliveries.length, sent: 0, receipts: [], texts: [], channel: 'qq-private-synthetic' },
    expected: { calls: 1, failed: true, thrownCode: 'model-unavailable', generationErrors: 1, attempted: 0, people: 0, turns: 0, committed: false },
    actual: {
      calls: brain.calls.length,
      failed: thrown !== null,
      thrownCode: thrown?.code ?? '',
      generationErrors,
      attempted: harness.bot.deliveries.length,
      people: memoryFacts.people,
      turns: memoryFacts.turns,
      committed: memoryFacts.personKnown,
    },
  });

  return { modules: ['index.js#handleTurn'], limitation: 'model-transport-synthetic', note: HUMANIZER_NOTE };
}

/* ══════════════════ B-13 投递未确认不重发 ══════════════════ */

/**
 * B-13：第一条确认、第二条回执 unknown → 立即停下，不重试、不重放整轮、
 * 不提交记忆；失败只以固定 code 报给窗口 onError。
 * 真实模块：Humanizer.say（回执判定）、handleTurn、ConversationWindow 的 onError 通道。
 */
async function runB13(harness) {
  const memory = harness.makeMemory('b13');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ probability: 0 });
  harness.setSendBehavior(['confirmed', 'unknown']);
  // 两段都要 ≥6 字：Humanizer.split 会把过短的相邻句合并成一条，那样就测不到"第 2 条失败"。
  const brain = harness.makeBrain({ memory, replies: [{ text: '第一条消息先发出去\n第二条消息要失败' }] });

  const failures = [];
  const window = createPrivateTurnWindow({
    deps: { bot: harness.bot, brain, human, memory, waker },
    cfg: baseCfg(),
    windowMs: 1500,
    onError: (error) => failures.push({
      code: error && typeof error.code === 'string' ? error.code : 'unknown',
      status: error && typeof error.status === 'string' ? error.status : '',
      sent: Number.isInteger(error?.sent) ? error.sent : null,
    }),
  });

  await pushPrivateMessage(window, privateMessage('说两句吧', { messageId: 'm-b13' }));
  await window.close();
  // 失败发生的那一刻记下已发送条数，再等一拍，直接观察"之后还有没有新的发送/重试"。
  const deliveredAtFailure = harness.bot.deliveries.length;
  await new Promise((resolve) => { setImmediate(resolve); });
  const retriesAfterFailure = harness.bot.deliveries.length - deliveredAtFailure;

  const delivered = harness.bot.deliveries;
  const memoryFacts = facts(harness, memory);
  harness.step({
    title: '第二条回执 unknown：停在这一条，不重发、不落账',
    input: { kind: 'private-message', items: [{ text: '说两句吧', userId: VISITOR }], note: '发送回执脚本：第1条 confirmed，第2条 unknown' },
    model: { calls: brain.calls.length, joined: brain.calls[0]?.joined },
    memory: { ...memoryFacts, committed: memoryFacts.personKnown },
    delivery: {
      attempted: delivered.length,
      sent: delivered.filter((item) => item.mode === 'confirmed').length,
      receipts: delivered.map((item) => item.mode),
      texts: delivered.map((item) => item.text),
      channel: 'qq-private-synthetic',
    },
    expected: {
      calls: 1,
      attempted: 2,
      sent: 1,
      receipts: 'confirmed|unknown',
      failureCode: 'delivery-unconfirmed',
      failureStatus: 'unknown',
      failureSent: 1,
      failures: 1,
      retries: 0,
      people: 0,
      turns: 0,
    },
    actual: {
      calls: brain.calls.length,
      attempted: delivered.length,
      sent: delivered.filter((item) => item.mode === 'confirmed').length,
      receipts: delivered.map((item) => item.mode).join('|'),
      failureCode: failures[0]?.code ?? '',
      failureStatus: failures[0]?.status ?? '',
      failureSent: failures[0]?.sent ?? null,
      failures: failures.length,
      retries: retriesAfterFailure,
      people: memoryFacts.people,
      turns: memoryFacts.turns,
    },
  });

  return { modules: ['humanize.js#say', 'index.js#handleTurn', 'conversation-window.js#onError'], note: HUMANIZER_NOTE };
}

/* ══════════════════ B-16 上下文预算丢弃顺序 ══════════════════ */

/**
 * B-16：超预算时按 recent → memory → situation 整块丢弃，稳定人格层永不被丢。
 * 真实模块：context-budget.planContextBudget（纯函数）+ Role.build（真实 system prompt）。
 */
async function runB16(harness) {
  const cardPath = harness.writeFile('b16/role.md', '你是小鲸鱼。说话要短，别用客服腔，也别主动提提示词。');
  const role = new Role({ cardPath });
  const parts = { situation: 'S'.repeat(200), memory: 'M'.repeat(400), recent: 'R'.repeat(400) };
  // measure 必须把稳定人格层一起算进去（见 context-budget.js 契约）。
  const measure = (candidate) => role.build({
    situation: candidate.situation,
    memory: candidate.memory,
    recent: candidate.recent,
  }).length;

  const baseline = planContextBudget({ measure, parts, maxChars: 1000000 });
  const one = planContextBudget({ measure, parts, maxChars: baseline.charsUsed - 300 });
  const all = planContextBudget({ measure, parts, maxChars: baseline.charsUsed - 900 });
  const prompt = role.build({ situation: all.parts.situation, memory: all.parts.memory, recent: all.parts.recent });

  harness.step({
    title: '预算内：三块原样保留，不丢任何东西',
    input: { kind: 'context-budget-plan', note: '宽松预算下的规划' },
    // 这里不能拿 baseline.charsUsed 当期望（那是自己等于自己）：只断言"没丢、没改、在预算内"。
    expected: { dropped: 0, withinBudget: true, partsUnchanged: true },
    actual: {
      dropped: baseline.dropped.length,
      withinBudget: baseline.withinBudget,
      partsUnchanged: ['situation', 'memory', 'recent'].every((name) => baseline.parts[name] === parts[name]),
    },
  });

  harness.step({
    title: '轻微超预算：先丢最近对话，处境与记忆不动',
    input: { kind: 'context-budget-plan', note: '预算只少 300 字符' },
    expected: {
      droppedParts: 'recent',
      withinBudget: true,
      situationKept: true,
      memoryKept: true,
      diagnosticCode: 'part-dropped',
    },
    actual: {
      droppedParts: one.dropped.map((item) => item.part).join('|'),
      withinBudget: one.withinBudget,
      situationKept: one.parts.situation === parts.situation,
      memoryKept: one.parts.memory === parts.memory,
      diagnosticCode: one.diagnostics.some((item) => item.code === 'part-dropped') ? 'part-dropped' : '',
    },
  });

  harness.step({
    title: '大幅超预算：按契约顺序逐块丢，稳定人格层仍在 prompt 里',
    input: { kind: 'context-budget-plan', note: '预算少 900 字符，三块都不够放' },
    expected: {
      // 丢弃顺序是契约，必须写成字面量；引用 DEFAULT_DROP_ORDER 会让这条断言恒真。
      droppedParts: 'recent|memory|situation',
      stableLayerKept: true,
      cardLayerKept: true,
      situationDropped: true,
      withinBudget: true,
    },
    actual: {
      droppedParts: all.dropped.map((item) => item.part).join('|'),
      stableLayerKept: prompt.includes('【基本规矩】'),
      cardLayerKept: prompt.includes('【完整设定】'),
      situationDropped: all.parts.situation === '',
      // 三块都丢完只剩稳定层；这里如实记录是否真的收敛进预算，而不是假装一定收敛。
      withinBudget: all.withinBudget,
    },
  });

  return { modules: ['context-budget.js', 'role.js'] };
}

/* ══════════════ B-17 生成 / 投递 / 记忆提交分离 ══════════════ */

/**
 * B-17：生成成功 ≠ 已送达 ≠ 已落账。顺序固定 brain.reply → bot.send → commit；
 * 投递未确认时 commit 不执行；干跑既不发送也不落账。
 * 真实模块：handleTurn、Humanizer、Memory。模型是脚本化替身（见 harness 文件头）。
 */
async function runB17(harness) {
  const memory = harness.makeMemory('b17');
  const human = new Humanizer({ enabled: false });
  const waker = new Waker({ probability: 0 });
  harness.setSendBehavior(['confirmed', 'unknown', 'confirmed']);
  const brain = harness.makeBrain({ memory, replies: [{ text: '好' }, { text: '嗯' }, { text: '在' }] });
  const deps = { bot: harness.bot, brain, human, memory, waker };
  const message = privateMessage('在吗');

  await handleTurn(deps, [message], baseCfg());
  const firstEvents = harness.events.join('>');
  const afterFirst = facts(harness, memory);

  harness.step({
    title: '送达后的顺序：生成 → 投递 → 提交，各一次',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }] },
    model: { calls: brain.calls.length, joined: brain.calls[0]?.joined, deferred: true, committed: true },
    memory: { ...afterFirst, committed: afterFirst.personKnown },
    delivery: { attempted: 1, sent: 1, receipts: ['confirmed'], texts: harness.bot.deliveries.map((item) => item.text), channel: 'qq-private-synthetic' },
    expected: { order: 'brain.reply>bot.send>memory.commit', calls: 1, sent: 1, committed: true, turns: 1 },
    actual: {
      order: firstEvents,
      calls: brain.calls.length,
      sent: harness.bot.deliveries.length,
      committed: afterFirst.personKnown,
      turns: afterFirst.turns,
    },
  });

  let thrown = null;
  try {
    await handleTurn(deps, [message], baseCfg());
  } catch (error) {
    thrown = error;
  }
  const afterSecond = facts(harness, memory);
  const commitEvents = harness.events.filter((event) => event === 'memory.commit').length;
  harness.step({
    title: '生成成功但投递未确认：commit 不执行，记忆不新增',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }], note: '第二次同内容投递，回执脚本为 unknown' },
    model: { calls: brain.calls.length, joined: brain.calls[1]?.joined, deferred: true, committed: false },
    memory: { ...afterSecond, committed: false },
    delivery: {
      attempted: harness.bot.deliveries.length,
      sent: 1,
      receipts: harness.bot.deliveries.map((item) => item.mode),
      texts: harness.bot.deliveries.map((item) => item.text),
      channel: 'qq-private-synthetic',
    },
    expected: { calls: 2, thrownCode: 'delivery-unconfirmed', commits: 1, turns: 1, attempted: 2, sent: 1 },
    actual: {
      calls: brain.calls.length,
      thrownCode: thrown?.code ?? '',
      commits: commitEvents,
      turns: afterSecond.turns,
      attempted: harness.bot.deliveries.length,
      sent: harness.bot.deliveries.filter((item) => item.mode === 'confirmed').length,
    },
  });

  await handleTurn(deps, [message], baseCfg({ dryRun: true }));
  const afterDryRun = facts(harness, memory);
  harness.step({
    title: '干跑：生成照常发生，但既不发也不落账',
    input: { kind: 'private-message', items: [{ text: message.text, userId: message.userId }], note: 'dryRun=true 的一轮' },
    model: { calls: brain.calls.length, joined: brain.calls[2]?.joined, deferred: true, committed: false },
    expected: { calls: 3, commits: 1, turns: 1, attempted: 2 },
    actual: {
      calls: brain.calls.length,
      commits: harness.events.filter((event) => event === 'memory.commit').length,
      turns: afterDryRun.turns,
      attempted: harness.bot.deliveries.length,
    },
  });

  return { modules: ['index.js#handleTurn', 'humanize.js', 'memory.js'], limitation: 'model-transport-synthetic', note: HUMANIZER_NOTE };
}

/* ═══════════════ X-01 工具确认 / 高风险门控（增补） ═══════════════ */

/** X-01：confirm 级工具必须走一次性批准；high-risk 只登记、永不执行。 */
async function runX01(harness) {
  let executed = 0;
  let highRiskExecuted = 0;
  const registry = createToolRegistry({
    now: () => harness.now(),
    createActionId: () => 'action-1',
  });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '演示正文' } },
  };
  registry.register({
    name: 'demo_confirm', description: '演示：需要确认的工具（纯内存）', parameters: schema,
    risk: 'confirm', permissions: ['note:write'], timeoutMs: 1000, failurePolicy: 'stop',
    compensate: null, schedulable: false, auditFields: ['trigger'],
    handler() { executed += 1; return { done: true }; },
  });
  registry.register({
    name: 'demo_high_risk', description: '演示：高风险工具只登记（纯内存）', parameters: schema,
    risk: 'high-risk', permissions: ['note:write'], timeoutMs: 1000, failurePolicy: 'stop',
    compensate: null, schedulable: false, auditFields: ['trigger'],
    handler() { highRiskExecuted += 1; return { done: true }; },
  });

  const permissions = ['note:write'];
  const noId = await registry.execute('demo_confirm', { text: 'ok' }, { permissions });
  const request = registry.requestConfirmation('demo_confirm', { text: 'ok' });
  const pending = await registry.execute('demo_confirm', { text: 'ok' }, { permissions, actionId: request.actionId });
  const approved = registry.decideConfirmation(request.actionId, 'approve');
  const ran = await registry.execute('demo_confirm', { text: 'ok' }, { permissions, actionId: request.actionId });
  const reused = await registry.execute('demo_confirm', { text: 'ok' }, { permissions, actionId: request.actionId });
  const highRisk = await registry.execute('demo_high_risk', { text: 'ok' }, { permissions });

  harness.step({
    title: '确认门控：未批准不执行、批准一次性、高风险永不执行',
    input: { kind: 'tool-call', items: [{ text: 'demo_confirm / demo_high_risk', userId: 'system' }], note: '先无凭据、再带凭据、最后复用凭据' },
    tools: [
      { name: 'demo_confirm', ok: ran.ok === true, code: ran.code, policy: 'confirm' },
      { name: 'demo_high_risk', ok: highRisk.ok === true, code: highRisk.code, policy: 'high-risk' },
    ],
    expected: {
      withoutId: 'confirmation-required',
      pending: 'confirmation-pending',
      requestOk: true,
      approved: true,
      executed: 'ok',
      reuse: 'confirmation-used',
      highRisk: 'risk-not-allowed',
      handlerRuns: 1,
      highRiskRuns: 0,
    },
    actual: {
      withoutId: noId.code ?? '',
      pending: pending.code ?? '',
      requestOk: request.ok === true,
      approved: approved.ok === true,
      executed: ran.ok === true ? 'ok' : (ran.code ?? ''),
      reuse: reused.code ?? '',
      highRisk: highRisk.code ?? '',
      handlerRuns: executed,
      highRiskRuns: highRiskExecuted,
    },
  });

  return { modules: ['tools/registry.js'] };
}

/* ═══════════════ X-02 提醒快照 fail-closed（增补） ═══════════════ */

/** X-02：坏快照读不懂就报错、保存被拒、原文件不被抹掉；重复 taskId 直接拒。 */
async function runX02(harness) {
  const broken = harness.writeFile('x02/reminders.json', '{ "version": 1, "records": [ ' + '\n');
  const store = createReminderStore(broken);
  const loaded = store.load();
  const record = { taskId: 't-1', conversationKey: KEY, text: '演示', dueAt: harness.now() + 1000, status: 'queued' };
  const saveBroken = store.save([record]);
  const unchanged = fs.readFileSync(broken, 'utf8') === '{ "version": 1, "records": [ \n';
  const duplicate = store.save([record, { ...record, text: '另一个' }]);

  harness.step({
    title: '坏快照 fail-closed：读报错、写被拒、原文件原样保留',
    input: { kind: 'persisted-snapshot', note: '故意写坏的 JSON 快照' },
    expected: {
      loadError: 'invalid-snapshot',
      saveError: 'invalid-snapshot',
      unchanged: true,
      duplicateError: 'invalid-records',
    },
    actual: {
      loadError: loaded.ok ? '' : loaded.error,
      saveError: saveBroken.ok ? '' : saveBroken.error,
      unchanged,
      duplicateError: duplicate.ok ? '' : duplicate.error,
    },
  });

  return { modules: ['reminder-store.js', 'reminder-recovery.js'] };
}

/* ═══════════════ X-03 工具安全内核的审计边界（增补） ═══════════════ */

/**
 * X-03：confirm 级工具的批准绑定「工具名 + 参数摘要」、一次性消费，high-risk 只登记；
 * 同时证明审计/结果里只有闭合码、状态、短摘要与关联标识，不含参数正文与 actionId。
 * 真实模块：tools/registry.js（纯内存、离线）。
 */
async function runX03(harness) {
  // 只用来验证「正文不进结果、不进审计」的哨兵串（合成内容，不对应任何真实数据）。
  const BODY = 'SENTINEL-X03-body-must-not-leak';
  const OTHER_BODY = 'SENTINEL-X03-other-body';
  let actionSeq = 0;
  let confirmRuns = 0;
  let highRiskRuns = 0;

  const registry = createToolRegistry({
    now: () => harness.now(),
    createActionId: () => 'x03-act-' + (actionSeq += 1),
  });
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 80, description: '演示正文' } },
  };
  registry.register({
    name: 'demo_x03_confirm',
    description: '演示：需要确认且审计只留摘要的工具（纯内存）',
    parameters: schema,
    risk: 'confirm',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['trigger', 'argsDigest'],
    handler(args) {
      confirmRuns += 1;
      return { done: true, runs: confirmRuns, chars: args.text.length };
    },
  });
  registry.register({
    name: 'demo_x03_high_risk',
    description: '演示：高风险工具只登记、永不执行（纯内存）',
    parameters: schema,
    risk: 'high-risk',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['trigger', 'argsDigest'],
    handler() {
      highRiskRuns += 1;
      return { done: true };
    },
  });

  const permissions = ['note:write'];
  const noId = await registry.execute('demo_x03_confirm', { text: BODY }, { permissions });
  const request = registry.requestConfirmation('demo_x03_confirm', { text: BODY });
  const pending = await registry.execute('demo_x03_confirm', { text: BODY }, { permissions, actionId: request.actionId });
  const approved = registry.decideConfirmation(request.actionId, 'approve');
  // 换参数不能用同一个批准：摘要绑定失败，批准仍然没被消耗。
  const mismatch = await registry.execute('demo_x03_confirm', { text: OTHER_BODY }, { permissions, actionId: request.actionId });
  const ran = await registry.execute('demo_x03_confirm', { text: BODY }, { permissions, actionId: request.actionId });
  const reused = await registry.execute('demo_x03_confirm', { text: BODY }, { permissions, actionId: request.actionId });
  const highRisk = await registry.execute('demo_x03_high_risk', { text: BODY }, { permissions });
  const highRiskRequest = registry.requestConfirmation('demo_x03_high_risk', { text: BODY });

  harness.step({
    title: '确认一次性：未批准不执行、换参数不复用、批准只用一次',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_x03_confirm', userId: 'system' }],
      note: '同一 actionId 依次：无凭据 → 未批准 → 换参数 → 原参数 → 复用',
    },
    tools: [
      { name: 'demo_x03_confirm', ok: ran.ok === true, code: ran.ok === true ? 'ok' : ran.code, policy: 'confirm' },
      { name: 'demo_x03_high_risk', ok: highRisk.ok === true, code: highRisk.code, policy: 'high-risk' },
    ],
    expected: {
      // 期望值一律写字面量，不引用 TOOL_RESULT_CODES：否则产品改码值，场景跟着"自动仍然通过"。
      withoutId: 'confirmation-required',
      requestOk: true,
      requestStatus: 'pending',
      pending: 'confirmation-pending',
      approved: true,
      mismatch: 'confirmation-mismatch',
      executed: 'ok',
      executedRuns: 1,
      reuse: 'confirmation-used',
      handlerRuns: 1,
      highRiskRuns: 0,
    },
    actual: {
      withoutId: noId.code ?? '',
      requestOk: request.ok === true,
      requestStatus: request.status ?? '',
      pending: pending.code ?? '',
      approved: approved.ok === true,
      mismatch: mismatch.code ?? '',
      executed: ran.ok === true ? 'ok' : (ran.code ?? ''),
      executedRuns: ran.ok === true ? ran.value.runs : -1,
      reuse: reused.code ?? '',
      handlerRuns: confirmRuns,
      highRiskRuns,
    },
  });

  const audit = registry.audit();
  const executeEntries = audit.filter((entry) => entry.event === 'execute');
  const digests = executeEntries
    .map((entry) => entry.argsDigest)
    .filter((value) => typeof value === 'string');
  // 只把「本该脱敏」的东西交给泄漏检查：request 的返回值里本来就有 actionId（凭据）。
  const inspectable = JSON.stringify([
    registry.audit(),
    registry.describeConfirmation(request.actionId),
    noId, pending, mismatch, ran, reused, highRisk, highRiskRequest,
  ]);

  harness.step({
    title: '高风险只登记 + 审计不泄露正文：只留摘要与关联标识',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_x03_high_risk', userId: 'system' }],
      note: '同样的合成正文同时喂给 confirm 与 high-risk 工具',
    },
    tools: [
      { name: 'demo_x03_high_risk', ok: highRisk.ok === true, code: highRisk.code, policy: 'high-risk' },
    ],
    expected: {
      highRiskExecute: 'risk-not-allowed',
      highRiskRequest: 'risk-not-allowed',
      highRiskRuns: 0,
      auditEvents: 'execute|confirmation-request|execute|confirmation-decision'
        + '|execute|execute|execute|execute|confirmation-request-rejected',
      auditConfirmations: 'missing|pending|mismatch|approved|consumed|not-required',
      digestCount: 5,
      digestsAreShortHashes: true,
      leakedBody: false,
      leakedActionId: false,
      correlationPrefixed: true,
    },
    actual: {
      highRiskExecute: highRisk.code ?? '',
      highRiskRequest: highRiskRequest.code ?? '',
      highRiskRuns,
      auditEvents: audit.map((entry) => entry.event).join('|'),
      auditConfirmations: executeEntries.map((entry) => entry.confirmation).join('|'),
      digestCount: digests.length,
      digestsAreShortHashes: digests.every((value) => /^[0-9a-f]{16}$/u.test(value)),
      leakedBody: inspectable.includes(BODY) || inspectable.includes(OTHER_BODY),
      leakedActionId: inspectable.includes(request.actionId),
      correlationPrefixed: audit.every((entry) => typeof entry.correlationId === 'string'
        && entry.correlationId.startsWith('c-')),
    },
  });

  return { modules: ['tools/registry.js'] };
}

/* ═══════════════ X-04 媒体管线的离线证据（增补） ═══════════════ */

/**
 * X-04：离线 ASR 桩转写 → 低置信度不写长期记忆（confirmed=true 才写）→ 临时音频
 * 落临时目录后被删除并留审计（审计不含音频正文）→ TTS 失败仍保留文字回退。
 * 真实模块：media/pipeline.js、media/offline-stub.js、media/store.js。
 */
async function runX04(harness) {
  const root = harness.dirOf('x04');
  const store = createMediaStore({
    root,
    now: () => harness.now(),
    retentionMs: 60 * 60 * 1000,
  });
  // 合成音频字节：不是真实录音，只用来验证「临时落盘 → 删除」的路径。
  const payload = Buffer.from('x04-synthetic-audio-bytes', 'utf8');
  const audioInput = {
    kind: 'audio',
    mime: 'audio/ogg',
    size: payload.length,
    durationMs: 1200,
    ref: 'synthetic://x04/voice-1',
    bytes: payload,
  };

  /** 只记录「有没有被写、写了什么形状」，不落任何真实记忆。 */
  const writes = [];
  const memoryPort = {
    async remember(record) {
      writes.push({
        chars: [...String(record?.text ?? '')].length,
        confidence: record?.confidence,
        source: record?.source,
      });
    },
  };

  const lowAsr = createOfflineAsrStub({
    transcripts: [{ text: 'synthetic transcript one', confidence: 0.2, language: 'en' }],
  });
  const low = await ingestAudio({
    asr: lowAsr,
    store,
    input: audioInput,
    memory: memoryPort,
    minConfidence: 0.6,
  });

  harness.step({
    title: '离线 ASR 桩：低置信度转写可用，但不写长期记忆',
    input: {
      kind: 'audio-message',
      items: [{ text: 'synthetic audio 1.2s', userId: VISITOR }],
      note: '音频与转写都是合成串；ASR 是 offline-asr-stub',
    },
    expected: {
      ok: true,
      transcriptChars: 24,
      confidence: 0.2,
      language: 'en',
      provider: 'offline-asr-stub',
      eligible: false,
      written: false,
      reason: 'low-confidence-needs-confirmation',
      memoryWrites: 0,
    },
    actual: {
      ok: low.ok === true,
      transcriptChars: low.ok === true ? low.transcript.text.length : -1,
      confidence: low.transcript?.confidence ?? null,
      language: low.transcript?.language ?? '',
      provider: low.transcript?.provider ?? '',
      eligible: low.memory?.eligible === true,
      written: low.memory?.written === true,
      reason: low.memory?.reason ?? '',
      memoryWrites: writes.length,
    },
  });

  // 正对照：同一份低置信度转写，显式 confirmed=true 才会写入 —— 说明上面不是"记忆端口根本没接"。
  const confirmedAsr = createOfflineAsrStub({
    transcripts: [{ text: 'synthetic transcript two', confidence: 0.2, language: 'en' }],
  });
  const confirmed = await ingestAudio({
    asr: confirmedAsr,
    store,
    input: { ...audioInput, confirmed: true },
    memory: memoryPort,
    minConfidence: 0.6,
  });

  harness.step({
    title: '确认后才写：confirmed=true 时同一端口只写一次',
    input: {
      kind: 'audio-message',
      items: [{ text: 'synthetic audio 1.2s (confirmed)', userId: VISITOR }],
      note: '同一段合成音频，显式带 confirmed=true',
    },
    expected: {
      ok: true,
      eligible: true,
      written: true,
      reason: 'written',
      memoryWrites: 1,
      writeChars: 24,
      writeSource: 'asr',
    },
    actual: {
      ok: confirmed.ok === true,
      eligible: confirmed.memory?.eligible === true,
      written: confirmed.memory?.written === true,
      reason: confirmed.memory?.reason ?? '',
      memoryWrites: writes.length,
      writeChars: writes[0]?.chars ?? -1,
      writeSource: writes[0]?.source ?? '',
    },
  });

  const audit = store.audit();
  const leftovers = harness.tempFiles().filter((file) => file.startsWith('x04/'));
  const temporary = low.metadata?.temporary ?? {};
  harness.step({
    title: '临时音频：写入临时目录后删除，删除留审计且审计不含音频正文',
    input: {
      kind: 'audio-message',
      items: [{ text: 'synthetic audio 1.2s', userId: VISITOR }],
      note: '两次 ingest 各自 put 一次、delete 一次（retainInput 默认 false）',
    },
    expected: {
      auditActions: 'put|delete|put|delete',
      deleteOutcomes: 'deleted|deleted',
      deleteReasons: 'delete|delete',
      remainingEntries: 0,
      filesLeft: 0,
      tempDeleted: true,
      tempRetained: false,
      tempCleanupError: null,
      tempRefShape: true,
      leakedPayload: false,
      auditHasSha256: true,
    },
    actual: {
      auditActions: audit.map((entry) => entry.action).join('|'),
      deleteOutcomes: audit.filter((entry) => entry.action === 'delete').map((entry) => entry.outcome).join('|'),
      deleteReasons: audit.filter((entry) => entry.action === 'delete').map((entry) => entry.reason).join('|'),
      remainingEntries: store.list().length,
      filesLeft: leftovers.length,
      tempDeleted: temporary.deleted === true,
      tempRetained: temporary.retained === true,
      tempCleanupError: temporary.cleanupError ?? null,
      tempRefShape: /^media:\/\/[0-9a-f-]{36}$/u.test(String(temporary.ref ?? '')),
      leakedPayload: JSON.stringify(audit).includes(payload.toString()),
      auditHasSha256: audit.every((entry) => /^[0-9a-f]{64}$/u.test(String(entry.sha256 ?? ''))),
    },
  });

  const ttsText = 'keep this text';
  const failedVoice = await renderVoice({
    tts: createOfflineTtsStub({ failWith: true }),
    text: ttsText,
    store,
    format: 'ogg',
  });

  harness.step({
    title: 'TTS 失败：闭合码 tts-failed，文字回退原样保留',
    input: {
      kind: 'voice-render',
      items: [{ text: ttsText, userId: VISITOR }],
      note: 'offline-tts-stub 被要求失败；不产生真实语音',
    },
    expected: {
      ok: false,
      code: 'tts-failed',
      fallbackKept: true,
      fallbackChars: 14,
      hasAudioRef: false,
      audioNotStored: true,
      auditActionsUnchanged: 'put|delete|put|delete',
    },
    actual: {
      ok: failedVoice.ok === true,
      code: failedVoice.error?.code ?? '',
      fallbackKept: failedVoice.fallbackText === ttsText,
      fallbackChars: [...String(failedVoice.fallbackText ?? '')].length,
      hasAudioRef: failedVoice.audioRef !== null,
      audioNotStored: store.list().length === 0,
      auditActionsUnchanged: store.audit().map((entry) => entry.action).join('|'),
    },
  });

  return {
    modules: ['media/pipeline.js', 'media/offline-stub.js', 'media/store.js'],
    limitation: 'media-adapters-synthetic-offline',
  };
}

/* ═══════════════ X-05 离线 QQ presence runtime（增补） ═══════════════ */

/** 合成账号 / 状态文件名：都是占位值，不对应任何真实账号，也不进证据。 */
const X05_OWNER = 'owner-synthetic-alpha';
const X05_OTHER = 'owner-synthetic-beta';
const X05_STRANGER = 'stranger-synthetic-gamma';
const X05_STATE_FILE = 'presence-qq-state.json';
/** 落盘字段白名单写成字面量：不从产品常量借，否则产品改字段这里会跟着变。 */
const X05_STATE_KEYS = 'activeMs|cooldowns|deliveredIds|kind|sessionStartedAt|state|updatedAt|version';

/**
 * 合成的 presenceQQ 配置：阈值压小好驱动，欢迎冷却保持 90 分钟（重启后仍要生效）。
 * 全部是字面量期望所依赖的输入，不是从产品默认值里读来的。
 */
function x05PresenceQQ(overrides = {}) {
  return {
    enabled: true,
    ownerId: X05_OWNER,
    idleMs: 1000,
    awayMs: 5000,
    returnAfterMs: 0,
    workAfterMs: 60 * 60 * 1000,
    cooldownMs: 90 * 60 * 1000,
    minGapMs: 0,
    maxPerDay: 5,
    quietHours: null,
    intentTtlMs: 10 * 60 * 1000,
    maxPending: 8,
    ...overrides,
  };
}

/**
 * X-05：真实 presence-qq-runtime.js 装配的 QQ 在场入口，离线跑一遍。
 * 真实模块：presence-qq-runtime.js、humanize.js（及其下游 presence/session.js、
 * presence/persistence.js、presence/qq-adapter.js、presence-runtime.js、
 * presence-interaction.js、presence.js）。假件只有合成 bot 与虚拟时钟。
 *
 * 依次验证：
 *   ① enabled / owner 白名单闸门：未开启、owner 缺失、owner 不在白名单都 fail-closed，
 *      不建发送、不落盘（多人白名单也不广播）；
 *   ② away → present 产生一条 welcome intent，且只投递给显式配置的唯一 owner；
 *   ③ 同一进程内再回来一次：冷却挡住第二条欢迎，锚点与台账都不动；
 *   ④ 状态文件只有白名单字段，且不含 intent 正文；
 *   ⑤ 新 host 实例从同一个临时目录恢复冷却与投递台账，重启不补发旧欢迎，
 *      冷却/去重继续挡住重复发送；
 *   ⑥ owner 私聊让 pending 作废且不自指发送；群聊与非 owner 私聊完全不触发。
 *
 * 不连 QQ / OneBot / 网络：bot 是 harness 的合成件，时间全部来自虚拟时钟。
 */
async function runX05(harness) {
  const human = new Humanizer({ enabled: false });
  const hostOf = (cfg) => createPresenceQQHost({
    cfg,
    bot: harness.bot,
    human,
    now: () => harness.now(),
  });

  /* ── ① 配置闸门 ── */
  const gateDir = harness.dirOf('x05/gate');
  const gateStatePath = harness.pathOf('x05/gate', X05_STATE_FILE);
  const noConfig = hostOf({ dataDir: gateDir, ownerIds: [X05_OWNER] });
  const switchedOff = hostOf({
    dataDir: gateDir,
    ownerIds: [X05_OWNER],
    presenceQQ: x05PresenceQQ({ enabled: false }),
  });
  const ownerMissing = hostOf({
    dataDir: gateDir,
    ownerIds: [X05_OWNER],
    presenceQQ: x05PresenceQQ({ ownerId: '' }),
  });
  const notWhitelisted = hostOf({
    dataDir: gateDir,
    ownerIds: [X05_OWNER, X05_OTHER],
    presenceQQ: x05PresenceQQ({ ownerId: X05_STRANGER }),
  });
  const gatedObserve = await notWhitelisted.observe({ kind: 'activity', at: harness.now() });

  harness.step({
    title: '闸门：未开启 / owner 缺失 / 不在白名单一律 fail-closed，不建发送也不落盘',
    input: {
      kind: 'presence-qq-config',
      note: '四份合成 cfg：无 presenceQQ / enabled=false / ownerId 空 / ownerId 不在 ownerIds 白名单；'
        + '白名单里另有一个合法 owner，也不许退而求其次发给他',
    },
    expected: {
      noConfigStatus: 'disabled',
      noConfigCode: 'presence-qq-disabled',
      offStatus: 'disabled',
      offCode: 'presence-qq-disabled',
      missingStatus: 'owner-missing',
      missingCode: 'presence-qq-owner-missing',
      notWhitelistedStatus: 'owner-not-whitelisted',
      notWhitelistedCode: 'presence-qq-owner-not-whitelisted',
      notWhitelistedOwner: null,
      notWhitelistedStateFile: null,
      observeOk: false,
      observeStatus: 'owner-not-whitelisted',
      sends: 0,
      stateFiles: 0,
    },
    actual: {
      noConfigStatus: noConfig.status,
      noConfigCode: noConfig.diagnostics[0]?.code ?? '',
      offStatus: switchedOff.status,
      offCode: switchedOff.diagnostics[0]?.code ?? '',
      missingStatus: ownerMissing.status,
      missingCode: ownerMissing.diagnostics[0]?.code ?? '',
      notWhitelistedStatus: notWhitelisted.status,
      notWhitelistedCode: notWhitelisted.diagnostics[0]?.code ?? '',
      notWhitelistedOwner: notWhitelisted.ownerId ?? null,
      notWhitelistedStateFile: notWhitelisted.stateFile ?? null,
      observeOk: gatedObserve.ok === true,
      observeStatus: gatedObserve.status,
      sends: harness.bot.privateDeliveries.length,
      stateFiles: fs.existsSync(gateStatePath) ? 1 : 0,
    },
  });

  /* ── ② away → present：一条 welcome，只发唯一 owner ── */
  const dataDir = harness.dirOf('x05/data');
  // 配置的 owner 故意不排在白名单第一位：这样「发给配置的 ownerId」与
  // 「发给白名单第一项」才能被区分开。
  const cfg = { dataDir, ownerIds: [X05_OTHER, X05_OWNER], presenceQQ: x05PresenceQQ() };
  const host = hostOf(cfg);
  const stateFileName = String(host.stateFile ?? '');

  const t0 = harness.now();
  const entered = await host.observe({ kind: 'activity', at: harness.now() });
  harness.advanceClock(6000);
  const away = await host.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const returned = await host.observe({ kind: 'activity', at: harness.now() });

  const firstSends = harness.bot.privateDeliveries.slice();
  const recipients = [...new Set(firstSends.map((item) => item.userId))];
  const deliveredText = String(firstSends[0]?.text ?? '');

  harness.step({
    title: 'away → present：一条 welcome intent，只投递给显式配置的唯一 owner',
    input: {
      kind: 'presence-signal',
      note: '合成 activity → settle(away 阈值到期) → activity；时间由虚拟时钟推进，不读任何真实信号',
    },
    expected: {
      status: 'ready',
      ownerMatchesConfigured: true,
      stateFileIsQq: true,
      enteredState: 'present',
      enteredIntents: 0,
      awayState: 'away',
      awayIntents: 0,
      returnedState: 'present',
      returnedIntents: 1,
      returnedKinds: 'welcome-back',
      routedAccepted: 1,
      deliveryStatus: 'accepted',
      delivered: 1,
      distinctRecipients: 1,
      recipientIsConfiguredOwner: true,
      groupChannelSends: 0,
      textNonEmpty: true,
      pendingAfter: 0,
    },
    delivery: {
      attempted: firstSends.length,
      sent: firstSends.length,
      receipts: [returned.delivery?.status ?? ''],
      channel: 'qq-private-synthetic',
    },
    actual: {
      status: host.status,
      ownerMatchesConfigured: host.ownerId === X05_OWNER,
      stateFileIsQq: stateFileName.endsWith(X05_STATE_FILE),
      enteredState: entered.state,
      enteredIntents: entered.intents.length,
      awayState: away.state,
      awayIntents: away.intents.length,
      returnedState: returned.state,
      returnedIntents: returned.intents.length,
      returnedKinds: returned.intents.map((intent) => intent.kind).join('|'),
      routedAccepted: returned.routed.filter((entry) => entry.accepted === true).length,
      deliveryStatus: returned.delivery?.status ?? '',
      delivered: firstSends.length,
      distinctRecipients: recipients.length,
      recipientIsConfiguredOwner: recipients.length === 1 && recipients[0] === X05_OWNER,
      groupChannelSends: harness.bot.deliveries.length,
      textNonEmpty: deliveredText.length > 0,
      pendingAfter: host.pending,
    },
  });

  /* ── ③ 同一进程内再来一次 away → present：冷却挡住第二条欢迎 ── */
  harness.advanceClock(6000);
  const repeatAway = await host.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const repeatReturn = await host.observe({ kind: 'activity', at: harness.now() });
  const cooldownWelcome = host.stats.session?.cooldowns?.welcome ?? null;
  const cooldownAgeMs = cooldownWelcome === null ? null : harness.now() - cooldownWelcome;

  harness.step({
    title: '冷却：同一进程内再回来一次也不再发，冷却锚点与台账都不动',
    input: {
      kind: 'presence-signal',
      note: '欢迎之后立刻再走一遍 away → present；90 分钟冷却仍在窗口内',
    },
    expected: {
      awayState: 'away',
      returnedState: 'present',
      intents: 0,
      routed: 0,
      sends: 1,
      ledgerEntries: 1,
      cooldownWelcome: t0 + 12000,
      cooldownAgeMs: 12000,
      cooldownMs: 90 * 60 * 1000,
      insideCooldownWindow: true,
      pending: 0,
    },
    actual: {
      awayState: repeatAway.state,
      returnedState: repeatReturn.state,
      intents: repeatReturn.intents.length,
      routed: repeatReturn.routed.length,
      sends: harness.bot.privateDeliveries.length,
      ledgerEntries: host.stats.session?.ledgerEntries ?? -1,
      cooldownWelcome,
      cooldownAgeMs,
      cooldownMs: host.stats.session?.cooldownMs ?? null,
      insideCooldownWindow: cooldownAgeMs !== null && cooldownAgeMs < 90 * 60 * 1000,
      pending: host.pending,
    },
  });

  /* ── ④ 状态文件：只有白名单字段，不含正文 ── */
  const rawState = fs.readFileSync(stateFileName, 'utf8');
  const savedState = JSON.parse(rawState);
  const ledger = Array.isArray(savedState.deliveredIds) ? savedState.deliveredIds : [];
  const nonAsciiChars = [...rawState].filter((ch) => ch.codePointAt(0) > 0x7f).length;

  harness.step({
    title: '状态文件：只有白名单字段，且不含 intent 正文',
    input: {
      kind: 'presence-state-file',
      note: '读取本场景临时目录里的 QQ 在场状态文件，只比对字段形状与是否夹带正文',
    },
    expected: {
      keys: X05_STATE_KEYS,
      cooldownKeys: 'break|proactive|welcome',
      kind: 'presence-state',
      version: 1,
      state: 'present',
      updatedAt: t0 + 24000,
      sessionStartedAt: t0 + 24000,
      activeMs: 0,
      cooldownWelcome: t0 + 12000,
      ledgerEntries: 1,
      ledgerStatuses: 'accepted',
      nonAsciiChars: 0,
      leakedBody: false,
    },
    actual: {
      keys: Object.keys(savedState).sort().join('|'),
      cooldownKeys: Object.keys(savedState.cooldowns ?? {}).sort().join('|'),
      kind: savedState.kind ?? '',
      version: savedState.version ?? null,
      state: savedState.state ?? '',
      updatedAt: savedState.updatedAt ?? null,
      sessionStartedAt: savedState.sessionStartedAt ?? null,
      activeMs: savedState.activeMs ?? null,
      cooldownWelcome: savedState.cooldowns?.welcome ?? null,
      ledgerEntries: ledger.length,
      ledgerStatuses: ledger.map((entry) => String(entry).split('|')[1] ?? '').join('|'),
      nonAsciiChars,
      leakedBody: deliveredText === '' ? true : rawState.includes(deliveredText),
    },
  });

  /* ── ⑤ 重启：同一临时目录恢复冷却与台账，不补发、不重发 ── */
  const sendsBeforeRestart = harness.bot.privateDeliveries.length;
  const restarted = hostOf(cfg);
  const restoredStats = restarted.stats;
  const resendAfterRestart = harness.bot.privateDeliveries.length - sendsBeforeRestart;

  harness.advanceClock(6000);
  const restartAway = await restarted.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const restartReturn = await restarted.observe({ kind: 'activity', at: harness.now() });
  const sendsAfterCycle = harness.bot.privateDeliveries.length - sendsBeforeRestart;
  const ledgerAfterCycle = restarted.stats.session?.ledgerEntries;

  harness.step({
    title: '重启：同一临时目录恢复冷却与投递台账，旧欢迎不补发、重复欢迎不再发',
    input: {
      kind: 'presence-restart',
      note: '同一个 dataDir 上再建一个 host；随后照原样再走一遍 away → present',
    },
    expected: {
      status: 'ready',
      restored: true,
      diagnostics: 0,
      cooldownWelcome: t0 + 12000,
      cooldownMs: 90 * 60 * 1000,
      ledgerEntries: 1,
      pendingEvents: 0,
      resendAfterRestart: 0,
      awayState: 'away',
      returnIntents: 0,
      returnRouted: 0,
      suppressedIntents: 1,
      sendsAfterCycle: 0,
      ledgerAfterCycle: 1,
    },
    actual: {
      status: restarted.status,
      restored: restoredStats.session?.restored === true,
      diagnostics: restarted.diagnostics.length,
      cooldownWelcome: restoredStats.session?.cooldowns?.welcome ?? null,
      cooldownMs: restoredStats.session?.cooldownMs ?? null,
      ledgerEntries: restoredStats.session?.ledgerEntries ?? -1,
      pendingEvents: restoredStats.runtime?.pendingEvents ?? -1,
      resendAfterRestart,
      awayState: restartAway.state,
      returnIntents: restartReturn.intents.length,
      returnRouted: restartReturn.routed.length,
      suppressedIntents: restarted.stats.session?.suppressedIntents ?? -1,
      sendsAfterCycle,
      ledgerAfterCycle: ledgerAfterCycle ?? -1,
    },
  });

  /* ── ⑥ owner 私聊作废 pending 且不自指；群聊 / 非 owner 不触发 ── */
  // 这个 host 是「真的能发」的：第一次回来就发出去一条；随后用 15 分钟最小间隔
  // 把第二条 welcome 留在 pending。等到最小间隔之外再让 owner 说话——如果那一拍
  // 真的把自指欢迎路由出去，它是发得出去的，所以下面的「没发」不是配置决定的。
  const chatHost = hostOf({
    dataDir: harness.dirOf('x05/chat'),
    ownerIds: [X05_OTHER, X05_OWNER],
    presenceQQ: x05PresenceQQ({ cooldownMs: 0, minGapMs: 15 * 60 * 1000 }),
  });
  const sendsBeforeChat = harness.bot.privateDeliveries.length;

  const chatEntered = await chatHost.observe({ kind: 'activity', at: harness.now() });
  harness.advanceClock(6000);
  const chatAway = await chatHost.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const chatWelcome = await chatHost.observe({ kind: 'activity', at: harness.now() });
  const sendsAfterWelcome = harness.bot.privateDeliveries.length - sendsBeforeChat;

  harness.advanceClock(6000);
  await chatHost.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const chatGapBlocked = await chatHost.observe({ kind: 'activity', at: harness.now() });

  // 再离开一次（pending 留在队列里），然后走出最小间隔，让 owner 在 away 状态下说话：
  // 这一拍会算出「回来了」的欢迎，只是被 onIncomingMessage 扣下不路由。
  harness.advanceClock(6000);
  await chatHost.settle({ at: harness.now() });
  const pendingBeforeOwner = chatHost.pending;

  harness.advanceClock(15 * 60 * 1000);
  const sendsBeforeOwner = harness.bot.privateDeliveries.length;
  const ownerMessage = chatHost.onIncomingMessage({ isGroup: false, userId: X05_OWNER });
  const ownerTick = await chatHost.tick(harness.now());
  const ownerSelfSend = harness.bot.privateDeliveries.length - sendsBeforeOwner;

  // 群聊 / 非 owner 用一个队列里始终躺着一条真 intent 的 host 来验：只要 pending
  // 从 1 掉到 0，就说明那一条消息被当成 owner 处理了。
  const groupHost = hostOf({
    dataDir: harness.dirOf('x05/group'),
    ownerIds: [X05_OTHER, X05_OWNER],
    // 安静时段全天生效（start === end）：主动消息发不出去，intent 就留在队列里。
    presenceQQ: x05PresenceQQ({ quietHours: [0, 0], cooldownMs: 0, minGapMs: 0 }),
  });
  await groupHost.observe({ kind: 'activity', at: harness.now() });
  harness.advanceClock(6000);
  await groupHost.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const groupQueued = await groupHost.observe({ kind: 'activity', at: harness.now() });
  const groupPendingBefore = groupHost.pending;
  const groupMessage = groupHost.onIncomingMessage({ isGroup: true, userId: X05_OWNER });
  const strangerMessage = groupHost.onIncomingMessage({ isGroup: false, userId: X05_STRANGER });

  harness.step({
    title: 'owner 私聊：作废旧 pending、不自指发送；群聊与非 owner 私聊不触发',
    input: {
      kind: 'presence-incoming-message',
      note: '能发的 host 上先用最小间隔留下 pending，再投递 owner 私聊；'
        + '另一个 host 上投递群聊与非 owner 私聊',
    },
    expected: {
      welcomeDelivery: 'accepted',
      sendsAfterWelcome: 1,
      gapBlockedDelivery: 'min-gap',
      pendingBeforeOwner: 1,
      ownerIgnored: false,
      ownerInvalidated: 1,
      ownerPending: 0,
      ownerSuppressedIntents: 1,
      ownerSelfSend: 0,
      ownerTickStatus: 'idle',
      groupQueuedDelivery: 'quiet-hours',
      groupPendingBefore: 1,
      groupStatus: 'not-private',
      groupIgnored: true,
      groupPending: 1,
      strangerStatus: 'not-owner',
      strangerIgnored: true,
      strangerPending: 1,
    },
    actual: {
      welcomeDelivery: chatWelcome.delivery?.status ?? '',
      sendsAfterWelcome,
      gapBlockedDelivery: chatGapBlocked.delivery?.status ?? '',
      pendingBeforeOwner,
      ownerIgnored: ownerMessage.ignored === true,
      ownerInvalidated: ownerMessage.invalidated,
      ownerPending: ownerMessage.pending,
      ownerSuppressedIntents: ownerMessage.suppressedIntents,
      ownerSelfSend,
      ownerTickStatus: ownerTick.status,
      groupQueuedDelivery: groupQueued.delivery?.status ?? '',
      groupPendingBefore,
      groupStatus: groupMessage.status,
      groupIgnored: groupMessage.ignored === true,
      groupPending: groupMessage.pending,
      strangerStatus: strangerMessage.status,
      strangerIgnored: strangerMessage.ignored === true,
      strangerPending: strangerMessage.pending,
    },
  });

  return {
    modules: [
      'presence-qq-runtime.js',
      'humanize.js',
      'presence/session.js',
      'presence/persistence.js',
      'presence/qq-adapter.js',
    ],
    limitation: 'qq-presence-runtime-synthetic-offline',
    note: HUMANIZER_NOTE,
  };
}

const execFileAsync = promisify(execFile);

/**
 * TAP 全通过判定：只要求 fail=0、skipped=0、pass>=1，不锁死用例条数。
 * 被复用的测试文件补一条用例时，X-06 不应因此从 pass 变成 fail。
 * @param {string} stdout 子进程的 TAP 输出
 * @returns {boolean}
 */
export function isTapAllPassed(stdout) {
  const text = String(stdout ?? '');
  const pass = text.match(/^# pass (\d+)\r?$/m);
  const fail = text.match(/^# fail (\d+)\r?$/m);
  const skipped = text.match(/^# skipped (\d+)\r?$/m);
  return pass !== null && Number(pass[1]) >= 1
    && fail !== null && Number(fail[1]) === 0
    && skipped !== null && Number(skipped[1]) === 0;
}

async function runX06(harness) {
  // Run in a separate process so the fake WebSocket hooks and timers cannot
  // affect the rest of the matrix.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const [file, title] of [
    ['onebot-reconnect-replay.test.mjs', '重连后已消费消息不复投，新消息正常投递'],
    ['onebot-closed-socket.test.mjs', '同一次断线只重连一次，忽略失效连接的事件'],
  ]) {
    // Windows Node's test runner does not discover absolute UNC test arguments.
    const regression = 'packages/companion/test/' + file;
    let passed = false;
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        '--test', '--test-reporter=tap', '--', regression,
      ], { cwd: new URL('../../', import.meta.url), env, timeout: 15_000 });
      passed = isTapAllPassed(stdout);
    } catch {
      // The report must not include child stdout or stderr.
    }
    harness.step({
      title,
      input: { kind: 'synthetic-onebot-regression', file },
      expected: { passed: true },
      actual: { passed },
    });
  }
  return { limitation: 'synthetic-cli-reconnect-no-host-journal' };
}

/* ═══════════════ D-01 离线 ASR 成功（桩） ═══════════════ */

/**
 * D-01：离线 ASR 桩返回转写、置信度与元数据；没有注入 memory port 时不写长期记忆。
 * 只证明离线桩契约，不是真实 ASR 供应商验收。
 */
async function runD01(harness) {
  const input = {
    kind: 'audio',
    mime: 'audio/ogg',
    size: 5,
    durationMs: 1200,
    ref: 'synthetic://d01/voice-1',
  };
  const result = await ingestAudio({
    asr: createOfflineAsrStub({
      transcripts: [{ text: '今天有点累', confidence: 0.92, language: 'zh' }],
    }),
    input,
  });
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: '离线 ASR 成功（桩）：转写 + 置信度 + 元数据；没有 memory port 时不写长期记忆',
    input: {
      kind: 'audio-message',
      items: [{ text: 'synthetic audio d01', userId: VISITOR }],
      note: 'ASR 是 offline-asr-stub；没有注入 memory port',
    },
    expected: {
      ok: true,
      text: '今天有点累',
      confidence: 0.92,
      language: 'zh',
      provider: 'offline-asr-stub',
      mime: 'audio/ogg',
      size: 5,
      durationMs: 1200,
      ref: 'synthetic://d01/voice-1',
      eligible: true,
      written: false,
      reason: 'memory-port-missing',
      hasError: false,
    },
    actual: {
      ok: result.ok === true,
      text: result.transcript?.text ?? '',
      confidence: result.transcript?.confidence ?? null,
      language: result.transcript?.language ?? '',
      provider: result.transcript?.provider ?? '',
      mime: result.metadata?.mime ?? '',
      size: result.metadata?.size ?? null,
      durationMs: result.metadata?.durationMs ?? null,
      ref: result.metadata?.ref ?? '',
      eligible: result.memory?.eligible === true,
      written: result.memory?.written === true,
      reason: result.memory?.reason ?? '',
      hasError: Object.hasOwn(result, 'error'),
    },
  });

  return {
    modules: ['media/pipeline.js', 'media/offline-stub.js'],
    limitation: 'offline-asr-stub-no-real-provider',
  };
}

/* ═══════════════ D-02 ASR 失败（桩） ═══════════════ */

/**
 * D-02：ASR 失败返回结构化 asr-failed，并给出请求重说（ask-repeat）；
 * 元数据保留，调用方可以据此让用户重说或走文字回退。
 */
async function runD02(harness) {
  const input = {
    kind: 'audio',
    mime: 'audio/ogg',
    size: 5,
    durationMs: 1200,
    ref: 'synthetic://d02/voice-1',
  };
  const result = await ingestAudio({
    asr: createOfflineAsrStub({ transcripts: [], failWith: { code: 'asr-failed' } }),
    input,
  });
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: 'ASR 失败（桩）：结构化 asr-failed + 请求重说（ask-repeat），保留元数据',
    input: {
      kind: 'audio-message',
      items: [{ text: 'synthetic audio d02', userId: VISITOR }],
      note: 'offline-asr-stub 被要求失败；不产生真实转写',
    },
    expected: {
      ok: false,
      code: 'asr-failed',
      action: 'ask-repeat',
      retryable: true,
      ref: 'synthetic://d02/voice-1',
      transcript: null,
    },
    actual: {
      ok: result.ok === true,
      code: result.error?.code ?? '',
      action: result.recovery?.action ?? '',
      retryable: result.recovery?.retryable === true,
      ref: result.metadata?.ref ?? '',
      transcript: result.transcript ?? null,
    },
  });

  return {
    modules: ['media/pipeline.js', 'media/offline-stub.js'],
    limitation: 'offline-asr-stub-no-real-provider',
  };
}

/* ═══════════════ D-03 TTS 失败（桩） ═══════════════ */

/**
 * D-03：TTS 显式失败与超时都保留 fallbackText，不产生音频、不落媒体存储。
 * 只证明离线 TTS 桩的失败回退契约，不是真实 TTS 供应商验收。
 */
async function runD03(harness) {
  const store = createMediaStore({
    root: harness.dirOf('d03'),
    now: () => harness.now(),
    retentionMs: 60 * 60 * 1000,
  });
  const text = '保留这句文字';

  const failed = await renderVoice({
    tts: createOfflineTtsStub({ failWith: true }),
    text,
    store,
    format: 'ogg',
  });
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: 'TTS 失败（桩）：显式 tts-failed，文字回退原样保留，不落音频',
    input: {
      kind: 'voice-render',
      items: [{ text, userId: VISITOR }],
      note: 'offline-tts-stub 被要求失败；不产生真实语音',
    },
    expected: {
      ok: false,
      code: 'tts-failed',
      fallbackKept: true,
      fallbackChars: 6,
      audioRef: null,
      stored: 0,
    },
    actual: {
      ok: failed.ok === true,
      code: failed.error?.code ?? '',
      fallbackKept: failed.fallbackText === text,
      fallbackChars: [...String(failed.fallbackText ?? '')].length,
      audioRef: failed.audioRef ?? null,
      stored: store.list().length,
    },
  });

  const timedOut = await renderVoice({
    tts: createOfflineTtsStub({ delayMs: 50 }),
    text,
    store,
    format: 'ogg',
    timeoutMs: 5,
  });

  harness.step({
    title: 'TTS 超时（桩）：timeout 同样保留文字回退，不落音频',
    input: {
      kind: 'voice-render',
      items: [{ text, userId: VISITOR }],
      note: 'offline-tts-stub 延迟 50ms，管线 5ms 超时',
    },
    expected: {
      ok: false,
      code: 'timeout',
      fallbackKept: true,
      fallbackChars: 6,
      audioRef: null,
      stored: 0,
    },
    actual: {
      ok: timedOut.ok === true,
      code: timedOut.error?.code ?? '',
      fallbackKept: timedOut.fallbackText === text,
      fallbackChars: [...String(timedOut.fallbackText ?? '')].length,
      audioRef: timedOut.audioRef ?? null,
      stored: store.list().length,
    },
  });

  return {
    modules: ['media/pipeline.js', 'media/offline-stub.js', 'media/store.js'],
    limitation: 'offline-tts-stub-no-real-provider',
  };
}

/* ═══════════════ D-04 低置信度先确认（语音运行入口） ═══════════════ */

/**
 * D-04：公开 createVoiceRuntime() 的低置信度路径——转写在确认前不进聊天、不写长期记忆；
 * 确认后只处理一次（同一条转写重复确认拿不到第二次聊天/记忆写入）。
 *
 * 合成测试：ASR 是 offline-asr-stub，记忆是内存端口，媒体存储落在 harness 临时目录；
 * 不接真实 ASR / 供应商，不发送任何消息。入参额外带 confirmed=true 作为绕过尝试，
 * 入口必须忽略它，仍然先挂待确认。
 */
async function runD04(harness) {
  const store = createMediaStore({
    root: harness.dirOf('d04/store'),
    now: () => harness.now(),
    retentionMs: 60 * 60 * 1000,
  });
  const transcriptText = '合成低置信度转写';
  const writes = [];
  const memoryPort = {
    async remember(record) {
      writes.push({
        chars: [...String(record?.text ?? '')].length,
        confidence: record?.confidence,
        source: record?.source,
      });
    },
  };
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({
      transcripts: [{ text: transcriptText, confidence: 0.2, language: 'zh' }],
    }),
    store,
    memory: memoryPort,
    minConfidence: 0.6,
    now: () => harness.now(),
  });

  const payload = Buffer.from('d04-synthetic-audio-bytes', 'utf8');
  const input = {
    kind: 'audio',
    mime: 'audio/ogg',
    size: payload.length,
    durationMs: 900,
    ref: 'synthetic://d04/voice-1',
    bytes: payload,
    // 绕过尝试：确认只能走 confirm(id)，入参上的 confirmed 不得放行。
    confirmed: true,
  };

  /** 只统计产品真正交出的聊天结果；不在这里替产品决定"进没进聊天"。 */
  const chats = [];
  const track = (result) => {
    if (result && result.chat !== null && result.chat !== undefined) chats.push(result.chat);
    return result;
  };

  try {
    const pending = track(await runtime.ingest({ input }));
    const pendingRows = runtime.listPending();

    harness.step({
      title: '低置信度：先挂待确认——不进聊天、不写记忆，入参 confirmed 不能绕过',
      input: {
        kind: 'audio-message',
        items: [{ text: 'synthetic audio d04 low-confidence', userId: VISITOR }],
        note: '合成音频 + offline-asr-stub（confidence=0.2，阈值 0.6）；'
          + '入参额外带 confirmed=true 作为绕过尝试',
      },
      expected: {
        ok: true,
        decision: 'needs-confirmation',
        chatEntries: 0,
        memoryWrites: 0,
        memoryWritten: false,
        memoryReason: 'low-confidence-needs-confirmation',
        pendingCount: 1,
        pendingChars: 8,
        pendingExposesText: false,
        bypassRejected: true,
        sends: 0,
        storeEntries: 0,
      },
      actual: {
        ok: pending.ok === true,
        decision: pending.decision ?? '',
        chatEntries: chats.length,
        memoryWrites: writes.length,
        memoryWritten: pending.memory?.written === true,
        memoryReason: pending.memory?.reason ?? '',
        pendingCount: pendingRows.length,
        pendingChars: pendingRows[0]?.chars ?? -1,
        pendingExposesText: Object.hasOwn(pendingRows[0] ?? {}, 'text'),
        bypassRejected: pending.decision === 'needs-confirmation',
        sends: harness.bot.deliveries.length,
        storeEntries: store.list().length,
      },
    });

    const confirmed = track(await runtime.confirm(pending.pending?.id));
    const afterConfirmRows = runtime.listPending();

    harness.step({
      title: '确认后：转写才进聊天，记忆只写一次',
      input: {
        kind: 'audio-confirmation',
        items: [{ text: 'confirm pending transcript once', userId: VISITOR }],
        note: '只调用一次 confirm(id)；确认凭据是运行时返回的待确认 id，不写进证据',
      },
      expected: {
        ok: true,
        decision: 'chat',
        chatText: transcriptText,
        chatSource: 'asr-confirmed',
        chatEntries: 1,
        memoryWrites: 1,
        memoryWritten: true,
        memoryReason: 'written',
        writeSource: 'asr-confirmed',
        pendingCount: 0,
        sends: 0,
        storeEntries: 0,
      },
      actual: {
        ok: confirmed.ok === true,
        decision: confirmed.decision ?? '',
        chatText: chats[0]?.text ?? '',
        chatSource: chats[0]?.source ?? '',
        chatEntries: chats.length,
        memoryWrites: writes.length,
        memoryWritten: confirmed.memory?.written === true,
        memoryReason: confirmed.memory?.reason ?? '',
        writeSource: writes[0]?.source ?? '',
        pendingCount: afterConfirmRows.length,
        sends: harness.bot.deliveries.length,
        storeEntries: store.list().length,
      },
    });

    const again = track(await runtime.confirm(pending.pending?.id));

    harness.step({
      title: '重复确认：同一条转写不会再进聊天、不会再写记忆',
      input: {
        kind: 'audio-confirmation',
        items: [{ text: 'repeat the same confirmation id', userId: VISITOR }],
        note: '用同一个 id 再确认一次；只允许一次消费',
      },
      expected: {
        ok: false,
        code: 'confirm-not-found',
        decision: 'text-fallback',
        chatEntries: 1,
        memoryWrites: 1,
        pendingCount: 0,
        sends: 0,
        storeEntries: 0,
      },
      actual: {
        ok: again.ok === true,
        code: again.error?.code ?? '',
        decision: again.decision ?? '',
        chatEntries: chats.length,
        memoryWrites: writes.length,
        pendingCount: runtime.listPending().length,
        sends: harness.bot.deliveries.length,
        storeEntries: store.list().length,
      },
    });
  } finally {
    await runtime.dispose();
  }

  return {
    modules: ['media/voice-runtime.js#createVoiceRuntime', 'media/offline-stub.js', 'media/store.js'],
    limitation: 'voice-runtime-synthetic-asr-memory-port',
    note: '合成测试：offline-asr-stub + 内存记忆端口 + 临时媒体存储；'
      + '不接真实 ASR / 供应商，不发送任何消息。',
  };
}

/* ═══════════════ D-05 图片/文件元数据（U2 前离线契约） ═══════════════ */

/** 合成哨兵：只用来验证「不读、不回显」，不对应任何真实文件、路径或账号。 */
const D05_CONTENT = 'D05-SYNTHETIC-FILE-CONTENT';
const D05_PATH = '/home/synthetic/private/photo.png';
const D05_URL = 'https://synthetic.invalid/private/photo.png';

/**
 * 造一个附件输入：基础字段正常，指定字段做成「一读就抛」的访问器。
 * 不能用对象展开复制访问器——展开会立刻触发 getter，反而证明不了入口没读。
 */
function d05AttachmentInput(base, forbidden, reads) {
  const input = { ...base };
  for (const name of forbidden) {
    Object.defineProperty(input, name, {
      enumerable: true,
      configurable: true,
      get() {
        reads.push(name);
        throw new Error('D05 forbidden field read: ' + name);
      },
    });
  }
  return input;
}

/**
 * D-05：公开 createAttachmentHost() 的图片/文件元数据入口。
 *
 * 合成测试：只喂 kind/mime/size（或 bytes 长度），ref/url/title/account/text/bytes
 * 用「一读就抛」的访问器守住；不解析内容、不联网、不调模型、不进聊天/记忆、不落盘。
 * 只证明 U2 之前的离线元数据契约：入口永远返回 supported:false + provider-required，
 * 不声称能看图或读文件，也不代表真实供应商接入。
 */
async function runD05(harness) {
  const host = createAttachmentHost();

  /* ── ① 图片：只回元数据，路径/URL/标题/账号/正文/字节一个都不读 ── */
  const imageReads = [];
  const image = host.inspect(d05AttachmentInput(
    {
      kind: 'image',
      // 分号参数里夹带合成路径与 URL：入口只保留 type/subtype。
      mime: 'image/png; name=' + D05_PATH + '; url=' + D05_URL,
      size: 12,
    },
    ['bytes', 'ref', 'url', 'title', 'account', 'text'],
    imageReads,
  ));
  const imageEvidence = JSON.stringify(image);

  harness.step({
    title: '图片元数据：只声明 provider-required，路径/URL/标题/账号/正文/字节一个都不读',
    input: {
      kind: 'attachment-metadata',
      items: [{ text: 'synthetic image/png 12 bytes', userId: 'host' }],
      note: '合成图片元数据；mime 分号参数夹带合成路径与 URL；'
        + 'ref/url/title/account/text/bytes 都是一读就抛的访问器',
    },
    delivery: { attempted: 0, sent: 0, receipts: [], texts: [], channel: 'none' },
    expected: {
      kind: 'image',
      mime: 'image/png',
      size: 12,
      ref: null,
      supported: false,
      reason: 'provider-required',
      capability: 'image-input',
      requiresUserDecision: 'U2',
      vision: false,
      contentParsing: false,
      hostEnabled: false,
      forbiddenReads: 0,
      leakedPath: false,
      leakedUrl: false,
      leakedContent: false,
      fetchCalls: 0,
      sends: 0,
      events: 0,
      tempFiles: 0,
    },
    actual: {
      kind: image.kind,
      mime: image.mime,
      size: image.size,
      ref: image.ref,
      supported: image.supported === true,
      reason: image.reason,
      capability: image.providerRequired?.capability ?? '',
      requiresUserDecision: image.providerRequired?.requiresUserDecision ?? '',
      vision: image.capabilities?.vision === true,
      contentParsing: image.capabilities?.contentParsing === true,
      hostEnabled: host.enabled === true,
      forbiddenReads: imageReads.length,
      leakedPath: imageEvidence.includes(D05_PATH),
      leakedUrl: imageEvidence.includes(D05_URL),
      leakedContent: imageEvidence.includes(D05_CONTENT),
      fetchCalls: harness.counters.fetchCalls,
      sends: harness.bot.deliveries.length,
      events: harness.events.length,
      tempFiles: harness.scenarioTempFiles().length,
    },
  });

  /* ── ② 文件：只按 bytes 长度算 size，不解析、不回显正文 ── */
  const fileReads = [];
  const file = host.readMetadata(d05AttachmentInput(
    {
      kind: 'file',
      mime: 'APPLICATION/PDF',
      bytes: Buffer.from(D05_CONTENT, 'utf8'),
    },
    ['ref', 'url', 'title', 'account', 'text'],
    fileReads,
  ));
  const fileEvidence = JSON.stringify(file);

  harness.step({
    title: '文件元数据：只按 bytes 长度算 size，正文不解析、不回显，仍只声明 provider-required',
    input: {
      kind: 'attachment-metadata',
      items: [{ text: 'synthetic application/pdf file bytes', userId: 'host' }],
      note: '合成文件元数据；bytes 内容含哨兵串，入口只读长度；'
        + 'ref/url/title/account/text 都是一读就抛的访问器',
    },
    delivery: { attempted: 0, sent: 0, receipts: [], texts: [], channel: 'none' },
    expected: {
      kind: 'file',
      mime: 'application/pdf',
      size: 26,
      ref: null,
      supported: false,
      reason: 'provider-required',
      capability: 'file-input',
      requiresUserDecision: 'U2',
      forbiddenReads: 0,
      leakedPath: false,
      leakedUrl: false,
      leakedContent: false,
      bytesExposed: false,
      fetchCalls: 0,
      sends: 0,
      events: 0,
      tempFiles: 0,
    },
    actual: {
      kind: file.kind,
      mime: file.mime,
      size: file.size,
      ref: file.ref,
      supported: file.supported === true,
      reason: file.reason,
      capability: file.providerRequired?.capability ?? '',
      requiresUserDecision: file.providerRequired?.requiresUserDecision ?? '',
      forbiddenReads: fileReads.length,
      leakedPath: fileEvidence.includes(D05_PATH),
      leakedUrl: fileEvidence.includes(D05_URL),
      leakedContent: fileEvidence.includes(D05_CONTENT),
      bytesExposed: Object.hasOwn(file, 'bytes'),
      fetchCalls: harness.counters.fetchCalls,
      sends: harness.bot.deliveries.length,
      events: harness.events.length,
      tempFiles: harness.scenarioTempFiles().length,
    },
  });

  /* ── ③ 默认关闭 / 显式开启：都只声明 provider-required，不变成“能看图” ── */
  const defaultStatus = createAttachmentHost().status();
  const enabledHost = createAttachmentHost({ enabled: true });
  const enabledStatus = enabledHost.status();
  const enabledImage = enabledHost.inspect({ kind: 'image', mime: 'image/png', size: 1 });

  harness.step({
    title: '默认关闭与显式开启：都只声明 provider-required，不解析内容、不读文件、不联网、不进聊天/记忆',
    input: {
      kind: 'attachment-host-status',
      items: [{ text: 'attachment-host enabled=false / enabled=true', userId: 'host' }],
      note: '两个公开入口实例 + 开启实例再识别一张合成图片；只读 status() 与元数据',
    },
    delivery: { attempted: 0, sent: 0, receipts: [], texts: [], channel: 'none' },
    expected: {
      kind: 'attachment-host',
      version: 1,
      defaultEnabled: false,
      enabledEnabled: true,
      defaultProviderRequired: true,
      enabledProviderRequired: true,
      parsesContent: false,
      fetches: false,
      readsFiles: false,
      writesMemory: false,
      entersChat: false,
      enabledStillSupported: false,
      enabledStillReason: 'provider-required',
      enabledRef: null,
      fetchCalls: 0,
      sends: 0,
      events: 0,
      tempFiles: 0,
    },
    actual: {
      kind: defaultStatus.kind,
      version: defaultStatus.version,
      defaultEnabled: defaultStatus.enabled === true,
      enabledEnabled: enabledStatus.enabled === true,
      defaultProviderRequired: defaultStatus.providerRequired === true,
      enabledProviderRequired: enabledStatus.providerRequired === true,
      parsesContent: defaultStatus.parsesContent === true || enabledStatus.parsesContent === true,
      fetches: defaultStatus.fetches === true || enabledStatus.fetches === true,
      readsFiles: defaultStatus.readsFiles === true || enabledStatus.readsFiles === true,
      writesMemory: defaultStatus.writesMemory === true || enabledStatus.writesMemory === true,
      entersChat: defaultStatus.entersChat === true || enabledStatus.entersChat === true,
      enabledStillSupported: enabledImage.supported === true,
      enabledStillReason: enabledImage.reason,
      enabledRef: enabledImage.ref,
      fetchCalls: harness.counters.fetchCalls,
      sends: harness.bot.deliveries.length,
      events: harness.events.length,
      tempFiles: harness.scenarioTempFiles().length,
    },
  });

  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');
  harness.assert(harness.bot.deliveries.length === 0, 'no-chat-send');
  harness.assert(harness.events.length === 0, 'no-model-or-memory-event');
  harness.assert(harness.scenarioTempFiles().length === 0, 'no-file-io');

  return {
    modules: [
      'lib.js#createAttachmentHost',
      'media/attachment-host.js',
      'media/pipeline.js#readAttachmentMetadata',
    ],
    limitation: 'attachment-metadata-offline-contract-before-U2',
    note: '合成图片/文件元数据；只证明 U2 前的离线元数据契约（provider-required，'
      + '不读路径/URL/标题/账号/正文/字节，不联网、不调模型、不落盘）；'
      + '真实图片理解 / 供应商接入不在本场景内。',
  };
}

/* ═══════════════ E-01 未知工具 ═══════════════ */

/** E-01：未知工具名一律 unknown-tool，不执行、不落审计（名字不可归属）。 */
async function runE01(harness) {
  const registry = createToolRegistry({ now: () => harness.now() });
  const result = await registry.execute('no_such_tool', {});
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: '未知工具：unknown-tool，不执行、不落审计（名字不可归属）',
    input: { kind: 'tool-call', items: [{ text: 'no_such_tool', userId: 'system' }] },
    tools: [{ name: 'no_such_tool', ok: false, code: result.code, policy: 'unknown' }],
    expected: { ok: false, code: 'unknown-tool', auditEntries: 0 },
    actual: {
      ok: result.ok === true,
      code: result.code ?? '',
      auditEntries: registry.audit().length,
    },
  });

  return { modules: ['tools/registry.js'], limitation: 'fake-tool-registry-offline' };
}

/* ═══════════════ E-02 需确认工具（拒绝路径） ═══════════════ */

/**
 * E-02：confirm 级工具必须请求确认；拒绝后同一 actionId 不能重试、不能翻案，
 * handler 一次都不执行。批准路径由 X-01 覆盖，这里只证明拒绝路径。
 */
async function runE02(harness) {
  let runs = 0;
  const registry = createToolRegistry({
    now: () => harness.now(),
    createActionId: () => 'action-e02',
  });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '演示正文' } },
  };
  registry.register({
    name: 'demo_confirm',
    description: '演示：需要确认的工具（纯内存）',
    parameters: schema,
    risk: 'confirm',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['trigger'],
    handler() {
      runs += 1;
      return { done: true };
    },
  });

  const withoutId = await registry.execute('demo_confirm', { text: 'ok' }, { permissions: ['note:write'] });
  const request = registry.requestConfirmation('demo_confirm', { text: 'ok' });
  const pending = await registry.execute(
    'demo_confirm',
    { text: 'ok' },
    { permissions: ['note:write'], actionId: request.actionId },
  );
  const deny = registry.decideConfirmation(request.actionId, 'deny');
  const denied = await registry.execute(
    'demo_confirm',
    { text: 'ok' },
    { permissions: ['note:write'], actionId: request.actionId },
  );
  const retry = await registry.execute(
    'demo_confirm',
    { text: 'ok' },
    { permissions: ['note:write'], actionId: request.actionId },
  );
  const audit = registry.audit();
  const count = (event, code) => audit.filter(
    (entry) => entry.event === event && (code === undefined || entry.code === code),
  ).length;
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: '需确认工具：未批准不执行、拒绝后同一 actionId 不能重试',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_confirm', userId: 'system' }],
      note: '请求 → 待批 → 拒绝 → 重试',
    },
    tools: [{ name: 'demo_confirm', ok: false, code: denied.code, policy: 'confirm' }],
    expected: {
      withoutId: 'confirmation-required',
      pending: 'confirmation-pending',
      requestOk: true,
      denyOk: true,
      denyStatus: 'denied',
      denied: 'confirmation-denied',
      retry: 'confirmation-denied',
      handlerRuns: 0,
      requestAudit: 1,
      decisionAudit: 1,
      deniedAudit: 2,
    },
    actual: {
      withoutId: withoutId.code ?? '',
      pending: pending.code ?? '',
      requestOk: request.ok === true,
      denyOk: deny.ok === true,
      denyStatus: deny.status ?? '',
      denied: denied.code ?? '',
      retry: retry.code ?? '',
      handlerRuns: runs,
      requestAudit: count('confirmation-request'),
      decisionAudit: count('confirmation-decision'),
      deniedAudit: count('execute', 'confirmation-denied'),
    },
  });

  return { modules: ['tools/registry.js'], limitation: 'fake-tool-registry-offline' };
}

/* ═══════════════ E-03 工具超时 ═══════════════ */

/**
 * E-03：handler 超过 timeoutMs 时只回结构化 timeout，不伪成功；
 * 审计留下 timeout 执行记录，迟到结果不再改写。
 */
async function runE03(harness) {
  const registry = createToolRegistry({ now: () => harness.now() });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '演示正文' } },
  };
  registry.register({
    name: 'demo_slow',
    description: '演示：永不返回的工具（纯内存）',
    parameters: schema,
    risk: 'read-only',
    permissions: ['note:write'],
    timeoutMs: 20,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['trigger'],
    handler() {
      return new Promise(() => {});
    },
  });

  const started = Date.now();
  const result = await registry.execute('demo_slow', { text: 'ok' }, { permissions: ['note:write'] });
  const elapsed = Date.now() - started;
  const audit = registry.audit();
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: '工具超时：结构化 timeout，审计记 timeout，不伪成功',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_slow', userId: 'system' }],
      note: 'handler 永不 resolve；timeoutMs=20',
    },
    tools: [{ name: 'demo_slow', ok: false, code: result.code, policy: 'read-only' }],
    expected: {
      ok: false,
      code: 'timeout',
      auditLastCode: 'timeout',
      auditLastEvent: 'execute',
      elapsedAtLeast15: true,
    },
    actual: {
      ok: result.ok === true,
      code: result.code ?? '',
      auditLastCode: audit.at(-1)?.code ?? '',
      auditLastEvent: audit.at(-1)?.event ?? '',
      elapsedAtLeast15: elapsed >= 15,
    },
  });

  return { modules: ['tools/registry.js'], limitation: 'fake-tool-registry-offline' };
}

/* ═══════════════ E-04 高风险工具 ═══════════════ */

/**
 * E-04：high-risk 工具只允许登记，执行默认 risk-not-allowed；handler 永不执行。
 * 真实高风险工具授权仍属 U3，不在离线场景内。
 */
async function runE04(harness) {
  let runs = 0;
  const registry = createToolRegistry({ now: () => harness.now() });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: '演示正文' } },
  };
  registry.register({
    name: 'demo_high_risk',
    description: '演示：高风险工具只登记（纯内存）',
    parameters: schema,
    risk: 'high-risk',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['trigger'],
    handler() {
      runs += 1;
      return { done: true };
    },
  });

  const result = await registry.execute('demo_high_risk', { text: 'ok' }, { permissions: ['note:write'] });
  const audit = registry.audit();
  harness.assert(harness.counters.fetchCalls === 0, 'no-fetch');

  harness.step({
    title: '高风险工具：默认 risk-not-allowed，永不执行，审计留拒绝码',
    input: { kind: 'tool-call', items: [{ text: 'demo_high_risk', userId: 'system' }] },
    tools: [{ name: 'demo_high_risk', ok: false, code: result.code, policy: 'high-risk' }],
    expected: {
      ok: false,
      code: 'risk-not-allowed',
      handlerRuns: 0,
      auditLastCode: 'risk-not-allowed',
      auditConfirmation: 'not-required',
    },
    actual: {
      ok: result.ok === true,
      code: result.code ?? '',
      handlerRuns: runs,
      auditLastCode: audit.at(-1)?.code ?? '',
      auditConfirmation: audit.at(-1)?.confirmation ?? '',
    },
  });

  return { modules: ['tools/registry.js'], limitation: 'high-risk-stub-requires-U3-to-enable' };
}

/* ═══════════════ E-05 工具审计脱敏（宿主桥接） ═══════════════ */

/**
 * E-05：公开 createToolHostBridge() 的审计边界——审计事件只留工具名、风险、结果码、
 * 确认状态、短摘要与关联标识；不含参数正文、异常原文或确认凭据（actionId / sessionKey）。
 *
 * 合成测试：宿主显式注入的纯内存假工具 + 固定 actionId/sessionKey；不接真实设备、
 * 账号、网络或模型工具。
 */
async function runE05(harness) {
  const BODY = 'E05-SYNTHETIC-ARG-BODY';
  const EXCEPTION = 'E05-SYNTHETIC-EXCEPTION-TEXT';
  const SESSION = 'e05-synthetic-session-key';
  let confirmRuns = 0;
  let actionSeq = 0;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 80 } },
  };
  const bridge = createToolHostBridge({
    enabled: true,
    tools: [
      {
        name: 'demo_e05_read',
        description: '演示：handler 抛错的只读假工具（纯内存）',
        parameters: schema,
        risk: 'read-only',
        permissions: [],
        timeoutMs: 1000,
        failurePolicy: 'stop',
        compensate: null,
        schedulable: false,
        auditFields: ['trigger', 'durationMs', 'argsDigest'],
        handler() {
          throw new Error(EXCEPTION + ' ' + BODY);
        },
      },
      {
        name: 'demo_e05_confirm',
        description: '演示：需要确认的假工具（纯内存）',
        parameters: schema,
        risk: 'confirm',
        permissions: [],
        timeoutMs: 1000,
        failurePolicy: 'stop',
        compensate: null,
        schedulable: false,
        auditFields: ['argsDigest'],
        handler() {
          confirmRuns += 1;
          return { done: true };
        },
      },
    ],
    permissions: [],
    now: () => harness.now(),
    createActionId: () => 'e05-act-' + (actionSeq += 1),
  });

  /* ── ① 异常路径：审计只留 handler-failed 与摘要 ── */
  const read = await bridge.execute('demo_e05_read', { text: BODY }, {});
  const auditAfterRead = bridge.audit();
  const readDigests = auditAfterRead
    .filter((entry) => entry.event === 'execute')
    .map((entry) => entry.argsDigest)
    .filter((value) => typeof value === 'string');

  harness.step({
    title: '异常路径：审计只留 handler-failed 与参数摘要，不含参数正文/异常原文',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_e05_read', userId: 'system' }],
      note: '合成假工具的 handler 抛出含哨兵正文的异常；只读审计快照',
    },
    tools: [{ name: 'demo_e05_read', ok: read.ok === true, code: read.code, policy: 'read-only' }],
    expected: {
      readOk: false,
      readCode: 'handler-failed',
      auditEvents: 'execute',
      auditCode: 'handler-failed',
      digestCount: 1,
      digestShape: true,
      correlationPrefixed: true,
      hasActionIdField: false,
      hasArgsField: false,
      leakedBody: false,
      leakedException: false,
      leakedResult: false,
    },
    actual: {
      readOk: read.ok === true,
      readCode: read.code ?? '',
      auditEvents: auditAfterRead.map((entry) => entry.event).join('|'),
      auditCode: auditAfterRead[0]?.code ?? '',
      digestCount: readDigests.length,
      digestShape: readDigests.every((value) => /^[0-9a-f]{16}$/u.test(value)),
      correlationPrefixed: auditAfterRead.every((entry) => typeof entry.correlationId === 'string'
        && entry.correlationId.startsWith('c-')),
      hasActionIdField: auditAfterRead.some((entry) => Object.hasOwn(entry, 'actionId')),
      hasArgsField: auditAfterRead.some((entry) => Object.hasOwn(entry, 'args') || Object.hasOwn(entry, 'text')),
      leakedBody: JSON.stringify(auditAfterRead).includes(BODY),
      leakedException: JSON.stringify(auditAfterRead).includes(EXCEPTION),
      leakedResult: JSON.stringify(read).includes(BODY) || JSON.stringify(read).includes(EXCEPTION),
    },
  });

  /* ── ② 确认流程：请求/批准/执行/复用后整条审计仍脱敏 ── */
  const modelCall = await bridge.model.call('demo_e05_confirm', { text: BODY });
  const request = bridge.requestConfirmation(
    'demo_e05_confirm',
    { text: BODY },
    { sessionKey: SESSION },
  );
  const pending = await bridge.execute(
    'demo_e05_confirm',
    { text: BODY },
    { sessionKey: SESSION, actionId: request.actionId },
  );
  const approved = bridge.decideConfirmation(request.actionId, 'approve', { sessionKey: SESSION });
  const ran = await bridge.execute(
    'demo_e05_confirm',
    { text: BODY },
    { sessionKey: SESSION, actionId: request.actionId },
  );
  const reused = await bridge.execute(
    'demo_e05_confirm',
    { text: BODY },
    { sessionKey: SESSION, actionId: request.actionId },
  );

  const audit = bridge.audit();
  const executeEntries = audit.filter((entry) => entry.event === 'execute');
  const digests = executeEntries
    .map((entry) => entry.argsDigest)
    .filter((value) => typeof value === 'string');
  const auditText = JSON.stringify(audit);
  const allowedKeys = new Set([
    'seq', 'event', 'tool', 'risk', 'at', 'code', 'correlationId', 'confirmation',
    'trigger', 'durationMs', 'argsDigest',
  ]);

  harness.step({
    title: '确认流程：审计不含参数正文、异常原文、actionId 或 sessionKey',
    input: {
      kind: 'tool-call',
      items: [{ text: 'demo_e05_confirm', userId: 'system' }],
      note: '模型侧调用 → 宿主请求 → 待批执行 → 批准 → 执行 → 复用；'
        + '正文/异常/凭据都是合成哨兵串，只读审计与结果',
    },
    tools: [
      {
        name: 'demo_e05_confirm',
        ok: ran.ok === true,
        code: ran.ok === true ? 'ok' : ran.code,
        policy: 'confirm',
      },
    ],
    expected: {
      modelCall: 'confirmation-required',
      requestOk: true,
      requestStatus: 'pending',
      pending: 'confirmation-pending',
      approved: true,
      approvedStatus: 'approved',
      executed: 'ok',
      reuse: 'confirmation-used',
      handlerRuns: 1,
      auditEvents: 'execute|execute|confirmation-request|execute|confirmation-decision|execute|execute',
      auditConfirmations: 'not-required|missing|pending|approved|consumed',
      digestCount: 5,
      digestShape: true,
      correlationPrefixed: true,
      safeKeysOnly: true,
      leakedBody: false,
      leakedException: false,
      leakedActionId: false,
      leakedSessionKey: false,
    },
    actual: {
      modelCall: modelCall.code ?? '',
      requestOk: request.ok === true,
      requestStatus: request.status ?? '',
      pending: pending.code ?? '',
      approved: approved.ok === true,
      approvedStatus: approved.status ?? '',
      executed: ran.ok === true ? 'ok' : (ran.code ?? ''),
      reuse: reused.code ?? '',
      handlerRuns: confirmRuns,
      auditEvents: audit.map((entry) => entry.event).join('|'),
      auditConfirmations: executeEntries.map((entry) => entry.confirmation).join('|'),
      digestCount: digests.length,
      digestShape: digests.every((value) => /^[0-9a-f]{16}$/u.test(value)),
      correlationPrefixed: audit.every((entry) => typeof entry.correlationId === 'string'
        && entry.correlationId.startsWith('c-')),
      safeKeysOnly: audit.every((entry) => Object.keys(entry).every((key) => allowedKeys.has(key))),
      leakedBody: auditText.includes(BODY),
      leakedException: auditText.includes(EXCEPTION),
      leakedActionId: auditText.includes(request.actionId),
      leakedSessionKey: auditText.includes(SESSION),
    },
  });

  return {
    modules: ['tools/host-bridge.js#createToolHostBridge', 'tools/registry.js'],
    limitation: 'tool-host-bridge-synthetic-fake-tools',
    note: '合成测试：宿主显式注入的纯内存假工具 + 固定 actionId/sessionKey；'
      + '不接真实设备、账号、网络或模型工具。',
  };
}

/* ══════════════════════ 场景表 ══════════════════════ */

/**
 * 未覆盖项：依赖本 checkout 里不存在的宿主集成 / QQ 集成 / Web presence 宿主。
 * 按 id 建索引（不按下标），增删一条不会让场景表悄悄错位。
 *
 * B-14 / B-18 有 X-07 的**通用入口旁证**，但仍缺宿主/真实 QQ 集成路径；
 * `proofRequired` 记录还差什么，`corroboratedBy` 只指向旁证，不改变 not-covered。
 */
const NOT_COVERED = Object.freeze(Object.fromEntries([
  ['B-03', 'requires-host-integration'],
  ['B-04', 'requires-host-integration'],
  ['B-05', 'requires-qq-integration'],
  ['B-12', 'requires-host-integration'],
  ['B-14', 'requires-qq-integration', [
    '宿主/QQ 集成路径：真实 QQ 群聊关闭、非 owner 私聊拒绝、白名单私聊成功',
    'X-07 只覆盖公开通用 CLI + 合成 OneBot 的入口子场景，不能代替真实平台收发',
    'T9 真实 QQ 验收仍需人工执行，不能把芙兰宿主或真实 QQ 记完成',
  ]],
  ['B-15', 'requires-host-integration'],
  ['B-18', 'requires-host-integration', [
    '宿主集成路径：宿主自己的 owner 白名单 / 群聊开关配置在缺失或非法时 fail-closed',
    'X-07 只覆盖公开通用 CLI 的配置闸门，不是芙兰宿主的配置装载路径',
    '真实配置错误仍需在接触运输/存储前退出的宿主级证据（T9/宿主验收）',
  ]],
].map(([id, reason, proofRequired]) => [id, {
  id,
  gate: 'b',
  status: 'not-covered',
  title: '未覆盖：依赖缺失的宿主/QQ 集成源码',
  reason,
  requires: '宿主集成路径或 QQ/OneBot 集成路径（本 checkout 不存在；X-07 只是通用入口旁证）',
  proofRequired: proofRequired ?? [],
  corroboratedBy: proofRequired ? ['X-07'] : [],
}])));

/**
 * D/E 当前没有 not-covered 项：D-01…D-05 与 E-01…E-05 都有可执行的离线契约证据。
 * D-05 只覆盖 U2 之前的元数据契约（provider-required），不代表真实图片理解/供应商接入。
 */

/**
 * 场景表（显示顺序固定）。covered 的条目必须真的能跑；not-covered 只列事实。
 * `aliases` 是给人手敲的短 id（--scenario=restart-recovery 这类写法）。
 * @type {Array<object>}
 */
export const SCENARIOS = Object.freeze([
  { id: 'B-01', aliases: ['greeting'], gate: 'b', status: 'covered', title: 'B-01 打招呼：一条私聊 → 生成 → 发送 → 落账', run: runB01 },
  { id: 'B-02', aliases: ['burst-merge'], gate: 'b', status: 'covered', title: 'B-02 连发三条：合并成一轮、保序、重复投递只消费一次', run: runB02 },
  NOT_COVERED['B-03'],
  NOT_COVERED['B-04'],
  NOT_COVERED['B-05'],
  { id: 'B-06', aliases: ['reminder-lifecycle'], gate: 'b', status: 'covered', title: 'B-06 提醒：创建 / 到期 / 结果回执 / 不重发', run: runB06 },
  { id: 'B-07', aliases: ['ambiguous-reminder'], gate: 'b', status: 'covered', title: 'B-07 模糊提醒：先澄清、不猜时间、不建任务、无已创建回执', run: runB07 },
  { id: 'B-08', aliases: ['reminder-vs-message'], gate: 'b', status: 'covered', title: 'B-08 同时发生：提醒不覆盖在途消息、消息不吞掉到期提醒、终态不重发', run: runB08 },
  NOT_COVERED['B-12'],
  { id: 'B-09', aliases: ['restart-recovery'], gate: 'b', status: 'covered', title: 'B-09 重启恢复：重排该排的、在途与终态不重发', run: runB09 },
  { id: 'B-10', aliases: ['tool-failure'], gate: 'b', status: 'covered', title: 'B-10 工具失败：闭合错误码、不重试、按策略补偿', run: runB10 },
  { id: 'B-11', aliases: ['model-failure'], gate: 'b', status: 'covered', title: 'B-11 模型失败：不发送、不落账、异常原样上抛', run: runB11 },
  NOT_COVERED['B-14'],
  { id: 'B-13', aliases: ['delivery-unconfirmed'], gate: 'b', status: 'covered', title: 'B-13 投递未确认：停在原地，不重发、不落账', run: runB13 },
  NOT_COVERED['B-15'],
  { id: 'B-16', aliases: ['context-budget'], gate: 'b', status: 'covered', title: 'B-16 上下文预算：按 recent → memory → situation 丢弃', run: runB16 },
  { id: 'B-17', aliases: ['generation-delivery-commit'], gate: 'b', status: 'covered', title: 'B-17 生成 / 投递 / 记忆提交分离', run: runB17 },
  NOT_COVERED['B-18'],
  // C-01/C-02 的 Web presence 宿主路径（#96/#100）已合入；C 门不再有 not-covered 项。
  ...C_SCENARIOS,
  { id: 'X-01', aliases: ['tool-confirmation'], gate: 'extra', status: 'covered', title: 'X-01（增补）工具确认一次性 / 高风险永不执行', run: runX01 },
  { id: 'X-02', aliases: ['reminder-store-integrity'], gate: 'extra', status: 'covered', title: 'X-02（增补）提醒快照 fail-closed，坏文件不被抹掉', run: runX02 },
  { id: 'X-03', aliases: ['tool-audit-boundary'], gate: 'extra', status: 'covered', title: 'X-03（增补）工具确认绑定参数、一次性消费，审计不含正文', run: runX03 },
  { id: 'X-04', aliases: ['media-pipeline-offline'], gate: 'extra', status: 'covered', title: 'X-04（增补）离线媒体：低置信度不写记忆、临时音频删除审计、TTS 失败保留文字', run: runX04 },
  { id: 'X-05', aliases: ['presence-qq-runtime'], gate: 'extra', status: 'covered', title: 'X-05（增补）离线 QQ presence runtime：白名单闸门、唯一 owner 欢迎、状态文件白名单、重启冷却/台账、私聊不自指、群聊不触发', run: runX05 },
  { id: 'X-06', aliases: ['onebot-reconnect'], gate: 'extra', status: 'covered', title: 'X-06（增补）通用 CLI 的 OneBot 重连与去重', run: runX06 },
  // X-07 只把 #95 的 --owner-private 接入通用 CLI 行为接进矩阵；B-14/B-18 仍是 not-covered。
  ...OWNER_PRIVATE_SCENARIOS,
  // D-01…D-05 / E-01…E-05 是执行计划 §9.3 的独立验收项；与 X-01/X-03/X-04 的增补旁证区分，不复用同一 ID。
  { id: 'D-01', aliases: ['asr-success'], gate: 'extra', status: 'covered', title: 'D-01 离线 ASR 成功（桩）：转写/置信度/元数据；无 memory port 不写长期记忆', run: runD01 },
  { id: 'D-02', aliases: ['asr-failure'], gate: 'extra', status: 'covered', title: 'D-02 ASR 失败（桩）：asr-failed + ask-repeat，保留元数据', run: runD02 },
  { id: 'D-03', aliases: ['tts-failure'], gate: 'extra', status: 'covered', title: 'D-03 TTS 失败（桩）：显式失败与超时都保留文字回退', run: runD03 },
  { id: 'D-04', aliases: ['voice-low-confidence-confirm'], gate: 'extra', status: 'covered', title: 'D-04 低置信度语音：确认前不进聊天/记忆，确认后只处理一次（合成 ASR + 内存记忆端口）', run: runD04 },
  { id: 'D-05', aliases: ['attachment-metadata'], gate: 'extra', status: 'covered', title: 'D-05 图片/文件元数据：公开附件宿主只声明 provider-required，不读路径/URL/内容（U2 前离线契约）', run: runD05 },
  // E-01…E-05 按执行计划 §9.3 的语义：未知工具 / 需确认 / 超时 / 高风险 / 审计脱敏。
  { id: 'E-01', aliases: ['unknown-tool'], gate: 'extra', status: 'covered', title: 'E-01 未知工具：unknown-tool，不执行、不落审计', run: runE01 },
  { id: 'E-02', aliases: ['confirm-reject'], gate: 'extra', status: 'covered', title: 'E-02 需确认工具：拒绝后不重试，handler 不执行', run: runE02 },
  { id: 'E-03', aliases: ['tool-timeout'], gate: 'extra', status: 'covered', title: 'E-03 工具超时：结构化 timeout + 审计，不伪成功', run: runE03 },
  { id: 'E-04', aliases: ['high-risk-tool'], gate: 'extra', status: 'covered', title: 'E-04 高风险工具：默认 risk-not-allowed，永不执行', run: runE04 },
  { id: 'E-05', aliases: ['tool-audit-redaction'], gate: 'extra', status: 'covered', title: 'E-05 工具审计脱敏：不含参数正文、异常原文或确认凭据（合成假工具）', run: runE05 },
].map((scenario) => Object.freeze(scenario)));

/** 取场景表（默认内置；测试可注入自己的表）。 */
export function listScenarios(registry = SCENARIOS) {
  return Array.isArray(registry) ? registry : SCENARIOS;
}

/** 按 id 或别名找场景；找不到返回 null。 */
export function findScenario(id, registry = SCENARIOS) {
  const target = String(id ?? '').trim();
  if (target === '') return null;
  return listScenarios(registry).find((scenario) => scenario.id === target
    || (Array.isArray(scenario.aliases) && scenario.aliases.includes(target))) ?? null;
}

/** 默认执行集合：所有 covered 场景（顺序同场景表）。 */
export function coveredScenarios(registry = SCENARIOS) {
  return listScenarios(registry).filter((scenario) => scenario.status === 'covered');
}

/** B 门（B-01…B-18）的完整 id 列表——覆盖率分母。 */
export function bGateIds(registry = SCENARIOS) {
  return listScenarios(registry)
    .filter((scenario) => scenario.gate === 'b')
    .map((scenario) => scenario.id);
}

/** 未覆盖的 B 门 id。 */
export function notCoveredBIds(registry = SCENARIOS) {
  return listScenarios(registry)
    .filter((scenario) => scenario.gate === 'b' && scenario.status === 'not-covered')
    .map((scenario) => scenario.id);
}

/** 已登记的 C 场景。 */
export function cGateIds(registry = SCENARIOS) {
  return listScenarios(registry)
    .filter((scenario) => scenario.gate === 'group')
    .map((scenario) => scenario.id);
}

/** 未覆盖的 C 门 id。 */
export function notCoveredCIds(registry = SCENARIOS) {
  return listScenarios(registry)
    .filter((scenario) => scenario.gate === 'group' && scenario.status === 'not-covered')
    .map((scenario) => scenario.id);
}
