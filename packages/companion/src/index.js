/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → 私聊: ConversationWindow / 群聊: Waker.batch
 *                                        ↓
 *                                   Brain(生成回复)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run   只打印，不真发
 *   node src/index.js --check                            只检查角色卡
 *   node src/index.js --config ./config.json --reminders 开启提醒定时派发（默认关）
 *   node src/index.js --config ./config.json --owner-private
 *       主人私聊准入：配置必须有有效 ownerIds，且只放行白名单里的私聊；
 *       群聊 / 非主人 / 缺失或矛盾的会话标识在入口拒绝，不进入后续任何一层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { Role } from './role.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { ConversationWindow } from './conversation-window.js';
import { OneBot } from './transport-onebot.js';
import { createPrivateTurnReplay } from './private-turn-replay.js';
import { createReminderRuntime } from './reminder-runtime.js';
import { createReminderCommands } from './reminder-commands.js';
import { createPresenceQQHost } from './presence-qq-runtime.js';
import {
  OWNER_PRIVATE_CONFIG_ERROR,
  createOwnerPrivateGate,
  loadOwnerPrivateConfig,
} from './owner-private.js';
import {
  createEntryMemoryRetriever,
  normalizeRetrievalConfig,
  retrieveMemoryForTurn,
} from './memory/retrieval-entry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 分层提示词预算的硬上限：与 Brain 默认的 maxInputChars 同一条契约（24000）。
 * 这里只做入口校验，不重复预算算法；实际预算仍由 Brain / layer-quota 执行。
 * 改 Brain 默认上限时，必须同步这里与 `cli-prompt-budget.test.mjs` 的漂移守卫。
 */
export const MAX_SYSTEM_BUDGET_CHARS = 24000;

/** 固定失败文案：不含配置值、路径、异常原文。 */
export const SYSTEM_BUDGET_CONFIG_ERROR = '配置不可用：memory.systemBudgetChars 必须是正安全整数且不超过硬上限；已停止（未读角色卡、未创建 Memory、未连接 OneBot、未调用模型）。';

/** 配置闸门的固定原因码。 */
export const SYSTEM_BUDGET_CODES = Object.freeze({
  INVALID: 'system-budget-invalid',
});

/**
 * 校验 `memory.systemBudgetChars`。
 *
 * - 省略（undefined）→ `{ok:true, value:null}`：完全沿用旧模型请求与日志；
 * - 提供 → 必须是正安全整数且不超过硬上限，否则返回固定原因码；
 * - 不在这里构造 Brain/Role，也不读取任何运行时资源。
 *
 * @param {unknown} value
 * @returns {{ok:true, value:number|null} | {ok:false, code:string}}
 */
export function validateSystemBudgetChars(value) {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_SYSTEM_BUDGET_CHARS) {
    return { ok: false, code: SYSTEM_BUDGET_CODES.INVALID };
  }
  return { ok: true, value };
}

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath, argv = process.argv) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  return normalizeConfig(cfg, file, argv);
}

/**
 * 把已经读到的 JSON 值归一化成运行配置。
 *
 * 旧入口 `loadConfig()` 仍然保留「读不到就用默认值」的宽松行为；`--owner-private`
 * 在调用这里之前会先做严格闸门，失败时不会走到 Memory / OneBot 装配。
 *
 * @param {any} cfg
 * @param {string} file
 * @param {string[]} [argv]
 */
