/**
 * 私聊接入会话窗口 · issue #18（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证 index.js 已接好的私聊装配：
 *
 *   OneBot 消息 → pushPrivateMessage → ConversationWindow → handleTurn
 *
 * 边界：不联网、不起模型。brain / human / bot / memory / waker 全部是替身，
 * 只有 index.js 的私有装配 + 真的 ConversationWindow 参与。
 *
 * 覆盖点（对应 issue 的验收要求）：
 *   1. 同一私聊连续多条 → 一批交出；上一批没处理完时下一批排队，串行不并发；
 *   2. 处理期间晚到的消息 → 只进下一批，不改写已冻结的上一批；
 *   3. 重复投递（同 messageId）→ 只消费一次；批次交出之后重复投递也不再次消费；
 *   4. 没有 messageId 的消息与带数字 messageId 的消息分属不同命名空间，互相不吞；
 *   5. 不同私聊会话可以用同一个 messageId，按会话作用域去重；
 *   6. 生成失败 → onError 走固定文案 + 白名单错误码，不转发异常正文；
 *   7. 失败之后同一会话继续可用（后续消息照常生成并发出）；
 *   8. 失败批次不写入记忆、不叫醒 waker。
 *
 * 两个容易踩的边界（用例里都做了显式断言）：
 *   - handleTurn 在 dryRun 下只打印「会说」，不走 bot.send、也不 touch 记忆；
 *     要验证发送/落账的用例传 cfg: { dryRun: false }。
 *   - window.close() 是轮次边界（进程关闭语义）：close 之后再推只会走 onDrop。
 *     所以「失败后继续」不能靠 close 结算，而是在同一窗口里再 push + flush。
 *
 * 文件后半部分是「真实入口」用例：在同一个 node:test worker 里用 registerHooks +
 * 不同 query 动态导入真实 index.js，临时把 process.argv[1] 指向它来真跑一次 main()。
 * 只替换 OneBot 传输层这一个外部边界（不连网）；fetch 用内存响应，不调模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPrivateTurnWindow,
  pushPrivateMessage,
  reportError,
} from '../src/index.js';

/** 可控等待：等某个回调真的发生，不依赖 sleep 的具体毫秒数。 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** 让出若干轮事件循环，模拟一批的异步耗时，不用墙钟等待。 */
async function yieldTurns(n = 4) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * 造一条合成 OneBot v11 消息（字段形状与 transport-onebot.js 的 #handle 产出一致）。
 * @param {object} [overrides]
 */
function privateMsg({
  userId = '10001',
  text = '在吗',
  messageId = 'msg-1',
  name = '小满',
  time = 1_700_000_000_000,
  groupId = null,
} = {}) {
  const isGroup = groupId !== null && groupId !== undefined;
  return {
    key: (isGroup ? 'group:' : 'private:') + (isGroup ? groupId : userId),
    isGroup,
    groupId: isGroup ? String(groupId) : '',
    userId: String(userId),
    name,
    text,
    raw: [{ type: 'text', data: { text } }],
    isAtMe: false,
    isQuoteMe: false,
    replyTo: null,
    messageId: String(messageId),
    time,
  };
}

/** 测试用 cfg：私聊窗口很短；默认干跑（不真发）。 */
function baseCfg(overrides = {}) {
  return {
    dryRun: true,
    ownerIds: [],
    wake: { privateWindowMs: 5, groupWindowMs: 5 },
    humanize: {},
    ...overrides,
  };
}

/**
 * 一组替身：brain 记下每轮收到的输入，bot 记下发出的每条，memory / waker 记下写入。
 * 每一轮生成默认卡在 gate 上，测试里 release() 才继续——这样「上一批未完成」
 * 是确定的状态，不靠墙钟猜测。
 * @param {{ reply?: (input: object, nth: number) => any }} [hooks]
 */
