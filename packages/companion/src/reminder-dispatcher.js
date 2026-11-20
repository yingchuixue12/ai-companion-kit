/**
 * 提醒派发 · 每次只推进一条提醒
 * ─────────────────────────────────────────────────────────────
 * 把「落盘的提醒」接到「真正发出去」这一小步上：
 *
 *   const dispatcher = createReminderDispatcher('/path/to/reminders.json', { send });
 *   await dispatcher.dispatchNext();   // { ok:true, result:null | {taskId, status} }
 *
 * ── 选哪一条 ────────────────────────────────────────────────
 *   每次调用只处理**最多一条**。先读快照，用 classifyReminderRecovery
 *   逐条分类，只留下 due / expired / canceled 三种：
 *     due       到期，需要发送
 *     expired   过期，落终态、不发送
 *     canceled  主动回访已逾期，落终态、不发送
 *   其余分类一律跳过：queued 还没到点，pending（processing / unknown /
 *   已经触发过）结果未确认，terminal（sent / partial / failed / canceled /
 *   expired）永不复活。所以下次 tick、或另一个刚启动的实例，都只会看到
 *   due / expired / canceled，不会重发已经触发过的提醒。
 *   候选按 dueAt 升序；dueAt 相同按 taskId 的码元顺序稳定破同分。
 *
 * ── 一条提醒怎么走完 ────────────────────────────────────────
 *   expired / canceled：
 *     同步写回终态（status 改成该分类），再返回
 *     { ok:true, result:{ taskId, status } }；全程不调用 send。
 *
 *   due：
 *     1. 在**第一次 await 之前**同步落盘 claim：
 *        { status:'processing', attempt:1, firedAt:now }
 *        写失败就把 store 的失败对象原样返回，send 一次都不会被调用。
 *        因为写入是同步完成的，同一进程里任何重入的读都会看到 processing，
 *        从而把它归为 pending —— 不需要额外的全局锁。
 *     2. await send({ taskId, conversationKey, text, dueAt, lateByMs })。
 *        只有返回字符串且精确等于 sent / partial / failed / unknown 才采纳；
 *        抛错、返回别的值、返回带空白的字符串，一律记 unknown。
 *     3. await 之后重新从磁盘读一遍，按 claim 身份（taskId + conversationKey
 *        + status + attempt + firedAt）找到自己的记录，只改它的 status，
 *        其余记录原样保留 —— await 期间别的任务新建或取消都不会被覆盖。
 *        记录消失了、或者已经被别人改过，就不写盘，返回
 *        { ok:false, error:'claim-conflict' }，绝不覆盖对方的版本。
 *     4. 合并结果保存失败时返回 store 的实际错误；那条记录留在 processing，
 *        不会被自动重发，等显式对账。
 *
 * ── 时钟与失败语义 ──────────────────────────────────────────
 *   now() 必须返回非负安全整数，否则 { ok:false, error:'invalid-clock' }，
 *   不读不写。load / save 失败都返回 store 自己的 { ok:false, error }。
 *   意外异常统一收成 { ok:false, error:'internal-error' }。
 *
 * ── 单进程单写者与重入 ──────────────────────────────────────
 *   本模块不加锁、不做跨进程互斥：同一个快照文件必须只由一个进程的这台
 *   dispatcher 写入。同一实例内的重叠调用按**排队等待**处理——后一次调用
 *   等前一次彻底结束（包括 send 与合并落盘）后再读快照选下一条，因此同一
 *   实例永远不会并发派发，也不会出现自己抢自己的 claim-conflict。
 *   两个进程共享同一文件时，这种排队不负责任何互斥保证。
 *
 *   不装定时器、不发网络以外的动作、不迁移旧数据；父目录由调用方准备。
 */
import { createReminderStore } from './reminder-store.js';
import { classifyReminderRecovery } from './reminder-recovery.js';
import { DELIVERY_TASK_STATUSES } from './task-status.js';

/** 需要本模块处理的恢复分类。 */
const DISPATCHABLE_KINDS = new Set(['due', 'expired', 'canceled']);
/** send 唯一被采纳的返回值：复用共享的送达结果词表。 */
const SEND_OUTCOMES = new Set(DELIVERY_TASK_STATUSES);
/** claim 期间的状态：落盘后即被视为已触发、不可重发。 */
const CLAIM_STATUS = 'processing';

