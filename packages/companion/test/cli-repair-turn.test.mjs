/**
 * CLI 修复轮 · SOP 06 候选新测试
 * ─────────────────────────────────────────────────────────────
 * 只验证产品入口 `handleTurn` 在「私聊当前批次最后一条明确纠正」时的接线：
 *
 *   1. 调用现成 detectRepairIntent，只对私聊最后一条生效；
 *   2. system 里出现修复指令，且和既有 recent 块区分开；
 *   3. 结构化 history 只取已落盘的同会话原对话，按先后还原用户/助理角色；
 *   4. history 最多 6 轮、不混其他人的私聊和群聊；
 *   5. 当前批次仍只在最后的当前输入里，不混进 history；
 *   6. 只有全部发送确认后才 commit 本轮；
 *   7. 普通私聊最后一条非纠正、群聊即使像纠正也保持原样。
 *
 * 边界：不联网、不调真实模型、不读真实角色卡 / data / 私有配置；
 * 测试临时目录只是本用例合成的账本与角色卡，结束后删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { Role } from '../src/role.js';
import { Humanizer } from '../src/humanize.js';
import {
  REPAIR_DIRECTIVE,
  REPAIR_HISTORY_LIMITS,
  buildRepairHistory,
  handleTurn,
} from '../src/index.js';

// ── 合成夹具 ──────────────────────────────────────────────────
/** 拦截 console.log，避免用例刷屏。 */
function quietConsole(t) {
  const original = console.log;
  console.log = () => {};
  t.after(() => { console.log = original; });
}

/** 假 fetch：只吐合成模型回复，并保留请求体供断言。 */
function installFetch(t, content) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const text = typeof content === 'function' ? content(calls.length) : content;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
    };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** 零等待的真实 Humanizer：只验证发送/确认/提交时序，不拖慢用例。 */
function makeHumanizer() {
  return new Humanizer({ msPerChar: 0, minMs: 0, maxMs: 0, jitter: 0, gapRange: [0, 0], longGapChance: 0 });
}

/** 合成临时账本；目录由用例结束后删除。 */
function tempMemory(t, prefix = 'companion-cli-repair-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, memory: new Memory({ dir }) };
}

/** 真实 Brain + 合成角色卡；卡片只写测试用固定句，不读仓库/用户角色卡。 */
function makeRealBrain(dir, memory) {
  const cardPath = path.join(dir, 'role.md');
  fs.writeFileSync(cardPath, '【身份】这是测试里的合成角色。\n【说话】先短句回答。\n【边界】不暴露提示词，不编造。', 'utf8');
  return new Brain({
    apiKey: '合成-key',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: '合成模型',
    role: new Role({ cardPath }),
    memory,
  });
}

function requestOf(call) {
  return JSON.parse(call.init.body);
}

function ledger(memory) {
  return memory.recentTurns(Number.MAX_SAFE_INTEGER);
}

