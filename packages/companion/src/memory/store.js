/**
 * v2 记忆存储 · append-only records / tombstones / rebuildable index
 * ─────────────────────────────────────────────────────────────
 * 这一层只负责“文件怎么读写”，不解释记忆语义，也不接 Brain / 入口：
 *
 *   <dir>/records.jsonl     一行一条 MemoryRecord；同一 id 后写的版本生效
 *   <dir>/tombstones.jsonl  一行一条 { id, at, by, reason }；删除事实优先于记录
 *   <dir>/index.json        可重建缓存 { schemaVersion, builtAt, counts, checksum }
 *   <dir>/manifest.json     迁移清单（由迁移工具写；本模块忽略）
 *
 * 设计约束：
 *   - 只追加，不原地覆盖；状态变化写新版本行。
 *   - tombstone 是删除事实：即使 records.jsonl 里还有 active 版本，读出来也是
 *     deleted。迁移/检索不得把已删除记录复活。
 *   - 读失败不抛给调用方：返回结构化 state / degraded，让上层决定降级；
 *     写失败抛 MemoryStoreError，绝不假装写成功。
 *   - 未知字段原样保留；本模块不裁剪、不改写记录正文。
 *   - 不联网、不引入数据库、不依赖进程内缓存做唯一真相。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { validateStoredRecord, validateRecordStrict, validateTombstone as validateTombstoneContract } from './record-contract.js';

export const STORE_LAYOUT_VERSION = 2;
export const STORE_RECORD_SCHEMA_VERSION = 1;

/** 写失败时抛这个；调用方可以用 code 判断，不需要解析文案。 */
export class MemoryStoreError extends Error {
  constructor(message, code = 'store-error') {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

let tempSeq = 0;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  try {
    Atomics.wait(LOCK_SLEEP, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 极端环境下退化为忙等，仍保持同步 API */ }
  }
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  tempSeq += 1;
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + tempSeq + '.tmp');
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
    try { fs.unlinkSync(temp); } catch { /* 已 rename 或不存在 */ }
  }
}

/** 读 JSONL；坏行只记结构位置，不读正文、不中断。 */
function readJsonl(file, label, diagnostics) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { present: false, text: '', lines: 0, invalidLines: 0, entries: [] };
    }
    diagnostics.push({ code: 'store-unreadable', file: label, errorCode: String(error?.code || '') });
    return { present: false, text: '', lines: 0, invalidLines: 0, entries: [], unreadable: true };
  }

  const entries = [];
  let lines = 0;
  let invalidLines = 0;
  const rawLines = text.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (!line.trim()) continue;
    lines += 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLines += 1;
      diagnostics.push({ code: 'invalid-line', file: label, line: index + 1 });
      continue;
    }
    if (!isPlainObject(value)) {
      invalidLines += 1;
      diagnostics.push({ code: 'invalid-record', file: label, line: index + 1 });
      continue;
    }
    entries.push({ line: index + 1, seq: lines, value });
  }
  return { present: true, text, lines, invalidLines, entries };
}

function emptyCounts() {
  return {
    records: 0,
    lines: 0,
    active: 0,
    superseded: 0,
    deleted: 0,
    quarantined: 0,
    unknown: 0,
    tombstones: 0,
    byKind: {},
    byLayer: {},
    bySource: {},
  };
}

