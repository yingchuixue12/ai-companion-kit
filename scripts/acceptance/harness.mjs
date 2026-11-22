/**
 * T4 统一离线验收 / 故障框架 · harness
 * ─────────────────────────────────────────────────────────────
 * 这个文件只提供「跑一次离线验收」需要的地基，不实现任何业务：
 *
 *   1. 确定性：虚拟时钟（可推进）+ 带种子随机源 + 固定起点；
 *   2. 隔离：一切落在一个临时目录里，结束即删，删两次也不出错；
 *   3. 注入：假 bot / 脚本化假 brain / 默认拒绝的 fetchImpl，全部显式可替换；
 *   4. 事实：每一步都记成可机读结构（输入 / 模型 / 工具 / 任务 / 记忆 / 投递 /
 *      期望与实际差异），失败只留闭合错误码，不转发任何异常 message。

 * ── 明确不做什么（避免把框架当成真实验收）─────────────────────
 *   - 不发真实 QQ / OneBot / HTTP：默认 fetchImpl 直接拒绝，且**不改全局 fetch**
 *     （`globalThis.fetch` 从头到尾不动，避免制造进程级网络绕过）。
 *   - 不读写仓库 `data/`、真实配置、私密记忆或日志：tempDir 必须是系统临时目录，
 *     指到仓库里直接拒绝（code `unsafe-temp-dir`）。
 *   - 不调用真实模型：本 checkout 的 `brain.js` 直接调用全局 `fetch`，没有注入点，
 *     所以模型侧一律用脚本化替身；相关 step 的 `model.transport` 记
 *     `synthetic-scripted`，报告里同时给 `model-transport-synthetic` 诊断码。
 *   - 不驱动真实宿主集成 / QQ 集成：缺的路径在场景表里标 `not-covered`，
 *     不用纯桩断言冒充对不存在产品路径的验收。
 *
 * 契约版本：ACCEPTANCE_VERSION = 1（字段增删都要改它）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from '../../packages/companion/src/memory.js';

import { findScenario } from './scenarios.mjs';

/** 验收框架契约版本。 */
export const ACCEPTANCE_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（scripts/acceptance/<file> → 上两级）。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 默认虚拟时钟起点：2026-01-01T00:00:00Z。只影响记录时间，不影响产品逻辑。 */
export const DEFAULT_CLOCK_START = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 默认种子（固定，保证同输入同输出）。 */
export const DEFAULT_SEED = 20260101;

/** 临时目录名前缀。 */
const TEMP_PREFIX = 'ai-companion-acceptance-';

/** 错误码白名单：只允许这类形状的 code 出现在诊断里。 */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/u;
/** 诊断 detail 白名单：只允许「我们自己写的」短令牌，绝不放异常文本。 */
const SAFE_DETAIL = /^[A-Za-z0-9.:=_/<>-]{1,120}$/u;
/** step 里 model.failCode 等字段同样要过 SAFE_CODE。 */

/** 造一个只带闭合错误码的异常（message 就是 code，永不携带外部文本）。 */
export function acceptanceError(code, detail) {
  const safe = SAFE_CODE.test(String(code)) ? String(code) : 'acceptance-error';
  const error = new Error(safe);
  error.code = safe;
  if (typeof detail === 'string' && SAFE_DETAIL.test(detail)) error.detail = detail;
  return error;
}

/** 把任意异常折叠成 {code, detail?}，绝不转发 message / stack / 正文。 */
export function projectError(error) {
  const raw = typeof error?.code === 'string' ? error.code : '';
  const code = SAFE_CODE.test(raw) ? raw : 'unknown-error';
  const detail = typeof error?.detail === 'string' && SAFE_DETAIL.test(error.detail)
    ? error.detail
    : null;
  return detail === null ? { code } : { code, detail };
}

