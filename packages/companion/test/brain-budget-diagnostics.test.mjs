/**
 * brain · 脱敏的 memory-budget 诊断（M5 独立增量）
 * ─────────────────────────────────────────────────────────────
 * 只用合成数据：临时角色卡 + 真实 Memory（临时目录）+ 假 fetch。
 * 不读仓库 data/、不联网、不调真实模型；临时目录在每个用例结束时删除。
 * 验收：node --test packages/companion/test/brain-budget-diagnostics.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain, MEMORY_BUDGET_EVENT_VERSION } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { Role } from '../src/role.js';

const MODEL = 'deepseek-chat';

/** 事件字段是固定集合：只允许块名与纯计数，任何正文/标识/异常都不可能挤进来 */
const EVENT_KEYS = [
  'blocksEvicted',
  'charsUsed',
  'event',
  'evictedParts',
  'maxChars',
  'roundsAvailable',
  'roundsDropped',
  'roundsKept',
  'topicsDropped',
  'version',
  'withinBudget',
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-diag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempRole(t, content = '合成角色卡：说话短、别客套。') {
  const cardPath = path.join(tempDir(t), 'role.md');
  fs.writeFileSync(cardPath, content);
  return new Role({ cardPath });
}

function tempMemory(t) {
  return new Memory({ dir: tempDir(t) });
}

/** 假 fetch：只记录请求体，返回固定形状的模型响应（绝不联网） */
function installFetch(t, message = { content: ' 好 ' }) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 以 reply 的同一形状装配期望请求体，用于逐字节比对（与旧测试同一套拼法） */
function expectedBody({ role, text, history = [], platform = '', parts }) {
  const sys = role.build({ ...parts, platform });
  const messages = [{ role: 'system', content: sys }];
  for (const h of history.slice(-20)) {
    messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
  }
  messages.push({ role: 'user', content: String(text || '') });
  return JSON.stringify({ model: MODEL, messages, temperature: 1.1, stream: false });
}

/** 五轮合成对话，正文带引号/反斜杠/emoji，让 JSON 转义真的影响预算边界 */
function seedRounds(memory, count = 5, where = 'private:u1') {
  for (let i = 1; i <= count; i += 1) {
    memory.logTurn({
      where,
      who: '阿明',
      text: 'OLD' + i + '_第' + i + '轮他说的话 "带引号" 反斜杠\\ 和🙂',
      reply: 'R' + i + '_第' + i + '轮的回复 "也带引号"\\',
    });
  }
}

/** 收集回调事件 */
function recorder() {
  const events = [];
  return { events, onMemoryBudget: (event) => { events.push(event); } };
}

/** 固定字段 + 脱敏断言：形状、冻结、无正文标记 */
function assertEvent(event, { maxChars, markers = [] }) {
  assert.ok(Object.isFrozen(event), '事件必须是冻结的只读对象');
  assert.ok(Object.isFrozen(event.evictedParts), 'evictedParts 必须是冻结数组');
  assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS, '事件字段集合必须固定');
  assert.equal(event.event, 'memory-budget');
  assert.equal(event.version, MEMORY_BUDGET_EVENT_VERSION);
  assert.equal(event.maxChars, maxChars);
  assert.equal(typeof event.charsUsed, 'number');
  assert.equal(event.withinBudget, event.charsUsed <= event.maxChars);
  for (const name of ['roundsAvailable', 'roundsKept', 'roundsDropped', 'topicsDropped', 'blocksEvicted']) {
    assert.ok(Number.isSafeInteger(event[name]) && event[name] >= 0, name + ' 必须是非负整数');
  }
  assert.equal(event.blocksEvicted, event.evictedParts.length, 'blocksEvicted 就是淘汰块数');
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('u1'), false, '事件不得带会话标识');
  assert.equal(serialized.includes('group:'), false, '事件不得带会话标识');
  for (const marker of markers) {
    assert.equal(serialized.includes(marker), false, marker + ' 不得进入诊断事件');
  }
}

