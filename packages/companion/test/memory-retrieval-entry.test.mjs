/**
 * 记忆检索的入口接线 · 离线验收
 * ─────────────────────────────────────────────────────────────
 * 只碰临时目录、合成账本、假适配器与假 fetch：
 *   - 默认关闭：`createEntryMemoryRetriever` 返回 null，Brain 一次都不调用检索；
 *   - 打开后：tail-window / lexical 都是只读，产出有界记忆块；
 *   - 隐私：无主体不检索、别人的记录不渲染、被删/隔离/脱敏/无 refs 的一律不出现；
 *   - 预算：单条 ≤160、整块 ≤maxChars，按整条贪心，不留半句；
 *   - 降级：适配器抛错 / 返回非法结构 / index-missing 空结果都回退旧路径，
 *     绝不拦模型调用；privacy.denied 不回退（回退等于绕过隐私边界）。
 *
 * 不联网、不调模型、不读真实配置与真实 data/、不写任何真实记忆。
 * 验收：node --test packages/companion/test/memory-retrieval-entry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { Memory } from '../src/memory.js';
import { Role } from '../src/role.js';
import { Brain } from '../src/brain.js';
import {
  MEMORY_RECORD_MAX_CHARS,
  MEMORY_SLOT_MAX_CHARS,
  createEntryMemoryRetriever,
  createRetrievalRequest,
  normalizeRetrievalConfig,
  renderRetrievalMemory,
  retrieveMemoryForTurn,
} from '../src/memory/retrieval-entry.js';
import { loadConfig, buildMemoryBlocks, main } from '../src/index.js';

const SUBJECT = '10001';
const OTHER = '20002';
const NOW = 1_760_000_000_000;

/** 合成临时账本（v1 布局，不迁移、不碰真实 data/）。 */
function tempLedger(t, seed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new Memory({ dir });
  if (seed) {
    memory.remember(SUBJECT, { name: '老王', trait: '常熬夜', fact: '养了只猫' });
    memory.remember(OTHER, { name: '小李', fact: '别人的秘密' });
    memory.logTurn({ where: 'private:' + SUBJECT, who: '老王', text: '今天加班到两点', reply: '又熬' });
    memory.logTurn({ where: 'private:' + OTHER, who: '小李', text: '别人的话', reply: '别人的回复' });
  }
  return { dir, memory };
}

function tempCard(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entry-card-'));
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, '合成角色卡：说话短、别客套。\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return cardPath;
}

/** 合成契约记录，只带渲染必须的字段。 */
function record(kind, text, extra = {}) {
  return {
    id: 'mem_' + kind + '_' + text.length,
    subjectId: SUBJECT,
    layer: 'user_fact',
    kind,
    text,
    reply: null,
    provenance: { source: 'migration', refs: [{ kind: 'action', line: 'remember:' + kind }], adapter: 'tail-window' },
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null },
    ...extra,
  };
}

/** 假适配器：按顺序调用，记录请求，返回给定结果。 */
function fakeRetriever(handler) {
  const calls = [];
  return {
    calls,
    retrieve(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

function installFetch(t, message = { content: ' 好，早点睡。 ' }) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function systemPromptOf(call) {
  const body = JSON.parse(call.init.body);
  return body.messages.find((message) => message.role === 'system').content;
}

test('CLI wires the configured lexical retriever into a private reply', { timeout: 2500 }, async (t) => {
  const { dir } = tempLedger(t);
  const calls = installFetch(t);
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    apiKey: 'synthetic',
    baseUrl: 'https://model.invalid',
    dataDir: dir,
    roleCard: tempCard(t),
    ownerIds: [SUBJECT],
    wake: { privateWindowMs: 10 },
    humanize: { enabled: false },
    memory: { retrieval: { enabled: true, mode: 'lexical' } },
  }));
  const proc = new EventEmitter();
  proc.argv = ['node', 'src/index.js', '--config', cfgFile];
  const sent = Promise.withResolvers();
  let onMessage;
  await main({
    proc,
    createBot: (options) => {
      onMessage = options.onMessage;
      return {
        async send(key, text) {
          sent.resolve({ key, text });
          return { receipt: { status: 'confirmed' } };
        },
        async setTyping() {},
      };
    },
  });
  const key = 'private:' + SUBJECT;
  onMessage({ key, userId: SUBJECT, name: '老王', text: '养了只猫', messageId: 'synthetic-1' });
  assert.equal((await sent.promise).key, key);
  assert.equal(calls.length, 1);
  assert.match(systemPromptOf(calls[0]), /他告诉过你：养了只猫/);
  assert.doesNotMatch(systemPromptOf(calls[0]), /【关于|别人的秘密/);
});

