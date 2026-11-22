/**
 * QQ 在场发送适配器 · presence QQ adapter
 * ─────────────────────────────────────────────────────────────
 *
 * 这一层只回答一个问题：**这条主动 intent 现在能不能真的发出去**。
 * 它自己不认识 QQ、不 import qq.js、不装定时器、不发网络：
 *
 *   - 发送通过注入的 `sendText(text, meta)` 完成（S1 必须接 `human.say`/`bot.send`）；
 *   - 只有**真实回执**才叫成功：`sent` = 平台给了可核对凭据（消息 id）；
 *     `accepted` = 平台受理但没有可核对凭据 —— **保持 accepted，绝不折算成 sent/已送达**，
 *     它只用于防刷屏（日上限 / 最小间隔）；
 *   - `partial` / `failed` / `unknown` / 异常 一律不算成功、不算额度送达，而且**不自动重试**；
 *   - 默认 `enabled=false`（C-P2）：B 门槛通过前，QQ 主动消息一条都不发；
 *   - 发送前过四道闸：在场状态、安静时段、每日上限、最小间隔；
 *     日上限与最小间隔跨重启（靠 session 台账，accepted 也计入额度）；
 *   - 用户正常消息调用 `noteUserMessage()`，把在此之前排队/尚未发出的 intent 全部作废；
 *     在场状态离开 present（away/idle/unknown）时，未发出的 intent 同样作废，
 *     避免「安静时段积压的欢迎，等用户已经走了才补发」。
 *
 * ── 写前日志（防盲发）──────────────────────────────────────
 *   真正调用 sendText **之前**，先往 session 台账写一条 `attempting`。
 *   如果这条写不进盘（store 存在但 save 失败、或台账明确拒绝写入），本次**不发送**
 *   并返回 `persist-failed`；如果发送后最终状态写盘失败，`attempting` 仍然留在盘上，
 *   重启后 `hasSettled(id)` 为真，不会把同一条当成没发过再发一次。
 *
 * ── 为什么不在这一层重试 ───────────────────────────────────
 *   unknown 意味着「不知道平台收没收到」；重发可能产生重复消息（刷屏）。
 *   所以本模块只把 unknown 结构化交回宿主，由 S1/对账逻辑决定，不擅自重试。
 *   failed / partial 同样不带重试：一次主动消息的失败不该由这一层再赌一次。
 *
 * ── 与 session 的关系 ──────────────────────────────────────
 *   session 负责状态/冷却/台账（可持久化）；adapter 只读它的 state、cooldowns 与
 *   deliveredOn()/hasSettled()，并通过 recordDelivery()/markProactive() 回写。
 *   session 若缺少这些扩展方法，adapter 退化为进程内记账（不抛错、也不假装持久化）。
 *   台账状态词表直接复用 persistence.js 的封闭集合（attempting/sent/accepted/
 *   partial/failed/unknown/skipped），本模块不另造一套。
 *
 * ── 与当前 fork 的适配（为什么不 import humanize 的归一化函数）──────────
 *   本 fork 的 humanize.js 只导出 Humanizer：`say()` 成功时返回 `{ sent, parts }`，
 *   未确认时抛 `delivery-unconfirmed`（带 `status: 'rejected' | 'unknown'`）；
 *   transport-onebot.js 的发送结果则是 `{ ...result, receipt: { status:
 *   'confirmed' | 'rejected' | 'unknown', messageId? } }`。原工作树的
 *   `normalizeDeliveryReceipt` / `summarizeDelivery` 在这里不存在，所以回执归一化
 *   自包含在本文件里（和 task-outcome-wiring.js 处理同一问题的做法一致），
 *   识别四种真实形状：
 *     outcome         humanize.summarizeDelivery 的汇总（sent/accepted/partial/
 *                     failed/unknown/empty）
 *     receipt         transport-onebot / Humanizer 的 confirmed/rejected/unknown
 *     status          已归一化的回执（sent/accepted/partial/failed/unknown/skipped）
 *     ok + message id OneBot 的 `{ ok:true, data:{ data:{ message_id } } }`
 *   认不出来的一律 unknown，绝不猜成功。
 *   另外两处刻意的 fork 适配：
 *     1. `delivery-unconfirmed` + `status:'rejected'` 记为 `failed`（平台明确拒绝），
 *        其余异常仍是 `unknown`；两者都不算送达、都不重试，安全性不变；
 *     2. `intent.at` 给了但解析不出来时直接拒收（invalid-intent），
 *        不再把「没时间戳的 intent」排队后照发。
 *   安静时段判定复用 followup-policy.js 的 isQuietHours，与主动跟进策略同一口径。
 */
