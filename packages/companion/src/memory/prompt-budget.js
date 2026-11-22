/**
 * 记忆块预算 · 只负责「记录 → 一段可注入文本」的减量
 * ─────────────────────────────────────────────────────────────
 * 隐私过滤、状态过滤（deleted / quarantined / superseded）、主体边界**都由调用方先做**。
 * 本模块只接收已经过筛的记录数组，回答两个问题：
 *   1. 最多能放进多少条、多少字符；
 *   2. 没放进去的记录为什么没放进去（只记 id/kind/原因，不记正文）。
 *
 * 契约来源：`docs/flandre-execution-plan.md` §4.2。默认值沿用现有实现：
 *   - `maxChars = 5000`：`role.js` 的记忆槽位上限；
 *   - `maxRecords = 36`：`Memory.renderPerson` 的 12 + 12 + 8 + 4 渲染上限（`memory.js:1213-1216`）；
 *   - `kindOrder = trait / fact / topic / pending`：同上账本的四个类别与标签。
 * 不改变 `Memory.renderPerson` 的默认行为：本模块是**补充**，只在超预算或显式启用时被调用。
 *
 * 硬约束（测试已固定）：
 *   1. 不读写文件、不调用 Memory 的任何写方法、不发网络、不读 `data/`。
 *   2. `text.length === charsUsed <= maxChars`。
 *   3. `omitted` / `diagnostics` 不含正文（只有 id / kind / 原因 / 数量）。
 *   4. 不修改入参记录；同输入同输出。
 */

/** 记忆块预算契约版本（字段增删都要改它） */
export const MEMORY_BUDGET_VERSION = 1;

/** 默认字符预算：沿用 role.js 记忆槽位上限 */
export const DEFAULT_MEMORY_BUDGET_CHARS = 5000;

/** 默认条数预算：沿用 12 + 12 + 8 + 4 */
export const DEFAULT_MEMORY_BUDGET_RECORDS = 36;

/** 默认类别顺序（也是默认渲染顺序） */
export const DEFAULT_MEMORY_KIND_ORDER = Object.freeze(['trait', 'fact', 'topic', 'pending']);

/**
 * 默认标签：与 `Memory.renderPerson` 同一套说法，避免两处提示词口吻漂移。
 * 调用方要完全按 `renderPerson` 的整段格式输出时，自己传 `render`。
 */
const DEFAULT_KIND_LABELS = Object.freeze({
  trait: '你了解他：',
  fact: '他告诉过你：',
  topic: '你们聊过：',
  pending: '⚠️ 你心里还记着没说出口的事：',
});

function positiveInt(value, fallback, where) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(where + ' 必须是非负有限数字，收到：' + String(value));
  return Math.floor(n);
}

function normalizeKindOrder(kindOrder) {
  if (kindOrder === undefined || kindOrder === null) return [...DEFAULT_MEMORY_KIND_ORDER];
  if (!Array.isArray(kindOrder)) throw new TypeError('kindOrder 必须是字符串数组');
  const seen = new Set();
  const out = [];
  for (const raw of kindOrder) {
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('kindOrder 的每一项都必须是非空字符串');
    const kind = raw.trim();
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  if (!out.length) throw new TypeError('kindOrder 不能为空数组');
  return out;
}

function recordKind(record) {
  return typeof record?.kind === 'string' ? record.kind.trim() : '';
}

function recordId(record, index) {
  const id = record?.id;
  if (id === undefined || id === null || id === '') return 'row:' + index;
  return String(id);
}

function recordText(record) {
  return typeof record?.text === 'string' ? record.text.trim() : '';
}

function observedTime(value) {
  // An explicit offset keeps the policy independent of the host timezone.
  const stamp = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!stamp) return -Infinity;
  const day = new Date(stamp[1] + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || !day.toISOString().startsWith(stamp[1])) return -Infinity;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : -Infinity;
}

function preferRecentExperiences(candidates) {
  const positions = [];
  for (const [index, entry] of candidates.entries()) {
    if (entry.kind === 'topic' && entry.record.layer === 'shared_experience') positions.push(index);
  }
  const topics = positions.map((index) => ({ entry: candidates[index], time: observedTime(candidates[index].record.observedAt) }));
  // Unknown timestamps have lowest retention priority; ties keep source order.
  topics.sort((a, b) => a.time === b.time ? a.entry.index - b.entry.index : b.time - a.time);
  const ordered = [...candidates];
  for (const [rank, index] of positions.entries()) ordered[index] = topics[rank].entry;
  return ordered;
}

/** 组装：按类别分组，组内用「；」连接，组间换行（与 renderPerson 的段落形状一致） */
function assemble(kindOrder, byKind, labels) {
  const lines = [];
  for (const kind of kindOrder) {
    const texts = byKind.get(kind);
    if (!texts || !texts.length) continue;
    const label = labels?.[kind];
    lines.push((label ? label : '') + texts.join('；'));
  }
  return lines.join('\n');
}

/**
 * 只做「记录 → 文本」的预算；隐私/状态过滤由调用方先做。
 * @param {Array<{id?:string, kind?:string, text:string, confidence?:number}>} records
 * @param {{
 *   maxChars?: number,       // 默认 5000，沿用 memory slot
 *   maxRecords?: number,     // 默认 36（沿用 12+12+8+4 的渲染上限）
 *   kindOrder?: string[],    // 默认 trait/fact/topic/pending
 *   minConfidence?: number,  // 默认 0；只过滤，不改写
 *   preferRecentExperiences?: boolean, // 只影响 L4 topic 的预算优先级；不改变输出顺序
 *   render?: (record:any) => string
 * }} options
 * @returns {{
 *   text: string,
 *   included: string[],
 *   omitted: Array<{id?:string, kind?:string, reason:'budget'|'confidence'|'kind'}>,
 *   charsUsed: number,
 *   diagnostics: Array<{code:string, detail?:string}>,
 *   version: number,
 *   maxChars: number,
 *   maxRecords: number
 * }}
 */
