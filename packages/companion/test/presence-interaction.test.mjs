/**
 * presence-interaction · 本地在场互动策略的离线测试
 * ─────────────────────────────────────────────────────────────
 * 全部用注入时钟 / 显式时间戳，不联网、不装定时器、不依赖真实时间、
 * 不碰文件系统状态（唯一读文件的地方是「源码静态检查」那条用例，
 * 只读本模块自己的源码）。不发送任何 QQ / Web 消息，不调用任何模型。
 *
 * 覆盖：
 *   · 首次启动、重连、心跳式输入不欢迎
 *   · idle 短离开不欢迎；真实 away → returned 才欢迎，且只欢迎一次
 *   · 离开时长不足 returnAfterMs 不欢迎；没有离开锚点按重连处理
 *   · 欢迎冷却、提醒冷却各自独立、互不压制
 *   · 在场累计按 present 累加，idle 暂停，away 清零并开新会话
 *   · 每段会话最多一次提醒；两次提醒之间有独立冷却
 *   · 每次 evaluate 最多一条 intent；欢迎优先于到期的提醒
 *   · 晚到的 away/returned 批次仍能算出真实离开时长
 *   · enabled=false 硬空操作、setEnabled、reset/clear 语义
 *   · 非法 at、缺省 at 用注入时钟、时钟倒流钳制
 *   · 未来事件忽略后可重放；略微超前的事件按 at 处理
 *   · 事件去重（id 与签名）、去重表有界淘汰、非法事件丢弃
 *   · 输入归一化（非对象请求、单事件对象、Date/数字 at）
 *   · 声明状态优先于事件状态；unknown/away/idle 的收尾分支
 *   · 内容盲：载荷噪音不进入 intent、stats、options
 *   · 兜底文案的边界（短、无数字、不越界）
 *   · 构造参数默认值与非法值回落、实例隔离
 *   · 与真实 PresenceMonitor 的事件与状态形状对接
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import PresenceInteractionPolicy, {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PRESENCE_INTERACTION_OPTIONS,
  DEFAULT_RETURN_AFTER_MS,
  DEFAULT_WORK_AFTER_MS,
  PRESENCE_INTERACTION_KINDS,
  PRESENCE_INTERACTION_TEXT,
  createPresenceInteractionPolicy,
} from '../src/presence-interaction.js';
import {
  PRESENCE_EVENT_TYPES,
  PresenceMonitor,
} from '../src/presence.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const MIN = 60_000;
const RETURN_MS = 5 * MIN;
const WORK_MS = 50 * MIN;
const COOLDOWN_MS = 90 * MIN;

const WELCOME = PRESENCE_INTERACTION_KINDS.WELCOME_BACK;
const BREAK = PRESENCE_INTERACTION_KINDS.BREAK_REMINDER;

function iso(ms) {
  return new Date(ms).toISOString();
}

function ev(type, ms, previousState, state, id, sequence = 1) {
  return {
    id,
    type,
    at: iso(ms),
    previousState,
    state,
    sequence,
  };
}

function entered(ms, id = 'entered-1') {
  return ev(PRESENCE_EVENT_TYPES.ENTERED, ms, 'unknown', 'present', id);
}

function idle(ms, id = 'idle-1') {
  return ev(PRESENCE_EVENT_TYPES.IDLE, ms, 'present', 'idle', id);
}

function away(ms, id = 'away-1') {
  return ev(PRESENCE_EVENT_TYPES.AWAY, ms, 'present', 'away', id);
}

function returned(ms, previousState = 'away', id = 'returned-1') {
  return ev(PRESENCE_EVENT_TYPES.RETURNED, ms, previousState, 'present', id);
}

/** 注入可变时钟；evaluate 仍显式传 at 时以 at 为准。 */
function makePolicy({ nowValue = T0, ...options } = {}) {
  let clock = nowValue;
  const policy = new PresenceInteractionPolicy({ now: () => clock, ...options });
  return {
    policy,
    setClock(value) {
      clock = value;
    },
  };
}

function kinds(intents) {
  return intents.map((intent) => intent.kind);
}

// ── 基本规则 ──────────────────────────────────────────────────

test('first activity, reconnect and heartbeat-like input never greet', () => {
  const { policy } = makePolicy();
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [entered(T0)],
    at: T0,
  }), []);

  // 同一段会话继续，只有活动时间，没有 returned。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + MIN }), []);

  // 重连：状态已经是 present，但没有 returned 事件。
  const reconnect = makePolicy().policy;
  assert.deepEqual(reconnect.evaluate({ state: 'present', events: [], at: T0 }), []);
  assert.deepEqual(reconnect.evaluate({ state: 'present', events: [], at: T0 + MIN }), []);

  // 心跳不是状态机事件；未知类型即使塞进来也不会产生欢迎。
  const heartbeatOnly = makePolicy().policy;
  assert.deepEqual(heartbeatOnly.evaluate({
    state: 'present',
    events: [{ id: 'hb', type: 'presence.heartbeat', at: iso(T0), previousState: 'away', state: 'present' }],
    at: T0,
  }), []);
});

