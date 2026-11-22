/**
 * presence/qq-adapter · 主动消息发送适配器的离线测试
 * ─────────────────────────────────────────────────────────────
 * sendText 全部是注入的桩（永不联网、不发真实 QQ、不调模型），时钟全部注入。
 *
 * 覆盖：默认关闭、sent/accepted/partial/failed/unknown/skipped 分类、
 * 失败/未知不自动重试、重复与队列上限、安静时段（数组与对象两种写法）、
 * 每日上限、最小间隔、跨重启台账、用户消息/离开状态使待发 intent 失效、
 * 写前日志失败 fail-closed、写后落盘失败不盲发、journal 内容盲、并发 flush。
 *
 * 与当前 fork 的差异：humanize.js 只导出 Humanizer（`say()` 返回 `{sent,parts}`，
 * 未确认时抛 `delivery-unconfirmed`），transport-onebot.js 的回执是
 * `{ receipt: { status: 'confirmed'|'rejected'|'unknown' } }`。这里用这些**真实形状**
 * 构造夹具，验证适配器的归一化；同时保留原工作树的 outcome / OneBot ok 形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPresenceQQAdapter, classifyPresenceDelivery, PRESENCE_QQ_DEFAULTS, PRESENCE_QQ_STATUSES } from '../src/presence/qq-adapter.js';
import { PRESENCE_LEDGER_STATUSES, PresenceStateStore } from '../src/presence/persistence.js';
import { createPresenceSession } from '../src/presence/session.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const MINUTE = 60 * 1000;

function intent(id, at = T0, kind = 'welcome-back', text = 'PING_TEXT') {
  return { id, kind, text, at };
}

/** 最小 session 桩：只实现 adapter 会用到的方法，便于单点断言。 */
function fakeSession(options = {}) {
  const entries = [];
  const cooldowns = { welcome: null, break: null, proactive: null };
  const session = {
    cooldowns,
    entries,
    hasSettled(id) {
      return entries.some((entry) => entry.id === id);
    },
    deliveredOn() {
      return entries.filter((entry) => entry.status === 'sent' || entry.status === 'accepted').length;
    },
    recordDelivery(record) {
      if (typeof options.recordDelivery === 'function') return options.recordDelivery(record, entries);
      entries.push({ id: record.id, status: record.status, at: record.at });
      return { ok: true, duplicate: false, persisted: true, hasStore: Boolean(options.hasStore) };
    },
    markProactive(at) {
      cooldowns.proactive = at;
    },
  };
  if (options.hasStore !== undefined) session.hasStore = options.hasStore;
  if (options.state !== undefined) session.state = options.state;
  return session;
}

/** 包一层记录调用的 sendText；不传 sendText 时默认返回带 message_id 的真回执。 */
function adapterOver(session, options = {}) {
  const calls = [];
  const now = { value: T0 };
  const { sendText, ...rest } = options;
  const adapter = createPresenceQQAdapter({
    session,
    now: () => now.value,
    sendText: async (text, meta) => {
      calls.push({ text, meta });
      return typeof sendText === 'function'
        ? sendText(text, meta)
        : { ok: true, data: { message_id: 'm-' + calls.length } };
    },
    ...rest,
  });
  return { adapter, calls, now };
}

test('defaults to disabled: nothing queues, nothing sends (C-P2)', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session);
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.onIntent(intent('w1')).reason, 'disabled');
  assert.equal(adapter.pendingCount, 0);
  const ticked = await adapter.tick(T0);
  assert.equal(ticked.status, 'disabled');
  assert.equal(calls.length, 0);
  assert.equal(PRESENCE_QQ_DEFAULTS.minGapMs, 15 * MINUTE);
  assert.equal(PRESENCE_QQ_DEFAULTS.maxPerDay, 2);
  assert.equal(Object.isFrozen(PRESENCE_QQ_DEFAULTS), true);
  assert.equal(Object.isFrozen(PRESENCE_QQ_STATUSES), true);
});

test('a real receipt settles delivery only when the platform confirms it', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true, sendText: async () => ({ ok: true, data: { message_id: 'm-1' } }) });
  assert.equal(adapter.onIntent(intent('w1')).accepted, true);
  const result = await adapter.tick(T0);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'sent');
  assert.equal(result.sent, 1);
  assert.equal(result.accepted, 0);
  assert.equal(result.delivered, 1);
  assert.equal(result.confirmed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].meta, { source: 'presence', kind: 'welcome-back', id: 'w1' });
  assert.equal(session.hasSettled('w1'), true);
  assert.equal(session.entries.at(-1).status, 'sent');
  assert.equal(session.cooldowns.proactive, T0);
  assert.equal(adapter.pendingCount, 0);
});

test('accepted stays accepted: it consumes quota but is never reported as sent/delivered', async () => {
  const session = fakeSession();
  const events = [];
  const { adapter } = adapterOver(session, {
    enabled: true,
    journal: (event) => events.push(event),
    sendText: async () => ({ ok: true }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted', 'platform ack without a receipt is accepted, not sent');
  assert.equal(result.sent, 0);
  assert.equal(result.accepted, 1);
  assert.equal(result.delivered, 1, 'accepted still consumes the anti-spam quota');
  assert.equal(result.confirmed, false);
  assert.equal(session.entries.at(-1).status, 'accepted', 'ledger keeps the accepted status');
  assert.equal(session.cooldowns.proactive, T0, 'accepted counts for the min-gap window');
  const delivery = events.find((event) => event.type === 'presence-delivery');
  assert.equal(delivery.status, 'accepted');
  assert.equal(delivery.confirmed, false);
  assert.equal(adapter.stats.accepted, 1);
  assert.equal(adapter.stats.confirmed, 0);
  assert.equal(adapter.stats.quotaSettled, 1);
});

test('explicit failure is recorded and never retried', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true, sendText: async () => ({ ok: false, error: 'offline' }) });
  adapter.onIntent(intent('w1'));
  const first = await adapter.tick(T0);
  assert.equal(first.ok, false);
  assert.equal(first.status, 'failed');
  assert.equal(first.sent, 0);
  const second = await adapter.tick(T0 + 1);
  assert.equal(second.status, 'idle', 'a failed intent is dropped, not retried');
  assert.equal(calls.length, 1);
  assert.equal(session.cooldowns.proactive, null, 'failure must not count as a proactive send');
  assert.equal(session.deliveredOn(), 0);
});

