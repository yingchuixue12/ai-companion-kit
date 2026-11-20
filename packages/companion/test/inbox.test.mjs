import test from 'node:test';
import assert from 'node:assert/strict';
import { Inbox, LANE_STEP, LANE_TURN } from '../src/inbox.js';

test('每条事件都有稳定 eventId、来源序号和接收时间', () => {
  const inbox = new Inbox({ key: 'private:demo' });
  const first = inbox.enqueue({ text: '第一句' }, { sequence: 7, receivedAt: '2026-10-29T07:00:00+08:00' });
  assert.equal(first.status, 'queued');
  assert.equal(first.event.eventId, 'private:demo#7');
  assert.equal(first.event.sequence, 7);
  assert.equal(first.event.receivedAt, new Date('2026-10-29T07:00:00+08:00').toISOString());
  assert.equal(first.event.lane, LANE_TURN);

  // 同一来源事件重复投递不会变成第二条事件
  const duplicate = inbox.enqueue({ text: '第一句' }, { sequence: 7 });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.event.eventId, 'private:demo#7');
  assert.equal(inbox.size, 1);

  // 适配层没给序号时用内部自增序号兜底，标识依然稳定且唯一
  const fallback = inbox.enqueue({ text: '第二句' });
  assert.equal(fallback.event.sequence, 8);
  assert.equal(fallback.event.eventId, 'private:demo#8');

  // 适配层显式给出的 eventId 优先
  const explicit = inbox.enqueue({ text: '第三句' }, { eventId: 'onebot-42', sequence: 9 });
  assert.equal(explicit.event.eventId, 'onebot-42');
  assert.equal(inbox.size, 3);
});

test('同一会话连续三条消息冻结成一个批次，之后到达的消息留在下一批', () => {
  const inbox = new Inbox({ key: 'group:1' });
  ['一', '二', '三'].forEach((text, index) => {
    inbox.enqueue({ text }, { sequence: index + 1 });
  });

  const batch = inbox.freezeBatch();
  assert.deepEqual(batch.inputs.map((item) => item.text), ['一', '二', '三']);
  assert.equal(batch.events.length, 3);
  assert.equal(inbox.size, 0);
  assert.equal(inbox.inflightSize, 3);

  // 推理期间又来了两条：它们不会进入已冻结的批次
  inbox.enqueue({ text: '四' }, { sequence: 4 });
  inbox.enqueue({ text: '五' }, { sequence: 5 });
  assert.deepEqual(batch.inputs.map((item) => item.text), ['一', '二', '三']);
  assert.equal(inbox.size, 2);

  assert.equal(inbox.ackBatch(batch), 3);
  assert.equal(inbox.ackBatch(batch), 0, '提交是幂等的，重复提交不会再次消费');
  assert.equal(inbox.has('group:1#1'), true, '已提交的事件身份要记住，避免平台重复投递被再消费');
  assert.equal(inbox.enqueue({ text: '一' }, { sequence: 1 }).status, 'duplicate');

  const next = inbox.freezeBatch();
  assert.deepEqual(next.inputs.map((item) => item.text), ['四', '五']);
  assert.equal(inbox.freezeBatch(), null, '队列空了就不成批');
});

test('失败的批次可以重放，重放保留原顺序和事件身份', () => {
  const inbox = new Inbox({ key: 'k1' });
  inbox.enqueue({ text: 'a' }, { sequence: 1 });
  inbox.enqueue({ text: 'b' }, { sequence: 2 });
  const batch = inbox.freezeBatch();
  inbox.enqueue({ text: 'c' }, { sequence: 3 });

  assert.equal(inbox.requeue(batch), 2);
  assert.equal(inbox.requeue(batch), 0, '重复 requeue 不会把同一批放回两次');
  assert.deepEqual(inbox.pendingEvents().map((event) => event.payload.text), ['a', 'b', 'c']);
  assert.deepEqual(inbox.pendingEvents().map((event) => event.eventId), ['k1#1', 'k1#2', 'k1#3']);
  assert.equal(inbox.pendingEvents()[0].attempts, 1, '重放计次，用于限制自动重试');

  // 重放期间同一条平台事件不会重复入队
  assert.equal(inbox.enqueue({ text: 'a' }, { sequence: 1 }).status, 'duplicate');

  const retried = inbox.freezeBatch();
  assert.deepEqual(retried.inputs.map((item) => item.text), ['a', 'b', 'c']);
});

