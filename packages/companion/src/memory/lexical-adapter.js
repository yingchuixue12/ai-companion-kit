/**
 * 记忆词面检索适配器 · lexical retrieval adapter
 * ─────────────────────────────────────────────────────────────
 * 词面检索接口继承最近窗口适配器的隐私与降级约定。
 * 与 §7（预算/排序）。本文件只实现"确定性的词面打分"这一层，不接线到 Brain，
 * 也不改 Brain / Role / Memory / 入口。宿主把实例传给 `memoryRetriever` 即可启用。
 *
 * 设计目标（对应任务要求）：
 *   1. 可组合：`new LexicalAdapter({ memory })` 或 `{ source: tailAdapter }`，
 *      也可以直接包一个只读快照 `{ people, turns }`；统一暴露 `retrieve(request)`。
 *   2. 纯本地、确定性：只做 token 重叠打分；没有 embedding、没有模型调用、没有
 *      网络请求、没有文件写入、没有模块级可变缓存。同一输入 + 同一时钟 = 同一输出。
 *   3. 隐私先于打分：主体、会话（where/scope）、纠正状态、脱敏/受限状态、出处
 *      全部在打分之前过滤；绝不返回别人的记录，也绝不把群聊尾部拼进私聊。
 *   4. 预算自管：maxRecords / maxChars 由本适配器自己截断，不把超长文本丢给
 *      Role.build 的兜底裁剪（§5.2 T-4、§7 P-6）。
 *   5. query.text 是唯一的排序输入；query.kinds / policy.excludeKinds / time 是
 *      过滤器，不参与打分。空查询、纯标点查询、无命中查询都退化成可用的尾窗口
 *      顺序（见下面「降级策略」），而不是抛错或假装做过相关性检索。
 *
 * ── 请求：retrieve(request) ─────────────────────────────────
 * 契约字段（§4.1 的最小子集，都可缺省）：
 *   schemaVersion  应为 1；给了别的版本 → degraded.reason='schema-mismatch'
 *   requestId      原样回显
 *   subject        { personId, displayName, scope, conversationKey }
 *                  scope ∈ private | group | web | cli
 *   query          { text, kinds, topicHints }
 *                  text 是唯一排序输入；kinds 是类别过滤；topicHints 本实现不读
 *   time           { nowIso, sinceIso, untilIso }；since/until 按 observedAt 过滤
 *   budget         { maxRecords, maxChars }
 *   policy         { minConfidence, includeUnverified, includeQuarantined,
 *                    excludeKinds, allowUnattributed }
 *   requester / trace 原样透传给来源适配器，本实现不解释
 * 调用别名（非契约，方便宿主直接传，和 tail-window-adapter 保持一致）：
 *   subjectId        ← subject.personId 的简写（也接受 subject 直接是字符串）
 *   scope            ← subject.scope 的简写
 *   where            ← 会话键精确过滤，string 或 string[]（对应 turns.jsonl 的 where）
 *   conversationKey  ← where 的简写
 *   kinds            ← query.kinds 的简写
 *   limit / maxChars ← budget.maxRecords / budget.maxChars 的简写
 *
 * ── 结果：MemoryRetrievalResult（§4.1）──────────────────────
 * 契约字段：schemaVersion / requestId / adapter{id,version,mode,capabilities} /
 *   generatedAt / subject{personId,scope} / records[] /
 *   budget{charsUsed,recordsUsed,truncated} /
 *   omitted{count,reasons[{reason,count}]} /
 *   degraded(null | {reason, fallback}) /
 *   privacy{redactedCount,tombstoned}
 * 本模块附加的字段（只增不改名，调用方可以忽略）：
 *   privacy.denied / privacy.deniedReason  是否因隐私边界返回空结果
 *   lexical{queryTokens,matchedRecords,order} 本次词面检索的机器可读摘要
 *     order: 'relevance' = 至少一条命中，按相关性排序
 *            'tail-window' = 没有可用查询词/没有命中，按尾窗口顺序
 *   notes[]  机器可读短标记（不含任何记忆正文）
 *   records[].score  由本适配器重算；provenance/correction/privacy 原样保留
 *   records[].provenance.adapter 仍指向真正产出该记录的上游适配器（例如
 *     'tail-window'）；本次检索模式看 result.adapter.id。
 *
 * ── 打分（确定性的词面重叠）────────────────────────────────
 * 只使用 query.text 与记录文本：
 *   - 拉丁/数字串按整词切分（大小写折叠、NFKC 归一），整词精确匹配；
 *   - CJK 连续段取二元组（相邻两字）作为查询词；单字段落取单字；
 *   - 文档侧额外索引单字，让「猫」这样的单字查询能命中「养了一只猫」；
 *   - 不做同义词、不做词干化、不做 embedding。
 * relevance = 命中的唯一查询词数 / 唯一查询词总数（0..1，保留 6 位小数）。
 * score.total = relevance；score.recency 恒为 0——query.text 是唯一排序输入，
 * 「新旧」只作为并列时的稳定次序，不混进分数（§4.1 排序规则的前两级）。
 *
 * ── 排序（稳定、可复现）────────────────────────────────────
 *   1) score.total 降序（查询词重叠越多越靠前）
 *   2) observedAt 降序（newest-first；缺失 observedAt 的排最后，不编造时间）
 *   3) 来源记录数组中的原始次序（original order）
 *   4) id 字典序升序（§4.1 兜底）
 * 第 2、3 条合起来就是任务要求的「newest-first then original order」。
 * 不用 Math.random()，不依赖 Map/Set 的迭代顺序做排序来源。
 *
 * ── 降级策略（T-3 同款：不抛错，给结构化结果）──────────────
 * - 没有查询词（空串/纯空白/纯标点）：不假装检索，按尾窗口顺序返回全部可用
 *   记录，degraded={reason:'index-missing', fallback:'tail-window'}，
 *   notes 记 'query-empty:tail-window' 或 'query-too-short:tail-window'。
 *   Brain 把 index-missing 视为"尾窗口仍可用"，因此不会丢上下文。
 * - 有查询词但一条都没命中：仍按尾窗口顺序返回（所有 relevance=0），
 *   degraded=null，notes 记 'no-lexical-match'，lexical.order='tail-window'。
 * - 来源适配器缺失/抛错/返回非法结构：degraded={reason:'adapter-error',
 *   fallback:'tail-window'}，records=[]，只留错误类别名，不泄漏正文。
 * - 来源适配器报 schema-mismatch：原样传播；来源报 index-missing：忽略，
 *   因为本适配器自己就做词面检索。
 * - 缺主体：privacy.denied=true、deniedReason='missing-subject'、records=[]，
 *   绝不退化成"返回全场记忆"（§4.6.1）。
 * - policy.includeQuarantined=true：明确拒绝（denied），而不是照做。
 * - 非法 budget / time / policy 数值：安全忽略或取默认值，绝不抛错。
 *
 * ── 隐私（§4.6）────────────────────────────────────────────
 * 来源适配器先做一次隔离，本适配器在打分前再做一次纵深检查：
 *   - 记录 subjectId 必须等于请求主体；subjectId=null 只允许在
 *     policy.allowUnattributed=true 且 kind='turn' 时通过；
 *   - turn 记录的 provenance.refs 里每个 turn ref 的 where 必须落在
 *     请求的 scope 前缀或精确 where 列表内；userId 必须为空（且允许未归属）
 *     或等于主体；
 *   - correction.status 必须是 'active'；'quarantined' 计入 quarantined，
 *     'deleted' 计入 privacy + tombstoned，'superseded' 计入 low-confidence；
 *   - privacy.redacted=true 或 privacy.level='restricted' 一律排除；
 *   - provenance.refs 缺失/为空视为不可回指，按 low-confidence 排除（§4.2 红线）；
 *   - 缺 active 状态、缺正文、缺 refs 这类结构不完整的记录同样按 low-confidence
 *     排除：宁可少返回一条，也不把无法证明来源的内容当记忆注入。
 *   - 「缺正文」只看可渲染文本：非 turn 记录必须自带非空 text；kind='turn' 允许
 *     只有宿主核实过的 assistant reply（与 searchableText 同一条回退——user text
 *     优先，空/缺失时用 reply）。回退只回答"这一段有没有正文可渲染"，不放宽任何
 *     来源检查：refs、主体、turn ref 的 owner/where 仍在打分之上一律强制，所以
 *     reply-only 不会变成绕过会话隔离的入口。
 * 没有任何"把别人的记录返回给当前主体"的分支。
 *
 * ── 预算（§5.2 T-4、§7 P-6）────────────────────────────────
 * maxRecords 限条数、maxChars 限字符（UTF-16 长度，与仓库现有口径一致）。
 * 单条放不下就跳过并计入 omitted.reasons[budget]，不中途停止（后面的短记录
 * 仍可能放入）。超预算由本适配器自己截断，绝不把超长文本丢给上层兜底。
 *
 * ── 不可变性与只读 ─────────────────────────────────────────
 * 只调用来源的 retrieve()（来源内部可以只读 dump()/recentTurns()），从不调用
 * person()/remember()/logTurn() 等写盘方法；不修改来源记录，返回前对记录做
 * 浅层复制并替换 score，refs/correction/privacy 也复制一层，避免调用方误改
 * 来源快照。没有模块级可变状态。
 */

