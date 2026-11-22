import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Memory } from '../src/memory.js';
import { MemoryStore } from '../src/memory/store.js';
import {
  TailWindowAdapter,
  createTailWindowAdapter,
  RETRIEVAL_SCHEMA_VERSION,
  TAIL_WINDOW_ADAPTER,
  TAIL_WINDOW_CAPABILITIES,
} from '../src/memory/tail-window-adapter.js';

/**
 * 尾窗口适配器的离线边界：
 *   - 账本 / 对话流只用临时目录与合成夹具，不碰真实 data/ 或私有配置；
 *   - v2 记录用合成 MemoryRecord（以及真实 MemoryStore + 临时目录）驱动，
 *     不依赖当前 fork 尚未迁移的 v2 Memory 门面；
 *   - 断言覆盖主体隔离、scope/where、kinds、排序/预算、状态（deleted /
 *     quarantined / superseded）、缺 refs、空查询降级、坏请求与内容盲。
 */

/** 固定时钟：只为让 generatedAt 稳定，不参与记录排序（排序只看 observedAt）。 */
const FIXED_NOW = 1767225600000;
/** 比任何账本 lastSeenAt 都新的夹具时间（2030-03-17T17:46:40Z），用来固定 turn 的相对新旧。 */
const LATE_TURN_T = 1900000000000;

const V2_T1 = '2026-01-01T00:00:00.000Z';
const V2_T2 = '2026-02-01T00:00:00.000Z';
const V2_T3 = '2026-03-01T00:00:00.000Z';
const V2_T4 = '2026-04-01T00:00:00.000Z';

function tempMemory(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new Memory({ dir, ...opts }) };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-adapter-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function adapterFor(memory) {
  return createTailWindowAdapter({ memory, now: () => FIXED_NOW });
}

function seedTurns(dir, rows) {
  fs.writeFileSync(path.join(dir, 'turns.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function texts(result) {
  return result.records.map((record) => record.text);
}

function reasonCount(result, reason) {
  return result.omitted.reasons.find((item) => item.reason === reason)?.count ?? 0;
}

function v2Record(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'mem_v2_base',
    subjectId: 'u1',
    layer: 'user_fact',
    kind: 'fact',
    text: 'v2 事实',
    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'seed' }], adapter: 'seed' },
    observedAt: V2_T1,
    recordedAt: V2_T1,
    lastConfirmedAt: null,
    confidence: 0.9,
    stability: 'stable',
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null },
    ...overrides,
  };
}

function v2Turn({ id, text, where = 'private:u1', userId = 'u1', subjectId = 'u1', observedAt = V2_T2, ...rest } = {}) {
  return v2Record({
    id,
    subjectId,
    layer: 'shared_experience',
    kind: 'turn',
    text,
    observedAt,
    recordedAt: observedAt,
    provenance: { source: 'host_verified', refs: [{ kind: 'turn', where, t: observedAt, userId }], adapter: 'seed' },
    stability: 'volatile',
    confidence: 0.95,
    ...rest,
  });
}

/** 只读 v2 门面：形状对齐 Memory(layoutVersion:2)，但记录由测试直接注入。 */
function v2Memory(records, options = {}) {
  const {
    status = { layoutVersion: 2, ok: true, state: 'ready', degraded: null },
    listThrows = false,
    statusThrows = false,
  } = options;
  return {
    layoutVersion: 2,
    status() {
      if (statusThrows) throw new Error('status exploded');
      return status;
    },
    listRecords() {
      if (listThrows) throw new Error('records exploded');
      return records;
    },
    dump() {
      return { people: {}, turns: [] };
    },
    recentTurns() {
      return [];
    },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

// ── 账本 / 对话流排序 ────────────────────────────────────────

test('tail-window ordering is newest-first and explicitly reversible to oldest-first', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: 'trait-old' });
  memory.remember('u1', { trait: 'trait-new' });
  memory.remember('u1', { fact: 'fact-only' });
  memory.remember('u1', { topic: 'topic-only' });
  memory.remember('u1', { pending: 'pending-only' });
  const adapter = adapterFor(memory);

  const newest = adapter.retrieve({ subjectId: 'u1' });
  assert.equal(newest.tail.order, 'newest-first');
  assert.deepEqual(texts(newest), ['trait-new', 'trait-old', 'fact-only', 'topic-only', 'pending-only']);

  const oldest = adapter.retrieve({ subjectId: 'u1', order: 'oldest-first' });
  assert.equal(oldest.tail.order, 'oldest-first');
  assert.deepEqual(texts(oldest), ['pending-only', 'topic-only', 'fact-only', 'trait-old', 'trait-new']);

  // 不认识的 order 回落默认值，而不是按调用方拼错的方向排序。
  assert.equal(adapter.retrieve({ subjectId: 'u1', order: 'sideways' }).tail.order, 'newest-first');
});

test('turns are ordered by observedAt with the newest first', (t) => {
  const { dir, memory } = tempMemory(t);
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '最早', reply: '嗯' },
    { t: 2000, where: 'private:u1', who: 'u1', userId: 'u1', text: '中间', reply: '嗯嗯' },
    { t: 3000, where: 'private:u1', who: 'u1', userId: 'u1', text: '最近', reply: '在' },
  ]);

  const result = adapterFor(memory).retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(result), ['最近', '中间', '最早']);
  assert.deepEqual(result.records.map((record) => record.observedAt), [
    new Date(3000).toISOString(),
    new Date(2000).toISOString(),
    new Date(1000).toISOString(),
  ]);
  assert.equal(result.records[0].kind, 'turn');
  assert.equal(result.records[0].reply, '在');

  const oldestFirst = adapterFor(memory).retrieve({ subjectId: 'u1', scope: 'private', order: 'oldest-first' });
  assert.deepEqual(texts(oldestFirst), ['最早', '中间', '最近']);
});

