/**
 * presence/session · 会话接缝的离线测试
 * ─────────────────────────────────────────────────────────────
 * 本仓 fork 里没有 presence-runtime.js / presence-interaction.js，因此这里
 * 按 session 实际调用的接口（observeActivity / observeWindowFocus /
 * observeHeartbeat / tick / consumeEvents|peekEvents / restore / state /
 * options，以及 policy.evaluate）实现 fake，不假装它们是真实模块。
 *
 * 真实的依赖只有已合入的 PresenceStateStore（临时目录 + 注入时钟）。
 * 覆盖：状态/会话锚点/累计在场、欢迎冷却（本进程与跨重启）、重启不补欢迎、
 * 停机不计时、台账写前日志/去重/限量、损坏/过期/不可用快照 fail-closed、
 * 无 store 退化、内容盲、源码守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PresenceStateStore } from '../src/presence/persistence.js';
import { PRESENCE_SESSION_VERSION, createPresenceSession } from '../src/presence/session.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const MINUTE = 60 * 1000;
const AWAY_MS = 600_000;
const COOLDOWN_MS = 90 * MINUTE;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'presence-session-'));
}

function withDir(run) {
  const dir = tempDir();
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** fake runtime：只实现 session 真正会调用到的那几个入口。 */
class FakeRuntime {
  constructor({ state = 'unknown', options = {}, clock = () => Date.now(), restoreResult = { accepted: true } } = {}) {
    this.state = state;
    this.options = options;
    this.clock = clock;
    this.events = [];
    this.signals = [];
    this.ticks = [];
    this.restoreCalls = [];
    this.restoreResult = restoreResult;
    this.throwOn = { observeActivity: false, consumeEvents: false, restore: false };
  }

  observeActivity(payload = {}) {
    if (this.throwOn.observeActivity) {
      this.throwOn.observeActivity = false;
      throw new Error('runtime observeActivity failed');
    }
    this.signals.push({ kind: 'activity', ...payload });
    if (payload.active !== false) this.state = 'present';
  }

  observeWindowFocus(payload = {}) {
    this.signals.push({ kind: 'focus', ...payload });
    if (payload.focused !== false) this.state = 'present';
  }

  observeHeartbeat(payload = {}) {
    this.signals.push({ kind: 'heartbeat', ...payload });
    if (payload.alive !== false && this.state === 'unknown') this.state = 'present';
  }

  tick(payload) {
    this.ticks.push(payload);
  }

  consumeEvents() {
    if (this.throwOn.consumeEvents) {
      this.throwOn.consumeEvents = false;
      throw new Error('runtime consumeEvents failed');
    }
    const events = this.events;
    this.events = [];
    return events;
  }

  peekEvents() {
    return this.events.slice();
  }

  restore(snapshot, options) {
    this.restoreCalls.push({ snapshot, options });
    if (this.throwOn.restore) throw new Error('runtime restore failed');
    if (this.restoreResult?.accepted !== false) this.state = snapshot.state;
    return this.restoreResult;
  }
}

class PeekOnlyRuntime extends FakeRuntime {
  consumeEvents = undefined;
}

class NoEventRuntime extends FakeRuntime {
  consumeEvents = undefined;
  peekEvents = undefined;
}

class NonArrayRuntime extends FakeRuntime {
  consumeEvents() {
    return 'not-an-array';
  }
}

class NonArrayPeekRuntime extends FakeRuntime {
  consumeEvents = undefined;
  peekEvents() {
    return 'not-an-array';
  }
}

class NoRestoreRuntime extends FakeRuntime {
  restore = undefined;
}

/** fake policy：按 session 的 evaluate({ state, events, at }) 契约返回排队的 intent。 */
class FakePolicy {
  constructor({ intents = [], options = {}, throwOnEvaluate = false } = {}) {
    this.queue = [...intents];
    this.options = options;
    this.throwOnEvaluate = throwOnEvaluate;
    this.calls = [];
  }

  evaluate(context) {
    this.calls.push(context);
    if (this.throwOnEvaluate) throw new Error('policy evaluate failed');
    return this.queue.length > 0 ? this.queue.shift() : [];
  }

  push(intent) {
    this.queue.push(intent);
  }
}

/**
 * 一套真实 store + fake runtime/policy。
 * session 的冷却闸门显式设成 90 分钟；policy 自己的 cooldown 默认 1s，
 * 这样「持久化冷却闸门」才是被单独验证的那一层。
 */