export function normalizeConfig(cfg, file, argv = process.argv) {
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));
  const systemBudgetChars = cfg.memory?.systemBudgetChars;

  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',

    roleCard: rel(cfg.roleCard, 'role.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir: rel(cfg.dataDir, 'data'),

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
    },
    oneBotStatusDiagnostics: cfg.onebot?.statusDiagnostics === true,

    names: cfg.names || [],
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),

    // QQ 在场主动消息（C-P2 默认关）：只有显式 enabled 且 owner 在 ownerIds 白名单里
    // 才会装配发送；未给出的数值字段交给各模块自己的安全默认值。
    presenceQQ: {
      enabled: cfg.presenceQQ?.enabled === true,
      ownerId: cfg.presenceQQ?.ownerId === undefined || cfg.presenceQQ?.ownerId === null
        ? ''
        : String(cfg.presenceQQ.ownerId).trim(),
      idleMs: cfg.presenceQQ?.idleMs,
      awayMs: cfg.presenceQQ?.awayMs,
      returnAfterMs: cfg.presenceQQ?.returnAfterMs,
      workAfterMs: cfg.presenceQQ?.workAfterMs,
      cooldownMs: cfg.presenceQQ?.cooldownMs,
      minGapMs: cfg.presenceQQ?.minGapMs,
      maxPerDay: cfg.presenceQQ?.maxPerDay,
      quietHours: cfg.presenceQQ?.quietHours ?? null,
      intentTtlMs: cfg.presenceQQ?.intentTtlMs,
      maxPending: cfg.presenceQQ?.maxPending,
    },

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 1500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 6000,
    },

    humanize: cfg.humanize || {},
    // 结构化记忆检索（默认关；只吃已合入的 tail-window / lexical 适配器，
    // 不迁移 v1、不发网络请求、不写真实记忆）
    memory: {
      retrieval: normalizeRetrievalConfig(cfg.memory?.retrieval),
      // 原样保留输入，交给 main 在构造任何下游之前校验（省略则保持对象形状不变）。
      ...(systemBudgetChars === undefined ? {} : { systemBudgetChars }),
    },
    reminders: argv.includes('--reminders'),
    dryRun: argv.includes('--dry-run'),
  };
}

// ── 错误报告 ──────────────────────────────────────────────────
/** 只放行不含用户内容的常见网络错误码，其余一律固定文案。 */
const SAFE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
]);

function logOneBotStatus(event) {
  if (!['connected', 'disconnected', 'error'].includes(event?.state)) return;
  const bounded = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  console.log('[onebot-status] ' + JSON.stringify({
    state: event.state,
    attempt: bounded(event.attempt),
    retryInMs: bounded(event.retryInMs),
  }));
}

/**
 * 统一的失败报告：固定文案 + 白名单错误码。
 * 不能转发 e.message —— Brain 的异常里可能带着原始 HTTP 响应或消息正文。
 *
 * @param {unknown} error
 * @param {string} [label] 固定短语（不要拼接外部文本）
 */
export function reportError(error, label) {
  const text = typeof label === 'string' && label ? label : '处理失败';
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code)
    ? '（' + error.code + '）'
    : '';
  console.error('[出错] ' + text + code);
}

// ── 提示词预算诊断 ────────────────────────────────────────────
/**
 * 把 Brain 已脱敏的 memory-budget 事件写到 CLI 日志。
 *
 * 事件字段由 Brain 固定为块名 / 计数 / 预算值（启用分层预算时 version=2，
 * 含 quotas）；这里不再拼接账号、上下文、URL、路径或异常原文。
 *
 * @param {object} event
 */
export function logMemoryBudget(event) {
  console.log('[memory-budget] ' + JSON.stringify(event));
}

// ── 私聊装配 ──────────────────────────────────────────────────
/**
 * 只在本进程显式开启提醒、非干跑、dataDir 有效时装配命令。
 * bot 在 main 里稍后才赋值，send 只在真正发确认时读取 deps.bot。
 */
function configureReminderCommands(deps, cfg) {
  if (!cfg?.reminders || cfg?.dryRun) return null;
  const dataDir = typeof cfg.dataDir === 'string' ? cfg.dataDir.trim() : '';
  if (!dataDir) return null;
  return createReminderCommands({
    dataDir,
    ownerIds: cfg.ownerIds,
    send: (userId, text) => deps?.bot?.sendPrivateText(userId, text),
    onError: () => { console.error('[提醒] 命令处理失败'); },
  });
}

