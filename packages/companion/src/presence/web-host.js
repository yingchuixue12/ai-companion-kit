/**
 * Web 在场宿主入口 · presence web host
 * ─────────────────────────────────────────────────────────────
 * 位置：和 presence-qq-runtime.js 同一层（宿主接线），只是把「投递」换成 Web 的形态。
 * 这里不重写状态机、互动策略、会话或存储，只做四件事：
 *
 *   1. **显式开启**：`enabled !== true` 时 observe()/settle() 是硬性空操作——
 *      不进状态机、不读盘、不写盘、不排队。缺省关闭，宿主必须显式打开。
 *   2. **内容盲路由**：宿主只给 `{ kind, at?, 一个布尔量 }`。本模块按白名单
 *      **重建**信号（kind + 可选 at + active/focused/alive 之一），其余键
 *      （text / title / url / clipboard / path / userId / 截图 …）在到达状态机
 *      之前就被丢掉，因此进不了事件、历史、队列或状态文件。另一个 kind 的
 *      布尔量被当成调用错误拒收（kind-flag-mismatch），而不是静默改写语义。
 *   3. **交付现有策略的提示**：每一拍把 session 产出的 intent
 *      （welcome-back / break-reminder；文案来自 PresenceInteractionPolicy
 *      的确定性短兜底）放进一个有界队列，宿主用 messages(after) 按游标读取。
 *      游标里带实例 id：服务重启后旧游标永远匹配不上，不会回放旧欢迎。
 *   4. **复用注入的持久化**：注入 PresenceStateStore（或给 stateFile 让本模块自建）
 *      之后，重启经 session.restore() 只恢复冷却/会话锚点/台账，不重放事件、
 *      不补发旧提示；写盘失败时 fail-closed —— 这一拍产生的提示**不交付**，
 *      并返回 state-save-failed，绝不交出一条「重启后还会再来一次」的欢迎。
 *
 * ── 时间边界（外部输入必须可表示）────────────────────────
 *   observe 的 `at` 与 settle 的时间（显式值或注入时钟）都只经过
 *   resolveExternalTime 这一个入口：必须落在一个 **Date 能表示的毫秒数** 上
 *   （±8.64e15）。超出范围的值（例如页面时钟坏掉发来的 1e18）在入口就拒收
 *   （invalid-at / clock-unavailable），不会交给状态机——否则它会在
 *   toISOString 上抛错，并把单调时钟锚点写坏，之后每一拍都继续抛错。
 *   拒收不改实例：状态、队列、状态文件都不动，同一个实例随后照常工作。
 *   上游万一仍然结构化拒绝（outcome.ok !== true），这一层如实把它的 reason
 *   交回宿主，绝不改写成成功。
 *
 * ── 禁用语义（清理必须成功）──────────────────────────────
 *   setEnabled(false) 先清空队列（禁用不残留排队提示），再关掉策略
 *   （policy.setEnabled(false) 自身会 reset），最后清掉持久化状态：
 *   「禁用 → 重启 → 再启用」从干净状态开始，不会沿用禁用前的冷却。
 *
 *   清理是**承诺**，不是尽力而为：只有 store.clear() 明确返回 `{ ok: true }`
 *   才算清干净。`{ ok: false }` / 抛异常 / 返回形状认不出来一律算失败：
 *     - 宿主仍然保持停用（不会偷偷继续跑）；
 *     - 记一条固定脱敏诊断 presence-web-state-clear-failed（不含异常、
 *       不含路径、不含 store 的任何原始字段）；
 *     - 同一个实例**不许**再启用，直到重试清理成功——绝不把旧文件当成
 *       干净状态来恢复。
 *   因此注入的 store 必须提供 clear()（缺了在构造时就 TypeError）；只有完全不
 *   持久化（既没有 store 也没有 stateFile）时才不需要清理。
 *
 * ── 关闭语义（§6 T6）────────────────────────────────────
 *   close() 与禁用一样**清空内存里待展示的提示**：关闭之后不再向宿主返回
 *   任何待展示提示（messages() 恒为空、pending 为 0），但**仍然落盘冷却**
 *   ——重启后靠这份存档判断「刚欢迎过 / 刚提醒过」，所以不会因为关闭而
 *   重复说一句。
 *
 * ── 投递口径（不谎称送达）────────────────────────────────
 *   本模块只负责「把提示交给宿主」，不写投递台账、不声称已送达：
 *   页面有没有真的展示，这一层看不见。跨重启的防重复靠 session 的
 *   冷却闸门（cooldowns.welcome / cooldowns.break），不靠 deliveredIds。
 *   口径偏保守：一次被闸门扣下的欢迎同样会推进策略自己的内存冷却，
 *   所以「扣下过一次」之后的一段时间里不会再尝试——宁可少说一句。
 *
 * ── 不做什么 ─────────────────────────────────────────────
 *   不开 HTTP 监听、不做认证、不画界面、不读真实传感器、不发 QQ、不调模型、
 *   不装定时器（节拍完全由宿主调用 observe/settle 决定）。
 */