/** 读时钟；抛错或不是非负安全整数时返回 null。 */
function readClock(now) {
  let value;
  try {
    value = now();
  } catch {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 用恢复分类判断一条记录该不该处理。
 * proactive 是存储里的独立字段，恢复分类从 input.proactive 读，这里显式投影。
 */
function classifyForDispatch(record, now) {
  return classifyReminderRecovery(
    {
      status: record.status,
      dueAt: record.dueAt,
      attempt: record.attempt,
      firedAt: record.firedAt,
      input: { proactive: record.proactive },
    },
    now,
  );
}

/**
 * 选出最早到期的一条候选；没有候选返回 null。
 * 排序键：dueAt 升序，然后 taskId 码元顺序（与 reminder-service.list 一致）。
 */
function selectNext(records, now) {
  let picked = null;
  for (const record of records) {
    const verdict = classifyForDispatch(record, now);
    if (!DISPATCHABLE_KINDS.has(verdict.kind)) continue;
    if (picked === null) {
      picked = { record, verdict };
      continue;
    }
    if (record.dueAt !== picked.record.dueAt) {
      if (record.dueAt < picked.record.dueAt) picked = { record, verdict };
      continue;
    }
    if (record.taskId < picked.record.taskId) picked = { record, verdict };
  }
  return picked;
}

/** 用一条记录替换同 taskId 的记录，返回新数组；不改变输入。 */
function replaceRecord(records, taskId, next) {
  return records.map((record) => (record.taskId === taskId ? next : record));
}

/** claim 身份：await 之后必须逐项相符，才承认这条记录还是我们的。 */
function isSameClaim(record, claim) {
  return (
    record.taskId === claim.taskId &&
    record.conversationKey === claim.conversationKey &&
    record.status === claim.status &&
    record.attempt === claim.attempt &&
    record.firedAt === claim.firedAt
  );
}

/** 调 send 并把结果收成四个状态之一；任何异常或陌生返回值都是 unknown。 */
async function runSend(send, record, lateByMs) {
  let reply;
  try {
    reply = await send({
      taskId: record.taskId,
      conversationKey: record.conversationKey,
      text: record.text,
      dueAt: record.dueAt,
      lateByMs,
    });
  } catch {
    return 'unknown';
  }
  return typeof reply === 'string' && SEND_OUTCOMES.has(reply) ? reply : 'unknown';
}

/**
 * 创建一个绑定到单个提醒快照文件的派发器。
 *
 * @param {string} file 提醒快照文件路径（父目录由调用方准备）
 * @param {{send: (delivery: object) => unknown, now?: () => number}} options
 *   send  投递一条提醒，可返回 Promise；now 返回当前毫秒时间（便于离线验证）
 * @returns {{dispatchNext: () => Promise<object>}}
 */
export function createReminderDispatcher(file, { send, now = Date.now } = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createReminderDispatcher: send must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createReminderDispatcher: now must be a function');
  }

  // 文件路径的校验交给 store：它是快照文件的唯一所有者。
  const store = createReminderStore(file);

  /**
   * 处理一条提醒。全程串行：调用时已经持有本实例的排队权。
   * @returns {Promise<object>} {ok:true,result} 或 {ok:false,error}
   */
  async function dispatchOnce() {
    const current = readClock(now);
    if (current === null) return { ok: false, error: 'invalid-clock' };

    const loaded = store.load();
    if (!loaded.ok) return loaded;

    const picked = selectNext(loaded.records, current);
    if (picked === null) return { ok: true, result: null };

    const { record, verdict } = picked;

    // 终态：只落盘，不发送。
    if (verdict.kind !== 'due') {
      const status = verdict.kind;
      const saved = store.save(
        replaceRecord(loaded.records, record.taskId, { ...record, status }),
      );
      if (!saved.ok) return saved;
      return { ok: true, result: { taskId: record.taskId, status } };
    }

    // due：在第一次 await 之前同步 claim，重入的读会看到 processing。
    const claim = {
      ...record,
      status: CLAIM_STATUS,
      attempt: 1,
      firedAt: current,
    };
    const claimed = store.save(replaceRecord(loaded.records, record.taskId, claim));
    // claim 失败：原错误返回，send 绝不被调用，记录仍是 due。
    if (!claimed.ok) return claimed;

    const status = await runSend(send, record, verdict.lateByMs);

    // await 之后重读，只合并自己那一条，保留期间别人的新建 / 取消。
    const fresh = store.load();
    if (!fresh.ok) return fresh;

    const index = fresh.records.findIndex((item) => item.taskId === record.taskId);
    if (index === -1) return { ok: false, error: 'claim-conflict' };

    const mine = fresh.records[index];
    if (!isSameClaim(mine, claim)) return { ok: false, error: 'claim-conflict' };

    const merged = fresh.records.slice();
    merged[index] = { ...mine, status };
    const saved = store.save(merged);
    // 合并保存失败：返回 store 的实际错误，记录留在 processing，不自动重发。
    if (!saved.ok) return saved;

    return { ok: true, result: { taskId: record.taskId, status } };
  }

  /** 本实例的排队尾：后一次调用等前一次彻底结束，绝不并发派发。 */
  let tail = Promise.resolve();

  /**
   * 处理最多一条提醒。同一实例的重叠调用会排队，不会并行。
   * @returns {Promise<object>} {ok:true,result:null|{taskId,status}} 或 {ok:false,error}
   */
  function dispatchNext() {
    const run = tail.then(dispatchOnce, dispatchOnce);
    // 排队尾永远收敛：上一次失败也不能卡死后续调用。
    tail = run.then(() => undefined, () => undefined);
    return run.then(
      (result) => result,
      () => ({ ok: false, error: 'internal-error' }),
    );
  }

  return { dispatchNext };
}
