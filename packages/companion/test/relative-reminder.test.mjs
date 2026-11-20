import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RELATIVE_REMINDER_DELAY_MS,
  MAX_RELATIVE_REMINDER_TEXT_LENGTH,
  parseRelativeReminder,
} from '../src/relative-reminder.js';

/** 只断言“可解析”这一半，正文统一为 “提醒内容”。 */
function delayOf(raw) {
  return parseRelativeReminder(raw)?.delayMs ?? null;
}

test('八种单位都按毫秒换算', () => {
  assert.deepEqual(parseRelativeReminder('250毫秒后提醒我喝水'), { delayMs: 250, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('250ms后提醒我喝水'), { delayMs: 250, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('2s后提醒我喝水'), { delayMs: 2000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('2秒后提醒我喝水'), { delayMs: 2000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('3分钟后提醒我喝水'), { delayMs: 180000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('3分后提醒我喝水'), { delayMs: 180000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('4小时后提醒我喝水'), { delayMs: 14400000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('4时后提醒我喝水'), { delayMs: 14400000, text: '喝水' });
});

test('ASCII 单位不区分大小写', () => {
  // 大小写只影响写法，不改变单位：MS 仍是毫秒，S 仍是秒。
  assert.equal(delayOf('2MS后提醒我喝水'), 2);
  assert.equal(delayOf('2Ms后提醒我喝水'), 2);
  assert.equal(delayOf('2S后提醒我喝水'), 2000);
});

test('允许空格，并去掉正文头尾空白', () => {
  assert.deepEqual(parseRelativeReminder('  30 分钟 后 提醒我   收衣服  '), {
    delayMs: 1800000,
    text: '收衣服',
  });
  assert.deepEqual(parseRelativeReminder('1.5 s后提醒我 Check the oven'), {
    delayMs: 1500,
    text: 'Check the oven',
  });
});

test('尾部句末标点被剥离，正文内部标点保留', () => {
  assert.deepEqual(parseRelativeReminder('5秒后提醒我喝水。'), { delayMs: 5000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('5秒后提醒我喝水！！！'), { delayMs: 5000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('5秒后提醒我喝水?!'), { delayMs: 5000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('5秒后提醒我喝水… '), { delayMs: 5000, text: '喝水' });
  assert.deepEqual(parseRelativeReminder('5秒后提醒我带伞，好吗？'), {
    delayMs: 5000,
    text: '带伞，好吗',
  });
});

test('小数按毫秒四舍五入', () => {
  assert.equal(delayOf('1.5秒后提醒我喝水'), 1500);
  assert.equal(delayOf('0.0005秒后提醒我喝水'), 1); // 0.5ms → 1ms
  assert.equal(delayOf('2.5毫秒后提醒我喝水'), 3);
  assert.equal(parseRelativeReminder('0.0004秒后提醒我喝水'), null); // 0.4ms → 0ms，越下界
});

test('1ms 与 7d 边界', () => {
  assert.deepEqual(parseRelativeReminder('1毫秒后提醒我喝水'), { delayMs: 1, text: '喝水' });
  assert.equal(delayOf('0.5毫秒后提醒我喝水'), 1);
  assert.equal(delayOf('604800秒后提醒我喝水'), MAX_RELATIVE_REMINDER_DELAY_MS);
  assert.equal(delayOf('168小时后提醒我喝水'), MAX_RELATIVE_REMINDER_DELAY_MS);
  assert.equal(delayOf('604800.1秒后提醒我喝水'), null); // 上界外 100ms
  assert.equal(delayOf('169小时后提醒我喝水'), null);
  assert.equal(delayOf('0毫秒后提醒我喝水'), null);
  assert.equal(delayOf('0秒后提醒我喝水'), null);
});

test('正文长度按 UTF-16 计，500 收 501 拒', () => {
  assert.equal(MAX_RELATIVE_REMINDER_TEXT_LENGTH, 500);
  const atLimit = '长'.repeat(500);
  assert.deepEqual(parseRelativeReminder(`5秒后提醒我${atLimit}`), { delayMs: 5000, text: atLimit });
  assert.equal(parseRelativeReminder(`5秒后提醒我${'长'.repeat(501)}`), null);

  // 单个 emoji 是 2 个 UTF-16 码元：250 个正好 500，251 个超限。
  const emojiAtLimit = '😀'.repeat(250);
  assert.equal(emojiAtLimit.length, 500);
  assert.deepEqual(parseRelativeReminder(`5秒后提醒我${emojiAtLimit}`), {
    delayMs: 5000,
    text: emojiAtLimit,
  });
  assert.equal(parseRelativeReminder(`5秒后提醒我${'😀'.repeat(251)}`), null);
});

test('拒绝多行输入', () => {
  assert.equal(parseRelativeReminder('5秒后提醒我第一行\n第二行'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我第一行\r\n第二行'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我第一行\u2028第二行'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我第一行\u2029第二行'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我喝水\n'), null);
});

test('拒绝普通叙述与猜测式表达', () => {
  assert.equal(parseRelativeReminder('我30秒后去洗衣服'), null);
  assert.equal(parseRelativeReminder('提醒我5秒后喝水'), null);
  assert.equal(parseRelativeReminder('半小时后提醒我喝水'), null);
  assert.equal(parseRelativeReminder('一分钟后提醒我喝水'), null);
  assert.equal(parseRelativeReminder('一会儿提醒我喝水'), null);
  assert.equal(parseRelativeReminder('5秒后我要喝水'), null);
});

test('拒绝缺金额或缺正文的请求', () => {
  assert.equal(parseRelativeReminder('秒后提醒我喝水'), null);
  assert.equal(parseRelativeReminder('毫秒后提醒我喝水'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我   '), null);
  assert.equal(parseRelativeReminder('5秒后提醒我。'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我！！！'), null);
  assert.equal(parseRelativeReminder('5秒后提醒我…'), null);
  assert.equal(parseRelativeReminder(''), null);
});

test('非字符串输入直接拒绝', () => {
  for (const value of [null, undefined, 5, NaN, {}, ['5秒后提醒我喝水'], new String('5秒后提醒我喝水')]) {
    assert.equal(parseRelativeReminder(value), null);
  }
});

test('巨大数值导致 Number 非有限时拒绝', () => {
  // 位数极多的十进制数字：正则通过，但 Number(...) 已经是 Infinity。
  const raw = `${'9'.repeat(400)}毫秒后提醒我喝水`;
  assert.equal(Number(raw.match(/^\d+/)[0]), Infinity);
  assert.equal(parseRelativeReminder(raw), null);
});

test('有限金额乘单位后溢出为 Infinity 时拒绝', () => {
  // 金额本身有限（1e307），乘上「小时」的 3.6e6 后溢出。
  const amount = `1${'0'.repeat(307)}`;
  assert.equal(Number.isFinite(Number(amount)), true);
  assert.equal(Number(amount) * 3600000, Infinity);
  assert.equal(parseRelativeReminder(`${amount}小时后提醒我喝水`), null);
});
