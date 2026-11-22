/**
 * 记忆检索的入口接线 · entry-side retrieval wiring
 * ─────────────────────────────────────────────────────────────
 * 这一层只回答一个问题：**宿主（命令行入口）怎么按配置，把已经合入的结构化
 * 检索适配器接给 Brain，并且默认什么都不做。**
 *
 * 合入的适配器本文件不重写、不改签名：
 *   - `createTailWindowAdapter({ memory })`（`tail-window-adapter.js`）
 *   - `createLexicalAdapter({ memory })`（`lexical-adapter.js`）
 * 本文件负责三件小事：
 *   1. 把 `config.memory.retrieval` 归一化成安全默认值（非法值一律回退，不抛）；
 *   2. 关闭时返回 null（默认关闭，行为与接线前逐字节一致）；
 *   3. 把检索结果渲染成一段**有界**的记忆块，并做主体/状态/隐私兜底。
 *
 * 隐私边界（与 `docs/flandre-memory-contract.md` §4.6 一致）：
 *   - 没有主体就不检索：不是"返回全场记忆"；
 *   - 只接受 `subjectId` 等于当前主体的记录；`null` 主体只在显式允许时可见；
 *   - 缺 `refs`、被删除/隔离/替代、`redacted`、`restricted` 的记录一律不渲染；
 *   - 不写任何文件、不迁移 v1→v2、不发网络请求、不 import brain / transport。
 *
 * 预算（§5.2 T-4、§7 P-5）：
 *   - 单条记录折叠空白后 ≤160 字符；
 *   - 整块 ≤ `maxChars`（默认 5000，与 `role.js` 记忆槽同源），按整条贪心取，
 *     绝不把一条记录切成半句，也绝不把超长文本丢给 `Role.build` 兜底裁剪。
 *
 * 降级（§5.2 T-3）：
 *   - 适配器缺失、抛错、返回非契约结构 → 返回 `{ used:false }`，调用方沿用
 *     `Memory.renderPerson` 的旧路径，模型调用不受影响；
 *   - 适配器报 `index-missing` 且没给记录 → 同样回退旧路径；
 *   - 适配器明确 `privacy.denied` → **不回退**（回退等于绕过隐私边界），给空块。
 */

import { createTailWindowAdapter } from './tail-window-adapter.js';
import { createLexicalAdapter } from './lexical-adapter.js';

/** 与 `role.js` 长期记忆槽同源的上限（§7.1）。 */
export const MEMORY_SLOT_MAX_CHARS = 5000;

/** 单条记录上限（§7 P-5：`memory.js` / `actions.js` 同一口径）。 */
export const MEMORY_RECORD_MAX_CHARS = 160;

/** 支持的模式；未列出的值一律回退默认模式。 */
export const MEMORY_RETRIEVAL_MODES = Object.freeze(['tail-window', 'lexical']);

/**
 * 默认值：**关闭**、不迁移、不做词面以外的任何推断。
 * `minConfidence=0` + `includeUnverified=true` 表示"不按置信度过滤"，
 * 与接线前的 `renderPerson` 内容范围保持一致（legacy 条目置信度是 0.30）。
 */
export const MEMORY_RETRIEVAL_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'tail-window',
  maxRecords: 20,
  maxChars: MEMORY_SLOT_MAX_CHARS,
  minConfidence: 0,
  includeUnverified: true,
  allowUnattributed: false,
});

/** 记忆块里的类别顺序（也是渲染顺序，固定值，保证同输入同输出）。 */
const KIND_ORDER = Object.freeze(['trait', 'fact', 'topic', 'pending', 'turn', 'interaction', 'task_ref']);

/** 类别标签：与 `Memory.renderPerson` 的措辞保持相近，避免两套口吻。 */
const KIND_LABELS = Object.freeze({
  trait: '你了解他：',
  fact: '他告诉过你：',
  topic: '你们聊过：',
  pending: '⚠️ 你心里还记着没说出口的事：',
  turn: '最近聊过：',
  interaction: '你们互动过',
  task_ref: '待办：',
});