import { isQuietHours } from '../followup-policy.js';

/** 默认参数（与 §4.3 / `presenceQQ` 配置一致）。 */
export const PRESENCE_QQ_DEFAULTS = Object.freeze({
  minGapMs: 15 * 60 * 1000,
  quietHours: null,
  maxPerDay: 2,
  intentTtlMs: 30 * 60 * 1000,
  maxPending: 8,
});

/**
 * 投递状态契约（返回值的 `status` 只会是这些之一）：
 *   sent             平台给出可核对回执 → 唯一可称「已送达」的状态
 *   accepted         平台受理、无回执 → 只计额度，不算已送达
 *   partial          只发出去一部分 → 不算成功
 *   failed           平台明确拒绝 → 不算成功
 *   unknown          回执缺失/异常 → 不算成功
 *   skipped          没有可发的分段
 *   idle             队列为空
 *   disabled         适配器默认关闭或已被关闭
 *   quiet-hours      安静时段，保留 intent 不发
 *   daily-cap        触达每日限额
 *   min-gap          距上一条主动消息不足最小间隔
 *   not-present      当前不在 present（用户已离开/状态未知），作废未发 intent
 *   persist-failed   写前日志落盘失败 → 本次不发送（fail-closed）
 *   duplicate        该 id 已结算或已在队列
 *   clock-unavailable 时钟不可用
 */
export const PRESENCE_QQ_STATUSES = Object.freeze([
  'sent',
  'accepted',
  'partial',
  'failed',
  'unknown',
  'skipped',
  'idle',
  'disabled',
  'quiet-hours',
  'daily-cap',
  'min-gap',
  'not-present',
  'persist-failed',
  'duplicate',
  'clock-unavailable',
]);

/** 消耗每日限额的状态（防刷屏口径）；只有 `sent` 是确认送达。 */
const QUOTA_STATUSES = new Set(['sent', 'accepted']);
/** humanize.summarizeDelivery 的 outcome 词表。 */
const HUMANIZE_OUTCOMES = new Set(['sent', 'accepted', 'partial', 'unknown', 'failed', 'empty']);
/** fork 里两种回执状态词表 → 本模块结算状态。 */
const RECEIPT_STATUS_MAP = Object.freeze({
  confirmed: 'sent',
  rejected: 'failed',
  sent: 'sent',
  accepted: 'accepted',
  partial: 'partial',
  failed: 'failed',
  unknown: 'unknown',
  skipped: 'skipped',
});
/** 传输层「说不清」的分类前缀：这类失败不能当成平台明确拒绝。 */
const TRANSPORT_UNKNOWN_CATEGORY = 'transport-unknown';
const TRANSPORT_CODE_PREFIX = 'transport-';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.trunc(ms) : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text.length > 64) return null;
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function nonNegativeMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const ms = toMs(value);
  return ms === null || ms < 0 ? fallback : ms;
}

/**
 * 每日上限归一：与原模块同一口径 —— `null` / `''` 会被 Number() 折成 0，
 * 也就是「今天一条都不发」（fail-closed）；只有真正解析不出的值才回落默认。
 */
function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

/** 队列上限归一：必须是正数，否则回落默认（0/负数/NaN 不能让队列无界或全拒）。 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

/** 从 OneBot / transport / 已归一化回执里尽力找出消息 id；没有就当没有，不猜。 */
function extractMessageId(result) {
  const raw = result?.data?.data?.message_id ?? result?.data?.message_id
    ?? result?.messageId ?? result?.data?.data?.messageId ?? result?.data?.messageId
    ?? result?.receipt?.messageId;
  if (raw === undefined || raw === null) return '';
  const id = String(raw).trim();
  return id === '0' || id === 'undefined' || id === 'null' ? '' : id;
}