// ── 主体 / 会话隔离 ──────────────────────────────────────────

test('a subject never sees another subject ledger', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: 'u1-自己的事' });
  memory.remember('u2', { trait: 'u2-自己的事' });
  const adapter = adapterFor(memory);

  assert.deepEqual(texts(adapter.retrieve({ subjectId: 'u1' })), ['u1-自己的事']);
  assert.deepEqual(texts(adapter.retrieve({ subjectId: 'u2' })), ['u2-自己的事']);
  const onlyU1 = adapter.retrieve({ subjectId: 'u1' });
  assert.doesNotMatch(JSON.stringify(onlyU1.records), /u2-自己的事/);
  // subject 可以直接是字符串；数字 id 也会归一化成字符串。
  assert.deepEqual(texts(adapter.retrieve({ subject: 'u1' })), ['u1-自己的事']);
  memory.remember(7, { trait: '数字 id' });
  assert.deepEqual(texts(adapter.retrieve({ subject: { personId: 7 } })), ['数字 id']);
});

test('turn retrieval is bounded by userId and by scope/where', (t) => {
  const { dir, memory } = tempMemory(t);
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '私聊旧' },
    { t: 2000, where: 'group:1', who: 'u1', userId: 'u1', text: '群里说的' },
    { t: 3000, where: 'private:u1', who: 'u1', userId: 'u1', text: '私聊新' },
    { t: 4000, where: 'private:u2', who: 'u2', userId: 'u2', text: '别人的私聊' },
    { t: 5000, where: 'flandre-web', who: 'u1', userId: 'u1', text: '网页入口' },
  ]);
  const adapter = adapterFor(memory);

  const privateScope = adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(privateScope), ['私聊新', '私聊旧']);
  assert.equal(reasonCount(privateScope, 'privacy'), 1);
  assert.equal(reasonCount(privateScope, 'out-of-scope'), 2);
  assert.doesNotMatch(JSON.stringify(privateScope.records), /群里说的|网页入口/);

  const groupScope = adapter.retrieve({ subjectId: 'u1', scope: 'group' });
  assert.deepEqual(texts(groupScope), ['群里说的']);
  assert.doesNotMatch(JSON.stringify(groupScope.records), /私聊/);

  const webScope = adapter.retrieve({ subjectId: 'u1', scope: 'web' });
  assert.deepEqual(texts(webScope), ['网页入口']);

  // where 精确到某个会话键时，其它会话（含别人的私聊）一律 out-of-scope。
  const exact = adapter.retrieve({ subjectId: 'u1', where: 'private:u1' });
  assert.deepEqual(texts(exact), ['私聊新', '私聊旧']);
  assert.equal(reasonCount(exact, 'out-of-scope'), 3);
  assert.equal(exact.tail.where.length, 1);

  // where 可以是数组，重复值会被去重。
  const duplicated = adapter.retrieve({ subjectId: 'u1', where: ['private:u1', 'private:u1'] });
  assert.deepEqual(texts(duplicated), ['私聊新', '私聊旧']);
  assert.deepEqual(duplicated.tail.where, ['private:u1']);

  // 不给 scope 也不给 where 时不读 turns：不把某段历史拼进别的场合。
  const unscoped = adapter.retrieve({ subjectId: 'u1' });
  assert.deepEqual(texts(unscoped), []);
  assert.ok(unscoped.notes.includes('turns-not-read:no-scope'));
});

test('scope filtering is enforced adapter-side even if the memory ignores wherePrefix', (t) => {
  const { dir } = tempMemory(t);
  const dir2 = path.join(dir, 'ignoring');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'turns.jsonl'), [
    JSON.stringify({ t: 1000, where: 'private:u1', userId: 'u1', text: '私聊' }),
    JSON.stringify({ t: 2000, where: 'group:9', userId: 'u1', text: '群聊' }),
  ].join('\n') + '\n', 'utf8');

  // 只实现 dump / recentTurns 的替身：故意忽略 wherePrefix，模拟还没迁移的 Memory。
  const stubborn = {
    dump() {
      return { people: {} };
    },
    recentTurns() {
      return fs.readFileSync(path.join(dir2, 'turns.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    },
  };
  const result = createTailWindowAdapter({ memory: stubborn, now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(result), ['私聊']);
  assert.equal(reasonCount(result, 'out-of-scope'), 1);
});

test('unattributed legacy turns stay hidden unless allowUnattributed', (t) => {
  const { dir, memory } = tempMemory(t);
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '有主的' },
    { t: 2000, where: 'private:u1', who: 'u1', text: '老格式没有 userId' },
  ]);
  const adapter = adapterFor(memory);

  const hidden = adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(hidden), ['有主的']);
  assert.equal(reasonCount(hidden, 'privacy'), 1);

  const shown = adapter.retrieve({ subjectId: 'u1', scope: 'private', policy: { allowUnattributed: true } });
  assert.deepEqual(texts(shown), ['老格式没有 userId', '有主的']);
  const legacy = shown.records[0];
  assert.equal(legacy.subjectId, null);
  assert.equal(legacy.confidence, 0.3);
  assert.equal(legacy.provenance.source, 'migration');
});