// ── 记忆检索接线（默认关）────────────────────────────────────
/**
 * 给 Brain 造一个可选的记忆块提供者。
 *
 * - 配置没开 → 返回 null：Brain 完全跳过检索，走原来的 `renderPerson`；
 * - 配置开了 → 每次调用现取适配器（tail-window / lexical 都是只读），
 *   交给 `retrieveMemoryForTurn` 做请求、隐私兜底与预算渲染；
 * - 拿不到块时返回空字符串，不读取旧账本、不写盘。
 *
 * 只读：适配器只调用 `dump()` / `recentTurns()` / `listRecords()`，
 * 不碰 `remember` / `logTurn` / `touch`，也不迁移 v1→v2。
 *
 * @param {object} cfg
 * @param {object} memory  Memory 实例
 * @returns {null | ((input: {key: string, userId: string, text: string}) => Promise<string|null>)}
 */
export function buildMemoryBlocks(cfg, memory) {
  const retrieval = normalizeRetrievalConfig(cfg?.memory?.retrieval);
  if (!retrieval.enabled) return null;
  return async ({ key, userId, text } = {}) => {
    // 工厂只做"能不能用"的判断（关闭/账本不可读时返回 null），不读账本；
    // 真正读账本在适配器的 retrieve() 里，失败按 T-3 返回 degraded。
    // 意外错误由 Brain 侧转换为空记忆块。
    const retriever = createEntryMemoryRetriever({ memory, config: retrieval });
    const out = await retrieveMemoryForTurn({
      retriever,
      key,
      userId,
      text,
      config: retrieval,
    });
    return out.memory;
  };
}

/**
 * 私聊批次统一出口：命令先在当前串行队列里处理，普通消息仍走原生成链。
 * items / batch 由 ConversationWindow 冻结后交出，这里只读不写；需要拆分
 * 时新建数组，原批次保持不变。混合批次生成失败只留档普通消息，重放不会
 * 再执行命令。
 */
async function handlePrivateFlush({ deps, cfg, items, batch, commands, replay }) {
  const plans = [];
  const plain = [];
  for (const item of items) {
    const plan = commands?.classify(item);
    if (plan) plans.push(plan);
    else plain.push(item);
  }

  // 没有命令（或未开启命令）：保持原 items / batch 身份，沿用既有生成与留档。
  if (!plans.length) {
    return handleTurn(deps, items, cfg, {
      // 只有 brain.reply 拒绝才会走到这里；原始异常仍由 handleTurn 重抛给 onError。
      onGenerationError: () => { replay.remember({ items, batch }); },
    });
  }

  // 已在窗口的每会话串行队列里，直接发确认，不再嵌套 runSerial。
  for (const plan of plans) await commands.handle(plan);

  if (!plain.length) return;

  // 混合批次只把普通消息交给生成链；失败留档也只留这些消息。
  const turnItems = Object.freeze(plain);
  return handleTurn(deps, turnItems, cfg, {
    onGenerationError: () => { replay.remember({ items: turnItems, batch }); },
  });
}

/**
 * 私聊这一段的最小可测试装配：造一个会话窗口，刷出时把原消息交给现有 handleTurn。
 *
 * - 消息原样进窗口（窗口会把原文冻结后原样交回）；
 * - eligible 固定 true：私聊策略本来就是“每条都理”；
 * - 窗口时长用原 cfg 的 privateWindowMs；
 * - 去重：OneBot messageId 非空时，按会话作用域放进独立命名空间；
 *   没有 id 就不传，交给模块自己按 `会话key#序号` 分配；
 * - 失败统一由窗口的 onError 报告，不在这里重复 try/catch，也不挡后续消息；
 * - 宿主专用：failedPrivateTurns(key) 只列生成阶段失败的原批次元数据，
 *   replayPrivateTurn(key, batchId) 用 window.runSerial 串行重放同一批。
 *   这两个入口不改变普通私聊的刷出/发送/落账行为。
 *
 * @param {{deps: object, cfg: object, windowMs?: number, onError?: (e: unknown) => void, maxFailedPrivateTurns?: number}} opts
 */
