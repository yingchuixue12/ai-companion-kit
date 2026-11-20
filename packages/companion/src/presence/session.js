/**
 * 在场会话 · presence session
 * ─────────────────────────────────────────────────────────────
 * 契约位置：docs/flandre-execution-plan.md §4.3（T3）；docs/flandre-decisions.md C-P3/C-P4。
 *
 * 这是「状态机 + 互动策略 + 状态文件」之间的深模块接缝：
 *
 *   1. 把宿主的一次信号（有活动 / 窗口获得焦点 / 心跳）路由进 PresenceRuntime；
 *   2. 取走状态机产生的事件，交给 PresenceInteractionPolicy 得到 intent；
 *   3. 在**自己这里**再套一层可持久化的冷却闸门（欢迎 / 休息提醒 / 主动消息），
 *      因为现有 runtime/policy 都没有 serialize——重启后 policy 的
 *      lastWelcomeAt 会归零，只有这一层能把「刚欢迎过」的事实带过重启；
 *   4. 维护会话锚点（sessionStartedAt）、累计在场时长（activeMs）、
 *      已结算 intent 台账（deliveredIds），并原子写进调用方给的 store。
 *
 * ── 重启语义（保守）────────────────────────────────────────
 *   createPresenceSession() 只构造，不读盘；
 *   restore() 是**显式**恢复：读回冷却/会话/台账，并把「有真实活动时间戳」的
 *   状态交还状态机（缺活动时间的状态退回 unknown，不凭空说「她还在」）。
 *   restore() 不产生任何 intent，也不重放旧事件——重启不补欢迎、不补提醒。
 *
 * ── 内容盲 ─────────────────────────────────────────────────
 *   这里能看到的只有：状态名、时间戳、事件 id/type、intent 的 id/kind/text。
 *   intent.text 是策略生成的短兜底文案，只用于交给发送方；它不进快照
 *   （snapshot() 完全不含 text 字段），因此不会落盘。
 *   状态机/policy 抛错不会污染状态：隔离后结构化返回。
 *
 * ── 不做什么 ───────────────────────────────────────────────
 *   不装定时器、不发网络、不 import server.js/qq.js；发送由注入的 sendText 完成
 *   （见 qq-adapter.js）。store 缺省时全部退化为纯内存，行为与旧路径一致。
 */
import {
  PRESENCE_STATE_VERSION,
  formatPresenceLedgerEntry,
  isPresenceDeliveredEntry,
  parsePresenceLedgerEntry,
  presenceLocalDayKey,
} from './persistence.js';

export const PRESENCE_SESSION_VERSION = 1;

const DEFAULT_COOLDOWN_MS = 90 * 60 * 1000;
const DEFAULT_MAX_LEDGER_ENTRIES = 128;
const DEFAULT_MAX_SEEN_INTENTS = 128;

/** intent kind → 冷却表里的键。未知 kind 不闸门，只去重。 */
const INTENT_COOLDOWN_KEY = Object.freeze({
  'welcome-back': 'welcome',
  'break-reminder': 'break',
});

