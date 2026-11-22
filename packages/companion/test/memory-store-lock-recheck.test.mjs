import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore, MemoryStoreError } from '../src/memory/store.js';

/**
 * 写锁的“读锁 → 查进程”竞态回归：
 *
 * 原持有者可能在 store 读到锁内容之后、`process.kill(pid, 0)` 之前正常释放
 * 并退出。此时锁文件已经消失（或被另一个进程接管），但查活必然得到 ESRCH。
 * 只凭“pid 已失活”就报 `store-lock-orphaned` 会把一次正常交接误判成崩溃遗留。
 *
 * 这里只用合成 pid / 合成锁文件与临时目录；通过替换 `process.kill` 精确控制
 * “查活”发生的那一刻，不依赖真实进程调度，因此可重复。
 */

const FIXED_NOW_ISO = '2030-01-01T00:00:00.000Z';
const FAKE_PID = 456789;
const T1 = '2023-11-14T22:13:20.000Z';

function tempDir(t, prefix = 'companion-memory-lock-recheck-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(id) {
  return {
    schemaVersion: 1,
    id,
    subjectId: 'u1',
    layer: 'user_fact',
    kind: 'fact',
    text: 'text-' + id,
    provenance: { source: 'user_message', refs: [{ kind: 'action', line: 'lock-recheck' }] },
    observedAt: T1,
    recordedAt: T1,
    lastConfirmedAt: null,
    confidence: 0.5,
    stability: 'stable',
    correction: { status: 'active', supersedes: null, correctedBy: null, tombstone: null },
    privacy: { level: 'normal', pii: false, redacted: false, retainUntil: null },
  };
}

function writeLock(store, { pid = FAKE_PID, token = 'holder-token', at = FIXED_NOW_ISO } = {}) {
  fs.writeFileSync(store.lockFile, JSON.stringify({ pid, token, at }), 'utf8');
}

function readLock(store) {
  return JSON.parse(fs.readFileSync(store.lockFile, 'utf8'));
}

function esrch() {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

/**
 * 替换 `process.kill`，只接管 FAKE_PID；其它 pid（包括 process.pid）原样放行。
 * handler 返回 undefined 表示交给真实实现，返回其它值则作为 `process.kill` 的结果。
 * 无论测试体是否抛错，finally 都会恢复真实实现。
 */
function withKill(handler, fn) {
  const original = process.kill;
  process.kill = function patchedKill(pid, signal) {
    const result = handler(pid, signal);
    if (result !== undefined) return result;
    return original.call(process, pid, signal);
  };
  try {
    return fn();
  } finally {
    process.kill = original;
  }
}

function assertReleasedHolderIsReacquired(t, waitMs) {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = waitMs;
  writeLock(store, { token: 'released-token' });

  let checks = 0;
  const result = withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    checks += 1;
    // 原持有者在“查活”的同一刻完成正常释放并退出：锁已不存在，查活得到 ESRCH。
    fs.unlinkSync(store.lockFile);
    throw esrch();
  }, () => store.transaction((tx) => tx.appendBatch({ records: [record('released-' + waitMs)] })));

  assert.equal(result.records, 1);
  // 每把锁只查活一次；旧锁消失后应重读身份并在下一轮重新竞争，而不是再查旧 pid。
  assert.equal(checks, 1);
  assert.equal(fs.existsSync(store.lockFile), false);
  const snapshot = store.read();
  assert.equal(snapshot.counts.records, 1);
  assert.equal(snapshot.byId.get('released-' + waitMs).text, 'text-released-' + waitMs);
}

test('a lock released and exited between read and liveness check is retried, not reported orphaned', (t) => {
  // 0ms 等待预算下也必须先重读身份、再尝试拿锁：锁已消失时不该误报超时/不可读。
  assertReleasedHolderIsReacquired(t, 0);
  assertReleasedHolderIsReacquired(t, 500);
});

test('a second release at the deadline cannot prolong acquisition indefinitely', (t) => {
  const store = new MemoryStore({ dir: tempDir(t) });
  store.lockWaitMs = 0;
  writeLock(store);
  const open = fs.openSync;
  let attempts = 0;
  t.mock.method(fs, 'openSync', function (file, flags, ...args) {
    if (file === store.lockFile && flags === 'wx' && ++attempts === 2) {
      writeLock(store, { token: 'replacement' });
    }
    return open.call(this, file, flags, ...args);
  });
  assert.throws(() => withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    fs.unlinkSync(store.lockFile);
    throw esrch();
  }, () => store.transaction(() => assert.fail('deadline already exhausted'))),
  { code: 'store-lock-unreadable' });
  assert.equal(attempts, 2);
});

