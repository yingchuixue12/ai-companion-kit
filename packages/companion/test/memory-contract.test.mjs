/**
 * M-0 · MemoryRecord 契约的离线测试（纯模块边界）
 * ─────────────────────────────────────────────────────────────
 * 只导入 `src/memory/record-contract.js`，不接 memory.js 主线、不建真实存储、
 * 不读 `data/`、不联网、不调用模型。
 *
 * 覆盖两个真实边界（见 docs/flandre-memory-contract.md §4.1 / §4.2 / §6.4）：
 *   - 写入 / 迁移边界：`validateRecordStrict` / `assertRecord`；
 *   - 读取 / 检索边界：`validateStoredRecord`（宽容可选字段、拒绝写坏的字段）；
 *   - tombstone：默认只认 id（历史文件），strict 追加 at/by/reason 类型检查；
 *   - 兼容：缺 schemaVersion 视为 1，未知字段原样保留且校验器只读。
 *
 * 验收：node --test packages/companion/test/memory-contract.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECORD_CONTRACT_VERSION,
  RECORD_LAYERS,
  RECORD_KINDS,
  RECORD_SOURCES,
  RECORD_STATUSES,
  RECORD_STABILITIES,
  RECORD_PRIVACY_LEVELS,
  RECORD_REF_KINDS,
  RECORD_SCOPES,
  RecordContractError,
  assertRecord,
  validateRecordStrict,
  validateStoredRecord,
  validateTombstone,
} from '../src/memory/record-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBSERVED_AT = '2026-11-21T04:00:00.000Z';
const RECORDED_AT = '2026-11-21T04:00:05.000Z';

/** 一条合法的 v2 记录（合成 fixture，不来自任何真实记忆）。 */
function record(overrides = {}) {
  return {
    id: 'mem_fixture_1',
    schemaVersion: 1,
    subjectId: 'u1',
    layer: 'user_fact',
    kind: 'fact',
    text: '养了猫',
    stability: 'stable',
    confidence: 0.8,
    privacy: { level: 'normal' },
    provenance: { source: 'user_message', refs: [{ kind: 'turn', id: 'turn_1' }] },
    correction: { status: 'active' },
    observedAt: OBSERVED_AT,
    recordedAt: RECORDED_AT,
    ...overrides,
  };
}

/** v1 布局时代的最小记录：只有 id/provenance/correction，没有 v2 的可选字段。 */
function legacyRecord(overrides = {}) {
  return {
    id: 'mem_legacy_1',
    provenance: { refs: [{ kind: 'action' }] },
    correction: { status: 'active' },
    ...overrides,
  };
}

function expectProblem(result, code, field) {
  assert.deepEqual(result, { code, field }, '应为 ' + code + (field ? '（' + field + '）' : ''));
}

test('contract constants are frozen, versioned and match the documented schema', () => {
  assert.equal(RECORD_CONTRACT_VERSION, 1);
  for (const list of [
    RECORD_LAYERS,
    RECORD_KINDS,
    RECORD_SOURCES,
    RECORD_STATUSES,
    RECORD_STABILITIES,
    RECORD_PRIVACY_LEVELS,
    RECORD_REF_KINDS,
    RECORD_SCOPES,
  ]) {
    assert.equal(Object.isFrozen(list), true);
  }
  assert.deepEqual([...RECORD_LAYERS], [
    'relationship',
    'user_fact',
    'shared_experience',
    'current_state',
    'temp_task',
  ]);
  assert.deepEqual([...RECORD_KINDS], ['trait', 'fact', 'topic', 'pending', 'interaction', 'turn', 'task_ref']);
  assert.deepEqual([...RECORD_SOURCES], ['user_message', 'host_verified', 'model_claim', 'derived', 'migration']);
  assert.deepEqual([...RECORD_STATUSES], ['active', 'superseded', 'deleted', 'quarantined']);
  assert.deepEqual([...RECORD_STABILITIES], ['stable', 'volatile']);
  assert.deepEqual([...RECORD_PRIVACY_LEVELS], ['normal', 'sensitive', 'restricted']);
  assert.deepEqual([...RECORD_REF_KINDS], ['turn', 'journal', 'action', 'task']);
  assert.deepEqual([...RECORD_SCOPES], ['private', 'group', 'web', 'cli', 'flandre-web']);
});

