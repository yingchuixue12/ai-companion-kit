/**
 * followup-policy 决策用例 · 固定时钟
 * ─────────────────────────────────────────────────────────────
 * 只测纯决策：不读真实时钟（now 全部写死）、不落盘、不联网、不发消息。
 * 覆盖主动联系的排程/送出、拒绝、告别、缺上下文、重复话题、用户更新发言、
 * 跨午夜静默、每日上限与冷却、显式提醒豁免，以及 invalid phase / invalid now。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import decideFollowup, {
  classifyFollowupIntent,
  evaluateFollowup,
  isFollowupRefusal,
  isQuietHours,
  shouldFollowup,
} from '../src/followup-policy.js';

const NOW = new Date('2026-10-25T10:00:00');
const NIGHT = new Date('2026-10-25T23:30:00');
const MIDNIGHT = new Date('2026-10-26T00:30:00');

const REMINDER = { intent: 'reminder', sourceText: '明天提醒我交作业', topic: '作业' };
const CHECKIN = { intent: 'check-in', sourceText: '今天有面试，等结果', topic: '面试' };

const pick = ({ eligible, action, reason }) => ({ eligible, action, reason });

// ── 1. 导出契约与轻量归类 ─────────────────────────────────────────

test('导出契约：默认导出与两个别名是同一个决策函数', () => {
  assert.equal(evaluateFollowup, decideFollowup);
  assert.equal(shouldFollowup, decideFollowup);

  assert.equal(classifyFollowupIntent('明天提醒我交作业'), 'reminder');
  assert.equal(classifyFollowupIntent('晚安'), 'farewell');
  assert.equal(classifyFollowupIntent('今天天气不错'), 'ordinary');
  assert.equal(classifyFollowupIntent({ text: '提醒我' }), 'reminder');
  assert.equal(classifyFollowupIntent(null), 'ordinary');

  assert.equal(isFollowupRefusal('别烦我'), true);
  assert.equal(isFollowupRefusal('好的'), false);
  assert.equal(isFollowupRefusal(null), false);
});

// ── 2. 排程：显式提醒与主动回访的依据 ─────────────────────────────

test('排程接受显式提醒，拒绝没有依据的主动回访', () => {
  assert.deepEqual(
    pick(decideFollowup({ phase: 'schedule', now: NOW, candidate: REMINDER })),
    { eligible: true, action: 'schedule', reason: 'eligible' },
  );

  // explicitReminder 标记等价于原文里的提醒请求。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'reminder', explicitReminder: true, sourceText: '明天开会', topic: '开会' },
  }).action, 'schedule');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '他昨天面试完说等结果', topic: '面试' },
  }).action, 'schedule');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '项目还没提交，等他处理完', topic: '项目' },
  }).action, 'schedule');

  // 只有近期时间、没有具体事件；或只有未完成措辞、没有具体对象。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '今天天气不错', topic: '天气' },
  }).reason, 'missing-recent-context');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'follow-up', sourceText: '随便聊聊', topic: '闲聊' },
  }).reason, 'missing-recent-context');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '还没弄完', topic: '项目' },
  }).reason, 'missing-recent-context');

  // intent=reminder 但没有用户明确的提醒请求。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'reminder', sourceText: '明天要开会', topic: '开会' },
  }).reason, 'reminder-not-explicit');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'smalltalk', sourceText: '今天有面试', topic: '面试' },
  }).reason, 'unsupported-intent');

  // 无参调用走默认 phase/candidate/state/config。
  const defaults = decideFollowup();
  assert.equal(defaults.reason, 'unsupported-intent');
  assert.equal(defaults.mode, 'unsupported');
  assert.equal('intent' in defaults, false);
});

test('排程接受原文对象，也接受告别语里的显式提醒', () => {
  // sourceText 不是字符串时按 { text } 取文本。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: { text: '今天有面试，等结果' }, topic: '面试' },
  }).action, 'schedule');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: 42, topic: '面试' },
  }).reason, 'missing-recent-context');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '我先走了，最近还有面试', topic: '面试' },
  }).reason, 'ordinary-farewell');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '我先走了，明天提醒我交作业', topic: '作业' },
  }).action, 'schedule');
});

test('排程在非法 phase 与主动联系关闭时给出明确原因', () => {
  assert.equal(decideFollowup({
    phase: 'later',
    now: NOW,
    candidate: CHECKIN,
  }).reason, 'invalid-phase');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    config: { enabled: false },
  }).reason, 'disabled');
});

// ── 3. 拒绝 ───────────────────────────────────────────────────────

test('用户拒绝在排程与送出两个阶段都取消', () => {
  assert.deepEqual(
    pick(decideFollowup({ phase: 'schedule', now: NOW, candidate: CHECKIN, state: { refused: true } })),
    { eligible: false, action: 'cancel', reason: 'user-refused' },
  );
  assert.deepEqual(
    pick(decideFollowup({ phase: 'send', now: NOW, candidate: CHECKIN, state: { refused: '别再联系我' } })),
    { eligible: false, action: 'cancel', reason: 'user-refused' },
  );
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { ...CHECKIN, sourceText: '别烦我，今天有面试' },
  }).reason, 'user-refused');
  // refused 字符串不命中拒绝词时继续正常判定。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { refused: '好的' },
  }).action, 'schedule');
});

// ── 4. 重复话题：排程阶段 ─────────────────────────────────────────

test('排程按待办话题去重，但提醒与不同话题不受影响', () => {
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ intent: 'check-in', topic: '面试' }] },
  }).reason, 'duplicate-pending-topic');

  // 待办里已有的主动回访（follow-up）同样算重复。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ intent: 'follow-up', topic: '面试' }] },
  }).reason, 'duplicate-pending-topic');

  // 提醒、无 intent、不同话题都不算重复。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ intent: 'reminder', topic: '面试' }] },
  }).action, 'schedule');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ topic: '面试' }] },
  }).action, 'schedule');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ intent: 'check-in', topic: '考试' }] },
  }).action, 'schedule');

  // 候选没有话题、或待办列表不是数组时不做去重。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '今天有面试，等结果' },
    state: { pendingFollowups: [{ intent: 'check-in', topic: '面试' }] },
  }).action, 'schedule');
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: null },
  }).action, 'schedule');
});

// ── 5. 送出：静默时段（含跨午夜） ─────────────────────────────────

test('送出在安静时段静默，覆盖普通区间、对象写法与跨午夜', () => {
  assert.equal(decideFollowup({
    phase: 'send',
    now: NIGHT,
    candidate: CHECKIN,
    config: { quietHours: [23, 7] },
  }).reason, 'quiet-hours');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NIGHT,
    candidate: CHECKIN,
    config: { quietHours: { start: 23, end: 7 } },
  }).reason, 'quiet-hours');
  assert.equal(decideFollowup({
    phase: 'send',
    now: MIDNIGHT,
    candidate: CHECKIN,
    config: { quietHours: [23, 7] },
  }).reason, 'quiet-hours');

  // 白天不在静默时段，直接可发。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    config: { quietHours: [23, 7] },
  }).action, 'send');
});

// ── 6. 送出：每日上限与冷却 ───────────────────────────────────────

test('送出受每日上限约束，提醒记录不占配额', () => {
  const sentToday = [
    { intent: 'follow-up', topic: '旧话题', sentAt: '2026-10-25T09:00:00' },
    { intent: 'check-in', topic: '另一个话题', sentAt: '2026-10-25T09:30:00' },
  ];
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: sentToday },
    config: { maxPerDay: 2 },
  }).reason, 'daily-cap');

  // 上限为 0 表示今天不再主动联系；NaN / 负数视为不限。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: sentToday },
    config: { maxPerDay: 0 },
  }).reason, 'daily-cap');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: sentToday },
    config: { maxPerDay: 'x' },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: sentToday },
    config: { maxPerDay: -1 },
  }).action, 'send');

  // 只统计主动联系；intent=reminder（含大写）的记录被排除。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [
      { intent: 'reminder', topic: 'a', sentAt: '2026-10-25T09:00:00' },
      { intent: 'reminder', topic: 'b', sentAt: '2026-10-25T09:10:00' },
      { intent: 'Reminder', topic: 'c', sentAt: '2026-10-25T09:20:00' },
    ] },
    config: { maxPerDay: 2 },
  }).action, 'send');

  // 记录字段回退：kind / type 也能识别，at / timestamp 也能取到时间。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ kind: 'reminder', topic: 'a', sentAt: '2026-10-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ type: 'follow-up', topic: 'a', sentAt: '2026-10-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).reason, 'daily-cap');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: 'a', at: '2026-10-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).reason, 'daily-cap');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: 'a', timestamp: '2026-10-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).reason, 'daily-cap');

  // 没有 intent/kind/type 的记录按主动联系计数。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ topic: 'a', sentAt: '2026-10-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).reason, 'daily-cap');

  // 跨年 / 跨月的历史记录不算今天。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: 'a', sentAt: '2025-12-31T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: 'a', sentAt: '2026-09-25T09:00:00' }] },
    config: { maxPerDay: 1 },
  }).action, 'send');

  // 无效时间不计数；sentFollowups 不是数组时按空列表处理。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: 'a', sentAt: 'bad' }] },
    config: { maxPerDay: 1 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: 'nope' },
    config: { maxPerDay: 1 },
  }).action, 'send');
});

test('送出受冷却约束，0 或负数冷却不生效', () => {
  const recent = { sentFollowups: [{ intent: 'follow-up', topic: '旧话题', sentAt: '2026-10-25T09:50:00' }] };
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: recent,
    config: { maxPerDay: 3, cooldownMs: 30 * 60 * 1000 },
  }).reason, 'cooldown');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: recent,
    config: { maxPerDay: 3, cooldownMs: 0 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: recent,
    config: { maxPerDay: 3, cooldownMs: -1 },
  }).action, 'send');
});

// ── 7. 送出：重复话题 ─────────────────────────────────────────────

test('送出按话题去重，话题 key 会归一化标点', () => {
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'follow-up', topic: '面试！', sentAt: '2026-10-24T09:00:00' }] },
    config: { maxPerDay: 3 },
  }).reason, 'duplicate-topic');

  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '今天有面试，等结果' },
    state: { sentFollowups: [{ intent: 'follow-up', topic: '面试', sentAt: '2026-10-24T09:00:00' }] },
    config: { maxPerDay: 3 },
  }).action, 'send');

  // 提醒记录不参与主动联系的话题去重。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { sentFollowups: [{ intent: 'reminder', topic: '面试', sentAt: '2026-10-24T09:00:00' }] },
    config: { maxPerDay: 3 },
  }).action, 'send');
});

// ── 8. 用户更新发言后取消过时回访 ─────────────────────────────────

test('用户发言晚于待发项时取消，早于或相等时继续', () => {
  assert.deepEqual(
    pick(decideFollowup({
      phase: 'send',
      now: NOW,
      candidate: { ...CHECKIN, createdAt: '2026-10-25T08:00:00' },
      state: { lastUserMessageAt: '2026-10-25T09:00:00' },
      config: { maxPerDay: 3 },
    })),
    { eligible: false, action: 'cancel', reason: 'user-spoke-after-pending' },
  );

  // createdAt 缺失时回退到匹配到的 pending 项。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: {
      pendingFollowups: [{ intent: 'check-in', topic: '面试', createdAt: '2026-10-25T08:00:00' }],
      lastUserMessageAt: '2026-10-25T09:00:00',
    },
    config: { maxPerDay: 3 },
  }).reason, 'user-spoke-after-pending');

  // 按 id 匹配 pending，哪怕话题不同。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: { ...CHECKIN, id: 'p1' },
    state: {
      pendingFollowups: [{ id: 'p1', intent: 'check-in', topic: '别的', createdAt: '2026-10-25T08:00:00' }],
      lastUserMessageAt: '2026-10-25T09:00:00',
    },
    config: { maxPerDay: 3 },
  }).reason, 'user-spoke-after-pending');

  // id 没匹配上时回退到话题；pending 没有 intent 也能匹配。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: { ...CHECKIN, id: 'missing' },
    state: {
      pendingFollowups: [{ topic: '面试', createdAt: '2026-10-25T08:00:00' }],
      lastUserMessageAt: '2026-10-25T09:00:00',
    },
    config: { maxPerDay: 3 },
  }).reason, 'user-spoke-after-pending');

  // 待办里的 reminder 不是主动回访，匹配不到就照常发送。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: {
      pendingFollowups: [{ intent: 'reminder', topic: '面试', createdAt: '2026-10-25T08:00:00' }],
      lastUserMessageAt: '2026-10-25T09:00:00',
    },
    config: { maxPerDay: 3 },
  }).action, 'send');

  // 用户消息不晚于待发项（或缺失）时照常发送。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: {
      pendingFollowups: [{ intent: 'check-in', topic: '面试', createdAt: '2026-10-25T09:00:00' }],
      lastUserMessageAt: '2026-10-25T08:00:00',
    },
    config: { maxPerDay: 3 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: {
      pendingFollowups: [{ intent: 'check-in', topic: '面试', createdAt: '2026-10-25T09:00:00' }],
      lastUserMessageAt: '2026-10-25T09:00:00',
    },
    config: { maxPerDay: 3 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: { pendingFollowups: [{ intent: 'check-in', topic: '面试', createdAt: '2026-10-25T08:00:00' }] },
    config: { maxPerDay: 3 },
  }).action, 'send');
  assert.equal(decideFollowup({
    phase: 'send',
    now: NOW,
    candidate: CHECKIN,
    state: {},
    config: { maxPerDay: 3 },
  }).action, 'send');
});

// ── 9. 显式提醒豁免主动联系限制 ───────────────────────────────────

test('显式提醒绕过静默、上限、冷却、话题去重与总开关', () => {
  const state = {
    sentFollowups: [
      { intent: 'follow-up', topic: '作业', sentAt: '2026-10-25T23:20:00' },
      { intent: 'check-in', topic: '别的事', sentAt: '2026-10-25T09:00:00' },
    ],
  };
  const config = { quietHours: [23, 7], maxPerDay: 1, cooldownMs: 60 * 60 * 1000, enabled: false };
  assert.deepEqual(
    pick(decideFollowup({ phase: 'send', now: NIGHT, candidate: REMINDER, state, config })),
    { eligible: true, action: 'send', reason: 'eligible' },
  );

  // 提醒本身也不占主动联系的配额（上限 0 仍然可发）。
  assert.equal(decideFollowup({
    phase: 'send',
    now: NIGHT,
    candidate: REMINDER,
    state: { sentFollowups: [{ intent: 'reminder', topic: '作业', sentAt: '2026-10-25T23:20:00' }] },
    config: { quietHours: [23, 7], maxPerDay: 0, cooldownMs: 60 * 60 * 1000 },
  }).action, 'send');

  assert.equal(decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: REMINDER,
    config: { enabled: false },
  }).action, 'schedule');
});

// ── 10. invalid phase / invalid now ──────────────────────────────

test('非法 phase 与非法 now 返回明确原因', () => {
  assert.equal(decideFollowup({ phase: 'later', now: NOW, candidate: CHECKIN }).reason, 'invalid-phase');
  assert.equal(decideFollowup({
    phase: 'send',
    now: 'not-a-date',
    candidate: CHECKIN,
  }).reason, 'invalid-now');
  assert.equal(decideFollowup({
    phase: 'send',
    now: new Date('not-a-date'),
    candidate: CHECKIN,
  }).reason, 'invalid-now');

  // 排程阶段不用 now，非法时间不影响排程结论。
  assert.equal(decideFollowup({
    phase: 'schedule',
    now: 'not-a-date',
    candidate: CHECKIN,
  }).action, 'schedule');
});

// ── 11. 结果形状 ─────────────────────────────────────────────────

test('结果只带契约字段：topic 缺省时不出现，intent 为空时省略', () => {
  const withTopic = decideFollowup({ phase: 'schedule', now: NOW, candidate: CHECKIN });
  assert.equal(withTopic.topic, '面试');
  assert.equal(withTopic.mode, 'check-in');
  assert.equal(withTopic.intent, 'check-in');

  const withoutTopic = decideFollowup({
    phase: 'schedule',
    now: NOW,
    candidate: { intent: 'check-in', sourceText: '今天有面试，等结果' },
  });
  assert.equal('topic' in withoutTopic, false);

  const noIntent = decideFollowup();
  assert.equal('intent' in noIntent, false);
});

// ── 12. isQuietHours 边界 ────────────────────────────────────────

test('isQuietHours 处理缺省、区间、跨午夜与非法输入', () => {
  assert.equal(isQuietHours(NOW, null), false);
  assert.equal(isQuietHours(NOW, undefined), false);

  assert.equal(isQuietHours(NOW, [9, 17]), true);
  assert.equal(isQuietHours(new Date('2026-10-25T09:00:00'), [9, 17]), true);
  assert.equal(isQuietHours(new Date('2026-10-25T17:00:00'), [9, 17]), false);
  assert.equal(isQuietHours(NIGHT, [23, 7]), true);
  assert.equal(isQuietHours(MIDNIGHT, [23, 7]), true);
  assert.equal(isQuietHours(new Date('2026-10-25T12:00:00'), [23, 7]), false);
  assert.equal(isQuietHours(NOW, { start: 9, end: 17 }), true);

  // 起止相同视为全天静默；字符串数字按数字处理。
  assert.equal(isQuietHours(NOW, [5, 5]), true);
  assert.equal(isQuietHours(NOW, ['9', '17']), true);
  assert.equal(isQuietHours(NOW.getTime(), [9, 17]), true);

  // 非法区间 / 非法时间一律返回 false，而不是猜。
  assert.equal(isQuietHours(NOW, ['x', 7]), false);
  assert.equal(isQuietHours('not-a-date', [9, 17]), false);
});