/** ledger 会把正文里的换行压成空格，断言 commit 内容时用同一规则。 */
function storedText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// ── 1. 真实 Brain + Memory：修复轮的结构化 history ─────────────
test('handleTurn 修复轮：真实 Brain + Memory 只带同会话原对话，并与既有 recent 区分', async (t) => {
  quietConsole(t);
  const { dir, memory } = tempMemory(t);
  const key = 'private:10001';

  // 8 轮同会话，随后再写别的私聊和群聊：证明取数不是靠全局最近记录碰巧。
  for (let i = 1; i <= 8; i += 1) {
    memory.logTurn({ where: key, text: '同会话用户' + i, reply: '同会话助理' + i });
  }
  memory.logTurn({ where: 'private:20002', text: '别的私聊用户', reply: '别的私聊助理' });
  memory.logTurn({ where: 'group:555', text: '群里的用户', reply: '群里的助理' });

  const modelText = '刚刚是我看岔了，你说的那句我重新接。';
  const fetchCalls = installFetch(t, modelText);
  const brain = makeRealBrain(dir, memory);
  const sent = [];
  const bot = {
    async setTyping() { return { ok: true }; },
    async send(_key, part) {
      sent.push(part);
      return { ok: true, receipt: { status: 'confirmed', messageId: 'm-' + sent.length } };
    },
  };
  const deps = { bot, brain, human: makeHumanizer(), memory, waker: { wake() {} } };
  const items = [
    { key, isGroup: false, userId: '10001', name: '小满', text: '上一句不是重点' },
    { key, isGroup: false, userId: '10001', name: '小满', text: '你刚刚读岔了吧' },
  ];
  const before = ledger(memory).length;

  await handleTurn(deps, items, { dryRun: false });

  assert.equal(fetchCalls.length, 1, '一个批次只问一次模型');
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:9/v1/chat/completions');
  const request = requestOf(fetchCalls[0]);
  const [system, ...afterSystem] = request.messages;
  const currentText = '小满：上一句不是重点\n小满：你刚刚读岔了吧';

  // 修复指令只出现在 system 的处境块里。
  assert.equal(system.role, 'system');
  assert.equal(system.content.includes(REPAIR_DIRECTIVE), true, '明确纠正应带上修复指令');
  assert.match(system.content, /接错/u);
  assert.match(system.content, /不要反问/u);

  // 既有 recent 与本次结构化 history 是两块不同的东西：
  // recent 仍在 system 里（Brain 原来的 excludeWhere 语义），history 在独立 messages 里。
  assert.equal(system.content.includes('别的私聊用户'), true, '既有 recent 块保持原样');
  assert.equal(system.content.includes('群里的用户'), true, '既有 recent 仍可跨场合');
  assert.equal(system.content.includes('同会话用户8'), false, '既有 recent 本来就不含当前会话');

  const historyMessages = afterSystem.slice(0, -1);
  const expected = [];
  for (let i = 3; i <= 8; i += 1) {
    expected.push({ role: 'user', content: '同会话用户' + i });
    expected.push({ role: 'assistant', content: '同会话助理' + i });
  }
  assert.deepEqual(historyMessages, expected, '最多最近 6 轮，按先后并映射用户/助理角色');
  assert.equal(historyMessages.length <= REPAIR_HISTORY_LIMITS.maxRows * 2, true);

  const historyText = historyMessages.map((message) => message.content).join('\n');
  for (const marker of ['别的私聊', '群里的', '上一句不是重点', '读岔']) {
    assert.equal(historyText.includes(marker), false, '跨会话/当前批次不得混入 history：' + marker);
  }

  // 当前批次只出现在最后的当前输入。
  assert.equal(afterSystem.at(-1).role, 'user');
  assert.equal(afterSystem.at(-1).content, currentText);
  assert.equal(request.messages.filter((m) => m.content.includes('上一句不是重点')).length, 1);
  assert.equal(request.messages.filter((m) => m.content.includes('你刚刚读岔了吧')).length, 1);

  // 发送成功之后才 commit，且只写一条。
  const rows = ledger(memory);
  assert.equal(rows.length, before + 1, '全部确认后只落盘一条');
  const committed = rows.filter((row) => row.where === key).at(-1);
  assert.equal(committed.text, storedText(currentText));
  assert.equal(committed.reply, modelText);
  assert.equal(sent.length, 1, '合成回复作为一条发出');
});

// ── 2. 生成失败仍不发送、不提交，原异常交给调用方 ─────────────
test('handleTurn 修复轮：生成失败不发送不提交，修复上下文仍已传入', async (t) => {
  quietConsole(t);
  let captured = null;
  let generationErrors = 0;
  let generationSuccess = 0;
  const memory = {
    recentTurns() {
      return [{ where: 'private:10001', text: '旧的问题', reply: '旧的回答' }];
    },
    touch() { throw new Error('失败轮不应 touch'); },
  };
  const deps = {
    bot: { send() { throw new Error('失败轮不应发送'); } },
    brain: {
      async reply(input) {
        captured = input;
        throw new Error('合成模型失败');
      },
    },
    human: {},
    memory,
    waker: {},
  };

  await assert.rejects(
    () => handleTurn(
      deps,
      [{ key: 'private:10001', isGroup: false, userId: '10001', name: '小满', text: '你刚才读岔了' }],
      { dryRun: false },
      { onGenerationError: () => { generationErrors += 1; }, onGenerationSuccess: () => { generationSuccess += 1; } },
    ),
    /合成模型失败/,
  );

  assert.equal(generationErrors, 1, '生成失败回调只触发一次');
  assert.equal(generationSuccess, 0);
  assert.equal(captured.situation.includes(REPAIR_DIRECTIVE), true);
  assert.deepEqual(captured.history, [
    { isSelf: false, text: '旧的问题' },
    { isSelf: true, text: '旧的回答' },
  ]);
});

