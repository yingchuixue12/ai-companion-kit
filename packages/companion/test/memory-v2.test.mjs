import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MemoryStore, MemoryStoreError } from '../src/memory/store.js';

/**
 * v2 存储的离线边界：append-only、tombstone 优先、可重建 index、
 * 读取结构化降级、写失败抛错、未知字段保留、删除事实不可复活。
 * 只用合成记录与临时目录，不接 Memory / Brain / 入口。
 */

const FIXED_NOW_ISO = '2030-01-01T00:00:00.000Z';
const T1 = '2023-11-14T22:13:20.000Z';

function tempDir(t, prefix = 'companion-memory-v2-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function record(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    subjectId: 'u1',
    layer: 'user_fact',
    kind: 'trait',
    text: 'text-' + id,
    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'test' }] },
    observedAt: T1,
    recordedAt: T1,
    lastConfirmedAt: null,
    confidence: 0.5,
    stability: 'stable',
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null },
    ...overrides,
  };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

test('missing store degrades explicitly and the first append creates append-only files', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });

  const missing = store.read();
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'missing');
  assert.deepEqual(missing.degraded, { reason: 'store-missing', fallback: 'v1' });
  assert.deepEqual(missing.records, []);
  assert.equal(missing.counts.records, 0);
  assert.equal(missing.checksum, sha256Text(''));
  assert.equal(store.readIndex(), null);
  assert.throws(() => new MemoryStore(), TypeError);

  const result = store.appendRecord(record('a', { futureField: { nested: true } }));
  assert.equal(result.file, store.recordsFile);
  assert.ok(result.bytes > 0);
  assert.equal(fs.existsSync(store.tombstonesFile), false);

  const snapshot = store.read();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.degraded, null);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].futureField.nested, true);
  assert.equal(snapshot.counts.active, 1);
  assert.equal(snapshot.checksum, sha256File(store.recordsFile));

  assert.deepEqual(store.appendBatch({}), { records: 0, tombstones: 0, bytes: 0 });
  const index = store.readIndex();
  assert.ok(index);
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.checksum, snapshot.checksum);
  assert.deepEqual(index.counts, snapshot.counts);

  fs.writeFileSync(store.indexFile, '{ broken', 'utf8');
  assert.equal(store.readIndex(), null);
});

test('write boundary rejects invalid records / tombstones before touching either file', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });

  assert.throws(
    () => store.appendRecord(record('bad', { layer: undefined })),
    (error) => error instanceof MemoryStoreError
      && error.code === 'invalid-record'
      && /layer/.test(error.message),
  );
  assert.equal(fs.existsSync(store.recordsFile), false);
  assert.equal(fs.existsSync(store.tombstonesFile), false);

  assert.throws(
    () => store.appendTombstone({ id: 'x', at: T1, by: 'nobody', reason: 'nope' }),
    (error) => error instanceof MemoryStoreError && error.code === 'invalid-tombstone',
  );
  assert.throws(
    () => store.appendTombstone({}),
    (error) => error instanceof MemoryStoreError && error.code === 'invalid-tombstone',
  );

  // 一条合法 + 一条非法：整批拒绝，合法记录也不能先落盘。
  assert.throws(
    () => store.appendBatch({
      records: [record('ok')],
      tombstones: [{ id: '', at: T1, by: 'user', reason: 'x' }],
    }),
    (error) => error instanceof MemoryStoreError && error.code === 'invalid-tombstone',
  );
  assert.equal(fs.existsSync(store.recordsFile), false);
  assert.equal(fs.existsSync(store.tombstonesFile), false);
  assert.equal(new MemoryStoreError('x').code, 'store-error');

  assert.throws(() => store.transaction(1), TypeError);
  assert.throws(() => store.appendRecord(record('missing-kind', { kind: 'nope' })), MemoryStoreError);
});

