/**
 * 送达后才记账 · issue #26（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证「什么时候把这一轮写进记忆」：
 *
 *   Brain.reply(record) → 立即写 / 不写 / deferred + commit()
 *   handleTurn → 真实 Humanizer 全部段确认之后才 commit
 *
 * 边界：不联网、不调模型、不碰真实 data/、不写任何外部状态。
 * Brain / handleTurn / Humanizer 都是真实实现；只有 fetch、Memory、bot 是替身。
 *
 * 覆盖点：
 *   1. 默认立即写；record:false 不写；两者都不暴露 commit；
 *   2. deferred：返回前不写，commit 一次才写一次，重复 commit 不重复写；
 *   3. deferred 首次写失败：错误交给调用方，第二次静默不重试；
 *   4. 全部段 confirmed：最后一段确认之后才写，且只写一次；
 *   5. 第二段 unknown / 第一段 rejected：不写、不重发消息、不重问模型；
 *   6. 静默 / 干跑 / 0 段：一行都不写；
 *   7. 记忆写失败：抛给调用方错误日志，既不重发消息也不重问模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Brain } from '../src/brain.js';
import { Humanizer } from '../src/humanize.js';
import { handleTurn } from '../src/index.js';

// ── 替身 ──────────────────────────────────────────────────────
/** 拦截 console.log，避免用例刷屏，同时能断言「没说话 / 干跑」这类提示真的打了。 */
function quietConsole(t) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.log = original; });
  return lines;
}

