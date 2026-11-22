/**
 * 增补场景 · 公开 CLI 的普通私聊记忆引用（B-05 旁证）
 * ─────────────────────────────────────────────────────────────
 * B-05 在统一矩阵里仍然要求 QQ / 芙兰宿主集成证据：真实私聊进入宿主后，
 * 当前用户的记忆要进模型提示词、别人的记忆不能进，回复要发回正确会话并落账。
 * 本 checkout 只有公开通用 CLI，没有芙兰宿主或真实 QQ 连接；本文件只把
 * **公开 CLI + 合成 OneBot + 合成模型 fetch** 这一条正常私聊子场景接进矩阵，
 * 作为 B-05 的旁证，不把 B-05 改成 covered。
 *
 * X-08 只证明：
 *   1. 真实公开入口 `main()` 装配普通私聊（不是 `--owner-private` 准入场景，
 *      也不重复 X-07 的配置闸门 / 群聊拒绝范围）；
 *   2. 临时账本里本用户与另一用户的已保存事实，只有本用户事实进入
 *      实际 Brain 请求的 system 提示词；另一用户事实不出现；
 *   3. 只发生一次合成模型请求；回复只向本用户会话发送一次；
 *   4. 回复作为一轮对话记到正确的会话 key，另一用户账本不被污染。
 *
 * ── 证据边界（必须和 X-08 一起读）──────────────────────────
 *   - OneBot 是合成的：只实现 onMessage / send / sendPrivateText / setTyping，
 *     不建立 WebSocket、HTTP 或真实 QQ 连接；
 *   - 模型请求被合成 fetch 接管，只返回固定文本；结束后恢复原全局 fetch；
 *   - 临时账本、合成账号、合成文案；不读写仓库 data/ 或真实配置；
 *   - 因此 B-05 继续保持 not-covered：本场景不能替代芙兰宿主或真实 QQ（T9）验收。
 */
import path from 'node:path';

import { captureConsole } from './harness.mjs';
import { main } from '../../packages/companion/src/index.js';
import { Memory } from '../../packages/companion/src/memory.js';

/** 合成账号：占位值，不对应任何真实账号。 */
const OWNER = '10001';
const OTHER = '10002';

/** 合成事实与正文：只进临时账本 / 合成请求，不进 step 证据。 */
const OWNER_FACT = 'X-08 合成本用户事实：周末常去图书馆';
const OTHER_FACT = 'X-08 合成其他用户事实：不该进入本用户提示词';
const USER_TEXT = 'X-08 合成普通私聊：今天有点累';
const REPLY_TEXT = 'X-08 合成回复：早点休息。';

const MESSAGE_TIME = 1_760_000_000;

/** 合成 OneBot：不连网，只记录 main() 实际调用过的端口。 */
function createSyntheticOneBot(onSend) {
  const calls = { send: [], private: [], typing: [] };
  return {
    onMessage: null,
    calls,
    async send(key, text) {
      calls.send.push({ key: String(key), text: String(text) });
      if (typeof onSend === 'function') onSend();
      return { ok: true };
    },
    async sendPrivateText(userId, text) {
      calls.private.push({ userId: String(userId), text: String(text) });
      return { ok: true };
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

function privateMsg({ userId = OWNER, text = USER_TEXT, messageId = 'x08-p1' } = {}) {
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

/** 0ms 会话窗口：让出事件循环，不用真实睡眠。 */
async function flushWindow() {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  for (let i = 0; i < 16; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

/** 等一次合成发送；超时返回 false，交给外层断言。 */
async function waitForSend(signal) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { resolve(false); }, 2000);
  });
  const delivered = await Promise.race([signal, timeout]);
  clearTimeout(timer);
  return delivered === true;
}

/**
 * 临时接管全局 fetch：只返回固定模型回复，记录请求；restore() 必须执行。
 * Brain 目前直接调用全局 fetch，没有注入点（见 harness.mjs 文件头），
 * 所以这里用场景级替身，并在 finally 中恢复，避免泄漏到其它测试。
 */
function installSyntheticModelFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: REPLY_TEXT } }] }),
    };
  };
  let restored = false;
  return {
    calls,
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = original;
    },
  };
}

function requestBodyOf(call) {
  try {
    return JSON.parse(call?.init?.body ?? '');
  } catch {
    return null;
  }
}

function systemPromptOf(body) {
  const message = body?.messages?.find((item) => item?.role === 'system');
  return typeof message?.content === 'string' ? message.content : '';
}

/* ══════════════════════ X-08 ══════════════════════ */

/**
 * X-08：真实 `main()` + 合成 OneBot + 合成模型 fetch + 临时账本。
 * 不启用 `--owner-private`，只走普通私聊的公开装配路径。
 */
