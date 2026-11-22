/**
 * C 门离线场景 · QQ 在场（presence）
 * ─────────────────────────────────────────────────────────────
 * 本文件只补「统一离线矩阵」里的 C 门，不改产品、不接真实平台：
 *
 *   C-03  QQ presence 默认关闭（配置缺省即关，不建状态、不发主动消息）
 *   C-04  开启后投递：真实 Humanizer → 合成 OneBot sendPrivateText；
 *         sent / accepted 严格分离，accepted 只占额度、不算送达
 *   C-05  重启后额度：同一状态文件跨 host 实例恢复日上限、冷却、已结算台账
 *   C-07  安静时段：保留 intent 不发；走出安静时段后过期积压不补发
 *   C-08  过时 intent：owner 一开口即作废 pending；更早 intent 被
 *         stale-after-user-message 拒绝
 *   C-09  失败 / 未知投递：只结算一次、不自动重试、不写成功台账
 *
 * ── 证据边界（必须在报告里一起读）──────────────────────────
 *   - 全部是离线合成证据：合成 owner / 合成文案 / 合成 OneBot；
 *     不连 QQ、OneBot、HTTP，不调真实模型，不读写仓库 data/ 或真实配置。
 *   - 时钟由 harness 虚拟时钟注入；时间只用于状态机、冷却、日上限与 TTL。
 *   - C-04 只证明「离线运行层 + 合成 OneBot」这一半；真实平台回执仍属 T9，
 *     不因本场景 pass 而视为 C-04 真实平台部分通过。
 *   - C-03 用 `main()` 的 createBot 注入点跑一次 CLI 装配（默认关闭），
 *     其余场景直接驱动 `createPresenceQQHost`（main() 使用的同一运行层），
 *     并把可控时钟注入 host；没有修改产品注入点。
 *
 * 约定同 scenarios.mjs：只填合成输入；每步 expected / actual 键集合一致；
 * 错误只留闭合码；不把正文、账号、异常 message 写进证据。
 */
import fs from 'node:fs';
import path from 'node:path';

import { Humanizer } from '../../packages/companion/src/humanize.js';
import { PresenceRuntime } from '../../packages/companion/src/presence-runtime.js';
import { createPresenceQQAdapter } from '../../packages/companion/src/presence/qq-adapter.js';
import { createPresenceSession } from '../../packages/companion/src/presence/session.js';
import { createPresenceQQHost } from '../../packages/companion/src/presence-qq-runtime.js';
import { loadConfig, main } from '../../packages/companion/src/index.js';

/** 合成账号 / 状态文件名：占位值，不对应任何真实账号。 */
const OWNER = 'owner-synthetic-alpha';
const OTHER = 'owner-synthetic-beta';
const STRANGER = 'stranger-synthetic-gamma';
const STATE_FILE = 'presence-qq-state.json';

const HUMANIZER_NOTE = 'enabled=false：只跳过拟人停顿，Humanizer 的分条与回执判定仍走真实代码。';

/**
 * 合成 OneBot：只实现 presence 用到的 sendPrivateText / setTyping，返回形状
 * 与 transport-onebot.js 的 `{ ...result, receipt }` 对齐；不建立任何连接。
 *
 * 模式：
 *   confirmed → 平台给出 message_id，回执 confirmed（可称 sent）
 *   accepted  → 平台受理但无可核对回执（只能记 accepted）
 *   rejected  → 平台明确拒绝（failed）
 *   throw     → 传输层异常（unknown）
 */
function createSyntheticOneBot({ mode = 'confirmed' } = {}) {
  const calls = [];
  let counter = 0;
  return {
    calls,
    async sendPrivateText(userId, text) {
      counter += 1;
      const record = {
        userId: String(userId),
        text: String(text),
        mode,
        receiptStatus: 'none',
      };
      calls.push(record);
      if (mode === 'throw') {
        throw Object.assign(new Error('synthetic-transport-failure'), {
          code: 'synthetic-transport-failure',
        });
      }
      if (mode === 'rejected') {
        record.receiptStatus = 'rejected';
        return {
          ok: false,
          data: { status: 'failed', retcode: 1200 },
          receipt: { status: 'rejected' },
        };
      }
      if (mode === 'accepted') return { ok: true };
      const messageId = 'synthetic-message-' + counter;
      record.receiptStatus = 'confirmed';
      return {
        ok: true,
        data: { status: 'ok', retcode: 0, data: { message_id: messageId } },
        receipt: { status: 'confirmed', messageId },
      };
    },
    async send(key, text) {
      calls.push({ key: String(key), text: String(text), mode, receiptStatus: 'none' });
      return { ok: true };
    },
    async setTyping() {},
  };
}

/** 合成的 presenceQQ 配置：阈值压小，便于用虚拟时钟驱动。 */
function presenceCfg(overrides = {}) {
  return {
    enabled: true,
    ownerId: OWNER,
    idleMs: 1000,
    awayMs: 5000,
    returnAfterMs: 0,
    workAfterMs: 60 * 60 * 1000,
    cooldownMs: 0,
    minGapMs: 0,
    maxPerDay: 5,
    quietHours: null,
    intentTtlMs: 30 * 60 * 1000,
    maxPending: 8,
    ...overrides,
  };
}