test('strict boundary accepts a complete v2 record without mutating it', () => {
  const valid = record();
  const snapshot = JSON.stringify(valid);
  assert.equal(validateRecordStrict(valid), null);
  assert.equal(assertRecord(valid), valid, '断言通过时必须返回同一条记录（不复制）');
  assert.equal(JSON.stringify(valid), snapshot, '校验器必须只读');
});

test('strict boundary rejects malformed records with structured {code, field} diagnostics', () => {
  const valid = record();
  const cases = [
    ['non-object-null', null, 'invalid-record', null],
    ['non-object-array', [], 'invalid-record', null],
    ['non-object-string', 'record', 'invalid-record', null],
    ['missing-id', { ...valid, id: undefined }, 'missing-id', 'id'],
    ['blank-id', { ...valid, id: '   ' }, 'missing-id', 'id'],
    ['non-string-id', { ...valid, id: 7 }, 'missing-id', 'id'],
    ['unsupported-schema', { ...valid, schemaVersion: 2 }, 'unsupported-schema', 'schemaVersion'],
    ['missing-correction', { ...valid, correction: undefined }, 'invalid-status', 'correction'],
    ['bad-correction-status', { ...valid, correction: { status: 'zombie' } }, 'invalid-status', 'correction.status'],
    ['bad-correction-tombstone', { ...valid, correction: { status: 'active', tombstone: 'gone' } }, 'invalid-correction', 'correction.tombstone'],
    ['missing-provenance', { ...valid, provenance: undefined }, 'missing-provenance', 'provenance'],
    ['empty-refs', { ...valid, provenance: { ...valid.provenance, refs: [] } }, 'missing-provenance-refs', 'provenance.refs'],
    ['refs-not-array', { ...valid, provenance: { ...valid.provenance, refs: 'turn_1' } }, 'missing-provenance-refs', 'provenance.refs'],
    ['unknown-source', { ...valid, provenance: { ...valid.provenance, source: 'oracle' } }, 'unknown-source', 'provenance.source'],
    ['missing-source', { ...valid, provenance: { refs: [{ kind: 'turn' }] } }, 'unknown-source', 'provenance.source'],
    ['unknown-ref-kind', { ...valid, provenance: { ...valid.provenance, refs: [{ kind: 'gossip' }] } }, 'invalid-ref', 'provenance.refs'],
    ['non-object-ref', { ...valid, provenance: { ...valid.provenance, refs: ['turn'] } }, 'invalid-ref', 'provenance.refs'],
    ['bad-subject', { ...valid, subjectId: 42 }, 'invalid-subject', 'subjectId'],
    ['unknown-layer', { ...valid, layer: 'persona_core' }, 'unknown-layer', 'layer'],
    ['missing-layer', { ...valid, layer: undefined }, 'unknown-layer', 'layer'],
    ['unknown-kind', { ...valid, kind: 'gossip' }, 'unknown-kind', 'kind'],
    ['missing-kind', { ...valid, kind: undefined }, 'unknown-kind', 'kind'],
    ['missing-text', { ...valid, text: undefined }, 'invalid-text', 'text'],
    ['non-string-text', { ...valid, text: 42 }, 'invalid-text', 'text'],
    ['bad-stability', { ...valid, stability: 'eternal' }, 'invalid-stability', 'stability'],
    ['missing-stability', { ...valid, stability: undefined }, 'invalid-stability', 'stability'],
    ['confidence-too-high', { ...valid, confidence: 1.5 }, 'invalid-confidence', 'confidence'],
    ['confidence-negative', { ...valid, confidence: -0.01 }, 'invalid-confidence', 'confidence'],
    ['confidence-not-number', { ...valid, confidence: 'high' }, 'invalid-confidence', 'confidence'],
    ['missing-privacy', { ...valid, privacy: undefined }, 'invalid-privacy', 'privacy'],
    ['bad-privacy-level', { ...valid, privacy: { level: 'secret' } }, 'invalid-privacy', 'privacy.level'],
    ['bad-observed-at', { ...valid, observedAt: 'yesterday' }, 'invalid-timestamp', 'observedAt'],
    ['missing-observed-at', { ...valid, observedAt: undefined }, 'invalid-timestamp', 'observedAt'],
    ['missing-recorded-at', { ...valid, recordedAt: undefined }, 'invalid-timestamp', 'recordedAt'],
    ['bad-last-confirmed-at', { ...valid, lastConfirmedAt: 'soon' }, 'invalid-timestamp', 'lastConfirmedAt'],
    ['bad-reply', { ...valid, reply: 42 }, 'invalid-text', 'reply'],
    ['bad-scope', { ...valid, scope: 'public' }, 'invalid-scope', 'scope'],
    ['bad-quarantine', { ...valid, quarantine: 'rule-list' }, 'invalid-quarantine', 'quarantine'],
    ['bad-quarantine-rules', { ...valid, quarantine: { rules: 'imperative' } }, 'invalid-quarantine', 'quarantine.rules'],
  ];

  for (const [label, candidate, code, field] of cases) {
    const found = validateRecordStrict(candidate);
    assert.ok(found, '必须拒绝：' + label);
    assert.deepEqual(Object.keys(found), ['code', 'field'], '诊断必须只有 code/field：' + label);
    expectProblem(found, code, field);
    assert.throws(
      () => assertRecord(candidate),
      (error) => error instanceof RecordContractError
        && error.name === 'RecordContractError'
        && error.code === code
        && error.field === field,
      label,
    );
  }
});

