/**
 * 增补场景 · owner-private 通用 CLI 入口
 * ─────────────────────────────────────────────────────────────
 * #95 已合入的 `--owner-private` 是**公开通用 companion CLI** 的入口闸门，
 * 不是芙兰原宿主、也不是真实 QQ 平台。本文件只把这段行为接进统一离线矩阵，
 * 作为 B-14 / B-18 的**明确旁证**，不把两个场景改成 covered。
 *
 * X-07 只证明以下子场景：
 *   1. 无效配置（读不到 / 非 JSON / 非 object / 无有效 ownerIds）在构造 OneBot
 *      与 Memory 之前退出，固定文案不回显配置、路径或解析异常；
 *   2. 群聊、非 owner 私聊在真实 `main()` 入口被拒绝，不建提醒、不发送、
 *      不落对话记忆，日志不含正文；
 *   3. 白名单私聊对照成功：同一条提醒命令真正落盘并只发一次确认（合成 OneBot）。
 *
 * ── 证据边界（必须和 X-07 一起读）──────────────────────────
 *   - 只跑真实公开入口 `main({ createBot })`，没有直接调用 gate 或 config loader；
 *   - OneBot 是合成的：只实现 onMessage / send / sendPrivateText / setTyping，
 *     不建立 WebSocket、HTTP 或真实 QQ 连接；
 *   - 临时目录、合成账号、合成文案；不读写仓库 data/ 或真实配置；
 *   - 正对照走 `--reminders` 的命令路径，不调真实模型；正常私聊的模型/记忆接线
 *     仍由 #95 的包内测试覆盖，不是本矩阵的执行证据；
 *   - 因此 B-14 / B-18 继续保持 not-covered，并记录 proofRequired；
 *     本场景不能替代芙兰宿主或真实 QQ（T9）验收。
 */
import fs from 'node:fs';
import path from 'node:path';

import { captureConsole } from './harness.mjs';
import { main } from '../../packages/companion/src/index.js';

/** 合成账号 / 群号：占位值，不对应任何真实账号。 */
const OWNER = '10001';
const OTHER = '10002';
const STRANGER = '20002';
const GROUP_ID = '9001';

/** 固定错误文案与闭合码都写成字面量：产品改了这里必须失败报警。 */
const CONFIG_ERROR = '配置不可用：--owner-private 需要可读的 JSON 对象配置，'
  + '且 ownerIds 至少包含一个有效账号；已停止（未创建 Memory、未连接 OneBot）。';
const CONFIG_CODES = ['config-unreadable', 'config-invalid-json', 'config-not-object', 'owner-ids-missing'];
const SECRET = 'owner-private-synthetic-secret-8848';

const COMMAND = '5分钟后提醒我喝水';
const REMINDER_TEXT = '喝水';

/** 合成 OneBot：不连网，只记录 main() 实际调用过的端口。 */
function createSyntheticOneBot() {
  const calls = { send: [], private: [], typing: [] };
  let privateSeq = 0;
  return {
    onMessage: null,
    calls,
    async send(key, text) {
      calls.send.push({ key: String(key), text: String(text) });
      return { ok: true };
    },
    async sendPrivateText(userId, text) {
      privateSeq += 1;
      calls.private.push({ userId: String(userId), text: String(text) });
      return { ok: true, messageId: 'synthetic-x07-' + privateSeq };
    },
    async setTyping(key, on) {
      calls.typing.push({ key: String(key), on: on === true });
    },
  };
}

/** 一次 CLI 装配用的最小 proc；不监听真实进程信号。 */
function makeProc(argv) {
  return {
    argv,
    exits: [],
    on() { return this; },
    exit(code) { this.exits.push(code); },
  };
}

/** 给每条合成消息一个稳定时间。 */
const MESSAGE_TIME = 1_760_000_000;

function privateMsg({ userId = OWNER, text = '在吗', messageId = 'x07-p1' } = {}) {
  return {
    key: 'private:' + userId,
    userId,
    name: userId === OWNER ? '主人' : '路人',
    text,
    isGroup: false,
    groupId: '',
    messageId,
    time: MESSAGE_TIME,
  };
}

