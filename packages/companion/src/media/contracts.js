/**
 * 供应商中立媒体契约（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 只定义数据结构、校验和错误码；不 import 任何供应商 SDK、不发网络、
 * 不写真实音频到仓库、不解析图片/文件内容。
 *
 * 真实 ASR/TTS/vision 适配器需要 U1/U2 确认后再另开任务；本文件不声称
 * 已具备语音或识图能力。
 */

export const MEDIA_CONTRACT_VERSION = 1;

/** 允许进入 ASR 管线的音频 MIME（白名单，大小写不敏感）。 */
export const AUDIO_MIME_TYPES = Object.freeze([
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
]);

/** TTS 输出格式白名单。 */
export const TTS_FORMATS = Object.freeze(['ogg', 'opus', 'wav', 'mp3']);

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 5 * 60 * 1000;
export const MAX_TRANSCRIPT_CHARS = 4000;
export const MAX_TTS_CHARS = 2000;
export const MAX_REF_CHARS = 512;

export const DEFAULT_ASR_TIMEOUT_MS = 15000;
export const DEFAULT_TTS_TIMEOUT_MS = 20000;
export const MAX_MEDIA_TIMEOUT_MS = 60000;
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** 结构化失败码。调用方按 code 分支，不解析自然语言。 */
export const MEDIA_ERROR = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  UNSUPPORTED_KIND: 'unsupported-kind',
  UNSUPPORTED_MIME: 'unsupported-mime',
  INVALID_SIZE: 'invalid-size',
  OVERSIZE: 'oversize',
  INVALID_DURATION: 'invalid-duration',
  TOO_LONG: 'too-long',
  INVALID_REF: 'invalid-ref',
  SIZE_MISMATCH: 'size-mismatch',
  INVALID_TRANSCRIPT: 'invalid-transcript',
  INVALID_CONFIDENCE: 'invalid-confidence',
  ADAPTER_MISSING: 'adapter-missing',
  PROVIDER_REQUIRED: 'provider-required',
  TIMEOUT: 'timeout',
  ASR_FAILED: 'asr-failed',
  TTS_FAILED: 'tts-failed',
  STORE_FAILED: 'store-failed',
  STORE_FULL: 'store-full',
  NOT_FOUND: 'not-found',
});

const AUDIO_MIME_SET = new Set(AUDIO_MIME_TYPES);
const TTS_FORMAT_SET = new Set(TTS_FORMATS);
const SHA256_RE = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return null;
}

function fail(field, code, message) {
  return { field, code, message };
}

function lowerString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export const AUDIO_INPUT_SCHEMA = deepFreeze({
  title: 'AudioInput',
  type: 'object',
  required: ['mime', 'size', 'ref'],
  properties: {
    kind: { const: 'audio' },
    mime: { type: 'string', enum: AUDIO_MIME_TYPES },
    size: { type: 'integer', minimum: 1, maximum: MAX_AUDIO_BYTES },
    durationMs: { type: 'integer', minimum: 1, maximum: MAX_AUDIO_DURATION_MS },
    ref: { type: 'string', minLength: 1, maxLength: MAX_REF_CHARS },
    confirmed: { type: 'boolean' },
  },
  additionalProperties: false,
});

export const TRANSCRIPT_SCHEMA = deepFreeze({
  title: 'Transcript',
  type: 'object',
  required: ['text', 'confidence'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_TRANSCRIPT_CHARS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    language: { type: 'string', minLength: 1, maxLength: 16 },
    provider: { type: 'string', minLength: 1, maxLength: 64 },
    durationMs: { type: 'integer', minimum: 0, maximum: MAX_AUDIO_DURATION_MS },
  },
  additionalProperties: false,
});

export const TTS_REQUEST_SCHEMA = deepFreeze({
  title: 'TtsRequest',
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_TTS_CHARS },
    voice: { type: 'string', minLength: 1, maxLength: 64 },
    format: { type: 'string', enum: TTS_FORMATS },
  },
  additionalProperties: false,
});