function fakeDeps(hooks = {}) {
  const replies = [];
  const sent = [];
  const writes = [];
  const logs = [];
  const gate = deferred();
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };

  const brain = {
    busy: 0,
    maxConcurrent: 0,
    async reply(input) {
      replies.push({ ...input });
      brain.busy += 1;
      brain.maxConcurrent = Math.max(brain.maxConcurrent, brain.busy);
      try {
        await gate.promise;
        const text = hooks.reply ? await hooks.reply(input, replies.length) : '收到';
        return { text };
      } finally {
        brain.busy -= 1;
      }
    },
    remember(userId, meta) { writes.push({ kind: 'brain-remember', userId, meta }); },
  };

  const human = {
    async say(text, io) {
      const parts = [String(text)];
      for (const part of parts) await io.send(part);
      return { sent: parts.length, parts };
    },
  };

  const bot = {
    async send(key, text) { sent.push({ key, text }); return { ok: true }; },
    async setTyping() { return { ok: true }; },
  };

  const memory = {
    touch(userId, meta) { writes.push({ kind: 'touch', userId, ...meta }); },
    remember() {},
    logTurn(record) { writes.push({ kind: 'logTurn', record }); },
  };

  const waker = { wake(key) { writes.push({ kind: 'wake', key }); } };

  return {
    deps: { bot, brain, human, memory, waker },
    replies,
    sent,
    writes,
    logs,
    release: () => gate.resolve(),
    restore: () => { console.log = originalLog; },
  };
}

/** 起一个私聊窗口，收集 onError。 */
function startWindow({ deps, cfg = baseCfg(), windowMs = 5, onError } = {}) {
  const errors = [];
  const window = createPrivateTurnWindow({
    deps,
    cfg,
    windowMs,
    onError: onError || ((error, context) => { errors.push({ error, context }); }),
  });
  return { window, errors };
}

/** 临时接住 console.error，用来断言「错误正文没有被打到日志里」。 */
function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  return {
    restore() { console.error = original; },
    text() { return lines.join('\n'); },
  };
}

// ── 1. 同私聊串行 ────────────────────────────────────────────

test('同一私聊：连续三条成一批；上一批没处理完时下一批排队，不并发', async () => {
  const fake = fakeDeps();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    const key = 'private:10001';

    await pushPrivateMessage(window, privateMsg({ text: '第一句', messageId: 'm-1' }));
    await pushPrivateMessage(window, privateMsg({ text: '第二句', messageId: 'm-2' }));
    await pushPrivateMessage(window, privateMsg({ text: '第三句', messageId: 'm-3' }));
    assert.equal(window.pending(key), 3, '三条同会话消息都留在同一个窗口里');

    const firstFlush = window.flush(key);
    await yieldTurns();
    assert.equal(fake.replies.length, 1, '第一批已进入生成');
    assert.match(fake.replies[0].text, /第一句/);
    assert.match(fake.replies[0].text, /第二句/);
    assert.match(fake.replies[0].text, /第三句/);

    // 第一批还挂在 brain 里，此时又来一条 + 刷出：只能排队
    await pushPrivateMessage(window, privateMsg({ text: '第四句', messageId: 'm-4' }));
    const secondFlush = window.flush(key);
    await yieldTurns();
    assert.equal(fake.replies.length, 1, '第一批没完成前，第二批不得开始生成');

    fake.release();
    await firstFlush;
    await secondFlush;
    await window.close();
    await yieldTurns();

    assert.equal(fake.replies.length, 2, '两批各自生成一次');
    assert.equal(fake.replies[0].text.includes('第四句'), false, '晚到的消息不能并进上一批');
    assert.match(fake.replies[1].text, /第四句/);
    assert.equal(fake.deps.brain.maxConcurrent, 1, '同一会话同一时刻最多一轮');
    // dryRun：只打印「会说」，不发消息
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.logs.filter((l) => l.includes('[干跑] 会说：')).length, 2);
    assert.deepEqual(window.pendingKeys(), []);
  } finally {
    fake.restore();
  }
});