import { randomBytes } from 'node:crypto';

import { PresenceInteractionPolicy } from '../presence-interaction.js';
import { PresenceRuntime } from '../presence-runtime.js';
import { PresenceStateStore } from './persistence.js';
import { createPresenceSession } from './session.js';

/** 与 QQ 分开的状态文件（C-P3）；相对路径由调用方给（例如 data/…）。 */
export const PRESENCE_WEB_STATE_FILE = 'presence-web-state.json';
/** 状态文件 TTL 7 天：过期存档按「没有状态」处理，不猜在场。 */
export const PRESENCE_WEB_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 排队提示上限（有界，超出丢最旧）。 */
export const PRESENCE_WEB_DEFAULT_MAX_MESSAGES = 32;

/**
 * 每种 kind 唯一允许的布尔字段。
 * 这是浏览器的本地在场信号，不是内容上报：一个 kind + 一个布尔量 + 可选时间戳。
 */
export const PRESENCE_WEB_SIGNAL_FLAGS = Object.freeze({
  activity: 'active',
  focus: 'focused',
  heartbeat: 'alive',
});

const SIGNAL_KINDS = Object.freeze(Object.keys(PRESENCE_WEB_SIGNAL_FLAGS));

/** host.status 的取值（入口自身的状态）。 */
export const PRESENCE_WEB_STATUSES = Object.freeze({
  DISABLED: 'disabled',
  READY: 'ready',
  CLOSED: 'closed',
  STATE_LOAD_FAILED: 'state-load-failed',
});

/** observe()/settle() 返回值的 status 取值（单拍结果）。 */
export const PRESENCE_WEB_RESULT_STATUSES = Object.freeze({
  OK: 'ok',
  DISABLED: 'disabled',
  CLOSED: 'closed',
  STATE_SAVE_FAILED: 'state-save-failed',
  SESSION_ERROR: 'session-error',
  REJECTED: 'rejected',
  INVALID_SIGNAL: 'invalid-signal',
  INVALID_KIND: 'invalid-kind',
  INVALID_FLAG: 'invalid-flag',
  /** 宿主没给 at，注入时钟也确定不出一个 Date 能表示的时间。 */
  CLOCK_UNAVAILABLE: 'clock-unavailable',
  KIND_FLAG_MISMATCH: 'kind-flag-mismatch',
  INVALID_AT: 'invalid-at',
});

/** 固定的、可观察的诊断码；不含异常 message、正文或文件路径。 */
export const PRESENCE_WEB_DIAGNOSTIC_CODES = Object.freeze({
  DISABLED: 'presence-web-disabled',
  IN_MEMORY: 'presence-web-in-memory',
  FRESH_START: 'presence-web-fresh-start',
  RESTORED: 'presence-web-restored',
  STATE_LOAD_FAILED: 'presence-web-state-load-failed',
  STATE_SAVE_FAILED: 'presence-web-state-save-failed',
  STATE_CLEAR_FAILED: 'presence-web-state-clear-failed',
});