test('tombstones are deletion facts and crash-recovered versions never resurrect old records', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });

  store.appendRecord(record('a', { text: 'old' }));
  store.appendRecord(record('b', {
    text: 'new',
    scope: 'private',
    subjectName: '甲',
    privacy: { level: 'restricted', pii: true, redacted: false, retainUntil: null },
    correction: { status: 'active', supersedes: 'a', correctedBy: null, tombstone: null },
  }));
  const recovered = store.read();
  const a = recovered.byId.get('a');
  assert.equal(a.correction.status, 'superseded');
  assert.equal(a.correction.correctedBy, 'b');

  store.appendTombstone({ id: 'b', at: FIXED_NOW_ISO, by: 'user', reason: 'user-request' });
  store.appendTombstone({ id: 'ghost', at: FIXED_NOW_ISO, by: 'user', reason: 'unknown-id' });
  const deleted = store.read();
  assert.equal(deleted.byId.get('b').correction.status, 'deleted');
  assert.equal(deleted.byId.get('b').correction.tombstone.reason, 'user-request');
  assert.equal(deleted.byId.get('b').correction.tombstone.by, 'user');
  // tombstone 覆盖状态时不得顺带改写 scope / privacy / 其他上下文字段。
  assert.equal(deleted.byId.get('b').scope, 'private');
  assert.equal(deleted.byId.get('b').subjectName, '甲');
  assert.equal(deleted.byId.get('b').privacy.level, 'restricted');
  assert.equal(deleted.byId.get('b').privacy.pii, true);
  assert.equal(deleted.byId.get('a').correction.status, 'superseded');
  assert.equal(deleted.counts.active, 0);
  assert.equal(deleted.counts.superseded, 1);
  assert.equal(deleted.counts.deleted, 1);
  assert.equal(deleted.counts.tombstones, 2);
  assert.ok(deleted.tombstoneIds.has('ghost'));
  assert.equal(deleted.records.length, 2);
});

test('read states distinguish corrupt, schema mismatch and unreadable without throwing', (t) => {
  const corruptDir = tempDir(t);
  const corrupt = new MemoryStore({ dir: corruptDir });
  fs.writeFileSync(corrupt.recordsFile, '{ not json\n42\n', 'utf8');
  const corruptSnapshot = corrupt.read();
  assert.equal(corruptSnapshot.ok, false);
  assert.equal(corruptSnapshot.state, 'corrupt');
  assert.deepEqual(corruptSnapshot.degraded, { reason: 'store-corrupt', fallback: 'v1' });
  assert.ok(corruptSnapshot.diagnostics.some((item) => item.code === 'invalid-line' && item.line === 1));
  assert.ok(corruptSnapshot.diagnostics.some((item) => item.code === 'invalid-record' && item.line === 2));

  const schemaDir = tempDir(t);
  const schema = new MemoryStore({ dir: schemaDir });
  fs.writeFileSync(schema.recordsFile, JSON.stringify(record('future', { schemaVersion: 3 })) + '\n', 'utf8');
  const schemaSnapshot = schema.read();
  assert.equal(schemaSnapshot.state, 'schema-mismatch');
  assert.deepEqual(schemaSnapshot.degraded, { reason: 'schema-mismatch', fallback: 'v1' });
  assert.ok(schemaSnapshot.diagnostics.some((item) => item.code === 'unsupported-record-schema'));

  const unreadableDir = tempDir(t);
  const unreadable = new MemoryStore({ dir: unreadableDir });
  fs.mkdirSync(unreadable.recordsFile, { recursive: true });
  const unreadableSnapshot = unreadable.read();
  assert.equal(unreadableSnapshot.state, 'unreadable');
  assert.deepEqual(unreadableSnapshot.degraded, { reason: 'store-unreadable', fallback: 'v1' });
  assert.ok(unreadableSnapshot.diagnostics.some((item) => item.code === 'store-unreadable'));

  const badFieldDir = tempDir(t);
  const badField = new MemoryStore({ dir: badFieldDir });
  fs.writeFileSync(badField.recordsFile, JSON.stringify(record('bad-confidence', { confidence: 2 })) + '\n', 'utf8');
  const badFieldSnapshot = badField.read();
  assert.equal(badFieldSnapshot.state, 'corrupt');
  assert.ok(badFieldSnapshot.diagnostics.some((item) => item.code === 'invalid-confidence'));

  const badTombstoneDir = tempDir(t);
  const badTombstone = new MemoryStore({ dir: badTombstoneDir });
  fs.writeFileSync(badTombstone.recordsFile, JSON.stringify(record('a')) + '\n', 'utf8');
  fs.writeFileSync(badTombstone.tombstonesFile, 'not json\n{"id":""}\n', 'utf8');
  const badTombstoneSnapshot = badTombstone.read();
  assert.equal(badTombstoneSnapshot.state, 'corrupt');
  assert.ok(badTombstoneSnapshot.diagnostics.some((item) => item.code === 'invalid-line' && item.file === 'tombstones.jsonl'));
  assert.ok(badTombstoneSnapshot.diagnostics.some((item) => item.code === 'missing-tombstone-id'));
});