test('short idle return does not greet; true away return greets exactly once', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'idle', events: [idle(T0 + 5 * MIN)], at: T0 + 5 * MIN });
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 6 * MIN, 'idle', 'return-idle')],
    at: T0 + 6 * MIN,
  }), []);

  policy.evaluate({ state: 'away', events: [away(T0 + 30 * MIN)], at: T0 + 30 * MIN });
  const back = returned(T0 + 40 * MIN, 'away', 'return-away');
  const intents = policy.evaluate({ state: 'present', events: [back], at: T0 + 40 * MIN });
  assert.equal(intents.length, 1);
  assert.deepEqual(Object.keys(intents[0]).sort(), ['at', 'id', 'kind', 'text']);
  assert.equal(intents[0].kind, WELCOME);
  assert.equal(intents[0].text, PRESENCE_INTERACTION_TEXT[WELCOME]);
  assert.equal(intents[0].at, iso(T0 + 40 * MIN));
  assert.equal(typeof intents[0].id, 'string');
  assert.ok(intents[0].id.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(intents[0])), intents[0]);

  // 同一条事件重复投递：id 去重。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [back], at: T0 + 41 * MIN }), []);
  // 换一个 id、内容相同：签名去重。
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 40 * MIN, 'away', 'return-away-copy')],
    at: T0 + 42 * MIN,
  }), []);
  assert.ok(policy.stats.duplicates >= 2);
});

test('away shorter than returnAfterMs does not greet', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'away', events: [away(T0 + 30 * MIN)], at: T0 + 30 * MIN });
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 32 * MIN)],
    at: T0 + 32 * MIN,
  }), []);
});

test('a returned event without a known away anchor is treated as reconnect, not a welcome', () => {
  const { policy } = makePolicy();
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 40 * MIN, 'away', 'return-no-anchor')],
    at: T0 + 40 * MIN,
  }), []);
});

test('welcome cooldown suppresses a second return and later expires', () => {
  const { policy } = makePolicy({ cooldownMs: COOLDOWN_MS });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });

  policy.evaluate({ state: 'away', events: [away(T0 + 10 * MIN, 'away-a')], at: T0 + 10 * MIN });
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 20 * MIN, 'away', 'return-a')],
    at: T0 + 20 * MIN,
  })), [WELCOME]);

  policy.evaluate({ state: 'away', events: [away(T0 + 30 * MIN, 'away-b')], at: T0 + 30 * MIN });
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 40 * MIN, 'away', 'return-b')],
    at: T0 + 40 * MIN,
  }), [], '距上次欢迎 20 分钟，仍在 90 分钟冷却内');

  policy.evaluate({ state: 'away', events: [away(T0 + 50 * MIN, 'away-c')], at: T0 + 50 * MIN });
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 120 * MIN, 'away', 'return-c')],
    at: T0 + 120 * MIN,
  })), [WELCOME], '距上次欢迎 100 分钟，冷却已过');
});

test('work threshold emits one break reminder per sustained session', () => {
  const { policy } = makePolicy();
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });

  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 49 * MIN }), []);
  const reminder = policy.evaluate({ state: 'present', events: [], at: T0 + 50 * MIN });
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].kind, BREAK);
  assert.equal(reminder[0].text, PRESENCE_INTERACTION_TEXT[BREAK]);
  assert.equal(reminder[0].at, iso(T0 + 50 * MIN));

  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 51 * MIN }), []);
  assert.equal(policy.stats.emitted, 1);
});

test('idle pauses active accumulation; away resets it', () => {
  const idlePolicy = makePolicy({ cooldownMs: 0 }).policy;
  idlePolicy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  idlePolicy.evaluate({ state: 'idle', events: [idle(T0 + 10 * MIN)], at: T0 + 10 * MIN });
  assert.deepEqual(idlePolicy.evaluate({ state: 'idle', events: [], at: T0 + 60 * MIN }), []);
  idlePolicy.evaluate({
    state: 'present',
    events: [returned(T0 + 61 * MIN, 'idle', 'idle-return')],
    at: T0 + 61 * MIN,
  });
  assert.deepEqual(idlePolicy.evaluate({ state: 'present', events: [], at: T0 + 100 * MIN }), []);
  assert.deepEqual(kinds(idlePolicy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 101 * MIN,
  })), [BREAK]);

  const awayPolicy = makePolicy({ cooldownMs: 0 }).policy;
  awayPolicy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  awayPolicy.evaluate({ state: 'present', events: [], at: T0 + 30 * MIN });
  awayPolicy.evaluate({ state: 'away', events: [away(T0 + 31 * MIN)], at: T0 + 31 * MIN });
  awayPolicy.evaluate({ state: 'present', events: [returned(T0 + 32 * MIN)], at: T0 + 32 * MIN });
  assert.deepEqual(awayPolicy.evaluate({ state: 'present', events: [], at: T0 + 81 * MIN }), []);
  assert.deepEqual(kinds(awayPolicy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 82 * MIN,
  })), [BREAK], '离开后重新从 0 开始累计，50 分钟后才提醒');
});