test('unknown outcome (throw / unrecognised) is neither success nor retried', async () => {
  const session = fakeSession();
  const throwing = adapterOver(session, { enabled: true, sendText: async () => { throw new Error('socket closed'); } });
  throwing.adapter.onIntent(intent('w1'));
  const thrown = await throwing.adapter.tick(T0);
  assert.equal(thrown.status, 'unknown');
  assert.equal(session.entries.at(-1).status, 'unknown');
  await throwing.adapter.tick(T0 + 1);
  assert.equal(throwing.calls.length, 1);

  const weirdSession = fakeSession();
  const weird = adapterOver(weirdSession, { enabled: true, sendText: async () => null });
  weird.adapter.onIntent(intent('w2'));
  assert.equal((await weird.adapter.tick(T0)).status, 'unknown');

  assert.equal(classifyPresenceDelivery(true), 'accepted');
  assert.equal(classifyPresenceDelivery({ outcome: 'partial', ok: false }), 'partial');
  assert.equal(classifyPresenceDelivery({ outcome: 'sideways' }), 'unknown');
  assert.equal(classifyPresenceDelivery({ foo: 1 }), 'unknown');
  assert.equal(classifyPresenceDelivery(undefined), 'unknown');
});

test('partial delivery is not reported as success and is not retried', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    sendText: async () => ({ ok: false, outcome: 'partial', sent: 1, failed: 1 }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'partial');
  assert.equal(session.deliveredOn(), 0);
  await adapter.tick(T0 + 1);
  assert.equal(calls.length, 1);
});

test('skipped / empty delivery is recorded as skipped without quota', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    sendText: async () => ({ outcome: 'empty', sent: 0, parts: [] }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'skipped');
  assert.equal(result.delivered, 0);
  assert.equal(session.entries.at(-1).status, 'skipped');
  assert.equal(adapter.stats.skipped, 1);
  assert.equal(session.deliveredOn(), 0, 'skipped never consumes quota');
  await adapter.tick(T0 + 1);
  assert.equal(calls.length, 1);
});

