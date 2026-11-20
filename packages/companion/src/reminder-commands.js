/**
 * 提醒命令 · 主人私聊里的明确命令
 * ─────────────────────────────────────────────────────────────
 * 只识别三种主人私聊命令，并复用 reminder-service 落盘：
 *
 *   5分钟后提醒我喝水        → create
 *   查看提醒                  → list
 *   取消提醒 <完整任务 ID>    → cancel
 *
 * 边界：
 *   - 只认 private:<规范十进制 id>，userId 与 key 里的 id 必须一致且在白名单；
 *   - 只认单行整句；相对时间只走 parseRelativeReminder，不做模糊解析；
 *   - 明确的提醒意图但缺时间 / 缺正文 / 时间词不认识时，固定回一句澄清；
 *     普通叙述里顺带出现“提醒我”不算命令，原样交给生成链；
 *   - create / cancel 先落盘成功才回确认；list 只读当前会话；
 *   - 确认直接调用 send（生产环境是 bot.sendPrivateText），只发一次，
 *     不重试、不外抛异常、不拼接异常正文；
 *   - 不读配置、不装定时器、不联网；dataDir 与 reminder-runtime 共用。
 */
import path from 'node:path';

import { createReminderService } from './reminder-service.js';
import { parseRelativeReminder } from './relative-reminder.js';

/** 规范十进制正整数（发送者 id 与白名单项）。 */
const DECIMAL_ID = /^[1-9]\d*$/u;
/** 单行约束：出现任一字符即不是命令。 */
const LINE_BREAK_PATTERN = /[\n\r\u2028\u2029]/u;
/** 与 reminder-service / store 保持一致。 */
const MAX_TASK_ID_LENGTH = 128;
/** 与 reminder-runtime 共用同一个快照文件。 */
const REMINDER_FILE_NAME = 'reminders.json';

/** 查看命令必须整句相等。 */
const LIST_COMMANDS = new Set([
  '查看提醒',
  '查看我的提醒',
  '查看提醒列表',
  '提醒列表',
  '我的提醒',
]);

/** 取消命令固定前缀；后面必须是完整任务 id。 */
const CANCEL_PREFIX = '取消提醒';

/** 明确但模糊的提醒命令统一回这一句。 */
const CLARIFY_REMINDER = '我还不太明白这条提醒：请说清多久之后、提醒你什么，例如：5分钟后提醒我喝水。';
/** 取消命令缺 id / id 不完整时统一回这一句。 */
const CLARIFY_CANCEL = '取消提醒需要完整的任务 ID，可以先用“查看提醒”查到。';

/** 固定回复，不把异常或正文拼进失败路径。 */
const REPLIES = Object.freeze({
  createFailed: '没能记下这条提醒，稍后再试。',
  listEmpty: '现在没有待提醒的事。',
  listFailed: '暂时查不了提醒，稍后再试。',
  cancelNotFound: '没找到这个任务 ID，可能已经取消或触发过了。',
  cancelNotCancelable: '这条提醒已经触发或正在发送，不能取消了。',
  cancelFailed: '暂时取消不了这条提醒，稍后再试。',
  genericFailed: '暂时处理不了提醒，稍后再试。',
});

/** 固定日志：不带异常、正文或 id。 */
const FAILURE_LOG = '[提醒] 命令处理失败';

/** 句首的提醒意图；提醒一下/提醒下 只在没有第三人称宾语时算命令。 */
const REMINDER_INTENT = /^(?:(?:请|麻烦|帮我|帮忙|记得|别忘了)\s*)?(?:提醒我|(?:提醒一下|提醒下)(?=$|[，,。！？!?、：:]|我))/u;

/** 句首模糊时间词：带“提醒我”时只做澄清。 */
const VAGUE_TIME_PREFIX = /^(?:一会儿|一会|待会|待会儿|晚点|等会|等会儿|过会|过一会儿|马上|立刻|稍后|过阵子|改天|半小时|半个小时|半天|明天|后天|今天|今晚|明早|下周|下个月)/u;

/** 数字开头、带“后”、但 parseRelativeReminder 没接住的时间形状。 */
const NUMERIC_TIME_PREFIX = /^\d+(?:\.\d+)?\s*[^\s，,。！？!?]{0,8}\s*后/u;

/** 白名单只接受规范十进制字符串或正安全整数。 */
function normalizeOwnerIds(ownerIds) {
  const owners = new Set();
  if (!ownerIds) return owners;
  const list = Array.isArray(ownerIds) ? ownerIds : (ownerIds instanceof Set ? [...ownerIds] : []);
  for (const value of list) {
    if (typeof value === 'string' && DECIMAL_ID.test(value)) owners.add(value);
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      owners.add(String(value));
    }
  }
  return owners;
}

/** 主人私聊：userId 规范、key 与 userId 对应、且在白名单里。 */
function ownerPrivateTarget(msg, owners) {
  if (!msg || typeof msg !== 'object' || msg.isGroup) return null;
  if (typeof msg.userId !== 'string' || !DECIMAL_ID.test(msg.userId)) return null;
  if (msg.key !== 'private:' + msg.userId) return null;
  if (!owners.has(msg.userId)) return null;
  return { userId: msg.userId, conversationKey: 'private:' + msg.userId };
}

