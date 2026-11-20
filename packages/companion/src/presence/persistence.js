/**
 * 在场状态持久化 · presence state store
 * ─────────────────────────────────────────────────────────────
 * 契约位置：docs/flandre-execution-plan.md §4.3（T3）；docs/flandre-decisions.md C-P3。
 *
 * 这个模块只做一件事：把「在场状态 / 冷却 / 会话锚点」以**内容盲**的固定
 * schema 落盘、再读回来。它不认识消息、窗口标题、应用名、URL、账号或转写：
 * 落盘前按白名单重建对象，落盘后按白名单严格校验，多一个键就 fail-closed，
 * 所以调用方不小心把整段运行时对象传进来，也不会把正文写进文件。
 *
 * ── 允许持久化的字段（唯一白名单）──────────────────────────
 *   version           schema 版本（当前 1）
 *   state             unknown / present / idle / away
 *   updatedAt         最后写入时间（毫秒时间戳，永远是数字）
 *   sessionStartedAt  当前在场会话的起点（毫秒或 null）
 *   activeMs          已累计的在场时长（非负整数）
 *   cooldowns         { welcome, break, proactive } → 毫秒时间戳或 null
 *   deliveredIds      已结算 intent 的记录：[`YYYY-MM-DD|status|id`]
 *                     （attempting/sent/accepted/partial/failed/unknown/skipped；
 *                      只有 sent 代表确认送达，accepted 只用于防刷屏限额）
 *
 * 这里没有任何 text / title / app / url / account / transcript 字段，
 * 也没有可扩展的 extra 槽位——schema 本身就是隐私边界。
 *
 * ── 失败语义（fail-closed，不猜测）──────────────────────────
 *   load():
 *     文件不存在        → { ok:true,  state:null, diagnostics:[{code:'absent'}] }
 *     JSON 坏 / 形状坏  → { ok:false, state:null, diagnostics:[{code:'corrupt',…}] }
 *     版本不认识        → { ok:false, state:null, diagnostics:[{code:'incompatible-version'}] }
 *     多余字段          → { ok:false, state:null, diagnostics:[{code:'unexpected-fields'}] }
 *     文件超限          → { ok:false, state:null, diagnostics:[{code:'oversized'}] }
 *     超过 TTL          → { ok:true,  state:null, diagnostics:[{code:'expired'}] }
 *   任何 ok:false 的读回都意味着「当作没有状态」，调用方从干净状态重启，
 *   绝不要拿半截数据猜一个在场状态。损坏的文件不会被自动删除（由调用方
 *   clear() 或人工处理），避免把可诊断的证据静默抹掉。
 *
 * ── 原子写 ──────────────────────────────────────────────────
 *   先写 `file + '.tmp-<pid>-<seq>'`，再 rename 覆盖目标文件（同卷原子）。
 *   写失败时清理临时文件并返回 { ok:false, persisted:false, error }；
 *   目标文件保持上一次的完整内容，不会出现半截 JSON。
 *
 * ── 不做什么 ────────────────────────────────────────────────
 *   不装定时器、不发网络、不 import server/qq；不做合并、不去重业务数据。
 *   文件路径由调用方给：Web 用 data/presence-web-state.json，
 *   QQ 用 data/presence-qq-state.json，两者绝不共享同一个文件。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PRESENCE_STATE_VERSION = 1;
export const PRESENCE_STATE_KIND = 'presence-state';

/** 默认 TTL：7 天（C-P3）。超过它的状态按「过期」处理，不参与恢复。 */
export const DEFAULT_PRESENCE_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 状态文件大小上限：正常文件不到 4KB；超过就当成损坏，避免读入异常大文件。 */
export const DEFAULT_PRESENCE_STATE_MAX_BYTES = 64 * 1024;

/** 落盘白名单：字段是封闭集合，不接受任何扩展。 */
export const PRESENCE_STATE_KEYS = Object.freeze([
  'version',
  'state',
  'updatedAt',
  'sessionStartedAt',
  'activeMs',
  'cooldowns',
  'deliveredIds',
]);

/** 冷却表的键；`proactive` 给主动消息的 minGap 用。 */
export const PRESENCE_COOLDOWN_KEYS = Object.freeze(['welcome', 'break', 'proactive']);

/**
 * 允许写进 deliveredIds 的结算状态。
 *
 * 状态语义（这是与「已送达」严格区分的口径）：
 *   attempting  发送前的写前日志：已决定要发、但还没有回执。它唯一的用途是
 *               让重启后认得出「这条可能已经发出去了」，从而**不再盲发**。
 *   sent        平台给出可核对回执（消息 id），确认送到。
 *   accepted    平台受理但没给可核对回执：**不等于已送到**，只用于防刷屏限额。
 *   partial     只发出去一部分：不算成功，不重试。
 *   failed      平台明确拒绝：不算成功，不重试。
 *   unknown     拿不到回执/异常：不算成功，不重试。
 *   skipped     根本没尝试发送。
 */