test('classifies the fork receipt shapes: transport receipt, Humanizer error, OneBot envelope', () => {
  // transport-onebot.js：{ ...result, receipt: { status, messageId } }
  assert.equal(classifyPresenceDelivery({ ok: true, receipt: { status: 'confirmed', messageId: 'm-9' } }), 'sent');
  assert.equal(classifyPresenceDelivery({ ok: false, receipt: { status: 'rejected' } }), 'failed');
  assert.equal(classifyPresenceDelivery({ ok: true, receipt: { status: 'unknown' } }), 'unknown');
  assert.equal(classifyPresenceDelivery({ receipt: { status: 'delivered' } }), 'unknown');
  assert.equal(classifyPresenceDelivery({ receipt: 'confirmed' }), 'unknown');

  // Humanizer 的真实错误形状：code + status + sent
  const rejectedError = Object.assign(new Error('发送未确认'), { code: 'delivery-unconfirmed', status: 'rejected', sent: 1 });
  const unknownError = Object.assign(new Error('发送未确认'), { code: 'delivery-unconfirmed', status: 'unknown', sent: 0 });
  assert.equal(classifyPresenceDelivery(null, rejectedError), 'failed', 'a rejected receipt is an explicit failure');
  assert.equal(classifyPresenceDelivery(null, unknownError), 'unknown', 'a timeout is not an explicit failure');
  assert.equal(classifyPresenceDelivery(null, new Error('boom')), 'unknown');
  assert.equal(classifyPresenceDelivery(null, 'plain string error'), 'unknown');

  // humanize.summarizeDelivery 的 outcome（原工作树的形状，继续兼容）
  assert.equal(classifyPresenceDelivery({ outcome: 'sent' }), 'sent');
  assert.equal(classifyPresenceDelivery({ outcome: 'accepted' }), 'accepted');
  assert.equal(classifyPresenceDelivery({ outcome: 'failed' }), 'failed');
  assert.equal(classifyPresenceDelivery({ outcome: 'unknown' }), 'unknown');

  // 明确失败优先：矛盾输入绝不能被别处的 confirmed 洗成送达。
  assert.equal(classifyPresenceDelivery({ ok: false, receipt: { status: 'confirmed', messageId: 'm-1' } }), 'failed');
  assert.equal(classifyPresenceDelivery({ ok: false, status: 'sent' }), 'failed');
  assert.equal(classifyPresenceDelivery({ ok: false, receipt: { status: 'confirmed' }, errorCode: 'transport-timeout' }), 'unknown');
  // outcome 与 ok 冲突时同样不猜。
  assert.equal(classifyPresenceDelivery({ outcome: 'sent', ok: false }), 'unknown');
  assert.equal(classifyPresenceDelivery({ outcome: 'accepted', ok: false }), 'unknown');
  assert.equal(classifyPresenceDelivery({ outcome: 'failed', ok: false }), 'failed');
  assert.equal(classifyPresenceDelivery({ outcome: 'empty', ok: false }), 'skipped');
  // ok:true 也不是免检通行证：receipt/status 说失败就是失败。
  assert.equal(classifyPresenceDelivery({ ok: true, receipt: { status: 'rejected' } }), 'failed');
  assert.equal(classifyPresenceDelivery({ ok: true, status: 'failed' }), 'failed');
  assert.equal(classifyPresenceDelivery({ ok: true, receipt: { status: 'confirmed' } }), 'accepted', 'no id → not confirmed');

  // sent 必须有可核对凭据：只写 status/receipt 却没有 message id 的降级成 accepted。
  assert.equal(classifyPresenceDelivery({ status: 'sent' }), 'accepted', 'no message id means no confirmed delivery');
  assert.equal(classifyPresenceDelivery({ receipt: { status: 'confirmed' } }), 'accepted');
  assert.equal(classifyPresenceDelivery({ receipt: { status: 'confirmed', messageId: 'm-2' } }), 'sent');
  assert.equal(classifyPresenceDelivery({ status: 'sent', messageId: 'm-3' }), 'sent');

  // 本 fork Humanizer.say() 的真实成功形状 { sent, parts }：没有消息 id，
  // 因此最多记 accepted（计额度、不算确认送达），段数对不上记 partial。
  assert.equal(classifyPresenceDelivery({ sent: 2, parts: ['a', 'b'] }), 'accepted');
  assert.equal(classifyPresenceDelivery({ sent: 1, parts: ['a', 'b'] }), 'partial');
  assert.equal(classifyPresenceDelivery({ sent: 0, parts: ['a'] }), 'unknown');
  assert.equal(classifyPresenceDelivery({ sent: 0, parts: [] }), 'skipped');
  assert.equal(classifyPresenceDelivery({ sent: 'nope', parts: ['a'] }), 'unknown');

  // 已归一化 status / OneBot 信封 / transport-* 分类
  assert.equal(classifyPresenceDelivery({ status: 'accepted' }), 'accepted');
  assert.equal(classifyPresenceDelivery({ status: 'nonsense' }), 'unknown');
  assert.equal(classifyPresenceDelivery({ ok: false, errorCode: 'transport-timeout' }), 'unknown');
  assert.equal(classifyPresenceDelivery({ ok: false, category: 'transport-unknown' }), 'unknown');
  assert.equal(classifyPresenceDelivery({ ok: true, data: { data: { message_id: '0' } } }), 'accepted');
  assert.equal(classifyPresenceDelivery({ ok: true, data: { message_id: 42 } }), 'sent');
  assert.equal(classifyPresenceDelivery({ ok: true, messageId: 'm-5' }), 'sent');
  assert.equal(classifyPresenceDelivery({ ok: true, data: { messageId: 'm-6' } }), 'sent');
  assert.equal(classifyPresenceDelivery({ ok: 'maybe' }), 'unknown');
});

test('delivery statuses are exactly the documented closed set', () => {
  assert.deepEqual([...PRESENCE_QQ_STATUSES], [
    'sent', 'accepted', 'partial', 'failed', 'unknown', 'skipped', 'idle', 'disabled',
    'quiet-hours', 'daily-cap', 'min-gap', 'not-present', 'persist-failed', 'duplicate',
    'clock-unavailable',
  ]);
  // adapter 落台账的状态必须都在 persistence 的封闭词表里，否则 session 会拒写。
  for (const status of ['sent', 'accepted', 'partial', 'failed', 'unknown', 'skipped', 'attempting']) {
    assert.equal(PRESENCE_LEDGER_STATUSES.includes(status), true, 'ledger must accept ' + status);
  }
});

test('duplicate intents and already-settled ids are rejected', async () => {
  const session = fakeSession();
  const { adapter } = adapterOver(session, { enabled: true });
  assert.equal(adapter.onIntent(intent('w1')).accepted, true);
  assert.equal(adapter.onIntent(intent('w1')).reason, 'duplicate');
  assert.equal(adapter.pendingCount, 1);
  session.recordDelivery({ id: 'w0', status: 'sent', at: T0 });
  assert.equal(adapter.onIntent(intent('w0')).reason, 'duplicate');
  assert.equal(adapter.onIntent({ id: '', kind: 'x', text: 't' }).reason, 'invalid-intent');
  assert.equal(adapter.onIntent(null).reason, 'invalid-intent');
  assert.equal(adapter.onIntent({ id: 'w9', kind: '', text: 't' }).reason, 'invalid-intent');
  assert.equal(adapter.onIntent({ id: 'w9', kind: 'k', text: '' }).reason, 'invalid-intent');
});

test('an intent whose timestamp cannot be parsed is rejected instead of queued', async () => {
  const session = fakeSession();
  const { adapter } = adapterOver(session, { enabled: true });
  assert.equal(adapter.onIntent({ id: 'w1', kind: 'k', text: 't', at: 'not-a-date' }).reason, 'invalid-intent');
  assert.equal(adapter.pendingCount, 0);
  // 非数字/字符串/Date 的类型一律解析不出时间。
  assert.equal(adapter.onIntent({ id: 'w1b', kind: 'k', text: 't', at: true }).reason, 'invalid-intent');
  assert.equal(adapter.onIntent({ id: 'w1c', kind: 'k', text: 't', at: {} }).reason, 'invalid-intent');
  // 没给 at：用注入时钟补一个时间基准。
  assert.equal(adapter.onIntent({ id: 'w2', kind: 'k', text: 't' }).accepted, true);
  // 合法字符串 / Date 都接受。
  assert.equal(adapter.onIntent({ id: 'w3', kind: 'k', text: 't', at: new Date(T0).toISOString() }).accepted, true);
  assert.equal(adapter.onIntent({ id: 'w4', kind: 'k', text: 't', at: new Date(T0 + 1_000) }).accepted, true);
});