/** 没有存档 / 存档过期 / 没有 store：按干净启动继续，不算「读盘失败」。 */
const FRESH_START_CODES = new Set(['absent', 'expired', 'no-store']);
/** 允许出现在诊断 detail 里的固定读盘码（白名单，绝不转发原始异常）。 */
const LOAD_DETAIL_CODES = new Set([
  'absent',
  'expired',
  'corrupt',
  'unreadable',
  'not-a-file',
  'oversized',
  'incompatible-version',
  'clock-unavailable',
  'no-store',
  'load-failed',
]);

const MESSAGE_TEXT_LIMIT = 200;
const MESSAGE_KIND_LIMIT = 32;
const CURSOR_PATTERN = /^presence-web:([0-9a-f]{12}):(\d{1,15})$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受有限毫秒数 / Date / 可解析的时间字符串；其余一律 null。 */
function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.trunc(ms) : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text.length > 64) return null;
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function isoFromMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(Math.trunc(value)).toISOString();
}

/**
 * ECMAScript Date 能表示的最大毫秒偏移（±8.64e15，即 ±275760 年）。
 * 超出这个范围的值 `new Date(ms).toISOString()` 会抛 RangeError——状态机在
 * 事件/结果里都会做这个转换，所以这种值必须在入口就被挡住：
 * 它不只是「时间很大」，还会把状态机的单调时钟锚点写成一个不可表示的数，
 * 之后每一次 tick 都会继续抛错，整个实例就废了。
 */
const MAX_REPRESENTABLE_MS = 8.64e15;

/** 这个毫秒数能不能被 Date 表示（toISOString 不会抛）。 */
function isRepresentableMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_REPRESENTABLE_MS;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/**
 * 输入窄化：只保留 kind + 可选 at + 该 kind 自己的布尔量。
 *
 * 两类「多余」字段的处置刻意不同：
 *   - 内容类字段（text / title / url / clipboard / path / userId …）**静默丢弃**，
 *     这是内容盲的落点：宿主多塞什么都到不了状态机、队列或状态文件；
 *   - 另一个 kind 的布尔量（例如 kind:'activity' 却给了 alive）**拒收**，
 *     因为那几乎一定是调用方的语义错误，静默丢弃会悄悄改变行为。
 *
 * @returns {{signal:{kind:string,at?:number,[flag:string]:unknown}}|{error:string}}
 */
function narrowSignal(signal) {
  if (!isPlainObject(signal)) return { error: PRESENCE_WEB_RESULT_STATUSES.INVALID_SIGNAL };
  const kind = typeof signal.kind === 'string' ? signal.kind : '';
  if (!SIGNAL_KINDS.includes(kind)) return { error: PRESENCE_WEB_RESULT_STATUSES.INVALID_KIND };

  const flagName = PRESENCE_WEB_SIGNAL_FLAGS[kind];
  for (const otherKind of SIGNAL_KINDS) {
    if (otherKind === kind) continue;
    if (Object.prototype.hasOwnProperty.call(signal, PRESENCE_WEB_SIGNAL_FLAGS[otherKind])) {
      return { error: PRESENCE_WEB_RESULT_STATUSES.KIND_FLAG_MISMATCH };
    }
  }

  let flag = true;
  if (Object.prototype.hasOwnProperty.call(signal, flagName)) {
    if (typeof signal[flagName] !== 'boolean') return { error: PRESENCE_WEB_RESULT_STATUSES.INVALID_FLAG };
    flag = signal[flagName];
  }

  const narrowed = { kind };
  // 时间**不在这里**校验：observe/settle 共用 resolveExternalTime 一个入口，
  // 保证「显式 at」和「注入时钟」走同一套可表示性判断。这里只搬运原值。
  const rawAt = signal.at;
  if (rawAt !== undefined && rawAt !== null) narrowed.at = rawAt;
  narrowed[flagName] = flag;
  return { signal: narrowed };
}