/** 传输层是否把这次失败归进「不知道平台收没收到」这一档。 */
function isTransportUnknown(result) {
  const category = typeof result?.category === 'string' ? result.category.trim() : '';
  const errorCode = typeof result?.errorCode === 'string' ? result.errorCode.trim().toLowerCase() : '';
  return category === TRANSPORT_UNKNOWN_CATEGORY || errorCode.startsWith(TRANSPORT_CODE_PREFIX);
}

/** 把回执/状态字段映射成结算状态；不在词表里返回空串。 */
function mapReceiptStatus(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return key && Object.prototype.hasOwnProperty.call(RECEIPT_STATUS_MAP, key)
    ? RECEIPT_STATUS_MAP[key]
    : '';
}

/**
 * 抛异常时的归类。
 *
 * 原工作树一律记 unknown（socket 断了本来也说不清）。本 fork 的 Humanizer 在
 * `delivery-unconfirmed` 上带了明确分类：`status:'rejected'`（回执 rejected，
 * 平台明确拒绝）→ failed；`status:'unknown'`（超时/异常/认不出的回执）→ unknown。
 * 两者都不算成功、都不计入额度、都不自动重试。
 */
function classifyThrown(error) {
  if (isPlainObject(error) && error.code === 'delivery-unconfirmed' && error.status === 'rejected') {
    return 'failed';
  }
  return 'unknown';
}

/**
 * 把一次 sendText 的返回值折算成结算状态。
 *   - 抛异常 / 返回 undefined / 返回看不懂 → unknown（绝不猜成功）
 *   - 有 outcome 字段（humanize 的汇总） → 直接用（empty → skipped）；
 *     outcome 声称 sent/accepted 却同时 ok:false（自相矛盾）→ unknown
 *   - `ok === false` → **优先于任何成功线索**：带 transport-* 分类记 unknown，否则 failed
 *   - 有 receipt.status（transport/Humanizer） → confirmed→sent、rejected→failed、其余 unknown
 *   - 有已归一化的 status 字段 → 只认结算词表
 *   - 有 { sent, parts }（本 fork 的 Humanizer.say 成功形状）→ 最多 accepted
 *   - OneBot `ok:true` → 有消息 id 记 sent，没有记 accepted
 *
 * `sent` 的口径是「平台给了可核对凭据」，所以凡是靠 status/receipt 声称 sent、
 * 却拿不到 message id 的，一律降级成 accepted —— 仍然占额度，但不宣称已送达。
 */
export function classifyPresenceDelivery(result, thrown = null) {
  if (thrown) return classifyThrown(thrown);
  if (result === true) return 'accepted';
  if (!isPlainObject(result)) return 'unknown';

  const outcome = typeof result.outcome === 'string' ? result.outcome : '';
  if (outcome) {
    if (!HUMANIZE_OUTCOMES.has(outcome)) return 'unknown';
    // 自相矛盾（outcome 说成功、ok 说失败）：不猜，记 unknown。
    if (result.ok === false && (outcome === 'sent' || outcome === 'accepted')) return 'unknown';
    return outcome === 'empty' ? 'skipped' : outcome;
  }

  // 明确失败优先：`{ ok:false, receipt:{ status:'confirmed' } }` 这种自相矛盾的输入
  // 必须按失败处理，绝不能因为别处写着 confirmed 就宣称送达（与原 humanize 的
  // `ok === false` 先判一致）。
  if (result.ok === false) return isTransportUnknown(result) ? 'unknown' : 'failed';

  const withReceiptId = (status) => (status === 'sent' && !extractMessageId(result) ? 'accepted' : status);

  if (isPlainObject(result.receipt)) {
    const fromReceipt = mapReceiptStatus(result.receipt.status);
    if (fromReceipt) return withReceiptId(fromReceipt);
  }

  const direct = mapReceiptStatus(result.status);
  if (direct) return withReceiptId(direct);

  // 本 fork 的 Humanizer.say()：成功时返回 { sent, parts }（未确认就直接抛错）。
  // 注意：say() 的返回值**不带**消息 id，这一层无法核对平台凭据，所以最多记
  // accepted —— 绝不因为「say 没抛错」就宣称 sent/已送达。段数对不上记 partial。
  if (Array.isArray(result.parts)) {
    const sentParts = Number(result.sent);
    if (!Number.isFinite(sentParts)) return 'unknown';
    const sentCount = Math.trunc(sentParts);
    if (result.parts.length === 0) return 'skipped';
    if (sentCount >= result.parts.length) return 'accepted';
    return sentCount > 0 ? 'partial' : 'unknown';
  }

  if (result.ok === true) return extractMessageId(result) ? 'sent' : 'accepted';
  return 'unknown';
}