import { createTailWindowAdapter } from './tail-window-adapter.js';

const SCHEMA_VERSION = 1;
const ADAPTER_ID = 'lexical';
const ADAPTER_VERSION = '1.0.0';
const ADAPTER_MODE = 'lexical';
const CAPABILITIES = Object.freeze({ lexical: true, semantic: false, localIndex: false });

/** 契约 §4.1 的 kind 取值域；不在表里的 kind 不进入结果集。 */
const CONTRACT_KINDS = Object.freeze({
  trait: true,
  fact: true,
  topic: true,
  pending: true,
  interaction: true,
  turn: true,
  task_ref: true,
});

/** scope → turns.jsonl 里 where 的前缀（现状取值见契约 §2.4）。 */
const WHERE_PREFIX_BY_SCOPE = Object.freeze({
  private: 'private',
  group: 'group',
  web: 'flandre-web',
  cli: 'cli',
});

const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_MAX_CHARS = 9000;

/**
 * 向来源适配器取候选时的预算。词面排序需要先看到全部候选，所以这里故意放大；
 * 真正的预算在打分之后按请求执行。Memory 现状最多 400 轮 + 每人一百多条条目，
 * 这个上限远高于实际数据量，不会静默漏掉候选。
 */
const SOURCE_MAX_RECORDS = 10000;
const SOURCE_MAX_CHARS = 10000000;

