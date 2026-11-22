/**
 * 媒体契约 / 离线管线加固测试（D0 / T7）
 * ─────────────────────────────────────────────────────────────
 * 只补齐迁移测试没有走到的防御分支：非法输入、适配器自述异常、
 * 存储上限/写失败/删除失败、离线桩的失败与中止路径，以及文字回退。
 * 全程离线：不访问网络、不读真实配置/账号/运行数据、不产生真实音频。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MEDIA_CONTRACT_VERSION,
  MEDIA_ERROR,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_REF_CHARS,
  AUDIO_INPUT_SCHEMA,
  validateAudioInput,
  validateTranscript,
  validateTtsRequest,
  validateMediaArtifact,
  mimeForFormat,
  toStructuredError,
} from '../src/media/contracts.js';
import { probeMediaCapabilities } from '../src/media/capabilities.js';
import { createOfflineAsrStub, createOfflineTtsStub } from '../src/media/offline-stub.js';
import { createMediaStore } from '../src/media/store.js';
import { ingestAudio, renderVoice, readAttachmentMetadata } from '../src/media/pipeline.js';

function tmpRoot(prefix = 'companion-media-hardening-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
  }
}

function audioInput(overrides = {}) {
  return { kind: 'audio', mime: 'audio/ogg', size: 4, ref: 'tmp://audio-1', ...overrides };
}

test('contract validators reject non-objects and out-of-range metadata with stable codes', () => {
  const base = audioInput();
  assert.equal(validateAudioInput([]).ok, false);
  assert.deepEqual(
    validateAudioInput({ ...base, ref: 'x'.repeat(MAX_REF_CHARS + 1) }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_REF],
  );
  assert.deepEqual(
    validateAudioInput({ ...base, bytes: new Uint8Array(4) }).value.bytes?.byteLength,
    4,
  );
  assert.equal(
    validateAudioInput({ ...base, bytes: new ArrayBuffer(4) }).value.bytes?.byteLength,
    4,
  );

  assert.equal(validateTranscript(null).ok, false);
  assert.deepEqual(
    validateTranscript({ text: 'hi', confidence: 0.5, language: 'x'.repeat(17) }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_TRANSCRIPT],
  );
  assert.deepEqual(
    validateTranscript({ text: 'hi', confidence: 0.5, provider: 'p'.repeat(65) }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_TRANSCRIPT],
  );
  assert.deepEqual(
    validateTranscript({ text: 'hi', confidence: 0.5, durationMs: -1 }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_TRANSCRIPT],
  );
  const full = validateTranscript({
    text: ' hi ',
    confidence: 0,
    language: ' zh ',
    provider: ' stub ',
    durationMs: 10,
  });
  assert.equal(full.ok, true);
  assert.equal(full.value.language, 'zh');
  assert.equal(full.value.provider, 'stub');
  assert.equal(full.value.durationMs, 10);

  assert.equal(validateTtsRequest(null).ok, false);
  assert.equal(validateTtsRequest({ text: 'hi', format: 'MP3' }).value.format, 'mp3');
  assert.deepEqual(
    validateTtsRequest({ text: 'hi', format: 42 }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_INPUT],
  );
  assert.equal(validateTtsRequest({ text: 'hi', voice: ' v ' }).value.voice, 'v');
  assert.equal(validateTtsRequest({ text: 'hi', voice: '   ' }).ok, false);

  assert.equal(validateMediaArtifact(null).ok, false);
  const artifact = {
    ref: 'media://123e4567-e89b-12d3-a456-426614174000',
    kind: 'audio-input',
    mime: 'audio/ogg',
    bytes: 1,
    sha256: 'a'.repeat(64),
  };
  assert.deepEqual(
    validateMediaArtifact({ ...artifact, kind: '' }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_INPUT],
  );
  assert.deepEqual(
    validateMediaArtifact({ ...artifact, mime: '' }).errors.map((error) => error.code),
    [MEDIA_ERROR.UNSUPPORTED_MIME],
  );
  assert.deepEqual(
    validateMediaArtifact({ ...artifact, createdAt: -1 }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_INPUT],
  );
  assert.deepEqual(
    validateMediaArtifact({ ...artifact, expiresAt: -1 }).errors.map((error) => error.code),
    [MEDIA_ERROR.INVALID_INPUT],
  );
  const stamped = validateMediaArtifact({ ...artifact, createdAt: 1, expiresAt: 2 });
  assert.equal(stamped.ok, true);
  assert.equal(stamped.value.createdAt, 1);
  assert.equal(stamped.value.expiresAt, 2);

  assert.equal(mimeForFormat('MP3'), 'audio/mpeg');
  assert.deepEqual(toStructuredError([], 'fallback'), { code: 'fallback', message: 'media request is invalid' });
  assert.deepEqual(
    toStructuredError([{ code: 'first', message: 'first message' }]),
    { code: 'first', message: 'first message' },
  );
});

test('capability probe tolerates adapters whose self-description throws', () => {
  const asr = {
    provider: 'probe-asr',
    transcribe() {},
    describe() { throw new Error('describe offline'); },
  };
  const tts = {
    offline: true,
    synthesize() {},
    describe() { return { provider: '   ' }; },
  };
  const report = probeMediaCapabilities({ asr, tts, now: 'not-a-function' });
  assert.equal(report.version, MEDIA_CONTRACT_VERSION);
  assert.equal(report.asr.available, true);
  assert.equal(report.asr.adapter, 'probe-asr');
  assert.equal(report.asr.offline, false);
  assert.equal(report.asr.reason, 'adapter-injected');
  assert.equal(report.tts.available, true);
  assert.equal(report.tts.adapter, 'injected');
  assert.equal(report.tts.offline, true);
  assert.equal(report.tts.reason, 'offline-stub');
  assert.equal('checkedAt' in report, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.asr), true);
  assert.equal(AUDIO_INPUT_SCHEMA.properties.mime.enum.includes('audio/ogg'), true);
});

test('media store rejects invalid constructor options and non-string mime without writing', () => {
  assert.throws(() => createMediaStore({ now: 1 }), /now must be a function/);
  assert.throws(() => createMediaStore({ retentionMs: 0 }), /retentionMs/);
  assert.throws(() => createMediaStore({ maxBytes: 0 }), /maxBytes/);
  assert.throws(() => createMediaStore({ maxEntries: 0 }), /maxEntries/);

  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    assert.throws(
      () => store.put({ bytes: Buffer.from('x'), mime: 42 }),
      (error) => error.code === MEDIA_ERROR.INVALID_INPUT,
    );
    const unfiled = store.put({ bytes: Buffer.from('x'), kind: 'audio-input' });
    assert.equal(unfiled.mime, 'application/octet-stream');
    const view = store.put({ bytes: new Uint8Array([1, 2]), mime: 'audio/ogg' });
    const arrayBuffer = store.put({ bytes: new ArrayBuffer(3), mime: 'audio/ogg' });
    assert.equal(view.bytes, 2);
    assert.equal(arrayBuffer.bytes, 3);
    assert.equal(store.stats().entries, 3);
  } finally {
    cleanup(root);
  }
});

test('media store enforces maxEntries, purges expired entries and reports store-full', () => {
  const root = tmpRoot();
  let now = 500;
  try {
    const store = createMediaStore({ root, now: () => now, retentionMs: 100, maxEntries: 1 });
    const first = store.put({ bytes: Buffer.from('a'), mime: 'audio/ogg' });
    assert.throws(
      () => store.put({ bytes: Buffer.from('b'), mime: 'audio/ogg' }),
      (error) => error.code === MEDIA_ERROR.STORE_FULL,
    );
    now += 101;
    const second = store.put({ bytes: Buffer.from('b'), mime: 'audio/ogg' });
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.audit().filter((entry) => entry.outcome === 'deleted').length, 1);
    assert.equal(store.delete(second.ref).deleted, true);
    assert.equal(store.delete(first.ref).code, MEDIA_ERROR.NOT_FOUND);
  } finally {
    cleanup(root);
  }
});

test('media store surfaces write failures as store-failed and removes stale temp files', () => {
  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    cleanup(root);
    fs.writeFileSync(root, 'blocker');
    assert.throws(
      () => store.put({ bytes: Buffer.from('x'), mime: 'audio/ogg' }),
      (error) => error.code === MEDIA_ERROR.STORE_FAILED,
    );
    assert.equal(store.list().length, 0);
  } finally {
    cleanup(root);
  }
});

test('media store reports delete failures with an audit trail and keeps the entry', () => {
  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    const artifact = store.put({ bytes: Buffer.from('x'), mime: 'audio/ogg' });
    const id = artifact.ref.slice('media://'.length);
    const file = path.join(root, `${id}.bin`);
    fs.rmSync(file);
    fs.mkdirSync(file);
    const failed = store.delete(artifact.ref, 'cleanup');
    assert.equal(failed.ok, false);
    assert.equal(failed.deleted, false);
    assert.equal(failed.code, MEDIA_ERROR.STORE_FAILED);
    assert.equal(failed.audit.outcome, 'failed');
    assert.equal(failed.audit.reason, 'cleanup');
    assert.equal(store.list().length, 1);
  } finally {
    cleanup(root);
  }
});

test('media store refuses artifacts whose metadata falls outside the contract', () => {
  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    const longMime = `audio/${'a'.repeat(130)}`;
    assert.throws(
      () => store.put({ bytes: Buffer.from('x'), mime: longMime }),
      (error) => error.code === MEDIA_ERROR.INVALID_INPUT,
    );
    assert.equal(store.list().length, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    cleanup(root);
  }
});

test('offline ASR stub validates its options and reports structured failures', async () => {
  assert.throws(() => createOfflineAsrStub({ transcripts: 'nope' }), /transcripts must be an array/);
  assert.throws(() => createOfflineAsrStub({ transcripts: [null] }), /transcripts\[0\]/);
  assert.throws(() => createOfflineAsrStub({ delayMs: -1 }), /delayMs/);

  const stub = createOfflineAsrStub({ transcripts: ['ok', { text: 'full', confidence: 0.4, language: 'zh', provider: 'p' }] });
  assert.equal(stub.describe().queued, 2);
  await assert.rejects(stub.transcribe({}), (error) => error.code === MEDIA_ERROR.INVALID_INPUT);
  const first = await stub.transcribe({ ref: 'tmp://a' });
  assert.equal(first.text, 'ok');
  assert.equal(first.provider, 'offline-asr-stub');
  const second = await stub.transcribe({ ref: 'tmp://a' });
  assert.equal(second.language, 'zh');
  assert.equal(second.provider, 'p');
  await assert.rejects(stub.transcribe({ ref: 'tmp://a' }), (error) => error.code === MEDIA_ERROR.ASR_FAILED);

  const cause = Object.assign(new Error('cause'), { code: MEDIA_ERROR.ASR_FAILED });
  const errorStub = createOfflineAsrStub({ transcripts: ['x'], failWith: cause });
  await assert.rejects(
    errorStub.transcribe({ ref: 'tmp://a' }),
    (error) => error.code === MEDIA_ERROR.ASR_FAILED && error.cause === cause,
  );
  const custom = createOfflineAsrStub({ transcripts: ['x'], failWith: 'custom reason' });
  await assert.rejects(custom.transcribe({ ref: 'tmp://a' }), /custom reason/);
  const timeout = createOfflineAsrStub({ transcripts: ['x'], failWith: { code: MEDIA_ERROR.TIMEOUT } });
  await assert.rejects(timeout.transcribe({ ref: 'tmp://a' }), (error) => error.code === MEDIA_ERROR.TIMEOUT);
  const numeric = createOfflineAsrStub({ transcripts: ['x'], failWith: 1 });
  await assert.rejects(numeric.transcribe({ ref: 'tmp://a' }), (error) => error.code === MEDIA_ERROR.ASR_FAILED);
  const boolean = createOfflineAsrStub({ transcripts: ['x'], failWith: true });
  await assert.rejects(boolean.transcribe({ ref: 'tmp://a' }), (error) => error.code === MEDIA_ERROR.ASR_FAILED);
});

test('offline ASR stub completes delayed work and rejects promptly when aborted', async () => {
  const fast = createOfflineAsrStub({ transcripts: ['fast'], delayMs: 1 });
  assert.equal((await fast.transcribe({ ref: 'tmp://a' })).text, 'fast');

  const aborted = new AbortController();
  aborted.abort();
  const already = createOfflineAsrStub({ transcripts: ['late'], delayMs: 10 });
  await assert.rejects(
    already.transcribe({ ref: 'tmp://a' }, { signal: aborted.signal }),
    (error) => error.code === MEDIA_ERROR.TIMEOUT,
  );

  const controller = new AbortController();
  const pending = createOfflineAsrStub({ transcripts: ['late'], delayMs: 1000 })
    .transcribe({ ref: 'tmp://a' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error) => error.code === MEDIA_ERROR.TIMEOUT);
});

test('offline TTS stub validates options and returns only synthetic markers', async () => {
  assert.throws(() => createOfflineTtsStub({ audioRef: '' }), /audioRef/);
  assert.throws(() => createOfflineTtsStub({ format: 'exe' }), /format must be one of/);
  assert.throws(() => createOfflineTtsStub({ delayMs: -1 }), /delayMs/);
  assert.throws(() => createOfflineTtsStub({ bytes: 'nope' }), /bytes must be a Buffer/);

  const stub = createOfflineTtsStub({ audioRef: ' stub://tts ', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(stub.describe().format, 'ogg');
  await assert.rejects(stub.synthesize({}), (error) => error.code === MEDIA_ERROR.INVALID_INPUT);
  const result = await stub.synthesize({ text: 'hello', format: 'mp3' });
  assert.equal(result.audioRef, 'stub://tts');
  assert.equal(result.mime, 'audio/mpeg');
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.durationMs, 500);
  assert.equal(result.bytes.includes(Buffer.from('hello')), false);

  const bufferStub = createOfflineTtsStub({ bytes: Buffer.from('raw') });
  assert.equal((await bufferStub.synthesize({ text: 'x' })).bytes.toString(), 'raw');
  const arrayStub = createOfflineTtsStub({ bytes: new ArrayBuffer(2) });
  assert.equal((await arrayStub.synthesize({ text: 'x' })).bytes.length, 2);
});

test('readAttachmentMetadata handles primitives and binary metadata without parsing content', () => {
  const marker = 'SYNTHETIC-ATTACHMENT-CONTENT';
  assert.equal(readAttachmentMetadata(null).reason, 'unsupported-kind');
  assert.equal(readAttachmentMetadata('not-an-object').kind, 'unknown');
  assert.equal(readAttachmentMetadata({ kind: 'image' }).providerRequired.capability, 'image-input');

  const image = readAttachmentMetadata({ mime: 'image/png', bytes: new Uint8Array(Buffer.from(marker)) });
  assert.equal(image.kind, 'image');
  assert.equal(image.size, Buffer.byteLength(marker));
  assert.equal(JSON.stringify(image).includes(marker), false);

  const audio = readAttachmentMetadata({ mime: 'audio/ogg', bytes: new ArrayBuffer(7) });
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.size, 7);
  assert.equal(audio.reason, 'use-audio-pipeline');

  const negative = readAttachmentMetadata({ kind: 'file', size: -1 });
  assert.equal(negative.size, null);
  const longRef = readAttachmentMetadata({ kind: 'file', size: 1, ref: 'x'.repeat(MAX_REF_CHARS + 1) });
  assert.equal(longRef.ref, null);
});

test('ingestAudio reports temporary-store failures before calling ASR', async () => {
  let calls = 0;
  const asr = { async transcribe() { calls += 1; return { text: 'x', confidence: 0.9 }; } };

  const invalidArtifact = await ingestAudio({
    asr,
    store: { put() { return {}; } },
    input: audioInput({ size: 1, bytes: Buffer.from('x') }),
  });
  assert.equal(invalidArtifact.ok, false);
  assert.equal(invalidArtifact.error.code, MEDIA_ERROR.STORE_FAILED);
  assert.equal(invalidArtifact.recovery.action, 'text-fallback');

  const genericFailure = await ingestAudio({
    asr,
    store: { put() { throw new Error('disk gone'); } },
    input: audioInput({ size: 1, bytes: Buffer.from('x') }),
  });
  assert.equal(genericFailure.error.code, MEDIA_ERROR.STORE_FAILED);
  assert.equal(calls, 0);
});

test('ingestAudio surfaces unsuccessful cleanup and abort-named adapter errors', async () => {
  const cleanupFailure = await ingestAudio({
    asr: createOfflineAsrStub({ transcripts: ['kept'] }),
    store: {
      put() { return { ref: 'media://123e4567-e89b-12d3-a456-426614174000' }; },
      delete() { return { ok: true, deleted: false, code: MEDIA_ERROR.NOT_FOUND }; },
    },
    input: audioInput({ size: 5, bytes: Buffer.from('audio') }),
  });
  assert.equal(cleanupFailure.ok, true);
  assert.equal(cleanupFailure.metadata.temporary.deleted, false);
  assert.equal(cleanupFailure.metadata.temporary.cleanupError, MEDIA_ERROR.NOT_FOUND);

  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  const abortResult = await ingestAudio({
    asr: { async transcribe() { throw aborted; } },
    input: audioInput(),
  });
  assert.equal(abortResult.ok, false);
  assert.equal(abortResult.error.code, MEDIA_ERROR.TIMEOUT);
  assert.equal(abortResult.recovery.retryable, true);
});

test('ingestAudio handles null input, invalid confidence thresholds and timeout clamping', async () => {
  const nullInput = await ingestAudio({ asr: createOfflineAsrStub({ transcripts: ['x'] }), input: null });
  assert.equal(nullInput.ok, false);
  assert.equal(nullInput.error.code, MEDIA_ERROR.INVALID_INPUT);
  assert.equal(nullInput.metadata, null);

  let seen = null;
  const asr = {
    async transcribe(input, options) {
      seen = options;
      return { text: 'clamped', confidence: 0.7 };
    },
  };
  const clamped = await ingestAudio({
    asr,
    input: audioInput({ durationMs: 1000 }),
    timeoutMs: Number.MAX_SAFE_INTEGER,
    minConfidence: 'not-a-number',
  });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.memory.eligible, true);
  assert.equal(clamped.memory.written, false);
  assert.equal(clamped.memory.reason, 'memory-port-missing');
  assert.equal(seen.timeoutMs, 60000);

  const fallbackTimeout = await ingestAudio({ asr, input: audioInput(), timeoutMs: 0 });
  assert.equal(fallbackTimeout.ok, true);
  assert.equal(seen.timeoutMs, 15000);
});

test('ingestAudio keeps transcript content out of result metadata and audits', async () => {
  const root = tmpRoot();
  const marker = 'SYNTHETIC-AUDIO-CONTENT-DO-NOT-ECHO';
  try {
    const store = createMediaStore({ root });
    const result = await ingestAudio({
      asr: createOfflineAsrStub({ transcripts: ['hi'] }),
      store,
      input: audioInput({ size: Buffer.byteLength(marker), bytes: Buffer.from(marker) }),
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(JSON.stringify(store.audit()).includes(marker), false);
  } finally {
    cleanup(root);
  }
});

test('renderVoice keeps a text fallback for empty, non-string and invalid requests', async () => {
  const tts = createOfflineTtsStub();

  const blank = await renderVoice({ tts, text: '   ' });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, MEDIA_ERROR.INVALID_INPUT);
  assert.equal(blank.fallbackText, '   ');

  const missing = await renderVoice({ tts, text: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.fallbackText, '');
  assert.equal(missing.audioRef, null);

  const badVoice = await renderVoice({ tts, text: 'hi', voice: 'v'.repeat(65) });
  assert.equal(badVoice.ok, false);
  assert.equal(badVoice.error.code, MEDIA_ERROR.INVALID_INPUT);
  assert.equal(badVoice.fallbackText, 'hi');

  const badFormat = await renderVoice({ tts, text: 'hi', format: 'exe' });
  assert.equal(badFormat.ok, false);
  assert.equal(badFormat.error.code, MEDIA_ERROR.INVALID_INPUT);
});

test('renderVoice supports object humanizers and tolerates non-string results', async () => {
  const humanized = await renderVoice({
    tts: createOfflineTtsStub(),
    humanizer: { humanize: (text) => `H:${text}` },
    text: 'hello',
  });
  assert.equal(humanized.ok, true);
  assert.equal(humanized.fallbackText, 'H:hello');

  const ignored = await renderVoice({
    tts: createOfflineTtsStub(),
    humanizer: { humanize: () => '   ' },
    text: 'original',
  });
  assert.equal(ignored.fallbackText, 'original');
});

test('renderVoice reads ref/mime fallbacks and rejects invalid synthesized bytes', async () => {
  const refOnly = await renderVoice({
    tts: {
      async synthesize() {
        return { ref: ' stub://from-ref ', mime: '' };
      },
    },
    text: 'ref only',
    format: 'mp3',
  });
  assert.equal(refOnly.ok, true);
  assert.equal(refOnly.audioRef, 'stub://from-ref');
  assert.equal(refOnly.mime, 'audio/mpeg');
  assert.equal(refOnly.artifact, null);

  const root = tmpRoot();
  try {
    const store = createMediaStore({ root });
    for (const bytes of ['not-bytes', new ArrayBuffer(2)]) {
      const invalid = await renderVoice({
        tts: { async synthesize() { return { audioRef: 'stub://bad', bytes }; } },
        store,
        text: 'keep this',
      });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, MEDIA_ERROR.TTS_FAILED);
      assert.equal(invalid.fallbackText, 'keep this');
      assert.equal(invalid.audioRef, 'stub://bad');
    }

    const viewStored = await renderVoice({
      tts: { async synthesize() { return { audioRef: 'stub://view', bytes: new Uint8Array([9, 8]) }; } },
      store,
      text: 'view bytes',
    });
    assert.equal(viewStored.ok, true);
    assert.equal(viewStored.artifact.bytes, 2);
    assert.equal(store.list().length, 1);
  } finally {
    cleanup(root);
  }
});

test('renderVoice reports invalid or full stores without dropping the text fallback', async () => {
  const invalidArtifact = await renderVoice({
    tts: createOfflineTtsStub(),
    store: { put() { return {}; } },
    text: 'still here',
  });
  assert.equal(invalidArtifact.ok, false);
  assert.equal(invalidArtifact.error.code, MEDIA_ERROR.STORE_FAILED);
  assert.equal(invalidArtifact.fallbackText, 'still here');
  assert.equal(invalidArtifact.audioRef, 'stub://audio');

  const full = await renderVoice({
    tts: createOfflineTtsStub(),
    store: {
      put() {
        const error = new Error('full');
        error.code = MEDIA_ERROR.STORE_FULL;
        throw error;
      },
    },
    text: 'still here',
  });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, MEDIA_ERROR.STORE_FULL);
  assert.equal(full.fallbackText, 'still here');
});