export function budgetMemoryBlock(records, options = {}) {
  if (records === undefined || records === null) records = [];
  if (!Array.isArray(records)) throw new TypeError('records 必须是数组');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options 必须是对象');
  }

  const maxChars = positiveInt(options.maxChars, DEFAULT_MEMORY_BUDGET_CHARS, 'maxChars');
  const maxRecords = positiveInt(options.maxRecords, DEFAULT_MEMORY_BUDGET_RECORDS, 'maxRecords');
  const kindOrder = normalizeKindOrder(options.kindOrder);

  let minConfidence = 0;
  if (options.minConfidence !== undefined && options.minConfidence !== null) {
    minConfidence = Number(options.minConfidence);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new TypeError('minConfidence 必须是 0..1 的有限数字');
    }
  }
  const render = options.render;
  if (render !== undefined && render !== null && typeof render !== 'function') {
    throw new TypeError('render 必须是函数');
  }

  const omitted = [];
  const diagnostics = [];
  const kindRank = new Map(kindOrder.map((kind, index) => [kind, index]));

  // ── 1. 过滤（只按 kind / confidence / 空文本；不复述正文）──────────────
  const candidates = [];
  let blankCount = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || typeof record !== 'object') {
      blankCount += 1;
      continue;
    }
    const text = recordText(record);
    if (!text) {
      blankCount += 1;
      continue;
    }
    const kind = recordKind(record);
    if (!kindRank.has(kind)) {
      omitted.push({ id: recordId(record, index), kind, reason: 'kind' });
      continue;
    }
    const confidence = Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : 1;
    if (confidence < minConfidence) {
      omitted.push({ id: recordId(record, index), kind, reason: 'confidence' });
      continue;
    }
    candidates.push({ index, id: recordId(record, index), kind, text, record });
  }
  if (blankCount) diagnostics.push({ code: 'blank-record-skipped', detail: blankCount + ' 条无正文记录' });

  // ── 2. 确定性排序：类别顺序 → 组内原顺序 ──────────────────────────────
  candidates.sort((a, b) => (kindRank.get(a.kind) - kindRank.get(b.kind)) || (a.index - b.index));
  const preferRecent = options.preferRecentExperiences === true;
  const selectionOrder = preferRecent ? preferRecentExperiences(candidates) : candidates;

  // ── 3. 贪心取前缀：第一个放不下的记录之后全部标 budget ────────────────
  const includedRecords = [];
  const byKind = new Map();
  let closed = false;
  let closeReason = '';
  for (const candidate of selectionOrder) {
    if (!closed) {
      if (includedRecords.length >= maxRecords) {
        closed = true;
        closeReason = 'maxRecords=' + maxRecords;
      } else {
        const line = typeof render === 'function' ? render(candidate.record) : null;
        if (typeof render === 'function' && typeof line !== 'string') {
          throw new TypeError('render 必须返回字符串');
        }
        const nextTexts = new Map(byKind);
        nextTexts.set(candidate.kind, [...(byKind.get(candidate.kind) || []), line === null ? candidate.text : line]);
        const nextText = typeof render === 'function'
          ? [...includedRecords.map((entry) => entry.line), line].join('\n')
          : assemble(kindOrder, nextTexts, DEFAULT_KIND_LABELS);
        if (nextText.length <= maxChars) {
          byKind.set(candidate.kind, nextTexts.get(candidate.kind));
          includedRecords.push({ ...candidate, line: line === null ? candidate.text : line });
        } else {
          closed = true;
          closeReason = 'maxChars=' + maxChars;
        }
      }
    }
    if (closed) omitted.push({ id: candidate.id, kind: candidate.kind, reason: 'budget' });
  }

  let renderedRecords = includedRecords;
  let renderedKinds = byKind;
  if (preferRecent) {
    const includedByIndex = new Map(includedRecords.map((entry) => [entry.index, entry]));
    renderedRecords = candidates.filter((entry) => includedByIndex.has(entry.index)).map((entry) => includedByIndex.get(entry.index));
    renderedKinds = new Map();
    for (const { kind, line } of renderedRecords) {
      if (!renderedKinds.has(kind)) renderedKinds.set(kind, []);
      renderedKinds.get(kind).push(line);
    }
  }
  const text = typeof render === 'function'
    ? renderedRecords.map((entry) => entry.line).join('\n')
    : assemble(kindOrder, renderedKinds, DEFAULT_KIND_LABELS);

  if (!records.length) {
    diagnostics.push({ code: 'empty-input' });
  } else if (closeReason) {
    diagnostics.push({ code: 'budget-truncated', detail: closeReason + ' 触发，共省略 ' + omitted.filter((entry) => entry.reason === 'budget').length + ' 条' });
  } else {
    diagnostics.push({ code: 'within-budget' });
  }

  return {
    text,
    included: renderedRecords.map((entry) => entry.id),
    omitted,
    charsUsed: text.length,
    diagnostics,
    version: MEMORY_BUDGET_VERSION,
    maxChars,
    maxRecords,
  };
}

export default budgetMemoryBlock;