test('welcome and break cooldowns are independent in both directions', () => {
  const welcomeThenBreak = makePolicy().policy;
  welcomeThenBreak.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  welcomeThenBreak.evaluate({ state: 'away', events: [away(T0 + MIN)], at: T0 + MIN });
  assert.deepEqual(kinds(welcomeThenBreak.evaluate({
    state: 'present',
    events: [returned(T0 + 10 * MIN)],
    at: T0 + 10 * MIN,
  })), [WELCOME]);
  assert.deepEqual(kinds(welcomeThenBreak.evaluate({
    state: 'present',
    events: [],
    at: T0 + 60 * MIN,
  })), [BREAK], '欢迎的冷却不能压掉 50 分钟后的休息提醒');

  const breakThenWelcome = makePolicy().policy;
  breakThenWelcome.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.deepEqual(kinds(breakThenWelcome.evaluate({
    state: 'present',
    events: [],
    at: T0 + 50 * MIN,
  })), [BREAK]);
  breakThenWelcome.evaluate({ state: 'away', events: [away(T0 + 51 * MIN)], at: T0 + 51 * MIN });
  assert.deepEqual(kinds(breakThenWelcome.evaluate({
    state: 'present',
    events: [returned(T0 + 60 * MIN)],
    at: T0 + 60 * MIN,
  })), [WELCOME], '提醒的冷却不能压掉真实离开后的欢迎');
});

test('at most one intent per evaluate; welcome wins over a due reminder', () => {
  const { policy } = makePolicy({ workAfterMs: 0, cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'away', events: [away(T0 + MIN)], at: T0 + MIN });
  const intents = policy.evaluate({
    state: 'present',
    events: [returned(T0 + 10 * MIN)],
    at: T0 + 10 * MIN,
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, WELCOME);
});

test('a late-arriving away/returned batch still measures the real away duration', () => {
  const { policy } = makePolicy();
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'present', events: [], at: T0 + 35 * MIN });
  const intents = policy.evaluate({
    state: 'present',
    events: [
      away(T0 + 30 * MIN, 'late-away'),
      returned(T0 + 40 * MIN, 'away', 'late-return'),
    ],
    at: T0 + 40 * MIN,
  });
  assert.deepEqual(kinds(intents), [WELCOME]);
  assert.ok(policy.stats.historicalEvents >= 1);
});

// ── 开关、重置、时间与内容盲 ──────────────────────────────────

test('enabled=false is a hard no-op; re-enabling starts clean', () => {
  const { policy } = makePolicy({ enabled: false });
  const inputs = [
    { state: 'present', events: [entered(T0)], at: T0 },
    { state: 'away', events: [away(T0 + 30 * MIN)], at: T0 + 30 * MIN },
    { state: 'present', events: [returned(T0 + 40 * MIN)], at: T0 + 40 * MIN },
    { state: 'present', events: [], at: T0 + 100 * MIN },
  ];
  for (const input of inputs) assert.deepEqual(policy.evaluate(input), []);
  assert.equal(policy.enabled, false);
  assert.equal(policy.stats.emitted, 0);
  assert.equal(policy.stats.state, 'unknown');
  assert.equal(policy.stats.trackedEvents, 0);

  policy.setEnabled(true);
  assert.equal(policy.enabled, true);
  // 关闭期间没有累计，重新启用后不会立刻补发提醒。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 101 * MIN }), []);
});

test('setEnabled(false) resets session and cooldowns', () => {
  const { policy } = makePolicy();
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 50 * MIN,
  })), [BREAK]);
  policy.setEnabled(false);
  assert.equal(policy.stats.emitted, 0);
  assert.equal(policy.stats.state, 'unknown');
  assert.equal(policy.stats.trackedEvents, 0);
});

test('reset/clear wipes dedupe, cooldowns, session and counters but keeps config', () => {
  const { policy } = makePolicy({ cooldownMs: 0, workAfterMs: 10 * MIN });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'away', events: [away(T0 + MIN)], at: T0 + MIN });
  const back = returned(T0 + 10 * MIN, 'away', 'return-reset');
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [back],
    at: T0 + 10 * MIN,
  })), [WELCOME]);

  assert.equal(policy.reset(), policy);
  assert.equal(policy.stats.state, 'unknown');
  assert.equal(policy.stats.emitted, 0);
  assert.equal(policy.stats.trackedEvents, 0);
  assert.equal(policy.stats.activeMs, 0);
  assert.equal(policy.options.workAfterMs, 10 * MIN);

  // 去重表已清空：同一 id 的事件可以再次处理。
  policy.evaluate({ state: 'present', events: [entered(T0 + 20 * MIN)], at: T0 + 20 * MIN });
  policy.evaluate({ state: 'away', events: [away(T0 + 21 * MIN, 'away-reset')], at: T0 + 21 * MIN });
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [returned(T0 + 30 * MIN, 'away', 'return-reset')],
    at: T0 + 30 * MIN,
  })), [WELCOME]);
  assert.equal(policy.clear(), policy);
});

test('invalid explicit timestamps are rejected; missing at uses the injected clock', () => {
  const { policy, setClock } = makePolicy({ nowValue: T0 });
  for (const bad of ['not-a-time', Number.NaN, {}, [], true]) {
    assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: bad }), []);
  }
  assert.equal(policy.stats.rejected, 5);

  // 空字符串是非法时间；null 视同「没传」，回落到注入时钟。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: '' }), []);
  assert.equal(policy.stats.rejected, 6);
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: null }), []);
  assert.equal(policy.stats.rejected, 6, 'null 不计数，按缺省 at 处理');

  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  setClock(T0 + 50 * MIN);
  assert.deepEqual(kinds(policy.evaluate({ state: 'present', events: [] })), [BREAK]);

  // 时钟倒流被钳住，不倒退会话，也不重复提醒。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 10 * MIN }), []);
  assert.ok(policy.stats.clockSkewCount >= 1);
});