/** policy.includeUnverified=false 时的置信度门槛（§4.1）。 */
const UNVERIFIED_CONFIDENCE_FLOOR = 0.6;

/** omitted.reasons 的固定输出顺序（计数为 0 的不输出），保证同输入同输出。 */
const OMITTED_REASON_ORDER = Object.freeze(['privacy', 'out-of-scope', 'quarantined', 'low-confidence', 'budget']);

/** 拉丁/数字整词；CJK 连续段（含扩展 A 与兼容区）。 */
const LATIN_TOKEN = /[a-z0-9]+/g;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

// ── 小工具 ────────────────────────────────────────────────────

/**
 * 诊断标签只允许内建错误名；未知/畸形 name 一律折叠成 `Error`。
 * `name` 是可写属性（甚至 getter），原样拼接会把正文或查询词带进 notes；
 * 这里只读 name、只认白名单，message/stack 一律不读。
 */
const ERROR_LABELS = Object.freeze({
  Error: true,
  TypeError: true,
  RangeError: true,
  SyntaxError: true,
  ReferenceError: true,
  EvalError: true,
  URIError: true,
  AggregateError: true,
});

/** 异常 → 有界诊断标签；任何读取失败都按未知异常处理，绝不让降级路径二次抛错。 */
function errorLabel(error) {
  try {
    const name = error !== null && typeof error === 'object' ? error.name : null;
    if (typeof name === 'string' && Object.hasOwn(ERROR_LABELS, name)) return name;
  } catch {
    // name 是 getter 且抛错：不读取、不重试，直接折叠。
  }
  return 'Error';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeId(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function positiveInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeKind(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 只用于打分的归一化：NFKC + 小写；不改变返回给调用方的原文。 */
function normalizeForTokens(value) {
  const text = String(value ?? '');
  try {
    return text.normalize('NFKC').toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}

function emptyResult({ requestId = null, generatedAt, subjectId = null, scope = null } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    adapter: { id: ADAPTER_ID, version: ADAPTER_VERSION, mode: ADAPTER_MODE, capabilities: { ...CAPABILITIES } },
    generatedAt,
    subject: { personId: subjectId, scope },
    records: [],
    budget: { charsUsed: 0, recordsUsed: 0, truncated: false },
    omitted: { count: 0, reasons: [] },
    degraded: null,
    privacy: { redactedCount: 0, tombstoned: 0, denied: false, deniedReason: null },
    lexical: { queryTokens: 0, matchedRecords: 0, order: 'tail-window' },
    notes: [],
  };
}

function zeroScore() {
  return { total: 0, relevance: 0, recency: 0, components: { lexical: 0, overlap: 0 } };
}

// ── 请求归一化 ────────────────────────────────────────────────

function normalizeSubjectId(request) {
  const subject = request?.subject;
  if (typeof subject === 'string') return normalizeId(subject);
  if (subject && typeof subject === 'object') return normalizeId(subject.personId);
  return normalizeId(request?.subjectId);
}

function normalizeScope(request) {
  const subject = request?.subject;
  const raw = subject && typeof subject === 'object' && subject.scope !== undefined
    ? subject.scope
    : request?.scope;
  const s = String(raw ?? '').trim().toLowerCase();
  return Object.hasOwn(WHERE_PREFIX_BY_SCOPE, s) ? s : null;
}

/** where / conversationKey：会话键精确过滤（string 或 string[]）。 */
function normalizeWhere(request) {
  const raw = request?.where ?? request?.conversationKey
    ?? (request?.subject && typeof request.subject === 'object' ? request.subject.conversationKey : undefined);
  if (raw === undefined || raw === null) return null;
  const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v ?? '').trim()).filter(Boolean);
  return list.length ? Array.from(new Set(list)) : null;
}

function normalizeBudget(request) {
  const raw = request?.budget;
  const budget = typeof raw === 'number' ? { maxRecords: raw } : (raw && typeof raw === 'object' ? raw : {});
  const maxRecords = positiveInt(budget.maxRecords) ?? positiveInt(request?.limit) ?? DEFAULT_MAX_RECORDS;
  const maxChars = positiveInt(budget.maxChars) ?? positiveInt(request?.maxChars) ?? DEFAULT_MAX_CHARS;
  return { maxRecords, maxChars };
}

/** 类别过滤：null = 不过滤；空 Set = 调用方要的类别一个都不认识（返回空）。 */
function normalizeKinds(request) {
  const raw = request?.query?.kinds ?? request?.kinds;
  if (raw === undefined || raw === null) return null;
  const list = (Array.isArray(raw) ? raw : [raw]).map((k) => String(k ?? '').trim().toLowerCase());
  return new Set(list.filter((k) => Object.hasOwn(CONTRACT_KINDS, k)));
}

function normalizeExcludeKinds(request) {
  const raw = request?.policy?.excludeKinds;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean));
}