export const MEDIA_ARTIFACT_SCHEMA = deepFreeze({
  title: 'MediaArtifact',
  type: 'object',
  required: ['ref', 'kind', 'mime', 'bytes', 'sha256'],
  properties: {
    ref: { type: 'string', minLength: 1, maxLength: MAX_REF_CHARS },
    kind: { type: 'string', minLength: 1, maxLength: 32 },
    mime: { type: 'string', minLength: 1, maxLength: 128 },
    bytes: { type: 'integer', minimum: 0, maximum: MAX_AUDIO_BYTES },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    createdAt: { type: 'number', minimum: 0 },
    expiresAt: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
});

/**
 * 校验音频输入；不修改入参，不读取 bytes 内容。
 * @returns {{ok:true, value:object}|{ok:false, errors:Array<{field:string,code:string,message:string}>}}
 */
export function validateAudioInput(input, options = {}) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [fail('input', MEDIA_ERROR.INVALID_INPUT, 'audio input must be a plain object')] };
  }
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : MAX_AUDIO_BYTES;
  const maxDurationMs = Number.isInteger(options.maxDurationMs) ? options.maxDurationMs : MAX_AUDIO_DURATION_MS;
  const errors = [];

  const kind = input.kind === undefined ? 'audio' : input.kind;
  if (kind !== 'audio') {
    errors.push(fail(
      'kind',
      kind === 'image' || kind === 'file' ? MEDIA_ERROR.UNSUPPORTED_KIND : MEDIA_ERROR.INVALID_INPUT,
      'ingestAudio only accepts audio input',
    ));
  }

  const mime = lowerString(input.mime);
  if (!mime || !AUDIO_MIME_SET.has(mime)) {
    errors.push(fail('mime', MEDIA_ERROR.UNSUPPORTED_MIME, 'audio mime type is not in the allowlist'));
  }

  const size = input.size;
  if (!Number.isInteger(size) || size < 1) {
    errors.push(fail('size', MEDIA_ERROR.INVALID_SIZE, 'size must be a positive integer'));
  } else if (size > maxBytes) {
    errors.push(fail('size', MEDIA_ERROR.OVERSIZE, 'audio exceeds the size limit'));
  }

  if (input.durationMs !== undefined) {
    if (!Number.isInteger(input.durationMs) || input.durationMs < 1) {
      errors.push(fail('durationMs', MEDIA_ERROR.INVALID_DURATION, 'durationMs must be a positive integer'));
    } else if (input.durationMs > maxDurationMs) {
      errors.push(fail('durationMs', MEDIA_ERROR.TOO_LONG, 'audio exceeds the duration limit'));
    }
  }

  const ref = typeof input.ref === 'string' ? input.ref.trim() : '';
  if (!ref || ref.length > MAX_REF_CHARS) {
    errors.push(fail('ref', MEDIA_ERROR.INVALID_REF, 'ref must be a non-empty string'));
  }

  if (input.bytes !== undefined) {
    const length = byteLength(input.bytes);
    if (length === null) {
      errors.push(fail('bytes', MEDIA_ERROR.INVALID_INPUT, 'bytes must be a Buffer, Uint8Array or ArrayBuffer'));
    } else if (Number.isInteger(size) && length !== size) {
      errors.push(fail('bytes', MEDIA_ERROR.SIZE_MISMATCH, 'size does not match bytes length'));
    }
  }

  if (errors.length) return { ok: false, errors };

  const value = { kind: 'audio', mime, size, ref };
  if (input.durationMs !== undefined) value.durationMs = input.durationMs;
  if (input.bytes !== undefined) value.bytes = input.bytes;
  if (input.confirmed === true) value.confirmed = true;
  return { ok: true, value };
}

/** 校验 ASR 输出；不修改入参。 */
export function validateTranscript(transcript) {
  if (!isPlainObject(transcript)) {
    return { ok: false, errors: [fail('input', MEDIA_ERROR.INVALID_TRANSCRIPT, 'transcript must be a plain object')] };
  }
  const errors = [];
  const text = typeof transcript.text === 'string' ? transcript.text : '';
  if (!text.trim()) {
    errors.push(fail('text', MEDIA_ERROR.INVALID_TRANSCRIPT, 'transcript text must not be empty'));
  } else if (text.length > MAX_TRANSCRIPT_CHARS) {
    errors.push(fail('text', MEDIA_ERROR.TOO_LONG, 'transcript text exceeds the limit'));
  }
  const confidence = transcript.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push(fail('confidence', MEDIA_ERROR.INVALID_CONFIDENCE, 'confidence must be a number between 0 and 1'));
  }
  if (transcript.language !== undefined) {
    if (typeof transcript.language !== 'string' || !transcript.language.trim() || transcript.language.length > 16) {
      errors.push(fail('language', MEDIA_ERROR.INVALID_TRANSCRIPT, 'language must be a short string'));
    }
  }
  if (transcript.provider !== undefined) {
    if (typeof transcript.provider !== 'string' || !transcript.provider.trim() || transcript.provider.length > 64) {
      errors.push(fail('provider', MEDIA_ERROR.INVALID_TRANSCRIPT, 'provider must be a short string'));
    }
  }
  if (transcript.durationMs !== undefined) {
    if (!Number.isInteger(transcript.durationMs) || transcript.durationMs < 0 || transcript.durationMs > MAX_AUDIO_DURATION_MS) {
      errors.push(fail('durationMs', MEDIA_ERROR.INVALID_TRANSCRIPT, 'durationMs must be a non-negative integer'));
    }
  }
  if (errors.length) return { ok: false, errors };
  const value = {
    text,
    confidence,
    language: typeof transcript.language === 'string' ? transcript.language.trim() : 'und',
    provider: typeof transcript.provider === 'string' ? transcript.provider.trim() : 'unknown',
  };
  if (transcript.durationMs !== undefined) value.durationMs = transcript.durationMs;
  return { ok: true, value };
}

