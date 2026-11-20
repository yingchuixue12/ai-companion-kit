/**
 * 主人私聊提醒 · 端到端（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只从真实入口 packages/companion/src/index.js 的 main() 出发，把外部世界
 * 全部换成可审计的替身，中间所有业务模块都是真的：
 *
 *   真实 main() → 真实 ConversationWindow → reminder-commands → reminder-service
 *   → reminder-store（真文件）→ reminder-runtime（真定时器）→ reminder-dispatcher
 *   → reminder-onebot → 假 OneBot
 *
 * 四个边界替身：
 *   - 假 OneBot：createBot 只捕获 main 装配进去的 onMessage，并按调用记录
 *     sendPrivateText / send；不连 WebSocket、不调 HTTP；
 *   - 假 process：argv / on / exit 都只记录，SIGINT 仍走主程序里的真实处理函数，
 *     但不真的退出进程；
 *   - 临时目录：config.json / role.md / data/reminders.json 全在 mkdtemp 里，
 *     不读真实配置，也不碰仓库里的 data/；
 *   - 可控时钟：node:test 的 mock timers 同时接管 Date 与 setTimeout，所以 main()
 *     创建各层时捕获到的 Date.now 和定时器就是这一套；时间只由 tick 推进。
 *
 * 覆盖的验收点：
 *   1. 从「没有提醒快照」开始：data/reminders.json 起初不存在；
 *   2. 主人私聊发一条明确的相对提醒 → 确认消息里的任务 ID 与落盘记录一致，
 *      dueAt = 刷出时刻 + 5 分钟，status queued，attempt 0、firedAt null；
 *   3. 推进到到期前 1 秒：一条提醒都不投递，状态仍是 queued；
 *   4. 跨过到期时刻：只投递一次纯文本，落盘 sent、attempt 1、firedAt 到期时刻；
 *      继续跑几轮也不重发；
 *   5. 停（SIGINT 先停调度再退出）并重开同一份临时配置：跨多轮都不重发，
 *      快照也不被重写。
 *
 * 刻意不做的事：不联网（globalThis.fetch 换成「一调就抛」的替身，结尾断言零调用）、
 * 不读真实配置与真实 data/、不靠任何睡眠时长——异步只靠 setImmediate 主动冲刷
 * microtask，因此整条时间线是确定的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { main } from '../src/index.js';

const OWNER = '10001';
const OWNER_NAME = '小满';
/** 基线时钟：固定值，方便精确断言 dueAt / firedAt。 */
const START = 1_760_000_000_000;
/** 明确的相对提醒：5 分钟后。 */
const DELAY_MS = 5 * 60 * 1000;
const RAW = '5分钟后提醒我喝水';
const BODY = '喝水';
/** reminder-runtime 的两轮之间固定 1000ms，切片推进就按这个节奏。 */
const ROUND_MS = 1000;
/** 命令确认消息的固定开头（与 reminder-commands 一致）。 */
const CONFIRM_PREFIX = '好，到点提醒你：';

/** <dataDir>/reminders.json：命令落盘与派发读的是同一个文件。 */
function reminderFile(dir) {
  return path.join(dir, 'data', 'reminders.json');
}

/** 直接读盘，不经过被测模块的 store，避免「自己验自己」。 */
function readRecords(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).records;
}

/**
 * 临时配置：主人白名单 + 私聊窗口 0ms。
 * 0ms 窗口让命令刷出即处理，落盘时刻就等于当前时钟，dueAt 可以精确断言。
 */
function writeTempConfig(dir) {
  fs.writeFileSync(path.join(dir, 'role.md'), '# 角色卡\n离线端到端测试用的角色卡。\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    // 模型永远不会被调用；这里留空只为覆盖「没配 apiKey」的启动分支。
    apiKey: '',
    names: [OWNER_NAME],
    ownerIds: [OWNER],
    dataDir: './data',
    wake: { probability: 0, privateWindowMs: 0, groupWindowMs: 0 },
    humanize: { enabled: false },
  }, null, 2));
  return configPath;
}

