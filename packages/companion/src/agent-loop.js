import { Inbox, LANE_STEP, LANE_TURN } from './inbox.js';

// 任务状态词表放在共享模块里，这里只做转发导出，保持既有公开 API 不变。
export { TASK_STATUSES, TERMINAL_TASK_STATUSES, DELIVERY_TASK_STATUSES } from './task-status.js';

// 收拢模式下单批最多合并多少条轮次输入：既保证“最新那一组”完整，也不让一批无限长。
const DEFAULT_MAX_TURN_BATCH = 12;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 轻量 agent loop：只负责普通 Inbox 驱动，不绑定模型、平台、任务或存储。
 * 调用方提供一个 `onTurn(inputs, ctx)`，其余交给收件箱和轮次边界。
 *
 * 批次边界：
 * - 每条输入先作为事件进入 Inbox，带稳定 eventId、来源序号和接收时间；
 *   `followup(input, { eventId, sequence, receivedAt })` 可以把适配层身份交给收件箱；
 *   宿主直接把原始适配消息交进来时，按消息自带的 `eventId` / `receiveSequence` /
 *   `receivedAt` 兜底，都没有时按 `key#序号` 生成，因此同一条平台消息重复投递
 *   不会被消费两次；
 * - 每轮开始时冻结一个批次，推理期间到达的新消息留在下一批，不并入当前批次；
 * - 默认轮次边界停在第一条 turn 事件：它前面排到的 step 事件和它一起冻成同一批；
 * - `coalesceTurns: true` 时（默认关闭，由宿主按会话显式打开），开轮时把队列里
 *   已经排到的轮次输入一次冻进同一批，事件身份、冻结语义和串行顺序都不变，
 *   但堆积的旧消息不会各占一轮、一条条追着过期话题回；
 * - onTurn 的 ctx 带上这批事件的身份、批次 id、冻结时间和重放次数；
 * - onTurn 正常返回即视为提交（ack），这批事件不会被重复消费；静默返回也是
 *   合法结论，loop 不补台词、不重试；
 * - onTurn 抛错时批次不会静默消失：默认进入 `failedBatches()` 留档，由调用方
 *   `replayFailed()` 显式重放；`maxAttempts > 1` 才启用有界自动重试；
 * - 一次只跑一轮，同一会话的输入天然串行（一个会话一个 loop）；
 * - 只有 step 事件时保持空闲：`inject()` 不唤醒驱动，`steer()` 也不会单独开轮，
 *   它们等下一次 `followup()` 到来后并入同一批；
 * - `cancel()` / `close()` 通过 AbortSignal 协作取消当前轮；被中断的批次按已
 *   消费处理，不会在失败区里复活。
 *
 * 任务、计时器、落盘和宿主入口不在这里实现。
 */
