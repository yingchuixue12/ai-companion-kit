/**
 * 提醒服务 · 在会话边界内创建、列出、取消一次性提醒
 * ─────────────────────────────────────────────────────────────
 * 把三块已有能力接成一条可持久化的会话内流程：
 *
 *   relative-reminder.js  只解析明确的「<数字><单位>后提醒我<内容>」
 *   reminder-store.js     按固定 schema 原子落盘、严格读回
 *   reminder-service.js   绑定 conversationKey，校验时钟与 id，收窄公开结果
 *
 *   const service = createReminderService('/path/to/reminders.json');
 *   service.create('private:10001', '30分钟后提醒我收衣服');
 *   service.list('private:10001');
 *   service.cancel('private:10001', taskId);
 *
 * ── 共同校验 ────────────────────────────────────────────────
 *   conversationKey 与 taskId 都必须是字符串、去掉头尾空白后非空、且
 *   ≤128 个 UTF-16 字符。服务不做 trim 后的改写：校验用 trim，保存和比较
 *   仍用原字符串，所以 `' private:1 '` 与 `'private:1'` 是两个不同的会话。
 *
 * ── create(conversationKey, raw) ────────────────────────────
 *   只有 parseRelativeReminder 明确解析成功才会落盘，不做任何模糊兜底。
 *   成功记录固定为 status 'queued'，dueAt = now() + delayMs：
 *     { ok:true, taskId, dueAt, status:'queued' }
 *   now() 必须返回非负安全整数；相加后的 dueAt 也必须是安全整数，
 *   溢出时拒绝，不写任何东西。taskId 由 newId() 生成并经过同一套 id 校验；
 *   重复 id 不在这里去重或换号，直接交给 store.save 拒绝。
 *
 *   输入或时钟不合法时返回结构化失败（不抛异常）：
 *     { ok:false, error:'invalid-conversation-key' }
 *     { ok:false, error:'invalid-reminder' }       raw 解析失败
 *     { ok:false, error:'invalid-clock' }          now() 非安全整数 / 相加溢出
 *     { ok:false, error:'invalid-task-id' }        newId() 不可用
 *
 * ── list(conversationKey, {pendingOnly}) ────────────────────
 *   只返回 conversationKey 完全相等的记录。默认返回全部状态；传
 *   {pendingOnly:true} 时只保留 created/queued/due，并在排序与截断前过滤。
 *   排序为 dueAt 升序，dueAt 相同时按 taskId 的码元顺序稳定破同分；
 *   最多返回 20 条，超过时 truncated:true。
 *     { ok:true, reminders:[{taskId,text,dueAt,status}], truncated:boolean }
 *   attempt / firedAt / proactive 属于投递内部事实，conversationKey 属于
 *   会话边界，都不出现在公开列表里。
 *
 * ── cancel(conversationKey, taskId) ─────────────────────────
 *   只按「当前会话 + 精确 taskId」查找；同 id 在别的会话里等同于不存在。
 *     - 找不到：{ ok:false, error:'not-found' }，不写盘；
 *     - 已是 canceled：幂等成功，不写盘；
 *     - 只有 status 为 created/queued/due 且尚未触发（attempt 为 0、
 *       firedAt 为 null）才改成 canceled 并保存；
 *     - 其他状态一律不改，返回 { ok:false, error:'not-cancelable' }，不写盘。
 *   成功结果：{ ok:true, taskId, status:'canceled' }
 *
 * ── 失败语义与并发 ──────────────────────────────────────────
 *   三个公开操作每一次都重新调用 store.load()，不使用内存缓存；任何
 *   load / save 失败都把 store 返回的对象原样返回，绝不会用一份旧内存
 *   快照覆盖磁盘。store 自身的单进程单写者假设保持不变：本服务不加锁，
 *   同一文件的调用仍需串行。不装定时器、不发网络、不接模型或配置。
 */
import { randomUUID } from 'node:crypto';

import { createReminderStore } from './reminder-store.js';
import { parseRelativeReminder } from './relative-reminder.js';

/** 会话键与任务 id 的最大长度（UTF-16 字符）。 */
const MAX_IDENTIFIER_LENGTH = 128;

/** list 一次最多返回多少条。 */
const MAX_LISTED_REMINDERS = 20;

/** 待提醒状态；cancel 另外还要求尚未触发过。 */
const PENDING_STATUSES = new Set(['created', 'queued', 'due']);

/** 统一的失败结果；store 的错误不走这里，而是原样返回。 */
function failure(error) {
  return { ok: false, error };
}

/**
 * 标识符必须是字符串、非纯空白、长度不超过 128。
 * 只做判断，不改变调用方给的原始字符串。
 */
