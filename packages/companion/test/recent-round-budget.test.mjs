/**
 * brain · 最近对话按整轮裁剪（B19 / P-3）
 * ─────────────────────────────────────────────────────────────
 * 只用合成数据：临时角色卡 + 真实 Memory（临时目录）+ 假 fetch。
 * 不读仓库 data/、不联网、不调真实模型；临时目录在每个用例结束时删除。
 * 验收：node --test packages/companion/test/recent-round-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { Role } from '../src/role.js';

const MODEL = 'deepseek-chat';
const RECENT_HEADER = '【最近的真实对话（跨场合合在一起）】';

/** 临时目录（用例结束自动删） */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-round-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 临时角色卡 */
function tempRole(t, content = '合成角色卡：说话短、别客套。') {
  const cardPath = path.join(tempDir(t), 'role.md');
  fs.writeFileSync(cardPath, content);
  return new Role({ cardPath });
}

/** 临时 Memory（真实实现，读写都在临时目录） */
function tempMemory(t) {
  return new Memory({ dir: tempDir(t) });
}

/** 假 fetch：只记录请求体，返回固定形状的模型响应 */
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

const systemOf = (body) => JSON.parse(body).messages[0].content;

/** 五轮合成对话：正文里带引号、反斜杠和 emoji，让 JSON 转义真的影响边界 */
function seedRounds(memory, count = 5) {
  for (let i = 1; i <= count; i += 1) {
    memory.logTurn({
      where: 'private:u1',
      who: '阿明',
      text: 'OLD' + i + '_第' + i + '轮他说的话 "带引号" 反斜杠\\ 和🙂',
      reply: 'R' + i + '_第' + i + '轮的回复 "也带引号"\\',
    });
  }
}

test('预算内：与旧渲染逐字节一致，结构化视图不改内容', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t);

  const input = {
    key: 'group:other',
    userId: 'u1',
    text: '现在的输入 "带引号"',
    situation: 'SITUATION_MARKER',
    platform: 'PLATFORM_MARKER',
    history: [{ text: 'H1' }, { text: 'H2', isSelf: true }],
  };
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000 });
  await brain.reply({ ...input, record: false });

  const raw = calls.at(-1).init.body;
  const expected = expectedBody({
    role,
    text: input.text,
    history: input.history,
    platform: input.platform,
    parts: { situation: input.situation, memory: memory.renderPerson('u1'), recent: memory.renderRecent(20) },
  });
  assert.equal(raw, expected, '预算内请求体必须与旧装配逐字节一致');
  assert.ok(raw.length <= 50000);
  const sys = systemOf(raw);
  assert.ok(sys.includes(RECENT_HEADER), '五轮都应在预算内');
  for (const mark of ['OLD1_', 'OLD5_', 'R1_', 'R5_']) assert.ok(sys.includes(mark), mark);
});

test('溢出：最旧一轮的 user 与 reply 一起消失，更新的完整轮保留，边界按真实序列化长度', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  seedRounds(memory);
  const calls = installFetch(t);

  const view = memory.recentRoundView(20);
  assert.equal(view.roundCount, 5);
  const prefix = { situation: 'SITUATION_MARKER', memory: memory.renderPerson('u1') };
  const bodyKeeping = (keep) => expectedBody({
    role,
    text: 'NOW',
    parts: { ...prefix, recent: view.renderFrom(view.roundCount - keep) },
  });
  const keepThree = bodyKeeping(3);
  const keepTwo = bodyKeeping(2);
  assert.ok(keepTwo.length < keepThree.length, '少留一轮必须更短');

  const reply = (cap) => new Brain({ apiKey: '合成-key', role, memory, maxInputChars: cap })
    .reply({ key: 'private:other', userId: 'u1', text: 'NOW', situation: prefix.situation, record: false });

  // cap 恰好等于「保留最近三轮」的序列化长度：应正好保留这三轮
  await reply(keepThree.length);
  const raw3 = calls.at(-1).init.body;
  assert.equal(raw3, keepThree);
  assert.equal(raw3.length, keepThree.length);
  const sys3 = systemOf(raw3);
  assert.equal(sys3.includes('OLD1_'), false, '最旧一轮的 user 必须整轮消失');
  assert.equal(sys3.includes('R1_'), false, '最旧一轮的 reply 必须一起消失');
  for (const i of [3, 4, 5]) {
    assert.ok(sys3.includes('OLD' + i + '_'), '更新一轮的 user 必须保留：' + i);
    assert.ok(sys3.includes('R' + i + '_'), '更新一轮的 reply 必须一起保留：' + i);
  }
  assert.ok(sys3.includes(RECENT_HEADER));

  // 再少一个字符就只能保留两轮：边界由真实 payload 决定，而不是按正文字符数估
  await reply(keepThree.length - 1);
  const raw2 = calls.at(-1).init.body;
  assert.equal(raw2, keepTwo);
  const sys2 = systemOf(raw2);
  assert.equal(sys2.includes('OLD3_'), false, '只能保留最近两轮');
  assert.ok(sys2.includes('OLD4_'));
  assert.ok(sys2.includes('OLD5_'));
  assert.ok(sys2.includes('R5_'));
});

