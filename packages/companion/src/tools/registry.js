/**
 * E0 通用工具注册与安全执行内核（离线、纯内存、不接真实服务）
 * ─────────────────────────────────────────────────────────────
 * 这一层只负责「工具怎么被声明、能不能执行、执行结果怎么被记录」，不接
 * AgentLoop / QQ / OneBot / phone / qzone，也不读写磁盘、不联网、不调模型。
 * 它本身不是任何真实工具的入口；下面的 demo_note_* 只是纯内存演示桩。
 *
 * 每个注册定义必须**显式**声明（缺任何一项都拒绝注册，不做默认值兜底）：
 *   - name / description / parameters：稳定工具名、说明、JSON 参数 schema 子集；
 *   - risk：'read-only' | 'reversible' | 'confirm' | 'high-risk' 四级；
 *   - permissions：权限标签数组（执行上下文必须全部具备；空数组表示"无需权限"）；
 *   - timeoutMs：有限超时（1 ~ 60000 毫秒）；
 *   - failurePolicy：'stop' | 'rollback'（rollback 必须提供 compensate）；
 *   - compensate：撤销/补偿函数或显式 null（reversible 必须提供函数）；
 *   - schedulable：是否允许定时任务上下文触发；
 *   - auditFields：额外审计字段（'trigger' | 'durationMs' | 'argsDigest'）；
 *   - handler：异步或同步函数，只允许在本地内存里工作。
 *
 * 分级与门控（全部 fail closed）：
 *   - read-only / reversible：校验通过即可执行；
 *   - confirm：必须先 requestConfirmation → decideConfirmation('approve')，
 *     执行时用同一个 actionId，且批准绑定「工具名 + 参数摘要」；
 *     换了参数不能复用批准；拒绝过的 actionId 不能重试、不能翻案；
 *     批准一次性：一旦用于执行（含执行失败/超时）即消耗，重试要重新请求；
 *   - high-risk：E0 只允许登记，永不执行（副作用评测之前不开放）。
 *
 * 稳定错误码（闭合词汇，结果里不回显原始入参、异常文本或身份内容）：
 *   注册期抛 ToolRegistryError（code + 静态字段名，不含字段值）；
 *   执行期返回 { ok: false, code }，成功返回 { ok: true, code: 'ok', value }。
 *
 * 审计只存安全的结构化元数据：工具名、风险、开始时间、结果码、确认状态、
 * 以及关联标识（c-<sha256 前缀>）。有 actionId 时由 actionId 派生，不可反推；
 * 无 actionId 时由内部单调 attempt 序号派生，不依赖可能抛错的生成器。
 * 不存参数正文、用户标识、异常消息。审计有上限，满则丢最旧的一条并计数；
 * 快照与结果都是深冻结的，外部改不动。
 *
 * 输入/输出边界：
 *   - 参数在入口一次性快照成「自有可枚举数据属性」的冻结副本，原型属性、访问器、
 *     Symbol 键、不可枚举键、Proxy 陷阱一律 invalid-arguments；schema、摘要与
 *     handler 都只看这份副本，避免“校验 A、执行 B”。handler 收到的是冻结的
 *     null 原型对象（可正常读取/spread/JSON 序列化，但没有 hasOwnProperty 等方法）。
 *   - handler 返回值投影成 JSON 安全的深冻结纯数据；Map/Set/Date/TypedArray、
 *     函数、Symbol、类实例、访问器、非枚举属性、稀疏数组、数组额外属性/Symbol 键、
 *     非有限数字一律 handler-failed，绝不允许“审计记成功、返回却抛异常”。
 *   - 注册定义本身也会做同样的快照；定义里嵌套的访问器/Proxy 抛出的任意异常
 *     一律折叠成 invalid-definition，不回显异常文本。
 *   - 执行上下文的 trigger 默认 'user'；调度入口必须显式传 'scheduled'，否则
 *     schedulable=false 的工具会被当成用户轮次放行。
 *
 * 审计事件（每条记录都带 event）：
 *   - 'execute'：一次执行尝试（含被门控拒绝的尝试）；
 *   - 'confirmation-request'：成功建立的确认请求（confirmation=pending，code=ok）；
 *   - 'confirmation-decision'：成功的批准/拒绝（confirmation=approved|denied）；
 *   - 'confirmation-request-rejected' / 'confirmation-decision-rejected'：可归属的
 *     失败（容量/参数/风险/生成器 ID 不可用、非法决策、重复决策等），只记闭合码
 *     与当前状态。未知工具名、未知/非法 actionId 的决策不落审计：无法归属到已注册
 *     工具，也避免把攻击者选择的值写进审计；这些情况仍返回稳定闭合码。
 *
 * 不落审计的两种情况（都是调用方错误、不是工具尝试）：工具名未知（名字不可信，
 * 不回显也不入库）、执行上下文形状非法（避免把未知触发词写进记录）。
 *
 * 已知限制（不掩盖）：
 *   - 超时只是「不再等待」，handler 已经产生的副作用无法取消，因此超时后不记录
 *     成功、也不自动补偿（结果未知），迟到结果一律丢弃；同步阻塞的 handler 仍会
 *     卡住事件循环；
 *   - 确认记录（pending/approved/denied/consumed）按容量上限 fail closed，但没有
 *     TTL/主动清理，容量耗尽后新确认请求会一直被拒；
 *   - 结果投影为普通原型的深冻结纯数据（深度上限 8），没有字节/条目大小上限；
 *     极端大的返回值会带来拷贝成本，接入真实工具时应在上层再设输出预算；
 *   - 审计是进程内环形缓冲：满则丢最旧，可被高频调用冲刷，不能当作不可篡改证据；
 *     argsDigest / correlationId 是无密钥截断哈希，只用于关联，低熵参数可枚举；
 *   - 权限标签完全由调用方上下文声明，本层不做身份/授权校验（属 U3/U4 范围）。
 */

import { createHash, randomUUID } from 'node:crypto';

/** 工具风险等级（声明词汇，顺序稳定）。 */
export const TOOL_RISK_LEVELS = Object.freeze(['read-only', 'reversible', 'confirm', 'high-risk']);

/** 失败策略：stop = 直接失败；rollback = 失败后调用 compensate 尝试撤销。 */
export const TOOL_FAILURE_POLICIES = Object.freeze(['stop', 'rollback']);

/** 执行上下文里允许的触发来源。 */
export const TOOL_TRIGGERS = Object.freeze(['user', 'scheduled']);

