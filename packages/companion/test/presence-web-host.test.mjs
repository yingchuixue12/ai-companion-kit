/**
 * presence/web-host · Web 在场宿主入口的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只测这一层新加的宿主接线（开了什么、丢了什么、交付了什么），
 * 状态机 / 互动策略 / 会话 / 存储都按已交付的接口组合进来，不 mock 它们。
 *
 * 覆盖：
 *   1. 显式开启才工作：缺省关闭时 observe/settle 是空操作，不建状态机、不写盘；
 *   2. 内容盲：text/title/url/clipboard/path/userId 在进入状态机前被丢掉，
 *      状态文件与队列里都不出现；另一个 kind 的布尔量被拒收；
 *   3. 交付现有策略的欢迎 / 休息提示：文案来自 PresenceInteractionPolicy；
 *   4. 游标读取只读幂等，重启后旧游标不回放；
 *   5. 禁用清空队列、删掉状态文件，再启用从干净状态开始；
 *   6. 注入的持久化：重启恢复冷却（不重复欢迎）、冷却到期后仍可再欢迎；
 *   7. 写盘失败 fail-closed：不交付一条「重启后还会再来一次」的提示；
 *   8. 有界队列、close() 语义、损坏存档不覆盖证据、离线/无定时器源码守卫。
 *
 * 全部用注入时钟 + 临时目录，不联网、不读真实配置或 data。
 *
 * 宿主一律经**公开入口** `../src/lib.js` 导入（而不是直接摸
 * ../src/presence/web-host.js）：这样 lib.js 的再导出也在覆盖率里，
 * 也顺带证明这些符号确实从包入口对外可见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PresenceStateStore } from '../src/presence/persistence.js';
import { PRESENCE_INTERACTION_TEXT } from '../src/presence-interaction.js';
import {
  PRESENCE_WEB_DEFAULT_MAX_MESSAGES,
  PRESENCE_WEB_DIAGNOSTIC_CODES,
  PRESENCE_WEB_SIGNAL_FLAGS,
  PRESENCE_WEB_STATUSES,
  PRESENCE_WEB_STATE_FILE,
  createPresenceWebHost,
} from '../src/lib.js';

const T0 = Date.parse('2026-11-22T12:00:00.000Z');
const MINUTE = 60 * 1000;

/** 常用阈值：5 分钟 idle / 30 分钟 away / 回来 5 分钟起算 / 90 分钟冷却。 */
const SETTINGS = Object.freeze({
  idleMs: 5 * MINUTE,
  awayMs: 30 * MINUTE,
  returnAfterMs: 5 * MINUTE,
  workAfterMs: 50 * MINUTE,
  cooldownMs: 90 * MINUTE,
});

/** 休息提醒用：idle 拉到 1 小时，才能在「一直 present」的情况下累计到 50 分钟。 */
const LONG_SESSION_SETTINGS = Object.freeze({
  idleMs: 60 * MINUTE,
  awayMs: 120 * MINUTE,
  returnAfterMs: 5 * MINUTE,
  workAfterMs: 50 * MINUTE,
  cooldownMs: 90 * MINUTE,
});

function makeClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    set(ms) {
      current = ms;
      return current;
    },
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-web-host-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 走一遍「进入在场 → 离开 → 回来（6 分钟）」，回来这一拍应当产生一条 welcome-back。 */
function driveToWelcome(host, clock) {
  clock.set(T0);
  const entered = host.observe({ kind: 'activity', at: T0 });
  clock.set(T0 + 31 * MINUTE);
  const away = host.settle(T0 + 31 * MINUTE);
  clock.set(T0 + 37 * MINUTE);
  const returned = host.observe({ kind: 'activity', at: T0 + 37 * MINUTE });
  return { entered, away, returned };
}

test('disabled by default: no state machine, no events, no file, no queued prompts', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const host = createPresenceWebHost({ stateFile: file, now: clock.now, settings: SETTINGS });

    assert.equal(host.enabled, false);
    assert.equal(host.status, PRESENCE_WEB_STATUSES.DISABLED);
    assert.equal(host.state, 'unknown');
    assert.equal(host.pending, 0);
    assert.equal(host.stateFile, null);
    assert.deepEqual(host.diagnostics, [{ code: PRESENCE_WEB_DIAGNOSTIC_CODES.DISABLED }]);

    const observed = host.observe({ kind: 'activity', at: T0 });
    assert.equal(observed.ok, false);
    assert.equal(observed.status, PRESENCE_WEB_STATUSES.DISABLED);
    assert.deepEqual(observed.events, []);
    assert.deepEqual(observed.messages, []);

    const settled = host.settle(T0 + 31 * MINUTE);
    assert.equal(settled.status, PRESENCE_WEB_STATUSES.DISABLED);
    assert.equal(host.state, 'unknown');

    // 关闭时不建 store：一个文件都不该被创建。
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(host.messages(), { cursor: host.cursor, messages: [] });

    // 从来没开启过的宿主也能安全关闭：没有状态机可落盘，也没有提示要清。
    assert.deepEqual(host.close(), {
      ok: true,
      persisted: false,
      alreadyClosed: false,
      previousStatus: PRESENCE_WEB_STATUSES.DISABLED,
      dropped: 0,
    });
    assert.equal(host.status, PRESENCE_WEB_STATUSES.CLOSED);
  });
});

