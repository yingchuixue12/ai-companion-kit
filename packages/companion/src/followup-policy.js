/**
 * 主动跟进的纯决策策略 · followup-policy
 * ─────────────────────────────────────────────────────────────
 * 只回答一个问题：这次跟进 / 提醒现在该不该排程、该不该发送。
 * 不落盘、不读时钟（now 由调用方传入）、不设定时器、不发送消息——持久化、
 * 计时与投递全部归调用方所有。
 *
 * 判定顺序（先否决，再限流）：
 *   1. 用户明确拒绝 → cancel（schedule / send 都取消）；
 *   2. 告别语 → skip（ordinary-farewell）；
 *   3. intent=reminder 但用户没有明确说出提醒请求 → skip（reminder-not-explicit）；
 *   4. follow-up/check-in 缺少近期事件或具体未完成事项 → skip（missing-recent-context）；
 *   5. 其它 intent → skip（unsupported-intent）；
 *   6. 非法 phase、主动跟进被关闭 → skip。
 *
 * 显式提醒与主动联系限制：
 *   只有用户明确说“提醒我…”（或 candidate.explicitReminder === true）才算 reminder。
 *   显式提醒是用户的直接请求，因此**不受**主动联系限制：安静时段、每日上限、
 *   冷却、话题去重、config.enabled=false 都不会拦它；sentFollowups 里 intent=reminder
 *   的记录也不计入主动联系的每日上限、冷却与话题去重。
 *   反过来，follow-up/check-in 是模型自己发起的主动关心，必须同时满足：有近期依据
 *   （近期事件或具体未完成事项）、不在安静时段、未超每日上限、未在冷却期、话题未重复；
 *   发送前若用户又发了新消息（lastUserMessageAt 晚于 pending.createdAt），这条主动
 *   回访已经过时，直接 cancel。
 */

const REMINDER_REQUEST = /(?:提醒我|提醒下我|记得提醒|别忘了提醒|到时候(?:叫|提醒)我|提醒一下我|记得叫我)/i;
const FAREWELL = /(?:我先走了|先走了|我走了|先下了|下线了|我去忙了|去忙了|晚安|睡了|拜拜|再见|回头聊|改天聊|不聊了)/i;
const REFUSAL = /(?:不要(?:再)?(?:联系|提醒|找我|打扰)|别(?:再)?(?:联系|提醒|找我|打扰|发(?:消息|信息)|给我发(?:消息|信息))|不用(?:提醒|联系|找我)|不需要(?:提醒|联系)|别烦我|先别找我|暂停(?:主动)?(?:联系|提醒))/i;
const RECENT_TIME = /(?:今天|昨天|前天|昨晚|前晚|刚才|刚刚|最近|这两天|这周|本周|上周|上个月|明天|后天|下周|近期|today|yesterday|last night|earlier today|just now|recently|this week|last week|next week|tomorrow|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i;
const EVENT = /(?:面试|考试|测验|约会|预约|复诊|手术|检查|比赛|演出|旅行|出差|搬家|开会|汇报|答辩|发布|截止|生日|婚礼|入职|毕业|看病|看医生|吵架|争吵|闹矛盾|分手|失恋|确诊|生病|住院|被辞退|通过|失败|收到|找工作|投简历|interview|exam|appointment|surgery|checkup|competition|performance|trip|business trip|moving|meeting|presentation|deadline|birthday|wedding|graduation|argue|fight|diagnosed|hospitalized|job interview|job search)/i;
const OPEN_ITEM = /(?:还没|尚未|没来得及|没能|还需要|需要|得去|必须|正在等|还在等|等待|未完成|没做完|没交|没提交|没写完|没处理|没解决|没收到|没回复|没确定|没出(?:来)?|还差|待办|待处理|还要|还得|要交|得交|要提交|得提交|要完成|得完成|要处理|得处理|haven't|hasn't|still need|waiting for|unfinished|not finished|pending|due)/i;
const OPEN_ITEM_OBJECT = /(?:事情|一件事|事项|待办|作业|报告|论文|项目|任务|考试|面试|申请|预约|复诊|检查|结果|账单|邮件|行程|计划|表格|资料|工作|搬家|决定|提交|报名|还款|文档|合同|维修|药|治疗|东西|安排|homework|report|paper|project|task|application|appointment|result|bill|email|plan|form|document|contract|repair|medicine|treatment|todo|item)/i;
const ACTIVE_INTENTS = new Set(['follow-up', 'check-in']);

function validDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.text ?? '').trim();
}

