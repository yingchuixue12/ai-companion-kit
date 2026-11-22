/**
 * 记忆尾窗口适配器 · tail-window retrieval adapter
 * ─────────────────────────────────────────────────────────────
 * 记录形状沿用同目录的 record-contract.js（layer / kind / provenance / correction /
 * privacy 的取值域），本文件不另立一套字段约定。
 *
 * 这一版只做一件小事：把「这个人最近发生过的事」按确定顺序取出来，带上出处、
 * 条数与字符预算。没有向量库、没有 embedding、没有网络请求；`query` 只接受、
 * 不解释（capabilities 里 lexical / semantic / localIndex 全为 false）。
 *
 * 读取方式：只用 Memory 的公开只读方法（dump() / recentTurns()）。
 * 不调用 person() / remember() / logTurn() 这些会写盘的接口——检索本身不创建
 * 人物、不改动任何数据文件。也不 import brain.js / transport-onebot.js，
 * 接缝保持独立，留给后续 worker 接到 prompt 组装里。
 *
 * ── 请求：retrieve(request) ─────────────────────────────────
 * 契约字段（检索请求的最小子集，都可缺省）：
 *   schemaVersion  应为 1；给了别的版本 → degraded.reason='schema-mismatch'
 *   requestId      原样回显
 *   subject        { personId, scope }；scope ∈ private | group | web | cli
 *   query          { text, kinds }；text 不参与检索，只用来标记降级；kinds 是类别过滤
 *   budget         { maxRecords, maxChars }
 *   policy         { allowUnattributed, includeQuarantined, excludeKinds }
 * 本模块附加的调用别名（非契约，方便宿主直接传）：
 *   subjectId        ← subject.personId 的简写（也接受 subject 直接是字符串）
 *   scope            ← subject.scope 的简写
 *   where            ← 会话键精确过滤，string 或 string[]（对应 turns.jsonl 的 where）
 *   conversationKey  ← where 的简写（可用 where: 'private:123' 只取某个私聊）
 *   kinds            ← query.kinds 的简写
 *   limit / maxChars ← budget.maxRecords / budget.maxChars 的简写
 *   order            'newest-first'（默认）| 'oldest-first'
 *
 * ── 结果：MemoryRetrievalResult ─────────────────────────────
 * 契约字段：schemaVersion / requestId / adapter{id,version,mode,capabilities} /
 *   generatedAt / subject{personId,scope} / records[] /
 *   budget{charsUsed,recordsUsed,truncated} /
 *   omitted{count,reasons[{reason,count}]} /
 *   degraded(null | {reason, fallback}) /
 *   privacy{redactedCount,tombstoned}
 * 本模块附加的字段（只增不改名，调用方可以忽略）：
 *   tail{order,kinds,scopePrefix,where,allowUnattributed}  本次请求实际生效的窗口参数
 *   notes[]                                                机器可读的短标记（不含记忆正文）
 *   privacy.denied / privacy.deniedReason                  是否因隐私边界返回空结果
 *   records[].reply  仅 kind='turn'：turns.jsonl 里宿主核实过的回复原文（无则为 null）
 *
 * ── 顺序（显式约定；是通用排序规则在 tail-window 模式下的收窄） ──
 * 默认 newest-first，排序键依次为：
 *   1) score.total 降序（尾窗口不打分，恒为 0）
 *   2) observedAt 降序。turns 用行内 t；账本条目没有条目级时间，用该人的
 *      lastSeenAt 近似（旧账本只有这个人级别的时间戳）；两者都缺时为 null 并排在最末——不编造时间
 *   3) kind 分组序 trait → fact → topic → pending → turn
 *   4) 同一 kind 内越靠后写入的越新（账本数组倒序；turns 按行序倒序）
 *   5) id 字典序升序（兜底；保证同一快照同一输出）
 * order='oldest-first' 时取上述顺序的严格倒序。
 * 不打分、不用 Math.random()、不依赖 Map 迭代顺序（确定性要求）。
 *
 * ── 隐私 ───────────────────────────────────────────────────
 * - 账本条目只来自 subjectId 本人；subjectId 缺失/为空 → 空结果 + privacy.denied，
 *   而不是"返回全场记忆"（多发送者群聊 memoryUserId=null 走这条）。
 * - turns 只收 userId 明确等于 subjectId 的行；缺 userId 的旧行默认排除
 *   （policy.allowUnattributed=true 才收，此时 subjectId=null、confidence=0.30）。
 * - turns 必须显式给 scope 或 where/conversationKey：scope 决定 where 前缀
 *   （private / group / flandre-web / cli）。群 scope 看不到私聊尾部，私聊 scope
 *   看不到群尾部；什么都不给时干脆不读 turns，避免把一段历史拼进别的场合。
 *   where 前缀由本适配器逐行复核（不依赖 Memory 的 wherePrefix 可选参数）：
 *   来源实现忽略该参数时，跨场合的行仍按 out-of-scope 挡掉，诊断计数也不会
 *   随来源实现不同而漂移。
 *
 * ── 预算（记录条数上限与字符上限）────────────────────────────
 * maxRecords 限条数、maxChars 限字符（UTF-16 长度，与仓库现有口径一致）。
 * 单条放不下就跳过并计入 omitted.reasons[budget]，不中途停止（后面的短条目仍可能放入）。
 * 超预算由本适配器自己截断，绝不把超长文本丢给 Role.build 的兜底裁剪。
 *
 * ── 本切片不做（后续任务）──────────────────────────────────
 * 不渲染 prompt 块、不做词面/语义检索、不实现 renderPerson/renderRecent 的
 * 字节等价外壳、不做 v1→v2 迁移与污染隔离标注、
 * 不写任何文件、不发任何网络请求。
 */

