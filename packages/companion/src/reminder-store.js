/**
 * 提醒状态快照 · reminder store
 * ─────────────────────────────────────────────────────────────
 * 只做一件事：把「一条提醒的当前状态」按固定 schema 落盘、再读回来。
 *
 *   const store = createReminderStore('/path/to/reminders.json');
 *   store.load();          // { ok:true, records } | { ok:false, error }
 *   store.save(records);   // { ok:true }          | { ok:false, error }
 *
 * ── 落盘格式（version 1）────────────────────────────────────
 *   { version: 1, records: [ ... ] }
 *
 * 每条记录的字段是封闭白名单，多一个键就拒绝：
 *   taskId          非空字符串，≤128                      （必填）
 *   conversationKey 非空字符串，≤128                      （必填）
 *   text            非空字符串，≤500                      （必填）
 *   dueAt           毫秒时间戳，非负安全整数              （必填）
 *   status          classifyReminderRecovery 认识的状态   （必填）
 *   attempt         非负安全整数，缺省 0                  （可省）
 *   firedAt         毫秒时间戳或 null，缺省 null          （可省）
 *   proactive       布尔，缺省 false                      （可省）
 *
 * 写入时按白名单重建对象，读回时按白名单严格校验：调用方即使在记录上
 * 挂了别的东西（正文之外的原文、会话快照、内部游标……），也进不了文件。
 *
 * ── 校验规则（fail-closed，不猜）────────────────────────────
 *   - 状态、dueAt、attempt、firedAt 的类型与取值交给
 *     classifyReminderRecovery 判：把 proactive 投影进 input，now 固定取
 *     dueAt，只把 kind === 'invalid' 当成不合法（其余分类结果与存储无关）；
 *   - taskId / conversationKey / text 必须是字符串、去掉头尾空白后非空、
 *     不超过各自上限——空白字符串一律拒绝；
 *   - proactive 必须是真正的布尔，字符串 'false' 不会被当成 false；
 *   - 同一批记录里 taskId 不能重复；
 *   - 一批最多 256 条；快照文件最大 1 MiB。
 *
 * ── 失败语义 ────────────────────────────────────────────────
 *   load():
 *     文件不存在      → { ok:true,  records:[] }
 *     读取失败（I/O） → { ok:false, error:'read-failed' }
 *     坏 JSON / 版本不认识 / 结构不对 / 超限
 *                     → { ok:false, error:'invalid-snapshot' }
 *   任何失败都不删除、不修复原文件：损坏的文件是诊断证据，由调用方处理。
 *
 *   save(records):
 *     输入不合法      → { ok:false, error:'invalid-records' }
 *     现有文件读不懂  → { ok:false, error:'read-failed' | 'invalid-snapshot' }
 *                       （重读失败时**不写**，坏文件绝不会被一次保存抹掉）
 *     写入失败        → { ok:false, error:'write-failed' }
 *     成功            → { ok:true }
 *
 * ── 原子写 ──────────────────────────────────────────────────
 *   覆盖前先重读同一个文件并确认它可读、可解析；然后在同目录下用**一次**
 *   随机名独占创建临时文件（'wx'，权限 0o600），写完 rename 到目标路径
 *   （同卷原子替换）。随机名撞车（EEXIST）即按写失败返回，不重试，也绝不
 *   复用/删除别人建出的文件；任一步失败只清理自己成功创建的那个临时文件，
 *   所以目标文件要么是上一份完整快照，要么是新的一份，不会出现半截 JSON。
 *   父目录由调用方准备（本模块不 mkdir）。
 *
 * ── 不做什么 ────────────────────────────────────────────────
 *   不加锁、不做并行写保证（单进程单写者）——同一文件的 save 必须由同一
 *   个写者串行调用；不装定时器、不发网络、不接入口、不迁移旧数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { classifyReminderRecovery } from './reminder-recovery.js';

/** 快照版本；只认 1。 */
const REMINDER_STORE_VERSION = 1;

/** 快照文件大小上限：1 MiB（按 JSON 编码后的字节算）。 */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** 一批最多多少条提醒。 */
const MAX_REMINDER_RECORDS = 256;

const MAX_TASK_ID_LENGTH = 128;
const MAX_CONVERSATION_KEY_LENGTH = 128;
const MAX_REMINDER_TEXT_LENGTH = 500;

/** 快照顶层与单条记录的键都是封闭集合，不接受任何扩展。 */
const SNAPSHOT_KEYS = Object.freeze(['version', 'records']);
const REMINDER_RECORD_KEYS = Object.freeze([
  'taskId',
  'conversationKey',
  'text',
  'dueAt',
  'status',
  'attempt',
  'firedAt',
  'proactive',
]);

const SNAPSHOT_KEY_SET = new Set(SNAPSHOT_KEYS);
const RECORD_KEY_SET = new Set(REMINDER_RECORD_KEYS);
/** 临时文件权限：只有本用户可读写。 */
const TEMPORARY_FILE_MODE = 0o600;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 键必须全部在白名单里：夹带未定义字段一律拒绝。 */
function hasOnlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** 必须是非空字符串：去空白后为空、超长、非字符串都算不合法。 */
function isBoundedText(value, maxLength) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

/**
 * 校验并归一化一条记录；不合法返回 null。
 * 状态 / dueAt / attempt / firedAt 复用 classifyReminderRecovery 的判定，
 * 这里只关心「读不懂」（invalid），不关心它被归到哪个恢复分类。
 */