test('过滤同会话：excludeWhere 的整轮既不进视图，也不参与裁剪', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  memory.logTurn({ where: 'private:u1', who: '阿明', text: 'PRIV1_只属于私聊', reply: 'PRIVREPLY1_私聊回复' });
  memory.logTurn({ where: 'group:9', who: '阿明', text: 'GROUP1_群里说过', reply: 'GROUPREPLY1_群里回复' });
  memory.logTurn({ where: 'private:u1', who: '阿明', text: 'PRIV2_第二句', reply: 'PRIVREPLY2_第二条回复' });
  memory.logTurn({ where: 'group:9', who: '阿明', text: 'GROUP2_群里又说', reply: 'GROUPREPLY2_再回' });
  const calls = installFetch(t);

  const view = memory.recentRoundView(20, { excludeWhere: 'group:9' });
  assert.equal(view.roundCount, 2, '群 9 的两轮不应计进视图');
  assert.equal(view.text, memory.renderRecent(20, { excludeWhere: 'group:9' }));
  assert.equal(view.text.includes('GROUP1_'), false);
  const person = memory.renderPerson('u1');

  // 预算内：用的就是过滤后的整段
  const bothRounds = expectedBody({ role, text: 'NOW', parts: { situation: '', memory: person, recent: view.text } });
  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 100000 })
    .reply({ key: 'group:9', userId: 'u1', text: 'NOW', record: false });
  assert.equal(calls.at(-1).init.body, bothRounds);

  // 溢出：先丢最旧的一轮私聊；群里那两轮从头到尾都不出现
  const oneRound = expectedBody({ role, text: 'NOW', parts: { situation: '', memory: person, recent: view.renderFrom(1) } });
  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: oneRound.length })
    .reply({ key: 'group:9', userId: 'u1', text: 'NOW', record: false });
  const raw = calls.at(-1).init.body;
  assert.equal(raw, oneRound);
  const sys = systemOf(raw);
  assert.equal(sys.includes('PRIV1_'), false);
  assert.equal(sys.includes('PRIVREPLY1_'), false);
  assert.ok(sys.includes('PRIV2_'));
  assert.ok(sys.includes('PRIVREPLY2_'));
  assert.equal(sys.includes('GROUP1_'), false);
  assert.equal(sys.includes('GROUP2_'), false);
});

