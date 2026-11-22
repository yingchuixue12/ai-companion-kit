/**
 * 本地在场状态机 · local presence monitor
 * ─────────────────────────────────────────────────────────────
 * 契约位置：docs/flandre-project-plan.md §4.1（平台事件）/ §4.2（会话上下文）。
 *
 * 「计算机是她的身体」的那一层很小：宿主能确定的只有「刚才有没有人在」。
 * 所以这个模块的输入永远只有两样东西——一个时间戳，和一个布尔量。
 * 它不知道消息内容、不知道窗口标题、不读键盘、不截图、不列文件、不联网；
 * 它只把「有人 / 没人 / 人回来了」整理成可序列化、可重放的本地状态。
 *
 * ── 状态 ────────────────────────────────────────────────────
 *   unknown   还没有任何活动观测（刚构造，或恢复的存档里没有活动记录）
 *   present   最近一次活动在 idleMs 以内
 *   idle      超过 idleMs 没有活动，但还没到 awayMs
 *   away      超过 awayMs 没有活动，或宿主显式报告自己离线
 *
 * ── 事件（由 consumeEvents() 取走，宿主自己投放到任何入口）─────
 *   presence.entered   unknown → present   本轮第一次活动
 *   presence.idle      present → idle      idle 阈值到期
 *   presence.away      present/idle → away away 阈值到期 / 宿主离线
 *   presence.returned  idle/away → present 人回来了
 *
 * 「没有先 idle/away 就没有 returned」是结构保证，不是 if 判断：
 * returned 只会从 idle / away 发出来；present 期间重复活动只更新时间戳。
 *
 * ── 时间 ────────────────────────────────────────────────────
 * 不装任何定时器。阈值只在宿主调用 tick(now) / observe* 的那一刻才结算，
 * 因此同一串输入在任何机器上都会得到同一串状态与事件。时钟可注入：
 *   new PresenceMonitor({ clock: () => myClock() })
 * 若注入时钟与输入时间戳互相矛盾（时间倒流），模块不抛错也不倒退状态：
 * 观测时间被钳到 lastSeenAt，并记入 clockSkewCount / maxClockSkewMs。
 *
 * ── 隐私 ────────────────────────────────────────────────────
 * snapshot() 里带 privacy 元数据，明确说明只存状态、时间戳、阈值、计数器，
 * 以及有界的历史与事件队列；不存任何活动内容（见 PRESENCE_PRIVACY）。
 * 模块没有任何 import，不依赖 node:fs / node:child_process / fetch。
 */

/** 可注入时钟的缺省值：只在宿主没有给 clock 时使用，不缓存结果。 */
const DEFAULT_CLOCK = () => Date.now();

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_AWAY_MS = 30 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 64;
const DEFAULT_MAX_HISTORY = 32;

const SNAPSHOT_KIND = 'presence-snapshot';
const SNAPSHOT_VERSION = 1;

export const PRESENCE_UNKNOWN = 'unknown';
export const PRESENCE_PRESENT = 'present';
export const PRESENCE_IDLE = 'idle';
export const PRESENCE_AWAY = 'away';

/** 四个状态，顺序即「有人在场 → 逐渐离开」的单调顺序。 */
export const PRESENCE_STATES = Object.freeze([
  PRESENCE_UNKNOWN,
  PRESENCE_PRESENT,
  PRESENCE_IDLE,
  PRESENCE_AWAY,
]);

const STATE_SET = new Set(PRESENCE_STATES);

/** 事件类型常量，宿主的 switch 直接用它，避免手写字符串。 */
export const PRESENCE_EVENT_TYPES = Object.freeze({
  ENTERED: 'presence.entered',
  IDLE: 'presence.idle',
  RETURNED: 'presence.returned',
  AWAY: 'presence.away',
});

export const PRESENCE_EVENT_TYPE_LIST = Object.freeze(Object.values(PRESENCE_EVENT_TYPES));

/** 安全默认值；thresholds 里的 awayMs 永远不小于 idleMs。 */
export const DEFAULT_PRESENCE_OPTIONS = Object.freeze({
  idleMs: DEFAULT_IDLE_MS,
  awayMs: DEFAULT_AWAY_MS,
  maxEvents: DEFAULT_MAX_EVENTS,
  maxHistory: DEFAULT_MAX_HISTORY,
});

/**
 * 隐私声明：随 snapshot().privacy 一起持久化，宿主可以原样展示给用户。
 * 「只存状态、不存内容」是这份契约里唯一需要长期守住的部分。
 */
