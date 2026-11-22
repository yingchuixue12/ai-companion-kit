#!/usr/bin/env node
/**
 * 真实 QQ 人工验收清单 · node scripts/acceptance/real-qq-checklist.mjs
 * ─────────────────────────────────────────────────────────────
 * 这是一个**清单打印器**，不是 runner，也不是验收证据本身：
 *
 *   - 只支持 `--dry-run`（默认行为，写不写都一样）和 `--json`；
 *   - `--send` 被**显式拒绝**（退出码 2）——这里没有任何发送实现；
 *   - 不读 data/、不读 config、不读记忆/日志、不联网、不调模型；
 *   - 只输出 `<RECIPIENT>` / `<MESSAGE>` / `<EVIDENCE_REF>` 占位符，以及人工
 *     记录字段、停止条件、授权项；真实账号、消息正文一律由执行人现场填，不落盘。
 *
 * ── 范围（真实渠道 owner 私聊验收）────────────────────────────
 *   只覆盖 **owner 私聊**这一条通道：执行人用自己（或明确授权）的 owner 私聊，
 *   看回复、看提醒、看重启行为。
 *
 *   群聊是**永久排除项**，本清单：
 *     - 不提供任何"进群 / 在群里发消息 / @ 一次"的操作步骤；
 *     - 只把"群聊入口必须被拒绝"记为一条**边界声明**（R-07），确认方式是
 *       "本轮全程没做群操作" + 离线证据，而不是去真实群里跑一遍；
 *     - 不要求任何人因为"群"而额外知情或参与。
 *
 *   记忆的落盘正确性**不用**本清单验收：清单不要求打开落盘账本、记忆文件或
 *   日志正文，只用 owner 私聊里**可观察到的回复表现**判断"像不像记得"，落盘
 *   本身以离线场景在临时目录里的证据为准。
 *
 * ── 两个容易混淆的 "sends" ──────────────────────────────────
 *   boundary.sends        清单打印器**自身**会不会发消息：恒为 0（没有任何发送实现）。
 *   steps[].humanActionSends  **人工执行人**在这一步是否需要往 QQ 发一条消息；
 *                         只有 owner 私聊的步骤可以为 true，"不做操作"的步骤必须 false。
 *
 * 为什么单独一个文件：真实 QQ 验收必须由人盯着做（账号、频率、内容都不可自动
 * 断言），所以它不进 run.mjs 的离线验收，也不伪装成自动化通过。
 *
 * 退出码：0 = 正常打印清单；2 = 参数不被支持（含 --send）/ 未知参数。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 3;

/** 占位符：任何真实账号 / 正文 / 证据位置都不出现在本文件与输出里。 */
export const PLACEHOLDERS = Object.freeze({
  recipient: '<RECIPIENT>',
  message: '<MESSAGE>',
  evidenceRef: '<EVIDENCE_REF>',
});

const RECIPIENT = PLACEHOLDERS.recipient;
const MESSAGE = PLACEHOLDERS.message;

/**
 * 清单的范围声明（机读）。测试会锁死这几项：
 *   - 只做 owner 私聊；
 *   - 群聊是永久排除项，不提供任何群操作；
 *   - 不通过查阅落盘账本 / 日志正文来验收。
 */
const SCOPE = Object.freeze({
  channel: 'owner-private',
  channelsAllowed: ['owner-private', 'none'],
  excluded: ['group-chat'],
  groupOps: false,
  ledgerInspection: false,
  note: '只覆盖 owner 私聊。群聊永久排除：不提供进群/群内发言/@ 的操作，只声明"必须拒绝"。',
  humanActionSendsNote: 'steps[].humanActionSends 只描述"人工执行人是否需要发一条 QQ 消息"；'
    + '清单自身不会发送任何东西（boundary.sends 恒为 0）。',
  recordNote: 'steps[].record 是 {field, expected} 数组：expected 为 null 表示"只记录观察值"，'
    + '非 null 表示硬性期望，必须相等才算 pass。',
});