test('a queued intent that is already on the ledger is dropped, never resent', async () => {
  // 写前日志「没写进盘但内存台账已经记了 attempting」：下一次 tick 必须认出来、
  // 出队并不发送，而不是当成新消息再赌一次。
  const entries = [];
  const session = fakeSession({
    hasStore: true,
    recordDelivery: (record, journal) => {
      entries.push({ id: record.id, status: record.status, at: record.at });
      journal.push({ id: record.id, status: record.status, at: record.at });
      return { ok: true, persisted: false, hasStore: true };
    },
  });
  const { adapter, calls } = adapterOver(session, { enabled: true });
  adapter.onIntent(intent('w1'));
  assert.equal((await adapter.tick(T0)).status, 'persist-failed');
  assert.equal(adapter.pendingCount, 1);
  const blocked = await adapter.tick(T0 + 1_000);
  assert.equal(blocked.status, 'duplicate');
  assert.equal(blocked.sent, 0);
  assert.equal(calls.length, 0, 'a pending id already on the ledger is never sent');
  assert.equal(adapter.pendingCount, 0);
  assert.ok(adapter.stats.duplicates >= 1);
});

test('queue is bounded and rejects overflow instead of dropping silently', async () => {
  const session = fakeSession();
  const { adapter } = adapterOver(session, { enabled: true, maxPending: 1 });
  assert.equal(adapter.onIntent(intent('w1')).accepted, true);
  assert.equal(adapter.onIntent(intent('w2')).reason, 'queue-full');
  assert.equal(adapter.pendingCount, 1);
  assert.equal(adapter.stats.maxPending, 1);
});

test('invalid options fall back to defaults instead of weakening the gates', async () => {
  const session = fakeSession();
  const { adapter } = adapterOver(session, { enabled: true, minGapMs: 'nope', maxPerDay: -3, maxPending: 0, intentTtlMs: -1 });
  assert.equal(adapter.stats.minGapMs, PRESENCE_QQ_DEFAULTS.minGapMs);
  assert.equal(adapter.stats.maxPerDay, PRESENCE_QQ_DEFAULTS.maxPerDay);
  assert.equal(adapter.stats.maxPending, PRESENCE_QQ_DEFAULTS.maxPending);
  assert.equal(adapter.stats.intentTtlMs, PRESENCE_QQ_DEFAULTS.intentTtlMs);
  assert.equal(adapter.stats.quietHours, null);

  const zeroCap = adapterOver(fakeSession(), { enabled: true, maxPerDay: 0 });
  zeroCap.adapter.onIntent(intent('z1'));
  assert.equal((await zeroCap.adapter.tick(T0)).status, 'daily-cap', 'maxPerDay=0 means no proactive message at all');

  // null / '' 与原模块同口径：折成 0，也就是当天一条都不发（fail-closed），
  // 而不是悄悄回落到默认 2。
  for (const value of [null, '']) {
    const capped = adapterOver(fakeSession(), { enabled: true, maxPerDay: value });
    capped.adapter.onIntent(intent('z2'));
    assert.equal((await capped.adapter.tick(T0)).status, 'daily-cap', 'maxPerDay=' + JSON.stringify(value));
  }
});

test('clock failures are reported, never guessed', async () => {
  const session = fakeSession();
  const adapter = createPresenceQQAdapter({
    session,
    enabled: true,
    now: () => { throw new Error('no clock'); },
    sendText: async () => ({ ok: true, data: { message_id: 'm-1' } }),
  });
  assert.equal(adapter.onIntent({ id: 'w1', kind: 'k', text: 't' }).accepted, true);
  assert.equal((await adapter.tick()).status, 'clock-unavailable');
  assert.equal((await adapter.flush()).status, 'clock-unavailable');
  assert.equal((await adapter.tick('garbage')).status, 'clock-unavailable');
  assert.deepEqual(adapter.noteUserMessage(), { invalidated: 0, reason: 'clock-unavailable' });
  assert.equal(adapter.pendingCount, 1);
});

test('quiet hours hold the intent without sending or dropping it', async () => {
  const session = fakeSession();
  const quietHour = new Date(2026, 9, 29, 23, 30, 0, 0).getTime();
  const morning = new Date(2026, 9, 30, 8, 30, 0, 0).getTime();
  const { adapter, calls, now } = adapterOver(session, {
    enabled: true,
    quietHours: [23, 7],
    intentTtlMs: 24 * 60 * MINUTE,
  });
  now.value = quietHour;
  adapter.onIntent(intent('w1', quietHour));
  const held = await adapter.tick(quietHour);
  assert.equal(held.status, 'quiet-hours');
  assert.equal(calls.length, 0);
  assert.equal(adapter.pendingCount, 1, 'the intent waits, it is not lost');
  assert.ok(adapter.stats.quietHoursSkips >= 1);

  now.value = morning;
  const sent = await adapter.tick(morning);
  assert.equal(sent.status, 'sent');
  assert.equal(calls.length, 1);
});