function isValidIdentifier(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * list 的排序：dueAt 升序；dueAt 相同按 taskId 码元顺序，保证结果稳定。
 */
function compareReminders(left, right) {
  if (left.dueAt !== right.dueAt) return left.dueAt < right.dueAt ? -1 : 1;
  if (left.taskId === right.taskId) return 0;
  return left.taskId < right.taskId ? -1 : 1;
}

/** 公开列表只暴露这四个字段，投递内部字段与会话键都不外传。 */
function toPublicReminder(record) {
  return {
    taskId: record.taskId,
    text: record.text,
    dueAt: record.dueAt,
    status: record.status,
  };
}

/**
 * 创建一个绑定到单个提醒快照文件的服务。
 *
 * @param {string} file 提醒快照文件路径
 * @param {{now?: () => number, newId?: () => string}} [options]
 *   now  返回当前毫秒时间；newId 返回新任务 id。两者都可注入用于离线验证。
 * @returns {{
 *   create: (conversationKey: string, raw: string) => object,
 *   list: (conversationKey: string) => object,
 *   cancel: (conversationKey: string, taskId: string) => object,
 * }}
 */
export function createReminderService(file, { now = Date.now, newId = randomUUID } = {}) {
  if (typeof now !== 'function') {
    throw new TypeError('createReminderService: now must be a function');
  }
  if (typeof newId !== 'function') {
    throw new TypeError('createReminderService: newId must be a function');
  }

  // 文件路径的校验交给 store：它是快照文件的唯一所有者。
  const store = createReminderStore(file);

  /**
   * 明确解析一条相对时间提醒，并写入 queued 记录。
   *
   * @param {string} conversationKey 当前会话键
   * @param {string} raw 用户原文
   * @returns {object} 成功 {ok:true,taskId,dueAt,status}；失败 {ok:false,error}
   */
  function create(conversationKey, raw) {
    if (!isValidIdentifier(conversationKey)) {
      return failure('invalid-conversation-key');
    }

    const parsed = parseRelativeReminder(raw);
    if (!parsed) return failure('invalid-reminder');

    let current;
    try {
      current = now();
    } catch {
      return failure('invalid-clock');
    }
    if (!Number.isSafeInteger(current) || current < 0) return failure('invalid-clock');

    const dueAt = current + parsed.delayMs;
    // 两个非负安全整数相加仍可能越过 2^53-1；溢出绝不落盘。
    if (!Number.isSafeInteger(dueAt) || dueAt < 0) return failure('invalid-clock');

    let taskId;
    try {
      taskId = newId();
    } catch {
      return failure('invalid-task-id');
    }
    if (!isValidIdentifier(taskId)) return failure('invalid-task-id');

    // 每次都从盘上读当前快照；读失败原样返回，绝不拿空数组继续写。
    const loaded = store.load();
    if (!loaded.ok) return loaded;

    const record = {
      taskId,
      conversationKey,
      text: parsed.text,
      dueAt,
      status: 'queued',
    };

    // 重复 id 不做内存去重：交给 store 的白名单 / 唯一性校验拒绝。
    const saved = store.save([...loaded.records, record]);
    if (!saved.ok) return saved;

    return { ok: true, taskId, dueAt, status: 'queued' };
  }

  /**
   * 列出当前会话的提醒；dueAt 升序，最多 20 条。
   *
   * @param {string} conversationKey 当前会话键
   * @param {{pendingOnly?: boolean}} [options] 只返回 created/queued/due
   * @returns {object} 成功 {ok:true,reminders,truncated}；失败 {ok:false,error}
   */
  function list(conversationKey, { pendingOnly = false } = {}) {
    if (!isValidIdentifier(conversationKey)) {
      return failure('invalid-conversation-key');
    }

    const loaded = store.load();
    if (!loaded.ok) return loaded;

    const reminders = loaded.records
      .filter((record) => record.conversationKey === conversationKey
        && (!pendingOnly || PENDING_STATUSES.has(record.status)))
      .sort(compareReminders);
    const truncated = reminders.length > MAX_LISTED_REMINDERS;

    return {
      ok: true,
      reminders: reminders.slice(0, MAX_LISTED_REMINDERS).map(toPublicReminder),
      truncated,
    };
  }

  /**
   * 取消当前会话里一个尚未触发的提醒。
   *
   * @param {string} conversationKey 当前会话键
   * @param {string} taskId 精确任务 id
   * @returns {object} 成功 {ok:true,taskId,status:'canceled'}；失败 {ok:false,error}
   */
  function cancel(conversationKey, taskId) {
    if (!isValidIdentifier(conversationKey)) {
      return failure('invalid-conversation-key');
    }
    if (!isValidIdentifier(taskId)) return failure('invalid-task-id');

    const loaded = store.load();
    if (!loaded.ok) return loaded;

    // 会话键与 id 必须同时相等；别的会话里的同 id 等同于不存在。
    const index = loaded.records.findIndex(
      (record) => record.conversationKey === conversationKey && record.taskId === taskId,
    );
    if (index === -1) return failure('not-found');

    const record = loaded.records[index];
    // 已经取消过：幂等成功，不重复写盘。
    if (record.status === 'canceled') {
      return { ok: true, taskId, status: 'canceled' };
    }

    const notFired = record.attempt === 0 && record.firedAt === null;
    if (!PENDING_STATUSES.has(record.status) || !notFired) {
      return failure('not-cancelable');
    }

    const records = loaded.records.slice();
    records[index] = { ...record, status: 'canceled' };

    const saved = store.save(records);
    if (!saved.ok) return saved;

    return { ok: true, taskId, status: 'canceled' };
  }

  return { create, list, cancel };
}