/**
 * 用真实 host + 真实 Humanizer + 合成 OneBot 搭一个 fixture。
 * `root` 必须是本场景专属的顶层目录（避免共享临时目录时证据串场）。
 */
function createHostFixture(harness, {
  root,
  name = 'data',
  presenceQQ,
  botMode = 'confirmed',
  dryRun = false,
  ownerIds = [OWNER, OTHER],
} = {}) {
  const dataDir = harness.dirOf(root + '/' + name);
  const bot = createSyntheticOneBot({ mode: botMode });
  const human = new Humanizer({ enabled: false });
  let humanCalls = 0;
  const humanPort = {
    say(text, io) {
      humanCalls += 1;
      return human.say(text, io);
    },
  };
  const journal = [];
  const host = createPresenceQQHost({
    cfg: { dataDir, ownerIds, presenceQQ, dryRun },
    bot,
    human: humanPort,
    now: () => harness.now(),
    journal: (event) => journal.push(event),
  });
  return {
    host,
    bot,
    journal,
    dataDir,
    stateFile: path.join(dataDir, STATE_FILE),
    humanCalls: () => humanCalls,
  };
}

/** 一次 activity → away → returned；不 sleep，全部由虚拟时钟推进。 */
async function runPresenceCycle(harness, host) {
  const entered = await host.observe({ kind: 'activity', at: harness.now() });
  harness.advanceClock(6000);
  const away = await host.settle({ at: harness.now() });
  harness.advanceClock(6000);
  const returned = await host.observe({ kind: 'activity', at: harness.now() });
  return { entered, away, returned };
}

/**
 * 把虚拟时钟推到本地 9–11 点安静窗口内，并保证窗口内至少还剩 10 分钟
 * （C-07 要在窗口内再前进 10 分钟）。只影响本场景后续的相对推进；不依赖墙钟。
 */
