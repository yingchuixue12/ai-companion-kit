/**
 * 媒体管线（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 只做编排：校验 → 注入适配器（ASR/TTS）→ 超时 → 结构化失败 → 文字回退。
 * 不发网络、不 import 供应商 SDK、不写长期记忆（只通过注入的 memory port）。
 *
 * 图片/文件只读元数据并返回 supported:false / provider-required；
 * 不读取、不解析、不假装理解内容。
 */

import {
  DEFAULT_ASR_TIMEOUT_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_TTS_TIMEOUT_MS,
  MAX_MEDIA_TIMEOUT_MS,
  MAX_TTS_CHARS,
  MEDIA_ERROR,
  mimeForFormat,
  toStructuredError,
  validateAudioInput,
  validateTranscript,
  validateTtsRequest,
} from './contracts.js';

class MediaTimeoutError extends Error {
  constructor() {
    super('media adapter timed out');
    this.code = MEDIA_ERROR.TIMEOUT;
  }
}

function clampTimeout(value, fallback) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, MAX_MEDIA_TIMEOUT_MS);
}

function clampConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_MIN_CONFIDENCE;
}

function runWithTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MediaTimeoutError());
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout])
    .finally(() => clearTimeout(timer));
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return null;
}

function baseMetadata(input) {
  if (!input || typeof input !== 'object') return null;
  const metadata = {
    kind: typeof input.kind === 'string' ? input.kind : 'audio',
    mime: typeof input.mime === 'string' ? input.mime.toLowerCase() : null,
    size: Number.isInteger(input.size) ? input.size : null,
    ref: typeof input.ref === 'string' ? input.ref : null,
  };
  if (Number.isInteger(input.durationMs)) metadata.durationMs = input.durationMs;
  return metadata;
}

/**
 * 转写音频。低置信度不会写长期记忆，除非输入显式带 confirmed:true。
 *
 * @param {{
 *   asr: {transcribe: Function},
 *   store?: {put: Function, delete: Function},
 *   input: object,
 *   memory?: {remember: Function},
 *   minConfidence?: number,
 *   timeoutMs?: number,
 *   retainInput?: boolean,
 *   retentionMs?: number
 * }} params
 */