/** 一条合成 OneBot v11 私聊消息（字段形状与 transport-onebot.js 的产出一致）。 */
function privateMsg({ text, messageId = 'private-msg-1' }) {
  return {
    key: 'private:' + OWNER,
    isGroup: false,
    groupId: '',
    userId: OWNER,
    name: OWNER_NAME,
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId,
    time: START,
  };
}

/** 主动冲刷 microtask / macrotask 队列：不睡眠，只让出事件循环。 */
async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * 起一次真实 main()。假 OneBot 把 main 装配的 onMessage 交出来，
 * 命令确认与提醒投递都记在 sentPrivate，普通聊天发送另记一份。
 */
async function startCli(configPath) {
  const builds = [];
  const sentPrivate = [];
  const sentChat = [];
  const bot = {
    sentPrivate,
    sentChat,
    async sendPrivateText(userId, text) {
      sentPrivate.push({ userId, text });
      return { receipt: { status: 'confirmed' } };
    },
    async send(key, text) {
      sentChat.push({ key, text });
      return { receipt: { status: 'confirmed' } };
    },
    async setTyping() { return { ok: true }; },
  };

  // 假 process：只记录 argv / 事件 / exit；SIGINT 仍然走 main 里的真实处理函数。
  const proc = new EventEmitter();
  proc.argv = ['node', 'src/index.js', '--config', configPath, '--reminders'];
  proc.exits = [];
  proc.exit = (code) => { proc.exits.push(code); };

  const run = await main({
    createBot: (options) => { builds.push(options); return bot; },
    proc,
  });
  return { run, bot, proc, builds, receive: builds[0]?.onMessage };
}