// ── 预算 / 类别 ─────────────────────────────────────────────

test('budget caps records and characters and reports what was omitted', (t) => {
  const { memory } = tempMemory(t);
  for (const text of ['aa', 'bb', 'cc', 'dd', 'ee']) memory.remember('u1', { trait: text });
  const adapter = adapterFor(memory);

  const byRecords = adapter.retrieve({ subjectId: 'u1', budget: { maxRecords: 2 } });
  assert.deepEqual(texts(byRecords), ['ee', 'dd']);
  assert.equal(byRecords.budget.recordsUsed, 2);
  assert.equal(byRecords.budget.charsUsed, 4);
  assert.equal(byRecords.budget.truncated, true);
  assert.deepEqual(byRecords.omitted.reasons, [{ reason: 'budget', count: 3 }]);
  assert.equal(byRecords.omitted.count, 3);

  const byChars = adapter.retrieve({ subjectId: 'u1', maxChars: 5 });
  assert.deepEqual(texts(byChars), ['ee', 'dd']);
  assert.equal(byChars.budget.charsUsed, 4);
  assert.equal(byChars.budget.truncated, true);

  const limited = adapter.retrieve({ subjectId: 'u1', limit: 1 });
  assert.deepEqual(texts(limited), ['ee']);
  assert.equal(limited.omitted.count, 4);

  // budget 直接给数字等于 maxRecords。
  assert.deepEqual(texts(adapter.retrieve({ subjectId: 'u1', budget: 1 })), ['ee']);
});

test('an oversized record is skipped without stopping the tail window', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: 'short1' });
  memory.remember('u1', { trait: 'x'.repeat(30) });
  memory.remember('u1', { trait: 'short2' });

  const result = adapterFor(memory).retrieve({ subjectId: 'u1', budget: { maxChars: 12 } });
  assert.deepEqual(texts(result), ['short2', 'short1']);
  assert.equal(result.budget.charsUsed, 12);
  assert.deepEqual(result.omitted.reasons, [{ reason: 'budget', count: 1 }]);
});

test('kind filters narrow the window and report what was excluded', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: '性格', fact: '事实', topic: '话题', pending: '待办' });
  seedTurns(dir, [{ t: LATE_TURN_T, where: 'private:u1', who: 'u1', userId: 'u1', text: '一轮对话' }]);
  const adapter = adapterFor(memory);

  const onlyTrait = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { kinds: ['trait'] } });
  assert.deepEqual(texts(onlyTrait), ['性格']);
  assert.deepEqual(onlyTrait.tail.kinds, ['trait']);
  assert.equal(reasonCount(onlyTrait, 'out-of-scope'), 3);

  const combined = adapter.retrieve({ subjectId: 'u1', scope: 'private', kinds: ['topic', 'turn'] });
  assert.deepEqual(texts(combined), ['一轮对话', '话题']);

  // 单个字符串 kinds 也接受。
  const single = adapter.retrieve({ subjectId: 'u1', scope: 'private', kinds: 'fact' });
  assert.deepEqual(texts(single), ['事实']);

  const excluded = adapter.retrieve({ subjectId: 'u1', scope: 'private', policy: { excludeKinds: ['fact'] } });
  assert.equal(texts(excluded).includes('事实'), false);
  assert.equal(texts(excluded).includes('性格'), true);
  assert.equal(reasonCount(excluded, 'out-of-scope'), 1);

  // 过滤条件里没有一个本实现认识的类别 → 空结果，而不是"返回全部"。
  const nothing = adapter.retrieve({ subjectId: 'u1', scope: 'private', kinds: ['interaction'] });
  assert.deepEqual(nothing.records, []);
  assert.deepEqual(nothing.notes, ['kinds-empty']);
});

// ── 空结果 / 坏请求 / 降级 ──────────────────────────────────

test('empty and missing inputs stay safe and return an empty window', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: '有记忆的人' });
  const adapter = adapterFor(memory);

  const unknown = adapter.retrieve({ subjectId: 'u-unknown' });
  assert.deepEqual(unknown.records, []);
  assert.equal(unknown.omitted.count, 0);
  assert.equal(unknown.degraded, null);
  assert.equal(unknown.privacy.denied, false);
  // 查询未知主体不得顺手创建人物（people.json 里没有这个 key）。
  const people = JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8'));
  assert.equal('u-unknown' in people, false);

  const emptyMemory = tempMemory(t).memory;
  assert.deepEqual(adapterFor(emptyMemory).retrieve({ subjectId: 'u1', scope: 'private' }).records, []);

  const none = adapter.retrieve();
  assert.deepEqual(none.records, []);
  assert.equal(none.privacy.denied, true);
  assert.equal(none.privacy.deniedReason, 'missing-subject');
  assert.deepEqual(none.notes, ['missing-subject']);
  assert.equal(none.subject.personId, null);
  assert.equal(none.requestId, null);

  for (const bad of [null, undefined, 42, 'u1', {}, { subject: {} }, { subjectId: '   ' }]) {
    assert.doesNotThrow(() => adapter.retrieve(bad));
    assert.deepEqual(adapter.retrieve(bad).records, []);
  }
});