/** 确认记录的状态机。 */
export const CONFIRMATION_STATUSES = Object.freeze(['pending', 'approved', 'denied', 'consumed']);

/** 注册定义里可以额外声明的审计字段（只允许这些安全字段）。 */
export const TOOL_AUDIT_FIELDS = Object.freeze(['trigger', 'durationMs', 'argsDigest']);

/** 注册与运行时的硬上限（避免无界增长与超长描述）。 */
export const TOOL_REGISTRY_LIMITS = Object.freeze({
  nameLength: 64,
  descriptionLength: 800,
  timeoutMs: 60_000,
  permissionTagLength: 64,
  auditEntries: Object.freeze({ default: 50, max: 500 }),
  confirmations: Object.freeze({ default: 100, max: 1000 }),
});

/** 注册期错误码：非法声明一律拒绝注册，不做「部分可用」。 */
export const TOOL_REGISTRATION_ERRORS = Object.freeze({
  invalidDefinition: 'invalid-definition',
  invalidName: 'invalid-name',
  duplicateName: 'duplicate-name',
  invalidDescription: 'invalid-description',
  invalidSchema: 'invalid-schema',
  unsupportedSchema: 'unsupported-schema',
  invalidRisk: 'invalid-risk',
  invalidPermissions: 'invalid-permissions',
  invalidTimeout: 'invalid-timeout',
  invalidFailurePolicy: 'invalid-failure-policy',
  invalidCompensation: 'invalid-compensation',
  invalidSchedulable: 'invalid-schedulable',
  invalidAuditFields: 'invalid-audit-fields',
  invalidHandler: 'invalid-handler',
  invalidOptions: 'invalid-options',
});

/** 审计事件类型（闭合词汇；request/decision 事件与 execute 共用同一条审计流）。 */
export const TOOL_AUDIT_EVENTS = Object.freeze([
  'execute',
  'confirmation-request',
  'confirmation-decision',
  'confirmation-request-rejected',
  'confirmation-decision-rejected',
]);

/** 执行期结果码（成功也走同一个 code 字段）。 */
export const TOOL_RESULT_CODES = Object.freeze({
  ok: 'ok',
  unknownTool: 'unknown-tool',
  invalidArguments: 'invalid-arguments',
  permissionDenied: 'permission-denied',
  invalidContext: 'invalid-context',
  scheduledNotAllowed: 'scheduled-trigger-not-allowed',
  riskNotAllowed: 'risk-not-allowed',
  confirmationRequired: 'confirmation-required',
  confirmationPending: 'confirmation-pending',
  confirmationUnknown: 'confirmation-unknown',
  confirmationDenied: 'confirmation-denied',
  confirmationMismatch: 'confirmation-mismatch',
  confirmationUsed: 'confirmation-used',
  confirmationNotRequired: 'confirmation-not-required',
  confirmationCapacity: 'confirmation-capacity',
  confirmationIdUnavailable: 'confirmation-id-unavailable',
  invalidDecision: 'invalid-decision',
  confirmationAlreadyDecided: 'confirmation-already-decided',
  handlerFailed: 'handler-failed',
  timeout: 'timeout',
});

/** 审计里的确认状态投影（不记录任何确认正文）。 */
export const TOOL_CONFIRMATION_STATES = Object.freeze({
  notRequired: 'not-required',
  notCreated: 'not-created',
  missing: 'missing',
  pending: 'pending',
  approved: 'approved',
  denied: 'denied',
  mismatch: 'mismatch',
  unknown: 'unknown',
  used: 'consumed',
});

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const PERMISSION_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/u;
/**
 * actionId 的安全形状：非空、至多 128 字符、只允许 URL 安全字符集。
 * 生成器输出必须匹配，否则按 confirmation-id-unavailable fail closed，
 * 既不落库也不回显具体值。
 */
const ACTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** 审计与返回里展示的参数摘要长度（sha256 前缀，只用于关联，不含正文）。 */
const DIGEST_PREFIX_LENGTH = 16;
/** ECMAScript Date TimeClip 可表示的最大绝对毫秒数。 */
const MAX_TIMESTAMP_MS = 8.64e15;
/** 结果投影的最大嵌套深度：超过即视为 handler 返回了不安全结构。 */
const RESULT_MAX_DEPTH = 8;

const DEFINITION_KEYS = new Set([
  'name',
  'description',
  'parameters',
  'risk',
  'permissions',
  'timeoutMs',
  'failurePolicy',
  'compensate',
  'schedulable',
  'auditFields',
  'handler',
]);

const SCHEMA_ROOT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties']);
const SCHEMA_PROPERTY_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const SCHEMA_KEYWORDS_BY_TYPE = Object.freeze({
  string: new Set(['type', 'description', 'enum', 'minLength', 'maxLength']),
  integer: new Set(['type', 'description', 'enum', 'minimum', 'maximum']),
  number: new Set(['type', 'description', 'enum', 'minimum', 'maximum']),
  boolean: new Set(['type', 'description']),
});

/** 内部错误登记表：error → 不可变的 {code, field}；外部伪造错误不会命中。 */
const INTERNAL_ERRORS = new WeakMap();

/** 注册期错误：只带闭合错误码与静态字段名，消息里永远不出现字段值。 */
export class ToolRegistryError extends Error {
  /**
   * @param {string} code TOOL_REGISTRATION_ERRORS 里的闭合错误码
   * @param {string|null} [field] 静态字段名（如 'risk'），不是字段值
   */
  constructor(code, field = null) {
    super(field ? `${code} (field: ${field})` : code);
    this.name = 'ToolRegistryError';
    this.code = code;
    this.field = field;
  }
}

/**
 * 抛出内部错误：错误对象本身冻结（外部改不动），同时把权威元数据存进
 * 私有 WeakMap；即使有人捕获后又篡改/转手抛出，register 也只按私有元数据
 * 重新构造错误，绝不信任 error.code/field/message。
 */
function reject(code, field = null) {
  const error = new ToolRegistryError(code, field);
  INTERNAL_ERRORS.set(error, Object.freeze({ code, field }));
  throw Object.freeze(error);
}

function requireCondition(condition, code, field = null) {
  if (!condition) reject(code, field);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深冻结：对象/数组及其子节点都不可改写（先冻结父节点，循环引用也不会递归失控）。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** 只用于复制 JSON 形状的 schema，避免注册后被调用方原地改写。 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = deepClone(child);
    return copy;
  }
  return value;
}

