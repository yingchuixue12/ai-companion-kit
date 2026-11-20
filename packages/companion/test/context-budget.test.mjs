/**
 * T1 · context-budget 深模块测试（隔离候选版）
 * 只测纯函数：不读 data/、不发网络、不碰 Role/Memory 实例。
 * 两条与真实 Role.build 的集成用例留待 S2 接线；本文件只保留模块级契约。
 * 验收：node --test packages/companion/test/context-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_BUDGET_VERSION,
  DEFAULT_DROP_ORDER,
  planContextBudget,
} from '../src/context-budget.js';

/**
 * 测试内独立夹具：等长保留首尾。接线前不依赖 brain.clipPreservingEnds，
 * 用来验证 trim 契约「只减不增、长度精确」；产品接线后由 S2 换回真实实现。
 */
const ELLIPSIS = '…（中间内容已省略）…';
function clipPreservingEnds(value, limit) {
  const source = String(value || '');
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (source.length <= max) return source;
  if (max <= ELLIPSIS.length) return source.slice(0, max);
  const room = max - ELLIPSIS.length;
  const head = Math.ceil(room / 2);
  const tail = Math.floor(room / 2);
  return source.slice(0, head) + ELLIPSIS + (tail > 0 ? source.slice(-tail) : '');
}

/** 稳定人格层（BASE_RULES + 角色卡）在 measure 里的固定项，本模块永远碰不到它 */
const STABLE = 'S'.repeat(1000);

function additiveMeasure() {
  const calls = [];
  const measure = (parts) => {
    calls.push(parts);
    return STABLE.length + parts.situation.length + parts.memory.length + parts.recent.length;
  };
  return { measure, calls };
}

const identityClip = (text, maxChars) => text.slice(0, Math.max(0, maxChars));

test('预算内：三块逐字节不变、dropped 为空、charsUsed 等于 measure 结果', () => {
  const { measure, calls } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };
  const plan = planContextBudget({ measure, parts, maxChars: 5000 });

  assert.equal(plan.version, CONTEXT_BUDGET_VERSION);
  assert.deepEqual(plan.parts, parts);
  assert.notEqual(plan.parts, parts, '必须返回新对象，不把入参对象透传出去');
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.charsUsed, 1410);
  assert.equal(plan.charsUsed, measure(plan.parts), 'charsUsed 必须等于最后一次 measure 的结果');
  assert.equal(plan.withinBudget, true);
  assert.equal(plan.maxChars, 5000);
  assert.deepEqual(plan.diagnostics.map((d) => d.code), ['within-budget']);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call !== parts), 'measure 不应收到调用方的原对象（避免被改写）');
});

test('默认丢弃顺序 recent → memory → situation：只丢到够用为止', () => {
  assert.deepEqual([...DEFAULT_DROP_ORDER], ['recent', 'memory', 'situation']);

  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  // 1110 = 稳定层 1000 + situation 50 + memory 60，丢掉 recent 就够
  const plan = planContextBudget({ measure, parts, maxChars: 1160 });
  assert.deepEqual(plan.parts, { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: '' });
  assert.deepEqual(plan.dropped, [{ part: 'recent', reason: 'over-budget', before: 300, after: 0 }]);
  assert.equal(plan.charsUsed, 1110);
  assert.equal(plan.parts.situation, parts.situation, 'situation 最后才动，本轮不该被改');
});

test('超预算较多时按顺序连续丢弃，且 situation 最后才丢', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  // 1050 = 稳定层 1000 + situation 50：memory 与 recent 都要丢
  const plan = planContextBudget({ measure, parts, maxChars: 1050 });
  assert.deepEqual(plan.dropped.map((entry) => [entry.part, entry.reason]), [
    ['recent', 'over-budget'],
    ['memory', 'over-budget'],
  ]);
  assert.equal(plan.parts.recent, '');
  assert.equal(plan.parts.memory, '');
  assert.equal(plan.parts.situation, 'a'.repeat(50));
  assert.equal(plan.charsUsed, 1050);

  // 1000：连 situation 都要丢，只剩稳定层
  const tighter = planContextBudget({ measure, parts, maxChars: 1000 });
  assert.deepEqual(tighter.dropped.map((entry) => entry.part), ['recent', 'memory', 'situation']);
  assert.equal(tighter.charsUsed, STABLE.length);
  assert.equal(tighter.withinBudget, true);
});

