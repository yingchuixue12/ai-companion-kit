/**
 * presence · 本地在场状态机的离线测试
 * ─────────────────────────────────────────────────────────────
 * 全部用注入时钟 / 显式时间戳，不依赖真实时间、不联网、不碰文件系统状态
 * （唯一读文件的地方是「源码静态检查」那条用例，只读本模块自己的源码）。
 *
 * 覆盖：阈值转换、离开后回来、重复抑制、时钟倒流（含存档来自更快时钟）、
 *       存档恢复（含无效存档、配置接管、事件重放开关）、事件与历史的有界保留、
 *       非法输入、内容盲、心跳、窗口焦点、确定性、重置、实例隔离、
 *       以及输入归一化/消费上限/统计计数器等边界分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import PresenceMonitor, {
  DEFAULT_PRESENCE_OPTIONS,
  PRESENCE_AWAY,
  PRESENCE_EVENT_TYPES,
  PRESENCE_EVENT_TYPE_LIST,
  PRESENCE_IDLE,
  PRESENCE_PRIVACY,
  PRESENCE_PRESENT,
  PRESENCE_STATES,
  PRESENCE_UNKNOWN,
  createPresenceMonitor,
} from '../src/presence.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const IDLE_MS = 60_000;
const AWAY_MS = 600_000;

function monitor(options = {}) {
  return new PresenceMonitor({ idleMs: IDLE_MS, awayMs: AWAY_MS, clock: () => T0, ...options });
}

function types(events) {
  return events.map((event) => event.type);
}

// ── 状态机主路径 ──────────────────────────────────────────────

test('threshold transitions: entered → idle → away, settled only when asked', () => {
  const presence = monitor();

  const first = presence.observeActivity(T0);
  assert.equal(first.accepted, true);
  assert.equal(presence.state, PRESENCE_PRESENT);
  assert.deepEqual(types(first.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(first.events[0].reason, 'activity');
  assert.equal(first.events[0].previousState, PRESENCE_UNKNOWN);
  assert.equal(first.events[0].at, new Date(T0).toISOString());
  assert.equal(first.events[0].sequence, 1);
  assert.equal(first.events[0].id, 'presence:1');
  assert.equal(first.at, new Date(T0).toISOString());

  // 没到 idle 阈值：状态和事件都不动。
  const nearly = presence.tick(T0 + IDLE_MS - 1);
  assert.equal(nearly.changed, false);
  assert.deepEqual(nearly.events, []);
  assert.equal(presence.state, PRESENCE_PRESENT);

  // 正好到 idle 阈值。
  const idle = presence.tick(T0 + IDLE_MS);
  assert.equal(presence.state, PRESENCE_IDLE);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);
  assert.equal(idle.events[0].reason, 'idle-threshold');
  assert.equal(idle.events[0].inactiveMs, IDLE_MS);
  assert.equal(idle.events[0].previousState, PRESENCE_PRESENT);

  // idle 期间继续 tick 不重复发事件。
  assert.deepEqual(presence.tick(T0 + IDLE_MS * 2).events, []);

  // away 阈值。
  const away = presence.tick(T0 + AWAY_MS);
  assert.equal(presence.state, PRESENCE_AWAY);
  assert.deepEqual(types(away.events), [PRESENCE_EVENT_TYPES.AWAY]);
  assert.equal(away.events[0].inactiveMs, AWAY_MS);
  assert.equal(away.events[0].previousState, PRESENCE_IDLE);

  // 状态机不会自己往下走：没有 tick 就没有新事件。
  assert.equal(presence.consumeEvents().length, 3);
  assert.equal(presence.consumeEvents().length, 0);
});

test('away is reached directly when a single gap passes both thresholds', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  const jump = presence.tick(T0 + AWAY_MS * 10);
  assert.deepEqual(types(jump.events), [PRESENCE_EVENT_TYPES.AWAY]);
  assert.equal(presence.state, PRESENCE_AWAY);
  // 跳过 idle 时不会补发 idle 事件。
  assert.equal(types(presence.consumeEvents()).includes(PRESENCE_EVENT_TYPES.IDLE), false);
});

test('return detection after away, and after idle', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  presence.tick(T0 + AWAY_MS);
  assert.equal(presence.state, PRESENCE_AWAY);

  const returned = presence.observeActivity(T0 + AWAY_MS + 1_000);
  assert.equal(presence.state, PRESENCE_PRESENT);
  assert.deepEqual(types(returned.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(returned.events[0].reason, 'returned-from-away');
  assert.equal(returned.events[0].previousState, PRESENCE_AWAY);

  const idleMonitor = monitor();
  idleMonitor.observeActivity(T0);
  idleMonitor.tick(T0 + IDLE_MS);
  assert.equal(idleMonitor.state, PRESENCE_IDLE);
  const back = idleMonitor.observeActivity(T0 + IDLE_MS + 1_000);
  assert.deepEqual(types(back.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(back.events[0].reason, 'returned-from-idle');
  assert.equal(back.events[0].previousState, PRESENCE_IDLE);
});

test('duplicate suppression: no second returned/entered without a real transition', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  // present 期间的重复活动只更新时间戳，不发事件。
  for (let i = 1; i <= 5; i += 1) {
    const repeated = presence.observeActivity(T0 + i * 1_000);
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.events, []);
  }
  assert.equal(presence.lastActivityAt, new Date(T0 + 5_000).toISOString());
  assert.deepEqual(types(presence.consumeEvents()), [PRESENCE_EVENT_TYPES.ENTERED]);

  // 一次 idle 之后只有一条 returned。
  presence.tick(T0 + 5_000 + IDLE_MS);
  presence.observeActivity(T0 + 5_000 + IDLE_MS + 1);
  presence.observeActivity(T0 + 5_000 + IDLE_MS + 2);
  assert.deepEqual(
    types(presence.consumeEvents()),
    [PRESENCE_EVENT_TYPES.IDLE, PRESENCE_EVENT_TYPES.RETURNED],
  );

  // 同样的 tick 重复调用不会产生第二条 idle。
  presence.tick(T0 + 5_000 + IDLE_MS + 2 + IDLE_MS);
  presence.tick(T0 + 5_000 + IDLE_MS + 2 + IDLE_MS + 10);
  assert.deepEqual(types(presence.consumeEvents()), [PRESENCE_EVENT_TYPES.IDLE]);
});

// ── 时钟 ──────────────────────────────────────────────────────

test('clock skew: backward timestamps are clamped, counted, and never rewind state', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  presence.tick(T0 + IDLE_MS);
  assert.equal(presence.state, PRESENCE_IDLE);

  // 时间倒流 60s：观测被钳到 lastSeenAt，于是算作一次活动归来。
  const skewed = presence.observeActivity(T0 + 20_000);
  assert.equal(skewed.accepted, true);
  assert.equal(skewed.at, new Date(T0 + IDLE_MS).toISOString());
  assert.equal(presence.state, PRESENCE_PRESENT);
  assert.deepEqual(types(skewed.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(skewed.events[0].at, new Date(T0 + IDLE_MS).toISOString());

  const stats = presence.stats;
  assert.equal(stats.clockSkewCount, 1);
  assert.equal(stats.maxClockSkewMs, IDLE_MS - 20_000);

  // 再倒流一次：仍然不倒退状态、不多发事件。
  const again = presence.tick(T0 + 40_000);
  assert.equal(again.changed, false);
  assert.equal(again.at, new Date(T0 + IDLE_MS).toISOString());
  assert.equal(presence.state, PRESENCE_PRESENT);
  assert.equal(presence.stats.clockSkewCount, 2);
  assert.equal(presence.stats.maxClockSkewMs, IDLE_MS - 20_000);

  // 时钟恢复正常后阈值仍然算得动。
  const idleAgain = presence.tick(T0 + IDLE_MS + IDLE_MS);
  assert.deepEqual(types(idleAgain.events), [PRESENCE_EVENT_TYPES.IDLE]);
});

test('restored activity anchor ahead of the clock is pulled back instead of freezing', () => {
  const presence = new PresenceMonitor({ idleMs: IDLE_MS, awayMs: AWAY_MS });
  // 存档里的活动锚点比当前时钟快 1 小时。
  presence.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_PRESENT,
    lastActivityAt: new Date(T0 + 3_600_000).toISOString(),
    stateSinceAt: new Date(T0 + 3_600_000).toISOString(),
  });
  assert.equal(presence.lastActivityAt, new Date(T0 + 3_600_000).toISOString());

  const pulled = presence.tick(T0);
  assert.equal(pulled.accepted, true);
  assert.equal(pulled.at, new Date(T0).toISOString());
  assert.deepEqual(pulled.events, []);
  assert.equal(presence.state, PRESENCE_PRESENT);
  // 活动锚点与状态锚点都被拉回现在，倒流被记入计数。
  assert.equal(presence.lastActivityAt, new Date(T0).toISOString());
  assert.equal(presence.stateSinceAt, new Date(T0).toISOString());
  assert.equal(presence.stats.clockSkewCount, 1);
  assert.equal(presence.stats.maxClockSkewMs, 3_600_000);

  // 拉回之后阈值继续算得动。
  const idle = presence.tick(T0 + IDLE_MS);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);
});

test('injected clock is used when no timestamp is passed', () => {
  let ticked = T0;
  const presence = new PresenceMonitor({ idleMs: IDLE_MS, awayMs: AWAY_MS, clock: () => ticked });

  const entered = presence.observeActivity();
  assert.deepEqual(types(entered.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(entered.at, new Date(T0).toISOString());

  ticked = T0 + IDLE_MS;
  const idle = presence.tick();
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);

  ticked = T0 + IDLE_MS + 1;
  const returned = presence.observeActivity();
  assert.deepEqual(types(returned.events), [PRESENCE_EVENT_TYPES.RETURNED]);

  // 时钟抛错时按非法输入处理，不改状态。
  const broken = new PresenceMonitor({ clock: () => { throw new Error('boom'); } });
  const failed = broken.tick();
  assert.equal(failed.accepted, false);
  assert.equal(failed.reason, 'invalid-time');
  assert.equal(broken.state, PRESENCE_UNKNOWN);

  // 时钟返回 Date 也行；返回无效 Date / 乱码字符串一律 invalid-time。
  const dated = new PresenceMonitor({ clock: () => new Date(T0) });
  assert.equal(dated.observeActivity().at, new Date(T0).toISOString());
  assert.equal(new PresenceMonitor({ clock: () => new Date(Number.NaN) }).tick().reason, 'invalid-time');
  assert.equal(new PresenceMonitor({ clock: () => 'nope' }).tick().reason, 'invalid-time');
  // 非函数 clock 被忽略，回落到缺省时钟（不会因为配置写错就炸）。
  assert.equal(new PresenceMonitor({ clock: 'now' }).observeActivity(T0).accepted, true);
});

// ── 存档 / 恢复 ───────────────────────────────────────────────

test('snapshot/restore survives process restart without inventing presence', () => {
  const before = monitor();
  before.observeActivity(T0);
  before.tick(T0 + IDLE_MS);
  before.tick(T0 + AWAY_MS);
  assert.equal(before.state, PRESENCE_AWAY);

  const frozen = JSON.stringify(before.snapshot());
  assert.equal(typeof frozen, 'string');
  const after = PresenceMonitor.fromSnapshot(JSON.parse(frozen));
  assert.equal(after.state, PRESENCE_AWAY);
  assert.equal(after.lastActivityAt, new Date(T0).toISOString());
  assert.equal(after.idleMs, IDLE_MS);
  assert.equal(after.awayMs, AWAY_MS);
  assert.equal(after.snapshot().privacy.contentBlind, true);

  // 重启后回来：是 returned，不是 entered；事件 id 继续往下排，不复用。
  const returned = after.observeActivity(T0 + AWAY_MS + 5_000);
  assert.deepEqual(types(returned.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(returned.events[0].sequence, 4);
  assert.equal(returned.events[0].id, 'presence:4');

  // present 状态存档后重启：阈值从存档时间继续算。
  const present = monitor();
  present.observeActivity(T0);
  const revived = PresenceMonitor.fromSnapshot(present.snapshot());
  assert.equal(revived.state, PRESENCE_PRESENT);
  assert.deepEqual(types(revived.consumeEvents()), []);
  assert.deepEqual(types(revived.tick(T0 + IDLE_MS).events), [PRESENCE_EVENT_TYPES.IDLE]);

  // 存档里没有活动时间的「在场」不算在场。
  const bogus = PresenceMonitor.fromSnapshot({ kind: 'presence-snapshot', version: 1, state: 'present' });
  assert.equal(bogus.state, PRESENCE_UNKNOWN);
  assert.deepEqual(bogus.consumeEvents(), []);
});

test('restore does not replay pending events unless asked', () => {
  const before = monitor();
  before.observeActivity(T0);
  before.tick(T0 + IDLE_MS);
  const snapshot = before.snapshot();
  assert.equal(snapshot.events.length, 2);
  assert.equal(before.pendingEventCount, 2);

  const quiet = PresenceMonitor.fromSnapshot(snapshot);
  assert.deepEqual(quiet.consumeEvents(), []);
  assert.equal(quiet.stats.sequence, 2);

  const loud = PresenceMonitor.fromSnapshot(snapshot, { replayEvents: true });
  assert.deepEqual(types(loud.consumeEvents()), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.IDLE,
  ]);
});

test('restore tolerates a slower clock instead of freezing', () => {
  const before = monitor();
  before.observeActivity(T0);
  // 存档来自「快了 10 分钟」的时钟。
  const after = PresenceMonitor.fromSnapshot(before.snapshot());
  const result = after.tick(T0 - 600_000);
  assert.equal(result.accepted, true);
  assert.equal(after.state, PRESENCE_PRESENT);
  assert.equal(after.stats.clockSkewCount >= 1, true);
  // 时钟追上之后，阈值照常生效（锚点已拉回到 T0-10min）。
  const idle = after.tick(T0 - 600_000 + IDLE_MS);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);
});

test('restore rehydrates counters, history and config from the snapshot', () => {
  const before = monitor({ maxEvents: 4, maxHistory: 3 });
  before.observeActivity(T0);
  before.tick(T0 + IDLE_MS);
  before.observeActivity(T0 + IDLE_MS + 1);
  before.tick(T0 + IDLE_MS * 2 + 1);
  const snapshot = before.snapshot();
  assert.equal(snapshot.counters.sequence, 4);

  // adoptConfig=true 时，阈值与队列上限都按存档里的配置接管。
  const adopted = new PresenceMonitor({ idleMs: 1, awayMs: 2, maxEvents: 1, maxHistory: 1 });
  const applied = adopted.restore(snapshot, { adoptConfig: true });
  assert.equal(applied.accepted, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.restoredEvents, 0);
  assert.deepEqual(adopted.options, { idleMs: IDLE_MS, awayMs: AWAY_MS, maxEvents: 4, maxHistory: 3 });
  assert.equal(adopted.history.length, 3);
  assert.equal(adopted.stats.sequence, 4);
  assert.equal(adopted.state, before.state);

  // 之后的第一条活动继续用旧序号，不回到 1。
  const next = adopted.observeActivity(T0 + IDLE_MS * 2 + 2);
  assert.equal(next.events[0].sequence, 5);

  // adoptConfig 缺省为 false：调用方自己的配置不被存档改写。
  const kept = new PresenceMonitor({ idleMs: 1_000, awayMs: 2_000 });
  kept.restore(snapshot);
  assert.deepEqual(kept.options, { idleMs: 1_000, awayMs: 2_000, maxEvents: 64, maxHistory: 32 });

  // 恢复历史/事件队列时也按（可能刚被接管的）上限截断。
  const bounded = new PresenceMonitor({ maxEvents: 1, maxHistory: 1 });
  const restored = bounded.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_IDLE,
    lastActivityAt: new Date(T0 + IDLE_MS).toISOString(),
    config: { idleMs: IDLE_MS, awayMs: AWAY_MS, maxEvents: 1, maxHistory: 1 },
    history: [
      { type: PRESENCE_EVENT_TYPES.ENTERED, at: new Date(T0).toISOString(), state: PRESENCE_PRESENT, previousState: PRESENCE_UNKNOWN },
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0 + IDLE_MS).toISOString(), state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT },
    ],
    events: [
      { type: PRESENCE_EVENT_TYPES.ENTERED, at: new Date(T0).toISOString(), state: PRESENCE_PRESENT, previousState: PRESENCE_UNKNOWN },
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0 + IDLE_MS).toISOString(), state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT },
    ],
  }, { adoptConfig: true, replayEvents: true });
  assert.equal(restored.restoredEvents, 1);
  assert.deepEqual(types(bounded.history), [PRESENCE_EVENT_TYPES.IDLE]);
  assert.deepEqual(types(bounded.peekEvents()), [PRESENCE_EVENT_TYPES.IDLE]);
});

test('restore normalises damaged fields instead of throwing', () => {
  const presence = new PresenceMonitor();

  // 非对象 / 坏 JSON / 错 kind / 错 version 一律 invalid-snapshot，且不改状态。
  for (const bad of [undefined, null, 42, 'not json', '42', [], true]) {
    const result = presence.restore(bad);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid-snapshot');
    assert.deepEqual(result.events, []);
    assert.equal(presence.state, PRESENCE_UNKNOWN);
  }
  assert.equal(presence.restore({ kind: 'something-else', state: PRESENCE_PRESENT }).reason, 'invalid-snapshot');
  assert.equal(presence.restore({ kind: 'presence-snapshot', version: 99 }).reason, 'invalid-snapshot');
  assert.equal(presence.restore({ kind: 'presence-snapshot', version: 0 }).reason, 'invalid-snapshot');
  assert.equal(presence.restore({ kind: 'presence-snapshot', version: 'x' }).reason, 'invalid-snapshot');
  assert.equal(presence.stats.rejectedObservations, 11);

  // kind / version 缺省时按当前版本接受（便于手工写的存档）。
  assert.equal(presence.restore({ state: PRESENCE_UNKNOWN }).accepted, true);
  assert.equal(presence.restore({ kind: 'presence-snapshot', version: '1', state: PRESENCE_UNKNOWN }).accepted, true);

  // 状态名不合法 → unknown；非 unknown 状态缺活动时间 → 退回 unknown。
  const junkState = new PresenceMonitor();
  junkState.restore({ kind: 'presence-snapshot', version: 1, state: 'sleeping' });
  assert.equal(junkState.state, PRESENCE_UNKNOWN);

  const awayNoActivity = new PresenceMonitor();
  awayNoActivity.restore({ kind: 'presence-snapshot', version: 1, state: PRESENCE_AWAY });
  assert.equal(awayNoActivity.state, PRESENCE_UNKNOWN);
  assert.equal(awayNoActivity.lastActivityAt, null);

  // unknown + 活动时间：仍不推断在场，tick 也不发事件。
  const unknownWithActivity = new PresenceMonitor();
  assert.equal(unknownWithActivity.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_UNKNOWN,
    lastActivityAt: new Date(T0).toISOString(),
  }).accepted, true);
  assert.equal(unknownWithActivity.state, PRESENCE_UNKNOWN);
  assert.deepEqual(unknownWithActivity.tick(T0 + AWAY_MS * 10).events, []);

  // 状态锚点缺失时用活动锚点补齐；坏 history/events 逐条丢弃，计数器负数归零。
  const sloppy = new PresenceMonitor();
  const result = sloppy.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_IDLE,
    lastActivityAt: new Date(T0 + IDLE_MS).toISOString(),
    history: [
      { id: '', type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0 + IDLE_MS).toISOString(), state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT, sequence: 3, inactiveMs: -4 },
      { id: 'custom-id', type: PRESENCE_EVENT_TYPES.AWAY, at: new Date(T0).toISOString(), state: PRESENCE_AWAY, previousState: PRESENCE_IDLE, sequence: 4, inactiveMs: '12.9' },
      { type: PRESENCE_EVENT_TYPES.IDLE, at: 'not-a-time', state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT },
      { type: 'presence.unknown-type', at: new Date(T0).toISOString(), state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT },
      'nope',
    ],
    events: 'not-an-array',
    counters: { sequence: 'x', droppedEvents: -3, droppedHistory: -1, clockSkewCount: -9, maxClockSkewMs: -2, rejectedObservations: -1 },
    config: 'not-an-object',
  });
  assert.equal(result.accepted, true);
  assert.equal(sloppy.state, PRESENCE_IDLE);
  assert.equal(sloppy.stateSinceAt, new Date(T0 + IDLE_MS).toISOString());
  assert.equal(sloppy.history.length, 2);
  assert.equal(sloppy.history[0].id, 'presence:3');
  assert.equal(sloppy.history[0].inactiveMs, 0);
  assert.equal(sloppy.history[1].id, 'custom-id');
  assert.equal(sloppy.history[1].inactiveMs, 12);
  // 坏条目是「逐条丢弃」，不是「整份存档拒收」，所以不计入 rejectedObservations；
  // 负数计数器一律归零，不把越界值带进运行态。
  assert.deepEqual(sloppy.stats, {
    sequence: 0,
    pendingEvents: 0,
    droppedEvents: 0,
    droppedHistory: 0,
    clockSkewCount: 0,
    maxClockSkewMs: 0,
    rejectedObservations: 0,
  });

  // 事件历史里 state / previousState 不是合法状态名的条目整条丢弃，
  // 不会把「未知状态」塞进 history 或事件队列。
  const badStates = new PresenceMonitor();
  badStates.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_IDLE,
    lastActivityAt: new Date(T0 + IDLE_MS).toISOString(),
    history: [
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0).toISOString(), state: 'sleeping', previousState: PRESENCE_PRESENT },
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0).toISOString(), state: PRESENCE_IDLE, previousState: 'sleeping' },
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0).toISOString(), state: PRESENCE_IDLE, previousState: PRESENCE_PRESENT },
    ],
    events: [
      { type: PRESENCE_EVENT_TYPES.IDLE, at: new Date(T0).toISOString(), state: 'sleeping', previousState: PRESENCE_PRESENT },
    ],
  }, { replayEvents: true });
  assert.equal(badStates.history.length, 1);
  assert.equal(badStates.peekEvents().length, 0);

  // hostAlive 只接受布尔值；缺失/非布尔一律当「没收到过心跳」。
  const aliveRestored = new PresenceMonitor();
  aliveRestored.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_PRESENT,
    lastActivityAt: new Date(T0).toISOString(),
    hostAlive: false,
  });
  assert.equal(aliveRestored.hostAlive, false);
  const junkAlive = new PresenceMonitor();
  junkAlive.restore({ kind: 'presence-snapshot', version: 1, hostAlive: 'yes' });
  assert.equal(junkAlive.hostAlive, null);

  // 第二个参数不是对象时按缺省处理，不抛错。
  const junkOptions = new PresenceMonitor({ idleMs: 1_000, awayMs: 2_000 });
  assert.equal(junkOptions.restore({ kind: 'presence-snapshot', version: 1, state: PRESENCE_UNKNOWN }, 'junk').accepted, true);
  assert.deepEqual(junkOptions.options, { idleMs: 1_000, awayMs: 2_000, maxEvents: 64, maxHistory: 32 });
});

test('fromSnapshot falls back to a fresh monitor when the archive is unusable', () => {
  const fallback = PresenceMonitor.fromSnapshot('{ broken json', { idleMs: 1_234, awayMs: 2_345 });
  assert.equal(fallback instanceof PresenceMonitor, true);
  assert.equal(fallback.state, PRESENCE_UNKNOWN);
  assert.equal(fallback.idleMs, 1_234);
  assert.equal(fallback.awayMs, 2_345);
  // 坏存档被记成一次被拒的恢复，而不是静默成功。
  assert.equal(fallback.stats.rejectedObservations, 1);

  // 可用的存档优先用存档配置，options 可以覆盖。
  const before = monitor();
  before.observeActivity(T0);
  before.tick(T0 + IDLE_MS);
  const revived = PresenceMonitor.fromSnapshot(before.snapshot(), { idleMs: 5_000, awayMs: 6_000, replayEvents: true });
  assert.equal(revived.idleMs, 5_000);
  assert.equal(revived.awayMs, 6_000);
  assert.equal(revived.state, PRESENCE_IDLE);
  assert.deepEqual(types(revived.consumeEvents()), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.IDLE,
  ]);

  // 第二个参数不是对象时按缺省处理：不接管配置，但也不抛错。
  const junkOptions = PresenceMonitor.fromSnapshot(before.snapshot(), 'junk');
  assert.equal(junkOptions.state, PRESENCE_IDLE);
  assert.equal(junkOptions.idleMs, IDLE_MS);
  assert.equal(junkOptions.awayMs, AWAY_MS);
});

// ── 有界保留 ──────────────────────────────────────────────────

test('bounded retention: pending events and history drop the oldest', () => {
  const presence = monitor({ maxEvents: 3, maxHistory: 2 });
  presence.observeActivity(T0);              // entered
  presence.tick(T0 + IDLE_MS);               // idle
  presence.observeActivity(T0 + IDLE_MS + 1); // returned
  presence.tick(T0 + IDLE_MS * 2 + 1);       // idle
  presence.observeActivity(T0 + IDLE_MS * 2 + 2); // returned

  assert.equal(presence.stats.sequence, 5);
  assert.equal(presence.pendingEventCount, 3);
  assert.equal(presence.stats.droppedEvents, 2);
  assert.deepEqual(types(presence.peekEvents()), [
    PRESENCE_EVENT_TYPES.RETURNED,
    PRESENCE_EVENT_TYPES.IDLE,
    PRESENCE_EVENT_TYPES.RETURNED,
  ]);
  assert.equal(presence.history.length, 2);
  assert.equal(presence.stats.droppedHistory, 3);

  // 部分消费。
  assert.deepEqual(types(presence.consumeEvents(1)), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.deepEqual(types(presence.consumeEvents()), [
    PRESENCE_EVENT_TYPES.IDLE,
    PRESENCE_EVENT_TYPES.RETURNED,
  ]);
  assert.equal(presence.consumeEvents(5).length, 0);
});

test('maxHistory=0 keeps no history but still counts drops; peek does not consume', () => {
  const presence = monitor({ maxHistory: 0, maxEvents: 1 });
  presence.observeActivity(T0);
  assert.equal(presence.history.length, 0);
  assert.equal(presence.stats.droppedHistory, 1);
  assert.equal(presence.pendingEventCount, 1);

  presence.tick(T0 + AWAY_MS);
  // 事件队列上限 1：最旧的 entered 被挤掉。
  assert.equal(presence.pendingEventCount, 1);
  assert.equal(presence.stats.droppedEvents, 1);
  assert.equal(presence.stats.droppedHistory, 2);
  assert.deepEqual(types(presence.peekEvents()), [PRESENCE_EVENT_TYPES.AWAY]);
  assert.deepEqual(types(presence.consumeEvents()), [PRESENCE_EVENT_TYPES.AWAY]);
});

test('consumeEvents limit: only non-negative finite numbers are honoured', () => {
  const build = () => {
    const presence = monitor({ maxEvents: 8 });
    presence.observeActivity(T0);
    presence.tick(T0 + IDLE_MS);
    presence.tick(T0 + AWAY_MS);
    return presence;
  };

  for (const limit of [undefined, null, -1, Number.NaN, 'x', {}]) {
    assert.equal(build().consumeEvents(limit).length, 3, 'limit ignored: ' + String(limit));
  }
  assert.equal(build().consumeEvents(0).length, 0);
  assert.equal(build().consumeEvents(1).length, 1);
  assert.equal(build().consumeEvents(1.9).length, 1);
  assert.equal(build().consumeEvents('2').length, 2);
  assert.equal(build().consumeEvents(99).length, 3);
});

// ── 输入校验 ──────────────────────────────────────────────────

test('invalid input is rejected without touching state', () => {
  const presence = monitor();

  const cases = [
    [presence.observeActivity({ at: 'not-a-time' }), 'invalid-time'],
    [presence.observeActivity({ at: Number.NaN }), 'invalid-time'],
    [presence.observeActivity({ at: '   ' }), 'invalid-time'],
    [presence.observeActivity({ at: 'x'.repeat(65) }), 'invalid-time'],
    [presence.observeActivity({ at: new Date(Number.NaN) }), 'invalid-time'],
    [presence.observeActivity({ at: T0, active: 'yes' }), 'invalid-active'],
    [presence.observeWindowFocus({ at: T0, focused: 1 }), 'invalid-focused'],
    [presence.observeHeartbeat({ at: T0, alive: 'true' }), 'invalid-alive'],
    [presence.observeActivity([]), 'invalid-input'],
    [presence.observeWindowFocus(Symbol('focus')), 'invalid-input'],
    [presence.observeActivity(() => {}), 'invalid-input'],
    [presence.tick({ at: {} }), 'invalid-time'],
    [presence.tick([]), 'invalid-input'],
  ];
  for (const [result, reason] of cases) {
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.events, []);
    assert.equal(result.changed, false);
    assert.equal(result.state, PRESENCE_UNKNOWN);
  }
  assert.equal(presence.state, PRESENCE_UNKNOWN);
  assert.equal(presence.lastActivityAt, null);
  assert.equal(presence.history.length, 0);
  assert.equal(presence.stats.rejectedObservations, cases.length);
  assert.equal(presence.stats.sequence, 0);

  // 坏存档不会抛错，也不会污染现有状态；被拒次数一并累计。
  const badJson = presence.restore('{ not json');
  assert.equal(badJson.accepted, false);
  assert.equal(badJson.reason, 'invalid-snapshot');
  const badKind = presence.restore({ kind: 'something-else', state: 'present' });
  assert.equal(badKind.accepted, false);
  const badVersion = presence.restore({ kind: 'presence-snapshot', version: 99, state: 'present' });
  assert.equal(badVersion.accepted, false);
  assert.equal(presence.state, PRESENCE_UNKNOWN);
  assert.equal(presence.stats.rejectedObservations, cases.length + 3);

  // 合法输入照常工作。
  const fine = presence.observeActivity(new Date(T0));
  assert.equal(fine.accepted, true);
  assert.deepEqual(types(fine.events), [PRESENCE_EVENT_TYPES.ENTERED]);
});

test('default clock is Date.now-based and read on demand, never cached', () => {
  const presence = new PresenceMonitor();
  const first = presence.observeActivity();
  assert.equal(first.accepted, true);
  assert.equal(first.state, PRESENCE_PRESENT);
  assert.equal(presence.lastActivityAt, first.at);
  // 缺省时钟每次调用都重新读，不缓存构造时的时间。
  const before = Date.now();
  const again = presence.observeActivity();
  const after = Date.now();
  assert.equal(again.accepted, true);
  // 不写死具体时刻：只要求落在这次调用前后的区间里（对本机时钟跳变留 1s 余量）。
  const parsed = Date.parse(again.at);
  assert.equal(parsed >= before - 1_000 && parsed <= after + 1_000, true);
  assert.equal(presence.tick().accepted, true);
  // 缺省时钟路径下语义与注入时钟一致：重复活动仍被抑制。
  assert.deepEqual(again.events, []);
});

test('observation inputs accept Date, millisecond numbers, ISO strings and boolean shorthand', () => {
  const presence = monitor();
  assert.deepEqual(types(presence.observeActivity(new Date(T0).toISOString()).events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(presence.lastActivityAt, new Date(T0).toISOString());

  // 数字简写 = 时间戳；毫秒内的浮点被截断。
  const numeric = presence.observeActivity(T0 + 1_500.7);
  assert.equal(numeric.at, new Date(T0 + 1_500).toISOString());

  // 字符串一律交给 Date.parse：四位纯数字是「年份」而不是毫秒。
  // 另起一个实例：上面的 lastSeenAt 已经很晚，会把这条更早的观测钳住。
  const yearString = monitor().observeActivity({ at: '1729' });
  assert.equal(yearString.at, new Date(Date.parse('1729')).toISOString());
  assert.equal(yearString.at, '1729-01-01T00:00:00.000Z');
  assert.equal(yearString.events[0].type, PRESENCE_EVENT_TYPES.ENTERED);
  // 超过 64 字符的字符串不当作时间，直接拒收（避免把整段正文塞进 Date.parse）。
  assert.equal(monitor().observeActivity({ at: '9'.repeat(65) }).reason, 'invalid-time');

  // 布尔简写：true = 有活动，false = 只结算阈值（等价 tick）。
  const bare = monitor();
  assert.deepEqual(types(bare.observeActivity(true).events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.deepEqual(bare.observeActivity(false).events, []);
  assert.equal(bare.state, PRESENCE_PRESENT);

  // 省略 at 时用注入时钟；显式 undefined 的布尔字段回落到默认（true）。
  const fallback = monitor();
  const entered = fallback.observeActivity({ active: undefined });
  assert.equal(entered.accepted, true);
  assert.equal(entered.at, new Date(T0).toISOString());
  assert.deepEqual(types(entered.events), [PRESENCE_EVENT_TYPES.ENTERED]);

  // tick 没有布尔 flag 的语义：裸布尔一律 invalid-input（不会当成「有活动」）。
  const bareTick = monitor();
  assert.equal(bareTick.tick(true).reason, 'invalid-input');
  assert.equal(bareTick.tick(false).reason, 'invalid-input');
  assert.equal(bareTick.state, PRESENCE_UNKNOWN);

  // 心跳同样只接受对象/时间/布尔简写；其他形状一律 invalid-input。
  assert.equal(monitor().observeHeartbeat([]).reason, 'invalid-input');
  assert.equal(monitor().observeHeartbeat(Symbol('hb')).reason, 'invalid-input');
  assert.equal(monitor().observeHeartbeat(() => {}).reason, 'invalid-input');
  assert.equal(monitor().observeHeartbeat({ at: 'nope' }).reason, 'invalid-time');
});

test('window focus: gaining focus is activity, losing focus only settles thresholds', () => {
  const presence = monitor();
  const focused = presence.observeWindowFocus({ at: T0, focused: true });
  assert.deepEqual(types(focused.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(focused.events[0].reason, 'focus');

  const blurred = presence.observeWindowFocus({ at: T0 + 1_000, focused: false });
  assert.deepEqual(blurred.events, []);
  assert.equal(presence.state, PRESENCE_PRESENT);

  // 焦点丢失后长时间无活动，照样按阈值离开。
  const idle = presence.tick(T0 + 1_000 + IDLE_MS);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);

  // 布尔简写：observeWindowFocus(false) = 只结算阈值。
  const bare = monitor();
  bare.observeActivity(T0);
  assert.deepEqual(bare.observeWindowFocus(false, undefined).events, []);
  const bareIdle = bare.observeWindowFocus(false);
  assert.equal(bareIdle.accepted, true);
  assert.equal(bare.state, PRESENCE_PRESENT);

  // 焦点丢失到阈值以下时，重新获得焦点算返回。
  bare.tick(T0 + IDLE_MS);
  const refocused = bare.observeWindowFocus(true);
  assert.deepEqual(types(refocused.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(refocused.events[0].reason, 'returned-from-idle');
});

// ── 心跳 ──────────────────────────────────────────────────────

test('heartbeat proves the host is alive but never counts as user activity', () => {
  // 只有心跳、没有活动：状态一直停在 unknown，也不会发事件。
  const lonely = monitor();
  for (let i = 0; i <= 60; i += 1) {
    lonely.observeHeartbeat({ at: T0 + i * 60_000, alive: true });
  }
  assert.equal(lonely.state, PRESENCE_UNKNOWN);
  assert.equal(lonely.hostAlive, true);
  assert.equal(lonely.lastHeartbeatAt, new Date(T0 + 60 * 60_000).toISOString());
  assert.deepEqual(lonely.consumeEvents(), []);

  const presence = monitor();
  presence.observeActivity(T0);
  presence.observeHeartbeat({ at: T0 + 30_000, alive: true });
  assert.equal(presence.state, PRESENCE_PRESENT);
  // 心跳不刷新活动锚点：静默照样到 idle。
  assert.equal(presence.lastActivityAt, new Date(T0).toISOString());
  const idle = presence.tick(T0 + IDLE_MS + 30_000);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);

  // 宿主自己离线 = away。
  const offline = presence.observeHeartbeat({ at: T0 + IDLE_MS + 40_000, alive: false });
  assert.equal(presence.hostAlive, false);
  assert.equal(presence.state, PRESENCE_AWAY);
  assert.deepEqual(types(offline.events), [PRESENCE_EVENT_TYPES.AWAY]);
  assert.equal(offline.events[0].reason, 'host-offline');
  assert.deepEqual(types(presence.consumeEvents()), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.IDLE,
    PRESENCE_EVENT_TYPES.AWAY,
  ]);

  // 重复离线心跳不重复发 away。
  const stillOffline = presence.observeHeartbeat({ at: T0 + IDLE_MS + 45_000, alive: false });
  assert.equal(stillOffline.accepted, true);
  assert.deepEqual(stillOffline.events, []);

  // 恢复心跳本身不算回来。
  presence.observeHeartbeat({ at: T0 + IDLE_MS + 50_000, alive: true });
  assert.equal(presence.state, PRESENCE_AWAY);
  assert.equal(presence.hostAlive, true);
  assert.deepEqual(presence.consumeEvents(), []);

  // 有活动才算回来。
  const returned = presence.observeActivity(T0 + IDLE_MS + 60_000);
  assert.deepEqual(types(returned.events), [PRESENCE_EVENT_TYPES.RETURNED]);

  // 心跳接受与观测相同的输入简写；alive 缺省视为 true。
  const shorthand = monitor();
  assert.equal(shorthand.observeHeartbeat(T0 + 1).accepted, true);
  assert.equal(shorthand.observeHeartbeat(new Date(T0 + 2)).accepted, true);
  assert.equal(shorthand.observeHeartbeat(true).accepted, true);
  assert.equal(shorthand.observeHeartbeat(null).accepted, true);
  assert.equal(shorthand.hostAlive, true);
  assert.equal(shorthand.observeHeartbeat({ alive: undefined }).accepted, true);
});

// ── 隐私 / 内容盲 ─────────────────────────────────────────────

test('content-blind: extra content fields never enter state, events or snapshot', () => {
  const presence = monitor();
  const noisy = {
    at: T0,
    active: true,
    text: 'PRIVATE-MESSAGE-BODY',
    windowTitle: 'PRIVATE-WINDOW-TITLE',
    url: 'https://private.example.invalid/secret',
    files: ['PRIVATE-FILE.txt'],
    clipboard: 'PRIVATE-CLIPBOARD',
    process: 'PRIVATE-PROCESS',
    screenshot: 'PRIVATE-SCREENSHOT',
  };
  const result = presence.observeActivity(noisy);
  assert.equal(result.accepted, true);
  assert.deepEqual(types(result.events), [PRESENCE_EVENT_TYPES.ENTERED]);

  presence.observeWindowFocus({ at: T0 + 1_000, focused: false, title: 'PRIVATE-WINDOW-TITLE' });
  presence.observeHeartbeat({ at: T0 + 2_000, alive: true, note: 'PRIVATE-MESSAGE-BODY' });
  presence.tick(T0 + IDLE_MS);

  const serialized = JSON.stringify({
    snapshot: presence.snapshot(),
    events: presence.peekEvents(),
    history: presence.history,
    stats: presence.stats,
  });
  for (const leaked of ['PRIVATE-MESSAGE-BODY', 'PRIVATE-WINDOW-TITLE', 'private.example.invalid',
    'PRIVATE-FILE.txt', 'PRIVATE-CLIPBOARD', 'PRIVATE-PROCESS', 'PRIVATE-SCREENSHOT']) {
    assert.equal(serialized.includes(leaked), false, 'snapshot leaked ' + leaked);
  }

  // 隐私元数据明确说明「只存状态」，并把不存的东西列清楚。
  const privacy = presence.privacy;
  assert.equal(privacy.contentBlind, true);
  assert.equal(privacy.localOnly, true);
  assert.equal(privacy.network, false);
  assert.equal(privacy.timers, false);
  assert.deepEqual(privacy.inputs, ['timestamp', 'boolean flag']);
  for (const forbidden of ['message text', 'screenshots', 'keystrokes', 'window titles',
    'file names or paths', 'urls', 'clipboard contents', 'process lists']) {
    assert.equal(privacy.neverStores.includes(forbidden), true, 'missing never-stores entry: ' + forbidden);
  }
  assert.deepEqual(presence.snapshot().privacy, privacy);
  assert.equal(PRESENCE_PRIVACY.contentBlind, true);

  // 复制出来的隐私对象改不动模块内部常量。
  privacy.neverStores.push('something');
  privacy.inputs.push('keystrokes');
  assert.equal(presence.privacy.neverStores.includes('something'), false);
  assert.deepEqual(presence.privacy.inputs, ['timestamp', 'boolean flag']);

  // 存档里的多余字段也不会被搬进状态。
  const restored = new PresenceMonitor();
  restored.restore({
    kind: 'presence-snapshot',
    version: 1,
    state: PRESENCE_PRESENT,
    lastActivityAt: new Date(T0).toISOString(),
    text: 'PRIVATE-MESSAGE-BODY',
    windowTitle: 'PRIVATE-WINDOW-TITLE',
  });
  const after = JSON.stringify(restored.snapshot());
  assert.equal(after.includes('PRIVATE-MESSAGE-BODY'), false);
  assert.equal(after.includes('PRIVATE-WINDOW-TITLE'), false);
});

test('module stays dependency-free, offline and timer-free', () => {
  const source = fs.readFileSync(new URL('../src/presence.js', import.meta.url), 'utf8');
  const forbidden = [
    /^\s*import\s/m,
    /\brequire\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /['"]node:(fs|child_process|net|http|https|os|worker_threads)['"]/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /\bprocess\.\w/,
    /\bMath\.random\b/,
    /\bnew Date\(\)/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in presence.js: ' + pattern);
  }
  // 缺省时钟虽用 Date.now，但只在宿主没注入时读取一次，且不预缓存。
  assert.equal(/const DEFAULT_CLOCK = \(\) => Date\.now\(\);/.test(source), true);
  // 模块里没有网络 / 文件 / 子进程的痕迹。
  assert.equal(source.includes('WebSocket'), false);
  assert.equal(source.includes('readFile'), false);
  assert.equal(source.includes('exec'), false);
});

// ── 配置 / 常量 ───────────────────────────────────────────────

test('safe defaults and threshold normalisation', () => {
  const defaults = new PresenceMonitor();
  assert.equal(defaults.idleMs, 5 * 60_000);
  assert.equal(defaults.awayMs, 30 * 60_000);
  assert.equal(defaults.state, PRESENCE_UNKNOWN);
  assert.equal(defaults.lastActivityAt, null);
  assert.equal(defaults.stateSinceAt, null);
  assert.equal(defaults.lastHeartbeatAt, null);
  assert.equal(defaults.hostAlive, null);
  assert.deepEqual(defaults.options, {
    idleMs: 5 * 60_000,
    awayMs: 30 * 60_000,
    maxEvents: 64,
    maxHistory: 32,
  });
  assert.deepEqual(DEFAULT_PRESENCE_OPTIONS, defaults.options);
  assert.equal(Object.isFrozen(DEFAULT_PRESENCE_OPTIONS), true);

  const silly = new PresenceMonitor({ idleMs: 0, awayMs: -1, maxEvents: 0, maxHistory: -3 });
  assert.equal(silly.idleMs, 5 * 60_000);
  assert.equal(silly.awayMs, 30 * 60_000);
  assert.equal(silly.options.maxEvents, 64);
  assert.equal(silly.options.maxHistory, 32);

  // away 阈值不能短于 idle 阈值。
  const flipped = new PresenceMonitor({ idleMs: 600_000, awayMs: 1_000 });
  assert.equal(flipped.idleMs, 600_000);
  assert.equal(flipped.awayMs, 600_000);

  // 非数字配置回落默认，不炸；小数被截断；上限不能为 0。
  const garbage = new PresenceMonitor({ idleMs: 'x', awayMs: null, maxEvents: {}, clock: 'now' });
  assert.equal(garbage.idleMs, 5 * 60_000);
  assert.equal(garbage.awayMs, 30 * 60_000);
  assert.equal(new PresenceMonitor({ idleMs: 1.9 }).idleMs, 1);
  assert.equal(new PresenceMonitor({ maxEvents: 1.7 }).options.maxEvents, 1);
  assert.equal(new PresenceMonitor(null).idleMs, 5 * 60_000);
  assert.equal(new PresenceMonitor('x').awayMs, 30 * 60_000);
  assert.equal(new PresenceMonitor([]).options.maxHistory, 32);

  // 工厂函数与默认导出等价。
  const made = createPresenceMonitor({ idleMs: 1_000, awayMs: 2_000 });
  assert.equal(made instanceof PresenceMonitor, true);
  assert.equal(made.awayMs, 2_000);
  assert.deepEqual(PRESENCE_STATES, [PRESENCE_UNKNOWN, PRESENCE_PRESENT, PRESENCE_IDLE, PRESENCE_AWAY]);
  assert.deepEqual(
    [...PRESENCE_EVENT_TYPE_LIST],
    ['presence.entered', 'presence.idle', 'presence.returned', 'presence.away'],
  );
});

// ── 确定性 / 重置 / 隔离 / 序列化 ─────────────────────────────

test('state is fully deterministic for the same timestamp sequence', () => {
  const script = [
    (p) => p.observeActivity(T0),
    (p) => p.tick(T0 + IDLE_MS),
    (p) => p.observeHeartbeat(T0 + IDLE_MS + 1),
    (p) => p.observeActivity(T0 + IDLE_MS + 2),
    (p) => p.tick(T0 + AWAY_MS * 2),
    (p) => p.observeActivity(T0 + AWAY_MS * 2 + 3),
  ];
  const a = monitor();
  const b = monitor({ clock: () => T0 + 999_999 });
  const traceA = script.map((step) => step(a));
  const traceB = script.map((step) => step(b));
  assert.deepEqual(traceA, traceB);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('reset clears state and counters but keeps configuration', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  presence.tick(T0 + AWAY_MS);
  assert.equal(presence.stats.sequence, 2);

  assert.equal(presence.reset(), presence);
  assert.equal(presence.state, PRESENCE_UNKNOWN);
  assert.equal(presence.lastActivityAt, null);
  assert.equal(presence.stateSinceAt, null);
  assert.equal(presence.hostAlive, null);
  assert.deepEqual(presence.consumeEvents(), []);
  assert.deepEqual(presence.stats, {
    sequence: 0,
    pendingEvents: 0,
    droppedEvents: 0,
    droppedHistory: 0,
    clockSkewCount: 0,
    maxClockSkewMs: 0,
    rejectedObservations: 0,
  });
  assert.equal(presence.idleMs, IDLE_MS);
  assert.equal(presence.awayMs, AWAY_MS);

  // reset 之后第一条活动仍然是 entered。
  const again = presence.observeActivity(T0 + 1);
  assert.deepEqual(types(again.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(again.events[0].sequence, 1);
});

test('instances are independent and module-level constants are frozen', () => {
  const a = monitor();
  const b = monitor();
  a.observeActivity(T0);
  assert.equal(a.state, PRESENCE_PRESENT);
  assert.equal(b.state, PRESENCE_UNKNOWN);
  assert.deepEqual(b.consumeEvents(), []);
  b.tick(T0 + AWAY_MS);
  assert.equal(a.state, PRESENCE_PRESENT);

  assert.equal(Object.isFrozen(PRESENCE_PRIVACY), true);
  assert.equal(Object.isFrozen(PRESENCE_PRIVACY.neverStores), true);
  assert.equal(Object.isFrozen(PRESENCE_PRIVACY.stores), true);
  assert.equal(Object.isFrozen(PRESENCE_EVENT_TYPES), true);
  assert.equal(Object.isFrozen(PRESENCE_STATES), true);
  assert.equal(Object.isFrozen(PRESENCE_EVENT_TYPE_LIST), true);
});

test('snapshot is plain JSON data with no functions or hidden references', () => {
  const presence = monitor();
  presence.observeActivity(T0);
  presence.tick(T0 + IDLE_MS);
  const snapshot = presence.snapshot();

  const roundTripped = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(roundTripped, snapshot);
  for (const value of Object.values(snapshot)) {
    const kind = typeof value;
    assert.equal(['object', 'string', 'number', 'boolean'].includes(kind), true);
  }
  assert.equal(snapshot.kind, 'presence-snapshot');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state, PRESENCE_IDLE);
  assert.equal(snapshot.config.idleMs, IDLE_MS);
  assert.equal(snapshot.counters.sequence, 2);
  assert.equal(snapshot.lastSeenAt, new Date(T0 + IDLE_MS).toISOString());

  // 事件副本与内部队列解耦：改 peek / history / snapshot 的返回值都不影响内部。
  const events = presence.peekEvents();
  events[0].type = 'presence.tampered';
  assert.equal(types(presence.peekEvents())[0], PRESENCE_EVENT_TYPES.ENTERED);
  const history = presence.history;
  history[0].state = 'tampered';
  assert.equal(presence.history[0].state, PRESENCE_PRESENT);
  const copy = presence.snapshot();
  copy.events[0].type = 'presence.tampered';
  copy.history[0].reason = 'tampered';
  assert.equal(types(presence.peekEvents())[0], PRESENCE_EVENT_TYPES.ENTERED);
  assert.equal(presence.history[0].reason, 'activity');

  // includeEvents: false 只存状态；缺省 / 垃圾参数都保留事件。
  assert.deepEqual(presence.snapshot({ includeEvents: false }).events, []);
  assert.equal(presence.snapshot({ includeEvents: true }).events.length, 2);
  assert.equal(presence.snapshot({ includeEvents: null }).events.length, 2);
  assert.equal(presence.snapshot('junk').events.length, 2);
  assert.equal(presence.toJSON().events.length, 2);
  assert.deepEqual(presence.toJSON(), presence.snapshot());
  assert.equal(JSON.parse(JSON.stringify(presence.toJSON())).state, PRESENCE_IDLE);

  // toJSON 让 JSON.stringify 直接可用。
  assert.equal(JSON.parse(JSON.stringify(presence)).version, 1);
});