test('a query degrades instead of pretending to search', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: '喜欢猫' });
  memory.remember('u1', { trait: '常熬夜' });
  const adapter = adapterFor(memory);

  const plain = adapter.retrieve({ subjectId: 'u1' });
  const queried = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });

  assert.equal(plain.degraded, null);
  assert.deepEqual(queried.degraded, { reason: 'index-missing', fallback: 'tail-window' });
  assert.ok(queried.notes.includes('query-not-searched'));
  // query 不参与筛选：带不带检索词，记录与顺序完全一致（不假装做过相关性检索）。
  assert.deepEqual(queried.records, plain.records);
  assert.equal(queried.adapter.capabilities.lexical, false);
  assert.equal(queried.adapter.capabilities.semantic, false);
  assert.equal(queried.adapter.capabilities.localIndex, false);

  // 非字符串 query.text 视为没有检索词。
  assert.equal(adapter.retrieve({ subjectId: 'u1', query: { text: 123 } }).degraded, null);
});

test('adapter faults degrade instead of throwing', (t) => {
  const noMemory = new TailWindowAdapter({ now: () => FIXED_NOW });
  const missing = noMemory.retrieve({ subjectId: 'u1' });
  assert.deepEqual(missing.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(missing.notes.includes('missing-memory'));
  assert.deepEqual(missing.records, []);

  const broken = new TailWindowAdapter({
    memory: {
      dump() { throw new TypeError('账本读坏了'); },
      recentTurns() { return []; },
    },
    now: () => FIXED_NOW,
  });
  const failed = broken.retrieve({ subjectId: 'u1' });
  assert.equal(failed.degraded.reason, 'adapter-error');
  assert.ok(failed.notes.includes('adapter-error:TypeError'));
  assert.deepEqual(failed.records, []);

  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: '还在' });
  const adapter = adapterFor(memory);

  const mismatched = adapter.retrieve({ schemaVersion: 2, subjectId: 'u1' });
  assert.deepEqual(mismatched.degraded, { reason: 'schema-mismatch', fallback: 'tail-window' });
  assert.deepEqual(mismatched.records, []);

  // 隔离开关恒为 false：要求"包含被隔离记忆"时明确拒绝，而不是照做。
  const refused = adapter.retrieve({ subjectId: 'u1', policy: { includeQuarantined: true } });
  assert.equal(refused.privacy.denied, true);
  assert.equal(refused.privacy.deniedReason, 'policy:includeQuarantined');
  assert.deepEqual(refused.records, []);
});

/** 让 dump() 抛出指定值：用于驱动 retrieve 顶层的 adapter-error 降级路径。 */
function throwingValue(value) {
  return new TailWindowAdapter({
    memory: {
      dump() { throw value; },
      recentTurns() { return []; },
    },
    now: () => FIXED_NOW,
  });
}

test('diagnostic error labels keep built-ins but never echo custom names', () => {
  const secretBody = '绝密记忆正文';
  const secretQuery = '绝密检索词';

  // 内建类型保持原有可观测标签（兼容既有诊断）。
  const typeError = throwingValue(new TypeError('boom')).retrieve({ subjectId: 'u1', query: { text: secretQuery } });
  assert.deepEqual(typeError.notes, ['adapter-error:TypeError']);
  const rangeError = throwingValue(new RangeError('boom')).retrieve({ subjectId: 'u1' });
  assert.deepEqual(rangeError.notes, ['adapter-error:RangeError']);

  // 自定义 name 带正文：只留泛化标签，诊断 JSON 不含原文。
  const named = new Error(secretBody);
  named.name = secretBody;
  const leaked = throwingValue(named).retrieve({ subjectId: 'u1', query: { text: secretQuery } });
  assert.deepEqual(leaked.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.deepEqual(leaked.notes, ['adapter-error:Error']);
  assert.doesNotMatch(JSON.stringify({ notes: leaked.notes, degraded: leaked.degraded }), /绝密/);

  // name 合法但 message 带正文：message 不参与诊断，标签仍可观测。
  const messageOnly = new Error(secretBody);
  messageOnly.name = 'TypeError';
  const byMessage = throwingValue(messageOnly).retrieve({ subjectId: 'u1' });
  assert.deepEqual(byMessage.notes, ['adapter-error:TypeError']);
  assert.doesNotMatch(JSON.stringify(byMessage), /绝密/);
});

test('hostile or malformed error names collapse to a bounded label without throwing', () => {
  const throwingName = {};
  Object.defineProperty(throwingName, 'name', {
    get() {
      throw new Error('name getter 炸了');
    },
  });
  const boxedName = new String('TypeError');
  const toStringTrap = { toString() { return '绝密'; } };
  const cases = [
    ['非字符串', 42],
    ['对象', toStringTrap],
    ['超长', 'x'.repeat(10000)],
    ['控制字符', '\u0000\n\u001b[31m'],
    ['装箱字符串', boxedName],
    ['getter 抛错', throwingName],
    ['抛字符串', '绝密字符串'],
    ['抛 null', null],
  ];

  for (const [label, value] of cases) {
    const adapter = throwingValue(value);
    let result;
    assert.doesNotThrow(() => {
      result = adapter.retrieve({ subjectId: 'u1', query: { text: '绝密检索词' } });
    }, label);
    assert.deepEqual(result.degraded, { reason: 'adapter-error', fallback: 'tail-window' }, label);
    assert.deepEqual(result.notes, ['adapter-error:Error'], label);
    assert.deepEqual(result.records, [], label);
    // 标签有界：不会把 10000 个字符的名字拼进 notes。
    assert.ok(result.notes.every((note) => note.length <= 'adapter-error:'.length + 16), label);
    assert.doesNotMatch(JSON.stringify(result), /绝密/, label);
  }
});

test('turn reading tolerates missing or malformed recentTurns and ledger entries', () => {
  const ledgerOnly = {
    dump() {
      return {
        people: {
          u1: { traits: ['', 42, '留下'], facts: 'not-an-array', lastSeenAt: null },
        },
      };
    },
  };
  const first = createTailWindowAdapter({ memory: ledgerOnly, now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(first), ['留下']);
  assert.equal(first.records[0].observedAt, null);
  assert.equal(first.records[0].provenance.source, 'migration');

  const badTurns = {
    dump() {
      return { people: {} };
    },
    recentTurns() {
      return 'not-an-array';
    },
  };
  assert.deepEqual(
    createTailWindowAdapter({ memory: badTurns, now: () => FIXED_NOW })
      .retrieve({ subjectId: 'u1', scope: 'private' }).records,
    [],
  );
});

test('a broken clock falls back to the real clock without failing retrieval', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { trait: 'A' });
  const throwing = new TailWindowAdapter({ memory, now: () => { throw new Error('clock'); } });
  const out = throwing.retrieve({ subjectId: 'u1' });
  assert.equal(typeof out.generatedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(out.generatedAt)));

  const nan = new TailWindowAdapter({ memory, now: () => NaN });
  assert.ok(Number.isFinite(Date.parse(nan.retrieve({ subjectId: 'u1' }).generatedAt)));
});