test('counts aggregate status, kind, layer and source, and ordering follows first appearance', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });

  store.appendRecord(record('first', { kind: 'trait', layer: 'user_fact', provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'x' }] } }));
  store.appendRecord(record('second', { kind: 'fact', layer: 'current_state', provenance: { source: 'model_claim', refs: [{ kind: 'action', line: 'x' }] } }));
  store.appendRecord(record('first', {
    text: 'replacement',
    confidence: 0.8,
    correction: { status: 'superseded', supersedes: null, correctedBy: 'third', tombstone: null },
  }));
  fs.appendFileSync(store.recordsFile, JSON.stringify({
    id: 'bare',
    provenance: { source: 'migration', refs: [{ kind: 'action', line: 'x' }] },
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
  }) + '\n', 'utf8');

  const snapshot = store.read();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.records.map((item) => item.id).slice(0, 3), ['first', 'second', 'bare']);
  assert.equal(snapshot.byId.get('first').text, 'replacement');
  assert.equal(snapshot.byId.get('first').confidence, 0.8);
  assert.equal(snapshot.counts.records, 3);
  assert.equal(snapshot.counts.superseded, 1);
  assert.equal(snapshot.counts.active, 2);
  assert.deepEqual(snapshot.counts.byKind, { fact: 1, trait: 1, unknown: 1 });
  assert.deepEqual(snapshot.counts.byLayer, { current_state: 1, unknown: 1, user_fact: 1 });
  assert.deepEqual(snapshot.counts.bySource, { migration: 1, model_claim: 1, user_message: 1 });
  assert.ok(snapshot.firstSeq.get('first') < snapshot.firstSeq.get('second'));
  assert.equal(snapshot.lastSeq.get('first'), 3);
});

test('index is a rebuildable cache and refresh never blocks writes', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.appendRecord(record('a'));
  const before = store.readIndex();
  assert.ok(before);
  assert.equal(before.checksum, sha256File(store.recordsFile));

  fs.rmSync(store.indexFile);
  assert.equal(store.readIndex(), null);
  const snapshot = store.transaction((tx) => {
    const inner = tx.read();
    assert.equal(inner.ok, true);
    return tx.appendBatch({ records: [record('b')] });
  });
  assert.equal(snapshot.records, 1);
  const rebuilt = store.readIndex();
  assert.ok(rebuilt);
  assert.equal(rebuilt.checksum, sha256File(store.recordsFile));
  assert.equal(rebuilt.counts.records, 2);

  fs.writeFileSync(store.recordsFile, '{ bad\n', 'utf8');
  const corrupt = store.read();
  assert.equal(corrupt.ok, false);
  store.transaction(() => 1);
  // 读取失败时不刷新 index；旧 index 不被半套状态覆盖。
  assert.equal(store.readIndex().checksum, rebuilt.checksum);
});

