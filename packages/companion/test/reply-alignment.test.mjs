import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGNMENT_REASONS,
  DEFAULT_ALIGNMENT,
  anchorOf,
  createSendPacer,
  detectRepairIntent,
  endsWithQuestion,
  findUngroundedQuote,
  isMetaLine,
  isUngroundedGuess,
  latestEntry,
  planOutbound,
} from '../src/reply-alignment.js';

const message = (text, sequence, receivedAt = '2026-10-30T06:50:00.000Z') => ({
  userId: 'owner', name: '朋友', isGroup: false, text, receiveSequence: sequence, receivedAt,
});

/** 可注入的时钟：sleep 会推进时间，因此节拍器的等待是完全确定的。 */
function fakeClock(start = 1_000_000) {
  let time = start;
  const waits = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms) => { waits.push(ms); time += ms; },
    get time() { return time; },
  };
}

// ── 1. 最新消息是唯一锚点 ─────────────────────────────────────────

test('最新一条用户消息就是锚点：序号乱序到达也不会挑错', () => {
  const entries = [
    message('第一句', 3),
    message('最新的那句', 7),
    message('中间那句', 5),
  ];
  const latest = latestEntry(entries);
  assert.equal(latest.index, 1);
  assert.equal(latest.sequence, 7);
  assert.equal(anchorOf(entries).text, '最新的那句');
});

test('序号缺失时按接收时间挑最新，时间也缺失时按到达顺序取最后一条', () => {
  const byTime = latestEntry([
    { text: '早的', receivedAt: '2026-10-30T06:00:00.000Z' },
    { text: '晚的', receivedAt: '2026-10-30T06:05:00.000Z' },
  ]);
  assert.equal(byTime.entry.text, '晚的');
  const byArrival = latestEntry([{ text: '甲' }, { text: '乙' }]);
  assert.equal(byArrival.entry.text, '乙');
  assert.equal(anchorOf([]), null);
});

test('这批之后已经来了更新的用户消息：旧回复整段作废，改为沉默', () => {
  const entries = [message('你还好吗', 4)];
  const plan = planOutbound({
    parts: ['我还好。'],
    entries,
    latestSequence: 5,
  });
  assert.equal(plan.action, 'silence');
  assert.deepEqual(plan.parts, []);
  assert.deepEqual(plan.reasons, [ALIGNMENT_REASONS.superseded]);

  // 没有被更新消息顶掉时照常发。
  const fresh = planOutbound({ parts: ['我还好。'], entries, latestSequence: 4 });
  assert.equal(fresh.action, 'send');
  assert.deepEqual(fresh.parts, ['我还好。']);
});

test('entries 缺失时用批次序号兜住过期判断', () => {
  const stale = planOutbound({ parts: ['好呀。'], entries: [], inputSequence: 2, latestSequence: 3 });
  assert.equal(stale.action, 'silence');
  assert.deepEqual(stale.reasons, [ALIGNMENT_REASONS.superseded]);
  const fresh = planOutbound({ parts: ['好呀。'], entries: [], inputSequence: 3, latestSequence: 3 });
  assert.equal(fresh.action, 'send');
});

// ── 2. 挑战 / 修复路径 ───────────────────────────────────────────

test('指出接错、读了旧消息会被识别成修复轮，普通提问不会', () => {
  for (const text of [
    '什么情况？你好像读到了之前的消息',
    '不顺，有时你会读到我之前一次性发的消息',
    '我没说过这句话',
    '你理解错了',
    '哪句读岔了',
  ]) {
    assert.equal(detectRepairIntent(text), true, text);
  }
  for (const text of ['今天好困', '你在做什么', '讲个故事吧']) {
    assert.equal(detectRepairIntent(text), false, text);
  }
});

test('修复轮只发一条，并删掉把定位错误推回给对方的反问', () => {
  const entries = [message('什么情况？你好像读到了之前的消息', 9)];
  const plan = planOutbound({
    parts: ['是我接岔了。哪句读岔了？你说具体点。'],
    entries,
    latestSequence: 9,
    repair: true,
  });
  assert.equal(plan.action, 'send');
  assert.deepEqual(plan.parts, ['是我接岔了。']);
  assert.ok(plan.reasons.includes(ALIGNMENT_REASONS.locateErrorQuestion));
});

test('把没被确认的猜测当事实说出来会被删掉；作为问句的一次确认可以留下', () => {
  assert.equal(isUngroundedGuess('你是想说，我今天不想聊了吧。'), true);
  assert.equal(isUngroundedGuess('你是在说今天不聊了吗？'), false);

  const entries = [message('我不想聊这个', 3)];
  const asserted = planOutbound({
    parts: ['你是想说，我今天不想聊了吧。'],
    entries,
    latestSequence: 3,
  });
  assert.equal(asserted.action, 'silence');
  assert.ok(asserted.reasons.includes(ALIGNMENT_REASONS.ungroundedGuess));

  const asked = planOutbound({
    parts: ['你是想说这个先放一放吗？'],
    entries,
    latestSequence: 3,
  });
  assert.equal(asked.action, 'send');
  assert.deepEqual(asked.parts, ['你是想说这个先放一放吗？']);
});

test('修复轮里"承认接岔"这句本身不会被当成元叙述删掉', () => {
  const plan = planOutbound({
    parts: ['是我读岔了。', '你说的是「今天没睡好」。'],
    entries: [message('今天没睡好', 1)],
    latestSequence: 1,
    repair: true,
  });
  assert.equal(plan.action, 'send');
  assert.equal(plan.parts.length, 1);
  assert.match(plan.parts[0], /是我读岔了/u);
  assert.match(plan.parts[0], /今天没睡好/u);
});

