/**
 * role · 显式启用的分层渲染（P-1 独立前置）
 * ─────────────────────────────────────────────────────────────
 * 只用合成数据：临时角色卡 + 假 Memory + 假 fetch，不读写 data/、不调真实服务。
 * 验收：
 *   1. 默认 build 逐字节不变（旧顺序、旧截断、旧分隔符，且忽略无关 ctx 键）；
 *   2. 唯一开关 new Role({ layered: true })：L1 永远在最前，完整角色卡不被 maxChars 截断；
 *   3. 真实 Brain 的硬预算在 L1 装不下时 0 次 fetch、结构化拒发；
 *   4. 显式 sections(ctx) 暴露固定名称、可测量的 section，供后续 P-4 使用。
 *
 * 运行：node --test packages/companion/test/role-layered-prompt.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { ROLE_SECTION_NAMES, Role, TASK_REFERENCES_TITLE } from '../src/role.js';

const MODEL = 'deepseek-chat';

function tempCard(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-role-layered-'));
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return cardPath;
}

function fakeMemory({ person = '', recent = '' } = {}) {
  const calls = { remember: 0, logTurn: 0 };
  return {
    calls,
    renderPerson: () => person,
    renderRecent: () => recent,
    remember() { calls.remember += 1; },
    logTurn() { calls.logTurn += 1; },
  };
}

function installFetch(t, message = { content: 'ok' }) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 以 Brain.reply 的同一形状装配请求体，用于逐字节比对 */
function expectedBody({ role, text, history = [], platform = '', parts }) {
  const sys = role.build({ ...parts, platform });
  const messages = [{ role: 'system', content: sys }];
  for (const h of history.slice(-20)) {
    messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
  }
  messages.push({ role: 'user', content: String(text || '') });
  return JSON.stringify({ model: MODEL, messages, temperature: 1.1, stream: false });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('默认 build 逐字节不变：旧顺序、旧截断、旧分隔符', (t) => {
  const cardPath = tempCard(t, 'CARD_MARK_BODY');
  const role = new Role({ cardPath, maxChars: 2000, extra: 'EXTRA_MARK' });
  const ctx = {
    situation: 'SIT_MARK',
    memory: 'MEM_MARK',
    recent: 'RECENT_MARK',
    taskReferences: ['TASK_ONE', 'TASK_TWO'],
    selfNote: 'NOTE_MARK',
    platform: 'PLATFORM_MARK',
  };
  const out = role.build(ctx);

  // 快照锁死旧输出：任何默认路径的字符、顺序或分隔符变化都会失败。
  assert.equal(out.length, 347);
  assert.equal(sha256(out), 'ce2e8fc36e186fd16c8407668f430cb0a67e7ab8cd584e84aee19f6af5029739');

  // 旧顺序：参考块在 L1 之前；L1 内部是 BASE_RULES → extra → 角色卡；平台说明最后。
  assert.ok(out.indexOf('SIT_MARK') < out.indexOf('MEM_MARK'));
  assert.ok(out.indexOf('MEM_MARK') < out.indexOf('RECENT_MARK'));
  assert.ok(out.indexOf('RECENT_MARK') < out.indexOf(TASK_REFERENCES_TITLE));
  assert.ok(out.indexOf(TASK_REFERENCES_TITLE) < out.indexOf('NOTE_MARK'));
  assert.ok(out.indexOf('NOTE_MARK') < out.indexOf('【基本规矩】'));
  assert.ok(out.indexOf('【基本规矩】') < out.indexOf('EXTRA_MARK'));
  assert.ok(out.indexOf('EXTRA_MARK') < out.indexOf('【完整设定】\nCARD_MARK_BODY'));
  assert.ok(out.endsWith('【平台给你的说明】\nPLATFORM_MARK'));

  // 旧 build(ctx) 只认 ctx 里的已知键：无关键、第二参数和 ctx.layered 都不能改变输出。
  assert.equal(role.build({ ...ctx, layered: true }), out);
  assert.equal(role.build({ ...ctx, unrelated: 'IGNORED' }), out);
  assert.equal(role.build(ctx, { layered: true }), out);
  assert.equal(new Role({ cardPath, maxChars: 2000, extra: 'EXTRA_MARK' }).build(ctx), out);

  // 默认模式的旧截断行为也必须保留：长卡仍按 maxChars 从头保留、切尾部。
  const longCard = 'LONG_CARD_' + 'c'.repeat(500);
  const longRole = new Role({ cardPath: tempCard(t, longCard), maxChars: 250 });
  const truncated = longRole.build({});
  assert.ok(truncated.includes('【完整设定】\nLONG_CARD_'));
  assert.ok(truncated.length < longCard.length, '默认模式长卡必须仍被截断');
});

test('分层模式：完整 L1 在所有参考块之前，角色卡不被 maxChars 截断', (t) => {
  const card = 'CARD_MARK_' + 'c'.repeat(800);
  const role = new Role({
    cardPath: tempCard(t, card),
    maxChars: 20,
    extra: 'EXTRA_MARK',
    layered: true,
  });
  const ctx = {
    situation: 'SIT_MARK',
    memory: 'MEM_MARK',
    recent: 'RECENT_MARK',
    taskReferences: ['TASK_ONE', 'TASK_TWO'],
    selfNote: 'NOTE_MARK',
    platform: 'PLATFORM_MARK',
  };
  const out = role.build(ctx);

  assert.ok(out.startsWith('【基本规矩】'));
  assert.ok(out.includes('【完整设定】\n' + card), '分层模式必须保留完整角色卡');
  assert.ok(card.length > role.maxChars, '用例前提：角色卡长于 maxChars');

  // L1 必须是连续前缀：基本规矩 / extra / 角色卡之间不能插参考块。
  const firstReference = out.indexOf('SIT_MARK');
  assert.notEqual(firstReference, -1);
  const l1 = out.slice(0, firstReference);
  assert.ok(l1.includes('【基本规矩】'));
  assert.ok(l1.includes('EXTRA_MARK'));
  assert.ok(l1.includes(card));
  for (const marker of ['MEM_MARK', 'RECENT_MARK', 'TASK_ONE', 'NOTE_MARK', 'PLATFORM_MARK']) {
    assert.equal(l1.includes(marker), false, marker + ' 不得插进 L1');
  }

  // 参考块保持既有相对顺序；L6 仍是独立固定块；平台说明仍在最后。
  const order = ['SIT_MARK', 'MEM_MARK', 'RECENT_MARK', 'TASK_ONE', 'NOTE_MARK', 'PLATFORM_MARK'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(out.indexOf(order[i - 1]) < out.indexOf(order[i]), order[i - 1] + ' 应排在 ' + order[i] + ' 之前');
  }
  assert.equal(out.split(TASK_REFERENCES_TITLE).length - 1, 1);
  assert.ok(out.includes(TASK_REFERENCES_TITLE + '\n- TASK_ONE\n- TASK_TWO'));
  assert.ok(out.endsWith('【平台给你的说明】\nPLATFORM_MARK'));

  // 唯一开关是构造参数：ctx 里的同名键不能关闭或开启分层模式。
  assert.equal(role.build({ ...ctx, layered: false }), out);
  const defaultRole = new Role({ cardPath: role.cardPath, maxChars: 20, extra: 'EXTRA_MARK' });
  assert.notEqual(defaultRole.build({ ...ctx, layered: true }), out);
  assert.ok(defaultRole.build({ ...ctx, layered: true }).includes('SIT_MARK'));
});

test('分层接口暴露固定名称、可测量的 section，拼接结果与 build 一致', (t) => {
  const role = new Role({ cardPath: tempCard(t, 'CARD_MARK'), extra: 'EXTRA_MARK', layered: true });
  const ctx = {
    situation: 'SIT_MARK',
    memory: 'MEM_MARK',
    recent: 'RECENT_MARK',
    taskReferences: ['TASK_ONE'],
    selfNote: 'NOTE_MARK',
    platform: 'PLATFORM_MARK',
  };

  assert.deepEqual([...ROLE_SECTION_NAMES], [
    'baseRules',
    'extra',
    'card',
    'situation',
    'memory',
    'recent',
    'taskReferences',
    'selfNote',
    'platform',
  ]);
  assert.ok(Object.isFrozen(ROLE_SECTION_NAMES));

  const sections = role.sections(ctx);
  assert.deepEqual(sections.map((section) => section.name), [...ROLE_SECTION_NAMES]);
  for (const section of sections) {
    assert.equal(typeof section.text, 'string');
    assert.equal(section.chars, section.text.length, section.name + ' 的 chars 必须按 UTF-16 字符计');
  }
  assert.deepEqual(sections.slice(0, 3).map((section) => section.name), ['baseRules', 'extra', 'card']);
  assert.equal(
    sections.filter((section) => section.text).map((section) => section.text).join('\n\n'),
    role.build(ctx),
    'section 拼接必须与分层 build 逐字节一致',
  );
  // 显式 section 接口与开关无关：默认 Role 也能按同一固定 schema 测量。
  const defaultRole = new Role({ cardPath: role.cardPath, extra: 'EXTRA_MARK' });
  assert.deepEqual(defaultRole.sections(ctx).map((section) => section.name), [...ROLE_SECTION_NAMES]);

  // 空块也返回固定名字与 0 字符，P-4 不需要猜缺了哪一块。
  const empty = role.sections({});
  assert.deepEqual(empty.map((section) => section.name), [...ROLE_SECTION_NAMES]);
  for (const name of ['situation', 'memory', 'recent', 'taskReferences', 'selfNote', 'platform']) {
    const section = empty.find((item) => item.name === name);
    assert.equal(section.text, '');
    assert.equal(section.chars, 0);
  }
});

test('lint 与模式一致：默认提示会被截断，分层模式提示由 Brain 硬预算拒发', (t) => {
  const card = '她说话短，不客套。' + 'c'.repeat(300);
  const cardPath = tempCard(t, card);
  const legacy = new Role({ cardPath, maxChars: 50 });
  const layered = new Role({ cardPath, maxChars: 50, layered: true });

  assert.ok(legacy.lint().warn.some((warning) => warning.includes('会被截断')));
  const layeredWarnings = layered.lint().warn;
  assert.ok(layeredWarnings.some((warning) => warning.includes('分层渲染不截断')));
  assert.equal(layeredWarnings.some((warning) => warning.includes('会被截断')), false);
});

test('真实 Brain + 假 fetch：L1 装不下时 0 次 fetch、结构化拒发、不泄漏正文', async (t) => {
  const card = 'L1_TOO_BIG_MARK' + 'x'.repeat(5000);
  const role = new Role({ cardPath: tempCard(t, card), maxChars: 10, layered: true });
  const memory = fakeMemory();
  const calls = installFetch(t);
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 800 });

  const err = await brain.reply({
    key: 'k',
    userId: 'u',
    text: 'USER_SECRET',
    situation: 'SITUATION_SECRET',
    platform: 'PLATFORM_SECRET',
  }).then(() => null, (error) => error);

  assert.ok(err instanceof Error);
  assert.equal(err.code, 'context-budget-overflow');
  assert.equal(err.maxInputChars, 800);
  assert.ok(Number.isInteger(err.inputChars));
  assert.ok(err.inputChars > 800);
  assert.equal(calls.length, 0, 'L1 装不下时不得调用模型');
  assert.equal(memory.calls.remember, 0, '拒发时不得写回记忆');
  assert.equal(memory.calls.logTurn, 0, '拒发时不得写回对话');
  for (const marker of ['L1_TOO_BIG_MARK', 'USER_SECRET', 'SITUATION_SECRET', 'PLATFORM_SECRET']) {
    assert.equal(JSON.stringify(err).includes(marker), false, '错误不得携带正文：' + marker);
  }
});