export function createPrivateTurnWindow({ deps, cfg, windowMs, onError, maxFailedPrivateTurns } = {}) {
  // replay 只负责“留档 / 列元数据 / 串行再跑一次”，真正的生成仍是 handleTurn。
  const replay = createPrivateTurnReplay({
    runSerial: (key, job) => window.runSerial(key, job),
    runTurn: (record, hooks) => handleTurn(deps, record.items, cfg, hooks),
    maxFailed: maxFailedPrivateTurns,
  });

  const commands = configureReminderCommands(deps, cfg);

  const window = new ConversationWindow({
    windowMs: windowMs ?? cfg?.wake?.privateWindowMs ?? 1500,
    onFlush: (items, batch) => handlePrivateFlush({
      deps, cfg, items, batch, commands, replay,
    }),
    onError: onError || reportError,
    onDrop: (reason) => console.error('[丢弃] 会话窗口已关闭（' + reason + '）'),
  });

  // 宿主专用入口：不通过 lib.js 导出，也不进入模型上下文。
  window.failedPrivateTurns = (key) => replay.list(key);
  window.replayPrivateTurn = (key, batchId) => replay.replay(key, batchId);
  return window;
}

/** 把一条 OneBot 私聊消息推进窗口（外部 id 与窗口自动 id 分属不同命名空间）。 */
export function pushPrivateMessage(window, msg) {
  const id = typeof msg?.messageId === 'string' ? msg.messageId.trim() : '';
  const options = { eligible: true };
  if (id) options.eventId = 'onebot:' + JSON.stringify([msg.key, id]);
  return window.push(msg.key, msg, options);
}

