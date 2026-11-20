/**
 * brain · 请求体预算与角色卡截断（隔离候选版）
 * ─────────────────────────────────────────────────────────────
 * 只用合成数据：临时角色卡 + 假 Memory + 假 fetch，不读写 data/、不调真实服务。
 * 验收：node --test packages/companion/test/brain-context-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { Role } from '../src/role.js';

const MODEL = 'deepseek-chat';
const CARD_MARK = '【完整设定】\n';
const PLATFORM_MARK = '\n\n【平台给你的说明】';

function tempCard(t, content = '合成角色卡：说话短、别客套。') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-brain-'));
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return cardPath;
}

function fakeMemory({ person = '', recent = '' } = {}) {
  const calls = { remember: 0, logTurn: 0, remembered: [], turns: [] };
  return {
    calls,
    renderPerson: () => person,
    renderRecent: () => recent,
    remember(userId, record) { calls.remember += 1; calls.remembered.push({ userId, record }); },
    logTurn(entry) { calls.logTurn += 1; calls.turns.push(entry); },
  };
}

function installFetch(t, message = { content: ' 好的 ' }) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 以 reply 的同一形状装配期望请求体，用于逐字节比对 */
function expectedBody({ role, text, history = [], platform = '', parts }) {
  const sys = role.build({ ...parts, platform });
  const messages = [{ role: 'system', content: sys }];
  for (const h of history.slice(-20)) {
    messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
  }
  messages.push({ role: 'user', content: String(text || '') });
  return JSON.stringify({ model: MODEL, messages, temperature: 1.1, stream: false });
}

/** 取出 system prompt 里的角色卡注入段（不含后面的平台说明） */
function cardSection(text) {
  const start = text.indexOf(CARD_MARK);
  assert.notEqual(start, -1, 'system prompt 必须包含角色卡段');
  const from = start + CARD_MARK.length;
  const end = text.indexOf(PLATFORM_MARK);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

test('未超限：请求体逐字节原样，长度按 JSON 转义后的字符数计', async (t) => {
  const cardPath = tempCard(t, 'CARD' + 'c'.repeat(300));
  const role = new Role({ cardPath });
  const memory = fakeMemory({ person: '你了解他：养了猫', recent: '他：昨天加班\n你：辛苦了' });
  const calls = installFetch(t, { content: ' 好，早点睡。 ', reasoning_content: '顺着聊' });

  const input = {
    key: 'group:1',
    userId: 'u1',
    userName: '阿明',
    text: '他说“别\n熬夜”🙂',
    situation: '你在群里。',
    platform: '平台说明：“引用”可用。',
    history: [{ text: '第一句' }, { text: '我回过一句', isSelf: true }],
  };
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000 });
  const out = await brain.reply(input);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer 合成-key');
  const raw = calls[0].init.body;
  const expected = expectedBody({
    role,
    text: input.text,
    history: input.history,
    platform: input.platform,
    parts: { situation: input.situation, memory: memory.renderPerson(), recent: memory.renderRecent() },
  });
  assert.equal(raw, expected, '预算内请求体必须与原有装配逐字节一致');
  assert.ok(raw.length <= 50000);
  // 实际转义发生在 JSON 序列化层：原文的换行在请求体里是反斜杠 + n 两个字符
  assert.ok(raw.includes('“别\\n熬夜”'));
  assert.equal(JSON.parse(raw).messages.at(-1).content, input.text);
  assert.equal(JSON.parse(raw).messages.length, 4);
  assert.equal(JSON.parse(raw).temperature, 1.1);
  assert.equal(JSON.parse(raw).stream, false);

  assert.deepEqual(out, {
    text: '好，早点睡。',
    reasoning: '顺着聊',
    raw: { choices: [{ message: { content: ' 好，早点睡。 ', reasoning_content: '顺着聊' } }] },
  });
});