test('lock distinguishes live holders, orphaned locks, unreadable locks and identity mismatch', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 60;

  fs.writeFileSync(store.lockFile, JSON.stringify({
    pid: process.pid,
    token: 'live-token',
    at: FIXED_NOW_ISO,
  }), 'utf8');
  const startedAt = Date.now();
  assert.throws(
    () => store.transaction(() => 1),
    (error) => error instanceof MemoryStoreError && error.code === 'store-lock-timeout',
  );
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(fs.existsSync(store.lockFile), true);
  fs.unlinkSync(store.lockFile);

  const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = dead.pid || 999999999;
  fs.writeFileSync(store.lockFile, JSON.stringify({
    pid: deadPid,
    token: 'orphan-token',
    at: FIXED_NOW_ISO,
  }), 'utf8');
  assert.throws(
    () => store.transaction(() => 1),
    (error) => error instanceof MemoryStoreError && error.code === 'store-lock-orphaned',
  );
  assert.equal(fs.existsSync(store.lockFile), true);
  fs.unlinkSync(store.lockFile);

  fs.writeFileSync(store.lockFile, 'not-json', 'utf8');
  assert.throws(
    () => store.transaction(() => 1),
    (error) => error instanceof MemoryStoreError && error.code === 'store-lock-unreadable',
  );
  assert.equal(fs.existsSync(store.lockFile), true);
  fs.unlinkSync(store.lockFile);

  assert.throws(
    () => store.transaction(() => {
      const current = JSON.parse(fs.readFileSync(store.lockFile, 'utf8'));
      fs.writeFileSync(store.lockFile, JSON.stringify({ ...current, token: 'someone-else' }), 'utf8');
      return 1;
    }),
    (error) => error instanceof MemoryStoreError && error.code === 'store-lock-identity-mismatch',
  );
  assert.equal(JSON.parse(fs.readFileSync(store.lockFile, 'utf8')).token, 'someone-else');
  fs.unlinkSync(store.lockFile);

  assert.equal(store.appendRecord(record('after-cleanup')).bytes > 0, true);
});

test('unreadable record bytes fail the append with store-read-failed and release the lock', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  fs.mkdirSync(store.recordsFile, { recursive: true });

  assert.throws(
    () => store.appendRecord(record('a')),
    (error) => error instanceof MemoryStoreError && error.code === 'store-read-failed',
  );
  assert.equal(fs.existsSync(store.lockFile), false);
});

test('two real child processes append concurrently without losing or corrupting lines', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.appendRecord(record('seed'));

  const storeUrl = pathToFileURL(fileURLToPath(new URL('../src/memory/store.js', import.meta.url))).href;
  const workerPath = path.join(dir, 'worker.mjs');
  fs.writeFileSync(workerPath, [
    'import { MemoryStore } from ' + JSON.stringify(storeUrl) + ';',
    'const [dir, workerId, count] = process.argv.slice(2);',
    'const store = new MemoryStore({ dir });',
    'for (let i = 0; i < Number(count); i += 1) {',
    "  store.appendRecord({ schemaVersion: 1, id: 'w' + workerId + '-' + i, subjectId: 'u1', layer: 'user_fact', kind: 'fact', text: 'w' + workerId + '-' + i,",
    "    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'worker' }] }, observedAt: '2023-11-14T22:13:20.000Z',",
    "    recordedAt: '2023-11-14T22:13:20.000Z', lastConfirmedAt: null, confidence: 0.5, stability: 'stable',",
    "    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },",
    "    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null } });",
    '}',
    'process.exitCode = 0;',
  ].join('\n'), 'utf8');

  // 子进程 stderr 有界捕获：CI 失败时带出真实退出原因，正常路径不改变等待/断言语义。
  const STDERR_LIMIT = 4096;
  const run = (workerId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, dir, workerId, '10'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let truncated = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const room = STDERR_LIMIT - stderr.length;
      truncated ||= chunk.length > room;
      stderr += chunk.slice(0, room);
    });
    child.on('error', reject);
    // close 在 exit 且 stdio 排空后触发，确保失败现场不被截断；仍然等两个子进程都结束。
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stderr: truncated ? stderr + '…[truncated]' : stderr,
    }));
  });
  const [workerA, workerB] = await Promise.all([run('A'), run('B')]);
  const failureDetail = (workerId, result) =>
    `worker ${workerId}: exit=${result.code} signal=${result.signal} stderr=${JSON.stringify(result.stderr)}`;
  assert.equal(workerA.code, 0, failureDetail('A', workerA));
  assert.equal(workerB.code, 0, failureDetail('B', workerB));

  const snapshot = store.read();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.records.length, 21);
  for (const line of readLines(store.recordsFile)) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(snapshot.counts.byKind.fact, 20);
  assert.equal(snapshot.records.filter((item) => item.id.startsWith('wA-')).length, 10);
  assert.equal(snapshot.records.filter((item) => item.id.startsWith('wB-')).length, 10);
});