// ── 确定性 / 只读 / 内容盲 ──────────────────────────────────

test('the same snapshot and clock produce an identical result', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: 'A', topic: 'T' });
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '同一句' },
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '同一句' },
    { t: 'not-a-timestamp', where: 'private:u1', who: 'u1', userId: 'u1', text: '时间坏了' },
  ]);
  const adapter = adapterFor(memory);
  const request = {
    requestId: 'req_fixed',
    subjectId: 'u1',
    scope: 'private',
    budget: { maxRecords: 10, maxChars: 500 },
  };

  const first = adapter.retrieve(request);
  const second = adapter.retrieve(request);

  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, new Date(FIXED_NOW).toISOString());
  assert.equal(first.requestId, 'req_fixed');
  // 两条内容完全相同的 turn 也要拿到不同 id（确定性后缀，不靠随机数）。
  const turnIds = first.records.filter((record) => record.kind === 'turn').map((record) => record.id);
  assert.equal(turnIds.length, 3);
  assert.equal(new Set(turnIds).size, 3);
  assert.match(turnIds[0], /^mem_tw_turn_[0-9a-f]{8}/);
  // 时间坏掉的行 observedAt 为 null 并排在最后，不编造时间。
  assert.equal(first.records.at(-1).text, '时间坏了');
  assert.equal(first.records.at(-1).observedAt, null);
});

test('retrieval never mutates the memory files and never calls writer methods', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: 'A' });
  seedTurns(dir, [{ t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: 'hi' }]);
  const peoplePath = path.join(dir, 'people.json');
  const turnsPath = path.join(dir, 'turns.jsonl');
  const before = {
    people: fs.readFileSync(peoplePath, 'utf8'),
    turns: fs.readFileSync(turnsPath, 'utf8'),
  };

  const adapter = adapterFor(memory);
  adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  adapter.retrieve({ subjectId: 'ghost', scope: 'private' });
  adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '语义检索' }, order: 'oldest-first' });

  assert.equal(fs.readFileSync(peoplePath, 'utf8'), before.people);
  assert.equal(fs.readFileSync(turnsPath, 'utf8'), before.turns);
  assert.equal('ghost' in JSON.parse(before.people), false);

  const calls = [];
  const trap = {
    dump() {
      return { people: { u1: { traits: ['只读'] } }, turns: [] };
    },
    recentTurns() {
      return [];
    },
    person() { calls.push('person'); },
    remember() { calls.push('remember'); },
    logTurn() { calls.push('logTurn'); },
    touch() { calls.push('touch'); },
  };
  assert.deepEqual(texts(createTailWindowAdapter({ memory: trap }).retrieve({ subjectId: 'u1' })), ['只读']);
  assert.deepEqual(calls, []);
});

test('diagnostics stay content-blind even when the store throws', () => {
  const secret = '绝密记忆正文';
  const broken = new TailWindowAdapter({
    memory: {
      dump() { throw new TypeError(secret); },
      recentTurns() { return []; },
    },
    now: () => FIXED_NOW,
  });
  const failed = broken.retrieve({ subjectId: 'u1', query: { text: '绝密检索词' } });
  assert.equal(failed.degraded.reason, 'adapter-error');
  const diagnostics = JSON.stringify({ notes: failed.notes, degraded: failed.degraded, omitted: failed.omitted });
  assert.doesNotMatch(diagnostics, /绝密记忆正文|绝密检索词/);
  assert.deepEqual(failed.records, []);
});