const SCHEMA_VERSION = 1;
const ADAPTER_ID = 'tail-window';
const ADAPTER_VERSION = '1.0.0';
const ADAPTER_MODE = 'tail-window';
const CAPABILITIES = Object.freeze({ lexical: false, semantic: false, localIndex: false });

/** 账本 kind → people.json 字段名（与 memory.js 的 FIELD_BY_KIND 同一口径）。 */
const LEDGER_FIELD_BY_KIND = Object.freeze({
  trait: 'traits',
  fact: 'facts',
  topic: 'topics',
  pending: 'pending',
});

/** 同 observedAt 下的分组序（见文件头「顺序」第 3 条）。 */
const KIND_RANK = Object.freeze({ trait: 0, fact: 1, topic: 2, pending: 3, turn: 4 });

/** kind → 记录契约的 layer（取值域见 record-contract.js 的 RECORD_LAYERS）。 */
const LAYER_BY_KIND = Object.freeze({
  trait: 'user_fact',
  fact: 'user_fact',
  pending: 'user_fact',
  topic: 'shared_experience',
  turn: 'shared_experience',
});

/** kind → 契约 stability：性格/事实视为稳定，话题/待办/对话轮视为易变。 */
const STABILITY_BY_KIND = Object.freeze({
  trait: 'stable',
  fact: 'stable',
  topic: 'volatile',
  pending: 'volatile',
  turn: 'volatile',
});

/** scope → turns.jsonl 里 where 的前缀（现状取值：private:* / group:* / flandre-web / cli）。 */
const WHERE_PREFIX_BY_SCOPE = Object.freeze({
  private: 'private',
  group: 'group',
  web: 'flandre-web',
  cli: 'cli',
});

const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_MAX_CHARS = 9000;

/** omitted.reasons 的固定输出顺序（计数为 0 的不输出），保证同输入同输出。 */
const OMITTED_REASON_ORDER = Object.freeze(['privacy', 'out-of-scope', 'quarantined', 'low-confidence', 'budget']);

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