/**
 * 从 `config.memory.retrieval` 归一化。任何非法输入都不抛：
 * 启动期不能因为一条配置把整个进程拦下来，回退到默认（默认即关闭）即可。
 *
 * @param {unknown} raw
 * @returns {{enabled:boolean, mode:string, maxRecords:number, maxChars:number,
 *   minConfidence:number, includeUnverified:boolean, allowUnattributed:boolean,
 *   warnings: string[]}}
 */
export function normalizeRetrievalConfig(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('memory.retrieval 不是对象，已忽略');
  }

  const enabled = source.enabled === true;
  const mode = MEMORY_RETRIEVAL_MODES.includes(source.mode) ? source.mode : MEMORY_RETRIEVAL_DEFAULTS.mode;
  if (source.mode !== undefined && source.mode !== null && !MEMORY_RETRIEVAL_MODES.includes(source.mode)) {
    warnings.push('mode 不认识，已回退 ' + MEMORY_RETRIEVAL_DEFAULTS.mode);
  }

  const maxRecords = clampInt(source.maxRecords, 1, 200, MEMORY_RETRIEVAL_DEFAULTS.maxRecords, 'maxRecords', warnings);
  const maxChars = clampInt(source.maxChars, 1, MEMORY_SLOT_MAX_CHARS, MEMORY_RETRIEVAL_DEFAULTS.maxChars, 'maxChars', warnings);

  let minConfidence = MEMORY_RETRIEVAL_DEFAULTS.minConfidence;
  if (source.minConfidence !== undefined && source.minConfidence !== null) {
    const value = Number(source.minConfidence);
    if (Number.isFinite(value) && value >= 0 && value <= 1) minConfidence = value;
    else warnings.push('minConfidence 必须是 0..1，已回退 ' + MEMORY_RETRIEVAL_DEFAULTS.minConfidence);
  }

  return {
    enabled,
    mode,
    maxRecords,
    maxChars,
    minConfidence,
    // 只有显式 false 才收紧；未配置时保持"不过滤置信度"的旧内容范围。
    includeUnverified: source.includeUnverified !== false,
    allowUnattributed: source.allowUnattributed === true,
    warnings,
  };
}

function clampInt(value, min, max, fallback, name, warnings) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    warnings.push(name + ' 必须是 ' + min + '..' + max + ' 的整数，已回退 ' + fallback);
    return fallback;
  }
  return n;
}

/**
 * 按配置造适配器。关闭、或 `memory` 不是可读账本时返回 null——
 * 调用方据此完全跳过检索（默认路径不产生任何额外调用）。
 *
 * @param {{memory?: object, config?: unknown}} opts
 * @returns {null | {retrieve: (request: object) => object, capabilities?: object}}
 */
export function createEntryMemoryRetriever({ memory, config } = {}) {
  const normalized = normalizeRetrievalConfig(config);
  if (!normalized.enabled) return null;
  if (!memory || typeof memory !== 'object') return null;
  const options = { memory };
  return normalized.mode === 'lexical'
    ? createLexicalAdapter(options)
    : createTailWindowAdapter(options);
}

/**
 * 组装 `MemoryRetrievalRequest` 的安全子集。只带当前主体与会话，
 * 不带任何"待检索的历史正文"以外的字段。
 *
 * @param {{key?:string, userId?:string|number|null, text?:string, now?:number, config?:unknown}} input
 * @returns {object|null} 没有主体时返回 null（不检索，也不返回全场记忆）
 */