test('处理失败的批次进入失败区，只有显式重放才会重新消费', () => {
  const inbox = new Inbox({ key: 'k2' });
  inbox.enqueue({ text: 'x' }, { sequence: 1 });
  const batch = inbox.freezeBatch();

  assert.equal(inbox.failBatch(batch, { error: new Error('模型超时') }), 1);
  assert.equal(inbox.size, 0);
  assert.equal(inbox.inflightSize, 0);
  assert.equal(inbox.failedSize, 1);

  const [record] = inbox.failedBatches();
  assert.equal(record.error, '模型超时');
  assert.deepEqual(record.events.map((event) => event.eventId), ['k2#1']);
  assert.equal(inbox.freezeBatch(), null, '失败批次不会自动回到队列，避免无声重试');

  assert.equal(inbox.replayFailed(), 1);
  assert.equal(inbox.failedSize, 0);
  const retry = inbox.freezeBatch();
  assert.deepEqual(retry.inputs.map((item) => item.text), ['x']);
  assert.equal(retry.events[0].attempts, 0, '显式重放会重置自动重试计数');
});

test('lane 规则：轮次批次带上排在前面的 step 事件，没有新轮次输入时不成批', () => {
  const inbox = new Inbox({ key: 'k3' });
  inbox.enqueue({ id: 'injected' }, { sequence: 1, lane: LANE_STEP });
  assert.equal(inbox.hasLane(LANE_TURN), false);
  assert.equal(inbox.freezeBatch({ lanes: [LANE_STEP, LANE_TURN], stopAt: LANE_TURN }), null);
  assert.equal(inbox.size, 1);

  inbox.enqueue({ id: 'wake' }, { sequence: 2, lane: LANE_TURN });
  const batch = inbox.freezeBatch({ lanes: [LANE_STEP, LANE_TURN], stopAt: LANE_TURN });
  assert.deepEqual(batch.inputs.map((item) => item.id), ['injected', 'wake']);

  inbox.enqueue({ id: 'more-step' }, { sequence: 3, lane: LANE_STEP });
  inbox.enqueue({ id: 'next-turn' }, { sequence: 4, lane: LANE_TURN });
  const stepBatch = inbox.freezeBatch({ lanes: [LANE_STEP] });
  assert.deepEqual(stepBatch.inputs.map((item) => item.id), ['more-step'], 'step 批次遇到新轮次输入就停');
  const turnBatch = inbox.freezeBatch({ lanes: [LANE_STEP, LANE_TURN], stopAt: LANE_TURN });
  assert.deepEqual(turnBatch.inputs.map((item) => item.id), ['next-turn']);
});

test('队列满时明确拒绝并回报，不静默丢消息', () => {
  const overflows = [];
  const inbox = new Inbox({
    key: 'k4',
    maxPending: 2,
    onOverflow: (error, meta) => overflows.push([error.message, meta.eventId]),
  });
  inbox.enqueue({ text: '1' }, { sequence: 1 });
  inbox.enqueue({ text: '2' }, { sequence: 2 });

  const rejected = inbox.enqueue({ text: '3' }, { sequence: 3 });
  assert.equal(rejected.status, 'overflow');
  assert.equal(rejected.event, null);
  assert.match(overflows[0][0], /收件箱已满/);
  assert.equal(overflows[0][1], 'k4#3');
  assert.equal(inbox.size, 2);

  // 冻结后队列腾出空间，新事件重新可以入队
  const batch = inbox.freezeBatch();
  assert.equal(inbox.enqueue({ text: '3' }, { sequence: 3 }).status, 'queued');
  assert.equal(inbox.ackBatch(batch), 2);
});

test('清空队列不打断冻结中的批次，失败区需要显式清空', () => {
  const inbox = new Inbox({ key: 'k5' });
  inbox.enqueue({ text: 'running' }, { sequence: 1 });
  const batch = inbox.freezeBatch();
  inbox.enqueue({ text: 'waiting' }, { sequence: 2 });

  assert.equal(inbox.clear(), 1);
  assert.equal(inbox.size, 0);
  assert.equal(inbox.inflightSize, 1, '正在处理的批次不受 cancel/clear 影响');
  assert.equal(inbox.ackBatch(batch), 1);

  inbox.enqueue({ text: 'failed' }, { sequence: 3 });
  const failedBatch = inbox.freezeBatch();
  inbox.failBatch(failedBatch, { error: new Error('boom') });
  assert.equal(inbox.failedSize, 1);
  assert.equal(inbox.clear(), 0);
  assert.equal(inbox.failedSize, 1, '普通清空不动失败区，等待重放');

  inbox.enqueue({ text: 'again' }, { sequence: 4 });
  assert.equal(inbox.clear({ includeFailed: true }), 2, '显式清空会连失败批次一起丢掉');
  assert.equal(inbox.failedSize, 0);
  assert.equal(inbox.size, 0);
});

// ── 以下为 Issue #14 补足的最小用例 ─────────────────────────────
// 上面 7 条从原树同名测试移植；下面每条只针对原用例没走到的分支，
// 都是适配层真实会遇到的情况：时间戳形态、队尾重放、失败区上限、批次观测、去重窗口。

