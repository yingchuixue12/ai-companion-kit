/**
 * 宿主附件元数据入口（D-05 · 默认关闭）
 * ─────────────────────────────────────────────────────────────
 * 只给可编程宿主一个明确、可验证的公开边界：拿图片/文件元数据，
 * 返回 `supported:false` / `provider-required`。不解析、不读取内容、
 * 不 fetch、不进聊天、不写记忆。
 *
 * 安全口径：
 *   - 只读取 `kind` / `mime` / `size`（以及确实缺 `size` 时的 bytes 长度），
 *     标题、路径、URL、账号、正文等字段一律不读、不回显；
 *   - 复用 `pipeline.js#readAttachmentMetadata` 的 kind/mime 白名单与
 *     providerRequired 结构，但把 `ref` 固定为 null，避免把路径/URL 带出去；
 *   - 只返回纯内存数据；没有 fs/网络/模型/记忆依赖，也没有副作用。
 *
 * 默认关闭只描述“内容理解能力”：即使宿主没有显式 enabled，本入口也只会
 * 安全地识别元数据并声明 provider-required，绝不会因此声称能看图或读文件。
 */

import { readAttachmentMetadata } from './pipeline.js';

export const ATTACHMENT_HOST_VERSION = 1;

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const SAFE_KINDS = new Set(['image', 'file', 'audio']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只接受 `type/subtype`；分号参数（可能夹带文件名/path）被丢掉。 */
function normalizeMime(value) {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(';', 1)[0].trim();
  return MIME_PATTERN.test(base) ? base : null;
}

/** 显式 kind 优先；否则仅从 mime 推断 image/audio，不把任意文件猜成 file。 */
function normalizeKind(input, mime) {
  const raw = typeof input?.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (SAFE_KINDS.has(raw)) return raw;
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'unknown';
}

/** 只取长度；不复制、不解析 bytes，也不把它交给下游。 */
function normalizeSize(input) {
  if (!isPlainObject(input)) return null;
  const declared = input.size;
  if (Number.isInteger(declared) && declared >= 0) return declared;
  try {
    const bytes = input.bytes;
    if (Buffer.isBuffer(bytes)) return bytes.length;
    if (ArrayBuffer.isView(bytes)) return bytes.byteLength;
    if (bytes instanceof ArrayBuffer) return bytes.byteLength;
  } catch {
    // 读不到长度就保持 null；不为了元数据去碰内容。
  }
  return null;
}

/**
 * 只读、无副作用的附件元数据入口。
 *
 * @param {unknown} input 宿主提供的附件描述；多余字段不会被读取
 * @returns {Readonly<{
 *   kind: string,
 *   mime: string|null,
 *   size: number|null,
 *   ref: null,
 *   supported: false,
 *   reason: string,
 *   capabilities: {vision:false, contentParsing:false},
 *   providerRequired: null|{capability:string, reason:string, requiresUserDecision:string}
 * }>}
 */
export function inspectAttachmentMetadata(input) {
  // 先窄化再交给既有 helper：ref/标题/路径/URL/账号/正文都不会进入结果。
  const mime = normalizeMime(input?.mime);
  const kind = normalizeKind(input, mime);
  const size = normalizeSize(input);
  const safeInput = { kind, mime, size };

  const result = readAttachmentMetadata(safeInput);
  const capabilities = Object.freeze({ vision: false, contentParsing: false });
  const providerRequired = result.providerRequired
    ? Object.freeze({
      capability: result.providerRequired.capability,
      reason: result.providerRequired.reason,
      requiresUserDecision: result.providerRequired.requiresUserDecision,
    })
    : null;

  return Object.freeze({
    kind: result.kind,
    mime: result.mime,
    size: result.size,
    ref: null,
    supported: false,
    reason: result.reason,
    capabilities,
    providerRequired,
  });
}

/**
 * 建一个默认关闭的附件宿主入口。`enabled` 只用于宿主自述；元数据识别
 * 本身永远安全，因此关闭时也不会解析内容或变成“能看图”。
 *
 * @param {{enabled?: boolean}} [options]
 */
export function createAttachmentHost({ enabled = false } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');

  const inspect = (input) => inspectAttachmentMetadata(input);
  return Object.freeze({
    kind: 'attachment-host',
    version: ATTACHMENT_HOST_VERSION,
    enabled,
    inspect,
    readMetadata: inspect,
    status: () => Object.freeze({
      kind: 'attachment-host',
      version: ATTACHMENT_HOST_VERSION,
      enabled,
      providerRequired: true,
      parsesContent: false,
      fetches: false,
      readsFiles: false,
      writesMemory: false,
      entersChat: false,
    }),
  });
}

export default createAttachmentHost;