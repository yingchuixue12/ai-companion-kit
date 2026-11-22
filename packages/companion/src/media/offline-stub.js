/**
 * 离线 ASR/TTS 桩（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 仅用于契约与失败回退的离线验证：不访问网络、不调用供应商、不产生真实语音。
 * 返回的 bytes 是可识别的合成标记，不是音频。
 */

import { MEDIA_ERROR, mimeForFormat } from './contracts.js';

const ASR_PROVIDER = 'offline-asr-stub';
const TTS_PROVIDER = 'offline-tts-stub';

function stubError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function normalizeFailure(failWith, fallbackCode, fallbackMessage) {
  if (failWith === true || failWith === undefined) return stubError(fallbackCode, fallbackMessage);
  if (failWith === 'timeout') return stubError(MEDIA_ERROR.TIMEOUT, 'offline stub timed out');
  if (typeof failWith === 'string') return stubError(fallbackCode, failWith);
  if (failWith instanceof Error) {
    const error = stubError(failWith.code || fallbackCode, fallbackMessage);
    error.cause = failWith;
    return error;
  }
  if (failWith && typeof failWith === 'object') {
    const code = failWith.code === MEDIA_ERROR.TIMEOUT ? MEDIA_ERROR.TIMEOUT : (failWith.code || fallbackCode);
    return stubError(code, fallbackMessage);
  }
  return stubError(fallbackCode, fallbackMessage);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(stubError(MEDIA_ERROR.TIMEOUT, 'offline stub aborted'));
      return;
    }
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      reject(stubError(MEDIA_ERROR.TIMEOUT, 'offline stub aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * @param {{transcripts?: Array<string|{text:string,confidence?:number,language?:string,provider?:string}>, delayMs?:number, failWith?:boolean|string|object}} options
 */
export function createOfflineAsrStub({ transcripts = [], delayMs = 0, failWith = null } = {}) {
  if (!Array.isArray(transcripts)) throw new TypeError('transcripts must be an array');
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new TypeError('delayMs must be a non-negative integer');
  const queue = transcripts.map((item, index) => {
    if (typeof item === 'string') {
      return { text: item, confidence: 0.9, language: 'und', provider: ASR_PROVIDER };
    }
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') {
      throw new TypeError(`transcripts[${index}] must be a string or { text }`);
    }
    return {
      text: item.text,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.9,
      language: typeof item.language === 'string' ? item.language : 'und',
      provider: typeof item.provider === 'string' ? item.provider : ASR_PROVIDER,
    };
  });
  let cursor = 0;

  return Object.freeze({
    kind: 'asr',
    provider: ASR_PROVIDER,
    offline: true,
    describe() {
      return { kind: 'asr', provider: ASR_PROVIDER, offline: true, queued: queue.length };
    },
    async transcribe(input, options = {}) {
      if (failWith) throw normalizeFailure(failWith, MEDIA_ERROR.ASR_FAILED, 'offline ASR stub failed');
      if (!input || typeof input.ref !== 'string' || !input.ref.trim()) {
        throw stubError(MEDIA_ERROR.INVALID_INPUT, 'audio ref is required');
      }
      if (delayMs > 0) await delay(delayMs, options.signal);
      if (cursor >= queue.length) {
        throw stubError(MEDIA_ERROR.ASR_FAILED, 'offline ASR stub queue is empty');
      }
      return { ...queue[cursor++] };
    },
  });
}

/**
 * @param {{audioRef?:string, format?:string, delayMs?:number, failWith?:boolean|string|object, bytes?:Buffer|Uint8Array}} options
 */
export function createOfflineTtsStub({
  audioRef = 'stub://audio',
  format = 'ogg',
  delayMs = 0,
  failWith = null,
  bytes = null,
} = {}) {
  if (typeof audioRef !== 'string' || !audioRef.trim()) throw new TypeError('audioRef must be a non-empty string');
  if (!mimeForFormat(format)) throw new TypeError('format must be one of ogg/opus/wav/mp3');
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new TypeError('delayMs must be a non-negative integer');
  const synthetic = bytes === null
    ? Buffer.from(`offline-tts:${format}`, 'utf8')
    : toBuffer(bytes);
  if (!synthetic) throw new TypeError('bytes must be a Buffer or Uint8Array');

  return Object.freeze({
    kind: 'tts',
    provider: TTS_PROVIDER,
    offline: true,
    describe() {
      return { kind: 'tts', provider: TTS_PROVIDER, offline: true, format };
    },
    async synthesize(request, options = {}) {
      if (failWith) throw normalizeFailure(failWith, MEDIA_ERROR.TTS_FAILED, 'offline TTS stub failed');
      if (!request || typeof request.text !== 'string' || !request.text.trim()) {
        throw stubError(MEDIA_ERROR.INVALID_INPUT, 'tts text is required');
      }
      if (delayMs > 0) await delay(delayMs, options.signal);
      return {
        audioRef: audioRef.trim(),
        mime: mimeForFormat(request.format || format) || 'audio/ogg',
        bytes: Buffer.from(synthetic),
        durationMs: Math.max(1, request.text.length * 100),
      };
    },
  });
}
