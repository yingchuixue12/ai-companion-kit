/**
 * SOP06 · 工具宿主桥接（默认关闭，只接宿主显式注入的假工具）
 * ─────────────────────────────────────────────────────────────
 * 只做一件事：把可编程宿主接到现有 `tools/registry.js`，复用它的权限、确认、
 * 超时和脱敏审计，不复制那套语义。
 *
 *   - 默认关闭：只有 `enabled === true` 才创建注册表；关闭时所有入口都返回
 *     `tool-host-disabled`，不读工具、不调 handler；
 *   - 只接宿主显式注入的假工具：`tools` 是唯一来源，不扫描目录、不 import
 *     设备/电话/浏览器/账号/shell/网络/第三方服务。注入项还必须在构造期通过
 *     假工具有界门（名字以 demo_/fake_ 开头、非 high-risk、不可定时、超时 ≤5s、
 *     参数 ≤8 个、权限 ≤8 个、总数 ≤8 个）；
 *   - 授权：权限标签由宿主构造时显式授予，调用参数不能临时提权；
 *   - 确认：确认记录额外绑定 sessionKey。模型视图只有 `model.call`，没有
 *     actionId、request/decide 入口，因此确认工具在模型侧永远停在
 *     `confirmation-required`；宿主必须 request → 线下确认 → decide → execute
 *     （带同一 sessionKey 和 actionId）。任何“确认 / 同意 / yes”文本都不算批准；
 *     跨会话拿 actionId 只会得到 `confirmation-unknown`；
 *   - 失败：结果码原样来自 registry.js；超时、handler 抛错、权限拒绝、确认失败
 *     都只会是失败结果，桥接不重试、不包装成成功。`formatToolHostOutcome` 只在
 *     `ok === true && code === 'ok'` 时输出“已完成”；
 *   - 审计：`audit()` 直接返回 registry.js 的脱敏环形快照，不记录参数正文、
 *     身份内容、异常文本或 actionId。
 *
 * 不接真实动作；handler 必须是宿主注入的纯内存示例/假工具。超时只表示不再
 * 等待，已经发生的内存副作用无法取消，桥接也不自动补偿。权限是静态授予的，
 * 需要动态授权时由宿主重建桥接。
 */

import { createToolRegistry } from './registry.js';

const FAKE_TOOL_NAME = /^(?:demo|fake)_[a-z0-9_]{1,58}$/u;
const SAFE_RESULT_CODE = /^[a-z][a-z0-9-]{1,63}$/u;

const MAX_TOOLS = 8;
const MAX_TIMEOUT_MS = 5000;
const MAX_PROPERTIES = 8;
const MAX_PERMISSIONS = 16;
const MAX_TOOL_PERMISSIONS = 8;
const ACTION_ID_MAX = 128;
const SESSION_KEY_MAX = 128;

const DISABLED_CODE = 'tool-host-disabled';
const INVALID_CALL_CODE = 'invalid-call';
const UNKNOWN_CONFIRMATION_CODE = 'confirmation-unknown';
const EMPTY = Object.freeze([]);

/** 桥接配置只接受 `enabled: true` 的显式启用；关闭时其余字段完全不碰。 */
function readConfig(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createToolHostBridge: options 必须是对象');
  }
  if (options.enabled !== true) return null;

  const tools = options.tools === undefined ? [] : options.tools;
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    throw new TypeError('createToolHostBridge: tools 必须是数量有界的数组');
  }
  const permissions = options.permissions === undefined ? [] : options.permissions;
  if (!Array.isArray(permissions) || permissions.length > MAX_PERMISSIONS) {
    throw new TypeError('createToolHostBridge: permissions 必须是数量有界的数组');
  }
  const granted = [];
  const seen = new Set();
  for (const tag of permissions) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 64) {
      throw new TypeError('createToolHostBridge: 权限标签必须是非空短字符串');
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      granted.push(tag);
    }
  }
  return { tools, permissions: Object.freeze(granted) };
}

/** 只透传注册表真正认识的选项，避免桥接字段被误当成注册表配置。 */
function registryOptions(options) {
  const result = {};
  if (options.now !== undefined) result.now = options.now;
  if (options.createActionId !== undefined) result.createActionId = options.createActionId;
  if (options.auditLimit !== undefined) result.auditLimit = options.auditLimit;
  if (options.confirmationLimit !== undefined) result.confirmationLimit = options.confirmationLimit;
  return result;
}

/** 注入工具的假工具有界门；只读 registry.register 返回的冻结投影。 */
function assertFakeTool(view) {
  if (!FAKE_TOOL_NAME.test(view.name)) {
    throw new TypeError('注入工具名必须以 demo_ 或 fake_ 开头');
  }
  if (view.risk === 'high-risk') throw new TypeError('桥接拒绝 high-risk 工具');
  if (view.schedulable !== false) throw new TypeError('桥接拒绝可在定时上下文触发的工具');
  if (view.timeoutMs > MAX_TIMEOUT_MS) throw new RangeError('工具超时超过桥接上限');
  if (view.permissions.length > MAX_TOOL_PERMISSIONS) throw new RangeError('工具权限标签过多');
  if (!view.parameters || typeof view.parameters.properties !== 'object') {
    throw new TypeError('工具参数 schema 不合法');
  }
  if (Object.keys(view.parameters.properties).length > MAX_PROPERTIES) {
    throw new RangeError('工具参数过多');
  }
}