test('strict boundary accepts null/optional compat values and numeric strings', () => {
  const valid = record({
    subjectId: null,
    scope: 'flandre-web',
    reply: null,
    lastConfirmedAt: null,
    quarantine: { rules: ['imperative-v1'], policy: 'quarantine-v1' },
    confidence: '0.5',
    schemaVersion: '1',
  });
  assert.equal(validateRecordStrict(valid), null);
  assert.equal(validateStoredRecord(valid), null);
});

test("layout v1 stays readable while the v2 write boundary keeps its strictness", () => {
  const legacy = legacyRecord();
  assert.equal(validateStoredRecord(legacy), null, 'v1 记录缺 v2 字段时必须仍然可读');
  assert.equal(validateStoredRecord({ ...legacy, schemaVersion: null }), null, 'schemaVersion=null 视为缺省');
  assert.equal(validateStoredRecord({ ...legacy, schemaVersion: 1 }), null);

  // §6.4：缺 schemaVersion 一律视为 1，而不是当作未知版本拒绝。
  expectProblem(validateRecordStrict({ ...legacy, schemaVersion: 2 }), 'unsupported-schema', 'schemaVersion');
  expectProblem(validateStoredRecord({ ...legacy, schemaVersion: 2 }), 'unsupported-schema', 'schemaVersion');
  expectProblem(validateStoredRecord({ ...legacy, schemaVersion: '3' }), 'unsupported-schema', 'schemaVersion');

  // 写/迁移边界只接受字段齐全的 v2 形态：v1 最小记录必须先在迁移里补字段。
  expectProblem(validateRecordStrict(legacy), 'invalid-subject', 'subjectId');
  expectProblem(validateRecordStrict({ ...legacy, subjectId: null }), 'unknown-layer', 'layer');
  assert.equal(validateRecordStrict(record({ schemaVersion: undefined })), null, '缺省版本 + v2 字段齐全仍然合法');
});

