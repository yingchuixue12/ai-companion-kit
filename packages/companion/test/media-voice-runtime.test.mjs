/**
 * 语音运行入口（SOP06 候选 / D0）· 离线验证
 * ─────────────────────────────────────────────────────────────
 * 只验证「可编程宿主的入口契约」：默认关闭、宿主显式启用并注入适配器、
 * 低置信度先确认后进聊天/记忆、TTS 失败退文字、关闭与在途操作、
 * 临时音频归属与清理。
 *
 * 全程离线：不访问网络、不装供应商 SDK、不开 CLI/QQ、不发送任何消息、
 * 不写用户语音或长期记忆。用到的 ASR/TTS 都是 src/media/offline-stub.js 的合成桩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createVoiceRuntime,
  DEFAULT_CONFIRM_TTL_MS,
  DEFAULT_MAX_PENDING,
  VOICE_DECISION,
  VOICE_RUNTIME_ERROR,
  VOICE_RUNTIME_VERSION,
} from '../src/media/voice-runtime.js';
import { createOfflineAsrStub, createOfflineTtsStub } from '../src/media/offline-stub.js';
import { createMediaStore } from '../src/media/store.js';
import { MEDIA_ERROR, MEDIA_CONTRACT_VERSION } from '../src/media/contracts.js';

const AUDIO_REF_RE = /^media:\/\/[0-9a-f-]{36}$/;

function audioInput(overrides = {}) {
  return {
    kind: 'audio',
    mime: 'audio/ogg',
    size: 5,
    durationMs: 900,
    ref: 'tmp://voice-1',
    ...overrides,
  };
}

function memorySpy() {
  const calls = [];
  return {
    calls,
    port: {
      async remember(payload) {
        calls.push(payload);
      },
    },
  };
}

function tmpRoot(prefix = 'companion-voice-runtime-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mustNotRun(label) {
  const spy = (...args) => {
    spy.calls.push(args);
    throw new Error(`${label} must not be called`);
  };
  spy.calls = [];
  return spy;
}

// ── ① 默认关闭 ─────────────────────────────────────────────────

test('V-01 voice runtime is off by default and never touches injected adapters', async () => {
  const transcribe = mustNotRun('asr.transcribe');
  const synthesize = mustNotRun('tts.synthesize');
  const runtime = createVoiceRuntime({ asr: { transcribe }, tts: { synthesize } });

  const ingested = await runtime.ingest({ input: audioInput() });
  assert.equal(ingested.ok, false);
  assert.equal(ingested.decision, VOICE_DECISION.TEXT);
  assert.equal(ingested.error.code, VOICE_RUNTIME_ERROR.DISABLED);
  assert.equal(ingested.chat, null);
  assert.equal(ingested.transcript, null);

  const spoken = await runtime.speak({ text: '在呢，咋了' });
  assert.equal(spoken.ok, false);
  assert.equal(spoken.prepared, 'text');
  assert.equal(spoken.fallbackText, '在呢，咋了');
  assert.equal(spoken.audioRef, null);
  assert.equal(spoken.error.code, VOICE_RUNTIME_ERROR.DISABLED);

  const status = runtime.status();
  assert.equal(status.enabled, false);
  assert.equal(status.closed, false);
  assert.equal(status.disposed, false);
  assert.equal(status.store.created, false);
  assert.equal(status.store.root, null);
  assert.equal(status.store.trackedRefs, 0);
  assert.equal(transcribe.calls.length, 0);
  assert.equal(synthesize.calls.length, 0);
  assert.equal((await runtime.dispose()).deleted, 0);
});

test('V-02 enabling requires a real boolean and validated options', async () => {
  assert.throws(() => createVoiceRuntime({ enabled: 'true' }), TypeError);
  assert.throws(() => createVoiceRuntime({ enabled: 1 }), TypeError);
  assert.throws(() => createVoiceRuntime({ minConfidence: 1.2 }), TypeError);
  assert.throws(() => createVoiceRuntime({ minConfidence: Number.NaN }), TypeError);
  assert.throws(() => createVoiceRuntime({ confirmTtlMs: 0 }), TypeError);
  assert.throws(() => createVoiceRuntime({ maxPending: 1.5 }), TypeError);
  assert.throws(() => createVoiceRuntime({ now: 'later' }), TypeError);
  assert.throws(() => createVoiceRuntime({ store: {} }), TypeError);
  assert.throws(() => createVoiceRuntime({ memory: {} }), TypeError);

  const runtime = createVoiceRuntime({ enabled: true });
  assert.equal(runtime.kind, 'voice-runtime');
  assert.equal(runtime.version, VOICE_RUNTIME_VERSION);
  const policy = runtime.status().policy;
  assert.equal(policy.retainInputAudio, false);
  assert.equal(policy.maxPending, DEFAULT_MAX_PENDING);
  assert.equal(policy.confirmTtlMs, DEFAULT_CONFIRM_TTL_MS);
  await runtime.dispose();
});

// ── ② 高置信度 → 聊天 + 记忆 ───────────────────────────────────

test('V-03 high-confidence input reaches chat, writes via the memory port and drops input audio', async () => {
  const spy = memorySpy();
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '今天有点累', confidence: 0.93, language: 'zh' }] }),
    memory: spy.port,
  });
  const payload = Buffer.from('synthetic-voice-input');

  const result = await runtime.ingest({ input: audioInput({ size: payload.length, bytes: payload }) });

  assert.equal(result.ok, true);
  assert.equal(result.decision, VOICE_DECISION.CHAT);
  assert.equal(result.chat.text, '今天有点累');
  assert.equal(result.chat.confidence, 0.93);
  assert.equal(result.chat.source, 'asr');
  assert.equal(result.pending, null);
  assert.equal(result.memory.written, true);
  assert.equal(result.memory.reason, 'written');
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].source, 'asr');

  // 输入音频是转写期临时文件：转写完就删，本入口不留用户语音。
  assert.equal(result.temporary.deleted, true);
  assert.match(result.temporary.ref, AUDIO_REF_RE);
  assert.equal(runtime.status().store.entries, 0);
  assert.deepEqual(runtime.listPending(), []);
  await runtime.dispose();
});

test('V-04 a transcript without a memory port stays out of long-term memory', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '只聊天不记账', confidence: 0.9 }] }),
  });
  const result = await runtime.ingest({ input: audioInput() });
  assert.equal(result.decision, VOICE_DECISION.CHAT);
  assert.equal(result.memory.written, false);
  assert.equal(result.memory.reason, 'memory-port-missing');
  await runtime.dispose();
});

// ── ③ 低置信度 → 只有 confirm(id) 能放行 ──────────────────────

test('V-05 low-confidence input waits for confirmation before chat or memory', async () => {
  const spy = memorySpy();
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '听不太清', confidence: 0.2 }] }),
    memory: spy.port,
  });

  const result = await runtime.ingest({ input: audioInput() });
  assert.equal(result.ok, true);
  assert.equal(result.decision, VOICE_DECISION.CONFIRM);
  assert.equal(result.chat, null);
  assert.equal(result.transcript.text, '听不太清');
  assert.equal(result.memory.eligible, false);
  assert.equal(result.memory.written, false);
  assert.equal(result.memory.reason, 'low-confidence-needs-confirmation');
  assert.equal(spy.calls.length, 0);
  assert.match(result.pending.id, /^[0-9a-f-]{36}$/);

  const rows = runtime.listPending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.pending.id);
  assert.equal(rows[0].chars, 4);
  assert.equal('text' in rows[0], false);

  const confirmed = await runtime.confirm(result.pending.id);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.decision, VOICE_DECISION.CHAT);
  assert.equal(confirmed.chat.text, '听不太清');
  assert.equal(confirmed.chat.source, 'asr-confirmed');
  assert.equal(confirmed.memory.written, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].source, 'asr-confirmed');

  const again = await runtime.confirm(result.pending.id);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, VOICE_RUNTIME_ERROR.CONFIRM_NOT_FOUND);
  assert.deepEqual(runtime.listPending(), []);
  await runtime.dispose();
});

test('V-06 a confirmed flag on the input cannot bypass confirmation', async () => {
  const spy = memorySpy();
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({
      transcripts: [
        { text: '入参说确认了', confidence: 0.2 },
        { text: '还是低置信度', confidence: 0.2 },
      ],
    }),
    memory: spy.port,
  });

  const viaInput = await runtime.ingest({ input: audioInput({ confirmed: true }) });
  assert.equal(viaInput.decision, VOICE_DECISION.CONFIRM);
  assert.equal(viaInput.chat, null);
  assert.equal(viaInput.memory.written, false);
  assert.equal(spy.calls.length, 0);

  const second = await runtime.ingest({ input: audioInput({ confirmed: true }) });
  assert.equal(second.decision, VOICE_DECISION.CONFIRM);
  assert.equal(runtime.status().pending.count, 2);
  assert.equal(spy.calls.length, 0);

  // 唯一放行路径仍然是 confirm(id)。
  const confirmed = await runtime.confirm(viaInput.pending.id);
  assert.equal(confirmed.chat.text, '入参说确认了');
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].source, 'asr-confirmed');
  await runtime.dispose();
});

test('V-07 rejecting a pending transcript falls back to text and never writes memory', async () => {
  const spy = memorySpy();
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '不是这个意思', confidence: 0.15 }] }),
    memory: spy.port,
  });

  const result = await runtime.ingest({ input: audioInput() });
  const rejected = runtime.reject(result.pending.id);
  assert.equal(rejected.ok, true);
  assert.equal(rejected.decision, VOICE_DECISION.TEXT);
  assert.equal(rejected.reason, 'rejected');
  assert.equal(rejected.chat, null);
  assert.equal(spy.calls.length, 0);
  assert.deepEqual(runtime.listPending(), []);

  assert.equal(runtime.reject('nope').error.code, VOICE_RUNTIME_ERROR.CONFIRM_NOT_FOUND);
  assert.equal(runtime.reject('').error.code, VOICE_RUNTIME_ERROR.INVALID_ID);
  assert.equal((await runtime.confirm(42)).error.code, VOICE_RUNTIME_ERROR.INVALID_ID);
  assert.equal((await runtime.confirm('')).error.code, VOICE_RUNTIME_ERROR.INVALID_ID);
  await runtime.dispose();
});

test('V-08 expired pending transcripts cannot be confirmed and do not block new ones', async () => {
  let clock = 1_000;
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({
      transcripts: [
        { text: '第一条', confidence: 0.2 },
        { text: '第二条', confidence: 0.2 },
      ],
    }),
    confirmTtlMs: 500,
    now: () => clock,
  });

  const first = await runtime.ingest({ input: audioInput() });
  assert.equal(first.pending.expiresAt, 1_500);
  clock = 1_600;
  assert.deepEqual(runtime.listPending(), []);

  const expired = await runtime.confirm(first.pending.id);
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, VOICE_RUNTIME_ERROR.CONFIRM_EXPIRED);

  const second = await runtime.ingest({ input: audioInput() });
  assert.equal(second.decision, VOICE_DECISION.CONFIRM);
  assert.equal(runtime.status().pending.count, 1);
  await runtime.dispose();
});

test('V-09 pending capacity falls back to text instead of queueing more speech', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({
      transcripts: [
        { text: '一', confidence: 0.2 },
        { text: '二', confidence: 0.2 },
      ],
    }),
    maxPending: 1,
  });

  const first = await runtime.ingest({ input: audioInput() });
  assert.equal(first.decision, VOICE_DECISION.CONFIRM);

  const second = await runtime.ingest({ input: audioInput() });
  assert.equal(second.ok, false);
  assert.equal(second.decision, VOICE_DECISION.TEXT);
  assert.equal(second.reason, VOICE_RUNTIME_ERROR.PENDING_FULL);
  assert.equal(second.error.code, VOICE_RUNTIME_ERROR.PENDING_FULL);
  assert.equal(second.chat, null);
  assert.equal(second.pending, null);
  await runtime.dispose();
});

test('V-10 a memory-port failure after confirmation keeps the transcript and says why', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '还是记一下', confidence: 0.2 }] }),
    memory: { async remember() { throw new Error('memory offline'); } },
  });

  const result = await runtime.ingest({ input: audioInput() });
  const confirmed = await runtime.confirm(result.pending.id);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.chat.text, '还是记一下');
  assert.equal(confirmed.memory.written, false);
  assert.equal(confirmed.memory.reason, 'memory-write-failed');
  await runtime.dispose();
});

// ── ④ TTS：只准备、不投递 ─────────────────────────────────────

test('V-11 TTS success only prepares audio and hands the host a ref it releases', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: createOfflineTtsStub({ audioRef: 'stub://voice-out' }),
  });

  const spoken = await runtime.speak({ text: '收到啦\n马上来', humanizer: (value) => value.replace(/\n/g, ' ') });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.prepared, 'voice');
  assert.equal(spoken.fallbackText, '收到啦 马上来');
  assert.match(spoken.audioRef, AUDIO_REF_RE);
  assert.equal(spoken.artifact.sha256.length, 64);
  assert.equal(spoken.temporary.owner, 'host-delivery');
  // 本入口不发送：没有任何「已投递」字段，只有 prepared。
  assert.equal('delivered' in spoken, false);
  assert.equal(runtime.status().store.entries, 1);
  assert.equal(runtime.status().store.trackedRefs, 1);

  const released = runtime.release(spoken.audioRef);
  assert.equal(released.ok, true);
  assert.equal(released.deleted, true);
  assert.equal(released.alreadyGone, false);
  assert.equal(runtime.status().store.entries, 0);
  assert.equal(runtime.status().store.trackedRefs, 0);

  const again = runtime.release(spoken.audioRef);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, VOICE_RUNTIME_ERROR.NOT_OWNED);
  await runtime.dispose();
});

test('V-12 TTS failure only claims text and never returns a half-finished audio ref', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: createOfflineTtsStub({ failWith: { code: MEDIA_ERROR.TTS_FAILED } }),
  });

  const spoken = await runtime.speak({ text: '  文字不能丢  ', humanizer: (value) => value.trim() });
  assert.equal(spoken.ok, false);
  assert.equal(spoken.prepared, 'text');
  assert.equal(spoken.fallbackText, '文字不能丢');
  assert.equal(spoken.audioRef, null);
  assert.equal(spoken.artifact, null);
  assert.equal(spoken.temporary, null);
  assert.equal(spoken.error.code, MEDIA_ERROR.TTS_FAILED);
  assert.equal(runtime.status().store.trackedRefs, 0);
  await runtime.dispose();
});

test('V-13 an adapter-owned ref is passed through without the runtime claiming ownership', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: {
      provider: 'vendor-x',
      async synthesize() {
        return { audioRef: 'vendor://audio-1', mime: 'audio/ogg' };
      },
    },
  });

  const spoken = await runtime.speak({ text: '供应商自己存' });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.prepared, 'voice');
  assert.equal(spoken.audioRef, 'vendor://audio-1');
  assert.equal(spoken.artifact, null);
  assert.equal(spoken.temporary, null);
  assert.equal(runtime.status().store.trackedRefs, 0);

  const released = runtime.release('vendor://audio-1');
  assert.equal(released.deleted, false);
  assert.equal(released.error.code, VOICE_RUNTIME_ERROR.NOT_OWNED);
  assert.equal(runtime.release('').error.code, VOICE_RUNTIME_ERROR.INVALID_ID);
  await runtime.dispose();
});

// ── ⑤ ASR 失败/非法输入 → 回退或重说 ──────────────────────────

test('V-14 ASR failure asks for a repeat and still deletes the input temp file', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [], failWith: { code: MEDIA_ERROR.ASR_FAILED } }),
  });
  const payload = Buffer.from('unreadable');

  const result = await runtime.ingest({ input: audioInput({ size: payload.length, bytes: payload }) });
  assert.equal(result.ok, false);
  assert.equal(result.decision, VOICE_DECISION.REPEAT);
  assert.equal(result.chat, null);
  assert.equal(result.error.code, MEDIA_ERROR.ASR_FAILED);
  assert.equal(result.temporary.deleted, true);
  assert.equal(runtime.status().store.entries, 0);
  await runtime.dispose();
});

test('V-15 invalid audio never reaches the adapter and falls back to text', async () => {
  let calls = 0;
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: { async transcribe() { calls += 1; return { text: 'x', confidence: 0.9 }; } },
  });

  const image = await runtime.ingest({ input: audioInput({ kind: 'image', mime: 'image/png' }) });
  assert.equal(image.ok, false);
  assert.equal(image.decision, VOICE_DECISION.TEXT);
  assert.equal(image.error.code, MEDIA_ERROR.UNSUPPORTED_KIND);

  const garbage = await runtime.ingest({ input: 42 });
  assert.equal(garbage.decision, VOICE_DECISION.TEXT);
  assert.equal(garbage.error.code, MEDIA_ERROR.INVALID_INPUT);

  const noAdapter = createVoiceRuntime({ enabled: true });
  const missing = await noAdapter.ingest({ input: audioInput() });
  assert.equal(missing.decision, VOICE_DECISION.TEXT);
  assert.equal(missing.error.code, MEDIA_ERROR.ADAPTER_MISSING);
  const noVoice = await noAdapter.speak({ text: '没有 TTS 适配器' });
  assert.equal(noVoice.prepared, 'text');
  assert.equal(noVoice.fallbackText, '没有 TTS 适配器');
  assert.equal(noVoice.error.code, MEDIA_ERROR.ADAPTER_MISSING);

  const noText = await runtime.speak({});
  assert.equal(noText.ok, false);
  assert.equal(noText.prepared, 'text');
  assert.equal(noText.error.code, MEDIA_ERROR.INVALID_INPUT);
  const nonString = await runtime.speak({ text: 42 });
  assert.equal(nonString.prepared, 'text');
  assert.equal(nonString.fallbackText, '');
  assert.equal(calls, 0);
  await noAdapter.dispose();
  await runtime.dispose();
});

// ── ⑥ 状态、归属、关闭契约 ───────────────────────────────────

test('V-16 status shows capabilities, store ownership, in-flight and policy', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '你好', confidence: 0.9 }] }),
    tts: createOfflineTtsStub(),
    minConfidence: 0.7,
    asrTimeoutMs: 2_000,
    ttsTimeoutMs: 3_000,
    maxPending: 3,
    confirmTtlMs: 60_000,
  });

  const before = runtime.status();
  assert.equal(before.enabled, true);
  assert.equal(before.closed, false);
  assert.equal(before.inFlight, 0);
  assert.equal(before.contractVersion, MEDIA_CONTRACT_VERSION);
  assert.equal(before.capabilities.asr.available, true);
  assert.equal(before.capabilities.asr.offline, true);
  assert.equal(before.capabilities.tts.offline, true);
  assert.equal(before.capabilities.image.available, false);
  assert.equal(before.store.created, false);
  assert.equal(before.store.owned, false);
  assert.equal(before.store.injected, false);
  assert.equal(before.store.root, null);
  assert.equal(before.store.entries, 0);
  assert.equal(before.pending.capacity, 3);
  assert.equal(before.policy.minConfidence, 0.7);
  assert.equal(before.policy.asrTimeoutMs, 2_000);
  assert.equal(before.policy.ttsTimeoutMs, 3_000);
  assert.equal(before.policy.confirmTtlMs, 60_000);

  // 没有任何 store 时 purge 不会凭空造目录。
  assert.deepEqual(runtime.purgeExpired(), { ok: true, removed: 0, refs: [], failures: [] });
  assert.equal(runtime.status().store.created, false);

  await runtime.ingest({ input: audioInput({ bytes: Buffer.from('voice') }) });
  const after = runtime.status();
  assert.equal(after.store.created, true);
  assert.equal(after.store.owned, true);
  assert.equal(typeof after.store.root, 'string');
  assert.equal(after.store.entries, 0);
  await runtime.dispose();
});

test('V-17 dispose closes, clears pending, removes own store directory and is idempotent', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '待确认', confidence: 0.2 }] }),
    tts: createOfflineTtsStub(),
  });

  const spoken = await runtime.speak({ text: '存一条语音' });
  const pending = await runtime.ingest({ input: audioInput() });
  assert.equal(pending.decision, VOICE_DECISION.CONFIRM);
  const root = runtime.status().store.root;
  assert.equal(fs.existsSync(root), true);

  const disposed = await runtime.dispose();
  assert.equal(disposed.ok, true);
  assert.equal(disposed.deleted, 1);
  assert.equal(disposed.failed, 0);
  assert.deepEqual(disposed.refs, [spoken.audioRef]);
  assert.equal(disposed.storeRemoved, true);
  assert.equal(disposed.pendingCleared, 1);
  assert.equal(fs.existsSync(root), false);

  const again = await runtime.dispose();
  assert.equal(again.ok, true);
  assert.equal(again.alreadyDisposed, true);
  // 重复调用回报的是同一次 dispose 的结果，不重复计数也不掩盖失败。
  assert.equal(again.deleted, 1);
  assert.deepEqual(again.refs, [spoken.audioRef]);

  const status = runtime.status();
  assert.equal(status.closed, true);
  assert.equal(status.disposed, true);
  assert.equal((await runtime.ingest({ input: audioInput() })).error.code, VOICE_RUNTIME_ERROR.CLOSED);
  const lateSpeech = await runtime.speak({ text: '关了就只发字' });
  assert.equal(lateSpeech.prepared, 'text');
  assert.equal(lateSpeech.fallbackText, '关了就只发字');
  assert.equal(lateSpeech.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(runtime.reject('x').error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(runtime.release('x').error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal((await runtime.confirm('x')).error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(runtime.purgeExpired().error.code, VOICE_RUNTIME_ERROR.CLOSED);
});

test('V-18 dispose with an injected store deletes only the refs the runtime created', async () => {
  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    const hostOwned = store.put({ bytes: Buffer.from('host-audio'), kind: 'host-file' });
    const runtime = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store });

    const spoken = await runtime.speak({ text: '运行时生成的语音' });
    assert.equal(runtime.status().store.injected, true);
    assert.equal(runtime.status().store.owned, false);
    assert.equal(runtime.status().store.root, null);
    assert.equal(store.list().length, 2);

    const disposed = await runtime.dispose();
    assert.equal(disposed.ok, true);
    assert.equal(disposed.deleted, 1);
    assert.equal(disposed.storeRemoved, false);
    assert.deepEqual(store.list().map((artifact) => artifact.ref), [hostOwned.ref]);

    const afterDispose = store.delete(spoken.audioRef);
    assert.equal(afterDispose.deleted, false);
    assert.equal(afterDispose.code, MEDIA_ERROR.NOT_FOUND);
    const hostFile = path.join(root, `${hostOwned.ref.slice('media://'.length)}.bin`);
    assert.equal(fs.existsSync(hostFile), true);

    const reuse = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store });
    assert.equal(reuse.status().store.entries, 1);
    await reuse.dispose();
    store.delete(hostOwned.ref);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V-19 release keeps tracking when the store fails and dispose retries cleanup', async () => {
  let attempts = 0;
  const throwing = {
    put() {
      return { ref: 'media://123e4567-e89b-12d3-a456-426614174000' };
    },
    delete() {
      attempts += 1;
      throw new Error('delete unavailable');
    },
  };
  const runtime = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store: throwing });
  const spoken = await runtime.speak({ text: '删不掉也要说清楚' });
  assert.equal(spoken.ok, true);

  const released = runtime.release(spoken.audioRef);
  assert.equal(released.ok, false);
  assert.equal(released.deleted, false);
  assert.equal(released.kept, true);
  assert.equal(released.error.code, MEDIA_ERROR.STORE_FAILED);
  assert.equal(runtime.status().store.trackedRefs, 1);

  const disposed = await runtime.dispose();
  assert.equal(disposed.ok, false);
  assert.equal(disposed.deleted, 0);
  assert.equal(disposed.failed, 1);
  assert.equal(disposed.failedRefs[0].ref, spoken.audioRef);
  assert.equal(disposed.failedRefs[0].code, MEDIA_ERROR.STORE_FAILED);
  assert.ok(attempts >= 2);

  // store 返回结构化失败（而不是抛异常）时同样保留追踪。
  const refusing = {
    put() {
      return { ref: 'media://123e4567-e89b-12d3-a456-426614174111' };
    },
    delete() {
      return { ok: false, deleted: false, code: MEDIA_ERROR.STORE_FAILED };
    },
  };
  const failing = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store: refusing });
  const second = await failing.speak({ text: '结构化失败' });
  const refused = failing.release(second.audioRef);
  assert.equal(refused.kept, true);
  assert.equal(failing.status().store.trackedRefs, 1);
  await failing.dispose();
});

test('V-20 release forgets a ref that is already gone and purge only touches own entries', async () => {
  let clock = 5_000;
  const root = tmpRoot();
  try {
    const store = createMediaStore({ root, now: () => clock, retentionMs: 1_000 });
    const hostExpired = store.put({ bytes: Buffer.from('host-old-audio'), kind: 'host-file' });
    const runtime = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store, now: () => clock });

    const spoken = await runtime.speak({ text: '一会儿就过期' });
    assert.equal(store.list().length, 2);

    clock = 7_000;
    const purged = runtime.purgeExpired();
    assert.equal(purged.ok, true);
    assert.equal(purged.removed, 1);
    assert.deepEqual(purged.refs, [spoken.audioRef]);
    // 共享 store 里别人的条目一条都不能动。
    assert.deepEqual(store.list().map((artifact) => artifact.ref), [hostExpired.ref]);

    const released = runtime.release(spoken.audioRef);
    assert.equal(released.error.code, VOICE_RUNTIME_ERROR.NOT_OWNED);

    // 宿主自己删掉的条目：release 视为已清理并停止追踪。
    const hostStore = createMediaStore({ root: tmpRoot() });
    const hostRuntime = createVoiceRuntime({ enabled: true, tts: createOfflineTtsStub(), store: hostStore });
    const second = await hostRuntime.speak({ text: '宿主先删了' });
    hostStore.delete(second.audioRef);
    const gone = hostRuntime.release(second.audioRef);
    assert.equal(gone.ok, true);
    assert.equal(gone.alreadyGone, true);
    assert.equal(hostRuntime.status().store.trackedRefs, 0);
    await hostRuntime.dispose();
    await runtime.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V-20c purge reports failures and keeps tracking the refs it could not delete', async () => {
  const checks = [
    () => { throw new Error('delete unavailable'); },
    () => ({ ok: false, deleted: false, code: MEDIA_ERROR.STORE_FAILED }),
  ];
  for (const removeBehavior of checks) {
    const refs = [];
    const store = {
      put() {
        const ref = `media://123e4567-e89b-12d3-a456-${String(refs.length).padStart(12, '0')}`;
        refs.push(ref);
        return { ref, expiresAt: 1_000 };
      },
      delete: removeBehavior,
    };
    const runtime = createVoiceRuntime({
      enabled: true,
      tts: createOfflineTtsStub(),
      store,
      now: () => 2_000,
    });

    await runtime.speak({ text: '过期了但删不掉' });
    const purged = runtime.purgeExpired();
    assert.equal(purged.ok, false);
    assert.equal(purged.removed, 0);
    assert.equal(purged.failures.length, 1);
    assert.equal(purged.failures[0].code, MEDIA_ERROR.STORE_FAILED);
    assert.equal(runtime.status().store.trackedRefs, 1);
    await runtime.dispose();
  }
});

test('V-20b a minimal injected store is reported honestly instead of throwing', async () => {
  let count = 0;
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: createOfflineTtsStub(),
    store: {
      put() {
        count += 1;
        return { ref: `media://123e4567-e89b-12d3-a456-${String(count).padStart(12, '0')}` };
      },
      delete() {
        return { ok: true, deleted: true };
      },
    },
  });

  await runtime.speak({ text: '最小 store' });
  assert.equal(runtime.status().store.entries, null);
  const purged = runtime.purgeExpired();
  assert.equal(purged.ok, true);
  assert.equal(purged.removed, 0);
  await runtime.dispose();
});

test('V-21 a disabled runtime cannot confirm, reject, release or purge', async () => {
  const runtime = createVoiceRuntime();
  assert.equal(runtime.reject('x').error.code, VOICE_RUNTIME_ERROR.DISABLED);
  assert.equal(runtime.release('x').error.code, VOICE_RUNTIME_ERROR.DISABLED);
  assert.equal((await runtime.confirm('x')).error.code, VOICE_RUNTIME_ERROR.DISABLED);
  assert.equal(runtime.purgeExpired().error.code, VOICE_RUNTIME_ERROR.DISABLED);
  assert.deepEqual(runtime.listPending(), []);
  assert.equal((await runtime.dispose()).deleted, 0);
});

// ── ⑦ 关闭 vs 在途操作（延迟 ASR / TTS 回归） ─────────────────

test('V-23 dispose during a slow transcription waits, adds no pending and writes no memory', async () => {
  const spy = memorySpy();
  const runtime = createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '慢转写', confidence: 0.95 }], delayMs: 60 }),
    memory: spy.port,
  });

  const inFlight = runtime.ingest({ input: audioInput({ bytes: Buffer.from('slow-audio') }) });
  const disposePromise = runtime.dispose();

  // 关闭一开始就拒绝新操作，不等在途结束。
  const late = await runtime.ingest({ input: audioInput() });
  assert.equal(late.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(late.chat, null);

  const result = await inFlight;
  const summary = await disposePromise;

  // 在途操作完成后才清理；关闭后不得冒出聊天、待确认或记忆写入。
  assert.equal(result.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(result.chat, null);
  assert.equal(result.pending, null);
  assert.equal(spy.calls.length, 0);
  assert.equal(summary.pendingCleared, 0);
  assert.equal(summary.deleted, 0);
  assert.equal(summary.storeRemoved, true);
  assert.deepEqual(runtime.listPending(), []);
});

test('V-24 dispose during slow synthesis waits, then removes the audio it never handed out', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: createOfflineTtsStub({ delayMs: 60 }),
  });

  const inFlight = runtime.speak({ text: '慢慢合成' });
  const root = runtime.status().store.root;
  const disposePromise = runtime.dispose();

  const lateSpeak = await runtime.speak({ text: '关闭后不再合成' });
  assert.equal(lateSpeak.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(lateSpeak.prepared, 'text');

  const result = await inFlight;
  assert.equal(result.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(result.prepared, 'text');
  assert.equal(result.fallbackText, '慢慢合成');
  assert.equal(result.audioRef, null);

  const summary = await disposePromise;
  assert.equal(summary.deleted, 1);
  assert.equal(summary.storeRemoved, true);
  assert.equal(fs.existsSync(root), false);
  assert.equal(runtime.status().store.trackedRefs, 0);
});

test('V-25 a speak in flight during close reports when its own audio could not be removed', async () => {
  const runtime = createVoiceRuntime({
    enabled: true,
    tts: createOfflineTtsStub({ delayMs: 40 }),
    store: {
      put() {
        return { ref: 'media://123e4567-e89b-12d3-a456-426614174222', expiresAt: Date.now() + 60_000 };
      },
      delete() {
        throw new Error('delete unavailable');
      },
    },
  });

  const inFlight = runtime.speak({ text: '关闭时删不掉' });
  const disposePromise = runtime.dispose();
  const result = await inFlight;

  assert.equal(result.error.code, VOICE_RUNTIME_ERROR.CLOSED);
  assert.equal(result.prepared, 'text');
  assert.equal(result.fallbackText, '关闭时删不掉');
  const summary = await disposePromise;
  assert.equal(summary.ok, false);
  assert.equal(summary.failedRefs[0].ref, 'media://123e4567-e89b-12d3-a456-426614174222');
  assert.equal(summary.deleted, 0);
  assert.equal(summary.storeRemoved, false);
});

// ── ⑧ 公共入口 ────────────────────────────────────────────────

test('V-22 the public lib entry exposes the voice runtime and runs fully offline', async () => {
  const lib = await import('../src/lib.js');
  assert.equal(typeof lib.createVoiceRuntime, 'function');
  assert.equal(lib.VOICE_RUNTIME_VERSION, VOICE_RUNTIME_VERSION);
  assert.equal(lib.VOICE_DECISION.CONFIRM, 'needs-confirmation');
  assert.equal(lib.VOICE_RUNTIME_ERROR.CLOSED, 'voice-closed');

  const runtime = lib.createVoiceRuntime({
    enabled: true,
    asr: createOfflineAsrStub({ transcripts: [{ text: '走公共入口', confidence: 0.88 }] }),
    tts: createOfflineTtsStub({ audioRef: 'stub://lib-voice' }),
  });

  const ingested = await runtime.ingest({ input: audioInput() });
  assert.equal(ingested.decision, lib.VOICE_DECISION.CHAT);
  assert.equal(ingested.chat.text, '走公共入口');

  const spoken = await runtime.speak({ text: '也说一句' });
  assert.equal(spoken.prepared, 'voice');
  assert.equal(runtime.release(spoken.audioRef).deleted, true);
  assert.equal((await runtime.dispose()).ok, true);
});