test('a lock replaced by another live holder is retried and never deleted', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 80;
  writeLock(store, { token: 'stale-token' });

  let checks = 0;
  const startedAt = Date.now();
  withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    checks += 1;
    // 旧持有者退出；重读之前锁已被另一个进程接管（新 pid + 新 token）。
    fs.writeFileSync(store.lockFile, JSON.stringify({
      pid: process.pid,
      token: 'new-holder-token',
      at: FIXED_NOW_ISO,
    }), 'utf8');
    throw esrch();
  }, () => {
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-timeout',
    );
  });

  assert.ok(Date.now() - startedAt < 2000);
  // 只查过旧 pid 一次；新持有者由下一轮按活锁等待，而不是误报 orphaned。
  assert.equal(checks, 1);
  assert.deepEqual(readLock(store), { pid: process.pid, token: 'new-holder-token', at: FIXED_NOW_ISO });
  fs.unlinkSync(store.lockFile);
});

test('a lock that keeps being replaced is retried only within lockWaitMs', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 40;
  writeLock(store, { token: 'churn-0' });

  let checks = 0;
  const startedAt = Date.now();
  withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    checks += 1;
    // 每次查活都换成一把新 token 的锁：身份持续变化，必须由截止时间兜底。
    fs.writeFileSync(store.lockFile, JSON.stringify({
      pid: FAKE_PID,
      token: 'churn-' + checks,
      at: FIXED_NOW_ISO,
    }), 'utf8');
    throw esrch();
  }, () => {
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-timeout',
    );
  });

  assert.ok(Date.now() - startedAt < 2000);
  assert.ok(checks >= 1);
  // 最后一把锁不属于我们：超时退出时原样保留，绝不删除。
  assert.equal(readLock(store).token, 'churn-' + checks);
  fs.unlinkSync(store.lockFile);
});

test('a lock replaced with a new token under the same pid is retried and never deleted', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 80;
  writeLock(store, { token: 'old-token' });

  let checks = 0;
  withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    checks += 1;
    if (checks === 1) {
      // pid 被复用，但 token 变了：仍是另一把锁，不能按旧身份判成遗留。
      fs.writeFileSync(store.lockFile, JSON.stringify({
        pid: FAKE_PID,
        token: 'reused-pid-token',
        at: FIXED_NOW_ISO,
      }), 'utf8');
      throw esrch();
    }
    return true; // 复用该 pid 的新持有者仍活着。
  }, () => {
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-timeout',
    );
  });

  assert.ok(checks >= 2);
  assert.equal(readLock(store).token, 'reused-pid-token');
  fs.unlinkSync(store.lockFile);
});

test('a lock replaced by unreadable bytes is retried to the deadline, not reported orphaned', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 40;
  writeLock(store, { token: 'stale-token' });

  withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    // 另一个进程正在写自己的锁内容：旧身份已不可读，但不是崩溃遗留。
    fs.writeFileSync(store.lockFile, 'not-json', 'utf8');
    throw esrch();
  }, () => {
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-unreadable',
    );
  });

  assert.equal(fs.readFileSync(store.lockFile, 'utf8'), 'not-json');
  fs.unlinkSync(store.lockFile);
});

test('a stable orphaned lock is still rejected and never deleted', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dir });
  store.lockWaitMs = 40;
  writeLock(store, { token: 'orphan-token' });

  let checks = 0;
  withKill((pid) => {
    if (pid !== FAKE_PID) return undefined;
    checks += 1;
    throw esrch(); // 锁始终没变，进程确实已退出。
  }, () => {
    assert.throws(
      () => store.transaction(() => 1),
      (error) => error instanceof MemoryStoreError && error.code === 'store-lock-orphaned',
    );
  });

  assert.ok(checks >= 1);
  assert.deepEqual(readLock(store), { pid: FAKE_PID, token: 'orphan-token', at: FIXED_NOW_ISO });
  fs.unlinkSync(store.lockFile);
});