function makeEnv({
  dir = null,
  at = T0,
  runtimeOptions = {},
  policyOptions = { cooldownMs: 1_000 },
  policyIntents = [],
  sessionOptions = {},
  runtime = null,
  policy = null,
  sessionNow = null,
  storeNow = null,
  storeFile = null,
} = {}) {
  const clock = { value: at };
  const store = dir
    ? new PresenceStateStore({
      file: storeFile ?? path.join(dir, 'presence-web-state.json'),
      now: storeNow ?? (() => clock.value),
    })
    : null;
  const fakeRuntime = runtime ?? new FakeRuntime({ options: runtimeOptions, clock: () => clock.value });
  const fakePolicy = policy ?? new FakePolicy({ intents: policyIntents, options: policyOptions });
  const session = createPresenceSession({
    runtime: fakeRuntime,
    policy: fakePolicy,
    store,
    now: sessionNow ?? (() => clock.value),
    cooldownMs: COOLDOWN_MS,
    ...sessionOptions,
  });
  return { clock, store, runtime: fakeRuntime, policy: fakePolicy, session };
}

function observe(env, at, signal = { kind: 'activity' }) {
  env.clock.value = at;
  return env.session.observe({ ...signal, at });
}

function settle(env, at) {
  env.clock.value = at;
  return env.session.settle({ at });
}

/** entered → away → returned；policy 在返回这一拍才拿到 welcome intent。 */
function awayAndReturn(env, baseAt, intent = null) {
  observe(env, baseAt);
  env.runtime.state = 'away';
  settle(env, baseAt + AWAY_MS);
  env.runtime.state = 'present';
  if (intent) env.policy.push(intent);
  return observe(env, baseAt + AWAY_MS + 1_000);
}

function welcomeIntent(id, text = 'welcome copy') {
  return { id, kind: 'welcome-back', text };
}

test('observe() drives the runtime, tracks the session and persists a whitelisted snapshot', () => {
  withDir((dir) => {
    const env = makeEnv({ dir });
    const first = observe(env, T0);
    assert.equal(first.ok, true);
    assert.equal(first.state, 'present');
    assert.deepEqual(first.events, []);
    assert.deepEqual(first.intents, []);
    assert.equal(first.persisted, true);
    assert.equal(env.session.state, 'present');
    assert.equal(env.session.sessionStartedAt, T0);
    assert.equal(env.session.activeMs, 0);
    assert.equal(env.session.restored, false);
    assert.equal(env.session.hasStore, true);
    assert.equal(env.session.cooldownMs, COOLDOWN_MS);
    assert.deepEqual(env.runtime.signals[0], { kind: 'activity', at: T0, active: true });
    assert.equal(env.session.stats.observed, 1);
    assert.equal(env.session.stats.settled, 0);

    const second = settle(env, T0 + 30_000);
    assert.equal(second.state, 'present');
    assert.equal(env.session.activeMs, 30_000, 'consecutive present ticks accumulate');

    const snapshot = env.session.snapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'activeMs', 'cooldowns', 'deliveredIds', 'sessionStartedAt', 'state', 'updatedAt', 'version',
    ]);
    assert.equal(snapshot.version, PRESENCE_SESSION_VERSION);
    assert.equal(snapshot.state, 'present');
    assert.equal(snapshot.sessionStartedAt, T0);
    assert.equal(snapshot.activeMs, 30_000);

    const stored = env.store.load();
    assert.equal(stored.ok, true);
    assert.equal(stored.state.state, 'present');
    assert.equal(stored.state.activeMs, 30_000);
    assert.equal(stored.state.updatedAt, T0 + 30_000);

    // away：会话锚点清空、累计清零。
    env.runtime.state = 'away';
    settle(env, T0 + 30_000 + AWAY_MS);
    assert.equal(env.session.state, 'away');
    assert.equal(env.session.sessionStartedAt, null);
    assert.equal(env.session.activeMs, 0);
  });
});

test('focus and heartbeat signals are routed, inactive ones never claim presence', () => {
  withDir((dir) => {
    const env = makeEnv({ dir });
    const focus = observe(env, T0, { kind: 'focus' });
    assert.equal(focus.state, 'present');
    assert.deepEqual(env.runtime.signals.at(-1), { kind: 'focus', at: T0, focused: true });

    env.runtime.state = 'away';
    const heartbeat = observe(env, T0 + 1_000, { kind: 'heartbeat', alive: false });
    assert.equal(heartbeat.state, 'away');
    assert.deepEqual(env.runtime.signals.at(-1), { kind: 'heartbeat', at: T0 + 1_000, alive: false });

    env.runtime.state = 'unknown';
    const inactive = observe(env, T0 + 2_000, { kind: 'activity', active: false });
    assert.equal(inactive.state, 'unknown');
    assert.equal(env.session.sessionStartedAt, null);

    const alive = observe(env, T0 + 3_000, { kind: 'heartbeat' });
    assert.equal(alive.state, 'present');
    assert.equal(env.session.sessionStartedAt, T0 + 3_000);

    // runtime 没有给出字符串状态时，对外一律是 unknown，不猜。
    const bare = new FakeRuntime({ state: undefined });
    const session = createPresenceSession({ runtime: bare });
    assert.equal(session.state, 'unknown');
  });
});