test('future events are ignored now and can be processed when time catches up', () => {
  const { policy } = makePolicy();
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  const futureReturn = returned(T0 + 10 * MIN, 'away', 'future-return');
  assert.deepEqual(policy.evaluate({ state: 'present', events: [futureReturn], at: T0 + MIN }), []);
  assert.equal(policy.stats.futureEvents, 1);
  assert.equal(policy.stats.duplicates, 0);

  // 没有离开锚点，所以时间追上后也只按重连处理，不欢迎。
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [futureReturn],
    at: T0 + 10 * MIN,
  }), []);
  assert.equal(policy.stats.futureEvents, 1);
});

test('event payload noise never enters intents or policy views', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  const markers = [
    'PRIVATE-BODY',
    'PRIVATE-TITLE',
    'https://private.example.invalid/x',
    'PRIVATE-FILE.txt',
    'PRIVATE-CLIPBOARD',
    'PRIVATE-USER-ID',
  ];
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({
    state: 'away',
    events: [{
      ...away(T0 + 30 * MIN),
      text: markers[0],
      windowTitle: markers[1],
      url: markers[2],
      files: [markers[3]],
      clipboard: markers[4],
      userId: markers[5],
    }],
    at: T0 + 30 * MIN,
  });
  const intents = policy.evaluate({
    state: 'present',
    events: [{
      ...returned(T0 + 40 * MIN),
      text: markers[0],
      title: markers[1],
      clipboard: markers[4],
    }],
    at: T0 + 40 * MIN,
  });
  assert.deepEqual(kinds(intents), [WELCOME]);
  assert.deepEqual(Object.keys(intents[0]).sort(), ['at', 'id', 'kind', 'text']);

  const blob = JSON.stringify({ intents, stats: policy.stats, options: policy.options });
  for (const marker of markers) assert.equal(blob.includes(marker), false, '不得含 ' + marker);
});

test('fallback text is short, deterministic and stays inside the sensing boundary', () => {
  assert.equal(Object.isFrozen(PRESENCE_INTERACTION_TEXT), true);
  assert.deepEqual(Object.keys(PRESENCE_INTERACTION_TEXT).sort(), [BREAK, WELCOME].sort());
  const forbidden = [
    '屏幕', '窗口', '应用', '程序', '文件', '网址', '网页', '剪贴板', '键盘', '鼠标', '截图',
    '监控', '盯着', '看着你', '一直', '好久', '很久', '分钟', '小时', '秒', '天',
    '等你', '对不起', '抱歉', '医生', '治疗', '药', '病', '健康', '眼睛', '颈椎', '腰',
    '身体', '熬夜', '休息不足', '必须', '应该', '不准', '不许',
  ];
  for (const [kind, text] of Object.entries(PRESENCE_INTERACTION_TEXT)) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length >= 4 && text.length <= 40, kind + ' 文案长度应短');
    assert.equal(/\d/.test(text), false, kind + ' 文案不得出现数字');
    assert.equal(/[\r\n]/.test(text), false, kind + ' 文案不得换行');
    for (const word of forbidden) {
      assert.equal(text.includes(word), false, kind + ' 文案不得含「' + word + '」');
    }
  }
});

