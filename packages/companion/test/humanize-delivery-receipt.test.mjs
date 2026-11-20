/**
 * 拟人化发送回执 · issue #22（SOP 06 测试节点）
 * ─────────────────────────────────────────────────────────────
 * 只验证 Humanizer.say 对 send 结果的消费：
 *
 *   send() → result.receipt.status / legacy 形状 → 计数或立即抛错
 *
 * 边界：不联网、不碰真实 OneBot、不写任何外部状态。
 * 用真实 Humanizer + 内存回调；启用拟人时注入无等待 sleep，
 * 用事件顺序确认失败后没有再安排条间停顿。
 *
 * 覆盖点：
 *   1. 启用/禁用两条路径的成功形状 {sent, parts}；
 *   2. 有回执 confirmed 与 legacy undefined / {ok:true} 都算成功；
 *   3. 第二段 rejected / unknown 后不发送第三段，sent 只算之前成功的段；
 *   4. ok:false、非法回执状态、send 抛异常 → unknown；
 *   5. 异常脱敏：固定 code/status/sent，不带 cause、正文或未发送段；
 *   6. 启用时失败后不再安排下一间隔。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Humanizer } from '../src/humanize.js';

const GAP_MS = 424242;

const confirmed = () => ({ receipt: { status: 'confirmed' } });
const rejected = () => ({ receipt: { status: 'rejected' } });
const unknown = () => ({ receipt: { status: 'unknown' } });
const legacyOk = () => ({ ok: true });
const legacyNone = () => undefined;

/**
 * 确定性 Humanizer：打字等待固定 1000ms（深夜会 ×1.6，不影响次数），
 * 条间停顿固定 GAP_MS，便于在事件序列里识别。
 */
function makeHumanizer(enabled) {
  return new Humanizer({
    enabled,
    minMs: 1000,
    maxMs: 1000,
    msPerChar: 0,
    jitter: 0,
    gapRange: [GAP_MS, GAP_MS],
    longGapChance: 0,
  });
}

/**
 * 用内存回调跑一次 say，记录 send / sleep / setTyping 的调用顺序。
 * responses 里每项都是返回结果的函数；函数抛错即模拟 send 异常。
 */
async function runSay({ enabled, parts, responses }) {
  const human = makeHumanizer(enabled);
  const calls = { send: [], sleep: [], typing: [], events: [] };
  let index = 0;

  const send = async (part) => {
    calls.send.push(part);
    calls.events.push('send:' + part);
    const respond = responses[index];
    index += 1;
    assert.ok(respond, '不应发送第 ' + index + ' 段');
    return respond();
  };

  const sleep = async (ms) => {
    calls.sleep.push(ms);
    calls.events.push('sleep:' + ms);
  };

  const setTyping = async (on) => {
    calls.typing.push(on);
    calls.events.push('typing:' + on);
  };

  let result;
  let error;
  try {
    result = await human.say(parts, { send, sleep, setTyping });
  } catch (caught) {
    error = caught;
  }
  return { result, error, ...calls };
}

/** 固定错误形状：code/status/sent，且不夹带原始异常、正文或未发送段。 */
function assertDeliveryError(error, { status, sent }) {
  assert.ok(error, '应当抛出 delivery-unconfirmed');
  assert.equal(error.code, 'delivery-unconfirmed');
  assert.equal(error.status, status);
  assert.equal(error.sent, sent);
  assert.deepEqual(Object.keys(error).sort(), ['code', 'sent', 'status']);
  assert.equal('cause' in error, false);
  assert.equal('parts' in error, false);
  assert.equal('text' in error, false);
}

const successCases = [
  { name: 'confirmed 回执', responses: [confirmed, confirmed] },
  { name: 'legacy undefined', responses: [legacyNone, legacyNone] },
  { name: 'legacy {ok:true}', responses: [legacyOk, legacyOk] },
  { name: 'confirmed + legacy 混合', responses: [confirmed, legacyOk] },
];

test('say 成功形状：启用/禁用都返回 {sent, parts}', async (t) => {
  for (const enabled of [false, true]) {
    for (const item of successCases) {
      await t.test(`${enabled ? '启用' : '禁用'} · ${item.name}`, async () => {
        const parts = ['甲', '乙'];
        const r = await runSay({ enabled, parts, responses: item.responses });

        assert.equal(r.error, undefined);
        assert.deepEqual(r.result, { sent: 2, parts });
        assert.deepEqual(r.send, parts);

        if (enabled) {
          assert.deepEqual(r.typing, [true, false, true, false]);
          assert.equal(r.sleep.length, 3, '两次打字等待 + 一次条间停顿');
          assert.equal(r.sleep.filter((ms) => ms === GAP_MS).length, 1);
        } else {
          assert.deepEqual(r.typing, []);
          assert.deepEqual(r.sleep, []);
        }
      });
    }
  }
});