test('invalid signals and times are rejected without touching state', () => {
  const env = makeEnv();
  assert.equal(env.session.observe(null).reason, 'invalid-signal');
  assert.equal(env.session.observe([]).reason, 'invalid-signal');
  assert.equal(env.session.observe({}).reason, 'invalid-signal');
  assert.equal(env.session.observe({ kind: 'telepathy', at: T0 }).reason, 'invalid-signal');
  assert.equal(env.session.observe({ kind: 'activity', at: 'not-a-time' }).reason, 'invalid-at');
  assert.equal(env.session.observe({ kind: 'activity', at: '' }).reason, 'invalid-at');
  assert.equal(env.session.observe({ kind: 'activity', at: 'x'.repeat(65) }).reason, 'invalid-at');
  assert.equal(env.session.observe({ kind: 'activity', at: Number.POSITIVE_INFINITY }).reason, 'invalid-at');
  assert.equal(env.session.observe({ kind: 'activity', at: {} }).reason, 'invalid-at');
  assert.equal(env.session.settle({ at: {} }).reason, 'invalid-at');
  assert.equal(env.session.settle({ at: 'nope' }).reason, 'invalid-at');
  assert.equal(env.session.state, 'unknown');
  assert.equal(env.session.stats.rejected, 11);
  assert.equal(env.session.restore().ok, false);
  assert.equal(env.session.settle({ at: T0 }).ok, true, 'rejections do not poison later calls');

  // 合法时间形态：Date 与 ISO 字符串都归一成毫秒。
  const dated = observe(env, T0, { kind: 'activity', at: new Date(T0) });
  assert.equal(dated.ok, true);
  const stringAt = env.session.observe({ kind: 'activity', at: new Date(T0 + 1_000).toISOString() });
  assert.equal(stringAt.ok, true);
  assert.equal(env.session.activeMs, 1_000);
});

test('the session anchor survives idle but resets across away, and a return starts a new one', () => {
  withDir((dir) => {
    const env = makeEnv({ dir });
    observe(env, T0);
    env.runtime.state = 'idle';
    settle(env, T0 + 1_000);
    assert.equal(env.session.sessionStartedAt, T0, 'idle is not away');
    assert.equal(env.session.activeMs, 0, 'idle ticks never accumulate');

    env.runtime.state = 'present';
    settle(env, T0 + 2_000);
    assert.equal(env.session.sessionStartedAt, T0, 'idle → present keeps the same anchor');

    env.runtime.state = 'away';
    settle(env, T0 + 3_000);
    assert.equal(env.session.sessionStartedAt, null);

    env.runtime.state = 'present';
    settle(env, T0 + 4_000);
    assert.equal(env.session.sessionStartedAt, T0 + 4_000, 'away → present starts a new anchor');

    // runtime 一开始就是 present（会话锚点尚不存在）也要落到当前拍。
    const started = makeEnv({ dir: tempDir(), runtime: new FakeRuntime({ state: 'present' }) });
    observe(started, T0);
    assert.equal(started.session.sessionStartedAt, T0);
  });
});

test('welcome-back is emitted once, then suppressed by the session cooldown gate', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, policyOptions: { cooldownMs: 1_000 } });
    const first = awayAndReturn(env, T0, welcomeIntent('welcome-1'));
    assert.deepEqual(first.intents.map((intent) => intent.kind), ['welcome-back']);
    assert.equal(first.intents[0].text, 'welcome copy');
    assert.equal(env.session.stats.emittedIntents, 1);
    assert.equal(env.session.cooldowns.welcome, T0 + AWAY_MS + 1_000);

    const second = awayAndReturn(env, T0 + AWAY_MS + 1_000, welcomeIntent('welcome-2'));
    assert.deepEqual(second.intents, [], 'cooldown keeps a second welcome quiet');
    assert.equal(env.session.stats.emittedIntents, 1);
    assert.ok(env.session.stats.suppressedIntents >= 1);
    // policy 自己认为可以说话（它的 cooldown 只有 1s），是 session 的持久化闸门扣下来的。
    assert.ok(env.session.stats.rawIntents >= 2);
  });
});