function matchesType(type, value) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 把调用方给的参数一次性快照成「只含自有可枚举数据属性」的冻结对象。
 *
 * 为什么必须快照：校验、摘要、handler 若各自读取原始活对象，访问器可以在两次
 * 读取之间返回不同值（摘要过的是 A、执行的是 B），继承属性又能绕过
 * additionalProperties/required 与摘要绑定。这里统一拒绝：
 * - 非普通对象（数组/null/类实例）或原型不是 Object.prototype / null；
 * - 任何 Symbol 键、不可枚举键、访问器属性；
 * - 快照过程本身抛错（如 Proxy 陷阱）。
 * 任一情况返回 null，调用方按 invalid-arguments fail closed（不回显原因）。
 */
function snapshotArguments(args) {
  try {
    if (!isPlainObject(args)) return null;
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(args);
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** 数组的规范下标判定：只认 "0"~"2^32-2" 这种字符串键。 */
function isArrayIndexKey(key) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index <= 2 ** 32 - 2 && String(index) === key;
}

/**
 * 注册定义的一次性深快照。
 *
 * 与 snapshotArguments 同思路，但递归到嵌套对象/数组：普通对象/数组只接受自有、
 * 可枚举、字符串键的数据属性；函数（handler/compensate）按引用保留；访问器、
 * Symbol、隐藏键、非普通原型、Proxy 陷阱、循环引用（由深度上限兜住）、超过
 * DEFINITION_MAX_DEPTH 的嵌套全部抛错，由 register 折叠成 invalid-definition。
 * 校验、存储、投影都只读取这份快照，杜绝“校验时一个值、建表时另一个值”。
 */
const DEFINITION_MAX_DEPTH = 8;
/** 定义里数组的长度上限：巨大稀疏数组在快照阶段就快速拒绝，避免长循环。 */
const DEFINITION_MAX_ARRAY_LENGTH = 1024;

function deepSnapshotDefinition(value, depth = 0) {
  if (depth > DEFINITION_MAX_DEPTH) throw new TypeError('unsafe-definition');
  if (value === undefined) return undefined;
  if (typeof value === 'function') return value;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value !== 'object') throw new TypeError('unsafe-definition');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('unsafe-definition');
    const length = value.length;
    if (length > DEFINITION_MAX_ARRAY_LENGTH) throw new TypeError('unsafe-definition');
    const copy = [];
    let indices = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= length) {
        throw new TypeError('unsafe-definition');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('unsafe-definition');
      }
      copy[Number(key)] = deepSnapshotDefinition(descriptor.value, depth + 1);
      indices += 1;
    }
    // 任意空洞（不只是尾部）都按非法定义拒绝：自有下标数量必须等于 length。
    if (indices !== length) throw new TypeError('unsafe-definition');
    return copy;
  }
  // 走到这里已经是非 null 对象且不是数组；只接受普通对象或 null 原型。
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('unsafe-definition');
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('unsafe-definition');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('unsafe-definition');
    }
    Object.defineProperty(copy, key, {
      value: deepSnapshotDefinition(descriptor.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * 把 handler 的返回值投影成 JSON 安全的深冻结数据。
 *
 * 只接受 null / 有限数字 / 字符串 / 布尔 / undefined / 数组 / 普通对象（含
 * null 原型）；Map、Set、Date、TypedArray、函数、Symbol、类实例、访问器属性、
 * 非枚举属性、稀疏数组、数组额外属性/Symbol 键、非有限数字、Symbol 键、超过
 * RESULT_MAX_DEPTH 的嵌套一律抛错，由 execute 记 handler-failed —— 不允许
 * 「审计已记成功、返回却抛异常」，也不允许隐藏字段借结果外泄。
 */
function copyResultValue(value, depth = 0) {
  if (depth > RESULT_MAX_DEPTH) throw new TypeError('unsafe-result');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('unsafe-result');
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('unsafe-result');
    // 只读一次 length：Proxy 的 getter 若在两次读取之间变化，不能造成“拷贝用 A、检查用 B”。
    const length = value.length;
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('unsafe-result');
      }
      copy.push(copyResultValue(descriptor.value, depth + 1));
    }
    // 数组只允许 length 范围内的数字下标：额外自有属性或 Symbol 键一律拒绝，
    // 越界下标（Proxy 可以谎报）也不能悄悄丢掉。
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !isArrayIndexKey(key) || Number(key) >= length) {
        throw new TypeError('unsafe-result');
      }
    }
    return Object.freeze(copy);
  }
  if (!isPlainObject(value)) throw new TypeError('unsafe-result');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('unsafe-result');
  const copy = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('unsafe-result');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('unsafe-result');
    }
    // defineProperty 而不是赋值：即使键叫 __proto__ 也只会建自有数据属性。
    Object.defineProperty(copy, key, {
      value: copyResultValue(descriptor.value, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

/** 参数 schema 的静态校验（只支持一小撮 JSON Schema 关键字，其余一律拒绝）。 */
function validateParametersSchema(schema) {
  requireCondition(isPlainObject(schema), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters');
  for (const key of Object.keys(schema)) {
    requireCondition(SCHEMA_ROOT_KEYS.has(key), TOOL_REGISTRATION_ERRORS.unsupportedSchema, 'parameters');
  }
  requireCondition(schema.type === 'object', TOOL_REGISTRATION_ERRORS.unsupportedSchema, 'parameters.type');
  requireCondition(
    schema.additionalProperties === false,
    TOOL_REGISTRATION_ERRORS.invalidSchema,
    'parameters.additionalProperties',
  );
  requireCondition(isPlainObject(schema.properties), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties');
  for (const [propertyName, spec] of Object.entries(schema.properties)) {
    requireCondition(NAME_PATTERN.test(propertyName), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties');
    validatePropertySchema(spec);
  }
  if (schema.required !== undefined) {
    requireCondition(Array.isArray(schema.required), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.required');
    const seen = new Set();
    for (const name of schema.required) {
      requireCondition(
        typeof name === 'string' && Object.hasOwn(schema.properties, name) && !seen.has(name),
        TOOL_REGISTRATION_ERRORS.invalidSchema,
        'parameters.required',
      );
      seen.add(name);
    }
  }
}

function validatePropertySchema(spec) {
  requireCondition(isPlainObject(spec), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties');
  requireCondition(
    typeof spec.type === 'string' && SCHEMA_PROPERTY_TYPES.has(spec.type),
    TOOL_REGISTRATION_ERRORS.unsupportedSchema,
    'parameters.properties.type',
  );
  const allowed = SCHEMA_KEYWORDS_BY_TYPE[spec.type];
  for (const keyword of Object.keys(spec)) {
    requireCondition(allowed.has(keyword), TOOL_REGISTRATION_ERRORS.unsupportedSchema, 'parameters.properties');
  }
  if (spec.description !== undefined) {
    requireCondition(
      typeof spec.description === 'string' && spec.description.length > 0,
      TOOL_REGISTRATION_ERRORS.invalidSchema,
      'parameters.properties.description',
    );
  }
  if (spec.enum !== undefined) {
    requireCondition(
      Array.isArray(spec.enum) && spec.enum.length > 0,
      TOOL_REGISTRATION_ERRORS.invalidSchema,
      'parameters.properties.enum',
    );
    const seen = new Set();
    for (const candidate of spec.enum) {
      requireCondition(
        matchesType(spec.type, candidate) && !seen.has(candidate),
        TOOL_REGISTRATION_ERRORS.invalidSchema,
        'parameters.properties.enum',
      );
      seen.add(candidate);
    }
  }
  if (spec.type === 'string') {
    if (spec.minLength !== undefined) {
      requireCondition(
        Number.isInteger(spec.minLength) && spec.minLength >= 0,
        TOOL_REGISTRATION_ERRORS.invalidSchema,
        'parameters.properties.minLength',
      );
    }
    if (spec.maxLength !== undefined) {
      requireCondition(
        Number.isInteger(spec.maxLength) && spec.maxLength >= 0,
        TOOL_REGISTRATION_ERRORS.invalidSchema,
        'parameters.properties.maxLength',
      );
    }
    if (spec.minLength !== undefined && spec.maxLength !== undefined) {
      requireCondition(
        spec.maxLength >= spec.minLength,
        TOOL_REGISTRATION_ERRORS.invalidSchema,
        'parameters.properties.maxLength',
      );
    }
  }
  if (spec.type === 'integer' || spec.type === 'number') {
    if (spec.minimum !== undefined) {
      requireCondition(Number.isFinite(spec.minimum), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties.minimum');
    }
    if (spec.maximum !== undefined) {
      requireCondition(Number.isFinite(spec.maximum), TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties.maximum');
    }
    if (spec.minimum !== undefined && spec.maximum !== undefined) {
      requireCondition(spec.maximum >= spec.minimum, TOOL_REGISTRATION_ERRORS.invalidSchema, 'parameters.properties.maximum');
    }
  }
}

function validatePermissions(permissions) {
  requireCondition(Array.isArray(permissions), TOOL_REGISTRATION_ERRORS.invalidPermissions, 'permissions');
  const seen = new Set();
  for (const tag of permissions) {
    requireCondition(
      typeof tag === 'string' && PERMISSION_PATTERN.test(tag) && !seen.has(tag),
      TOOL_REGISTRATION_ERRORS.invalidPermissions,
      'permissions',
    );
    seen.add(tag);
  }
}

function validateAuditFields(fields) {
  requireCondition(Array.isArray(fields), TOOL_REGISTRATION_ERRORS.invalidAuditFields, 'auditFields');
  const seen = new Set();
  for (const field of fields) {
    requireCondition(
      typeof field === 'string' && TOOL_AUDIT_FIELDS.includes(field) && !seen.has(field),
      TOOL_REGISTRATION_ERRORS.invalidAuditFields,
      'auditFields',
    );
    seen.add(field);
  }
}

/**
 * 校验一份工具定义并生成冻结的内部记录。
 * 合法时返回 { name, description, parameters, risk, permissions, timeoutMs,
 * failurePolicy, compensate, schedulable, auditFields, handler }。
 */
function buildDefinition(candidate) {
  requireCondition(isPlainObject(candidate), TOOL_REGISTRATION_ERRORS.invalidDefinition);
  // 定义先做一次性深快照：访问器、隐藏键、Symbol、异常 Proxy 都按非法定义拒绝，
  // 校验与建表读的是同一份纯数据，不存在“校验 A、存储 B”。
  const definition = deepSnapshotDefinition(candidate);
  // 只认白名单字段：拼错的字段（如 scheduleable）会按“缺字段”拒绝，而不是被静默忽略。
  for (const key of Object.keys(definition)) {
    requireCondition(DEFINITION_KEYS.has(key), TOOL_REGISTRATION_ERRORS.invalidDefinition);
  }
  requireCondition(
    typeof definition.name === 'string'
      && definition.name.length <= TOOL_REGISTRY_LIMITS.nameLength
      && NAME_PATTERN.test(definition.name),
    TOOL_REGISTRATION_ERRORS.invalidName,
    'name',
  );
  const { description } = definition;
  requireCondition(
    typeof description === 'string'
      && description.trim().length > 0
      && description.length <= TOOL_REGISTRY_LIMITS.descriptionLength,
    TOOL_REGISTRATION_ERRORS.invalidDescription,
    'description',
  );
  validateParametersSchema(definition.parameters);
  requireCondition(
    TOOL_RISK_LEVELS.includes(definition.risk),
    TOOL_REGISTRATION_ERRORS.invalidRisk,
    'risk',
  );
  validatePermissions(definition.permissions);
  requireCondition(
    Number.isInteger(definition.timeoutMs)
      && definition.timeoutMs > 0
      && definition.timeoutMs <= TOOL_REGISTRY_LIMITS.timeoutMs,
    TOOL_REGISTRATION_ERRORS.invalidTimeout,
    'timeoutMs',
  );
  requireCondition(
    TOOL_FAILURE_POLICIES.includes(definition.failurePolicy),
    TOOL_REGISTRATION_ERRORS.invalidFailurePolicy,
    'failurePolicy',
  );
  const { compensate } = definition;
  requireCondition(
    compensate === null || typeof compensate === 'function',
    TOOL_REGISTRATION_ERRORS.invalidCompensation,
    'compensate',
  );
  // 可逆工具必须说清怎么撤销；rollback 策略没有撤销实现就是自相矛盾。
  if (definition.risk === 'reversible' || definition.failurePolicy === 'rollback') {
    requireCondition(
      typeof compensate === 'function',
      TOOL_REGISTRATION_ERRORS.invalidCompensation,
      'compensate',
    );
  }
  requireCondition(
    typeof definition.schedulable === 'boolean',
    TOOL_REGISTRATION_ERRORS.invalidSchedulable,
    'schedulable',
  );
  validateAuditFields(definition.auditFields);
  requireCondition(typeof definition.handler === 'function', TOOL_REGISTRATION_ERRORS.invalidHandler, 'handler');

  return deepFreeze({
    name: definition.name,
    description,
    parameters: deepClone(definition.parameters),
    risk: definition.risk,
    permissions: [...definition.permissions],
    timeoutMs: definition.timeoutMs,
    failurePolicy: definition.failurePolicy,
    compensate,
    schedulable: definition.schedulable,
    auditFields: [...definition.auditFields],
    handler: definition.handler,
  });
}

/** 对外可见的冻结投影：不含 handler / compensate，schema 是独立副本。 */
function publicView(definition) {
  return deepFreeze({
    name: definition.name,
    description: definition.description,
    parameters: deepClone(definition.parameters),
    risk: definition.risk,
    permissions: [...definition.permissions],
    timeoutMs: definition.timeoutMs,
    failurePolicy: definition.failurePolicy,
    compensable: typeof definition.compensate === 'function',
    schedulable: definition.schedulable,
    auditFields: [...definition.auditFields],
    requiresConfirmation: definition.risk === 'confirm',
  });
}

/** 参数是否满足注册时的 schema（不做类型转换，未知键一律拒绝；入参已由 snapshotArguments 归一）。 */
function matchesSchema(schema, args) {
  const properties = schema.properties;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return false;
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) return false;
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (Object.hasOwn(args, key) && !matchesProperty(spec, args[key])) return false;
  }
  return true;
}

function matchesProperty(spec, value) {
  if (!matchesType(spec.type, value)) return false;
  if (spec.enum !== undefined && !spec.enum.includes(value)) return false;
  if (spec.type === 'string') {
    if (spec.minLength !== undefined && value.length < spec.minLength) return false;
    if (spec.maxLength !== undefined && value.length > spec.maxLength) return false;
  } else if (spec.type === 'integer' || spec.type === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) return false;
    if (spec.maximum !== undefined && value > spec.maximum) return false;
  }
  return true;
}

/** 参数摘要：只对已通过 schema 的扁平参数做 sha256（键排序，结果稳定）。 */
function digestArguments(args) {
  const keys = Object.keys(args).sort();
  const body = JSON.stringify(keys.map((key) => [key, args[key]]));
  return createHash('sha256').update(body).digest('hex');
}

/** actionId 的派生关联标识：审计里只出现它，出不去也反推不回 actionId。 */
function correlate(toolName, actionId) {
  const digest = createHash('sha256').update(`${toolName}\u0000${actionId}`).digest('hex');
  return `c-${digest.slice(0, DIGEST_PREFIX_LENGTH)}`;
}

/**
 * 无 actionId 的执行尝试使用内部单调序号关联，不再向 actionId 生成器借值：
 * 生成器可能抛错或返回重复值，而审计关联必须始终可写、不可被调用方控制。
 * 前缀含 NUL，与合法 actionId 的字符集（不含 NUL）天然隔离。
 */
function correlateAnonymous(toolName, attempt) {
  return correlate(toolName, `\u0000anonymous-attempt:${attempt}`);
}

function isRepresentableTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS;
}

/** 本地时钟兜底；即使运行环境把 Date.now 弄坏，也退到纪元 0 保证 Date 可表示。 */
function localTimestamp() {
  try {
    const fallback = Date.now();
    return isRepresentableTimestamp(fallback) ? fallback : 0;
  } catch {
    return 0;
  }
}

/** 把任意时钟输出归一为有限、可被 Date 表示的毫秒值；非法时回退到有效本地时间。 */
function normalizeTimestamp(value) {
  return isRepresentableTimestamp(value) ? value : localTimestamp();
}

/**
 * 时钟注入边界：调用注入的 now() 绝不向外抛异常。抛错、NaN、Infinity、
 * 超出 Date 可表示范围的值都折叠为有效本地时间。
 */
function readTimestamp(source) {
  try {
    return normalizeTimestamp(source());
  } catch {
    return localTimestamp();
  }
}

/** 生成审计/确认视图里的 ISO 时间；输入再坏也不会抛 RangeError。 */
function toIsoTimestamp(value) {
  return new Date(normalizeTimestamp(value)).toISOString();
}

/** 执行上下文归一化：只认对象、闭合触发词、字符串权限标签。 */
function readContext(context) {
  if (!isPlainObject(context)) return { ok: false };
  const trigger = context.trigger === undefined ? 'user' : context.trigger;
  if (!TOOL_TRIGGERS.includes(trigger)) return { ok: false };
  const permissions = context.permissions === undefined ? [] : context.permissions;
  if (!(permissions instanceof Set) && !Array.isArray(permissions)) return { ok: false };
  const granted = new Set();
  for (const tag of permissions) {
    if (typeof tag !== 'string') return { ok: false };
    granted.add(tag);
  }
  return { ok: true, trigger, permissions: granted };
}

function hasPermissions(definition, granted) {
  return definition.permissions.every((tag) => granted.has(tag));
}

function readLimitOption(value, field, limits) {
  if (value === undefined) return limits.default;
  requireCondition(
    Number.isInteger(value) && value >= 1 && value <= limits.max,
    TOOL_REGISTRATION_ERRORS.invalidOptions,
    field,
  );
  return value;
}

function readOptions(options) {
  requireCondition(isPlainObject(options), TOOL_REGISTRATION_ERRORS.invalidOptions);
  const now = options.now === undefined ? () => Date.now() : options.now;
  requireCondition(typeof now === 'function', TOOL_REGISTRATION_ERRORS.invalidOptions, 'now');
  const createActionId = options.createActionId === undefined ? () => randomUUID() : options.createActionId;
  requireCondition(
    typeof createActionId === 'function',
    TOOL_REGISTRATION_ERRORS.invalidOptions,
    'createActionId',
  );
  return {
    now,
    createActionId,
    auditLimit: readLimitOption(options.auditLimit, 'auditLimit', TOOL_REGISTRY_LIMITS.auditEntries),
    confirmationLimit: readLimitOption(
      options.confirmationLimit,
      'confirmationLimit',
      TOOL_REGISTRY_LIMITS.confirmations,
    ),
  };
}

/** 调用 handler 并施加超时：超时后不再关心迟到结果，也不记成功。 */
function invokeHandler(definition, args, context) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: TOOL_RESULT_CODES.timeout });
    }, definition.timeoutMs);
    let returned;
    try {
      returned = definition.handler(args, context);
    } catch {
      // 异常文本一律丢弃：只回稳定错误码。
      finish({ ok: false, code: TOOL_RESULT_CODES.handlerFailed });
      return;
    }
    Promise.resolve(returned).then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, code: TOOL_RESULT_CODES.handlerFailed }),
    );
  });
}