test('预算内：事件照发、轮次如实、请求体与旧装配逐字节一致', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const input = {
    key: 'group:other',
    userId: 'u1',
    text: '现在的输入',
    situation: 'SITUATION_MARKER',
    platform: 'PLATFORM_MARKER',
    history: [{ text: 'H1' }, { text: 'H2', isSelf: true }],
  };
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000, onMemoryBudget });
  await brain.reply({ ...input, record: false });

  assert.equal(events.length, 1, '每次请求装配完成后发一条事件');
  const event = events[0];
  assertEvent(event, { maxChars: 50000, markers: ['SITUATION_MARKER', 'PLATFORM_MARKER', 'OLD1_'] });
  assert.equal(event.roundsAvailable, 5);
  assert.equal(event.roundsKept, 5, '预算内五轮都在请求里');
  assert.equal(event.roundsDropped, 0);
  assert.equal(event.topicsDropped, 0);
  assert.equal(event.blocksEvicted, 0);
  assert.deepEqual(event.evictedParts, []);
  assert.equal(event.withinBudget, true);

  const raw = calls.at(-1).init.body;
  assert.equal(event.charsUsed, raw.length, 'charsUsed 就是最终序列化请求体长度');
  assert.equal(raw, expectedBody({
    role,
    text: input.text,
    history: input.history,
    platform: input.platform,
    parts: { situation: input.situation, memory: memory.renderPerson('u1'), recent: memory.renderRecent(20) },
  }), '接不接回调，最终请求体必须逐字节一致');
});

test('正常按整轮裁剪：记录成功保留的轮次，载荷仍是该轮减量结果', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const view = memory.recentRoundView(20);
  assert.equal(view.roundCount, 5);
  const parts = { situation: '', memory: memory.renderPerson('u1'), recent: view.renderFrom(2) };
  const keepThree = expectedBody({ role, text: 'NOW', parts });

  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: keepThree.length, onMemoryBudget });
  await brain.reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });

  assert.equal(calls.at(-1).init.body, keepThree, '裁剪结果必须与旧路径一致');
  assert.equal(events.length, 1);
  const event = events[0];
  assertEvent(event, { maxChars: keepThree.length, markers: ['OLD1_', 'R1_', 'OLD2_', 'R2_'] });
  assert.equal(event.roundsAvailable, 5);
  assert.equal(event.roundsKept, 3, '只保留最近三轮');
  assert.equal(event.roundsDropped, 2);
  assert.equal(event.topicsDropped, 0);
  assert.equal(event.blocksEvicted, 0, '只裁轮次，没有整块淘汰');
  assert.deepEqual(event.evictedParts, []);
  assert.equal(event.charsUsed, keepThree.length);
  assert.equal(event.withinBudget, true);
});

test('旧话题裁剪：话题数如实，被放弃的最近对话算整块淘汰', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  const oldTopic = 'OLD_TOPIC "' + '\\'.repeat(60);
  const newTopic = 'NEW_TOPIC ' + '语'.repeat(50);
  memory.remember('sample', { fact: 'FACT', topic: oldTopic });
  memory.remember('sample', { pending: 'PENDING', topic: newTopic });
  memory.logTurn({ where: 'private:other', who: 'sample', text: 'OTHER_RECENT', reply: 'OTHER_REPLY' });
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const topicView = memory.personTopicView('sample');
  assert.equal(topicView.topicCount, 2);
  const trimmed = expectedBody({ role, text: 'NOW', parts: { situation: '', memory: topicView.renderFrom(1), recent: '' } });

  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: trimmed.length, onMemoryBudget });
  await brain.reply({ key: 'private:current', userId: 'sample', text: 'NOW', record: false });

  assert.equal(calls.at(-1).init.body, trimmed, '话题裁剪后的请求体必须与旧路径一致');
  const event = events.at(-1);
  assertEvent(event, { maxChars: trimmed.length, markers: ['OLD_TOPIC', 'NEW_TOPIC', 'OTHER_RECENT', 'FACT'] });
  assert.equal(event.topicsDropped, 1, '只裁掉最旧的一条话题');
  assert.equal(event.roundsAvailable, 1);
  assert.equal(event.roundsKept, 0, '最近的对话整块放弃，一条都没进请求');
  assert.equal(event.roundsDropped, 1);
  assert.equal(event.blocksEvicted, 1);
  assert.deepEqual(event.evictedParts, ['recent']);
});