test('the gate cooldown falls back to policy options, honours overrides and 0 disables it', () => {
  const policyGate = makeEnv({ sessionOptions: { cooldownMs: undefined }, policyOptions: { cooldownMs: 5_000 } });
  assert.equal(policyGate.session.cooldownMs, 5_000);
  observe(policyGate, T0);
  policyGate.policy.push(welcomeIntent('welcome-1'));
  assert.deepEqual(settle(policyGate, T0 + 1_000).intents.map((intent) => intent.kind), ['welcome-back']);
  policyGate.policy.push(welcomeIntent('welcome-2'));
  assert.deepEqual(settle(policyGate, T0 + 3_000).intents, [], 'inside the policy-derived window');
  policyGate.policy.push(welcomeIntent('welcome-3'));
  assert.deepEqual(
    settle(policyGate, T0 + 6_000).intents.map((intent) => intent.kind),
    ['welcome-back'],
    'exactly at the boundary is allowed',
  );

  const overridden = makeEnv({ dir: tempDir(), sessionOptions: { cooldownMs: 1_000 }, policyOptions: { cooldownMs: 5_000 } });
  assert.equal(overridden.session.cooldownMs, 1_000);
  observe(overridden, T0);
  overridden.policy.push(welcomeIntent('welcome-1'));
  assert.deepEqual(settle(overridden, T0 + 1_000).intents.length, 1);
  overridden.policy.push(welcomeIntent('welcome-2'));
  assert.deepEqual(settle(overridden, T0 + 1_500).intents, [], 'the explicit 1s window wins over the policy 5s');
  overridden.policy.push(welcomeIntent('welcome-3'));
  assert.deepEqual(settle(overridden, T0 + 2_000).intents.length, 1);

  const disabled = makeEnv({ dir: tempDir(), sessionOptions: { cooldownMs: 0 } });
  assert.equal(disabled.session.cooldownMs, 0);
  observe(disabled, T0);
  disabled.policy.push(welcomeIntent('welcome-1'));
  assert.deepEqual(settle(disabled, T0 + 1_000).intents.length, 1);
  disabled.policy.push(welcomeIntent('welcome-2'));
  assert.deepEqual(settle(disabled, T0 + 1_500).intents.map((intent) => intent.kind), ['welcome-back'], 'cooldown 0 disables the gate');

  const invalid = makeEnv({ dir: tempDir(), sessionOptions: { cooldownMs: 'not-a-number' }, policyOptions: {} });
  assert.equal(invalid.session.cooldownMs, COOLDOWN_MS, 'invalid cooldown falls back to the default');
  const noOptions = makeEnv({ dir: tempDir(), sessionOptions: { cooldownMs: undefined }, policyOptions: null });
  assert.equal(noOptions.session.cooldownMs, COOLDOWN_MS);
});

test('intent ids are deduplicated, settled ids are not re-emitted, and the seen window is bounded', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, sessionOptions: { maxSeenIntents: 2 } });
    observe(env, T0);
    const emit = (id, at) => {
      env.policy.push({ id, kind: 'proactive', text: 'nudge' });
      return settle(env, at);
    };
    assert.deepEqual(emit('a', T0 + 1_000).intents.map((intent) => intent.id), ['a']);
    assert.deepEqual(emit('b', T0 + 2_000).intents.map((intent) => intent.id), ['b']);
    assert.deepEqual(emit('c', T0 + 3_000).intents.map((intent) => intent.id), ['c']);
    assert.deepEqual(emit('a', T0 + 4_000).intents.map((intent) => intent.id), ['a'], 'the oldest id was evicted');
    assert.deepEqual(emit('a', T0 + 5_000).intents, [], 'a duplicate inside the window stays quiet');

    // 已结算（含写前日志）的 id 同样不再发。
    env.session.recordDelivery({ id: 'settled', status: 'attempting', at: T0 + 5_000 });
    env.policy.push({ id: 'settled', kind: 'proactive' });
    assert.deepEqual(settle(env, T0 + 6_000).intents, []);

    // 非法 intent 只记账不抛错。
    env.policy.push(null);
    assert.deepEqual(settle(env, T0 + 7_000).intents, []);
    env.policy.push({ kind: 'proactive' });
    assert.deepEqual(settle(env, T0 + 8_000).intents, []);
    env.policy.push({ id: 'single-object', kind: 'proactive' });
    const mixed = settle(env, T0 + 9_000);
    assert.deepEqual(mixed.intents.map((intent) => intent.id), ['single-object'], 'a single object is normalized, junk is dropped');
    assert.ok(env.session.stats.suppressedIntents >= 2);

    // policy 抛错隔离。
    env.policy.throwOnEvaluate = true;
    const failed = settle(env, T0 + 10_000);
    assert.deepEqual(failed.intents, []);
    assert.ok(env.session.stats.rejected >= 1);
    env.policy.throwOnEvaluate = false;
  });
});

test('gateIntent records the cooldown timestamp and tolerates a missing at', () => {
  withDir((dir) => {
    const env = makeEnv({ dir });
    env.policy.push(welcomeIntent('welcome-1'));
    const noAt = env.session.observe({ kind: 'activity' });
    assert.equal(noAt.ok, true);
    assert.equal(noAt.intents[0].at, null);
    assert.equal(env.session.cooldowns.welcome, null, 'a missing timestamp cannot open a cooldown');

    env.policy.push(welcomeIntent('welcome-2'));
    const atT0 = observe(env, T0);
    assert.deepEqual(atT0.intents.map((intent) => intent.id), ['welcome-2']);
    assert.equal(env.session.cooldowns.welcome, T0);
    assert.deepEqual(env.session.cooldowns, { welcome: T0, break: null, proactive: null });

    // 冷却表是拷贝，外部改不到内部。
    env.session.cooldowns.welcome = 0;
    assert.equal(env.session.cooldowns.welcome, T0);
  });
});