test('接收时间归一化：Date、毫秒时间戳、非法值各自落到可解释的结果', () => {
  const inbox = new Inbox({ key: 'k6' });
  const fromDate = inbox.enqueue({ text: 'd' }, { sequence: 1, receivedAt: new Date('2026-10-29T00:00:00Z') });
  assert.equal(fromDate.event.receivedAt, '2026-10-29T00:00:00.000Z');

  const ms = 1793000000000;
  assert.equal(inbox.enqueue({ text: 'ms' }, { sequence: 2, receivedAt: ms }).event.receivedAt, new Date(ms).toISOString());

  // 非法 Date 和纯空白字符串退回「当前时间」兜底：是能解析的 ISO，而不是 Invalid Date
  const invalidDate = new Date('not-a-time');
  const fromInvalid = inbox.enqueue({ text: 'bad' }, { sequence: 3, receivedAt: invalidDate });
  assert.equal(Number.isNaN(Date.parse(fromInvalid.event.receivedAt)), false);
  const fromBlank = inbox.enqueue({ text: 'blank' }, { sequence: 4, receivedAt: '   ' });
  assert.equal(Number.isNaN(Date.parse(fromBlank.event.receivedAt)), false);

  // 解析不了的字符串原样保留，交给上层判断，不静默改写成 now
  assert.equal(inbox.enqueue({ text: 'unknown' }, { sequence: 5, receivedAt: '昨天' }).event.receivedAt, '昨天');
});

test('requeue 默认回到队首，显式 front:false 时排到队尾', () => {
  const inbox = new Inbox({ key: 'k7' });
  inbox.enqueue({ text: 'a' }, { sequence: 1 });
  const batch = inbox.freezeBatch();
  inbox.enqueue({ text: 'b' }, { sequence: 2 });

  assert.equal(inbox.requeue(batch, { front: false }), 1);
  assert.deepEqual(inbox.pendingEvents().map((event) => event.payload.text), ['b', 'a'], '队尾重放不插队');
  assert.deepEqual(inbox.pendingEvents().map((event) => event.eventId), ['k7#2', 'k7#1'], '重放保留事件身份');
});

test('失败区超上限时丢最旧的并显式回报，回报方抛错也不影响收件箱', () => {
  const dropped = [];
  const inbox = new Inbox({
    key: 'k8',
    maxFailed: 1,
    onDrop: (record) => {
      dropped.push(record.events.map((event) => event.eventId));
      throw new Error('上报失败');
    },
  });

  for (const seq of [1, 2]) {
    inbox.enqueue({ text: `t${seq}` }, { sequence: seq });
    inbox.failBatch(inbox.freezeBatch(), { error: new Error(`e${seq}`) });
  }

  assert.deepEqual(dropped, [['k8#1']], '最早失败的批次被丢掉，并且回报了是哪一条');
  assert.equal(inbox.failedSize, 1);
  assert.deepEqual(inbox.failedBatches().map((record) => record.error), ['e2'], '留下的是最新的失败批次');
});

test('冻结中的批次可观测：inflightBatches 给出批次身份与事件快照', () => {
  const inbox = new Inbox({ key: 'k9' });
  inbox.enqueue({ text: 'a' }, { sequence: 1 });
  inbox.enqueue({ text: 'b' }, { sequence: 2 });
  const batch = inbox.freezeBatch();

  const snapshot = inbox.inflightBatches();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].batchId, batch.batchId);
  assert.equal(snapshot[0].key, 'k9');
  assert.equal(snapshot[0].attempts, 0);
  assert.deepEqual(snapshot[0].events.map((event) => event.eventId), ['k9#1', 'k9#2']);
  assert.equal(snapshot[0].events[0].payload.text, 'a');
  assert.equal(inbox.pendingEvents({ lane: LANE_TURN }).length, 0, '冻结后队列里没有待处理事件');

  assert.equal(inbox.ackBatch(batch), 2);
  assert.deepEqual(inbox.inflightBatches(), [], '提交后不再出现在冻结快照里');
});

test('已提交事件的记忆窗口有限：超过上限后旧 eventId 可以重新入队', () => {
  const inbox = new Inbox({ key: 'k10', maxPending: 600 });
  for (let seq = 1; seq <= 257; seq += 1) inbox.enqueue({ text: `m${seq}` }, { sequence: seq });
  const batch = inbox.freezeBatch();
  assert.equal(batch.events.length, 257);
  assert.equal(inbox.ackBatch(batch), 257);

  assert.equal(inbox.has('k10#257'), true, '窗口内的事件身份仍然记得');
  assert.equal(inbox.has('k10#1'), false, '窗口外的旧身份被淘汰，记忆不无界增长');
  assert.equal(inbox.enqueue({ text: 'm1-again' }, { sequence: 1 }).status, 'queued');
});