/** 事件只按稳定字段投影，避免状态机以后新增的字段被顺手带出这一层。 */
function projectEvent(event) {
  const projected = {
    id: typeof event?.id === 'string' ? event.id : '',
    type: typeof event?.type === 'string' ? event.type : '',
    at: typeof event?.at === 'string' ? event.at : null,
    state: typeof event?.state === 'string' ? event.state : '',
    previousState: typeof event?.previousState === 'string' ? event.previousState : '',
    reason: typeof event?.reason === 'string' ? event.reason : '',
    sequence: Number.isFinite(Number(event?.sequence)) ? Math.trunc(Number(event.sequence)) : 0,
  };
  if (Number.isFinite(Number(event?.inactiveMs))) {
    projected.inactiveMs = Math.max(0, Math.trunc(Number(event.inactiveMs)));
  }
  return projected;
}

function copyDiagnostics(list) {
  return list.map((entry) => ({ ...entry }));
}

/**
 * 装配 Web 在场宿主入口。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled]  必须显式为 true 才工作（缺省关闭）
 * @param {object} [options.settings]  在场阈值：idleMs / awayMs / returnAfterMs / workAfterMs / cooldownMs
 * @param {object} [options.store]     PresenceStateStore 形状的 store（load / save / clear）；
 *   注入了就优先用它。clear 是禁用承诺的一部分，缺了直接 TypeError（fail-closed）。
 * @param {string} [options.stateFile] 没有注入 store 时用它自建 PresenceStateStore（建议 data/presence-web-state.json）
 * @param {() => number|Date} [options.now] 时钟注入（测试/宿主统一时间源）
 * @param {(event:object)=>void} [options.journal] 结构化 journal（只有 kind/at/count，绝不含正文）
 * @param {number} [options.maxMessages] 排队提示上限（默认 32）
 * @returns {object} 控制面：enabled / status / state / stateFile / restored / pending /
 *   diagnostics / observe / settle / messages / clearMessages / setEnabled / close / stats
 *
 * @example
 *   const presence = createPresenceWebHost({
 *     enabled: cfg.presence?.enabled === true,
 *     settings: cfg.presence,
 *     stateFile: 'data/presence-web-state.json',
 *   });
 *   presence.observe({ kind: 'activity', at: Date.now() });   // 页面收到信号时
 *   presence.settle(Date.now());                              // 宿主自己的节拍
 *   const { cursor, messages } = presence.messages(lastCursor);
 */