/**
 * 只读宿主上下文里的 actionId / sessionKey。
 * 只认自有数据属性；继承属性、访问器、非字符串、空串、超长值一律 invalid-call。
 * 其他键（模型塞进来的 permissions / approval 文本等）全部忽略。
 */
function readContext(context) {
  if (context === undefined) return { ok: true, actionId: null, sessionKey: null };
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return { ok: false };
  }
  try {
    const readOwnString = (key, maxLength) => {
      if (!Object.hasOwn(context, key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(context, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('访问器');
      if (typeof descriptor.value !== 'string' || descriptor.value.length === 0 || descriptor.value.length > maxLength) {
        throw new TypeError('非法字符串');
      }
      return descriptor.value;
    };
    return {
      ok: true,
      actionId: readOwnString('actionId', ACTION_ID_MAX),
      sessionKey: readOwnString('sessionKey', SESSION_KEY_MAX),
    };
  } catch {
    return { ok: false };
  }
}

function disabledResult() {
  return Object.freeze({ ok: false, code: DISABLED_CODE });
}

function invalidCallResult(name) {
  const result = { ok: false, code: INVALID_CALL_CODE };
  if (typeof name === 'string' && FAKE_TOOL_NAME.test(name)) result.tool = name;
  return Object.freeze(result);
}

function unknownConfirmationResult(name) {
  const result = { ok: false, code: UNKNOWN_CONFIRMATION_CODE };
  if (typeof name === 'string' && FAKE_TOOL_NAME.test(name)) result.tool = name;
  return Object.freeze(result);
}

/**
 * 创建工具宿主桥接。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled=false] 只有显式 true 才启用；默认关闭
 * @param {object[]} [options.tools=[]] 宿主显式注入的假工具定义（registry.js 定义格式）
 * @param {string[]} [options.permissions=[]] 宿主显式授予的权限标签
 * @param {() => number} [options.now] 透传 registry.js 时钟
 * @param {() => string} [options.createActionId] 透传 registry.js actionId 生成器
 * @param {number} [options.auditLimit] 透传 registry.js 审计上限
 * @param {number} [options.confirmationLimit] 透传 registry.js 确认记录上限
 */
export function createToolHostBridge(options = {}) {
  const config = readConfig(options);
  if (!config) return makeBridge(null, EMPTY);

  const registry = createToolRegistry(registryOptions(options));
  for (const definition of config.tools) {
    assertFakeTool(registry.register(definition));
  }
  return makeBridge(registry, config.permissions);
}

function makeBridge(registry, permissions) {
  /** actionId → sessionKey；只保存 bridge.requestConfirmation 成功建立的凭据。 */
  const confirmationSessions = new Map();

  async function execute(name, args, context) {
    if (!registry) return disabledResult();
    const parsed = readContext(context);
    if (!parsed.ok) return invalidCallResult(name);
    // actionId 必须来自同一 session 的 request；否则连确认记录都不查，直接 fail closed。
    if (parsed.actionId !== null && confirmationSessions.get(parsed.actionId) !== parsed.sessionKey) {
      return unknownConfirmationResult(name);
    }
    const registryContext = { trigger: 'user', permissions };
    if (parsed.actionId !== null) registryContext.actionId = parsed.actionId;
    return registry.execute(name, args, registryContext);
  }

  function requestConfirmation(name, args, context) {
    if (!registry) return disabledResult();
    const parsed = readContext(context);
    if (!parsed.ok || parsed.sessionKey === null) return invalidCallResult(name);
    const result = registry.requestConfirmation(name, args);
    if (result.ok) confirmationSessions.set(result.actionId, parsed.sessionKey);
    return result;
  }

  function decideConfirmation(actionId, decision, context) {
    if (!registry) return disabledResult();
    const parsed = readContext(context);
    if (
      !parsed.ok
      || parsed.sessionKey === null
      || typeof actionId !== 'string'
      || confirmationSessions.get(actionId) !== parsed.sessionKey
    ) {
      return unknownConfirmationResult();
    }
    return registry.decideConfirmation(actionId, decision);
  }

  const model = Object.freeze({
    /** 模型只能走这一层：没有 actionId，也没有 request/decide，确认工具无法被模型批准。 */
    call: (name, args) => execute(name, args),
  });

  return Object.freeze({
    enabled: registry !== null,
    model,
    execute,
    requestConfirmation,
    decideConfirmation,
    listTools: () => (registry ? registry.list() : EMPTY),
    audit: () => (registry ? registry.audit() : EMPTY),
  });
}

/**
 * 把结果转成宿主可安全播报的固定短语。
 * 只有 `ok === true`、`code === 'ok'`、工具名是合法假工具名时才输出“已完成”；
 * 其余形状一律“未完成”，不包含返回值或任何原始文本。
 */
export function formatToolHostOutcome(result) {
  let tool = null;
  let code = 'unknown-error';
  let ok = false;
  try {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (typeof result.tool === 'string' && FAKE_TOOL_NAME.test(result.tool)) tool = result.tool;
      if (typeof result.code === 'string' && result.code !== 'ok' && SAFE_RESULT_CODE.test(result.code)) {
        code = result.code;
      }
      ok = result.ok === true && result.code === 'ok' && tool !== null;
    }
  } catch {
    ok = false;
  }
  if (ok) return Object.freeze({ ok: true, tool, code: 'ok', text: `工具 ${tool} 已完成。` });
  return Object.freeze({
    ok: false,
    tool,
    code,
    text: `工具 ${tool ?? '（未命名）'} 未完成（${code}）。`,
  });
}

export default createToolHostBridge;