function groupMsg({ userId = OWNER, text = '群里说话', messageId = 'x07-g1' } = {}) {
  return {
    key: 'group:' + GROUP_ID,
    userId,
    name: '群友',
    text,
    isGroup: true,
    groupId: GROUP_ID,
    messageId,
    time: MESSAGE_TIME,
  };
}

/** 0ms 会话窗口 + 提醒确认：让出事件循环，不用真实睡眠。 */
async function flushWindow() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function reminderRecords(dir) {
  const state = readJson(path.join(dir, 'reminders.json'));
  return Array.isArray(state?.records) ? state.records : [];
}

function writeRole(harness, root) {
  harness.writeFile(root + '/role.md', '# 角色卡\nX-07 合成 owner-private 验收用角色卡。\n');
}

function validConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'synthetic-model',
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

/* ══════════════════════ X-07 ══════════════════════ */

/**
 * X-07：真实 `main()` + 合成 OneBot + 临时目录。
 * 先验证配置闸门在运输/存储之前，再验证拒绝路径与白名单正对照。
 */
async function runX07(harness) {
  /* ── 1. 无效配置：Memory / OneBot 之前退出 ── */
  const invalidCases = [
    ['missing', null, CONFIG_CODES[0]],
    ['invalid-json', '{"ownerIds":["' + OWNER + '"],"apiKey":"' + SECRET, CONFIG_CODES[1]],
    ['array', JSON.stringify([{ apiKey: SECRET }]), CONFIG_CODES[2]],
    ['no-owner-ids', JSON.stringify({ apiKey: SECRET, dataDir: './data' }), CONFIG_CODES[3]],
  ];

  const observedCodes = [];
  const observedFailures = [];
  const observedBotConstructions = [];
  const observedDataDirs = [];
  const observedErrorLines = [];
  const observedLeaksSecret = [];
  const observedLeaksPath = [];
  const observedStartupBanner = [];

  for (const [name, content, expectedCode] of invalidCases) {
    const root = 'x07/invalid/' + name;
    harness.dirOf(root);
    writeRole(harness, root);
    const configPath = content === null
      ? path.join(harness.pathOf(root), 'config.json')
      : harness.writeFile(root + '/config.json', content);
    const argv = ['node', 'index.js', '--config', configPath, '--owner-private'];
    const proc = makeProc(argv);
    const capture = captureConsole();
    let result;
    try {
      result = await main({
        createBot: () => {
          observedBotConstructions.push(name);
          return createSyntheticOneBot();
        },
        proc,
      });
    } finally {
      capture.restore();
    }

    observedCodes.push(result?.ownerPrivate?.code ?? '');
    observedFailures.push(result?.ok === false && result?.bot === null);
    observedDataDirs.push(fs.existsSync(path.join(harness.pathOf(root), 'data')));
    const errorLines = capture.lines.filter((line) => line.startsWith('[owner-private] '));
    observedErrorLines.push(errorLines.length === 1 && errorLines[0] === '[owner-private] ' + CONFIG_ERROR);
    observedLeaksSecret.push(capture.lines.some((line) => line.includes(SECRET)));
    observedLeaksPath.push(capture.lines.some((line) => line.includes(configPath)));
    observedStartupBanner.push(capture.lines.some((line) => line.includes('════════ companion ════════')));
    harness.assert(result?.ownerPrivate?.ok === false, 'invalid-config-not-failed-' + name);
    harness.assert(result?.ownerPrivate?.code === expectedCode, 'invalid-config-code-' + name);
  }

  harness.step({
    title: '无效配置在 Memory / OneBot 之前退出（公开 CLI --owner-private）',
    input: {
      kind: 'owner-private-config-gate',
      note: '四份合成配置：缺失 / 非 JSON / 顶层数组 / 无有效 ownerIds；createBot 只计数',
    },
    expected: {
      cases: 'missing|invalid-json|array|no-owner-ids',
      codes: CONFIG_CODES.join('|'),
      allFailed: 'true|true|true|true',
      botConstructions: 0,
      dataDirsCreated: 0,
      fixedErrorOnly: 'true|true|true|true',
      leakedSecret: 'false|false|false|false',
      leakedConfigPath: 'false|false|false|false',
      startupBanner: 'false|false|false|false',
    },
    actual: {
      cases: invalidCases.map(([name]) => name).join('|'),
      codes: observedCodes.join('|'),
      allFailed: observedFailures.map(String).join('|'),
      botConstructions: observedBotConstructions.length,
      dataDirsCreated: observedDataDirs.filter(Boolean).length,
      fixedErrorOnly: observedErrorLines.map(String).join('|'),
      leakedSecret: observedLeaksSecret.map(String).join('|'),
      leakedConfigPath: observedLeaksPath.map(String).join('|'),
      startupBanner: observedStartupBanner.map(String).join('|'),
    },
  });

  /* ── 2. 有效配置：拒绝群聊 / 非 owner；白名单私聊正对照 ── */
  const root = 'x07/valid';
  writeRole(harness, root);
  const configPath = harness.writeFile(root + '/config.json', JSON.stringify(validConfig()));
  const dataDir = path.join(harness.pathOf(root), 'data');
  const argv = [
    'node', 'index.js',
    '--config', configPath,
    '--owner-private',
    '--reminders',
  ];
  const proc = makeProc(argv);
  const bot = createSyntheticOneBot();
  let started = null;
  let startedOk = false;
  let ownerPrivateOwners = '';
  let remindersActive = false;
  let groupRejected = false;
  let nonOwnerRejected = false;
  let modelErrors = 0;
  let rejectedBodyInLogs = false;

  const capture = captureConsole();
  try {
    started = await main({
      createBot: (options) => {
        bot.onMessage = options.onMessage;
        return bot;
      },
      proc,
    });
    startedOk = started?.ok === true;
    ownerPrivateOwners = (started?.ownerPrivate?.ownerIds ?? []).join(',');
    remindersActive = started?.reminders?.active === true;
    harness.assert(startedOk, 'public-cli-not-started');
    harness.assert(typeof bot.onMessage === 'function', 'on-message-not-wired');
    harness.assert(remindersActive, 'reminders-not-active');

    const groupBody = '群聊暗号-拒绝-x07';
    const strangerBody = '陌生人暗号-拒绝-x07';
    bot.onMessage(groupMsg({ text: groupBody }));
    bot.onMessage(privateMsg({ userId: STRANGER, text: strangerBody, messageId: 'x07-p2' }));
    await flushWindow();

    const rejectionLines = capture.lines
      .filter((line) => line.includes('[owner-private] 已拒绝：'))
      .map((line) => line.slice(line.indexOf('：') + 1));
    groupRejected = rejectionLines.includes('group');
    nonOwnerRejected = rejectionLines.includes('not-owner');
    modelErrors = capture.lines.filter((line) => line.startsWith('[出错]')).length;
    rejectedBodyInLogs = capture.lines.some((line) => line.includes(groupBody) || line.includes(strangerBody));

    const rejects = {
      rejectionLines: rejectionLines.join('|'),
      reminders: reminderRecords(dataDir).length,
      privateSends: bot.calls.private.length,
      groupSends: bot.calls.send.length,
      typing: bot.calls.typing.length,
      memoryTurns: fs.existsSync(path.join(dataDir, 'turns.jsonl')),
    };

    harness.step({
      title: '群聊 / 非 owner 在入口拒绝：提醒、发送、记忆全部 0 次',
      input: {
        kind: 'owner-private-rejections',
        note: '同一条明确提醒命令分别来自群聊与陌生人私聊；合成 OneBot 只记录调用',
      },
      expected: {
        groupRejected: true,
        nonOwnerRejected: true,
        rejectionLines: 'group|not-owner',
        modelErrors: 0,
        reminderRecords: 0,
        privateSends: 0,
        groupSends: 0,
        typing: 0,
        memoryTurns: false,
        bodyInLogs: false,
      },
      actual: {
        groupRejected,
        nonOwnerRejected,
        rejectionLines: rejects.rejectionLines,
        modelErrors,
        reminderRecords: rejects.reminders,
        privateSends: rejects.privateSends,
        groupSends: rejects.groupSends,
        typing: rejects.typing,
        memoryTurns: rejects.memoryTurns,
        bodyInLogs: rejectedBodyInLogs,
      },
    });

    /* 白名单正对照：同一命令由 owner 私聊进入 → 落盘 + 一次确认。 */
    bot.onMessage(privateMsg({ text: COMMAND, messageId: 'x07-p3' }));
    await flushWindow();

    const records = reminderRecords(dataDir);
    const confirmation = bot.calls.private.at(-1) ?? null;
    const ownerLogs = capture.lines.filter((line) => line.startsWith('[owner-private] 已拒绝：')).length;
    harness.step({
      title: '白名单私聊对照成功：提醒落盘一次、只发一条确认，仍不走模型',
      input: {
        kind: 'owner-private-allowlist',
        note: '合成 owner 发送同一条明确提醒命令；正对照走 --reminders 命令路径',
      },
      expected: {
        ownerPrivateOwners: OWNER + ',' + OTHER,
        remindersActive: true,
        reminderRecords: 1,
        reminderText: REMINDER_TEXT,
        reminderStatus: 'queued',
        confirmationSends: 1,
        confirmationUser: OWNER,
        confirmationHasText: true,
        modelErrors: 0,
        groupSends: 0,
        memoryTurns: false,
        rejectionLinesAfterOwner: 2,
      },
      actual: {
        ownerPrivateOwners,
        remindersActive,
        reminderRecords: records.length,
        reminderText: records[0]?.text ?? '',
        reminderStatus: records[0]?.status ?? '',
        confirmationSends: bot.calls.private.length,
        confirmationUser: confirmation?.userId ?? '',
        confirmationHasText: String(confirmation?.text ?? '').includes(REMINDER_TEXT),
        modelErrors: capture.lines.filter((line) => line.startsWith('[出错]')).length,
        groupSends: bot.calls.send.length,
        memoryTurns: fs.existsSync(path.join(dataDir, 'turns.jsonl')),
        rejectionLinesAfterOwner: ownerLogs,
      },
    });
  } finally {
    started?.reminders?.stop();
    capture.restore();
  }

  return {
    modules: [
      'index.js#main',
      'owner-private.js',
      'reminder-commands.js',
      'reminder-service.js',
    ],
    limitation: 'owner-private-cli-synthetic-onebot-subscenario',
    scope: 'sub-scenario',
    corroborates: ['B-14', 'B-18'],
    proofRequired: [
      'B-14 / B-18 仍缺宿主/QQ 集成路径：真实 QQ 群聊关闭、非 owner 私聊拒绝、白名单私聊成功',
      '本场景只覆盖公开通用 CLI 的 owner-private 入口 + 合成 OneBot + 提醒命令路径',
      '正常 owner 私聊的模型/记忆接线仍以 #95 的包内测试为旁证，不是本矩阵的执行证据',
      '真实平台收发与芙兰原宿主装配仍属 T9 / 宿主验收，不能用 X-07 记完成',
    ],
    note: 'X-07 是旁证，不是 B-14 / B-18 的通过证据；两场景在场景表里保持 not-covered。',
    rejectedBodies: 'logs-only-closed-reasons',
    positiveControl: 'reminder-command-path',
  };
}

/** X-07 场景对象（顺序由 scenarios.mjs 决定）。 */
export const OWNER_PRIVATE_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'X-07',
    aliases: ['owner-private'],
    gate: 'extra',
    status: 'covered',
    title: 'X-07（增补）owner-private 通用 CLI：配置闸门先于运输/存储，群聊/非 owner 拒绝，白名单私聊正对照',
    run: runX07,
  }),
]);