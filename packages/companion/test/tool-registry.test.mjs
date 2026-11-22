/**
 * E0 通用工具注册与安全执行内核 · 专项测试
 * ─────────────────────────────────────────────────────────────
 * 覆盖：
 *   1. 注册契约：每个字段必须显式声明；非法/重复注册被拒绝且错误文本不含值；
 *      注册结果、schema、列表与结果都不可被外部改写；
 *   2. 风险分级：read-only / reversible 可执行，confirm 必须走确认，high-risk 永不执行；
 *   3. 确认（E-02）：请求 → 未确认不执行 → 待批不执行 → 批准执行 → 一次性；
 *      换参数不能复用批准；拒绝后同一 actionId 不能重试、不能翻案；
 *   4. 权限与定时门控；
 *   5. 非法/恶意参数不执行、不回显、不落审计；
 *   6. handler 同步抛错 / 异步拒绝 / 超时 / 迟到结果，都不伪成功、不泄漏异常文本；
 *   7. 审计：只存安全元数据、字段按声明裁剪、有上限、快照不可变、不含参数正文。
 *
 * 全程离线：纯内存桩、注入时钟与 actionId 生成器；不联网、不调模型、不碰磁盘。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRMATION_STATUSES,
  TOOL_AUDIT_FIELDS,
  TOOL_CONFIRMATION_STATES,
  TOOL_FAILURE_POLICIES,
  TOOL_REGISTRATION_ERRORS,
  TOOL_REGISTRY_LIMITS,
  TOOL_RESULT_CODES,
  TOOL_RISK_LEVELS,
  TOOL_TRIGGERS,
  ToolRegistryError,
  createMemoryNoteStore,
  createNoteAppendTool,
  createNoteClearTool,
  createNoteReadTool,
  createToolRegistry,
  registerNoteTools,
} from '../src/tools/registry.js';

const FIXED_NOW = Date.parse('2026-11-21T00:00:00.000Z');
const FIXED_ISO = new Date(FIXED_NOW).toISOString();

function fixedRegistry(options = {}) {
  return createToolRegistry({ now: () => FIXED_NOW, ...options });
}

function sequenceIds(prefix = 'act') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

/** 一份完整合法的定义；各测试只改需要的字段。 */
function definition(overrides = {}) {
  return {
    name: 'demo_custom',
    description: '测试用工具（纯内存）',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 20 },
      },
      required: ['text'],
    },
    risk: 'read-only',
    permissions: ['demo:read'],
    timeoutMs: 50,
    failurePolicy: 'stop',
    compensate: null,
    schedulable: false,
    auditFields: [],
    handler: () => ({ ok: true }),
    ...overrides,
  };
}

function confirmEchoDefinition(overrides = {}) {
  return definition({
    name: 'demo_confirm_echo',
    risk: 'confirm',
    permissions: ['demo:write'],
    handler: () => ({ echoed: true }),
    ...overrides,
  });
}

function registerDefinition(registry, overrides = {}) {
  const built = definition(overrides);
  registry.register(built);
  return built;
}

function codeOf(result) {
  assert.equal(result.ok, false);
  return result.code;
}

/** 断言审计/确认视图里的时间是可解析、可往返的 ISO 字符串。 */
function assertValidIso(value) {
  assert.equal(typeof value, 'string');
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `无效时间：${value}`);
  assert.equal(new Date(parsed).toISOString(), value);
}

function registrationCode(registry, input) {
  assert.throws(() => registry.register(input), (error) => {
    assert.ok(error instanceof ToolRegistryError);
    return typeof error.code === 'string';
  });
  try {
    registry.register(input);
  } catch (error) {
    return error;
  }
  return null;
}

/* ───────────────────────── 1. 注册契约与冻结 ───────────────────────── */

test('注册：返回冻结投影，不暴露 handler/compensate，schema 与外部输入隔离', () => {
  const registry = fixedRegistry();
  const input = definition();
  const view = registry.register(input);

  assert.equal(view.name, 'demo_custom');
  assert.equal(view.risk, 'read-only');
  assert.equal(view.requiresConfirmation, false);
  assert.equal(view.compensable, false);
  assert.equal(Object.hasOwn(view, 'handler'), false);
  assert.equal(Object.hasOwn(view, 'compensate'), false);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.parameters));
  assert.ok(Object.isFrozen(view.permissions));
  assert.throws(() => { view.parameters.properties.text.maxLength = 999; }, TypeError);
  assert.throws(() => { view.name = 'other'; }, TypeError);

  // 注册后改原始定义，不能影响注册表里的 schema（内部是深拷贝 + 冻结）。
  input.parameters.properties.text.maxLength = 3;
  input.permissions.push('demo:extra');
  assert.equal(registry.describe('demo_custom').parameters.properties.text.maxLength, 20);
  assert.deepEqual(registry.describe('demo_custom').permissions, ['demo:read']);
  assert.equal(registry.describe('unknown_tool'), null);
  assert.equal(registry.describe(42), null);

  const listed = registry.list();
  assert.ok(Object.isFrozen(listed));
  assert.equal(listed.length, 1);
  assert.equal(listed[0], view);
  assert.throws(() => { listed.push(view); }, TypeError);

  // 注册表对象本身也冻结：不能替换方法或挂私有状态。
  assert.ok(Object.isFrozen(registry));
  assert.throws(() => { registry.execute = () => {}; }, TypeError);
  assert.throws(() => { registry.extra = {}; }, TypeError);
});

test('注册：重复工具名被拒绝，且失败不影响已注册定义', () => {
  const registry = fixedRegistry();
  registerDefinition(registry);
  const error = registrationCode(registry, definition());
  assert.equal(error.code, TOOL_REGISTRATION_ERRORS.duplicateName);
  assert.equal(error.field, 'name');
  assert.equal(registry.list().length, 1);
});

