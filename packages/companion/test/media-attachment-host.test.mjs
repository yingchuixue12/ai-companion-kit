import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTACHMENT_HOST_VERSION,
  createAttachmentHost,
  inspectAttachmentMetadata,
} from '../src/media/attachment-host.js';
import {
  createAttachmentHost as createAttachmentHostFromLib,
  inspectAttachmentMetadata as inspectAttachmentMetadataFromLib,
} from '../src/lib.js';

const SECRET = 'SYNTHETIC-ATTACHMENT-CONTENT-MUST-NOT-LEAK';
const SECRET_PATH = '/home/user/secret/photo.png';
const SECRET_URL = 'https://secret.example/private/photo.png';
const SECRET_TITLE = 'private-photo-title';
const SECRET_ACCOUNT = 'account-123456';

function assertNoSensitiveText(value) {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, SECRET_PATH, SECRET_URL, SECRET_TITLE, SECRET_ACCOUNT]) {
    assert.equal(text.includes(secret), false, `result must not echo ${secret}`);
  }
}

test('image metadata is provider-required and never reads path, URL, title, account, content or bytes', () => {
  const neverRead = (name) => ({
    get() {
      throw new Error(`${name} must not be read`);
    },
  });
  const input = {
    kind: 'image',
    mime: 'image/png; name=/secret/photo.png',
    size: 12,
    ...neverRead('bytes'),
    ...neverRead('ref'),
    ...neverRead('url'),
    ...neverRead('title'),
    ...neverRead('account'),
    ...neverRead('text'),
  };

  const result = inspectAttachmentMetadata(input);

  assert.equal(result.kind, 'image');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.size, 12);
  assert.equal(result.ref, null);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'provider-required');
  assert.deepEqual(result.capabilities, { vision: false, contentParsing: false });
  assert.deepEqual(result.providerRequired, {
    capability: 'image-input',
    reason: 'provider-required',
    requiresUserDecision: 'U2',
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'capabilities',
    'kind',
    'mime',
    'providerRequired',
    'reason',
    'ref',
    'size',
    'supported',
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
  assert.equal(Object.isFrozen(result.providerRequired), true);
  assertNoSensitiveText(result);
});

test('file metadata is provider-required and computes size from bytes without parsing them', () => {
  const result = inspectAttachmentMetadata({
    kind: 'file',
    mime: 'APPLICATION/PDF',
    bytes: Buffer.from(SECRET),
    ref: SECRET_PATH,
    url: SECRET_URL,
    title: SECRET_TITLE,
    account: SECRET_ACCOUNT,
    text: SECRET,
  });

  assert.equal(result.kind, 'file');
  assert.equal(result.mime, 'application/pdf');
  assert.equal(result.size, Buffer.byteLength(SECRET));
  assert.equal(result.ref, null);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'provider-required');
  assert.deepEqual(result.providerRequired, {
    capability: 'file-input',
    reason: 'provider-required',
    requiresUserDecision: 'U2',
  });
  assertNoSensitiveText(result);
});

test('kind can be inferred from safe image/audio mime but never from arbitrary file mime', () => {
  const image = inspectAttachmentMetadata({ mime: 'image/jpeg', size: 1 });
  assert.equal(image.kind, 'image');
  assert.equal(image.providerRequired.capability, 'image-input');

  const audio = inspectAttachmentMetadata({ mime: 'audio/ogg', size: 1 });
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.reason, 'use-audio-pipeline');
  assert.equal(audio.providerRequired, null);

  const archive = inspectAttachmentMetadata({ mime: 'application/zip', size: 1 });
  assert.equal(archive.kind, 'unknown');
  assert.equal(archive.reason, 'unsupported-kind');
  assert.equal(archive.providerRequired, null);
});

test('non-attachments and malformed metadata stay supported:false without leaking or throwing', () => {
  for (const input of [null, undefined, 'not-an-object', 42, [], { kind: 'archive', mime: 'application/zip' }]) {
    const result = inspectAttachmentMetadata(input);
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'unsupported-kind');
    assert.equal(result.ref, null);
    assert.equal(result.providerRequired, null);
  }

  const negative = inspectAttachmentMetadata({ kind: 'file', size: -1 });
  assert.equal(negative.size, null);
  assert.equal(negative.reason, 'provider-required');

  const invalidMime = inspectAttachmentMetadata({ kind: 'image', mime: 'image/png; title="private"', size: 2 });
  assert.equal(invalidMime.mime, 'image/png');
  assertNoSensitiveText(invalidMime);
});

test('default-off host entry exposes safe metadata without claiming image understanding', () => {
  const host = createAttachmentHost();
  assert.equal(host.kind, 'attachment-host');
  assert.equal(host.version, ATTACHMENT_HOST_VERSION);
  assert.equal(host.enabled, false);
  assert.deepEqual(host.status(), {
    kind: 'attachment-host',
    version: ATTACHMENT_HOST_VERSION,
    enabled: false,
    providerRequired: true,
    parsesContent: false,
    fetches: false,
    readsFiles: false,
    writesMemory: false,
    entersChat: false,
  });

  const image = host.inspect({ kind: 'image', mime: 'image/png', size: 3, ref: SECRET_PATH });
  assert.equal(image.supported, false);
  assert.equal(image.reason, 'provider-required');
  assert.equal(image.ref, null);
  assert.equal(image.capabilities.vision, false);
  assertNoSensitiveText(image);

  const enabled = createAttachmentHost({ enabled: true });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.readMetadata({ kind: 'file', mime: 'application/pdf', size: 1 }), {
    kind: 'file',
    mime: 'application/pdf',
    size: 1,
    ref: null,
    supported: false,
    reason: 'provider-required',
    capabilities: { vision: false, contentParsing: false },
    providerRequired: {
      capability: 'file-input',
      reason: 'provider-required',
      requiresUserDecision: 'U2',
    },
  });

  assert.throws(() => createAttachmentHost({ enabled: 'true' }), /enabled must be a boolean/);
});

test('host entry has no fetch, chat, memory or transcript side effects', () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches += 1;
    throw new Error('fetch must not be called');
  };
  try {
    const result = inspectAttachmentMetadata({
      kind: 'image',
      mime: 'image/png',
      size: Buffer.byteLength(SECRET),
      bytes: Buffer.from(SECRET),
      ref: SECRET_PATH,
      url: SECRET_URL,
    });

    assert.equal(fetches, 0);
    assert.equal(result.supported, false);
    for (const forbidden of ['chat', 'memory', 'transcript', 'messages', 'text', 'bytes']) {
      assert.equal(Object.hasOwn(result, forbidden), false, `result must not expose ${forbidden}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public lib.js export points at the same safe host entry', () => {
  assert.equal(createAttachmentHostFromLib, createAttachmentHost);
  assert.equal(inspectAttachmentMetadataFromLib, inspectAttachmentMetadata);

  const result = inspectAttachmentMetadataFromLib({ kind: 'image', mime: 'image/png', size: 1, ref: SECRET_PATH });
  assert.equal(result.reason, 'provider-required');
  assert.equal(result.ref, null);
  assertNoSensitiveText(result);
});