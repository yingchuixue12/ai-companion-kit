/**
 * SOP06 · 工具宿主桥接 · 离线专项测试
 * ─────────────────────────────────────────────────────────────
 * 只使用纯内存假工具、注入时钟/actionId；不联网、不碰设备、不调模型。
 * 覆盖：默认关闭、显式注入、构造门控、授权、跨会话确认、拒绝/超时重试、
 * 失败不虚报、脱敏审计、AgentLoop 宿主接线与公开入口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import AgentLoop from '../src/agent-loop.js';
import { createToolHostBridge, formatToolHostOutcome } from '../src/tools/host-bridge.js';
import * as publicApi from '../src/lib.js';
import {
  createMemoryNoteStore,
  createNoteAppendTool,
  createNoteClearTool,
  createNoteReadTool,
} from '../src/tools/registry.js';

const FIXED_NOW = Date.parse('2026-11-22T00:00:00.000Z');

function sequenceIds(prefix = 'act') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function definition(overrides = {}) {
  return {
    name: 'demo_custom',
    description: '测试用纯内存假工具',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 20 },
      },
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

function bridgeWith(tools, options = {}) {
  return createToolHostBridge({
    enabled: true,
    tools,
    permissions: ['demo:read', 'demo:write', 'note:read', 'note:write'],
    now: () => FIXED_NOW,
    createActionId: sequenceIds(),
    ...options,
  });
}

function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

test('默认关闭：不建注册表、不调用 handler，所有入口稳定返回 disabled', async () => {
  let calls = 0;
  const bridge = createToolHostBridge({
    tools: [definition({ handler: () => { calls += 1; return {}; } })],
  });

  assert.equal(bridge.enabled, false);
  assert.deepEqual(bridge.listTools(), []);
  assert.deepEqual(bridge.audit(), []);

  assertFailure(await bridge.execute('demo_custom', {}), 'tool-host-disabled');
  assertFailure(await bridge.model.call('demo_custom', {}), 'tool-host-disabled');
  assertFailure(bridge.requestConfirmation('demo_custom', {}, { sessionKey: 's1' }), 'tool-host-disabled');
  assertFailure(bridge.decideConfirmation('act-1', 'approve', { sessionKey: 's1' }), 'tool-host-disabled');
  assert.equal(calls, 0);

  // 关闭时不校验 tools：默认路径完全惰性，坏注入也不会被触碰。
  assert.doesNotThrow(() => createToolHostBridge({ tools: [null] }));
  // 只有显式 true 才启用；truthy 字符串不会意外打开。
  assert.equal(createToolHostBridge({ enabled: 'yes' }).enabled, false);
});

test('显式注入合法假工具：授权、执行、列表和审计都来自 registry', async () => {
  const store = createMemoryNoteStore(['旧便签']);
  const bridge = bridgeWith([
    createNoteReadTool(store),
    createNoteAppendTool(store),
  ], {
    permissions: ['note:read', 'note:write'],
    auditLimit: 10,
    confirmationLimit: 5,
  });

  assert.equal(bridge.enabled, true);
  assert.deepEqual(bridge.listTools().map((tool) => tool.name), [
    'demo_note_read',
    'demo_note_append',
  ]);

  const read = await bridge.execute('demo_note_read', { limit: 1 }, {});
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { notes: ['旧便签'] });

  const append = await bridge.execute('demo_note_append', { text: '新便签' }, {});
  assert.equal(append.ok, true);
  assert.equal(append.value.size, 2);

  // 权限固定来自宿主构造参数；调用参数里的伪权限不会临时提权。
  const noWrite = createToolHostBridge({
    enabled: true,
    tools: [createNoteAppendTool(createMemoryNoteStore())],
    permissions: ['note:read'],
  });
  assertFailure(
    await noWrite.execute('demo_note_append', { text: 'x' }, { permissions: ['note:write'] }),
    'permission-denied',
  );

  const audit = bridge.audit();
  assert.equal(audit.length, 2);
  assert.ok(Object.isFrozen(audit));
  assert.ok(audit.every((entry) => entry.event === 'execute'));
});

test('构造门控：只接受宿主注入的有界假工具', () => {
  assert.throws(() => createToolHostBridge(null), TypeError);
  assert.throws(() => createToolHostBridge({ enabled: true, tools: {} }), TypeError);
  assert.throws(() => createToolHostBridge({ enabled: true, permissions: {} }), TypeError);
  assert.throws(() => createToolHostBridge({ enabled: true, permissions: [42] }), TypeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: Array.from({ length: 9 }, () => definition()),
  }), TypeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ name: 'real_tool' })],
  }), TypeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ risk: 'high-risk' })],
  }), TypeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ schedulable: true })],
  }), TypeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ timeoutMs: 5001 })],
  }), RangeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ permissions: Array.from({ length: 9 }, (_, index) => `demo:p${index}`) })],
  }), RangeError);
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`p${index}`, { type: 'string' }]),
        ),
      },
    })],
  }), RangeError);
  // registry 自己的注册错误照常抛出，桥接不吞也不改。
  assert.throws(() => createToolHostBridge({
    enabled: true,
    tools: [definition({ handler: null })],
  }), /invalid-handler/u);
});

test('确认绑定 session：跨会话拿 actionId 不能确认、不能执行', async () => {
  const store = createMemoryNoteStore(['a', 'b']);
  const bridge = bridgeWith([createNoteClearTool(store)], {
    permissions: ['note:write'],
    createActionId: sequenceIds('clear'),
    confirmationLimit: 1,
  });

  assertFailure(await bridge.execute('demo_note_clear', { scope: 'demo' }, {}), 'confirmation-required');
  assertFailure(await bridge.model.call('demo_note_clear', { scope: 'demo' }), 'confirmation-required');
  assertFailure(bridge.requestConfirmation('demo_note_clear', { scope: 'demo' }, {}), 'invalid-call');

  const request = bridge.requestConfirmation('demo_note_clear', { scope: 'demo' }, { sessionKey: 's1' });
  assert.equal(request.ok, true);
  assert.match(request.actionId, /^clear-\d+$/u);
  const { actionId } = request;
  assertFailure(
    bridge.requestConfirmation('demo_note_clear', { scope: 'demo' }, { sessionKey: 's2' }),
    'confirmation-capacity',
  );

  // 另一个会话既不能替 s1 做决定，也不能拿 s1 的凭据执行。
  assertFailure(
    bridge.decideConfirmation(actionId, 'approve', { sessionKey: 's2' }),
    'confirmation-unknown',
  );
  const crossExecute = await bridge.execute(
    'demo_note_clear',
    { scope: 'demo' },
    { sessionKey: 's2', actionId },
  );
  assertFailure(crossExecute, 'confirmation-unknown');
  assert.equal(crossExecute.tool, 'demo_note_clear');
  assert.equal(store.size(), 2);
  // 不带 session 同样 fail closed。
  assertFailure(
    await bridge.execute('demo_note_clear', { scope: 'demo' }, { actionId }),
    'confirmation-unknown',
  );

  assert.equal(
    bridge.decideConfirmation(actionId, 'approve', { sessionKey: 's1' }).status,
    'approved',
  );
  assertFailure(
    await bridge.execute('demo_note_clear', { scope: 'demo' }, { sessionKey: 's2', actionId }),
    'confirmation-unknown',
  );
  assert.equal(store.size(), 2);

  const executed = await bridge.execute(
    'demo_note_clear',
    { scope: 'demo' },
    { sessionKey: 's1', actionId },
  );
  assert.equal(executed.ok, true);
  assert.equal(store.size(), 0);

  assertFailure(
    await bridge.execute('demo_note_clear', { scope: 'demo' }, { sessionKey: 's1', actionId }),
    'confirmation-used',
  );
});

test('确认只认 actionId，不信任 args 里的“确认/同意”文本', async () => {
  let calls = 0;
  const bridge = bridgeWith([definition({
    name: 'demo_confirm_note',
    risk: 'confirm',
    handler: () => { calls += 1; return { done: true }; },
  })]);

  const args = { text: '确认' };
  assertFailure(await bridge.model.call('demo_confirm_note', args), 'confirmation-required');
  assertFailure(
    await bridge.execute('demo_confirm_note', args, { sessionKey: 's1', actionId: '确认' }),
    'confirmation-unknown',
  );
  assert.equal(calls, 0);

  const request = bridge.requestConfirmation('demo_confirm_note', args, { sessionKey: 's1' });
  assert.equal(request.ok, true);
  // 未决定前不能执行。
  assertFailure(
    await bridge.execute('demo_confirm_note', args, { sessionKey: 's1', actionId: request.actionId }),
    'confirmation-pending',
  );
  assert.equal(calls, 0);
});

test('拒绝后不重试、不能翻案，handler 不会被调用', async () => {
  let calls = 0;
  const bridge = bridgeWith([definition({
    name: 'demo_confirm_echo',
    risk: 'confirm',
    handler: () => { calls += 1; return { echoed: true }; },
  })]);

  const request = bridge.requestConfirmation(
    'demo_confirm_echo',
    { text: 'x' },
    { sessionKey: 's1' },
  );
  assert.equal(request.ok, true);
  assert.equal(
    bridge.decideConfirmation(request.actionId, 'deny', { sessionKey: 's1' }).status,
    'denied',
  );
  assertFailure(
    await bridge.execute(
      'demo_confirm_echo',
      { text: 'x' },
      { sessionKey: 's1', actionId: request.actionId },
    ),
    'confirmation-denied',
  );
  assertFailure(
    await bridge.execute(
      'demo_confirm_echo',
      { text: 'x' },
      { sessionKey: 's1', actionId: request.actionId },
    ),
    'confirmation-denied',
  );
  assertFailure(
    bridge.decideConfirmation(request.actionId, 'approve', { sessionKey: 's1' }),
    'confirmation-already-decided',
  );
  assert.equal(calls, 0);
});

test('超时只报失败、不自动重试；确认凭据不会被超时重置', async () => {
  let calls = 0;
  const bridge = bridgeWith([
    definition({
      name: 'demo_slow_read',
      timeoutMs: 10,
      handler: () => {
        calls += 1;
        return new Promise((resolve) => setTimeout(() => resolve({ late: true }), 30));
      },
    }),
  ]);

  const result = await bridge.execute('demo_slow_read', { text: 'x' }, {});
  assertFailure(result, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 1, '桥接不能自动重试');
  assert.equal(bridge.audit().at(-1).code, 'timeout');

  let confirmCalls = 0;
  const confirmBridge = bridgeWith([
    definition({
      name: 'demo_confirm_slow',
      risk: 'confirm',
      timeoutMs: 10,
      handler: () => { confirmCalls += 1; return new Promise(() => {}); },
    }),
    definition({ name: 'demo_filler', permissions: [] }),
    definition({ name: 'demo_filler_two', permissions: [] }),
    definition({ name: 'demo_filler_three', permissions: [] }),
    definition({ name: 'demo_filler_four', permissions: [] }),
    definition({ name: 'demo_filler_five', permissions: [] }),
    definition({ name: 'demo_filler_six', permissions: [] }),
  ], { createActionId: sequenceIds('slow') });

  const request = confirmBridge.requestConfirmation(
    'demo_confirm_slow',
    { text: 'x' },
    { sessionKey: 's1' },
  );
  assert.equal(request.ok, true);
  assert.equal(
    confirmBridge.decideConfirmation(request.actionId, 'approve', { sessionKey: 's1' }).status,
    'approved',
  );
  assertFailure(
    await confirmBridge.execute(
      'demo_confirm_slow',
      { text: 'x' },
      { sessionKey: 's1', actionId: request.actionId },
    ),
    'timeout',
  );
  assert.equal(confirmCalls, 1);
  // registry 在进入 handler 前就消耗了批准；同一凭据重试必须重新请求。
  assertFailure(
    await confirmBridge.execute(
      'demo_confirm_slow',
      { text: 'x' },
      { sessionKey: 's1', actionId: request.actionId },
    ),
    'confirmation-used',
  );
  assert.equal(confirmCalls, 1);
});

test('结果不虚报：超时、抛错、权限、确认失败都只输出“未完成”', async () => {
  const throwing = bridgeWith([
    definition({
      name: 'demo_throws',
      permissions: [],
      handler: () => { throw new Error('SECRET-ERROR'); },
    }),
  ], { permissions: [] });

  const thrown = await throwing.execute('demo_throws', { text: 'x' }, {});
  assertFailure(thrown, 'handler-failed');
  const thrownText = formatToolHostOutcome(thrown);
  assert.equal(thrownText.ok, false);
  assert.match(thrownText.text, /未完成/u);
  assert.doesNotMatch(thrownText.text, /已完成|SECRET/u);

  const timeout = formatToolHostOutcome({ ok: false, code: 'timeout', tool: 'demo_slow' });
  assert.equal(timeout.ok, false);
  assert.match(timeout.text, /timeout/u);

  const required = formatToolHostOutcome({
    ok: false,
    code: 'confirmation-required',
    tool: 'demo_confirm_note',
  });
  assert.equal(required.ok, false);

  // 伪造/畸形结果：即使自称 ok，只要 code/tool 不闭合，也不能被播报为成功。
  for (const forged of [
    { ok: true, code: 'timeout', tool: 'demo_x' },
    { ok: true, code: 'ok' },
    { ok: true, code: 'ok', tool: 'real_tool' },
    { ok: false, code: 'ok', tool: 'demo_x' },
    { ok: false, code: 'SECRET CODE', tool: 'demo_x' },
    { get tool() { throw new Error('SECRET-ERROR'); } },
    null,
    [],
  ]) {
    const outcome = formatToolHostOutcome(forged);
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /未完成/u);
    assert.doesNotMatch(outcome.text, /已完成|SECRET/u);
  }

  const success = formatToolHostOutcome({
    ok: true,
    code: 'ok',
    tool: 'demo_x',
    value: { secret: 'SECRET-VALUE' },
  });
  assert.equal(success.ok, true);
  assert.match(success.text, /已完成/u);
  assert.doesNotMatch(success.text, /SECRET/u);
});

test('审计脱敏：不含参数正文、异常文本、返回值或 actionId', async () => {
  const bridge = bridgeWith([
    definition({
      name: 'demo_secret',
      permissions: [],
      auditFields: ['argsDigest', 'durationMs', 'trigger'],
      handler: () => { throw new Error('SECRET-ERROR'); },
    }),
    createNoteClearTool(createMemoryNoteStore(['x'])),
  ]);

  const result = await bridge.execute('demo_secret', { text: 'SECRET-ARG' }, {});
  assertFailure(result, 'handler-failed');

  const request = bridge.requestConfirmation(
    'demo_note_clear',
    { scope: 'demo' },
    { sessionKey: 's1' },
  );
  assert.equal(request.ok, true);
  bridge.decideConfirmation(request.actionId, 'approve', { sessionKey: 's1' });
  const cleared = await bridge.execute(
    'demo_note_clear',
    { scope: 'demo' },
    { sessionKey: 's1', actionId: request.actionId },
  );
  assert.equal(cleared.ok, true);

  const auditText = JSON.stringify(bridge.audit());
  assert.doesNotMatch(auditText, /SECRET-ARG|SECRET-ERROR|SECRET-VALUE/u);
  assert.doesNotMatch(auditText, new RegExp(request.actionId, 'u'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
  assert.doesNotMatch(JSON.stringify(cleared), /SECRET/u);
});

test('上下文形状 fail closed；继承/访问器/非法 actionId 都不放行', async () => {
  const bridge = bridgeWith([definition({ name: 'demo_context', permissions: [] })]);

  assertFailure(await bridge.execute('demo_context', {}, null), 'invalid-call');
  assertFailure(await bridge.execute('demo_context', {}, []), 'invalid-call');
  assertFailure(await bridge.execute('demo_context', {}, { actionId: 42 }), 'invalid-call');
  assertFailure(await bridge.execute('demo_context', {}, { actionId: '' }), 'invalid-call');
  assertFailure(
    await bridge.execute('demo_context', {}, { actionId: 'a'.repeat(129) }),
    'invalid-call',
  );
  assertFailure(
    await bridge.execute('demo_context', {}, { get actionId() { return 'x'; } }),
    'invalid-call',
  );
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('trap'); },
  });
  assertFailure(await bridge.execute('demo_context', {}, hostile), 'invalid-call');

  // 继承属性不算宿主显式上下文；普通只读工具仍可执行。
  const inherited = Object.create({ actionId: 'inherited' });
  assert.equal((await bridge.execute('demo_context', {}, inherited)).ok, true);

  // invalid-call 结果只在名字是合法假工具名时回显名字。
  const safe = await bridge.execute('demo_context', {}, null);
  assert.equal(safe.tool, 'demo_context');
  const unsafe = await bridge.execute('real_tool', {}, null);
  assert.equal(Object.hasOwn(unsafe, 'tool'), false);
});

test('AgentLoop 宿主接线：失败结果交给宿主时仍是失败，不会被模型侧包装成成功', async () => {
  const bridge = bridgeWith([createNoteReadTool(createMemoryNoteStore(['a']))], {
    permissions: ['note:read'],
  });
  const seen = [];
  const loop = new AgentLoop({
    key: 'private:tool-host',
    onTurn: async (inputs, ctx) => {
      const result = await bridge.model.call('demo_note_read', { limit: 999 });
      const outcome = formatToolHostOutcome(result);
      seen.push({ inputs: inputs.map((item) => item.text), outcome, turn: ctx.turn });
    },
  });

  loop.followup({ text: '读一下便签' });
  await loop.whenIdle();
  await loop.close();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].turn, 1);
  assert.equal(seen[0].outcome.ok, false);
  assert.match(seen[0].outcome.text, /未完成/u);
  assert.doesNotMatch(seen[0].outcome.text, /已完成/u);
});

test('公开出口：lib.js 导出桥接，且桥接结果可由 registry 语义直接消费', () => {
  assert.equal(typeof publicApi.createToolHostBridge, 'function');
  assert.equal(typeof publicApi.formatToolHostOutcome, 'function');
});