/** 校验 TTS 请求；不修改入参。 */
export function validateTtsRequest(request, options = {}) {
  if (!isPlainObject(request)) {
    return { ok: false, errors: [fail('input', MEDIA_ERROR.INVALID_INPUT, 'tts request must be a plain object')] };
  }
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : MAX_TTS_CHARS;
  const errors = [];
  const text = typeof request.text === 'string' ? request.text : '';
  if (!text.trim()) {
    errors.push(fail('text', MEDIA_ERROR.INVALID_INPUT, 'tts text must not be empty'));
  } else if (text.length > maxChars) {
    errors.push(fail('text', MEDIA_ERROR.TOO_LONG, 'tts text exceeds the limit'));
  }
  if (request.voice !== undefined) {
    if (typeof request.voice !== 'string' || !request.voice.trim() || request.voice.length > 64) {
      errors.push(fail('voice', MEDIA_ERROR.INVALID_INPUT, 'voice must be a short string'));
    }
  }
  const format = request.format === undefined ? 'ogg' : lowerString(request.format);
  if (!TTS_FORMAT_SET.has(format)) {
    errors.push(fail('format', MEDIA_ERROR.INVALID_INPUT, 'tts format is not in the allowlist'));
  }
  if (errors.length) return { ok: false, errors };
  const value = { text, format };
  if (typeof request.voice === 'string' && request.voice.trim()) value.voice = request.voice.trim();
  return { ok: true, value };
}

/** 校验媒体 artifact 元数据；不读取文件内容。 */
export function validateMediaArtifact(artifact) {
  if (!isPlainObject(artifact)) {
    return { ok: false, errors: [fail('input', MEDIA_ERROR.INVALID_INPUT, 'artifact must be a plain object')] };
  }
  const errors = [];
  if (typeof artifact.ref !== 'string' || !artifact.ref.trim() || artifact.ref.length > MAX_REF_CHARS) {
    errors.push(fail('ref', MEDIA_ERROR.INVALID_REF, 'artifact ref is invalid'));
  }
  if (typeof artifact.kind !== 'string' || !artifact.kind.trim() || artifact.kind.length > 32) {
    errors.push(fail('kind', MEDIA_ERROR.INVALID_INPUT, 'artifact kind is invalid'));
  }
  if (typeof artifact.mime !== 'string' || !artifact.mime.trim() || artifact.mime.length > 128) {
    errors.push(fail('mime', MEDIA_ERROR.UNSUPPORTED_MIME, 'artifact mime is invalid'));
  }
  if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
    errors.push(fail('bytes', MEDIA_ERROR.INVALID_SIZE, 'artifact bytes must be a non-negative integer'));
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
    errors.push(fail('sha256', MEDIA_ERROR.INVALID_INPUT, 'artifact sha256 must be lowercase hex'));
  }
  if (artifact.createdAt !== undefined && (typeof artifact.createdAt !== 'number' || artifact.createdAt < 0)) {
    errors.push(fail('createdAt', MEDIA_ERROR.INVALID_INPUT, 'createdAt must be a non-negative number'));
  }
  if (artifact.expiresAt !== undefined && (typeof artifact.expiresAt !== 'number' || artifact.expiresAt < 0)) {
    errors.push(fail('expiresAt', MEDIA_ERROR.INVALID_INPUT, 'expiresAt must be a non-negative number'));
  }
  if (errors.length) return { ok: false, errors };
  const value = {
    ref: artifact.ref.trim(),
    kind: artifact.kind.trim(),
    mime: artifact.mime.trim(),
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
  if (artifact.createdAt !== undefined) value.createdAt = artifact.createdAt;
  if (artifact.expiresAt !== undefined) value.expiresAt = artifact.expiresAt;
  return { ok: true, value };
}

/** TTS 格式 → MIME；未知格式返回 null。 */
export function mimeForFormat(format) {
  switch (lowerString(format)) {
    case 'ogg': return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mpeg';
    default: return null;
  }
}

/** 把校验错误折叠成管线使用的结构化错误；只保留第一个错误码。 */
export function toStructuredError(errors, fallbackCode = MEDIA_ERROR.INVALID_INPUT) {
  const first = Array.isArray(errors) && errors.length ? errors[0] : null;
  return {
    code: first?.code || fallbackCode,
    message: first?.message || 'media request is invalid',
  };
}