/** epoch 毫秒；非法/缺失返回 null（不许拿 0 冒充"很久以前"）。 */
function timestampMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 对外一律 ISO 8601 UTC；取不到就 null，不编造。 */
function toIsoString(value) {
  const ms = timestampMs(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** FNV-1a：确定性稳定 id 用，不依赖运行时随机数。 */
function stableHash(parts) {
  let h = 0x811c9dc5;
  const joined = parts.map((part) => String(part ?? '')).join('\u0001');
  for (let i = 0; i < joined.length; i += 1) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function emptyCorrection() {
  return { status: 'active', supersedes: null, correctedBy: null, tombstone: null };
}

function emptyPrivacy() {
  return { level: 'normal', pii: false, redacted: false, retainUntil: null };
}

/** 尾窗口不打分：分数全 0，排序落到 observedAt 与 id 上。 */
function zeroScore() {
  return { total: 0, relevance: 0, recency: 0, components: { relevance: 0, recency: 0 } };
}

/** v2 记录复制：保留 provenance / correction / privacy / quarantine，只重算 score。 */
function cloneV2Record(record) {
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
  const out = { ...record, provenance, correction, privacy, score: zeroScore() };
  if (record.quarantine && typeof record.quarantine === 'object') {
    out.quarantine = {
      ...record.quarantine,
      rules: Array.isArray(record.quarantine.rules) ? [...record.quarantine.rules] : record.quarantine.rules,
    };
  }
  return out;
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
    tail: { order: 'newest-first', kinds: null, scopePrefix: null, where: null, allowUnattributed: false },
    notes: [],
  };
}

// ── 请求归一化 ────────────────────────────────────────────────

function normalizeSubjectId(request) {
  const subject = request?.subject;
  if (typeof subject === 'string') return normalizeId(subject);
  if (subject && typeof subject === 'object') return normalizeId(subject.personId);
  return normalizeId(request?.subjectId);
}

function normalizeScope(request) {
  const raw = request?.subject && typeof request.subject === 'object' && request.subject.scope !== undefined
    ? request.subject.scope
    : request?.scope;
  const s = String(raw ?? '').trim().toLowerCase();
  return Object.hasOwn(WHERE_PREFIX_BY_SCOPE, s) ? s : null;
}

/** where / conversationKey：会话键精确过滤（string 或 string[]）。 */
function normalizeWhere(request) {
  const raw = request?.where ?? request?.conversationKey ?? (request?.subject && typeof request.subject === 'object'
    ? request.subject.conversationKey
    : undefined);
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

/** 类别过滤：null = 不过滤；空 Set = 调用方要的类别一个都不认识（返回空，而不是"全部"）。 */
function normalizeKinds(request) {
  const raw = request?.query?.kinds ?? request?.kinds;
  if (raw === undefined || raw === null) return null;
  const list = (Array.isArray(raw) ? raw : [raw]).map((k) => String(k ?? '').trim().toLowerCase());
  return new Set(list.filter((k) => Object.hasOwn(KIND_RANK, k)));
}

function normalizeExcludeKinds(request) {
  const raw = request?.policy?.excludeKinds;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean));
}

function normalizeOrder(request) {
  return String(request?.order ?? '').trim().toLowerCase() === 'oldest-first' ? 'oldest-first' : 'newest-first';
}

function queryText(request) {
  const raw = request?.query?.text;
  return typeof raw === 'string' ? raw.trim() : '';
}

// ── 排序 ──────────────────────────────────────────────────────

/** newest-first：observedAt 降序 → kind 分组序 → 同组内新者在前 → id 升序兜底。 */
function compareCandidatesNewestFirst(a, b) {
  const am = a.observedMs === null ? Number.NEGATIVE_INFINITY : a.observedMs;
  const bm = b.observedMs === null ? Number.NEGATIVE_INFINITY : b.observedMs;
  if (am !== bm) return bm > am ? 1 : -1;
  if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;
  if (a.sourceIndex !== b.sourceIndex) return b.sourceIndex - a.sourceIndex;
  if (a.record.id === b.record.id) return 0;
  return a.record.id < b.record.id ? -1 : 1;
}

/** oldest-first：上面那条顺序的严格倒序（文档化，不另起一套规则）。 */
function compareCandidatesOldestFirst(a, b) {
  return -compareCandidatesNewestFirst(a, b);
}

// ── 适配器 ────────────────────────────────────────────────────

/**
 * 尾窗口适配器。
 *
 *   const adapter = new TailWindowAdapter({ memory });
 *   const result = adapter.retrieve({ subjectId: 'u1', scope: 'private', budget: { maxRecords: 10 } });
 *
 * @param {object} [opts]
 * @param {object} [opts.memory]  Memory 实例（或任何提供 dump() / recentTurns() 的只读替身）
 * @param {() => number} [opts.now]  时钟注入，默认 Date.now（只为让测试拿到稳定的 generatedAt）
 */
export class TailWindowAdapter {
  #memory;
  #now;

  constructor({ memory = null, now = () => Date.now() } = {}) {
    this.#memory = memory || null;
    this.#now = typeof now === 'function' ? now : () => Date.now();
  }

  /** 能力协商：本模式三项均为 false，不做词面/语义/本地索引检索。 */
  get capabilities() {
    return { ...CAPABILITIES };
  }

  /**
   * 唯一的检索入口。缺参、参数非法、内部故障一律返回结构化结果，不抛错（T-3）。
   *
   * @param {object} [request] MemoryRetrievalRequest 的最小子集，见文件头说明
   * @returns {object} MemoryRetrievalResult，见文件头说明
   */
  retrieve(request = {}) {
    const req = request && typeof request === 'object' ? request : {};
    const generatedAt = this.#timestamp();
    const requestId = isNonEmptyString(req.requestId) ? req.requestId.trim() : null;
    const subjectId = normalizeSubjectId(req);
    const scope = normalizeScope(req);
    const base = () => emptyResult({ requestId, generatedAt, subjectId, scope });

    // ① schema 版本不认识：显式降级，不猜着升级。
    if (req.schemaVersion !== undefined && req.schemaVersion !== null && Number(req.schemaVersion) !== SCHEMA_VERSION) {
      const out = base();
      out.degraded = { reason: 'schema-mismatch', fallback: ADAPTER_MODE };
      out.notes.push('unsupported-schema-version');
      return out;
    }

    // ② 隔离条目的开关恒为 false：调用方要求包含被隔离记忆时直接拒绝，而不是照做。
    if (req.policy && req.policy.includeQuarantined === true) {
      const out = base();
      out.degraded = { reason: 'schema-mismatch', fallback: ADAPTER_MODE };
      out.privacy.denied = true;
      out.privacy.deniedReason = 'policy:includeQuarantined';
      out.notes.push('policy-refused:includeQuarantined');
      return out;
    }

    // ③ 没有主体就没有记忆：返回空，而不是"全场记忆"。
    if (!subjectId) {
      const out = base();
      out.privacy.denied = true;
      out.privacy.deniedReason = 'missing-subject';
      out.notes.push('missing-subject');
      return out;
    }

    // ④ 没有账本实例：降级但不抛（T-3）。
    if (!this.#memory || typeof this.#memory !== 'object') {
      const out = base();
      out.degraded = { reason: 'adapter-error', fallback: ADAPTER_MODE };
      out.notes.push('missing-memory');
      return out;
    }

    try {
      return this.#collect(req, { requestId, generatedAt, subjectId, scope });
    } catch (error) {
      // T-3：任何适配器故障都退化成空窗口，只留机器可读的错误类别，不泄漏正文。
      const out = base();
      out.degraded = { reason: 'adapter-error', fallback: ADAPTER_MODE };
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

  /**
   * 只读 turns.jsonl 的尾部（不传 wherePrefix：不同 Memory 实现对该可选参数的支持
   * 不一致，过滤放在本适配器里做，诊断计数才不会随来源实现漂移）。
   * scope / where 的逐行检查见 #collect：隐私边界不依赖来源恰好守约。
   */
  #readTurns() {
    if (typeof this.#memory.recentTurns !== 'function') return [];
    const rows = this.#memory.recentTurns(Number.MAX_SAFE_INTEGER);
    return Array.isArray(rows) ? rows : [];
  }

  #isV2Memory() {
    return Boolean(this.#memory)
      && this.#memory.layoutVersion === 2
      && typeof this.#memory.listRecords === 'function';
  }

  /**
   * v2 分支：直接消费 MemoryRecord，保留 migration / host_verified / model_claim
   * 等出处，以及 active / quarantined / deleted / superseded 状态与隐私等级。
   * 只做主体/会话/类别/状态过滤和预算，不重新解释记录。
   */
  #collectV2({ out, subjectId, kinds, excludeKinds, allowUnattributed, budget, order, whereFilters, scopePrefix, req }) {
    const status = typeof this.#memory.status === 'function' ? this.#memory.status() : null;
    if (status && status.ok === false) {
      const reason = status.state === 'schema-mismatch'
        ? 'schema-mismatch'
        : (status.state === 'missing' ? 'index-missing' : 'adapter-error');
      out.degraded = { reason, fallback: ADAPTER_MODE };
      out.notes.push('store-' + String(status.state || 'unavailable'));
      return out;
    }

    let sourceRecords;
    try {
      sourceRecords = this.#memory.listRecords({ includeInactive: true });
    } catch {
      out.degraded = { reason: 'adapter-error', fallback: ADAPTER_MODE };
      out.notes.push('store-read-error');
      return out;
    }
    if (!Array.isArray(sourceRecords)) {
      out.degraded = { reason: 'adapter-error', fallback: ADAPTER_MODE };
      out.notes.push('store-records-invalid');
      return out;
    }

    const omitted = new Map();
    const bump = (reason, count = 1) => {
      if (count > 0) omitted.set(reason, (omitted.get(reason) || 0) + count);
    };
    const candidates = [];

    for (let index = 0; index < sourceRecords.length; index += 1) {
      const record = sourceRecords[index];
      if (!record || typeof record !== 'object') {
        bump('low-confidence');
        continue;
      }
      const kind = String(record.kind || '');
      const rawSubject = record.subjectId;
      const recordSubject = rawSubject === undefined || rawSubject === null ? null : String(rawSubject).trim();

      // ① 主体边界：别人的记录一条都不进来。
      if (recordSubject === null) {
        if (!allowUnattributed || kind !== 'turn') {
          bump('privacy');
          continue;
        }
      } else if (recordSubject !== String(subjectId)) {
        bump('privacy');
        continue;
      }

      // ② 状态：只有 active 可以返回；deleted/quarantined/superseded 显式计数。
      const recordStatus = record.correction?.status;
      if (recordStatus === 'quarantined') {
        bump('quarantined');
        continue;
      }
      if (recordStatus === 'deleted') {
        bump('privacy');
        out.privacy.tombstoned += 1;
        continue;
      }
      if (recordStatus === 'superseded') {
        bump('low-confidence');
        continue;
      }
      if (recordStatus !== 'active') {
        bump('low-confidence');
        continue;
      }

      // ③ 脱敏 / 受限记录永不返回。
      if (record.privacy?.redacted === true) {
        bump('privacy');
        out.privacy.redactedCount += 1;
        continue;
      }
      if (record.privacy?.level === 'restricted') {
        bump('privacy');
        continue;
      }

      // ④ 没有 refs 的记录不得进入结果集（出处是硬性要求）。
      const refs = record.provenance?.refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        bump('low-confidence');
        continue;
      }

      // ⑤ 文本必须可渲染；turn 允许只有 reply。
      const text = typeof record.text === 'string' ? record.text : '';
      const reply = kind === 'turn' && typeof record.reply === 'string' ? record.reply : '';
      if (!text.trim() && !reply.trim()) {
        bump('low-confidence');
        continue;
      }

      // ⑥ 类别过滤（过滤器，不参与排序）。
      if (!Object.hasOwn(KIND_RANK, kind)) {
        bump('out-of-scope');
        continue;
      }
      if ((kinds && !kinds.has(kind)) || excludeKinds.has(kind)) {
        bump('out-of-scope');
        continue;
      }

      // ⑦ turn 必须能回指到本次请求的会话键（范围边界）。
      if (kind === 'turn') {
        const turnRefs = refs.filter((ref) => ref && typeof ref === 'object' && ref.kind === 'turn');
        if (turnRefs.length === 0) {
          bump('out-of-scope');
          continue;
        }
        let allowed = true;
        for (const ref of turnRefs) {
          const refUserId = ref.userId === undefined || ref.userId === null ? null : String(ref.userId).trim() || null;
          if (refUserId === null) {
            if (!allowUnattributed) {
              bump('privacy');
              allowed = false;
              break;
            }
          } else if (refUserId !== String(subjectId)) {
            bump('privacy');
            allowed = false;
            break;
          }
          const refWhere = typeof ref.where === 'string' ? ref.where.trim() : '';
          if (!refWhere) {
            bump('out-of-scope');
            allowed = false;
            break;
          }
          if (!scopePrefix && !whereFilters) {
            bump('out-of-scope');
            allowed = false;
            break;
          }
          if (scopePrefix && !refWhere.startsWith(scopePrefix)) {
            bump('out-of-scope');
            allowed = false;
            break;
          }
          if (whereFilters && !whereFilters.includes(refWhere)) {
            bump('out-of-scope');
            allowed = false;
            break;
          }
        }
        if (!allowed) continue;
      }

      const observedMs = timestampMs(Date.parse(record.observedAt));
      candidates.push({
        record: cloneV2Record(record),
        cost: text.length + reply.length,
        observedMs,
        kindRank: KIND_RANK[kind],
        sourceIndex: index,
      });
    }

    const ordered = candidates
      .slice()
      .sort(order === 'oldest-first' ? compareCandidatesOldestFirst : compareCandidatesNewestFirst);

    const records = [];
    let charsUsed = 0;
    for (const candidate of ordered) {
      if (records.length >= budget.maxRecords || charsUsed + candidate.cost > budget.maxChars) {
        bump('budget');
        continue;
      }
      records.push(candidate.record);
      charsUsed += candidate.cost;
    }

    const reasons = OMITTED_REASON_ORDER
      .filter((reason) => (omitted.get(reason) || 0) > 0)
      .map((reason) => ({ reason, count: omitted.get(reason) }));

    out.records = records;
    out.budget = { charsUsed, recordsUsed: records.length, truncated: (omitted.get('budget') || 0) > 0 };
    out.omitted = { count: reasons.reduce((sum, item) => sum + item.count, 0), reasons };

    // query 只接受不解释：tail-window 不做词面检索（M2 才做）。
    if (queryText(req)) {
      out.degraded = { reason: 'index-missing', fallback: ADAPTER_MODE };
      out.notes.push('query-not-searched');
    }
    return out;
  }

  #collect(req, { requestId, generatedAt, subjectId, scope }) {
    const out = emptyResult({ requestId, generatedAt, subjectId, scope });
    const kinds = normalizeKinds(req);
    const excludeKinds = normalizeExcludeKinds(req);
    const allowUnattributed = req.policy?.allowUnattributed === true;
    const budget = normalizeBudget(req);
    const order = normalizeOrder(req);
    const whereFilters = normalizeWhere(req);
    const scopePrefix = scope ? WHERE_PREFIX_BY_SCOPE[scope] : null;
    const wantTurns = (!kinds || kinds.has('turn')) && !excludeKinds.has('turn');

    out.tail = {
      order,
      kinds: kinds ? Array.from(kinds).sort() : null,
      scopePrefix,
      where: whereFilters,
      allowUnattributed,
    };

    // 类别过滤一个都不认识 → 空结果；不把"过滤不出来"当成"要全部"。
    if (kinds && kinds.size === 0) {
      out.notes.push('kinds-empty');
      return out;
    }

    // v2 存储：记录自带 provenance / correction / privacy，必须原样保留，
    // 不能像 legacy 那样在适配器里重新合成“未验证的 migration 记录”。
    if (this.#isV2Memory()) {
      return this.#collectV2({
        out, subjectId, kinds, excludeKinds, allowUnattributed, budget, order, whereFilters, scopePrefix, req,
      });
    }

    const usedIds = new Map();
    const omitted = new Map();
    const bump = (reason, count = 1) => {
      if (count > 0) omitted.set(reason, (omitted.get(reason) || 0) + count);
    };
    const nextId = (kind, parts) => {
      const candidate = 'mem_tw_' + kind + '_' + stableHash(parts);
      const seen = usedIds.get(candidate) || 0;
      usedIds.set(candidate, seen + 1);
      return seen === 0 ? candidate : candidate + '_' + (seen + 1);
    };

    /** @type {Array<{record: object, cost: number, observedMs: number|null, kindRank: number, sourceIndex: number}>} */
    const candidates = [];

    // ── 账本（people.json）：只读 dump()，绝不调用 person()（那会创建人物并写盘） ──
    const dump = typeof this.#memory.dump === 'function' ? this.#memory.dump() : null;
    const person = dump && dump.people && typeof dump.people === 'object' ? dump.people[String(subjectId)] : null;
    const ledgerMs = timestampMs(person?.lastSeenAt);
    const ledgerIso = toIsoString(person?.lastSeenAt);
    if (person) {
      for (const [kind, field] of Object.entries(LEDGER_FIELD_BY_KIND)) {
        const entries = Array.isArray(person[field]) ? person[field] : [];
        if (!entries.length) continue;
        if ((kinds && !kinds.has(kind)) || excludeKinds.has(kind)) {
          bump('out-of-scope', entries.length);
          continue;
        }
        for (let index = 0; index < entries.length; index += 1) {
          const text = typeof entries[index] === 'string' ? entries[index] : '';
          if (!text.trim()) continue;
          candidates.push({
            record: {
              id: nextId(kind, [kind, subjectId, field, index, text]),
              subjectId: String(subjectId),
              layer: LAYER_BY_KIND[kind],
              kind,
              text,
              provenance: {
                source: 'migration',
                refs: [{ kind: 'action', line: 'remember:' + kind }],
                adapter: ADAPTER_ID,
              },
              observedAt: ledgerIso,
              recordedAt: ledgerIso,
              lastConfirmedAt: null,
              confidence: 0.3,
              stability: STABILITY_BY_KIND[kind],
              correction: emptyCorrection(),
              privacy: emptyPrivacy(),
              score: zeroScore(),
            },
            cost: text.length,
            observedMs: ledgerMs,
            kindRank: KIND_RANK[kind],
            sourceIndex: index,
          });
        }
      }
    }

    // ── 共享对话流（turns.jsonl）：没有 scope / where 就不读，避免跨场合拼接 ──
    if (wantTurns && (scopePrefix || whereFilters)) {
      const rows = this.#readTurns();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (!row || typeof row !== 'object') continue;
        const rowWhere = String(row.where ?? '').trim();
        // scope 决定 where 前缀：在这里逐行挡掉别的场合（不依赖 Memory 的 wherePrefix）。
        if (scopePrefix && !rowWhere.startsWith(scopePrefix)) {
          bump('out-of-scope');
          continue;
        }
        if (whereFilters && !whereFilters.includes(rowWhere)) {
          bump('out-of-scope');
          continue;
        }
        const rowUserId = row.userId === undefined || row.userId === null ? '' : String(row.userId).trim();
        if (!rowUserId) {
          if (!allowUnattributed) {
            bump('privacy');
            continue;
          }
        } else if (rowUserId !== String(subjectId)) {
          // 别人的行一律不进结果集（主体边界）。
          bump('privacy');
          continue;
        }
        const text = typeof row.text === 'string' ? row.text : '';
        const reply = typeof row.reply === 'string' && row.reply ? row.reply : null;
        if (!text && !reply) continue;
        const unattributed = !rowUserId;
        const observedMs = timestampMs(row.t);
        candidates.push({
          record: {
            id: nextId('turn', ['turn', subjectId, rowWhere, row.t ?? '', text, reply || '']),
            subjectId: unattributed ? null : String(subjectId),
            layer: LAYER_BY_KIND.turn,
            kind: 'turn',
            text,
            reply,
            provenance: {
              source: unattributed ? 'migration' : 'host_verified',
              refs: [{ kind: 'turn', where: rowWhere, t: toIsoString(row.t), userId: rowUserId || null }],
              adapter: ADAPTER_ID,
            },
            observedAt: toIsoString(row.t),
            recordedAt: toIsoString(row.t),
            lastConfirmedAt: null,
            confidence: unattributed ? 0.3 : 0.95,
            stability: STABILITY_BY_KIND.turn,
            correction: emptyCorrection(),
            privacy: emptyPrivacy(),
            score: zeroScore(),
          },
          cost: text.length + (reply ? reply.length : 0),
          observedMs,
          kindRank: KIND_RANK.turn,
          sourceIndex: index,
        });
      }
    } else if (wantTurns) {
      out.notes.push('turns-not-read:no-scope');
    }

    const ordered = candidates
      .slice()
      .sort(order === 'oldest-first' ? compareCandidatesOldestFirst : compareCandidatesNewestFirst);

    // ── 预算：自己按 maxRecords / maxChars 截断（T-4） ──
    const records = [];
    let charsUsed = 0;
    for (const candidate of ordered) {
      if (records.length >= budget.maxRecords || charsUsed + candidate.cost > budget.maxChars) {
        bump('budget');
        continue;
      }
      records.push(candidate.record);
      charsUsed += candidate.cost;
    }

    const reasons = OMITTED_REASON_ORDER
      .filter((reason) => (omitted.get(reason) || 0) > 0)
      .map((reason) => ({ reason, count: omitted.get(reason) }));

    out.records = records;
    out.budget = { charsUsed, recordsUsed: records.length, truncated: (omitted.get('budget') || 0) > 0 };
    out.omitted = { count: reasons.reduce((sum, item) => sum + item.count, 0), reasons };

    // query 只接受不解释：带了检索词就明说"这不是相关性检索"（M2/M3 尚未实现的显式痕迹）。
    if (queryText(req)) {
      out.degraded = { reason: 'index-missing', fallback: ADAPTER_MODE };
      out.notes.push('query-not-searched');
    }
    return out;
  }
}

/** 工厂：与 `new TailWindowAdapter(opts)` 等价，调用方按习惯挑一种。 */
export function createTailWindowAdapter(options = {}) {
  return new TailWindowAdapter(options);
}

export const RETRIEVAL_SCHEMA_VERSION = SCHEMA_VERSION;
export const TAIL_WINDOW_ADAPTER = Object.freeze({ id: ADAPTER_ID, version: ADAPTER_VERSION, mode: ADAPTER_MODE });
export const TAIL_WINDOW_CAPABILITIES = CAPABILITIES;