// ── 主程序 ────────────────────────────────────────────────────
export async function main({ createBot, proc: injectedProc, process: injectedProcess } = {}) {
  // 默认维持当前运行方式；离线验证时只替换 bot 构造与进程对象。
  const proc = injectedProc || injectedProcess || process;
  const argv = Array.isArray(proc?.argv) ? proc.argv : process.argv;
  const buildBot = typeof createBot === 'function' ? createBot : (options) => new OneBot(options);

  const cfgIdx = argv.indexOf('--config');
  const configPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : null;
  const ownerPrivateRequested = argv.includes('--owner-private');

  // `--owner-private` 是严格模式：先过配置闸门，再碰 Memory / OneBot。
  // 失败时只打固定文案，不回显配置、路径或解析异常；返回 ok:false 让 CLI 非零退出。
  let cfg;
  let ownerPrivate = null;
  if (ownerPrivateRequested) {
    const loaded = loadOwnerPrivateConfig(configPath);
    if (!loaded.ok) {
      console.error('[owner-private] ' + OWNER_PRIVATE_CONFIG_ERROR);
      return {
        ok: false,
        bot: null,
        reminders: null,
        presence: null,
        ownerPrivate: { enabled: true, ok: false, code: loaded.code },
      };
    }
    cfg = normalizeConfig(loaded.config, loaded.file, argv);
    // 用严格闸门归一化过的白名单，避免宽松路径的 String() 形状混进来。
    cfg.ownerIds = loaded.ownerIds;
    ownerPrivate = { enabled: true, ok: true, ownerIds: [...loaded.ownerIds] };
  } else {
    cfg = loadConfig(configPath, argv);
  }

  // 提示词预算闸门：宽松路径与 --owner-private 都走同一份校验，且在角色卡 /
  // Memory / OneBot / 模型之前失败。非法值只报固定文案，不复述输入。
  const budget = validateSystemBudgetChars(cfg.memory?.systemBudgetChars);
  if (!budget.ok) {
    console.error('[配置] ' + SYSTEM_BUDGET_CONFIG_ERROR);
    return {
      ok: false,
      bot: null,
      reminders: null,
      presence: null,
      ownerPrivate,
      systemBudget: { enabled: false, ok: false, code: budget.code },
    };
  }
  const systemBudgetChars = budget.value;

  // 入口准入器在装配任何下游之前就绪；没有 flag 时为 null，旧行为不变。
  const ownerGate = ownerPrivate ? createOwnerPrivateGate({ ownerIds: cfg.ownerIds }) : null;

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + (cfg.oneBotStatusDiagnostics ? '连接诊断已启用' : cfg.onebot.wsUrl));
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('  提醒      ' + (cfg.reminders ? (cfg.dryRun ? '开（干跑不启动）' : '开') : '关'));
  console.log('  记忆检索  ' + (cfg.memory.retrieval.enabled
    ? cfg.memory.retrieval.mode + '（上限 ' + cfg.memory.retrieval.maxChars + ' 字）'
    : '关'));
  // 只有显式配置才多这一行；省略时启动横幅与旧版逐字节一致。
  if (systemBudgetChars !== null) {
    console.log('  提示词预算  ' + systemBudgetChars + ' 字（分层；硬上限 ' + MAX_SYSTEM_BUDGET_CHARS + '）');
  }
  if (ownerGate) console.log('  准入      owner-private（仅白名单私聊）');
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const role = new Role({
    cardPath: cfg.roleCard,
    maxChars: cfg.roleMaxChars,
    layered: systemBudgetChars !== null,
  });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    role,
    memory,
    memoryBlocks: buildMemoryBlocks(cfg, memory),
    // 省略（null）时两个选项都是旧默认：不启用分层预算，也不接诊断回调。
    systemBudgetChars,
    onMemoryBudget: systemBudgetChars === null ? null : logMemoryBudget,
  });
  const human = new Humanizer(cfg.humanize);
  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
  });

  const deps = { bot: null, brain, human, memory, waker };

  // 私聊走会话窗口（群聊仍走 Waker.batch + 定时器）
  const privateTurns = createPrivateTurnWindow({ deps, cfg, windowMs: cfg.wake.privateWindowMs });

  /** @type {Map<string, NodeJS.Timeout>} 每个群会话的合并定时器 */
  const pending = new Map();

  // Presence 装配在 bot 之后（发送要用 bot），但消息可能先到，所以先留一个句柄。
  /** @type {ReturnType<typeof createPresenceQQHost>|null} */
  let presenceHost = null;

  const bot = buildBot({
    ...cfg.onebot,
    ...(cfg.oneBotStatusDiagnostics ? { onStatus: logOneBotStatus } : {}),
    onMessage: (msg) => {
      // --owner-private：入口第一道闸。被拒消息不进入 presence / waker /
      // 模型 / 记忆 / 任务 / 发送；日志只留固定原因码，不写正文或账号。
      if (ownerGate) {
        const admission = ownerGate.admit(msg);
        if (!admission.ok) {
          console.error('[owner-private] 已拒绝：' + admission.reason);
          return;
        }
      }

      // 只有选定 owner 的私聊会动 presence；群聊/非 owner 由 host 自己忽略。
      // 先于唤醒判定，避免「静音」分支漏掉用户活动刷新。
      presenceHost?.onIncomingMessage(msg);

      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: 'diving',
              atMention: true,
              nameMention: !cfg.wake.groupAtOnly,
              question: !cfg.wake.groupAtOnly,
              poke: true,
              probability: cfg.wake.groupAtOnly ? 0 : cfg.wake.probability,
            }
          : { mode: 'active', anyMessage: true });   // 私聊每条都理
      }

      const verdict = waker.shouldWake(msg);
      const isOwner = cfg.ownerIds.includes(msg.userId);
      if (!verdict.wake && !isOwner) {
        if (msg.isGroup) console.log('[静音] ' + msg.name + '：' + msg.text.slice(0, 40));
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 私聊：交给会话窗口，等对方把话说完再生成回复
      if (!msg.isGroup) {
        pushPrivateMessage(privateTurns, msg).catch(reportError);
        return;
      }

      // 群聊合并窗口：等人把话说完
      clearTimeout(pending.get(msg.key));
      waker.batch(msg);
      pending.set(msg.key, setTimeout(() => {
        const items = waker.flush(msg.key);
        if (!items.length) return;
        handleTurn(deps, items, cfg).catch(reportError);
      }, cfg.wake.groupWindowMs));
    },
  });

  deps.bot = bot;

  // QQ 在场（默认关）：配置闸门全过才建 adapter；--dry-run 不建 adapter、不落盘。
  // 装配即显式恢复（不重放旧事件、不补发旧欢迎）；读取失败则 fail-closed 不发送。
  presenceHost = createPresenceQQHost({
    cfg,
    bot,
    human,
    now: () => Date.now(),
    journal: (event) => {
      // 只按固定事件类型报告，不转发任何正文 / 账号 / 异常 message。
      if (event?.type === 'presence-persist-failed') console.error('[在场] 状态落盘失败，本次不发送');
    },
  });
  if (cfg.presenceQQ.enabled) {
    console.log('  在场QQ    ' + (presenceHost.enabled
      ? presenceHost.ownerId + '（已启用）'
      : '未启用（' + presenceHost.status + '）'));
  }

  // 宿主定时运转：显式 --reminders 且非干跑才启动。没有有效白名单时
  // runtime 自己不会排定时器，也不碰 bot；干跑连 runtime 都不建。
  /** @type {ReturnType<typeof createReminderRuntime>|null} */
  let reminders = null;
  if (cfg.reminders && !cfg.dryRun) {
    reminders = createReminderRuntime({
      bot,
      window: privateTurns,   // 与普通私聊批次共用同一条每会话串行队列
      ownerIds: cfg.ownerIds,
      dataDir: cfg.dataDir,   // → <dataDir>/reminders.json
    });
    reminders.start();
    if (!reminders.active) console.log('[提醒] 没有有效主人白名单，不启动调度');
  }

  proc.on('unhandledRejection', (e) => reportError(e, '未处理'));
  proc.on('SIGINT', () => {
    // 先停调度与在场（落盘会话），再按原来的方式退出。
    reminders?.stop();
    presenceHost?.stop();
    console.log('\n再见。');
    if (typeof proc.exit === 'function') proc.exit(0);
    else process.exit(0);
  });

  console.log('在跑了。Ctrl+C 退出。\n');
  return {
    ok: true,
    bot,
    reminders,
    presence: presenceHost,
    ownerPrivate,
    systemBudget: { enabled: systemBudgetChars !== null, chars: systemBudgetChars },
  };
}