test('超限：按 recent → memory → situation 整块逐级丢弃，固定层始终留下', async (t) => {
  const cardPath = tempCard(t, 'CARD' + 'c'.repeat(200));
  const role = new Role({ cardPath });
  const person = 'MEMORY_MARKER' + 'm'.repeat(300);
  const recent = 'RECENT_MARKER' + 'r'.repeat(300);
  const situation = 'SITUATION_MARKER' + 's'.repeat(300);
  const memory = fakeMemory({ person, recent });
  const calls = installFetch(t);
  const input = {
    key: 'group:2',
    userId: 'u2',
    text: 'USER_MARKER_原文',
    situation,
    platform: 'PLATFORM_MARKER',
    history: [{ text: 'H1' }, { text: 'H2', isSelf: true }],
  };
  const common = { role, text: input.text, history: input.history, platform: input.platform };

  const stages = [
    {
      cap: expectedBody({ ...common, parts: { situation, memory: person, recent: '' } }).length,
      parts: { situation, memory: person, recent: '' },
      gone: ['RECENT_MARKER'],
      kept: ['MEMORY_MARKER', 'SITUATION_MARKER'],
    },
    {
      cap: expectedBody({ ...common, parts: { situation, memory: '', recent: '' } }).length,
      parts: { situation, memory: '', recent: '' },
      gone: ['RECENT_MARKER', 'MEMORY_MARKER'],
      kept: ['SITUATION_MARKER'],
    },
    {
      cap: expectedBody({ ...common, parts: { situation: '', memory: '', recent: '' } }).length,
      parts: { situation: '', memory: '', recent: '' },
      gone: ['RECENT_MARKER', 'MEMORY_MARKER', 'SITUATION_MARKER'],
      kept: [],
    },
  ];

  for (const stage of stages) {
    const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: stage.cap });
    await brain.reply(input);
    const raw = calls.at(-1).init.body;
    const sys = JSON.parse(raw).messages[0].content;
    assert.equal(raw, expectedBody({ ...common, parts: stage.parts }), '应得到该轮减量后的唯一请求体');
    assert.ok(raw.length <= stage.cap, '请求体必须在 cap 内');
    for (const marker of stage.gone) assert.equal(sys.includes(marker), false, marker + ' 必须已整块丢弃');
    for (const marker of stage.kept) assert.ok(sys.includes(marker), marker + ' 必须保留');
    // 固定层：角色卡、基本规矩、平台说明、独立 history、用户原文
    assert.ok(sys.includes(CARD_MARK + 'CARD' + 'c'.repeat(200)), '角色卡不得被参考块挤占');
    assert.ok(sys.includes('【基本规矩】'));
    assert.ok(sys.includes('PLATFORM_MARKER'));
    assert.equal(sys.includes('USER_MARKER_原文'), false);
    const messages = JSON.parse(raw).messages;
    assert.equal(messages[1].content, 'H1');
    assert.equal(messages[2].content, 'H2');
    assert.equal(messages.at(-1).content, 'USER_MARKER_原文');
  }
});

test('固定内容仍超限：fetch 前抛结构化错误，零写回且错误只有计数', async (t) => {
  const cardPath = tempCard(t, 'CARD_ONLY');
  const role = new Role({ cardPath });
  const memory = fakeMemory({ person: '', recent: '' });
  const calls = installFetch(t);
  const markers = ['TOP_SECRET_USER_9f3a', 'TOP_SECRET_PLATFORM_7c2b'];

  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 200 });
  const err = await brain.reply({ key: 'k', userId: 'u', text: markers[0], platform: markers[1] })
    .then(() => null, (e) => e);

  assert.ok(err instanceof Error);
  assert.equal(err.code, 'context-budget-overflow');
  assert.equal(err.maxInputChars, 200);
  assert.ok(Number.isInteger(err.inputChars));
  assert.ok(err.inputChars > 200);
  assert.deepEqual(Object.keys(err).sort(), ['code', 'inputChars', 'maxInputChars']);
  const serialized = JSON.stringify(err);
  for (const marker of markers) assert.equal(serialized.includes(marker), false, '错误不得携带正文');
  assert.equal(calls.length, 0, '超限时不得调用 fetch');
  assert.equal(memory.calls.remember, 0, '超限时不得写回记忆');
  assert.equal(memory.calls.logTurn, 0, '超限时不得写回对话');
});