test('restart restores cooldowns, anchors and the ledger without replaying anything', () => {
  withDir((dir) => {
    const first = makeEnv({ dir });
    observe(first, T0);
    settle(first, T0 + 30_000);
    const welcome = awayAndReturn(first, T0 + 30_000, welcomeIntent('welcome-1'));
    assert.equal(welcome.intents.length, 1);
    const welcomeAt = first.session.cooldowns.welcome;
    const sessionAt = first.session.sessionStartedAt;
    const activeMs = first.session.activeMs;
    first.session.recordDelivery({ id: 'welcome-1', status: 'sent', at: welcomeAt });
    first.session.markProactive(T0 + 29_000);
    assert.equal(first.session.close().ok, true);

    const closedAt = welcomeAt;
    const second = makeEnv({ dir, at: closedAt });
    second.runtime.events.push({ type: 'presence.entered' });
    const restored = second.session.restore();
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, true);
    assert.deepEqual(restored.diagnostics, []);
    assert.equal(second.session.restored, true);
    assert.equal(second.session.state, 'present');
    assert.equal(second.session.cooldowns.welcome, welcomeAt);
    assert.equal(second.session.cooldowns.proactive, T0 + 29_000);
    assert.equal(second.session.sessionStartedAt, sessionAt);
    assert.equal(second.session.activeMs, activeMs);
    assert.equal(second.session.deliveredOn(welcomeAt), 1);
    assert.equal(second.session.stats.emittedIntents, 0);
    assert.equal(second.policy.calls.length, 0, 'restore never evaluates policy');
    assert.equal(second.runtime.events.length, 1, 'restore never consumes queued events');
    assert.equal(second.runtime.restoreCalls.length, 1);
    const { snapshot, options } = second.runtime.restoreCalls[0];
    assert.equal(snapshot.kind, 'presence-snapshot');
    assert.equal(snapshot.state, 'present');
    assert.equal(snapshot.stateSinceAt, new Date(closedAt).toISOString());
    assert.deepEqual(snapshot.config, { idleMs: 0, awayMs: 0 });
    assert.deepEqual(options, { adoptConfig: false, replayEvents: false });

    // 重启后立刻 away → returned：policy 想欢迎，但持久化冷却把它扣住。
    second.runtime.state = 'away';
    settle(second, closedAt + AWAY_MS);
    second.runtime.state = 'present';
    second.policy.push(welcomeIntent('welcome-2'));
    const returned = observe(second, closedAt + AWAY_MS + 1_000);
    assert.deepEqual(returned.intents, []);
    assert.ok(second.session.stats.rawIntents >= 1, 'policy still wanted to speak');
    assert.ok(second.session.stats.suppressedIntents >= 1);
  });
});

test('restart never counts downtime as active presence', () => {
  withDir((dir) => {
    const first = makeEnv({ dir });
    observe(first, T0);
    settle(first, T0 + 30_000);
    assert.equal(first.session.activeMs, 30_000);
    assert.equal(first.session.sessionStartedAt, T0);
    assert.equal(first.session.close().ok, true);

    const downtime = 2 * 60 * 60 * 1000;
    const resumedAt = T0 + 30_000 + downtime;
    const second = makeEnv({ dir, at: resumedAt });
    const restored = second.session.restore();
    assert.equal(restored.ok, true);
    assert.equal(second.session.activeMs, 30_000, 'the archive keeps the real accumulated time');
    assert.equal(second.session.sessionStartedAt, T0);

    const firstAfterRestart = observe(second, resumedAt);
    assert.deepEqual(firstAfterRestart.intents, []);
    assert.equal(second.session.activeMs, 30_000, 'downtime is not added to active presence');
    assert.equal(second.session.sessionStartedAt, T0, 'the real session anchor is preserved');
    assert.ok(second.session.stats.restoredDowntimeSkips >= 1);

    // 只有重启后真实累计的在场时间才继续增长。
    const after10 = settle(second, resumedAt + 10_000);
    assert.deepEqual(after10.intents, []);
    assert.equal(second.session.activeMs, 40_000);
    const after21 = settle(second, resumedAt + 21_000);
    assert.equal(second.session.activeMs, 51_000);
  });
});