// ── 配置归一化 ────────────────────────────────────────────────

test('默认关闭：没有配置、配置为空、配置非对象都回退默认值且不抛', () => {
  const empty = normalizeRetrievalConfig(undefined);
  assert.equal(empty.enabled, false);
  assert.equal(empty.mode, 'tail-window');
  assert.equal(empty.maxChars, MEMORY_SLOT_MAX_CHARS);
  assert.deepEqual(empty.warnings, []);

  assert.equal(normalizeRetrievalConfig(null).enabled, false);
  assert.deepEqual(normalizeRetrievalConfig([]).warnings, ['memory.retrieval 不是对象，已忽略']);
  assert.equal(normalizeRetrievalConfig([]).enabled, false);
  assert.equal(normalizeRetrievalConfig('lexical').enabled, false);
  assert.equal(normalizeRetrievalConfig(42).enabled, false);
  assert.equal(normalizeRetrievalConfig(false).enabled, false);
});

test('非法模式与数值一律回退默认值，并给出可读警告', () => {
  const out = normalizeRetrievalConfig({
    enabled: true,
    mode: 'semantic',
    maxRecords: -1,
    maxChars: 999999,
    minConfidence: 2,
  });
  assert.equal(out.enabled, true);
  assert.equal(out.mode, 'tail-window');
  assert.equal(out.maxRecords, 20);
  assert.equal(out.maxChars, MEMORY_SLOT_MAX_CHARS);
  assert.equal(out.minConfidence, 0);
  assert.equal(out.warnings.length, 4);

  const nonInteger = normalizeRetrievalConfig({ maxRecords: 2.5, maxChars: 'abc' });
  assert.equal(nonInteger.maxRecords, 20);
  assert.equal(nonInteger.maxChars, MEMORY_SLOT_MAX_CHARS);

  assert.equal(normalizeRetrievalConfig({ minConfidence: 'high' }).minConfidence, 0);
  assert.equal(normalizeRetrievalConfig({ minConfidence: -0.1 }).minConfidence, 0);
});

test('只有显式 true / false 才改变开关语义', () => {
  const on = normalizeRetrievalConfig({ enabled: 'yes', includeUnverified: 'no' });
  assert.equal(on.enabled, false, 'enabled 只认布尔 true');
  assert.equal(on.includeUnverified, true, 'includeUnverified 只认布尔 false');
  assert.equal(on.allowUnattributed, false);

  const strict = normalizeRetrievalConfig({ enabled: true, includeUnverified: false, allowUnattributed: true });
  assert.equal(strict.enabled, true);
  assert.equal(strict.includeUnverified, false);
  assert.equal(strict.allowUnattributed, true);
  assert.equal(strict.mode, 'tail-window');
});

test('非法整数下限：0、负数、整数字符串都按回退处理，合法整数原样保留', () => {
  assert.equal(normalizeRetrievalConfig({ maxRecords: 0 }).maxRecords, 20);
  assert.equal(normalizeRetrievalConfig({ maxChars: 0 }).maxChars, MEMORY_SLOT_MAX_CHARS);
  assert.equal(normalizeRetrievalConfig({ maxRecords: '8' }).maxRecords, 8);
  assert.equal(normalizeRetrievalConfig({ maxChars: '1200' }).maxChars, 1200);
  assert.equal(normalizeRetrievalConfig({ maxRecords: 200 }).maxRecords, 200);
  assert.equal(normalizeRetrievalConfig({ maxRecords: 201 }).maxRecords, 20);
});