export const PRESENCE_LEDGER_STATUSES = Object.freeze([
  'attempting',
  'sent',
  'accepted',
  'partial',
  'failed',
  'unknown',
  'skipped',
]);

/** 计入「今天已经消耗几条主动消息限额」的状态；accepted 是平台受理、不是确认送达。 */
export const PRESENCE_DELIVERED_LEDGER_STATUSES = Object.freeze(['sent', 'accepted']);

const STATE_VALUES = new Set(['unknown', 'present', 'idle', 'away']);
const COOLDOWN_KEY_SET = new Set(PRESENCE_COOLDOWN_KEYS);
const LEDGER_STATUS_SET = new Set(PRESENCE_LEDGER_STATUSES);
const MAX_LEDGER_ID_LENGTH = 120;
const LEDGER_ENTRY_PATTERN = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2})\\|(' + PRESENCE_LEDGER_STATUSES.join('|') + ')\\|([^\\s|]{1,' + MAX_LEDGER_ID_LENGTH + '})$',
);
/** 未来时间戳的容忍窗口：超过它认为文件被改坏了，而不是时钟略快。 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LEDGER_ENTRIES = 128;

let temporarySequence = 0;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受毫秒数字或 Date；字符串/布尔/NaN 一律 null（落盘格式是数字，不猜字符串）。 */
function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.trunc(ms) : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  return null;
}

function nonNegativeMs(value) {
  const ms = toMs(value);
  return ms === null || ms < 0 ? null : ms;
}

function boundedNonNegativeInt(value) {
  const ms = nonNegativeMs(value);
  return ms === null ? null : ms;
}

/** 本地日期键（YYYY-MM-DD）：日上限按本地日切分，和 followup-policy 一致。 */
export function presenceLocalDayKey(value) {
  const ms = toMs(value);
  if (ms === null) return '';
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/** 生成一条 deliveredIds 记录；id 非法（空/含分隔符/超长）时返回 null。 */
export function formatPresenceLedgerEntry({ dayKey, status, id } = {}) {
  const key = typeof dayKey === 'string' ? dayKey : '';
  const kind = typeof status === 'string' ? status : '';
  const intentId = typeof id === 'string' ? id.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  if (!LEDGER_STATUS_SET.has(kind)) return null;
  if (!intentId || intentId.length > MAX_LEDGER_ID_LENGTH) return null;
  if (/[\s|]/.test(intentId)) return null;
  return key + '|' + kind + '|' + intentId;
}

/** 解析一条 deliveredIds 记录；不合法返回 null。 */
export function parsePresenceLedgerEntry(entry) {
  if (typeof entry !== 'string') return null;
  const match = LEDGER_ENTRY_PATTERN.exec(entry);
  if (!match) return null;
  return { dayKey: match[1], status: match[2], id: match[3] };
}

/** 一条记录是否计为「真正送达」（sent / accepted）。 */
export function isPresenceDeliveredEntry(entry) {
  const parsed = parsePresenceLedgerEntry(entry);
  return Boolean(parsed) && PRESENCE_DELIVERED_LEDGER_STATUSES.includes(parsed.status);
}

/**
 * 归一化冷却表：只认白名单键，值必须是毫秒或 null。
 * 出现未知键时返回 { error:'unexpected-cooldown-keys' }；值非法返回 { error }。
 */
function normalizeCooldowns(value, { strict }) {
  if (value === undefined || value === null) {
    return { cooldowns: { welcome: null, break: null, proactive: null } };
  }
  if (!isPlainObject(value)) return { error: 'invalid-cooldowns' };
  const cooldowns = { welcome: null, break: null, proactive: null };
  for (const key of Object.keys(value)) {
    if (!COOLDOWN_KEY_SET.has(key)) {
      if (strict) return { error: 'unexpected-cooldown-keys' };
      continue;
    }
    const raw = value[key];
    if (raw === null || raw === undefined) {
      cooldowns[key] = null;
      continue;
    }
    const ms = nonNegativeMs(raw);
    if (ms === null) return { error: 'invalid-cooldowns' };
    cooldowns[key] = ms;
  }
  return { cooldowns };
}

/** 归一化 deliveredIds：每条都必须是合法记录；重复项去重保序。 */
function normalizeDeliveredIds(value, maxEntries) {
  if (value === undefined || value === null) return { deliveredIds: [] };
  if (!Array.isArray(value)) return { error: 'invalid-delivered-ids' };
  const deliveredIds = [];
  const seen = new Set();
  for (const entry of value) {
    if (!parsePresenceLedgerEntry(entry)) return { error: 'invalid-delivered-ids' };
    if (seen.has(entry)) continue;
    seen.add(entry);
    deliveredIds.push(entry);
  }
  const bounded = deliveredIds.slice(-maxEntries);
  return { deliveredIds: bounded };
}

/**
 * 状态归一化（白名单重建）。
 * strict=true 时任何未知顶层键都是错误（读文件时用）；
 * strict=false 时忽略未知键、只挑白名单字段（调用方传运行时对象时用）。
 *
 * @returns {{state:object}|{error:string}}
 */
function normalizeStateValue(raw, { strict, now, maxLedgerEntries }) {
  if (!isPlainObject(raw)) return { error: 'invalid-state' };

  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!PRESENCE_STATE_KEYS.includes(key)) return { error: 'unexpected-fields' };
    }
  }

  if (raw.version !== undefined) {
    const version = Number(raw.version);
    if (!Number.isFinite(version) || Math.trunc(version) !== PRESENCE_STATE_VERSION) {
      return { error: 'incompatible-version' };
    }
  }

  const state = typeof raw.state === 'string' && STATE_VALUES.has(raw.state) ? raw.state : null;
  if (state === null) return { error: 'invalid-state-value' };

  const updatedAt = nonNegativeMs(raw.updatedAt);
  if (updatedAt === null) return { error: 'invalid-updated-at' };
  const nowMs = toMs(now);
  const tolerance = nowMs === null ? 0 : FUTURE_TOLERANCE_MS;
  if (nowMs !== null && updatedAt > nowMs + tolerance) return { error: 'invalid-updated-at' };

  let sessionStartedAt = null;
  if (raw.sessionStartedAt !== undefined && raw.sessionStartedAt !== null) {
    sessionStartedAt = nonNegativeMs(raw.sessionStartedAt);
    if (sessionStartedAt === null) return { error: 'invalid-session-started-at' };
  }

  let activeMs = 0;
  if (raw.activeMs !== undefined && raw.activeMs !== null) {
    const value = boundedNonNegativeInt(raw.activeMs);
    if (value === null) return { error: 'invalid-active-ms' };
    activeMs = value;
  }

  const cooldownResult = normalizeCooldowns(raw.cooldowns, { strict });
  if (cooldownResult.error) return { error: cooldownResult.error };

  const ledgerResult = normalizeDeliveredIds(raw.deliveredIds, maxLedgerEntries);
  if (ledgerResult.error) return { error: ledgerResult.error };

  return {
    state: {
      version: PRESENCE_STATE_VERSION,
      state,
      updatedAt,
      sessionStartedAt,
      activeMs,
      cooldowns: cooldownResult.cooldowns,
      deliveredIds: ledgerResult.deliveredIds,
    },
  };
}

