/**
 * 在场互动策略 · presence interaction policy
 * ─────────────────────────────────────────────────────────────
 * 位置：P2 本地在场行为的「要不要说一句」这一层。
 * 上游是 presence.js / presence-runtime.js 的状态与事件；下游是宿主自己的
 * 主动消息通道（Web、QQ、Live2D 都行）。本模块只做本地纯策略：
 *
 *   输入：{ state, events, at }
 *   输出：[] 或 [{ id, kind, text, at }]（每次最多一条）
 *
 * 它不联网、不读文件、不写文件、不装定时器、不调用模型、不读任何内容字段。
 * 事件只认 presence.js 定义的那四种类型；多塞的 text / title / url / clipboard
 * 在归一化时就被丢掉，不会进入策略状态，也不会出现在 intent 里。
 *
 * ── 两条规则 ────────────────────────────────────────────────
 *   welcome-back    一次「真的离开过又回来」才可能欢迎一次。
 *                   必须同时满足：returned 事件的 previousState 是 away、
 *                   离开时长 ≥ returnAfterMs、离上次欢迎 ≥ cooldownMs。
 *                   第一次启动（entered）、重连（只有 present 没有 returned）、
 *                   心跳、重复事件、idle→present 的短离开都不会欢迎。
 *   break-reminder  一段持续在场的会话最多提醒一次。
 *                   在场时长按「present 的累计时间」算，idle 期间暂停累计，
 *                   away 会清零并开启新会话；两次提醒之间还有独立冷却。
 *
 * ── 为什么欢迎和提醒的冷却分开 ──────────────────────────────
 * 如果共用一个冷却，一次欢迎会把接下来 90 分钟的休息提醒全部压掉；
 * 反过来一次提醒也会压掉刚回来时的欢迎。这里用两张独立的冷却表：
 *   lastWelcomeAt / lastBreakAt
 * 两者互不影响，任一条都不会因为另一条而静默失效。
 *
 * ── 时间 ────────────────────────────────────────────────────
 * evaluate({ at }) 的时间是权威时间；at 缺省时才用构造函数的 now()。
 * 显式传入非法 at 时直接返回 []，不猜时间。事件时间晚于 at 超过
 * FUTURE_TOLERANCE_MS 的视为未来事件，本次忽略（不记为已见，等时间追上）；
 * 略微超前（≤ 5 秒）的按 at 处理，容忍宿主的小时钟偏差。
 * at 相对上一次 evaluate 倒流时钳到上一次的时间，并计入 clockSkewCount，
 * 和 PresenceMonitor 的单调时间语义保持一致。
 *
 * ── 去重 ────────────────────────────────────────────────────
 * 同一条事件（id 相同）只处理一次；没有 id 时用
 * type + at + previousState + state 的签名去重。两种键都放进一个有界集合
 * （默认 256 个键，丢最旧），所以重复投递、宿主重放同一批事件都不会
 * 重复欢迎或重复提醒。
 *
 * ── 重置 ────────────────────────────────────────────────────
 * reset()/clear() 清空：会话累计、离开锚点、两张冷却表、去重表、序号和
 * 计数器；配置与 enabled 保留。重置后同一批事件可以再次触发，因为去重表
 * 也清了——宿主不应该在重置后重放旧事件。setEnabled(false) 会先 reset()
 * 再停止输出；重新启用从干净状态开始。enabled=false 时 evaluate() 是
 * 硬性空操作：不改状态、不记去重、不产生 intent。
 *
 * ── 文案 ────────────────────────────────────────────────────
 * 文案是确定性的短兜底，只描述「回来了」和「要不要歇一下」。
 * 不声称看见屏幕、窗口、应用或任何内容；不计算离开了多久；不制造愧疚；
 * 不做监控式点评；不给医疗建议。宿主可以不用 text、只按 kind 生成自己的
 * 人格化文案，但必须守住同样的真实边界。
 */
import {
  PRESENCE_AWAY,
  PRESENCE_EVENT_TYPES,
  PRESENCE_IDLE,
  PRESENCE_PRESENT,
  PRESENCE_UNKNOWN,
} from './presence.js';

const DEFAULT_NOW = () => Date.now();

export const DEFAULT_RETURN_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_WORK_AFTER_MS = 50 * 60 * 1000;
export const DEFAULT_COOLDOWN_MS = 90 * 60 * 1000;
const DEFAULT_MAX_SEEN = 256;
const FUTURE_TOLERANCE_MS = 5 * 1000;

/** intent 的两种 kind；宿主的 switch 直接用，避免手写字符串。 */
export const PRESENCE_INTERACTION_KINDS = Object.freeze({
  WELCOME_BACK: 'welcome-back',
  BREAK_REMINDER: 'break-reminder',
});