test('quiet hours accept the object form used by presenceQQ config', async () => {
  const quietHour = new Date(2026, 9, 29, 23, 30, 0, 0).getTime();
  const { adapter, calls } = adapterOver(fakeSession(), { enabled: true, quietHours: { start: 23, end: 7 } });
  adapter.onIntent(intent('w1', quietHour));
  assert.equal((await adapter.tick(quietHour)).status, 'quiet-hours');
  assert.equal(calls.length, 0);
  assert.deepEqual(adapter.stats.quietHours, { start: 23, end: 7 });
});

test('a quiet-hours backlog is dropped once the user has left (no late welcome)', async () => {
  const session = fakeSession({ state: 'present' });
  const quietHour = new Date(2026, 9, 29, 23, 30, 0, 0).getTime();
  const morning = new Date(2026, 9, 30, 8, 30, 0, 0).getTime();
  // intentTtlMs: 0 关掉 TTL 过期，专门验证「在场状态」这道闸门。
  const { adapter, calls, now } = adapterOver(session, { enabled: true, quietHours: [23, 7], intentTtlMs: 0 });
  now.value = quietHour;
  adapter.onIntent(intent('w1', quietHour));
  assert.equal((await adapter.tick(quietHour)).status, 'quiet-hours');
  assert.equal(adapter.pendingCount, 1);

  session.state = 'away';
  const held = await adapter.tick(morning);
  assert.equal(held.status, 'not-present');
  assert.equal(held.sent, 0);
  assert.equal(calls.length, 0, 'a stale welcome is never sent after the user left');
  assert.equal(adapter.pendingCount, 0);
  assert.ok(adapter.stats.notPresentDrops >= 1);
  assert.equal(held.reason, 'presence-away');

  session.state = 'present';
  assert.equal((await adapter.tick(morning + 1_000)).status, 'idle');
  assert.equal(calls.length, 0);

  // 显式同步状态也可以立刻作废（S1 可选接线）。
  adapter.onIntent(intent('w2', morning + 2_000));
  assert.deepEqual(adapter.notePresenceState('away', morning + 2_000), { dropped: 1, pending: 0 });
  assert.deepEqual(adapter.notePresenceState('present', morning + 3_000), { dropped: 0, pending: 0 });
  // 非字符串状态按 unknown 处理，同样不发送。
  adapter.onIntent(intent('w3', morning + 4_000));
  assert.deepEqual(adapter.notePresenceState(null, morning + 4_000), { dropped: 1, pending: 0 });
});

test('a failed ledger write before sending aborts the send (fail-closed, no blind send)', async () => {
  const session = fakeSession({
    hasStore: true,
    recordDelivery: () => ({ ok: true, duplicate: false, persisted: false, hasStore: true }),
  });
  const { adapter, calls } = adapterOver(session, { enabled: true });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'persist-failed');
  assert.equal(result.sent, 0);
  assert.equal(result.accepted, 0);
  assert.equal(result.delivered, 0);
  assert.equal(calls.length, 0, 'no message may be sent when the attempt cannot be recorded');
  assert.equal(adapter.pendingCount, 1, 'the intent stays queued for a later write retry');
  assert.ok(adapter.stats.persistFailures >= 1);

  const throwing = fakeSession({ hasStore: true, recordDelivery: () => { throw new Error('disk full'); } });
  const second = adapterOver(throwing, { enabled: true });
  second.adapter.onIntent(intent('w1'));
  assert.equal((await second.adapter.tick(T0)).status, 'persist-failed');
  assert.equal(second.calls.length, 0);

  // 台账明确拒绝写入（ok:false）同样 fail-closed —— 这是 fork 里 session.recordDelivery
  // 对非法状态/时钟不可用的真实返回形状。
  const refusing = fakeSession({ hasStore: true, recordDelivery: () => ({ ok: false, reason: 'invalid-entry', persisted: false, hasStore: true }) });
  const third = adapterOver(refusing, { enabled: true });
  third.adapter.onIntent(intent('w1'));
  assert.equal((await third.adapter.tick(T0)).status, 'persist-failed');
  assert.equal(third.calls.length, 0);

  // hasStore 通过 stats 暴露（没有布尔 getter 的 session）也要认出来。
  const statsOnly = fakeSession({
    recordDelivery: () => ({ ok: true, persisted: false }),
  });
  statsOnly.stats = { hasStore: true };
  const fourth = adapterOver(statsOnly, { enabled: true });
  fourth.adapter.onIntent(intent('w1'));
  assert.equal((await fourth.adapter.tick(T0)).status, 'persist-failed');
  assert.equal(fourth.calls.length, 0);

  // 纯内存 session：没有 recordDelivery 也没有 store → 仍然可以发（不假装持久化）。
  const memoryOnly = adapterOver({}, { enabled: true });
  memoryOnly.adapter.onIntent(intent('w1'));
  assert.equal((await memoryOnly.adapter.tick(T0)).status, 'sent');

  // store 存在但没有 recordDelivery：写不进盘 → fail-closed。
  const noRecorder = adapterOver({ hasStore: true }, { enabled: true });
  noRecorder.adapter.onIntent(intent('w1'));
  assert.equal((await noRecorder.adapter.tick(T0)).status, 'persist-failed');
  assert.equal(noRecorder.calls.length, 0);
});