test('constructor defaults and invalid-option fallbacks are stable', () => {
  const policy = new PresenceInteractionPolicy();
  assert.deepEqual(policy.options, {
    returnAfterMs: DEFAULT_RETURN_AFTER_MS,
    workAfterMs: DEFAULT_WORK_AFTER_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
    maxSeen: 256,
  });
  assert.deepEqual(DEFAULT_PRESENCE_INTERACTION_OPTIONS, {
    returnAfterMs: DEFAULT_RETURN_AFTER_MS,
    workAfterMs: DEFAULT_WORK_AFTER_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
  });
  assert.equal(RETURN_MS, DEFAULT_RETURN_AFTER_MS);
  assert.equal(WORK_MS, DEFAULT_WORK_AFTER_MS);
  assert.equal(COOLDOWN_MS, DEFAULT_COOLDOWN_MS);

  const fallback = new PresenceInteractionPolicy({
    returnAfterMs: -1,
    workAfterMs: 'nope',
    cooldownMs: Number.NaN,
    enabled: 0,
  });
  assert.equal(fallback.options.returnAfterMs, DEFAULT_RETURN_AFTER_MS);
  assert.equal(fallback.options.workAfterMs, DEFAULT_WORK_AFTER_MS);
  assert.equal(fallback.options.cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(fallback.options.enabled, true, '只有显式 false 才关闭');

  const nullOptions = new PresenceInteractionPolicy({
    returnAfterMs: null,
    workAfterMs: '',
    cooldownMs: undefined,
  });
  assert.equal(nullOptions.options.returnAfterMs, DEFAULT_RETURN_AFTER_MS);
  assert.equal(nullOptions.options.workAfterMs, DEFAULT_WORK_AFTER_MS);
  assert.equal(nullOptions.options.cooldownMs, DEFAULT_COOLDOWN_MS);

  assert.ok(createPresenceInteractionPolicy() instanceof PresenceInteractionPolicy);
});

test('module source stays local, content-blind and timer-free', () => {
  const source = fs.readFileSync(new URL('../src/presence-interaction.js', import.meta.url), 'utf8');
  const forbidden = [
    /\bfetch\s*\(/,
    /\brequire\s*\(/,
    /from\s+['"]node:/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
    /\bXMLHttpRequest\b/,
    /\blocalStorage\b/,
    /\bprocess\.env\b/,
    /\bwriteFile/,
    /\breadFile/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, 'presence-interaction.js 不得匹配 ' + pattern);
  }
  assert.match(source, /export class PresenceInteractionPolicy/);
  assert.match(source, /export function createPresenceInteractionPolicy/);
});

test('works with real PresenceMonitor event and state shapes', () => {
  const monitor = new PresenceMonitor({ idleMs: MIN, awayMs: 10 * MIN, clock: () => T0 });
  const policy = new PresenceInteractionPolicy({
    now: () => T0,
    returnAfterMs: 5 * MIN,
    workAfterMs: 50 * MIN,
    cooldownMs: 0,
  });

  monitor.observeActivity(T0);
  assert.deepEqual(policy.evaluate({
    state: monitor.state,
    events: monitor.consumeEvents(),
    at: T0,
  }), []);

  monitor.tick(T0 + 10 * MIN);
  assert.equal(monitor.state, 'away');
  assert.deepEqual(policy.evaluate({
    state: monitor.state,
    events: monitor.consumeEvents(),
    at: T0 + 10 * MIN,
  }), []);

  monitor.observeActivity(T0 + 20 * MIN);
  const backEvents = monitor.consumeEvents();
  assert.deepEqual(kinds(policy.evaluate({
    state: monitor.state,
    events: backEvents,
    at: T0 + 20 * MIN,
  })), [WELCOME]);

  // 同一批真实事件重放不会重复欢迎。
  assert.deepEqual(policy.evaluate({
    state: monitor.state,
    events: backEvents,
    at: T0 + 20 * MIN + 1,
  }), []);

  // 真实状态机继续推进到工作阈值。
  assert.deepEqual(kinds(policy.evaluate({
    state: monitor.state,
    events: [],
    at: T0 + 70 * MIN,
  })), [BREAK]);
});

// ── 输入归一化与时间形状 ──────────────────────────────────────

test('evaluate normalizes non-object requests and single-event payloads', () => {
  const { policy } = makePolicy();
  // 非对象请求按「没有状态、没有事件」处理，不抛错。
  for (const request of [undefined, null, [], 'present', 42, true]) {
    assert.deepEqual(policy.evaluate(request), []);
  }
  assert.equal(policy.stats.rejected, 0);

  // events 允许是单个对象，也允许是其它类型（按空处理）。
  const single = makePolicy({ cooldownMs: 0 }).policy;
  assert.deepEqual(single.evaluate({
    state: 'present',
    events: { type: PRESENCE_EVENT_TYPES.ENTERED, at: iso(T0), previousState: 'unknown', state: 'present' },
    at: T0,
  }), []);
  assert.equal(single.stats.state, 'present');
  assert.deepEqual(single.evaluate({ state: 'present', events: 'nope', at: T0 + MIN }), []);
  assert.equal(single.stats.state, 'present');

  // at 支持 Date 与毫秒数；Date 形状非法时拒绝。
  const dateAt = makePolicy({ cooldownMs: 0 }).policy;
  dateAt.evaluate({ state: 'present', events: [entered(T0)], at: new Date(T0) });
  assert.deepEqual(kinds(dateAt.evaluate({
    state: 'present',
    events: [],
    at: T0 + WORK_MS,
  })), [BREAK]);
  const numericAt = makePolicy({ cooldownMs: 0 }).policy;
  numericAt.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.deepEqual(kinds(numericAt.evaluate({
    state: 'present',
    events: [],
    at: T0 + WORK_MS,
  })), [BREAK]);
  assert.deepEqual(dateAt.evaluate({ at: new Date(Number.NaN) }), []);
  assert.equal(dateAt.stats.rejected, 1);

  // 超长字符串时间戳直接判非法，不去猜。
  const longAt = 'x'.repeat(65);
  assert.deepEqual(dateAt.evaluate({ at: longAt }), []);
  assert.equal(dateAt.stats.rejected, 2);
});

test('clock option accepts a fixed value, falls back safely and survives a throwing clock', () => {
  // 固定数字时钟：等价于 () => T0。
  const fixed = new PresenceInteractionPolicy({ now: T0, workAfterMs: 0 });
  assert.deepEqual(kinds(fixed.evaluate({ state: 'present' })), [BREAK]);

  // 非法固定时钟回落到真实 Date.now，evaluate() 仍可用（不会抛）。
  const fallbackClock = new PresenceInteractionPolicy({ now: 'not-a-time' });
  assert.deepEqual(fallbackClock.evaluate({ state: 'present' }), []);
  assert.equal(fallbackClock.stats.rejected, 0);

  // 时钟自己抛错：按「拿不到时间」处理，计入 rejected，不产生 intent。
  const throwing = new PresenceInteractionPolicy({
    now: () => {
      throw new Error('clock down');
    },
  });
  assert.deepEqual(throwing.evaluate({ state: 'present' }), []);
  assert.equal(throwing.stats.rejected, 1);

  // 没有 now 选项时用默认时钟。
  const defaultClock = new PresenceInteractionPolicy();
  assert.deepEqual(defaultClock.evaluate({ state: 'present', events: [] }), []);
});

test('malformed events are dropped before they can move state', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  const before = policy.stats;

  const junk = [
    null,
    undefined,
    'presence.away',
    42,
    [],
    { type: PRESENCE_EVENT_TYPES.AWAY, at: iso(T0 + MIN), state: 'away' }, // 缺 previousState 也能进
    { type: 'presence.bogus', at: iso(T0 + MIN), state: 'away' },
    { type: PRESENCE_EVENT_TYPES.AWAY, at: 'not-a-time', state: 'away' },
    { type: PRESENCE_EVENT_TYPES.AWAY, at: undefined, state: 'away' },
    { type: PRESENCE_EVENT_TYPES.AWAY, at: new Date(Number.NaN), state: 'away' },
    { type: PRESENCE_EVENT_TYPES.AWAY, at: 'x'.repeat(65), state: 'away' },
  ];
  assert.deepEqual(policy.evaluate({ state: 'present', events: junk, at: T0 + MIN }), []);
  // 只有那条形状正确、缺 previousState 的 away 被接受；它没有 id，
  // 所以只进去重表一个签名键。声明状态仍是 present，收尾状态按声明走。
  assert.equal(policy.stats.trackedEvents, before.trackedEvents + 1);
  assert.equal(policy.stats.state, 'present');
  assert.equal(policy.stats.activeMs, 0, 'away 事件已把会话累计清零');

  // 未知状态名归一化成 null，不会当成 present/away 用。
  const unknownState = makePolicy({ cooldownMs: 0 }).policy;
  unknownState.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.deepEqual(unknownState.evaluate({ state: 'sleeping', events: [], at: T0 + MIN }), []);
  assert.equal(unknownState.stats.state, 'present');
});

test('slightly-future events are clamped to at; farther ones wait for their time', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });

  // 4 秒超前（≤ 5 秒容忍）：按 at 处理，仍然走 away 转换。
  const slightlyAhead = away(T0 + MIN + 4000, 'slightly-ahead');
  policy.evaluate({ state: 'away', events: [slightlyAhead], at: T0 + MIN });
  assert.equal(policy.stats.state, 'away');
  assert.equal(policy.stats.futureEvents, 0);
  assert.equal(policy.stats.awayMs, 0, '离开锚点被钳到 at，不产生负数离开时长');

  // 6 秒超前：本次忽略且不记为已见，时间追上后仍可处理。
  const later = makePolicy({ cooldownMs: 0 }).policy;
  later.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  const ahead = away(T0 + MIN + 6000, 'ahead');
  assert.deepEqual(later.evaluate({ events: [ahead], at: T0 + MIN }), []);
  assert.equal(later.stats.futureEvents, 1);
  assert.equal(later.stats.state, 'present', '未来事件不得改变状态');
  assert.equal(later.stats.trackedEvents, 2, '未来事件不进去重表');
  later.evaluate({ state: 'away', events: [ahead], at: T0 + MIN + 6000 });
  assert.equal(later.stats.state, 'away');
  assert.equal(later.stats.duplicates, 0, '未来事件不记为已见，追上后按新事件处理');
});