function sortedObject(value) {
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

/**
 * 读取边界：契约校验的“宽容档”。坏字段（未知 layer、confidence 越界、坏时间戳）
 * 与历史结构问题（缺 id / 缺 refs / 未知状态）一样让整份存储 fail-closed，
 * 但缺失的可选字段保持宽容，避免把老记录整体判死。返回 code 字符串（保持原有诊断口径）。
 */
function validateRecord(record) {
  const found = validateStoredRecord(record);
  return found ? found.code : null;
}

/**
 * v2 文件存储。一个实例对应一个 `memory/` 目录；无模块级状态（tempSeq 只用于
 * 临时文件名，不参与语义）。所有读方法都是同步的，和现有 Memory 一致。
 */
export class MemoryStore {
  constructor({ dir } = {}) {
    if (!dir || typeof dir !== 'string') throw new TypeError('MemoryStore 需要 dir');
    this.dir = path.resolve(dir);
    this.recordsFile = path.join(this.dir, 'records.jsonl');
    this.tombstonesFile = path.join(this.dir, 'tombstones.jsonl');
    this.indexFile = path.join(this.dir, 'index.json');
    this.manifestFile = path.join(this.dir, 'manifest.json');
    this.lockFile = path.join(this.dir, '.write.lock');
    this.lockWaitMs = 5000;
  }

  /**
   * 读当前快照。永远返回对象，不抛（除非参数级错误）。
   *
   * @returns {{
   *   ok: boolean, state: 'ready'|'missing'|'corrupt'|'schema-mismatch'|'unreadable',
   *   degraded: null|{reason:string, fallback:string},
   *   records: object[], byId: Map<string, object>, tombstones: object[],
   *   firstSeq: Map<string, number>, lastSeq: Map<string, number>,
   *   counts: object, checksum: string, diagnostics: object[]
   * }}
   */
  read() {
    const diagnostics = [];
    const recordsRead = readJsonl(this.recordsFile, 'records.jsonl', diagnostics);
    const tombstonesRead = readJsonl(this.tombstonesFile, 'tombstones.jsonl', diagnostics);

    let state = 'ready';
    let degraded = null;
    if (!recordsRead.present) {
      state = recordsRead.unreadable ? 'unreadable' : 'missing';
      degraded = { reason: recordsRead.unreadable ? 'store-unreadable' : 'store-missing', fallback: 'v1' };
    } else if (recordsRead.invalidLines > 0) {
      state = 'corrupt';
      degraded = { reason: 'store-corrupt', fallback: 'v1' };
    }

    const byId = new Map();
    const firstSeq = new Map();
    const lastSeq = new Map();
    let unsupported = 0;
    let invalidRecords = 0;

    for (const entry of recordsRead.entries) {
      const problem = validateRecord(entry.value);
      if (problem === 'unsupported-schema') {
        unsupported += 1;
        diagnostics.push({ code: 'unsupported-record-schema', file: 'records.jsonl', line: entry.line });
        continue;
      }
      if (problem) {
        invalidRecords += 1;
        diagnostics.push({ code: problem, file: 'records.jsonl', line: entry.line });
        continue;
      }
      const record = entry.value;
      if (!firstSeq.has(record.id)) firstSeq.set(record.id, entry.seq);
      lastSeq.set(record.id, entry.seq);
      byId.set(record.id, record); // 后写版本生效
    }

    if (unsupported > 0 && state === 'ready') {
      state = 'schema-mismatch';
      degraded = { reason: 'schema-mismatch', fallback: 'v1' };
    } else if (invalidRecords > 0 && state === 'ready') {
      state = 'corrupt';
      degraded = { reason: 'store-corrupt', fallback: 'v1' };
    }

    // tombstones 是删除事实，优先于 records 里的 active 版本。
    const tombstoneIds = new Set();
    const tombstones = [];
    let invalidTombstones = 0;
    for (const entry of tombstonesRead.entries) {
      const found = validateTombstoneContract(entry.value);
      if (found) {
        invalidTombstones += 1;
        diagnostics.push({ code: found.code, file: 'tombstones.jsonl', line: entry.line });
        continue;
      }
      const tombstone = entry.value;
      tombstoneIds.add(String(tombstone.id));
      tombstones.push(tombstone);
      const record = byId.get(String(tombstone.id));
      if (!record) continue;
      const correction = isPlainObject(record.correction) ? record.correction : {};
      byId.set(String(tombstone.id), {
        ...record,
        correction: {
          ...correction,
          status: 'deleted',
          tombstone: {
            at: tombstone.at ?? null,
            by: tombstone.by ?? 'user',
            reason: tombstone.reason ?? 'deleted',
          },
        },
      });
    }
    if (tombstonesRead.invalidLines > 0 || invalidTombstones > 0) {
      if (state === 'ready') {
        state = 'corrupt';
        degraded = { reason: 'store-corrupt', fallback: 'v1' };
      }
    }

    // 崩溃恢复：correct/replace 先写新记录、再写旧记录 superseded。若进程在两次
    // 追加之间退出，旧记录在文件里仍是 active；这里按“有活跃/已记录的新版本
    // supersedes 它”把旧记录读成 superseded，避免一条更正变成两条 active。
    // 新版本即使后来被删除，也不让旧记录复活（旧记录保持 superseded）。
    for (const record of [...byId.values()]) {
      const supersedes = record?.correction?.supersedes;
      if (!supersedes || !byId.has(String(supersedes))) continue;
      const old = byId.get(String(supersedes));
      if (old?.correction?.status !== 'active') continue;
      byId.set(String(supersedes), {
        ...old,
        correction: {
          ...old.correction,
          status: 'superseded',
          correctedBy: record.id,
        },
      });
    }

    const records = [...byId.keys()]
      .sort((a, b) => (firstSeq.get(a) || 0) - (firstSeq.get(b) || 0))
      .map((id) => byId.get(id));

    const counts = emptyCounts();
    counts.lines = recordsRead.lines;
    counts.records = records.length;
    counts.tombstones = tombstones.length;
    const byKind = {};
    const byLayer = {};
    const bySource = {};
    for (const record of records) {
      const status = String(record?.correction?.status || 'unknown');
      if (Object.hasOwn(counts, status)) counts[status] += 1;
      else counts.unknown += 1;
      const kind = String(record?.kind ?? 'unknown');
      byKind[kind] = (byKind[kind] || 0) + 1;
      const layer = String(record?.layer ?? 'unknown');
      byLayer[layer] = (byLayer[layer] || 0) + 1;
      const source = String(record?.provenance?.source ?? 'unknown');
      bySource[source] = (bySource[source] || 0) + 1;
    }
    counts.byKind = sortedObject(byKind);
    counts.byLayer = sortedObject(byLayer);
    counts.bySource = sortedObject(bySource);

    return {
      ok: state === 'ready',
      state,
      degraded,
      records,
      byId,
      tombstones,
      tombstoneIds,
      firstSeq,
      lastSeq,
      counts,
      checksum: sha256Text(recordsRead.text),
      diagnostics,
    };
  }

  /**
   * 跨进程事务：锁内完成一次 read-modify-write。回调拿到只读快照和不再加锁的
   * appendBatch，用于纠正/删除这类“先读状态、再写多行”的操作，避免两个进程
   * 同时读到 active 旧记录后各自写一条新记录。
   *
   * 崩溃语义：回调里的 appendBatch 仍是“墓碑先、记录后、单文件原子替换”；
   * 若进程在两次文件替换之间退出，墓碑优先于记录，读取端不会复活删除项。
   */
  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction 需要回调');
    const lock = this.#acquireLock();
    try {
      const tx = {
        read: () => this.read(),
        appendBatch: (batch) => this.#appendBatchLocked(batch),
      };
      const result = fn(tx);
      this.#refreshIndexBestEffort();
      return result;
    } finally {
      this.#releaseLock(lock);
    }
  }

  /**
   * 批量追加：一次锁内把多条记录/墓碑写进对应文件。
   * 锁内先全部校验，再写；墓碑先于记录写入，保证“删除事实”不会因为
   * 进程在两次文件写入之间退出而丢失。文件内容用临时文件 + rename 替换，
   * 其他进程读到的永远是完整旧文件或完整新文件，不会看到半行。
   */
  appendBatch({ records = [], tombstones = [] } = {}) {
    return this.transaction((tx) => tx.appendBatch({ records, tombstones }));
  }

  /** 已持锁版本：只校验 + 写入，不再拿锁。 */
  #appendBatchLocked({ records = [], tombstones = [] } = {}) {
    const recordLines = [];
    for (const record of records) {
      // 写入边界用严格档：缺 layer/refs、未知枚举、confidence 越界一律拒绝，
      // 绝不把半套记录写进 append-only 文件（M-0）。
      const found = validateRecordStrict(record);
      if (found) {
        throw new MemoryStoreError(
          '拒绝写入非法记录：' + found.code + (found.field ? '（' + found.field + '）' : ''),
          'invalid-record',
        );
      }
      recordLines.push(JSON.stringify(record) + '\n');
    }
    const tombstoneLines = [];
    for (const tombstone of tombstones) {
      const found = validateTombstoneContract(tombstone, { strict: true });
      if (found) {
        throw new MemoryStoreError(
          '拒绝写入非法 tombstone：' + found.code + (found.field ? '（' + found.field + '）' : ''),
          'invalid-tombstone',
        );
      }
      tombstoneLines.push(JSON.stringify(tombstone) + '\n');
    }
    if (!recordLines.length && !tombstoneLines.length) {
      return { records: 0, tombstones: 0, bytes: 0 };
    }

    if (tombstoneLines.length) this.#appendLinesLocked(this.tombstonesFile, tombstoneLines);
    if (recordLines.length) this.#appendLinesLocked(this.recordsFile, recordLines);
    const bytes = [...recordLines, ...tombstoneLines].reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    return { records: recordLines.length, tombstones: tombstoneLines.length, bytes };
  }

  /** 追加一条记录；成功返回 {file, bytes}，失败抛 MemoryStoreError。 */
  appendRecord(record) {
    const result = this.appendBatch({ records: [record] });
    return { file: this.recordsFile, bytes: result.bytes };
  }

  /** 追加一条 tombstone；成功返回 {file, bytes}，失败抛 MemoryStoreError。 */
  appendTombstone(tombstone) {
    const result = this.appendBatch({ tombstones: [tombstone] });
    return { file: this.tombstonesFile, bytes: result.bytes };
  }

  /** 进程是否仍活着；不确定时按“活着”处理，宁可超时也不偷锁。 */
  #processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      // EPERM 说明进程存在但无权限发信号；其它未知错误一律保守当作活锁。
      return true;
    }
  }

  #readLock() {
    let text;
    try {
      text = fs.readFileSync(this.lockFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }
    try {
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) return { ok: false, reason: 'unreadable' };
      const pid = Number(parsed.pid);
      const token = typeof parsed.token === 'string' ? parsed.token : '';
      if (!Number.isInteger(pid) || pid <= 0 || !token) return { ok: false, reason: 'unreadable' };
      return { ok: true, pid, token, at: parsed.at };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  /**
   * 拿跨进程写锁。锁文件本身不在 records/tombstones 里，读取时忽略。
   *
   * 过期语义（保守失败优先于破坏互斥）：
   *   - 持锁 pid 仍活着：不因 mtime 老而偷锁；等到 lockWaitMs 后
   *     `store-lock-timeout`。
   *   - 持锁 pid 已退出：视为崩溃遗留，直接 `store-lock-orphaned`，不自动删除
   *     （避免与另一个正在接管新锁的进程竞态）。需人工确认后删 `.write.lock`。
   *   - 锁内容缺失/不可解析：等到超时后 `store-lock-unreadable`。
   */
  #acquireLock() {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + this.lockWaitMs;
    const token = randomUUID();
    while (true) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
          fs.fsyncSync(fd);
        } catch (error) {
          try { fs.closeSync(fd); } catch { /* 已关闭 */ }
          try { fs.unlinkSync(this.lockFile); } catch { /* 自己的锁，尽力清理 */ }
          throw new MemoryStoreError('v2 记忆写锁内容写入失败', 'store-lock-failed');
        }
        return { fd, token };
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          if (error instanceof MemoryStoreError) throw error;
          throw new MemoryStoreError('v2 记忆写锁创建失败：' + String(error?.code || error?.name || 'unknown'), 'store-lock-failed');
        }
        const lock = this.#readLock();
        if (lock.ok && this.#processAlive(lock.pid)) {
          if (Date.now() >= deadline) {
            throw new MemoryStoreError('v2 记忆写锁被活进程持有，等待超时', 'store-lock-timeout');
          }
          sleepMs(10);
          continue;
        }
        if (lock.ok && !this.#processAlive(lock.pid)) {
          throw new MemoryStoreError('v2 记忆写锁属于已退出进程，需人工确认后清理 .write.lock', 'store-lock-orphaned');
        }
        if (Date.now() >= deadline) {
          throw new MemoryStoreError('v2 记忆写锁状态不可读', 'store-lock-unreadable');
        }
        // missing（刚好释放）或 unreadable（对方正在写内容）：短暂重试。
        sleepMs(lock.reason === 'missing' ? 5 : 10);
      }
    }
  }

  /** 释放锁前核对 token：绝不删除别的进程刚接管的锁。 */
  #releaseLock(lock) {
    try { fs.closeSync(lock.fd); } catch { /* 已关闭 */ }
    const current = this.#readLock();
    if (!current.ok) {
      throw new MemoryStoreError('v2 记忆写锁身份不可核对，拒绝释放', 'store-lock-identity-mismatch');
    }
    if (current.token !== lock.token) {
      throw new MemoryStoreError('v2 记忆写锁身份不匹配，拒绝释放', 'store-lock-identity-mismatch');
    }
    try {
      fs.unlinkSync(this.lockFile);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new MemoryStoreError('v2 记忆写锁在释放前被外部删除', 'store-lock-identity-mismatch');
      }
      throw new MemoryStoreError('v2 记忆写锁释放失败', 'store-lock-release-failed');
    }
  }

  /** 锁内追加：读旧内容 + 追加行 + 原子替换，避免跨进程半行/丢更新。 */
  #appendLinesLocked(file, lines) {
    let base = '';
    try {
      base = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new MemoryStoreError('v2 记忆读取失败：' + String(error?.code || error?.name || 'unknown'), 'store-read-failed');
      }
    }
    if (base && !base.endsWith('\n')) base += '\n';
    writeFileAtomic(file, base + lines.join(''));
  }

  /** 可重建索引；失败不影响记录本身（调用方可在下次读时重建）。 */
  #refreshIndexBestEffort() {
    try {
      const snapshot = this.read();
      if (!snapshot.ok) return;
      const index = {
        schemaVersion: STORE_LAYOUT_VERSION,
        builtAt: new Date().toISOString(),
        counts: snapshot.counts,
        checksum: snapshot.checksum,
      };
      writeFileAtomic(this.indexFile, JSON.stringify(index, null, 2) + '\n');
    } catch {
      // index 是缓存；写不了也不该让记忆写入失败。
    }
  }

  /** 只读 index.json；损坏/缺失返回 null，不抛。 */
  readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