/**
 * 路径包含判断（平台感知）。
 * Windows 文件系统大小写不敏感：先统一小写再比，否则 `c:/users/...` 会被误判成
 * 「不在临时目录下」，导致 Git Bash / 小写盘符场景直接跑不起来。
 * @param {string} parent 父目录
 * @param {string} candidate 候选路径
 */
export function isPathInside(parent, candidate) {
  const normalize = (value) => {
    const text = path.resolve(String(value));
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  const root = normalize(parent);
  const child = normalize(candidate);
  return child === root || child.startsWith(root + path.sep);
}

/**
 * 校验临时目录安全：必须在系统临时目录下，且不能落在仓库里。
 * 这是「禁止读写 repo data/、真实配置」这条硬约束的执行点。
 */
export function assertSafeTempRoot(dir) {
  const resolved = path.resolve(String(dir));
  const resolvedTmp = path.resolve(os.tmpdir());
  if (isPathInside(REPO_ROOT, resolved)) {
    throw acceptanceError('unsafe-temp-dir', 'inside-repo');
  }
  if (!isPathInside(resolvedTmp, resolved)) {
    throw acceptanceError('unsafe-temp-dir', 'outside-os-tmp');
  }
  return resolved;
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 截断但保留换行（输入原文用）。 */
function clip(value, max = 200) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** 压成单行再截断（标题 / 备注用）。 */
function flat(value, max = 120) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** 深拷贝成 JSON 安全纯数据，并对深度 / 长度 / 条目数设上限。 */
function sanitizePlain(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(value, 240);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizePlain(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 20)) {
      out[clip(key, 40)] = sanitizePlain(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

/** 逐字段比较 expected / actual，产出机读差异。 */
function diffPlain(expected, actual) {
  const fields = new Set([
    ...Object.keys(expected ?? {}),
    ...Object.keys(actual ?? {}),
  ]);
  const diff = [];
  for (const field of [...fields].sort()) {
    const left = expected?.[field] ?? null;
    const right = actual?.[field] ?? null;
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      diff.push({ field, expected: left, actual: right });
    }
  }
  return diff;
}

/** mulberry32：同一 seed 产出同一序列，不依赖 Math.random。 */
function createRandom(seed) {
  let state = (Number(seed) || 0) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** sendBehavior 归一化：字符串 / 数组 / 函数三种写法。 */
const SEND_MODES = new Set(['confirmed', 'unknown', 'rejected', 'throw']);

function normalizeSendBehavior(behavior) {
  if (behavior === undefined || behavior === null) return () => 'confirmed';
  if (typeof behavior === 'function') {
    return (index) => {
      const mode = behavior(index);
      if (mode === undefined) return 'confirmed';
      if (typeof mode !== 'string' || !SEND_MODES.has(mode)) throw acceptanceError('invalid-send-behavior');
      return mode;
    };
  }
  if (Array.isArray(behavior)) {
    const modes = behavior.map((mode) => {
      if (typeof mode !== 'string' || !SEND_MODES.has(mode)) throw acceptanceError('invalid-send-behavior');
      return mode;
    });
    return (index) => modes[index] ?? modes[modes.length - 1] ?? 'confirmed';
  }
  if (typeof behavior === 'string' && SEND_MODES.has(behavior)) return () => behavior;
  throw acceptanceError('invalid-send-behavior');
}

/** 把 sendBehavior 模式投影成 Humanizer 认的回执 / 提醒派发认的状态串。 */
const RECEIPT_STATUS = Object.freeze({ confirmed: 'confirmed', unknown: 'unknown', rejected: 'rejected' });
const REMINDER_OUTCOME = Object.freeze({ confirmed: 'sent', unknown: 'unknown', rejected: 'failed' });

/* ───────────────────────── 结构化 step ───────────────────────── */

function normalizeInput(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.synthetic === false) throw acceptanceError('non-synthetic-input');
  const out = { synthetic: true, kind: flat(input.kind, 40) };
  if (Array.isArray(input.items)) {
    out.items = input.items.slice(0, 10).map((item) => ({
      text: clip(item?.text, 200),
      userId: clip(item?.userId, 64),
    }));
  }
  if (input.note !== undefined) out.note = flat(input.note, 160);
  if (input.extra !== undefined) out.extra = sanitizePlain(input.extra);
  return out;
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    transport: 'synthetic-scripted',
    calls: Number(model.calls) || 0,
    joined: clip(model.joined, 600),
    deferred: model.deferred === true,
    committed: model.committed === true,
    failed: model.failed === true,
    failCode: SAFE_CODE.test(String(model.failCode ?? '')) ? String(model.failCode) : null,
  };
}

function normalizeTool(tool) {
  return {
    name: clip(tool?.name, 64),
    ok: tool?.ok === true,
    code: SAFE_CODE.test(String(tool?.code ?? '')) ? String(tool.code) : null,
    policy: clip(tool?.policy, 24),
  };
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    id: clip(task.id, 64),
    status: clip(task.status, 24),
    attempt: Number.isInteger(task.attempt) ? task.attempt : null,
    firedAtSet: task.firedAtSet === true,
    kind: clip(task.kind, 24),
  };
}

function normalizeMemory(memory) {
  if (!memory || typeof memory !== 'object') return null;
  return {
    people: Number(memory.people) || 0,
    turns: Number(memory.turns) || 0,
    personKnown: memory.personKnown === true,
    interactions: Number(memory.interactions) || 0,
    topics: Number(memory.topics) || 0,
    committed: memory.committed === true,
  };
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;
  return {
    attempted: Number(delivery.attempted) || 0,
    sent: Number(delivery.sent) || 0,
    receipts: Array.isArray(delivery.receipts)
      ? delivery.receipts.slice(0, 10).map((status) => clip(status, 24))
      : [],
    texts: Array.isArray(delivery.texts) ? delivery.texts.slice(0, 10).map((text) => clip(text, 200)) : [],
    channel: clip(delivery.channel, 32),
  };
}

/* ───────────────────────── harness ───────────────────────── */

/**
 * 造一个离线验收 harness。
 *
 * @param {object} [options]
 * @param {number|(() => number)} [options.now] 虚拟时钟起点（数字）或外部时钟函数；
 *   给函数时 advanceClock 会拒绝（code `clock-not-virtual`）
 * @param {number} [options.seed] 随机源种子
 * @param {string} [options.tempDir] 指定临时目录（必须在系统临时目录下）；
 *   不给就自己 mkdtemp
 * @param {Array|Function} [options.brainReplies] 脚本化假 brain 的回复序列
 * @param {string|string[]|Function} [options.sendBehavior] 假 bot 的发送回执行为
 * @param {(url: string, init?: object) => Promise<any>} [options.fetchImpl]
 *   默认拒绝所有请求（code `offline-fetch-blocked`）
 * @returns {object} harness
 */
export function createHarness(options = {}) {
  const {
    now,
    seed = DEFAULT_SEED,
    tempDir,
    brainReplies = [],
    sendBehavior = 'confirmed',
    fetchImpl,
  } = options ?? {};

  /* ── 时钟 ── */
  let clockValue = DEFAULT_CLOCK_START;
  let clockSource = null;
  if (typeof now === 'function') {
    clockSource = now;
  } else if (now !== undefined) {
    if (!Number.isSafeInteger(now) || now < 0) throw acceptanceError('invalid-now');
    clockValue = now;
  }
  const readClock = () => {
    if (clockSource === null) return clockValue;
    let value;
    try {
      value = clockSource();
    } catch {
      return clockValue;
    }
    return Number.isSafeInteger(value) && value >= 0 ? value : clockValue;
  };
  const advanceClock = (ms) => {
    if (clockSource !== null) throw acceptanceError('clock-not-virtual');
    if (!Number.isSafeInteger(ms) || ms < 0) throw acceptanceError('invalid-clock-advance');
    clockValue += ms;
    return clockValue;
  };

  /* ── 目录 ── */
  const ownsTempRoot = tempDir === undefined || tempDir === null;
  const root = ownsTempRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
    : assertSafeTempRoot(tempDir);
  fs.mkdirSync(root, { recursive: true });
  let cleaned = false;
  const pathOf = (...segments) => path.join(root, ...segments.map(String));
  /**
   * 本场景碰过的顶层目录（由 dirOf / writeFile 自动登记）。
   * 临时目录是整个 harness 共享的，不登记的话「证据」会跨场景串在一起
   * （B-02 的 artifacts 里冒出 b01/*），报告就没法把文件归到具体场景。
   */
  let touchedRoots = new Set();
  const noteRoot = (segments) => {
    const first = String(segments[0] ?? '').split(/[\\/]/u)[0];
    if (first && first !== '.' && first !== '..') touchedRoots.add(first);
  };
  const dirOf = (...segments) => {
    noteRoot(segments);
    const dir = pathOf(...segments);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const writeFile = (relative, content) => {
    if (path.isAbsolute(String(relative)) || String(relative).split(/[\\/]/u).includes('..')) {
      throw acceptanceError('unsafe-temp-path');
    }
    noteRoot(String(relative).split(/[\\/]/u));
    const file = pathOf(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(content), 'utf8');
    return file;
  };

  /* ── 拒绝网络的 fetch（默认全拒；注入时走注入实现）── */
  const counters = { fetchCalls: 0, blockedFetchCalls: 0 };
  const injectedFetch = typeof fetchImpl === 'function' ? fetchImpl : null;
  const fetchGuard = async (url, init) => {
    counters.fetchCalls += 1;
    if (injectedFetch === null) {
      counters.blockedFetchCalls += 1;
      throw acceptanceError('offline-fetch-blocked');
    }
    return injectedFetch(url, init);
  };

  /* ── 随机源 ── */
  const random = createRandom(seed);

  /* ── 事件序（用于验证「生成 → 投递 → 提交」的先后）── */
  let events = [];

  /* ── 假 bot ── */
  let behavior = normalizeSendBehavior(sendBehavior);
  const bot = {
    deliveries: [],
    privateDeliveries: [],
    typing: [],
    sendIndex: 0,
    async send(key, text) {
      const index = bot.sendIndex;
      bot.sendIndex += 1;
      const mode = behavior(index);
      const record = {
        index,
        key: clip(key, 64),
        text: clip(text, 200),
        textChars: [...String(text ?? '')].length,
        mode,
        at: readClock(),
      };
      bot.deliveries.push(record);
      events.push('bot.send');
      if (mode === 'throw') throw acceptanceError('synthetic-send-failure');
      return { ok: true, receipt: { status: RECEIPT_STATUS[mode] } };
    },
    async setTyping(key, on) {
      bot.typing.push({ key: clip(key, 64), on: on === true, at: readClock() });
    },
    async sendPrivateText(userId, text) {
      const index = bot.sendIndex;
      bot.sendIndex += 1;
      const mode = behavior(index);
      const record = { index, userId: clip(userId, 64), text: clip(text, 200), mode, at: readClock() };
      bot.privateDeliveries.push(record);
      events.push('bot.sendPrivateText');
      if (mode === 'throw') throw acceptanceError('synthetic-send-failure');
      return REMINDER_OUTCOME[mode];
    },
  };

  /* ── 记忆 ── */
  let defaultMemory = null;

  /* ── steps ── */
  let steps = [];

  const harness = {
    version: ACCEPTANCE_VERSION,
    seed,
    tempRoot: root,
    ownsTempRoot,
    injections: Object.freeze({
      now: clockSource === null ? 'virtual' : 'injected',
      seed,
      tempDir: ownsTempRoot ? 'mkdtemp' : 'injected',
      brainReplies: typeof brainReplies === 'function' ? 'function' : brainReplies.length,
      sendBehavior: typeof sendBehavior === 'function' ? 'function' : sendBehavior,
      fetchImpl: injectedFetch === null ? 'deny' : 'injected',
    }),
    bot,
    fetch: fetchGuard,
    random,
    pathOf,
    dirOf,
    writeFile,
    now: readClock,
    isoNow: () => new Date(readClock()).toISOString(),
    advanceClock,
    get events() {
      return events;
    },
    get steps() {
      return steps;
    },
    get cleaned() {
      return cleaned;
    },
    get counters() {
      return { ...counters };
    },

    /** 断言辅助：失败只留我们自己写的 code。 */
    assert(condition, code) {
      if (!condition) throw acceptanceError('assertion-failed', code);
      return true;
    },
    /** 主动失败。 */
    fail(code) {
      throw acceptanceError('assertion-failed', code);
    },
    /** 造一个带闭合码的异常（供场景注入失败路径）。 */
    error: acceptanceError,

    /** 真 Memory（落在临时目录里）。 */
    makeMemory(name = 'memory') {
      return new Memory({ dir: dirOf(name) });
    },
    /** 默认 Memory（懒创建）。 */
    get memory() {
      // 默认 Memory 只建一次，跨场景复用；这里仍要登记目录，否则后续场景的
      // 证据里会缺 memory/ 下的文件。
      noteRoot(['memory']);
      if (defaultMemory === null) defaultMemory = harness.makeMemory('memory');
      return defaultMemory;
    },
    /** 把 Memory 的现状读成机读事实（只用公开 API，不产生副作用）。 */
    memoryFacts(memory, userId) {
      const target = memory ?? harness.memory;
      const dump = target.dump();
      const key = userId === undefined || userId === null ? null : String(userId);
      const person = key === null ? null : dump.people[key];
      return {
        people: Object.keys(dump.people).length,
        turns: dump.turns.length,
        personKnown: Boolean(person),
        interactions: person ? Number(person.interactions) || 0 : 0,
        topics: person ? (person.topics ?? []).length : 0,
      };
    },
    /** 脚本化假 brain（模型传输在检查 checkout 里不可注入，见文件头）。 */
    makeBrain(brainOptions = {}) {
      return createScriptedBrain({
        replies: brainOptions.replies ?? brainReplies,
        memory: brainOptions.memory ?? harness.memory,
        readClock,
        pushEvent: (event) => events.push(event),
      });
    },
    /** 默认假 brain。 */
    get brain() {
      return harness.makeBrain();
    },
    /** 把一次执行记成结构化 step，并算出期望/实际差异。 */
    step(fields = {}) {
      const record = {
        id: `s${steps.length + 1}`,
        title: flat(fields.title, 120),
        at: new Date(readClock()).toISOString(),
        input: normalizeInput(fields.input),
        model: normalizeModel(fields.model),
        tools: Array.isArray(fields.tools) ? fields.tools.map(normalizeTool) : [],
        task: normalizeTask(fields.task),
        memory: normalizeMemory(fields.memory),
        delivery: normalizeDelivery(fields.delivery),
        expected: sanitizePlain(fields.expected ?? null),
        actual: sanitizePlain(fields.actual ?? null),
        diff: [],
        ok: true,
      };
      record.diff = diffPlain(record.expected, record.actual);
      record.ok = record.diff.length === 0 && fields.ok !== false;
      const frozen = deepFreeze(record);
      steps.push(frozen);
      return frozen;
    },
    /** 运行期改发送回执脚本（场景需要"第几条失败"时用；同时把序号归零）。 */
    setSendBehavior(next) {
      behavior = normalizeSendBehavior(next);
      bot.sendIndex = 0;
      return behavior;
    },
    /** 清掉上一个场景留下的事实（每个场景从零开始）。 */
    reset() {
      steps = [];
      events = [];
      touchedRoots = new Set();
      bot.deliveries.length = 0;
      bot.privateDeliveries.length = 0;
      bot.typing.length = 0;
      bot.sendIndex = 0;
      counters.fetchCalls = 0;
      counters.blockedFetchCalls = 0;
      // 默认 Memory 也属于「上一个场景留下的事实」：删掉它的目录并让下次访问重建。
      // 否则整表跑时后面的场景会读到前面场景写入的 people/turns，单场景跑与整表跑结果不同。
      fs.rmSync(pathOf('memory'), { recursive: true, force: true });
      defaultMemory = null;
    },
    /** 列出临时目录里的文件（相对路径，排序后），用于 artifact 证据。 */
    tempFiles() {
      const out = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
      };
      walk(root);
      return out.sort();
    },
    /**
     * 只列**本场景**碰过的目录下的文件：共享临时目录里别的场景留下的文件不算本次证据。
     * 场景没碰任何目录时返回空数组（而不是把整棵临时树都算进来）。
     */
    scenarioTempFiles() {
      const roots = new Set(touchedRoots);
      return harness.tempFiles().filter((relative) => roots.has(relative.split('/')[0]));
    },
    /**
     * 清理临时目录。幂等：第二次调用什么都不做。
     * 只删构造时校验过的那个目录（构造期已确认在系统临时目录下、不在仓库里）。
     */
    cleanup() {
      if (cleaned) return false;
      cleaned = true;
      fs.rmSync(root, { recursive: true, force: true });
      return true;
    },
    /** cleanup 的别名（与「关闭」语义一致的调用点）。 */
    close() {
      return harness.cleanup();
    },
  };

  // 只在这里绑定产品 Memory，避免 scenarios/harness 之间出现循环 import。
  return harness;
}

/** 深冻结（step 交给调用方后不可改写）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * 脚本化假 brain：只模仿 Brain 的**对外契约**（返回 {text, commit}），
 * 不模仿它的网络行为。deferred 语义与 Brain 一致：调用方拿到 commit，
 * 只有在真正送达后才调用；commit 一次性，重复调用不再写记忆。
 */
function createScriptedBrain({ replies, memory, readClock, pushEvent }) {
  const script = typeof replies === 'function' ? replies : [...(replies ?? [])];
  const calls = [];
  let index = 0;

  const brain = {
    calls,
    transport: 'synthetic-scripted',
    async reply(input) {
      const position = index;
      index += 1;
      const text = Array.isArray(input?.text) ? input.text.join('\n') : String(input?.text ?? '');
      calls.push({
        index: position,
        key: clip(input?.key, 64),
        userId: clip(input?.userId, 64),
        record: input?.record === true ? 'immediate' : clip(String(input?.record), 24),
        joined: clip(text, 600),
        at: readClock(),
      });
      pushEvent('brain.reply');

      let item;
      if (typeof script === 'function') item = await script(position, input);
      else item = script[position];
      if (!item || typeof item !== 'object') throw acceptanceError('brain-script-exhausted');
      if (item.fail !== undefined) {
        const code = String(item.fail);
        if (!SAFE_CODE.test(code)) throw acceptanceError('brain-script-invalid');
        throw acceptanceError(code);
      }

      const out = typeof item.text === 'string' ? item.text : '';
      const writeMemory = () => {
        if (!memory) return;
        // 与 Brain#recordTurn 相同的两次调用（真实 Memory 代码，不是桩）。
        memory.remember(input?.userId, {
          name: input?.userName,
          topic: String(input?.text ?? '').slice(0, 40) + ' → ' + out.slice(0, 40),
        });
        memory.logTurn({ where: input?.key, who: input?.userName || input?.userId, text: input?.text, reply: out });
      };

      if (input?.record === 'deferred') {
        let attempted = false;
        return {
          text: out,
          raw: { synthetic: true },
          commit: () => {
            if (attempted) return;
            attempted = true;
            pushEvent('memory.commit');
            writeMemory();
          },
        };
      }
      pushEvent('memory.commit');
      writeMemory();
      return { text: out, raw: { synthetic: true } };
    },
  };
  return brain;
}

/* ───────────────────────── 场景执行 ───────────────────────── */

/**
 * 执行一个场景。
 *
 * @param {string} id 场景 id（见 scenarios.mjs）
 * @param {object} options
 * @param {object} options.harness createHarness 的返回值
 * @param {object} [options.scenarioOptions] 传给场景实现的选项
 * @param {Array} [options.registry] 场景表（默认用内置的；测试可注入）
 * @returns {Promise<{id:string, ok:boolean, status:'pass'|'fail'|'not-covered', gate:string,
 *   steps:object[], diagnostics:object[], artifacts:object}>}
 */
export async function runScenario(id, { harness, scenarioOptions, registry } = {}) {
  if (!harness || typeof harness.step !== 'function') throw acceptanceError('harness-required');
  const scenario = findScenario(id, registry);
  if (!scenario) throw acceptanceError('unknown-scenario');

  if (scenario.status === 'not-covered') {
    // reason 也走同一套 detail 白名单：闭合码不变式不能靠"当前常量恰好安全"维持。
    const reason = typeof scenario.reason === 'string' && SAFE_DETAIL.test(scenario.reason)
      ? scenario.reason
      : 'not-covered';
    return {
      id: scenario.id,
      ok: false,
      status: 'not-covered',
      gate: scenario.gate ?? 'b',
      steps: [],
      diagnostics: [{ code: 'not-covered', detail: reason }],
      artifacts: {
        notes: [scenario.title],
        requirements: [scenario.requires].filter(Boolean),
        // 没执行就没有产物：字段照样给，值是空数组（"没有证据"要能被机读区分）。
        tempFiles: [],
      },
    };
  }

  harness.reset();
  try {
    const artifacts = (await scenario.run(harness, scenarioOptions ?? {})) ?? {};
    const steps = [...harness.steps];
    const broken = steps.find((step) => !step.ok);
    if (broken) throw acceptanceError('step-mismatch', 'step:' + broken.id);
    harness.assert(steps.length > 0, 'no-steps-recorded');
    return {
      id: scenario.id,
      ok: true,
      status: 'pass',
      gate: scenario.gate ?? 'b',
      steps,
      diagnostics: [
        { code: 'all-steps-matched' },
        // 模型侧一致性：本框架从不调用真实模型，这一条永远在，避免误读。
        { code: 'model-transport-synthetic' },
      ],
      artifacts: { ...sanitizePlain(artifacts), tempFiles: harness.scenarioTempFiles() },
    };
  } catch (error) {
    const steps = [...harness.steps];
    return {
      id: scenario.id,
      ok: false,
      status: 'fail',
      gate: scenario.gate ?? 'b',
      steps,
      diagnostics: [projectError(error), { code: 'model-transport-synthetic' }],
      artifacts: { tempFiles: harness.scenarioTempFiles() },
    };
  }
}

/**
 * 临时接管 console.*，把产品代码的日志收成数组。**调用方必须 restore()**，
 * 否则控制台会一直不输出；run.mjs 在 finally 里无条件还原。
 * 只接管 log/error/warn/info 四个方法，不碰 process.stdout。
 */
export function captureConsole() {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const lines = [];
  const sink = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  console.log = sink;
  console.error = sink;
  console.warn = sink;
  console.info = sink;
  let restored = false;
  return {
    lines,
    restore() {
      if (restored) return lines;
      restored = true;
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.info = original.info;
      return lines;
    },
  };
}

/**
 * 把一次执行记成 step 的字段白名单在这里收口，场景实现只填值。
 * （step 记录本身由 createHarness 内的 harness.step 构造，见上。）
 */