test('restore() fails closed on unavailable snapshots and keeps working in memory', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');

    // 损坏 JSON。
    fs.writeFileSync(file, '{"state":"present", broken', 'utf8');
    const corrupt = makeEnv({ dir });
    const corruptResult = corrupt.session.restore();
    assert.equal(corruptResult.ok, false);
    assert.equal(corruptResult.restored, false);
    assert.equal(corruptResult.diagnostics[0].code, 'corrupt');
    assert.equal(corrupt.session.state, 'unknown');
    assert.equal(observe(corrupt, T0).state, 'present', 'a corrupt archive never blocks a fresh session');

    // 文件不存在。
    fs.rmSync(file, { force: true });
    const absent = makeEnv({ dir });
    const absentResult = absent.session.restore();
    assert.equal(absentResult.ok, false);
    assert.equal(absentResult.diagnostics[0].code, 'absent');

    // 目标路径是目录。
    const notAFile = path.join(dir, 'state-dir');
    fs.mkdirSync(notAFile);
    const directory = makeEnv({ dir, storeFile: notAFile });
    const directoryResult = directory.session.restore();
    assert.equal(directoryResult.ok, false);
    assert.equal(directoryResult.diagnostics[0].code, 'not-a-file');

    // 过期（TTL 7 天）。
    const seeded = makeEnv({ dir });
    observe(seeded, T0);
    assert.equal(seeded.session.close().ok, true);
    const stale = makeEnv({ dir, at: T0 + 8 * 24 * 60 * MINUTE });
    const staleResult = stale.session.restore();
    assert.equal(staleResult.ok, false);
    assert.equal(staleResult.diagnostics[0].code, 'expired');
    assert.equal(stale.session.state, 'unknown');
  });
});

test('restore() reports runtime hand-back failures without corrupting the session', () => {
  withDir((dir) => {
    const seed = makeEnv({ dir });
    observe(seed, T0);
    assert.equal(seed.session.close().ok, true);

    const rejected = makeEnv({ dir, at: T0, runtime: new FakeRuntime({ restoreResult: { accepted: false } }) });
    const rejectedResult = rejected.session.restore();
    assert.equal(rejectedResult.ok, true);
    assert.equal(rejectedResult.restored, true);
    assert.equal(rejectedResult.diagnostics[0].code, 'runtime-restore-rejected');

    const throwing = makeEnv({ dir, at: T0, runtime: new FakeRuntime() });
    throwing.runtime.throwOn.restore = true;
    const throwingResult = throwing.session.restore();
    assert.equal(throwingResult.ok, true);
    assert.equal(throwingResult.diagnostics[0].code, 'runtime-restore-error');

    const bare = makeEnv({ dir, at: T0, runtime: new NoRestoreRuntime() });
    const bareResult = bare.session.restore();
    assert.equal(bareResult.ok, true);
    assert.equal(bareResult.diagnostics[0].code, 'no-runtime-restore');

    // runtime.options 不是对象时，快照配置退化为 0。
    const nullOptions = makeEnv({ dir, at: T0, runtime: new FakeRuntime({ options: null }) });
    assert.equal(nullOptions.session.restore().ok, true);
    assert.deepEqual(nullOptions.runtime.restoreCalls[0].snapshot.config, { idleMs: 0, awayMs: 0 });

    // 存档里的 unknown 不会被当成在场状态恢复。
    const unknownDir = tempDir();
    const unknownStore = new PresenceStateStore({ file: path.join(unknownDir, 'presence-web-state.json'), now: () => T0 });
    unknownStore.save({ version: 1, state: 'unknown', updatedAt: T0, sessionStartedAt: null, activeMs: 0, cooldowns: {}, deliveredIds: [] });
    const unknown = makeEnv({ dir: unknownDir, at: T0 });
    const unknownResult = unknown.session.restore();
    assert.equal(unknownResult.ok, true);
    assert.equal(unknown.session.state, 'unknown');
    assert.deepEqual(unknownResult.diagnostics, []);
    assert.equal(unknown.runtime.restoreCalls.length, 0, 'unknown is never handed to the runtime');
  });
});

test('delivery ledger: write-ahead, dedupe, quota, replacement and restart', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, sessionOptions: { maxLedgerEntries: 10 } });
    observe(env, T0);

    const firstRecord = env.session.recordDelivery({ id: 'welcome-1', status: 'sent', at: T0 });
    assert.equal(firstRecord.ok, true);
    assert.equal(firstRecord.duplicate, false);
    assert.equal(firstRecord.persisted, true, 'a settlement is only ok to rely on when it is on disk');
    assert.equal(env.session.recordDelivery({ id: 'welcome-1', status: 'sent', at: T0 }).duplicate, true);

    // 写前日志：attempting 不算送达，但足以让重启后不再盲发。
    const writeAhead = env.session.recordDelivery({ id: 'p1', status: 'attempting', at: T0 });
    assert.equal(writeAhead.ok, true);
    assert.equal(env.session.hasSettled('p1'), true);
    assert.equal(env.session.deliveredOn(T0), 1, 'attempting is not counted as delivered/quota');

    env.session.recordDelivery({ id: 'break-1', status: 'failed', at: T0 });
    env.session.recordDelivery({ id: 'break-2', status: 'unknown', at: T0 });
    assert.equal(env.session.deliveredOn(T0), 1, 'only sent/accepted count toward the quota');
    assert.equal(env.session.hasSettled('break-1'), true);
    assert.equal(env.session.hasSettled('nope'), false);
    assert.equal(env.session.hasSettled(null), false);
    assert.equal(env.session.hasSettled(''), false);
    assert.equal(env.session.recordDelivery({ id: 'has|pipe', status: 'sent', at: T0 }).reason, 'invalid-entry');
    assert.equal(env.session.recordDelivery({ id: 'x', at: {} }).reason, 'clock-unavailable');
    assert.equal(env.session.deliveredOn('nope'), 0);

    // Date 入参同样归一。
    const accepted = env.session.recordDelivery({ id: 'welcome-2', status: 'accepted', at: new Date(T0) });
    assert.equal(accepted.ok, true);
    assert.equal(env.session.deliveredOn(T0), 2, 'sent and accepted both consume quota; failed/unknown do not');

    // 同一 id 只保留一条：attempting → sent 覆盖旧判定。
    const replaced = env.session.recordDelivery({ id: 'p1', status: 'sent', at: T0 });
    assert.equal(replaced.duplicate, false);
    assert.equal(env.session.deliveredOn(T0), 3);
    assert.equal(env.session.deliveredIds.length, 5);

    env.session.markProactive(T0 + 1_000);
    assert.equal(env.session.cooldowns.proactive, T0 + 1_000);
    assert.equal(env.session.markProactive({}).reason, 'clock-unavailable');
    assert.equal(env.session.close().ok, true);

    const restarted = makeEnv({ dir, at: T0 + 2_000 });
    assert.equal(restarted.session.restore().ok, true);
    assert.equal(restarted.session.hasSettled('welcome-2'), true, 'an accepted settlement survives restart');
    assert.equal(restarted.session.deliveredOn(T0), 3, 'the daily quota is remembered across restart');
    assert.equal(restarted.session.cooldowns.proactive, T0 + 1_000);
    assert.equal(restarted.session.deliveredIds.length, 5);
  });
});