test('enabled must be literally true; disabled host ignores every signal shape', () => {
  for (const enabled of [undefined, false, 'true', 1, {}]) {
    const host = createPresenceWebHost({ enabled });
    assert.equal(host.enabled, false);
    assert.equal(host.observe({ kind: 'activity' }).status, PRESENCE_WEB_STATUSES.DISABLED);
    assert.equal(host.observe({ kind: 'heartbeat', alive: false }).status, PRESENCE_WEB_STATUSES.DISABLED);
  }
});

test('content-blind: only kind + at + own flag reach the machine, everything else is dropped', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const host = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });

    const junk = {
      kind: 'activity',
      at: T0,
      text: '机密正文-不要落盘',
      title: '某个窗口标题',
      url: 'https://example.invalid/private?token=abc',
      clipboard: '剪贴板内容',
      path: 'C:\\private\\file.txt',
      userId: 'uuid-user-7788',
      screenshot: 'data:image/png;base64,AAA',
    };
    const result = host.observe(junk);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'present');
    assert.deepEqual(result.events.map((event) => event.type), ['presence.entered']);

    // 页面拿到的只是策略文案，不是宿主塞进来的任何内容。
    const welcome = driveToWelcome(host, clock).returned;
    assert.equal(welcome.messages.length, 1);
    assert.equal(welcome.messages[0].text, PRESENCE_INTERACTION_TEXT['welcome-back']);

    const raw = fs.readFileSync(file, 'utf8');
    for (const leak of ['机密正文', '某个窗口标题', 'example.invalid', '剪贴板内容', 'private\\file.txt', 'uuid-user-7788', 'base64']) {
      assert.equal(raw.includes(leak), false, 'state file leaked: ' + leak);
    }
    // 落盘字段是封闭白名单，一个多余的键都没有。
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'activeMs',
      'cooldowns',
      'deliveredIds',
      'kind',
      'sessionStartedAt',
      'state',
      'updatedAt',
      'version',
    ]);
    assert.deepEqual(Object.keys(parsed.cooldowns).sort(), ['break', 'proactive', 'welcome']);
  });
});

test('signal validation: kind, own flag, foreign flag and timestamp are checked without touching state', () => {
  const host = createPresenceWebHost({ enabled: true, settings: SETTINGS });
  const cases = [
    [null, 'invalid-signal'],
    ['activity', 'invalid-signal'],
    [{}, 'invalid-kind'],
    [{ kind: 'mouse' }, 'invalid-kind'],
    [{ kind: 'activity', active: 'yes' }, 'invalid-flag'],
    [{ kind: 'activity', alive: false }, 'kind-flag-mismatch'],
    [{ kind: 'focus', active: true }, 'kind-flag-mismatch'],
    [{ kind: 'heartbeat', focused: true }, 'kind-flag-mismatch'],
    [{ kind: 'activity', at: 'not-a-time' }, 'invalid-at'],
    [{ kind: 'activity', at: Number.NaN }, 'invalid-at'],
  ];
  for (const [input, expected] of cases) {
    const result = host.observe(input);
    assert.equal(result.ok, false, 'expected rejection for ' + JSON.stringify(input));
    assert.equal(result.status, expected, 'wrong status for ' + JSON.stringify(input));
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.messages, []);
    assert.equal(host.state, 'unknown');
  }
  assert.equal(host.stats.counters.rejected, cases.length);

  // settle 的 at 同样按白名单校验，坏时间不会推进状态。
  assert.equal(host.settle('not-a-time').status, 'invalid-at');
  assert.equal(host.settle({ at: {} }).status, 'invalid-at');
  assert.equal(host.state, 'unknown');

  // 合法形状仍然工作：三种 kind 各走自己的入口。
  assert.equal(host.observe({ kind: 'activity', at: T0 }).state, 'present');
  assert.equal(host.observe({ kind: 'focus', at: T0 + MINUTE, focused: true }).ok, true);
  const offline = host.observe({ kind: 'heartbeat', at: T0 + 2 * MINUTE, alive: false });
  assert.deepEqual(offline.events.map((event) => [event.type, event.reason]), [['presence.away', 'host-offline']]);
  assert.equal(offline.state, 'away');

  // Date 形式的 at 同样接受（宿主可能直接给 new Date()）。
  const fromDate = host.observe({ kind: 'activity', at: new Date(T0 + 5 * MINUTE) });
  assert.equal(fromDate.ok, true);
  assert.equal(fromDate.state, 'present');
});

