/**
 * 在场运行时桥 · presence runtime bridge
 * ─────────────────────────────────────────────────────────────
 * 状态机本体在 ./presence.js（零依赖、无定时器、内容盲）；这个文件只做宿主栈
 * 与状态机之间的那一层很薄的转接：
 *
 *   1. 持有并独占一个 PresenceMonitor；
 *   2. 把 observe* / tick / consumeEvents / peekEvents / snapshot / restore
 *      原样透传，事件字段与类型保持 PresenceMonitor 的定义，不加料、不改名；
 *   3. 提供 onEvent 回调 + drain()/dispatch()，保证同一条事件最多投递一次；
 *   4. 回调抛错不污染状态：状态机已在上一步完成转换，错误被计数并结构化返回。
 *
 * 这里不生成寒暄、不调用 Brain、不发 QQ 消息、不联网、不装定时器，
 * 也不认识「窗口标题 / URL / 文件名 / 键盘 / 截图 / 进程列表 / 剪贴板 / 用户 id」
 * 这些词——输入只有时间戳与布尔量，其余字段在到达状态机之前就被窄化掉了。
 *
 * ── 投递语义（at-most-once）────────────────────────────────
 *   drain(limit?)        把状态机队列里的事件取走并投递，按 id 去重
 *   dispatch(events)     投递宿主自己手上的事件（同样按 id 去重）
 *   同一条事件（id 相同）在一次运行里只会进 onEvent 一次；投递失败的也不重试，
 *   因为「宁可少说一句，也不要重复说一句」。失败事件在返回值 failed[] 里交回宿主。
 *
 * ── 存档语义 ───────────────────────────────────────────────
 *   snapshot(options)             = PresenceMonitor.snapshot()，纯 JSON 数据
 *   restore(snapshot, options)    = PresenceMonitor.restore()，默认不重放未消费事件
 *   fromSnapshot(snapshot, opts)  构造即恢复；回调函数永远不落盘
 *
 * 典型用法（未来 QQ / Web / Live2D 宿主）：
 *
 *   const presence = new PresenceRuntime({ idleMs: 3 * 60_000, onEvent: (event) => {
 *     // 这里才决定要不要说话、说什么；桥本身不生成任何台词
 *     host.emit('presence', event.type);
 *   } });
 *   presence.observeActivity();            // 会话入口收到一条消息时
 *   presence.tick(Date.now());             // 宿主自己的节拍，不要求固定频率
 *   presence.drain();                      // 不设 onEvent 时自己轮询取事件
 */
import PresenceMonitor, {
  DEFAULT_PRESENCE_OPTIONS,
  PRESENCE_AWAY,
  PRESENCE_EVENT_TYPE_LIST,
  PRESENCE_EVENT_TYPES,
  PRESENCE_IDLE,
  PRESENCE_PRIVACY,
  PRESENCE_PRESENT,
  PRESENCE_STATES,
  PRESENCE_UNKNOWN,
  createPresenceMonitor,
} from './presence.js';

/** 桥接层的常量与类型原样再导出，宿主只 import 一个模块就够。 */
export {
  DEFAULT_PRESENCE_OPTIONS,
  PRESENCE_AWAY,
  PRESENCE_EVENT_TYPE_LIST,
  PRESENCE_EVENT_TYPES,
  PRESENCE_IDLE,
  PRESENCE_PRIVACY,
  PRESENCE_PRESENT,
  PRESENCE_STATES,
  PRESENCE_UNKNOWN,
  createPresenceMonitor,
};
export { PresenceMonitor };

const DEFAULT_MAX_DELIVERED = 256;

/**
 * 回调错误只允许公开这张固定白名单里的内建类别。
 * 键是原型而不是构造器：自定义子类、伪造 name 的对象和跨 realm 值都会
 * 落回 Error，不需要读取任何可能带正文的字段。
 */
const BUILTIN_ERROR_NAMES = new Map([
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [EvalError.prototype, 'EvalError'],
  [URIError.prototype, 'URIError'],
  [AggregateError.prototype, 'AggregateError'],
]);