export const PRESENCE_PRIVACY = Object.freeze({
  contentBlind: true,
  localOnly: true,
  network: false,
  timers: false,
  inputs: Object.freeze(['timestamp', 'boolean flag']),
  stores: Object.freeze([
    'presence state',
    'activity / heartbeat timestamps',
    'idle and away thresholds',
    'bounded transition history',
    'bounded pending event queue',
    'counters (skew, drops, rejections)',
  ]),
  neverStores: Object.freeze([
    'message text',
    'screenshots',
    'keystrokes',
    'window titles',
    'file names or paths',
    'urls',
    'clipboard contents',
    'process lists',
    'user identifiers',
  ]),
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 只接受「时间戳」这一种时间输入：
 * Date / 有限数字（毫秒）/ 可解析的时间字符串。
 * 其余（对象、布尔、NaN、Infinity、乱码字符串）一律当成无效输入。
 */
function toTimestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
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

function toIso(ms) {
  if (ms === null || ms === undefined) return null;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function boundedInt(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= min ? i : fallback;
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 阈值归一化：非法值回落安全默认；awayMs < idleMs 时抬到 idleMs。 */
function thresholdsFrom(source = {}) {
  const opts = isPlainObject(source) ? source : {};
  const idleMs = positiveMs(opts.idleMs, DEFAULT_IDLE_MS);
  const awayMs = Math.max(idleMs, positiveMs(opts.awayMs, DEFAULT_AWAY_MS));
  return { idleMs, awayMs };
}

function copyEvent(event) {
  const copy = {
    id: event.id,
    type: event.type,
    at: event.at,
    state: event.state,
    previousState: event.previousState,
    reason: event.reason,
    sequence: event.sequence,
  };
  if (event.inactiveMs !== undefined) copy.inactiveMs = event.inactiveMs;
  return copy;
}

function normalizeEvent(value) {
  if (!isPlainObject(value)) return null;
  if (!PRESENCE_EVENT_TYPE_LIST.includes(value.type)) return null;
  const at = toTimestamp(value.at);
  if (at === null) return null;
  const state = STATE_SET.has(value.state) ? value.state : null;
  const previousState = STATE_SET.has(value.previousState) ? value.previousState : null;
  if (!state || !previousState) return null;
  const sequence = nonNegativeInt(value.sequence);
  return {
    id: typeof value.id === 'string' && value.id ? value.id : 'presence:' + sequence,
    type: value.type,
    at: toIso(at),
    state,
    previousState,
    reason: typeof value.reason === 'string' ? value.reason : '',
    ...(Number.isFinite(Number(value.inactiveMs)) ? { inactiveMs: Math.max(0, Math.trunc(Number(value.inactiveMs))) } : {}),
    sequence,
  };
}

/**
 * 观测输入的归一化：只读 `at` 与少数几个布尔字段，其他键全部忽略。
 * 这是「内容盲」的落点——宿主不小心多塞了 text / title / url 也进不来。
 */
function parseObservation(input, flagName) {
  if (input === undefined || input === null) return { at: undefined, flags: {} };
  if (input instanceof Date || typeof input === 'number' || typeof input === 'string') {
    return { at: input, flags: {} };
  }
  if (typeof input === 'boolean') {
    if (!flagName) return { error: 'invalid-input' };
    return { at: undefined, flags: { [flagName]: input } };
  }
  if (!isPlainObject(input)) return { error: 'invalid-input' };
  return { at: input.at, flags: input };
}

function readFlag(flags, name, fallback) {
  if (!Object.prototype.hasOwnProperty.call(flags, name) || flags[name] === undefined) {
    return { value: fallback };
  }
  if (typeof flags[name] !== 'boolean') return { error: 'invalid-' + name };
  return { value: flags[name] };
}

/**
 * 存档归一化：接受对象或 JSON 字符串，字段缺失/损坏时降级而不是抛错。
 * 恢复出来的状态如果缺 lastActivityAt，就不能声称 present / idle / away，
 * 一律退回 unknown，避免重启后凭空捏造「她还在」。
 */
function normalizeSnapshot(input) {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(data)) return null;
  if (data.kind !== undefined && data.kind !== SNAPSHOT_KIND) return null;
  if (data.version !== undefined) {
    const version = Number(data.version);
    if (!Number.isFinite(version) || version < 1 || version > SNAPSHOT_VERSION) return null;
  }

  const config = thresholdsFrom(data.config);
  let state = STATE_SET.has(data.state) ? data.state : PRESENCE_UNKNOWN;
  const lastActivityAt = toTimestamp(data.lastActivityAt);
  if (state !== PRESENCE_UNKNOWN && lastActivityAt === null) state = PRESENCE_UNKNOWN;

  const stateSinceAt = toTimestamp(data.stateSinceAt) ?? lastActivityAt;
  const counters = isPlainObject(data.counters) ? data.counters : {};
  const history = Array.isArray(data.history) ? data.history.map(normalizeEvent).filter(Boolean) : [];
  const events = Array.isArray(data.events) ? data.events.map(normalizeEvent).filter(Boolean) : [];
  const hostAlive = typeof data.hostAlive === 'boolean' ? data.hostAlive : null;

  return {
    state,
    stateSinceAt,
    lastActivityAt,
    lastHeartbeatAt: toTimestamp(data.lastHeartbeatAt),
    hostAlive,
    config: {
      idleMs: config.idleMs,
      awayMs: config.awayMs,
      maxEvents: boundedInt(isPlainObject(data.config) ? data.config.maxEvents : null, DEFAULT_MAX_EVENTS, 1),
      maxHistory: boundedInt(isPlainObject(data.config) ? data.config.maxHistory : null, DEFAULT_MAX_HISTORY, 0),
    },
    counters: {
      sequence: nonNegativeInt(counters.sequence),
      droppedEvents: nonNegativeInt(counters.droppedEvents),
      droppedHistory: nonNegativeInt(counters.droppedHistory),
      clockSkewCount: nonNegativeInt(counters.clockSkewCount),
      maxClockSkewMs: nonNegativeInt(counters.maxClockSkewMs),
      rejectedObservations: nonNegativeInt(counters.rejectedObservations),
    },
    history,
    events,
  };
}

/**
 * PresenceMonitor · 纯内存、无依赖、无定时器的在场状态机。
 *
 * @example
 *   const presence = new PresenceMonitor({ idleMs: 3 * 60_000, awayMs: 20 * 60_000 });
 *   presence.observeActivity();                       // presence.entered
 *   presence.tick(Date.now() + 4 * 60_000);           // presence.idle
 *   presence.tick(Date.now() + 25 * 60_000);          // presence.away
 *   presence.observeActivity();                       // presence.returned
 *   for (const event of presence.consumeEvents()) host.emit(event.type, event);
 */
export class PresenceMonitor {
  #clock;
  #idleMs;
  #awayMs;
  #maxEvents;
  #maxHistory;

  #state = PRESENCE_UNKNOWN;
  #stateSinceAt = null;
  #lastActivityAt = null;
  #lastHeartbeatAt = null;
  #lastSeenAt = null;
  #hostAlive = null;

  #sequence = 0;
  #events = [];
  #history = [];
  #droppedEvents = 0;
  #droppedHistory = 0;
  #clockSkewCount = 0;
  #maxClockSkewMs = 0;
  #rejectedObservations = 0;

  /**
   * @param {object} [options]
   * @param {number} [options.idleMs]      present → idle 的静默阈值（默认 5 分钟）
   * @param {number} [options.awayMs]      → away 的静默阈值（默认 30 分钟，自动 ≥ idleMs）
   * @param {number} [options.maxEvents]   未消费事件队列上限（默认 64，丢最旧）
   * @param {number} [options.maxHistory]  转换历史上限（默认 32，丢最旧）
   * @param {() => number|Date} [options.clock] 时钟注入，缺省 Date.now
   */
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    this.#clock = typeof opts.clock === 'function' ? opts.clock : DEFAULT_CLOCK;
    const { idleMs, awayMs } = thresholdsFrom(opts);
    this.#idleMs = idleMs;
    this.#awayMs = awayMs;
    this.#maxEvents = boundedInt(opts.maxEvents, DEFAULT_MAX_EVENTS, 1);
    this.#maxHistory = boundedInt(opts.maxHistory, DEFAULT_MAX_HISTORY, 0);
  }

  /** @returns {'unknown'|'present'|'idle'|'away'} 当前状态 */
  get state() {
    return this.#state;
  }

  get stateSinceAt() {
    return toIso(this.#stateSinceAt);
  }

  get lastActivityAt() {
    return toIso(this.#lastActivityAt);
  }

  get lastHeartbeatAt() {
    return toIso(this.#lastHeartbeatAt);
  }

  /** @returns {boolean|null} null = 还没收到过心跳 */
  get hostAlive() {
    return this.#hostAlive;
  }

  get idleMs() {
    return this.#idleMs;
  }

  get awayMs() {
    return this.#awayMs;
  }

  get pendingEventCount() {
    return this.#events.length;
  }

  /** 只读的生效配置副本。 */
  get options() {
    return {
      idleMs: this.#idleMs,
      awayMs: this.#awayMs,
      maxEvents: this.#maxEvents,
      maxHistory: this.#maxHistory,
    };
  }

  /** 只读的隐私元数据副本（数组也复制，调用方改不动内部常量）。 */
  get privacy() {
    return {
      ...PRESENCE_PRIVACY,
      inputs: [...PRESENCE_PRIVACY.inputs],
      stores: [...PRESENCE_PRIVACY.stores],
      neverStores: [...PRESENCE_PRIVACY.neverStores],
    };
  }

  // ── 输入 ──────────────────────────────────────────────────

  /**
   * 有人在场的一次证据：用户发了消息、用了鼠标键盘、点了窗口……
   * 宿主只需告诉这里「刚刚有活动」，不要告诉任何内容。
   * `active: false` 表示「只报个时间，没有活动」，等价于 tick。
   */
  observeActivity(input) {
    return this.#observe(input, 'active', true, 'activity');
  }

  /**
   * 窗口焦点事件：获得焦点 = 有活动；失去焦点只结算阈值，不直接判离开
   * （切窗口很常见，不能当成离场）。
   */
  observeWindowFocus(input) {
    return this.#observe(input, 'focused', true, 'focus');
  }

  /**
   * 宿主的存活心跳：证明「身体」还在跑，但不是用户活动证据。
   * heartbeat(alive: true) 只刷新 lastHeartbeatAt / hostAlive；
   * heartbeat(alive: false) 表示宿主自己离线，此时直接判 away。
   */
  observeHeartbeat(input) {
    const parsed = parseObservation(input, 'alive');
    if (parsed.error) return this.#reject(parsed.error);
    const flag = readFlag(parsed.flags, 'alive', true);
    if (flag.error) return this.#reject(flag.error);
    const at = this.#resolveTime(parsed.at);
    if (at === null) return this.#reject('invalid-time');
    const now = this.#advance(at);

    this.#lastHeartbeatAt = now;
    this.#hostAlive = flag.value;
    const events = [];
    if (!flag.value) {
      const event = this.#become(PRESENCE_AWAY, now, PRESENCE_EVENT_TYPES.AWAY, 'host-offline');
      if (event) events.push(event);
    }
    return this.#result(events, now);
  }

  /** 显式结算阈值：宿主定时调用（例如每秒一次），模块自己不装定时器。 */
  tick(input) {
    const parsed = parseObservation(input);
    if (parsed.error) return this.#reject(parsed.error);
    const at = this.#resolveTime(parsed.at);
    if (at === null) return this.#reject('invalid-time');
    const now = this.#advance(at);
    return this.#result(this.#evaluate(now), now);
  }

  // ── 输出 ──────────────────────────────────────────────────

  /**
   * 取走（并清空）待消费事件。limit 缺省为全部。
   * @param {number} [limit]
   * @returns {object[]} 结构化事件副本，可直接 JSON.stringify
   */
  consumeEvents(limit) {
    const size = this.#events.length;
    let count = size;
    if (limit !== undefined && limit !== null) {
      const n = Number(limit);
      if (Number.isFinite(n) && n >= 0) count = Math.min(size, Math.trunc(n));
    }
    return this.#events.splice(0, count).map(copyEvent);
  }

  /** 只看不取。 */
  peekEvents() {
    return this.#events.map(copyEvent);
  }

  /** 有界的转换历史（最新在最后），用于宿主日志或调试。 */
  get history() {
    return this.#history.map(copyEvent);
  }

  /** 计数器快照，全部是数字，没有内容。 */
  get stats() {
    return {
      sequence: this.#sequence,
      pendingEvents: this.#events.length,
      droppedEvents: this.#droppedEvents,
      droppedHistory: this.#droppedHistory,
      clockSkewCount: this.#clockSkewCount,
      maxClockSkewMs: this.#maxClockSkewMs,
      rejectedObservations: this.#rejectedObservations,
    };
  }

  // ── 存档 ──────────────────────────────────────────────────

  /**
   * 可序列化快照：全部字段是 string / number / boolean / null / 数组。
   * @param {{ includeEvents?: boolean }} [options] includeEvents=false 可只存状态
   */
  snapshot(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    return {
      kind: SNAPSHOT_KIND,
      version: SNAPSHOT_VERSION,
      state: this.#state,
      stateSinceAt: toIso(this.#stateSinceAt),
      lastActivityAt: toIso(this.#lastActivityAt),
      lastHeartbeatAt: toIso(this.#lastHeartbeatAt),
      lastSeenAt: toIso(this.#lastSeenAt),
      hostAlive: this.#hostAlive,
      config: this.options,
      counters: this.stats,
      history: this.#history.map(copyEvent),
      events: opts.includeEvents === false ? [] : this.#events.map(copyEvent),
      privacy: this.privacy,
    };
  }

  toJSON() {
    return this.snapshot();
  }

  /**
   * 进程重启后恢复：
   * - 缺少活动时间的状态一律退回 unknown（不凭空恢复「在场」）；
   * - 未消费事件默认不重放，避免重启后重复发出同一条 returned；
   * - 时间基准重新起算（lastSeenAt 清空），注入时钟比存档靠前时不会永久卡死。
   *
   * @param {object|string} snapshot
   * @param {{ adoptConfig?: boolean, replayEvents?: boolean }} [options]
   */
  restore(snapshot, options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const data = normalizeSnapshot(snapshot);
    if (!data) return this.#reject('invalid-snapshot');

    const previousState = this.#state;
    if (opts.adoptConfig === true) {
      this.#idleMs = data.config.idleMs;
      this.#awayMs = data.config.awayMs;
      this.#maxEvents = data.config.maxEvents;
      this.#maxHistory = data.config.maxHistory;
    }

    this.#state = data.state;
    this.#lastActivityAt = data.lastActivityAt;
    this.#stateSinceAt = data.stateSinceAt;
    this.#lastHeartbeatAt = data.lastHeartbeatAt;
    this.#hostAlive = data.hostAlive;
    this.#lastSeenAt = null;

    this.#sequence = Math.max(this.#sequence, data.counters.sequence);
    this.#droppedEvents = Math.max(this.#droppedEvents, data.counters.droppedEvents);
    this.#droppedHistory = Math.max(this.#droppedHistory, data.counters.droppedHistory);
    this.#clockSkewCount = Math.max(this.#clockSkewCount, data.counters.clockSkewCount);
    this.#maxClockSkewMs = Math.max(this.#maxClockSkewMs, data.counters.maxClockSkewMs);
    this.#rejectedObservations = Math.max(this.#rejectedObservations, data.counters.rejectedObservations);

    this.#history = data.history.slice(-this.#maxHistory).map(copyEvent);
    this.#events = opts.replayEvents === true ? data.events.slice(-this.#maxEvents).map(copyEvent) : [];

    return {
      accepted: true,
      reason: '',
      state: this.#state,
      changed: previousState !== this.#state,
      events: [],
      restoredEvents: this.#events.length,
    };
  }

  /** 构造一个已恢复的监控器：存档里的阈值优先生效，options 可覆盖。 */
  static fromSnapshot(snapshot, options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const data = normalizeSnapshot(snapshot);
    if (!data) {
      const fallback = new PresenceMonitor(opts);
      fallback.restore(snapshot, opts);
      return fallback;
    }
    const monitor = new PresenceMonitor({ ...data.config, ...opts });
    monitor.restore(data, { ...opts, adoptConfig: false });
    return monitor;
  }

  /** 清空状态与计数器（配置保留），用于宿主下班/退出。 */
  reset() {
    this.#state = PRESENCE_UNKNOWN;
    this.#stateSinceAt = null;
    this.#lastActivityAt = null;
    this.#lastHeartbeatAt = null;
    this.#lastSeenAt = null;
    this.#hostAlive = null;
    this.#sequence = 0;
    this.#events = [];
    this.#history = [];
    this.#droppedEvents = 0;
    this.#droppedHistory = 0;
    this.#clockSkewCount = 0;
    this.#maxClockSkewMs = 0;
    this.#rejectedObservations = 0;
    return this;
  }

  // ── 内部 ──────────────────────────────────────────────────

  #observe(input, flagName, flagDefault, cause) {
    const parsed = parseObservation(input, flagName);
    if (parsed.error) return this.#reject(parsed.error);
    const flag = readFlag(parsed.flags, flagName, flagDefault);
    if (flag.error) return this.#reject(flag.error);
    const at = this.#resolveTime(parsed.at);
    if (at === null) return this.#reject('invalid-time');
    const now = this.#advance(at);

    if (!flag.value) return this.#result(this.#evaluate(now), now);
    return this.#result(this.#activity(now, cause), now);
  }

  #resolveTime(raw) {
    if (raw === undefined || raw === null) {
      let value;
      try {
        value = this.#clock();
      } catch {
        return null;
      }
      return toTimestamp(value);
    }
    return toTimestamp(raw);
  }

  /** 时间只能往前走：倒流被钳住并计数，绝不因此倒退状态。 */
  #advance(at) {
    let now = at;
    if (this.#lastSeenAt !== null && now < this.#lastSeenAt) {
      this.#clockSkewCount += 1;
      this.#maxClockSkewMs = Math.max(this.#maxClockSkewMs, this.#lastSeenAt - now);
      now = this.#lastSeenAt;
    }
    this.#lastSeenAt = now;

    if (this.#lastActivityAt !== null && this.#lastActivityAt > now) {
      // 常见于「存档来自更快的时钟」：把活动锚点拉回现在，阈值才继续算得动。
      this.#clockSkewCount += 1;
      this.#maxClockSkewMs = Math.max(this.#maxClockSkewMs, this.#lastActivityAt - now);
      this.#lastActivityAt = now;
      if (this.#stateSinceAt !== null && this.#stateSinceAt > now) this.#stateSinceAt = now;
    }
    return now;
  }

  /** 活动证据：present 期间重复活动不发事件，保证不重复 returned/entered。 */
  #activity(now, cause) {
    this.#lastActivityAt = now;
    const previousState = this.#state;
    if (previousState === PRESENCE_PRESENT) return [];
    if (previousState === PRESENCE_UNKNOWN) {
      const event = this.#become(PRESENCE_PRESENT, now, PRESENCE_EVENT_TYPES.ENTERED, cause);
      return event ? [event] : [];
    }
    const reason = previousState === PRESENCE_AWAY ? 'returned-from-away' : 'returned-from-idle';
    const event = this.#become(PRESENCE_PRESENT, now, PRESENCE_EVENT_TYPES.RETURNED, reason);
    return event ? [event] : [];
  }

  #evaluate(now) {
    if (this.#lastActivityAt === null) return [];
    if (this.#state === PRESENCE_AWAY || this.#state === PRESENCE_UNKNOWN) return [];
    const inactiveMs = Math.max(0, now - this.#lastActivityAt);
    if (inactiveMs >= this.#awayMs) {
      const event = this.#become(PRESENCE_AWAY, now, PRESENCE_EVENT_TYPES.AWAY, 'away-threshold', { inactiveMs });
      return event ? [event] : [];
    }
    if (this.#state === PRESENCE_PRESENT && inactiveMs >= this.#idleMs) {
      const event = this.#become(PRESENCE_IDLE, now, PRESENCE_EVENT_TYPES.IDLE, 'idle-threshold', { inactiveMs });
      return event ? [event] : [];
    }
    return [];
  }

  #become(next, at, type, reason, extra = {}) {
    const previousState = this.#state;
    if (previousState === next) return null;
    this.#state = next;
    this.#stateSinceAt = at;
    return this.#emit(type, at, { state: next, previousState, reason, ...extra });
  }

  #emit(type, at, fields) {
    this.#sequence += 1;
    const event = {
      id: 'presence:' + this.#sequence,
      type,
      at: toIso(at),
      state: fields.state,
      previousState: fields.previousState,
      reason: fields.reason,
      sequence: this.#sequence,
    };
    if (Number.isFinite(Number(fields.inactiveMs))) {
      event.inactiveMs = Math.max(0, Math.trunc(Number(fields.inactiveMs)));
    }
    this.#events.push(copyEvent(event));
    while (this.#events.length > this.#maxEvents) {
      this.#events.shift();
      this.#droppedEvents += 1;
    }
    this.#history.push(copyEvent(event));
    while (this.#history.length > this.#maxHistory) {
      this.#history.shift();
      this.#droppedHistory += 1;
    }
    return event;
  }

  #reject(reason) {
    this.#rejectedObservations += 1;
    return {
      accepted: false,
      reason,
      state: this.#state,
      changed: false,
      events: [],
    };
  }

  #result(events, at) {
    return {
      accepted: true,
      reason: '',
      state: this.#state,
      changed: events.length > 0,
      events: events.map(copyEvent),
      at: toIso(at),
    };
  }
}

export function createPresenceMonitor(options) {
  return new PresenceMonitor(options);
}

export default PresenceMonitor;