test('引用最新消息里没有的原话属于编造锚点，会被删掉', () => {
  const entries = [message('今天加班到十点', 6)];
  assert.equal(findUngroundedQuote('你说「明天去爬山」。', '今天加班到十点'), '明天去爬山');
  assert.equal(findUngroundedQuote('你说「今天加班到十点」。', '今天加班到十点'), '');
  const plan = planOutbound({ parts: ['你说「明天去爬山」。'], entries, latestSequence: 6 });
  assert.equal(plan.action, 'silence');
  assert.ok(plan.reasons.includes(ALIGNMENT_REASONS.ungroundedQuote));
});

// ── 3. 问句是轮次边界 ───────────────────────────────────────────

test('问句之后不再追加判断、换话题或自问自答', () => {
  assert.equal(endsWithQuestion('你还好吗？'), true);
  assert.equal(endsWithQuestion('你还好吗'), true);
  assert.equal(endsWithQuestion('我还好。'), false);

  const entries = [message('随便聊聊', 2)];
  const plan = planOutbound({
    parts: ['你最近还好吗？', '不过我觉得你想太多了。', '算了不说这个。'],
    entries,
    latestSequence: 2,
  });
  assert.equal(plan.action, 'send');
  assert.deepEqual(plan.parts, ['你最近还好吗？']);
  assert.ok(plan.reasons.includes(ALIGNMENT_REASONS.questionBoundary));
});

test('一路追加到最后都只是自检式元叙述时，宁可沉默', () => {
  const entries = [message('你读错了', 4)];
  const plan = planOutbound({
    parts: ['我看看是不是又抢了半拍。'],
    entries,
    latestSequence: 4,
  });
  assert.equal(plan.action, 'silence');
  assert.ok(plan.reasons.includes(ALIGNMENT_REASONS.metaLine));
  assert.equal(isMetaLine('我又抢了半拍'), true);
  assert.equal(isMetaLine('今天降温了'), false);
});

// ── 4. 条数与发送间隔 ───────────────────────────────────────────

test('一个用户批次最多两条消息：多出来的并回最后一条，而不是再拆一条', () => {
  const entries = [message('说点什么', 1)];
  const plan = planOutbound({
    parts: ['第一句。', '第二句。', '第三句。', '第四句。'],
    entries,
    latestSequence: 1,
  });
  assert.equal(plan.action, 'send');
  assert.equal(plan.parts.length, DEFAULT_ALIGNMENT.maxParts);
  assert.deepEqual(plan.parts, ['第一句。', '第二句。 第三句。 第四句。']);
  assert.ok(plan.reasons.includes(ALIGNMENT_REASONS.partCap));
  assert.ok(plan.parts.length <= 2);
});

test('发送节拍器把最小间隔抬成下界：第二条至少等 3 秒，时间差可以算清', async () => {
  const clock = fakeClock();
  const pacer = createSendPacer({ minGapMs: 3000, sleep: clock.sleep, now: clock.now });
  const sentAt = [];
  for (let index = 0; index < 2; index += 1) {
    await pacer.beforeSend();
    sentAt.push(clock.time);
  }
  assert.deepEqual(clock.waits, [3000]);
  assert.equal(sentAt[1] - sentAt[0], 3000);
  assert.ok(sentAt[1] - sentAt[0] >= DEFAULT_ALIGNMENT.minSendGapMs);
});

test('节拍器不会缩短已经够长的等待（只抬下界，不加随机抖动）', async () => {
  const clock = fakeClock();
  const pacer = createSendPacer({ minGapMs: 3000, sleep: clock.sleep, now: clock.now });
  await pacer.beforeSend();
  clock.sleep(5000); // 真实停顿比下界更长（例如打字时间）
  const waited = await pacer.beforeSend();
  assert.equal(waited, 0);
  assert.deepEqual(clock.waits, [5000]);
});

test('两条上限 + 最小间隔让"三条短消息挤在 8 秒里"不可能发生', async () => {
  const entries = [message('嗯', 1)];
  const plan = planOutbound({
    parts: ['这样啊。', '那我先不打扰了。', '你忙吧。'],
    entries,
    latestSequence: 1,
  });
  const clock = fakeClock();
  const pacer = createSendPacer({ minGapMs: 3000, sleep: clock.sleep, now: clock.now });
  const sentAt = [];
  for (const _part of plan.parts) {
    await pacer.beforeSend();
    sentAt.push(clock.time);
  }
  assert.equal(plan.parts.length, 2);
  assert.ok(sentAt.at(-1) - sentAt[0] >= 3000);
  assert.ok(sentAt.length < 3, '不可能出现第三条');
});
// ── 5. 兜底路径：删除后无话可说 / 节拍器只读状态（补齐稳定契约） ──

test('删完什么都不剩时保持沉默，并记为 empty-reply（沉默是合法的兜底）', () => {
  const entries = [message('嗯', 1)];
  const plan = planOutbound({ parts: ['   ', ''], entries, latestSequence: 1 });
  assert.equal(plan.action, 'silence');
  assert.deepEqual(plan.parts, []);
  assert.deepEqual(plan.reasons, [ALIGNMENT_REASONS.emptyReply]);
});

test('节拍器暴露只读状态：发送前为 null，每次发送后记录当前时间', async () => {
  const clock = fakeClock(5000);
  const pacer = createSendPacer({ minGapMs: 3000, sleep: clock.sleep, now: clock.now });
  assert.equal(pacer.lastSendAt, null);
  await pacer.beforeSend();
  assert.equal(pacer.lastSendAt, 5000);
  await pacer.beforeSend();
  assert.equal(pacer.lastSendAt, 8000);
});
