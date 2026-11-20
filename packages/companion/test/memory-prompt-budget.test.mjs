/**
 * T1 · memory/prompt-budget 深模块测试（隔离候选版）
 * 只测「记录 → 文本」的纯预算；不读写 data/、不构造 Memory 实例、不发网络。
 * Memory v2 迁移集成用例留待后续接线；本文件只保留模块级契约。
 * 验收：node --test packages/companion/test/memory-prompt-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_BUDGET_VERSION,
  DEFAULT_MEMORY_BUDGET_CHARS,
  DEFAULT_MEMORY_BUDGET_RECORDS,
  DEFAULT_MEMORY_KIND_ORDER,
  budgetMemoryBlock,
} from '../src/memory/prompt-budget.js';

const rec = (id, kind, text, extra = {}) => ({ id, kind, text, ...extra });

test('默认上限与现有实现一致：5000 字符 / 36 条 / trait-fact-topic-pending', () => {
  assert.equal(MEMORY_BUDGET_VERSION, 1);
  assert.equal(DEFAULT_MEMORY_BUDGET_CHARS, 5000);
  assert.equal(DEFAULT_MEMORY_BUDGET_RECORDS, 36);
  assert.deepEqual([...DEFAULT_MEMORY_KIND_ORDER], ['trait', 'fact', 'topic', 'pending']);

  const records = Array.from({ length: 40 }, (_, i) => rec('t' + i, 'trait', 'trait-' + i));
  const result = budgetMemoryBlock(records);
  assert.equal(result.version, MEMORY_BUDGET_VERSION);
  assert.equal(result.maxChars, 5000);
  assert.equal(result.maxRecords, 36);
  assert.equal(result.included.length, 36);
  assert.equal(result.included[0], 't0');
  assert.equal(result.included[35], 't35');
  assert.equal(result.omitted.length, 4);
  assert.deepEqual(result.omitted.map((entry) => entry.reason), ['budget', 'budget', 'budget', 'budget']);
  assert.deepEqual(result.omitted.map((entry) => entry.id), ['t36', 't37', 't38', 't39']);
  assert.equal(result.charsUsed, result.text.length);
  assert.ok(result.text.startsWith('你了解他：trait-0；trait-1'));
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['budget-truncated']);
});

test('类别顺序固定：输入顺序不影响渲染顺序与 included 顺序', () => {
  const records = [
    rec('p1', 'pending', '还没问完'),
    rec('q1', 'topic', '聊过猫'),
    rec('f1', 'fact', '养了猫'),
    rec('a1', 'trait', '常熬夜'),
    rec('q2', 'topic', '聊过面试'),
  ];
  const result = budgetMemoryBlock(records);

  assert.deepEqual(result.included, ['a1', 'f1', 'q1', 'q2', 'p1']);
  assert.equal(result.text, [
    '你了解他：常熬夜',
    '他告诉过你：养了猫',
    '你们聊过：聊过猫；聊过面试',
    '⚠️ 你心里还记着没说出口的事：还没问完',
  ].join('\n'));
  assert.equal(result.charsUsed, result.text.length);
  assert.deepEqual(result.omitted, []);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['within-budget']);
});

test('字符预算：text 不超上限，放不下的记录标 budget 且不截断原文', () => {
  const records = [rec('a', 'trait', 'x'.repeat(3000)), rec('b', 'trait', 'y'.repeat(3000))];
  const result = budgetMemoryBlock(records, { maxChars: 5000 });

  assert.equal(result.text, '你了解他：' + 'x'.repeat(3000));
  assert.equal(result.charsUsed, 3005);
  assert.ok(result.charsUsed <= 5000);
  assert.deepEqual(result.included, ['a']);
  assert.deepEqual(result.omitted, [{ id: 'b', kind: 'trait', reason: 'budget' }]);
  assert.ok(result.diagnostics.some((d) => d.code === 'budget-truncated' && d.detail.includes('maxChars=5000')));
});

test('单条记录自身就超上限：整条省略而不是改写正文（已知限制）', () => {
  const result = budgetMemoryBlock([rec('big', 'fact', 'z'.repeat(6000))]);
  assert.equal(result.text, '');
  assert.equal(result.charsUsed, 0);
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.omitted, [{ id: 'big', kind: 'fact', reason: 'budget' }]);
});

test('minConfidence 只过滤不改写；缺省 confidence 视为可信', () => {
  const records = [
    rec('low', 'fact', '低置信事实', { confidence: 0.45 }),
    rec('mid', 'fact', '中等置信事实', { confidence: 0.8 }),
    rec('none', 'fact', '无置信度事实'),
  ];
  const result = budgetMemoryBlock(records, { minConfidence: 0.6 });

  assert.deepEqual(result.included, ['mid', 'none']);
  assert.deepEqual(result.omitted, [{ id: 'low', kind: 'fact', reason: 'confidence' }]);
  assert.equal(result.text, '他告诉过你：中等置信事实；无置信度事实');
  assert.equal(result.text.includes('0.45'), false, '数值不得进 prompt');
});

test('kindOrder 之外的类别被结构性省略（reason=kind），并按入参顺序记录', () => {
  const records = [
    rec('t1', 'trait', '常熬夜'),
    rec('i1', 'interaction', '互动 12 次'),
    rec('turn1', 'turn', '聊过天气'),
    rec('p1', 'pending', '还没说完'),
  ];
  const result = budgetMemoryBlock(records);
  assert.deepEqual(result.included, ['t1', 'p1']);
  assert.deepEqual(result.omitted, [
    { id: 'i1', kind: 'interaction', reason: 'kind' },
    { id: 'turn1', kind: 'turn', reason: 'kind' },
  ]);
  assert.equal(result.text, '你了解他：常熬夜\n⚠️ 你心里还记着没说出口的事：还没说完');
});

test('自定义 kindOrder 同时决定过滤与渲染顺序', () => {
  const records = [rec('a', 'trait', '常熬夜'), rec('b', 'pending', '还没说完'), rec('c', 'fact', '养了猫')];
  const result = budgetMemoryBlock(records, { kindOrder: ['fact'] });
  assert.deepEqual(result.included, ['c']);
  assert.deepEqual(result.omitted, [
    { id: 'a', kind: 'trait', reason: 'kind' },
    { id: 'b', kind: 'pending', reason: 'kind' },
  ]);
  assert.equal(result.text, '他告诉过你：养了猫');
});

test('maxChars=0 / maxRecords=0：空文本且全部标 budget', () => {
  const records = [rec('a', 'trait', '常熬夜'), rec('b', 'fact', '养了猫')];

  const zeroChars = budgetMemoryBlock(records, { maxChars: 0 });
  assert.equal(zeroChars.text, '');
  assert.equal(zeroChars.charsUsed, 0);
  assert.deepEqual(zeroChars.omitted.map((entry) => entry.reason), ['budget', 'budget']);

  const zeroRecords = budgetMemoryBlock(records, { maxRecords: 0 });
  assert.equal(zeroRecords.text, '');
  assert.deepEqual(zeroRecords.included, []);
  assert.deepEqual(zeroRecords.omitted.map((entry) => entry.id), ['a', 'b']);
  assert.ok(zeroRecords.diagnostics.some((d) => d.code === 'budget-truncated' && d.detail.includes('maxRecords=0')));
});

test('自定义 render：逐条渲染并用换行连接；非字符串返回直接报错', () => {
  const records = [rec('a', 'trait', '常熬夜'), rec('b', 'fact', '养了猫')];
  const result = budgetMemoryBlock(records, { render: (record) => '-' + record.text });

  assert.equal(result.text, '-常熬夜\n-养了猫');
  assert.equal(result.charsUsed, result.text.length);
  assert.deepEqual(result.included, ['a', 'b']);
  assert.throws(() => budgetMemoryBlock(records, { render: () => 42 }), TypeError);
  assert.throws(() => budgetMemoryBlock(records, { render: 'nope' }), TypeError);
});

test('空正文/非对象记录被跳过并留诊断（不进 omitted、不泄漏内容）', () => {
  const records = [
    rec('blank', 'trait', '   '),
    { id: 'no-text', kind: 'fact' },
    null,
    'not-a-record',
    rec('ok', 'trait', '常熬夜'),
  ];
  const result = budgetMemoryBlock(records);
  assert.deepEqual(result.included, ['ok']);
  assert.deepEqual(result.omitted, []);
  assert.ok(result.diagnostics.some((d) => d.code === 'blank-record-skipped' && d.detail === '4 条无正文记录'));
});

test('无 id 的记录使用确定性合成 id；重复调用结果一致且不改入参', () => {
  const records = [{ kind: 'trait', text: '常熬夜' }, { kind: 'fact', text: '养了猫' }];
  const snapshot = JSON.parse(JSON.stringify(records));

  const first = budgetMemoryBlock(records);
  const second = budgetMemoryBlock(records);

  assert.deepEqual(first.included, ['row:0', 'row:1']);
  assert.deepEqual(first, second);
  assert.deepEqual(records, snapshot, 'records 不得被改写');
  assert.notEqual(first.included, records, '返回的数组必须是新数组');
});

test('omitted/diagnostics 不含正文，字符数与 text 长度一致', () => {
  const markers = ['BODY_TRAIT_MARKER', 'BODY_FACT_MARKER', 'BODY_LOW_MARKER'];
  const records = [
    rec('a', 'trait', markers[0] + '常熬夜'),
    rec('b', 'fact', markers[1] + '养了猫', { confidence: 0.1 }),
    rec('c', 'unknown', markers[2] + '别的'),
    rec('d', 'pending', 'x'.repeat(6000)),
  ];
  const result = budgetMemoryBlock(records, { minConfidence: 0.5 });
  const sideChannel = JSON.stringify({ omitted: result.omitted, diagnostics: result.diagnostics });

  for (const marker of markers) assert.equal(sideChannel.includes(marker), false, '诊断/省略清单不得泄漏正文');
  assert.equal(result.charsUsed, result.text.length);
  assert.ok(result.charsUsed <= DEFAULT_MEMORY_BUDGET_CHARS);
  for (const entry of result.omitted) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'kind', 'reason']);
    assert.ok(['budget', 'confidence', 'kind'].includes(entry.reason));
  }
});

test('空输入与非数组入参的边界', () => {
  const empty = budgetMemoryBlock([]);
  assert.equal(empty.text, '');
  assert.equal(empty.charsUsed, 0);
  assert.deepEqual(empty.included, []);
  assert.deepEqual(empty.omitted, []);
  assert.deepEqual(empty.diagnostics.map((d) => d.code), ['empty-input']);

  const nullInput = budgetMemoryBlock(null);
  assert.equal(nullInput.text, '');
  assert.deepEqual(nullInput.included, []);

  assert.throws(() => budgetMemoryBlock('nope'), TypeError);
  assert.throws(() => budgetMemoryBlock({ kind: 'trait' }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { maxChars: -1 }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { maxRecords: NaN }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { minConfidence: 'high' }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { minConfidence: 1.5 }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { kindOrder: [] }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], { kindOrder: [''] }), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], null), TypeError);
  assert.throws(() => budgetMemoryBlock([rec('a', 'trait', 'x')], []), TypeError);
});

test('同类别内保持输入顺序，跨类别按 kindOrder 稳定分组', () => {
  const records = [
    rec('t2', 'trait', '第二条'),
    rec('f1', 'fact', '事实一'),
    rec('t1', 'trait', '第一条'),
    rec('f2', 'fact', '事实二'),
  ];
  const result = budgetMemoryBlock(records);
  assert.deepEqual(result.included, ['t2', 't1', 'f1', 'f2']);
  assert.equal(result.text, '你了解他：第二条；第一条\n他告诉过你：事实一；事实二');
});

test('前缀预算不补位：第一条放不下后，后续更短记录也标 budget；诊断不含正文', () => {
  const longBody = 'PREFIX_BODY_MARKER_' + 'x'.repeat(5000);
  const shortBody = 'SHORT_BODY_MARKER_养了猫';
  const records = [
    rec('big', 'trait', longBody),
    rec('small', 'fact', shortBody),
  ];

  // 第一条（trait）加标签后已超 5000，模块关闭前缀；第二条（fact）虽短也不得回填。
  const result = budgetMemoryBlock(records, { maxChars: 5000 });

  assert.equal(result.text, '');
  assert.deepEqual(result.included, []);
  assert.deepEqual(result.omitted, [
    { id: 'big', kind: 'trait', reason: 'budget' },
    { id: 'small', kind: 'fact', reason: 'budget' },
  ]);
  assert.ok(result.diagnostics.some((d) => d.code === 'budget-truncated' && d.detail.includes('maxChars=5000')));

  const sideChannel = JSON.stringify({ omitted: result.omitted, diagnostics: result.diagnostics });
  assert.equal(sideChannel.includes('PREFIX_BODY_MARKER'), false, '前缀诊断不得泄漏正文');
  assert.equal(sideChannel.includes('SHORT_BODY_MARKER'), false, '补位诊断不得泄漏正文');
  assert.equal(sideChannel.includes('养了猫'), false, '短记录正文也不得进诊断');
});