test('unrepresentable timestamps are refused at the boundary and never poison the instance', () => {
  // 时间在本层统一判定（resolveExternalTime）：超出 Date 可表示范围（±8.64e15）
  // 的值绝不交给状态机——它会在 toISOString 上抛错，并把单调时钟锚点写成不可
  // 表示的数，之后每一拍都继续抛错，整个实例报废。页面时钟坏掉时就会发出这种
  // 数，所以入口必须挡住；而且拒收之后同一个实例必须还能继续用。
  withTempDir((dir) => {
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const clock = makeClock(T0);
    const host = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });

    for (const at of [8.64e15 + 1, 8.7e15, 1e18]) {
      const observed = host.observe({ kind: 'activity', at });
      assert.equal(observed.ok, false, 'expected refusal for at=' + at);
      assert.equal(observed.status, 'invalid-at');
      assert.deepEqual(observed.events, []);
      assert.deepEqual(observed.messages, []);

      const settled = host.settle(at);
      assert.equal(settled.ok, false, 'expected refusal for settle at=' + at);
      assert.equal(settled.status, 'invalid-at');
      assert.deepEqual(settled.messages, []);
    }

    // 拒收不改实例：状态没动、队列空、状态文件根本没被创建。
    assert.equal(host.state, 'unknown');
    assert.equal(host.pending, 0);
    assert.equal(fs.existsSync(file), false);

    // 边界之内照常工作，而且**同一个实例**直接继续——锚点没被写坏。
    assert.equal(host.observe({ kind: 'activity', at: 8.64e15 }).ok, true);
    assert.equal(host.state, 'present');

    // 换回正常时间继续走完整链路（这里也用注入时钟，覆盖无 at 的路径）。
    const fresh = createPresenceWebHost({ enabled: true, now: clock.now, settings: SETTINGS });
    assert.equal(fresh.observe({ kind: 'activity', at: T0 }).ok, true);
    clock.set(T0 + 31 * MINUTE);
    assert.deepEqual(fresh.settle().events.map((event) => event.type), ['presence.away']);
    clock.set(T0 + 37 * MINUTE);
    const returned = fresh.observe({ kind: 'activity' });
    assert.deepEqual(returned.events.map((event) => event.type), ['presence.returned']);
    assert.equal(returned.messages.length, 1);
  });
});

test('an unusable injected clock is refused as clock-unavailable and the instance recovers', () => {
  // 没给 at 时时间来自注入时钟；时钟抛错 / 给出非法 Date / 给出不可表示的毫秒
  // 都必须拒收，而不是把垃圾时间交给状态机。
  const broken = [
    () => {
      throw new Error('clock exploded');
    },
    () => new Date(Number.NaN),
    () => 1e18,
  ];
  for (const now of broken) {
    const host = createPresenceWebHost({ enabled: true, now, settings: SETTINGS });
    const observed = host.observe({ kind: 'activity' });
    assert.equal(observed.ok, false);
    assert.equal(observed.status, 'clock-unavailable');
    assert.deepEqual(observed.events, []);
    assert.deepEqual(observed.messages, []);

    const settled = host.settle();
    assert.equal(settled.ok, false);
    assert.equal(settled.status, 'clock-unavailable');
    assert.equal(host.state, 'unknown');
    assert.equal(host.pending, 0);
  }

  // 时钟恢复正常后，同一个实例继续工作（不是只能重建）。
  const clock = makeClock(T0);
  const host = createPresenceWebHost({ enabled: true, now: clock.now, settings: SETTINGS });
  assert.equal(host.observe({ kind: 'activity', at: T0 }).state, 'present');

  clock.set(1e18);
  assert.equal(host.observe({ kind: 'activity' }).status, 'clock-unavailable');
  assert.equal(host.settle().status, 'clock-unavailable');
  assert.equal(host.state, 'present');

  clock.set(T0 + 31 * MINUTE);
  assert.deepEqual(host.settle().events.map((event) => event.type), ['presence.away']);
  assert.equal(host.state, 'away');
});