/** 时间窗按 observedAt 过滤（§4.3）；非法日期安全忽略并留一条机器标记。 */
function normalizeTimeWindow(request) {
  const time = request?.time;
  if (!time || typeof time !== 'object') return { sinceMs: null, untilMs: null, invalid: false };
  const parse = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : NaN;
  };
  const since = parse(time.sinceIso);
  const until = parse(time.untilIso);
  return {
    sinceMs: Number.isFinite(since) ? since : null,
    untilMs: Number.isFinite(until) ? until : null,
    invalid: Number.isNaN(since) || Number.isNaN(until),
  };
}

/**
 * 置信度门槛。契约把 includeUnverified 写成布尔，但没有给缺省值；本实现只在
 * 调用方显式传 false 时才套用 0.6 门槛，避免 Brain 未传该字段时把迁移来的
 * 0.30 条目全部隐藏（那会让词面检索失去意义）。显式 minConfidence 始终生效，
 * 两者取更严格的那个。这个默认值写在测试里固定。
 */
function resolveConfidenceFloor(policy, notes) {
  let floor = null;
  const raw = policy?.minConfidence;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) floor = n;
    else notes.push('invalid-min-confidence');
  }
  if (policy?.includeUnverified === false) floor = Math.max(floor ?? 0, UNVERIFIED_CONFIDENCE_FLOOR);
  return floor;
}

function queryText(request) {
  const raw = request?.query?.text;
  return typeof raw === 'string' ? raw.trim() : '';
}

// ── 词面切分与打分 ────────────────────────────────────────────

function tokenizeQuery(value) {
  const text = normalizeForTokens(value);
  const tokens = new Set();
  for (const match of text.matchAll(LATIN_TOKEN)) tokens.add('w:' + match[0]);
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add('u:' + run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add('b:' + run.slice(i, i + 2));
    }
  }
  return tokens;
}

function tokenizeDocument(value) {
  const text = normalizeForTokens(value);
  const tokens = new Set();
  for (const match of text.matchAll(LATIN_TOKEN)) tokens.add('w:' + match[0]);
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add('u:' + run);
    } else {
      // 文档侧额外索引单字，保证单字查询能命中更长的连续段。
      for (let i = 0; i < run.length; i += 1) tokens.add('u:' + run[i]);
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add('b:' + run.slice(i, i + 2));
    }
  }
  return tokens;
}

function searchableText(record) {
  const text = typeof record.text === 'string' ? record.text : '';
  if (text.trim()) return text;
  if (record.kind === 'turn' && typeof record.reply === 'string') return record.reply;
  return '';
}

/**
 * 可渲染文本判定：与 searchableText 复用同一条回退（user text 优先；kind='turn'
 * 的 text 空/缺失时用 reply）。只回答"有没有正文"，不读正文内容、不改动记录。
 * 必须复用 searchableText：候选门槛与打分看到的得是同一段文本，否则会留下
 * "过了门槛却打不出相关性"或"能打分却被门槛提前丢掉"的缺口——后者正是
 * reply-only turn 曾经不可达的原因。非 turn 记录在 searchableText 里没有 reply
 * 分支，所以这里对它们等价于"text 必须非空"。
 */
function hasRenderableText(record) {
  return searchableText(record).trim() !== '';
}

function scoreRecord(record, queryTokens) {
  const docTokens = tokenizeDocument(searchableText(record));
  let overlap = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) overlap += 1;
  }
  const relevance = queryTokens.size > 0 ? round6(overlap / queryTokens.size) : 0;
  return {
    total: relevance,
    relevance,
    recency: 0,
    components: { lexical: relevance, overlap },
  };
}

function recordCost(record) {
  const text = typeof record.text === 'string' ? record.text : '';
  const reply = record.kind === 'turn' && typeof record.reply === 'string' ? record.reply : '';
  return text.length + reply.length;
}

