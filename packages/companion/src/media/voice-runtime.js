/**
 * 语音运行入口（SOP06 候选 / D0）
 * ─────────────────────────────────────────────────────────────
 * 给「可编程宿主」用的一个显式入口：宿主自己决定要不要启用语音，并注入
 * ASR/TTS 适配器；本模块只做编排，不安装供应商、不发网络、不发送消息。
 *
 * 四条硬规则（与 docs/flandre-decisions.md 的 A6 / D0 一致）：
 *   1. 默认关闭：`enabled` 必须是布尔 true；关闭时 ingest/speak 都不碰适配器、
 *      不建临时目录，只把文字原样退回。
 *   2. ASR 低置信度不直接进聊天、也不写长期记忆：先挂成待确认，宿主问过用户
 *      再 confirm(id)。用户否认就 reject(id) 回退文字。不存在「入参自带
 *      confirmed 就放行」这种可绕过前置确认的口子。
 *   3. TTS 失败保留文字：speak() 永远带回 fallbackText、prepared 退成 'text'。
 *   4. 只准备、不投递：speak() 只把音频准备好交给宿主，本入口不调用任何平台。
 *
 * 关闭契约（dispose 是 async 的）：
 *   - dispose() 一被调用就同步拒绝新操作（code: voice-closed），
 *   - 然后等在途操作归零（延迟 ASR/TTS 会让它等），再清理临时音频与待确认条目，
 *   - 在途操作如果察觉到已关闭，不会新增待确认、不会写记忆、不会把刚生成的
 *     TTS 文件登记成自己的（直接删掉），因此关闭后不会再有文件或记忆落出来。
 *
 * 临时文件归属（store 只有两种，不混）：
 *   - 宿主注入 store：宿主拥有它；本入口只删除自己创建过的 ref，
 *     purgeExpired() 也只清自己的条目，绝不替宿主清理别人的文件；
 *   - 宿主没注入：本入口在系统临时目录下自建 store（root 见 status()），
 *     dispose() 会先删自己的 ref，再删这个目录。
 *   输入音频是「转写期」临时文件：转写结束（成功或失败）就被 pipeline 删掉，
 *   本模块不提供 retainInput，默认不留下用户语音。
 *   TTS 音频是「投递期」临时文件：ref 交给宿主去发送，宿主发完调 release()，
 *   或者 dispose() 时统一清理；本模块不会在 speak() 返回前删它。
 *
 * 不是 D1–D3：没有真实供应商、没有留存策略、没有质量评估。离线桩只用于契约验证。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  DEFAULT_ASR_TIMEOUT_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_TTS_TIMEOUT_MS,
  MEDIA_CONTRACT_VERSION,
  MEDIA_ERROR,
} from './contracts.js';
import { probeMediaCapabilities } from './capabilities.js';
import { ingestAudio, renderVoice } from './pipeline.js';
import { createMediaStore } from './store.js';

export const VOICE_RUNTIME_VERSION = 2;

/** 待确认条目的默认寿命：过了就作废，不会自己变成聊天输入。 */
export const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000;
/** 同时挂起的待确认条目上限；超过了就回退文字，不排队攒用户语音。 */
export const DEFAULT_MAX_PENDING = 8;

/** 一次语音输入的去向：进聊天 / 等确认 / 回退文字 / 请用户重说。 */
export const VOICE_DECISION = Object.freeze({
  CHAT: 'chat',
  CONFIRM: 'needs-confirmation',
  TEXT: 'text-fallback',
  REPEAT: 'ask-repeat',
});

/** 运行入口自己的结构化失败码（媒体契约之外的编排层状态）。 */
export const VOICE_RUNTIME_ERROR = Object.freeze({
  DISABLED: 'voice-disabled',
  CLOSED: 'voice-closed',
  PENDING_FULL: 'pending-full',
  CONFIRM_EXPIRED: 'confirm-expired',
  CONFIRM_NOT_FOUND: 'confirm-not-found',
  INVALID_ID: 'invalid-id',
  NOT_OWNED: 'not-owned',
});