test('break reminder: the existing policy text is delivered once per sustained session', () => {
  const clock = makeClock();
  const host = createPresenceWebHost({ enabled: true, now: clock.now, settings: LONG_SESSION_SETTINGS });

  clock.set(T0);
  assert.deepEqual(host.observe({ kind: 'activity', at: T0 }).messages, []);

  clock.set(T0 + 30 * MINUTE);
  assert.deepEqual(host.settle(T0 + 30 * MINUTE).messages, []);

  clock.set(T0 + 55 * MINUTE);
  const reminder = host.settle(T0 + 55 * MINUTE);
  assert.equal(reminder.messages.length, 1);
  assert.equal(reminder.messages[0].kind, 'break-reminder');
  assert.equal(reminder.messages[0].text, PRESENCE_INTERACTION_TEXT['break-reminder']);

  // 同一段会话不再重复提醒。
  clock.set(T0 + 58 * MINUTE);
  assert.deepEqual(host.settle(T0 + 58 * MINUTE).messages, []);
  assert.equal(host.pending, 1);
});

test('messages(after) is a read-only idempotent cursor; a foreign or stale cursor replays nothing', () => {
  const clock = makeClock();
  const host = createPresenceWebHost({ enabled: true, now: clock.now, settings: SETTINGS });

  const before = host.messages();
  assert.deepEqual(before.messages, []);

  const { returned } = driveToWelcome(host, clock);
  assert.equal(returned.messages.length, 1);
  const delivered = returned.messages[0];

  // 不传 after：只给游标，不回放（刷新页面不会重复说一句）。
  assert.deepEqual(host.messages().messages, []);

  const first = host.messages(before.cursor);
  assert.equal(first.messages.length, 1);
  assert.deepEqual(first.messages[0], {
    id: delivered.id,
    kind: 'welcome-back',
    text: PRESENCE_INTERACTION_TEXT['welcome-back'],
    at: new Date(T0 + 37 * MINUTE).toISOString(),
  });
  assert.equal(first.cursor, host.cursor);

  // 幂等：同一个 after 再读一次结果一样，队列没有被消费。
  assert.deepEqual(host.messages(before.cursor).messages, first.messages);
  assert.equal(host.pending, 1);

  // 未知/别人实例/超前的游标：一律空，不猜。
  for (const bogus of ['', 'presence-web:000000000000:0', 'presence-web:zzzzzzzzzzzz:0', 'nonsense', host.cursor]) {
    assert.deepEqual(host.messages(bogus).messages, [], 'unexpected replay for ' + bogus);
  }
});

test('disable purges the queue, clears the state file, and re-enable starts clean', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const host = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });

    driveToWelcome(host, clock);
    assert.equal(host.pending, 1);
    assert.equal(fs.existsSync(file), true);

    const cursorBefore = host.cursor;
    const disabled = host.setEnabled(false);
    assert.deepEqual(disabled, {
      enabled: false,
      status: PRESENCE_WEB_STATUSES.DISABLED,
      dropped: 1,
      cleared: true,
    });
    assert.equal(host.status, PRESENCE_WEB_STATUSES.DISABLED);
    assert.equal(host.enabled, false);
    assert.equal(host.pending, 0);
    assert.equal(host.stats.clearPending, false);
    // 禁用不残留排队提示：旧游标读不到东西，队列本身也是空的。
    assert.deepEqual(host.messages(cursorBefore).messages, []);
    assert.deepEqual(host.messages().messages, []);
    // 状态文件被删掉：禁用 → 重启 → 再启用 不会沿用旧冷却。
    assert.equal(fs.existsSync(file), false);

    assert.equal(host.observe({ kind: 'activity', at: T0 + 40 * MINUTE }).status, PRESENCE_WEB_STATUSES.DISABLED);

    const reenabled = host.setEnabled(true);
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.cleared, true);
    assert.equal(host.status, PRESENCE_WEB_STATUSES.READY);
    assert.equal(host.restored, false);
    assert.equal(host.pending, 0);
    assert.equal(host.diagnostics.some((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.FRESH_START), true);

    // 重新启用后是一个全新的实例：旧游标永远匹配不上。
    assert.deepEqual(host.messages(cursorBefore).messages, []);
    assert.equal(host.setEnabled(true).alreadyEnabled, true);
  });
});