function topicKey(topic) {
  return String(topic ?? '').trim().toLocaleLowerCase().replace(/[\s\p{P}]+/gu, '');
}

function isRecentContext(sourceText) {
  const source = textOf(sourceText);
  if (!source) return false;
  const recentEvent = RECENT_TIME.test(source) && EVENT.test(source);
  const unfinishedItem = OPEN_ITEM.test(source) && OPEN_ITEM_OBJECT.test(source);
  return recentEvent || unfinishedItem;
}

function isRefused(state, sourceText) {
  return state?.refused === true ||
    (typeof state?.refused === 'string' && REFUSAL.test(state.refused)) ||
    REFUSAL.test(textOf(sourceText));
}

function isExplicitReminder(candidate, sourceText) {
  return candidate.explicitReminder === true || REMINDER_REQUEST.test(textOf(sourceText));
}

function candidateMode(candidate, sourceText, directText = sourceText) {
  const intent = String(candidate.intent ?? '').toLowerCase();
  const source = textOf(sourceText);
  const direct = textOf(directText);
  const reminder = isExplicitReminder(candidate, direct);

  if (reminder) return 'reminder';
  if (FAREWELL.test(direct) && !reminder) return 'farewell';
  if (intent === 'reminder') return 'reminder-unconfirmed';
  if (ACTIVE_INTENTS.has(intent) && isRecentContext(source)) return 'check-in';
  if (ACTIVE_INTENTS.has(intent)) return 'missing-context';
  return 'unsupported';
}

/** 给只需要轻量提示的调用方：把一段原文归类成 reminder / farewell / ordinary。 */
export function classifyFollowupIntent(text) {
  const value = textOf(text);
  if (REMINDER_REQUEST.test(value)) return 'reminder';
  if (FAREWELL.test(value)) return 'farewell';
  return 'ordinary';
}

/** 给传输 / 集成层用的轻量拒绝判断。 */
export function isFollowupRefusal(text) {
  return REFUSAL.test(textOf(text));
}