export const PRESENCE_INTERACTION_TEXT = Object.freeze({
  [PRESENCE_INTERACTION_KINDS.WELCOME_BACK]: '你回来啦，我在呢。',
  [PRESENCE_INTERACTION_KINDS.BREAK_REMINDER]: '你好像忙了一阵子啦，要不要先歇一下？',
});

export const DEFAULT_PRESENCE_INTERACTION_OPTIONS = Object.freeze({
  returnAfterMs: DEFAULT_RETURN_AFTER_MS,
  workAfterMs: DEFAULT_WORK_AFTER_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  enabled: true,
});

const KNOWN_EVENT_TYPES = new Set(Object.values(PRESENCE_EVENT_TYPES));
const KNOWN_STATES = new Set([
  PRESENCE_UNKNOWN,
  PRESENCE_PRESENT,
  PRESENCE_IDLE,
  PRESENCE_AWAY,
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受 Date / 有限毫秒数 / 可解析的时间字符串；其余一律 null。 */
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
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 阈值允许 0（测试/关闭用），null/空串/负数/非有限值回落默认。 */
function nonNegativeMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function boundedInt(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i >= min ? i : fallback;
}

function normalizeState(value) {
  return KNOWN_STATES.has(value) ? value : null;
}

function normalizeEvents(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return [value];
  return [];
}

/**
 * 事件归一化：只保留 presence.js 定义过的字段，其他键全部丢弃。
 * 返回的 at 是毫秒数；非法时间返回 null，由调用方跳过。
 */
function normalizeEvent(value) {
  if (!isPlainObject(value)) return null;
  if (!KNOWN_EVENT_TYPES.has(value.type)) return null;
  const at = toTimestamp(value.at);
  if (at === null) return null;
  const sequence = Number(value.sequence);
  return {
    id: typeof value.id === 'string' && value.id ? value.id : null,
    type: value.type,
    at,
    state: normalizeState(value.state),
    previousState: normalizeState(value.previousState),
    sequence: Number.isFinite(sequence) && sequence >= 0 ? Math.trunc(sequence) : 0,
  };
}

function compareEvents(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const left = a.id || '';
  const right = b.id || '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 本地在场互动策略。
 *
 * @example
 *   const policy = new PresenceInteractionPolicy({ returnAfterMs: 5 * 60_000 });
 *   const { delivered } = presence.drain();
 *   const intents = policy.evaluate({ state: presence.state, events: delivered, at: Date.now() });
 *   for (const intent of intents) host.say(intent.text, { source: 'presence', kind: intent.kind });
 */
export class PresenceInteractionPolicy {
  #now;
  #returnAfterMs;
  #workAfterMs;
  #cooldownMs;
  #enabled;
  #maxSeen;

  #state = PRESENCE_UNKNOWN;
  #lastAt = null;
  #activeMs = 0;
  #awayStartedAt = null;
  #sessionReminderSent = false;
  #lastWelcomeAt = null;
  #lastBreakAt = null;

  #seen = new Set();
  #sequence = 0;
  #duplicates = 0;
  #rejected = 0;
  #futureEvents = 0;
  #historicalEvents = 0;
  #clockSkewCount = 0;

  /**
   * @param {object} [options]
   * @param {() => number|Date|string} [options.now] 没有传 at 时使用的时钟
   * @param {number} [options.returnAfterMs] 离开多久才算「真的离开过」（默认 5 分钟）
   * @param {number} [options.workAfterMs]   持续在场多久提醒一次（默认 50 分钟）
   * @param {number} [options.cooldownMs]    欢迎/提醒各自的冷却（默认 90 分钟）
   * @param {boolean} [options.enabled]      false = 完全不输出（默认 true）
   * @param {number} [options.maxSeen]       去重键上限（默认 256）
   */
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    if (typeof opts.now === 'function') {
      this.#now = opts.now;
    } else if (opts.now !== undefined && opts.now !== null) {
      const fixed = toTimestamp(opts.now);
      this.#now = fixed === null ? DEFAULT_NOW : () => fixed;
    } else {
      this.#now = DEFAULT_NOW;
    }
    this.#returnAfterMs = nonNegativeMs(opts.returnAfterMs, DEFAULT_RETURN_AFTER_MS);
    this.#workAfterMs = nonNegativeMs(opts.workAfterMs, DEFAULT_WORK_AFTER_MS);
    this.#cooldownMs = nonNegativeMs(opts.cooldownMs, DEFAULT_COOLDOWN_MS);
    this.#enabled = opts.enabled !== false;
    this.#maxSeen = boundedInt(opts.maxSeen, DEFAULT_MAX_SEEN, 16);
  }

  get enabled() {
    return this.#enabled;
  }

  get options() {
    return {
      returnAfterMs: this.#returnAfterMs,
      workAfterMs: this.#workAfterMs,
      cooldownMs: this.#cooldownMs,
      enabled: this.#enabled,
      maxSeen: this.#maxSeen,
    };
  }

  /** 只读运行计数，全是数字/布尔/null，不含任何内容。 */
  get stats() {
    return {
      enabled: this.#enabled,
      state: this.#state,
      activeMs: this.#activeMs,
      awayMs: this.#awayStartedAt === null || this.#lastAt === null
        ? 0
        : Math.max(0, this.#lastAt - this.#awayStartedAt),
      emitted: this.#sequence,
      duplicates: this.#duplicates,
      rejected: this.#rejected,
      futureEvents: this.#futureEvents,
      historicalEvents: this.#historicalEvents,
      clockSkewCount: this.#clockSkewCount,
      trackedEvents: this.#seen.size,
    };
  }

  /**
   * 评估当前状态与一批新事件，返回 0 或 1 条 intent。
   * @param {{state?: string, events?: object|object[], at?: number|string|Date}} [input]
   * @returns {Array<{id:string, kind:string, text:string, at:string}>}
   */
  evaluate(input) {
    if (!this.#enabled) return [];
    const request = isPlainObject(input) ? input : {};
    const rawAt = request.at === undefined || request.at === null
      ? this.#resolveNow()
      : toTimestamp(request.at);
    if (rawAt === null) {
      this.#rejected += 1;
      return [];
    }

    let now = rawAt;
    if (this.#lastAt !== null && now < this.#lastAt) {
      this.#clockSkewCount += 1;
      now = this.#lastAt;
    }

    const declaredState = normalizeState(request.state);
    const events = this.#prepareEvents(normalizeEvents(request.events), now);
    let state = this.#state;
    let cursor = this.#lastAt !== null ? this.#lastAt : (events.length > 0 ? events[0].at : now);
    let intent = null;
    let sawReturned = false;

    for (const event of events) {
      // 晚到的事件（早于上一次 evaluate 的时间）仍然处理它的状态转换，
      // 但不把已经过去的区间重复计成在场时间；这样轮询式宿主晚一拍的
      // away→returned 批次仍能算出正确的离开时长。
      const late = event.at < cursor;
      if (late) this.#historicalEvents += 1;
      const eventAt = late ? event.at : Math.min(event.at, now);
      if (!late && state === PRESENCE_PRESENT) {
        this.#activeMs += Math.max(0, eventAt - cursor);
      }
      if (!late) cursor = eventAt;

      if (event.type === PRESENCE_EVENT_TYPES.ENTERED) {
        state = PRESENCE_PRESENT;
        this.#activeMs = 0;
        this.#sessionReminderSent = false;
        this.#awayStartedAt = null;
      } else if (event.type === PRESENCE_EVENT_TYPES.RETURNED) {
        sawReturned = true;
        const from = event.previousState || state;
        if (from === PRESENCE_AWAY) {
          const awayStarted = this.#awayStartedAt !== null
            ? this.#awayStartedAt
            : (this.#state === PRESENCE_AWAY && this.#lastAt !== null ? this.#lastAt : null);
          const awayMs = awayStarted === null ? null : Math.max(0, eventAt - awayStarted);
          const cooled = this.#lastWelcomeAt === null
            || now - this.#lastWelcomeAt >= this.#cooldownMs;
          if (intent === null && awayMs !== null && awayMs >= this.#returnAfterMs && cooled) {
            intent = this.#makeIntent(PRESENCE_INTERACTION_KINDS.WELCOME_BACK, now);
            this.#lastWelcomeAt = now;
          }
          this.#activeMs = 0;
          this.#sessionReminderSent = false;
        } else if (from === PRESENCE_IDLE) {
          // 短离开：不欢迎，但会话继续，累计的在场时间不清零。
        } else {
          // previousState 未知：不欢迎，也不假设之前在工作。
          this.#activeMs = 0;
          this.#sessionReminderSent = false;
        }
        this.#awayStartedAt = null;
        state = PRESENCE_PRESENT;
      } else if (event.type === PRESENCE_EVENT_TYPES.AWAY) {
        state = PRESENCE_AWAY;
        this.#activeMs = 0;
        this.#sessionReminderSent = false;
        this.#awayStartedAt = this.#awayStartedAt === null
          ? eventAt
          : Math.min(this.#awayStartedAt, eventAt);
      } else if (event.type === PRESENCE_EVENT_TYPES.IDLE) {
        state = PRESENCE_IDLE;
      }
    }

    // 末尾到 at 的这段：只有确认仍在 present 时才计入在场时间。
    // 宿主只给 state=idle/away 而没有对应事件时，不把未知的那段算成工作。
    const finalState = declaredState === null ? state : declaredState;
    if (state === PRESENCE_PRESENT && finalState === PRESENCE_PRESENT) {
      this.#activeMs += Math.max(0, now - cursor);
    }

    if (finalState === PRESENCE_AWAY) {
      this.#activeMs = 0;
      this.#sessionReminderSent = false;
      if (this.#awayStartedAt === null) this.#awayStartedAt = now;
    } else if (finalState === PRESENCE_UNKNOWN) {
      this.#activeMs = 0;
      this.#sessionReminderSent = false;
      this.#awayStartedAt = null;
    } else if (finalState === PRESENCE_PRESENT && !sawReturned) {
      // 只有 state=present 没有 returned 事件：可能是宿主重连/恢复。
      // 不欢迎，也不保留旧的离开锚点，避免下一次迟到事件被算成「离开很久」。
      this.#awayStartedAt = null;
    } else if (finalState === PRESENCE_IDLE) {
      this.#awayStartedAt = null;
    }

    if (intent === null
      && finalState === PRESENCE_PRESENT
      && !this.#sessionReminderSent
      && this.#activeMs >= this.#workAfterMs
      && (this.#lastBreakAt === null || now - this.#lastBreakAt >= this.#cooldownMs)) {
      intent = this.#makeIntent(PRESENCE_INTERACTION_KINDS.BREAK_REMINDER, now);
      this.#lastBreakAt = now;
      this.#sessionReminderSent = true;
    }

    this.#state = finalState;
    this.#lastAt = now;
    return intent === null ? [] : [intent];
  }

  /** 清空会话、冷却、去重与计数；保留配置和 enabled。 */
  reset() {
    this.#state = PRESENCE_UNKNOWN;
    this.#lastAt = null;
    this.#activeMs = 0;
    this.#awayStartedAt = null;
    this.#sessionReminderSent = false;
    this.#lastWelcomeAt = null;
    this.#lastBreakAt = null;
    this.#seen.clear();
    this.#sequence = 0;
    this.#duplicates = 0;
    this.#rejected = 0;
    this.#futureEvents = 0;
    this.#historicalEvents = 0;
    this.#clockSkewCount = 0;
    return this;
  }

  /** reset() 的别名；语义完全相同。 */
  clear() {
    return this.reset();
  }

  /**
   * 开关策略。关闭时先 reset()，避免重新启用后立刻补发旧会话的提醒。
   * @param {boolean} value
   */
  setEnabled(value) {
    if (value === false) {
      this.reset();
      this.#enabled = false;
    } else {
      this.#enabled = true;
    }
    return this;
  }

  // ── 内部 ──────────────────────────────────────────────────

  #resolveNow() {
    let value;
    try {
      value = this.#now();
    } catch {
      return null;
    }
    return toTimestamp(value);
  }

  /**
   * 归一化、排序、去重、过滤未来事件。
   * 未来事件不记为已见，等 at 追上后仍可处理；早于上一次 evaluate 的事件
   * 仍会进入事件循环，由调用方按「晚到事件」处理转换。
   */
  #prepareEvents(rawEvents, now) {
    const events = [];
    for (const raw of rawEvents) {
      const event = normalizeEvent(raw);
      if (!event) continue;
      if (event.at > now + FUTURE_TOLERANCE_MS) {
        this.#futureEvents += 1;
        continue;
      }
      if (event.at > now) event.at = now;
      const idKey = event.id === null ? null : 'id:' + event.id;
      const signature = 'sig:' + [
        event.type,
        event.at,
        event.previousState || '',
        event.state || '',
      ].join('|');
      if ((idKey !== null && this.#seen.has(idKey)) || this.#seen.has(signature)) {
        this.#duplicates += 1;
        continue;
      }
      this.#remember(idKey);
      this.#remember(signature);
      events.push(event);
    }
    events.sort(compareEvents);
    return events;
  }

  #remember(key) {
    if (key === null) return;
    this.#seen.add(key);
    while (this.#seen.size > this.#maxSeen) {
      const oldest = this.#seen.values().next().value;
      this.#seen.delete(oldest);
    }
  }

  #makeIntent(kind, atMs) {
    this.#sequence += 1;
    return {
      id: 'presence-interaction:' + kind + ':' + this.#sequence,
      kind,
      text: PRESENCE_INTERACTION_TEXT[kind],
      at: toIso(atMs),
    };
  }
}

export function createPresenceInteractionPolicy(options) {
  return new PresenceInteractionPolicy(options);
}

export default PresenceInteractionPolicy;