/**
 * journal 里的异常描述：只留异常名和错误码，**不留 message**。
 * 发送异常常常把平台原文、URL、token 甚至正文夹在 message 里，而 journal 是要落盘/
 * 上报的；排障靠 name + code + 结算状态就够了（与 task-outcome-wiring 的口径一致）。
 */
function describeThrown(error) {
  if (error instanceof Error) {
    const described = { name: String(error.name || 'Error').slice(0, 64) };
    const code = typeof error.code === 'string' ? error.code.trim() : '';
    if (code) described.code = code.slice(0, 64);
    return described;
  }
  return { name: typeof error };
}

/** 统一的结果形状：sent / accepted / delivered 三个口径分开，不留歧义。 */
function settleResult({ ok, status, pending, reason }) {
  return {
    ok: ok === true,
    status,
    sent: status === 'sent' ? 1 : 0,
    accepted: status === 'accepted' ? 1 : 0,
    delivered: QUOTA_STATUSES.has(status) ? 1 : 0,
    confirmed: status === 'sent',
    pending,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 创建 QQ 在场发送适配器。
 *
 * @param {object} options
 * @param {object} options.session             createPresenceSession 的返回值
 * @param {(text:string, meta:object)=>Promise<any>} options.sendText  S1 注入的真实发送
 * @param {(event:object)=>void} [options.journal]  结构化 journal（不含正文/账号）
 * @param {() => number|Date} [options.now]   时钟注入
 * @param {number} [options.minGapMs]         两次主动消息的最小间隔（默认 15 分钟）
 * @param {[number,number]|{start:number,end:number}|null} [options.quietHours] 安静时段（默认 null=不限制）
 * @param {number} [options.maxPerDay]        每日主动消息额度（默认 2；sent/accepted 都计入）
 * @param {boolean} [options.enabled]         默认 false（C-P2：B 门槛前不发）
 * @param {number} [options.intentTtlMs]      排队 intent 的过期时间（默认 30 分钟）
 * @param {number} [options.maxPending]       排队上限（默认 8）
 */
export function createPresenceQQAdapter({
  session,
  sendText,
  journal = null,
  now = () => Date.now(),
  minGapMs = PRESENCE_QQ_DEFAULTS.minGapMs,
  quietHours = PRESENCE_QQ_DEFAULTS.quietHours,
  maxPerDay = PRESENCE_QQ_DEFAULTS.maxPerDay,
  enabled = false,
  intentTtlMs = PRESENCE_QQ_DEFAULTS.intentTtlMs,
  maxPending = PRESENCE_QQ_DEFAULTS.maxPending,
} = {}) {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createPresenceQQAdapter: session is required');
  }
  if (typeof sendText !== 'function') {
    throw new TypeError('createPresenceQQAdapter: sendText must be a function');
  }
  if (journal !== null && journal !== undefined && typeof journal !== 'function') {
    throw new TypeError('createPresenceQQAdapter: journal must be a function or null');
  }

  const clock = typeof now === 'function' ? now : () => Date.now();
  const gapMs = nonNegativeMs(minGapMs, PRESENCE_QQ_DEFAULTS.minGapMs);
  const ttlMs = nonNegativeMs(intentTtlMs, PRESENCE_QQ_DEFAULTS.intentTtlMs);
  const dailyCap = nonNegativeInt(maxPerDay, PRESENCE_QQ_DEFAULTS.maxPerDay);
  const pendingLimit = positiveInt(maxPending, PRESENCE_QQ_DEFAULTS.maxPending);
  const quiet = Array.isArray(quietHours) || isPlainObject(quietHours) ? quietHours : null;

  let isEnabled = enabled === true;
  let pending = [];
  let inFlight = null;
  let lastUserMessageAt = null;

  const counters = {
    intentsAccepted: 0,
    intentsRejected: 0,
    intentsExpired: 0,
    intentsInvalidated: 0,
    attempted: 0,
    confirmed: 0,
    accepted: 0,
    quotaSettled: 0,
    failed: 0,
    unknown: 0,
    partial: 0,
    skipped: 0,
    quietHoursSkips: 0,
    minGapSkips: 0,
    dailyCapSkips: 0,
    notPresentDrops: 0,
    persistFailures: 0,
    duplicates: 0,
  };

  const nowMs = () => {
    try {
      return toMs(clock());
    } catch {
      return null;
    }
  };

  const emitJournal = (event) => {
    if (typeof journal !== 'function') return;
    try {
      journal(event);
    } catch {
      /* journal 抛错不能影响发送记账 */
    }
  };

  const sessionCooldowns = () => (typeof session.cooldowns === 'object' && session.cooldowns !== null ? session.cooldowns : {});
  const sessionHasSettled = (id) => typeof session.hasSettled === 'function' && session.hasSettled(id) === true;
  const sessionDeliveredOn = (atMs) => (typeof session.deliveredOn === 'function' ? Number(session.deliveredOn(atMs)) || 0 : 0);
  const sessionHasStore = () => (typeof session.hasStore === 'boolean' ? session.hasStore : Boolean(session.stats && session.stats.hasStore));
  const sessionPresenceState = () => (typeof session.state === 'string' ? session.state : null);

  /**
   * 写台账。返回 { ok, durable }：
   *   durable=true  → 这条记录已经在盘上（或本就没有 store，纯内存模式）且台账接受了它
   *   durable=false → 台账拒绝 / store 存在但没写进去 / 写抛错，调用方必须 fail-closed
   */
  const sessionRecord = (id, status, atMs) => {
    if (typeof session.recordDelivery !== 'function') {
      return { ok: true, durable: !sessionHasStore() };
    }
    let result;
    try {
      result = session.recordDelivery({ id, status, at: atMs });
    } catch {
      return { ok: false, durable: false };
    }
    const ok = !result || result.ok !== false;
    const durable = ok && (!sessionHasStore() || (Boolean(result) && result.persisted === true));
    return { ok, durable };
  };

  const sessionMarkProactive = (atMs) => {
    if (typeof session.markProactive === 'function') session.markProactive(atMs);
  };

  const isDuplicate = (id) => pending.some((entry) => entry.id === id) || sessionHasSettled(id);

  const expirePending = (atMs) => {
    if (ttlMs <= 0) return;
    const kept = [];
    for (const entry of pending) {
      if (entry.at !== null && atMs - entry.at > ttlMs) {
        counters.intentsExpired += 1;
        emitJournal({ type: 'presence-intent-expired', kind: entry.kind, at: atMs });
      } else {
        kept.push(entry);
      }
    }
    pending = kept;
  };

  /** 用户不在 present（离开/未知）时，未发出的主动 intent 全部作废。 */
  const dropPendingForAbsence = (atMs, reason = 'not-present') => {
    const dropped = pending.length;
    pending = [];
    counters.intentsInvalidated += dropped;
    counters.notPresentDrops += dropped;
    if (dropped > 0) emitJournal({ type: 'presence-intent-invalidated', reason, count: dropped, at: atMs });
    return dropped;
  };

  /**
   * 尝试投递队首 intent。所有硬闸门都在这里判断，flush/tick 共用。
   * @returns {Promise<object>} settleResult(...)
   */
  const attempt = async (atMs) => {
    if (!isEnabled) return settleResult({ ok: false, status: 'disabled', pending: pending.length, reason: 'disabled' });
    if (atMs === null) return settleResult({ ok: false, status: 'clock-unavailable', pending: pending.length, reason: 'clock-unavailable' });
    expirePending(atMs);
    if (!pending.length) return settleResult({ ok: true, status: 'idle', pending: 0 });

    // 闸门顺序：安静时段 → 每日上限 → 最小间隔 → 在场状态。
    // 前三道都用「保留 intent」处理；只有确认离开/未知才作废，避免积压到用户走后补发。
    if (isQuietHours(new Date(atMs), quiet)) {
      counters.quietHoursSkips += 1;
      return settleResult({ ok: false, status: 'quiet-hours', pending: pending.length, reason: 'quiet-hours' });
    }
    if (sessionDeliveredOn(atMs) >= dailyCap) {
      counters.dailyCapSkips += 1;
      return settleResult({ ok: false, status: 'daily-cap', pending: pending.length, reason: 'daily-cap' });
    }
    const lastProactive = sessionCooldowns().proactive;
    if (gapMs > 0 && lastProactive !== null && lastProactive !== undefined && atMs >= lastProactive && atMs - lastProactive < gapMs) {
      counters.minGapSkips += 1;
      return settleResult({ ok: false, status: 'min-gap', pending: pending.length, reason: 'min-gap' });
    }
    const presence = sessionPresenceState();
    if (presence !== null && presence !== 'present') {
      // 用户已经离开（away/idle/unknown）：任何「回来了 / 该歇一下」都不再成立。
      dropPendingForAbsence(atMs, 'presence-' + presence);
      return settleResult({ ok: false, status: 'not-present', pending: 0, reason: 'presence-' + presence });
    }

    const intent = pending[0];
    if (sessionHasSettled(intent.id)) {
      pending = pending.slice(1);
      counters.duplicates += 1;
      return settleResult({ ok: false, status: 'duplicate', pending: pending.length, reason: 'duplicate' });
    }

    // 写前日志：先落盘 attempting；写不进去就不发（fail-closed）。
    const writeAhead = sessionRecord(intent.id, 'attempting', atMs);
    if (!writeAhead.durable) {
      counters.persistFailures += 1;
      emitJournal({ type: 'presence-persist-failed', stage: 'before-send', kind: intent.kind, at: atMs });
      return settleResult({ ok: false, status: 'persist-failed', pending: pending.length, reason: 'ledger-write-failed' });
    }

    counters.attempted += 1;
    emitJournal({ type: 'presence-intent', kind: intent.kind, at: atMs });

    let raw;
    let thrown = null;
    try {
      raw = await sendText(intent.text, { source: 'presence', kind: intent.kind, id: intent.id });
    } catch (error) {
      thrown = error;
    }

    const status = classifyPresenceDelivery(raw, thrown);
    // 无论结果如何，这条 intent 都从队列里出队：不自动重试。
    pending = pending.slice(1);

    if (QUOTA_STATUSES.has(status)) {
      if (status === 'sent') {
        counters.confirmed += 1;
      } else {
        counters.accepted += 1;
      }
      counters.quotaSettled += 1;
      const recorded = sessionRecord(intent.id, status, atMs);
      // 额度与间隔：accepted 也占额度（防刷屏），但 journal 明确区分 confirmed。
      sessionMarkProactive(atMs);
      emitJournal({
        type: 'presence-delivery',
        kind: intent.kind,
        status,
        confirmed: status === 'sent',
        quota: true,
        at: atMs,
        ...(recorded.durable ? {} : { persisted: false }),
      });
      const result = settleResult({ ok: true, status, pending: pending.length });
      if (!recorded.durable) {
        counters.persistFailures += 1;
        result.persisted = false;
        result.reason = 'ledger-write-failed';
        // 写前日志已在盘上，重启后 hasSettled(id) 仍为真 → 不会盲发。
        emitJournal({ type: 'presence-persist-failed', stage: 'after-send', kind: intent.kind, status, at: atMs });
      }
      return result;
    }

    if (status === 'partial') counters.partial += 1;
    else if (status === 'failed') counters.failed += 1;
    else if (status === 'skipped') counters.skipped += 1;
    else counters.unknown += 1;

    // 失败/未知/部分也落一条结算记录：避免进程重启后把它当成没发过再发一次。
    const recorded = sessionRecord(intent.id, status, atMs);
    emitJournal({
      type: 'presence-delivery',
      kind: intent.kind,
      status,
      confirmed: false,
      quota: false,
      at: atMs,
      ...(thrown ? { error: describeThrown(thrown) } : {}),
      ...(recorded.durable ? {} : { persisted: false }),
    });
    return settleResult({ ok: false, status, pending: pending.length, reason: recorded.durable ? undefined : 'ledger-write-failed' });
  };

  /** flush/tick 并发保护：同一个 Promise 共享，绝不并行发两条。 */
  const runExclusive = (atMs) => {
    if (inFlight) return inFlight;
    const running = attempt(atMs).finally(() => {
      inFlight = null;
    });
    inFlight = running;
    return running;
  };

  return {
    /** 宿主节拍：结算过期并从队列里发一条（如果闸门都过）。 */
    tick(at) {
      const atMs = at === undefined || at === null ? nowMs() : toMs(at);
      return runExclusive(atMs);
    },
    /** 直接尝试发送；与 tick 共用闸门与并发保护。 */
    flush() {
      return runExclusive(nowMs());
    },
    /**
     * 收下一条 policy intent。非法/重复/过时/禁用时不入队。
     * @returns {{accepted:boolean, reason?:string, pending:number}}
     */
    onIntent(intent) {
      if (!isEnabled) {
        counters.intentsRejected += 1;
        return { accepted: false, reason: 'disabled', pending: pending.length };
      }
      if (!isPlainObject(intent)) {
        counters.intentsRejected += 1;
        return { accepted: false, reason: 'invalid-intent', pending: pending.length };
      }
      const id = typeof intent.id === 'string' ? intent.id.trim() : '';
      const kind = typeof intent.kind === 'string' ? intent.kind : '';
      const text = typeof intent.text === 'string' ? intent.text : '';
      if (!id || !kind || !text) {
        counters.intentsRejected += 1;
        return { accepted: false, reason: 'invalid-intent', pending: pending.length };
      }
      let atMs;
      if (intent.at === undefined || intent.at === null) {
        atMs = nowMs();
      } else {
        atMs = toMs(intent.at);
        // 给了时间却解析不出来：宁可拒收，也不排一条没有时间基准的主动消息。
        if (atMs === null) {
          counters.intentsRejected += 1;
          return { accepted: false, reason: 'invalid-intent', pending: pending.length };
        }
      }
      if (lastUserMessageAt !== null && atMs !== null && atMs <= lastUserMessageAt) {
        counters.intentsInvalidated += 1;
        return { accepted: false, reason: 'stale-after-user-message', pending: pending.length };
      }
      if (isDuplicate(id)) {
        counters.duplicates += 1;
        counters.intentsRejected += 1;
        return { accepted: false, reason: 'duplicate', pending: pending.length };
      }
      if (pending.length >= pendingLimit) {
        counters.intentsRejected += 1;
        return { accepted: false, reason: 'queue-full', pending: pending.length };
      }
      pending.push({ id, kind, text, at: atMs });
      counters.intentsAccepted += 1;
      return { accepted: true, pending: pending.length };
    },
    /**
     * 用户发来一条正常消息：把在此之前排队的主动 intent 全部作废。
     * 之后 onIntent 收到更早的 intent 也会被拒（stale-after-user-message）。
     */
    noteUserMessage(at) {
      const atMs = at === undefined || at === null ? nowMs() : toMs(at);
      if (atMs === null) return { invalidated: 0, reason: 'clock-unavailable' };
      lastUserMessageAt = lastUserMessageAt === null ? atMs : Math.max(lastUserMessageAt, atMs);
      const before = pending.length;
      pending = pending.filter((entry) => entry.at !== null && entry.at > atMs);
      const invalidated = before - pending.length;
      counters.intentsInvalidated += invalidated;
      if (invalidated > 0) emitJournal({ type: 'presence-intent-invalidated', reason: 'user-message', count: invalidated, at: atMs });
      return { invalidated, pending: pending.length };
    },
    /**
     * 宿主显式同步在场状态（可选）：离开 present 时立刻作废未发出的主动 intent。
     * 不调用也没关系 —— tick/flush 会在 attempt 里按 session.state 兜底。
     */
    notePresenceState(state, at) {
      const atMs = at === undefined || at === null ? nowMs() : toMs(at);
      const next = typeof state === 'string' ? state : '';
      if (next === 'present') return { dropped: 0, pending: pending.length };
      const dropped = dropPendingForAbsence(atMs, 'presence-' + (next || 'unknown'));
      return { dropped, pending: pending.length };
    },
    setEnabled(value) {
      isEnabled = value === true;
      if (!isEnabled) {
        const dropped = pending.length;
        pending = [];
        counters.intentsInvalidated += dropped;
        return { enabled: false, dropped };
      }
      return { enabled: true, dropped: 0 };
    },
    get enabled() {
      return isEnabled;
    },
    get pendingCount() {
      return pending.length;
    },
    get stats() {
      return {
        ...counters,
        enabled: isEnabled,
        pending: pending.length,
        minGapMs: gapMs,
        maxPerDay: dailyCap,
        maxPending: pendingLimit,
        quietHours: quiet,
        intentTtlMs: ttlMs,
      };
    },
  };
}

export default createPresenceQQAdapter;
