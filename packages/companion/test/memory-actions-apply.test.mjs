/**
 * B-15a · Memory.forget / Memory.replace 的离线行为（本 Run 唯一允许的测试文件）
 * ─────────────────────────────────────────────────────────────
 * 只导入 `../src/memory.js`：这两个方法是这一轮唯一的产品改动，纠正动作的
 * 解析与「送达后才落地」属于另一次 B-15b 的变更，不在这里覆盖。
 *
 * 覆盖点：
 *   1. forget：空白折叠后精确命中，只删这一条，别的类目不动；
 *   2. forget：另一个人的同名条目不受影响；
 *   3. forget：目标不存在时幂等，不写盘、不涨互动计数、不建人；
 *   4. forget：未知类目与空目标直接抛 TypeError，且不写盘；
 *   5. replace：原地更正，保持条目顺序；
 *   6. replace：目标已存在时不产生重复条目；
 *   7. replace：没有匹配时内容逐字节不变、返回 0（from === to 同样无变化）；
 *   8. replace：空的 from / to 抛 TypeError；
 *   9. 重启：新建 Memory 指向同一目录，删除与更正都还在；
 *  10. 共享对话流不参与纠正（只动个人账本的对应数组）。
 *
 * 离线：不联网、不调模型、不读写真实 data/；每个用例自带临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Memory } from '../src/memory.js';

const USER_A = 'u-a';
const USER_B = 'u-b';
const OLD = 'addr-old';
const NEW = 'addr-new';

/** 每个用例一个临时账本目录；结束时删掉。 */
function tmpMemory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b15a-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new Memory({ dir }) };
}

/** people.json 的字节摘要：用来证明「没有匹配就没有写盘」。 */
function ledgerDigest(dir) {
  const file = path.join(dir, 'people.json');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file).toString('base64');
}

test('forget：空白折叠后精确命中，只删这一条，别的类目不动', (t) => {
  const { memory } = tmpMemory(t);
  memory.remember(USER_A, { trait: 'night-owl', fact: OLD, topic: 'chat-1' });

  assert.equal(memory.forget(USER_A, { kind: 'fact', text: '  ' + OLD + '  ' }), 1, '多余空白应被归一化后命中');

  const person = memory.person(USER_A);
  assert.deepEqual(person.facts, [], '目标条目被删除');
  assert.deepEqual(person.traits, ['night-owl'], '别的类目不受影响');
  assert.deepEqual(person.topics, ['chat-1'], '别的类目不受影响');
});

test('forget：另一个人的同名条目不受影响', (t) => {
  const { memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  memory.remember(USER_B, { fact: OLD });

  assert.equal(memory.forget(USER_A, { kind: 'fact', text: OLD }), 1);

  assert.deepEqual(memory.person(USER_A).facts, []);
  assert.deepEqual(memory.person(USER_B).facts, [OLD], '只改这一本账');
});

test('forget：目标不存在时幂等，不写盘、不涨计数、不建人', (t) => {
  const { dir, memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  const before = ledgerDigest(dir);
  const { interactions } = memory.person(USER_A);

  assert.equal(memory.forget(USER_A, { kind: 'fact', text: 'never-stored' }), 0, '重复/落空删除返回 0');
  assert.equal(ledgerDigest(dir), before, '没有匹配就不得写盘');
  assert.equal(memory.person(USER_A).interactions, interactions, '删除不是一次互动');

  assert.equal(memory.forget('u-new', { kind: 'fact', text: OLD }), 0, '没记过的人返回 0');
  assert.equal(memory.person('u-new').interactions, 0, '不得顺手建人');
});

test('forget：未知类目与空目标直接抛 TypeError，且不写盘', (t) => {
  const { dir, memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  const before = ledgerDigest(dir);

  assert.throws(() => memory.forget(USER_A, { kind: 'mood', text: OLD }), TypeError, '未知类目必须拒绝');
  assert.throws(() => memory.forget(USER_A, { kind: 'fact', text: '   ' }), TypeError, '空目标必须拒绝');
  assert.throws(() => memory.forget(USER_A, { kind: 'fact', text: '' }), TypeError, '空字符串必须拒绝');
  assert.throws(() => memory.forget(USER_A, {}), TypeError, '缺参数必须拒绝');

  assert.equal(ledgerDigest(dir), before, '被拒绝的调用不得写盘');
  assert.deepEqual(memory.person(USER_A).facts, [OLD]);
});

test('replace：原地更正，保持条目顺序', (t) => {
  const { memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: 'first' });
  memory.remember(USER_A, { fact: OLD });
  memory.remember(USER_A, { fact: 'third' });

  assert.equal(memory.replace(USER_A, { kind: 'fact', from: OLD, to: NEW }), 1);
  assert.deepEqual(memory.person(USER_A).facts, ['first', NEW, 'third'], '位置不变、内容更正');
});

test('replace：目标已存在时不产生重复条目', (t) => {
  const { memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: NEW });
  memory.remember(USER_A, { fact: OLD });

  assert.equal(memory.replace(USER_A, { kind: 'fact', from: OLD, to: NEW }), 1);
  assert.deepEqual(memory.person(USER_A).facts, [NEW], '同一个类目里不允许出现两条一样的记忆');
});

test('replace：没有匹配时内容不变并返回 0', (t) => {
  const { dir, memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  const before = ledgerDigest(dir);
  const { interactions } = memory.person(USER_A);

  assert.equal(memory.replace(USER_A, { kind: 'fact', from: 'never-stored', to: NEW }), 0);
  assert.equal(memory.replace(USER_A, { kind: 'fact', from: OLD, to: OLD }), 0, 'from 与 to 相同不算改动');
  assert.equal(ledgerDigest(dir), before, '没有匹配就不得写盘');
  assert.equal(memory.person(USER_A).interactions, interactions);
  assert.deepEqual(memory.person(USER_A).facts, [OLD]);
});

test('replace：空的 from / to 与未知类目抛 TypeError', (t) => {
  const { dir, memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  const before = ledgerDigest(dir);

  assert.throws(() => memory.replace(USER_A, { kind: 'fact', from: '   ', to: NEW }), TypeError);
  assert.throws(() => memory.replace(USER_A, { kind: 'fact', from: OLD, to: '   ' }), TypeError);
  assert.throws(() => memory.replace(USER_A, { kind: 'mood', from: OLD, to: NEW }), TypeError);

  assert.equal(ledgerDigest(dir), before, '被拒绝的调用不得写盘');
});

test('重启：新建 Memory 指向同一目录，删除与更正都还在', (t) => {
  const { dir, memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  memory.remember(USER_B, { fact: OLD });

  assert.equal(memory.forget(USER_A, { kind: 'fact', text: OLD }), 1);
  assert.equal(memory.replace(USER_B, { kind: 'fact', from: OLD, to: NEW }), 1);

  const reopened = new Memory({ dir });
  assert.deepEqual(reopened.person(USER_A).facts, [], '重启后删除仍然有效');
  assert.deepEqual(reopened.person(USER_B).facts, [NEW], '重启后更正仍然有效');
});

test('共享对话流不参与纠正', (t) => {
  const { memory } = tmpMemory(t);
  memory.remember(USER_A, { fact: OLD });
  memory.logTurn({ where: 'private:' + USER_A, who: '阿明', text: '在吗', reply: '在的' });

  assert.equal(memory.forget(USER_A, { kind: 'fact', text: OLD }), 1);

  const rows = memory.recentTurns(10);
  assert.equal(rows.length, 1, '纠正只动个人账本，不删对话流');
  assert.equal(rows[0].text, '在吗');
});