test('the ledger stays bounded and evicts the oldest settlement', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, sessionOptions: { maxLedgerEntries: 2 } });
    observe(env, T0);
    env.session.recordDelivery({ id: 'a', status: 'sent', at: T0 });
    env.session.recordDelivery({ id: 'b', status: 'failed', at: T0 });
    env.session.recordDelivery({ id: 'c', status: 'accepted', at: T0 });
    assert.deepEqual(env.session.deliveredIds.map((entry) => entry.split('|')[2]), ['b', 'c']);
    assert.equal(env.session.hasSettled('a'), false);
    assert.equal(env.session.deliveredOn(T0), 1, 'the evicted sent entry no longer counts');

    // 非法上限退回默认值，不抛错。
    const fallback = makeEnv({ dir: tempDir(), sessionOptions: { maxLedgerEntries: 0, maxSeenIntents: -1 } });
    observe(fallback, T0);
    assert.equal(fallback.session.stats.ledgerEntries, 0);
  });
});

test('without a store the session degrades to memory only', () => {
  const env = makeEnv();
  const result = observe(env, T0);
  assert.equal(result.persisted, false);
  assert.equal(env.session.stats.hasStore, false);
  assert.equal(env.session.hasStore, false);
  const recorded = env.session.recordDelivery({ id: 'welcome-1', status: 'sent', at: T0 });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.persisted, false);
  assert.equal(recorded.error, 'no-store');
  assert.equal(env.session.close().ok, false);
  assert.equal(env.session.close().error, 'no-store');
  assert.equal(env.session.snapshot().state, 'present');
  assert.equal(env.session.restore().diagnostics[0].code, 'no-store');
});

test('persistOnChange=false defers writes until close and a clean tick is not a write', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, sessionOptions: { persistOnChange: false } });
    const observed = observe(env, T0);
    assert.equal(observed.persisted, false);
    assert.equal(env.store.load().state, null, 'nothing is written before close');
    assert.equal(env.session.close().persisted, true);
    assert.equal(env.store.load().ok, true);

    const clean = env.session.settle({ at: T0 });
    assert.equal(clean.ok, true);
    assert.equal(clean.persisted, false, 'no change means no write');
  });
});

test('store write failures surface instead of being swallowed', () => {
  withDir((dir) => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const env = makeEnv({ dir, storeFile: path.join(blocker, 'presence-web-state.json') });
    const observed = observe(env, T0);
    assert.equal(observed.ok, true);
    assert.equal(observed.persisted, false);
    assert.equal(env.session.stats.saveFailures, 1);

    const closed = env.session.close();
    assert.equal(closed.ok, false);
    assert.equal(closed.persisted, false);
    assert.equal(typeof closed.error, 'string');
    const recorded = env.session.recordDelivery({ id: 'welcome-1', status: 'sent', at: T0 });
    assert.equal(recorded.persisted, false);
    assert.equal(recorded.error, closed.error);
  });
});