// ── 工厂：关闭就不造适配器 ────────────────────────────────────

test('默认关闭时工厂返回 null，开启后按模式造出只读适配器', (t) => {
  const { memory } = tempLedger(t);
  assert.equal(createEntryMemoryRetriever({ memory }), null);
  assert.equal(createEntryMemoryRetriever({ memory, config: { enabled: false } }), null);
  assert.equal(createEntryMemoryRetriever({ memory: null, config: { enabled: true } }), null);
  assert.equal(createEntryMemoryRetriever({ config: { enabled: true } }), null);

  const tail = createEntryMemoryRetriever({ memory, config: { enabled: true } });
  assert.equal(tail.retrieve({ subjectId: SUBJECT, scope: 'private', where: 'private:' + SUBJECT }).adapter.id, 'tail-window');
  assert.deepEqual(tail.capabilities, { lexical: false, semantic: false, localIndex: false });

  const lexical = createEntryMemoryRetriever({ memory, config: { enabled: true, mode: 'lexical' } });
  assert.equal(lexical.retrieve({ subjectId: SUBJECT }).adapter.id, 'lexical');
  assert.equal(lexical.capabilities.lexical, true);
});

test('检索是只读的：打开前后 people.json / turns.jsonl 逐字节不变', (t) => {
  const { dir, memory } = tempLedger(t);
  const peopleFile = path.join(dir, 'people.json');
  const turnsFile = path.join(dir, 'turns.jsonl');
  const before = [fs.readFileSync(peopleFile, 'utf8'), fs.readFileSync(turnsFile, 'utf8')];

  const config = { enabled: true, mode: 'lexical' };
  const retriever = createEntryMemoryRetriever({ memory, config });
  return retrieveMemoryForTurn({
    retriever, key: 'private:' + SUBJECT, userId: SUBJECT, text: '猫', config, now: NOW,
  }).then((out) => {
    assert.equal(out.used, true);
    assert.deepEqual([fs.readFileSync(peopleFile, 'utf8'), fs.readFileSync(turnsFile, 'utf8')], before);
    assert.equal(fs.existsSync(path.join(dir, 'memory')), false, '不得创建 v2 目录，也不得迁移');
  });
});

// ── 请求形状 ──────────────────────────────────────────────────

test('请求只带当前主体与会话，policy 恒不允许隔离记录', () => {
  const config = { enabled: true, maxRecords: 7, maxChars: 900, minConfidence: 0.4, allowUnattributed: true };
  const request = createRetrievalRequest({ key: 'private:' + SUBJECT, userId: Number(SUBJECT), text: '猫', now: NOW, config });
  assert.equal(request.schemaVersion, 1);
  assert.deepEqual(request.subject, { personId: SUBJECT, scope: 'private', conversationKey: 'private:' + SUBJECT });
  assert.equal(request.where, 'private:' + SUBJECT);
  assert.equal(request.query.text, '猫');
  assert.equal(request.time.nowIso, new Date(NOW).toISOString());
  assert.deepEqual(request.budget, { maxRecords: 7, maxChars: 900 });
  assert.equal(request.policy.includeQuarantined, false);
  assert.equal(request.policy.allowUnattributed, true);
  assert.equal(request.policy.minConfidence, 0.4);
});

