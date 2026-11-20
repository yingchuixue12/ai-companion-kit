/**
 * OneBot 文本发送回执 · issue #20（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证 transport-onebot.js 的文本发送：
 *
 *   OneBot.send(key, text) → api() → HTTP 响应 → receipt 分类
 *
 * 边界：不联网、不连真实 WebSocket、不碰真实 OneBot 实现。
 *   - 动态 import('ws') 用 registerHooks 换成 data URL 内存 WebSocket stub，
 *     因此构造的是真实 OneBot 实例；私有 #headers / #connect 都会正常执行。
 *   - HTTP 用 t.mock.method(globalThis, 'fetch', ...) 提供内存响应或抛错。
 *
 * 覆盖点：
 *   1. 有效字符串 / 数值 message_id → confirmed；
 *   2. 零、纯空白、null、非整数、非安全整数、布尔等无效 ID → unknown；
 *   3. HTTP 失败却带成功信封 → unknown；
 *   4. 明确失败信封（failed + 非零整数 retcode + 无可用 ID）→ rejected；
 *   5. 矛盾失败体（retcode 为 0 / 字符串 / 带可用 ID）→ unknown；
 *   6. 非对象信封、非法 JSON → unknown；
 *   7. fetch 超时 / 断线 → unknown；
 *   8. 同一次发送只调用一次 fetch；
 *   9. 私聊 / 群聊路由与 atUserId 前缀不变，原返回字段保留。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { OneBot } from '../src/transport-onebot.js';

const transportUrl = new URL('../src/transport-onebot.js', import.meta.url);

// data URL 内联 WebSocket stub：构造时记录参数，不建立任何连接。
const wsStubUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`
export class WebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    (globalThis.__onebotStubSockets ||= []).push(this);
  }
  on() {}
}
`);

// 只替换 transport-onebot.js 发出的 import('ws')，其余模块解析保持原样。
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'ws' && context.parentURL?.includes('/transport-onebot.js')) {
      return { url: wsStubUrl, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

after(() => hooks.deregister());

const WS_URL = 'ws://stub.invalid';
const HTTP_URL = 'http://onebot.invalid';
const TOKEN = 'test-token';

/** 构造真实 OneBot；等 #connect 的动态 import 落地，便于断言 WebSocket stub。 */
async function makeBot() {
  globalThis.__onebotStubSockets = [];
  const bot = new OneBot({ wsUrl: WS_URL, httpUrl: HTTP_URL, accessToken: TOKEN });
  await new Promise((resolve) => setImmediate(resolve));
  return bot;
}