/** 明确但解析不出完整相对时间的命令形状。 */
function isAmbiguousReminderCommand(text) {
  if (REMINDER_INTENT.test(text)) return true;
  if (text.includes('提醒我') && VAGUE_TIME_PREFIX.test(text)) return true;
  if (text.includes('提醒我') && NUMERIC_TIME_PREFIX.test(text)) return true;
  return false;
}

/**
 * 只解析文本本身；返回 null 表示不是命令。
 * @param {unknown} raw
 * @returns {{kind: 'create', raw: string, text: string, delayMs: number}
 *   | {kind: 'list'}
 *   | {kind: 'cancel', taskId: string}
 *   | {kind: 'clarify', reason: string}
 *   | null}
 */
export function parseReminderCommand(raw) {
  if (typeof raw !== 'string') return null;
  if (LINE_BREAK_PATTERN.test(raw)) return null;

  const text = raw.trim();
  if (!text) return null;

  if (LIST_COMMANDS.has(text)) return { kind: 'list' };

  // 只认独立的“取消提醒”，或后面紧跟空白 / 中英文冒号再接完整 id。
  if (text === CANCEL_PREFIX) return { kind: 'clarify', reason: 'cancel-task-id' };

  const cancel = /^取消提醒(?:\s*[:：]\s*|\s+)(.*)$/u.exec(text);
  if (cancel) {
    const taskId = cancel[1].trim();
    if (!taskId || /[\s\u3000]/u.test(taskId) || taskId.length > MAX_TASK_ID_LENGTH) {
      return { kind: 'clarify', reason: 'cancel-task-id' };
    }
    return { kind: 'cancel', taskId };
  }

  const reminder = parseRelativeReminder(text);
  if (reminder) {
    return { kind: 'create', raw: text, text: reminder.text };
  }

  if (isAmbiguousReminderCommand(text)) return { kind: 'clarify', reason: 'ambiguous-reminder' };
  return null;
}

/** ISO UTC，不依赖运行机器的本地时区。 */
function formatDueAt(dueAt) {
  return new Date(dueAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, ' UTC');
}

/**
 * 创建绑定到 dataDir/reminders.json 的命令处理器。
 *
 * @param {object} [options]
 * @param {string} options.dataDir 数据目录（必填）
 * @param {Iterable<string|number>} [options.ownerIds] 主人白名单
 * @param {(userId: string, text: string) => any} options.send 命令确认发送
 * @param {() => void} [options.onError] 固定失败报告
 * @returns {{classify: (msg: object) => object|null, handle: (plan: object) => Promise<void>}}
 */
export function createReminderCommands({ dataDir, ownerIds, send, onError } = {}) {
  const owners = normalizeOwnerIds(ownerIds);
  const report = typeof onError === 'function' ? onError : () => { console.error(FAILURE_LOG); };
  const engine = createReminderService(path.join(dataDir, REMINDER_FILE_NAME));

  /** 识别一条消息；不抛异常、不落盘、不发消息。 */
  function classify(msg) {
    const target = ownerPrivateTarget(msg, owners);
    if (!target) return null;
    const command = parseReminderCommand(msg.text);
    return command ? { ...command, ...target } : null;
  }

  /** 把命令收成固定回复；预期失败都有固定文案。 */
  function replyFor(plan) {
    if (plan.kind === 'clarify') {
      return plan.reason === 'cancel-task-id' ? CLARIFY_CANCEL : CLARIFY_REMINDER;
    }

    if (plan.kind === 'create') {
      const result = engine.create(plan.conversationKey, plan.raw);
      if (!result || result.ok !== true) return REPLIES.createFailed;
      return '好，到点提醒你：' + plan.text
        + '\n任务 ID：' + result.taskId
        + '（取消：取消提醒 ' + result.taskId + '）';
    }

    if (plan.kind === 'list') {
      const result = engine.list(plan.conversationKey, { pendingOnly: true });
      if (!result || result.ok !== true) return REPLIES.listFailed;
      const active = result.reminders;
      if (!active.length) return REPLIES.listEmpty;
      const lines = active.map((item, index) => (index + 1) + '. '
        + formatDueAt(item.dueAt) + '｜' + item.text + '｜ID：' + item.taskId);
      const more = result.truncated ? '\n（还有更多，只显示前 20 条）' : '';
      return '当前会话的提醒：\n' + lines.join('\n') + more;
    }

    if (plan.kind === 'cancel') {
      const result = engine.cancel(plan.conversationKey, plan.taskId);
      if (result && result.ok === true) return '已取消提醒 ' + plan.taskId + '。';
      if (result?.error === 'not-found') return REPLIES.cancelNotFound;
      if (result?.error === 'not-cancelable') return REPLIES.cancelNotCancelable;
      return REPLIES.cancelFailed;
    }

    return REPLIES.genericFailed;
  }

  /**
   * 先落盘，成功才发确认；只发一次，异常只报固定日志。
   * @param {object} plan classify 的结果
   * @returns {Promise<void>}
   */
  async function handle(plan) {
    try {
      await send(plan.userId, replyFor(plan));
    } catch {
      report();
    }
  }

  return { classify, handle };
}

export default createReminderCommands;