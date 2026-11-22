import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MEDIA_CONTRACT_VERSION,
  AUDIO_INPUT_SCHEMA,
  TRANSCRIPT_SCHEMA,
  TTS_REQUEST_SCHEMA,
  MEDIA_ARTIFACT_SCHEMA,
  MEDIA_ERROR,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  validateAudioInput,
  validateTranscript,
  validateTtsRequest,
  validateMediaArtifact,
  mimeForFormat,
} from '../src/media/contracts.js';
import { createOfflineAsrStub, createOfflineTtsStub } from '../src/media/offline-stub.js';
import { probeMediaCapabilities } from '../src/media/capabilities.js';
import { createMediaStore, MEDIA_STORE_DELETE_REASONS } from '../src/media/store.js';
import { readAttachmentMetadata } from '../src/media/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SRC = path.resolve(HERE, '../src/media');

function codes(result) {
  return result.errors.map((error) => error.code);
}

test('media contracts expose versioned, frozen schemas without provider coupling', () => {
  assert.equal(MEDIA_CONTRACT_VERSION, 1);
  for (const schema of [AUDIO_INPUT_SCHEMA, TRANSCRIPT_SCHEMA, TTS_REQUEST_SCHEMA, MEDIA_ARTIFACT_SCHEMA]) {
    assert.equal(Object.isFrozen(schema), true);
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required));
  }
  assert.ok(Object.isFrozen(AUDIO_INPUT_SCHEMA.properties));
  assert.deepEqual(AUDIO_INPUT_SCHEMA.required, ['mime', 'size', 'ref']);
  assert.deepEqual(TRANSCRIPT_SCHEMA.required, ['text', 'confidence']);
  assert.deepEqual(TTS_REQUEST_SCHEMA.required, ['text']);
  assert.deepEqual(MEDIA_ARTIFACT_SCHEMA.required, ['ref', 'kind', 'mime', 'bytes', 'sha256']);
});

test('validateAudioInput accepts valid input without mutating it', () => {
  const bytes = Buffer.from('fake');
  const input = Object.freeze({
    kind: 'audio',
    mime: 'AUDIO/OGG',
    size: bytes.length,
    durationMs: 1000,
    ref: 'tmp://audio-1',
    bytes,
  });
  const before = JSON.stringify(input);
  const result = validateAudioInput(input);
  assert.equal(result.ok, true);
  assert.equal(result.value.kind, 'audio');
  assert.equal(result.value.mime, 'audio/ogg');
  assert.equal(result.value.size, bytes.length);
  assert.equal(result.value.durationMs, 1000);
  assert.equal(result.value.bytes, bytes);
  assert.equal(JSON.stringify(input), before);
});

test('validateAudioInput returns structured codes for bad format, size, duration and kind', () => {
  const base = { kind: 'audio', mime: 'audio/ogg', size: 4, ref: 'tmp://audio-1' };
  assert.deepEqual(codes(validateAudioInput({ ...base, mime: 'video/mp4' })), [MEDIA_ERROR.UNSUPPORTED_MIME]);
  assert.deepEqual(codes(validateAudioInput({ ...base, size: MAX_AUDIO_BYTES + 1 })), [MEDIA_ERROR.OVERSIZE]);
  assert.deepEqual(codes(validateAudioInput({ ...base, size: 0 })), [MEDIA_ERROR.INVALID_SIZE]);
  assert.deepEqual(codes(validateAudioInput({ ...base, ref: '   ' })), [MEDIA_ERROR.INVALID_REF]);
  assert.deepEqual(codes(validateAudioInput({ ...base, durationMs: MAX_AUDIO_DURATION_MS + 1 })), [MEDIA_ERROR.TOO_LONG]);
  assert.deepEqual(codes(validateAudioInput({ ...base, durationMs: 0 })), [MEDIA_ERROR.INVALID_DURATION]);
  assert.deepEqual(codes(validateAudioInput({ ...base, bytes: Buffer.from('toolong') })), [MEDIA_ERROR.SIZE_MISMATCH]);
  assert.deepEqual(codes(validateAudioInput({ ...base, bytes: 'not-bytes' })), [MEDIA_ERROR.INVALID_INPUT]);
  assert.equal(codes(validateAudioInput({ ...base, kind: 'image', mime: 'image/png' }))[0], MEDIA_ERROR.UNSUPPORTED_KIND);
  assert.deepEqual(codes(validateAudioInput(null)), [MEDIA_ERROR.INVALID_INPUT]);
});

test('validateTranscript enforces confidence range and defaults metadata', () => {
  const valid = validateTranscript({ text: '你好', confidence: 0.8 });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.language, 'und');
  assert.equal(valid.value.provider, 'unknown');

  assert.deepEqual(codes(validateTranscript({ text: '你好', confidence: 1.2 })), [MEDIA_ERROR.INVALID_CONFIDENCE]);
  assert.deepEqual(codes(validateTranscript({ text: '你好', confidence: Number.NaN })), [MEDIA_ERROR.INVALID_CONFIDENCE]);
  assert.deepEqual(codes(validateTranscript({ text: '   ', confidence: 0.8 })), [MEDIA_ERROR.INVALID_TRANSCRIPT]);
  assert.deepEqual(codes(validateTranscript({ text: 'x'.repeat(4001), confidence: 0.8 })), [MEDIA_ERROR.TOO_LONG]);
});