test('真实 Brain + 假 fetch：短角色卡按分层顺序发送，超预算先丢参考块、保留完整 L1 与 L6 独立槽', async (t) => {
  const card = 'SHORT_CARD_MARK';
  const role = new Role({ cardPath: tempCard(t, card), layered: true });
  const memory = fakeMemory({
    person: 'MEMORY_MARK' + 'm'.repeat(1200),
    recent: 'RECENT_MARK' + 'r'.repeat(1200),
  });
  const calls = installFetch(t);
  const input = {
    key: 'k',
    userId: 'u',
    text: 'USER_MARK',
    situation: 'SITUATION_MARK' + 's'.repeat(1200),
    platform: 'PLATFORM_MARK',
    taskReferences: ['TASK_MARK'],
  };
  // 上限刚好等于「L1 + 平台说明 + L6 + 用户原文」：三个参考块都放不下，L6 仍应留下。
  const expected = expectedBody({
    role,
    text: input.text,
    platform: input.platform,
    parts: { situation: '', memory: '', recent: '', taskReferences: input.taskReferences },
  });
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: expected.length });

  const out = await brain.reply(input);

  assert.equal(out.text, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, expected, '应得到「丢掉三个参考块、保留 L1/L6/平台」的唯一请求体');
  assert.equal(calls[0].init.body.length, expected.length);
  const sys = JSON.parse(calls[0].init.body).messages[0].content;
  assert.ok(sys.startsWith('【基本规矩】'), 'system prompt 必须以 L1 开头');
  assert.ok(sys.includes('【完整设定】\n' + card), '短角色卡必须完整保留');
  assert.ok(sys.includes(TASK_REFERENCES_TITLE + '\n- TASK_MARK'), 'L6 仍是独立固定块');
  assert.ok(sys.includes('PLATFORM_MARK'));
  assert.ok(sys.endsWith('【平台给你的说明】\nPLATFORM_MARK'), '平台说明仍在最后');
  for (const marker of ['SITUATION_MARK', 'MEMORY_MARK', 'RECENT_MARK']) {
    assert.equal(sys.includes(marker), false, marker + ' 应先被预算丢掉');
  }
});

test('真实 Brain + 假 fetch：默认 Role 的请求体与旧装配逐字节一致', async (t) => {
  const cardPath = tempCard(t, 'CARD_MARK_BODY');
  const role = new Role({ cardPath, maxChars: 2000, extra: 'EXTRA_MARK' });
  const memory = fakeMemory({ person: 'MEMORY_MARK', recent: 'RECENT_MARK' });
  const calls = installFetch(t);
  const input = {
    key: 'k',
    userId: 'u',
    text: 'USER_MARK',
    situation: 'SIT_MARK',
    platform: 'PLATFORM_MARK',
    history: [{ text: 'H1' }, { text: 'H2', isSelf: true }],
  };
  const brain = new Brain({ apiKey: '合成-key', role, memory, maxInputChars: 50000 });

  await brain.reply(input);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, expectedBody({
    role,
    text: input.text,
    history: input.history,
    platform: input.platform,
    parts: { situation: input.situation, memory: 'MEMORY_MARK', recent: 'RECENT_MARK' },
  }));
});