async function runX08(harness) {
  const root = 'x08';
  harness.writeFile(root + '/role.md', '# 角色卡\nX-08 合成公开 CLI 验收用角色卡。\n');
  const dataDir = harness.dirOf(root + '/data');

  // 临时账本：本用户与另一用户各一条已保存事实。不写其它轮次。
  const seed = new Memory({ dir: dataDir });
  seed.remember(OWNER, { name: '主人', fact: OWNER_FACT });
  seed.remember(OTHER, { name: '路人', fact: OTHER_FACT });

  const configPath = harness.writeFile(root + '/config.json', JSON.stringify({
    apiKey: 'synthetic-x08-key',
    baseUrl: 'http://model.invalid/v1',
    model: 'synthetic-x08-model',
    ownerIds: [OWNER],
    dataDir: './data',
    wake: { probability: 0, privateWindowMs: 0, groupWindowMs: 0 },
    humanize: { enabled: false },
    memory: { retrieval: { enabled: true, mode: 'tail-window' } },
  }));

  const proc = makeProc(['node', 'src/index.js', '--config', configPath]);
  let resolveSent = null;
  const sentSignal = new Promise((resolve) => { resolveSent = resolve; });
  const bot = createSyntheticOneBot(() => resolveSent(true));
  const fetchStub = installSyntheticModelFetch();
  const capture = captureConsole();

  let started = null;
  try {
    started = await main({
      createBot: (options) => {
        bot.onMessage = options.onMessage;
        return bot;
      },
      proc,
    });
    harness.assert(started?.ok === true, 'public-cli-not-started');
    harness.assert(typeof bot.onMessage === 'function', 'on-message-not-wired');

    bot.onMessage(privateMsg());
    const delivered = await waitForSend(sentSignal);
    harness.assert(delivered, 'synthetic-send-timeout');
    await flushWindow();

    const dump = new Memory({ dir: dataDir }).dump();
    const turns = Array.isArray(dump.turns) ? dump.turns : [];
    const ownerTurns = turns.filter((turn) => turn.where === 'private:' + OWNER);
    const otherTurns = turns.filter((turn) => turn.where === 'private:' + OTHER);
    const ownerFacts = Array.isArray(dump.people?.[OWNER]?.facts) ? dump.people[OWNER].facts : [];
    const otherFacts = Array.isArray(dump.people?.[OTHER]?.facts) ? dump.people[OTHER].facts : [];

    const modelCall = fetchStub.calls[0] ?? null;
    const body = requestBodyOf(modelCall);
    const system = systemPromptOf(body);
    const send = bot.calls.send[0] ?? null;

    harness.step({
      title: '公开 main 的普通私聊：一次模型请求只带本用户事实，一次发送落到本会话并落账',
      input: {
        kind: 'public-cli-memory-reference',
        note: '临时账本预置本用户与另一用户事实；仅合成模型 fetch 与合成 OneBot，不启用 --owner-private',
      },
      expected: {
        modelCalls: 1,
        modelUrlSynthetic: true,
        systemPresent: true,
        ownerFactInPrompt: true,
        otherFactInPrompt: false,
        userTextInRequest: true,
        sendCalls: 1,
        sendToOwnerConversation: true,
        sendTextMatched: true,
        typingCalls: 0,
        turns: 1,
        ownerTurns: 1,
        otherTurns: 0,
        turnWhereOwner: true,
        turnReplyMatched: true,
        ownerFactStillSaved: true,
        otherFactIntact: true,
      },
      actual: {
        modelCalls: fetchStub.calls.length,
        modelUrlSynthetic: modelCall?.url === 'http://model.invalid/v1/chat/completions',
        systemPresent: system.length > 0,
        ownerFactInPrompt: system.includes(OWNER_FACT),
        otherFactInPrompt: system.includes(OTHER_FACT),
        userTextInRequest: JSON.stringify(body ?? {}).includes(USER_TEXT),
        sendCalls: bot.calls.send.length,
        sendToOwnerConversation: send?.key === 'private:' + OWNER,
        sendTextMatched: send?.text === REPLY_TEXT,
        typingCalls: bot.calls.typing.length,
        turns: turns.length,
        ownerTurns: ownerTurns.length,
        otherTurns: otherTurns.length,
        turnWhereOwner: ownerTurns[0]?.where === 'private:' + OWNER,
        turnReplyMatched: ownerTurns[0]?.reply === REPLY_TEXT,
        ownerFactStillSaved: ownerFacts.includes(OWNER_FACT),
        otherFactIntact: otherFacts.includes(OTHER_FACT),
      },
    });
  } finally {
    started?.reminders?.stop();
    started?.presence?.stop();
    capture.restore();
    fetchStub.restore();
  }

  return {
    modules: [
      'index.js#main',
      'brain.js',
      'memory.js',
      'memory/retrieval-entry.js',
      'role.js',
      'humanize.js',
    ],
    limitation: 'public-cli-synthetic-model-and-onebot-memory-reference',
    scope: 'sub-scenario',
    corroborates: ['B-05'],
    proofRequired: [
      'B-05 仍缺 QQ / 芙兰宿主集成路径：真实 QQ 私聊进入宿主后的记忆引用、回复与落账',
      'X-08 只覆盖公开通用 CLI + 合成 OneBot + 合成模型 fetch 的普通私聊子场景，不能代替真实平台收发',
      'T9 真实 QQ 验收仍需人工执行，不能把芙兰宿主或真实 QQ 记完成',
    ],
    note: 'X-08 是 B-05 的公开 CLI 旁证，不是 B-05 通过证据；B-05 在场景表里保持 not-covered。',
    boundary: {
      realQQ: false,
      flandreHost: false,
      realModel: false,
      syntheticOneBot: true,
      syntheticModelFetch: true,
    },
  };
}

/** X-08 场景对象（顺序由 scenarios.mjs 决定）。 */
export const MEMORY_REFERENCE_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'X-08',
    aliases: ['memory-reference'],
    gate: 'extra',
    status: 'covered',
    title: 'X-08（增补）公开 CLI 普通私聊：模型只带本用户事实、只发本会话一次并落账（B-05 旁证）',
    run: runX08,
  }),
]);
