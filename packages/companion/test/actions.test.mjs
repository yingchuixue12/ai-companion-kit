/**
 * actions.js · issue #46（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只覆盖纯解析：五类独行指令（schedule / remember / forget /
 * replace / silent）、普通可见文字、默认与自定义 silent，以及限额。
 * 相对提醒只验证 actions 转出的既有舍入与标点行为。
 *
 * 边界：纯内存、不联网、不读写真实数据、不执行任何动作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import parseActions, {
  MAX_MEMORY_ACTION_TEXT_LENGTH,
  MAX_SCHEDULE_DELAY_MS,
  MAX_SCHEDULE_TEXT_LENGTH,
  MEMORY_ACTION_KINDS,
  SCHEDULE_INTENTS,
  parseActions as namedParseActions,
  parseRelativeReminder,
} from '../src/actions.js';
import {
  MAX_RELATIVE_REMINDER_DELAY_MS,
  MAX_RELATIVE_REMINDER_TEXT_LENGTH,
  parseRelativeReminder as sourceParseRelativeReminder,
} from '../src/relative-reminder.js';

const LONG_500 = '长'.repeat(500);
const LONG_501 = '长'.repeat(501);
const MEM_160 = 'a'.repeat(160);
const MEM_161 = 'b'.repeat(161);

/** 单行解析的完整结果；表驱动用例共用。 */
function result(text, actions = [], silent = false) {
  return { text, silent, actions };
}

test('导出兼容原 actions，且常量与 relative-reminder 一致', () => {
  assert.equal(parseActions, namedParseActions);
  assert.equal(MAX_SCHEDULE_DELAY_MS, MAX_RELATIVE_REMINDER_DELAY_MS);
  assert.equal(MAX_SCHEDULE_TEXT_LENGTH, MAX_RELATIVE_REMINDER_TEXT_LENGTH);
  assert.equal(MAX_MEMORY_ACTION_TEXT_LENGTH, 160);
  assert.deepEqual(SCHEDULE_INTENTS, ['follow-up', 'check-in', 'reminder']);
  assert.deepEqual(MEMORY_ACTION_KINDS, ['trait', 'fact', 'topic', 'pending']);
  assert.equal(parseRelativeReminder, sourceParseRelativeReminder);
});