export async function ingestAudio({
  asr,
  store,
  input,
  memory,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  timeoutMs = DEFAULT_ASR_TIMEOUT_MS,
  retainInput = false,
  retentionMs,
} = {}) {
  const metadata = baseMetadata(input);
  const validation = validateAudioInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      transcript: null,
      metadata,
      error: toStructuredError(validation.errors),
      recovery: { action: 'text-fallback', retryable: false },
    };
  }
  const audio = validation.value;
  if (!asr || typeof asr.transcribe !== 'function') {
    return {
      ok: false,
      transcript: null,
      metadata,
      error: { code: MEDIA_ERROR.ADAPTER_MISSING, message: 'no ASR adapter is injected' },
      recovery: { action: 'text-fallback', retryable: false },
    };
  }

  const effectiveTimeout = clampTimeout(timeoutMs, DEFAULT_ASR_TIMEOUT_MS);
  let temporary = null;

  if (store && audio.bytes !== undefined) {
    try {
      const artifact = store.put({
        bytes: audio.bytes,
        mime: audio.mime,
        kind: 'audio-input',
        ttlMs: retentionMs,
      });
      if (!artifact || typeof artifact.ref !== 'string' || !artifact.ref) {
        throw Object.assign(new Error('invalid store artifact'), { code: MEDIA_ERROR.STORE_FAILED });
      }
      temporary = { ref: artifact.ref, retained: retainInput === true, deleted: false };
    } catch (error) {
      return {
        ok: false,
        transcript: null,
        metadata,
        error: {
          code: error?.code === MEDIA_ERROR.STORE_FULL ? MEDIA_ERROR.STORE_FULL : MEDIA_ERROR.STORE_FAILED,
          message: 'temporary audio could not be stored',
        },
        recovery: { action: 'text-fallback', retryable: false },
      };
    }
  }

  let transcript = null;
  try {
    const raw = await runWithTimeout(
      (signal) => asr.transcribe(audio, { signal, timeoutMs: effectiveTimeout }),
      effectiveTimeout,
    );
    const checked = validateTranscript(raw);
    if (!checked.ok) {
      const error = toStructuredError(checked.errors, MEDIA_ERROR.INVALID_TRANSCRIPT);
      error.message = 'speech recognition returned an invalid transcript';
      throw Object.assign(new Error(error.message), { code: error.code, structured: error });
    }
    transcript = checked.value;
  } catch (error) {
    const code = error?.code === MEDIA_ERROR.TIMEOUT || error?.name === 'AbortError'
      ? MEDIA_ERROR.TIMEOUT
      : (error?.code === MEDIA_ERROR.INVALID_TRANSCRIPT ? MEDIA_ERROR.INVALID_TRANSCRIPT : MEDIA_ERROR.ASR_FAILED);
    const messages = {
      [MEDIA_ERROR.TIMEOUT]: 'speech recognition timed out',
      [MEDIA_ERROR.INVALID_TRANSCRIPT]: 'speech recognition returned an invalid transcript',
      [MEDIA_ERROR.ASR_FAILED]: 'speech recognition failed',
    };
    return {
      ok: false,
      transcript: null,
      metadata,
      error: { code, message: messages[code] || messages[MEDIA_ERROR.ASR_FAILED] },
      recovery: { action: 'ask-repeat', retryable: code !== MEDIA_ERROR.INVALID_TRANSCRIPT },
    };
  } finally {
    if (temporary && !retainInput) {
      try {
        const deletion = store.delete(temporary.ref);
        temporary.deleted = deletion.deleted === true;
        temporary.audit = deletion.audit;
        if (!temporary.deleted) temporary.cleanupError = deletion.code || MEDIA_ERROR.STORE_FAILED;
      } catch {
        temporary.deleted = false;
        temporary.cleanupError = MEDIA_ERROR.STORE_FAILED;
      }
    }
    if (temporary && metadata) metadata.temporary = temporary;
  }

  const confidence = transcript.confidence;
  const confirmed = audio.confirmed === true;
  const eligible = confidence >= clampConfidence(minConfidence) || confirmed;
  const memoryState = { eligible, written: false, reason: null };
  if (!eligible) {
    memoryState.reason = 'low-confidence-needs-confirmation';
  } else if (!memory || typeof memory.remember !== 'function') {
    memoryState.reason = 'memory-port-missing';
  } else {
    try {
      await memory.remember({
        text: transcript.text,
        confidence,
        language: transcript.language,
        provider: transcript.provider,
        source: 'asr',
      });
      memoryState.written = true;
      memoryState.reason = 'written';
    } catch {
      memoryState.reason = 'memory-write-failed';
    }
  }

  return { ok: true, transcript, metadata, memory: memoryState };
}

/**
 * 渲染语音；任何失败都保留 fallbackText，不丢文字回复。
 *
 * @param {{
 *   tts: {synthesize: Function},
 *   humanizer?: Function|{humanize: Function},
 *   text: string,
 *   store?: {put: Function},
 *   voice?: string,
 *   format?: string,
 *   timeoutMs?: number,
 *   maxChars?: number
 * }} params
 */
