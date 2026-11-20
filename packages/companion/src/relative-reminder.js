/**
 * 相对时间提醒 · 只认明确的“<数字><单位>后提醒我<内容>”
 * ────────────────────────────────────────────────────────────
 * 这里不做自然语言理解，只做一条锚定的形状匹配：
 *
 *   5秒后提醒我喝水
 *   30 分钟 后 提醒我 收衣服。
 *   1.5s后提醒我 Check the oven!
 *   600MS后提醒我站起来活动一下
 *
 * 刻意收紧的地方：
 *   - 输入只接受字符串，其它类型一律 null，不做隐式转换。
 *   - 只接受单行；出现换行（含 U+2028/U+2029）直接拒绝。
 *   - 必须以数字开头、必须带金额和单位、必须出现“提醒我”和内容，
 *     所以“我30秒后去洗衣服”这类普通叙述不会被误判。
 *   - 保留“分/分钟”“时/小时”这类口语单位，但不猜“一会儿”“半小时”。
 *   - 小数按毫秒四舍五入；有效范围 1ms ~ 7 天。
 *   - 正文去掉头尾空白与尾部句末标点后必须非空且不超过 500 个 UTF-16 字符。
 */

export const MAX_RELATIVE_REMINDER_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RELATIVE_REMINDER_TEXT_LENGTH = 500;

const RELATIVE_REMINDER_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|分钟|分|小时|时|s)\s*后\s*提醒我\s*(.+?)\s*$/iu;
const RELATIVE_REMINDER_UNITS = Object.freeze({
  '毫秒': 1,
  ms: 1,
  s: 1000,
  '秒': 1000,
  '分钟': 60 * 1000,
  '分': 60 * 1000,
  '小时': 60 * 60 * 1000,
  '时': 60 * 60 * 1000,
});

/** 出现任一字符即视为多行，直接拒绝。 */
const LINE_BREAK_PATTERN = /[\n\r\u2028\u2029]/;
/** 尾部句末标点：中英文句号、感叹号、问号、省略号。 */
const TRAILING_SENTENCE_PUNCTUATION = /[。．！？!?.…]+$/u;

/** 去头尾空白，再去掉尾部句末标点；两个动作互相影响，所以跑到稳定为止。 */
function normalizeReminderText(value) {
  let text = value.trim();
  for (;;) {
    const stripped = text.replace(TRAILING_SENTENCE_PUNCTUATION, '').trim();
    if (stripped === text) return text;
    text = stripped;
  }
}

/**
 * Parse an explicit relative-time reminder request.
 *
 * @param {string} raw 单行原文
 * @returns {{ delayMs: number, text: string } | null}
 */
export function parseRelativeReminder(raw) {
  if (typeof raw !== 'string') return null;
  if (LINE_BREAK_PATTERN.test(raw)) return null;

  const match = raw.match(RELATIVE_REMINDER_PATTERN);
  if (!match) return null;

  const amount = Number(match[1]);
  const multiplier = RELATIVE_REMINDER_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(amount) || !multiplier) return null;

  const delayMs = Math.round(amount * multiplier);
  if (!Number.isFinite(delayMs)) return null;
  if (delayMs < 1 || delayMs > MAX_RELATIVE_REMINDER_DELAY_MS) return null;

  const text = normalizeReminderText(match[3]);
  if (!text) return null;
  if (text.length > MAX_RELATIVE_REMINDER_TEXT_LENGTH) return null;

  return { delayMs, text };
}