test('稳定层本身就超预算：不再无限减，给出 over-budget-residual 诊断', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };
  const plan = planContextBudget({ measure, parts, maxChars: 800 });

  assert.deepEqual(plan.parts, { situation: '', memory: '', recent: '' });
  assert.equal(plan.charsUsed, STABLE.length);
  assert.equal(plan.withinBudget, false);
  assert.ok(plan.diagnostics.some((d) => d.code === 'over-budget-residual'));
});

test('trim 只减到刚好够：多一个字符就超预算（最小减量）', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  const plan = planContextBudget({
    measure,
    parts,
    maxChars: 1200,
    trim: { recent: identityClip },
  });

  assert.equal(plan.parts.recent.length, 90, '1200 - (1000 + 50 + 60) = 90');
  assert.equal(plan.parts.memory, 'm'.repeat(60));
  assert.equal(plan.parts.situation, 'a'.repeat(50));
  assert.deepEqual(plan.dropped, [{ part: 'recent', reason: 'trimmed', before: 300, after: 90 }]);
  assert.equal(plan.charsUsed, 1200);
  assert.ok(plan.diagnostics.some((d) => d.code === 'part-trimmed' && d.part === 'recent'));

  const oneMore = { ...plan.parts, recent: plan.parts.recent + 'r' };
  assert.ok(measure(oneMore) > 1200, '再放一个字符就该超预算，说明是最小减量');
});

test('trim 后仍超预算：没有 trim 的 part 整块丢弃（不静默截断）', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  const plan = planContextBudget({
    measure,
    parts,
    maxChars: 1105,
    trim: { recent: identityClip },
  });

  assert.deepEqual(plan.dropped.map((entry) => [entry.part, entry.reason]), [
    ['recent', 'over-budget'],
    ['memory', 'over-budget'],
  ]);
  assert.equal(plan.parts.recent, '');
  assert.equal(plan.parts.memory, '');
  assert.equal(plan.parts.situation, 'a'.repeat(50), 'situation 本轮不需要动');
  assert.equal(plan.charsUsed, 1050);
  assert.ok(plan.diagnostics.some((d) => d.code === 'trim-insufficient' && d.part === 'recent'));
});

test('minChars 下限：放不下就整块丢弃；放得下就不裁到下限以下', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  // 需要 recent ≤ 90，但 minChars=100 不允许：整块丢弃
  const blocked = planContextBudget({
    measure,
    parts,
    maxChars: 1200,
    trim: { recent: identityClip },
    minChars: { recent: 100 },
  });
  assert.equal(blocked.parts.recent, '');
  assert.deepEqual(blocked.dropped[0], { part: 'recent', reason: 'over-budget', before: 300, after: 0 });
  assert.ok(blocked.diagnostics.some((d) => d.code === 'trim-insufficient' && d.part === 'recent'));

  // 需要 recent ≤ 150，minChars=100 不构成阻碍
  const allowed = planContextBudget({
    measure,
    parts,
    maxChars: 1260,
    trim: { recent: identityClip },
    minChars: { recent: 100 },
  });
  assert.equal(allowed.parts.recent.length, 150);
  assert.deepEqual(allowed.dropped, [{ part: 'recent', reason: 'trimmed', before: 300, after: 150 }]);
});