async function startCli(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-onebot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(path.join(dir, 'role.md'), '# 角色卡\n离线测试角色。\n');
  fs.writeFileSync(configPath, JSON.stringify({
    apiKey: 'synthetic',
    names: ['小满'],
    wake: { probability: 0, privateWindowMs: 20, groupWindowMs: 40 },
    humanize: { enabled: false },
    ...config,
  }));

  const entry = new URL('../src/index.js', import.meta.url);
  entry.searchParams.set('offline-case', path.basename(dir));
  const bots = [];
  const sent = [];
  class OfflineBot {
    constructor({ onMessage }) { bots.push(onMessage); }
    async send(key, text) { sent.push({ key, text }); return { ok: true }; }
    async setTyping() {}
  }
  const fakeUrl = 'data:text/javascript,export const OneBot = globalThis.__companionOfflineBot;';
  globalThis.__companionOfflineBot = OfflineBot;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry.href && specifier === './transport-onebot.js') {
        return { url: `${fakeUrl}#${path.basename(dir)}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });

  const requests = [];
  const exits = [];
  const errors = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'offline reply' } }] }));
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', (line) => errors.push(line));
  t.mock.method(process, 'exit', (code) => exits.push(code));

  const originalArgv = process.argv;
  const events = ['unhandledRejection', 'SIGINT'];
  const listeners = Object.fromEntries(events.map((event) => [event, new Set(process.listeners(event))]));
  process.argv = [process.execPath, fileURLToPath(entry), '--config', configPath];
  try {
    await import(entry.href);
    await yieldTurns();
  } finally {
    for (const event of events) {
      for (const listener of process.listeners(event)) {
        if (!listeners[event].has(listener)) process.removeListener(event, listener);
      }
    }
    process.argv = originalArgv;
    hooks.deregister();
    delete globalThis.__companionOfflineBot;
  }
  return { bots, requests, sent, exits, errors };
}

test('CLI windows batch private messages and preserve the group wake rule', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bots, requests, sent, exits } = await startCli(t);
  assert.equal(bots.length, 1);
  const [receive] = bots;
  receive(privateMsg({ text: 'first', messageId: 'p1' }));
  receive(privateMsg({ text: 'second', messageId: 'p2' }));
  receive(privateMsg({ text: 'duplicate', messageId: 'p2' }));
  receive(privateMsg({ groupId: '8', userId: '9', text: 'quiet', messageId: 'g1' }));
  receive({ ...privateMsg({ groupId: '7', text: 'mention', messageId: 'g2' }), isAtMe: true });
  assert.equal(requests.length, 0);

  t.mock.timers.tick(20);
  await yieldTurns();
  assert.deepEqual(sent, [{ key: 'private:10001', text: 'offline reply' }]);
  const privateInput = requests[0].messages.at(-1).content;
  assert.match(privateInput, /first[\s\S]+second/);
  assert.doesNotMatch(privateInput, /duplicate/);

  t.mock.timers.tick(20);
  await yieldTurns();
  assert.deepEqual(sent.map(({ key }) => key), ['private:10001', 'group:7']);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /mention/);
  assert.deepEqual(exits, []);
});

test('CLI startup failure reports a fixed message and fails before opening OneBot', async (t) => {
  const { bots, requests, exits, errors } = await startCli(t, { ownerIds: 'invalid private value' });
  assert.deepEqual(bots, []);
  assert.deepEqual(requests, []);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors, ['[出错] 启动失败']);
});

test('不同私聊会话互不串行：两条私聊同时进入生成，不互相阻塞', async () => {
  const fake = fakeDeps();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });

    await pushPrivateMessage(window, privateMsg({ userId: '20001', messageId: 'same-id', text: '甲' }));
    await pushPrivateMessage(window, privateMsg({ userId: '20002', messageId: 'same-id', text: '乙' }));
    const a = window.flush('private:20001');
    const b = window.flush('private:20002');
    await yieldTurns();

    assert.equal(fake.replies.length, 2, '两批都已进入生成');
    assert.equal(fake.deps.brain.maxConcurrent, 2, '不同会话应可并行');

    fake.release();
    await Promise.all([a, b]);
    await window.close();
    assert.deepEqual(fake.replies.map((r) => r.key).sort(), ['private:20001', 'private:20002']);
  } finally {
    fake.restore();
  }
});

// ── 2/3. 晚到与去重 ──────────────────────────────────────────

test('重复投递的同一条私聊消息只生成一次；批次交出之后重复投递也不再消费', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    const key = 'private:10001';

    await pushPrivateMessage(window, privateMsg({ text: '只该回一次', messageId: 'dup-1' }));
    await pushPrivateMessage(window, privateMsg({ text: '只该回一次', messageId: 'dup-1' }));
    assert.equal(window.pending(key), 1, '同 messageId 第二次不进入窗口');

    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 1);

    // 批次早就交出去了，平台又投递一次：仍然必须挡住
    await pushPrivateMessage(window, privateMsg({ text: '只该回一次', messageId: 'dup-1' }));
    await yieldTurns();
    await pushPrivateMessage(window, privateMsg({ text: '只该回一次', messageId: 'dup-1' }));
    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 1, '交出之后重复投递不能再次消费');
    assert.deepEqual(window.pendingKeys(), []);
  } finally {
    fake.restore();
  }
});

test('处理期间晚到的消息只进下一批，已交出的上一批冻结不变', async () => {
  const fake = fakeDeps();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    const key = 'private:10001';

    await pushPrivateMessage(window, privateMsg({ text: '上一批', messageId: 'late-1' }));
    // 不要 await 这一批：它被 gate 卡在生成里，等它 settle 会死等
    window.flush(key);
    await yieldTurns();
    const frozen = fake.replies[0];
    assert.ok(frozen);
    assert.match(frozen.text, /上一批/);

    // 上一批已经交给 handleTurn（还卡在生成里）；再推一条只能是下一批
    await pushPrivateMessage(window, privateMsg({ text: '晚到的', messageId: 'late-2' }));
    await yieldTurns();
    assert.equal(frozen.text.includes('晚到的'), false, '已经交出的这批不能被后到的消息改写');

    fake.release();
    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 2);
    assert.match(fake.replies[1].text, /晚到的/);
    assert.equal(fake.replies[1].text.includes('上一批'), false, '下一批不重复上一批的内容');
  } finally {
    fake.restore();
  }
});

// ── 4. 无 ID 与数字 ID 不冲突 ────────────────────────────────

test('没有 messageId 的消息与带数字 messageId 的消息分属不同命名空间，彼此不吞消息', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    const key = 'private:30001';

    // 先一条没有 messageId 的：pushPrivateMessage 不传 eventId，模块按 `key#序号` 自己编号
    await pushPrivateMessage(window, privateMsg({ userId: '30001', text: '无编号-1', messageId: '' }));
    // 再一条 messageId 恰好是 "1" 的：不能因为与自动编号 `key#1` 撞名而被误判重复
    await pushPrivateMessage(window, privateMsg({ userId: '30001', text: '带编号-1', messageId: '1' }));
    // 又来一条同一个数字 id 的重复投递 → 这条应被挡住
    await pushPrivateMessage(window, privateMsg({ userId: '30001', text: '带编号-1', messageId: '1' }));

    assert.equal(window.pending(key), 2, '一条无 id + 一条有 id（重复那条已去重），一共两条');

    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 1);
    assert.match(fake.replies[0].text, /无编号-1/);
    assert.match(fake.replies[0].text, /带编号-1/);
  } finally {
    fake.restore();
  }
});