function normalizeRecord(value) {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyKeys(value, RECORD_KEY_SET)) return null;
  if (!isBoundedText(value.taskId, MAX_TASK_ID_LENGTH)) return null;
  if (!isBoundedText(value.conversationKey, MAX_CONVERSATION_KEY_LENGTH)) return null;
  if (!isBoundedText(value.text, MAX_REMINDER_TEXT_LENGTH)) return null;

  const proactive = value.proactive === undefined ? false : value.proactive;
  if (typeof proactive !== 'boolean') return null;

  const verdict = classifyReminderRecovery(
    {
      status: value.status,
      dueAt: value.dueAt,
      attempt: value.attempt,
      firedAt: value.firedAt,
      // 恢复分类从 input.proactive 读主动语义，这里显式投影过去。
      input: { proactive },
    },
    // now 固定在 dueAt：存储校验只判断字段能不能读懂，不做时间窗口决策。
    value.dueAt,
  );
  if (verdict.kind === 'invalid') return null;

  return Object.freeze({
    taskId: value.taskId,
    conversationKey: value.conversationKey,
    text: value.text,
    dueAt: value.dueAt,
    status: value.status,
    attempt: value.attempt === undefined ? 0 : value.attempt,
    firedAt: value.firedAt === undefined ? null : value.firedAt,
    proactive,
  });
}

/**
 * 校验整批记录：必须是数组、≤256 条、每条合法、taskId 不重复。
 * 成功返回归一化后的数组（新对象），失败返回 null。
 */
function normalizeRecords(value) {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_REMINDER_RECORDS) return null;

  const records = [];
  const taskIds = new Set();
  for (const item of value) {
    const record = normalizeRecord(item);
    if (!record) return null;
    if (taskIds.has(record.taskId)) return null;
    taskIds.add(record.taskId);
    records.push(record);
  }
  return records;
}

/** 解析快照文本；坏 JSON / 版本 / 结构 / 超限记录一律 null。 */
function parseSnapshot(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (!hasOnlyKeys(parsed, SNAPSHOT_KEY_SET)) return null;
  if (parsed.version !== REMINDER_STORE_VERSION) return null;
  return normalizeRecords(parsed.records);
}

/**
 * 同步创建一个提醒状态存储。文件路径由调用方给出，父目录由调用方准备。
 *
 * @param {string} file 快照文件路径
 * @returns {{load: () => ({ok: true, records: object[]} | {ok: false, error: string}), save: (records: unknown) => ({ok: true} | {ok: false, error: string})}}
 */
export function createReminderStore(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError('createReminderStore: file must be a non-empty string');
  }
  const target = path.resolve(file);

  /**
   * 读当前文件。records 为 null 表示文件不存在。
   * @returns {{ok: true, records: object[]|null} | {ok: false, error: string}}
   */
  function readCurrent() {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, records: null };
      return { ok: false, error: 'read-failed' };
    }
    // 目录 / 设备文件不是快照；按 I/O 失败处理，不当成空账。
    if (!stat.isFile()) return { ok: false, error: 'read-failed' };
    if (stat.size > MAX_SNAPSHOT_BYTES) return { ok: false, error: 'invalid-snapshot' };

    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      return { ok: false, error: 'read-failed' };
    }

    const records = parseSnapshot(text);
    if (!records) return { ok: false, error: 'invalid-snapshot' };
    return { ok: true, records };
  }

  /** 原子写入已序列化好的快照。 */
  function writeSnapshot(json) {
    // 随机名只生成一次：撞名（EEXIST）就当写失败，不重试、也不碰别人建出的文件。
    const temporary = path.join(
      path.dirname(target),
      '.' + path.basename(target) + '.' + process.pid + '-' + randomBytes(8).toString('hex') + '.tmp',
    );

    let descriptor = null;
    let created = false;
    try {
      // 'wx' = 独占创建：同名文件已存在就失败，绝不复用别人的临时文件。
      descriptor = fs.openSync(temporary, 'wx', TEMPORARY_FILE_MODE);
      created = true;

      fs.writeFileSync(descriptor, json, 'utf8');
      fs.closeSync(descriptor);
      descriptor = null;

      fs.renameSync(temporary, target);
      created = false;
      return { ok: true };
    } catch {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* 清理失败不影响返回值 */ }
      }
      // 只清理自己成功创建的文件：openSync 失败时那个路径从来不属于我们。
      if (created) {
        try { fs.unlinkSync(temporary); } catch { /* 清理失败不影响返回值 */ }
      }
      return { ok: false, error: 'write-failed' };
    }
  }

  /**
   * 读回快照。文件不存在算空账；坏数据按失败返回，绝不静默给空数组。
   * @returns {{ok: true, records: object[]} | {ok: false, error: string}}
   */
  function load() {
    const current = readCurrent();
    if (!current.ok) return { ok: false, error: current.error };
    return { ok: true, records: current.records === null ? [] : current.records };
  }

  /**
   * 用给定记录整体覆盖快照。
   * @param {unknown} records 记录数组（允许省略 attempt/firedAt/proactive）
   * @returns {{ok: true} | {ok: false, error: string}}
   */
  function save(records) {
    const normalized = normalizeRecords(records);
    if (!normalized) return { ok: false, error: 'invalid-records' };

    // 覆盖前先重读：现有文件读不懂就拒绝写，坏文件没有任何机会被抹掉。
    const current = readCurrent();
    if (!current.ok) return { ok: false, error: current.error };

    // 归一化后的记录只含原始类型和新建的普通对象，JSON.stringify 不会抛；
    // 编码后仍要过 1 MiB 闸门：控制字符会被转义成 \uXXXX，体积最大涨到原文 6 倍，
    // 256 条 × 每条长度极限时确实能超过上限，所以这道检查是可达到的。
    const json = JSON.stringify({ version: REMINDER_STORE_VERSION, records: normalized });
    if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
      return { ok: false, error: 'invalid-records' };
    }

    return writeSnapshot(json);
  }

  return { load, save };
}