test('trim 完全没起作用（裁剪函数忽略上限）时退回整块丢弃，预算仍收敛', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  const plan = planContextBudget({
    measure,
    parts,
    maxChars: 1200,
    trim: { recent: (text) => text },
  });

  assert.equal(plan.parts.recent, '');
  assert.ok(plan.withinBudget);
  assert.ok(plan.diagnostics.some((d) => d.code === 'trim-insufficient'));
});

test('自定义 dropOrder：不在顺序里的块永不被减，超预算如实报告', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: 'a'.repeat(50), memory: 'm'.repeat(60), recent: 'r'.repeat(300) };

  const plan = planContextBudget({ measure, parts, maxChars: 1100, dropOrder: ['situation'] });
  assert.equal(plan.parts.situation, '');
  assert.equal(plan.parts.memory, 'm'.repeat(60), 'dropOrder 之外的块不得被动到');
  assert.equal(plan.parts.recent, 'r'.repeat(300));
  assert.equal(plan.charsUsed, 1360);
  assert.equal(plan.withinBudget, false);
  assert.ok(plan.diagnostics.some((d) => d.code === 'over-budget-residual'));
});

test('measure 有平台期（槽位自带裁剪上限）时仍确定性收敛到预算内', () => {
  // 模仿 role.js 的槽位裁剪：每块超过 100 字符后 measure 不再增长
  const measure = (parts) => STABLE.length
    + Math.min(parts.situation.length, 100)
    + Math.min(parts.memory.length, 100)
    + Math.min(parts.recent.length, 100);
  const parts = { situation: 'a'.repeat(500), memory: 'm'.repeat(500), recent: 'r'.repeat(500) };

  const first = planContextBudget({ measure, parts, maxChars: 1150, trim: { recent: identityClip, memory: identityClip } });
  const second = planContextBudget({ measure, parts, maxChars: 1150, trim: { recent: identityClip, memory: identityClip } });

  assert.deepEqual(first, second, '同输入必须同输出');
  assert.equal(first.charsUsed, measure(first.parts));
  assert.ok(first.charsUsed <= 1150);
  assert.equal(first.parts.recent, '');
  assert.equal(first.parts.memory.length, 50);
  assert.deepEqual(first.dropped.map((entry) => [entry.part, entry.reason]), [
    ['recent', 'over-budget'],
    ['memory', 'trimmed'],
  ]);
});

test('空块/缺省块不产生 dropped 记录', () => {
  const { measure } = additiveMeasure();
  const plan = planContextBudget({
    measure,
    parts: { situation: '', memory: undefined, recent: 'r'.repeat(300) },
    maxChars: 1150,
  });
  assert.deepEqual(plan.dropped, [{ part: 'recent', reason: 'over-budget', before: 300, after: 0 }]);
  assert.equal(plan.parts.situation, '');
  assert.equal(plan.parts.memory, '');

  // 全空 + 零预算：没有可减的东西，不产生 dropped，也不报超预算
  const zero = planContextBudget({ measure: () => 0, parts: { situation: '', memory: '', recent: '' }, maxChars: 0 });
  assert.deepEqual(zero.dropped, []);
  assert.equal(zero.charsUsed, 0);
  assert.equal(zero.withinBudget, true);
});