test('restart restores the cooldown from the injected store: the same welcome is not sent twice', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const store = new PresenceStateStore({ file, now: clock.now });

    const first = createPresenceWebHost({ enabled: true, store, now: clock.now, settings: SETTINGS });
    const { returned } = driveToWelcome(first, clock);
    assert.equal(returned.messages.length, 1);
    const oldCursor = first.cursor;
    assert.equal(first.stateFile, store.file);
    assert.deepEqual(first.close(), {
      ok: true,
      persisted: true,
      alreadyClosed: false,
      previousStatus: PRESENCE_WEB_STATUSES.READY,
      dropped: 1,
    });

    // 重启：同一个 store、同一个时钟，晚了 3 分钟。
    clock.set(T0 + 40 * MINUTE);
    const second = createPresenceWebHost({ enabled: true, store: new PresenceStateStore({ file, now: clock.now }), now: clock.now, settings: SETTINGS });
    assert.equal(second.status, PRESENCE_WEB_STATUSES.READY);
    assert.equal(second.restored, true);
    assert.equal(second.pending, 0);
    // 旧提示不会被补发（旧游标属于上一个实例）。
    assert.deepEqual(second.messages(oldCursor).messages, []);

    // 冷却期内再来一次「离开 → 回来」：策略会想欢迎，但持久化闸门把它扣下来。
    clock.set(T0 + 70 * MINUTE);
    const away = second.settle(T0 + 70 * MINUTE);
    assert.deepEqual(away.events.map((event) => event.type), ['presence.away']);
    clock.set(T0 + 76 * MINUTE);
    const suppressed = second.observe({ kind: 'activity', at: T0 + 76 * MINUTE });
    assert.deepEqual(suppressed.messages, []);
    assert.equal(second.pending, 0);
    assert.ok(second.stats.session.suppressedIntents >= 1);

    // 冷却到期后仍然可以正常欢迎（不是永久闭嘴）。
    // 口径：策略自己也有一张内存冷却表，被 session 闸门扣下的那次同样从
    // T0+76 起算 90 分钟，所以要等到 T0+170 之后才会再次产生欢迎。
    clock.set(T0 + 170 * MINUTE);
    assert.deepEqual(second.settle(T0 + 170 * MINUTE).events.map((event) => event.type), ['presence.away']);
    clock.set(T0 + 176 * MINUTE);
    const later = second.observe({ kind: 'activity', at: T0 + 176 * MINUTE });
    assert.equal(later.messages.length, 1);
    assert.equal(later.messages[0].kind, 'welcome-back');
  });
});

test('a failing save fails closed: the prompt is withheld instead of becoming a duplicate after restart', () => {
  const clock = makeClock();
  const failing = {
    file: 'memory://failing',
    load: () => ({ ok: true, state: null, diagnostics: [{ code: 'absent' }] }),
    save: () => ({ ok: false, persisted: false, error: 'disk-full' }),
    clear: () => ({ ok: true }),
  };
  const host = createPresenceWebHost({ enabled: true, store: failing, now: clock.now, settings: SETTINGS });

  const { returned } = driveToWelcome(host, clock);
  assert.equal(returned.ok, false);
  assert.equal(returned.status, 'state-save-failed');
  assert.deepEqual(returned.messages, []);
  assert.equal(host.pending, 0);
  assert.equal(host.stats.counters.saveFailures >= 1, true);
  assert.equal(
    host.diagnostics.some((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_SAVE_FAILED),
    true,
  );
});

test('bounded queue keeps the newest prompts and counts what it dropped', () => {
  const clock = makeClock();
  const host = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    settings: { ...SETTINGS, cooldownMs: 0, returnAfterMs: 0 },
    maxMessages: 2,
  });

  clock.set(T0);
  host.observe({ kind: 'activity', at: T0 });
  let at = T0;
  for (let round = 1; round <= 3; round += 1) {
    at += 31 * MINUTE;
    host.settle(at);
    at += 1 * MINUTE;
    const step = host.observe({ kind: 'activity', at });
    assert.equal(step.messages.length, 1, 'welcome round ' + round);
  }
  assert.equal(host.pending, 2);
  assert.equal(host.stats.counters.droppedOldest, 1);
  assert.equal(host.stats.maxMessages, 2);
});

test('corrupt state file fails closed and is never overwritten', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const garbage = '{"state":"present","cooldowns":{"welcome":';
    fs.writeFileSync(file, garbage, 'utf8');

    const host = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });
    assert.equal(host.status, PRESENCE_WEB_STATUSES.STATE_LOAD_FAILED);
    assert.equal(host.enabled, false);
    assert.equal(host.restored, false);
    assert.deepEqual(
      host.diagnostics.find((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_LOAD_FAILED),
      { code: PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_LOAD_FAILED, detail: 'corrupt' },
    );

    const attempted = host.observe({ kind: 'activity', at: T0 });
    assert.equal(attempted.ok, false);
    assert.equal(attempted.status, PRESENCE_WEB_STATUSES.STATE_LOAD_FAILED);
    assert.equal(host.state, 'unknown');
    // 读盘失败不覆盖证据。
    assert.equal(fs.readFileSync(file, 'utf8'), garbage);
  });
});