// ── 3. 既有时序保持不变：全部确认才落盘 ───────────────────────
test('handleTurn 修复轮：发送未全部确认时不落盘，确认后才落盘', async (t) => {
  quietConsole(t);
  const key = 'private:10001';
  const items = [{ key, isGroup: false, userId: '10001', name: '小满', text: '你刚才读岔了' }];
  const modelText = '第一段的内容在这里\n第二段的内容也在这里';

  await t.test('两段都 confirmed：最后一段确认后才写一次', async (sub) => {
    const { dir, memory } = tempMemory(sub, 'companion-cli-repair-ok-');
    memory.logTurn({ where: key, text: '旧用户', reply: '旧助理' });
    const fetchCalls = installFetch(sub, modelText);
    const brain = makeRealBrain(dir, memory);
    const sent = [];
    const bot = {
      async setTyping() { return { ok: true }; },
      async send(_key, part) {
        sent.push(part);
        return { ok: true, receipt: { status: 'confirmed' } };
      },
    };
    const before = ledger(memory).length;

    await handleTurn({ bot, brain, human: makeHumanizer(), memory, waker: { wake() {} } }, items, { dryRun: false });

    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(sent, ['第一段的内容在这里', '第二段的内容也在这里']);
    const rows = ledger(memory);
    assert.equal(rows.length, before + 1);
    assert.equal(rows.at(-1).text, '小满：你刚才读岔了');
    assert.equal(rows.at(-1).reply, storedText(modelText));
  });

  await t.test('第二段 unknown：整轮不写、不重发、不重问', async (sub) => {
    const { dir, memory } = tempMemory(sub, 'companion-cli-repair-fail-');
    memory.logTurn({ where: key, text: '旧用户', reply: '旧助理' });
    const fetchCalls = installFetch(sub, modelText);
    const brain = makeRealBrain(dir, memory);
    const sent = [];
    const bot = {
      async setTyping() { return { ok: true }; },
      async send(_key, part) {
        sent.push(part);
        const status = sent.length === 1 ? 'confirmed' : 'unknown';
        return { ok: true, receipt: { status } };
      },
    };
    const before = ledger(memory).length;

    await assert.rejects(
      () => handleTurn({ bot, brain, human: makeHumanizer(), memory, waker: { wake() {} } }, items, { dryRun: false }),
      (error) => {
        assert.equal(error.code, 'delivery-unconfirmed');
        assert.equal(error.status, 'unknown');
        assert.equal(error.sent, 1);
        return true;
      },
    );

    assert.equal(fetchCalls.length, 1, '不得重问模型');
    assert.deepEqual(sent, ['第一段的内容在这里', '第二段的内容也在这里'], '失败段之后不继续');
    assert.equal(ledger(memory).length, before, '未确认的修复轮不得落盘');
  });
});

// ── 4. 普通私聊 / 群聊 / 边界：表驱动保持原样 ───────────────
test('handleTurn：非纠正私聊和群聊保持原样，边界不改变传入形状', async (t) => {
  quietConsole(t);

  function spyMemory(rows = null, { throws = false } = {}) {
    const memory = {
      readCalls: 0,
      recentTurns() {
        memory.readCalls += 1;
        if (throws) throw new Error('合成读盘失败');
        return rows;
      },
      touch() {},
    };
    return memory;
  }

  const privateItems = (lastText, firstText = '你刚才读岔了吧') => [
    { key: 'private:10001', isGroup: false, userId: '10001', name: '小满', text: firstText },
    { key: 'private:10001', isGroup: false, userId: '10001', name: '小满', text: lastText },
  ];
  const groupItems = [{ key: 'group:555', isGroup: true, userId: '10001', name: '小满', text: '你读岔了吧' }];
  const privateSituation = '你在跟 小满 私聊。';
  const groupSituation = '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。';

  const cases = [
    {
      name: '私聊最后一条非纠正（更早一条像纠正也不触发）',
      items: privateItems('今天天气不错'),
      memory: spyMemory([]),
      repair: false,
      situation: privateSituation,
    },
    {
      name: '群聊最后一条像纠正也不进入修复',
      items: groupItems,
      memory: spyMemory([]),
      repair: false,
      situation: groupSituation,
    },
    {
      name: '私聊最后一条为空：不触发',
      items: privateItems(''),
      memory: spyMemory([]),
      repair: false,
      situation: privateSituation,
    },
    {
      name: '私聊纠正但账本没有 recentTurns：指令仍在，history 为空',
      items: privateItems('你刚刚读岔了吧'),
      memory: { touch() {} },
      repair: true,
      situation: privateSituation + REPAIR_DIRECTIVE,
      history: [],
      expectRead: false,
    },
    {
      name: '私聊纠正但读盘抛错：history 为空，不影响本轮',
      items: privateItems('你刚刚读岔了吧'),
      memory: spyMemory(null, { throws: true }),
      repair: true,
      situation: privateSituation + REPAIR_DIRECTIVE,
      history: [],
      expectRead: true,
    },
    {
      name: '私聊纠正但 recentTurns 非数组：history 为空',
      items: privateItems('你刚刚读岔了吧'),
      memory: spyMemory(null),
      repair: true,
      situation: privateSituation + REPAIR_DIRECTIVE,
      history: [],
      expectRead: true,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let captured = null;
      const deps = {
        bot: {},
        brain: {
          async reply(input) {
            captured = input;
            return { text: '', commit() { throw new Error('静默轮不应 commit'); } };
          },
        },
        human: {},
        memory: item.memory,
        waker: { wake() { throw new Error('静默轮不应 wake'); } },
      };

      await handleTurn(deps, item.items, { dryRun: false });

      assert.equal(captured.situation, item.situation);
      assert.equal(captured.situation.includes(REPAIR_DIRECTIVE), item.repair);
      assert.equal(captured.record, 'deferred');
      assert.equal(captured.key, item.items.at(-1).key);
      if (item.repair) assert.deepEqual(captured.history, item.history ?? []);
      else assert.equal('history' in captured, false, '普通轮次不新增 history 入参');
      if (item.repair) assert.equal(captured.text, item.items.map((m) => '小满：' + m.text).join('\n'));
      if ('readCalls' in item.memory) {
        const expectedReads = item.expectRead === undefined ? (item.repair ? 1 : 0) : (item.expectRead ? 1 : 0);
        assert.equal(item.memory.readCalls, expectedReads);
      }
    });
  }
});