export function createRetrievalRequest({ key, userId, text, now, config } = {}) {
  const normalized = normalizeRetrievalConfig(config);
  const subjectId = userId === undefined || userId === null ? '' : String(userId).trim();
  if (!subjectId) return null;
  const conversationKey = typeof key === 'string' && key.trim() ? key.trim() : null;
  const scope = scopeOf(conversationKey);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return {
    schemaVersion: 1,
    subject: { personId: subjectId, scope, conversationKey },
    subjectId,
    scope,
    where: conversationKey,
    query: { text: String(text ?? ''), kinds: null },
    time: { nowIso: new Date(nowMs).toISOString(), sinceIso: null, untilIso: null },
    budget: { maxRecords: normalized.maxRecords, maxChars: normalized.maxChars },
    policy: {
      minConfidence: normalized.minConfidence,
      includeUnverified: normalized.includeUnverified,
      includeQuarantined: false,
      allowUnattributed: normalized.allowUnattributed,
    },
    requester: 'host',
  };
}

/** 会话 key → 契约 scope；认不出就留 null，让适配器自己决定。 */
function scopeOf(key) {
  const value = String(key ?? '');
  if (value.startsWith('private:')) return 'private';
  if (value.startsWith('group:')) return 'group';
  if (value === 'flandre-web' || value.startsWith('flandre-web:')) return 'web';
  if (value === 'cli' || value.startsWith('cli:')) return 'cli';
  return null;
}

/** 记录是否可作为"当前主体"的记忆渲染（隐私与状态的双重兜底）。 */
function isRenderableRecord(record, subjectId, allowUnattributed) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.text !== 'string' || !record.text.trim()) return false;
  const status = record.correction?.status;
  if (status !== undefined && status !== null && status !== 'active') return false;
  if (record.privacy?.redacted === true) return false;
  if (record.privacy?.level === 'restricted') return false;
  if (!Array.isArray(record.provenance?.refs) || record.provenance.refs.length === 0) return false;

  const rawSubject = record.subjectId;
  const recordSubject = rawSubject === undefined || rawSubject === null ? null : String(rawSubject).trim();
  if (recordSubject === null || recordSubject === '') {
    // 不可归属的旧轮次只允许在显式允许、且确实是对话轮次时出现。
    return allowUnattributed === true && record.kind === 'turn';
  }
  return recordSubject === String(subjectId);
}

/** 折叠空白、去首尾、按单条上限截断（不做语义改写）。 */
function normalizeRecordText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_RECORD_MAX_CHARS);
}

function recordLine(record) {
  const text = normalizeRecordText(record.text);
  const label = KIND_LABELS[record.kind] || '记忆：';
  if (record.kind === 'interaction') return label + ' ' + text + ' 次';
  if (record.kind !== 'turn') return label + text;
  const reply = normalizeRecordText(record.reply);
  return reply ? label + text + '\n  你：' + reply : label + text;
}

/**
 * 把检索记录渲染成一段有界的记忆块。
 *
 * 排序完全跟随适配器给出的顺序，只在类别内分组（类别顺序固定），
 * 因此同一输入、同一快照必得同一输出。按整条贪心加入，放不下就停止并计数。
 *
 * @param {Array<object>} records
 * @param {{subjectId?:string|number|null, maxChars?:number, allowUnattributed?:boolean}} [options]
 * @returns {{text:string, recordsUsed:number, omitted:number}}
 */
export function renderRetrievalMemory(records, options = {}) {
  const subjectId = options.subjectId === undefined || options.subjectId === null
    ? ''
    : String(options.subjectId).trim();
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(0, Math.floor(Number(options.maxChars)))
    : MEMORY_SLOT_MAX_CHARS;
  const allowUnattributed = options.allowUnattributed === true;
  const list = Array.isArray(records) ? records : [];

  const accepted = [];
  let omitted = 0;
  for (const record of list) {
    if (!isRenderableRecord(record, subjectId, allowUnattributed)) {
      omitted += 1;
      continue;
    }
    accepted.push(record);
  }

  // 先按固定类别顺序分组，组内保持适配器给出的顺序（不重新打分、不重排）。
  const ordered = [];
  for (const kind of KIND_ORDER) {
    for (const record of accepted) {
      if (record.kind === kind) ordered.push(record);
    }
  }
  // 类别不在白名单里的记录不静默丢弃，计入 omitted。
  omitted += accepted.filter((record) => !KIND_ORDER.includes(record.kind)).length;

  // 按整条贪心加入：第一条放不下就停（后面的只会更长），绝不留半句。
  const included = [];
  for (const record of ordered) {
    const candidate = assembleMemoryText([...included, record]);
    if (candidate.length > maxChars) break;
    included.push(record);
  }
  omitted += ordered.length - included.length;

  return {
    text: assembleMemoryText(included),
    recordsUsed: included.length,
    omitted,
  };
}

