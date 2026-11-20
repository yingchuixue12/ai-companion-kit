/**
 * 事件收件箱（inbox）：把离散到达的输入排成一条有序事件队列，
 * 并在轮次开始时冻结成一个不可变批次，交给模型/消费者处理。
 *
 * 一条事件至少带着三样身份信息：
 * - eventId：稳定标识。适配层给出就用它，否则用 `会话 key#来源序号` 组合；
 *   同一条平台消息重复投递时 eventId 相同，因此不会被消费两次。
 * - sequence：来源序号。优先取适配层的接收序号（如 OneBot 的 receiveSequence），
 *   适配层没给时用收件箱内部自增序号兜底。
 * - receivedAt：接收时间（ISO 字符串）。
 *
 * 边界约定（S1 只做这些，不做离线补发、unknown 重试、提醒睡眠策略）：
 * - freezeBatch() 取走“当前这一批”，冻结之后新到的事件留在队列里等下一批；
 * - ackBatch() 表示这批已经成功提交，事件不再回到队列，也不会被重复消费；
 * - requeue() 把批次按原顺序放回队首，并累加 attempts，用于可重放；
 * - failBatch() 把批次放进失败区等待显式 replayFailed()，避免静默丢掉；
 * - 同一个收件箱实例只服务一个会话，因此同会话天然串行。
 *
 * 典型用法（QQ 适配层）：
 *
 *   const inbox = new Inbox({ key: 'private:123' });
 *   inbox.enqueue(msg, { sequence: msg.receiveSequence, receivedAt: msg.receivedAt });
 *   const batch = inbox.freezeBatch();
 *   try {
 *     await handle(batch.inputs);
 *     inbox.ackBatch(batch);
 *   } catch (error) {
 *     inbox.requeue(batch);   // 或者 failBatch(batch, { error }) 留待重放
 *   }
 */

/** 开启一轮新对话的输入（next-turn）。 */
export const LANE_TURN = 'turn';
/** 属于当前轮次后续步骤的输入（next-step）。 */
export const LANE_STEP = 'step';

export const LANES = [LANE_STEP, LANE_TURN];

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_FAILED = 16;
// 已经提交过的事件 id 只保留最近的若干条，用来挡住平台层重复投递。
const RECENT_ACK_LIMIT = 256;

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

function describeEvent(event) {
  return {
    eventId: event.eventId,
    key: event.key,
    sequence: event.sequence,
    receivedAt: event.receivedAt,
    lane: event.lane,
    attempts: event.attempts,
    source: event.source,
    payload: event.payload,
  };
}

export class Inbox {
  constructor({ key = '', maxPending = DEFAULT_MAX_PENDING, maxFailed = DEFAULT_MAX_FAILED, onOverflow, onDrop } = {}) {
    this.key = String(key ?? '');
    this.maxPending = Math.max(1, Number(maxPending) || DEFAULT_MAX_PENDING);
    this.maxFailed = Math.max(1, Number(maxFailed) || DEFAULT_MAX_FAILED);
    this.onOverflow = typeof onOverflow === 'function' ? onOverflow : null;
    this.onDrop = typeof onDrop === 'function' ? onDrop : null;
    /** 尚未冻结的事件，按到达顺序排列。 */
    this.queue = [];
    /** 已冻结、等待 ack/requeue 的批次：batchId -> batch。 */
    this.batches = new Map();
    /** 处理失败、等待显式重放的批次记录。 */
    this.failed = [];
    this.recent = new Set();
    this.recentOrder = [];
    this.sequence = 0;
    this.batchCount = 0;
  }

  /** 队列里还没冻结的事件条数。 */
  get size() { return this.queue.length; }

  /** 已冻结、尚未提交的事件条数。 */
  get inflightSize() {
    let total = 0;
    for (const batch of this.batches.values()) total += batch.events.length;
    return total;
  }

  /** 队列 + 冻结中的事件条数。 */
  get pendingSize() { return this.size + this.inflightSize; }

  get failedSize() { return this.failed.length; }

  /**
   * 收一条事件。
   * @returns {{ status: 'queued'|'duplicate'|'overflow', event: object|null, error?: Error }}
   */
  enqueue(payload, { eventId, sequence, receivedAt, lane = LANE_TURN, source = null } = {}) {
    const seqNumber = Number(sequence);
    const seq = sequence !== undefined && sequence !== null && sequence !== '' && Number.isFinite(seqNumber)
      ? seqNumber
      : this.sequence + 1;
    const id = typeof eventId === 'string' && eventId.trim()
      ? eventId.trim()
      : `${this.key}#${seq}`;

    const existing = this.#find(id);
    if (existing) return { status: 'duplicate', event: existing };

    if (this.queue.length >= this.maxPending) {
      const error = new Error(`队列已满（收件箱已满，最多${this.maxPending}）`);
      if (this.onOverflow) {
        try { this.onOverflow(error, { eventId: id, payload, key: this.key }); } catch { /* reporting must not break enqueue */ }
      }
      return { status: 'overflow', event: null, error };
    }

    this.sequence = Math.max(this.sequence, seq);
    const event = {
      eventId: id,
      key: this.key,
      sequence: seq,
      receivedAt: toIsoTime(receivedAt),
      lane: lane === LANE_STEP ? LANE_STEP : LANE_TURN,
      source: source ?? null,
      attempts: 0,
      payload,
    };
    this.queue.push(event);
    return { status: 'queued', event };
  }