export function createPresenceWebHost({
  enabled = false,
  settings = null,
  store = null,
  stateFile = '',
  now = () => Date.now(),
  journal = null,
  maxMessages = PRESENCE_WEB_DEFAULT_MAX_MESSAGES,
} = {}) {
  const thresholds = isPlainObject(settings) ? settings : {};
  const clock = typeof now === 'function' ? now : () => Date.now();
  const limit = positiveInt(maxMessages, PRESENCE_WEB_DEFAULT_MAX_MESSAGES);
  if (journal !== null && journal !== undefined && typeof journal !== 'function') {
    throw new TypeError('createPresenceWebHost: journal must be a function or null');
  }
  if (store !== null && store !== undefined && (
    typeof store.load !== 'function'
    || typeof store.save !== 'function'
    || typeof store.clear !== 'function'
  )) {
    // 禁用要能删掉状态文件；没有 clear 就没法兑现「禁用不残留旧状态」，直接拒收。
    throw new TypeError('createPresenceWebHost: store must provide load(), save() and clear()');
  }

  const injectedStore = store === undefined ? null : store;
  const configuredFile = typeof stateFile === 'string' ? stateFile.trim() : '';

  const diagnostics = [];
  const counters = {
    steps: 0,
    observes: 0,
    settles: 0,
    intents: 0,
    queued: 0,
    droppedOldest: 0,
    purged: 0,
    rejected: 0,
    saveFailures: 0,
  };

  let status = enabled === true ? PRESENCE_WEB_STATUSES.READY : PRESENCE_WEB_STATUSES.DISABLED;
  let closed = false;
  let runtime = null;
  let policy = null;
  let session = null;
  let storeInstance = null;
  let restored = false;
  // 上一次禁用有没有把持久化状态清干净；没清干净时禁止再启用（fail-closed）。
  let clearPending = false;

  // 游标里的实例 id：重启/重新启用都会换一个，旧游标永远匹配不上 → 不回放旧提示。
  let epoch = randomBytes(6).toString('hex');
  const messages = { items: [], seq: 0 };

  const emit = (event) => {
    if (typeof journal !== 'function') return;
    try {
      journal(event);
    } catch {
      /* journal 抛错不能影响在场记账 */
    }
  };

  const pushDiagnostic = (code, detail) => {
    if (diagnostics.some((entry) => entry.code === code)) return;
    diagnostics.push(detail === undefined ? { code } : { code, detail });
  };

  const nowMs = () => {
    try {
      return toMs(clock());
    } catch {
      return null;
    }
  };

  const hostState = () => (runtime && typeof runtime.state === 'string' ? runtime.state : 'unknown');

  const ready = () => status === PRESENCE_WEB_STATUSES.READY && !closed && session !== null;

  const resolveStore = () => {
    if (injectedStore) return injectedStore;
    if (!configuredFile) return null;
    return new PresenceStateStore({ file: configuredFile, now: clock, maxAgeMs: PRESENCE_WEB_STATE_TTL_MS });
  };

  const arm = () => {
    diagnostics.length = 0;
    storeInstance = resolveStore();
    runtime = new PresenceRuntime({
      idleMs: thresholds.idleMs,
      awayMs: thresholds.awayMs,
      clock,
    });
    policy = new PresenceInteractionPolicy({
      now: clock,
      returnAfterMs: thresholds.returnAfterMs,
      workAfterMs: thresholds.workAfterMs,
      cooldownMs: thresholds.cooldownMs,
    });
    session = createPresenceSession({ runtime, policy, store: storeInstance, now: clock });
    if (!storeInstance) pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.IN_MEMORY);

    let outcome;
    try {
      outcome = session.restore();
    } catch {
      outcome = { ok: false, restored: false, diagnostics: [{ code: 'load-failed' }] };
    }
    restored = outcome?.restored === true;

    if (!restored) {
      const codes = Array.isArray(outcome?.diagnostics)
        ? outcome.diagnostics.map((entry) => (
          isPlainObject(entry) && typeof entry.code === 'string' ? entry.code : 'load-failed'
        ))
        : ['load-failed'];
      if (!codes.every((code) => FRESH_START_CODES.has(code))) {
        // 读盘失败：不启动、不覆盖证据，返回固定诊断码。
        status = PRESENCE_WEB_STATUSES.STATE_LOAD_FAILED;
        pushDiagnostic(
          PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_LOAD_FAILED,
          codes.find((code) => LOAD_DETAIL_CODES.has(code)) || 'load-failed',
        );
        runtime = null;
        policy = null;
        session = null;
        return status;
      }
      pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.FRESH_START);
    } else {
      pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.RESTORED);
    }

    status = PRESENCE_WEB_STATUSES.READY;
    return status;
  };

  /** 清空排队提示（禁用/关闭/宿主显式清理用）；返回丢掉多少条。 */
  const clearMessages = () => {
    const dropped = messages.items.length;
    messages.items.length = 0;
    counters.purged += dropped;
    return dropped;
  };

  /**
   * 清掉持久化状态。只有出现明确的 `{ ok: true }` 才算清干净：
   * 没有 store 时不需要清；`{ ok: false }` / 抛异常 / 认不出的返回一律算失败。
   * 失败不抛、不转发任何原始字段——调用方只拿到布尔量，诊断走固定码。
   */
  const attemptClear = () => {
    if (!storeInstance) return true;
    if (typeof storeInstance.clear !== 'function') return false;
    let result;
    try {
      result = storeInstance.clear();
    } catch {
      return false;
    }
    return isPlainObject(result) && result.ok === true;
  };

  const disarm = () => {
    const dropped = clearMessages();
    if (policy) policy.setEnabled(false);
    // 清理失败必须记下来：宿主要保持停用，且在重试成功前不许再启用。
    const cleared = attemptClear();
    clearPending = !cleared;
    runtime = null;
    policy = null;
    session = null;
    restored = false;
    status = PRESENCE_WEB_STATUSES.DISABLED;
    diagnostics.length = 0;
    pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.DISABLED);
    if (!cleared) pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_CLEAR_FAILED);
    emit({ type: 'presence-web-disabled', dropped, cleared, at: isoFromMs(nowMs()) });
    return { enabled: false, status, dropped, cleared };
  };

  const inert = (resultStatus) => ({
    ok: false,
    status: resultStatus ?? (closed ? PRESENCE_WEB_STATUSES.CLOSED : status),
    state: hostState(),
    events: [],
    messages: [],
    persisted: false,
    diagnostics: copyDiagnostics(diagnostics),
  });

  /**
   * 单拍被拒的统一失败契约：记一次拒绝，返回同一份形状——不交付提示、
   * 不假装落盘、不动实例。入口拒收（kind / 布尔量 / 时间）、会话抛错、
   * 以及上游结构化拒绝的兜底都走这里，保证三条路对外长得一样。
   *
   * @param {string} resultStatus 固定失败码（或上游给的 reason）
   * @param {object[]} [events] 上游已经产生的结构化事件（默认空）
   */
  const rejectStep = (resultStatus, events = []) => {
    counters.rejected += 1;
    return {
      ok: false,
      status: resultStatus,
      state: hostState(),
      events,
      messages: [],
      persisted: false,
      diagnostics: copyDiagnostics(diagnostics),
    };
  };

  const enqueue = (intent, atMs) => {
    if (!isPlainObject(intent)) return null;
    if (typeof intent.id !== 'string' || !intent.id) return null;
    counters.intents += 1;

    messages.seq += 1;
    const message = {
      seq: messages.seq,
      id: 'presence-web-msg:' + epoch + ':' + messages.seq,
      kind: typeof intent.kind === 'string' ? intent.kind.slice(0, MESSAGE_KIND_LIMIT) : '',
      text: typeof intent.text === 'string' ? intent.text.slice(0, MESSAGE_TEXT_LIMIT) : '',
      at: isoFromMs(intent.at) ?? isoFromMs(atMs) ?? null,
    };
    messages.items.push(message);
    counters.queued += 1;
    while (messages.items.length > limit) {
      messages.items.shift();
      counters.droppedOldest += 1;
    }
    // journal 只带 kind/at：文案是给页面的投递内容，不进日志。
    emit({ type: 'presence-web-intent', kind: message.kind, at: message.at });
    return { id: message.id, kind: message.kind, text: message.text, at: message.at };
  };

  /**
   * 一拍：session 前进（observe 或 settle）→ 检查落盘 → 把 intent 放进队列。
   * 落盘失败时这一拍的 intent 一律不交付（fail-closed）。
   */
  const step = (mode, narrowed, atMs) => {
    if (!ready()) return inert();
    const failuresBefore = session.stats.saveFailures;

    let outcome;
    try {
      outcome = mode === 'observe'
        ? session.observe(narrowed)
        : session.settle({ at: atMs === null ? undefined : atMs });
    } catch {
      return rejectStep(PRESENCE_WEB_RESULT_STATUSES.SESSION_ERROR);
    }

    counters.steps += 1;
    if (mode === 'observe') counters.observes += 1;
    else counters.settles += 1;

    const events = Array.isArray(outcome?.events) ? outcome.events.map(projectEvent) : [];

    if (session.stats.saveFailures > failuresBefore) {
      counters.saveFailures += 1;
      pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_SAVE_FAILED);
      emit({ type: 'presence-web-state-save-failed', at: isoFromMs(nowMs()) });
      return {
        ok: false,
        status: PRESENCE_WEB_RESULT_STATUSES.STATE_SAVE_FAILED,
        state: hostState(),
        events,
        messages: [],
        persisted: false,
        diagnostics: copyDiagnostics(diagnostics),
      };
    }

    if (outcome?.ok !== true) {
      // 兜底：上游自己给出结构化拒绝（入口已挡住可表示性，正常输入到不了这里，
      // 留着防上游回归）。如实交回它的 reason，绝不改写成成功。
      return rejectStep(
        typeof outcome?.reason === 'string' && outcome.reason
          ? outcome.reason
          : PRESENCE_WEB_RESULT_STATUSES.REJECTED,
        events,
      );
    }

    const queued = [];
    for (const intent of Array.isArray(outcome.intents) ? outcome.intents : []) {
      const message = enqueue(intent, atMs);
      if (message) queued.push(message);
    }

    return {
      ok: true,
      status: PRESENCE_WEB_RESULT_STATUSES.OK,
      state: hostState(),
      events,
      messages: queued,
      persisted: outcome.persisted === true,
      diagnostics: [],
    };
  };

  /**
   * 外部时间的唯一入口（observe 与 settle 共用）。
   *
   * 显式 `at` 优先，缺省时用注入时钟；两条路都必须落到一个 **Date 能表示的
   * 毫秒数** 上。不可表示的值（超出 ±8.64e15）绝不能交给状态机：它会先在
   * `toISOString()` 上抛错，把这一拍变成 runtime-error，同时把单调时钟锚点
   * 写坏——此后的每一次 tick 都会继续抛错。所以在入口就拒收。
   *
   * 失败只返回固定失败码，不改实例：不推进状态、不排队、不写盘。
   *
   * @returns {{atMs:number}|{error:string}}
   */
  const resolveExternalTime = (value) => {
    if (value !== undefined && value !== null) {
      const atMs = toMs(value);
      return atMs !== null && isRepresentableMs(atMs)
        ? { atMs }
        : { error: PRESENCE_WEB_RESULT_STATUSES.INVALID_AT };
    }
    const atMs = nowMs();
    return atMs !== null && isRepresentableMs(atMs)
      ? { atMs }
      : { error: PRESENCE_WEB_RESULT_STATUSES.CLOCK_UNAVAILABLE };
  };

  /**
   * 收一个内容盲信号。`kind` 必须是 activity / focus / heartbeat；
   * 只认该 kind 自己的布尔量和一个可选时间戳，其余字段一律丢弃/拒收。
   */
  const observe = (signal) => {
    if (!ready()) return inert();
    const narrowed = narrowSignal(signal);
    if (narrowed.error) return rejectStep(narrowed.error);
    const time = resolveExternalTime(narrowed.signal.at);
    if (time.error) return rejectStep(time.error);
    return step('observe', { ...narrowed.signal, at: time.atMs }, time.atMs);
  };

  /** 宿主自己的节拍：只结算阈值（不构成活动证据）。 */
  const settle = (input) => {
    if (!ready()) return inert();
    const raw = isPlainObject(input) ? input.at : input;
    const time = resolveExternalTime(raw);
    if (time.error) return rejectStep(time.error);
    // 时间由本层定死再交下去：会话不再自己去问时钟，只有一个时间来源。
    return step('settle', null, time.atMs);
  };

  const cursor = () => 'presence-web:' + epoch + ':' + messages.seq;

  const parseCursor = (value) => {
    if (typeof value !== 'string') return null;
    const match = CURSOR_PATTERN.exec(value.trim());
    if (!match || match[1] !== epoch) return null;
    return Number(match[2]);
  };

  /**
   * 按游标读取排队提示（只读、不消费、幂等）。
   *   - 关闭之后恒为空：关闭的宿主不再交付待展示提示（§6 T6）；
   *   - 不传 after：只返回当前 cursor 与空数组（首次/刷新不回放）；
   *   - after 属于别的实例（重启/重新启用）、格式未知、超前、已被有界队列淘汰：
   *     同样返回当前 cursor 与空数组；
   *   - after 有效：返回之后的所有提示，cursor 精确指向最后一条。
   */
  const messagesSince = (after) => {
    const current = cursor();
    if (closed) return { cursor: current, messages: [] };
    if (after === null || after === undefined || after === '') return { cursor: current, messages: [] };
    const at = parseCursor(after);
    if (at === null || at > messages.seq) return { cursor: current, messages: [] };
    const oldest = messages.items.length ? messages.items[0].seq : messages.seq + 1;
    if (at + 1 < oldest) return { cursor: current, messages: [] };
    return {
      cursor: current,
      messages: messages.items
        .filter((item) => item.seq > at)
        .map(({ id, kind, text, at: atIso }) => ({ id, kind, text, at: atIso })),
    };
  };

  const setEnabled = (value) => {
    if (closed) return { enabled: false, status: PRESENCE_WEB_STATUSES.CLOSED, dropped: 0, cleared: false };
    if (value === true) {
      if (ready()) return { enabled: true, status, dropped: 0, cleared: true, alreadyEnabled: true };
      // 上一次禁用没清干净：先重试清理，成功了才允许启用。失败就一直停在
      // disabled —— 绝不把旧状态文件当成「干净启动」来 restore。
      if (clearPending) {
        if (!attemptClear()) {
          pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_CLEAR_FAILED);
          return { enabled: false, status: PRESENCE_WEB_STATUSES.DISABLED, dropped: 0, cleared: false };
        }
        clearPending = false;
      }
      epoch = randomBytes(6).toString('hex');
      arm();
      return { enabled: ready(), status, dropped: 0, cleared: true };
    }
    return disarm();
  };

  /**
   * 关停：落盘（保留冷却，供重启判断「刚说过」）+ 清内存提示（§6 T6）。
   * 关闭之后不再向宿主返回待展示提示。
   */
  const close = () => {
    if (closed) {
      return { ok: true, persisted: false, alreadyClosed: true, dropped: 0 };
    }
    closed = true;
    const previous = status;
    status = PRESENCE_WEB_STATUSES.CLOSED;
    const dropped = clearMessages();
    if (!session) {
      return { ok: true, persisted: false, alreadyClosed: false, previousStatus: previous, dropped };
    }
    let saved;
    try {
      saved = session.close();
    } catch {
      saved = { ok: false, persisted: false };
    }
    return {
      ok: saved?.ok === true,
      persisted: saved?.persisted === true,
      alreadyClosed: false,
      previousStatus: previous,
      dropped,
    };
  };

  // 构造即开启：显式 enabled:true 才 arm()，否则完全不建状态机。
  if (status === PRESENCE_WEB_STATUSES.READY) {
    arm();
  } else {
    pushDiagnostic(PRESENCE_WEB_DIAGNOSTIC_CODES.DISABLED);
  }

  return {
    get enabled() {
      return ready();
    },
    get status() {
      return status;
    },
    get closed() {
      return closed;
    },
    /** 幂等只读：状态机状态，未开启/已关闭时是 unknown。 */
    get state() {
      return hostState();
    },
    /** 生效的状态文件（没有持久化时是 null）。 */
    get stateFile() {
      return storeInstance && typeof storeInstance.file === 'string' ? storeInstance.file : null;
    },
    /** 本次启动是否真的从存档恢复（false = 干净启动或无存档）。 */
    get restored() {
      return restored;
    },
    get pending() {
      return messages.items.length;
    },
    get cursor() {
      return cursor();
    },
    get diagnostics() {
      return copyDiagnostics(diagnostics);
    },
    get stats() {
      return {
        enabled: ready(),
        closed,
        status,
        state: hostState(),
        restored,
        clearPending,
        pending: messages.items.length,
        maxMessages: limit,
        stateFile: storeInstance && typeof storeInstance.file === 'string' ? storeInstance.file : null,
        counters: { ...counters },
        thresholds: {
          idleMs: runtime ? runtime.idleMs : null,
          awayMs: runtime ? runtime.awayMs : null,
          cooldownMs: session ? session.cooldownMs : null,
        },
        session: session ? session.stats : null,
        diagnostics: copyDiagnostics(diagnostics),
      };
    },
    observe,
    settle,
    messages: messagesSince,
    clearMessages,
    setEnabled,
    close,
  };
}

export default createPresenceWebHost;