test('全丢 recent 之后才继续减 memory → situation，固定层永不裁剪', async (t) => {
  const role = tempRole(t);
  const memory = tempMemory(t);
  memory.remember('u7', { name: '阿七', trait: 'TRAIT_MARKER_' + 't'.repeat(60) });
  memory.logTurn({
    where: 'private:u7',
    who: '阿七',
    text: 'TURN_MARKER_' + 'x'.repeat(60),
    reply: 'REPLY_MARKER_' + 'y'.repeat(60),
  });
  const calls = installFetch(t);
  const person = memory.renderPerson('u7');
  const situation = 'SITUATION_MARKER_' + 's'.repeat(60);
  assert.ok(person.includes('TRAIT_MARKER_'));
  assert.ok(memory.renderRecent(20).includes('TURN_MARKER_'));

  const stages = [
    { parts: { situation, memory: person, recent: '' }, gone: ['TURN_MARKER_'], kept: ['TRAIT_MARKER_', 'SITUATION_MARKER_'] },
    { parts: { situation, memory: '', recent: '' }, gone: ['TURN_MARKER_', 'TRAIT_MARKER_'], kept: ['SITUATION_MARKER_'] },
    { parts: { situation: '', memory: '', recent: '' }, gone: ['TURN_MARKER_', 'TRAIT_MARKER_', 'SITUATION_MARKER_'], kept: [] },
  ];
  let previous = Infinity;
  for (const stage of stages) {
    const expected = expectedBody({ role, text: 'NOW', ...stage });
    assert.ok(expected.length < previous, '逐级减量必须单调变短');
    previous = expected.length;
    await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: expected.length })
      .reply({ key: 'private:other', userId: 'u7', text: 'NOW', situation, record: false });
    const raw = calls.at(-1).init.body;
    assert.equal(raw, expected, '该轮应得到唯一的减量结果');
    const sys = systemOf(raw);
    for (const mark of stage.gone) assert.equal(sys.includes(mark), false, mark + ' 应已丢弃');
    for (const mark of stage.kept) assert.ok(sys.includes(mark), mark + ' 应保留');
    // 固定层（人格 + 基本规矩）永远在场
    assert.ok(sys.includes('【完整设定】'));
    assert.ok(sys.includes('【基本规矩】'));
  }

  // 固定层自己都放不下：fetch 前抛结构化错误，且零写回
  const callsBefore = calls.length;
  const turnsBefore = fs.readFileSync(memory.turnsFile, 'utf8');
  const peopleBefore = fs.readFileSync(memory.peopleFile, 'utf8');
  const over = await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50 })
    .reply({ key: 'private:other', userId: 'u7', text: 'NOW', situation })
    .then(() => null, (error) => error);
  assert.ok(over instanceof Error);
  assert.equal(over.code, 'context-budget-overflow');
  assert.equal(calls.length, callsBefore, '超限时不得调用 fetch');
  assert.equal(fs.readFileSync(memory.turnsFile, 'utf8'), turnsBefore);
  assert.equal(fs.readFileSync(memory.peopleFile, 'utf8'), peopleBefore);
});

test('自定义 renderer：拿不到结构化轮次就维持整块 fallback', async (t) => {
  const role = tempRole(t);
  class CustomMemory extends Memory {
    renderRecent() { return 'CUSTOM_RECENT_MARKER ' + 'c'.repeat(200); }
  }
  const memory = new CustomMemory({ dir: tempDir(t) });
  seedRounds(memory);
  assert.equal(memory.recentRoundView(20), null, '自定义 renderer 不提供结构化候选');

  const calls = installFetch(t);
  const person = memory.renderPerson('u1');
  const recent = memory.renderRecent(20);
  const full = expectedBody({ role, text: 'NOW', parts: { situation: '', memory: person, recent } });

  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000 })
    .reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });
  assert.equal(calls.at(-1).init.body, full);
  assert.ok(systemOf(calls.at(-1).init.body).includes('CUSTOM_RECENT_MARKER'));

  // 溢出：自定义渲染一次只能整块丢，不会出现「半轮」
  const withoutRecent = expectedBody({ role, text: 'NOW', parts: { situation: '', memory: person, recent: '' } });
  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: full.length - 1 })
    .reply({ key: 'private:other', userId: 'u1', text: 'NOW', record: false });
  assert.equal(calls.at(-1).init.body, withoutRecent);

  // 取数本身不可信（非数组）：同样退回
  class BrokenTurnsMemory extends Memory {
    recentTurns() { return null; }
  }
  assert.equal(new BrokenTurnsMemory({ dir: tempDir(t) }).recentRoundView(20), null);
});