test('反序也成立：有数字 messageId 先到，空 messageId 随后不被吃掉', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    const key = 'private:30002';

    await pushPrivateMessage(window, privateMsg({ userId: '30002', text: '有编号先到', messageId: '2' }));
    await pushPrivateMessage(window, privateMsg({ userId: '30002', text: '无编号随后', messageId: '   ' }));
    await pushPrivateMessage(window, privateMsg({ userId: '30002', text: '有编号又来一条', messageId: '3' }));

    assert.equal(window.pending(key), 3, '空字符串/纯空白的 messageId 等同于没有 id');
    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 1);
    assert.match(fake.replies[0].text, /有编号先到/);
    assert.match(fake.replies[0].text, /无编号随后/);
    assert.match(fake.replies[0].text, /有编号又来一条/);
  } finally {
    fake.restore();
  }
});

// ── 5. 不同会话同 ID ─────────────────────────────────────────

test('不同私聊会话可以用同一个 messageId：按会话作用域去重，不会互相吃掉', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });

    await pushPrivateMessage(window, privateMsg({ userId: '40001', text: '甲的 900', messageId: '900' }));
    await pushPrivateMessage(window, privateMsg({ userId: '40002', text: '乙的 900', messageId: '900' }));

    assert.equal(window.pending('private:40001'), 1);
    assert.equal(window.pending('private:40002'), 1);

    // 只有「同一个会话里」重复才被挡住
    await pushPrivateMessage(window, privateMsg({ userId: '40002', text: '乙的 900', messageId: '900' }));
    assert.equal(window.pending('private:40002'), 1);

    await window.close();
    await yieldTurns();
    assert.equal(fake.replies.length, 2, '两个会话各生成一次');
    const byKey = new Map(fake.replies.map((r) => [r.key, r.text]));
    assert.match(byKey.get('private:40001'), /甲的 900/);
    assert.match(byKey.get('private:40002'), /乙的 900/);
  } finally {
    fake.restore();
  }
});