test('a failing or unparseable clock is fail-closed, never guessed', () => {
  withDir((dir) => {
    const env = makeEnv({ dir, sessionNow: () => { throw new Error('clock down'); } });
    const observed = env.session.observe({ kind: 'activity', at: T0 });
    assert.equal(observed.ok, true);
    assert.equal(observed.persisted, false);
    assert.equal(env.session.snapshot().updatedAt, 0);
    assert.equal(env.session.close().ok, false);
    assert.equal(env.session.close().error, 'clock-unavailable');
    assert.equal(env.session.recordDelivery({ id: 'welcome-1' }).reason, 'clock-unavailable');
    assert.equal(env.session.markProactive().reason, 'clock-unavailable');

    const garbage = makeEnv({ dir: tempDir(), sessionNow: () => 'garbage' });
    const result = garbage.session.observe({ kind: 'activity', at: T0 });
    assert.equal(result.persisted, false);
    assert.equal(garbage.session.close().error, 'clock-unavailable');
  });
});

test('snapshot never carries intent text or any content', () => {
  withDir((dir) => {
    const secret = 'SECRET_WELCOME_COPY_SHOULD_NOT_PERSIST';
    const env = makeEnv({ dir });
    const returned = awayAndReturn(env, T0, welcomeIntent('welcome-1', secret));
    assert.equal(returned.intents[0].text, secret, 'the sender still gets the text');
    const snapshot = JSON.stringify(env.session.snapshot());
    assert.equal(snapshot.includes(secret), false);
    assert.equal(snapshot.includes('"kind"'), false);
    assert.equal(snapshot.includes('"text"'), false);
    const file = fs.readFileSync(path.join(dir, 'presence-web-state.json'), 'utf8');
    assert.equal(file.includes(secret), false);
    assert.equal(file.includes('welcome-back'), false);
  });
});

test('runtime failures are isolated and never poison later calls', () => {
  withDir((dir) => {
    const env = makeEnv({ dir });
    env.runtime.throwOn.observeActivity = true;
    const failed = observe(env, T0);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'runtime-error');
    assert.deepEqual(failed.intents, []);
    assert.equal(env.session.state, 'unknown');
    assert.ok(env.session.stats.rejected >= 1);

    env.runtime.throwOn.consumeEvents = true;
    const consumed = observe(env, T0 + 1_000);
    assert.equal(consumed.reason, 'runtime-error');

    assert.equal(observe(env, T0 + 2_000).ok, true, 'the next call works again');
  });
});

test('event consumption prefers consumeEvents and falls back to peekEvents or nothing', () => {
  withDir((dir) => {
    const event = { type: 'presence.entered', at: T0 };

    const peek = makeEnv({ dir, runtime: new PeekOnlyRuntime() });
    peek.runtime.events.push(event);
    observe(peek, T0);
    assert.deepEqual(peek.policy.calls[0].events, [event]);
    assert.equal(peek.runtime.events.length, 1, 'peek never removes the event');

    const none = makeEnv({ dir, runtime: new NoEventRuntime() });
    observe(none, T0);
    assert.deepEqual(none.policy.calls[0].events, []);

    const weird = makeEnv({ dir, runtime: new NonArrayRuntime() });
    observe(weird, T0);
    assert.deepEqual(weird.policy.calls[0].events, []);

    const weirdPeek = makeEnv({ dir, runtime: new NonArrayPeekRuntime() });
    observe(weirdPeek, T0);
    assert.deepEqual(weirdPeek.policy.calls[0].events, []);
  });
});

test('constructor rejects broken wiring and keeps the documented defaults', () => {
  assert.throws(() => createPresenceSession({}), TypeError);
  assert.throws(() => createPresenceSession({ runtime: { state: 'unknown' } }), TypeError);
  assert.throws(() => createPresenceSession({ runtime: { observeActivity() {}, tick() {} }, policy: { evaluate: 1 } }), TypeError);
  assert.throws(() => createPresenceSession({ runtime: { observeActivity() {}, tick() {} }, store: { save() {} } }), TypeError);
  assert.throws(() => createPresenceSession({ runtime: { observeActivity() {}, tick() {} }, store: { load() {} } }), TypeError);

  const defaults = createPresenceSession({ runtime: new FakeRuntime() });
  assert.equal(defaults.cooldownMs, COOLDOWN_MS);
  assert.equal(defaults.restored, false);
  assert.equal(defaults.hasStore, false);
  assert.equal(defaults.stats.hasPolicy, false);
  assert.equal(defaults.stats.persistOnChange, true);
  assert.equal(defaults.snapshot().state, 'unknown');
  assert.deepEqual(defaults.cooldowns, { welcome: null, break: null, proactive: null });
  assert.deepEqual(defaults.deliveredIds, []);
});

test('module is offline, timer-free and imports only the local persistence module', () => {
  const source = fs.readFileSync(new URL('../src/presence/session.js', import.meta.url), 'utf8');
  const importLines = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
  assert.equal(importLines.length, 1);
  assert.equal(/from\s+'\.\/persistence\.js'/.test(importLines[0]), true);
  for (const pattern of [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /['"]node:/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /\bchild_process\b/,
    /from\s+['"][^'"]*qq\.js['"]/,
    /from\s+['"][^'"]*server\.js['"]/,
  ]) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in session.js: ' + pattern);
  }
});