test('the adapter source stays offline, import-free and read-only', () => {
  const source = fs.readFileSync(new URL('../src/memory/tail-window-adapter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bnode:(?:fs|net|http|https|dns|tls|dgram|child_process|worker_threads)\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bprocess\.env\b/);
  assert.doesNotMatch(source, /\bfs\./);
});

// ── v2 记录：状态 / 隐私 / 出处 ──────────────────────────────

test('v2 records are filtered by subject, status, privacy and provenance', () => {
  const records = [
    v2Record({ id: 'ok', text: '活跃事实', observedAt: V2_T3 }),
    v2Record({ id: 'other', subjectId: 'u2', text: '别人的事实' }),
    v2Record({
      id: 'quarantined',
      text: '隔离事实',
      correction: { status: 'quarantined', supersedes: null, correctedBy: null, tombstone: null },
    }),
    v2Record({
      id: 'deleted',
      text: '删除事实',
      correction: {
        status: 'deleted',
        supersedes: null,
        correctedBy: null,
        tombstone: { at: V2_T1, by: 'user', reason: '用户要求' },
      },
    }),
    v2Record({
      id: 'superseded',
      text: '被替代事实',
      correction: { status: 'superseded', supersedes: 'old', correctedBy: 'new', tombstone: null },
    }),
    v2Record({ id: 'redacted', text: '脱敏事实', privacy: { level: 'normal', pii: true, redacted: true, retainUntil: null } }),
    v2Record({ id: 'restricted', text: '受限事实', privacy: { level: 'restricted', pii: false, redacted: false, retainUntil: null } }),
    v2Record({ id: 'no-refs', text: '没有出处', provenance: { source: 'user_message', refs: [] } }),
    v2Record({ id: 'empty', text: '   ' }),
    null,
    v2Record({ id: 'unknown-kind', kind: 'interaction', layer: 'current_state', text: '互动记录' }),
    v2Record({ id: 'null-subject', subjectId: null, text: '无主事实' }),
    v2Record({
      id: 'unknown-status',
      text: '未知状态',
      correction: { status: 'mystery', supersedes: null, correctedBy: null, tombstone: null },
    }),
  ];
  const adapter = createTailWindowAdapter({ memory: v2Memory(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(result), ['活跃事实']);
  assert.equal(reasonCount(result, 'privacy'), 5);
  assert.equal(reasonCount(result, 'quarantined'), 1);
  assert.equal(reasonCount(result, 'low-confidence'), 5);
  assert.equal(reasonCount(result, 'out-of-scope'), 1);
  assert.equal(result.omitted.count, 12);
  assert.equal(result.privacy.tombstoned, 1);
  assert.equal(result.privacy.redactedCount, 1);
  assert.equal(result.budget.recordsUsed, 1);

  // kinds / excludeKinds 在 v2 分支同样只是过滤器。
  const onlyTurns = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { kinds: ['turn'] } });
  assert.deepEqual(onlyTurns.records, []);
  assert.equal(reasonCount(onlyTurns, 'out-of-scope'), 2);
  const excludedFacts = adapter.retrieve({ subjectId: 'u1', scope: 'private', policy: { excludeKinds: ['fact'] } });
  assert.deepEqual(excludedFacts.records, []);
  assert.equal(reasonCount(excludedFacts, 'out-of-scope'), 2);

  // 来源出处在结果里原样保留，不被适配器重写成 migration。
  const [only] = result.records;
  assert.equal(only.provenance.source, 'user_message');
  assert.equal(only.provenance.adapter, 'seed');
  assert.deepEqual(only.provenance.refs, [{ kind: 'action', line: 'seed' }]);
  assert.equal(only.correction.status, 'active');

  // 带 query 也不做词面检索：只留降级标记。
  const queried = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '活跃' } });
  assert.deepEqual(queried.degraded, { reason: 'index-missing', fallback: 'tail-window' });
  assert.deepEqual(texts(queried), ['活跃事实']);
});

test('v2 turn records are bounded by their turn refs (scope, where, userId)', () => {
  const records = [
    v2Turn({ id: 'turn-ok', text: '对话 a' }),
    v2Turn({ id: 'turn-group', text: '对话 b', where: 'group:1' }),
    v2Turn({ id: 'turn-other-user', text: '对话 c', userId: 'u2' }),
    v2Turn({ id: 'turn-unattributed', text: '对话 d', userId: null }),
    v2Turn({ id: 'turn-no-where', text: '对话 e', where: '' }),
    v2Record({
      id: 'turn-no-turn-ref',
      kind: 'turn',
      layer: 'shared_experience',
      text: '对话 f',
      provenance: { source: 'host_verified', refs: [{ kind: 'action', line: 'x' }] },
    }),
  ];
  const adapter = createTailWindowAdapter({ memory: v2Memory(records), now: () => FIXED_NOW });

  const scoped = adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  assert.deepEqual(texts(scoped), ['对话 a']);
  assert.equal(reasonCount(scoped, 'out-of-scope'), 3);
  assert.equal(reasonCount(scoped, 'privacy'), 2);

  const withUnattributed = adapter.retrieve({
    subjectId: 'u1',
    scope: 'private',
    policy: { allowUnattributed: true },
  });
  assert.deepEqual(texts(withUnattributed), ['对话 d', '对话 a']);

  const exact = adapter.retrieve({ subjectId: 'u1', where: ['private:u1'] });
  assert.deepEqual(texts(exact), ['对话 a']);

  const mismatchedWhere = adapter.retrieve({ subjectId: 'u1', where: ['private:u9'] });
  assert.deepEqual(mismatchedWhere.records, []);

  // 不给 scope 也不给 where 时，turn 记录无法证明会话边界，一律不返回。
  const unscoped = adapter.retrieve({ subjectId: 'u1' });
  assert.deepEqual(unscoped.records, []);
});