const USAGE = [
  '用法：node scripts/acceptance/real-qq-checklist.mjs [--dry-run] [--json]',
  '',
  '  --dry-run   打印人工验收清单（默认，就是这个行为）',
  '  --json      以 JSON 输出同一份清单',
  '  --help      打印本用法',
  '',
  '范围：只做 owner 私聊。群聊是永久排除项，清单不提供任何群操作。',
  '不支持 --send：本工具没有发送能力，也不会读真实配置或 data/。',
  '退出码：0=正常打印，2=参数不被支持。',
].join('\n');

/** 前置条件：任何一条不满足就停，不要"先跑起来再说"。 */
const PRECONDITIONS = [
  '只做 owner 私聊：把 <RECIPIENT> 设成 owner 自己的私聊会话（本人或明确授权者）。',
  '群聊是永久排除项：本轮不加入任何群、不打开任何群、不在任何群里发消息。',
  'OneBot / 桥接只监听本机回环地址，且已确认没有对外暴露。',
  '白名单只放 <RECIPIENT> 这一个 owner，不放任何群会话。',
  '先在离线验收里跑通 run.mjs --offline，确认基线是绿的。',
  '准备记录介质；记录里不写真实账号、正文成段内容或任何密钥。',
];

/**
 * 清单正体。每条都能在现场用眼睛判定，并且都被一条"停止条件"兜住。
 *
 * 每条都带机读标记，测试据此锁死范围：
 *   channel           'owner-private' | 'none' —— 这一步发生在哪条通道
 *   humanActionSends  人工执行人是否要发一条 QQ 消息 —— 只有 owner 私聊可为 true
 *   readsData         是否需要打开落盘账本/日志正文 —— 恒为 false
 *   record            [{field, expected}]，expected=null 表示只记录不判定
 */