test('注册拒绝：定义 / 名称 / 描述', () => {
  const registry = fixedRegistry();
  const cases = [
    [null, TOOL_REGISTRATION_ERRORS.invalidDefinition],
    [[], TOOL_REGISTRATION_ERRORS.invalidDefinition],
    [definition({ name: 'Bad Name' }), TOOL_REGISTRATION_ERRORS.invalidName],
    [definition({ name: 'Upper' }), TOOL_REGISTRATION_ERRORS.invalidName],
    [definition({ name: 42 }), TOOL_REGISTRATION_ERRORS.invalidName],
    [definition({ name: `a${'b'.repeat(TOOL_REGISTRY_LIMITS.nameLength)}` }), TOOL_REGISTRATION_ERRORS.invalidName],
    [definition({ description: '' }), TOOL_REGISTRATION_ERRORS.invalidDescription],
    [definition({ description: '   ' }), TOOL_REGISTRATION_ERRORS.invalidDescription],
    [definition({ description: 'x'.repeat(TOOL_REGISTRY_LIMITS.descriptionLength + 1) }), TOOL_REGISTRATION_ERRORS.invalidDescription],
    [definition({ description: 7 }), TOOL_REGISTRATION_ERRORS.invalidDescription],
    // 未知字段（典型是拼错）不被静默忽略，按非法定义拒绝。
    [{ ...definition(), scheduleable: true }, TOOL_REGISTRATION_ERRORS.invalidDefinition],
  ];
  for (const [input, code] of cases) {
    const error = registrationCode(registry, input);
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}`);
    // 错误文本只带错误码与静态字段名，不回显任何字段值。
    assert.equal(error.message.includes('Bad Name'), false);
    assert.equal(error.message.includes('Upper'), false);
    assert.equal(error.message.includes('x'.repeat(20)), false);
  }
});

test('注册拒绝：参数 schema 只支持声明的子集', () => {
  const registry = fixedRegistry();
  const schema = (overrides) => definition({
    parameters: { type: 'object', additionalProperties: false, properties: {}, ...overrides },
  });
  const cases = [
    [schema({ type: 'array' }), TOOL_REGISTRATION_ERRORS.unsupportedSchema],
    [schema({ additionalProperties: true }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: null }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ oneOf: [] }), TOOL_REGISTRATION_ERRORS.unsupportedSchema],
    [schema({ required: ['missing'] }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ required: 'text' }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { 'Bad-Key': { type: 'string' } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'array' } } }), TOOL_REGISTRATION_ERRORS.unsupportedSchema],
    [schema({ properties: { value: { type: 'string', pattern: '^a$' } } }), TOOL_REGISTRATION_ERRORS.unsupportedSchema],
    [schema({ properties: { value: { type: 'boolean', enum: [true] } } }), TOOL_REGISTRATION_ERRORS.unsupportedSchema],
    [schema({ properties: { value: null } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', description: '' } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', enum: [] } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', enum: ['a', 'a'] } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', enum: [1] } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', minLength: -1 } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', maxLength: '4' } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'string', minLength: 5, maxLength: 4 } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'integer', minimum: Number.POSITIVE_INFINITY } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'number', maximum: Number.NaN } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
    [schema({ properties: { value: { type: 'integer', minimum: 5, maximum: 4 } } }), TOOL_REGISTRATION_ERRORS.invalidSchema],
  ];
  for (const [input, code] of cases) {
    const error = registrationCode(registry, input);
    assert.equal(error.code, code, JSON.stringify(input.parameters));
  }
  assert.equal(registry.list().length, 0);
});

test('注册拒绝：风险 / 权限 / 超时 / 失败策略 / 补偿 / 定时 / 审计字段 / handler', () => {
  const registry = fixedRegistry();
  const cases = [
    [definition({ risk: 'dangerous' }), TOOL_REGISTRATION_ERRORS.invalidRisk],
    [definition({ permissions: 'demo:read' }), TOOL_REGISTRATION_ERRORS.invalidPermissions],
    [definition({ permissions: ['Bad Tag'] }), TOOL_REGISTRATION_ERRORS.invalidPermissions],
    [definition({ permissions: ['demo:read', 'demo:read'] }), TOOL_REGISTRATION_ERRORS.invalidPermissions],
    [definition({ permissions: [42] }), TOOL_REGISTRATION_ERRORS.invalidPermissions],
    [definition({ timeoutMs: 0 }), TOOL_REGISTRATION_ERRORS.invalidTimeout],
    [definition({ timeoutMs: 1.5 }), TOOL_REGISTRATION_ERRORS.invalidTimeout],
    [definition({ timeoutMs: TOOL_REGISTRY_LIMITS.timeoutMs + 1 }), TOOL_REGISTRATION_ERRORS.invalidTimeout],
    [definition({ timeoutMs: '50' }), TOOL_REGISTRATION_ERRORS.invalidTimeout],
    [definition({ failurePolicy: 'retry' }), TOOL_REGISTRATION_ERRORS.invalidFailurePolicy],
    [definition({ compensate: undefined }), TOOL_REGISTRATION_ERRORS.invalidCompensation],
    [definition({ compensate: 'noop' }), TOOL_REGISTRATION_ERRORS.invalidCompensation],
    [definition({ risk: 'reversible', compensate: null }), TOOL_REGISTRATION_ERRORS.invalidCompensation],
    [definition({ failurePolicy: 'rollback', compensate: null }), TOOL_REGISTRATION_ERRORS.invalidCompensation],
    [definition({ schedulable: 'yes' }), TOOL_REGISTRATION_ERRORS.invalidSchedulable],
    [definition({ auditFields: 'trigger' }), TOOL_REGISTRATION_ERRORS.invalidAuditFields],
    [definition({ auditFields: ['user'] }), TOOL_REGISTRATION_ERRORS.invalidAuditFields],
    [definition({ auditFields: ['trigger', 'trigger'] }), TOOL_REGISTRATION_ERRORS.invalidAuditFields],
    [definition({ handler: null }), TOOL_REGISTRATION_ERRORS.invalidHandler],
  ];
  for (const [input, code] of cases) {
    const error = registrationCode(registry, input);
    assert.equal(error.code, code);
  }
  assert.equal(registry.list().length, 0);
});

test('注册拒绝：每个字段都必须显式声明，缺省不兜底', () => {
  const registry = fixedRegistry();
  const fields = [
    ['name', TOOL_REGISTRATION_ERRORS.invalidName],
    ['description', TOOL_REGISTRATION_ERRORS.invalidDescription],
    ['parameters', TOOL_REGISTRATION_ERRORS.invalidSchema],
    ['risk', TOOL_REGISTRATION_ERRORS.invalidRisk],
    ['permissions', TOOL_REGISTRATION_ERRORS.invalidPermissions],
    ['timeoutMs', TOOL_REGISTRATION_ERRORS.invalidTimeout],
    ['failurePolicy', TOOL_REGISTRATION_ERRORS.invalidFailurePolicy],
    ['compensate', TOOL_REGISTRATION_ERRORS.invalidCompensation],
    ['schedulable', TOOL_REGISTRATION_ERRORS.invalidSchedulable],
    ['auditFields', TOOL_REGISTRATION_ERRORS.invalidAuditFields],
    ['handler', TOOL_REGISTRATION_ERRORS.invalidHandler],
  ];
  for (const [field, code] of fields) {
    const input = definition();
    delete input[field];
    const error = registrationCode(registry, input);
    assert.equal(error.code, code, `缺 ${field} 时应为 ${code}`);
  }
});

test('注册定义深快照：嵌套访问器不会被调用，校验与存储不会读到两个值', () => {
  const registry = fixedRegistry();
  let reads = 0;
  const spec = {};
  Object.defineProperty(spec, 'type', {
    enumerable: true,
    get() {
      reads += 1;
      return 'string';
    },
  });
  const input = definition();
  input.parameters = { type: 'object', additionalProperties: false, properties: { text: spec }, required: ['text'] };
  const error = registrationCode(registry, input);
  assert.equal(error.code, TOOL_REGISTRATION_ERRORS.invalidDefinition);
  assert.equal(reads, 0, '访问器在注册阶段一次都不应被调用');
  assert.equal(error.message.includes('SECRET'), false);
  assert.equal(registry.list().length, 0);
});

test('注册定义深快照拒绝：Symbol/隐藏键/稀疏数组/额外属性/类实例/大整数/循环/伪错误', () => {
  const registry = fixedRegistry();
  const withSymbol = { ...definition(), [Symbol('x')]: 1 };
  const hidden = definition();
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  const permissionsSymbol = definition();
  permissionsSymbol.permissions = ['demo:read'];
  permissionsSymbol.permissions[Symbol('x')] = 1;
  const permissionsExtra = definition();
  permissionsExtra.permissions = ['demo:read'];
  permissionsExtra.permissions.extra = 1;
  const permissionsHidden = definition();
  permissionsHidden.permissions = ['demo:read'];
  Object.defineProperty(permissionsHidden.permissions, 0, { value: 'demo:read', enumerable: false });
  const permissionsArrayProto = definition();
  permissionsArrayProto.permissions = Object.setPrototypeOf(['demo:read'], null);
  const permissionsArrayOutOfRange = definition();
  permissionsArrayOutOfRange.permissions = new Proxy(['demo:read'], {
    ownKeys(target) { return [...Reflect.ownKeys(target), '5']; },
    getOwnPropertyDescriptor(target, key) {
      if (key === '5') return { value: 'demo:read', enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const sparse = definition();
  sparse.auditFields = ['trigger'];
  sparse.auditFields.length = 2;
  const deep = definition();
  let cursor = deep;
  for (let index = 0; index < 10; index += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  const cyclic = definition();
  cyclic.self = cyclic;
  const classInstance = definition({
    parameters: new (class Params { constructor() { this.type = 'object'; } })(),
  });
  const bigintName = { ...definition(), name: 1n };
  const fakeError = new Proxy({}, {
    ownKeys() { throw new ToolRegistryError('EVIL-SECRET-CODE', 'evil-field'); },
  });

  const cases = [
    withSymbol,
    hidden,
    permissionsSymbol,
    permissionsExtra,
    permissionsHidden,
    permissionsArrayProto,
    permissionsArrayOutOfRange,
    sparse,
    deep,
    cyclic,
    classInstance,
    bigintName,
    fakeError,
  ];
  for (const [index, input] of cases.entries()) {
    const error = registrationCode(registry, input);
    assert.equal(error.code, TOOL_REGISTRATION_ERRORS.invalidDefinition, `case ${index}`);
    assert.equal(error.message.includes('EVIL'), false);
  }
  assert.equal(registry.list().length, 0);
});

test('内部错误被篡改后经 Proxy 重放也不泄漏：register 只按私有元数据重建', () => {
  const registry = fixedRegistry();
  let captured;
  try {
    registry.register(null);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ToolRegistryError);
  assert.ok(Object.isFrozen(captured));
  assert.throws(() => { captured.code = 'EVIL-SECRET-CODE'; }, TypeError);
  assert.throws(() => { captured.message = 'EVIL-SECRET-CODE'; }, TypeError);
  assert.equal(captured.code, TOOL_REGISTRATION_ERRORS.invalidDefinition);

  // 把捕获到的真实内部错误原样从嵌套 Proxy 陷阱抛出：即使它曾被尝试篡改，
  // register 也只读私有元数据，最终必须还是闭合的 invalid-definition。
  const replayed = new Proxy({}, {
    ownKeys() { throw captured; },
  });
  const error = registrationCode(registry, replayed);
  assert.equal(error.code, TOOL_REGISTRATION_ERRORS.invalidDefinition);
  assert.equal(error.message.includes('EVIL'), false);
  assert.equal(registry.list().length, 0);
});

test('注册定义数组：非尾部空洞与巨大稀疏数组都快速拒绝', () => {
  const registry = fixedRegistry();
  const middleHole = definition();
  middleHole.auditFields = [];
  middleHole.auditFields[1] = 'trigger';
  const hugeSparse = definition();
  hugeSparse.auditFields = [];
  hugeSparse.auditFields[100000] = 'trigger';
  for (const input of [middleHole, hugeSparse]) {
    const error = registrationCode(registry, input);
    assert.equal(error.code, TOOL_REGISTRATION_ERRORS.invalidDefinition);
  }
  assert.equal(registry.list().length, 0);
});

test('注册表选项非法时 fail closed', () => {
  const cases = [
    [null, 'invalid-options'],
    [{ now: 'later' }, 'invalid-options'],
    [{ createActionId: 7 }, 'invalid-options'],
    [{ auditLimit: 0 }, 'invalid-options'],
    [{ auditLimit: 1.5 }, 'invalid-options'],
    [{ auditLimit: TOOL_REGISTRY_LIMITS.auditEntries.max + 1 }, 'invalid-options'],
    [{ confirmationLimit: 0 }, 'invalid-options'],
    [{ confirmationLimit: TOOL_REGISTRY_LIMITS.confirmations.max + 1 }, 'invalid-options'],
  ];
  for (const [options, code] of cases) {
    assert.throws(() => createToolRegistry(options), (error) => {
      assert.ok(error instanceof ToolRegistryError);
      assert.equal(error.code, code);
      return true;
    });
  }
  // 合法边界可以创建。
  assert.doesNotThrow(() => createToolRegistry({ auditLimit: 1, confirmationLimit: 1 }));
});

/* ───────────────────────── 2. 风险分级门控 ───────────────────────── */

test('风险分级：read-only 直接执行，confirm 未确认不执行，high-risk 永不执行', async () => {
  const calls = { read: 0, confirm: 0, danger: 0 };
  const registry = fixedRegistry();
  registry.register(definition({
    handler: () => { calls.read += 1; return { read: true }; },
  }));
  registry.register(confirmEchoDefinition({
    handler: () => { calls.confirm += 1; return { echoed: true }; },
  }));
  registry.register(definition({
    name: 'demo_danger',
    risk: 'high-risk',
    permissions: ['demo:admin'],
    handler: () => { calls.danger += 1; return { danger: true }; },
  }));

  assert.equal(registry.describe('demo_danger').risk, 'high-risk');
  const direct = await registry.execute('demo_custom', { text: 'hi' }, { permissions: ['demo:read'] });
  assert.equal(direct.ok, true);

  const requirement = await registry.execute('demo_confirm_echo', { text: 'hi' }, { permissions: ['demo:write'] });
  assert.equal(codeOf(requirement), TOOL_RESULT_CODES.confirmationRequired);

  const risk = await registry.execute('demo_danger', {}, { permissions: ['demo:admin'] });
  assert.equal(codeOf(risk), TOOL_RESULT_CODES.riskNotAllowed);
  assert.equal(calls.read, 1);
  assert.equal(calls.confirm, 0);
  assert.equal(calls.danger, 0);

  const request = registry.requestConfirmation('demo_danger', {});
  assert.equal(codeOf(request), TOOL_RESULT_CODES.riskNotAllowed);
});

/* ───────────────────────── 3. 只读 / 可逆桩 ───────────────────────── */

test('只读桩：成功读取、结果不可改写、审计只记声明的字段', async () => {
  const store = createMemoryNoteStore(['一', '二', '三']);
  const registry = fixedRegistry();
  const names = registerNoteTools(registry, store);
  assert.ok(Object.isFrozen(names));
  assert.deepEqual(names, ['demo_note_read', 'demo_note_append', 'demo_note_clear']);

  const result = await registry.execute('demo_note_read', { limit: 2 }, { permissions: ['note:read'] });
  assert.equal(result.ok, true);
  assert.equal(result.code, TOOL_RESULT_CODES.ok);
  assert.deepEqual(result.value.notes, ['一', '二']);
  assert.deepEqual(store.list(), ['一', '二', '三']);
  // 不传 limit 时用工具声明的默认值（20），不是无限读取。
  const withoutLimit = await registry.execute('demo_note_read', {}, { permissions: ['note:read'] });
  assert.deepEqual(withoutLimit.value.notes, ['一', '二', '三']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.value));
  assert.throws(() => { result.value.notes.push('四'); }, TypeError);

  const [entry] = registry.audit();
  assert.equal(entry.tool, 'demo_note_read');
  assert.equal(entry.risk, 'read-only');
  assert.equal(entry.code, TOOL_RESULT_CODES.ok);
  assert.equal(entry.confirmation, TOOL_CONFIRMATION_STATES.notRequired);
  assert.equal(entry.trigger, 'user');
  assert.equal(typeof entry.durationMs, 'number');
  // 只声明了 durationMs / trigger：其余安全字段不出现。
  assert.equal(Object.hasOwn(entry, 'argsDigest'), false);
  assert.equal(entry.at, FIXED_ISO);
});

test('可逆桩：成功追加；handler 失败时按 rollback 策略补偿', async () => {
  const store = createMemoryNoteStore();
  const registry = fixedRegistry();
  registry.register(createNoteAppendTool(store));

  const appended = await registry.execute('demo_note_append', { text: '买牛奶' }, { permissions: ['note:write'] });
  assert.equal(appended.ok, true);
  assert.equal(appended.value.size, 1);
  assert.deepEqual(store.list(), ['买牛奶']);

  // 可逆工具失败后的补偿：追加已经发生，再抛错时按 rollback 撤销本次追加。
  const failingStore = createMemoryNoteStore();
  const failingRegistry = fixedRegistry();
  failingRegistry.register(definition({
    name: 'demo_append_fail',
    risk: 'reversible',
    permissions: ['note:write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['text'],
    },
    failurePolicy: 'rollback',
    compensate: () => failingStore.dropLast(),
    handler: (args) => {
      failingStore.append(args.text);
      throw new Error('内部异常文本不该外泄');
    },
  }));
  const failed = await failingRegistry.execute('demo_append_fail', { text: '买牛奶' }, { permissions: ['note:write'] });
  assert.equal(codeOf(failed), TOOL_RESULT_CODES.handlerFailed);
  assert.equal(failed.compensated, true);
  assert.equal(failingStore.size(), 0);
  assert.equal(JSON.stringify(failed).includes('内部异常文本'), false);

  // 补偿不盲删：handler 在 append 之前就失败时，已有便签必须原样保留——
  // 即使旧便签内容与本次参数完全相同，也不能误删。
  const untouched = createMemoryNoteStore(['同内容']);
  const guardedRegistry = fixedRegistry();
  guardedRegistry.register({
    ...createNoteAppendTool(untouched),
    handler: () => { throw new Error('append 之前失败'); },
  });
  const guarded = await guardedRegistry.execute('demo_note_append', { text: '同内容' }, { permissions: ['note:write'] });
  assert.equal(codeOf(guarded), TOOL_RESULT_CODES.handlerFailed);
  assert.equal(guarded.compensated, true);
  assert.deepEqual(untouched.list(), ['同内容']);
});

test('可逆桩补偿按执行 token 撤销：只删本次追加，不误删同内容旧便签或别人的便签', () => {
  const store = createMemoryNoteStore(['同内容']);
  const tool = createNoteAppendTool(store);
  const context = Object.freeze({ tool: tool.name, risk: tool.risk, trigger: 'user' });

  assert.deepEqual(tool.handler({ text: '同内容' }, context), { size: 2 });
  assert.deepEqual(store.list(), ['同内容', '同内容']);
  tool.compensate({ text: '同内容' }, context);
  assert.deepEqual(store.list(), ['同内容']);

  // 没有追加过的执行上下文，补偿必须是无操作（重复补偿也不会继续删）。
  tool.compensate({ text: '同内容' }, context);
  assert.deepEqual(store.list(), ['同内容']);
  tool.compensate({ text: '同内容' }, Object.freeze({ tool: tool.name, risk: tool.risk, trigger: 'user' }));
  assert.deepEqual(store.list(), ['同内容']);

  // 交错执行：A 的补偿只能撤销 A，即使 B 在 A 之后追加（B 才是最后一条）。
  const first = Object.freeze({ tool: tool.name, risk: tool.risk, trigger: 'user' });
  const second = Object.freeze({ tool: tool.name, risk: tool.risk, trigger: 'user' });
  tool.handler({ text: 'A' }, first);
  tool.handler({ text: 'B' }, second);
  assert.deepEqual(store.list(), ['同内容', 'A', 'B']);
  tool.compensate({ text: 'A' }, first);
  assert.deepEqual(store.list(), ['同内容', 'B']);
  tool.compensate({ text: 'B' }, second);
  assert.deepEqual(store.list(), ['同内容']);

  // id 已经不存在时撤销是幂等的 false，不误删别的便签。
  assert.equal(store.remove(9999), false);
  assert.deepEqual(store.list(), ['同内容']);
});

test('补偿自身抛错时如实记 compensated=false，不向上抛', async () => {
  const registry = fixedRegistry();
  registry.register(definition({
    name: 'demo_fragile',
    risk: 'reversible',
    failurePolicy: 'rollback',
    compensate: () => { throw new Error('补偿失败'); },
    handler: () => { throw new Error('执行失败'); },
  }));
  const result = await registry.execute('demo_fragile', { text: 'x' }, { permissions: ['demo:read'] });
  assert.equal(codeOf(result), TOOL_RESULT_CODES.handlerFailed);
  assert.equal(result.compensated, false);
  assert.equal(JSON.stringify(result).includes('补偿失败'), false);
});

test('需确认工具也可以声明 rollback：失败后同样尝试补偿', async () => {
  const registry = fixedRegistry({ createActionId: sequenceIds() });
  registry.register(definition({
    name: 'demo_confirm_rollback',
    risk: 'confirm',
    permissions: ['demo:write'],
    failurePolicy: 'rollback',
    compensate: () => {},
    handler: () => { throw new Error('换参数不应发生'); },
  }));
  const request = registry.requestConfirmation('demo_confirm_rollback', { text: 'x' });
  assert.equal(registry.decideConfirmation(request.actionId, 'approve').status, 'approved');
  const result = await registry.execute(
    'demo_confirm_rollback',
    { text: 'x' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(codeOf(result), TOOL_RESULT_CODES.handlerFailed);
  assert.equal(result.compensated, true);
  // 批准在交给 handler 时就被消耗：失败也不能拿着同一个批准静默重试。
  assert.equal(
    codeOf(await registry.execute(
      'demo_confirm_rollback',
      { text: 'x' },
      { permissions: ['demo:write'], actionId: request.actionId },
    )),
    TOOL_RESULT_CODES.confirmationUsed,
  );
});

/* ───────────────────────── 4. 确认（E-02） ───────────────────────── */

test('确认流程：请求 → 未确认/待批不执行 → 批准执行 → 批准一次性', async () => {
  const store = createMemoryNoteStore(['a', 'b']);
  const registry = fixedRegistry({ createActionId: sequenceIds() });
  registerNoteTools(registry, store);
  const context = { permissions: ['note:write'] };

  const request = registry.requestConfirmation('demo_note_clear', { scope: 'demo' });
  assert.equal(request.ok, true);
  assert.equal(request.status, 'pending');
  assert.equal(request.tool, 'demo_note_clear');
  assert.equal(request.argsDigest.length, 16);
  assert.match(request.correlationId, /^c-[0-9a-f]{16}$/u);
  assert.equal(registry.describeConfirmation(request.actionId).status, 'pending');

  const missing = await registry.execute('demo_note_clear', { scope: 'demo' }, context);
  assert.equal(codeOf(missing), TOOL_RESULT_CODES.confirmationRequired);
  assert.equal(store.size(), 2);

  const pending = await registry.execute('demo_note_clear', { scope: 'demo' }, { ...context, actionId: request.actionId });
  assert.equal(codeOf(pending), TOOL_RESULT_CODES.confirmationPending);
  assert.equal(store.size(), 2);

  const approved = registry.decideConfirmation(request.actionId, 'approve');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.actionId, request.actionId);

  const executed = await registry.execute('demo_note_clear', { scope: 'demo' }, { ...context, actionId: request.actionId });
  assert.equal(executed.ok, true);
  assert.equal(executed.value.cleared, 2);
  assert.equal(store.size(), 0);
  assert.equal(registry.describeConfirmation(request.actionId).status, 'consumed');

  const reused = await registry.execute('demo_note_clear', { scope: 'demo' }, { ...context, actionId: request.actionId });
  assert.equal(codeOf(reused), TOOL_RESULT_CODES.confirmationUsed);

  // 审计里只出现派生关联标识，不出现 actionId 原文；确认状态可追溯。
  const confirmEntries = registry.audit().filter((entry) => entry.tool === 'demo_note_clear');
  const requestEvent = confirmEntries.find((entry) => entry.event === 'confirmation-request');
  assert.equal(requestEvent.code, TOOL_RESULT_CODES.ok);
  assert.equal(requestEvent.confirmation, TOOL_CONFIRMATION_STATES.pending);
  assert.equal(requestEvent.correlationId, request.correlationId);
  const decisionEvent = confirmEntries.find((entry) => entry.event === 'confirmation-decision');
  assert.equal(decisionEvent.code, TOOL_RESULT_CODES.ok);
  assert.equal(decisionEvent.confirmation, TOOL_CONFIRMATION_STATES.approved);
  assert.equal(decisionEvent.correlationId, request.correlationId);

  const executions = confirmEntries.filter((entry) => entry.event === 'execute');
  assert.deepEqual(
    executions.map((entry) => entry.confirmation),
    [
      TOOL_CONFIRMATION_STATES.missing,
      TOOL_CONFIRMATION_STATES.pending,
      TOOL_CONFIRMATION_STATES.approved,
      TOOL_CONFIRMATION_STATES.used,
    ],
  );
  // 没有携带 actionId 的那次调用属于另一条“未确认”路径，关联标识自然不同；
  // 其余（待批 / 已批 / 已用）都应与确认请求的关联标识一致。
  const correlated = executions.filter((entry) => entry.confirmation !== TOOL_CONFIRMATION_STATES.missing);
  assert.equal(correlated.length, 3);
  assert.ok(correlated.every((entry) => entry.correlationId === request.correlationId));
  assert.equal(JSON.stringify(registry.audit()).includes(request.actionId), false);
});

test('确认：换参数不能复用批准', async () => {
  let executions = 0;
  const registry = fixedRegistry({ createActionId: sequenceIds() });
  registry.register(confirmEchoDefinition({ handler: () => { executions += 1; return { echoed: true }; } }));

  const request = registry.requestConfirmation('demo_confirm_echo', { text: '原始参数' });
  registry.decideConfirmation(request.actionId, 'approve');

  const swapped = await registry.execute(
    'demo_confirm_echo',
    { text: '换过的参数' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(codeOf(swapped), TOOL_RESULT_CODES.confirmationMismatch);
  assert.equal(executions, 0);

  // 批准没有被换参数的调用消耗掉：原参数仍然可以执行一次。
  const original = await registry.execute(
    'demo_confirm_echo',
    { text: '原始参数' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(original.ok, true);
  assert.equal(executions, 1);
});

test('确认：拒绝后同一 actionId 不能重试，也不能翻案', async () => {
  let executions = 0;
  const registry = fixedRegistry({ createActionId: sequenceIds() });
  registry.register(confirmEchoDefinition({ handler: () => { executions += 1; return { echoed: true }; } }));
  const context = { permissions: ['demo:write'] };

  const request = registry.requestConfirmation('demo_confirm_echo', { text: '不要做' });
  const denied = registry.decideConfirmation(request.actionId, 'deny');
  assert.equal(denied.status, 'denied');

  const retried = await registry.execute('demo_confirm_echo', { text: '不要做' }, { ...context, actionId: request.actionId });
  assert.equal(codeOf(retried), TOOL_RESULT_CODES.confirmationDenied);
  assert.equal(executions, 0);

  assert.equal(registry.decideConfirmation(request.actionId, 'approve').code, TOOL_RESULT_CODES.confirmationAlreadyDecided);
  assert.equal(registry.decideConfirmation(request.actionId, 'deny').code, TOOL_RESULT_CODES.confirmationAlreadyDecided);
  assert.equal(registry.describeConfirmation(request.actionId).status, 'denied');

  // 拒绝、拒绝后的重试阻断、翻案被拒都留下脱敏审计；不含 actionId 原文。
  const events = registry.audit().filter((entry) => entry.tool === 'demo_confirm_echo');
  const decision = events.find((entry) => entry.event === 'confirmation-decision');
  assert.equal(decision.confirmation, TOOL_CONFIRMATION_STATES.denied);
  assert.equal(decision.code, TOOL_RESULT_CODES.ok);
  assert.equal(decision.correlationId, request.correlationId);
  const deniedExecution = events.find((entry) => entry.event === 'execute');
  assert.equal(deniedExecution.code, TOOL_RESULT_CODES.confirmationDenied);
  const rejectedDecisions = events.filter((entry) => entry.event === 'confirmation-decision-rejected');
  assert.equal(rejectedDecisions.length, 2);
  assert.ok(rejectedDecisions.every((entry) => entry.code === TOOL_RESULT_CODES.confirmationAlreadyDecided));
  assert.ok(rejectedDecisions.every((entry) => entry.confirmation === TOOL_CONFIRMATION_STATES.denied));
  assert.equal(JSON.stringify(events).includes(request.actionId), false);
});

test('确认 actionId：非法/碰撞 ID fail closed，且不覆盖既有 pending/approved/denied', async () => {
  // 生成器输出非法：空串、非字符串、含空格、超长——一律闭合且不落库。
  for (const output of ['', 42, 'bad id!', 'x'.repeat(129)]) {
    const registry = fixedRegistry({ createActionId: () => output });
    registry.register(confirmEchoDefinition());
    const result = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
    assert.equal(codeOf(result), TOOL_RESULT_CODES.confirmationIdUnavailable);
    assert.equal(result.tool, 'demo_confirm_echo');
    assert.equal(registry.stats().confirmations, 0);
    const rejected = registry.audit().filter((entry) => entry.event === 'confirmation-request-rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].code, TOOL_RESULT_CODES.confirmationIdUnavailable);
    assert.equal(rejected[0].confirmation, TOOL_CONFIRMATION_STATES.notCreated);
    if (typeof output === 'string' && output !== '') {
      assert.equal(JSON.stringify(result).includes(output), false);
      assert.equal(JSON.stringify(rejected).includes(output), false);
    }
  }

  // 生成器直接抛错：折叠成闭合码，不泄漏异常文本。
  const throwing = fixedRegistry({ createActionId: () => { throw new Error('SECRET-id-generator'); } });
  throwing.register(confirmEchoDefinition());
  const thrown = throwing.requestConfirmation('demo_confirm_echo', { text: 'x' });
  assert.equal(codeOf(thrown), TOOL_RESULT_CODES.confirmationIdUnavailable);
  assert.equal(JSON.stringify(thrown).includes('SECRET'), false);
  assert.equal(throwing.stats().confirmations, 0);

  // 重复 ID：pending 不被覆盖。
  let next = 'act-fixed';
  const registry = fixedRegistry({ createActionId: () => next });
  registry.register(confirmEchoDefinition());
  const first = registry.requestConfirmation('demo_confirm_echo', { text: 'a' });
  assert.equal(first.ok, true);
  const duplicatePending = registry.requestConfirmation('demo_confirm_echo', { text: 'b' });
  assert.equal(codeOf(duplicatePending), TOOL_RESULT_CODES.confirmationIdUnavailable);
  assert.equal(registry.describeConfirmation(first.actionId).status, 'pending');
  assert.equal(registry.stats().confirmations, 1);

  // 批准后重复 ID 仍不覆盖 approved，原批准仍可执行一次。
  registry.decideConfirmation(first.actionId, 'approve');
  const duplicateApproved = registry.requestConfirmation('demo_confirm_echo', { text: 'c' });
  assert.equal(codeOf(duplicateApproved), TOOL_RESULT_CODES.confirmationIdUnavailable);
  assert.equal(registry.describeConfirmation(first.actionId).status, 'approved');
  const executed = await registry.execute(
    'demo_confirm_echo',
    { text: 'a' },
    { permissions: ['demo:write'], actionId: first.actionId },
  );
  assert.equal(executed.ok, true);

  // 拒绝后重复 ID 不覆盖 denied。
  next = 'act-denied';
  const deniedRegistry = fixedRegistry({ createActionId: () => next });
  deniedRegistry.register(confirmEchoDefinition());
  const deniedRequest = deniedRegistry.requestConfirmation('demo_confirm_echo', { text: 'd' });
  deniedRegistry.decideConfirmation(deniedRequest.actionId, 'deny');
  const duplicateDenied = deniedRegistry.requestConfirmation('demo_confirm_echo', { text: 'e' });
  assert.equal(codeOf(duplicateDenied), TOOL_RESULT_CODES.confirmationIdUnavailable);
  assert.equal(deniedRegistry.describeConfirmation(deniedRequest.actionId).status, 'denied');
});

test('执行审计关联不依赖 actionId 生成器：生成器抛错时匿名执行与确认拒绝仍然稳定', async () => {
  let generatorCalls = 0;
  let confirmExecutions = 0;
  const registry = fixedRegistry({
    createActionId: () => {
      generatorCalls += 1;
      throw new Error('SECRET-GEN-A');
    },
  });
  registry.register(definition({
    name: 'demo_anonymous_read',
    permissions: [],
    handler: () => ({ anonymous: true }),
  }));
  registry.register(confirmEchoDefinition({
    permissions: [],
    handler: () => {
      confirmExecutions += 1;
      return { echoed: true };
    },
  }));

  // 无 actionId 的普通执行不能借 actionId 生成器造关联标识：生成器抛错也不能让
  // execute 原样拒绝，更不能丢掉 execution audit。
  const direct = await registry.execute('demo_anonymous_read', { text: 'x' });
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.value, { anonymous: true });

  // 确认工具缺 actionId 必须稳定返回 confirmation-required，同时留下脱敏审计。
  const missing = await registry.execute('demo_confirm_echo', { text: 'x' });
  assert.equal(codeOf(missing), TOOL_RESULT_CODES.confirmationRequired);
  assert.equal(confirmExecutions, 0);
  assert.equal(generatorCalls, 0, '无 actionId 的执行不应调用生成器');

  const entries = registry.audit();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.event === 'execute'));
  assert.equal(entries[0].code, TOOL_RESULT_CODES.ok);
  assert.equal(entries[1].code, TOOL_RESULT_CODES.confirmationRequired);
  assert.equal(entries[1].confirmation, TOOL_CONFIRMATION_STATES.missing);
  assert.notEqual(entries[0].correlationId, entries[1].correlationId);
  for (const entry of entries) {
    assert.match(entry.correlationId, /^c-[0-9a-f]{16}$/u);
    assertValidIso(entry.at);
  }
  assert.equal(JSON.stringify({ direct, missing, entries }).includes('SECRET-GEN-A'), false);

  // 生成器仍只用于显式确认请求；其异常继续 fail closed 且不泄漏原文。
  const request = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
  assert.equal(codeOf(request), TOOL_RESULT_CODES.confirmationIdUnavailable);
  assert.equal(generatorCalls, 1);
  assert.equal(JSON.stringify(request).includes('SECRET-GEN-A'), false);
  assert.equal(JSON.stringify(registry.audit()).includes('SECRET-GEN-A'), false);
});

test('时钟边界：注入时钟抛错/NaN/Infinity/越界都不外抛，审计与确认视图回退有效 ISO', async () => {
  const badClocks = [
    ['抛错', () => { throw new Error('SECRET-CLOCK-A'); }],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['上界外', () => 8.64e15 + 1],
    ['下界外', () => -(8.64e15 + 1)],
  ];

  for (const [label, now] of badClocks) {
    const registry = fixedRegistry({ now, createActionId: sequenceIds() });
    registry.register(definition({
      name: 'demo_clock_plain',
      permissions: [],
      handler: () => ({ clock: true }),
    }));
    registry.register(confirmEchoDefinition({ permissions: [], handler: () => ({ confirmed: true }) }));

    const direct = await registry.execute('demo_clock_plain', { text: 'x' });
    assert.equal(direct.ok, true, label);

    let request;
    assert.doesNotThrow(() => {
      request = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
    }, label);
    assert.equal(request.ok, true, label);
    const pending = registry.describeConfirmation(request.actionId);
    assert.equal(pending.status, 'pending', label);
    assertValidIso(pending.requestedAt);

    let approved;
    assert.doesNotThrow(() => {
      approved = registry.decideConfirmation(request.actionId, 'approve');
    }, label);
    assert.equal(approved.status, 'approved', label);

    const executed = await registry.execute(
      'demo_confirm_echo',
      { text: 'x' },
      { permissions: ['demo:write'], actionId: request.actionId },
    );
    assert.equal(executed.ok, true, label);
    const consumed = registry.describeConfirmation(request.actionId);
    assert.equal(consumed.status, 'consumed', label);
    assertValidIso(consumed.requestedAt);

    // 拒绝路径同样经过确认审计与决策审计，时间注入仍不能抛 RangeError。
    const deniedRequest = registry.requestConfirmation('demo_confirm_echo', { text: 'y' });
    assert.equal(deniedRequest.ok, true, label);
    let denied;
    assert.doesNotThrow(() => {
      denied = registry.decideConfirmation(deniedRequest.actionId, 'deny');
    }, label);
    assert.equal(denied.status, 'denied', label);
    let rejected;
    assert.doesNotThrow(() => {
      rejected = registry.decideConfirmation(deniedRequest.actionId, 'approve');
    }, label);
    assert.equal(rejected.code, TOOL_RESULT_CODES.confirmationAlreadyDecided, label);

    const entries = registry.audit();
    assert.ok(entries.length >= 6, label);
    for (const entry of entries) assertValidIso(entry.at);
    assert.equal(JSON.stringify({ entries, request, consumed }).includes('SECRET-CLOCK-A'), false);
  }
});

test('本地时钟也失效时：时钟回退到可表示的纪元时间，不抛 RangeError', async () => {
  const originalDateNow = Date.now;
  const registry = fixedRegistry({
    now: () => { throw new Error('SECRET-CLOCK-B'); },
    createActionId: sequenceIds(),
  });
  registry.register(definition({ name: 'demo_clock_fallback', permissions: [], handler: () => ({}) }));
  registry.register(confirmEchoDefinition({ permissions: [] }));

  try {
    // 先让本地时钟返回 NaN：覆盖“本地时钟不可表示”分支。
    Date.now = () => Number.NaN;
    const result = await registry.execute('demo_clock_fallback', { text: 'x' });
    assert.equal(result.ok, true);
    const request = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
    assert.equal(request.ok, true);
    assert.equal(registry.describeConfirmation(request.actionId).requestedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(registry.audit()[0].at, '1970-01-01T00:00:00.000Z');

    // 再让本地时钟直接抛错：覆盖“本地时钟调用失败”分支。
    Date.now = () => { throw new Error('SECRET-LOCAL-CLOCK'); };
    const second = await registry.execute('demo_clock_fallback', { text: 'x' });
    assert.equal(second.ok, true);
    const secondRequest = registry.requestConfirmation('demo_confirm_echo', { text: 'y' });
    assert.equal(secondRequest.ok, true);
    assert.equal(registry.describeConfirmation(secondRequest.actionId).requestedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(registry.audit().at(-1).at, '1970-01-01T00:00:00.000Z');
    assert.equal(JSON.stringify(registry.audit()).includes('SECRET'), false);
  } finally {
    Date.now = originalDateNow;
  }
});

test('确认 API：非法决策 / 未知凭据 / 不需要确认 / 容量上限', async () => {
  const registry = fixedRegistry({ createActionId: sequenceIds(), confirmationLimit: 1 });
  registry.register(confirmEchoDefinition());
  registry.register(definition({ name: 'demo_plain' }));

  assert.equal(codeOf(registry.requestConfirmation('unknown_tool', {})), TOOL_RESULT_CODES.unknownTool);
  assert.equal(codeOf(registry.requestConfirmation(42, {})), TOOL_RESULT_CODES.unknownTool);
  assert.equal(codeOf(registry.requestConfirmation('demo_plain', { text: 'x' })), TOOL_RESULT_CODES.confirmationNotRequired);
  assert.equal(codeOf(registry.requestConfirmation('demo_confirm_echo', {})), TOOL_RESULT_CODES.invalidArguments);

  const first = registry.requestConfirmation('demo_confirm_echo', { text: 'a' });
  assert.equal(first.ok, true);
  const full = registry.requestConfirmation('demo_confirm_echo', { text: 'b' });
  assert.equal(codeOf(full), TOOL_RESULT_CODES.confirmationCapacity);

  assert.equal(codeOf(registry.decideConfirmation('nope', 'approve')), TOOL_RESULT_CODES.confirmationUnknown);
  assert.equal(codeOf(registry.decideConfirmation(first.actionId, 'maybe')), TOOL_RESULT_CODES.invalidDecision);
  assert.equal(registry.decideConfirmation(42, 'approve').code, TOOL_RESULT_CODES.confirmationUnknown);
  assert.equal(registry.describeConfirmation('nope'), null);
  assert.equal(registry.describeConfirmation(42), null);

  // 非法决策不算用过：同一个 actionId 仍可正常批准。
  assert.equal(registry.decideConfirmation(first.actionId, 'approve').status, 'approved');
  const used = await registry.execute('demo_confirm_echo', { text: 'a' }, { permissions: ['demo:write'], actionId: first.actionId });
  assert.equal(used.ok, true);

  // 记录（含已消耗/已拒绝）计入上限：容量满时继续 fail closed，不静默淘汰。
  assert.equal(codeOf(registry.requestConfirmation('demo_confirm_echo', { text: 'b' })), TOOL_RESULT_CODES.confirmationCapacity);
});

test('确认：批准不能跨工具复用', async () => {
  const registry = fixedRegistry({ createActionId: sequenceIds(), confirmationLimit: 5 });
  registry.register(confirmEchoDefinition());
  registry.register(confirmEchoDefinition({ name: 'demo_confirm_other' }));

  const request = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
  registry.decideConfirmation(request.actionId, 'approve');
  const crossed = await registry.execute(
    'demo_confirm_other',
    { text: 'x' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(codeOf(crossed), TOOL_RESULT_CODES.confirmationMismatch);
  // 同一 actionId 仍可执行原本批准的工具。
  const proper = await registry.execute(
    'demo_confirm_echo',
    { text: 'x' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(proper.ok, true);
});

test('确认：未知 actionId 与非法 actionId 类型都 fail closed', async () => {
  const registry = fixedRegistry();
  registry.register(confirmEchoDefinition());
  const context = { permissions: ['demo:write'] };
  assert.equal(
    codeOf(await registry.execute('demo_confirm_echo', { text: 'x' }, { ...context, actionId: 'invented-id' })),
    TOOL_RESULT_CODES.confirmationUnknown,
  );
  assert.equal(
    codeOf(await registry.execute('demo_confirm_echo', { text: 'x' }, { ...context, actionId: 42 })),
    TOOL_RESULT_CODES.confirmationRequired,
  );
  assert.equal(
    codeOf(await registry.execute('demo_confirm_echo', { text: 'x' }, { ...context, actionId: '' })),
    TOOL_RESULT_CODES.confirmationRequired,
  );
});

/* ───────────────────────── 5. 权限与定时门控 ───────────────────────── */

test('权限门控：缺标签拒绝，多给不影响，上下文形状非法同样拒绝', async () => {
  const calls = { count: 0 };
  const registry = fixedRegistry();
  registry.register(definition({ handler: () => { calls.count += 1; return {}; } }));

  assert.equal(
    codeOf(await registry.execute('demo_custom', { text: 'x' })),
    TOOL_RESULT_CODES.permissionDenied,
  );
  assert.equal(
    codeOf(await registry.execute('demo_custom', { text: 'x' }, { permissions: ['demo:write'] })),
    TOOL_RESULT_CODES.permissionDenied,
  );
  const granted = await registry.execute(
    'demo_custom',
    { text: 'x' },
    { permissions: new Set(['demo:read', 'demo:write']) },
  );
  assert.equal(granted.ok, true);
  assert.equal(calls.count, 1);

  const auditBefore = registry.stats().auditEntries;
  for (const [context, label] of [
    [{ permissions: 'demo:read' }, '权限不是数组/Set'],
    [{ permissions: [7] }, '权限标签不是字符串'],
    [{ trigger: 'cron', permissions: ['demo:read'] }, '触发词不在闭合词汇'],
    [null, '上下文不是对象'],
  ]) {
    assert.equal(
      codeOf(await registry.execute('demo_custom', { text: 'x' }, context)),
      TOOL_RESULT_CODES.invalidContext,
      label,
    );
  }
  // 非法上下文不落审计（避免把未知触发词写进记录）。
  assert.equal(registry.stats().auditEntries, auditBefore);
  assert.equal(calls.count, 1);
});

test('执行上下文里的访问器抛错 → invalid-context，无审计、无异常文本', async () => {
  const called = [];
  const registry = fixedRegistry();
  registry.register(definition({ handler: () => { called.push(1); return {}; } }));
  const context = {};
  Object.defineProperty(context, 'trigger', {
    enumerable: true,
    get() { throw new Error('SECRET-context-getter'); },
  });
  const result = await registry.execute('demo_custom', { text: 'x' }, context);
  assert.equal(codeOf(result), TOOL_RESULT_CODES.invalidContext);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(registry.audit().length, 0);
  assert.deepEqual(called, []);
});

test('定时门控：schedulable=false 拒绝 scheduled，true 放行', async () => {
  const registry = fixedRegistry();
  registry.register(definition({ name: 'demo_manual' }));
  registry.register(definition({ name: 'demo_scheduled_ok', schedulable: true, permissions: [] }));

  assert.equal(
    codeOf(await registry.execute('demo_manual', { text: 'x' }, { trigger: 'scheduled', permissions: ['demo:read'] })),
    TOOL_RESULT_CODES.scheduledNotAllowed,
  );
  const allowed = await registry.execute('demo_scheduled_ok', { text: 'x' }, { trigger: 'scheduled' });
  assert.equal(allowed.ok, true);
  const manual = await registry.execute('demo_manual', { text: 'x' }, { permissions: ['demo:read'] });
  assert.equal(manual.ok, true);
});

/* ───────────────────────── 6. 非法参数与信息泄漏 ───────────────────────── */

test('非法/恶意参数不执行、不回显、不落审计正文', async () => {
  const secret = 'user-secret-LEAK-42';
  const calls = [];
  const registry = fixedRegistry();
  registry.register(definition({
    name: 'demo_strict',
    auditFields: ['argsDigest'],
    handler: (args) => { calls.push(args); return { accepted: true }; },
  }));

  const cases = [
    {},
    { text: 'ok', extra: secret },
    { text: 42 },
    { text: '' },
    { text: 'x'.repeat(21) },
    JSON.parse(`{"__proto__":"${secret}","text":"ok"}`),
    null,
    [],
    'text',
  ];
  for (const args of cases) {
    const result = await registry.execute('demo_strict', args, { permissions: ['demo:read'] });
    assert.equal(codeOf(result), TOOL_RESULT_CODES.invalidArguments);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(calls, []);
  const entries = registry.audit();
  assert.equal(entries.length, cases.length);
  assert.ok(entries.every((entry) => entry.code === TOOL_RESULT_CODES.invalidArguments));
  assert.ok(entries.every((entry) => !Object.hasOwn(entry, 'argsDigest')));
  assert.equal(JSON.stringify(registry.audit()).includes(secret), false);
  assert.equal(({}).polluted, undefined);
});

test('参数快照：继承属性/访问器/隐藏键/Symbol/Proxy 都不能绕过 schema 或批准', async () => {
  const seen = [];
  const registry = fixedRegistry({ createActionId: sequenceIds() });
  registry.register(definition({
    name: 'demo_snapshot',
    permissions: [],
    handler: (args) => {
      seen.push({ ...args });
      return { size: Object.keys(args).length };
    },
  }));
  registry.register(confirmEchoDefinition());

  const inherited = Object.create({ text: 'inherited-value' });
  const accessor = {};
  let reads = 0;
  Object.defineProperty(accessor, 'text', {
    enumerable: true,
    get() {
      reads += 1;
      return reads > 2 ? 'x'.repeat(30) : 'ok';
    },
  });
  const hidden = {};
  Object.defineProperty(hidden, 'text', { value: 'hidden-value', enumerable: false });
  const symbolKey = { text: 'ok' };
  symbolKey[Symbol('smuggled')] = 'symbol-value';
  const trapped = new Proxy({ text: 'ok' }, {
    ownKeys() { throw new Error('Proxy 陷阱不该外泄'); },
  });

  for (const args of [inherited, accessor, hidden, symbolKey, trapped]) {
    const result = await registry.execute('demo_snapshot', args);
    assert.equal(codeOf(result), TOOL_RESULT_CODES.invalidArguments);
    assert.equal(JSON.stringify(result).includes('inherited-value'), false);
    assert.equal(JSON.stringify(result).includes('Proxy 陷阱'), false);
  }
  assert.deepEqual(seen, []);
  assert.equal(registry.audit().length, 5);
  assert.ok(registry.audit().every((entry) => entry.code === TOOL_RESULT_CODES.invalidArguments));

  // null 原型的纯数据可以执行，handler 拿到的是冻结副本。
  const nullPrototype = Object.assign(Object.create(null), { text: 'ok' });
  const accepted = await registry.execute('demo_snapshot', nullPrototype);
  assert.equal(accepted.ok, true);
  assert.deepEqual(seen, [{ text: 'ok' }]);

  // 批准绑定使用同一份快照：继承属性既不能请求批准，也不能拿来执行。
  assert.equal(codeOf(registry.requestConfirmation('demo_confirm_echo', inherited)), TOOL_RESULT_CODES.invalidArguments);
  const request = registry.requestConfirmation('demo_confirm_echo', { text: 'ok' });
  registry.decideConfirmation(request.actionId, 'approve');
  const bypass = await registry.execute(
    'demo_confirm_echo',
    inherited,
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(codeOf(bypass), TOOL_RESULT_CODES.invalidArguments);
  const normal = await registry.execute(
    'demo_confirm_echo',
    { text: 'ok' },
    { permissions: ['demo:write'], actionId: request.actionId },
  );
  assert.equal(normal.ok, true);
});

test('handler 返回值必须是可安全冻结的纯数据，否则按 handler-failed 闭合', async () => {
  const registry = fixedRegistry();
  const unsafe = {
    demo_result_map: () => new Map([['a', 1]]),
    demo_result_date: () => new Date(0),
    demo_result_typed: () => new Uint8Array([1, 2, 3]),
    demo_result_array_proto: () => Object.setPrototypeOf([1], null),
    demo_result_class: () => new (class Demo { constructor() { this.a = 1; } })(),
    demo_result_function: () => () => {},
    demo_result_symbol: () => Symbol('x'),
    demo_result_bigint: () => 1n,
    demo_result_nan: () => Number.NaN,
    demo_result_infinite: () => Number.POSITIVE_INFINITY,
    demo_result_sparse: () => {
      const sparse = [];
      sparse[1] = 1;
      return sparse;
    },
    demo_result_accessor: () => ({ get value() { return 1; } }),
    demo_result_hidden: () => {
      const hidden = {};
      Object.defineProperty(hidden, 'hiddenSecret', { value: 'HIDDEN', enumerable: false });
      return hidden;
    },
    demo_result_array_extra: () => {
      const array = [1];
      array.extra = 'EXTRA';
      return array;
    },
    demo_result_array_nan_key: () => {
      const array = [1];
      array.NaN = 'EXTRA';
      return array;
    },
    demo_result_array_infinity_key: () => {
      const array = [1];
      array.Infinity = 'EXTRA';
      return array;
    },
    demo_result_array_symbol: () => {
      const array = [1];
      array[Symbol('x')] = 1;
      return array;
    },
    demo_result_array_hidden_index: () => {
      const array = [1];
      Object.defineProperty(array, 0, { value: 1, enumerable: false });
      return array;
    },
    demo_result_array_out_of_range: () => new Proxy([1], {
      ownKeys(target) { return [...Reflect.ownKeys(target), '5']; },
      getOwnPropertyDescriptor(target, key) {
        if (key === '5') return { value: 'OUT', enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
    demo_result_symbol_key: () => ({ [Symbol('x')]: 1 }),
    demo_result_deep: () => {
      const root = {};
      let cursor = root;
      for (let index = 0; index < 10; index += 1) {
        cursor.next = {};
        cursor = cursor.next;
      }
      return root;
    },
  };
  for (const [name, handler] of Object.entries(unsafe)) {
    registry.register(definition({ name, permissions: [], handler }));
  }
  for (const name of Object.keys(unsafe)) {
    const result = await registry.execute(name, { text: 'x' });
    assert.equal(codeOf(result), TOOL_RESULT_CODES.handlerFailed, name);
    assert.equal(JSON.stringify(result).includes('unsafe-result'), false);
  }
  // 审计与最终返回一致：不安全的返回值不会被记成 ok。
  assert.equal(registry.audit().length, Object.keys(unsafe).length);
  assert.ok(registry.audit().every((entry) => entry.code === TOOL_RESULT_CODES.handlerFailed));

  // 合法纯数据会被深拷贝并冻结；null 原型对象也支持。
  registry.register(definition({
    name: 'demo_result_ok',
    permissions: [],
    handler: () => ({
      list: [1, 'a', true, null, undefined],
      nested: Object.assign(Object.create(null), { value: 1 }),
      fallback: undefined,
    }),
  }));
  const ok = await registry.execute('demo_result_ok', { text: 'x' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.list, [1, 'a', true, null, undefined]);
  assert.equal(ok.value.nested.value, 1);
  assert.equal(ok.value.fallback, undefined);
  assert.ok(Object.isFrozen(ok.value));
  assert.ok(Object.isFrozen(ok.value.list));
  assert.throws(() => { ok.value.list.push(2); }, TypeError);
});

test('未知工具名不回显，也不产生审计条目', async () => {
  const registry = fixedRegistry();
  const result = await registry.execute('LEAK_TOOL_NAME', {}, {});
  assert.equal(codeOf(result), TOOL_RESULT_CODES.unknownTool);
  assert.equal(JSON.stringify(result).includes('LEAK_TOOL_NAME'), false);
  assert.equal(Object.hasOwn(result, 'tool'), false);
  assert.equal(codeOf(await registry.execute(undefined, {})), TOOL_RESULT_CODES.unknownTool);
  assert.equal(registry.audit().length, 0);
});

test('参数类型/边界：boolean、number、enum 都按 schema 校验', async () => {
  const registry = fixedRegistry();
  registry.register(definition({
    name: 'demo_typed',
    permissions: [],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        flag: { type: 'boolean' },
        ratio: { type: 'number', minimum: 0.5, maximum: 1.5 },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['flag'],
    },
    handler: (args) => ({ flag: args.flag, ratio: args.ratio ?? null, mode: args.mode ?? null }),
  }));
  const ok = await registry.execute('demo_typed', { flag: true, ratio: 1, mode: 'a' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { flag: true, ratio: 1, mode: 'a' });
  for (const args of [{ flag: 'true' }, { flag: true, ratio: 2 }, { flag: true, ratio: 0.1 }, { flag: true, mode: 'c' }]) {
    assert.equal(codeOf(await registry.execute('demo_typed', args)), TOOL_RESULT_CODES.invalidArguments);
  }
});

/* ───────────────────────── 7. handler 异常与超时 ───────────────────────── */

test('handler 同步抛错与异步拒绝都只回稳定错误码', async () => {
  const registry = fixedRegistry();
  registry.register(definition({ name: 'demo_throws', handler: () => { throw new Error('SECRET-throw'); } }));
  registry.register(definition({
    name: 'demo_rejects',
    handler: () => Promise.reject(new Error(`SECRET-reject-${'x'.repeat(3)}`)),
  }));

  for (const name of ['demo_throws', 'demo_rejects']) {
    const result = await registry.execute(name, { text: 'x' }, { permissions: ['demo:read'] });
    assert.equal(codeOf(result), TOOL_RESULT_CODES.handlerFailed);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(Object.hasOwn(result, 'compensated'), false);
  }
  assert.equal(JSON.stringify(registry.audit()).includes('SECRET'), false);
});

test('超时后不把迟到结果记作成功，也不自动补偿', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveLate;
  let compensationCalls = 0;
  const registry = fixedRegistry();
  registry.register(definition({
    name: 'demo_slow',
    risk: 'reversible',
    timeoutMs: 10,
    failurePolicy: 'rollback',
    compensate: () => { compensationCalls += 1; },
    auditFields: ['durationMs'],
    handler: () => new Promise((resolve) => { resolveLate = resolve; }),
  }));

  const running = registry.execute('demo_slow', { text: 'x' }, { permissions: ['demo:read'] });
  t.mock.timers.tick(10);
  const timedOut = await running;
  assert.equal(codeOf(timedOut), TOOL_RESULT_CODES.timeout);
  assert.equal(Object.hasOwn(timedOut, 'compensated'), false);
  assert.equal(compensationCalls, 0);

  const before = registry.audit();
  resolveLate({ ok: true, late: true });
  await new Promise((resolve) => setImmediate(resolve));
  const after = registry.audit();
  assert.equal(after.length, before.length);
  assert.equal(after[0].code, TOOL_RESULT_CODES.timeout);
  assert.equal(registry.describe('demo_slow').timeoutMs, 10);
  // 迟到结果没有让第二次执行变成成功，也没有新增审计。
  assert.equal(after.some((entry) => entry.code === TOOL_RESULT_CODES.ok), false);
});

/* ───────────────────────── 8. 审计脱敏、上限与快照 ───────────────────────── */

test('审计：只含安全元数据，按声明裁剪字段，摘要稳定且不含正文', async () => {
  const store = createMemoryNoteStore(['私密便签正文']);
  const registry = fixedRegistry({ createActionId: sequenceIds('call') });
  registerNoteTools(registry, store);

  await registry.execute('demo_note_read', { limit: 1 }, { permissions: ['note:read'] });
  await registry.execute('demo_note_append', { text: '第一条' }, { permissions: ['note:write'] });
  await registry.execute('demo_note_append', { text: '第二条' }, { permissions: ['note:write'] });

  const entries = registry.audit();
  assert.equal(entries.length, 3);
  const declaredByTool = {
    demo_note_read: ['durationMs', 'trigger'],
    demo_note_append: ['argsDigest', 'durationMs'],
  };
  for (const entry of entries) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(entry.event, 'execute');
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['seq', 'event', 'tool', 'risk', 'at', 'code', 'correlationId', 'confirmation', ...declaredByTool[entry.tool]].sort(),
    );
    assert.match(entry.correlationId, /^c-[0-9a-f]{16}$/u);
    assert.notEqual(entry.correlationId, 'call-1');
    assert.equal(entry.at, FIXED_ISO);
  }
  // 摘要只关联参数，不含正文；不同参数摘要不同。
  const [, firstAppend, secondAppend] = entries;
  assert.equal(firstAppend.argsDigest.length, 16);
  assert.notEqual(firstAppend.argsDigest, secondAppend.argsDigest);
  assert.equal(JSON.stringify(entries).includes('第一条'), false);
  assert.equal(JSON.stringify(entries).includes('私密便签正文'), false);
  assert.equal(JSON.stringify(entries).includes('note:read'), false);
});

test('审计：有上限、丢最旧并计数，快照不可变且不是活引用', async () => {
  const registry = fixedRegistry({ auditLimit: 2 });
  registry.register(definition({ permissions: [], handler: () => ({}) }));

  for (let index = 0; index < 3; index += 1) {
    await registry.execute('demo_custom', { text: `第${index}次` });
  }
  const snapshot = registry.audit();
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot.map((entry) => entry.seq), [2, 3]);
  assert.deepEqual(registry.stats(), {
    tools: 1,
    confirmations: 0,
    auditEntries: 2,
    droppedAuditEntries: 1,
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { snapshot.push(snapshot[0]); }, TypeError);
  assert.throws(() => { snapshot[0].code = 'tampered'; }, TypeError);

  // 快照是副本：后续执行不会改变已拿到的快照。
  await registry.execute('demo_custom', { text: '第四次' });
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].seq, 2);
  assert.equal(registry.audit().length, 2);
  assert.equal(registry.stats().droppedAuditEntries, 2);
});

test('审计与返回里不含身份内容或参数正文（桩场景）', async () => {
  const store = createMemoryNoteStore(['QQ-身份-不应出现']);
  const registry = fixedRegistry();
  registry.register(createNoteReadTool(store));
  registry.register(createNoteClearTool(store));

  await registry.execute('demo_note_read', { limit: 20 }, { permissions: ['note:read'] });
  const request = registry.requestConfirmation('demo_note_clear', { scope: 'demo' });
  assert.equal(JSON.stringify(request).includes('QQ-身份'), false);
  const trace = JSON.stringify({ audit: registry.audit(), request });
  assert.equal(trace.includes('QQ-身份'), false);
  assert.equal(trace.includes('demo:read'), false);
  assert.equal(trace.includes('userId'), false);
});

test('默认时钟与 actionId 生成器：不注入选项也能安全运行', async () => {
  const registry = createToolRegistry();
  registry.register(definition({ permissions: [], handler: () => ({ done: true }) }));
  registry.register(confirmEchoDefinition());

  const before = Date.now();
  const result = await registry.execute('demo_custom', { text: 'x' });
  const after = Date.now();
  assert.equal(result.ok, true);
  const [entry] = registry.audit();
  const at = Date.parse(entry.at);
  assert.ok(at >= before && at <= after + 1000, `审计时间 ${entry.at} 应落在本次调用附近`);
  assert.match(entry.correlationId, /^c-[0-9a-f]{16}$/u);

  const request = registry.requestConfirmation('demo_confirm_echo', { text: 'x' });
  assert.equal(request.ok, true);
  assert.match(request.actionId, /^[0-9a-f]{8}-[0-9a-f]{4}-/u);
});

/* ───────────────────────── 9. 声明词汇的稳定性 ───────────────────────── */

test('公开词汇与常量保持冻结、闭合', () => {
  for (const list of [
    TOOL_RISK_LEVELS,
    TOOL_FAILURE_POLICIES,
    TOOL_TRIGGERS,
    CONFIRMATION_STATUSES,
    TOOL_AUDIT_FIELDS,
  ]) {
    assert.ok(Object.isFrozen(list));
  }
  assert.deepEqual(TOOL_RISK_LEVELS, ['read-only', 'reversible', 'confirm', 'high-risk']);
  assert.deepEqual(TOOL_FAILURE_POLICIES, ['stop', 'rollback']);
  assert.deepEqual(TOOL_TRIGGERS, ['user', 'scheduled']);
  assert.deepEqual(CONFIRMATION_STATUSES, ['pending', 'approved', 'denied', 'consumed']);
  assert.deepEqual(TOOL_AUDIT_FIELDS, ['trigger', 'durationMs', 'argsDigest']);
  assert.ok(Object.isFrozen(TOOL_RESULT_CODES));
  assert.ok(Object.isFrozen(TOOL_REGISTRATION_ERRORS));
  assert.ok(Object.isFrozen(TOOL_REGISTRY_LIMITS.auditEntries));
});