/** 桥的默认行为：默认不自动投递（显式 drain 更可预测），去重表保留最近 256 个 id。 */
export const DEFAULT_RUNTIME_OPTIONS = Object.freeze({
  autoDrain: false,
  maxDelivered: DEFAULT_MAX_DELIVERED,
});

/** 输入窄化时允许透传的字段名，按观测入口区分。 */
const INPUT_FLAGS = Object.freeze({
  activity: 'active',
  focus: 'focused',
  heartbeat: 'alive',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInt(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= min ? i : fallback;
}

/**
 * 输入窄化：只保留 `at` 与该入口的布尔字段，其它键在进入状态机之前就丢掉。
 * 这是「桥也内容盲」的落点——宿主多塞 text / title / url / clipboard，
 * 到不了 PresenceMonitor，也就进不了事件、历史和快照。
 */
function narrowInput(input, flagName) {
  if (!isPlainObject(input)) return input;
  const narrowed = {};
  if (Object.prototype.hasOwnProperty.call(input, 'at')) narrowed.at = input.at;
  if (flagName && Object.prototype.hasOwnProperty.call(input, flagName)) {
    narrowed[flagName] = input[flagName];
  }
  return narrowed;
}

/**
 * 回调错误的公开描述：只按原型返回白名单内建类别，绝不读取或返回
 * name / message / stack，也不对非 Error 值做字符串化。
 * 连原型读取都可能被 Proxy trap 打断，所以整段匹配 fail closed 到 Error。
 */
function describeCallbackError(error) {
  try {
    if (typeof error !== 'object' || error === null) return { name: 'Error' };
    return { name: BUILTIN_ERROR_NAMES.get(Object.getPrototypeOf(error)) ?? 'Error' };
  } catch {
    return { name: 'Error' };
  }
}

function eventId(event) {
  return isPlainObject(event) && typeof event.id === 'string' && event.id ? event.id : null;
}

/**
 * PresenceRuntime · 宿主侧的在场事件桥。
 *
 * @example
 *   const presence = new PresenceRuntime({
 *     idleMs: 3 * 60_000,
 *     awayMs: 20 * 60_000,
 *     onEvent: (event) => host.emit(event.type, event),
 *     autoDrain: true,
 *   });
 *   presence.observeActivity();       // → presence.entered 立刻交给 onEvent
 *   presence.tick(Date.now() + 1);    // 阈值只在宿主调用时结算
 */
export class PresenceRuntime {
  #monitor;
  #onEvent = null;
  #autoDrain = false;
  #maxDelivered;

  #deliveredIds = new Set();
  #deliveredCount = 0;
  #droppedNoSink = 0;
  #callbackErrors = 0;
  #skippedDuplicates = 0;
  #invalidEvents = 0;
  #lastCallbackError = null;

  /**
   * @param {object} [options]
   * @param {PresenceMonitor} [options.monitor]  复用已有状态机（否则按 options 新建）
   * @param {number} [options.idleMs]            present → idle 阈值
   * @param {number} [options.awayMs]            → away 阈值
   * @param {number} [options.maxEvents]         状态机事件队列上限
   * @param {number} [options.maxHistory]        状态机转换历史上限
   * @param {() => number|Date} [options.clock]  时钟注入
   * @param {(event: object) => void} [options.onEvent] 事件回调（可为 null）
   * @param {boolean} [options.autoDrain]        true = 每次观测后自动投递
   * @param {number} [options.maxDelivered]      去重表上限（默认 256）
   */
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    this.#monitor = opts.monitor instanceof PresenceMonitor
      ? opts.monitor
      : new PresenceMonitor(opts);
    if (opts.onEvent !== undefined && opts.onEvent !== null && typeof opts.onEvent !== 'function') {
      throw new TypeError('PresenceRuntime: onEvent must be a function or null');
    }
    this.#onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.#autoDrain = opts.autoDrain === true;
    this.#maxDelivered = boundedInt(opts.maxDelivered, DEFAULT_MAX_DELIVERED, 1);
  }

  // ── 观测透传（输入先窄化，绝不落盘原文）───────────────────

  /** 有人在场的一次证据；`active: false` 等价于只结算阈值。 */
  observeActivity(input) {
    return this.#run(() => this.#monitor.observeActivity(narrowInput(input, INPUT_FLAGS.activity)));
  }

  /** 窗口获得焦点算活动；失去焦点只结算阈值。 */
  observeWindowFocus(input) {
    return this.#run(() => this.#monitor.observeWindowFocus(narrowInput(input, INPUT_FLAGS.focus)));
  }

  /** 宿主存活心跳：不构成用户活动；`alive: false` 表示身体离线。 */
  observeHeartbeat(input) {
    return this.#run(() => this.#monitor.observeHeartbeat(narrowInput(input, INPUT_FLAGS.heartbeat)));
  }

  /** 显式结算阈值（宿主自己的节拍；本模块不装定时器）。 */
  tick(input) {
    return this.#run(() => this.#monitor.tick(input));
  }

  // ── 投递 ──────────────────────────────────────────────────

  /**
   * 取走状态机队列里的事件并投递给 onEvent，同一条事件只会投递一次。
   * @param {number} [limit] 最多投递几条（缺省全部）
   * @returns {{attempted:number, delivered:object[], failed:object[], skipped:number}}
   */
  drain(limit) {
    return this.#deliver(this.#monitor.consumeEvents(limit));
  }

  /**
   * 投递宿主手上的事件（例如从外部队列恢复、或自己排序过的事件）。
   * 与 drain() 共用同一张去重表，因此不会把同一条事件送两次。
   * @param {object[]} events
   */
  dispatch(events) {
    return this.#deliver(Array.isArray(events) ? events : []);
  }

  /** 直接取原始事件、不做投递记账（留着状态机的读写口，谨慎使用）。 */
  consumeEvents(limit) {
    return this.#monitor.consumeEvents(limit);
  }

  /** 只看不取。 */
  peekEvents() {
    return this.#monitor.peekEvents();
  }

  // ── 回调管理 ──────────────────────────────────────────────

  get onEvent() {
    return this.#onEvent;
  }

  /** 设置/替换事件回调；传 null 表示暂时不投递。 */
  setOnEvent(callback) {
    if (callback !== null && typeof callback !== 'function') {
      throw new TypeError('PresenceRuntime: onEvent must be a function or null');
    }
    this.#onEvent = callback;
    return this;
  }

  clearOnEvent() {
    this.#onEvent = null;
    return this;
  }

  // ── 状态与只读视图 ────────────────────────────────────────

  get state() {
    return this.#monitor.state;
  }

  get stateSinceAt() {
    return this.#monitor.stateSinceAt;
  }

  get lastActivityAt() {
    return this.#monitor.lastActivityAt;
  }

  get lastHeartbeatAt() {
    return this.#monitor.lastHeartbeatAt;
  }

  get hostAlive() {
    return this.#monitor.hostAlive;
  }

  get idleMs() {
    return this.#monitor.idleMs;
  }

  get awayMs() {
    return this.#monitor.awayMs;
  }

  get options() {
    return { ...this.#monitor.options, autoDrain: this.#autoDrain, maxDelivered: this.#maxDelivered };
  }

  get pendingEventCount() {
    return this.#monitor.pendingEventCount;
  }

  get history() {
    return this.#monitor.history;
  }

  /**
   * 隐私元数据：状态机的声明 + 桥自己的两条附加保证（不回写状态机对象）。
   * persistsCallbacks=false 明确说明回调函数不会被写进快照。
   */
  get privacy() {
    return {
      ...this.#monitor.privacy,
      persistsCallbacks: false,
      eventDelivery: 'at-most-once',
    };
  }

  /** 结构化的运行统计：状态机计数器、桥的投递计数，以及内容盲的回调错误标签。 */
  get stats() {
    return {
      monitor: this.#monitor.stats,
      bridge: {
        autoDrain: this.#autoDrain,
        hasSink: typeof this.#onEvent === 'function',
        delivered: this.#deliveredCount,
        droppedNoSink: this.#droppedNoSink,
        callbackErrors: this.#callbackErrors,
        skippedDuplicates: this.#skippedDuplicates,
        invalidEvents: this.#invalidEvents,
        trackedEventIds: this.#deliveredIds.size,
        lastCallbackError: this.#lastCallbackError ? { ...this.#lastCallbackError } : null,
      },
    };
  }

  // ── 存档 ──────────────────────────────────────────────────

  /** 纯 JSON 快照（格式与 PresenceMonitor 一致）；回调函数不参与序列化。 */
  snapshot(options = {}) {
    return this.#monitor.snapshot(options);
  }

  toJSON() {
    return this.snapshot();
  }

  /**
   * 恢复：默认不重放未消费事件（与 PresenceMonitor 一致），传 replayEvents: true 才重放。
   * 重放也只补发「本次运行里还没投递过」的 id，因此不会重复触发同一条 returned。
   */
  restore(snapshot, options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const result = this.#monitor.restore(snapshot, opts);
    if (this.#autoDrain && typeof this.#onEvent === 'function') this.drain();
    return result;
  }

  /** 构造即恢复。默认沿用宿主配置；`adoptConfig: true` 才采用快照里的阈值。 */
  static fromSnapshot(snapshot, options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const runtime = new PresenceRuntime(opts);
    runtime.restore(snapshot, { ...opts, adoptConfig: opts.adoptConfig === true });
    return runtime;
  }

  /** 清空状态机与桥的投递记账（配置与回调保留）。 */
  reset() {
    this.#monitor.reset();
    this.#deliveredIds.clear();
    this.#deliveredCount = 0;
    this.#droppedNoSink = 0;
    this.#callbackErrors = 0;
    this.#skippedDuplicates = 0;
    this.#invalidEvents = 0;
    this.#lastCallbackError = null;
    return this;
  }

  // ── 内部 ──────────────────────────────────────────────────

  #run(operation) {
    const result = operation();
    if (this.#autoDrain && typeof this.#onEvent === 'function') this.drain();
    return result;
  }

  /**
   * 单条投递入口：先记账再回调，保证「回调里再 drain 一次」也不会重复投递。
   * 回调抛错只记一次结构化错误，不影响同批后续事件，也不影响状态机。
   */
  #deliver(events) {
    const delivered = [];
    const failed = [];
    let skipped = 0;

    for (const event of events) {
      const id = eventId(event);
      if (!id) {
        // 没有稳定 id 的事件无法保证「最多一次」，直接不投递。
        skipped += 1;
        this.#invalidEvents += 1;
        continue;
      }
      if (this.#deliveredIds.has(id)) {
        skipped += 1;
        this.#skippedDuplicates += 1;
        continue;
      }
      this.#track(id);

      if (typeof this.#onEvent !== 'function') {
        this.#droppedNoSink += 1;
        continue;
      }
      try {
        this.#onEvent(event);
        this.#deliveredCount += 1;
        delivered.push(event);
      } catch (error) {
        this.#callbackErrors += 1;
        this.#lastCallbackError = Object.freeze({
          eventId: id,
          eventType: typeof event.type === 'string' ? event.type : '',
          ...describeCallbackError(error),
        });
        failed.push(event);
      }
    }

    return { attempted: Array.isArray(events) ? events.length : 0, delivered, failed, skipped };
  }

  #track(id) {
    this.#deliveredIds.add(id);
    while (this.#deliveredIds.size > this.#maxDelivered) {
      const oldest = this.#deliveredIds.values().next().value;
      this.#deliveredIds.delete(oldest);
    }
  }
}

export function createPresenceRuntime(options) {
  return new PresenceRuntime(options);
}

export default PresenceRuntime;