const SIGNAL_KINDS = Object.freeze(['activity', 'focus', 'heartbeat']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function nonNegativeInt(value) {
  const ms = toMs(value);
  return ms === null || ms < 0 ? 0 : ms;
}

function normalizeIntents(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return [value];
  return [];
}

function copyCooldowns(source) {
  const cooldowns = { welcome: null, break: null, proactive: null };
  if (!isPlainObject(source)) return cooldowns;
  for (const key of Object.keys(cooldowns)) {
    const value = source[key];
    cooldowns[key] = value === null || value === undefined ? null : nonNegativeInt(value);
  }
  return cooldowns;
}

/**
 * Presence session。
 *
 * @example
 *   const store = new PresenceStateStore({ file: 'data/presence-web-state.json' });
 *   const session = createPresenceSession({ runtime, policy, store });
 *   session.restore();                                  // 显式恢复（不产生 intent）
 *   session.observe({ kind: 'activity', at: Date.now() }); // → { state, intents }
 *   session.settle({ at: now + 6 * 60_000 });            // → { state, intents }
 *   session.close();                                     // 关前落盘
 */
export function createPresenceSession({
  runtime,
  policy = null,
  store = null,
  now = () => Date.now(),
  cooldownMs,
  maxLedgerEntries = DEFAULT_MAX_LEDGER_ENTRIES,
  maxSeenIntents = DEFAULT_MAX_SEEN_INTENTS,
  persistOnChange = true,
} = {}) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('createPresenceSession: runtime is required');
  }
  if (typeof runtime.observeActivity !== 'function' || typeof runtime.tick !== 'function') {
    throw new TypeError('createPresenceSession: runtime must provide observeActivity() and tick()');
  }
  if (policy !== null && policy !== undefined && typeof policy.evaluate !== 'function') {
    throw new TypeError('createPresenceSession: policy must provide evaluate() or be null');
  }
  if (store !== null && store !== undefined && (typeof store.save !== 'function' || typeof store.load !== 'function')) {
    throw new TypeError('createPresenceSession: store must provide load() and save()');
  }

  const clock = typeof now === 'function' ? now : () => Date.now();
  const policyCooldown = Number(policy?.options?.cooldownMs);
  const gateCooldownMs = Number.isFinite(Number(cooldownMs))
    ? Math.max(0, Math.trunc(Number(cooldownMs)))
    : (Number.isFinite(policyCooldown) && policyCooldown >= 0 ? Math.trunc(policyCooldown) : DEFAULT_COOLDOWN_MS);
  const ledgerLimit = Number.isFinite(Number(maxLedgerEntries)) && Number(maxLedgerEntries) > 0
    ? Math.trunc(Number(maxLedgerEntries))
    : DEFAULT_MAX_LEDGER_ENTRIES;
  const seenLimit = Number.isFinite(Number(maxSeenIntents)) && Number(maxSeenIntents) > 0
    ? Math.trunc(Number(maxSeenIntents))
    : DEFAULT_MAX_SEEN_INTENTS;

  let sessionStartedAt = null;
  let activeMs = 0;
  let cooldowns = { welcome: null, break: null, proactive: null };
  let deliveredIds = [];
  let lastAt = null;
  let previousState = typeof runtime.state === 'string' ? runtime.state : 'unknown';
  let dirty = false;
  let restored = false;
  // 恢复后的第一拍要跳过 activeMs 累计：停机时长不是在场时长。
  let skipDowntimeOnce = false;

  const seenIntentIds = new Set();
  const counters = {
    observed: 0,
    settled: 0,
    rejected: 0,
    rawIntents: 0,
    emittedIntents: 0,
    suppressedIntents: 0,
    saves: 0,
    saveFailures: 0,
    restoredDowntimeSkips: 0,
  };

  const markDirty = () => { dirty = true; };

  const nowMs = () => {
    try {
      return toMs(clock());
    } catch {
      return null;
    }
  };

  const buildSnapshot = (atMs = null) => ({
    version: PRESENCE_STATE_VERSION,
    state: typeof runtime.state === 'string' ? runtime.state : 'unknown',
    updatedAt: atMs === null ? 0 : atMs,
    sessionStartedAt: sessionStartedAt === null ? null : sessionStartedAt,
    activeMs: Math.max(0, Math.trunc(activeMs)),
    cooldowns: { ...cooldowns },
    deliveredIds: deliveredIds.slice(),
  });

  const persist = () => {
    if (!store) return { ok: false, persisted: false, error: 'no-store' };
    const atMs = nowMs();
    if (atMs === null) return { ok: false, persisted: false, error: 'clock-unavailable' };
    const result = store.save(buildSnapshot(atMs));
    if (result && result.ok) {
      counters.saves += 1;
    } else {
      counters.saveFailures += 1;
    }
    return result;
  };

  const persistIfDirty = () => {
    if (!persistOnChange || !dirty) return { ok: true, persisted: false };
    dirty = false;
    return persist();
  };

  const hasSettled = (id) => {
    if (typeof id !== 'string' || !id) return false;
    return deliveredIds.some((entry) => {
      const parsed = parsePresenceLedgerEntry(entry);
      return Boolean(parsed) && parsed.id === id;
    });
  };

  const deliveredOn = (atMs) => {
    // 口径：消耗「主动消息每日限额」的条数（sent + accepted）。
    // accepted 只是平台受理、不是确认送达，所以这里只用于防刷屏，不当作投递成功证据。
    const dayKey = presenceLocalDayKey(atMs);
    if (!dayKey) return 0;
    let count = 0;
    for (const entry of deliveredIds) {
      if (!isPresenceDeliveredEntry(entry)) continue;
      const parsed = parsePresenceLedgerEntry(entry);
      if (parsed && parsed.dayKey === dayKey) count += 1;
    }
    return count;
  };

  /**
   * 写一条结算记录（也用于发送前的 attempting 写前日志）。
   * 返回值带 persisted：调用方可以据此 fail-closed —— 写不进盘就不要发。
   */
  const recordDelivery = ({ id, status = 'sent', at } = {}) => {
    const atMs = at === undefined || at === null ? nowMs() : toMs(at);
    if (atMs === null) return { ok: false, reason: 'clock-unavailable', persisted: false, hasStore: Boolean(store) };
    const entry = formatPresenceLedgerEntry({ dayKey: presenceLocalDayKey(atMs), status, id });
    if (!entry) return { ok: false, reason: 'invalid-entry', persisted: false, hasStore: Boolean(store) };
    if (deliveredIds.includes(entry)) {
      return { ok: true, duplicate: true, persisted: true, hasStore: Boolean(store) };
    }

    // 同一个 id 只保留一条结算记录：新的判定覆盖旧判定（例如 attempting → sent），
    // 避免重复计数；但替换时刻意保留「曾经尝试过」的事实，重启不会盲发。
    deliveredIds = deliveredIds.filter((existing) => {
      const parsed = parsePresenceLedgerEntry(existing);
      return !parsed || parsed.id !== id;
    });
    deliveredIds.push(entry);
    while (deliveredIds.length > ledgerLimit) deliveredIds.shift();
    markDirty();
    const saved = persistIfDirty();
    return {
      ok: true,
      duplicate: false,
      persisted: saved.persisted === true,
      hasStore: Boolean(store),
      ...(saved.error ? { error: saved.error } : {}),
    };
  };

  const markProactive = (atMs) => {
    const value = atMs === undefined || atMs === null ? nowMs() : toMs(atMs);
    if (value === null) return { ok: false, reason: 'clock-unavailable' };
    cooldowns = { ...cooldowns, proactive: value };
    markDirty();
    persistIfDirty();
    return { ok: true };
  };

  const rememberIntent = (id) => {
    if (typeof id !== 'string' || !id) return;
    seenIntentIds.add(id);
    while (seenIntentIds.size > seenLimit) {
      const oldest = seenIntentIds.values().next().value;
      seenIntentIds.delete(oldest);
    }
  };

  /** 冷却闸门：把已经在冷却里的 intent 扣下来，保证重启后不重复欢迎。 */
  const gateIntent = (intent, atMs) => {
    if (!isPlainObject(intent)) return { suppressed: 'invalid-intent' };
    const kind = typeof intent.kind === 'string' ? intent.kind : '';
    const id = typeof intent.id === 'string' ? intent.id : '';
    if (!id) return { suppressed: 'invalid-intent' };
    if (seenIntentIds.has(id) || hasSettled(id)) return { suppressed: 'duplicate' };
    const key = INTENT_COOLDOWN_KEY[kind];
    if (key && atMs !== null && gateCooldownMs > 0) {
      const last = cooldowns[key];
      if (last !== null && atMs >= last && atMs - last < gateCooldownMs) {
        return { suppressed: 'cooldown' };
      }
    }
    if (key) cooldowns = { ...cooldowns, [key]: atMs === null ? null : atMs };
    rememberIntent(id);
    return { intent: { id, kind, text: typeof intent.text === 'string' ? intent.text : '', at: atMs === null ? null : atMs } };
  };

  const applyRuntimeState = (atMs) => {
    const state = typeof runtime.state === 'string' ? runtime.state : 'unknown';
    if (state !== previousState) markDirty();
    if (state === 'present') {
      if (sessionStartedAt === null) sessionStartedAt = atMs;
      else if (previousState === 'away') sessionStartedAt = atMs;
    } else if (state === 'away' || state === 'unknown') {
      sessionStartedAt = null;
      activeMs = 0;
    }
    previousState = state;
    return state;
  };

  /**
   * 统一的一轮：路由信号（可选）→ 取事件 → policy → 冷却闸门 → 记账 → 落盘。
   * @returns {{ok:boolean, reason?:string, state:string, events:object[], intents:object[], persisted:boolean}}
   */
  const step = ({ signal = null, atMs = null, mode }) => {
    let events = [];
    try {
      if (signal) {
        const payload = atMs === null ? {} : { at: atMs };
        if (signal.kind === 'activity') {
          runtime.observeActivity({ ...payload, active: signal.active !== false });
        } else if (signal.kind === 'focus') {
          runtime.observeWindowFocus({ ...payload, focused: signal.focused !== false });
        } else {
          runtime.observeHeartbeat({ ...payload, alive: signal.alive !== false });
        }
      } else {
        runtime.tick(atMs === null ? undefined : { at: atMs });
      }

      if (typeof runtime.consumeEvents === 'function') {
        const consumed = runtime.consumeEvents();
        events = Array.isArray(consumed) ? consumed : [];
      } else if (typeof runtime.peekEvents === 'function') {
        const peeked = runtime.peekEvents();
        events = Array.isArray(peeked) ? peeked : [];
      }
    } catch {
      counters.rejected += 1;
      return { ok: false, reason: 'runtime-error', state: typeof runtime.state === 'string' ? runtime.state : 'unknown', events: [], intents: [], persisted: false };
    }

    const stateBefore = previousState;
    const state = applyRuntimeState(atMs);
    // 会话累计在场时长用本模块自己的口径：只在「连续 present 的两拍之间」累计，
    // 跨越 idle/away 的间隔不算工作，也不依赖 policy 内部的私有计数。
    //
    // restore() 之后的第一拍必须跳过：lastAt 是停机前的存档时间，直接相减会把
    // 整个停机时长算成「持续在场」。跳过一次后 lastAt 才落到当前时间，之后照常累计。
    if (skipDowntimeOnce) {
      skipDowntimeOnce = false;
      counters.restoredDowntimeSkips += 1;
    } else if (state === 'present' && stateBefore === 'present' && lastAt !== null && atMs !== null) {
      const delta = Math.max(0, atMs - lastAt);
      if (delta > 0) {
        activeMs += delta;
        markDirty();
      }
    }
    lastAt = atMs;

    const intents = [];
    if (policy) {
      let raw = [];
      try {
        raw = normalizeIntents(policy.evaluate({ state, events, at: atMs === null ? undefined : atMs }));
      } catch {
        counters.rejected += 1;
        raw = [];
      }
      for (const candidate of raw) {
        counters.rawIntents += 1;
        const gated = gateIntent(candidate, atMs);
        if (gated.intent) {
          intents.push(gated.intent);
          counters.emittedIntents += 1;
          markDirty();
        } else {
          counters.suppressedIntents += 1;
        }
      }
    }

    if (mode === 'observe') counters.observed += 1;
    else counters.settled += 1;

    const persisted = persistIfDirty().persisted === true;
    return { ok: true, state, events, intents, persisted };
  };

  const restore = () => {
    if (!store) {
      return { ok: false, restored: false, state: typeof runtime.state === 'string' ? runtime.state : 'unknown', diagnostics: [{ code: 'no-store' }] };
    }
    const loaded = store.load();
    if (!loaded || loaded.ok !== true || !loaded.state) {
      return {
        ok: false,
        restored: false,
        state: typeof runtime.state === 'string' ? runtime.state : 'unknown',
        diagnostics: Array.isArray(loaded?.diagnostics) ? loaded.diagnostics : [{ code: 'load-failed' }],
      };
    }

    const state = loaded.state;
    sessionStartedAt = state.sessionStartedAt;
    activeMs = state.activeMs;
    cooldowns = copyCooldowns(state.cooldowns);
    deliveredIds = Array.isArray(state.deliveredIds) ? state.deliveredIds.slice() : [];
    lastAt = state.updatedAt;
    restored = true;
    // 存档时间只用于恢复冷却/台账；下一拍不能把「存档 → 现在」的停机时长算进在场。
    skipDowntimeOnce = true;

    const diagnostics = [];
    if (state.state !== 'unknown' && typeof runtime.restore === 'function') {
      const options = typeof runtime.options === 'object' && runtime.options !== null ? runtime.options : {};
      const snapshot = {
        kind: 'presence-snapshot',
        version: 1,
        state: state.state,
        stateSinceAt: new Date(state.updatedAt).toISOString(),
        lastActivityAt: new Date(state.updatedAt).toISOString(),
        config: {
          idleMs: Number(options.idleMs) || 0,
          awayMs: Number(options.awayMs) || 0,
        },
        counters: {},
        history: [],
        events: [],
      };
      try {
        const applied = runtime.restore(snapshot, { adoptConfig: false, replayEvents: false });
        if (applied && applied.accepted === false) diagnostics.push({ code: 'runtime-restore-rejected' });
      } catch {
        diagnostics.push({ code: 'runtime-restore-error' });
      }
    } else if (state.state !== 'unknown') {
      diagnostics.push({ code: 'no-runtime-restore' });
    }
    previousState = typeof runtime.state === 'string' ? runtime.state : 'unknown';
    return { ok: true, restored: true, state: previousState, diagnostics };
  };

  const observe = (signal) => {
    if (!isPlainObject(signal) || !SIGNAL_KINDS.includes(signal.kind)) {
      counters.rejected += 1;
      return { ok: false, reason: 'invalid-signal', state: typeof runtime.state === 'string' ? runtime.state : 'unknown', events: [], intents: [], persisted: false };
    }
    let atMs = null;
    if (signal.at !== undefined && signal.at !== null) {
      atMs = toMs(signal.at);
      if (atMs === null) {
        counters.rejected += 1;
        return { ok: false, reason: 'invalid-at', state: typeof runtime.state === 'string' ? runtime.state : 'unknown', events: [], intents: [], persisted: false };
      }
    }
    return step({ signal, atMs, mode: 'observe' });
  };

  const settle = ({ at } = {}) => {
    let atMs = null;
    if (at !== undefined && at !== null) {
      atMs = toMs(at);
      if (atMs === null) {
        counters.rejected += 1;
        return { ok: false, reason: 'invalid-at', state: typeof runtime.state === 'string' ? runtime.state : 'unknown', events: [], intents: [], persisted: false };
      }
    }
    return step({ signal: null, atMs, mode: 'settle' });
  };

  const close = () => {
    const result = persist();
    dirty = false;
    return { ok: result.ok === true, persisted: result.persisted === true, ...(result.error ? { error: result.error } : {}) };
  };

  return {
    observe,
    settle,
    snapshot: () => buildSnapshot(nowMs() ?? 0),
    restore,
    close,
    recordDelivery,
    hasSettled,
    deliveredOn,
    markProactive,
    get state() {
      return typeof runtime.state === 'string' ? runtime.state : 'unknown';
    },
    get cooldowns() {
      return { ...cooldowns };
    },
    get sessionStartedAt() {
      return sessionStartedAt;
    },
    get activeMs() {
      return Math.max(0, Math.trunc(activeMs));
    },
    get deliveredIds() {
      return deliveredIds.slice();
    },
    get cooldownMs() {
      return gateCooldownMs;
    },
    get restored() {
      return restored;
    },
    get hasStore() {
      return Boolean(store);
    },
    get stats() {
      return {
        ...counters,
        state: typeof runtime.state === 'string' ? runtime.state : 'unknown',
        activeMs: Math.max(0, Math.trunc(activeMs)),
        sessionStartedAt,
        cooldowns: { ...cooldowns },
        ledgerEntries: deliveredIds.length,
        restored,
        persistOnChange,
        cooldownMs: gateCooldownMs,
        hasStore: Boolean(store),
        hasPolicy: Boolean(policy),
      };
    },
  };
}

export default createPresenceSession;