export class AgentLoop {
  constructor({
    onTurn, onError, key = '', maxPending = 64, maxFailed, maxAttempts = 1,
    coalesceTurns = false, maxTurnBatchItems = DEFAULT_MAX_TURN_BATCH,
  } = {}) {
    if (typeof onTurn !== 'function') throw new TypeError('AgentLoop 需要 onTurn');
    this.onTurn = onTurn;
    this.onError = typeof onError === 'function' ? onError : () => {};
    // 收拢模式：轮次开始时把队列里已经排到的轮次输入冻成同一批。
    // 默认关闭（每个离散事件照旧各成一批），由宿主按会话显式打开。
    this.coalesceTurns = coalesceTurns === true;
    this.maxTurnBatchItems = Math.max(1, Number(maxTurnBatchItems) || DEFAULT_MAX_TURN_BATCH);
    this.maxPending = Math.max(1, Number(maxPending) || 64);
    // 1 表示“失败就留档等显式重放”，大于 1 表示允许自动重放若干次。
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 1);
    this.key = String(key ?? '');
    this.inbox = new Inbox({
      key: this.key,
      maxPending: this.maxPending,
      maxFailed: Math.max(1, Number(maxFailed) || this.maxPending),
      onOverflow: (error, { payload }) => this.#reportQueueError(error, payload),
    });
    this.running = false;
    this.closed = false;
    this.turn = 0;
    this.abortController = null;
    this.activity = Promise.resolve();
  }

  /** 排队一条新轮次输入，并唤醒驱动。 */
  followup(input, meta) { return this.#enqueue(LANE_TURN, input, true, meta); }

  /** 排队一条当前轮次的后续步骤输入，并尝试唤醒驱动。 */
  steer(input, meta) { return this.#enqueue(LANE_STEP, input, true, meta); }

  /** 排队一条当前轮次的后续步骤输入，但不唤醒空闲驱动。 */
  inject(input, meta) { return this.#enqueue(LANE_STEP, input, false, meta); }

  /** 等当前排队和运行中的工作全部结束。 */
  async whenIdle() {
    let activity;
    do {
      await (activity = this.activity);
    } while (activity !== this.activity);
  }

  /**
   * 取消当前轮并（默认）清空尚未冻结的队列。
   * 失败待重放的批次不随 cancel 丢弃：它们是已经收下的输入，只能被显式清空。
   */
  cancel({ keepInbox = false } = {}) {
    if (!keepInbox) this.inbox.clear();
    this.abortController?.abort();
  }

  /** 取消当前轮、清空收件箱（含失败区），并阻止之后继续入队。 */
  close() {
    if (this.closed) return this.activity;
    this.closed = true;
    this.abortController?.abort();
    this.inbox.clear({ includeFailed: true });
    return this.activity;
  }

  /** 队列里还没冻结的事件快照（观测/日志用）。 */
  pendingEvents(options) { return this.inbox.pendingEvents(options); }

  /** 失败留档、等待显式重放的批次。 */
  failedBatches() { return this.inbox.failedBatches(); }

  /** 把失败批次按原顺序放回队首，下一个轮次边界会重新消费。 */
  replayFailed(options) {
    if (this.closed) return 0;
    const count = this.inbox.replayFailed(options);
    if (count) this.#wake();
    return count;
  }

  #reportQueueError(error, input) {
    try {
      Promise.resolve(this.onError(error, { kind: 'queue-overflow', input })).catch(() => {});
    } catch { /* 上报失败不能中断入队 */ }
  }

  #enqueue(lane, input, wake, meta) {
    if (this.closed) return false;
    const { status } = this.inbox.enqueue(input, { ...meta, ...this.#identityOf(input, meta), lane });
    if (status === 'overflow') return false;
    if (status === 'duplicate') return true;
    if (wake) this.#wake();
    return true;
  }

  /**
   * 事件身份：调用方显式给出的 meta 优先；宿主直接把原始适配消息交进来时，
   * 用消息自带的 eventId / receiveSequence / receivedAt 兜底，保证同一条平台
   * 消息重复投递时拿到同一个 eventId。都没有就不传，由收件箱按 `key#序号` 生成。
   */
  #identityOf(input, meta) {
    const payload = isPlainObject(input) ? input : null;
    const provided = (value) => (value === undefined || value === null || value === '' ? undefined : value);
    return {
      eventId: provided(meta?.eventId) ?? provided(payload?.eventId),
      sequence: provided(meta?.sequence) ?? provided(payload?.receiveSequence),
      receivedAt: provided(meta?.receivedAt) ?? provided(payload?.receivedAt),
    };
  }

  #wake() {
    if (this.running || this.closed) return;
    // 只有队列里存在新轮次输入时才跑；只有 step 事件时保持空闲，避免空转。
    if (!this.inbox.hasLane(LANE_TURN)) return;
    this.running = true;
    this.activity = this.#drain().finally(() => {
      this.running = false;
      if (!this.closed && this.inbox.hasLane(LANE_TURN)) this.#wake();
    });
  }

  async #drain() {
    while (!this.closed) {
      // 没有新的 turn 事件就不开轮：step-only 的积压保持空闲，等下一次 followup。
      if (!this.inbox.hasLane(LANE_TURN)) break;
      // 轮次批次：当前排在前面的 step 事件 + 触发本轮的那条 turn 事件。
      // 收拢模式下不停在第一条 turn 事件：队列里已经排到的轮次输入全部冻进同一批。
      const batch = this.coalesceTurns
        ? this.inbox.freezeBatch({ lanes: [LANE_STEP, LANE_TURN], max: this.maxTurnBatchItems })
        : this.inbox.freezeBatch({ lanes: [LANE_STEP, LANE_TURN], stopAt: LANE_TURN });
      if (!batch) break;
      this.turn += 1;
      let step = 0;
      while (!this.closed) {
        // 第 0 步就是上面冻结的那批；之后的 step 只取冻结之后新到的 step 事件，
        // 期间到达的新轮次输入留在队列里，等下一轮。
        const stepBatch = step === 0 ? batch : this.inbox.freezeBatch({ lanes: [LANE_STEP] });
        if (!stepBatch) break;
        const controller = new AbortController();
        this.abortController = controller;
        try {
          await this.onTurn(stepBatch.inputs, {
            turn: this.turn,
            step,
            loop: this,
            signal: controller.signal,
            batchId: stepBatch.batchId,
            frozenAt: stepBatch.frozenAt,
            attempts: stepBatch.attempts,
            events: stepBatch.events.map((event) => ({
              eventId: event.eventId,
              sequence: event.sequence,
              receivedAt: event.receivedAt,
              lane: event.lane,
            })),
            task: null,
            tasks: [],
            inbox: this.inbox,
          });
          this.inbox.ackBatch(stepBatch);
        } catch (error) {
          await this.#settleFailedBatch(stepBatch, error, controller, step);
        } finally {
          if (this.abortController === controller) this.abortController = null;
        }
        step += 1;
      }
    }
  }

  /** 失败批次：中断按已消费处理，其余要么有界重放回队首，要么留档等显式重放。 */
  async #settleFailedBatch(batch, error, controller, step) {
    let outcome;
    if (controller.signal.aborted) {
      this.inbox.ackBatch(batch);
      outcome = 'aborted';
    } else if (batch.attempts + 1 < this.maxAttempts) {
      this.inbox.requeue(batch);
      outcome = 'requeued';
    } else {
      this.inbox.failBatch(batch, { error });
      outcome = 'failed';
    }
    // onError 自己抛错或返回 rejected Promise 都不能变成未处理拒绝，也不能停掉驱动。
    try {
      await this.onError(error, {
        turn: this.turn,
        step,
        batch: batch.inputs,
        batchId: batch.batchId,
        frozenAt: batch.frozenAt,
        attempts: batch.attempts,
        events: batch.events.map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          receivedAt: event.receivedAt,
          lane: event.lane,
        })),
        task: null,
        tasks: [],
        outcome,
        inbox: this.inbox,
      });
    } catch { /* 上报失败不能中断驱动 */ }
  }
}

export default AgentLoop;