test('a ledger write that fails after sending still prevents a blind resend after restart', async () => {
  const entries = [];
  const session = fakeSession({
    hasStore: true,
    recordDelivery: (record) => {
      if (record.status === 'attempting') {
        entries.push({ id: record.id, status: record.status, at: record.at });
        return { ok: true, duplicate: false, persisted: true, hasStore: true };
      }
      return { ok: false, persisted: false, hasStore: true };
    },
  });
  const events = [];
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    journal: (event) => events.push(event),
    sendText: async () => ({ ok: true, data: { message_id: 'm-1' } }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'sent');
  assert.equal(result.persisted, false, 'the caller is told the final settlement did not persist');
  assert.equal(result.reason, 'ledger-write-failed');
  assert.equal(calls.length, 1);
  assert.deepEqual(entries.map((entry) => entry.status), ['attempting']);
  const afterSend = events.find((event) => event.type === 'presence-persist-failed' && event.stage === 'after-send');
  assert.equal(afterSend.status, 'sent');

  // 重启：盘上只有 attempting；同一条 intent 不会被当成没发过再发一次。
  const restarted = fakeSession({ hasStore: true });
  restarted.entries.push(...entries);
  const second = adapterOver(restarted, { enabled: true });
  assert.equal(second.adapter.onIntent(intent('w1')).reason, 'duplicate');
  assert.equal((await second.adapter.tick(T0 + 1)).status, 'idle');
  assert.equal(second.calls.length, 0);
});

test('min gap blocks back-to-back proactive messages', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true, minGapMs: 15 * MINUTE });
  adapter.onIntent(intent('w1'));
  assert.equal((await adapter.tick(T0)).status, 'sent');
  adapter.onIntent(intent('b1', T0 + 1_000, 'break-reminder'));
  const blocked = await adapter.tick(T0 + 1_000);
  assert.equal(blocked.status, 'min-gap');
  assert.equal(calls.length, 1);
  assert.ok(adapter.stats.minGapSkips >= 1);
  const later = await adapter.tick(T0 + 16 * MINUTE);
  assert.equal(later.status, 'sent');
  assert.equal(calls.length, 2);

  // 已经开着时再次 setEnabled(true) 是幂等的：不丢队列、不误判间隔。
  const odd = adapterOver(fakeSession(), { enabled: true, minGapMs: 15 * MINUTE });
  odd.adapter.onIntent(intent('w9'));
  assert.deepEqual(odd.adapter.setEnabled(true), { enabled: true, dropped: 0 });
  assert.equal(odd.adapter.pendingCount, 1, 're-enabling keeps the queue');
  assert.equal((await odd.adapter.tick(T0)).status, 'sent');
});

test('daily cap stops the third proactive message', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true, minGapMs: 0, maxPerDay: 2 });
  const times = [T0, T0 + 1_000, T0 + 2_000];
  for (let i = 0; i < times.length; i++) {
    adapter.onIntent(intent('i' + i, times[i]));
    const result = await adapter.tick(times[i]);
    if (i < 2) assert.equal(result.status, 'sent');
    else assert.equal(result.status, 'daily-cap');
  }
  assert.equal(calls.length, 2);
  assert.equal(adapter.pendingCount, 1);
  assert.ok(adapter.stats.dailyCapSkips >= 1);
});

test('daily cap and proactive gap survive a restart through the session ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-adapter-'));
  try {
    const store = new PresenceStateStore({ file: path.join(dir, 'presence-qq-state.json'), now: () => T0 + 5 * MINUTE });
    const runtime = {
      state: 'present',
      observeActivity() {},
      observeWindowFocus() {},
      observeHeartbeat() {},
      tick() {},
      consumeEvents: () => [],
      restore: () => ({ accepted: true }),
    };
    const session = createPresenceSession({ runtime, policy: null, store, now: () => T0 + 5 * MINUTE });
    const calls = [];
    const first = createPresenceQQAdapter({
      session,
      enabled: true,
      minGapMs: 0,
      maxPerDay: 2,
      now: () => T0,
      sendText: async (text) => { calls.push(text); return { ok: true, data: { message_id: 'm-' + calls.length } }; },
    });
    first.onIntent(intent('p1'));
    assert.equal((await first.tick(T0)).status, 'sent');
    first.onIntent(intent('p2', T0 + 1_000));
    assert.equal((await first.tick(T0 + 1_000)).status, 'sent');
    assert.equal(session.close().ok, true);

    const restartedRuntime = { ...runtime, state: 'unknown' };
    const restarted = createPresenceSession({ runtime: restartedRuntime, policy: null, store, now: () => T0 + 5 * MINUTE });
    assert.equal(restarted.restore().ok, true);
    const second = createPresenceQQAdapter({
      session: restarted,
      enabled: true,
      minGapMs: 0,
      maxPerDay: 2,
      now: () => T0 + 5 * MINUTE,
      sendText: async (text) => { calls.push(text); return { ok: true, data: { message_id: 'm-' + calls.length } }; },
    });
    second.onIntent(intent('p3', T0 + 5 * MINUTE));
    const blocked = await second.tick(T0 + 5 * MINUTE);
    assert.equal(blocked.status, 'daily-cap', 'the two sends today are remembered after restart');
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an accepted-but-unpersisted send reports the gap and is never resent', async () => {
  // accepted 走「发送成功但最终状态没落盘」这条路：仍然算一次额度消耗，
  // 但必须明确告诉调用方 persisted:false，并留 after-send journal 证据。
  const events = [];
  const session = fakeSession({
    hasStore: true,
    recordDelivery: (record) => (record.status === 'attempting'
      ? { ok: true, persisted: true, hasStore: true }
      : { ok: true, persisted: false, hasStore: true }),
  });
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    journal: (event) => events.push(event),
    sendText: async () => ({ ok: true }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'accepted');
  assert.equal(result.persisted, false);
  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 1);
  assert.equal(session.cooldowns.proactive, T0, 'an accepted send still opens the min-gap window');
  assert.equal(adapter.stats.persistFailures, 1);
  const gap = events.find((event) => event.type === 'presence-persist-failed' && event.stage === 'after-send');
  assert.equal(gap.status, 'accepted');
  assert.equal((await adapter.tick(T0 + 1_000)).status, 'idle', 'the intent is gone: never resent');
  assert.equal(calls.length, 1);
});