test('stored boundary tolerates missing optional fields but rejects fields written wrong', () => {
  const valid = record();

  // 宽容：v1 形态、以及 v2 记录里可缺省/可为 null 的可选字段。
  const tolerant = [
    legacyRecord(),
    { ...valid, layer: undefined, kind: undefined, text: undefined, stability: undefined, confidence: undefined },
    { ...valid, privacy: null, reply: null, scope: null, observedAt: null, recordedAt: null, lastConfirmedAt: null },
    { ...valid, quarantine: null, correction: { status: 'quarantined' } },
    { ...valid, provenance: { refs: [{ kind: 'task' }], source: undefined } },
  ];
  for (const candidate of tolerant) {
    assert.equal(validateStoredRecord(candidate), null, '读取档不应拒绝历史缺省字段');
  }

  // 拒绝：已经写进文件的非法枚举 / 越界 / 坏时间戳 / 坏引用。
  const cases = [
    ['missing-id', { ...valid, id: '' }, 'missing-id', 'id'],
    ['unsupported-schema', { ...valid, schemaVersion: 9 }, 'unsupported-schema', 'schemaVersion'],
    ['missing-correction', { ...valid, correction: null }, 'invalid-status', 'correction'],
    ['unknown-layer', { ...valid, layer: 'persona_core' }, 'unknown-layer', 'layer'],
    ['unknown-kind', { ...valid, kind: 'gossip' }, 'unknown-kind', 'kind'],
    ['confidence-out-of-range', { ...valid, confidence: 2 }, 'invalid-confidence', 'confidence'],
    ['bad-stability', { ...valid, stability: 'forever' }, 'invalid-stability', 'stability'],
    ['bad-privacy', { ...valid, privacy: { level: 'public' } }, 'invalid-privacy', 'privacy.level'],
    ['bad-timestamp', { ...valid, observedAt: 'not-a-date' }, 'invalid-timestamp', 'observedAt'],
    ['bad-quarantine-rules', { ...valid, quarantine: { rules: 'x' } }, 'invalid-quarantine', 'quarantine.rules'],
    ['empty-refs', { ...valid, provenance: { ...valid.provenance, refs: [] } }, 'missing-provenance-refs', 'provenance.refs'],
  ];
  for (const [label, candidate, code, field] of cases) {
    expectProblem(validateStoredRecord(candidate), code, field);
    assert.ok(validateRecordStrict(candidate), '读取档拒绝的字段在写入档也必须拒绝：' + label);
  }
});

test('unknown fields are preserved verbatim and never used to widen the contract', () => {
  const valid = record({
    unknownTopLevel: { nested: [1, 2, 3] },
    provenance: {
      source: 'user_message',
      refs: [{ kind: 'turn', id: 'turn_1' }],
      unknownProvenance: 'kept',
    },
    privacy: { level: 'normal', unknownPrivacy: true },
    correction: { status: 'active', unknownCorrection: 'kept' },
  });
  const snapshot = JSON.parse(JSON.stringify(valid));

  assert.equal(validateRecordStrict(valid), null);
  assert.equal(validateStoredRecord(valid), null);
  assert.equal(assertRecord(valid), valid);
  assert.deepEqual(valid, snapshot, '未知字段必须原样保留');
  assert.deepEqual(valid.unknownTopLevel, { nested: [1, 2, 3] });
  assert.equal(valid.provenance.unknownProvenance, 'kept');
  assert.equal(valid.privacy.unknownPrivacy, true);
  assert.equal(valid.correction.unknownCorrection, 'kept');

  // 未知字段不能顶替已知字段：把 layer 挪进未知字段仍然拒绝。
  const { layer, ...withoutLayer } = valid;
  assert.ok(layer);
  expectProblem(validateRecordStrict({ ...withoutLayer, unknownLayer: layer }), 'unknown-layer', 'layer');
});