test('dedupe keys are bounded: the oldest entries are evicted and can be seen again', () => {
  const policy = new PresenceInteractionPolicy({ now: () => T0, maxSeen: 16, cooldownMs: 0 });
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push(ev(PRESENCE_EVENT_TYPES.IDLE, T0 + i * 1000, 'present', 'idle', 'idle-' + i, i + 1));
  }
  policy.evaluate({ state: 'idle', events, at: T0 + 10_000 });
  assert.equal(policy.stats.trackedEvents, 16, '每条事件两个键，集合上限 16');
  assert.equal(policy.stats.duplicates, 0);

  // 最近一条还在集合里：判重。
  policy.evaluate({ state: 'idle', events: [events[9]], at: T0 + 11_000 });
  assert.equal(policy.stats.duplicates, 1);

  // 最早一条的键已被淘汰：当作新事件重新处理，不再计入 duplicates。
  policy.evaluate({ state: 'idle', events: [events[0]], at: T0 + 12_000 });
  assert.equal(policy.stats.duplicates, 1, '被淘汰的旧键不会再判重');
  assert.equal(policy.stats.trackedEvents, 16);

  // maxSeen 低于下限时回落到默认 256；合法值原样保留。
  assert.equal(new PresenceInteractionPolicy({ maxSeen: 4 }).options.maxSeen, 256);
  assert.equal(new PresenceInteractionPolicy({ maxSeen: 32 }).options.maxSeen, 32);
  assert.equal(new PresenceInteractionPolicy({ maxSeen: 'nope' }).options.maxSeen, 256);
});

test('away anchor keeps the earliest timestamp and a returned without previousState still measures it', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'away', events: [away(T0 + 10 * MIN, 'away-first')], at: T0 + 10 * MIN });
  // 第二条 away 不推迟锚点：离开时长仍从第一次离开算起。
  policy.evaluate({ state: 'away', events: [away(T0 + 20 * MIN, 'away-second')], at: T0 + 20 * MIN });
  assert.equal(policy.stats.awayMs, 10 * MIN);

  // returned 没带 previousState：回落到策略自己的状态（away），照常测量并欢迎。
  const intents = policy.evaluate({
    state: 'present',
    events: [ev(PRESENCE_EVENT_TYPES.RETURNED, T0 + 25 * MIN, undefined, 'present', 'return-bare')],
    at: T0 + 25 * MIN,
  });
  assert.deepEqual(kinds(intents), [WELCOME]);
  assert.equal(intents[0].at, iso(T0 + 25 * MIN));
  assert.equal(policy.stats.awayMs, 0);
});