test('in-memory mode works without persistence and says so', () => {
  const clock = makeClock();
  const host = createPresenceWebHost({ enabled: true, now: clock.now, settings: SETTINGS });
  assert.equal(host.status, PRESENCE_WEB_STATUSES.READY);
  assert.equal(host.stateFile, null);
  assert.equal(host.diagnostics.some((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.IN_MEMORY), true);

  const { returned } = driveToWelcome(host, clock);
  assert.equal(returned.messages.length, 1);
  assert.equal(returned.persisted, false);
});

test('close() clears the in-memory prompts but still persists the cooldown for restarts', () => {
  withTempDir((dir) => {
    const clock = makeClock();
    const file = path.join(dir, PRESENCE_WEB_STATE_FILE);
    const host = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });

    const cursorBefore = host.cursor;
    driveToWelcome(host, clock);
    assert.equal(host.pending, 1);
    assert.equal(host.closed, false);

    const first = host.close();
    assert.equal(first.ok, true);
    assert.equal(first.persisted, true);
    assert.equal(first.previousStatus, PRESENCE_WEB_STATUSES.READY);
    assert.equal(first.dropped, 1);
    assert.equal(host.status, PRESENCE_WEB_STATUSES.CLOSED);
    assert.equal(host.closed, true);
    assert.equal(host.enabled, false);

    // §6 T6：关闭清内存提示，关闭的宿主不再返回待展示提示。
    assert.equal(host.pending, 0);
    assert.deepEqual(host.messages(cursorBefore), { cursor: host.cursor, messages: [] });
    assert.deepEqual(host.messages().messages, []);

    // 但冷却仍然落盘：重启后不会把同一句欢迎再说一遍。
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.cooldowns.welcome, T0 + 37 * MINUTE);
    clock.set(T0 + 40 * MINUTE);
    const restarted = createPresenceWebHost({ enabled: true, stateFile: file, now: clock.now, settings: SETTINGS });
    assert.equal(restarted.restored, true);
    assert.equal(restarted.pending, 0);
    assert.deepEqual(restarted.messages(cursorBefore).messages, []);

    const after = host.observe({ kind: 'activity', at: T0 + 40 * MINUTE });
    assert.equal(after.ok, false);
    assert.equal(after.status, PRESENCE_WEB_STATUSES.CLOSED);
    assert.deepEqual(host.close(), { ok: true, persisted: false, alreadyClosed: true, dropped: 0 });
    assert.equal(host.setEnabled(true).enabled, false);
  });
});

test('journal carries kinds and timestamps only, never the prompt text', () => {
  const clock = makeClock();
  const events = [];
  const host = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    settings: SETTINGS,
    journal: (event) => events.push(event),
  });
  driveToWelcome(host, clock);
  host.setEnabled(false);

  assert.deepEqual(events.map((event) => event.type), ['presence-web-intent', 'presence-web-disabled']);
  assert.equal(events[0].kind, 'welcome-back');
  assert.equal(typeof events[0].at, 'string');
  assert.equal(events[1].dropped, 1);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(PRESENCE_INTERACTION_TEXT['welcome-back']), false);
  assert.equal(/text/.test(serialized), false);
});

test('constructor rejects programmer errors and normalises thresholds', () => {
  assert.throws(() => createPresenceWebHost({ journal: 'nope' }), TypeError);
  assert.throws(() => createPresenceWebHost({ store: { load() {} } }), TypeError);
  assert.throws(() => createPresenceWebHost({ store: { save() {} } }), TypeError);
  // 注入的 store 少了 clear：禁用就无法兑现「清掉旧状态」，构造时就拒收（fail-closed）。
  assert.throws(
    () => createPresenceWebHost({ store: { load() {}, save() {} } }),
    /must provide load\(\), save\(\) and clear\(\)/,
  );
  assert.throws(
    () => createPresenceWebHost({ store: { load() {}, save() {}, clear: 'nope' } }),
    TypeError,
  );

  const clock = makeClock();
  const host = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    stateFile: '',
    maxMessages: 0,
    settings: { idleMs: 'x', awayMs: -1, cooldownMs: null },
  });
  assert.equal(host.stats.maxMessages, PRESENCE_WEB_DEFAULT_MAX_MESSAGES);
  // 非法阈值退回状态机的安全默认，而不是让入口崩掉。
  assert.equal(host.stats.thresholds.idleMs > 0, true);
  assert.equal(host.stats.thresholds.awayMs >= host.stats.thresholds.idleMs, true);
  assert.equal(host.state, 'unknown');
});