test('scope 由会话 key 推导，认不出就留 null；没有主体就不造请求', () => {
  const scopeOf = (key) => createRetrievalRequest({ key, userId: SUBJECT, text: '', config: { enabled: true } }).scope;
  assert.equal(scopeOf('group:555'), 'group');
  assert.equal(scopeOf('flandre-web'), 'web');
  assert.equal(scopeOf('cli'), 'cli');
  assert.equal(scopeOf('unknown:1'), null);
  assert.equal(scopeOf(''), null);
  assert.equal(scopeOf(undefined), null);

  assert.equal(createRetrievalRequest({ key: 'group:1', userId: null, text: 'x' }), null);
  assert.equal(createRetrievalRequest({ key: 'group:1', userId: undefined }), null);
  assert.equal(createRetrievalRequest({ key: 'group:1', userId: '   ' }), null);

  const noClock = createRetrievalRequest({ key: 'private:1', userId: '1', now: 'nope' });
  assert.match(noClock.time.nowIso, /^\d{4}-\d{2}-\d{2}T/);
});

// ── 隐私：不渲染别人的、不该渲染的记录 ────────────────────────

test('主体边界：别人的记录、缺失主体的记录都不渲染', () => {
  const records = [
    record('fact', '自己的事实'),
    record('fact', '别人的事实', { subjectId: OTHER }),
    record('turn', '别人的轮次', { subjectId: OTHER }),
  ];
  const out = renderRetrievalMemory(records, { subjectId: SUBJECT, maxChars: 5000 });
  assert.equal(out.text, '他告诉过你：自己的事实');
  assert.equal(out.recordsUsed, 1);
  assert.equal(out.omitted, 2);

  // 主体缺失时只接受"显式允许 + 不可归属 + turn"这一种情形。
  const unattributed = [record('turn', '旧轮次', { subjectId: null })];
  assert.equal(renderRetrievalMemory(unattributed, { subjectId: SUBJECT, maxChars: 5000 }).recordsUsed, 0);
  assert.equal(renderRetrievalMemory(unattributed, { subjectId: SUBJECT, maxChars: 5000 }).omitted, 1);
  assert.equal(renderRetrievalMemory(unattributed, { subjectId: SUBJECT, allowUnattributed: true, maxChars: 5000 }).recordsUsed, 1);

  const factUnattributed = [record('fact', '无主事实', { subjectId: null })];
  assert.equal(renderRetrievalMemory(factUnattributed, { subjectId: SUBJECT, allowUnattributed: true }).recordsUsed, 0);
});

test('状态与隐私过滤：删除/隔离/替代/脱敏/受限/无 refs/空正文一律不渲染', () => {
  const rejected = [
    record('fact', '已删除', { correction: { status: 'deleted' } }),
    record('fact', '已隔离', { correction: { status: 'quarantined' } }),
    record('fact', '已替代', { correction: { status: 'superseded' } }),
    record('fact', '已脱敏', { privacy: { level: 'normal', redacted: true } }),
    record('fact', '受限', { privacy: { level: 'restricted', redacted: false } }),
    record('fact', '无出处', { provenance: { source: 'derived', refs: [] } }),
    record('fact', '没有 refs 字段', { provenance: { source: 'derived' } }),
    record('fact', '   '),
    record('fact', 42),
    null,
    undefined,
    'nope',
    record('unexpected_kind', '类别不在白名单'),
  ];
  const out = renderRetrievalMemory([...rejected, record('fact', '唯一保留')], { subjectId: SUBJECT });
  assert.equal(out.text, '他告诉过你：唯一保留');
  assert.equal(out.recordsUsed, 1);
  assert.equal(out.omitted, rejected.length);
});

test('status 缺省、privacy 缺省的历史记录仍可渲染（只按已给出的字段判断）', () => {
  const legacy = [
    record('trait', '常熬夜', { correction: undefined, privacy: undefined }),
    record('pending', '想问猫的名字', { correction: {}, privacy: {} }),
  ];
  const out = renderRetrievalMemory(legacy, { subjectId: SUBJECT });
  assert.equal(out.text, '你了解他：常熬夜\n⚠️ 你心里还记着没说出口的事：想问猫的名字');
});