/**
 * PresenceStateStore · 单个入口（Web 或 QQ）的在场状态文件。
 *
 * @example
 *   const store = new PresenceStateStore({ file: 'data/presence-web-state.json' });
 *   const loaded = store.load();          // 启动时读一次
 *   // 损坏(ok:false) 或过期(state:null) 都从干净状态开始，不猜在场状态
 *   store.save(session.snapshot());       // 状态变化时原子写
 */
export class PresenceStateStore {
  #file;
  #now;
  #maxAgeMs;
  #maxBytes;
  #maxLedgerEntries;

  /**
   * @param {object} options
   * @param {string} options.file            状态文件路径（必填）
   * @param {() => number|Date} [options.now] 时钟注入
   * @param {number} [options.maxAgeMs]      TTL（默认 7 天）
   * @param {number} [options.maxBytes]      文件大小上限（默认 64KB）
   * @param {number} [options.maxLedgerEntries] deliveredIds 上限（默认 128）
   */
  constructor({ file, now = () => Date.now(), maxAgeMs = DEFAULT_PRESENCE_STATE_MAX_AGE_MS, maxBytes = DEFAULT_PRESENCE_STATE_MAX_BYTES, maxLedgerEntries = DEFAULT_MAX_LEDGER_ENTRIES } = {}) {
    if (typeof file !== 'string' || !file.trim()) {
      throw new TypeError('PresenceStateStore: file must be a non-empty string');
    }
    const age = Number(maxAgeMs);
    const size = Number(maxBytes);
    this.#file = path.resolve(file);
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#maxAgeMs = Number.isFinite(age) && age > 0 ? Math.trunc(age) : DEFAULT_PRESENCE_STATE_MAX_AGE_MS;
    this.#maxBytes = Number.isFinite(size) && size > 0 ? Math.trunc(size) : DEFAULT_PRESENCE_STATE_MAX_BYTES;
    this.#maxLedgerEntries = Number.isFinite(Number(maxLedgerEntries)) && Number(maxLedgerEntries) > 0
      ? Math.trunc(Number(maxLedgerEntries))
      : DEFAULT_MAX_LEDGER_ENTRIES;
  }

