/**
 * 提醒任务状态词表 · 纯常量
 * ────────────────────────────────────────────────────────────
 * 任务生命周期状态（flandre-target-design §5.1）：
 * created → queued → due → processing → delivery_pending → sent / partial / failed / unknown；
 * 以及终态 canceled / expired，和“已恢复但暂不触发”的 pending。
 *
 * 这里只放共享词表，不放任何判断逻辑：恢复分类（reminder-recovery）、
 * 派发（reminder-dispatcher）和 agent loop 都从这一份定义出发，
 * 避免同一个状态集合在多处各写一遍后悄悄走样。
 */

export const TASK_STATUSES = Object.freeze([
  'created', 'queued', 'due', 'processing', 'delivery_pending',
  'sent', 'partial', 'failed', 'unknown', 'canceled', 'expired', 'pending',
]);

/** 终态：普通重启不得复活（§5.4）。 */
export const TERMINAL_TASK_STATUSES = Object.freeze(['sent', 'partial', 'failed', 'canceled', 'expired']);

/** 调用方可以显式回填的投递结果状态（§5.1 / §5.3）。 */
export const DELIVERY_TASK_STATUSES = Object.freeze(['sent', 'partial', 'failed', 'unknown']);