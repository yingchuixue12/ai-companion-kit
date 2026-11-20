/**
 * 提醒恢复分类 · 纯函数
 * ────────────────────────────────────────────────────────────
 * 重启后按确定性规则判断一条已落盘的状态记录应该怎么办：
 *
 *   - 终态（sent/partial/failed/canceled/expired）原样保留，绝不复活；
 *   - 已经触发过（attempt > 0 / firedAt 非空）或处于
 *     processing/delivery_pending/unknown/pending 的记录，一律 pending，
 *     不自动重发，等显式对账；
 *   - created/queued/due 且未触发过的记录才可能重新排程：
 *       未来超过 7 天 -> expired（due-beyond-max-delay）
 *       未来          -> queued
 *       逾期主动回访  -> canceled（proactive-overdue）
 *       逾期超过 24h  -> expired（overdue-beyond-window）
 *       其余逾期      -> due
 *
 * 只接受白名单状态、非负安全整数时间；读不懂的记录返回 invalid，
 * 不猜状态、不误排程。函数无副作用，now 必须由调用方显式传入。
 *
 * 契约来源：docs/flandre-decisions.md A4/A5；
 * packages/companion/src/agent-loop.js #classifyRestored。
 */

export const MAX_SCHEDULE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 可以重新排程、但尚未触发过的状态。 */
const SCHEDULABLE_STATUSES = new Set(['created', 'queued', 'due']);
/** 已经触发过或结果未确认，只能待查、不能自动重发的状态。 */
const PENDING_STATUSES = new Set(['processing', 'delivery_pending', 'unknown', 'pending']);
/** 终态：优先保留，永不复活。 */
const TERMINAL_STATUSES = new Set(['sent', 'partial', 'failed', 'canceled', 'expired']);
const KNOWN_STATUSES = new Set([
  ...SCHEDULABLE_STATUSES,
  ...PENDING_STATUSES,
  ...TERMINAL_STATUSES,
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalid(reason = 'invalid-record') {
  return { kind: 'invalid', dueAt: null, lateByMs: null, reason };
}

function result(kind, dueAt, lateByMs, reason = null) {
  return { kind, dueAt, lateByMs, reason };
}

/**
 * 分类一条提醒状态记录。
 *
 * @param {object} record 状态记录：status、dueAt，可选 attempt、firedAt、input.proactive
 * @param {number} now 当前时间（毫秒），必须显式传入
 * @returns {{kind: string, dueAt: number|null, lateByMs: number|null, reason: string|null}}
 */
export function classifyReminderRecovery(record, now) {
  if (!isPlainObject(record)) return invalid();
  if (!KNOWN_STATUSES.has(record.status)) return invalid();
  if (!validTimestamp(record.dueAt)) return invalid();
  if (!validTimestamp(now)) return invalid();

  const attempt = record.attempt === undefined ? 0 : record.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 0) return invalid();

  const firedAt = record.firedAt === undefined ? null : record.firedAt;
  if (firedAt !== null && !validTimestamp(firedAt)) return invalid();

  const dueAt = record.dueAt;
  const lateByMs = Math.max(0, now - dueAt);

  // 终态优先：即使记录上留着尝试次数或触发时间，也不复活、不重发。
  if (TERMINAL_STATUSES.has(record.status)) {
    return result('terminal', dueAt, lateByMs);
  }

  // 已触发过、或处于待查状态：结果未确认，永不自动重发。
  if (attempt > 0 || firedAt !== null || PENDING_STATUSES.has(record.status)) {
    return result('pending', dueAt, lateByMs, 'unconfirmed');
  }

  // 走到这里只可能是 created/queued/due，且没有触发过。
  if (dueAt > now + MAX_SCHEDULE_DELAY_MS) {
    return result('expired', dueAt, lateByMs, 'due-beyond-max-delay');
  }
  if (dueAt > now) return result('queued', dueAt, lateByMs);

  const proactive = record.input?.proactive === true;
  if (proactive && lateByMs > 0) return result('canceled', dueAt, lateByMs, 'proactive-overdue');
  if (lateByMs > EXPIRE_AFTER_MS) {
    return result('expired', dueAt, lateByMs, 'overdue-beyond-window');
  }
  return result('due', dueAt, lateByMs);
}