/** 假 fetch：按顺序吐出合成模型回复，不联网。 */
function installFetch(t, content = '在的') {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const text = typeof content === 'function' ? content(calls.length) : content;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/**
 * 假 Memory：只把写入按顺序记进 events，不落盘。
 * failRemember 用来复现「记忆写失败」；attempts 记录真正尝试写了几次。
 */
function fakeMemory(events, { failRemember = false } = {}) {
  const writes = [];
  const memory = {
    writes,
    attempts: 0,
    renderPerson: () => '你了解他：养了猫',
    renderRecent: () => '他：昨天加班',
    remember(userId, record) {
      memory.attempts += 1;
      events.push('remember');
      if (failRemember) throw new Error('写记忆失败');
      writes.push({ kind: 'remember', userId, record });
    },
    logTurn(entry) {
      memory.attempts += 1;
      events.push('logTurn');
      writes.push({ kind: 'logTurn', entry });
    },
    touch(userId, meta) {
      events.push('touch');
      writes.push({ kind: 'touch', userId, meta });
    },
  };
  return memory;
}

/**
 * 假 bot：每段按 receipts 给出回执，回复形状与 transport-onebot.js 的 send 一致。
 * sendWrites 记录「这一段发出时记忆已经写了几次」，用来证明提交发生在全部发送之后。
 */
function fakeBot(events, receipts, countWrites) {
  const bot = {
    sent: [],
    sendWrites: [],
    async setTyping() { return { ok: true }; },
    async send(key, text) {
      const index = bot.sent.length;
      bot.sent.push(text);
      bot.sendWrites.push(countWrites());
      events.push('send:' + text);
      const status = receipts[index] ?? 'confirmed';
      return { ok: true, receipt: { status, messageId: 'm-' + (index + 1) } };
    },
  };
  return bot;
}

/** 只用于制造「一段都没发出去」：真实 Humanizer 对任何非空文本都至少切出一段。 */
class ZeroPartHumanizer extends Humanizer {
  async say() { return { sent: 0, parts: [] }; }
}

/** 零等待的真实 Humanizer：打字与条间停顿都取 0，避免用例被真实计时拖慢。 */
function makeHumanizer() {
  return new Humanizer({ msPerChar: 0, minMs: 0, maxMs: 0, jitter: 0, gapRange: [0, 0], longGapChance: 0 });
}

/** 一轮真实装配：真实 Brain + 真实 Humanizer + handleTurn，假 fetch / Memory / bot。 */
function makeRound(t, {
  modelText = PART1 + '\n' + PART2,
  receipts = [],
  failRemember = false,
  dryRun = false,
  human = null,
} = {}) {
  const events = [];
  const fetchCalls = installFetch(t, modelText);
  const memory = fakeMemory(events, { failRemember });
  const bot = fakeBot(events, receipts, () => memory.writes.length);
  const brain = new Brain({ apiKey: '合成-key', role: { build: () => '合成角色卡' }, memory });
  const deps = { bot, brain, human: human || makeHumanizer(), memory, waker: { wake: () => events.push('wake') } };
  const items = [{ key: 'private:10001', isGroup: false, userId: '10001', name: '小满', text: '在吗' }];
  return { deps, items, cfg: { dryRun }, events, memory, bot, fetchCalls };
}

// 两段都要长过 Humanizer 的合并阈值（不足 6 字的短段会被并成一条）
const PART1 = '第一段的内容在这里';
const PART2 = '第二段的内容也在这里';
const INPUT = { key: 'private:10001', userId: '10001', userName: '小满', text: '在吗' };

/** 直接调真实 Brain.reply，只看记忆写入。 */
async function brainReply(t, options = {}) {
  const events = [];
  const fetchCalls = installFetch(t, '在的');
  const memory = fakeMemory(events, { failRemember: options.failRemember });
  const brain = new Brain({ apiKey: '合成-key', role: { build: () => '合成角色卡' }, memory });
  const replyInput = { ...INPUT };
  if ('record' in options) replyInput.record = options.record;
  const result = await brain.reply(replyInput);
  return { result, events, memory, fetchCalls };
}

// ── 1. Brain.reply 的三种 record ──────────────────────────────
test('Brain.reply：默认立即写、record:false 不写、deferred 交给一次性 commit', async (t) => {
  await t.test('默认：返回前就写完，返回对象不带 commit', async () => {
    const r = await brainReply(t);
    assert.equal(r.result.text, '在的');
    assert.deepEqual(r.events, ['remember', 'logTurn']);
    assert.equal(r.memory.attempts, 2);
    assert.equal('commit' in r.result, false);
    assert.equal(r.fetchCalls.length, 1);
  });

  await t.test('record:false：一行都不写，也没有 commit', async () => {
    const r = await brainReply(t, { record: false });
    assert.deepEqual(r.events, []);
    assert.equal(r.memory.attempts, 0);
    assert.equal('commit' in r.result, false);
  });

  await t.test('deferred：提交前不写，commit 两次也只写一次', async () => {
    const r = await brainReply(t, { record: 'deferred' });
    assert.equal(typeof r.result.commit, 'function');
    assert.deepEqual(r.events, [], 'deferred 返回前不得写记忆');

    r.result.commit();
    assert.deepEqual(r.events, ['remember', 'logTurn']);

    r.result.commit();
    assert.deepEqual(r.events, ['remember', 'logTurn'], '重复提交不得重复写');
    assert.equal(r.memory.attempts, 2);
  });

  await t.test('deferred：首次提交失败后第二次不再重试', async () => {
    const r = await brainReply(t, { record: 'deferred', failRemember: true });
    assert.throws(() => r.result.commit(), /写记忆失败/);
    assert.equal(r.memory.attempts, 1);

    r.result.commit();
    assert.equal(r.memory.attempts, 1, '失败也算尝试过，不得重复写');
    assert.deepEqual(r.events, ['remember']);
  });
});

// ── 2. 全部发送确认之后才记账 ────────────────────────────────
test('handleTurn：两条都 confirmed，最后一段确认之后才写，且只写一次', async (t) => {
  quietConsole(t);
  const round = makeRound(t, { receipts: ['confirmed', 'confirmed'] });

  await handleTurn(round.deps, round.items, round.cfg);

  assert.deepEqual(round.bot.sent, [PART1, PART2]);
  assert.deepEqual(round.bot.sendWrites, [0, 0], '发送过程中不得写记忆');
  assert.deepEqual(round.events, ['send:' + PART1, 'send:' + PART2, 'remember', 'logTurn', 'wake', 'touch']);
  assert.equal(round.memory.attempts, 2);
  assert.equal(round.fetchCalls.length, 1);
});

// ── 3. 送达未确认：不写、不重发、不重问 ──────────────────────
test('handleTurn：投递未确认时不写记忆，也不重发消息或重问模型', async (t) => {
  quietConsole(t);

  await t.test('第二段 unknown', async () => {
    const round = makeRound(t, { receipts: ['confirmed', 'unknown'] });

    await assert.rejects(
      () => handleTurn(round.deps, round.items, round.cfg),
      (error) => {
        assert.equal(error.code, 'delivery-unconfirmed');
        assert.equal(error.status, 'unknown');
        assert.equal(error.sent, 1);
        return true;
      },
    );

    assert.deepEqual(round.bot.sent, [PART1, PART2]);
    assert.equal(round.memory.attempts, 0, '未确认的轮次不得写记忆');
    assert.deepEqual(round.memory.writes, []);
    assert.equal(round.fetchCalls.length, 1, '不得重问模型');
    assert.equal(round.events.includes('wake'), false);
    assert.equal(round.events.includes('touch'), false);
  });

  await t.test('第一段 rejected', async () => {
    const round = makeRound(t, { receipts: ['rejected'] });

    await assert.rejects(
      () => handleTurn(round.deps, round.items, round.cfg),
      (error) => {
        assert.equal(error.code, 'delivery-unconfirmed');
        assert.equal(error.status, 'rejected');
        assert.equal(error.sent, 0);
        return true;
      },
    );

    assert.deepEqual(round.bot.sent, [PART1], '失败段之后不得再发');
    assert.equal(round.memory.attempts, 0);
    assert.equal(round.fetchCalls.length, 1);
  });
});

// ── 4. 没走到「发送成功」就一行都不写 ───────────────────────
test('handleTurn：静默 / 干跑 / 0 段都不写记忆', async (t) => {
  const logs = quietConsole(t);

  await t.test('静默（模型没说话）', async () => {
    const round = makeRound(t, { modelText: '' });
    await handleTurn(round.deps, round.items, round.cfg);

    assert.deepEqual(round.bot.sent, []);
    assert.equal(round.memory.attempts, 0);
    assert.deepEqual(round.events, []);
    assert.equal(logs.some((line) => line.includes('没说话')), true);
  });

  await t.test('干跑', async () => {
    const round = makeRound(t, { modelText: '收到', dryRun: true });
    await handleTurn(round.deps, round.items, round.cfg);

    assert.deepEqual(round.bot.sent, []);
    assert.equal(round.memory.attempts, 0);
    assert.deepEqual(round.events, []);
    assert.equal(logs.some((line) => line.includes('[干跑]')), true);
  });

  await t.test('0 段', async () => {
    const round = makeRound(t, { human: new ZeroPartHumanizer() });
    await handleTurn(round.deps, round.items, round.cfg);

    assert.deepEqual(round.bot.sent, []);
    assert.equal(round.memory.attempts, 0, 'sent=0 不得写记忆');
    assert.deepEqual(round.events, ['wake', 'touch'], 'wake/touch 照旧');
  });
});

// ── 5. 记忆写失败：只抛错，不重发 ───────────────────────────
test('handleTurn：记忆写失败抛给调用方，不重发消息也不重问模型', async (t) => {
  quietConsole(t);
  const round = makeRound(t, { receipts: ['confirmed', 'confirmed'], failRemember: true });

  await assert.rejects(() => handleTurn(round.deps, round.items, round.cfg), /写记忆失败/);

  assert.deepEqual(round.bot.sent, [PART1, PART2], '不得重发已确认的段');
  assert.equal(round.fetchCalls.length, 1, '不得重问模型');
  assert.equal(round.memory.attempts, 1, '提交只尝试一次');
  assert.equal(round.events.includes('wake'), false);
  assert.equal(round.events.includes('touch'), false);
});