// ── 渲染与预算 ────────────────────────────────────────────────

test('渲染：固定类别顺序、类别内保持适配器顺序、turn 带核实过的回复', () => {
  const records = [
    record('pending', '想问猫的名字'),
    record('fact', '养了只猫'),
    record('trait', '常熬夜'),
    record('turn', '今天加班到两点', { reply: '又熬' }),
    record('interaction', '37'),
  ];
  const out = renderRetrievalMemory(records, { subjectId: SUBJECT, maxChars: 5000 });
  assert.equal(
    out.text,
    ['你了解他：常熬夜', '他告诉过你：养了只猫', '⚠️ 你心里还记着没说出口的事：想问猫的名字', '最近聊过：今天加班到两点', '  你：又熬', '你们互动过 37 次'].join('\n'),
  );

  const noReply = renderRetrievalMemory([record('turn', '只有用户话')], { subjectId: SUBJECT });
  assert.equal(noReply.text, '最近聊过：只有用户话');
  const unknownKindLabel = renderRetrievalMemory([record('task_ref', '买菜')], { subjectId: SUBJECT });
  assert.equal(unknownKindLabel.text, '待办：买菜');
});

test('渲染：单条折叠空白并截到 160 字符，不改写其余内容', () => {
  const long = '长的'.repeat(200);
  const out = renderRetrievalMemory([record('fact', '  多   空格\n换行  '), record('fact', long)], { subjectId: SUBJECT, maxChars: 10000 });
  const parts = out.text.split('；');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], '他告诉过你：多 空格 换行');
  assert.equal(parts[1], '他告诉过你：' + long.slice(0, MEMORY_RECORD_MAX_CHARS));
  assert.ok(parts[1].length <= MEMORY_RECORD_MAX_CHARS + '他告诉过你：'.length);
});

test('渲染：整块不超过 maxChars，按整条贪心且不留半句', () => {
  const records = [record('fact', '甲'.repeat(80)), record('fact', '乙'.repeat(80)), record('fact', '丙'.repeat(80))];
  const one = renderRetrievalMemory(records, { subjectId: SUBJECT, maxChars: 900 });
  assert.equal(one.recordsUsed, 3);

  const split = renderRetrievalMemory(records, { subjectId: SUBJECT, maxChars: 100 });
  assert.ok(split.text.length <= 100);
  assert.equal(split.recordsUsed, 1, '第二条放不下就停');
  assert.equal(split.omitted, 2);
  assert.ok(!split.text.includes('乙'), '绝不把半条塞进去');

  const tiny = renderRetrievalMemory(records, { subjectId: SUBJECT, maxChars: 3 });
  assert.deepEqual(tiny, { text: '', recordsUsed: 0, omitted: 3 });

  // 默认上限就是记忆槽上限，不会把超长文本丢给 Role.build 兜底。
  const many = Array.from({ length: 80 }, (_, index) => record('fact', '事实' + index + '：' + '内容'.repeat(70)));
  const bounded = renderRetrievalMemory(many, { subjectId: SUBJECT });
  assert.ok(bounded.text.length <= MEMORY_SLOT_MAX_CHARS);
  assert.ok(bounded.recordsUsed > 0 && bounded.recordsUsed < many.length);
  assert.equal(bounded.recordsUsed + bounded.omitted, many.length);
});

test('渲染：同输入同输出，且不修改入参', () => {
  const records = [record('trait', '常熬夜'), record('fact', '养了只猫')];
  const snapshot = JSON.stringify(records);
  const first = renderRetrievalMemory(records, { subjectId: SUBJECT });
  const second = renderRetrievalMemory(records, { subjectId: SUBJECT });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(records), snapshot);
  assert.deepEqual(renderRetrievalMemory(undefined, {}), { text: '', recordsUsed: 0, omitted: 0 });
  assert.deepEqual(renderRetrievalMemory('nope', {}), { text: '', recordsUsed: 0, omitted: 0 });
});