test('assertRecord throws a labelled, content-free RecordContractError', () => {
  const broken = record({ id: 'mem_broken', layer: 'persona_core' });

  assert.throws(
    () => assertRecord(broken, 'import-batch'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof RecordContractError);
      assert.equal(error.code, 'unknown-layer');
      assert.equal(error.field, 'layer');
      assert.match(error.message, /unknown-layer/);
      assert.match(error.message, /layer/);
      assert.match(error.message, /\[import-batch\]/);
      assert.equal(error.message.includes(broken.text), false, '错误信息不得包含记录正文');
      return true;
    },
  );

  // 无字段的顶层错误：field 为 null，消息里不出现空括号。
  assert.throws(
    () => assertRecord(null),
    (error) => error.code === 'invalid-record'
      && error.field === null
      && error.message.includes('invalid-record')
      && error.message.includes('（）') === false,
  );

  // 未给 label 时不追加方括号后缀。
  assert.equal(new RecordContractError('missing-id').message, 'MemoryRecord 不符合契约：missing-id');
  assert.equal(new RecordContractError('missing-id', 'id', '').message, 'MemoryRecord 不符合契约：missing-id（id）');
});

test('tombstone validation: read boundary only needs id, strict boundary checks at/by/reason', () => {
  expectProblem(validateTombstone(null), 'invalid-tombstone', null);
  expectProblem(validateTombstone([]), 'invalid-tombstone', null);
  expectProblem(validateTombstone('mem_1'), 'invalid-tombstone', null);
  expectProblem(validateTombstone({}), 'missing-tombstone-id', 'id');
  expectProblem(validateTombstone({ id: '   ' }), 'missing-tombstone-id', 'id');

  // 读取边界：历史墓碑可能只有 id，多余字段不校验。
  assert.equal(validateTombstone({ id: 'mem_1' }), null);
  assert.equal(validateTombstone({ id: 'mem_1', at: 'yesterday', by: 'nobody', reason: 42 }), null);

  // 写入边界：at / by / reason 必须类型正确；缺省或 null 仍然允许。
  assert.equal(validateTombstone({ id: 'mem_1' }, { strict: true }), null);
  assert.equal(
    validateTombstone({ id: 'mem_1', at: OBSERVED_AT, by: 'user', reason: 'user-request' }, { strict: true }),
    null,
  );
  assert.equal(validateTombstone({ id: 'mem_1', at: null, by: 'host' }, { strict: true }), null);
  assert.equal(validateTombstone({ id: 'mem_1', by: 'migration' }, { strict: true }), null);
  expectProblem(validateTombstone({ id: 'mem_1', at: 'yesterday' }, { strict: true }), 'invalid-tombstone', 'at');
  expectProblem(validateTombstone({ id: 'mem_1', by: 'nobody' }, { strict: true }), 'invalid-tombstone', 'by');
  expectProblem(validateTombstone({ id: 'mem_1', reason: 42 }, { strict: true }), 'invalid-tombstone', 'reason');
  expectProblem(validateTombstone({}, { strict: true }), 'missing-tombstone-id', 'id');

  // strict 只认识 user/host/migration，不接受任意字符串。
  assert.ok(validateTombstone({ id: 'mem_1', by: 'USER' }, { strict: true }));
});

test('both pure modules stay dependency-free and content-blind', () => {
  const sources = ['record-contract.js', 'privacy-rules.js'].map((name) => {
    const file = path.join(HERE, '../src/memory', name);
    return { name, text: fs.readFileSync(file, 'utf8') };
  });

  for (const { name, text } of sources) {
    assert.equal(/^\s*import\s/m.test(text), false, name + ' 不得有运行时依赖');
    assert.equal(/\brequire\s*\(/.test(text), false, name + ' 不得使用 require');
    assert.equal(/\bprocess\.env\b/.test(text), false, name + ' 不得读取环境变量');
    assert.equal(/\b(?:fetch|https?\.request|net\.connect)\s*\(/.test(text), false, name + ' 不得联网');
    assert.equal(/readFileSync|writeFileSync|readdirSync/.test(text), false, name + ' 不得直接读写文件');
    assert.equal(/\bDate\.now\s*\(/.test(text), false, name + ' 不得依赖当前时钟');
  }
});