test('字符串输入仍按 split 分段并返回同样的 parts', async () => {
  const text = '第一段的内容\n第二段的内容';
  const r = await runSay({ enabled: false, parts: text, responses: [confirmed, confirmed] });

  assert.equal(r.error, undefined);
  assert.deepEqual(r.result, { sent: 2, parts: ['第一段的内容', '第二段的内容'] });
  assert.deepEqual(r.send, ['第一段的内容', '第二段的内容']);
});

test('空输入返回零发送，不调用 send / sleep / setTyping', async () => {
  const r = await runSay({ enabled: true, parts: [], responses: [] });

  assert.equal(r.error, undefined);
  assert.deepEqual(r.result, { sent: 0, parts: [] });
  assert.deepEqual(r.send, []);
  assert.deepEqual(r.sleep, []);
  assert.deepEqual(r.typing, []);
});

const failureCases = [
  { name: 'rejected 回执', response: rejected, status: 'rejected' },
  { name: 'unknown 回执', response: unknown, status: 'unknown' },
  { name: '非法回执状态', response: () => ({ receipt: { status: 'delivered' } }), status: 'unknown' },
  { name: '回执不是对象', response: () => ({ receipt: 'confirmed' }), status: 'unknown' },
  { name: '无回执但 ok:false', response: () => ({ ok: false }), status: 'unknown' },
];

test('第二段失败：不发送第三段，sent 只算之前成功的段', async (t) => {
  for (const enabled of [false, true]) {
    for (const item of failureCases) {
      await t.test(`${enabled ? '启用' : '禁用'} · ${item.name}`, async () => {
        const parts = ['一', '二', '三'];
        const r = await runSay({
          enabled,
          parts,
          responses: [confirmed, item.response, confirmed],
        });

        assert.equal(r.result, undefined);
        assertDeliveryError(r.error, { status: item.status, sent: 1 });
        assert.deepEqual(r.send, ['一', '二'], '第三段不得发送');

        if (enabled) {
          assert.deepEqual(r.typing, [true, false, true, false]);
          assert.equal(r.sleep.filter((ms) => ms === GAP_MS).length, 1, '第一段后只安排一次条间停顿');
          const failedAt = r.events.lastIndexOf('send:二');
          assert.ok(failedAt >= 0);
          assert.equal(
            r.events.slice(failedAt + 1).some((event) => event.startsWith('sleep:')),
            false,
            '失败后不得再安排下一间隔',
          );
        } else {
          assert.deepEqual(r.typing, []);
          assert.deepEqual(r.sleep, []);
        }
      });
    }
  }
});

test('send 抛异常：unknown，错误脱敏且不自动重试', async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? '启用' : '禁用', async () => {
      const secret = 'SECRET-BODY-不应泄漏';
      const original = new Error('上游异常：' + secret);
      original.cause = new Error('root cause：' + secret);
      const parts = ['第一段正文', '第二段正文', '第三段未发送'];

      const r = await runSay({
        enabled,
        parts,
        responses: [confirmed, () => { throw original; }, confirmed],
      });

      assert.equal(r.result, undefined);
      assertDeliveryError(r.error, { status: 'unknown', sent: 1 });
      assert.notEqual(r.error, original);
      assert.equal(r.error.cause, undefined);
      assert.equal(r.error.message.includes(secret), false);
      assert.equal(String(r.error.stack).includes(secret), false);
      assert.equal(JSON.stringify(r.error).includes(secret), false);
      assert.deepEqual(r.send, ['第一段正文', '第二段正文']);

      if (enabled) {
        const failedAt = r.events.lastIndexOf('send:第二段正文');
        assert.equal(
          r.events.slice(failedAt + 1).some((event) => event.startsWith('sleep:')),
          false,
        );
        assert.equal(r.sleep.filter((ms) => ms === GAP_MS).length, 1);
      } else {
        assert.deepEqual(r.sleep, []);
      }
    });
  }
});

test('第一段即失败：sent=0，后续段不发送', async () => {
  const r = await runSay({
    enabled: false,
    parts: ['一', '二'],
    responses: [() => ({ ok: false }), confirmed],
  });

  assertDeliveryError(r.error, { status: 'unknown', sent: 0 });
  assert.deepEqual(r.send, ['一']);
});

test('既有 split / gap 分支保持原行为（长句切分、超量合并、长停顿）', () => {
  const h = new Humanizer({
    burstMax: 2,
    gapRange: [100, 100],
    longGapChance: 1,
    longGapRange: [200, 200],
  });

  const longParts = h.split('很长'.repeat(30) + '。' + '短句');
  assert.equal(longParts.length, 2);
  assert.equal(longParts[0].length, 61);
  assert.equal(longParts[1], '短句');

  const overflow = h.split('第一段的内容\n第二段的内容\n第三段的内容', 2);
  assert.deepEqual(overflow, ['第一段的内容', '第二段的内容 第三段的内容']);

  assert.equal(h.gapMs(), 300);
});