// ── 降级（T-3）：绝不抛、绝不拦 ───────────────────────────────

test('降级：没有适配器、没有主体、适配器抛错、返回非法结构都不抛', async () => {
  const config = { enabled: true };
  const base = await retrieveMemoryForTurn({ key: 'private:' + SUBJECT, userId: SUBJECT, config });
  assert.equal(base.used, false);
  assert.equal(base.reason, 'adapter-missing');

  const noSubject = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [] })),
    key: 'group:1',
    userId: null,
    config,
  });
  assert.equal(noSubject.reason, 'missing-subject');
  assert.equal(noSubject.memory, '');

  const throwing = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => { throw new Error('合成故障'); }),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config,
  });
  assert.deepEqual(
    { used: throwing.used, reason: throwing.reason, degraded: throwing.degraded },
    { used: false, reason: 'adapter-error', degraded: 'adapter-error' },
  );

  for (const invalid of [null, undefined, 'nope', {}, { records: 'nope' }, []]) {
    const out = await retrieveMemoryForTurn({
      retriever: fakeRetriever(() => invalid),
      key: 'private:' + SUBJECT,
      userId: SUBJECT,
      config,
    });
    assert.equal(out.used, false, String(invalid));
    assert.equal(out.reason, 'invalid-result', String(invalid));
  }
});

test('降级：async 适配器也支持；index-missing 空结果与其它 degraded 都回退', async () => {
  const config = { enabled: true };
  const asyncAdapter = {
    async retrieve() {
      return { adapter: { mode: 'lexical' }, records: [record('fact', '异步给的')], degraded: null };
    },
  };
  const ok = await retrieveMemoryForTurn({ retriever: asyncAdapter, key: 'private:' + SUBJECT, userId: SUBJECT, config });
  assert.equal(ok.used, true);
  assert.equal(ok.mode, 'lexical');
  assert.equal(ok.memory, '他告诉过你：异步给的');

  const emptyIndex = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [], degraded: { reason: 'index-missing' } })),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config,
  });
  assert.equal(emptyIndex.used, false);
  assert.equal(emptyIndex.reason, 'degraded-empty');
  assert.equal(emptyIndex.degraded, 'index-missing');

  const broken = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [record('fact', '不该出现')], degraded: 'schema-mismatch' })),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config,
  });
  assert.equal(broken.used, false);
  assert.equal(broken.reason, 'degraded');
  assert.equal(broken.memory, '');

  // 字符串形式与未知形态的 degraded 都归一化成可读原因。
  const stringDegraded = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [], degraded: 'adapter-error' })),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config,
  });
  assert.equal(stringDegraded.degraded, 'adapter-error');
  const unknownDegraded = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [], degraded: { reason: 42 } })),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config,
  });
  assert.equal(unknownDegraded.degraded, 'degraded');
});

test('隐私拒绝不回退：denied 时给空块，绝不退回别人的记忆', async () => {
  const out = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({
      records: [record('fact', '全场记忆')],
      privacy: { denied: true, deniedReason: 'missing-subject' },
    })),
    key: 'group:1',
    userId: SUBJECT,
    config: { enabled: true },
  });
  assert.equal(out.used, true);
  assert.equal(out.denied, true);
  assert.equal(out.memory, '');
  assert.equal(out.reason, 'privacy-denied');
});

test('过滤后为空返回 empty，不假装成功', async () => {
  const out = await retrieveMemoryForTurn({
    retriever: fakeRetriever(() => ({ records: [record('fact', '别人的', { subjectId: OTHER })] })),
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    config: { enabled: true },
  });
  assert.equal(out.used, false);
  assert.equal(out.reason, 'empty');
  assert.equal(out.omitted, 1);
});

// ── 端到端：真实账本 → 适配器 → Brain ────────────────────────

