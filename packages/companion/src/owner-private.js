/**
 * 主人私聊准入 · owner-private entry gate
 * ─────────────────────────────────────────────────────────────
 * 给公开 fork 的通用 companion CLI 增加一个显式模式：`--owner-private`。
 *
 * 这个模块只做两件窄事，不碰模型、不碰记忆、不碰 OneBot：
 *
 *   1. **配置闸门**：严格读一次配置。读不到、不是 JSON、不是 object、
 *      或 `ownerIds` 里没有任何可用账号，都返回固定错误码；调用方必须在
 *      构造 Memory / 连接 OneBot 之前处理。错误文案固定，不回显配置内容、
 *      文件路径或解析异常原文。
 *
 *   2. **入口准入**：只放行「白名单里的 OneBot 私聊」。群聊、非白名单、
 *      缺失或自相矛盾的会话标识一律拒绝，返回固定原因码；调用方不得把
 *      被拒消息交给 presence / waker / 模型 / 记忆 / 任务 / 发送，也不得
 *      把正文写进日志。
 *
 * 这里不声称已经接入芙兰原宿主；它只是可复用的主机前置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/** 固定错误文案：不含配置、路径、异常原文。 */
export const OWNER_PRIVATE_CONFIG_ERROR = '配置不可用：--owner-private 需要可读的 JSON 对象配置，且 ownerIds 至少包含一个有效账号；已停止（未创建 Memory、未连接 OneBot）。';

/** 配置闸门的固定原因码；调用方可以据此返回非零退出码。 */
export const OWNER_PRIVATE_CONFIG_CODES = Object.freeze({
  UNREADABLE: 'config-unreadable',
  INVALID_JSON: 'config-invalid-json',
  NOT_OBJECT: 'config-not-object',
  NO_OWNER_IDS: 'owner-ids-missing',
});

/** 入口拒绝的固定原因码；日志里只出现这些码，不出现正文或账号。 */
export const OWNER_PRIVATE_REJECTIONS = Object.freeze({
  NOT_OBJECT: 'not-object',
  GROUP: 'group',
  MISSING_USER: 'missing-user',
  MISSING_SESSION: 'missing-session',
  NOT_PRIVATE: 'not-private',
  SESSION_MISMATCH: 'session-mismatch',
  NOT_OWNER: 'not-owner',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 规范十进制账号：与 reminder-runtime / reminder-commands 的白名单规则一致。 */
const DECIMAL_ID = /^[1-9]\d*$/;

/**
 * 归一化 owner 白名单：只接受规范十进制账号（字符串或正安全整数），
 * 去空白、去重。其它类型（对象、数组、布尔、null、0、负数、小数、非数字串）
 * 一律忽略；一个都没有就是「没有有效 ownerIds」。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeOwnerIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    let id = '';
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (DECIMAL_ID.test(trimmed)) id = trimmed;
    } else if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0) {
      id = String(item);
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 严格读取 `--owner-private` 的配置。
 *
 * 与 `loadConfig()` 的宽松默认值不同：这里任何读不到 / 解析失败 / 顶层不是
 * object / 没有有效 ownerIds 的情况都失败，不打印文件路径，也不回退到默认值。
 *
 * @param {string|null|undefined} explicitPath
 * @returns {{ok: true, file: string, config: object, ownerIds: string[]}
 *   | {ok: false, code: string}}
 */
export function loadOwnerPrivateConfig(explicitPath) {
  const file = typeof explicitPath === 'string' && explicitPath.trim()
    ? explicitPath
    : DEFAULT_CONFIG_PATH;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, code: OWNER_PRIVATE_CONFIG_CODES.UNREADABLE };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { ok: false, code: OWNER_PRIVATE_CONFIG_CODES.INVALID_JSON };
  }

  if (!isPlainObject(config)) {
    return { ok: false, code: OWNER_PRIVATE_CONFIG_CODES.NOT_OBJECT };
  }

  const ownerIds = normalizeOwnerIds(config.ownerIds);
  if (!ownerIds.length) {
    return { ok: false, code: OWNER_PRIVATE_CONFIG_CODES.NO_OWNER_IDS };
  }

  return { ok: true, file, config, ownerIds };
}

/** 账号字段只接受字符串或有限数字；其余形状视为缺失。 */
function toUserId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 私聊消息不应带群号；空串 / null / undefined 视为没有。 */
function hasGroupId(value) {
  if (value === undefined || value === null) return false;
  return String(value).trim() !== '';
}

/**
 * 创建一个入口准入器。
 *
 * 放行条件（全部满足）：
 *   - 是 object，且 `isGroup === false`；
 *   - `userId` 是非空字符串 / 有限数字；
 *   - `key` 是 `private:<userId>`，与 `userId` 完全一致；
 *   - 没有非空 `groupId`；
 *   - `userId` 在 owner 白名单里。
 *
 * @param {{ownerIds?: unknown}} [options]
 * @returns {{ownerIds: string[], admit: (msg: unknown) => {ok: true, userId: string, key: string} | {ok: false, reason: string}}}
 */
export function createOwnerPrivateGate({ ownerIds } = {}) {
  const allowed = new Set(normalizeOwnerIds(ownerIds));
  const reject = (reason) => ({ ok: false, reason });

  return {
    ownerIds: [...allowed],
    admit(msg) {
      if (!isPlainObject(msg)) return reject(OWNER_PRIVATE_REJECTIONS.NOT_OBJECT);
      // 只接受明确的私聊；群聊、缺失 isGroup、以及任何非 false 值都拒绝。
      if (msg.isGroup !== false) return reject(OWNER_PRIVATE_REJECTIONS.GROUP);

      const userId = toUserId(msg.userId);
      if (!userId) return reject(OWNER_PRIVATE_REJECTIONS.MISSING_USER);

      const key = typeof msg.key === 'string' ? msg.key : '';
      if (!key) return reject(OWNER_PRIVATE_REJECTIONS.MISSING_SESSION);
      if (!key.startsWith('private:')) return reject(OWNER_PRIVATE_REJECTIONS.NOT_PRIVATE);

      const keyUser = key.slice('private:'.length);
      if (!keyUser) return reject(OWNER_PRIVATE_REJECTIONS.MISSING_SESSION);
      if (keyUser !== userId) return reject(OWNER_PRIVATE_REJECTIONS.SESSION_MISMATCH);
      if (hasGroupId(msg.groupId)) return reject(OWNER_PRIVATE_REJECTIONS.SESSION_MISMATCH);

      if (!allowed.has(userId)) return reject(OWNER_PRIVATE_REJECTIONS.NOT_OWNER);
      return { ok: true, userId, key };
    },
  };
}

export default createOwnerPrivateGate;