function observedMs(record) {
  const iso = record?.observedAt;
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── 隐私 / 状态过滤（打分之前）───────────────────────────────

/**
 * 返回 null 表示可进入候选；否则返回 { reason, tombstone?, redacted? }。
 * 检查顺序固定：主体 → 纠正状态 → 脱敏/受限 → 出处 → 文本 → 类别 → 时间 →
 * 会话隔离 → 置信度。顺序固定是为了让 omitted 计数稳定可复现。
 */
function classifyRecord(record, options) {
  if (!record || typeof record !== 'object') return { reason: 'low-confidence' };

  const kind = normalizeKind(record.kind);

  // ① 主体边界：别人的记录一条都不进来（§4.6.1）。
  const rawSubject = record.subjectId;
  const recordSubject = rawSubject === undefined || rawSubject === null ? null : String(rawSubject).trim();
  if (recordSubject === null) {
    // subjectId=null 只用于不可归属的旧 turns（§6.3 第 6 步），且必须显式允许。
    if (!options.allowUnattributed || kind !== 'turn') return { reason: 'privacy' };
  } else if (recordSubject !== options.subjectId) {
    return { reason: 'privacy' };
  }

  // ② 纠正状态：只有 active 可以返回（§4.5）。
  const status = record.correction?.status;
  if (status === 'quarantined') return { reason: 'quarantined' };
  if (status === 'deleted') return { reason: 'privacy', tombstone: true };
  if (status === 'superseded') return { reason: 'low-confidence' };
  if (status !== 'active') return { reason: 'low-confidence' };

  // ③ 脱敏 / 受限记录永不返回。redactedCount 只统计真正的脱敏记录；
  //    受限记录同样排除，但只体现在 omitted.privacy 里。
  if (record.privacy?.redacted === true) return { reason: 'privacy', redacted: true };
  if (record.privacy?.level === 'restricted') return { reason: 'privacy' };

  // ④ 没有 refs 的记录不得进入结果集（§4.2 红线）。
  const refs = record.provenance?.refs;
  if (!Array.isArray(refs) || refs.length === 0) return { reason: 'low-confidence' };

  // ⑤ 必须有可渲染的正文。非 turn 记录维持「text 必须非空」；kind='turn' 允许只有
  //    assistant reply——与 searchableText / recordCost 共用同一条回退：user text
  //    优先，text 空/缺失时把 reply 当作记录正文。这里只判断"有没有正文"，不读、
  //    不复制、不外传正文；主体①、refs④、turn ref 的 owner/where⑧ 都在打分之上一律
  //    强制，所以这条回退不放松隐私边界，只是让已有的 reply 打分真正可达。
  if (!hasRenderableText(record)) return { reason: 'low-confidence' };

  // ⑥ 类别过滤（过滤器，不参与打分）。
  if (!Object.hasOwn(CONTRACT_KINDS, kind)) return { reason: 'out-of-scope' };
  if (options.kinds && !options.kinds.has(kind)) return { reason: 'out-of-scope' };
  if (options.excludeKinds.has(kind)) return { reason: 'out-of-scope' };

  // ⑦ 时间窗按 observedAt 过滤（§4.3）；没有 observedAt 就无法证明在窗内。
  if (options.time.sinceMs !== null || options.time.untilMs !== null) {
    const ms = observedMs(record);
    if (ms === null) return { reason: 'out-of-scope' };
    if (options.time.sinceMs !== null && ms < options.time.sinceMs) return { reason: 'out-of-scope' };
    if (options.time.untilMs !== null && ms > options.time.untilMs) return { reason: 'out-of-scope' };
  }

  // ⑧ 会话边界：turn 记录必须能回指到本次请求的会话键。
  if (kind === 'turn') {
    const turnRefs = refs.filter((ref) => ref && typeof ref === 'object' && ref.kind === 'turn');
    if (turnRefs.length === 0) return { reason: 'out-of-scope' };
    for (const ref of turnRefs) {
      const refUserId = ref.userId === undefined || ref.userId === null ? null : String(ref.userId).trim() || null;
      if (refUserId === null) {
        if (!options.allowUnattributed) return { reason: 'privacy' };
      } else if (refUserId !== options.subjectId) {
        return { reason: 'privacy' };
      }
      const refWhere = typeof ref.where === 'string' ? ref.where.trim() : '';
      if (!refWhere) return { reason: 'out-of-scope' };
      if (!options.scopePrefix && !options.whereFilters) return { reason: 'out-of-scope' };
      if (options.scopePrefix && !refWhere.startsWith(options.scopePrefix)) return { reason: 'out-of-scope' };
      if (options.whereFilters && !options.whereFilters.includes(refWhere)) return { reason: 'out-of-scope' };
    }
  }

  // ⑨ 置信度策略（显式传入才生效，见 resolveConfidenceFloor）。
  if (options.confidenceFloor !== null) {
    const confidence = Number(record.confidence);
    if (!Number.isFinite(confidence) || confidence < options.confidenceFloor) return { reason: 'low-confidence' };
  }

  return null;
}

// ── 排序 ──────────────────────────────────────────────────────

/**
 * score.total 降序 → observedAt 降序 → 来源原始次序 → id 字典序。
 * 这就是任务要求的「newest-first then original order」的稳定实现。
 */
function compareCandidates(a, b) {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  const am = a.observedMs === null ? Number.NEGATIVE_INFINITY : a.observedMs;
  const bm = b.observedMs === null ? Number.NEGATIVE_INFINITY : b.observedMs;
  if (am !== bm) return bm > am ? 1 : -1;
  if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
  const aid = String(a.record.id ?? '');
  const bid = String(b.record.id ?? '');
  if (aid === bid) return 0;
  return aid < bid ? -1 : 1;
}

// ── 记录复制（不修改来源）────────────────────────────────────

function cloneRecord(record, score) {
  const provenance = record.provenance && typeof record.provenance === 'object'
    ? {
      ...record.provenance,
      refs: Array.isArray(record.provenance.refs)
        ? record.provenance.refs.map((ref) => (ref && typeof ref === 'object' ? { ...ref } : ref))
        : record.provenance.refs,
    }
    : record.provenance;
  const correction = record.correction && typeof record.correction === 'object'
    ? {
      ...record.correction,
      tombstone: record.correction.tombstone && typeof record.correction.tombstone === 'object'
        ? { ...record.correction.tombstone }
        : record.correction.tombstone,
    }
    : record.correction;
  const privacy = record.privacy && typeof record.privacy === 'object' ? { ...record.privacy } : record.privacy;
  return { ...record, provenance, correction, privacy, score };
}

// ── 来源适配器解析 ────────────────────────────────────────────

/** 把只读快照 { people, turns } 包成 TailWindowAdapter 认识的只读 Memory 替身。 */
function snapshotMemory(snapshot) {
  const people = snapshot.people && typeof snapshot.people === 'object' ? snapshot.people : {};
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  return {
    dump() {
      return { people, turns };
    },
    recentTurns(n = 20, { wherePrefix } = {}) {
      let rows = turns.slice();
      if (wherePrefix) rows = rows.filter((row) => String(row?.where ?? '').startsWith(wherePrefix));
      const limit = Math.max(0, Math.floor(Number(n) || 0));
      if (!limit) return [];
      return rows.slice(-limit);
    },
  };
}

/**
 * 解析来源：
 *   - 任何实现 retrieve() 的适配器（例如 TailWindowAdapter）→ 原样使用；
 *   - Memory 实例（dump + recentTurns）→ 包成 TailWindowAdapter；
 *   - 只读快照 { people, turns } → 包成只读替身后再包 TailWindowAdapter。
 */
function resolveSource(candidate, now) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.retrieve === 'function') return candidate;
  if (typeof candidate.dump === 'function' && typeof candidate.recentTurns === 'function') {
    return createTailWindowAdapter({ memory: candidate, now });
  }
  if (candidate.people && typeof candidate.people === 'object') {
    return createTailWindowAdapter({ memory: snapshotMemory(candidate), now });
  }
  return null;
}