const STEPS = [
  {
    id: 'R-01',
    title: '启动前自检（干跑）',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '以 --dry-run 启动宿主，然后在 ' + RECIPIENT + ' 的私聊里发一条 ' + MESSAGE + '（内容随机的短句）。',
    expect: '控制台只出现「干跑」字样与拟回复内容；owner 侧**收不到任何消息**。',
    record: [
      { field: 'startedAt', expected: null },
      { field: 'dryRunOutputHash', expected: null },
      { field: 'sideReceivedAny', expected: false },
    ],
  },
  {
    id: 'R-02',
    title: 'owner 私聊一问一答',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '关掉干跑，重启宿主，在 ' + RECIPIENT + ' 的私聊里发一条 ' + MESSAGE + '。',
    expect: '回复条数 1~4 且内容相关；没有客服腔；没有 Markdown 分点。',
    record: [
      { field: 'sentAt', expected: null },
      { field: 'observedAt', expected: null },
      { field: 'partCount', expected: null },
      { field: 'replySummary', expected: null },
      { field: 'styleVerdict', expected: null },
    ],
  },
  {
    id: 'R-03',
    title: '连发三条只回一轮',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '在 ' + RECIPIENT + ' 的私聊里连续发 3 条 ' + MESSAGE + '（同一话题，间隔 1 秒内）。',
    expect: '只触发一轮生成，回复里体现三条的**先后顺序**，不逐条追回复。',
    record: [
      { field: 'observedAt', expected: null },
      { field: 'inboundCount', expected: 3 },
      { field: 'generationCount', expected: 1 },
      { field: 'orderPreserved', expected: true },
    ],
  },
  {
    id: 'R-04',
    title: '提醒创建与到期回执',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '在 ' + RECIPIENT + ' 的私聊里发「1分钟后提醒我' + MESSAGE + '」，等 1 分钟。',
    expect: '创建后有一条确认；到期**只**提醒一次；正文与 ' + MESSAGE + ' 一致。',
    record: [
      { field: 'createdAt', expected: null },
      { field: 'dueAt', expected: null },
      { field: 'firedAt', expected: null },
      { field: 'fireCount', expected: 1 },
      { field: 'textMatched', expected: true },
    ],
  },
  {
    id: 'R-05',
    title: '重启后不重发',
    channel: 'owner-private',
    humanActionSends: false,
    readsData: false,
    action: '在提醒发送后的 10 秒内重启宿主，在 ' + RECIPIENT + ' 的私聊里观察 2 分钟（不额外发消息）。',
    expect: '已发过的提醒不重发；未到期的仍然按时发；发送中的保持沉默。',
    record: [
      { field: 'restartAt', expected: null },
      { field: 'observedUntil', expected: null },
      { field: 'resendCount', expected: 0 },
      { field: 'missedCount', expected: 0 },
    ],
  },
  {
    id: 'R-06',
    title: '投递未确认不重发',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '用桥接断线/限流制造一次发送失败（例如临时断开回环端口），在 ' + RECIPIENT
      + ' 的私聊里再发一条 ' + MESSAGE + '，只看宿主终端打印的固定错误码。',
    expect: '只出现固定错误码（如 delivery-unconfirmed）；不重试、不补发、不刷屏。',
    record: [
      { field: 'observedAt', expected: null },
      { field: 'errorCode', expected: null },
      { field: 'retryCount', expected: 0 },
      { field: 'manualRetry', expected: false },
    ],
  },
  {
    id: 'R-07',
    title: '群聊边界：不执行，只确认"本轮没有群操作"',
    channel: 'none',
    humanActionSends: false,
    readsData: false,
    action: '本步**不做任何操作**：不打开群、不在群里发消息、不把任何群会话加入白名单。'
      + '只回头确认整轮验收确实没有发生群操作。',
    expect: '群聊是项目层面的永久排除项（范围决策，不声称已存在代码级群聊闸门）。'
      + '本步只用"人工不动作声明 + 离线证据（run.mjs 的场景表与 boundary 字段）"确认本轮没有群操作；'
      + '**不要**为了验证这条去真实群里发消息或 @ 一次。',
    record: [
      { field: 'confirmedAt', expected: null },
      { field: 'joinedAnyGroup', expected: false },
      { field: 'groupMessagesSent', expected: 0 },
      { field: 'offlineEvidenceRef', expected: PLACEHOLDERS.evidenceRef },
    ],
  },
  {
    id: 'R-08',
    title: '记忆效果：只看 owner 私聊里可观察到的表现',
    channel: 'owner-private',
    humanActionSends: true,
    readsData: false,
    action: '在 ' + RECIPIENT + ' 的私聊里先说一件事（例如 ' + MESSAGE + '），隔几轮再提一次相关话题；'
      + '只看对话里 AI 是否自然体现出"记得"。**不要**打开落盘账本、记忆文件或日志正文。',
    expect: '私聊回复里能自然体现出前文信息（或明确承认不确定）。落盘正确性不靠本清单验收：'
      + '本清单不查阅任何落盘账本/日志，落盘结论以离线场景在临时目录里的证据为准。',
    record: [
      { field: 'observedAt', expected: null },
      { field: 'privateRecallObserved', expected: true },
      { field: 'ledgerOpened', expected: false },
      { field: 'logBodyRead', expected: false },
    ],
  },
  {
    id: 'R-09',
    title: '清理与收尾',
    channel: 'none',
    humanActionSends: false,
    readsData: false,
    action: '停止宿主，结束本轮验收。临时落盘交给宿主自己的清理策略；'
      + '不要为了"确认"去翻账本或日志正文。',
    expect: '无残留进程、无外发连接、owner 可安全结束本轮。',
    record: [
      { field: 'stoppedAt', expected: null },
      { field: 'processesLeft', expected: 0 },
      { field: 'authorizationReleased', expected: true },
    ],
  },
];