/**
 * 处理一轮（可能是合并后的多条）。
 *
 * 可选的第四个参数只给宿主/装配层用：
 * - onGenerationError：仅 Brain.reply 拒绝时调用，之后仍重抛原异常；
 * - onGenerationSuccess：Brain.reply 成功时调用，供重放层移除记录。
 * 发送、静默、干跑、提交等后续阶段的异常不经过 onGenerationError。
 *
 * @param {object} deps
 * @param {any[]} items
 * @param {object} cfg
 * @param {{onGenerationError?: () => void, onGenerationSuccess?: () => void}} [options]
 */
export async function handleTurn({ bot, brain, human, memory, waker }, items, cfg, {
  onGenerationError,
  onGenerationSuccess,
} = {}) {
  const last = items[items.length - 1];
  const key = last.key;
  const text = Waker.joinBatch(items);

  const situation = last.isGroup
    ? '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。'
    : '你在跟 ' + last.name + ' 私聊。';

  // deferred：这一轮先不写记忆，等真的发出去了（Humanizer 完成且 sent > 0）再一次性提交
  let result;
  try {
    result = await brain.reply({ key, userId: last.userId, userName: last.name, text, situation, record: 'deferred' });
  } catch (error) {
    // 只包住生成阶段：原始异常原样重抛，现有 onError 语义不变。
    onGenerationError?.();
    throw error;
  }

  onGenerationSuccess?.();

  const { text: out, commit } = result;
  if (!out) { console.log('   （没说话）'); return; }

  if (cfg.dryRun) { console.log('   [干跑] 会说：' + out); return; }

  const r = await human.say(out, {
    setTyping: (on) => bot.setTyping(key, on),
    send: (m) => bot.send(key, m),
  });
  console.log('   发出 ' + r.sent + ' 条：' + r.parts.map((p) => p.slice(0, 18)).join(' | '));
  // 发不出去就不提交；旧替身没有 commit，直接跳过
  if (r.sent > 0) commit?.();
  waker.wake(key);
  memory.touch(last.userId, { name: last.name });
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((result) => {
      // 配置闸门失败不抛异常（避免把配置/路径带进错误报告），用退出码表达。
      if (result?.ok === false) process.exit(1);
    })
    .catch((e) => { reportError(e, '启动失败'); process.exit(1); });
}