test('Memory.recentRoundView：整段、按整轮裁剪、越界与非法入参', (t) => {
  const memory = tempMemory(t);
  seedRounds(memory);
  const view = memory.recentRoundView(20);
  assert.equal(view.text, memory.renderRecent(20));
  assert.equal(view.roundCount, 5);
  assert.equal(view.renderFrom(0), view.text);
  assert.equal(view.renderFrom(-1), view.text, '非正数按 0 处理');
  assert.equal(view.renderFrom(1.5), view.text, '非整数按 0 处理');
  assert.equal(view.renderFrom(5), '');
  assert.equal(view.renderFrom(99), '', '越界丢光即可，不抛');

  // 丢最旧两轮 == 对剩余三条记录调 renderRecent
  class SliceMemory extends Memory {
    constructor(dir, rows) { super({ dir }); this.rows = rows; }
    recentTurns() { return this.rows; }
  }
  const rows = memory.recentTurns(20);
  const subset = new SliceMemory(tempDir(t), rows.slice(2));
  assert.equal(view.renderFrom(2), subset.renderRecent(20));
  assert.equal(view.renderFrom(2).includes('OLD2_'), false);
  assert.ok(view.renderFrom(2).includes('OLD3_'));

  // 空账本
  const empty = new Memory({ dir: tempDir(t) });
  const emptyView = empty.recentRoundView(20);
  assert.equal(emptyView.text, '');
  assert.equal(emptyView.roundCount, 0);
  assert.equal(emptyView.renderFrom(0), '');
});

test('不可信 / 报错的可选视图：一律退回旧整块路径', async (t) => {
  const role = tempRole(t);
  const calls = installFetch(t);
  const situation = 'SITUATION_MARKER';
  const person = 'PERSON_MARKER_' + 'p'.repeat(40);
  const recentText = 'RECENT_MARKER_' + 'r'.repeat(40);
  const base = () => ({ renderPerson: () => person, renderRecent: () => recentText, remember() {}, logTurn() {} });

  const views = [
    ['没有 recentRoundView', () => base()],
    ['调用就抛错', () => ({ ...base(), recentRoundView() { throw new Error('view boom'); } })],
    ['返回 null', () => ({ ...base(), recentRoundView: () => null })],
    ['返回非对象', () => ({ ...base(), recentRoundView: () => 'nope' })],
    ['text 非字符串', () => ({ ...base(), recentRoundView: () => ({ text: 42, roundCount: 2, renderFrom: () => '' }) })],
    ['缺 renderFrom', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: 2 }) })],
    ['roundCount 非整数', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: 1.5, renderFrom: () => '' }) })],
    ['roundCount 为负', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: -1, renderFrom: () => '' }) })],
    ['没有轮次', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: 0, renderFrom: () => '' }) })],
    ['renderFrom 抛错', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: 2, renderFrom() { throw new Error('round boom'); } }) })],
    ['renderFrom 返回非字符串', () => ({ ...base(), recentRoundView: () => ({ text: recentText, roundCount: 2, renderFrom: () => null }) })],
  ];

  // cap 恰好等于「recent 整块丢掉」的长度：正常实现会得到这唯一一份请求体
  const planned = expectedBody({ role, text: 'NOW', parts: { situation, memory: person, recent: '' } });
  for (const [name, make] of views) {
    const brain = new Brain({ apiKey: '合成-key', role, memory: make(), maxInputChars: planned.length });
    await brain.reply({ key: 'k1', userId: 'u1', text: 'NOW', situation, record: false });
    const raw = calls.at(-1).init.body;
    assert.equal(raw, planned, name + '：应等同于旧版整块丢弃后的请求体');
    assert.equal(systemOf(raw).includes('RECENT_MARKER_'), false, name + '：坏视图的正文不得进入请求');
  }
});

test('roundCount 超出请求上限：尝试次数按 20 收住，不碰范围外的轮次', async (t) => {
  const role = tempRole(t);
  const calls = installFetch(t);
  const situation = 'SITUATION_MARKER';
  let attempts = 0;
  const memory = {
    renderPerson: () => '',
    renderRecent: () => 'R'.repeat(600),
    remember() {},
    logTurn() {},
    recentRoundView: () => ({
      text: 'R'.repeat(600),
      roundCount: 500,
      renderFrom() { attempts += 1; return 'R'.repeat(600); },
    }),
  };
  const planned = expectedBody({ role, text: 'NOW', parts: { situation, memory: '', recent: '' } });
  await new Brain({ apiKey: '合成-key', role, memory, maxInputChars: planned.length })
    .reply({ key: 'k', userId: 'u1', text: 'NOW', situation, record: false });

  assert.equal(attempts, 19, '上限 20 轮 → 最多丢 19 次，多出来的 480 轮不去碰');
  assert.equal(calls.at(-1).init.body, planned, '每一轮都放不下时退回整块丢弃');
});