// ── 6. 不记录错误正文 ───────────────────────────────────────

test('reportError：固定文案 + 仅白名单错误码，异常正文与标识都不出现在日志里', () => {
  const secret = '用户原话-不能进日志-8848';
  const uid = '999888777';
  const captured = captureConsoleError();
  try {
    const whitelisted = new Error(`连接时被拒：${secret}（uid=${uid}）`);
    whitelisted.code = 'ECONNREFUSED';
    reportError(whitelisted);

    const notWhitelisted = new Error(`模型返回 500：${secret}`);
    notWhitelisted.code = 'ERR_MODEL_500';
    reportError(notWhitelisted);

    const text = captured.text();
    const lines = text.split('\n');
    assert.equal(lines[0], '[出错] 处理失败（ECONNREFUSED）');
    assert.equal(lines[1], '[出错] 处理失败', '非白名单错误码不转发');
    assert.equal(text.includes(secret), false, '不能转发异常正文');
    assert.equal(text.includes(uid), false, '不能转发异常里带的会话标识');
  } finally {
    captured.restore();
  }
});

test('生成失败：onError 收到错误上下文、日志只有固定文案，窗口不崩也不留拒绝', async () => {
  const captured = captureConsoleError();
  const failure = new Error('模型返回 500：泄漏的正文');
  failure.code = 'NOT_IN_WHITELIST';
  const fake = fakeDeps();
  fake.release();
  try {
    const errors = [];
    const { window } = startWindow({
      deps: fake.deps,
      cfg: baseCfg({ dryRun: false }),
      windowMs: 60_000,
      // 既收集上下文，又保留主程序真实默认行为（reportError）
      onError: (error, context) => { errors.push({ error, context }); reportError(error); },
    });
    fake.deps.brain.reply = async (input) => { throw failure; };

    await pushPrivateMessage(window, privateMsg({ text: '会失败的一句', messageId: 'fail-1' }));
    const flushed = window.flush('private:10001');
    await flushed;      // 刷出本身以 settled 形式返回：失败已被 onError 吸收，不会拒绝调用方
    await yieldTurns();

    assert.equal(errors.length, 1, '失败只报告一次');
    assert.equal(errors[0].error, failure);
    assert.equal(errors[0].context.key, 'private:10001');
    assert.deepEqual(errors[0].context.items.map((m) => m.text), ['会失败的一句']);
    assert.equal(captured.text(), '[出错] 处理失败', '非白名单错误码 + 固定文案');
    assert.equal(captured.text().includes('泄漏的正文'), false, '报错不泄漏异常正文');
    assert.equal(fake.writes.length, 0, '失败轮次不写记忆、不叫醒 waker');
    assert.equal(fake.sent.length, 0, '失败这一轮什么都没发出去');
  } finally {
    captured.restore();
    fake.restore();
  }
});

// ── 7/8. 失败后继续 ─────────────────────────────────────────

test('失败之后同一会话继续可用：下一批照常生成、发送，并落账', async () => {
  const captured = captureConsoleError();
  const failure = new Error('模型返回 500：泄漏的正文');
  failure.code = 'ECONNRESET';
  const fake = fakeDeps();
  fake.release();
  try {
    const { window, errors } = startWindow({ deps: fake.deps, cfg: baseCfg({ dryRun: false }), windowMs: 60_000 });
    const key = 'private:10001';
    fake.deps.brain.reply = async (input) => {
      fake.replies.push({ text: input.text });
      if (fake.replies.length === 1) throw failure;
      return { text: '第二次就成功了' };
    };

    // 第一轮失败
    await pushPrivateMessage(window, privateMsg({ text: '第一轮-会失败', messageId: 'fail-1' }));
    await window.flush(key);
    await yieldTurns();
    assert.equal(errors.length, 1);
    assert.equal(fake.sent.length, 0);
    assert.equal(fake.writes.length, 0, '失败轮次不落地');

    // 第二轮：同一个窗口、同一个会话，继续可用
    await pushPrivateMessage(window, privateMsg({ text: '第二轮-应该成功', messageId: 'fail-2' }));
    await window.flush(key);
    await yieldTurns();

    assert.equal(fake.replies.length, 2, '失败没有挡住后续消息');
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0].key, key);
    assert.equal(fake.sent[0].text, '第二次就成功了');
    assert.deepEqual(
      fake.writes.map((w) => w.kind),
      ['wake', 'touch'],
      '成功轮次才叫醒 waker、才 touch 记忆',
    );
    assert.equal(fake.writes[1].userId, '10001');
    assert.equal(fake.writes[1].name, '小满');
    assert.equal(JSON.stringify(fake.writes).includes('第一轮-会失败'), false, '失败批次正文没有落账');
    assert.equal(captured.text().includes('泄漏的正文'), false);
    await window.close();
  } finally {
    captured.restore();
    fake.restore();
  }
});