function ensureLocalQuietWindow(harness, start = 9, end = 11) {
  const now = new Date(harness.now());
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour >= start && hour < end - 10 / 60) return harness.now();
  const target = new Date(now);
  target.setHours(9, 30, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  harness.advanceClock(target.getTime() - now.getTime());
  return harness.now();
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ledgerStatuses(state) {
  return (state?.deliveredIds ?? [])
    .map((entry) => String(entry).split('|')[1] ?? '')
    .join('|');
}

function eventsOf(journal, type) {
  return journal.filter((event) => event.type === type);
}

function hasBody(value, body) {
  const text = JSON.stringify(value);
  return (body !== '' && text.includes(body))
    || /"text"\s*:/u.test(text)
    || /"name"\s*:/u.test(text);
}

function stateHasNoBody(state, body) {
  if (state === null) return false;
  const text = JSON.stringify(state);
  return (body === '' || !text.includes(body))
    && !/"text"\s*:/u.test(text)
    && !/"name"\s*:/u.test(text);
}

/* ══════════════════════ C-03 默认关闭 ══════════════════════ */

/**
 * C-03：配置缺省即关闭；关闭时不建状态文件、不发主动消息。
 * 先跑一次真实 CLI 装配（main + createBot 注入），再用 host 覆盖
 * 「关闭 / 缺 owner / 不在白名单 / 多 owner 无显式 owner / dry-run」闸门。
 */
async function runC03(harness) {
  const rolePath = harness.writeFile('c03/cli/role.md', '你是小鲸鱼。说话短一点，别用客服腔。');
  const configPath = harness.writeFile('c03/cli/config.json', JSON.stringify({
    apiKey: '',
    roleCard: 'role.md',
    dataDir: 'data',
    ownerIds: [OWNER],
    onebot: { wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' },
    wake: { privateWindowMs: 10 },
    humanize: { enabled: false },
  }));
  const argv = ['node', 'index.js', '--config', configPath];
  const cfg = loadConfig(configPath, argv);
  const bot = createSyntheticOneBot();
  const proc = { argv, on() {} };
  const app = await main({ createBot: () => bot, proc });
  const presence = app.presence;
  const statePath = path.join(cfg.dataDir, STATE_FILE);
  const ticked = await presence.tick(harness.now());
  const closed = presence.close();

  harness.step({
    title: 'CLI 默认关闭：未配置 presenceQQ 时不建状态、不发主动消息',
    input: {
      kind: 'presence-qq-config',
      note: 'main() + 合成 bot + 临时配置；配置里没有 presenceQQ 字段',
    },
    expected: {
      configEnabled: false,
      configOwner: '',
      hostStatus: 'disabled',
      hostEnabled: false,
      hostOwner: null,
      stateFile: null,
      stateFileExists: false,
      sends: 0,
      tickStatus: 'disabled',
      closeOk: true,
      closePersisted: false,
    },
    actual: {
      configEnabled: cfg.presenceQQ.enabled,
      configOwner: cfg.presenceQQ.ownerId,
      hostStatus: presence.status,
      hostEnabled: presence.enabled,
      hostOwner: presence.ownerId ?? null,
      stateFile: presence.stateFile ?? null,
      stateFileExists: fs.existsSync(statePath),
      sends: bot.calls.length,
      tickStatus: ticked.status,
      closeOk: closed.ok === true,
      closePersisted: closed.persisted === true,
    },
  });

  const variants = [
    ['no-config', { presenceQQ: undefined }],
    ['off', { presenceQQ: { enabled: false, ownerId: OWNER } }],
    ['owner-missing', { presenceQQ: { enabled: true } }],
    ['not-whitelisted', { presenceQQ: { enabled: true, ownerId: STRANGER } }],
    ['multi-owner-no-explicit', { presenceQQ: { enabled: true } }],
    ['dry-run', { presenceQQ: { enabled: true, ownerId: OWNER }, dryRun: true }],
  ];
  const statuses = [];
  const codes = [];
  const observeStatuses = [];
  let stateFiles = 0;
  let sends = 0;
  for (const [name, options] of variants) {
    const fixture = createHostFixture(harness, {
      root: 'c03/gates/' + name,
      ...options,
    });
    statuses.push(fixture.host.status);
    codes.push(fixture.host.diagnostics[0]?.code ?? '');
    const observed = await fixture.host.observe({ kind: 'activity', at: harness.now() });
    observeStatuses.push(observed.status);
    stateFiles += fs.existsSync(fixture.stateFile) ? 1 : 0;
    sends += fixture.bot.calls.length;
    fixture.host.close();
  }

  harness.step({
    title: '配置闸门：关闭 / 缺 owner / 不在白名单 / 多 owner 无显式 owner 都 fail-closed',
    input: {
      kind: 'presence-qq-config',
      note: '六份合成 cfg：无配置 / enabled=false / owner 空 / owner 不在白名单 / 多 owner 但无显式 owner / dry-run',
    },
    expected: {
      statuses: 'disabled|disabled|owner-missing|owner-not-whitelisted|owner-missing|dry-run',
      codes: 'presence-qq-disabled|presence-qq-disabled|presence-qq-owner-missing'
        + '|presence-qq-owner-not-whitelisted|presence-qq-owner-missing|presence-qq-dry-run',
      observeStatuses: 'disabled|disabled|owner-missing|owner-not-whitelisted|owner-missing|dry-run',
      stateFiles: 0,
      sends: 0,
    },
    actual: {
      statuses: statuses.join('|'),
      codes: codes.join('|'),
      observeStatuses: observeStatuses.join('|'),
      stateFiles,
      sends,
    },
  });

  return {
    modules: ['index.js#main', 'index.js#loadConfig', 'presence-qq-runtime.js'],
    limitation: 'qq-presence-default-off-cli-synthetic-bot',
    note: '只证明默认关闭与配置闸门；真实 QQ / OneBot 连接不在本场景内。'
      + ' 本 fork 的 PRESENCE_QQ_DEFAULTS.quietHours 为 null，计划 T5 写的是 [23,7]；'
      + ' 本 PR 不改产品，故不把该默认值差异算作 C-03 通过。',
    roleCard: path.basename(rolePath),
    configFile: path.basename(configPath),
    defaults: { minGapMs: 15 * 60 * 1000, maxPerDay: 2, quietHours: null },
    humanizerNote: HUMANIZER_NOTE,
  };
}

/* ══════════════════════ C-04 开启后投递 ══════════════════════ */

/**
 * C-04：开启后 intent 经真实 Humanizer → 合成 OneBot 投递。
 * sent 必须有可核对回执；accepted 只占额度、不算送达；两者都写台账。
 */
async function runC04(harness) {
  const confirmed = createHostFixture(harness, {
    root: 'c04/confirmed',
    presenceQQ: presenceCfg({ maxPerDay: 2 }),
  });
  const first = await runPresenceCycle(harness, confirmed.host);
  const delivery = first.returned.delivery;
  const body = confirmed.bot.calls[0]?.text ?? '';
  const state = readState(confirmed.stateFile);
  const journal = confirmed.journal;
  const intentIndex = journal.findIndex((event) => event.type === 'presence-intent');
  const deliveryIndex = journal.findIndex((event) => event.type === 'presence-delivery');
  const deliveryEvent = eventsOf(journal, 'presence-delivery').at(-1) ?? null;

  harness.step({
    title: '开启后投递：Humanizer → 合成 OneBot，confirmed 回执才算 sent',
    input: {
      kind: 'presence-qq-delivery',
      note: '合成 owner；away → present 产生一条 welcome intent；合成 OneBot 返回 message_id + confirmed',
    },
    model: { calls: 0 },
    delivery: {
      attempted: confirmed.bot.calls.length,
      sent: delivery?.sent ?? 0,
      receipts: delivery?.status ? [delivery.status] : [],
      texts: confirmed.bot.calls.map((call) => call.text),
      channel: 'qq-private-synthetic-onebot',
    },
    expected: {
      status: 'sent',
      sent: 1,
      accepted: 0,
      confirmed: true,
      pending: 0,
      botCalls: 1,
      botUser: OWNER,
      humanCalls: 1,
      receiptStatus: 'confirmed',
      textNonEmpty: true,
    },
    actual: {
      status: delivery?.status ?? '',
      sent: delivery?.sent ?? 0,
      accepted: delivery?.accepted ?? 0,
      confirmed: delivery?.confirmed === true,
      pending: delivery?.pending ?? -1,
      botCalls: confirmed.bot.calls.length,
      botUser: confirmed.bot.calls[0]?.userId ?? '',
      humanCalls: confirmed.humanCalls(),
      receiptStatus: confirmed.bot.calls[0]?.receiptStatus ?? '',
      textNonEmpty: body.length > 0,
    },
  });

  harness.step({
    title: '投递证据：intent 先于 delivery，journal/状态文件都不含正文',
    input: {
      kind: 'presence-qq-delivery-evidence',
      note: '同一拍的 journal 与 presence-qq-state.json；只检查顺序、状态与是否夹带正文',
    },
    expected: {
      journalIntentBeforeDelivery: true,
      journalDeliveryStatus: 'sent',
      journalConfirmed: true,
      journalQuota: true,
      journalNoBody: true,
      ledgerStatus: 'sent',
      stateNoBody: true,
      stateFileExists: true,
    },
    actual: {
      journalIntentBeforeDelivery: intentIndex >= 0 && deliveryIndex > intentIndex,
      journalDeliveryStatus: deliveryEvent?.status ?? '',
      journalConfirmed: deliveryEvent?.confirmed === true,
      journalQuota: deliveryEvent?.quota === true,
      journalNoBody: !hasBody(journal, body),
      ledgerStatus: ledgerStatuses(state),
      stateNoBody: stateHasNoBody(state, body),
      stateFileExists: state !== null,
    },
  });

  const accepted = createHostFixture(harness, {
    root: 'c04/accepted',
    presenceQQ: presenceCfg({ maxPerDay: 1 }),
    botMode: 'accepted',
  });
  const acceptedCycle = await runPresenceCycle(harness, accepted.host);
  const acceptedDelivery = acceptedCycle.returned.delivery;
  const acceptedState = readState(accepted.stateFile);

  harness.step({
    title: 'accepted：平台受理但无可核对回执，不算 sent / 已送达',
    input: {
      kind: 'presence-qq-delivery',
      note: '合成 OneBot 只返回 ok:true，没有 message_id；同一套 Humanizer / host',
    },
    model: { calls: 0 },
    delivery: {
      attempted: accepted.bot.calls.length,
      sent: acceptedDelivery?.sent ?? 0,
      receipts: acceptedDelivery?.status ? [acceptedDelivery.status] : [],
      texts: accepted.bot.calls.map((call) => call.text),
      channel: 'qq-private-synthetic-onebot',
    },
    expected: {
      status: 'accepted',
      sent: 0,
      accepted: 1,
      confirmed: false,
      pending: 0,
      botCalls: 1,
      humanCalls: 1,
      ledgerStatus: 'accepted',
    },
    actual: {
      status: acceptedDelivery?.status ?? '',
      sent: acceptedDelivery?.sent ?? 0,
      accepted: acceptedDelivery?.accepted ?? 0,
      confirmed: acceptedDelivery?.confirmed === true,
      pending: acceptedDelivery?.pending ?? -1,
      botCalls: accepted.bot.calls.length,
      humanCalls: accepted.humanCalls(),
      ledgerStatus: ledgerStatuses(acceptedState),
    },
  });

  const capped = await runPresenceCycle(harness, accepted.host);
  const cappedDelivery = capped.returned.delivery;
  const acceptedStateAfter = readState(accepted.stateFile);

  harness.step({
    title: 'accepted 也占额度：同一状态再收一条 intent，被日上限拦住',
    input: {
      kind: 'presence-qq-delivery',
      note: 'maxPerDay=1；accepted 已经消耗当日额度，第二条 intent 只排队不发送',
    },
    expected: {
      secondStatus: 'daily-cap',
      secondSent: 0,
      sendsAfter: 1,
      pendingAfter: 1,
      journalDeliveries: 1,
      ledgerStatusAfter: 'accepted',
    },
    actual: {
      secondStatus: cappedDelivery?.status ?? '',
      secondSent: cappedDelivery?.sent ?? 0,
      sendsAfter: accepted.bot.calls.length,
      pendingAfter: accepted.host.pending,
      journalDeliveries: eventsOf(accepted.journal, 'presence-delivery').length,
      ledgerStatusAfter: ledgerStatuses(acceptedStateAfter),
    },
  });

  confirmed.host.close();
  accepted.host.close();

  return {
    modules: [
      'presence-qq-runtime.js',
      'humanize.js',
      'presence/qq-adapter.js',
      'presence/session.js',
      'presence/persistence.js',
    ],
    limitation: 'qq-presence-runtime-synthetic-onebot-offline',
    note: '只证明离线运行层 + 合成 OneBot：经真实 Humanizer、真实回执归一化与状态文件。'
      + ' C-04 的真实平台回执部分仍需 T9，本场景 pass 不代表该半通过。',
    humanizerNote: HUMANIZER_NOTE,
  };
}

/* ══════════════════════ C-05 重启后额度 ══════════════════════ */

/**
 * C-05：同一状态文件跨 host 实例恢复日上限、冷却与已结算台账；
 * 旧欢迎不补发，新 intent 被 daily-cap 拦住。
 */
async function runC05(harness) {
  ensureLocalQuietWindow(harness);
  const first = createHostFixture(harness, {
    root: 'c06',
    name: 'data',
    presenceQQ: presenceCfg({ maxPerDay: 1 }),
  });
  const firstCycle = await runPresenceCycle(harness, first.host);
  const firstAt = harness.now();
  const firstDelivery = firstCycle.returned.delivery;
  const firstState = readState(first.stateFile);
  first.host.close();

  harness.advanceClock(60 * 60 * 1000);
  const restarted = createHostFixture(harness, {
    root: 'c06',
    name: 'data',
    presenceQQ: presenceCfg({ maxPerDay: 1 }),
  });
  const restoredStats = restarted.host.stats;
  const sendsAfterRestart = restarted.bot.calls.length;
  const restartCycle = await runPresenceCycle(harness, restarted.host);
  const restartFirstReturn = restartCycle.returned;
  const sendsAfterFirstReturn = restarted.bot.calls.length;
  const cappedCycle = await runPresenceCycle(harness, restarted.host);
  const cappedDelivery = cappedCycle.returned.delivery;
  const stateAfter = readState(restarted.stateFile);

  harness.step({
    title: '重启前：第一条 welcome 已 sent，台账落盘',
    input: {
      kind: 'presence-qq-delivery',
      note: 'away → present 产生 welcome；合成 OneBot 返回 confirmed + message_id',
    },
    expected: {
      status: 'sent',
      sent: 1,
      confirmed: true,
      botCalls: 1,
      ledgerStatus: 'sent',
      ledgerEntries: 1,
      stateFileExists: true,
    },
    actual: {
      status: firstDelivery?.status ?? '',
      sent: firstDelivery?.sent ?? 0,
      confirmed: firstDelivery?.confirmed === true,
      botCalls: first.bot.calls.length,
      ledgerStatus: ledgerStatuses(firstState),
      ledgerEntries: (firstState?.deliveredIds ?? []).length,
      stateFileExists: firstState !== null,
    },
  });

  harness.step({
    title: '重启：同一状态文件恢复日上限、冷却与已结算台账',
    input: {
      kind: 'presence-restart',
      note: '同一 dataDir 上新建 host；时钟前进一小时，不补发旧欢迎',
    },
    expected: {
      restored: true,
      ledgerEntries: 1,
      cooldownWelcome: firstAt,
      cooldownProactive: firstAt,
      pendingEvents: 0,
      sendsAfterRestart: 0,
    },
    actual: {
      restored: restoredStats.session?.restored === true,
      ledgerEntries: restoredStats.session?.ledgerEntries ?? -1,
      cooldownWelcome: restoredStats.session?.cooldowns?.welcome ?? null,
      cooldownProactive: restoredStats.session?.cooldowns?.proactive ?? null,
      pendingEvents: restoredStats.runtime?.pendingEvents ?? -1,
      sendsAfterRestart,
    },
  });

  harness.step({
    title: '重启后旧欢迎不补发：同一 id 已被台账结算，第一拍不再发',
    input: {
      kind: 'presence-restart',
      note: '新 host 的第一轮 away → present；intent 序号从 1 重新开始，与已结算 id 相同',
    },
    expected: {
      firstReturnIntents: 0,
      firstReturnRouted: 0,
      firstReturnDelivery: null,
      sendsAfterFirstReturn: 0,
    },
    actual: {
      firstReturnIntents: restartFirstReturn.intents.length,
      firstReturnRouted: restartFirstReturn.routed.length,
      firstReturnDelivery: restartFirstReturn.delivery ?? null,
      sendsAfterFirstReturn,
    },
  });

  harness.step({
    title: '重启后日上限仍生效：新 intent 被 daily-cap 拦住，不发送',
    input: {
      kind: 'presence-restart',
      note: '第二轮 away → present 产生新 id；maxPerDay=1，当日额度已被重启前那条占满',
    },
    expected: {
      secondReturnStatus: 'daily-cap',
      secondReturnPending: 1,
      sendsAfterSecondReturn: 0,
      ledgerEntriesAfter: 1,
      dailyCapSkips: 1,
      restored: true,
    },
    actual: {
      secondReturnStatus: cappedDelivery?.status ?? '',
      secondReturnPending: cappedDelivery?.pending ?? -1,
      sendsAfterSecondReturn: restarted.bot.calls.length,
      ledgerEntriesAfter: restarted.host.stats.session?.ledgerEntries ?? -1,
      dailyCapSkips: restarted.host.stats.adapter?.dailyCapSkips ?? -1,
      restored: restarted.host.stats.session?.restored === true,
    },
  });

  restarted.host.close();

  return {
    modules: [
      'presence-qq-runtime.js',
      'presence/session.js',
      'presence/persistence.js',
      'presence/qq-adapter.js',
    ],
    limitation: 'qq-presence-restart-synthetic-onebot-offline',
    note: '同一临时状态文件的 host 重建，证明日上限/冷却/台账跨重启生效；'
      + '不是进程级重启，也不是真实 QQ。',
    stateFile: STATE_FILE,
    ledgerStatusAfter: ledgerStatuses(stateAfter),
  };
}

/* ══════════════════════ C-07 安静时段 / 过期积压 ══════════════════════ */

/**
 * C-07：安静时段保留 intent 不发；走出安静时段后过期积压不补发。
 */
async function runC07(harness) {
  ensureLocalQuietWindow(harness);
  const fixture = createHostFixture(harness, {
    root: 'c07',
    presenceQQ: presenceCfg({ quietHours: [9, 11], maxPerDay: 5 }),
  });
  const cycle = await runPresenceCycle(harness, fixture.host);
  const quiet = cycle.returned.delivery;

  harness.step({
    title: '安静时段：intent 保留在队列，一条都不发',
    input: {
      kind: 'presence-quiet-hours',
      note: '虚拟时钟落在本地 9–11 点；away → present 产生 welcome',
    },
    expected: {
      status: 'quiet-hours',
      pending: 1,
      sends: 0,
      deliveryEvents: 0,
      expiredEvents: 0,
    },
    actual: {
      status: quiet?.status ?? '',
      pending: fixture.host.pending,
      sends: fixture.bot.calls.length,
      deliveryEvents: eventsOf(fixture.journal, 'presence-delivery').length,
      expiredEvents: eventsOf(fixture.journal, 'presence-intent-expired').length,
    },
  });

  harness.advanceClock(10 * 60 * 1000);
  const stillQuiet = await fixture.host.tick(harness.now());

  harness.step({
    title: '仍在安静时段：10 分钟后仍不发，intent 不丢',
    input: {
      kind: 'presence-quiet-hours',
      note: '安静窗口内再 tick 一次；intent TTL 30 分钟尚未到',
    },
    expected: {
      status: 'quiet-hours',
      pending: 1,
      sends: 0,
    },
    actual: {
      status: stillQuiet.status,
      pending: fixture.host.pending,
      sends: fixture.bot.calls.length,
    },
  });

  harness.advanceClock(3 * 60 * 60 * 1000);
  const afterQuiet = await fixture.host.tick(harness.now());

  harness.step({
    title: '走出安静时段：积压已过期，不补发、不 burst',
    input: {
      kind: 'presence-quiet-hours',
      note: '再前进三小时到 13 点；intent 已超过 30 分钟 TTL',
    },
    expected: {
      status: 'idle',
      pending: 0,
      sends: 0,
      expiredEvents: 1,
      deliveryEvents: 0,
    },
    actual: {
      status: afterQuiet.status,
      pending: fixture.host.pending,
      sends: fixture.bot.calls.length,
      expiredEvents: eventsOf(fixture.journal, 'presence-intent-expired').length,
      deliveryEvents: eventsOf(fixture.journal, 'presence-delivery').length,
    },
  });

  fixture.host.close();

  return {
    modules: [
      'presence-qq-runtime.js',
      'presence/qq-adapter.js',
      'followup-policy.js#isQuietHours',
    ],
    limitation: 'qq-presence-quiet-hours-synthetic-clock-offline',
    note: '安静时段按本地小时判断；只证明离线状态机与 TTL，不证明真实平台时段。',
  };
}

/* ══════════════════════ C-08 过时 intent ══════════════════════ */

/**
 * C-08：owner 一开口即作废 pending；更早的 intent 被
 * stale-after-user-message 拒绝。前半走 host，后半直接驱动同一适配器。
 */
async function runC08(harness) {
  ensureLocalQuietWindow(harness);
  const fixture = createHostFixture(harness, {
    root: 'c08',
    presenceQQ: presenceCfg({ quietHours: [9, 11], maxPerDay: 5 }),
  });
  const cycle = await runPresenceCycle(harness, fixture.host);
  const queued = cycle.returned.delivery;
  const noted = fixture.host.onIncomingMessage({ isGroup: false, userId: OWNER });
  const ticked = await fixture.host.tick(harness.now());

  harness.step({
    title: 'owner 开口：pending 作废，不补发，也不自指发送',
    input: {
      kind: 'presence-incoming-message',
      note: '安静时段先留一条 pending；随后 owner 私聊到达（同一虚拟时刻）',
    },
    expected: {
      queuedStatus: 'quiet-hours',
      queuedPending: 1,
      ignored: false,
      invalidated: 1,
      pendingAfter: 0,
      selfSends: 0,
      tickStatus: 'idle',
      invalidatedEvents: 1,
      deliveryEvents: 0,
    },
    actual: {
      queuedStatus: queued?.status ?? '',
      queuedPending: queued?.pending ?? -1,
      ignored: noted.ignored === true,
      invalidated: noted.invalidated,
      pendingAfter: noted.pending,
      selfSends: fixture.bot.calls.length,
      tickStatus: ticked.status,
      invalidatedEvents: eventsOf(fixture.journal, 'presence-intent-invalidated').length,
      deliveryEvents: eventsOf(fixture.journal, 'presence-delivery').length,
    },
  });

  // 后半段直接驱动同一真实适配器：host 不暴露 adapter.onIntent，无法从 host
  // 注入一条「比用户消息更早」的 intent；这里用真实 session/runtime/adapter
  // 验证适配器自己的 stale-after-user-message 守卫。
  const runtime = new PresenceRuntime({ clock: () => harness.now() });
  const session = createPresenceSession({ runtime, store: null, now: () => harness.now() });
  let sendCalls = 0;
  const adapter = createPresenceQQAdapter({
    session,
    sendText: async () => {
      sendCalls += 1;
      return { ok: true, data: { message_id: 'synthetic-adapter-message' } };
    },
    now: () => harness.now(),
    enabled: true,
    minGapMs: 0,
    quietHours: null,
    maxPerDay: 5,
    intentTtlMs: 30 * 60 * 1000,
  });
  const at = harness.now();
  const queuedAdapter = adapter.onIntent({
    id: 'c08-old', kind: 'welcome-back', text: '合成：旧 intent', at,
  });
  const notedAdapter = adapter.noteUserMessage(at + 10_000);
  const older = adapter.onIntent({
    id: 'c08-older', kind: 'welcome-back', text: '合成：更旧的 intent', at,
  });
  const tickedAdapter = await adapter.tick(at + 20_000);

  harness.step({
    title: '过时 intent：更早的 intent 被 stale-after-user-message 拒绝，不重发',
    input: {
      kind: 'presence-stale-intent',
      note: '真实 session/runtime/adapter + 合成 sendText；先入队，再模拟用户消息，最后提交更早 intent',
    },
    expected: {
      queuedAccepted: true,
      queuedPending: 1,
      invalidated: 1,
      pendingAfterNote: 0,
      olderAccepted: false,
      olderReason: 'stale-after-user-message',
      tickStatus: 'idle',
      sendCalls: 0,
    },
    actual: {
      queuedAccepted: queuedAdapter.accepted === true,
      queuedPending: queuedAdapter.pending,
      invalidated: notedAdapter.invalidated,
      pendingAfterNote: notedAdapter.pending,
      olderAccepted: older.accepted === true,
      olderReason: older.reason ?? '',
      tickStatus: tickedAdapter.status,
      sendCalls,
    },
  });

  fixture.host.close();

  return {
    modules: [
      'presence-qq-runtime.js',
      'presence/qq-adapter.js',
      'presence/session.js',
      'presence-runtime.js',
    ],
    limitation: 'qq-presence-stale-intent-synthetic-offline',
    note: '前半是 host 层（owner 消息作废 pending），后半是同一适配器的 stale 守卫；'
      + '两者都是真实离线模块，不是真实 QQ。',
  };
}

/* ══════════════════════ C-09 失败 / 未知不重试 ══════════════════════ */

/**
 * C-09：failed / unknown 只结算一次，不自动重试，不写成功台账。
 */
async function runC09(harness) {
  const failed = createHostFixture(harness, {
    root: 'c09/failed',
    presenceQQ: presenceCfg({ maxPerDay: 5 }),
    botMode: 'rejected',
  });
  const failedCycle = await runPresenceCycle(harness, failed.host);
  const failedDelivery = failedCycle.returned.delivery;
  const failedJournal = eventsOf(failed.journal, 'presence-delivery').at(-1) ?? null;
  const failedState = readState(failed.stateFile);
  const failedRetry = await failed.host.tick(harness.now());

  harness.step({
    title: '平台明确拒绝：结算 failed 一次，不重试、不占额度、不写 sent',
    input: {
      kind: 'presence-qq-delivery-failure',
      note: '合成 OneBot 返回 ok:false + receipt rejected；随后再 tick 一次',
    },
    expected: {
      status: 'failed',
      confirmed: false,
      sent: 0,
      accepted: 0,
      pending: 0,
      botCalls: 1,
      journalStatus: 'failed',
      journalQuota: false,
      ledgerStatus: 'failed',
      retryStatus: 'idle',
      callsAfterRetry: 1,
      attempted: 1,
      failedCount: 1,
    },
    actual: {
      status: failedDelivery?.status ?? '',
      confirmed: failedDelivery?.confirmed === true,
      sent: failedDelivery?.sent ?? 0,
      accepted: failedDelivery?.accepted ?? 0,
      pending: failedDelivery?.pending ?? -1,
      botCalls: failed.bot.calls.length,
      journalStatus: failedJournal?.status ?? '',
      journalQuota: failedJournal?.quota === true,
      ledgerStatus: ledgerStatuses(failedState),
      retryStatus: failedRetry.status,
      callsAfterRetry: failed.bot.calls.length,
      attempted: failed.host.stats.adapter?.attempted ?? -1,
      failedCount: failed.host.stats.adapter?.failed ?? -1,
    },
  });

  const unknown = createHostFixture(harness, {
    root: 'c09/unknown',
    presenceQQ: presenceCfg({ maxPerDay: 5 }),
    botMode: 'throw',
  });
  const unknownCycle = await runPresenceCycle(harness, unknown.host);
  const unknownDelivery = unknownCycle.returned.delivery;
  const unknownJournal = eventsOf(unknown.journal, 'presence-delivery').at(-1) ?? null;
  const unknownState = readState(unknown.stateFile);
  const unknownRetry = await unknown.host.tick(harness.now());

  harness.step({
    title: '回执未知：结算 unknown 一次，不重试、不占额度、不写 sent',
    input: {
      kind: 'presence-qq-delivery-failure',
      note: '合成 OneBot 直接抛传输异常；Humanizer 归类 unknown；随后再 tick 一次',
    },
    expected: {
      status: 'unknown',
      confirmed: false,
      sent: 0,
      accepted: 0,
      pending: 0,
      botCalls: 1,
      journalStatus: 'unknown',
      journalQuota: false,
      ledgerStatus: 'unknown',
      retryStatus: 'idle',
      callsAfterRetry: 1,
      attempted: 1,
      unknownCount: 1,
    },
    actual: {
      status: unknownDelivery?.status ?? '',
      confirmed: unknownDelivery?.confirmed === true,
      sent: unknownDelivery?.sent ?? 0,
      accepted: unknownDelivery?.accepted ?? 0,
      pending: unknownDelivery?.pending ?? -1,
      botCalls: unknown.bot.calls.length,
      journalStatus: unknownJournal?.status ?? '',
      journalQuota: unknownJournal?.quota === true,
      ledgerStatus: ledgerStatuses(unknownState),
      retryStatus: unknownRetry.status,
      callsAfterRetry: unknown.bot.calls.length,
      attempted: unknown.host.stats.adapter?.attempted ?? -1,
      unknownCount: unknown.host.stats.adapter?.unknown ?? -1,
    },
  });

  failed.host.close();
  unknown.host.close();

  return {
    modules: [
      'presence-qq-runtime.js',
      'humanize.js',
      'presence/qq-adapter.js',
      'presence/persistence.js',
    ],
    limitation: 'qq-presence-failure-no-retry-synthetic-offline',
    note: '只证明离线失败结算：failed 与 unknown 都只出队一次、不自动重试；'
      + '真实平台对账仍属 T9。',
    humanizerNote: HUMANIZER_NOTE,
  };
}

/* ══════════════════════ 场景表 ══════════════════════ */

/**
 * 本 checkout 没有 Web presence 宿主路径。
 */
export const C_NOT_COVERED = Object.freeze([
  Object.freeze({
    id: 'C-01',
    gate: 'group',
    status: 'not-covered',
    title: '未覆盖：C-01 Web presence 欢迎/休息',
    reason: 'requires-web-presence-host',
    requires: 'Web presence 宿主/API 路径（本 checkout 没有）',
  }),
  Object.freeze({
    id: 'C-02',
    gate: 'group',
    status: 'not-covered',
    title: '未覆盖：C-02 Web presence 重启恢复',
    reason: 'requires-web-presence-restart',
    requires: 'Web presence 状态文件与重启装配（本 checkout 没有；QQ presence 重启见 C-05）',
  }),
]);

/** C 门可执行场景（顺序固定）。 */
export const C_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'C-03',
    aliases: ['presence-default-off'],
    gate: 'group',
    status: 'covered',
    title: 'C-03 QQ presence 默认关闭：配置缺省即关，不建状态、不发主动消息',
    run: runC03,
  }),
  Object.freeze({
    id: 'C-04',
    aliases: ['presence-delivery'],
    gate: 'group',
    status: 'covered',
    title: 'C-04 开启后投递：经 Humanizer/合成 OneBot；sent/accepted 分离且都占额度',
    run: runC04,
  }),
  Object.freeze({
    id: 'C-05',
    aliases: ['presence-restart-quota', 'C-06'],
    gate: 'group',
    status: 'covered',
    title: 'C-05 重启后额度：日上限/冷却/台账跨重启生效，旧欢迎不补发',
    run: runC05,
  }),
  Object.freeze({
    id: 'C-07',
    aliases: ['presence-quiet-hours'],
    gate: 'group',
    status: 'covered',
    title: 'C-07 安静时段：保留 intent 不发；走出窗口后过期积压不补发',
    run: runC07,
  }),
  Object.freeze({
    id: 'C-08',
    aliases: ['presence-stale-intent'],
    gate: 'group',
    status: 'covered',
    title: 'C-08 过时 intent：owner 一开口即作废；更早 intent 被 stale-after-user-message 拒绝',
    run: runC08,
  }),
  Object.freeze({
    id: 'C-09',
    aliases: ['presence-failure-no-retry'],
    gate: 'group',
    status: 'covered',
    title: 'C-09 失败/未知投递：只结算一次、不自动重试、不写成功台账',
    run: runC09,
  }),
]);