test('returned from an unknown previous state restarts the session without greeting', () => {
  const { policy } = makePolicy({ cooldownMs: 0, workAfterMs: 30 * MIN });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'present', events: [], at: T0 + 25 * MIN });
  assert.equal(policy.stats.activeMs, 25 * MIN);

  const intents = policy.evaluate({
    state: 'present',
    events: [ev(PRESENCE_EVENT_TYPES.RETURNED, T0 + 26 * MIN, 'unknown', 'present', 'return-unknown')],
    at: T0 + 26 * MIN,
  });
  assert.deepEqual(intents, [], 'previousState 未知时既不欢迎也不假设在忙');
  assert.equal(policy.stats.activeMs, 0);
  // 会话从 0 重新累计：30 分钟阈值要等到 T0 + 56 分钟。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 55 * MIN }), []);
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 56 * MIN,
  })), [BREAK]);
});

test('declared state wins over event state and settles each terminal branch', () => {
  // 事件说 present，但宿主声明 idle：声明赢了，这段未知时间不算工作。
  const idleDeclared = makePolicy({ cooldownMs: 0, workAfterMs: 10 * MIN }).policy;
  idleDeclared.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  idleDeclared.evaluate({ state: 'present', events: [], at: T0 + 5 * MIN });
  assert.equal(idleDeclared.stats.activeMs, 5 * MIN);
  idleDeclared.evaluate({ state: 'idle', events: [], at: T0 + 10 * MIN });
  assert.equal(idleDeclared.stats.state, 'idle');
  assert.equal(idleDeclared.stats.activeMs, 5 * MIN, '声明 idle 的那段不累计');
  assert.deepEqual(idleDeclared.evaluate({ state: 'idle', events: [], at: T0 + 60 * MIN }), []);
  assert.equal(idleDeclared.stats.activeMs, 5 * MIN, 'idle 期间暂停累计');

  // 声明 unknown：清空累计与会话标记，离开锚点也丢掉。
  idleDeclared.evaluate({ state: 'away', events: [], at: T0 + 61 * MIN });
  assert.equal(idleDeclared.stats.state, 'away');
  idleDeclared.evaluate({ state: 'unknown', events: [], at: T0 + 62 * MIN });
  assert.equal(idleDeclared.stats.state, 'unknown');
  assert.equal(idleDeclared.stats.activeMs, 0);
  assert.equal(idleDeclared.stats.awayMs, 0);

  // 声明 away 而没有事件：锚点落在 at 上，awayMs 从那一刻开始长。
  idleDeclared.evaluate({ state: 'away', events: [], at: T0 + 63 * MIN });
  idleDeclared.evaluate({ state: 'away', events: [], at: T0 + 68 * MIN });
  assert.equal(idleDeclared.stats.awayMs, 5 * MIN);

  // 声明 present 但没有 returned：按重连处理，丢掉离开锚点。
  idleDeclared.evaluate({ state: 'present', events: [], at: T0 + 69 * MIN });
  assert.equal(idleDeclared.stats.state, 'present');
  assert.equal(idleDeclared.stats.awayMs, 0);
});

test('break reminder keeps its own cooldown across sessions', () => {
  const policy = new PresenceInteractionPolicy({
    now: () => T0,
    workAfterMs: 10 * MIN,
    cooldownMs: COOLDOWN_MS,
    returnAfterMs: RETURN_MS,
  });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 10 * MIN,
  })), [BREAK]);

  // 新会话（away → returned），10 分钟后又够阈值，但仍在提醒冷却内。
  policy.evaluate({ state: 'away', events: [away(T0 + 11 * MIN)], at: T0 + 11 * MIN });
  policy.evaluate({ state: 'present', events: [returned(T0 + 12 * MIN)], at: T0 + 12 * MIN });
  assert.deepEqual(policy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 22 * MIN,
  }), [], '距上次提醒 12 分钟，仍在 90 分钟冷却内');

  // 冷却一过，同一会话里立刻补上（会话标记只看「本会话有没有提醒过」）。
  assert.deepEqual(policy.evaluate({ state: 'present', events: [], at: T0 + 99 * MIN }), []);
  assert.deepEqual(kinds(policy.evaluate({
    state: 'present',
    events: [],
    at: T0 + 100 * MIN,
  })), [BREAK], '距上次提醒正好 90 分钟，冷却已过');
  assert.equal(policy.stats.emitted, 2);
});

