/**
 * 临时媒体存储与删除审计（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 只把调用方给的合成/临时字节写到显式临时目录（默认 os.tmpdir()），
 * 默认 1 小时过期；put/delete/purge 都留元数据审计，不记录内容。
 *
 * put 只接受格式校验后的 kind/mime；delete 的 reason 只接受白名单码，
 * 非法 ref/reason 在审计里统一记为 invalid，不原样保留外部字符串。
 *
 * 不是 D3 的真实音频生命周期：没有远端存储、加密、配额、用户级删除策略。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_AUDIO_BYTES, MEDIA_ERROR, validateMediaArtifact } from './contracts.js';

const REF_RE = /^media:\/\/([0-9a-f-]{36})$/;
const KIND_RE = /^[a-z][a-z0-9._-]{0,31}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

/** delete() 只接受这些审计原因码；其他值在审计里统一记为 invalid。 */
export const MEDIA_STORE_DELETE_REASONS = Object.freeze(['delete', 'expired', 'cleanup']);
const REASON_SET = new Set(MEDIA_STORE_DELETE_REASONS);

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = REF_RE.exec(ref.trim());
  return match ? match[1] : null;
}

function auditRef(ref) {
  const id = parseRef(ref);
  return id ? `media://${id}` : 'invalid';
}

function auditReason(reason) {
  return typeof reason === 'string' && REASON_SET.has(reason) ? reason : 'invalid';
}

function normalizeMime(mime) {
  if (mime === undefined || mime === null || (typeof mime === 'string' && !mime.trim())) {
    return 'application/octet-stream';
  }
  if (typeof mime !== 'string') return null;
  const value = mime.trim().toLowerCase();
  return MIME_RE.test(value) ? value : null;
}

/**
 * @param {{root?:string, now?:() => number, retentionMs?:number, maxBytes?:number, maxEntries?:number}} options
 */
export function createMediaStore({
  root,
  now = Date.now,
  retentionMs = DEFAULT_RETENTION_MS,
  maxBytes = MAX_AUDIO_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(retentionMs) || retentionMs <= 0) throw new TypeError('retentionMs must be a positive integer');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive integer');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError('maxEntries must be a positive integer');

  const resolvedRoot = root ? path.resolve(root) : fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-'));
  fs.mkdirSync(resolvedRoot, { recursive: true });

  const artifacts = new Map();
  const auditLog = [];

  function audit(entry) {
    const record = Object.freeze({ ...entry });
    auditLog.push(record);
    return record;
  }

  function put({ bytes, mime, kind = 'audio-input', ttlMs } = {}) {
    const buffer = toBuffer(bytes);
    if (!buffer || buffer.length === 0) {
      throw storeError(MEDIA_ERROR.INVALID_INPUT, 'bytes must be a non-empty Buffer or Uint8Array');
    }
    if (buffer.length > maxBytes) {
      throw storeError(MEDIA_ERROR.OVERSIZE, 'media exceeds the store size limit');
    }
    const kindValue = typeof kind === 'string' ? kind.trim() : '';
    if (!KIND_RE.test(kindValue)) {
      throw storeError(MEDIA_ERROR.INVALID_INPUT, 'kind must be a lowercase media kind identifier');
    }
    const mimeValue = normalizeMime(mime);
    if (!mimeValue) {
      throw storeError(MEDIA_ERROR.INVALID_INPUT, 'mime must be a simple media type');
    }
    if (artifacts.size >= maxEntries) {
      purgeExpired();
      if (artifacts.size >= maxEntries) {
        throw storeError(MEDIA_ERROR.STORE_FULL, 'media store is full');
      }
    }

    const id = crypto.randomUUID();
    const ref = `media://${id}`;
    const createdAt = now();
    const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : retentionMs;
    const expiresAt = createdAt + ttl;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = path.join(resolvedRoot, `${id}.bin`);
    const tempFile = `${file}.tmp`;

    try {
      fs.writeFileSync(tempFile, buffer, { mode: 0o600 });
      fs.renameSync(tempFile, file);
    } catch {
      try { fs.rmSync(tempFile, { force: true }); } catch { /* best effort */ }
      throw storeError(MEDIA_ERROR.STORE_FAILED, 'temporary media could not be written');
    }

    const artifact = Object.freeze({
      ref,
      kind: kindValue,
      mime: mimeValue,
      bytes: buffer.length,
      sha256,
      createdAt,
      expiresAt,
    });
    const checked = validateMediaArtifact(artifact);
    if (!checked.ok) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      throw storeError(MEDIA_ERROR.INVALID_INPUT, 'media artifact metadata is invalid');
    }

    artifacts.set(id, { artifact, file });
    audit({
      at: createdAt,
      action: 'put',
      ref,
      kind: artifact.kind,
      mime: artifact.mime,
      bytes: artifact.bytes,
      sha256,
      expiresAt,
    });
    return artifact;
  }

  function remove(ref, reason = 'delete') {
    const at = now();
    const id = parseRef(ref);
    const entry = id ? artifacts.get(id) : null;
    const safeReason = auditReason(reason);
    const safeRef = auditRef(ref);
    if (!entry) {
      const record = audit({
        at,
        action: 'delete',
        ref: safeRef,
        outcome: 'not-found',
        reason: safeReason,
      });
      return { ok: true, deleted: false, code: MEDIA_ERROR.NOT_FOUND, ref: safeRef, audit: record };
    }
    try {
      fs.rmSync(entry.file, { force: true });
    } catch {
      const record = audit({
        at,
        action: 'delete',
        ref: entry.artifact.ref,
        outcome: 'failed',
        reason: safeReason,
        kind: entry.artifact.kind,
        bytes: entry.artifact.bytes,
      });
      return { ok: false, deleted: false, code: MEDIA_ERROR.STORE_FAILED, ref: entry.artifact.ref, audit: record };
    }
    artifacts.delete(id);
    const record = audit({
      at,
      action: 'delete',
      ref: entry.artifact.ref,
      outcome: 'deleted',
      reason: safeReason,
      kind: entry.artifact.kind,
      mime: entry.artifact.mime,
      bytes: entry.artifact.bytes,
      sha256: entry.artifact.sha256,
    });
    return { ok: true, deleted: true, ref: entry.artifact.ref, audit: record };
  }

  function purgeExpired() {
    const at = now();
    const refs = [];
    for (const entry of artifacts.values()) {
      if (entry.artifact.expiresAt <= at) refs.push(entry.artifact.ref);
    }
    for (const ref of refs) remove(ref, 'expired');
    return { removed: refs.length, refs };
  }

  function list() {
    return [...artifacts.values()].map((entry) => entry.artifact);
  }

  function auditEntries() {
    return auditLog.slice();
  }

  function stats() {
    let bytes = 0;
    for (const entry of artifacts.values()) bytes += entry.artifact.bytes;
    return { entries: artifacts.size, bytes, maxEntries, maxBytes, retentionMs };
  }

  return Object.freeze({
    put,
    delete: remove,
    purgeExpired,
    list,
    audit: auditEntries,
    stats,
  });
}