// ── 适配器 ────────────────────────────────────────────────────

/**
 * 词面检索适配器。
 *
 *   const adapter = new LexicalAdapter({ memory });
 *   const result = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' } });
 *
 *   // 也可以包一层已有的尾窗口适配器，或直接包只读快照：
 *   const adapter = createLexicalAdapter({ source: createTailWindowAdapter({ memory }) });
 *   const adapter = createLexicalAdapter({ source: { people, turns } });
 *
 * @param {object} [opts]
 * @param {object} [opts.source]  已存在的检索适配器 / Memory 实例 / 只读快照
 * @param {object} [opts.adapter] source 的别名
 * @param {object} [opts.memory]  Memory 实例或只读快照（source 缺省时使用）
 * @param {() => number} [opts.now] 时钟注入，默认 Date.now（只为 generatedAt）
 */
export class LexicalAdapter {
  #source;
  #now;

  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.#source = resolveSource(opts.source ?? opts.adapter ?? opts.memory ?? null, this.#now);
  }

  /** 能力协商（§5.3）：词面检索可用，语义/本地索引不可用。 */
  get capabilities() {
    return { ...CAPABILITIES };
  }

  /**
   * 唯一的检索入口。缺参、参数非法、内部故障一律返回结构化结果，不抛错（T-3）。
   * 来源适配器必须是同步的：本方法同步返回，Brain 的 `await` 对同步返回值同样适用。
   *
   * @param {object} [request] MemoryRetrievalRequest 的最小子集，见文件头说明
   * @returns {object} MemoryRetrievalResult，见文件头说明
   */
  retrieve(request = {}) {
    const req = request && typeof request === 'object' ? request : {};
    const generatedAt = this.#timestamp();
    let requestId = null;
    try {
      requestId = isNonEmptyString(req.requestId) ? req.requestId.trim() : null;
    } catch {
      requestId = null;
    }
    let subjectId = null;
    let scope = null;
    try {
      subjectId = normalizeSubjectId(req);
      scope = normalizeScope(req);
    } catch {
      subjectId = null;
      scope = null;
    }
    const base = () => emptyResult({ requestId, generatedAt, subjectId, scope });

    try {
      // ① schema 版本不认识：显式降级，不猜着升级。
      if (req.schemaVersion !== undefined && req.schemaVersion !== null && Number(req.schemaVersion) !== SCHEMA_VERSION) {
        const out = base();
        out.degraded = { reason: 'schema-mismatch', fallback: 'tail-window' };
        out.notes.push('unsupported-schema-version');
        return out;
      }

      // ② 隔离条目的开关恒为 false（§4.1）：要求包含被隔离记忆时明确拒绝。
      if (req.policy && req.policy.includeQuarantined === true) {
        const out = base();
        out.degraded = { reason: 'schema-mismatch', fallback: 'tail-window' };
        out.privacy.denied = true;
        out.privacy.deniedReason = 'policy:includeQuarantined';
        out.notes.push('policy-refused:includeQuarantined');
        return out;
      }

      // ③ 没有主体就没有记忆：返回空，而不是"全场记忆"（§4.6.1）。
      if (!subjectId) {
        const out = base();
        out.privacy.denied = true;
        out.privacy.deniedReason = 'missing-subject';
        out.notes.push('missing-subject');
        return out;
      }

      // ④ 没有可用的来源：降级但不抛（T-3）。
      if (!this.#source) {
        const out = base();
        out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
        out.notes.push('missing-source');
        return out;
      }

      return this.#collect(req, { requestId, generatedAt, subjectId, scope });
    } catch (error) {
      // T-3：任何适配器故障都退化成空结果，只留机器可读的错误类别，不泄漏正文。
      const out = base();
      out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
      out.notes.push('adapter-error:' + errorLabel(error));
      return out;
    }
  }

  #timestamp() {
    try {
      const ms = Number(this.#now());
      const date = new Date(Number.isFinite(ms) ? ms : NaN);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    } catch { /* 时钟坏了也不能拖垮检索 */ }
    return new Date().toISOString();
  }

  #collect(req, { requestId, generatedAt, subjectId, scope }) {
    const out = emptyResult({ requestId, generatedAt, subjectId, scope });
    const kinds = normalizeKinds(req);
    const excludeKinds = normalizeExcludeKinds(req);
    const allowUnattributed = req.policy?.allowUnattributed === true;
    const budget = normalizeBudget(req);
    const whereFilters = normalizeWhere(req);
    const scopePrefix = scope ? WHERE_PREFIX_BY_SCOPE[scope] : null;
    const time = normalizeTimeWindow(req);
    const confidenceFloor = resolveConfidenceFloor(req.policy, out.notes);
    const query = queryText(req);
    const queryTokens = tokenizeQuery(query);

    out.lexical.queryTokens = queryTokens.size;

    // 类别过滤一个都不认识 → 空结果；不把"过滤不出来"当成"要全部"。
    if (kinds && kinds.size === 0) {
      out.notes.push('kinds-empty');
      return out;
    }
    if (time.invalid) out.notes.push('invalid-time-filter');

    const subjectConversationKey = typeof req.subject?.conversationKey === 'string'
      ? req.subject.conversationKey.trim()
      : '';
    const subject = { personId: subjectId, scope };
    if (typeof req.subject?.displayName === 'string') subject.displayName = req.subject.displayName;
    if (subjectConversationKey) subject.conversationKey = subjectConversationKey;
    else if (whereFilters && whereFilters.length === 1) subject.conversationKey = whereFilters[0];

    // 来源只负责取候选：主体/会话边界照传，类别/置信度/时间/预算由本适配器自己算，
    // 这样 omitted 计数不会被来源的预过滤悄悄吃掉。policy 显式要求"全都要"，
    // 以免来源按自己的默认值把低置信度候选先删掉。
    const sourceRequest = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      subject,
      subjectId,
      scope,
      where: whereFilters && whereFilters.length === 1 ? whereFilters[0] : (whereFilters ?? undefined),
      query: { text: '', kinds: null },
      budget: { maxRecords: SOURCE_MAX_RECORDS, maxChars: SOURCE_MAX_CHARS },
      policy: {
        minConfidence: 0,
        includeUnverified: true,
        includeQuarantined: false,
        excludeKinds: null,
        allowUnattributed,
      },
      order: 'newest-first',
    };
    if (req.requester !== undefined) sourceRequest.requester = req.requester;
    if (req.trace !== undefined) sourceRequest.trace = req.trace;

    let sourceResult;
    try {
      sourceResult = this.#source.retrieve(sourceRequest);
    } catch (error) {
      out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
      out.notes.push('source-error:' + errorLabel(error));
      return out;
    }

    if (sourceResult && typeof sourceResult.then === 'function') {
      out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
      out.notes.push('async-source-unsupported');
      return out;
    }
    if (!sourceResult || typeof sourceResult !== 'object') {
      out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
      out.notes.push('invalid-source-result');
      return out;
    }
    if (!Array.isArray(sourceResult.records)) {
      out.degraded = { reason: 'adapter-error', fallback: 'tail-window' };
      out.notes.push('invalid-source-records');
      return out;
    }

    // 来源的隐私拒绝优先：不渲染、也不回退到别人的记录。
    if (sourceResult.privacy?.denied === true) {
      out.privacy.denied = true;
      out.privacy.deniedReason = isNonEmptyString(sourceResult.privacy.deniedReason)
        ? sourceResult.privacy.deniedReason
        : 'source-denied';
      out.notes.push('source-denied');
      return out;
    }

    const sourceDegraded = normalizeSourceDegraded(sourceResult.degraded);
    if (sourceDegraded && sourceDegraded.reason !== 'index-missing') {
      out.degraded = { reason: sourceDegraded.reason, fallback: 'tail-window' };
      out.notes.push('source-degraded:' + sourceDegraded.reason);
      return out;
    }

    const omitted = new Map();
    const bump = (reason, count = 1) => {
      if (!OMITTED_REASON_ORDER.includes(reason) || count <= 0) return;
      omitted.set(reason, (omitted.get(reason) || 0) + count);
    };
    mergeSourceOmissions(omitted, sourceResult.omitted);

    const candidates = [];
    for (let index = 0; index < sourceResult.records.length; index += 1) {
      const record = sourceResult.records[index];
      const verdict = classifyRecord(record, {
        subjectId,
        allowUnattributed,
        kinds,
        excludeKinds,
        scopePrefix,
        whereFilters,
        time,
        confidenceFloor,
      });
      if (verdict) {
        bump(verdict.reason);
        if (verdict.tombstone) out.privacy.tombstoned += 1;
        if (verdict.redacted) out.privacy.redactedCount += 1;
        continue;
      }
      candidates.push({
        record,
        score: zeroScore(),
        observedMs: observedMs(record),
        originalIndex: index,
      });
    }

    // 打分：query.text 是唯一排序输入；空查询/无可用词直接走尾窗口降级。
    let matchedRecords = 0;
    if (queryTokens.size === 0) {
      out.degraded = { reason: 'index-missing', fallback: 'tail-window' };
      out.notes.push(query ? 'query-too-short:tail-window' : 'query-empty:tail-window');
    } else {
      for (const candidate of candidates) {
        candidate.score = scoreRecord(candidate.record, queryTokens);
        if (candidate.score.relevance > 0) matchedRecords += 1;
      }
      if (matchedRecords === 0) out.notes.push('no-lexical-match');
    }

    const ordered = candidates.slice().sort(compareCandidates);

    // 预算：自己按 maxRecords / maxChars 截断（T-4）。
    const records = [];
    let charsUsed = 0;
    for (const candidate of ordered) {
      if (records.length >= budget.maxRecords) {
        bump('budget');
        continue;
      }
      const cost = recordCost(candidate.record);
      if (charsUsed + cost > budget.maxChars) {
        bump('budget');
        continue;
      }
      records.push(cloneRecord(candidate.record, candidate.score));
      charsUsed += cost;
    }

    const reasons = OMITTED_REASON_ORDER
      .filter((reason) => (omitted.get(reason) || 0) > 0)
      .map((reason) => ({ reason, count: omitted.get(reason) }));

    out.records = records;
    out.budget = {
      charsUsed,
      recordsUsed: records.length,
      truncated: (omitted.get('budget') || 0) > 0,
    };
    out.omitted = {
      count: reasons.reduce((sum, item) => sum + item.count, 0),
      reasons,
    };
    out.lexical = {
      queryTokens: queryTokens.size,
      // 候选池里有词面命中的条数（预算之前）；order 看的是最终返回集。
      matchedRecords,
      order: records.some((record) => record.score.relevance > 0) ? 'relevance' : 'tail-window',
    };
    return out;
  }
}