test('五类独行指令：schedule / remember / forget / replace / silent', () => {
  const cases = [
    {
      name: 'schedule 省略 intent 时默认 follow-up',
      raw: '[[schedule:60000:过一会儿回来看看]]',
      expected: result('', [{ type: 'schedule', intent: 'follow-up', delayMs: 60000, text: '过一会儿回来看看' }]),
    },
    {
      name: 'schedule 明确 intent 并去掉正文头尾空白',
      raw: '  [[schedule:1:check-in:  到点了  ]]  ',
      expected: result('', [{ type: 'schedule', intent: 'check-in', delayMs: 1, text: '到点了' }]),
    },
    {
      name: 'schedule 上限：7 天 / 500 字',
      raw: `[[schedule:604800000:reminder:${LONG_500}]]`,
      expected: result('', [{ type: 'schedule', intent: 'reminder', delayMs: 604800000, text: LONG_500 }]),
    },
    {
      name: 'schedule 正文内部空白保留',
      raw: '[[schedule:1000:  a   b  ]]',
      expected: result('', [{ type: 'schedule', intent: 'follow-up', delayMs: 1000, text: 'a   b' }]),
    },
    {
      name: 'remember 四种 kind，正文 trim 后原样保留',
      raw: '[[remember:trait: 他喜欢深夜聊天 ]]',
      expected: result('', [{ type: 'remember', kind: 'trait', text: '他喜欢深夜聊天' }]),
    },
    {
      name: 'remember fact',
      raw: '[[remember:fact:养了只猫]]',
      expected: result('', [{ type: 'remember', kind: 'fact', text: '养了只猫' }]),
    },
    {
      name: 'remember topic',
      raw: '[[remember:topic:最近在学做饭]]',
      expected: result('', [{ type: 'remember', kind: 'topic', text: '最近在学做饭' }]),
    },
    {
      name: 'remember pending',
      raw: '[[remember:pending:还没问完那件事]]',
      expected: result('', [{ type: 'remember', kind: 'pending', text: '还没问完那件事' }]),
    },
    {
      name: 'remember 保持原行为：不按 160 截断',
      raw: `[[remember:fact:${'x'.repeat(600)}]]`,
      expected: result('', [{ type: 'remember', kind: 'fact', text: 'x'.repeat(600) }]),
    },
    {
      name: 'forget 按 Memory 规则归一化',
      raw: '[[forget:fact:  旧   地址 ]]',
      expected: result('', [{ type: 'forget', kind: 'fact', text: '旧 地址' }]),
    },
    {
      name: 'forget 其余 kind',
      raw: '[[forget:topic:旧话题]]',
      expected: result('', [{ type: 'forget', kind: 'topic', text: '旧话题' }]),
    },
    {
      name: 'replace 只按第一个 => 切分',
      raw: '[[replace:topic:旧=>新=>后]]',
      expected: result('', [{ type: 'replace', kind: 'topic', from: '旧', to: '新=>后' }]),
    },
    {
      name: 'replace trait 归一化两端',
      raw: '[[replace:trait:  旧   =>  新  ]]',
      expected: result('', [{ type: 'replace', kind: 'trait', from: '旧', to: '新' }]),
    },
    {
      name: 'replace fact / pending 可用',
      raw: '[[replace:fact:旧地址=>新地址]]',
      expected: result('', [{ type: 'replace', kind: 'fact', from: '旧地址', to: '新地址' }]),
    },
    {
      name: 'replace pending',
      raw: '[[replace:pending:旧问题=>新问题]]',
      expected: result('', [{ type: 'replace', kind: 'pending', from: '旧问题', to: '新问题' }]),
    },
    {
      name: 'silent 默认标记',
      raw: '[[silent]]',
      expected: result('', [{ type: 'silent' }], true),
    },
  ];

  for (const { name, raw, expected } of cases) {
    assert.deepEqual(parseActions(raw), expected, name);
  }
});

test('普通可见文字：保留原文、丢弃空行、非控制行原样留下', () => {
  const cases = [
    ['空输入', '', result('')],
    ['null', null, result('')],
    ['undefined', undefined, result('')],
    ['只有空白行', '  \n\t\r\n ', result('')],
    ['普通一句话', '普通一句话', result('普通一句话')],
    ['首尾整体 trim、行内空白保留', '  前面 保留  \n\n[[unknown]]\n后面  ', result('前面 保留  \n[[unknown]]\n后面')],
    ['CRLF 按行拆分', 'a\r\nb', result('a\nb')],
    ['schedule 缺冒号按普通文字', '[[schedule]]', result('[[schedule]]')],
    ['remember 空正文按普通文字', '[[remember:trait:]]', result('[[remember:trait:]]')],
    ['replace 缺箭头按普通文字', '[[replace:fact:没有箭头]]', result('[[replace:fact:没有箭头]]')],
    ['非字符串输入转成文字', 123, result('123')],
  ];

  for (const [name, raw, expected] of cases) {
    assert.deepEqual(parseActions(raw), expected, name);
  }
});

test('default / 自定义 silent：静默时清空可见文字', () => {
  assert.deepEqual(parseActions('可见\n[[silent]]\n后文'), result('', [{ type: 'silent' }], true));
  assert.deepEqual(parseActions('  可见  \n  [[silent]]  \n后文'), result('', [{ type: 'silent' }], true));
  assert.deepEqual(parseActions('[[silent]]\n[[silent]]'), result('', [{ type: 'silent' }, { type: 'silent' }], true));

  const custom = { silentToken: '[[安静]]' };
  assert.deepEqual(parseActions('可见\n[[安静]]\n后文', custom), result('', [{ type: 'silent' }], true));
  // 自定义标记下，默认 [[silent]] 只是普通文字。
  assert.deepEqual(parseActions('可见\n[[silent]]', custom), result('可见\n[[silent]]'));
});

