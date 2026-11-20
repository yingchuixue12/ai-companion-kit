/**
 * 解析模型输出里的少量自主动作。
 * ─────────────────────────────────────────────────────────────
 * 动作必须单独占一行，解析后不会当成可见文字发给用户：
 *
 *   [[schedule:60000:过一会儿回来看看]]
 *   [[schedule:60000:check-in:过一会儿回来看看]]
 *   [[remember:trait:他喜欢深夜聊天]]
 *   [[remember:pending:还没问完那件事]]
 *   [[forget:trait:他喜欢深夜聊天]]
 *   [[replace:fact:旧地址=>新地址]]
 *   [[silent]]
 *
 * 边界：
 *   - 这里是纯解析：不执行动作、不写记忆、不装定时器、不联网；
 *   - 只有整行命中才算动作，普通可见文字原样保留（空行丢弃）；
 *   - schedule 沿用原实现的限额（1ms ~ 7 天、正文 500 字符、只留第一条）；
 *   - remember 保持原行为：非空即可，归一化和截断交给 Memory；
 *   - forget / replace 按 Memory 的归一化后校验长度（上限 160），
 *     超限或为空的行按普通可见文字处理；
 *   - 相对时间提醒的解析与常量统一来自 relative-reminder.js，
 *     这里不复制第二套正则，只转出原 actions 的同名常量与函数。
 */
import {
  MAX_RELATIVE_REMINDER_DELAY_MS,
  MAX_RELATIVE_REMINDER_TEXT_LENGTH,
  parseRelativeReminder,
} from './relative-reminder.js';

/** 与原 actions 的导出名兼容；数值取自 relative-reminder.js。 */
export const MAX_SCHEDULE_DELAY_MS = MAX_RELATIVE_REMINDER_DELAY_MS;
export const MAX_SCHEDULE_TEXT_LENGTH = MAX_RELATIVE_REMINDER_TEXT_LENGTH;
export const SCHEDULE_INTENTS = Object.freeze(['follow-up', 'check-in', 'reminder']);

export const MEMORY_ACTION_KINDS = Object.freeze(['trait', 'fact', 'topic', 'pending']);
/** 与 Memory 的条目上限（160）保持一致；超过上限的 forget/replace 行按非法控制行处理。 */
export const MAX_MEMORY_ACTION_TEXT_LENGTH = 160;

const REMEMBER_PATTERN = /^\[\[remember:(trait|fact|topic|pending):([\s\S]+)\]\]$/;
const FORGET_PATTERN = /^\[\[forget:(trait|fact|topic|pending):([\s\S]+)\]\]$/;
const REPLACE_PATTERN = /^\[\[replace:(trait|fact|topic|pending):([\s\S]+?)=>([\s\S]+)\]\]$/;

const SCHEDULE_WITH_INTENT_PATTERN = /^\[\[schedule:(\d{1,12}):([a-z-]{1,32}):([\s\S]*)\]\]$/;
const SCHEDULE_PATTERN = /^\[\[schedule:(\d{1,12}):([\s\S]*)\]\]$/;

/** 与 Memory.remember 的归一化保持一致，长度校验才有意义。 */
function normalizeMemoryActionText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function validMemoryActionText(value) {
  return Boolean(value) && value.length <= MAX_MEMORY_ACTION_TEXT_LENGTH;
}

/**
 * 把一段模型输出拆成「可见文字 + 动作列表」。
 *
 * @param {string} raw
 * @param {{silentToken?: string}} [options]
 * @returns {{text: string, silent: boolean, actions: Array<object>}}
 */
export function parseActions(raw, { silentToken = '[[silent]]' } = {}) {
  const lines = String(raw || '').split(/\r?\n/);
  const actions = [];
  const visible = [];

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    if (text === silentToken) {
      actions.push({ type: 'silent' });
      continue;
    }

    if (text.startsWith('[[schedule:')) {
      let match = text.match(SCHEDULE_WITH_INTENT_PATTERN);
      if (match || (match = text.match(SCHEDULE_PATTERN))) {
        const hasIntent = match.length === 4;
        const delayMs = Number(match[1]);
        const intent = hasIntent ? match[2] : 'follow-up';
        const taskText = (hasIntent ? match[3] : match[2]).trim();
        if (Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= MAX_SCHEDULE_DELAY_MS
          && SCHEDULE_INTENTS.includes(intent) && taskText.length > 0 && taskText.length <= MAX_SCHEDULE_TEXT_LENGTH
          && !actions.some((action) => action.type === 'schedule')) {
          actions.push({ type: 'schedule', intent, delayMs, text: taskText });
        }
      }
      continue;
    }

    let match = text.match(REMEMBER_PATTERN);
    if (match) {
      // 保持原有 remember 行为：任何非空内容都接受，由 Memory 负责归一化和截断。
      actions.push({ type: 'remember', kind: match[1], text: match[2].trim() });
      continue;
    }

    match = text.match(FORGET_PATTERN);
    if (match) {
      const entry = normalizeMemoryActionText(match[2]);
      if (validMemoryActionText(entry)) {
        actions.push({ type: 'forget', kind: match[1], text: entry });
        continue;
      }
      visible.push(line);
      continue;
    }

    match = text.match(REPLACE_PATTERN);
    if (match) {
      const from = normalizeMemoryActionText(match[2]);
      const to = normalizeMemoryActionText(match[3]);
      if (validMemoryActionText(from) && validMemoryActionText(to)) {
        actions.push({ type: 'replace', kind: match[1], from, to });
        continue;
      }
      visible.push(line);
      continue;
    }

    visible.push(line);
  }

  const silent = actions.some((action) => action.type === 'silent');
  return {
    text: silent ? '' : visible.join('\n').trim(),
    silent,
    actions,
  };
}

export { parseRelativeReminder };
export default parseActions;