test('signal flags are the documented content-blind triple', () => {
  assert.deepEqual({ ...PRESENCE_WEB_SIGNAL_FLAGS }, { activity: 'active', focus: 'focused', heartbeat: 'alive' });
  assert.equal(Object.isFrozen(PRESENCE_WEB_SIGNAL_FLAGS), true);
});

test('throwing injectors are contained: journal, clock and a broken store never escape the host', () => {
  // journal 抛错不能影响这一拍：欢迎照样交付。
  const clock = makeClock();
  const host = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    settings: SETTINGS,
    journal: () => {
      throw new Error('journal exploded');
    },
  });
  assert.equal(driveToWelcome(host, clock).returned.messages.length, 1);
  assert.equal(host.setEnabled(false).enabled, false);

  // 时钟抛错：没有可用时间就不猜，也不抛出去——结构化拒绝（clock-unavailable）。
  const events = [];
  const broken = createPresenceWebHost({
    enabled: true,
    now: () => {
      throw new Error('clock exploded');
    },
    settings: SETTINGS,
    journal: (event) => events.push(event),
  });
  const blind = broken.observe({ kind: 'activity' });
  assert.equal(blind.ok, false);
  assert.equal(blind.status, 'clock-unavailable');
  assert.equal(blind.state, 'unknown');
  assert.deepEqual(blind.events, []);
  assert.equal(broken.setEnabled(false).enabled, false);
  assert.deepEqual(events.at(-1), { type: 'presence-web-disabled', dropped: 0, cleared: true, at: null });

  // 读盘直接抛错：当成读盘失败，不启动、不覆盖。
  const loadThrows = createPresenceWebHost({
    enabled: true,
    stateFile: 'unused.json',
    now: clock.now,
    settings: SETTINGS,
    store: {
      file: 'memory://load-throws',
      load: () => {
        throw new Error('load exploded');
      },
      save: () => ({ ok: true, persisted: true }),
      clear: () => ({ ok: true }),
    },
  });
  assert.equal(loadThrows.status, PRESENCE_WEB_STATUSES.STATE_LOAD_FAILED);
  assert.equal(loadThrows.enabled, false);
  assert.deepEqual(
    loadThrows.diagnostics.find((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_LOAD_FAILED),
    { code: PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_LOAD_FAILED, detail: 'load-failed' },
  );

  // 写盘直接抛错：这一拍结构化失败，close() 也不抛。
  const saveThrows = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    settings: SETTINGS,
    store: {
      file: 'memory://save-throws',
      load: () => ({ ok: true, state: null, diagnostics: [{ code: 'absent' }] }),
      save: () => {
        throw new Error('save exploded');
      },
      clear: () => ({ ok: true }),
    },
  });
  const failedStep = saveThrows.observe({ kind: 'activity', at: T0 });
  assert.equal(failedStep.ok, false);
  assert.equal(failedStep.status, 'session-error');
  assert.deepEqual(saveThrows.close(), {
    ok: false,
    persisted: false,
    alreadyClosed: false,
    previousStatus: PRESENCE_WEB_STATUSES.READY,
    dropped: 0,
  });

  // clear() 抛错：禁用照样生效，不把异常抛给宿主。
  const clearThrows = createPresenceWebHost({
    enabled: true,
    now: clock.now,
    settings: SETTINGS,
    store: {
      file: 'memory://clear-throws',
      load: () => ({ ok: true, state: null, diagnostics: [{ code: 'absent' }] }),
      save: () => ({ ok: true, persisted: true }),
      clear: () => {
        throw new Error('clear exploded');
      },
    },
  });
  assert.equal(clearThrows.observe({ kind: 'activity', at: T0 }).state, 'present');
  // clear() 抛错＝清理失败：停用生效、异常不外抛，并落在固定诊断码上。
  assert.deepEqual(clearThrows.setEnabled(false), {
    enabled: false,
    status: PRESENCE_WEB_STATUSES.DISABLED,
    dropped: 0,
    cleared: false,
  });
  assert.equal(clearThrows.pending, 0);
  assert.equal(clearThrows.stats.clearPending, true);
  assert.deepEqual(
    clearThrows.diagnostics.map((entry) => entry.code),
    [PRESENCE_WEB_DIAGNOSTIC_CODES.DISABLED, PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_CLEAR_FAILED],
  );
  // 诊断是固定脱敏码：没有异常 message，也没有 store 的 file。
  const serialized = JSON.stringify(clearThrows.diagnostics);
  assert.equal(serialized.includes('clear exploded'), false);
  assert.equal(serialized.includes('memory://'), false);
  for (const entry of clearThrows.diagnostics) {
    assert.deepEqual(Object.keys(entry), ['code']);
  }
  // 清不干净就别想启用。
  assert.equal(clearThrows.setEnabled(true).enabled, false);
  assert.equal(clearThrows.status, PRESENCE_WEB_STATUSES.DISABLED);
});