test('schedule 非法时间 / 文字 / intent / 形状一律丢弃，不进入可见文字', () => {
  const cases = [
    ['时间 0', '[[schedule:0:x]]'],
    ['超过 7 天', '[[schedule:604800001:x]]'],
    ['非数字时间', '[[schedule:abc:x]]'],
    ['未知 intent', '[[schedule:1000:unknown:x]]'],
    ['空正文', '[[schedule:1000:]]'],
    ['正文 501 字', `[[schedule:1000:${LONG_501}]]`],
    ['缺少结尾', '[[schedule:1000:x'],
    ['时间位数超限', '[[schedule:1234567890123:x]]'],
  ];

  for (const [name, raw] of cases) {
    assert.deepEqual(parseActions(raw), result(''), name);
  }
});

test('schedule 只保留第一条；前一条非法不会占用名额', () => {
  const firstWins = '[[schedule:1000:第一条]]\n[[schedule:2000:第二条]]';
  assert.deepEqual(parseActions(firstWins), result('', [
    { type: 'schedule', intent: 'follow-up', delayMs: 1000, text: '第一条' },
  ]));

  const skipInvalid = '[[schedule:0:无效]]\n[[schedule:1000:有效]]';
  assert.deepEqual(parseActions(skipInvalid), result('', [
    { type: 'schedule', intent: 'follow-up', delayMs: 1000, text: '有效' },
  ]));
});

test('forget / replace：规范化后为空或超过 160 字时仍作为可见文字', () => {
  const cases = [
    ['forget 归一化后为空', '[[forget:fact:   ]]'],
    ['forget 超过 160', `[[forget:fact:${MEM_161}]]`],
    ['replace from 为空', '[[replace:fact:   =>新]]'],
    ['replace to 为空', '[[replace:fact:旧=>   ]]'],
    ['replace from 超过 160', `[[replace:fact:${MEM_161}=>新]]`],
    ['replace to 超过 160', `[[replace:fact:旧=>${MEM_161}]]`],
  ];

  for (const [name, raw] of cases) {
    assert.deepEqual(parseActions(raw), result(raw), name);
  }
});

test('forget / replace 的 160 字边界有效', () => {
  assert.deepEqual(parseActions(`[[forget:fact:${MEM_160}]]`), result('', [
    { type: 'forget', kind: 'fact', text: MEM_160 },
  ]));
  assert.deepEqual(parseActions(`[[replace:fact:${MEM_160}=>${MEM_160}]]`), result('', [
    { type: 'replace', kind: 'fact', from: MEM_160, to: MEM_160 },
  ]));
});

test('相对提醒复用既有解析：舍入与尾部标点兼容', () => {
  const cases = [
    ['1.5 秒四舍五入到 1500ms', '1.5秒后提醒我喝水', { delayMs: 1500, text: '喝水' }],
    ['2.5 毫秒四舍五入到 3ms', '2.5毫秒后提醒我喝水', { delayMs: 3, text: '喝水' }],
    ['多个尾部句末标点被剥离', '5秒后提醒我喝水？！。', { delayMs: 5000, text: '喝水' }],
    ['正文内部标点保留', '5秒后提醒我喝水，好吗？', { delayMs: 5000, text: '喝水，好吗' }],
    ['168 小时上界', '168小时后提醒我喝水', { delayMs: 604800000, text: '喝水' }],
  ];

  for (const [name, raw, expected] of cases) {
    assert.deepEqual(parseRelativeReminder(raw), expected, name);
  }
  assert.equal(parseRelativeReminder('168.1小时后提醒我喝水'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我喝水\n第二行'), null);
});