export async function renderVoice({
  tts,
  humanizer,
  text,
  store,
  voice,
  format = 'ogg',
  timeoutMs = DEFAULT_TTS_TIMEOUT_MS,
  maxChars = MAX_TTS_CHARS,
} = {}) {
  let fallbackText = typeof text === 'string' ? text : '';
  const humanize = typeof humanizer === 'function'
    ? humanizer
    : (typeof humanizer?.humanize === 'function' ? (value) => humanizer.humanize(value) : null);
  if (humanize && fallbackText.trim()) {
    try {
      const humanized = humanize(fallbackText);
      if (typeof humanized === 'string' && humanized.trim()) fallbackText = humanized;
    } catch {
      // 拟人化失败不阻塞文字回退，保留原文。
    }
  }

  if (!fallbackText.trim()) {
    return {
      ok: false,
      fallbackText,
      audioRef: null,
      error: { code: MEDIA_ERROR.INVALID_INPUT, message: 'text is required' },
    };
  }

  const request = validateTtsRequest({ text: fallbackText, voice, format }, { maxChars });
  if (!request.ok) {
    return {
      ok: false,
      fallbackText,
      audioRef: null,
      error: toStructuredError(request.errors),
    };
  }
  if (!tts || typeof tts.synthesize !== 'function') {
    return {
      ok: false,
      fallbackText,
      audioRef: null,
      error: { code: MEDIA_ERROR.ADAPTER_MISSING, message: 'no TTS adapter is injected' },
    };
  }

  const effectiveTimeout = clampTimeout(timeoutMs, DEFAULT_TTS_TIMEOUT_MS);
  let output;
  try {
    output = await runWithTimeout(
      (signal) => tts.synthesize(request.value, { signal, timeoutMs: effectiveTimeout }),
      effectiveTimeout,
    );
  } catch (error) {
    const code = error?.code === MEDIA_ERROR.TIMEOUT || error?.name === 'AbortError'
      ? MEDIA_ERROR.TIMEOUT
      : MEDIA_ERROR.TTS_FAILED;
    return {
      ok: false,
      fallbackText,
      audioRef: null,
      error: {
        code,
        message: code === MEDIA_ERROR.TIMEOUT ? 'voice rendering timed out' : 'voice rendering failed',
      },
    };
  }

  const audioRef = typeof output?.audioRef === 'string' && output.audioRef.trim()
    ? output.audioRef.trim()
    : (typeof output?.ref === 'string' && output.ref.trim() ? output.ref.trim() : '');
  if (!audioRef) {
    return {
      ok: false,
      fallbackText,
      audioRef: null,
      error: { code: MEDIA_ERROR.TTS_FAILED, message: 'tts adapter returned no audio reference' },
    };
  }

  let mime = typeof output?.mime === 'string' && output.mime.trim()
    ? output.mime.trim()
    : mimeForFormat(request.value.format);
  if (!mime) mime = 'application/octet-stream';

  let artifact = null;
  if (store && output?.bytes !== undefined) {
    const buffer = Buffer.isBuffer(output.bytes)
      ? output.bytes
      : (ArrayBuffer.isView(output.bytes) ? Buffer.from(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength) : null);
    if (!buffer) {
      return {
        ok: false,
        fallbackText,
        audioRef,
        error: { code: MEDIA_ERROR.TTS_FAILED, message: 'tts adapter returned invalid bytes' },
      };
    }
    try {
      artifact = store.put({ bytes: buffer, mime, kind: 'tts-audio' });
      if (!artifact || typeof artifact.ref !== 'string' || !artifact.ref) {
        throw Object.assign(new Error('invalid store artifact'), { code: MEDIA_ERROR.STORE_FAILED });
      }
    } catch (error) {
      return {
        ok: false,
        fallbackText,
        audioRef,
        error: {
          code: error?.code === MEDIA_ERROR.STORE_FULL ? MEDIA_ERROR.STORE_FULL : MEDIA_ERROR.STORE_FAILED,
          message: 'synthesized audio could not be stored',
        },
      };
    }
  }

  return { ok: true, fallbackText, audioRef, mime, artifact };
}

/**
 * 图片/文件只返回元数据与 provider-required，不解析内容。
 * @param {{kind?:string, mime?:string, size?:number, ref?:string, bytes?:Buffer}} input
 */
export function readAttachmentMetadata(input = {}) {
  if (!input || typeof input !== 'object') {
    return {
      kind: 'unknown',
      mime: null,
      size: null,
      ref: null,
      supported: false,
      reason: 'unsupported-kind',
      capabilities: { vision: false, contentParsing: false },
      providerRequired: null,
    };
  }
  const rawKind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  const mime = typeof input.mime === 'string' && input.mime.trim()
    ? input.mime.trim().toLowerCase()
    : null;
  let kind = 'unknown';
  if (rawKind === 'image' || rawKind === 'file') kind = rawKind;
  else if (rawKind === 'audio') kind = 'audio';
  else if (mime?.startsWith('image/')) kind = 'image';
  else if (mime?.startsWith('audio/')) kind = 'audio';

  const size = Number.isInteger(input.size) && input.size >= 0
    ? input.size
    : byteLength(input.bytes);
  const ref = typeof input.ref === 'string' && input.ref.trim() && input.ref.length <= 512
    ? input.ref.trim()
    : null;

  if (kind === 'audio') {
    return {
      kind,
      mime,
      size,
      ref,
      supported: false,
      reason: 'use-audio-pipeline',
      capabilities: { vision: false, contentParsing: false },
      providerRequired: null,
    };
  }
  if (kind !== 'image' && kind !== 'file') {
    return {
      kind: 'unknown',
      mime,
      size,
      ref,
      supported: false,
      reason: 'unsupported-kind',
      capabilities: { vision: false, contentParsing: false },
      providerRequired: null,
    };
  }
  return {
    kind,
    mime,
    size,
    ref,
    supported: false,
    reason: 'provider-required',
    capabilities: { vision: false, contentParsing: false },
    providerRequired: {
      capability: kind === 'image' ? 'image-input' : 'file-input',
      reason: 'provider-required',
      requiresUserDecision: 'U2',
    },
  };
}
