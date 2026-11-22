import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Memory } from '../src/memory.js';
import { createTailWindowAdapter } from '../src/memory/tail-window-adapter.js';
import {
  LexicalAdapter,
  createLexicalAdapter,
  LEXICAL_ADAPTER,
  LEXICAL_CAPABILITIES,
  RETRIEVAL_SCHEMA_VERSION,
} from '../src/memory/lexical-adapter.js';

/**
 * 词面检索适配器的离线边界：
 *   - 排序/过滤用合成 MemoryRecord 与临时 Memory 夹具，不读真实数据；
 *   - 覆盖主体隔离、scope/where、kinds、排序/预算、缺 refs、deleted /
 *     quarantined、空查询回退、坏请求、内容盲与来源降级；
 *   - 不调用模型、网络或真实配置。
 */

/** 固定时钟：只为让 generatedAt 稳定，不参与记录排序（排序只看 observedAt）。 */
const FIXED_NOW = 1767225600000;
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

function tempMemory(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-lexical-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new Memory({ dir, ...opts }) };
}

function lexicalFor(memory) {
  return createLexicalAdapter({ memory, now: () => FIXED_NOW });
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

let recordSeq = 0;

function makeRecord(overrides = {}) {
  recordSeq += 1;
  return {
    id: 'mem_test_' + recordSeq,
    subjectId: 'u1',
    layer: 'user_fact',
    kind: 'fact',
    text: '猫',
    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'remember:fact' }], adapter: 'fake' },
    observedAt: T1,
    recordedAt: T1,
    lastConfirmedAt: null,
    confidence: 0.9,
    stability: 'stable',
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null },
    score: { total: 0, relevance: 0, recency: 0, components: {} },
    ...overrides,
  };
}

function turnRecord({ text, where = 'private:u1', userId = 'u1', subjectId = 'u1', observedAt = T1, ...rest } = {}) {
  return makeRecord({
    subjectId,
    layer: 'shared_experience',
    kind: 'turn',
    text,
    provenance: { source: 'host_verified', refs: [{ kind: 'turn', where, t: observedAt, userId }], adapter: 'fake' },
    observedAt,
    recordedAt: observedAt,
    confidence: 0.95,
    stability: 'volatile',
    ...rest,
  });
}

function fakeSource(records, extra = {}) {
  return {
    retrieve() {
      return {
        schemaVersion: 1,
        adapter: { id: 'fake', version: '1.0.0', mode: 'tail-window' },
        records,
        budget: { charsUsed: 0, recordsUsed: records.length, truncated: false },
        omitted: { count: 0, reasons: [] },
        privacy: { redactedCount: 0, tombstoned: 0, denied: false, deniedReason: null },
        degraded: null,
        ...extra,
      };
    },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

// ── 词面排序 ──────────────────────────────────────────────────

test('lexical ranking puts the strongest query-token overlap first and keeps the tail as fallback', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: '喜欢猫' });
  memory.remember('u1', { fact: '常熬夜' });
  memory.remember('u1', { fact: '养了一只叫小白的猫' });
  const adapter = lexicalFor(memory);

  const phrase = adapter.retrieve({ subjectId: 'u1', query: { text: '喜欢猫' } });
  assert.deepEqual(texts(phrase), ['喜欢猫', '养了一只叫小白的猫', '常熬夜']);
  assert.equal(phrase.lexical.order, 'relevance');
  assert.equal(phrase.lexical.queryTokens, 2);
  assert.equal(phrase.lexical.matchedRecords, 1);
  assert.equal(phrase.records[0].score.relevance, 1);
  assert.equal(phrase.records[1].score.relevance, 0);
  assert.equal(phrase.degraded, null);

  // 单字查询走文档侧的单字索引；同分时按 newest-first + 原始次序。
  const single = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(texts(single), ['养了一只叫小白的猫', '喜欢猫', '常熬夜']);
  assert.equal(single.records[0].score.relevance, 1);
  assert.equal(single.records[1].score.relevance, 1);
  assert.equal(single.records[2].score.relevance, 0);

  // 二元组查询只命中真正包含该词组的记录。
  const bigram = adapter.retrieve({ subjectId: 'u1', query: { text: '熬夜' } });
  assert.deepEqual(texts(bigram), ['常熬夜', '养了一只叫小白的猫', '喜欢猫']);

  // 同输入同输出（固定时钟下整份结果逐字段相等）。
  const request = { subjectId: 'u1', query: { text: '猫' } };
  assert.deepEqual(adapter.retrieve(request), adapter.retrieve(request));

  // 排序先于预算：预算只留下相关性最高的那条。
  const topOnly = adapter.retrieve({ subjectId: 'u1', query: { text: '喜欢猫' }, budget: { maxRecords: 1 } });
  assert.deepEqual(texts(topOnly), ['喜欢猫']);
  assert.equal(topOnly.budget.truncated, true);
});

test('equal relevance breaks ties newest-first and then by original order', (t) => {
  const records = [
    makeRecord({ text: '旧猫', observedAt: T1 }),
    makeRecord({ text: '新猫', observedAt: T3 }),
    makeRecord({ text: '同新猫', observedAt: T3 }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(texts(result), ['新猫', '同新猫', '旧猫']);
  assert.deepEqual(result.records.map((record) => record.score.relevance), [1, 1, 1]);
});

test('latin words are matched as whole tokens and case is folded', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: 'API 文档在这里' });
  memory.remember('u1', { fact: '今天天气不错' });
  const adapter = lexicalFor(memory);

  const result = adapter.retrieve({ subjectId: 'u1', query: { text: 'api' } });
  assert.deepEqual(texts(result), ['API 文档在这里', '今天天气不错']);
  assert.equal(result.records[0].score.relevance, 1);
  assert.equal(result.records[1].score.relevance, 0);

  // 全角字母/数字先做 NFKC 归一，再按整词匹配。
  const normalized = adapter.retrieve({ subjectId: 'u1', query: { text: 'ＡＰＩ' } });
  assert.deepEqual(texts(normalized), ['API 文档在这里', '今天天气不错']);
  assert.equal(normalized.records[0].score.relevance, 1);
});

test('query text is the only ranking input; topicHints do not filter or rank', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: '喜欢猫' });
  memory.remember('u1', { fact: '常熬夜' });
  const adapter = lexicalFor(memory);

  const plain = adapter.retrieve({ subjectId: 'u1' });
  const hinted = adapter.retrieve({ subjectId: 'u1', query: { text: '', topicHints: ['猫'] } });
  assert.deepEqual(hinted.records, plain.records);
  assert.deepEqual(texts(hinted), ['常熬夜', '喜欢猫']);
  assert.equal(hinted.lexical.queryTokens, 0);
});

