/**
 * MemoryRecord 契约的运行时校验（M-0）
 * ─────────────────────────────────────────────────────────────
 * 检索结果必须保留来源 refs；读取旧记录时保留未知字段。
 *
 * 两个强度，对应两个真实边界：
 *   - `validateRecordStrict` / `assertRecord`：**写入与迁移边界**。字段必须齐全，
 *     layer/kind/source/status/confidence 必须合法，否则拒绝落盘（fail-closed）。
 *   - `validateStoredRecord`：**读取 / 检索来源边界**。沿用历史结构校验，并额外拒绝
 *     已经写进文件的非法字段（未知 layer、confidence 越界、坏时间戳…）；对历史记录
 *     里可能缺失的可选字段保持宽容，避免把老数据整体判死。
 *
 * 两条路径都**不修改**记录：未知字段原样保留，只读判断。
 */

export const RECORD_CONTRACT_VERSION = 1;

export const RECORD_LAYERS = Object.freeze([
  'relationship', 'user_fact', 'shared_experience', 'current_state', 'temp_task',
]);

export const RECORD_KINDS = Object.freeze([
  'trait', 'fact', 'topic', 'pending', 'interaction', 'turn', 'task_ref',
]);

export const RECORD_SOURCES = Object.freeze([
  'user_message', 'host_verified', 'model_claim', 'derived', 'migration',
]);

export const RECORD_STATUSES = Object.freeze(['active', 'superseded', 'deleted', 'quarantined']);

export const RECORD_STABILITIES = Object.freeze(['stable', 'volatile']);

export const RECORD_PRIVACY_LEVELS = Object.freeze(['normal', 'sensitive', 'restricted']);

export const RECORD_REF_KINDS = Object.freeze(['turn', 'journal', 'action', 'task']);

/** scope 允许值；`flandre-web` 是入口历史写法，与 `web` 等价（memory.js 的归一化）。 */
export const RECORD_SCOPES = Object.freeze(['private', 'group', 'web', 'cli', 'flandre-web']);