test('端到端：关着时请求体与接线前逐字节一致', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  const plain = new Brain({ apiKey: '合成-key', role, memory });
  await plain.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });

  const withBlocks = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks: null });
  await withBlocks.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });

  const expected = role.build({ memory: memory.renderPerson(SUBJECT), recent: memory.renderRecent(20, { excludeWhere: 'private:' + SUBJECT }) });
  assert.equal(systemPromptOf(calls[0]), expected);
  assert.equal(calls[0].init.body, calls[1].init.body);

  // 配置没开时入口给的就是 null：Brain 一次都不调用提供者。
  assert.equal(buildMemoryBlocks({ memory: {} }, memory), null);
  assert.equal(buildMemoryBlocks({}, memory), null);
  assert.equal(buildMemoryBlocks(undefined, memory), null);
});

test('端到端：开着时记忆块来自检索，且只含当前主体的记录', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  const memoryBlocks = buildMemoryBlocks({ memory: { retrieval: { enabled: true, mode: 'tail-window' } } }, memory);
  assert.equal(typeof memoryBlocks, 'function');
  const brain = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks });
  await brain.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '猫还好吗', record: false });

  const system = systemPromptOf(calls[0]);
  // 只检查记忆槽那一段：`recent` 块沿用既有跨场合渲染语义，不在本次改动范围内。
  const memorySlot = system.slice(0, system.indexOf('【最近的真实对话'));
  assert.match(memorySlot, /你了解他：常熬夜/);
  assert.match(memorySlot, /他告诉过你：养了只猫/);
  assert.ok(!memorySlot.includes('别人的秘密'), '绝不能把别人的记录带进记忆槽');
  assert.ok(!memorySlot.includes('最近聊过：别人的话'));
  assert.ok(!memorySlot.includes('【关于'), '开了检索就不再叠加 renderPerson 的整块账本');
});

test('端到端：lexical 模式按查询词把相关的记录排在前面', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  const memoryBlocks = buildMemoryBlocks({ memory: { retrieval: { enabled: true, mode: 'lexical' } } }, memory);
  const brain = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks });
  await brain.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '猫', record: false });

  const system = systemPromptOf(calls[0]);
  const fed = system.indexOf('养了只猫');
  assert.notEqual(fed, -1);
  assert.match(system, /常熬夜/);
});

test('端到端：提供者抛错或返回空值时不读取旧账本，模型照常调用', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  const throwing = new Brain({
    apiKey: '合成-key',
    role,
    memory,
    memoryBlocks: () => { throw new Error('合成故障'); },
  });
  await throwing.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });
  assert.ok(!systemPromptOf(calls[0]).includes('【关于'));

  const blank = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks: async () => '   ' });
  await blank.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });
  assert.ok(!systemPromptOf(calls[1]).includes('【关于'));

  const nonString = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks: () => 42 });
  await nonString.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });
  assert.ok(!systemPromptOf(calls[2]).includes('【关于'));

  assert.equal(calls.length, 3);
});

test('端到端：没有主体（群聊多发送者）时没有长期记忆块', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  const memoryBlocks = buildMemoryBlocks({ memory: { retrieval: { enabled: true, mode: 'lexical' } } }, memory);
  const brain = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks });
  await brain.reply({ key: 'group:555', userId: '', userName: '某人', text: '在吗', record: false });

  assert.equal(systemPromptOf(calls[0]), role.build({
    memory: '',
    recent: memory.renderRecent(20, { excludeWhere: 'group:555' }),
  }));
});

test('端到端：适配器抛错时不读取旧账本，模型照常调用', async (t) => {
  const { memory } = tempLedger(t);
  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);

  // 用真实检索入口 + 一个必然抛错的适配器，验证"降级不拦对话"。
  const memoryBlocks = buildMemoryBlocks({ memory: { retrieval: { enabled: true } } }, memory);
  const brain = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks });

  const original = memory.dump;
  memory.dump = () => { throw new Error('合成故障'); };
  t.after(() => { memory.dump = original; });
  await brain.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });

  assert.equal(calls.length, 1, '适配器故障时模型仍要被调用一次');
  assert.ok(!systemPromptOf(calls[0]).includes('【关于'));
});