test('validateTtsRequest enforces text limits and format allowlist', () => {
  const valid = validateTtsRequest({ text: '说点什么' });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.format, 'ogg');
  assert.equal(valid.value.voice, undefined);

  assert.deepEqual(codes(validateTtsRequest({ text: '' })), [MEDIA_ERROR.INVALID_INPUT]);
  assert.deepEqual(codes(validateTtsRequest({ text: 'x'.repeat(2001) })), [MEDIA_ERROR.TOO_LONG]);
  assert.deepEqual(codes(validateTtsRequest({ text: 'hi', format: 'exe' })), [MEDIA_ERROR.INVALID_INPUT]);
  assert.deepEqual(codes(validateTtsRequest({ text: 'hi', voice: 'v'.repeat(65) })), [MEDIA_ERROR.INVALID_INPUT]);
});

test('validateMediaArtifact checks sha256 and non-negative size', () => {
  const artifact = {
    ref: 'media://123e4567-e89b-12d3-a456-426614174000',
    kind: 'audio-input',
    mime: 'audio/ogg',
    bytes: 3,
    sha256: 'a'.repeat(64),
  };
  assert.equal(validateMediaArtifact(artifact).ok, true);
  assert.deepEqual(codes(validateMediaArtifact({ ...artifact, sha256: 'ABC' })), [MEDIA_ERROR.INVALID_INPUT]);
  assert.deepEqual(codes(validateMediaArtifact({ ...artifact, bytes: -1 })), [MEDIA_ERROR.INVALID_SIZE]);
  assert.deepEqual(codes(validateMediaArtifact({ ...artifact, ref: '' })), [MEDIA_ERROR.INVALID_REF]);
});

test('mimeForFormat maps only the declared TTS formats', () => {
  assert.equal(mimeForFormat('ogg'), 'audio/ogg');
  assert.equal(mimeForFormat('opus'), 'audio/opus');
  assert.equal(mimeForFormat('wav'), 'audio/wav');
  assert.equal(mimeForFormat('mp3'), 'audio/mpeg');
  assert.equal(mimeForFormat('exe'), null);
});

test('readAttachmentMetadata is provider-required for image/file and never echoes content', () => {
  const marker = 'SYNTHETIC-IMAGE-CONTENT-DO-NOT-PARSE';
  const image = readAttachmentMetadata({
    kind: 'image',
    mime: 'image/png',
    bytes: Buffer.from(marker),
    ref: 'tmp://image-1',
    text: marker,
  });
  assert.equal(image.supported, false);
  assert.equal(image.reason, 'provider-required');
  assert.equal(image.kind, 'image');
  assert.equal(image.size, Buffer.byteLength(marker));
  assert.equal(image.capabilities.vision, false);
  assert.equal(image.providerRequired.capability, 'image-input');
  assert.equal(image.providerRequired.requiresUserDecision, 'U2');
  assert.equal(JSON.stringify(image).includes(marker), false);

  const file = readAttachmentMetadata({ kind: 'file', mime: 'application/pdf', size: 10, ref: 'tmp://file-1' });
  assert.equal(file.supported, false);
  assert.equal(file.reason, 'provider-required');
  assert.equal(file.providerRequired.capability, 'file-input');

  const audio = readAttachmentMetadata({ kind: 'audio', mime: 'audio/ogg', size: 10, ref: 'tmp://audio-1' });
  assert.equal(audio.supported, false);
  assert.equal(audio.reason, 'use-audio-pipeline');

  const unknown = readAttachmentMetadata({ kind: 'archive', mime: 'application/zip', size: 10 });
  assert.equal(unknown.supported, false);
  assert.equal(unknown.reason, 'unsupported-kind');
});

test('capability probe reports only injected adapters and keeps image/file provider-required', () => {
  const empty = probeMediaCapabilities();
  assert.equal(empty.version, MEDIA_CONTRACT_VERSION);
  assert.equal(empty.asr.available, false);
  assert.equal(empty.asr.reason, 'provider-required');
  assert.equal(empty.tts.available, false);
  assert.equal(empty.image.available, false);
  assert.equal(empty.image.reason, 'provider-required');
  assert.equal(empty.file.available, false);

  const report = probeMediaCapabilities({
    asr: createOfflineAsrStub({ transcripts: ['hi'] }),
    tts: createOfflineTtsStub(),
    now: () => 1234,
  });
  assert.equal(report.asr.available, true);
  assert.equal(report.asr.offline, true);
  assert.equal(report.asr.adapter, 'offline-asr-stub');
  assert.equal(report.tts.available, true);
  assert.equal(report.tts.adapter, 'offline-tts-stub');
  assert.equal(report.image.available, false);
  assert.equal(report.checkedAt, 1234);
});