test('v2 ordering and budgets follow the documented order', () => {
  const records = [
    v2Record({ id: 'a', text: 'aa', observedAt: V2_T1 }),
    v2Record({ id: 'b', text: 'bb', observedAt: V2_T2 }),
    v2Record({ id: 'c', text: 'cc', observedAt: V2_T3 }),
    v2Record({ id: 'd', text: 'dd', observedAt: V2_T4 }),
  ];
  const adapter = createTailWindowAdapter({ memory: v2Memory(records), now: () => FIXED_NOW });

  assert.deepEqual(texts(adapter.retrieve({ subjectId: 'u1' })), ['dd', 'cc', 'bb', 'aa']);
  assert.deepEqual(texts(adapter.retrieve({ subjectId: 'u1', order: 'oldest-first' })), ['aa', 'bb', 'cc', 'dd']);

  const byRecords = adapter.retrieve({ subjectId: 'u1', budget: { maxRecords: 2 } });
  assert.deepEqual(texts(byRecords), ['dd', 'cc']);
  assert.equal(byRecords.budget.charsUsed, 4);
  assert.deepEqual(byRecords.omitted.reasons, [{ reason: 'budget', count: 2 }]);

  const byChars = adapter.retrieve({ subjectId: 'u1', maxChars: 5 });
  assert.deepEqual(texts(byChars), ['dd', 'cc']);
  assert.equal(byChars.budget.truncated, true);
});

test('same-timestamp same-id versions fall back to a stable order instead of a random one', () => {
  // append-only 存储里同一 id 可以有多个版本行，且 observedAt 可能完全相同。
  // 排序必须仍然确定（这里只比较"同一快照两次结果一致"与"不丢记录"），
  // 不能让比较函数在等价键上返回不一致的结果。
  const records = [
    v2Record({ id: 'dup', text: '版本一', observedAt: V2_T2 }),
    v2Record({ id: 'dup', text: '版本二', observedAt: V2_T2 }),
    v2Record({ id: 'peer', text: '同伴', observedAt: V2_T2 }),
  ];
  const adapter = createTailWindowAdapter({ memory: v2Memory(records), now: () => FIXED_NOW });

  const first = adapter.retrieve({ subjectId: 'u1' });
  const second = adapter.retrieve({ subjectId: 'u1' });
  assert.deepEqual(first, second);
  assert.deepEqual(texts(first).slice().sort(), ['同伴', '版本一', '版本二'].sort());
  assert.equal(first.records.length, 3);
});

test('v2 stores that fail to read degrade with structured reasons', () => {
  const adapterForMemory = (memory) => createTailWindowAdapter({ memory, now: () => FIXED_NOW });

  const schema = adapterForMemory(v2Memory([], {
    status: { layoutVersion: 2, ok: false, state: 'schema-mismatch', degraded: { reason: 'schema-mismatch' } },
  })).retrieve({ subjectId: 'u1' });
  assert.deepEqual(schema.degraded, { reason: 'schema-mismatch', fallback: 'tail-window' });
  assert.ok(schema.notes.includes('store-schema-mismatch'));

  const missing = adapterForMemory(v2Memory([], {
    status: { layoutVersion: 2, ok: false, state: 'missing', degraded: { reason: 'store-missing' } },
  })).retrieve({ subjectId: 'u1' });
  assert.deepEqual(missing.degraded, { reason: 'index-missing', fallback: 'tail-window' });
  assert.ok(missing.notes.includes('store-missing'));

  const corrupt = adapterForMemory(v2Memory([], {
    status: { layoutVersion: 2, ok: false, state: 'corrupt', degraded: { reason: 'store-corrupt' } },
  })).retrieve({ subjectId: 'u1' });
  assert.deepEqual(corrupt.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(corrupt.notes.includes('store-corrupt'));

  const readError = adapterForMemory(v2Memory([], { listThrows: true })).retrieve({ subjectId: 'u1' });
  assert.deepEqual(readError.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(readError.notes.includes('store-read-error'));

  const invalid = adapterForMemory(v2Memory('not-an-array')).retrieve({ subjectId: 'u1' });
  assert.deepEqual(invalid.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(invalid.notes.includes('store-records-invalid'));

  const statusThrows = adapterForMemory(v2Memory([], { statusThrows: true })).retrieve({ subjectId: 'u1' });
  assert.deepEqual(statusThrows.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(statusThrows.notes.some((note) => note.startsWith('adapter-error:')));
});

test('v2 records stay independent of the returned copies', () => {
  const source = [v2Record({
    id: 'clone',
    text: '原始正文',
    correction: {
      status: 'active',
      supersedes: null,
      correctedBy: null,
      tombstone: { at: V2_T1, by: 'user', reason: 'unused' },
    },
    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'original' }], adapter: 'seed' },
    quarantine: { rules: ['imperative-directive'], at: V2_T1 },
  })];
  deepFreeze(source);
  const result = createTailWindowAdapter({ memory: v2Memory(source), now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1' });

  assert.equal(result.records.length, 1);
  const returned = result.records[0];
  assert.notStrictEqual(returned, source[0]);
  assert.notStrictEqual(returned.provenance, source[0].provenance);
  assert.notStrictEqual(returned.provenance.refs[0], source[0].provenance.refs[0]);
  assert.notStrictEqual(returned.correction.tombstone, source[0].correction.tombstone);
  assert.notStrictEqual(returned.quarantine, source[0].quarantine);
  assert.notStrictEqual(returned.quarantine.rules, source[0].quarantine.rules);

  returned.text = '被调用方改过了';
  returned.provenance.refs[0].line = 'changed';
  returned.quarantine.rules.push('changed');
  assert.equal(source[0].text, '原始正文');
  assert.equal(source[0].provenance.refs[0].line, 'original');
  assert.deepEqual(source[0].quarantine.rules, ['imperative-directive']);
});

test('v2 records read through the existing MemoryStore keep provenance and tombstones', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.appendRecord(v2Record({ id: 'keep', text: '会留下', provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'seed' }], adapter: 'store' } }));
  store.appendRecord(v2Record({ id: 'gone', text: '会被删' }));
  store.appendTombstone({ id: 'gone', at: V2_T1, by: 'user', reason: '用户要求' });

  const memory = {
    layoutVersion: 2,
    status() {
      const snapshot = store.read();
      return { layoutVersion: 2, ok: snapshot.ok, state: snapshot.state, counts: snapshot.counts };
    },
    listRecords() {
      return store.read().records;
    },
    dump() {
      return { people: {}, turns: [] };
    },
    recentTurns() {
      return [];
    },
  };

  const result = createTailWindowAdapter({ memory, now: () => FIXED_NOW }).retrieve({ subjectId: 'u1' });
  assert.deepEqual(texts(result), ['会留下']);
  assert.equal(result.records[0].provenance.adapter, 'store');
  assert.equal(reasonCount(result, 'privacy'), 1);
  assert.equal(result.privacy.tombstoned, 1);
  assert.equal(result.degraded, null);
});