test('a journal sink that throws on the persist-failed path still fails closed', async () => {
  const session = fakeSession({ hasStore: true, recordDelivery: () => ({ ok: true, persisted: false, hasStore: true }) });
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    journal: () => { throw new Error('sink down'); },
    sendText: async () => ({ ok: true, data: { message_id: 'm-1' } }),
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'persist-failed');
  assert.equal(calls.length, 0, 'a broken journal can never turn into a blind send');
  assert.equal(adapter.pendingCount, 1);
});

test('a normal user message invalidates stale queued intents', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true });
  adapter.onIntent(intent('w1', T0));
  adapter.onIntent(intent('w2', T0 + 1_000));
  const invalidated = adapter.noteUserMessage(T0 + 500);
  assert.equal(invalidated.invalidated, 1, 'intents older than the user message are dropped');
  assert.equal(invalidated.pending, 1);
  assert.equal(adapter.onIntent(intent('old', T0 + 400)).reason, 'stale-after-user-message');
  assert.equal((await adapter.tick(T0 + 2_000)).status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.id, 'w2');
});

test('disabling clears the queue and stops sending', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true });
  adapter.onIntent(intent('w1'));
  assert.deepEqual(adapter.setEnabled(false), { enabled: false, dropped: 1 });
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.onIntent(intent('w2')).reason, 'disabled');
  assert.equal((await adapter.tick(T0)).status, 'disabled');
  assert.equal(calls.length, 0);
  adapter.setEnabled(true);
  assert.equal(adapter.onIntent(intent('w3')).accepted, true);
  assert.equal((await adapter.flush()).status, 'sent');
  assert.equal(adapter.stats.intentsInvalidated, 1);
});

test('concurrent flush calls share one in-flight send', async () => {
  const session = fakeSession();
  let resolveSend;
  let calls = 0;
  const adapter = createPresenceQQAdapter({
    session,
    enabled: true,
    now: () => T0,
    sendText: () => new Promise((resolve) => { calls += 1; resolveSend = resolve; }),
  });
  adapter.onIntent(intent('w1'));
  const a = adapter.flush();
  const b = adapter.flush();
  assert.equal(a, b, 'overlapping flush() calls share the same promise');
  resolveSend({ ok: true, data: { message_id: 'm-1' } });
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'sent');
  assert.equal(calls, 1);
  // 发完之后锁释放：下一次 flush 可以继续（队列空 → idle）。
  assert.equal((await adapter.flush()).status, 'idle');
  // tick 与 flush 共用同一把锁。
  adapter.onIntent(intent('w2', T0 + 1_000));
  const ticked = adapter.tick(T0 + 1_000);
  const flushed = adapter.flush();
  assert.equal(ticked, flushed, 'tick() and flush() share the in-flight promise');
  assert.equal((await ticked).status, 'min-gap', 'the gates still apply to the shared attempt');
});

test('expired intents are dropped instead of being sent late', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, { enabled: true, intentTtlMs: 60_000 });
  adapter.onIntent(intent('w1', T0));
  const result = await adapter.tick(T0 + 61_000);
  assert.equal(result.status, 'idle');
  assert.equal(calls.length, 0);
  assert.ok(adapter.stats.intentsExpired >= 1);
});

test('journal records intents and settlements without any message text', async () => {
  const session = fakeSession();
  const events = [];
  const { adapter } = adapterOver(session, { enabled: true, journal: (event) => events.push(event) });
  adapter.onIntent(intent('w1', T0, 'welcome-back', 'SECRET_PING_TEXT'));
  await adapter.tick(T0);
  const journaled = JSON.stringify(events);
  assert.equal(journaled.includes('SECRET_PING_TEXT'), false);
  assert.equal(journaled.includes('"text"'), false);
  assert.deepEqual(events.map((event) => event.type), ['presence-intent', 'presence-delivery']);
  assert.equal(events[0].kind, 'welcome-back');
  assert.equal(events[1].status, 'sent');
  assert.equal(typeof events[1].at, 'number');

  // 抛错路径的 journal 只写异常名/错误码，不写 message —— message 里可能夹着
  // 平台原文、URL、token 或正文，而 journal 要落盘。
  const throwingEvents = [];
  const throwing = adapterOver(fakeSession(), {
    enabled: true,
    journal: (event) => throwingEvents.push(event),
    sendText: async () => {
      const error = new Error('SECRET_PING_TEXT at https://example.invalid?token=SECRET');
      error.name = 'SocketError';
      throw error;
    },
  });
  throwing.adapter.onIntent(intent('w2', T0, 'break-reminder', 'SECRET_PING_TEXT'));
  await throwing.adapter.tick(T0);
  const throwingJournal = JSON.stringify(throwingEvents);
  assert.equal(throwingJournal.includes('SECRET_PING_TEXT'), false, 'raw error text never reaches the journal');
  assert.equal(throwingJournal.includes('SECRET'), false, 'tokens never reach the journal');
  assert.deepEqual(throwingEvents.at(-1).error, { name: 'SocketError' });

  // delivery-unconfirmed 只额外带固定 code，同样没有 message。
  const codedEvents = [];
  const coded = adapterOver(fakeSession(), {
    enabled: true,
    journal: (event) => codedEvents.push(event),
    sendText: async () => {
      throw Object.assign(new Error('SECRET_PING_TEXT'), { code: 'delivery-unconfirmed', status: 'rejected', sent: 1 });
    },
  });
  coded.adapter.onIntent(intent('w3', T0));
  assert.equal((await coded.adapter.tick(T0)).status, 'failed');
  assert.deepEqual(codedEvents.at(-1).error, { name: 'Error', code: 'delivery-unconfirmed' });
});