test('media store writes temp files, audits put/delete and never records bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-store-'));
  let now = 1000;
  try {
    const store = createMediaStore({ root, now: () => now, retentionMs: 5000 });
    const payload = Buffer.from('synthetic-audio-payload');
    const artifact = store.put({ bytes: payload, mime: 'audio/ogg', kind: 'audio-input' });

    assert.match(artifact.ref, /^media:\/\/[0-9a-f-]{36}$/);
    assert.equal(artifact.bytes, payload.length);
    assert.equal(artifact.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(artifact.expiresAt, 6000);
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.stats().bytes, payload.length);

    const putAudit = store.audit().at(-1);
    assert.equal(putAudit.action, 'put');
    assert.equal(putAudit.ref, artifact.ref);
    assert.equal(JSON.stringify(putAudit).includes(payload.toString()), false);

    const deleted = store.delete(artifact.ref);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.audit.action, 'delete');
    assert.equal(deleted.audit.outcome, 'deleted');
    assert.equal(store.list().length, 0);

    const again = store.delete(artifact.ref);
    assert.equal(again.ok, true);
    assert.equal(again.deleted, false);
    assert.equal(again.code, MEDIA_ERROR.NOT_FOUND);
    assert.equal(again.audit.outcome, 'not-found');

    const expiring = store.put({ bytes: Buffer.from('short-lived'), mime: 'audio/ogg', ttlMs: 10 });
    now = 1100;
    const purged = store.purgeExpired();
    assert.equal(purged.removed, 1);
    assert.deepEqual(purged.refs, [expiring.ref]);
    assert.equal(store.list().length, 0);
    assert.ok(store.audit().some((entry) => entry.action === 'delete' && entry.reason === 'expired'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media store rejects oversized, empty and unsafe payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-store-'));
  try {
    const store = createMediaStore({ root, maxBytes: 4 });
    assert.throws(() => store.put({ bytes: Buffer.from('12345'), mime: 'audio/ogg' }), (error) => error.code === MEDIA_ERROR.OVERSIZE);
    assert.throws(() => store.put({ bytes: Buffer.alloc(0), mime: 'audio/ogg' }), (error) => error.code === MEDIA_ERROR.INVALID_INPUT);
    assert.throws(() => store.put({ bytes: 'not-bytes', mime: 'audio/ogg' }), (error) => error.code === MEDIA_ERROR.INVALID_INPUT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media store rejects arbitrary kind/mime before writing an audit entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-store-'));
  try {
    const store = createMediaStore({ root });
    const bytes = Buffer.from('x');
    assert.throws(
      () => store.put({ bytes, kind: 'secret kind text', mime: 'audio/ogg' }),
      (error) => error.code === MEDIA_ERROR.INVALID_INPUT,
    );
    assert.throws(
      () => store.put({ bytes, kind: 'audio-input', mime: 'secret mime text' }),
      (error) => error.code === MEDIA_ERROR.INVALID_INPUT,
    );
    assert.throws(
      () => store.put({ bytes, kind: 'audio-input', mime: 'audio/ogg; codecs=opus' }),
      (error) => error.code === MEDIA_ERROR.INVALID_INPUT,
    );
    assert.equal(store.audit().length, 0);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media store sanitizes invalid delete refs/reasons and keeps whitelisted reason codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-store-'));
  try {
    const store = createMediaStore({ root });
    assert.deepEqual(MEDIA_STORE_DELETE_REASONS, ['delete', 'expired', 'cleanup']);

    const bad = store.delete('secret ref text', 'secret reason text');
    assert.equal(bad.ok, true);
    assert.equal(bad.deleted, false);
    assert.equal(bad.code, MEDIA_ERROR.NOT_FOUND);
    assert.equal(bad.audit.ref, 'invalid');
    assert.equal(bad.audit.reason, 'invalid');
    const badText = JSON.stringify(bad.audit);
    assert.equal(badText.includes('secret ref text'), false);
    assert.equal(badText.includes('secret reason text'), false);

    const validRef = 'media://123e4567-e89b-12d3-a456-426614174000';
    const unknown = store.delete(validRef, 'because-user-said-secret');
    assert.equal(unknown.audit.ref, validRef);
    assert.equal(unknown.audit.reason, 'invalid');

    const artifact = store.put({ bytes: Buffer.from('x'), kind: 'audio-input', mime: 'audio/ogg' });
    const deleted = store.delete(artifact.ref, 'cleanup');
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.audit.reason, 'cleanup');

    const numeric = store.delete(12345, 'expired');
    assert.equal(numeric.audit.ref, 'invalid');
    assert.equal(numeric.audit.reason, 'expired');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media modules have no network, provider SDK or shell imports', () => {
  const files = fs.readdirSync(MEDIA_SRC).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const source = fs.readFileSync(path.join(MEDIA_SRC, name), 'utf8');
    for (const pattern of [/node:https?/, /\bfetch\s*\(/, /node:child_process/, /\brequire\s*\(/, /https?:\/\//]) {
      assert.equal(pattern.test(source), false, `${name} must stay offline`);
    }
  }
});