// ── 主体 / 会话隔离 ──────────────────────────────────────────

test('a subject never sees another subject ledger or another conversation tail', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { fact: 'u1 的猫' });
  memory.remember('u2', { fact: 'u2 的猫' });
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: 'u1 私聊 猫' },
    { t: 2000, where: 'group:1', who: 'u1', userId: 'u1', text: 'u1 群里 猫' },
    { t: 3000, where: 'private:u2', who: 'u2', userId: 'u2', text: 'u2 私聊 猫' },
  ]);
  const adapter = lexicalFor(memory);

  const privateU1 = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' } });
  assert.deepEqual(texts(privateU1), ['u1 的猫', 'u1 私聊 猫']);
  assert.doesNotMatch(JSON.stringify(privateU1.records), /u2 的猫|u2 私聊|u1 群里/);
  assert.equal(reasonCount(privateU1, 'privacy'), 1);

  const groupU1 = adapter.retrieve({ subjectId: 'u1', scope: 'group', query: { text: '猫' } });
  assert.deepEqual(texts(groupU1), ['u1 的猫', 'u1 群里 猫']);
  assert.doesNotMatch(JSON.stringify(groupU1.records), /私聊/);

  const webU1 = adapter.retrieve({ subjectId: 'u1', scope: 'web', query: { text: '猫' } });
  assert.deepEqual(texts(webU1), ['u1 的猫']);

  // 精确 where 过滤：其它私聊键（包括别人的）一律 out-of-scope。
  // 群聊行与别人的私聊行都在适配器这一层被挡掉，所以计数是 2（不依赖 Memory 的 wherePrefix）。
  const exact = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u1', query: { text: '猫' } });
  assert.deepEqual(texts(exact), ['u1 的猫', 'u1 私聊 猫']);
  assert.equal(reasonCount(exact, 'out-of-scope'), 2);

  // 请求指向别人的私聊键时，别人的行仍因 userId 不符被挡住。
  const foreign = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u2', query: { text: '猫' } });
  assert.deepEqual(texts(foreign), ['u1 的猫']);
  assert.doesNotMatch(JSON.stringify(foreign.records), /u2 私聊/);
});