test('确定性 + 无入参突变 + dropped/diagnostics 不含正文', () => {
  const { measure } = additiveMeasure();
  const secretSituation = 'SITUATION_BODY_MARKER_' + 'a'.repeat(50);
  const secretMemory = 'MEMORY_BODY_MARKER_' + 'm'.repeat(60);
  const secretRecent = 'RECENT_BODY_MARKER_' + 'r'.repeat(300);
  const parts = { situation: secretSituation, memory: secretMemory, recent: secretRecent };
  const snapshot = JSON.parse(JSON.stringify(parts));
  const input = { measure, parts, maxChars: 1050, trim: { recent: identityClip } };

  const first = planContextBudget(input);
  const second = planContextBudget(input);

  assert.deepEqual(parts, snapshot, '入参不得被改写');
  assert.deepEqual(first.parts, second.parts);
  assert.deepEqual(first.dropped, second.dropped);
  assert.deepEqual(first.diagnostics, second.diagnostics);

  const sideChannel = JSON.stringify({ dropped: first.dropped, diagnostics: first.diagnostics });
  assert.equal(sideChannel.includes('BODY_MARKER'), false, '诊断与 dropped 不得泄漏正文');
  for (const entry of first.dropped) {
    assert.deepEqual(Object.keys(entry).sort(), ['after', 'before', 'part', 'reason']);
    assert.ok(entry.reason === 'over-budget' || entry.reason === 'trimmed');
    assert.equal(typeof entry.before, 'number');
    assert.equal(typeof entry.after, 'number');
  }
  for (const entry of first.diagnostics) {
    assert.equal(typeof entry.code, 'string');
    if (entry.part !== undefined) assert.ok(['situation', 'memory', 'recent'].includes(entry.part));
  }
});

test('parts 里多出来的槽位不会被保留，并留下 ignored-extra-parts 诊断（不含正文）', () => {
  const { measure } = additiveMeasure();
  const plan = planContextBudget({
    measure,
    parts: { situation: 'a', memory: 'm', recent: 'r', selfNote: '不该被吞掉', platform: 'x' },
    maxChars: 5000,
  });
  assert.deepEqual(Object.keys(plan.parts).sort(), ['memory', 'recent', 'situation']);
  assert.ok(plan.diagnostics.some((d) => d.code === 'ignored-extra-parts' && d.detail.includes('selfNote')));
  assert.equal(JSON.stringify(plan.diagnostics).includes('不该被吞掉'), false, '诊断不得泄漏正文');
});

test('非法入参一律显式报错，不静默兜底', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: '', memory: '', recent: 'r' };

  assert.throws(() => planContextBudget(), TypeError);
  assert.throws(() => planContextBudget({ parts, maxChars: 10 }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts: null, maxChars: 10 }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts: [], maxChars: 10 }), TypeError);
  assert.throws(() => planContextBudget({ measure: 'nope', parts, maxChars: 10 }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts, maxChars: NaN }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts, maxChars: -1 }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts, maxChars: 10, dropOrder: 'recent' }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts, maxChars: 10, dropOrder: ['persona'] }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts, maxChars: 10, dropOrder: [] }), TypeError);
  assert.throws(() => planContextBudget({ measure, parts: { recent: 42 }, maxChars: 10 }), TypeError);
  assert.throws(() => planContextBudget({ measure: () => 'many', parts, maxChars: 10 }), TypeError);
  assert.throws(
    () => planContextBudget({
      measure,
      parts: { situation: '', memory: 'm'.repeat(20), recent: 'r' },
      maxChars: 10,
      trim: { memory: (text) => text + text },
    }),
    TypeError,
  );
  assert.throws(
    () => planContextBudget({ measure, parts: { recent: 'r' }, maxChars: 10, trim: { persona: identityClip } }),
    TypeError,
  );
});

test('trim 可复用等长首尾保留夹具：长度精确、首尾都保留', () => {
  const { measure } = additiveMeasure();
  const parts = { situation: '', memory: '', recent: 'HEAD-' + 'x'.repeat(300) + '-TAIL' };
  const maxChars = STABLE.length + 100;

  const plan = planContextBudget({
    measure,
    parts,
    maxChars,
    trim: { recent: clipPreservingEnds },
  });

  assert.equal(plan.parts.recent.length, 100);
  assert.ok(plan.parts.recent.startsWith('HE'));
  assert.ok(plan.parts.recent.endsWith('TAIL'));
  assert.equal(plan.charsUsed, maxChars);
  assert.deepEqual(plan.dropped, [{ part: 'recent', reason: 'trimmed', before: parts.recent.length, after: 100 }]);
  assert.ok(measure({ ...plan.parts, recent: plan.parts.recent + 'x' }) > maxChars, '再长一个字符就超预算');
});