test('dryRun 下失败与成功都不写记忆（handleTurn 提前返回）：失败不影响后续轮次', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window, errors } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    fake.deps.brain.reply = async (input) => {
      fake.replies.push({ text: input.text });
      if (fake.replies.length === 1) throw new Error('boom');
      return { text: '干跑的第二轮' };
    };

    await pushPrivateMessage(window, privateMsg({ text: '第一轮', messageId: 'dry-1' }));
    await window.flush('private:10001');
    await yieldTurns();
    await pushPrivateMessage(window, privateMsg({ text: '第二轮', messageId: 'dry-2' }));
    await window.flush('private:10001');
    await yieldTurns();
    await window.close();

    assert.equal(errors.length, 1);
    assert.equal(fake.replies.length, 2);
    assert.equal(fake.sent.length, 0, 'dryRun 不发送');
    assert.equal(fake.writes.length, 0, 'dryRun 不落账');
    assert.equal(fake.logs.some((l) => l.includes('干跑') && l.includes('干跑的第二轮')), true);
  } finally {
    fake.restore();
  }
});

// ── 装配边界 ────────────────────────────────────────────────

test('窗口时长：用 cfg.wake.privateWindowMs，显式 windowMs 优先，缺省 1500ms', async () => {
  const fake = fakeDeps();
  try {
    const fromCfg = createPrivateTurnWindow({ deps: fake.deps, cfg: baseCfg({ wake: { privateWindowMs: 1234 } }) });
    assert.equal(fromCfg.windowMs, 1234);
    const explicit = createPrivateTurnWindow({ deps: fake.deps, cfg: baseCfg({ wake: { privateWindowMs: 1234 } }), windowMs: 7 });
    assert.equal(explicit.windowMs, 7);
    const fallback = createPrivateTurnWindow({ deps: fake.deps, cfg: {} });
    assert.equal(fallback.windowMs, 1500);
    await fromCfg.close();
    await explicit.close();
    await fallback.close();
  } finally {
    fake.restore();
  }
});

test('会话身份按原样交给 handleTurn：key / userId / name / 私聊处境 / 拼好的正文', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });

    await pushPrivateMessage(window, privateMsg({ userId: '55555', text: '把这句话带过去', messageId: 'shape-1', name: '测试昵称' }));
    await window.close();
    await yieldTurns();

    assert.equal(fake.replies.length, 1);
    assert.equal(fake.replies[0].key, 'private:55555');
    assert.equal(fake.replies[0].userId, '55555');
    assert.equal(fake.replies[0].userName, '测试昵称');
    assert.match(fake.replies[0].text, /测试昵称：把这句话带过去/, '批次正文按 Waker.joinBatch 的 `名字：正文` 形式拼');
    assert.match(fake.replies[0].situation, /私聊/);
  } finally {
    fake.restore();
  }
});

test('关闭之后再推私聊消息：显式走 onDrop 报告，不再生成', async () => {
  const fake = fakeDeps();
  fake.release();
  try {
    const drops = [];
    const { window } = startWindow({ deps: fake.deps, windowMs: 60_000 });
    window.onDrop = (reason, meta) => drops.push([reason, meta.key]);

    await window.close();
    await pushPrivateMessage(window, privateMsg({ text: '关掉之后才到', messageId: 'after-1' }));
    await yieldTurns();

    assert.deepEqual(drops, [['closed', 'private:10001']]);
    assert.equal(fake.replies.length, 0);
  } finally {
    fake.restore();
  }
});
