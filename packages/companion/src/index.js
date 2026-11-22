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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath, argv = process.argv) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));

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
  const cfg = loadConfig(cfgIdx >= 0 ? argv[cfgIdx + 1] : null, argv);

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('  提醒      ' + (cfg.reminders ? (cfg.dryRun ? '开（干跑不启动）' : '开') : '关'));
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, role, memory });
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
    onMessage: (msg) => {
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
  return { bot, reminders, presence: presenceHost };
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
  main().catch((e) => { reportError(e, '启动失败'); process.exit(1); });
}
