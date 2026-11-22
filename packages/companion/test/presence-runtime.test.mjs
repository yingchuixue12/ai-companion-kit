/**
 * presence-runtime · 宿主桥的离线测试
 * ─────────────────────────────────────────────────────────────
 * 全部用注入时钟 + 合成时间戳，不联网、不装定时器、不依赖真实文件状态。
 * 覆盖：透传与输入窄化、at-most-once 投递、回调隔离、内容盲、快照/恢复、
 * 去重表上限、无 sink、实例隔离、构造校验与零依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import PresenceRuntime, {
  PRESENCE_AWAY,
  PRESENCE_EVENT_TYPES,
  PRESENCE_IDLE,
  PRESENCE_PRESENT,
  PRESENCE_UNKNOWN,
  PresenceMonitor,
  createPresenceRuntime,
} from '../src/presence-runtime.js';
import * as monitorModule from '../src/presence.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const IDLE_MS = 60_000;
const AWAY_MS = 600_000;

function types(events) {
  return events.map((event) => event.type);
}

function runtime(options = {}) {
  const seen = [];
  const instance = new PresenceRuntime({
    idleMs: IDLE_MS,
    awayMs: AWAY_MS,
    clock: () => T0,
    onEvent: (event) => seen.push(event),
    ...options,
  });
  return { runtime: instance, seen };
}

test('delegates every monitor operation without changing its contract', () => {
  const { runtime: presence, seen } = runtime();

  const first = presence.observeActivity(T0);
  assert.equal(first.accepted, true);
  assert.deepEqual(types(first.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(first.events[0].at, new Date(T0).toISOString());
  assert.equal(presence.state, PRESENCE_PRESENT);
  assert.equal(presence.stateSinceAt, new Date(T0).toISOString());
  assert.equal(presence.lastActivityAt, new Date(T0).toISOString());
  assert.equal(presence.pendingEventCount, 1);
  // 默认不自动投递：宿主自己决定节奏。
  assert.deepEqual(seen, []);

  const idle = presence.tick(T0 + IDLE_MS);
  assert.deepEqual(types(idle.events), [PRESENCE_EVENT_TYPES.IDLE]);
  assert.equal(presence.state, PRESENCE_IDLE);

  const away = presence.observeHeartbeat({ at: T0 + AWAY_MS, alive: false });
  assert.deepEqual(types(away.events), [PRESENCE_EVENT_TYPES.AWAY]);
  assert.equal(presence.state, PRESENCE_AWAY);
  assert.equal(presence.hostAlive, false);
  assert.equal(presence.lastHeartbeatAt, new Date(T0 + AWAY_MS).toISOString());

  const focused = presence.observeWindowFocus({ at: T0 + AWAY_MS + 1, focused: true });
  assert.deepEqual(types(focused.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(presence.state, PRESENCE_PRESENT);

  assert.equal(presence.peekEvents().length, 4);
  assert.equal(presence.pendingEventCount, 4);
  assert.equal(presence.consumeEvents(2).length, 2);
  assert.equal(presence.pendingEventCount, 2);
  assert.equal(presence.consumeEvents().length, 2);
  assert.equal(presence.pendingEventCount, 0);

  assert.equal(presence.idleMs, IDLE_MS);
  assert.equal(presence.awayMs, AWAY_MS);
  assert.equal(presence.options.idleMs, IDLE_MS);
  assert.equal(presence.options.autoDrain, false);
  assert.equal(presence.history.length, 4);

  // 无效输入照样由状态机拒绝，桥不改语义。
  const bad = presence.observeActivity({ at: 'not-a-time' });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'invalid-time');
  const badFlag = presence.observeWindowFocus({ at: T0 + AWAY_MS + 2, focused: 'yes' });
  assert.equal(badFlag.accepted, false);
  assert.equal(badFlag.reason, 'invalid-focused');
});

test('at-most-once draining: each monitor event reaches the host exactly once', () => {
  const { runtime: presence, seen } = runtime();
  presence.observeActivity(T0);
  presence.tick(T0 + IDLE_MS);
  presence.tick(T0 + AWAY_MS);
  assert.deepEqual(seen, []);

  const first = presence.drain();
  assert.equal(first.attempted, 3);
  assert.equal(first.skipped, 0);
  assert.deepEqual(types(first.delivered), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.IDLE,
    PRESENCE_EVENT_TYPES.AWAY,
  ]);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(types(seen), types(first.delivered));
  assert.equal(new Set(seen.map((event) => event.id)).size, 3);

  // 第二次 drain 没有事件可取，也不会重复投递。
  const second = presence.drain();
  assert.equal(second.attempted, 0);
  assert.deepEqual(second.delivered, []);
  assert.equal(seen.length, 3);

  // 部分投递：只取一条。
  presence.observeActivity(T0 + AWAY_MS + 1);
  presence.tick(T0 + AWAY_MS + 1 + IDLE_MS);
  const partial = presence.drain(1);
  assert.deepEqual(types(partial.delivered), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(partial.attempted, 1);
  assert.equal(presence.pendingEventCount, 1);
  const rest = presence.drain();
  assert.deepEqual(types(rest.delivered), [PRESENCE_EVENT_TYPES.IDLE]);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen.map((event) => event.id)).size, 5);
  assert.equal(presence.stats.bridge.delivered, 5);
});

test('autoDrain delivers each event as soon as it is produced', () => {
  const seen = [];
  const presence = new PresenceRuntime({
    idleMs: IDLE_MS,
    awayMs: AWAY_MS,
    clock: () => T0,
    onEvent: (event) => seen.push(event),
    autoDrain: true,
  });

  presence.observeActivity();
  assert.deepEqual(types(seen), [PRESENCE_EVENT_TYPES.ENTERED]);
  presence.tick(T0 + IDLE_MS);
  assert.deepEqual(types(seen), [PRESENCE_EVENT_TYPES.ENTERED, PRESENCE_EVENT_TYPES.IDLE]);
  // 没有新事件的 tick 不会重复投递。
  presence.tick(T0 + IDLE_MS + 1);
  assert.equal(seen.length, 2);
  assert.equal(presence.pendingEventCount, 0);
  assert.equal(presence.stats.bridge.autoDrain, true);
});

test('callback failures never break state updates and stay structured', () => {
  const seen = [];
  let calls = 0;
  const secret = 'PRIVATE-CALLBACK-MESSAGE-SECRET';
  const presence = new PresenceRuntime({
    idleMs: IDLE_MS,
    awayMs: AWAY_MS,
    clock: () => T0,
    onEvent: (event) => {
      calls += 1;
      if (calls === 2) throw new Error(secret + ' ' + 'x'.repeat(400));
      seen.push(event);
    },
  });

  presence.observeActivity(T0);
  presence.tick(T0 + IDLE_MS);
  presence.tick(T0 + AWAY_MS);
  // 回调在 drain 时才执行，状态机早已完成全部转换。
  assert.equal(presence.state, PRESENCE_AWAY);
  assert.equal(presence.stats.monitor.sequence, 3);

  const result = presence.drain();
  assert.equal(result.attempted, 3);
  assert.deepEqual(types(result.delivered), [PRESENCE_EVENT_TYPES.ENTERED, PRESENCE_EVENT_TYPES.AWAY]);
  assert.deepEqual(types(result.failed), [PRESENCE_EVENT_TYPES.IDLE]);
  // 失败的那条不会被重投；同批后面的事件照常送达。
  assert.deepEqual(types(seen), [PRESENCE_EVENT_TYPES.ENTERED, PRESENCE_EVENT_TYPES.AWAY]);
  assert.equal(presence.drain().delivered.length, 0);

  const bridge = presence.stats.bridge;
  assert.equal(bridge.callbackErrors, 1);
  assert.equal(bridge.delivered, 2);
  assert.equal(bridge.lastCallbackError.eventId, 'presence:2');
  assert.equal(bridge.lastCallbackError.eventType, PRESENCE_EVENT_TYPES.IDLE);
  assert.equal(bridge.lastCallbackError.name, 'Error');
  assert.deepEqual(
    Object.keys(bridge.lastCallbackError).sort(),
    ['eventId', 'eventType', 'name'],
  );
  const serialized = JSON.stringify(bridge.lastCallbackError);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('stack'), false);

  // 状态机继续工作，后续事件照常投递。
  const after = presence.observeActivity(T0 + AWAY_MS + 1);
  assert.deepEqual(types(after.events), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.deepEqual(types(presence.drain().delivered), [PRESENCE_EVENT_TYPES.RETURNED]);
  assert.equal(presence.state, PRESENCE_PRESENT);
});

test('content-blind: extra content fields never reach events, snapshot or stats', () => {
  const { runtime: presence } = runtime();
  const noisy = {
    at: T0,
    active: true,
    text: 'PRIVATE-MESSAGE-BODY',
    windowTitle: 'PRIVATE-WINDOW-TITLE',
    url: 'https://private.example.invalid/secret',
    files: ['PRIVATE-FILE.txt'],
    clipboard: 'PRIVATE-CLIPBOARD',
    keys: 'PRIVATE-KEYSTROKES',
    screenshot: 'PRIVATE-SCREENSHOT',
    processes: ['PRIVATE-PROCESS'],
    userId: 'PRIVATE-USER-ID',
  };

  const result = presence.observeActivity(noisy);
  assert.deepEqual(types(result.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  presence.observeWindowFocus({ at: T0 + 1, focused: false, title: 'PRIVATE-WINDOW-TITLE' });
  presence.observeHeartbeat({ at: T0 + 2, alive: true, note: 'PRIVATE-MESSAGE-BODY' });
  presence.tick(T0 + IDLE_MS);
  const drained = presence.drain();

  const blob = JSON.stringify({
    snapshot: presence.snapshot(),
    stats: presence.stats,
    events: presence.peekEvents(),
    history: presence.history,
    drained,
    privacy: presence.privacy,
    options: presence.options,
  });
  for (const leaked of ['PRIVATE-MESSAGE-BODY', 'PRIVATE-WINDOW-TITLE', 'private.example.invalid',
    'PRIVATE-FILE.txt', 'PRIVATE-CLIPBOARD', 'PRIVATE-KEYSTROKES', 'PRIVATE-SCREENSHOT',
    'PRIVATE-PROCESS', 'PRIVATE-USER-ID']) {
    assert.equal(blob.includes(leaked), false, 'bridge leaked ' + leaked);
  }

  // 桥只沿用状态机的输入契约：时间戳 + 布尔量。
  const privacy = presence.privacy;
  assert.equal(privacy.contentBlind, true);
  assert.equal(privacy.localOnly, true);
  assert.equal(privacy.network, false);
  assert.equal(privacy.timers, false);
  assert.equal(privacy.persistsCallbacks, false);
  assert.equal(privacy.eventDelivery, 'at-most-once');
  assert.deepEqual(privacy.inputs, ['timestamp', 'boolean flag']);
  for (const forbidden of ['message text', 'screenshots', 'keystrokes', 'window titles',
    'file names or paths', 'urls', 'clipboard contents', 'process lists', 'user identifiers']) {
    assert.equal(privacy.neverStores.includes(forbidden), true, 'missing never-stores: ' + forbidden);
  }
  // 桥只追加自己的两条保证，不改状态机的隐私对象。
  assert.equal(monitorModule.PRESENCE_PRIVACY.persistsCallbacks, undefined);
  assert.equal(Object.isFrozen(monitorModule.PRESENCE_PRIVACY), true);
});

test('snapshot/restore keeps the monitor format and does not persist callbacks', () => {
  const { runtime: first } = runtime();
  first.observeActivity(T0);
  first.tick(T0 + AWAY_MS);
  first.drain();
  assert.equal(first.state, PRESENCE_AWAY);

  const snapshot = first.snapshot();
  const json = JSON.stringify(snapshot);
  assert.deepEqual(JSON.parse(json), snapshot);
  assert.equal(snapshot.kind, 'presence-snapshot');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.state, PRESENCE_AWAY);
  for (const value of Object.values(snapshot)) {
    assert.equal(['object', 'string', 'number', 'boolean'].includes(typeof value), true);
  }
  assert.equal(json.includes('onEvent'), false);
  assert.equal(JSON.stringify(first).includes('onEvent'), false);

  // 重启后回来：returned 而不是 entered。
  const restored = PresenceRuntime.fromSnapshot(JSON.parse(json), {
    clock: () => T0,
    onEvent: () => {},
  });
  assert.equal(restored.state, PRESENCE_AWAY);
  assert.equal(restored.lastActivityAt, new Date(T0).toISOString());
  const returned = restored.observeActivity(T0 + AWAY_MS + 1);
  assert.deepEqual(types(returned.events), [PRESENCE_EVENT_TYPES.RETURNED]);

  // 默认不采用快照阈值（宿主配置优先），adoptConfig: true 才采用。
  assert.equal(restored.idleMs, 5 * 60_000);
  const adopted = PresenceRuntime.fromSnapshot(json, { adoptConfig: true });
  assert.equal(adopted.idleMs, IDLE_MS);
  assert.equal(adopted.awayMs, AWAY_MS);
  assert.equal(adopted.state, PRESENCE_AWAY);

  // 坏存档被拒绝且不抛错。
  const broken = PresenceRuntime.fromSnapshot('{ not json');
  assert.equal(broken.state, PRESENCE_UNKNOWN);
  const rejected = broken.restore({ kind: 'other', state: 'present' });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'invalid-snapshot');
});

test('restore does not replay pending events unless asked, and never replays delivered ones', () => {
  const before = runtime();
  before.runtime.observeActivity(T0);
  before.runtime.tick(T0 + IDLE_MS);
  const snapshot = before.runtime.snapshot();
  assert.equal(snapshot.events.length, 2);

  // 默认：不重放。
  const quiet = PresenceRuntime.fromSnapshot(snapshot, {
    clock: () => T0,
    onEvent: () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(quiet.drain(), { attempted: 0, delivered: [], failed: [], skipped: 0 });
  assert.equal(quiet.stats.bridge.delivered, 0);

  // 显式要求重放才补发。
  const loudSeen = [];
  const loud = PresenceRuntime.fromSnapshot(snapshot, {
    clock: () => T0,
    onEvent: (event) => loudSeen.push(event),
    replayEvents: true,
  });
  const replayed = loud.drain();
  assert.deepEqual(types(replayed.delivered), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.IDLE,
  ]);
  assert.equal(loudSeen.length, 2);

  // 同一条 ran 时已经投递过的事件，即使重放也不会二次投递。
  const { runtime: same, seen } = runtime();
  same.observeActivity(T0);
  same.tick(T0 + IDLE_MS);
  const liveSnapshot = same.snapshot();
  same.drain();
  assert.equal(seen.length, 2);

  const restored = same.restore(liveSnapshot, { replayEvents: true });
  assert.equal(restored.accepted, true);
  assert.equal(restored.restoredEvents, 2);
  const again = same.drain();
  assert.equal(again.delivered.length, 0);
  assert.equal(again.skipped, 2);
  assert.equal(seen.length, 2);
  assert.equal(same.stats.bridge.skippedDuplicates, 2);
  assert.equal(same.state, PRESENCE_IDLE);
});

test('dispatch shares the same at-most-once bookkeeping as drain', () => {
  const { runtime: presence, seen } = runtime();
  const external = {
    id: 'host:1',
    type: PRESENCE_EVENT_TYPES.IDLE,
    at: new Date(T0).toISOString(),
    state: PRESENCE_IDLE,
    previousState: PRESENCE_PRESENT,
    reason: 'idle-threshold',
    sequence: 7,
  };

  const once = presence.dispatch([external, { ...external }]);
  assert.equal(once.attempted, 2);
  assert.deepEqual(types(once.delivered), [PRESENCE_EVENT_TYPES.IDLE]);
  assert.equal(once.skipped, 1);
  assert.equal(seen.length, 1);

  // 手写事件与状态机事件共用去重表。
  presence.observeActivity(T0);
  presence.drain();
  const mixed = presence.dispatch([external, { id: 'host:2', type: 'presence.away' }]);
  assert.deepEqual(types(mixed.delivered), ['presence.away']);
  assert.equal(mixed.skipped, 1);
  assert.equal(seen.length, 3);

  // 非数组 / 缺 id 的事件不会炸，也不会被投递。
  assert.deepEqual(presence.dispatch('nope'), { attempted: 0, delivered: [], failed: [], skipped: 0 });
  assert.deepEqual(presence.dispatch(undefined), { attempted: 0, delivered: [], failed: [], skipped: 0 });
  const malformed = presence.dispatch([{ type: 'presence.idle' }, null, 42]);
  assert.equal(malformed.attempted, 3);
  assert.equal(malformed.delivered.length, 0);
  assert.equal(malformed.skipped, 3);
  assert.equal(presence.stats.bridge.invalidEvents, 3);
});

test('sink management: no sink means events are counted as dropped, not queued forever', () => {
  const presence = new PresenceRuntime({ idleMs: IDLE_MS, awayMs: AWAY_MS, clock: () => T0 });
  assert.equal(presence.onEvent, null);
  assert.equal(presence.stats.bridge.hasSink, false);

  presence.observeActivity(T0);
  const withoutSink = presence.drain();
  assert.equal(withoutSink.attempted, 1);
  assert.deepEqual(withoutSink.delivered, []);
  assert.equal(presence.stats.bridge.droppedNoSink, 1);

  const collected = [];
  presence.setOnEvent((event) => collected.push(event));
  assert.equal(presence.stats.bridge.hasSink, true);
  presence.tick(T0 + IDLE_MS);
  presence.drain();
  assert.deepEqual(types(collected), [PRESENCE_EVENT_TYPES.IDLE]);

  assert.throws(() => presence.setOnEvent('nope'), TypeError);
  assert.throws(() => new PresenceRuntime({ onEvent: 'nope' }), TypeError);

  presence.clearOnEvent();
  presence.tick(T0 + AWAY_MS);
  presence.drain();
  assert.equal(presence.stats.bridge.droppedNoSink, 2);
  assert.equal(presence.state, PRESENCE_AWAY);
});

test('reset clears state and delivery bookkeeping but keeps config and sink', () => {
  const { runtime: presence, seen } = runtime();
  presence.observeActivity(T0);
  presence.tick(T0 + AWAY_MS);
  presence.drain();
  assert.equal(seen.length, 2);
  assert.equal(presence.stats.monitor.sequence, 2);
  assert.equal(presence.stats.bridge.trackedEventIds, 2);

  presence.reset();
  assert.equal(presence.state, PRESENCE_UNKNOWN);
  assert.equal(presence.lastActivityAt, null);
  assert.equal(presence.pendingEventCount, 0);
  assert.equal(presence.stats.monitor.sequence, 0);
  assert.equal(presence.stats.bridge.delivered, 0);
  assert.equal(presence.stats.bridge.trackedEventIds, 0);
  assert.equal(presence.stats.bridge.callbackErrors, 0);
  assert.equal(presence.stats.bridge.lastCallbackError, null);
  assert.equal(presence.stats.bridge.hasSink, true);
  assert.equal(presence.idleMs, IDLE_MS);

  // reset 之后重新从 entered 开始，事件 id 复用也不会被去重表挡掉。
  const again = presence.observeActivity(T0);
  assert.deepEqual(types(again.events), [PRESENCE_EVENT_TYPES.ENTERED]);
  assert.equal(again.events[0].id, 'presence:1');
  presence.drain();
  assert.deepEqual(types(seen), [
    PRESENCE_EVENT_TYPES.ENTERED,
    PRESENCE_EVENT_TYPES.AWAY,
    PRESENCE_EVENT_TYPES.ENTERED,
  ]);
});

test('runtimes are independent and re-exported constants stay identical', () => {
  const a = runtime();
  const b = runtime();
  a.runtime.observeActivity(T0);
  assert.equal(a.runtime.state, PRESENCE_PRESENT);
  assert.equal(b.runtime.state, PRESENCE_UNKNOWN);
  assert.deepEqual(b.seen, []);

  // 只 import 桥就能拿到状态机常量与工厂。
  assert.equal(PRESENCE_EVENT_TYPES, monitorModule.PRESENCE_EVENT_TYPES);
  assert.equal(PresenceMonitor, monitorModule.default);
  assert.deepEqual(Object.values(PRESENCE_EVENT_TYPES), [
    'presence.entered',
    'presence.idle',
    'presence.returned',
    'presence.away',
  ]);

  const factory = createPresenceRuntime({ idleMs: 1_000, awayMs: 2_000, clock: () => T0 });
  assert.equal(factory instanceof PresenceRuntime, true);
  assert.equal(factory.awayMs, 2_000);

  // 也可以把已有状态机交给桥复用。
  const shared = new PresenceMonitor({ idleMs: IDLE_MS, awayMs: AWAY_MS, clock: () => T0 });
  const bridged = new PresenceRuntime({ monitor: shared });
  bridged.observeActivity(T0);
  assert.equal(shared.state, PRESENCE_PRESENT);
  assert.equal(bridged.state, PRESENCE_PRESENT);

  // 同样的输入序列得到同样的快照（无隐藏状态、无随机）。
  const left = runtime();
  const right = runtime();
  const script = [
    (rt) => rt.observeActivity(T0),
    (rt) => rt.tick(T0 + IDLE_MS),
    (rt) => rt.drain(),
    (rt) => rt.observeWindowFocus({ at: T0 + IDLE_MS + 1, focused: true }),
    (rt) => rt.tick(T0 + AWAY_MS * 2),
    (rt) => rt.drain(),
  ];
  const leftTrace = script.map((step) => step(left.runtime));
  const rightTrace = script.map((step) => step(right.runtime));
  assert.deepEqual(leftTrace, rightTrace);
  assert.deepEqual(left.runtime.snapshot(), right.runtime.snapshot());
  assert.deepEqual(left.seen, right.seen);
});

test('observe* narrows host payloads before the monitor sees them', () => {
  const received = [];
  class CapturingMonitor extends PresenceMonitor {
    observeActivity(input) {
      received.push(input);
      return { accepted: true, events: [], state: 'present' };
    }

    observeWindowFocus(input) {
      received.push(input);
      return { accepted: true, events: [], state: 'present' };
    }

    observeHeartbeat(input) {
      received.push(input);
      return { accepted: true, events: [], state: 'present' };
    }

    tick(input) {
      received.push(input);
      return { accepted: true, events: [], state: 'present' };
    }
  }

  const presence = new PresenceRuntime({ monitor: new CapturingMonitor() });
  const noisy = {
    at: T0,
    active: true,
    text: 'PRIVATE-MESSAGE',
    title: 'PRIVATE-TITLE',
    url: 'https://private.example.invalid/',
  };
  presence.observeActivity(noisy);
  presence.observeWindowFocus({ at: T0 + 1, focused: false, title: 'PRIVATE-TITLE' });
  presence.observeHeartbeat({ at: T0 + 2, alive: false, note: 'PRIVATE-NOTE' });

  // Only the timestamp and this entry point's boolean survive the bridge.
  assert.deepEqual(received[0], { at: T0, active: true });
  assert.deepEqual(received[1], { at: T0 + 1, focused: false });
  assert.deepEqual(received[2], { at: T0 + 2, alive: false });

  // A plain object without the flag keeps only `at`; scalar input is delegated as-is.
  presence.observeActivity({ at: T0 + 3, text: 'PRIVATE-MESSAGE' });
  assert.deepEqual(received[3], { at: T0 + 3 });
  presence.observeWindowFocus(T0 + 4);
  assert.equal(received[4], T0 + 4);

  // tick is a raw pass-through: narrowing belongs to the observation entry points.
  const tickInput = { at: T0 + 5, text: 'PRIVATE-MESSAGE' };
  presence.tick(tickInput);
  assert.equal(received.length, 6);
  assert.equal(received[5], tickInput, 'tick delegates its input unchanged');
});

test('constructor bounds the delivery ledger and evicts the oldest event id', () => {
  const fallback = new PresenceRuntime({ maxDelivered: 0 });
  assert.equal(fallback.options.maxDelivered, 256, 'below 1 falls back to the default');
  assert.equal(new PresenceRuntime({ maxDelivered: Number.NaN }).options.maxDelivered, 256);
  assert.equal(new PresenceRuntime(null).onEvent, null, 'non-object options are ignored');
  assert.equal(new PresenceRuntime('ignored').options.autoDrain, false);
  assert.equal(new PresenceRuntime({ autoDrain: 'yes' }).options.autoDrain, false, 'only boolean true enables autoDrain');

  const seen = [];
  const presence = new PresenceRuntime({
    maxDelivered: '2.9',
    onEvent: (event) => seen.push(event),
  });
  assert.equal(presence.options.maxDelivered, 2, 'fractional limits are truncated');
  const event = (id) => ({ id, type: PRESENCE_EVENT_TYPES.IDLE });

  presence.dispatch([event('host:a'), event('host:b')]);
  presence.dispatch([event('host:c')]); // evicts host:a
  assert.equal(presence.stats.bridge.trackedEventIds, 2);

  const duplicates = presence.dispatch([event('host:b'), event('host:c')]);
  assert.equal(duplicates.delivered.length, 0);
  assert.equal(duplicates.skipped, 2);
  assert.equal(presence.stats.bridge.skippedDuplicates, 2);

  // Once an old id is evicted it can be delivered again; the ledger stays bounded.
  const replayedA = presence.dispatch([event('host:a')]);
  assert.deepEqual(replayedA.delivered.map((item) => item.id), ['host:a']);
  const replayedB = presence.dispatch([event('host:b')]);
  assert.deepEqual(replayedB.delivered.map((item) => item.id), ['host:b']);
  assert.equal(presence.stats.bridge.trackedEventIds, 2);
  assert.equal(presence.stats.bridge.delivered, 5);
  assert.equal(seen.length, 5);
});

test('callback error labels are limited to the fixed builtin whitelist', () => {
  const secret = 'PRIVATE-CALLBACK-ERROR-TEXT';
  const cases = [
    ['Error', new Error(secret)],
    ['TypeError', new TypeError(secret)],
    ['RangeError', new RangeError(secret)],
    ['SyntaxError', new SyntaxError(secret)],
    ['ReferenceError', new ReferenceError(secret)],
    ['EvalError', new EvalError(secret)],
    ['URIError', new URIError(secret)],
    ['AggregateError', new AggregateError([new Error(secret)], secret)],
  ];
  let thrown;
  const presence = new PresenceRuntime({
    onEvent: () => { throw thrown; },
  });

  for (const [label, error] of cases) {
    thrown = error;
    const result = presence.dispatch([{
      id: 'host:' + label,
      type: PRESENCE_EVENT_TYPES.IDLE,
    }]);
    assert.deepEqual(types(result.failed), [PRESENCE_EVENT_TYPES.IDLE]);
    const diagnostic = presence.stats.bridge.lastCallbackError;
    assert.deepEqual(diagnostic, {
      eventId: 'host:' + label,
      eventType: PRESENCE_EVENT_TYPES.IDLE,
      name: label,
    });
    assert.deepEqual(Object.keys(diagnostic).sort(), ['eventId', 'eventType', 'name']);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }

  assert.equal(presence.stats.bridge.callbackErrors, cases.length);
  assert.equal(presence.state, PRESENCE_UNKNOWN, 'diagnostics never mutate the state machine');
});

test('hostile callback throws degrade to Error without reading or leaking text', () => {
  const secret = 'PRIVATE-HOSTILE-CALLBACK-SECRET';
  class CustomError extends Error {
    constructor() {
      super(secret);
      this.name = secret;
    }
  }

  let getterReads = 0;
  const getterBomb = new Error(secret);
  for (const field of ['name', 'message', 'stack']) {
    Object.defineProperty(getterBomb, field, {
      configurable: true,
      get() {
        getterReads += 1;
        throw new Error(secret);
      },
    });
  }

  const stringifyBomb = {
    name: secret,
    message: secret,
    stack: secret,
    toString() { return secret; },
  };
  const proxyBomb = new Proxy({}, {
    getPrototypeOf() { throw new Error(secret); },
  });
  const hostileValues = [
    ['custom', new CustomError()],
    ['object', stringifyBomb],
    ['string', secret],
    ['undefined', undefined],
    ['getter', getterBomb],
    ['proxy', proxyBomb],
  ];

  let thrown;
  const presence = new PresenceRuntime({
    idleMs: IDLE_MS,
    awayMs: AWAY_MS,
    clock: () => T0,
    onEvent: () => { throw thrown; },
  });
  presence.observeActivity(T0);
  assert.equal(presence.state, PRESENCE_PRESENT);

  for (const [label, value] of hostileValues) {
    thrown = value;
    const result = presence.dispatch([{
      id: 'host:' + label,
      type: PRESENCE_EVENT_TYPES.AWAY,
    }]);
    assert.deepEqual(types(result.failed), [PRESENCE_EVENT_TYPES.AWAY]);
    const diagnostic = presence.stats.bridge.lastCallbackError;
    assert.deepEqual(diagnostic, {
      eventId: 'host:' + label,
      eventType: PRESENCE_EVENT_TYPES.AWAY,
      name: 'Error',
    });
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }

  assert.equal(getterReads, 0, 'name/message/stack getters must never be read');
  assert.equal(presence.stats.bridge.callbackErrors, hostileValues.length);
  const publicJson = JSON.stringify({
    stats: presence.stats,
    snapshot: presence.snapshot(),
    toJSON: presence.toJSON(),
  });
  assert.equal(publicJson.includes(secret), false);
  assert.deepEqual(Object.keys(presence.stats.bridge.lastCallbackError).sort(), [
    'eventId',
    'eventType',
    'name',
  ]);

  // 回调错误没有让状态机二次失败：阈值照常结算。
  presence.tick(T0 + IDLE_MS);
  assert.equal(presence.state, PRESENCE_IDLE);
});

test('module stays dependency-free, offline and timer-free', () => {
  const source = fs.readFileSync(new URL('../src/presence-runtime.js', import.meta.url), 'utf8');
  const importLines = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
  assert.equal(importLines.length, 1, 'only the local presence module may be imported');
  assert.equal(/from\s+'\.\/presence\.js'/.test(importLines[0]), true);

  const forbidden = [
    /\brequire\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /['"]node:/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /\bMath\.random\b/,
    /\bnew Date\(\)/,
    /\bprocess\.\w/,
    /\bchild_process\b/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in presence-runtime.js: ' + pattern);
  }
  assert.equal(/^\s*import\s+PresenceMonitor, \{/m.test(source), true);
});