function jsonReply(body, status = 200) {
  return () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textReply(text, status = 200) {
  return () => new Response(text, { status });
}

function rejectReply(error) {
  return () => { throw error; };
}

const okEnvelope = (messageId) => ({ status: 'ok', retcode: 0, data: { message_id: messageId } });

/** 回执只能有 status，确认时才多一个 messageId。 */
function assertReceipt(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assert.deepEqual(
    Object.keys(actual),
    expected.messageId === undefined ? ['status'] : ['status', 'messageId'],
    label + '：回执字段',
  );
}

// 表驱动：每个用例一个 HTTP 响应，统一发私聊文本。
const cases = [
  {
    name: '字符串 message_id 确认送达',
    reply: jsonReply(okEnvelope('123')),
    expected: { status: 'confirmed', messageId: '123' },
    ok: true,
  },
  {
    name: '非零安全整数 message_id 确认送达并转字符串',
    reply: jsonReply(okEnvelope(456)),
    expected: { status: 'confirmed', messageId: '456' },
    ok: true,
  },
  {
    name: '字符串 ID 两侧空白被规范化',
    reply: jsonReply(okEnvelope('  msg-9  ')),
    expected: { status: 'confirmed', messageId: 'msg-9' },
    ok: true,
  },
  {
    name: '数值零无效',
    reply: jsonReply(okEnvelope(0)),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '字符串零无效',
    reply: jsonReply(okEnvelope('0')),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '空字符串无效',
    reply: jsonReply(okEnvelope('')),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '纯空白字符串无效',
    reply: jsonReply(okEnvelope('   ')),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: 'null ID 无效',
    reply: jsonReply(okEnvelope(null)),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '小数 ID 无效',
    reply: jsonReply(okEnvelope(1.5)),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '超出安全整数范围的 ID 无效',
    reply: jsonReply(okEnvelope(Number.MAX_SAFE_INTEGER + 1)),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '布尔 ID 无效',
    reply: jsonReply(okEnvelope(true)),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '成功信封但缺少 message_id → unknown',
    reply: jsonReply({ status: 'ok', retcode: 0, data: {} }),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: 'HTTP 失败却带成功信封 → unknown',
    reply: jsonReply(okEnvelope('999'), 500),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: '明确失败信封 → rejected',
    reply: jsonReply({ status: 'failed', retcode: 100 }),
    expected: { status: 'rejected' },
    ok: false,
  },
  {
    name: '明确失败信封（空 data）→ rejected',
    reply: jsonReply({ status: 'failed', retcode: 100, data: {} }),
    expected: { status: 'rejected' },
    ok: false,
  },
  {
    name: '失败信封 retcode 为 0 → unknown',
    reply: jsonReply({ status: 'failed', retcode: 0 }),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: '失败信封 retcode 为字符串 → unknown',
    reply: jsonReply({ status: 'failed', retcode: '100' }),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: '失败信封但同时带可用 ID → unknown',
    reply: jsonReply({ status: 'failed', retcode: 100, data: { message_id: '9' } }),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: 'ok 信封但 retcode 非 0 → unknown',
    reply: jsonReply({ status: 'ok', retcode: 1, data: { message_id: '9' } }),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: 'ok 信封但 retcode 为字符串 → unknown',
    reply: jsonReply({ status: 'ok', retcode: '0', data: { message_id: '9' } }),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '数组信封 → unknown',
    reply: jsonReply([]),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '字符串信封 → unknown',
    reply: jsonReply('not-an-envelope'),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: 'null 信封 → unknown',
    reply: jsonReply(null),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: '非法 JSON → unknown',
    reply: textReply('{"status":'),
    expected: { status: 'unknown' },
    ok: true,
  },
  {
    name: '超时（fetch reject）→ unknown',
    reply: rejectReply(new DOMException('timed out', 'TimeoutError')),
    expected: { status: 'unknown' },
    ok: false,
  },
  {
    name: '断线（fetch reject）→ unknown',
    reply: rejectReply(new Error('socket hang up')),
    expected: { status: 'unknown' },
    ok: false,
  },
];

test('send() 文本回执分类矩阵', async (t) => {
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const bot = await makeBot();
      const calls = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url: String(url), init });
        return item.reply();
      });

      const result = await bot.send('private:42', 'hello');

      assert.equal(calls.length, 1, '同一次发送只调用一次 fetch');
      assert.equal(calls[0].url, HTTP_URL + '/send_private_msg');
      assertReceipt(result.receipt, item.expected, item.name);
      assert.equal(result.ok, item.ok, item.name + '：原 ok 字段保留');
      assert.ok('data' in result || 'error' in result, item.name + '：原返回字段保留');
    });
  }
});

test('send() 路由、atUserId 与真实构造边界', async (t) => {
  const bot = await makeBot();
  const socket = globalThis.__onebotStubSockets.at(-1);
  assert.ok(socket, '真实 OneBot 构造应触发 WebSocket stub');
  assert.equal(socket.url, WS_URL);
  assert.equal(socket.opts.headers.authorization, 'Bearer ' + TOKEN, '私有 #headers 正常执行');

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonReply(okEnvelope('m-1'))();
  });

  const privateResult = await bot.send('private:42', 'hi');
  assert.equal(calls.length, 1, '私聊发送只调用一次 fetch');
  assert.equal(calls[0].url, HTTP_URL + '/send_private_msg');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(calls[0].init.body), { user_id: '42', message: 'hi' });
  assert.equal(privateResult.ok, true);
  assert.equal(privateResult.data.status, 'ok');
  assert.equal(privateResult.error, undefined);
  assertReceipt(privateResult.receipt, { status: 'confirmed', messageId: 'm-1' }, '私聊回执');

  const groupResult = await bot.send('group:7', 'yo', { atUserId: '9' });
  assert.equal(calls.length, 2, '群聊发送只新增一次 fetch');
  assert.equal(calls[1].url, HTTP_URL + '/send_group_msg');
  assert.deepEqual(
    JSON.parse(calls[1].init.body),
    { group_id: '7', message: '[CQ:at,qq=9] yo' },
  );
  assertReceipt(groupResult.receipt, { status: 'confirmed', messageId: 'm-1' }, '群聊回执');
});