function assertBoolean(name, value) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function assertConfidence(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a number between 0 and 1`);
  }
}

function normalizeId(id) {
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * 建一个语音运行入口。默认 enabled=false，也就是「装好了也不出声」。
 *
 * 长期记忆只通过注入的 memory 端口写，且只写 confirm() 过的转写；
 * 入参上的 confirmed 字段一律不采纳（见文件头规则 2）。
 *
 * @param {{
 *   enabled?: boolean,
 *   asr?: {transcribe: Function}|null,
 *   tts?: {synthesize: Function}|null,
 *   store?: {put: Function, delete: Function}|null,
 *   memory?: {remember: Function}|null,
 *   minConfidence?: number,
 *   asrTimeoutMs?: number,
 *   ttsTimeoutMs?: number,
 *   confirmTtlMs?: number,
 *   maxPending?: number,
 *   now?: () => number
 * }} options
 */
export function createVoiceRuntime({
  enabled = false,
  asr = null,
  tts = null,
  store = null,
  memory = null,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  asrTimeoutMs = DEFAULT_ASR_TIMEOUT_MS,
  ttsTimeoutMs = DEFAULT_TTS_TIMEOUT_MS,
  confirmTtlMs = DEFAULT_CONFIRM_TTL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  now = Date.now,
} = {}) {
  // enabled 只认布尔 true：配置里写 "true" / 1 一律当配置错误，不猜宿主意图。
  assertBoolean('enabled', enabled);
  assertConfidence('minConfidence', minConfidence);
  assertPositiveInteger('confirmTtlMs', confirmTtlMs);
  assertPositiveInteger('maxPending', maxPending);
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (store && (typeof store.put !== 'function' || typeof store.delete !== 'function')) {
    throw new TypeError('store must expose put() and delete()');
  }
  if (memory && typeof memory.remember !== 'function') {
    throw new TypeError('memory port must expose remember()');
  }

  let closed = false;
  let disposePromise = null;
  let inFlight = 0;
  let idleWaiters = [];
  let internalStore = null;
  let internalRoot = null;
  /** 本入口写进 store 且还没 release/dispose 的 ref → { expiresAt }。 */
  const ownedRefs = new Map();
  /** 待确认条目：只在内存里，不落盘、不进长期记忆。 */
  const pending = new Map();

  /** 第一次真正调用入口时才建目录：关闭状态下（以及没调用过时）没有任何磁盘副作用。 */
  function activeStore() {
    if (store) return store;
    if (!internalStore) {
      internalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-voice-'));
      internalStore = createMediaStore({ root: internalRoot });
    }
    return internalStore;
  }

  function beginOp() {
    if (closed) return false;
    inFlight += 1;
    return true;
  }

  function endOp() {
    inFlight -= 1;
    if (inFlight === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function whenIdle() {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => { idleWaiters.push(resolve); });
  }

  function refusal(code, message, extra = {}) {
    return { ok: false, chat: null, transcript: null, error: { code, message }, ...extra };
  }

  function offResult(code, message, extra = {}) {
    return refusal(code, message, { enabled, decision: VOICE_DECISION.TEXT, ...extra });
  }

  function offSpeak(code, message, text, extra = {}) {
    return refusal(code, message, { enabled, prepared: 'text', fallbackText: text, audioRef: null, ...extra });
  }

  /**
   * pipeline / confirm 共用的记忆写入：关闭后一律不写。
   * 返回 null 表示「没有端口」，由调用方给 memory-port-missing。
   */
  async function writeMemory(payload, source) {
    if (!memory) return { written: false, reason: 'memory-port-missing' };
    if (closed) return { written: false, reason: VOICE_RUNTIME_ERROR.CLOSED };
    try {
      await memory.remember({ ...payload, source });
      return { written: true, reason: 'written' };
    } catch {
      return { written: false, reason: 'memory-write-failed' };
    }
  }

  /** 给 pipeline 的端口：关闭时必须抛错，否则 pipeline 会把「没写」误记成写过。 */
  function pipelineMemoryPort() {
    if (!memory) return null;
    return {
      async remember(payload) {
        if (closed) throw Object.assign(new Error('voice runtime is closed'), { code: VOICE_RUNTIME_ERROR.CLOSED });
        await memory.remember({ ...payload, source: 'asr' });
      },
    };
  }

  function pruneExpiredPending(at) {
    for (const [id, entry] of pending) {
      if (at >= entry.expiresAt) pending.delete(id);
    }
  }

  function listPending() {
    const at = now();
    const rows = [];
    for (const [id, entry] of pending) {
      if (at >= entry.expiresAt) continue;
      // 列表只给元数据，不回显转写内容（内容留在 confirm/reject 那一侧）。
      rows.push(Object.freeze({
        id,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        confidence: entry.transcript.confidence,
        chars: entry.transcript.text.length,
      }));
    }
    return rows;
  }

  /**
   * 转写一段音频并决定它能不能进聊天。
   * 低置信度只会进「待确认」，chat 一定是 null；入参里的 confirmed 不被采纳。
   */
  async function ingest({ input, timeoutMs } = {}) {
    if (!enabled) return offResult(VOICE_RUNTIME_ERROR.DISABLED, 'voice input is disabled by the host');
    if (!beginOp()) return offResult(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed');

    try {
      // 显式抹掉 input.confirmed：确认只能走 confirm(id)，不能从入参绕过。
      const safeInput = input && typeof input === 'object' && !Array.isArray(input)
        ? { ...input, confirmed: false }
        : input;

      const result = await ingestAudio({
        asr,
        store: activeStore(),
        input: safeInput,
        memory: pipelineMemoryPort(),
        minConfidence,
        timeoutMs: timeoutMs === undefined ? asrTimeoutMs : timeoutMs,
        retainInput: false,
      });

      const temporary = result.metadata?.temporary ?? null;
      const base = {
        enabled: true,
        transcript: result.transcript,
        metadata: result.metadata,
        temporary,
        pending: null,
        chat: null,
      };

      // 关闭开始了：结果不外泄成聊天，也不新增待确认。
      if (closed) return { ...base, ...offResult(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime closed while transcribing') };

      if (!result.ok) {
        return {
          ...base,
          ok: false,
          decision: result.recovery?.action === 'ask-repeat' ? VOICE_DECISION.REPEAT : VOICE_DECISION.TEXT,
          memory: null,
          error: result.error,
        };
      }

      const transcript = result.transcript;
      if (transcript.confidence < minConfidence) {
        const at = now();
        pruneExpiredPending(at);
        if (pending.size >= maxPending) {
          return {
            ...base,
            ok: false,
            decision: VOICE_DECISION.TEXT,
            memory: result.memory,
            reason: VOICE_RUNTIME_ERROR.PENDING_FULL,
            error: {
              code: VOICE_RUNTIME_ERROR.PENDING_FULL,
              message: 'too many transcripts are waiting for confirmation; falling back to text',
            },
          };
        }
        const id = crypto.randomUUID();
        const entry = { transcript, createdAt: at, expiresAt: at + confirmTtlMs };
        pending.set(id, entry);
        return {
          ...base,
          ok: true,
          decision: VOICE_DECISION.CONFIRM,
          memory: result.memory,
          pending: { id, createdAt: entry.createdAt, expiresAt: entry.expiresAt },
        };
      }

      return {
        ...base,
        ok: true,
        decision: VOICE_DECISION.CHAT,
        memory: result.memory,
        chat: {
          text: transcript.text,
          confidence: transcript.confidence,
          source: 'asr',
        },
      };
    } finally {
      endOp();
    }
  }

  /** 用户确认了一条低置信度转写：这时才允许进聊天、才允许写长期记忆。 */
  async function confirm(id) {
    if (!enabled) return offResult(VOICE_RUNTIME_ERROR.DISABLED, 'voice input is disabled by the host', { id: null });
    if (!beginOp()) return offResult(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed', { id: null });
    try {
      const key = normalizeId(id);
      if (!key) return offResult(VOICE_RUNTIME_ERROR.INVALID_ID, 'pending id must be a non-empty string', { id: null });
      const entry = pending.get(key);
      if (!entry) {
        return offResult(VOICE_RUNTIME_ERROR.CONFIRM_NOT_FOUND, 'no pending transcript for this id', { id: key });
      }
      if (now() >= entry.expiresAt) {
        pending.delete(key);
        return offResult(VOICE_RUNTIME_ERROR.CONFIRM_EXPIRED, 'pending transcript expired before confirmation', { id: key });
      }
      pending.delete(key);
      const memoryState = await writeMemory({
        text: entry.transcript.text,
        confidence: entry.transcript.confidence,
        language: entry.transcript.language,
        provider: entry.transcript.provider,
      }, 'asr-confirmed');

      return {
        ok: true,
        enabled: true,
        decision: VOICE_DECISION.CHAT,
        id: key,
        transcript: entry.transcript,
        memory: memoryState,
        chat: {
          text: entry.transcript.text,
          confidence: entry.transcript.confidence,
          source: 'asr-confirmed',
        },
      };
    } finally {
      endOp();
    }
  }

  /** 用户否认这条转写：丢掉待确认条目，回退成打字。 */
  function reject(id) {
    if (!enabled) return offResult(VOICE_RUNTIME_ERROR.DISABLED, 'voice input is disabled by the host', { id: null });
    if (closed) return offResult(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed', { id: null });
    const key = normalizeId(id);
    if (!key) return offResult(VOICE_RUNTIME_ERROR.INVALID_ID, 'pending id must be a non-empty string', { id: null });
    if (!pending.has(key)) {
      return offResult(VOICE_RUNTIME_ERROR.CONFIRM_NOT_FOUND, 'no pending transcript for this id', { id: key });
    }
    pending.delete(key);
    return { ok: true, enabled: true, decision: VOICE_DECISION.TEXT, id: key, reason: 'rejected', chat: null };
  }

  /**
   * 把文字「准备好」成语音；不发送、不调用任何平台。
   * 任何失败都只退化成 prepared:'text'，文字一定还在；失败不给半成品 ref。
   */
  async function speak({ text, voice, format, timeoutMs, humanizer } = {}) {
    const plain = typeof text === 'string' ? text : '';
    if (!enabled) return offSpeak(VOICE_RUNTIME_ERROR.DISABLED, 'voice output is disabled by the host', plain);
    if (!beginOp()) return offSpeak(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed', plain);

    try {
      const result = await renderVoice({
        tts,
        humanizer,
        text: plain,
        store: activeStore(),
        voice,
        format,
        timeoutMs: timeoutMs === undefined ? ttsTimeoutMs : timeoutMs,
      });

      const artifactRef = result.ok && result.artifact && typeof result.artifact.ref === 'string'
        ? result.artifact.ref
        : null;

      if (artifactRef) {
        ownedRefs.set(artifactRef, {
          expiresAt: Number.isFinite(result.artifact.expiresAt) ? result.artifact.expiresAt : null,
        });
      }
      // dispose waits for this operation, then cleans up the tracked artifact.
      if (closed) {
        return offSpeak(
          VOICE_RUNTIME_ERROR.CLOSED,
          'voice runtime closed while preparing audio',
          result.fallbackText ?? plain,
        );
      }

      return {
        ok: result.ok,
        enabled: true,
        prepared: result.ok ? 'voice' : 'text',
        fallbackText: result.fallbackText,
        audioRef: result.ok ? (artifactRef || result.audioRef || null) : null,
        mime: result.ok ? (result.mime ?? null) : null,
        artifact: result.ok ? (result.artifact ?? null) : null,
        temporary: artifactRef ? { ref: artifactRef, kind: 'tts-audio', owner: 'host-delivery' } : null,
        error: result.error ?? null,
      };
    } finally {
      endOp();
    }
  }

  /**
   * 宿主发完语音后释放这条投递期临时文件（只允许本入口创建过的 ref）。
   * 只有真删掉、或确认已经不存在，才停止追踪；存储抛异常时保留追踪，留给 dispose 重试。
   */
  function release(ref) {
    if (!enabled) return refusal(VOICE_RUNTIME_ERROR.DISABLED, 'voice is disabled by the host', { deleted: false, ref: null });
    if (closed) return refusal(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed', { deleted: false, ref: null });
    const key = normalizeId(ref);
    if (!key) return refusal(VOICE_RUNTIME_ERROR.INVALID_ID, 'audio ref must be a non-empty string', { deleted: false, ref: null });
    if (!ownedRefs.has(key)) {
      return refusal(VOICE_RUNTIME_ERROR.NOT_OWNED, 'this ref was not created by the voice runtime', { deleted: false, ref: key });
    }

    let deletion;
    try {
      deletion = (store || internalStore).delete(key, 'delete');
    } catch {
      return refusal(MEDIA_ERROR.STORE_FAILED, 'temporary voice audio could not be deleted', { deleted: false, ref: key, kept: true });
    }
    const deleted = deletion?.deleted === true;
    if (deleted) {
      ownedRefs.delete(key);
      return { ok: true, enabled: true, deleted: true, ref: key, alreadyGone: false, audit: deletion?.audit ?? null, error: null };
    }
    if (deletion?.code === MEDIA_ERROR.NOT_FOUND) {
      ownedRefs.delete(key);
      return { ok: true, enabled: true, deleted: false, ref: key, alreadyGone: true, error: null };
    }
    return refusal(
      deletion?.code || MEDIA_ERROR.STORE_FAILED,
      'temporary voice audio could not be deleted',
      { deleted: false, ref: key, kept: true },
    );
  }

  /**
   * 清掉「本入口自己创建的」已过期临时音频。
   * 注入共享 store 时不会调用 store.purgeExpired()——那会删到宿主的条目。
   */
  function purgeExpired() {
    if (!enabled) return refusal(VOICE_RUNTIME_ERROR.DISABLED, 'voice is disabled by the host', { removed: 0, refs: [] });
    if (closed) return refusal(VOICE_RUNTIME_ERROR.CLOSED, 'voice runtime is closing or closed', { removed: 0, refs: [] });
    const active = store || internalStore;
    if (!active || ownedRefs.size === 0) return { ok: true, removed: 0, refs: [], failures: [] };

    const at = now();
    const due = [...ownedRefs.entries()]
      .filter(([, meta]) => Number.isFinite(meta.expiresAt) && meta.expiresAt <= at)
      .map(([ref]) => ref);

    const refs = [];
    const failures = [];
    for (const ref of due) {
      try {
        const deletion = active.delete(ref, 'expired');
        if (deletion?.deleted === true || deletion?.code === MEDIA_ERROR.NOT_FOUND) {
          ownedRefs.delete(ref);
          refs.push(ref);
        } else {
          failures.push({ ref, code: deletion?.code || MEDIA_ERROR.STORE_FAILED });
        }
      } catch {
        failures.push({ ref, code: MEDIA_ERROR.STORE_FAILED });
      }
    }
    return { ok: failures.length === 0, removed: refs.length, refs, failures };
  }

  /**
   * 关掉这个入口（async）：同步拒绝新操作 → 等在途归零 → 删自有临时音频 +
   * 清待确认条目；自建 store 的目录一并删除，注入 store 只删自己的 ref。
   */
  function dispose() {
    if (disposePromise) {
      return disposePromise.then((summary) => ({ ...summary, alreadyDisposed: true }));
    }
    closed = true;
    disposePromise = (async () => {
      await whenIdle();
      return finalizeDispose();
    })();
    return disposePromise;
  }

  function finalizeDispose() {
    const active = store || internalStore;
    const refs = [...ownedRefs.keys()];
    let deleted = 0;
    const failedRefs = [];
    if (active) {
      for (const ref of refs) {
        try {
          const deletion = active.delete(ref, 'cleanup');
          if (deletion?.deleted === true) deleted += 1;
          else if (deletion?.code !== MEDIA_ERROR.NOT_FOUND) {
            // 文件已经不在（not-found）不算清理失败；其它原因才如实上报。
            failedRefs.push({ ref, code: deletion?.code || MEDIA_ERROR.STORE_FAILED });
          }
        } catch {
          failedRefs.push({ ref, code: MEDIA_ERROR.STORE_FAILED });
        }
      }
    }
    ownedRefs.clear();

    const ownsDirectory = Boolean(internalStore && internalRoot);
    let storeRemoved = false;
    if (internalStore && internalRoot) {
      const root = internalRoot;
      internalStore = null;
      internalRoot = null;
      try {
        fs.rmSync(root, { recursive: true, force: true });
        storeRemoved = true;
      } catch {
        storeRemoved = false;
      }
    }

    const pendingCleared = pending.size;
    pending.clear();

    return {
      ok: failedRefs.length === 0 && (!ownsDirectory || storeRemoved),
      alreadyDisposed: false,
      deleted,
      failed: failedRefs.length,
      failedRefs,
      refs,
      storeRemoved,
      pendingCleared,
    };
  }

  /** 只读自述：启用/关闭状态、在途数、适配器能力、临时存储归属、待确认条数、策略值。 */
  function status() {
    const active = store || internalStore;
    const entries = active
      ? (typeof active.list === 'function' ? active.list().length : null)
      : 0;
    return Object.freeze({
      kind: 'voice-runtime',
      version: VOICE_RUNTIME_VERSION,
      contractVersion: MEDIA_CONTRACT_VERSION,
      enabled,
      closed,
      disposed: closed && inFlight === 0 && Boolean(disposePromise),
      inFlight,
      capabilities: probeMediaCapabilities({ asr, tts }),
      store: Object.freeze({
        injected: Boolean(store),
        owned: !store && Boolean(internalStore),
        created: Boolean(store) || Boolean(internalStore),
        root: store ? null : internalRoot,
        entries,
        trackedRefs: ownedRefs.size,
      }),
      pending: Object.freeze({ count: pending.size, capacity: maxPending }),
      policy: Object.freeze({
        minConfidence,
        confirmTtlMs,
        asrTimeoutMs,
        ttsTimeoutMs,
        maxPending,
        retainInputAudio: false,
      }),
    });
  }

  return Object.freeze({
    kind: 'voice-runtime',
    version: VOICE_RUNTIME_VERSION,
    ingest,
    speak,
    confirm,
    reject,
    release,
    purgeExpired,
    dispose,
    status,
    listPending,
  });
}