test('压力下不泄漏：事件里没有输入、标识、异常原文或任何 prompt', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory, 3, 'private:u1');
  memory.remember('u1', { name: 'SECRET_NAME_55', trait: 'SECRET_TRAIT_44', topic: 'SECRET_TOPIC_33' });
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const markers = [
    'SECRET_NAME_55',
    'SECRET_TRAIT_44',
    'SECRET_TOPIC_33',
    'SECRET_KEY_88',
    'SECRET_PLATFORM_71',
    'SECRET_SITUATION_22',
    'SECRET_HISTORY_66',
  ];
  // 收紧到只能留下最新一轮：三种裁剪里的正文全部不得出现在事件里
  const view = memory.recentRoundView(20, { excludeWhere: 'group:secret' });
  const cap = expectedBody({
    role,
    text: 'SECRET_KEY_88',
    history: [{ text: 'SECRET_HISTORY_66' }],
    platform: 'SECRET_PLATFORM_71',
    parts: { situation: 'SECRET_SITUATION_22', memory: '', recent: view.renderFrom(view.roundCount - 1) },
  }).length;
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: cap, onMemoryBudget });
  await brain.reply({
    key: 'group:secret',
    userId: 'u1',
    userName: 'SECRET_NAME_55',
    text: 'SECRET_KEY_88',
    platform: 'SECRET_PLATFORM_71',
    situation: 'SECRET_SITUATION_22',
    history: [{ text: 'SECRET_HISTORY_66' }],
    record: false,
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assertEvent(event, { maxChars: cap, markers });
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('SECRET_'), false, '事件只能有块名与计数');
  assert.equal(serialized.includes('OLD1_'), false);
  assert.equal(serialized.includes('group:secret'), false);
  assert.equal(events[0].charsUsed, calls.at(-1).init.body.length);
  // 事件与最终请求体互不影响：正文仍照常送进请求
  assert.ok(calls.at(-1).init.body.includes('SECRET_KEY_88'));
});

test('绝无可裁时：事件先落一条「不通过」，然后照旧 fetch 前抛错且零写回', async (t) => {
  const role = tempRole(t, 'CARD_ONLY');
  const memory = tempMemory(t);
  seedRounds(memory, 2);
  memory.remember('u1', { trait: 'TRAIT_MARKER_' + 't'.repeat(40) });
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50, onMemoryBudget });
  const err = await brain.reply({ key: 'k', userId: 'u1', text: 'TOP_SECRET_USER_9f3a', situation: 'SITUATION_MARKER' })
    .then(() => null, (error) => error);

  assert.ok(err instanceof Error);
  assert.equal(err.code, 'context-budget-overflow');
  assert.equal(calls.length, 0, '超限时不得调用 fetch');
  assert.equal(memory.recentTurns(20).length, 2, '超限时不得写回对话');

  assert.equal(events.length, 1, '抛错前必须先留下诊断');
  const event = events[0];
  assertEvent(event, { maxChars: 50, markers: ['TOP_SECRET_USER_9f3a', 'CARD_ONLY', 'TRAIT_MARKER_', 'SITUATION_MARKER'] });
  assert.equal(event.withinBudget, false);
  assert.equal(event.charsUsed, err.inputChars, '事件与抛出的错误报同一个字符数');
  assert.ok(event.charsUsed > event.maxChars);
  assert.equal(event.roundsAvailable, 2);
  assert.equal(event.roundsKept, 0);
  assert.equal(event.roundsDropped, 2);
  assert.equal(event.blocksEvicted, 3);
  assert.deepEqual(event.evictedParts, ['recent', 'memory', 'situation']);
  assert.equal(JSON.stringify(err).includes('TOP_SECRET_USER_9f3a'), false);
});

test('无回调兼容：不传 / 传非函数都不做事，载荷与接线前逐字节一致', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t);
  // 换一个会话来源：最近对话不因 excludeWhere 被过滤，期望请求体里带着五轮
  const input = { key: 'private:other', userId: 'u1', text: 'NOW', situation: 'SIT', platform: 'PLAT', record: false };

  assert.equal(new Brain({ apiKey: 'k', role, memory }).onMemoryBudget, null);
  assert.equal(new Brain({ apiKey: 'k', role, memory, onMemoryBudget: '不是函数' }).onMemoryBudget, null);
  assert.equal(new Brain({ apiKey: 'k', role, memory, onMemoryBudget: null }).onMemoryBudget, null);

  const bodies = [];
  for (const opts of [{}, { onMemoryBudget: '不是函数' }, { onMemoryBudget: undefined }]) {
    await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000, ...opts })
      .reply(input);
    bodies.push(calls.at(-1).init.body);
  }
  for (const body of bodies) assert.equal(body, bodies[0], '有没有回调，请求体都一模一样');
  assert.equal(bodies[0], expectedBody({
    role,
    text: input.text,
    platform: input.platform,
    parts: { situation: input.situation, memory: memory.renderPerson('u1'), recent: memory.renderRecent(20) },
  }));
});