test('two child processes read-modify-write the same record under transaction without double activation', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.appendRecord(record('contested', {
    text: 'contested',
    scope: 'private',
    privacy: { level: 'restricted', pii: true, redacted: false, retainUntil: null },
  }));
  store.appendRecord(record('doomed', { text: 'doomed' }));

  const seeded = store.read();
  const contested = seeded.byId.get('contested');
  const doomed = seeded.byId.get('doomed');
  assert.ok(contested && doomed);

  const storeUrl = pathToFileURL(fileURLToPath(new URL('../src/memory/store.js', import.meta.url))).href;
  const workerPath = path.join(dir, 'tx-worker.mjs');
  fs.writeFileSync(workerPath, `import { MemoryStore } from ${JSON.stringify(storeUrl)};
const [dir, mode, workerId, id] = process.argv.slice(2);
const store = new MemoryStore({ dir });
store.transaction((tx) => {
  const snapshot = tx.read();
  const current = snapshot.byId.get(id);
  if (!current || current.correction.status !== 'active') return;
  if (mode === 'correct') {
    const replacement = {
      ...current,
      id: current.id + '-r-' + workerId,
      text: 'corrected-' + workerId,
      correction: { status: 'active', supersedes: current.id, correctedBy: null, tombstone: null },
    };
    tx.appendBatch({
      records: [
        replacement,
        { ...current, correction: { ...current.correction, status: 'superseded', correctedBy: replacement.id } },
      ],
    });
    return;
  }
  tx.appendBatch({ tombstones: [{ id: current.id, at: '2030-01-01T00:00:00.000Z', by: 'user', reason: 'worker-' + workerId }] });
});
process.exitCode = 0;
`, 'utf8');

  const run = (mode, workerId, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, dir, mode, workerId, id], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });

  const [codeA, codeB] = await Promise.all([
    run('correct', 'A', contested.id),
    run('correct', 'B', contested.id),
  ]);
  assert.equal(codeA, 0);
  assert.equal(codeB, 0);

  const afterCorrect = store.read();
  const old = afterCorrect.byId.get(contested.id);
  assert.equal(old.correction.status, 'superseded');
  const replacements = afterCorrect.records.filter((item) => item.kind === 'trait'
    && item.correction?.status === 'active'
    && String(item.text || '').startsWith('corrected-'));
  assert.equal(replacements.length, 1);
  assert.equal(old.correction.correctedBy, replacements[0].id);
  assert.equal(afterCorrect.records.filter((item) => item.correction?.status === 'active' && item.text === 'contested').length, 0);
  // 读-改-写保留原记录的 scope / privacy，不因并发纠正而放宽。
  assert.equal(replacements[0].scope, 'private');
  assert.equal(replacements[0].privacy.level, 'restricted');
  assert.equal(replacements[0].privacy.pii, true);

  const [deleteA, deleteB] = await Promise.all([
    run('delete', 'A', doomed.id),
    run('delete', 'B', doomed.id),
  ]);
  assert.equal(deleteA, 0);
  assert.equal(deleteB, 0);

  const afterDelete = store.read();
  assert.equal(afterDelete.byId.get(doomed.id).correction.status, 'deleted');
  assert.equal(afterDelete.records.some((item) => item.correction?.status === 'active' && item.text === 'doomed'), false);
  const doomedTombstones = readLines(store.tombstonesFile)
    .map((line) => JSON.parse(line))
    .filter((item) => item.id === doomed.id);
  assert.equal(doomedTombstones.length, 1);
  assert.equal(readLines(store.recordsFile).map((line) => JSON.parse(line)).filter((item) => item.id === doomed.id).length, 1);
});