test('maxInputChars：非法配置显式抛 TypeError，缺省 24000', () => {
  const role = {};
  const memory = {};
  for (const bad of [0, -1, 1.5, NaN, Infinity, '24000', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new Brain({ apiKey: 'k', role, memory, maxInputChars: bad }), TypeError, String(bad));
  }
  assert.equal(new Brain({ apiKey: 'k', role, memory }).maxInputChars, 24000);
});

test('正常响应与 record：返回形态不变，只有 record=true 才写回', async (t) => {
  const cardPath = tempCard(t);
  const role = new Role({ cardPath });
  const memory = fakeMemory();
  installFetch(t, { content: ' 我在。 ', reasoning_content: '先应一声' });
  const brain = new Brain({ apiKey: '合成-key', role, memory });

  const quiet = await brain.reply({ key: 'c:1', userId: 'u1', userName: '阿明', text: '在吗', record: false });
  assert.deepEqual(quiet, {
    text: '我在。',
    reasoning: '先应一声',
    raw: { choices: [{ message: { content: ' 我在。 ', reasoning_content: '先应一声' } }] },
  });
  assert.equal(memory.calls.remember, 0);
  assert.equal(memory.calls.logTurn, 0);

  const normal = await brain.reply({ key: 'c:1', userId: 'u1', userName: '阿明', text: '在吗' });
  assert.equal(normal.text, '我在。');
  assert.equal(memory.calls.remember, 1);
  assert.equal(memory.calls.logTurn, 1);
  assert.equal(memory.calls.remembered[0].userId, 'u1');
  assert.equal(memory.calls.remembered[0].record.name, '阿明');
  assert.equal(memory.calls.remembered[0].record.topic, '在吗 → 我在。');
  assert.deepEqual(memory.calls.turns[0], { where: 'c:1', who: '阿明', text: '在吗', reply: '我在。' });
});

test('角色卡截断只依赖稳定层：参考块不挤占，selfNote/extra 计入额度', (t) => {
  const longCard = '【旧设定】' + 'c'.repeat(2000);
  const longRole = new Role({ cardPath: tempCard(t, longCard), maxChars: 500 });
  const baseline = longRole.build({});
  const loaded = longRole.build({
    situation: 'S'.repeat(4000),
    memory: 'M'.repeat(4000),
    recent: 'R'.repeat(4000),
    platform: 'PLATFORM_MARKER',
  });
  const trimmed = cardSection(loaded);
  assert.equal(trimmed, cardSection(baseline), '参考块再长，角色卡截断结果也应不变');
  assert.ok(trimmed.length < longCard.length, '长卡必须被截断');
  assert.ok(loaded.includes('S'.repeat(4000)));
  assert.ok(loaded.includes('M'.repeat(4000)));
  assert.ok(loaded.includes('R'.repeat(4000)));

  // 短卡 + selfNote / extra：稳定层计入额度，但卡本身完整保留
  const shortRole = new Role({ cardPath: tempCard(t, 'SHORT_CARD'), maxChars: 2000, extra: 'EXTRA_RULE_MARKER' });
  const out = shortRole.build({ selfNote: 'SELF_NOTE_MARKER', situation: 'SIT' });
  assert.ok(out.includes(CARD_MARK + 'SHORT_CARD'));
  assert.ok(out.includes('SELF_NOTE_MARKER'));
  assert.ok(out.includes('EXTRA_RULE_MARKER'));
});