test('a journal that throws cannot break delivery accounting', async () => {
  const session = fakeSession();
  const { adapter, calls } = adapterOver(session, {
    enabled: true,
    journal: () => { throw new Error('journal sink down'); },
  });
  adapter.onIntent(intent('w1'));
  const result = await adapter.tick(T0);
  assert.equal(result.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(session.entries.at(-1).status, 'sent');

  // 非 Error 的抛出也会被结构化描述，且不影响记账。
  const odd = adapterOver(fakeSession(), { enabled: true, sendText: async () => { throw 'string failure'; } });
  odd.adapter.onIntent(intent('w2'));
  assert.equal((await odd.adapter.tick(T0)).status, 'unknown');
});

test('real Humanizer.say output is consumed as accepted, never as confirmed delivery', async () => {
  // 用真实 Humanizer（关掉拟人化等待）验证 fork 里的真实返回形状：
  // say() 成功 → { sent, parts }，没有消息 id → accepted；未确认 → 抛错 → failed/unknown。
  const { Humanizer } = await import('../src/humanize.js');
  const human = new Humanizer({ enabled: false });

  const okSession = fakeSession();
  const ok = adapterOver(okSession, {
    enabled: true,
    sendText: async (text, meta) => human.say(text, {
      send: async () => ({ receipt: { status: 'confirmed', messageId: meta.id + '-m1' } }),
    }),
  });
  ok.adapter.onIntent(intent('w1', T0, 'welcome-back', '第一段\n第二段'));
  const accepted = await ok.adapter.tick(T0);
  assert.equal(accepted.status, 'accepted', 'say() gives no message id, so it cannot be called sent');
  assert.equal(accepted.confirmed, false);
  assert.equal(accepted.delivered, 1, 'accepted still consumes the anti-spam quota');
  assert.equal(okSession.entries.at(-1).status, 'accepted');

  const rejectedSession = fakeSession();
  const rejected = adapterOver(rejectedSession, {
    enabled: true,
    sendText: async (text) => human.say(text, { send: async () => ({ receipt: { status: 'rejected' } }) }),
  });
  rejected.adapter.onIntent(intent('w2', T0));
  assert.equal((await rejected.adapter.tick(T0)).status, 'failed');
  assert.equal(rejectedSession.entries.at(-1).status, 'failed');
  assert.equal(rejectedSession.deliveredOn(), 0);

  const unknownSession = fakeSession();
  const unknown = adapterOver(unknownSession, {
    enabled: true,
    sendText: async (text) => human.say(text, { send: async () => { throw new Error('socket hang up'); } }),
  });
  unknown.adapter.onIntent(intent('w3', T0));
  assert.equal((await unknown.adapter.tick(T0)).status, 'unknown');
  assert.equal(unknownSession.deliveredOn(), 0);
  await unknown.adapter.tick(T0 + 1_000);
  assert.equal(unknown.adapter.pendingCount, 0, 'unknown is never retried');
});

test('constructor rejects missing pieces and tolerates a minimal session', async () => {
  assert.throws(() => createPresenceQQAdapter({}), TypeError);
  assert.throws(() => createPresenceQQAdapter({ session: null }), TypeError);
  assert.throws(() => createPresenceQQAdapter({ session: {}, sendText: 1 }), TypeError);
  assert.throws(() => createPresenceQQAdapter({ session: {}, sendText: async () => ({ ok: true }), journal: 1 }), TypeError);

  const minimal = {};
  const adapter = createPresenceQQAdapter({ session: minimal, sendText: async () => ({ ok: true, data: { message_id: 'm-1' } }), enabled: true, now: () => T0 });
  adapter.onIntent(intent('w1'));
  assert.equal((await adapter.tick(T0)).status, 'sent');

  // 没有时钟注入 / 注入了非函数：退回 Date.now()，而不是抛错或停摆。
  const noClock = createPresenceQQAdapter({ session: {}, sendText: async () => ({ ok: true }), enabled: true });
  assert.equal(noClock.onIntent({ id: 'w2', kind: 'k', text: 't' }).accepted, true);
  assert.equal((await noClock.flush()).status, 'accepted');
  const badClock = createPresenceQQAdapter({ session: {}, sendText: async () => ({ ok: true }), enabled: true, now: 'not-a-function' });
  assert.equal(badClock.onIntent({ id: 'w3', kind: 'k', text: 't' }).accepted, true);
  assert.equal((await badClock.tick()).status, 'accepted');
});

test('module is offline, timer-free and does not import the entry points', () => {
  const source = fs.readFileSync(new URL('../src/presence/qq-adapter.js', import.meta.url), 'utf8');
  const importLines = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
  assert.deepEqual(importLines.map((line) => /from\s+(['"][^'"]+['"])/.exec(line)[1]), [
    "'../followup-policy.js'",
  ]);
  for (const pattern of [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /['"]node:/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /from\s+['"][^'"]*qq\.js['"]/,
    /from\s+['"][^'"]*server\.js['"]/,
    /\bprocess\.env\b/,
  ]) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in qq-adapter.js: ' + pattern);
  }
  // 内容盲：模块自身模板字符串里不能出现正文变量插值到 journal 的写法。
  assert.equal(/journal\(\{[^}]*\btext\b/.test(source), false);
});