  /**
   * 冻结一个批次：按队列顺序取队首事件。
   * - `lanes`：只接受这些 lane 的事件，遇到别的 lane 立即停止；
   * - `stopAt`：抓到第一个该 lane 的事件就停止取，并要求本批一定包含它，
   *   否则返回 null（例如只有 step 事件、还没有新轮次输入时不成批）；
   * - `max`：本批最多取多少条。
   * 冻结之后到达的事件进入下一批。
   */
  freezeBatch({ lanes = LANES, stopAt = null, max = Infinity } = {}) {
    const allowed = Array.isArray(lanes) && lanes.length ? lanes : LANES;
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
    const picked = [];
    for (const event of this.queue) {
      if (!allowed.includes(event.lane)) break;
      picked.push(event);
      if (picked.length >= limit) break;
      if (stopAt && event.lane === stopAt) break;
    }
    if (!picked.length) return null;
    if (stopAt && picked[picked.length - 1].lane !== stopAt) return null;

    this.queue.splice(0, picked.length);
    this.batchCount += 1;
    const batch = {
      batchId: `${this.key || 'inbox'}:b${this.batchCount}`,
      key: this.key,
      events: picked,
      inputs: picked.map((event) => event.payload),
      frozenAt: new Date().toISOString(),
      attempts: picked[0].attempts,
    };
    this.batches.set(batch.batchId, batch);
    return batch;
  }

  /** 提交批次：事件彻底离开队列，之后不会被重复消费。重复 ack 返回 0。 */
  ackBatch(batch) {
    const tracked = this.#batch(batch);
    if (!tracked) return 0;
    this.batches.delete(tracked.batchId);
    for (const event of tracked.events) this.#remember(event.eventId);
    return tracked.events.length;
  }

  /** 把批次按原顺序放回队首（默认），并累加 attempts；重复调用返回 0。 */
  requeue(batch, { front = true } = {}) {
    const tracked = this.#batch(batch);
    if (!tracked) return 0;
    this.batches.delete(tracked.batchId);
    for (const event of tracked.events) event.attempts += 1;
    if (front) this.queue.unshift(...tracked.events);
    else this.queue.push(...tracked.events);
    return tracked.events.length;
  }

  /** 把批次移入失败区：不丢弃、保留原顺序，等待 replayFailed() 显式重放。 */
  failBatch(batch, { error = null } = {}) {
    const tracked = this.#batch(batch);
    if (!tracked) return 0;
    this.batches.delete(tracked.batchId);
    const record = {
      batchId: tracked.batchId,
      key: this.key,
      events: tracked.events,
      inputs: tracked.inputs,
      attempts: tracked.attempts + 1,
      failedAt: new Date().toISOString(),
      error: error ? String(error.message || error) : null,
    };
    this.failed.push(record);
    while (this.failed.length > this.maxFailed) {
      const dropped = this.failed.shift();
      if (this.onDrop) {
        try { this.onDrop(dropped); } catch { /* reporting must not break the queue */ }
      }
    }
    return record.events.length;
  }

  /** 失败批次按原顺序回到队首，attempts 归零；返回放回的事件数。 */
  replayFailed({ limit = Infinity } = {}) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : this.failed.length;
    const records = this.failed.splice(0, cap);
    if (!records.length) return 0;
    const events = [];
    for (const record of records) {
      for (const event of record.events) {
        event.attempts = 0;
        events.push(event);
      }
    }
    this.queue.unshift(...events);
    return events.length;
  }

  /** 队列里的事件快照（只读，用于观测/日志）。 */
  pendingEvents({ lane } = {}) {
    return this.queue
      .filter((event) => !lane || event.lane === lane)
      .map(describeEvent);
  }

  /** 已冻结、尚未提交的批次快照。 */
  inflightBatches() {
    return [...this.batches.values()].map((batch) => ({
      batchId: batch.batchId,
      key: batch.key,
      frozenAt: batch.frozenAt,
      attempts: batch.attempts,
      events: batch.events.map(describeEvent),
    }));
  }

  /** 等待重放的失败批次快照。 */
  failedBatches() {
    return this.failed.map((record) => ({
      batchId: record.batchId,
      key: record.key,
      failedAt: record.failedAt,
      attempts: record.attempts,
      error: record.error,
      events: record.events.map(describeEvent),
    }));
  }

  /** 这个 eventId 是否已经在队列、冻结中、失败区或最近提交过。 */
  has(eventId) {
    return Boolean(this.#find(eventId));
  }

  /** 队列里是否还有指定 lane 的事件。 */
  hasLane(lane) {
    return this.queue.some((event) => event.lane === lane);
  }

  /**
   * 清空队列（取消/关闭时用）。冻结中的批次不动，避免打断正在处理的轮次。
   * `includeFailed` 为 true 时连失败区一起清掉。
   */
  clear({ includeFailed = false } = {}) {
    let dropped = this.queue.length;
    this.queue.length = 0;
    if (includeFailed) {
      for (const record of this.failed) dropped += record.events.length;
      this.failed.length = 0;
    }
    return dropped;
  }

  #batch(batch) {
    if (!batch) return null;
    const id = typeof batch === 'string' ? batch : batch.batchId;
    if (!id) return null;
    return this.batches.get(id) || null;
  }

  #find(eventId) {
    if (typeof eventId !== 'string' || !eventId) return null;
    for (const event of this.queue) if (event.eventId === eventId) return event;
    for (const batch of this.batches.values()) {
      for (const event of batch.events) if (event.eventId === eventId) return event;
    }
    for (const record of this.failed) {
      for (const event of record.events) if (event.eventId === eventId) return event;
    }
    if (this.recent.has(eventId)) return { eventId, acked: true };
    return null;
  }

  #remember(eventId) {
    if (this.recent.has(eventId)) return;
    this.recent.add(eventId);
    this.recentOrder.push(eventId);
    while (this.recentOrder.length > RECENT_ACK_LIMIT) {
      this.recent.delete(this.recentOrder.shift());
    }
  }
}

export default Inbox;