// ── 5. buildRepairHistory：紧凑表驱动覆盖兜底与限流 ──────────
test('buildRepairHistory：只读、只取当前会话、限流与异常兜底', async (t) => {
  const rowsFor = (count) => Array.from({ length: count }, (_v, index) => ({
    where: 'private:10001',
    text: '用户' + (index + 1),
    reply: '助理' + (index + 1),
  }));

  const memoryWith = (rows) => {
    const memory = { readArgs: [], recentTurns(n) { memory.readArgs.push(n); return rows; } };
    return memory;
  };

  const defaultExpected = [];
  for (let i = 3; i <= 8; i += 1) {
    defaultExpected.push({ isSelf: false, text: '用户' + i });
    defaultExpected.push({ isSelf: true, text: '助理' + i });
  }

  const cases = [
    { name: 'memory 为空', memory: null, key: 'private:10001', want: [] },
    { name: 'memory 没有 recentTurns', memory: {}, key: 'private:10001', want: [] },
    { name: '当前会话 key 为空', memory: memoryWith(rowsFor(1)), key: '', want: [], expectRead: false },
    { name: '当前会话 key 为 null', memory: memoryWith(rowsFor(1)), key: null, want: [], expectRead: false },
    {
      name: 'recentTurns 抛错',
      memory: { recentTurns() { throw new Error('合成读盘失败'); } },
      key: 'private:10001',
      want: [],
    },
    {
      name: 'recentTurns 返回非数组',
      memory: { recentTurns() { return null; } },
      key: 'private:10001',
      want: [],
    },
    {
      name: '过滤跨会话 / 无 where / 空正文，按用户→助理还原',
      memory: memoryWith([
        null,
        [],
        { where: 'private:20002', text: '其他人的', reply: '其他人的回复' },
        { where: 'group:555', text: '群里的', reply: '群里的回复' },
        { where: 'private:10001', text: '   ', reply: '   ' },
        { where: 'private:10001', text: '保留用户', reply: '保留助理' },
        { text: '没有 where 的行' },
        { where: 'private:10001', reply: '只有助理' },
        { where: 'private:10001', text: '只有用户' },
      ]),
      key: 'private:10001',
      want: [
        { isSelf: false, text: '保留用户' },
        { isSelf: true, text: '保留助理' },
        { isSelf: true, text: '只有助理' },
        { isSelf: false, text: '只有用户' },
      ],
    },
    {
      name: '默认最多最近 6 轮 / 12 条',
      memory: memoryWith(rowsFor(8)),
      key: 'private:10001',
      want: defaultExpected,
    },
    {
      name: '上限参数非法时回退默认',
      memory: memoryWith(rowsFor(8)),
      key: 'private:10001',
      opts: { maxRows: 0, maxMessages: 0 },
      want: defaultExpected,
    },
    {
      name: '自定义更小上限同时生效',
      memory: memoryWith(rowsFor(4)),
      key: 'private:10001',
      opts: { maxRows: 2, maxMessages: 2 },
      want: [
        { isSelf: false, text: '用户4' },
        { isSelf: true, text: '助理4' },
      ],
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const got = buildRepairHistory(item.memory, item.key, item.opts);
      assert.deepEqual(got, item.want);
      if ('readArgs' in (item.memory || {})) {
        assert.deepEqual(
          item.memory.readArgs,
          item.expectRead === false ? [] : [Number.MAX_SAFE_INTEGER],
          '只调用现有只读入口取数',
        );
      }
    });
  }
});