/** 按已纳入的顺序拼成最终文本（同类别合并成一行，类别之间换行）。 */
function assembleMemoryText(records) {
  const lines = [];
  let currentKind = null;
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    const rendered = bucket.map(recordLine);
    lines.push(currentKind === 'turn' ? rendered.join('\n') : rendered.join('；'));
    bucket = [];
  };
  for (const record of records) {
    if (record.kind !== currentKind) {
      flush();
      currentKind = record.kind;
    }
    bucket.push(record);
  }
  flush();
  return lines.join('\n');
}

/**
 * 一次完整的入口检索：请求 → 适配器 → 安全渲染。
 *
 * **绝不抛错**（T-3）。返回值里的元数据只含计数、模式与降级原因，
 * 不含任何记录正文，便于写日志/测试断言。
 *
 * @param {{retriever?: object|null, key?:string, userId?:string|number|null,
 *   text?:string, now?:number, config?:unknown}} input
 * @returns {{used:boolean, memory:string, denied:boolean, degraded:string|null,
 *   mode:string|null, records:number, recordsUsed:number, omitted:number, reason:string|null}}
 */
export async function retrieveMemoryForTurn({ retriever, key, userId, text, now, config } = {}) {
  const normalized = normalizeRetrievalConfig(config);
  const base = {
    used: false,
    memory: '',
    denied: false,
    degraded: null,
    mode: null,
    records: 0,
    recordsUsed: 0,
    omitted: 0,
    reason: null,
  };
  if (!retriever || typeof retriever.retrieve !== 'function') {
    return { ...base, reason: 'adapter-missing' };
  }
  const request = createRetrievalRequest({ key, userId, text, now, config: normalized });
  // 没有主体就不检索：沿用调用方原有的记忆路径，绝不返回"全场记忆"。
  if (!request) return { ...base, reason: 'missing-subject' };

  let result;
  try {
    result = await retriever.retrieve(request);
  } catch (error) {
    return { ...base, reason: 'adapter-error', degraded: 'adapter-error' };
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.records)) {
    return { ...base, reason: 'invalid-result', degraded: 'adapter-error' };
  }

  const mode = typeof result.adapter?.mode === 'string' ? result.adapter.mode : null;
  const degraded = normalizeDegraded(result.degraded);
  if (result.privacy?.denied === true) {
    // 隐私拒绝优先：不回退、不渲染、也不假装成功。
    return { ...base, used: true, denied: true, degraded, mode, reason: 'privacy-denied' };
  }
  if (degraded && degraded !== 'index-missing') {
    return { ...base, degraded, mode, reason: 'degraded' };
  }
  if (degraded === 'index-missing' && result.records.length === 0) {
    return { ...base, degraded, mode, reason: 'degraded-empty' };
  }

  const rendered = renderRetrievalMemory(result.records, {
    subjectId: request.subjectId,
    maxChars: normalized.maxChars,
    allowUnattributed: normalized.allowUnattributed,
  });
  if (!rendered.text) {
    return {
      ...base,
      degraded,
      mode,
      records: result.records.length,
      omitted: rendered.omitted,
      reason: 'empty',
    };
  }
  return {
    used: true,
    memory: rendered.text,
    denied: false,
    degraded,
    mode,
    records: result.records.length,
    recordsUsed: rendered.recordsUsed,
    omitted: rendered.omitted,
    reason: null,
  };
}

function normalizeDegraded(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.reason === 'string' && value.reason) return value.reason;
  return 'degraded';
}