test('lock paths fail closed on write, missing, foreign and unpurgeable lock identities', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  const originalWriteFileSync = fs.writeFileSync;
  const originalReadFileSync = fs.readFileSync;
  const originalUnlinkSync = fs.unlinkSync;
  const originalAtomicsWait = Atomics.wait;
  const originalOpenSync = fs.openSync;

  try {
    // ① 锁内容写入失败：close fd、清理刚建的锁，再抛 store-lock-failed。
    let writeCalls = 0;
    fs.writeFileSync = function patchedWrite(fd, data, ...rest) {
      writeCalls += 1;
      if (writeCalls === 1) {
        const error = new Error('write failed');
        error.code = 'EIO';
        throw error;
      }
      return originalWriteFileSync.call(this, fd, data, ...rest);
    };
    assert.throws(
      () => store.appendRecord(record('lock-write-fail')),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-failed',
    );
    fs.writeFileSync = originalWriteFileSync;
    assert.equal(fs.existsSync(store.lockFile), false);

    // ② 读锁时非 ENOENT 的读取错误 → reason=unreadable，等到超时后 store-lock-unreadable。
    store.lockWaitMs = 20;
    fs.writeFileSync(store.lockFile, 'occupied', 'utf8');
    let lockReads = 0;
    fs.readFileSync = function patchedRead(file, ...rest) {
      if (String(file) === store.lockFile) {
        lockReads += 1;
        const error = new Error('read denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFileSync.call(this, file, ...rest);
    };
    // Atomics.wait 被禁用时退化为忙等，仍要在超时后返回结构化错误。
    Atomics.wait = () => { throw new Error('Atomics.wait unavailable'); };
    let unreadableError = null;
    try {
      store.transaction(() => 1);
    } catch (error) {
      unreadableError = error;
    }
    fs.readFileSync = originalReadFileSync;
    Atomics.wait = originalAtomicsWait;
    assert.ok(unreadableError instanceof MemoryStoreError);
    assert.equal(unreadableError.code, 'store-lock-unreadable');
    assert.ok(lockReads >= 1);
    assert.equal(fs.existsSync(store.lockFile), true);
    fs.unlinkSync(store.lockFile);

    // ③ 回调里删掉自己的锁：释放时身份不可核对，拒绝继续。
    assert.throws(
      () => store.transaction(() => {
        originalUnlinkSync.call(fs, store.lockFile);
        return 1;
      }),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-identity-mismatch',
    );
    assert.equal(fs.existsSync(store.lockFile), false);

    // ④ 锁不可解析（缺 pid/token）：释放时身份不可核对。
    assert.throws(
      () => store.transaction(() => {
        originalWriteFileSync.call(fs, store.lockFile, JSON.stringify({ at: FIXED_NOW_ISO }), 'utf8');
        return 1;
      }),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-identity-mismatch',
    );
    originalUnlinkSync.call(fs, store.lockFile);

    // ⑤ 释放前锁被外部替换成同 token 但删除时 ENOENT：不假装释放成功。
    let unlinkCalls = 0;
    fs.unlinkSync = function patchedUnlink(file, ...rest) {
      if (String(file) === store.lockFile) {
        unlinkCalls += 1;
        if (unlinkCalls === 1) {
          const error = new Error('gone');
          error.code = 'ENOENT';
          throw error;
        }
      }
      return originalUnlinkSync.call(this, file, ...rest);
    };
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-identity-mismatch',
    );
    assert.equal(unlinkCalls, 1);
    fs.unlinkSync = originalUnlinkSync;
    originalUnlinkSync.call(fs, store.lockFile);

    // ⑥ 其它 unlink 错误 → store-lock-release-failed。
    unlinkCalls = 0;
    fs.unlinkSync = function patchedUnlinkAgain(file, ...rest) {
      if (String(file) === store.lockFile) {
        const error = new Error('denied');
        error.code = 'EPERM';
        throw error;
      }
      return originalUnlinkSync.call(this, file, ...rest);
    };
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-release-failed',
    );
    fs.unlinkSync = originalUnlinkSync;

    // ⑦ 锁文件被外部占用导致 open 非 EEXIST 失败 → store-lock-failed。
    fs.mkdirSync(store.dir, { recursive: true });
    originalUnlinkSync.call(fs, store.lockFile);
    fs.openSync = function patchedOpen(file, ...rest) {
      if (String(file) === store.lockFile) {
        const error = new Error('too many files');
        error.code = 'EMFILE';
        throw error;
      }
      return originalOpenSync.call(this, file, ...rest);
    };
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-failed',
    );
    fs.openSync = originalOpenSync;

    assert.ok(store.appendRecord(record('after-all-lock-failures')).bytes > 0);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.readFileSync = originalReadFileSync;
    fs.unlinkSync = originalUnlinkSync;
    fs.openSync = originalOpenSync;
    Atomics.wait = originalAtomicsWait;
  }
});