export class RecordContractError extends Error {
  constructor(code, field, message) {
    super(message || ('MemoryRecord 不符合契约：' + code + (field ? '（' + field + '）' : '')));
    this.name = 'RecordContractError';
    this.code = code;
    this.field = field || null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function problem(code, field) {
  return { code, field: field || null };
}

function checkSchemaVersion(record) {
  // §6.4：缺 schemaVersion 一律视为 1。
  if (record.schemaVersion === undefined || record.schemaVersion === null) return null;
  if (Number(record.schemaVersion) !== 1) return problem('unsupported-schema', 'schemaVersion');
  return null;
}

function checkCorrection(record, strict) {
  const correction = record.correction;
  if (!isPlainObject(correction)) return problem(strict ? 'invalid-correction' : 'invalid-status', 'correction');
  if (!RECORD_STATUSES.includes(String(correction.status || ''))) {
    return problem('invalid-status', 'correction.status');
  }
  if (correction.tombstone !== undefined && correction.tombstone !== null && !isPlainObject(correction.tombstone)) {
    return problem('invalid-correction', 'correction.tombstone');
  }
  return null;
}

function checkProvenance(record, strict) {
  const provenance = record.provenance;
  if (!isPlainObject(provenance)) return problem('missing-provenance', 'provenance');
  if (!Array.isArray(provenance.refs) || provenance.refs.length === 0) {
    return problem('missing-provenance-refs', 'provenance.refs');
  }
  if (provenance.source !== undefined && !RECORD_SOURCES.includes(String(provenance.source))) {
    return problem('unknown-source', 'provenance.source');
  }
  if (!strict) return null;
  if (!RECORD_SOURCES.includes(String(provenance.source))) {
    return problem('unknown-source', 'provenance.source');
  }
  for (const ref of provenance.refs) {
    if (!isPlainObject(ref) || !RECORD_REF_KINDS.includes(String(ref.kind))) {
      return problem('invalid-ref', 'provenance.refs');
    }
  }
  return null;
}

function checkOptionalFields(record) {
  if (record.text !== undefined && typeof record.text !== 'string') return problem('invalid-text', 'text');
  if (record.reply !== undefined && record.reply !== null && typeof record.reply !== 'string') {
    return problem('invalid-text', 'reply');
  }
  if (record.layer !== undefined && !RECORD_LAYERS.includes(String(record.layer))) {
    return problem('unknown-layer', 'layer');
  }
  if (record.kind !== undefined && !RECORD_KINDS.includes(String(record.kind))) {
    return problem('unknown-kind', 'kind');
  }
  if (record.stability !== undefined && !RECORD_STABILITIES.includes(String(record.stability))) {
    return problem('invalid-stability', 'stability');
  }
  if (record.confidence !== undefined) {
    const confidence = Number(record.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return problem('invalid-confidence', 'confidence');
    }
  }
  if (record.scope !== undefined && record.scope !== null && !RECORD_SCOPES.includes(String(record.scope))) {
    return problem('invalid-scope', 'scope');
  }
  if (record.privacy !== undefined && record.privacy !== null) {
    if (!isPlainObject(record.privacy)) return problem('invalid-privacy', 'privacy');
    if (!RECORD_PRIVACY_LEVELS.includes(String(record.privacy.level))) {
      return problem('invalid-privacy', 'privacy.level');
    }
  }
  for (const field of ['observedAt', 'recordedAt']) {
    if (record[field] !== undefined && record[field] !== null && !isIsoTimestamp(record[field])) {
      return problem('invalid-timestamp', field);
    }
  }
  if (record.lastConfirmedAt !== undefined && record.lastConfirmedAt !== null && !isIsoTimestamp(record.lastConfirmedAt)) {
    return problem('invalid-timestamp', 'lastConfirmedAt');
  }
  if (record.quarantine !== undefined && record.quarantine !== null) {
    if (!isPlainObject(record.quarantine)) return problem('invalid-quarantine', 'quarantine');
    if (record.quarantine.rules !== undefined && !Array.isArray(record.quarantine.rules)) {
      return problem('invalid-quarantine', 'quarantine.rules');
    }
  }
  return null;
}

function checkCommon(record) {
  if (!isPlainObject(record)) return problem('invalid-record');
  if (!isNonEmptyString(record.id)) return problem('missing-id', 'id');
  const schema = checkSchemaVersion(record);
  if (schema) return schema;
  const correction = checkCorrection(record, false);
  if (correction) return correction;
  return checkProvenance(record, false);
}

/**
 * 写入/迁移边界：字段齐全 + 枚举合法 + 时间可解析。
 * @returns {{code:string, field:string|null}|null}
 */
export function validateRecordStrict(record) {
  const common = checkCommon(record);
  if (common) return common;
  if (!(record.subjectId === null || typeof record.subjectId === 'string')) {
    return problem('invalid-subject', 'subjectId');
  }
  if (!RECORD_LAYERS.includes(String(record.layer))) return problem('unknown-layer', 'layer');
  if (!RECORD_KINDS.includes(String(record.kind))) return problem('unknown-kind', 'kind');
  if (typeof record.text !== 'string') return problem('invalid-text', 'text');
  if (!isPlainObject(record.provenance)) return problem('missing-provenance', 'provenance');
  if (!RECORD_SOURCES.includes(String(record.provenance.source))) {
    return problem('unknown-source', 'provenance.source');
  }
  if (!isPlainObject(record.correction)) return problem('invalid-correction', 'correction');
  if (!RECORD_STABILITIES.includes(String(record.stability))) {
    return problem('invalid-stability', 'stability');
  }
  const confidence = Number(record.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return problem('invalid-confidence', 'confidence');
  }
  if (!isPlainObject(record.privacy)) return problem('invalid-privacy', 'privacy');
  if (!RECORD_PRIVACY_LEVELS.includes(String(record.privacy.level))) {
    return problem('invalid-privacy', 'privacy.level');
  }
  if (!isIsoTimestamp(record.observedAt)) return problem('invalid-timestamp', 'observedAt');
  if (!isIsoTimestamp(record.recordedAt)) return problem('invalid-timestamp', 'recordedAt');
  const provenance = checkProvenance(record, true);
  if (provenance) return provenance;
  return checkOptionalFields(record);
}

/**
 * 读取/检索来源边界：沿用历史结构校验，并拒绝已落盘的非法枚举/越界值；
 * 缺字段的历史记录保持宽容（fail-closed 只针对“写坏了”的字段）。
 * @returns {{code:string, field:string|null}|null}
 */
export function validateStoredRecord(record) {
  const common = checkCommon(record);
  if (common) return common;
  return checkOptionalFields(record);
}

/** 写入边界断言：非法直接抛 `RecordContractError`（不写半套数据）。 */
export function assertRecord(record, label) {
  const found = validateRecordStrict(record);
  if (!found) return record;
  throw new RecordContractError(
    found.code,
    found.field,
    'MemoryRecord 不符合契约：' + found.code + (found.field ? '（' + found.field + '）' : '')
      + (label ? ' [' + label + ']' : ''),
  );
}

/**
 * tombstone 校验。`strict=true` 用于写入边界（at/by/reason 类型必须正确），
 * 默认只要求 id（读取边界，兼容历史文件）。
 * @returns {{code:string, field:string|null}|null}
 */
export function validateTombstone(tombstone, { strict = false } = {}) {
  if (!isPlainObject(tombstone)) return problem('invalid-tombstone');
  if (!isNonEmptyString(tombstone.id)) return problem('missing-tombstone-id', 'id');
  if (!strict) return null;
  if (tombstone.at !== undefined && tombstone.at !== null && !isIsoTimestamp(tombstone.at)) {
    return problem('invalid-tombstone', 'at');
  }
  if (tombstone.by !== undefined && !['user', 'host', 'migration'].includes(String(tombstone.by))) {
    return problem('invalid-tombstone', 'by');
  }
  if (tombstone.reason !== undefined && typeof tombstone.reason !== 'string') {
    return problem('invalid-tombstone', 'reason');
  }
  return null;
}