test('端到端：真实适配器读不到账本时回退旧路径，不写盘', async (t) => {
  const { dir, memory } = tempLedger(t);
  const before = fs.readFileSync(path.join(dir, 'people.json'), 'utf8');
  const config = { enabled: true };

  // 适配器实例的 #collect 抛错时只降级，不抛；账本保持原样。
  const retriever = createEntryMemoryRetriever({ memory, config });
  const realDump = memory.dump;
  memory.dump = () => { throw new Error('合成故障'); };
  const out = await retrieveMemoryForTurn({
    retriever,
    key: 'private:' + SUBJECT,
    userId: SUBJECT,
    text: '在吗',
    config,
  });
  memory.dump = realDump;

  assert.equal(out.used, false);
  assert.equal(out.reason, 'degraded');
  assert.equal(out.degraded, 'adapter-error');
  assert.equal(out.memory, '');
  assert.equal(fs.readFileSync(path.join(dir, 'people.json'), 'utf8'), before);
});

test('入口配置：loadConfig 读 memory.retrieval，缺省与非法值都安全', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entry-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'role.md'), '# 角色卡\n合成。\n');

  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  const withoutMemory = loadConfig(write('a.json', { dataDir: './data' }), ['node', 'src/index.js']);
  assert.equal(withoutMemory.memory.retrieval.enabled, false);
  assert.equal(withoutMemory.memory.retrieval.mode, 'tail-window');

  const explicit = loadConfig(write('b.json', {
    dataDir: './data',
    memory: { retrieval: { enabled: true, mode: 'lexical', maxChars: 2048 } },
  }), ['node', 'src/index.js']);
  assert.equal(explicit.memory.retrieval.enabled, true);
  assert.equal(explicit.memory.retrieval.mode, 'lexical');
  assert.equal(explicit.memory.retrieval.maxChars, 2048);

  const bogus = loadConfig(write('c.json', {
    dataDir: './data',
    memory: { retrieval: { enabled: 'yes', mode: 'semantic', maxChars: -1 } },
  }), ['node', 'src/index.js']);
  assert.equal(bogus.memory.retrieval.enabled, false);
  assert.equal(bogus.memory.retrieval.mode, 'tail-window');
  assert.equal(bogus.memory.retrieval.maxChars, MEMORY_SLOT_MAX_CHARS);
});

test('账本对象异常时：适配器内部降级，提供者返回空块', async (t) => {
  // 账本代理一读属性就抛：适配器读账本会失败。整条链路仍然不抛——
  // 适配器降级时，提供者保留空记忆块。
  const exploding = new Proxy({}, {
    get() { throw new Error('合成故障'); },
  });
  const memoryBlocks = buildMemoryBlocks({ memory: { retrieval: { enabled: true } } }, exploding);
  assert.equal(typeof memoryBlocks, 'function');
  assert.equal(await memoryBlocks({ key: 'private:' + SUBJECT, userId: SUBJECT, text: '在吗' }), '');

  const role = new Role({ cardPath: tempCard(t) });
  const calls = installFetch(t);
  const memory = new Memory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entry-explode-')) });
  t.after(() => fs.rmSync(memory.dir, { recursive: true, force: true }));
  const brain = new Brain({ apiKey: '合成-key', role, memory, memoryBlocks });
  await brain.reply({ key: 'private:' + SUBJECT, userId: SUBJECT, userName: '老王', text: '在吗', record: false });
  assert.equal(calls.length, 1, '提供者降级时模型仍要被调用一次');
  assert.equal(systemPromptOf(calls[0]), role.build({
    memory: '',
    recent: memory.renderRecent(20, { excludeWhere: 'private:' + SUBJECT }),
  }));
});