test('privacy is enforced again before scoring even if a source adapter leaks a record', (t) => {
  const records = [
    makeRecord({ subjectId: 'u2', text: '别人的猫' }),
    makeRecord({ text: '我的猫' }),
    turnRecord({ text: '群里的猫', where: 'group:1', userId: 'u1' }),
    turnRecord({ text: '私聊的猫', where: 'private:u1', userId: 'u1' }),
    turnRecord({ text: '别人的私聊猫', where: 'private:u1', userId: 'u2' }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({
    subjectId: 'u1',
    scope: 'private',
    where: 'private:u1',
    query: { text: '猫' },
  });

  assert.deepEqual(texts(result), ['我的猫', '私聊的猫']);
  assert.doesNotMatch(JSON.stringify(result.records), /别人的猫|群里的猫|别人的私聊猫/);
  assert.equal(reasonCount(result, 'privacy'), 2);
  assert.equal(reasonCount(result, 'out-of-scope'), 1);
});

test('turn refs must point at the requested conversation and owner', () => {
  const records = [
    // 没有 turn ref：无法回指会话。
    makeRecord({
      kind: 'turn',
      layer: 'shared_experience',
      text: '没有会话出处',
      provenance: { source: 'host_verified', refs: [{ kind: 'action', line: 'x' }] },
    }),
    // turn ref 缺 where。
    turnRecord({ text: '缺 where 的猫', where: '' }),
    // turn ref 的 userId 为空：默认隐私拒绝。
    turnRecord({ text: '没有 userId 的猫', userId: null }),
    // 别的会话键。
    turnRecord({ text: '别的会话猫', where: 'private:u9' }),
    // 合法记录。
    turnRecord({ text: '合法猫', where: 'private:u1' }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const scoped = adapter.retrieve({
    subjectId: 'u1',
    scope: 'private',
    where: 'private:u1',
    query: { text: '猫' },
  });
  assert.deepEqual(texts(scoped), ['合法猫']);
  assert.equal(reasonCount(scoped, 'out-of-scope'), 3);
  assert.equal(reasonCount(scoped, 'privacy'), 1);

  const withUnattributed = adapter.retrieve({
    subjectId: 'u1',
    scope: 'private',
    where: 'private:u1',
    query: { text: '猫' },
    policy: { allowUnattributed: true },
  });
  assert.deepEqual(texts(withUnattributed), ['没有 userId 的猫', '合法猫']);

  // 什么都不给时不读会话尾部：turn 记录一律 out-of-scope。
  const unscoped = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(unscoped.records, []);
  assert.equal(reasonCount(unscoped, 'out-of-scope'), 4);
});

test('unattributed legacy turns stay hidden unless allowUnattributed is explicit', (t) => {
  const { dir, memory } = tempMemory(t);
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '有主的猫' },
    { t: 2000, where: 'private:u1', who: 'u1', text: '老格式没有 userId 的猫' },
  ]);
  const adapter = lexicalFor(memory);

  const hidden = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' } });
  assert.deepEqual(texts(hidden), ['有主的猫']);
  assert.equal(reasonCount(hidden, 'privacy'), 1);

  const shown = adapter.retrieve({
    subjectId: 'u1',
    scope: 'private',
    query: { text: '猫' },
    policy: { allowUnattributed: true },
  });
  assert.deepEqual(texts(shown), ['老格式没有 userId 的猫', '有主的猫']);
  assert.equal(shown.records[0].subjectId, null);
  assert.equal(shown.records[0].confidence, 0.3);
});

// ── turn 的 reply 回退 ───────────────────────────────────────

/**
 * reply-only turn：用户这一轮没有文本（空 text），只有宿主核实过的 assistant
 * reply。这里刻意走完整链路 Memory → createTailWindowAdapter → createLexicalAdapter，
 * 因为不可达回退就是在这条链路里被 classifyRecord 的门槛丢掉的：
 * searchableText/recordCost 已经认 reply，门槛也必须认，否则打分永远走不到。
 */
test('a reply-only turn is retrievable through the real tail adapter and stays inside its refs', (t) => {
  const { dir, memory } = tempMemory(t);
  seedTurns(dir, [
    { t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '', reply: '今天也想和你一起看猫' },
    // 空 text + 空 reply：没有任何可渲染正文。尾窗口就会丢掉它，词面适配器也不认。
    { t: 1500, where: 'private:u1', who: 'u1', userId: 'u1', text: '', reply: '' },
    // 同一句话但属于别人：reply 不能让主体边界松口。
    { t: 2000, where: 'private:u1', who: 'u2', userId: 'u2', text: '', reply: '别人的猫回复' },
    // 同一个 owner，别的会话键：scope 前缀对得上，但 where 不精确匹配。
    { t: 3000, where: 'private:u9', who: 'u1', userId: 'u1', text: '', reply: '别的会话猫回复' },
  ]);
  const tail = createTailWindowAdapter({ memory, now: () => FIXED_NOW });
  const adapter = createLexicalAdapter({ source: tail, now: () => FIXED_NOW });

  const hit = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u1', query: { text: '猫' } });
  assert.equal(hit.records.length, 1);
  // 正文仍然只有 reply：适配器不把 reply 抄进 text，也不伪造用户原文。
  assert.deepEqual(texts(hit), ['']);
  assert.deepEqual(hit.records.map((record) => record.reply), ['今天也想和你一起看猫']);
  assert.ok(hit.records[0].score.relevance > 0);
  assert.equal(hit.records[0].score.total, hit.records[0].score.relevance);
  assert.equal(hit.lexical.order, 'relevance');
  assert.equal(hit.lexical.matchedRecords, 1);
  // 别人的 reply 与空 reply 都不在结果里；别人的那条记进 privacy 计数。
  assert.equal(reasonCount(hit, 'privacy'), 1);
  assert.doesNotMatch(JSON.stringify(hit.records), /别人的猫回复|别的会话猫回复/);

  // 主体隔离照旧：换主体只看得到自己那条 reply-only 记录，看不到 u1 的。
  const asU2 = adapter.retrieve({ subjectId: 'u2', scope: 'private', where: 'private:u1', query: { text: '猫' } });
  assert.deepEqual(asU2.records.map((record) => record.reply), ['别人的猫回复']);

  // 不匹配的会话键仍被排除：命中查询词也换不来跨会话。
  const otherSession = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u9', query: { text: '猫' } });
  assert.deepEqual(otherSession.records.map((record) => record.reply), ['别的会话猫回复']);

  // 缺 scope/where：turn 无法回指会话，reply-only 同样一条都不返回。
  const unscoped = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(unscoped.records, []);
});

test('the reply fallback gates candidates without bypassing provenance or the text rule', () => {
  const records = [
    // 有效 reply-only：text 为空、reply 命中查询词。
    turnRecord({ text: '', reply: '私聊里说过要早点睡猫' }),
    // 空 text + 空 reply：没有任何可渲染正文 → 门槛丢掉。
    turnRecord({ text: '', reply: '' }),
    // reply-only 但只有 action ref、没有 turn ref：无法回指会话。
    turnRecord({
      text: '',
      reply: '没有会话出处的猫',
      provenance: { source: 'host_verified', refs: [{ kind: 'action', line: 'x' }] },
    }),
    // reply-only 且 refs 为空：缺来源仍是 §4.2 红线，reply 不能当成出处。
    turnRecord({ text: '', reply: '没有出处的猫', provenance: { source: 'host_verified', refs: [] } }),
    // reply-only 但 ref 指向别的会话。
    turnRecord({ text: '', reply: '别的会话猫', where: 'private:u9' }),
    // reply-only 但 ref 的 userId 是别人。
    turnRecord({ text: '', reply: '别人的猫咪', userId: 'u2' }),
    // 非 turn 记录：reply 不参与 searchableText，text 空就仍然排除。
    makeRecord({ text: '', reply: '非 turn 的猫回复' }),
    // 同时有 text 与 reply：打分只用 user text（回退不改变「text 优先」）。
    turnRecord({ text: '有原文的猫', reply: '另一段回复' }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u1', query: { text: '猫' } });
  assert.deepEqual(result.records.map((record) => record.reply), ['私聊里说过要早点睡猫', '另一段回复']);
  assert.equal(result.records[0].score.relevance, 1);
  assert.equal(result.records[1].score.relevance, 1);
  // 空 reply、空 refs、非 turn 空 text 各一条 low-confidence。
  assert.equal(reasonCount(result, 'low-confidence'), 3);
  // 缺 turn ref 与别的会话键各一条 out-of-scope。
  assert.equal(reasonCount(result, 'out-of-scope'), 2);
  // ref 的 userId 不是本人 → privacy。
  assert.equal(reasonCount(result, 'privacy'), 1);
  assert.doesNotMatch(JSON.stringify(result.records), /没有出处|没有会话出处|别人|别的会话|非 turn/);

  // text 优先的可见证据：text 非空时 reply 不进入文档词，所以 '另一段' 打不中它。
  const textFirst = adapter.retrieve({ subjectId: 'u1', scope: 'private', where: 'private:u1', query: { text: '另一段' } });
  assert.equal(textFirst.records.length, 2);
  assert.deepEqual(textFirst.records.map((record) => record.score.relevance), [0, 0]);
  assert.equal(textFirst.lexical.order, 'tail-window');
});

// ── 状态 / 脱敏 / 出处 ───────────────────────────────────────

test('only active, non-redacted and non-restricted records reach the result', () => {
  const records = [
    makeRecord({ text: '活跃的猫' }),
    makeRecord({ text: '敏感的猫', privacy: { level: 'sensitive', pii: false, redacted: false, retainUntil: null } }),
    makeRecord({ text: '隔离的猫', correction: { status: 'quarantined', supersedes: null, correctedBy: null, tombstone: null } }),
    makeRecord({
      text: '删除的猫',
      correction: { status: 'deleted', supersedes: null, correctedBy: null, tombstone: { at: T1, by: 'user', reason: '用户要求' } },
    }),
    makeRecord({ text: '被替代的猫', correction: { status: 'superseded', supersedes: 'mem_old', correctedBy: 'mem_new', tombstone: null } }),
    makeRecord({ text: '脱敏的猫', privacy: { level: 'normal', pii: true, redacted: true, retainUntil: null } }),
    makeRecord({ text: '受限的猫', privacy: { level: 'restricted', pii: false, redacted: false, retainUntil: null } }),
    makeRecord({ text: '别人的猫', subjectId: 'u2' }),
    makeRecord({ text: '没出处的猫', provenance: { source: 'user_message', refs: [], adapter: 'fake' } }),
    makeRecord({ text: '没有状态的猫', correction: undefined }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });

  assert.deepEqual(texts(result), ['活跃的猫', '敏感的猫']);
  assert.equal(result.omitted.count, 8);
  assert.equal(reasonCount(result, 'quarantined'), 1);
  assert.equal(reasonCount(result, 'privacy'), 4);
  assert.equal(reasonCount(result, 'low-confidence'), 3);
  assert.equal(result.privacy.tombstoned, 1);
  assert.equal(result.privacy.redactedCount, 1);

  for (const record of result.records) {
    assert.equal(record.correction.status, 'active');
    assert.notEqual(record.privacy.redacted, true);
    assert.notEqual(record.privacy.level, 'restricted');
    assert.ok(Array.isArray(record.provenance.refs) && record.provenance.refs.length >= 1);
  }
});

test('malformed records are excluded without throwing or leaking their content', () => {
  const records = [
    null,
    'not-a-record',
    makeRecord({ subjectId: '   ', text: '空白主体' }),
    makeRecord({ text: '' }),
    makeRecord({ kind: 'not-a-kind', text: '未知类别' }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(result.records, []);
  assert.equal(reasonCount(result, 'low-confidence'), 3);
  assert.equal(reasonCount(result, 'privacy'), 1);
  assert.equal(reasonCount(result, 'out-of-scope'), 1);
  assert.doesNotMatch(JSON.stringify(result.notes), /空白主体|未知类别|未知/);
});

test('confidence policy is explicit: minConfidence and includeUnverified=false are honored', () => {
  const records = [
    makeRecord({ text: '低猫', confidence: 0.3 }),
    makeRecord({ text: '中猫', confidence: 0.5 }),
    makeRecord({ text: '高猫', confidence: 0.7 }),
    makeRecord({ text: '最高猫', confidence: 0.9 }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const lenient = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(texts(lenient), ['低猫', '中猫', '高猫', '最高猫']);

  const verifiedOnly = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' }, policy: { includeUnverified: false } });
  assert.deepEqual(texts(verifiedOnly), ['高猫', '最高猫']);
  assert.equal(reasonCount(verifiedOnly, 'low-confidence'), 2);

  const highFloor = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' }, policy: { minConfidence: 0.8 } });
  assert.deepEqual(texts(highFloor), ['最高猫']);
  assert.equal(reasonCount(highFloor, 'low-confidence'), 3);

  const both = adapter.retrieve({
    subjectId: 'u1',
    query: { text: '猫' },
    policy: { minConfidence: 0.9, includeUnverified: true },
  });
  assert.deepEqual(texts(both), ['最高猫']);
});

// ── 预算 ─────────────────────────────────────────────────────

test('budget caps records and characters and reports what was omitted', (t) => {
  const { memory } = tempMemory(t);
  for (const text of ['aa', 'bb', 'cc', 'dd', 'ee']) memory.remember('u1', { fact: text });
  const adapter = lexicalFor(memory);

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

  const byAlias = adapter.retrieve({ subjectId: 'u1', limit: 1 });
  assert.deepEqual(texts(byAlias), ['ee']);
  assert.equal(byAlias.omitted.count, 4);
});

test('an oversized record is skipped without stopping the tail window', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: 'short1' });
  memory.remember('u1', { fact: 'x'.repeat(30) });
  memory.remember('u1', { fact: 'short2' });

  const result = lexicalFor(memory).retrieve({ subjectId: 'u1', budget: { maxChars: 12 } });
  assert.deepEqual(texts(result), ['short2', 'short1']);
  assert.equal(result.budget.charsUsed, 12);
  assert.deepEqual(result.omitted.reasons, [{ reason: 'budget', count: 1 }]);
});

// ── 空查询 / 降级 ────────────────────────────────────────────

test('empty and too-short queries degrade to the usable tail-window order', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: '喜欢猫' });
  memory.remember('u1', { fact: '常熬夜' });
  const adapter = lexicalFor(memory);
  const tailOrder = ['常熬夜', '喜欢猫'];

  for (const text of ['', '   ']) {
    const result = adapter.retrieve({ subjectId: 'u1', query: { text } });
    assert.deepEqual(texts(result), tailOrder);
    assert.deepEqual(result.degraded, { reason: 'index-missing', fallback: 'tail-window' });
    assert.ok(result.notes.includes('query-empty:tail-window'));
    assert.equal(result.lexical.order, 'tail-window');
    assert.equal(result.lexical.queryTokens, 0);
  }

  const missing = adapter.retrieve({ subjectId: 'u1' });
  assert.deepEqual(texts(missing), tailOrder);
  assert.ok(missing.notes.includes('query-empty:tail-window'));

  const punctuation = adapter.retrieve({ subjectId: 'u1', query: { text: '！！！' } });
  assert.deepEqual(texts(punctuation), tailOrder);
  assert.ok(punctuation.notes.includes('query-too-short:tail-window'));
  assert.equal(punctuation.degraded.reason, 'index-missing');

  const noMatch = adapter.retrieve({ subjectId: 'u1', query: { text: '量子力学' } });
  assert.deepEqual(texts(noMatch), tailOrder);
  assert.equal(noMatch.degraded, null);
  assert.ok(noMatch.notes.includes('no-lexical-match'));
  assert.equal(noMatch.lexical.order, 'tail-window');
  assert.equal(noMatch.lexical.matchedRecords, 0);

  // 纯数字查询按拉丁词处理；单字符查询只索引单字。
  const numeric = adapter.retrieve({ subjectId: 'u1', query: { text: '123' } });
  assert.equal(numeric.lexical.queryTokens, 1);
  assert.equal(numeric.lexical.matchedRecords, 0);

  const singleChar = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.equal(singleChar.lexical.queryTokens, 1);
  assert.equal(singleChar.records[0].text, '喜欢猫');
});

test('source degradation is normalized and index-missing is ignored by the lexical adapter', () => {
  const records = [makeRecord({ text: '猫' })];

  const indexMissing = createLexicalAdapter({
    source: fakeSource(records, { degraded: { reason: 'index-missing', fallback: 'tail-window' } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(texts(indexMissing), ['猫']);
  assert.equal(indexMissing.degraded, null);

  const adapterError = createLexicalAdapter({
    source: fakeSource(records, { degraded: { reason: 'adapter-error', fallback: 'tail-window' } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(adapterError.records, []);
  assert.deepEqual(adapterError.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(adapterError.notes.includes('source-degraded:adapter-error'));

  const schemaMismatch = createLexicalAdapter({
    source: fakeSource(records, { degraded: { reason: 'schema-mismatch', fallback: 'tail-window' } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(schemaMismatch.degraded, { reason: 'schema-mismatch', fallback: 'tail-window' });

  // 来源用字符串报降级同样归一化；未知值按 adapter-error 处理。
  const stringIndexMissing = createLexicalAdapter({
    source: fakeSource(records, { degraded: 'index-missing' }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(texts(stringIndexMissing), ['猫']);

  const unknownString = createLexicalAdapter({
    source: fakeSource(records, { degraded: 'mystery' }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(unknownString.degraded, { reason: 'adapter-error', fallback: 'tail-window' });

  const unknownReason = createLexicalAdapter({
    source: fakeSource(records, { degraded: { reason: 'mystery' } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(unknownReason.degraded, { reason: 'adapter-error', fallback: 'tail-window' });

  const denied = createLexicalAdapter({
    source: fakeSource(records, { privacy: { denied: true, deniedReason: 'missing-subject' } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(denied.records, []);
  assert.equal(denied.privacy.denied, true);
  assert.equal(denied.privacy.deniedReason, 'missing-subject');
  assert.ok(denied.notes.includes('source-denied'));

  // 来源没有给 deniedReason 时回落 source-denied。
  const bareDenied = createLexicalAdapter({
    source: fakeSource(records, { privacy: { denied: true } }),
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.equal(bareDenied.privacy.deniedReason, 'source-denied');
});

test('source omissions are merged and malformed counters are ignored', () => {
  const source = {
    retrieve() {
      return {
        records: [makeRecord({ text: '事实猫' })],
        omitted: {
          count: 99,
          reasons: [
            { reason: 'privacy', count: 2 },
            { reason: 'bogus', count: 5 },
            null,
            { reason: 'budget', count: 0 },
            { reason: 'low-confidence', count: '3' },
          ],
        },
        privacy: { denied: false },
        degraded: null,
      };
    },
  };
  const adapter = createLexicalAdapter({ source, now: () => FIXED_NOW });
  const result = adapter.retrieve({ subjectId: 'u1', query: { text: '猫' } });

  assert.deepEqual(texts(result), ['事实猫']);
  assert.equal(reasonCount(result, 'privacy'), 2);
  assert.equal(reasonCount(result, 'low-confidence'), 3);
  assert.deepEqual(result.omitted.reasons.map((item) => item.reason), ['privacy', 'low-confidence']);
  assert.equal(result.omitted.count, 5);
});

// ── 非法请求安全 ─────────────────────────────────────────────

test('malformed requests stay safe and never throw', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: '有记忆的人' });
  const adapter = lexicalFor(memory);

  for (const bad of [null, undefined, 42, 'u1', {}, { subject: {} }, { subjectId: '   ' }]) {
    assert.doesNotThrow(() => adapter.retrieve(bad));
    const result = adapter.retrieve(bad);
    assert.deepEqual(result.records, []);
    assert.equal(result.privacy.denied, true);
    assert.equal(result.privacy.deniedReason, 'missing-subject');
    assert.ok(result.notes.includes('missing-subject'));
  }

  const mismatched = adapter.retrieve({ subjectId: 'u1', schemaVersion: 2 });
  assert.deepEqual(mismatched.degraded, { reason: 'schema-mismatch', fallback: 'tail-window' });
  assert.deepEqual(mismatched.records, []);
  assert.ok(mismatched.notes.includes('unsupported-schema-version'));

  const refused = adapter.retrieve({ subjectId: 'u1', policy: { includeQuarantined: true } });
  assert.deepEqual(refused.records, []);
  assert.equal(refused.privacy.denied, true);
  assert.equal(refused.privacy.deniedReason, 'policy:includeQuarantined');
  assert.ok(refused.notes.includes('policy-refused:includeQuarantined'));

  // 非法预算回落到默认值，不抛错。
  for (const budget of [{ maxRecords: -1, maxChars: 'abc' }, { maxRecords: 0, maxChars: 0 }, { maxRecords: Infinity }]) {
    const result = adapter.retrieve({ subjectId: 'u1', budget });
    assert.deepEqual(texts(result), ['有记忆的人']);
  }

  // 非法时间窗被忽略，并留下机器标记。
  const invalidTime = adapter.retrieve({ subjectId: 'u1', time: { sinceIso: 'not-a-date' } });
  assert.deepEqual(texts(invalidTime), ['有记忆的人']);
  assert.ok(invalidTime.notes.includes('invalid-time-filter'));

  // time 不是对象时直接忽略，不抛。
  const nonObjectTime = adapter.retrieve({ subjectId: 'u1', time: 'bad' });
  assert.deepEqual(texts(nonObjectTime), ['有记忆的人']);
  assert.equal(nonObjectTime.notes.includes('invalid-time-filter'), false);

  // 非法 minConfidence 被忽略，并留下机器标记。
  const invalidFloor = adapter.retrieve({ subjectId: 'u1', policy: { minConfidence: 'abc' } });
  assert.deepEqual(texts(invalidFloor), ['有记忆的人']);
  assert.ok(invalidFloor.notes.includes('invalid-min-confidence'));

  // 非字符串 query.text 视为空查询。
  const numericQuery = adapter.retrieve({ subjectId: 'u1', query: { text: 123 } });
  assert.deepEqual(texts(numericQuery), ['有记忆的人']);
  assert.ok(numericQuery.notes.includes('query-empty:tail-window'));

  // 兼容 subject 直接是字符串、scope 在顶层。
  const aliased = adapter.retrieve({ subject: 'u1', scope: 'private' });
  assert.deepEqual(texts(aliased), ['有记忆的人']);

  // 读取请求字段时抛错也只降级，不把异常抛给调用方。
  const exploding = adapter.retrieve({
    subjectId: 'u1',
    get query() {
      throw new Error('boom');
    },
  });
  assert.deepEqual(exploding.records, []);
  assert.deepEqual(exploding.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(exploding.notes.includes('adapter-error:Error'));
});

test('bad request getters and a broken clock degrade without throwing', (t) => {
  const { memory } = tempMemory(t);
  memory.remember('u1', { fact: '有记忆的人' });

  // requestId 读坏了只是回显 null，不影响检索。
  const brokenRequestId = {
    subjectId: 'u1',
    get requestId() {
      throw new Error('requestId');
    },
  };
  const byId = lexicalFor(memory).retrieve(brokenRequestId);
  assert.equal(byId.requestId, null);
  assert.deepEqual(texts(byId), ['有记忆的人']);

  // subject 读坏了按"没有主体"处理，绝不退化成返回全场记忆。
  const brokenSubject = {
    subjectId: 'u1',
    get subject() {
      throw new Error('subject');
    },
  };
  const bySubject = lexicalFor(memory).retrieve(brokenSubject);
  assert.equal(bySubject.privacy.denied, true);
  assert.equal(bySubject.privacy.deniedReason, 'missing-subject');
  assert.deepEqual(bySubject.records, []);

  // 时钟坏了也要给一个可解析的 generatedAt。
  const brokenClock = new LexicalAdapter({ source: { people: {} }, now: () => { throw new Error('clock'); } });
  const byClock = brokenClock.retrieve({ subjectId: 'u1' });
  assert.ok(Number.isFinite(Date.parse(byClock.generatedAt)));
});

test('missing, throwing, async and malformed sources degrade instead of throwing', () => {
  const missing = new LexicalAdapter({ now: () => FIXED_NOW });
  const missingResult = missing.retrieve({ subjectId: 'u1' });
  assert.deepEqual(missingResult.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(missingResult.notes.includes('missing-source'));
  assert.deepEqual(missingResult.records, []);

  const throwing = createLexicalAdapter({
    source: { retrieve() { throw new TypeError('账本读坏了'); } },
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1' });
  assert.deepEqual(throwing.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(throwing.notes.includes('source-error:TypeError'));
  assert.deepEqual(throwing.records, []);

  const asyncSource = createLexicalAdapter({
    source: { retrieve: async () => ({ records: [makeRecord({ text: '猫' })] }) },
    now: () => FIXED_NOW,
  }).retrieve({ subjectId: 'u1', query: { text: '猫' } });
  assert.deepEqual(asyncSource.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(asyncSource.notes.includes('async-source-unsupported'));

  for (const result of [null, 42, 'nope', { records: 'not-an-array' }]) {
    const out = createLexicalAdapter({
      source: { retrieve: () => result },
      now: () => FIXED_NOW,
    }).retrieve({ subjectId: 'u1' });
    assert.deepEqual(out.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
    assert.deepEqual(out.records, []);
    assert.ok(out.notes.some((note) => note.startsWith('invalid-source')));
  }
});

/** 让来源 retrieve() 抛出指定值：驱动 source-error 降级路径。 */
function throwingSource(value) {
  return createLexicalAdapter({
    source: { retrieve() { throw value; } },
    now: () => FIXED_NOW,
  });
}

test('source error labels keep built-ins but never echo custom names', () => {
  const secretBody = '绝密记忆正文';
  const secretQuery = '绝密检索词';

  const typeError = throwingSource(new TypeError('boom')).retrieve({ subjectId: 'u1', query: { text: secretQuery } });
  assert.deepEqual(typeError.notes, ['source-error:TypeError']);
  const rangeError = throwingSource(new RangeError('boom')).retrieve({ subjectId: 'u1' });
  assert.deepEqual(rangeError.notes, ['source-error:RangeError']);

  const named = new Error(secretBody);
  named.name = secretBody;
  const leaked = throwingSource(named).retrieve({ subjectId: 'u1', query: { text: secretQuery } });
  assert.deepEqual(leaked.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.deepEqual(leaked.notes, ['source-error:Error']);
  assert.deepEqual(leaked.records, []);
  assert.doesNotMatch(JSON.stringify({ notes: leaked.notes, degraded: leaked.degraded }), /绝密/);

  // message 带正文不参与诊断；内建标签仍可观测。
  const messageOnly = new Error(secretBody);
  messageOnly.name = 'TypeError';
  const byMessage = throwingSource(messageOnly).retrieve({ subjectId: 'u1' });
  assert.deepEqual(byMessage.notes, ['source-error:TypeError']);
  assert.doesNotMatch(JSON.stringify(byMessage), /绝密/);
});

test('hostile or malformed source error names collapse to a bounded label without throwing', () => {
  const throwingName = {};
  Object.defineProperty(throwingName, 'name', {
    get() {
      throw new Error('name getter 炸了');
    },
  });
  const toStringTrap = { toString() { return '绝密'; } };
  const cases = [
    ['非字符串', 42],
    ['对象', toStringTrap],
    ['超长', 'x'.repeat(10000)],
    ['控制字符', '\u0000\n\u001b[31m'],
    ['装箱字符串', new String('TypeError')],
    ['getter 抛错', throwingName],
    ['抛字符串', '绝密字符串'],
    ['抛 null', null],
  ];

  for (const [label, value] of cases) {
    const adapter = throwingSource(value);
    let result;
    assert.doesNotThrow(() => {
      result = adapter.retrieve({ subjectId: 'u1', query: { text: '绝密检索词' } });
    }, label);
    assert.deepEqual(result.degraded, { reason: 'adapter-error', fallback: 'tail-window' }, label);
    assert.deepEqual(result.notes, ['source-error:Error'], label);
    assert.deepEqual(result.records, [], label);
    assert.ok(result.notes.every((note) => note.length <= 'source-error:'.length + 16), label);
    assert.doesNotMatch(JSON.stringify(result), /绝密/, label);
  }
});

test('the outer adapter-error path uses the same bounded labels', () => {
  // 查询对象 getter 抛出自定义 name：外层 catch 只能给出泛化标签，且诊断不含正文。
  const secret = '绝密检索词';
  const named = new Error(secret);
  named.name = secret;
  const request = {
    subjectId: 'u1',
    get query() {
      throw named;
    },
  };
  const result = createLexicalAdapter({ source: fakeSource([]), now: () => FIXED_NOW }).retrieve(request);
  assert.deepEqual(result.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.deepEqual(result.notes, ['adapter-error:Error']);
  assert.doesNotMatch(JSON.stringify(result), /绝密/);

  // 内建标签在顶层 catch 同样保留。
  const range = new RangeError('boom');
  const byRange = createLexicalAdapter({ source: fakeSource([]), now: () => FIXED_NOW }).retrieve({
    subjectId: 'u1',
    get query() {
      throw range;
    },
  });
  assert.deepEqual(byRange.notes, ['adapter-error:RangeError']);
});

// ── 类别 / 时间过滤 ─────────────────────────────────────────

test('kind filters narrow the result set without changing the query ranking', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: '性格猫', fact: '事实猫', topic: '话题猫', pending: '待办猫' });
  seedTurns(dir, [{ t: 3000, where: 'private:u1', who: 'u1', userId: 'u1', text: '对话猫' }]);
  const adapter = lexicalFor(memory);

  const onlyFact = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫', kinds: ['fact'] } });
  assert.deepEqual(texts(onlyFact), ['事实猫']);
  assert.equal(reasonCount(onlyFact, 'out-of-scope'), 4);

  const excluded = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' }, policy: { excludeKinds: ['fact'] } });
  assert.deepEqual(texts(excluded), ['性格猫', '话题猫', '待办猫', '对话猫']);
  assert.equal(reasonCount(excluded, 'out-of-scope'), 1);

  const onlyTurn = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫', kinds: ['turn'] } });
  assert.deepEqual(texts(onlyTurn), ['对话猫']);

  const unknown = adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫', kinds: ['bogus'] } });
  assert.deepEqual(unknown.records, []);
  assert.deepEqual(unknown.notes, ['kinds-empty']);
});

test('time windows filter by observedAt and treat missing timestamps as out of scope', () => {
  const records = [
    makeRecord({ text: '一月猫', observedAt: T1 }),
    makeRecord({ text: '二月猫', observedAt: T2 }),
    makeRecord({ text: '三月猫', observedAt: T3 }),
    makeRecord({ text: '无时间猫', observedAt: null }),
  ];
  const adapter = createLexicalAdapter({ source: fakeSource(records), now: () => FIXED_NOW });

  const result = adapter.retrieve({
    subjectId: 'u1',
    query: { text: '猫' },
    time: { nowIso: T2, sinceIso: '2026-01-15T00:00:00.000Z', untilIso: '2026-02-15T00:00:00.000Z' },
  });

  assert.deepEqual(texts(result), ['二月猫']);
  assert.equal(reasonCount(result, 'out-of-scope'), 3);
});

// ── 不可变性 / 内容盲 / 离线 ────────────────────────────────

test('retrieval never mutates the memory files or the source records', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { fact: '还在' });
  seedTurns(dir, [{ t: 1000, where: 'private:u1', who: 'u1', userId: 'u1', text: '你好' }]);
  const peoplePath = path.join(dir, 'people.json');
  const turnsPath = path.join(dir, 'turns.jsonl');
  const before = {
    people: fs.readFileSync(peoplePath, 'utf8'),
    turns: fs.readFileSync(turnsPath, 'utf8'),
  };

  const adapter = lexicalFor(memory);
  adapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' } });
  adapter.retrieve({ subjectId: 'u1', scope: 'private' });
  adapter.retrieve({ subjectId: 'ghost', scope: 'private' });
  adapter.retrieve({ subjectId: 'u1', scope: 'private', budget: { maxRecords: 1, maxChars: 10 } });

  assert.equal(fs.readFileSync(peoplePath, 'utf8'), before.people);
  assert.equal(fs.readFileSync(turnsPath, 'utf8'), before.turns);
  assert.equal('ghost' in JSON.parse(before.people), false);

  // 来源记录被冻结时仍可检索；返回的是副本，改返回值不影响来源。
  const sourceRecords = [
    makeRecord({ text: '我的猫' }),
    turnRecord({ text: '私聊的猫', where: 'private:u1', userId: 'u1' }),
  ];
  deepFreeze(sourceRecords);
  const frozenSource = fakeSource(sourceRecords);
  const frozenAdapter = createLexicalAdapter({ source: frozenSource, now: () => FIXED_NOW });
  const result = frozenAdapter.retrieve({ subjectId: 'u1', scope: 'private', query: { text: '猫' } });
  assert.equal(result.records.length, 2);

  const returned = result.records.find((record) => record.text === '我的猫');
  const sourceRecord = sourceRecords.find((record) => record.text === '我的猫');
  assert.notStrictEqual(returned, sourceRecord);
  assert.notStrictEqual(returned.provenance, sourceRecord.provenance);
  returned.text = '被调用方改过了';
  returned.provenance.refs[0].line = 'changed';
  assert.equal(sourceRecord.text, '我的猫');
  assert.equal(sourceRecord.provenance.refs[0].line, 'remember:fact');
});

test('the returned record copies correction tombstones and non-object refs safely', () => {
  const source = [makeRecord({
    text: '带墓碑的猫',
    correction: {
      status: 'active',
      supersedes: null,
      correctedBy: null,
      tombstone: { at: T1, by: 'user', reason: '历史残留' },
    },
    provenance: { source: 'user_message', refs: [null, { kind: 'action', line: 'x' }], adapter: 'fake' },
  })];
  const result = createLexicalAdapter({ source: fakeSource(source), now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1', query: { text: '猫' } });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].provenance.refs[0], null);
  assert.notStrictEqual(result.records[0].correction.tombstone, source[0].correction.tombstone);
  result.records[0].correction.tombstone.reason = '改过了';
  assert.equal(source[0].correction.tombstone.reason, '历史残留');
});

test('diagnostics stay content-blind and never call writer methods', () => {
  const secret = '绝密记忆正文';
  const source = {
    retrieve() {
      throw new TypeError(secret);
    },
  };
  const adapter = createLexicalAdapter({ source, now: () => FIXED_NOW });
  const failed = adapter.retrieve({ subjectId: 'u1', query: { text: '绝密检索词' } });
  assert.deepEqual(failed.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  const diagnostics = JSON.stringify({ notes: failed.notes, degraded: failed.degraded, omitted: failed.omitted });
  assert.doesNotMatch(diagnostics, /绝密记忆正文|绝密检索词/);

  // 正常结果里 notes 也不回显查询词或正文。
  const ok = createLexicalAdapter({ source: fakeSource([makeRecord({ text: secret })]), now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1', query: { text: '绝密' } });
  assert.equal(ok.records[0].text, secret);
  assert.doesNotMatch(JSON.stringify(ok.notes), /绝密/);

  const writes = [];
  const trap = {
    dump() {
      return { people: { u1: { traits: ['只读'] } }, turns: [] };
    },
    recentTurns() {
      return [];
    },
    person() { writes.push('person'); },
    remember() { writes.push('remember'); },
    logTurn() { writes.push('logTurn'); },
  };
  assert.deepEqual(texts(createLexicalAdapter({ memory: trap, now: () => FIXED_NOW })
    .retrieve({ subjectId: 'u1', query: { text: '只读' } })), ['只读']);
  assert.deepEqual(writes, []);
});

test('the adapter source stays offline and imports only the tail adapter', () => {
  const source = fs.readFileSync(new URL('../src/memory/lexical-adapter.js', import.meta.url), 'utf8');
  assert.deepEqual(source.match(/^import .*$/gm), [
    "import { createTailWindowAdapter } from './tail-window-adapter.js';",
  ]);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bnode:(?:fs|net|http|https|dns|tls|dgram|child_process|worker_threads)\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bprocess\.env\b/);
  assert.doesNotMatch(source, /\bfs\./);
});

// ── 结果形状 / 组合能力 ─────────────────────────────────────

test('results keep the contract shape and the lexical capability metadata', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { trait: '常熬夜' });
  seedTurns(dir, [{ t: 3000, where: 'private:u1', who: 'u1', userId: 'u1', text: '在吗', reply: '在' }]);

  const result = lexicalFor(memory).retrieve({
    schemaVersion: 1,
    requestId: 'req_lexical',
    subject: { personId: 'u1', scope: 'private', conversationKey: 'private:u1' },
    query: { text: '在吗' },
    budget: { maxRecords: 10, maxChars: 500 },
  });

  assert.equal(result.schemaVersion, RETRIEVAL_SCHEMA_VERSION);
  assert.equal(result.requestId, 'req_lexical');
  assert.equal(result.generatedAt, new Date(FIXED_NOW).toISOString());
  assert.deepEqual(result.adapter, {
    id: LEXICAL_ADAPTER.id,
    version: LEXICAL_ADAPTER.version,
    mode: LEXICAL_ADAPTER.mode,
    capabilities: { lexical: true, semantic: false, localIndex: false },
  });
  assert.deepEqual(result.subject, { personId: 'u1', scope: 'private' });
  assert.deepEqual(result.privacy, { redactedCount: 0, tombstoned: 0, denied: false, deniedReason: null });
  assert.equal(result.degraded, null);
  assert.deepEqual(result.lexical, { queryTokens: 1, matchedRecords: 1, order: 'relevance' });
  assert.ok(result.omitted.count === 0);

  const turn = result.records.find((record) => record.kind === 'turn');
  assert.equal(turn.layer, 'shared_experience');
  assert.equal(turn.provenance.source, 'host_verified');
  assert.deepEqual(turn.provenance.refs[0], {
    kind: 'turn',
    where: 'private:u1',
    t: new Date(3000).toISOString(),
    userId: 'u1',
  });
  assert.equal(turn.correction.status, 'active');
  assert.equal(turn.privacy.level, 'normal');
  assert.equal(typeof turn.score.total, 'number');
  assert.equal(turn.score.recency, 0);

  const trait = result.records.find((record) => record.kind === 'trait');
  assert.equal(trait.provenance.source, 'migration');
  assert.equal(trait.confidence, 0.3);
  assert.equal(trait.provenance.adapter, 'tail-window');
});

test('the adapter composes over Memory, a tail adapter and a read-only snapshot', (t) => {
  const { dir, memory } = tempMemory(t);
  memory.remember('u1', { fact: '喜欢猫' });
  memory.remember('u1', { fact: '常熬夜' });
  seedTurns(dir, [{ t: 3000, where: 'private:u1', who: 'u1', userId: 'u1', text: '私聊猫' }]);
  const request = { subjectId: 'u1', scope: 'private', query: { text: '猫' }, budget: { maxRecords: 10, maxChars: 500 } };

  const direct = createLexicalAdapter({ memory, now: () => FIXED_NOW });
  const tail = createTailWindowAdapter({ memory, now: () => FIXED_NOW });
  const wrapped = createLexicalAdapter({ source: tail, now: () => FIXED_NOW });

  assert.deepEqual(direct.retrieve(request), wrapped.retrieve(request));
  assert.equal(direct.retrieve(request).records.length, 3);

  const snapshot = {
    people: JSON.parse(fs.readFileSync(path.join(dir, 'people.json'), 'utf8')),
    turns: fs.readFileSync(path.join(dir, 'turns.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
  const fromSnapshot = createLexicalAdapter({ source: snapshot, now: () => FIXED_NOW });
  assert.deepEqual(fromSnapshot.retrieve(request).records, direct.retrieve(request).records);

  // 空快照与非法快照都不会抛；非法快照按 missing-source 降级。
  const emptySnapshot = createLexicalAdapter({ source: { people: {} }, now: () => FIXED_NOW });
  assert.deepEqual(emptySnapshot.retrieve({ subjectId: 'u1', scope: 'private' }).records, []);

  const invalidSnapshot = createLexicalAdapter({ source: { people: 'nope' }, now: () => FIXED_NOW });
  const invalidResult = invalidSnapshot.retrieve({ subjectId: 'u1' });
  assert.deepEqual(invalidResult.degraded, { reason: 'adapter-error', fallback: 'tail-window' });
  assert.ok(invalidResult.notes.includes('missing-source'));

  assert.ok(createLexicalAdapter({ memory }) instanceof LexicalAdapter);
  assert.deepEqual(direct.capabilities, { lexical: true, semantic: false, localIndex: false });
  assert.equal(Object.isFrozen(LEXICAL_CAPABILITIES), true);
  assert.equal(Object.isFrozen(LEXICAL_ADAPTER), true);
  assert.equal(LEXICAL_ADAPTER.id, 'lexical');
  assert.equal(LEXICAL_ADAPTER.mode, 'lexical');
});

test('the source is asked for candidates without pre-filtering kinds, confidence or budget', () => {
  let captured = null;
  const source = {
    retrieve(request) {
      captured = request;
      return {
        records: [makeRecord({ text: '事实猫' })],
        omitted: { count: 2, reasons: [{ reason: 'privacy', count: 2 }] },
        privacy: { denied: false },
        degraded: null,
      };
    },
  };
  const adapter = createLexicalAdapter({ source, now: () => FIXED_NOW });
  const result = adapter.retrieve({
    subject: { personId: 'u1', displayName: '小鱼', scope: 'private', conversationKey: 'private:u1' },
    query: { text: '猫', kinds: ['fact'] },
    policy: { minConfidence: 0.5, excludeKinds: ['topic'] },
    budget: { maxRecords: 1, maxChars: 5 },
  });

  assert.equal(captured.subject.personId, 'u1');
  assert.equal(captured.subject.displayName, '小鱼');
  assert.equal(captured.subject.scope, 'private');
  assert.equal(captured.subject.conversationKey, 'private:u1');
  assert.equal(captured.subjectId, 'u1');
  assert.equal(captured.scope, 'private');
  assert.equal(captured.where, 'private:u1');
  assert.deepEqual(captured.query, { text: '', kinds: null });
  assert.equal(captured.policy.includeQuarantined, false);
  assert.equal(captured.policy.allowUnattributed, false);
  assert.equal(captured.policy.minConfidence, 0);
  assert.equal(captured.policy.includeUnverified, true);
  assert.ok(captured.budget.maxRecords > 1);
  assert.ok(captured.budget.maxChars > 5);

  // 来源报告的 privacy 计数被并入；本适配器自己的类别过滤也计数。
  assert.deepEqual(texts(result), ['事实猫']);
  assert.equal(reasonCount(result, 'privacy'), 2);
});