test('a failed state clear keeps the host disabled and never adopts the old file as clean state', () => {
  const clock = makeClock();
  clock.set(T0 + 40 * MINUTE);
  let clearCalls = 0;
  let clearSucceeds = false;
  let statePresent = true;
  const staleState = {
    version: 1,
    state: 'present',
    updatedAt: T0 + 37 * MINUTE,
    sessionStartedAt: T0,
    activeMs: 37 * MINUTE,
    cooldowns: { welcome: T0 + 37 * MINUTE, break: null, proactive: null },
    deliveredIds: [],
  };
  const store = {
    file: 'memory://flaky-clear',
    load: () => (statePresent
      ? { ok: true, state: { ...staleState }, diagnostics: [] }
      : { ok: true, state: null, diagnostics: [{ code: 'absent' }] }),
    save: () => ({ ok: true, persisted: true }),
    clear: () => {
      clearCalls += 1;
      if (!clearSucceeds) return { ok: false, error: 'EPERM' };
      statePresent = false;
      return { ok: true };
    },
  };

  const host = createPresenceWebHost({ enabled: true, store, now: clock.now, settings: SETTINGS });
  assert.equal(host.restored, true);
  assert.equal(host.stats.session.cooldowns.welcome, T0 + 37 * MINUTE);

  // 禁用：清理返回 { ok:false }，必须当真。
  const disabled = host.setEnabled(false);
  assert.deepEqual(disabled, {
    enabled: false,
    status: PRESENCE_WEB_STATUSES.DISABLED,
    dropped: 0,
    cleared: false,
  });
  assert.equal(clearCalls, 1);
  assert.equal(host.status, PRESENCE_WEB_STATUSES.DISABLED);
  assert.equal(host.stats.clearPending, true);
  assert.deepEqual(
    host.diagnostics.map((entry) => entry.code),
    [PRESENCE_WEB_DIAGNOSTIC_CODES.DISABLED, PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_CLEAR_FAILED],
  );

  // 清理没成功：同一实例不许启用，也不建状态机。
  const blocked = host.setEnabled(true);
  assert.deepEqual(blocked, {
    enabled: false,
    status: PRESENCE_WEB_STATUSES.DISABLED,
    dropped: 0,
    cleared: false,
  });
  assert.equal(clearCalls, 2);
  assert.equal(host.state, 'unknown');
  assert.equal(host.observe({ kind: 'activity', at: T0 + 41 * MINUTE }).status, PRESENCE_WEB_STATUSES.DISABLED);

  // 重试清理成功后才允许启用，而且必须是干净启动：旧冷却不许被恢复。
  clearSucceeds = true;
  const enabled = host.setEnabled(true);
  assert.deepEqual(enabled, {
    enabled: true,
    status: PRESENCE_WEB_STATUSES.READY,
    dropped: 0,
    cleared: true,
  });
  assert.equal(clearCalls, 3);
  assert.equal(host.restored, false);
  assert.equal(host.stats.clearPending, false);
  assert.equal(host.stats.session.cooldowns.welcome, null);
  assert.equal(host.diagnostics.some((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.FRESH_START), true);
  assert.equal(host.diagnostics.some((entry) => entry.code === PRESENCE_WEB_DIAGNOSTIC_CODES.STATE_CLEAR_FAILED), false);
});

test('module is offline, timer-free, and imports only the presence pipeline', () => {
  const source = fs.readFileSync(new URL('../src/presence/web-host.js', import.meta.url), 'utf8');
  const importLines = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
  assert.deepEqual(
    importLines.map((line) => /from\s+(['"][^'"]+['"])/.exec(line)[1]),
    [
      "'node:crypto'",
      "'../presence-interaction.js'",
      "'../presence-runtime.js'",
      "'./persistence.js'",
      "'./session.js'",
    ],
  );
  for (const pattern of [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bcreateServer\b/,
    /\.listen\s*\(/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /\bchild_process\b/,
    /from\s+['"][^'"]*qq\.js['"]/,
    /from\s+['"][^'"]*server\.js['"]/,
    /\bprocess\.env\b/,
  ]) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in web-host.js: ' + pattern);
  }
});