/** 判断某个时间点是否落在配置的安静时段内。 */
export function isQuietHours(now, quietHours) {
  if (!quietHours) return false;
  const [start, end] = Array.isArray(quietHours)
    ? quietHours
    : [quietHours.start, quietHours.end];
  if (![start, end].every((n) => Number.isFinite(Number(n)))) return false;
  const date = validDate(now);
  if (!date) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  const s = Number(start); const e = Number(end);
  return s === e ? true : s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function isProactiveRecord(record) {
  const kind = String(record?.intent ?? record?.kind ?? record?.type ?? '').toLowerCase();
  return kind !== 'reminder';
}

function sentRecords(state) {
  return Array.isArray(state?.sentFollowups) ? state.sentFollowups : [];
}

function matchingPending(state, candidate) {
  const pending = Array.isArray(state?.pendingFollowups) ? state.pendingFollowups : [];
  if (candidate.id != null) {
    const byId = pending.find((entry) => String(entry.id) === String(candidate.id));
    if (byId) return byId;
  }
  const topic = topicKey(candidate.topic);
  return pending.find((entry) => (!entry.intent || ACTIVE_INTENTS.has(String(entry.intent).toLowerCase())) &&
    topic && topicKey(entry.topic) === topic) ?? null;
}

function result(eligible, action, reason, mode, intent, candidate) {
  return {
    eligible,
    action,
    reason,
    ...(mode ? { mode } : {}),
    ...(intent ? { intent } : {}),
    ...(candidate.topic == null ? {} : { topic: candidate.topic }),
  };
}

/**
 * 判断这次主动跟进该排程还是该发送。
 *
 * 输入契约：
 *   decideFollowup({ phase: 'schedule'|'send', now, candidate,
 *     state: { sentFollowups, pendingFollowups, lastUserMessageAt, refused }, config })
 *
 * 显式提醒是用户的直接请求；follow-up / check-in 候选必须带上描述近期事件或
 * 具体未完成事项的 sourceText 才会被接受。
 */
export function decideFollowup({ phase = 'schedule', now = new Date(), candidate = {}, state = {}, config = {} } = {}) {
  const intent = String(candidate.intent ?? '');
  const sourceText = candidate.sourceText ?? '';
  const directText = candidate.sourceText ?? candidate.text ?? '';
  const mode = candidateMode(candidate, sourceText, directText);

  if (isRefused(state, directText)) return result(false, 'cancel', 'user-refused', mode, intent, candidate);
  if (mode === 'farewell') return result(false, 'skip', 'ordinary-farewell', mode, intent, candidate);
  if (mode === 'reminder-unconfirmed') return result(false, 'skip', 'reminder-not-explicit', mode, intent, candidate);
  if (mode === 'missing-context') return result(false, 'skip', 'missing-recent-context', mode, intent, candidate);
  if (mode === 'unsupported') return result(false, 'skip', 'unsupported-intent', mode, intent, candidate);
  if (phase !== 'schedule' && phase !== 'send') return result(false, 'skip', 'invalid-phase', mode, intent, candidate);
  if (config.enabled === false && mode !== 'reminder') return result(false, 'skip', 'disabled', mode, intent, candidate);

  if (phase === 'schedule') {
    if (mode === 'check-in') {
      const key = topicKey(candidate.topic);
      const pending = Array.isArray(state.pendingFollowups) ? state.pendingFollowups : [];
      if (key && pending.some((entry) => ACTIVE_INTENTS.has(String(entry.intent ?? '').toLowerCase())
        && topicKey(entry.topic) === key)) {
        return result(false, 'skip', 'duplicate-pending-topic', mode, intent, candidate);
      }
    }
    return result(true, 'schedule', 'eligible', mode, intent, candidate);
  }

  // 用户消息比待发主动回访更新，说明这条回访已经过时。
  if (mode === 'check-in') {
    const pending = matchingPending(state, candidate);
    const createdAt = validDate(candidate.createdAt) ?? validDate(pending?.createdAt);
    const lastUserMessageAt = validDate(state.lastUserMessageAt);
    if (createdAt && lastUserMessageAt && lastUserMessageAt > createdAt) {
      return result(false, 'cancel', 'user-spoke-after-pending', mode, intent, candidate);
    }

    const dateNow = validDate(now);
    if (!dateNow) return result(false, 'skip', 'invalid-now', mode, intent, candidate);
    if (isQuietHours(dateNow, config.quietHours)) return result(false, 'skip', 'quiet-hours', mode, intent, candidate);

    const proactiveSent = sentRecords(state).filter(isProactiveRecord);
    const todays = proactiveSent.filter((entry) => {
      const sentAt = validDate(entry.sentAt ?? entry.at ?? entry.timestamp);
      return sentAt && sentAt.getFullYear() === dateNow.getFullYear() &&
        sentAt.getMonth() === dateNow.getMonth() && sentAt.getDate() === dateNow.getDate();
    });
    const cap = Number(config.maxPerDay ?? 2);
    if (Number.isFinite(cap) && cap >= 0 && todays.length >= cap) {
      return result(false, 'skip', 'daily-cap', mode, intent, candidate);
    }

    const cooldownMs = Number(config.cooldownMs ?? 0);
    const recentSent = proactiveSent.map((entry) => validDate(entry.sentAt ?? entry.at ?? entry.timestamp))
      .filter(Boolean);
    if (cooldownMs > 0 && recentSent.some((sentAt) => dateNow - sentAt < cooldownMs)) {
      return result(false, 'skip', 'cooldown', mode, intent, candidate);
    }
    const key = topicKey(candidate.topic);
    if (key && proactiveSent.some((entry) => topicKey(entry.topic) === key)) {
      return result(false, 'skip', 'duplicate-topic', mode, intent, candidate);
    }
  }

  // 显式提醒代表用户的直接请求，所以主动联系限制不适用于它。
  return result(true, 'send', 'eligible', mode, intent, candidate);
}

export const evaluateFollowup = decideFollowup;
export const shouldFollowup = decideFollowup;
export default decideFollowup;