test('CLI 提醒端到端：私聊建提醒 → 到期只投递一次 → 停并重开不重发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-reminder-e2e-'));
  const errors = [];
  let first = null;
  let second = null;
  try {
    // 先接管时钟与定时器，再起 main()：各模块创建时捕获的 Date.now / setTimeout
    // 必须是这一套，之后每次 tick 都会同时推进两者。
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
    const fetchMock = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('离线端到端用例不允许真实网络请求');
    });

    /**
     * 推进时钟：按 runtime 的 1 秒节奏切片，每片之后主动冲刷，让本轮
     * dispatchNext 彻底结束并排好下一轮；不用睡眠，也不依赖真实等待。
     */
    const advance = async (ms, { step = ROUND_MS } = {}) => {
      let remaining = ms;
      do {
        const slice = Math.min(step, Math.max(remaining, 0));
        t.mock.timers.tick(slice);
        remaining -= slice;
        await settle();
      } while (remaining > 0);
    };

    // ── 0. 临时配置 + 空快照 ──────────────────────────────────
    const configPath = writeTempConfig(dir);
    const file = reminderFile(dir);
    assert.equal(fs.existsSync(file), false, '开始时没有任何提醒快照');

    // ── 1. 起 CLI，拿到 main 装配出来的 onMessage ──────────────
    first = await startCli(configPath);
    assert.equal(first.builds.length, 1, '只装配一个 OneBot');
    assert.equal(typeof first.receive, 'function', 'onMessage 已被捕获');
    assert.equal(first.run.reminders?.active, true, '有有效主人白名单，提醒调度生效');
    assert.equal(first.run.reminders.running, true);

    // ── 2. 主人私聊发明确的相对提醒：落盘 + 确认 ──────────────
    const createAt = Date.now();
    first.receive(privateMsg({ text: RAW, messageId: 'cli-remind-1' }));
    await advance(0);
    assert.equal(Date.now(), createAt, '0ms 窗口：刷出不推进时钟');

    assert.equal(first.bot.sentPrivate.length, 1, '命令只回一条确认');
    const confirmation = first.bot.sentPrivate[0];
    assert.equal(confirmation.userId, OWNER);
    assert.ok(
      confirmation.text.startsWith(CONFIRM_PREFIX + BODY + '\n任务 ID：'),
      '确认先报正文、再报任务 ID',
    );

    const taskId = /任务 ID：([0-9a-fA-F-]{36})/u.exec(confirmation.text)?.[1];
    assert.equal(typeof taskId, 'string', '确认里带完整任务 ID');
    assert.match(confirmation.text, new RegExp('取消提醒 ' + taskId, 'u'), '确认里给了取消入口');

    const queued = readRecords(file);
    assert.equal(queued.length, 1, '快照里恰好一条提醒');
    const record = queued[0];
    assert.equal(record.taskId, taskId, '落盘 ID 与确认里的 ID 一致');
    assert.equal(record.conversationKey, 'private:' + OWNER);
    assert.equal(record.text, BODY, '正文就是解析出来的提醒内容');
    assert.equal(record.status, 'queued');
    assert.equal(record.dueAt, createAt + DELAY_MS, 'dueAt = 刷出时刻 + 5 分钟');
    assert.equal(record.attempt, 0);
    assert.equal(record.firedAt, null);

    // ── 3. 到期前：一条都不投递，状态仍是 queued ──────────────
    await advance(DELAY_MS - ROUND_MS);
    assert.equal(Date.now(), createAt + DELAY_MS - ROUND_MS, '时钟推到到期前 1 秒');
    assert.equal(first.bot.sentPrivate.length, 1, '到期前没有投递任何提醒');
    assert.equal(readRecords(file)[0].status, 'queued', '到期前状态仍是 queued');

    // ── 4. 跨过到期时刻：只投递一次纯文本并落 sent ────────────
    await advance(ROUND_MS);
    assert.equal(Date.now(), createAt + DELAY_MS, '时钟正好越过到期时刻');

    const deliveries = first.bot.sentPrivate.slice(1);
    assert.equal(deliveries.length, 1, '到期只投递一次');
    assert.equal(deliveries[0].userId, OWNER, '投给主人本人');
    assert.equal(typeof deliveries[0].text, 'string');
    assert.equal(deliveries[0].text, BODY, '投递的就是纯文本正文，不裁剪、不包装');

    const sent = readRecords(file);
    assert.equal(sent.length, 1, '仍然只有这一条记录');
    assert.equal(sent[0].taskId, taskId);
    assert.equal(sent[0].status, 'sent', '投递成功后落 sent');
    assert.equal(sent[0].attempt, 1);
    assert.equal(typeof sent[0].firedAt, 'number');
    assert.ok(sent[0].firedAt >= sent[0].dueAt, 'firedAt 不早于 dueAt');
    assert.ok(sent[0].firedAt - sent[0].dueAt < ROUND_MS, 'claim 落在到期后的第一轮以内');
    assert.equal(sent[0].dueAt, createAt + DELAY_MS, 'dueAt 没有被改写');

    // 再跑几轮：已 sent 的记录绝不复活。
    await advance(3 * ROUND_MS);
    assert.equal(first.bot.sentPrivate.length, 2, '再跑三轮也不重发');
    assert.equal(readRecords(file)[0].status, 'sent');
    const settledText = fs.readFileSync(file, 'utf8');

    // ── 5. 停（SIGINT 先停调度）再重开同一份临时配置 ─────────
    first.proc.emit('SIGINT');
    assert.equal(first.run.reminders.running, false, 'SIGINT 先停调度');
    assert.deepEqual(first.proc.exits, [0], '然后才退出');

    second = await startCli(configPath);
    assert.equal(second.run.reminders.active, true, '重开后调度照常生效');
    assert.equal(second.run.reminders.running, true);
    assert.deepEqual(second.bot.sentPrivate, [], '重开不会补发已经 sent 的提醒');

    // 多轮：重启后的实例只能看到终态，永不重发、也不重写快照。
    await advance(5 * ROUND_MS);
    assert.deepEqual(second.bot.sentPrivate, [], '重开后多轮也不重发');
    assert.equal(fs.readFileSync(file, 'utf8'), settledText, '快照内容一个字都没变');

    // ── 全程边界 ─────────────────────────────────────────────
    assert.deepEqual(first.bot.sentChat, [], '命令消息没有掉进生成链');
    assert.deepEqual(second.bot.sentChat, []);
    assert.deepEqual(errors, [], '全程没有失败报告（固定文案也不会出现）');
    assert.equal(fetchMock.mock.callCount(), 0, '全程零网络请求');
    assert.equal(errors.some((line) => line.includes(BODY)), false, '日志里不出现提醒正文');
  } finally {
    second?.run?.reminders?.stop();
    first?.run?.reminders?.stop();
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});