// ── 结果形状 ─────────────────────────────────────────────────

test('records keep contract-shaped layers, provenance and scopes', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: '常熬夜', fact: '养了只猫', topic: '聊到猫', pending: '还没问完' });
  seedTurns(dir, [{ t: LATE_TURN_T, where: 'private:u1', who: 'u1', userId: 'u1', text: '在吗', reply: '在' }]);

  const result = adapterFor(memory).retrieve({ subjectId: 'u1', scope: 'private', requestId: 'req_shape' });

  assert.equal(result.schemaVersion, RETRIEVAL_SCHEMA_VERSION);
  assert.equal(result.adapter.id, TAIL_WINDOW_ADAPTER.id);
  assert.equal(result.adapter.mode, 'tail-window');
  assert.equal(result.requestId, 'req_shape');
  assert.deepEqual(result.subject, { personId: 'u1', scope: 'private' });
  assert.equal(result.records.length, 5);

  for (const record of result.records) {
    assert.equal(record.subjectId, 'u1');
    assert.ok(Array.isArray(record.provenance.refs) && record.provenance.refs.length >= 1);
    assert.equal(record.provenance.adapter, 'tail-window');
    assert.equal(record.correction.status, 'active');
    assert.equal(record.privacy.level, 'normal');
    assert.equal(typeof record.score.total, 'number');
    assert.match(record.id, /^mem_tw_/);
  }

  const layerByKind = Object.fromEntries(result.records.map((record) => [record.kind, record.layer]));
  assert.deepEqual(layerByKind, {
    trait: 'user_fact',
    fact: 'user_fact',
    pending: 'user_fact',
    topic: 'shared_experience',
    turn: 'shared_experience',
  });

  const turn = result.records.find((record) => record.kind === 'turn');
  assert.deepEqual(turn.provenance.refs[0], {
    kind: 'turn',
    where: 'private:u1',
    t: new Date(LATE_TURN_T).toISOString(),
    userId: 'u1',
  });
  assert.equal(turn.provenance.source, 'host_verified');
  assert.equal(turn.confidence, 0.95);
  assert.equal(turn.observedAt, new Date(LATE_TURN_T).toISOString());

  const trait = result.records.find((record) => record.kind === 'trait');
  assert.deepEqual(trait.provenance.refs, [{ kind: 'action', line: 'remember:trait' }]);
  assert.equal(trait.provenance.source, 'migration');
  assert.equal(trait.confidence, 0.3);
  assert.equal(trait.stability, 'stable');

  // 3 + 4 + 3 + 4 + (2 + 1) = 17 个 UTF-16 字符（turn 的 reply 也计入预算）。
  assert.deepEqual(result.budget, { charsUsed: 17, recordsUsed: 5, truncated: false });
  assert.deepEqual(result.omitted, { count: 0, reasons: [] });
  assert.equal(result.degraded, null);
  assert.deepEqual(result.privacy, { redactedCount: 0, tombstoned: 0, denied: false, deniedReason: null });
  assert.deepEqual(result.tail, {
    order: 'newest-first',
    kinds: null,
    scopePrefix: 'private',
    where: null,
    allowUnattributed: false,
  });

  assert.deepEqual(adapterFor(memory).capabilities, { lexical: false, semantic: false, localIndex: false });
  assert.equal(Object.isFrozen(TAIL_WINDOW_CAPABILITIES), true);
  assert.equal(Object.isFrozen(TAIL_WINDOW_ADAPTER), true);
  assert.ok(createTailWindowAdapter({ memory }) instanceof TailWindowAdapter);
});
