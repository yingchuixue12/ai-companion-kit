import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ingestAudio, renderVoice } from '../src/media/pipeline.js';
import { createOfflineAsrStub, createOfflineTtsStub } from '../src/media/offline-stub.js';
import { createMediaStore } from '../src/media/store.js';
import { MEDIA_ERROR, MAX_TTS_CHARS } from '../src/media/contracts.js';

function audioInput(overrides = {}) {
  return {
    kind: 'audio',
    mime: 'audio/ogg',
    size: 5,
    durationMs: 1200,
    ref: 'tmp://audio-1',
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

test('D-01 offline ASR success returns transcript/metadata and does not write without a memory port', async () => {
  const asr = createOfflineAsrStub({
    transcripts: [{ text: '今天有点累', confidence: 0.92, language: 'zh' }],
  });
  const result = await ingestAudio({ asr, input: audioInput() });

  assert.equal(result.ok, true);
  assert.equal(result.transcript.text, '今天有点累');
  assert.equal(result.transcript.confidence, 0.92);
  assert.equal(result.transcript.language, 'zh');
  assert.equal(result.transcript.provider, 'offline-asr-stub');
  assert.equal(result.metadata.mime, 'audio/ogg');
  assert.equal(result.metadata.size, 5);
  assert.equal(result.memory.eligible, true);
  assert.equal(result.memory.written, false);
  assert.equal(result.memory.reason, 'memory-port-missing');
  assert.equal('error' in result, false);
});

test('D-02 ASR failure returns structured ask-repeat and keeps metadata', async () => {
  const asr = createOfflineAsrStub({ transcripts: [], failWith: { code: MEDIA_ERROR.ASR_FAILED } });
  const result = await ingestAudio({ asr, input: audioInput() });

  assert.equal(result.ok, false);
  assert.equal(result.transcript, null);
  assert.equal(result.error.code, MEDIA_ERROR.ASR_FAILED);
  assert.equal(result.recovery.action, 'ask-repeat');
  assert.equal(result.recovery.retryable, true);
  assert.equal(result.metadata.ref, 'tmp://audio-1');
});

test('ASR timeout is structured and does not leak adapter errors', async () => {
  const asr = createOfflineAsrStub({ transcripts: ['too late'], delayMs: 50 });
  const started = Date.now();
  const result = await ingestAudio({ asr, input: audioInput(), timeoutMs: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, MEDIA_ERROR.TIMEOUT);
  assert.equal(result.error.message, 'speech recognition timed out');
  assert.equal(result.recovery.retryable, true);
  assert.ok(Date.now() - started < 500);
});

test('invalid ASR transcript is rejected instead of persisted', async () => {
  const asr = createOfflineAsrStub({ transcripts: [{ text: '   ', confidence: 0.9 }] });
  const result = await ingestAudio({ asr, input: audioInput() });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, MEDIA_ERROR.INVALID_TRANSCRIPT);
  assert.equal(result.recovery.retryable, false);
});

test('ingestAudio rejects image, unsupported mime, oversize and missing ref before calling ASR', async () => {
  let calls = 0;
  const asr = {
    async transcribe() {
      calls += 1;
      return { text: 'nope', confidence: 0.9 };
    },
  };
  const cases = [
    [audioInput({ kind: 'image', mime: 'image/png' }), MEDIA_ERROR.UNSUPPORTED_KIND],
    [audioInput({ mime: 'video/mp4' }), MEDIA_ERROR.UNSUPPORTED_MIME],
    [audioInput({ size: 11 * 1024 * 1024 }), MEDIA_ERROR.OVERSIZE],
    [audioInput({ ref: '' }), MEDIA_ERROR.INVALID_REF],
  ];
  for (const [input, code] of cases) {
    const result = await ingestAudio({ asr, input });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.recovery.action, 'text-fallback');
  }
  assert.equal(calls, 0);
});

test('missing ASR adapter is provider/adapter failure, not a fake transcript', async () => {
  const result = await ingestAudio({ asr: null, input: audioInput() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MEDIA_ERROR.ADAPTER_MISSING);
  assert.equal(result.transcript, null);
});

test('D-04 low-confidence transcript never writes long-term memory unless confirmed', async () => {
  const low = createOfflineAsrStub({ transcripts: [{ text: '听不太清', confidence: 0.2 }] });
  const spy = memorySpy();
  const result = await ingestAudio({ asr: low, input: audioInput(), memory: spy.port });

  assert.equal(result.ok, true);
  assert.equal(result.memory.eligible, false);
  assert.equal(result.memory.written, false);
  assert.equal(result.memory.reason, 'low-confidence-needs-confirmation');
  assert.equal(spy.calls.length, 0);

  const confirmed = await ingestAudio({
    asr: createOfflineAsrStub({ transcripts: [{ text: '听不太清', confidence: 0.2 }] }),
    input: audioInput({ confirmed: true }),
    memory: spy.port,
  });
  assert.equal(confirmed.memory.eligible, true);
  assert.equal(confirmed.memory.written, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].text, '听不太清');
  assert.equal(spy.calls[0].source, 'asr');
});

test('high-confidence transcript writes through the injected memory port only', async () => {
  const asr = createOfflineAsrStub({ transcripts: [{ text: '记住这件事', confidence: 0.9 }] });
  const spy = memorySpy();
  const result = await ingestAudio({ asr, input: audioInput(), memory: spy.port, minConfidence: 0.8 });
  assert.equal(result.memory.written, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].confidence, 0.9);
});