test('回调失败隔离：抛错或 reject 都不影响回复、请求体与写回', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t, { content: ' 在的 ' });
  // 第一轮会写回记忆（且本轮来源会被 excludeWhere 排除），期望请求体按当轮现场算
  const expectedNow = (text, key) => expectedBody({
    role,
    text,
    parts: { situation: '', memory: memory.renderPerson('u1'), recent: memory.renderRecent(20, { excludeWhere: key }) },
  });
  const input = { key: 'private:other', userId: 'u1', userName: '阿明', text: '在吗' };

  const boom = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000, onMemoryBudget() { throw new Error('诊断炸了'); } });
  const expectedFirst = expectedNow(input.text, input.key);   // 装配发生在写回之前
  const out = await boom.reply(input);
  assert.equal(out.text, '在的');
  assert.equal(calls.at(-1).init.body, expectedFirst, '回调抛错不得改变请求体');
  assert.equal(memory.recentTurns(20).length, 6, '回调抛错不得改变写回');

  let seen = 0;
  const asyncBrain = new Brain({
    apiKey: '合成-key',
    role,
    memory,
    maxInputChars: 50000,
    onMemoryBudget: async () => { seen += 1; throw new Error('异步诊断炸了'); },
  });
  const expectedSecond = expectedNow(input.text, input.key);
  const asyncOut = await asyncBrain.reply({ ...input, record: false });
  assert.equal(asyncOut.text, '在的');
  assert.equal(seen, 1);
  assert.equal(calls.at(-1).init.body, expectedSecond);
  assert.equal(memory.recentTurns(20).length, 6, 'record:false 时也不因诊断而多写一条');
  // 给被吞掉的 rejection 一个机会落地：若未隔离，这里会冒成未处理的 rejection
  await new Promise((resolve) => { setTimeout(resolve, 20); });
});

test('事件在 fetch 之前发出，且回调不能改动本轮装配', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const { events, onMemoryBudget } = recorder();
  const beforeFetch = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    beforeFetch.push({ events: events.length, body: init.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '好' } }] }) };
  };
  t.after(() => { globalThis.fetch = original; });

  const payloads = [];
  const brain = new Brain({
    apiKey: '合成-key',
    role,
    memory,
    maxInputChars: 50000,
    onMemoryBudget(event) {
      events.push(event);
      // 事件是冻结的：就算消费方想「就地改一个数」也不会影响本轮装配
      try {
        event.charsUsed = 0;
        event.evictedParts.push('situation');
      } catch { /* 冻结对象赋值在严格模式下会抛，忽略 */ }
      payloads.push(JSON.stringify(event));
    },
  });
  await brain.reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });

  assert.equal(beforeFetch.length, 1);
  assert.equal(beforeFetch[0].events, 1, 'fetch 之前事件已经送达');
  assert.equal(beforeFetch[0].body, expectedBody({
    role,
    text: 'NOW',
    parts: { situation: '', memory: memory.renderPerson('u1'), recent: memory.renderRecent(20) },
  }), '事件处理不得改动请求体');
  assert.equal(events[0].charsUsed, beforeFetch[0].body.length);
  assert.deepEqual(events[0].evictedParts, []);
  assert.equal(JSON.parse(payloads[0]).charsUsed, beforeFetch[0].body.length);
});

test('拿不到结构化轮次：轮次计数为 0，但正文与整块淘汰照旧上报', async (t) => {
  const role = tempRole(t);
  class CustomMemory extends Memory {
    renderRecent() { return 'CUSTOM_RECENT_MARKER ' + 'c'.repeat(200); }
  }
  const memory = new CustomMemory({ dir: tempDir(t) });
  seedRounds(memory);
  const calls = installFetch(t);
  const { events, onMemoryBudget } = recorder();

  const full = expectedBody({
    role,
    text: 'NOW',
    parts: { situation: '', memory: memory.renderPerson('u1'), recent: memory.renderRecent(20) },
  });

  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000, onMemoryBudget })
    .reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });
  const within = events.at(-1);
  assertEvent(within, { maxChars: 50000, markers: ['CUSTOM_RECENT_MARKER'] });
  assert.equal(within.roundsAvailable, 0, '没有结构化视图就不猜轮数');
  assert.equal(within.roundsKept, 0);
  assert.equal(within.roundsDropped, 0);
  assert.equal(within.blocksEvicted, 0);
  assert.equal(within.charsUsed, full.length);

  // 溢出：自定义渲染只能整块丢 recent
  const withoutRecent = expectedBody({
    role,
    text: 'NOW',
    parts: { situation: '', memory: memory.renderPerson('u1'), recent: '' },
  });
  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: full.length - 1, onMemoryBudget })
    .reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });
  assert.equal(calls.at(-1).init.body, withoutRecent);
  const evicted = events.at(-1);
  assertEvent(evicted, { maxChars: full.length - 1, markers: ['CUSTOM_RECENT_MARKER'] });
  assert.equal(evicted.blocksEvicted, 1);
  assert.deepEqual(evicted.evictedParts, ['recent']);
  assert.equal(evicted.roundsAvailable, 0);
  assert.equal(evicted.roundsKept, 0);
});