/** 来源降级归一化：只认契约里的三个 reason；未知值按 adapter-error 处理。 */
function normalizeSourceDegraded(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    if (value === 'index-missing') return { reason: 'index-missing' };
    if (value === 'schema-mismatch') return { reason: 'schema-mismatch' };
    return { reason: 'adapter-error' };
  }
  if (typeof value === 'object') {
    if (value.reason === 'index-missing') return { reason: 'index-missing' };
    if (value.reason === 'schema-mismatch') return { reason: 'schema-mismatch' };
    return { reason: 'adapter-error' };
  }
  return null;
}

/** 把来源报告的 omitted 计数并入本适配器的计数（来源已排除的记录不会被重复计数）。 */
function mergeSourceOmissions(omitted, sourceOmitted) {
  if (!sourceOmitted || !Array.isArray(sourceOmitted.reasons)) return;
  for (const item of sourceOmitted.reasons) {
    if (!item || typeof item !== 'object') continue;
    const reason = String(item.reason ?? '');
    if (!OMITTED_REASON_ORDER.includes(reason)) continue;
    const count = Math.floor(Number(item.count));
    if (Number.isFinite(count) && count > 0) {
      omitted.set(reason, (omitted.get(reason) || 0) + count);
    }
  }
}

/** 工厂：与 `new LexicalAdapter(opts)` 等价，调用方按习惯挑一种。 */
export function createLexicalAdapter(options = {}) {
  return new LexicalAdapter(options);
}

export const RETRIEVAL_SCHEMA_VERSION = SCHEMA_VERSION;
export const LEXICAL_ADAPTER = Object.freeze({ id: ADAPTER_ID, version: ADAPTER_VERSION, mode: ADAPTER_MODE });
export const LEXICAL_CAPABILITIES = CAPABILITIES;
