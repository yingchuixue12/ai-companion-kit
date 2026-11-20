/**
 * 会话窗口：把连续到达的消息先收齐，再交给上层决定是否生成回复。
 * 它只负责时间窗口、最大条数和同一会话串行，不负责模型或平台。
 *
 * 与 S1 批次边界的关系：
 * - 每条进入窗口的消息都会先拿到稳定身份：eventId、来源序号（sequence）、接收时间
 *   （receivedAt）。适配层给了就用（例如 OneBot 的 receiveSequence），没给就按
 *   `会话 key#序号` 生成；
 * - 同一会话在窗口内连续到达的消息全部保留，按到达顺序交给 onFlush，不合并、不丢弃，
 *   因此“连续三条”就是三条；
 * - 同一条消息重复投递（eventId 相同）会被跳过，避免同一事件被消费两次；
 *   批次交出之后再重复投递同一条消息同样会被挡住（`seen` 保留最近的 id）；
 * - 刷出批次时会附带批次信封作为第二个参数：`{ key, batchId, events, frozenAt }`，
 *   上层可以把 batchId 当作收件箱事件 id 继续往下传；
 * - 批次信封、事件身份和原文列表都会被冻结（Object.freeze）：交出之后谁都改不动
 *   已经冻结的上下文，晚到的消息只会进入下一批；
 * - 关闭（close）算一次轮次边界：计时器还没到的待处理消息会被照常交出，不丢；
 *   关闭之后仍有消息进来时通过 onDrop('closed', …) 显式报告，不静默吞掉；
 * - 同一会话串行：上一批还没处理完时，下一批排队等待，不会并发改写同一份历史。
 */
const DEFAULT_MAX_SEEN = 512;

function toIsoTime(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = String(value).trim();
  if (!text) return new Date().toISOString();
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

function snapshotItem(item) {
  if (!item || typeof item !== 'object') return item;
  return Object.freeze(Array.isArray(item) ? [...item] : { ...item });
}

export class ConversationWindow {
  constructor({ windowMs = 4000, maxItems = 12, maxSeen = DEFAULT_MAX_SEEN, onFlush, onIgnore, onError, onDuplicate, onDrop } = {}) {
    this.windowMs = Math.max(0, Number(windowMs) || 0);
    this.maxItems = Math.max(1, Number(maxItems) || 1);
    this.maxSeen = Math.max(1, Number(maxSeen) || DEFAULT_MAX_SEEN);
    this.onFlush = onFlush;
    this.onIgnore = onIgnore;
    this.onError = onError;
    this.onDuplicate = onDuplicate;
    this.onDrop = onDrop;
    this.entries = new Map();
    this.tails = new Map();
    this.sequences = new Map();
    this.batchCount = 0;
    this.seen = new Set();
    this.seenOrder = [];
    this.closing = false;
  }

  /**
   * 收一条消息。
   * @param {string} key 会话键
   * @param {any} item 原始消息（保持原样交给 onFlush）
   * @param {{eligible?: boolean, windowMs?: number, eventId?: string, sequence?: number, receivedAt?: string|number|Date}} [options]
   */
  push(key, item, { eligible = false, windowMs, eventId, sequence, receivedAt } = {}) {
    if (this.closing) {
      // 关闭之后的输入没有批次可归，必须显式报告，不能静默丢掉。
      this.#drop('closed', { key, item });
      return Promise.resolve();
    }
    const identity = this.#identify(key, item, { eventId, sequence, receivedAt });
    if (this.#seen(identity.eventId)) {
      try { this.onDuplicate?.(identity, { key, item }); } catch { /* logging must not break the window */ }
      return Promise.resolve();
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { records: [], eligible: false, timer: null, windowMs: this.windowMs };
      this.entries.set(key, entry);
    }
    entry.records.push({ ...identity, item: snapshotItem(item) });
    entry.eligible ||= Boolean(eligible);
    if (windowMs !== undefined) entry.windowMs = Math.max(0, Number(windowMs) || 0);
    clearTimeout(entry.timer);
    if (entry.records.length >= this.maxItems) return this.flush(key);
    entry.timer = setTimeout(() => { void this.flush(key); }, entry.windowMs);
    return Promise.resolve();
  }

  /** 当前窗口里还没刷出的消息条数。 */
  pending(key) {
    return this.entries.get(key)?.records.length || 0;
  }

  /** 有待刷出消息的会话键。 */
  pendingKeys() {
    return [...this.entries.keys()];
  }

  flush(key) {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    this.entries.delete(key);
    const records = entry.records;
    // 冻结语义：交出之后晚到的消息不能改写这一批的原文或事件身份。
    const items = Object.freeze(records.map((record) => record.item));
    this.batchCount += 1;
    const batch = Object.freeze({
      key,
      batchId: `${key}:w${this.batchCount}`,
      events: Object.freeze(records.map(({ item, ...identity }) => Object.freeze(identity))),
      frozenAt: new Date().toISOString(),
    });
    const job = async () => {
      if (entry.eligible) return this.onFlush?.(items, batch);
      return this.onIgnore?.(items, batch);
    };
    const previous = this.tails.get(key) || Promise.resolve();
    // Timer-triggered flushes have no caller waiting on them. Report failures
    // here so a model/send error cannot become an unhandled rejection.
    const current = previous.catch(() => {}).then(job);
    const settled = current.catch((error) => {
      try { this.onError?.(error, { key, items, batch }); } catch { /* logging must not break the queue */ }
    });
    let tail;
    tail = settled.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return settled;
  }

  close() {
    if (this.closing) return Promise.allSettled(this.tails.values());
    this.closing = true;
    // Treat shutdown as a turn boundary so messages already received are not
    // silently discarded just because their debounce timer has not fired.
    const pending = [...this.entries.keys()].map((key) => this.flush(key));
    return Promise.allSettled([...pending, ...this.tails.values()]);
  }

  #identify(key, item, { eventId, sequence, receivedAt }) {
    const providedSequence = sequence !== undefined && sequence !== null && sequence !== ''
      ? Number(sequence)
      : Number(item?.receiveSequence);
    const previous = this.sequences.get(key) || 0;
    const seq = Number.isFinite(providedSequence) ? providedSequence : previous + 1;
    this.sequences.set(key, Math.max(previous, seq));
    const id = typeof eventId === 'string' && eventId.trim()
      ? eventId.trim()
      : (typeof item?.eventId === 'string' && item.eventId.trim() ? item.eventId.trim() : `${key}#${seq}`);
    return {
      eventId: id,
      sequence: seq,
      receivedAt: toIsoTime(receivedAt ?? item?.receivedAt ?? item?.time),
    };
  }

  #seen(eventId) {
    if (this.seen.has(eventId)) return true;
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    while (this.seenOrder.length > this.maxSeen) {
      this.seen.delete(this.seenOrder.shift());
    }
    return false;
  }

  #drop(reason, { key, item }) {
    try {
      this.onDrop?.(reason, { key, item, windowMs: this.windowMs });
    } catch { /* reporting must not break the window */ }
  }
}

export default ConversationWindow;