/** 人工记录字段：每条结论都必须能落到这些字段上，才叫"有证据"。 */
const MANUAL_RECORD_FIELDS = [
  'stepId：对应的清单编号（R-01…R-09）',
  'observedAt：现场观察时间（本地时区，精确到分钟）',
  'observedBy：执行人（不要写真实姓名，写代号即可）',
  'attempt：第几次尝试（失败重试要保留每一次）',
  'expected / actual：期望与实际，各写一句；expected 为 null 的字段只记录观察值',
  'evidenceRef：截图或终端输出的位置（只写位置，不要把正文整段贴进来）',
  'verdict：pass / fail / blocked（blocked 必须写原因）',
];

/** 停止条件：命中任何一条就立刻停手，不要"再试一下看看"。 */
const STOP_CONDITIONS = [
  '任何一步要求你进入群聊、在群里发消息、或把群会话加入白名单。',
  '任何消息发到了 <RECIPIENT> 之外的会话（含自己的主号、其他好友、任何群）。',
  '为了"确认记忆"或"排查问题"去打开落盘账本、记忆文件或日志正文。',
  '同一条提醒或同一轮回复被重复发送超过 1 次。',
  '投递错误之后出现自动重试或补发。',
  '终端输出、截图或记录里出现真实密码、access token、完整账号或成段私密正文。',
  '宿主开始对外发起连接，或桥接端口出现在非回环地址上。',
  '进程残留或授权没撤回。',
];

/** 授权项：没有这些授权就不该开始。 */
const AUTHORIZATIONS = [
  'owner（<RECIPIENT> 的所有者）本人明确同意用它做本轮验收。',
  '同意本轮**只做私聊**，不做任何群操作（不加入、不打开、不在群里发言）。',
  '同意"发现问题就停"，不在现场顺手改产品源码。',
  '如果涉及真实对话内容，仅在本轮记录里使用，不外传、不截图到公开渠道。',
  '同意记录里不写入真实账号、密钥或成段正文。',
];

/* ──────────── 群操作反向扫描（供测试与本文件自检复用）──────────── */

/**
 * 群相关词：命中即说明这句话"提到了群或被 @ 的动作"。
 * `群` 单独出现也算，因为中文里"群里 / 群聊 / 群消息 / 群会话 / 建群"都可能省字。
 */
const GROUP_TOKENS = /(群聊|群组|群消息|群会话|群里|群|被\s*@|@)/u;

/**
 * 明确的"禁止 / 不动作 / 排除"标记。只有带这类标记的分句才算合法说明，
 * 其余提到群的分句一律当作**正向群操作**。
 */
const PROHIBITION_MARKERS = /(不要|不得|不准|禁止|不能|无需|不需要|不做|不加入|不打开|不在|不把|不提供|不声称|不会|不要求|不进入|不放|不查|不翻|没有|无任何|永久排除|排除项|必须被拒绝|no-op)/u;

/**
 * 把一段说明拆成可判定的分句。
 * 除了句读，还要在转折/并列连词（而 / 但 / 却 / 然而）处再切一刀：
 * 否则"不要只在私聊直接去群里发一条"这类整句会被前半个禁止词带着一起放行。
 */
function splitClauses(text) {
  const coarse = String(text ?? '').split(/[。；;！？!?\n，,：:]/u);
  const clauses = [];
  for (const piece of coarse) {
    for (const part of piece.split(/而|但|却|然而/u)) {
      const clause = part.trim();
      if (clause) clauses.push(clause);
    }
  }
  return clauses;
}

/**
 * 找出文本里"正向群操作"的分句。
 *
 * 判定规则：分句里出现群/被 @ 词，且**没有**任何禁止/排除标记 → 视为正向群操作。
 * 因此"不要…群里发消息"、"本步不做任何操作"、"群聊是永久排除项"、"必须被拒绝"
 * 都合法；"在群里发一条消息"、"去群里说一句"、"把群会话加入白名单" 都会被命中。
 *
 * 这是**启发式**静态检查（配合人工复核），不是形式化证明：它只保证"没有明显
 * 的正向群操作措辞"，不保证语义上绝对无法被误读。
 *
 * @param {string} text
 * @returns {string[]} 命中的分句（空数组 = 干净）
 */