  get file() {
    return this.#file;
  }

  get maxAgeMs() {
    return this.#maxAgeMs;
  }

  /** 读回状态；任何异常都结构化返回，不抛。 */
  load() {
    let stat;
    try {
      stat = fs.statSync(this.#file);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, state: null, diagnostics: [{ code: 'absent' }] };
      }
      return { ok: false, state: null, diagnostics: [{ code: 'unreadable', detail: error?.code || 'io-error' }] };
    }
    if (!stat.isFile()) {
      return { ok: false, state: null, diagnostics: [{ code: 'not-a-file' }] };
    }
    if (stat.size > this.#maxBytes) {
      return { ok: false, state: null, diagnostics: [{ code: 'oversized', detail: String(stat.size) }] };
    }

    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      return { ok: false, state: null, diagnostics: [{ code: 'unreadable', detail: error?.code || 'io-error' }] };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, state: null, diagnostics: [{ code: 'corrupt', detail: 'invalid-json' }] };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, state: null, diagnostics: [{ code: 'corrupt', detail: 'not-an-object' }] };
    }
    if (parsed.kind !== undefined && parsed.kind !== PRESENCE_STATE_KIND) {
      return { ok: false, state: null, diagnostics: [{ code: 'corrupt', detail: 'wrong-kind' }] };
    }

    const nowMs = this.#nowMs();
    const fields = { ...parsed };
    delete fields.kind;
    const normalized = normalizeStateValue(fields, {
      strict: true,
      now: nowMs,
      maxLedgerEntries: this.#maxLedgerEntries,
    });
    if (normalized.error) {
      const code = normalized.error === 'incompatible-version' ? 'incompatible-version' : 'corrupt';
      return { ok: false, state: null, diagnostics: [{ code, detail: normalized.error }] };
    }

    const state = normalized.state;
    if (nowMs === null) {
      return { ok: true, state, diagnostics: [{ code: 'clock-unavailable' }] };
    }
    if (nowMs - state.updatedAt > this.#maxAgeMs) {
      return { ok: true, state: null, diagnostics: [{ code: 'expired', detail: String(nowMs - state.updatedAt) }] };
    }
    return { ok: true, state, diagnostics: [] };
  }

  /**
   * 原子写入。updatedAt 由本方法按注入时钟重新盖章（保存时刻即权威时间）。
   * 调用方多传的字段会被白名单丢掉，正文永远进不了文件。
   */
  save(state) {
    const nowMs = this.#nowMs();
    if (nowMs === null) return { ok: false, persisted: false, error: 'clock-unavailable' };

    const source = isPlainObject(state) ? { ...state, updatedAt: nowMs } : null;
    const normalized = normalizeStateValue(source, {
      strict: false,
      now: nowMs,
      maxLedgerEntries: this.#maxLedgerEntries,
    });
    if (normalized.error) return { ok: false, persisted: false, error: normalized.error };

    const payload = {
      kind: PRESENCE_STATE_KIND,
      version: PRESENCE_STATE_VERSION,
      state: normalized.state.state,
      updatedAt: normalized.state.updatedAt,
      sessionStartedAt: normalized.state.sessionStartedAt,
      activeMs: normalized.state.activeMs,
      cooldowns: normalized.state.cooldowns,
      deliveredIds: normalized.state.deliveredIds,
    };

    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      return { ok: false, persisted: false, error: 'unserializable-state' };
    }
    if (Buffer.byteLength(json, 'utf8') > this.#maxBytes) {
      return { ok: false, persisted: false, error: 'state-too-large' };
    }

    let temporary = '';
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      temporarySequence += 1;
      temporary = this.#file + '.tmp-' + process.pid + '-' + temporarySequence;
      fs.writeFileSync(temporary, json, { encoding: 'utf8' });
      fs.renameSync(temporary, this.#file);
    } catch (error) {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* 清理失败不影响返回值 */ }
      }
      return { ok: false, persisted: false, error: error?.code || 'io-error' };
    }
    return { ok: true, persisted: true };
  }

  /** 删除状态文件（禁用/关闭入口时用）。文件不存在也算成功。 */
  clear() {
    try {
      fs.rmSync(this.#file, { force: true });
    } catch (error) {
      return { ok: false, error: error?.code || 'io-error' };
    }
    return { ok: true };
  }

  #nowMs() {
    let value;
    try {
      value = this.#now();
    } catch {
      return null;
    }
    return toMs(value);
  }
}

export function createPresenceStateStore(options) {
  return new PresenceStateStore(options);
}

export default PresenceStateStore;