test('stats and options are structured, content-free and serializable', () => {
  const { policy } = makePolicy({ cooldownMs: 0 });
  policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  policy.evaluate({ state: 'present', events: [], at: T0 + MIN });
  policy.evaluate({ state: 'away', events: [away(T0 + 2 * MIN)], at: T0 + 2 * MIN });

  const stats = policy.stats;
  assert.deepEqual(Object.keys(stats).sort(), [
    'activeMs', 'awayMs', 'clockSkewCount', 'duplicates', 'emitted', 'enabled',
    'futureEvents', 'historicalEvents', 'rejected', 'state', 'trackedEvents',
  ]);
  for (const key of Object.keys(stats)) {
    if (key === 'state' || key === 'enabled') continue;
    assert.equal(typeof stats[key], 'number', key + ' 必须是数字');
    assert.ok(Number.isFinite(stats[key]), key + ' 必须有限');
    assert.ok(stats[key] >= 0, key + ' 不得为负');
  }
  assert.equal(typeof stats.enabled, 'boolean');
  assert.equal(stats.state, 'away');
  assert.equal(stats.awayMs, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), stats);
  assert.deepEqual(JSON.parse(JSON.stringify(policy.options)), policy.options);
  assert.equal(Object.isFrozen(policy.options), false, 'options 是快照，不是共享对象');
});

test('two policies never share state', () => {
  const a = new PresenceInteractionPolicy({ now: () => T0 });
  const b = new PresenceInteractionPolicy({ now: () => T0 });
  a.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.equal(b.stats.state, 'unknown');
  assert.deepEqual(b.evaluate({ state: 'present', events: [], at: T0 }), []);
  assert.deepEqual(kinds(a.evaluate({ state: 'present', events: [], at: T0 + WORK_MS })), [BREAK]);
  assert.equal(b.stats.emitted, 0, 'b 没有累计，不会被 a 的会话带到阈值');
  assert.equal(b.stats.activeMs, 0);
  assert.equal(a.stats.trackedEvents, 2);
  assert.equal(b.stats.trackedEvents, 0, '去重表各自独立');
});

test('events sharing a timestamp are ordered by sequence and then by id', () => {
  const sameAt = (type, ms, previousState, state, id, sequence) => ({
    id,
    type,
    at: iso(ms),
    previousState,
    state,
    sequence,
  });

  // 同一时间戳：先按 sequence 升序。数组里 away 在前，但 idle 的序号更小，
  // 所以真正的处理顺序是 idle → away，最终停在 away。
  const bySequence = new PresenceInteractionPolicy({ now: () => T0 });
  bySequence.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  bySequence.evaluate({
    events: [
      sameAt(PRESENCE_EVENT_TYPES.AWAY, T0 + MIN, 'present', 'away', 'away-9', 9),
      sameAt(PRESENCE_EVENT_TYPES.IDLE, T0 + MIN, 'present', 'idle', 'idle-8', 8),
    ],
    at: T0 + MIN,
  });
  assert.equal(bySequence.stats.state, 'away', 'idle(8) 先于 away(9)');

  // sequence 相同：按 id 字典序，保证同一批输入在任何宿主上顺序一致。
  const byId = new PresenceInteractionPolicy({ now: () => T0 });
  byId.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  byId.evaluate({
    events: [
      sameAt(PRESENCE_EVENT_TYPES.AWAY, T0 + MIN, 'present', 'away', 'zzz', 7),
      sameAt(PRESENCE_EVENT_TYPES.IDLE, T0 + MIN, 'present', 'idle', 'aaa', 7),
      sameAt(PRESENCE_EVENT_TYPES.IDLE, T0 + MIN, 'present', 'idle', 'mmm', 7),
    ],
    at: T0 + MIN,
  });
  assert.equal(byId.stats.state, 'away', 'aaa/mmm 的 idle 都排在 zzz 的 away 之前');

  // 完全并列（无 id、同 at、同 sequence）：保持稳定顺序，不丢事件。
  const tied = new PresenceInteractionPolicy({ now: () => T0 });
  tied.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  tied.evaluate({
    events: [
      sameAt(PRESENCE_EVENT_TYPES.IDLE, T0 + MIN, 'present', 'idle', undefined, 3),
      sameAt(PRESENCE_EVENT_TYPES.AWAY, T0 + MIN, 'present', 'away', undefined, 3),
    ],
    at: T0 + MIN,
  });
  assert.equal(tied.stats.state, 'away', '两条都处理，最后一条决定状态');
  assert.equal(tied.stats.trackedEvents, 4, '并列事件各自留下签名键');
});

test('intent ids are stable in shape and unique per emit', () => {
  const policy = new PresenceInteractionPolicy({ now: () => T0, workAfterMs: 0, cooldownMs: 0 });
  const first = policy.evaluate({ state: 'present', events: [entered(T0)], at: T0 });
  assert.equal(first[0].kind, BREAK);
  assert.equal(first[0].id, 'presence-interaction:' + BREAK + ':1');
  const second = policy.evaluate({
    state: 'present',
    events: [away(T0 + 2 * MIN), returned(T0 + 20 * MIN)],
    at: T0 + 20 * MIN,
  });
  assert.equal(second[0].kind, WELCOME);
  assert.equal(second[0].id, 'presence-interaction:' + WELCOME + ':2');
  assert.notEqual(first[0].id, second[0].id);
  assert.match(second[0].id, /^presence-interaction:[a-z-]+:\d+$/);
  // 序号在 reset() 后回到 0。
  policy.reset();
  const afterReset = policy.evaluate({
    state: 'present',
    events: [entered(T0 + 30 * MIN)],
    at: T0 + 30 * MIN,
  });
  assert.equal(afterReset[0].id, 'presence-interaction:' + BREAK + ':1');
});