test('a failed atomic close still cleans its temp file and releases the lock', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  const originalCloseSync = fs.closeSync;

  fs.closeSync = function patchedClose() {
    const error = new Error('close failed');
    error.code = 'EIO';
    throw error;
  };
  let thrown = null;
  try {
    store.appendRecord(record('close-fail'));
  } catch (error) {
    thrown = error;
  } finally {
    fs.closeSync = originalCloseSync;
  }
  assert.ok(thrown);
  assert.equal(thrown.code, 'EIO');
  assert.equal(fs.existsSync(store.recordsFile), false);
  assert.equal(fs.existsSync(store.lockFile), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(store.appendRecord(record('after-close-failure')).bytes > 0);
});

test('index refresh is best effort: a blocked index file never fails a successful write', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.appendRecord(record('a'));
  fs.rmSync(store.indexFile, { force: true });
  fs.mkdirSync(store.indexFile, { recursive: true });

  const result = store.appendRecord(record('b'));
  assert.equal(result.bytes > 0, true);
  assert.equal(store.read().counts.records, 2);
  // 目录占位导致 index 无法写入：读回 null，但记录本身完好。
  assert.equal(store.readIndex(), null);
  fs.rmSync(store.indexFile, { recursive: true, force: true });
  store.transaction(() => 1);
  assert.ok(store.readIndex());
});

test('a record with an unknown status is counted as unknown instead of crashing read()', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store.recordsFile, JSON.stringify(record('odd', {
    correction: { status: 'archived', supersedes: null, correctedBy: null, tombstone: null },
  })) + '\n', 'utf8');
  // 未知 status 在写入边界本就非法；这里模拟历史文件，读取必须降级而不是抛错。
  const snapshot = store.read();
  assert.equal(snapshot.state, 'corrupt');
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'invalid-status'));
});