test('memory write failure keeps the transcript and reports a structured reason', async () => {
  const asr = createOfflineAsrStub({ transcripts: [{ text: '保留转写', confidence: 0.9 }] });
  const result = await ingestAudio({
    asr,
    input: audioInput(),
    memory: { async remember() { throw new Error('memory offline'); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transcript.text, '保留转写');
  assert.equal(result.memory.written, false);
  assert.equal(result.memory.reason, 'memory-write-failed');
});

test('temporary input audio is stored, then deleted with an auditable trail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-pipeline-'));
  try {
    const store = createMediaStore({ root });
    const payload = Buffer.from('synthetic-input-audio');
    const result = await ingestAudio({
      asr: createOfflineAsrStub({ transcripts: ['收到'] }),
      store,
      input: audioInput({ size: payload.length, bytes: payload }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.metadata.temporary.deleted, true);
    assert.equal(result.metadata.temporary.retained, false);
    assert.match(result.metadata.temporary.ref, /^media:\/\/[0-9a-f-]{36}$/);
    assert.equal(store.list().length, 0);
    assert.deepEqual(store.audit().map((entry) => entry.action), ['put', 'delete']);
    assert.equal(store.audit().at(-1).outcome, 'deleted');
    assert.equal(JSON.stringify(store.audit()).includes(payload.toString()), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('temporary input audio is deleted even when ASR fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-pipeline-'));
  try {
    const store = createMediaStore({ root });
    const payload = Buffer.from('failing-input-audio');
    const result = await ingestAudio({
      asr: createOfflineAsrStub({ transcripts: [], failWith: { code: MEDIA_ERROR.ASR_FAILED } }),
      store,
      input: audioInput({ size: payload.length, bytes: payload }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.metadata.temporary.deleted, true);
    assert.equal(store.list().length, 0);
    assert.deepEqual(store.audit().map((entry) => entry.action), ['put', 'delete']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retainInput keeps the temporary audio for an explicit later delete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-pipeline-'));
  try {
    const store = createMediaStore({ root });
    const payload = Buffer.from('retained-audio');
    const result = await ingestAudio({
      asr: createOfflineAsrStub({ transcripts: ['保留'] }),
      store,
      input: audioInput({ size: payload.length, bytes: payload }),
      retainInput: true,
    });
    assert.equal(result.metadata.temporary.retained, true);
    assert.equal(result.metadata.temporary.deleted, false);
    assert.equal(store.list().length, 1);
    const deletion = store.delete(result.metadata.temporary.ref);
    assert.equal(deletion.deleted, true);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('temporary audio cleanup failure is surfaced without losing the transcript', async () => {
  const fakeStore = {
    put() {
      return { ref: 'media://123e4567-e89b-12d3-a456-426614174000' };
    },
    delete() {
      throw new Error('delete unavailable');
    },
  };
  const result = await ingestAudio({
    asr: createOfflineAsrStub({ transcripts: ['仍然保留'] }),
    store: fakeStore,
    input: audioInput({ bytes: Buffer.from('audio') }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.transcript.text, '仍然保留');
  assert.equal(result.metadata.temporary.deleted, false);
  assert.equal(result.metadata.temporary.cleanupError, MEDIA_ERROR.STORE_FAILED);
});

test('temporary audio store failure aborts before ASR and returns store-failed', async () => {
  let calls = 0;
  const result = await ingestAudio({
    asr: { async transcribe() { calls += 1; return { text: 'x', confidence: 0.9 }; } },
    store: { put() { const error = new Error('no space'); error.code = MEDIA_ERROR.STORE_FULL; throw error; } },
    input: audioInput({ bytes: Buffer.from('audio') }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MEDIA_ERROR.STORE_FULL);
  assert.equal(calls, 0);
});

test('D-03 TTS success keeps fallback text and can persist synthesized audio', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-pipeline-'));
  try {
    const store = createMediaStore({ root });
    const tts = createOfflineTtsStub({ audioRef: 'stub://tts-1' });
    const result = await renderVoice({
      tts,
      humanizer: (text) => text.replace(/\n/g, ' '),
      text: '第一行\n第二行',
      store,
    });

    assert.equal(result.ok, true);
    assert.equal(result.fallbackText, '第一行 第二行');
    assert.equal(result.audioRef, 'stub://tts-1');
    assert.equal(result.mime, 'audio/ogg');
    assert.equal(store.list().length, 1);
    assert.equal(store.audit().at(-1).action, 'put');
    assert.equal(result.artifact.sha256.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-03 TTS failure always retains the text fallback', async () => {
  const tts = createOfflineTtsStub({ failWith: { code: MEDIA_ERROR.TTS_FAILED } });
  const result = await renderVoice({ tts, humanizer: (text) => text.trim(), text: '  回复不能丢  ' });

  assert.equal(result.ok, false);
  assert.equal(result.fallbackText, '回复不能丢');
  assert.equal(result.audioRef, null);
  assert.equal(result.error.code, MEDIA_ERROR.TTS_FAILED);
});

test('TTS timeout, missing adapter, oversized text and invalid result keep fallback text', async () => {
  const slow = createOfflineTtsStub({ delayMs: 50 });
  const timeout = await renderVoice({ tts: slow, text: '慢一点', timeoutMs: 5 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, MEDIA_ERROR.TIMEOUT);
  assert.equal(timeout.fallbackText, '慢一点');

  const missing = await renderVoice({ tts: null, text: '没有适配器' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, MEDIA_ERROR.ADAPTER_MISSING);
  assert.equal(missing.fallbackText, '没有适配器');

  const longText = 'x'.repeat(MAX_TTS_CHARS + 1);
  const tooLong = await renderVoice({ tts: createOfflineTtsStub(), text: longText });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, MEDIA_ERROR.TOO_LONG);
  assert.equal(tooLong.fallbackText, longText);

  const invalid = await renderVoice({ tts: { async synthesize() { return {}; } }, text: '空结果' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, MEDIA_ERROR.TTS_FAILED);
  assert.equal(invalid.fallbackText, '空结果');
});

test('humanizer failure falls back to the original text instead of dropping the reply', async () => {
  const result = await renderVoice({
    tts: createOfflineTtsStub(),
    humanizer: () => { throw new Error('humanizer offline'); },
    text: '原样回复',
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackText, '原样回复');
});

test('TTS store failure keeps text and reports store-failed', async () => {
  const result = await renderVoice({
    tts: createOfflineTtsStub(),
    store: { put() { throw new Error('store offline'); } },
    text: '文字还在',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MEDIA_ERROR.STORE_FAILED);
  assert.equal(result.fallbackText, '文字还在');
});
