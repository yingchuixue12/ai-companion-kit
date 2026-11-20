/**
 * 私聊失败批次重放 · 宿主专用
 * ─────────────────────────────────────────────────────────────
 * 只服务一种失败：Brain.reply 在“生成阶段”拒绝。此时原批次已经被
 * ConversationWindow 冻结，消息原文、eventId、batchId 都不能再改写，
 * 所以这里按原 batchId 留一份记录，等宿主显式调用 replay 再跑一次。
 *
 * 边界：
 * - 不记录原始异常（异常里可能带模型响应或正文），只留 batchId / key /
 *   attempts / failedAt 这类元数据；
 * - 不自动重试，也不拆批：replay 用的是同一个 batch 和同一组 items；
 * - 发送拒绝/未知/部分、静默、干跑成功、记忆提交失败都不在这里留记录；
 * - 一旦生成成功（哪怕随后发送失败）就移除记录，不再提供重放；
 * - 同一个 batch 同时只允许一个显式 replay 在跑：在加入串行队列之前
 *   标记 inFlight，队列拒绝或任务结束时清除；
 * - 全局记录数有上限；淘汰时跳过 inFlight 的批次，避免把正在重放的批次删掉。
 */

const DEFAULT_LIMIT = 64;

function replayError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {object} opts
 * @param {(key: string, job: () => any) => Promise<any>} opts.runSerial
 *   窗口的串行入口（ConversationWindow.runSerial），保证与普通批次同队列。
 * @param {(record: object, hooks: {onGenerationError: Function, onGenerationSuccess: Function}) => any} opts.runTurn
 *   用记录里的原批次再跑一次 handleTurn。
 * @param {number} [opts.maxFailed] 全局最多保留多少条失败批次。
 */
export function createPrivateTurnReplay({ runSerial, runTurn, maxFailed }) {
  const limit = Number.isSafeInteger(maxFailed) && maxFailed > 0
    ? Math.min(maxFailed, DEFAULT_LIMIT) : DEFAULT_LIMIT;
  /** @type {Map<string, {batchId: string, key: string, batch: object, items: any[], attempts: number, failedAt: string, inFlight: boolean}>} */
  const records = new Map();

  /** 只淘汰最老且不在重放中的一条；全都 inFlight 时返回 false。 */
  function evictOldestIdle() {
    for (const [batchId, record] of records) {
      if (!record.inFlight) {
        records.delete(batchId);
        return true;
      }
    }
    return false;
  }

  /**
   * 生成阶段失败时留档。故意不收 error 参数：原始异常不进入记录。
   * @param {{items: any[], batch: object}} context
   * @returns {boolean} 是否成功留档（达到上限且没有可淘汰项时为 false）
   */
  function remember({ items, batch }) {
    const { batchId, key } = batch;
    if (records.size >= limit && !evictOldestIdle()) return false;
    records.set(batchId, {
      batchId,
      key,
      batch,
      items,
      attempts: 1,
      failedAt: new Date().toISOString(),
      inFlight: false,
    });
    return true;
  }

  /**
   * 失败批次元数据快照。只含 batchId 等元数据，不含 items / 正文 / 异常。
   * @param {string} [key] 只列这个会话的批次；省略则列全部。
   */
  function list(key) {
    const wanted = key === undefined || key === null ? null : String(key);
    const out = [];
    for (const record of records.values()) {
      if (wanted !== null && record.key !== wanted) continue;
      out.push({
        batchId: record.batchId,
        key: record.key,
        attempts: record.attempts,
        failedAt: record.failedAt,
      });
    }
    return out;
  }

  /**
   * 显式重放一个失败批次。
   * 串行由 window.runSerial 保证；同 batch 的并发请求在进入 FIFO 前就被拒绝。
   * 生成再次失败时保留原记录；生成成功时立刻移除（之后发送失败也不再重放）。
   * @param {string} key 会话 key
   * @param {string} batchId 原窗口批次 id
   * @returns {Promise<any>}
   */
  async function replay(key, batchId) {
    const record = records.get(batchId);
    if (!record || record.key !== key) {
      throw replayError('找不到可重放的私聊批次', 'private-batch-not-found');
    }
    if (record.inFlight) {
      throw replayError('这个私聊批次正在重放', 'private-batch-in-flight');
    }
    // 必须在加入 FIFO 之前标记：否则两个并发请求会同时排进队列。
    record.inFlight = true;

    const onGenerationError = () => {
      record.attempts += 1;
      record.failedAt = new Date().toISOString();
    };
    const onGenerationSuccess = () => { records.delete(batchId); };

    try {
      return await runSerial(key, () => runTurn(record, { onGenerationError, onGenerationSuccess }));
    } finally {
      record.inFlight = false;
    }
  }

  return { remember, list, replay };
}