export function findPositiveGroupActions(text) {
  const hits = [];
  for (const clause of splitClauses(text)) {
    if (!GROUP_TOKENS.test(clause)) continue;
    if (PROHIBITION_MARKERS.test(clause)) continue;
    hits.push(clause);
  }
  return hits;
}

/** record 条目归一化：字符串 → {field, expected:null}；对象原样收窄。 */
function normalizeRecordEntry(entry) {
  if (typeof entry === 'string') return { field: entry, expected: null };
  const field = typeof entry?.field === 'string' ? entry.field : '';
  return { field, expected: entry?.expected === undefined ? null : entry.expected };
}

/**
 * 组装清单（纯数据，便于 --json 与测试直接断言）。
 * @returns {object}
 */
export function buildChecklist() {
  return {
    version: VERSION,
    kind: 'real-qq-checklist',
    mode: 'dry-run',
    runner: 'manual',
    scope: {
      ...SCOPE,
      channelsAllowed: [...SCOPE.channelsAllowed],
      excluded: [...SCOPE.excluded],
    },
    boundary: {
      network: false,
      reads: {
        repoData: false,
        config: false,
        memory: false,
        memoryFiles: false,
        ledger: false,
        logBody: false,
        logs: false,
      },
      // 清单自身永不发送；执行人是否发送看 steps[].humanActionSends。
      sends: 0,
      sendsMeaning: 'checklist-itself',
      humanActionSendsMeaning: 'step-operator-action',
      placeholdersOnly: true,
      note: '只打印清单：不发送、不读取、不联网。真实结论必须由人现场记录。',
    },
    placeholders: { ...PLACEHOLDERS },
    preconditions: [...PRECONDITIONS],
    steps: STEPS.map((step) => ({
      id: step.id,
      title: step.title,
      channel: step.channel,
      // 人工执行人是否需要发一条 QQ 消息（与清单自身的 boundary.sends=0 无关）。
      humanActionSends: step.humanActionSends === true,
      readsData: step.readsData === true,
      action: step.action,
      expect: step.expect,
      record: step.record.map(normalizeRecordEntry),
      fields: [...MANUAL_RECORD_FIELDS],
    })),
    manualRecordFields: [...MANUAL_RECORD_FIELDS],
    stopConditions: [...STOP_CONDITIONS],
    authorizations: [...AUTHORIZATIONS],
    notAutomated: [
      'C/D/E 组与 B 门里依赖真实宿主的项（B-03/04/05/07/08/12/14/15/18）没有离线可执行证据，'
        + '只能靠人工确认；在此之前 completeBGate 必须保持 false。',
      '群聊永久排除（范围决策）：本清单不提供任何群操作，也不声称代码里有群聊闸门；'
        + '该边界只用离线证据 + 人工不动作声明确认。',
      '记忆落盘正确性不靠本清单：清单不查阅落盘账本/日志正文，只观察 owner 私聊里的回复表现。',
    ],
  };
}