/** 失败补偿：只报告是否成功执行了补偿，不向上抛异常，也不回显异常文本。 */
async function runCompensation(definition, args, context) {
  try {
    await definition.compensate(args, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * 造一个工具注册表。返回对象本身冻结；所有状态都在闭包里。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时间源（测试注入，默认 Date.now）
 * @param {() => string} [options.createActionId] actionId 生成器（测试注入，默认 randomUUID）
 * @param {number} [options.auditLimit] 审计上限（1~500，默认 50）
 * @param {number} [options.confirmationLimit] 确认记录上限（1~1000，默认 100）
 */
export function createToolRegistry(options = {}) {
  const settings = readOptions(options);
  /** @type {Map<string, object>} name → 冻结定义 + view */
  const definitions = new Map();
  /** @type {Map<string, object>} actionId → 冻结确认记录 */
  const confirmations = new Map();
  /** @type {object[]} 只存安全元数据的冻结审计条目（环形上限） */
  const auditEntries = [];
  let auditSeq = 0;
  let droppedAuditEntries = 0;
  let executionAttemptSeq = 0;

  /** 追加一条审计：补序号、深冻结、环形上限（丢最旧并计数）。 */
  function appendAudit(entry) {
    auditSeq += 1;
    const frozen = deepFreeze({ seq: auditSeq, ...entry });
    auditEntries.push(frozen);
    if (auditEntries.length > settings.auditLimit) {
      auditEntries.shift();
      droppedAuditEntries += 1;
    }
    return frozen;
  }

  function pushAudit({ definition, code, startedAt, durationMs, trigger, confirmation, correlationId, argsDigest }) {
    const entry = {
      event: 'execute',
      tool: definition.name,
      risk: definition.risk,
      at: toIsoTimestamp(startedAt),
      code,
      correlationId,
      confirmation,
    };
    for (const field of definition.auditFields) {
      if (field === 'trigger') entry.trigger = trigger;
      else if (field === 'durationMs') entry.durationMs = durationMs;
      else if (argsDigest !== null) entry.argsDigest = argsDigest;
    }
    appendAudit(entry);
  }

  /** 确认请求/决策事件：只写脱敏元数据，绝不写 actionId、参数或身份内容。 */
  function pushConfirmationAudit({ tool, risk, event, code, confirmation, correlationId }) {
    appendAudit({
      event,
      tool,
      risk,
      at: toIsoTimestamp(readTimestamp(settings.now)),
      code,
      correlationId,
      confirmation,
    });
  }

  function confirmDefinition(definition, actionId, digest) {
    if (actionId === null) {
      return { state: TOOL_CONFIRMATION_STATES.missing, code: TOOL_RESULT_CODES.confirmationRequired };
    }
    const record = confirmations.get(actionId) ?? null;
    if (!record) return { state: TOOL_CONFIRMATION_STATES.unknown, code: TOOL_RESULT_CODES.confirmationUnknown };
    if (record.status === 'denied') {
      return { state: TOOL_CONFIRMATION_STATES.denied, code: TOOL_RESULT_CODES.confirmationDenied };
    }
    if (record.status === 'pending') {
      return { state: TOOL_CONFIRMATION_STATES.pending, code: TOOL_RESULT_CODES.confirmationPending };
    }
    if (record.status === 'consumed') {
      return { state: TOOL_CONFIRMATION_STATES.used, code: TOOL_RESULT_CODES.confirmationUsed };
    }
    if (record.tool !== definition.name || record.digest !== digest) {
      return { state: TOOL_CONFIRMATION_STATES.mismatch, code: TOOL_RESULT_CODES.confirmationMismatch };
    }
    confirmations.set(actionId, deepFreeze({ ...record, status: 'consumed', consumedAt: readTimestamp(settings.now) }));
    return { state: TOOL_CONFIRMATION_STATES.approved, code: null };
  }

  function register(definition) {
    let built;
    try {
      built = buildDefinition(definition);
    } catch (error) {
      // 只有本模块 reject() 造出的错误会被重建；定义里嵌套的访问器/Proxy 抛出的
      // 任意异常（包括伪造或篡改过的同名错误）一律折叠成非法定义。
      const internal = INTERNAL_ERRORS.get(error);
      if (internal) {
        // 重建而不是重抛原对象：错误码只来自私有元数据；返回值同样冻结。
        throw Object.freeze(new ToolRegistryError(internal.code, internal.field));
      }
      reject(TOOL_REGISTRATION_ERRORS.invalidDefinition);
    }
    if (definitions.has(built.name)) reject(TOOL_REGISTRATION_ERRORS.duplicateName, 'name');
    definitions.set(built.name, Object.freeze({ ...built, view: publicView(built) }));
    return definitions.get(built.name).view;
  }

  function describe(name) {
    const found = typeof name === 'string' ? definitions.get(name) : null;
    return found ? found.view : null;
  }

  function list() {
    return Object.freeze([...definitions.values()].map((definition) => definition.view));
  }

  function stats() {
    return deepFreeze({
      tools: definitions.size,
      confirmations: confirmations.size,
      auditEntries: auditEntries.length,
      droppedAuditEntries,
    });
  }

  /** 只读审计快照（冻结副本；之后的调用不会改变已拿到的快照）。 */
  function audit() {
    return Object.freeze(auditEntries.slice());
  }

  /** 确认记录的安全视图：不给摘要、不给参数，也不给任何身份内容。 */
  function describeConfirmation(actionId) {
    const record = typeof actionId === 'string' ? confirmations.get(actionId) : null;
    if (!record) return null;
    return deepFreeze({
      tool: record.tool,
      status: record.status,
      correlationId: record.correlationId,
      requestedAt: toIsoTimestamp(record.requestedAt),
    });
  }

  /**
   * 为一个需要确认的调用建立请求。返回的 actionId 是调用方持有的凭据；
   * 参数不落库，只保留摘要（用于绑定）。
   */
  function requestConfirmation(name, args) {
    const definition = typeof name === 'string' ? definitions.get(name) : null;
    if (!definition) return deepFreeze({ ok: false, code: TOOL_RESULT_CODES.unknownTool });

    /** 请求被拒：写一条可归属的脱敏审计，然后返回闭合码（不回显任何输入值）。 */
    const rejectRequest = (code) => {
      pushConfirmationAudit({
        tool: definition.name,
        risk: definition.risk,
        event: 'confirmation-request-rejected',
        code,
        confirmation: TOOL_CONFIRMATION_STATES.notCreated,
        correlationId: correlate(definition.name, `request-rejected:${auditSeq + 1}`),
      });
      return deepFreeze({ ok: false, code, tool: definition.name });
    };

    if (definition.risk === 'high-risk') return rejectRequest(TOOL_RESULT_CODES.riskNotAllowed);
    if (definition.risk !== 'confirm') return rejectRequest(TOOL_RESULT_CODES.confirmationNotRequired);
    const snapshot = snapshotArguments(args);
    if (snapshot === null || !matchesSchema(definition.parameters, snapshot)) {
      return rejectRequest(TOOL_RESULT_CODES.invalidArguments);
    }
    if (confirmations.size >= settings.confirmationLimit) {
      return rejectRequest(TOOL_RESULT_CODES.confirmationCapacity);
    }

    // actionId 是调用方凭据：必须先验证形状、再验证唯一性；任何失败都不落库、
    // 不覆盖既有记录，也不把生成器返回的原始值写进结果或审计。
    let actionId;
    try {
      actionId = settings.createActionId();
    } catch {
      return rejectRequest(TOOL_RESULT_CODES.confirmationIdUnavailable);
    }
    if (typeof actionId !== 'string' || !ACTION_ID_PATTERN.test(actionId) || confirmations.has(actionId)) {
      return rejectRequest(TOOL_RESULT_CODES.confirmationIdUnavailable);
    }

    const digest = digestArguments(snapshot);
    const record = deepFreeze({
      tool: definition.name,
      risk: definition.risk,
      digest,
      status: 'pending',
      correlationId: correlate(definition.name, actionId),
      requestedAt: readTimestamp(settings.now),
    });
    confirmations.set(actionId, record);
    pushConfirmationAudit({
      tool: definition.name,
      risk: definition.risk,
      event: 'confirmation-request',
      code: TOOL_RESULT_CODES.ok,
      confirmation: TOOL_CONFIRMATION_STATES.pending,
      correlationId: record.correlationId,
    });
    return deepFreeze({
      ok: true,
      code: TOOL_RESULT_CODES.ok,
      tool: definition.name,
      risk: definition.risk,
      actionId,
      correlationId: record.correlationId,
      argsDigest: digest.slice(0, DIGEST_PREFIX_LENGTH),
      status: 'pending',
    });
  }

  /** 同意或拒绝；已决策过的 actionId 不能翻案。 */
  function decideConfirmation(actionId, decision) {
    const record = typeof actionId === 'string' ? confirmations.get(actionId) : null;
    // 未知/非法 actionId 无法归属到已注册工具，不落审计（仍返回闭合码）。
    if (!record) return deepFreeze({ ok: false, code: TOOL_RESULT_CODES.confirmationUnknown });

    /** 决策被拒：记录闭合码 + 当前确认状态（不含任何凭据/参数/身份）。 */
    const rejectDecision = (code) => {
      pushConfirmationAudit({
        tool: record.tool,
        risk: record.risk,
        event: 'confirmation-decision-rejected',
        code,
        confirmation: record.status,
        correlationId: record.correlationId,
      });
      return deepFreeze({ ok: false, code });
    };

    if (decision !== 'approve' && decision !== 'deny') {
      return rejectDecision(TOOL_RESULT_CODES.invalidDecision);
    }
    if (record.status !== 'pending') {
      return rejectDecision(TOOL_RESULT_CODES.confirmationAlreadyDecided);
    }
    const status = decision === 'approve' ? 'approved' : 'denied';
    confirmations.set(actionId, deepFreeze({ ...record, status, decidedAt: readTimestamp(settings.now) }));
    pushConfirmationAudit({
      tool: record.tool,
      risk: record.risk,
      event: 'confirmation-decision',
      code: TOOL_RESULT_CODES.ok,
      confirmation: status,
      correlationId: record.correlationId,
    });
    return deepFreeze({
      ok: true,
      code: TOOL_RESULT_CODES.ok,
      tool: record.tool,
      actionId,
      correlationId: record.correlationId,
      status,
    });
  }

  /**
   * 执行一个已注册工具。
   *
   * @param {unknown} name 工具名（未知一律 unknown-tool，不回显名字）
   * @param {unknown} args 参数（必须符合注册 schema）
   * @param {object} [context]
   * @param {'user'|'scheduled'} [context.trigger] 触发来源，默认 user
   * @param {string[]|Set<string>} [context.permissions] 本轮已授予的权限标签
   * @param {string} [context.actionId] 需确认工具的执行凭据
   */
  async function execute(name, args, context = {}) {
    const definition = typeof name === 'string' ? definitions.get(name) : null;
    if (!definition) return deepFreeze({ ok: false, code: TOOL_RESULT_CODES.unknownTool });
    const attempt = (executionAttemptSeq += 1);
    const startedAt = readTimestamp(settings.now);
    let parsed;
    let actionId;
    try {
      parsed = readContext(context);
      actionId = typeof context.actionId === 'string' && context.actionId ? context.actionId : null;
    } catch {
      // 上下文里的访问器/Proxy 抛错：按调用方错误处理，不落审计、不泄漏异常文本。
      return deepFreeze({ ok: false, code: TOOL_RESULT_CODES.invalidContext, tool: definition.name });
    }
    // 上下文形状本身不合法（调用方 bug）：不落审计，避免把非法触发词写进记录。
    if (!parsed.ok) return deepFreeze({ ok: false, code: TOOL_RESULT_CODES.invalidContext, tool: definition.name });

    // 参数一次性快照：后续 schema 校验、摘要、handler 都只看这份冻结副本。
    const snapshot = snapshotArguments(args);
    // 无 actionId 时用内部 attempt 序号做匿名关联；绝不调用可能抛错的 actionId 生成器，
    // 因此确认工具缺凭据也能稳定返回 confirmation-required 并留下执行审计。
    const correlationId = actionId
      ? correlate(definition.name, actionId)
      : correlateAnonymous(definition.name, attempt);
    let confirmation = definition.risk === 'confirm'
      ? TOOL_CONFIRMATION_STATES.missing
      : TOOL_CONFIRMATION_STATES.notRequired;
    let code = TOOL_RESULT_CODES.ok;
    let value;
    let compensated = null;
    let argsDigest = null;

    if (definition.risk === 'high-risk') {
      // 副作用评测之前不开放：登记可以，执行永远不。
      code = TOOL_RESULT_CODES.riskNotAllowed;
    } else if (!hasPermissions(definition, parsed.permissions)) {
      code = TOOL_RESULT_CODES.permissionDenied;
    } else if (parsed.trigger === 'scheduled' && !definition.schedulable) {
      code = TOOL_RESULT_CODES.scheduledNotAllowed;
    } else if (snapshot === null || !matchesSchema(definition.parameters, snapshot)) {
      code = TOOL_RESULT_CODES.invalidArguments;
    } else {
      const digest = digestArguments(snapshot);
      argsDigest = digest.slice(0, DIGEST_PREFIX_LENGTH);
      if (definition.risk === 'confirm') {
        const check = confirmDefinition(definition, actionId, digest);
        confirmation = check.state;
        if (check.code) code = check.code;
      }
      if (code === TOOL_RESULT_CODES.ok) {
        const toolContext = deepFreeze({ tool: definition.name, risk: definition.risk, trigger: parsed.trigger });
        const outcome = await invokeHandler(definition, snapshot, toolContext);
        if (outcome.ok) {
          try {
            value = copyResultValue(outcome.value);
          } catch {
            // 返回值不是可安全冻结的纯数据：当 handler 失败处理，绝不让审计记成功。
            code = TOOL_RESULT_CODES.handlerFailed;
          }
        } else {
          code = outcome.code;
        }
        // 超时视作结果未知：不自动补偿（副作用可能仍在发生），只如实报超时。
        if (code === TOOL_RESULT_CODES.handlerFailed && definition.failurePolicy === 'rollback') {
          compensated = await runCompensation(definition, snapshot, toolContext);
        }
      }
    }

    const durationMs = Math.max(0, readTimestamp(settings.now) - startedAt);
    pushAudit({
      definition,
      code,
      startedAt,
      durationMs,
      trigger: parsed.trigger,
      confirmation,
      correlationId,
      argsDigest,
    });
    if (code === TOOL_RESULT_CODES.ok) {
      return deepFreeze({ ok: true, code, tool: definition.name, value: deepFreeze(value) });
    }
    const result = { ok: false, code, tool: definition.name };
    if (compensated !== null) result.compensated = compensated;
    return deepFreeze(result);
  }

  return Object.freeze({
    register,
    describe,
    list,
    execute,
    requestConfirmation,
    decideConfirmation,
    describeConfirmation,
    audit,
    stats,
  });
}

/* ───────────────────────── 纯内存演示桩（E0 示例工厂） ───────────────────────── */

/**
 * 一个只在内存里的便签账本；不读写磁盘、不访问网络。
 * 返回的方法可以原地改内部数组，因此 handler 必须返回副本。
 */
export function createMemoryNoteStore(initialNotes = []) {
  let nextId = 0;
  const notes = initialNotes.map((text) => ({ id: (nextId += 1), text: String(text) }));
  return {
    list: () => notes.map((note) => note.text),
    /** 追加并返回本次追加的唯一 id（补偿按 id 撤销，不依赖位置）。 */
    append: (text) => {
      nextId += 1;
      notes.push({ id: nextId, text: String(text) });
      return nextId;
    },
    /** 按 id 撤销；已经不存在时返回 false（幂等，不误删别人）。 */
    remove: (id) => {
      const index = notes.findIndex((note) => note.id === id);
      if (index < 0) return false;
      notes.splice(index, 1);
      return true;
    },
    dropLast: () => {
      if (notes.length > 0) notes.pop();
      return notes.length;
    },
    size: () => notes.length,
  };
}

/** 只读桩：读内存便签，不产生任何副作用。 */
export function createNoteReadTool(store) {
  return {
    name: 'demo_note_read',
    description: '读取本地演示便签（只读、纯内存，不访问真实服务）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条，默认 20' },
      },
    },
    risk: 'read-only',
    permissions: ['note:read'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['durationMs', 'trigger'],
    handler: (args) => {
      const limit = args.limit ?? 20;
      return { notes: store.list().slice(0, limit) };
    },
  };
}

/** 可逆桩：追加一条便签；失败策略 rollback，补偿只撤销本次确实追加的那一条。 */
export function createNoteAppendTool(store) {
  // 每次执行拿到的 ctx 是独立冻结对象：记录本次追加的 note id，补偿按 id 撤销，
  // 既不会误删同内容的旧便签，也不会在并发/交错执行时删掉别人的便签。
  const appended = new WeakMap();
  return {
    name: 'demo_note_append',
    description: '向本地演示便签追加一条（可逆、纯内存，撤销即移除本次追加）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200, description: '要追加的便签正文' },
      },
      required: ['text'],
    },
    risk: 'reversible',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'rollback',
    compensate: (args, context) => {
      const noteId = appended.get(context);
      if (noteId === undefined) return;
      appended.delete(context);
      store.remove(noteId);
    },
    schedulable: false,
    auditFields: ['argsDigest', 'durationMs'],
    handler: (args, context) => {
      const noteId = store.append(args.text);
      appended.set(context, noteId);
      return { size: store.size() };
    },
  };
}

/** 需确认桩：清空演示便签前必须先拿到绑定参数摘要的批准（E0 的 E-02 演示）。 */
export function createNoteClearTool(store) {
  return {
    name: 'demo_note_clear',
    description: '清空本地演示便签（需确认；纯内存，不接触真实服务）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['demo'], description: '只允许清空演示范围' },
      },
      required: ['scope'],
    },
    risk: 'confirm',
    permissions: ['note:write'],
    timeoutMs: 1000,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: ['argsDigest', 'trigger', 'durationMs'],
    handler: () => {
      const cleared = store.size();
      while (store.size() > 0) store.dropLast();
      return { cleared };
    },
  };
}

/** 一次性把三只演示桩注册进注册表（顺序稳定）。 */
export function registerNoteTools(registry, store) {
  return Object.freeze([
    registry.register(createNoteReadTool(store)).name,
    registry.register(createNoteAppendTool(store)).name,
    registry.register(createNoteClearTool(store)).name,
  ]);
}

export default createToolRegistry;