/** 人类可读版本。 */
export function formatChecklist(checklist = buildChecklist()) {
  const lines = [];
  const renderRecord = (entry) => {
    const record = normalizeRecordEntry(entry);
    return record.expected === null ? record.field : record.field + '=' + String(record.expected);
  };
  lines.push('════════ 真实 QQ 人工验收清单 · ' + checklist.kind + ' v' + checklist.version + ' ════════');
  lines.push('  模式      ' + checklist.mode + '（不发送 / 不读取 / 不联网）');
  lines.push('  范围      ' + checklist.scope.channel + '（群聊永久排除：'
    + checklist.scope.excluded.join(' / ') + '）');
  lines.push('  占位符    ' + PLACEHOLDERS.recipient + '  ' + PLACEHOLDERS.message + '  '
    + PLACEHOLDERS.evidenceRef + '  —— 现场自己替换，不要写进任何文件');
  lines.push('');
  lines.push('▸ 前置条件（任何一条不满足就先停）');
  for (const item of checklist.preconditions) lines.push('  · ' + item);
  lines.push('');
  lines.push('▸ 步骤（"需要执行人发消息"只表示人工动作，清单自身不会发送）');
  for (const step of checklist.steps) {
    const marks = [];
    if (step.humanActionSends) marks.push('执行人需发消息');
    if (step.channel === 'none') marks.push('不做操作');
    lines.push('  [' + step.id + '] ' + step.title + (marks.length ? '（' + marks.join('，') + '）' : ''));
    lines.push('      做：' + step.action);
    lines.push('      看：' + step.expect);
    lines.push('      记：' + step.record.map(renderRecord).join(' / '));
  }
  lines.push('');
  lines.push('▸ 人工记录字段（每条结论都要落在这里）');
  for (const field of checklist.manualRecordFields) lines.push('  · ' + field);
  lines.push('');
  lines.push('▸ 停止条件（命中就停手）');
  for (const item of checklist.stopConditions) lines.push('  · ' + item);
  lines.push('');
  lines.push('▸ 需要先拿到的授权');
  for (const item of checklist.authorizations) lines.push('  · ' + item);
  lines.push('');
  lines.push('▸ 边界说明');
  for (const item of checklist.notAutomated) lines.push('  · ' + item);
  lines.push('');
  lines.push('─'.repeat(58));
  lines.push('  本清单不产生通过结论：跑完请人工填写 record 字段并存档。');
  return lines.join('\n');
}

/**
 * 解析参数。只认 --dry-run / --json / --help；--send 显式拒绝。
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const options = { dryRun: true, json: false, help: false, refused: null };
  for (const arg of argv) {
    const raw = typeof arg === 'string' ? arg : '';
    if (raw === '--dry-run') { options.dryRun = true; continue; }
    if (raw === '--json') { options.json = true; continue; }
    if (raw === '--help' || raw === '-h') { options.help = true; continue; }
    // 只有这一个"危险"参数需要单独讲清：本工具没有发送实现。
    // 不提前 return：--json 出现在 --send 之后时也要按 JSON 输出。
    if (raw === '--send' || raw === '--live' || raw === '--real') {
      if (options.refused === null) options.refused = 'send-not-supported';
      continue;
    }
    if (options.refused === null) options.refused = 'unknown-argument';
  }
  return options;
}

/**
 * CLI 主流程（同步）。
 * @param {string[]} argv
 * @param {{log?: (line: string) => void}} [io]
 * @returns {number} 退出码
 */
export function main(argv = [], io = {}) {
  const log = typeof io.log === 'function' ? io.log : (line) => process.stdout.write(String(line) + '\n');
  const options = parseArgs(argv);

  if (options.refused !== null) {
    const message = options.refused === 'send-not-supported'
      ? '本工具不支持 --send：没有任何发送实现，也不会读取真实配置。真实发送必须由人自己执行。'
      : '本工具只支持 --dry-run / --json / --help。';
    if (options.json) {
      log(JSON.stringify({
        version: VERSION,
        kind: 'real-qq-checklist',
        ok: false,
        error: options.refused,
        sends: 0,
        message,
      }, null, 2));
    } else {
      log('[拒绝] ' + message);
    }
    return 2;
  }

  if (options.help) {
    log(USAGE);
    return 0;
  }

  if (options.json) {
    log(JSON.stringify(buildChecklist(), null, 2));
    return 0;
  }

  log(formatChecklist());
  return 0;
}

/* ───────────────────────── CLI 入口 ───────────────────────── */

/** 同一路径判断（Windows 大小写不敏感）：Git Bash / 小写盘符下也能命中直跑分支。 */
function samePath(left, right) {
  const normalize = (value) => {
    const text = path.resolve(String(value));
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  return normalize(left) === normalize(right);
}

const invokedDirectly = process.argv[1]
  && samePath(process.argv[1], fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
