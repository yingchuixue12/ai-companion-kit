#!/usr/bin/env node
/**
 * T4 统一离线验收 runner · node scripts/acceptance/run.mjs --offline
 * ─────────────────────────────────────────────────────────────
 * 只跑本 checkout 里真实存在、且能在离线条件下驱动的场景（见 scenarios.mjs）。
 * 退出码：
 *   0 = 已执行范围内的场景全部通过（not-covered 不算通过，也不算失败）
 *   1 = 已执行的场景有失败
 *   2 = 参数错误 / 框架错误（含报告写不出来）
 *
 * 用法：
 *   node scripts/acceptance/run.mjs --offline
 *   node scripts/acceptance/run.mjs --offline --scenario=restart-recovery   （按 id，见 --list）
 *   node scripts/acceptance/run.mjs --offline --scenario=B-09
 *   node scripts/acceptance/run.mjs --offline --json=<file>   （不得指向仓库 data/）
 *   node scripts/acceptance/run.mjs --list
 *
 * 明确不做：不发真实 QQ / OneBot / HTTP，不调真实模型，不读写仓库 data/ 或真实配置。
 * 真实 QQ 的人工验收不归这个 runner 管，见 real-qq-checklist.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE_VERSION,
  DEFAULT_SEED,
  REPO_ROOT,
  captureConsole,
  createHarness,
  isPathInside,
  projectError,
  runScenario,
} from './harness.mjs';
import {
  SCENARIOS,
  bGateIds,
  findScenario,
  listScenarios,
  notCoveredBIds,
} from './scenarios.mjs';

export const EXIT_OK = 0;
export const EXIT_SCENARIO_FAILED = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  '用法：node scripts/acceptance/run.mjs --offline [--scenario=<id>] [--json=<file>] [--list]',
  '',
  '  --offline            必填。只跑离线场景（无网络、无真实模型、无仓库 data/）',
  '  --scenario=<id>      只跑一个场景（id 见 --list）',
  '  --json=<file>        把机读报告写入该文件（UTF-8 无 BOM；不得指向仓库 data/；同时仍打印摘要）',
  '  --list               只列场景表与状态，不执行任何场景',
  '  --help               打印本用法',
  '',
  '退出码：0=已执行范围全通过，1=已执行场景有失败，2=参数/框架错误。',
].join('\n');

/** 模型侧的固定说明：本 runner 从不调用真实模型。 */
const MODEL_NOTE = 'model-transport-synthetic';

/** 仓库里禁止写入的位置：本 runner 声明「不碰仓库 data/」，报告也不例外。 */
const REPO_DATA_DIR = path.join(REPO_ROOT, 'data');

/** 同一路径判断（Windows 大小写不敏感），用于 CLI 直跑判定。 */
function samePath(left, right) {
  const normalize = (value) => {
    const text = path.resolve(String(value));
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  return normalize(left) === normalize(right);
}

/**
 * 报告输出路径的安全校验：拒绝写进仓库 `data/`（真实数据目录）。
 * 其它位置（CI 的 artifacts/、系统临时目录等）由调用方自己负责。
 * @param {string} file
 * @returns {string} 解析后的绝对路径
 */
export function assertSafeReportPath(file) {
  const target = path.resolve(String(file));
  if (isPathInside(REPO_DATA_DIR, target)) {
    throw Object.assign(new Error('unsafe-report-path'), { code: 'unsafe-report-path' });
  }
  return target;
}

/* ───────────────────────── 参数 ───────────────────────── */

/**
 * 解析命令行。只认闭合的几种写法；不认识的参数一律拒绝，
 * 并且**不回显**参数原文（可能夹带 token 或路径）。
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const options = { offline: false, list: false, help: false, scenario: null, jsonFile: null };
  for (const arg of argv) {
    const raw = typeof arg === 'string' ? arg : '';
    if (raw === '--offline') { options.offline = true; continue; }
    if (raw === '--list') { options.list = true; continue; }
    if (raw === '--help' || raw === '-h') { options.help = true; continue; }
    if (raw.startsWith('--scenario=')) {
      const value = raw.slice('--scenario='.length).trim();
      if (value === '') throw Object.assign(new Error('scenario-value-required'), { code: 'scenario-value-required' });
      if (options.scenario !== null) throw Object.assign(new Error('duplicate-argument'), { code: 'duplicate-argument' });
      options.scenario = value;
      continue;
    }
    if (raw === '--scenario') throw Object.assign(new Error('scenario-value-required'), { code: 'scenario-value-required' });
    if (raw.startsWith('--json=')) {
      const value = raw.slice('--json='.length).trim();
      if (value === '') throw Object.assign(new Error('json-path-required'), { code: 'json-path-required' });
      if (options.jsonFile !== null) throw Object.assign(new Error('duplicate-argument'), { code: 'duplicate-argument' });
      options.jsonFile = value;
      continue;
    }
    // 裸 --json 没有路径：明确拒绝，避免把报告糊到 stdout 里冒充文件输出。
    if (raw === '--json') throw Object.assign(new Error('json-path-required'), { code: 'json-path-required' });
    // 真实发送与本 runner 的定位冲突：显式拒绝。
    if (raw === '--send' || raw === '--live' || raw === '--real') {
      throw Object.assign(new Error('send-not-supported'), { code: 'send-not-supported' });
    }
    throw Object.assign(new Error('unknown-argument'), { code: 'unknown-argument' });
  }
  return options;
}

/* ───────────────────────── 报告 ───────────────────────── */

function summarizeScenario(result, registry = SCENARIOS) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const diffCount = steps.reduce((sum, step) => sum + (Array.isArray(step.diff) ? step.diff.length : 0), 0);
  // 用同一张 registry 反查标题：注入 registry（测试/子集运行）时也能追溯到场景名。
  const scenario = findScenario(result.id, registry);
  return {
    id: result.id,
    gate: result.gate ?? scenario?.gate ?? 'b',
    status: result.status,
    ok: result.ok === true,
    title: scenario?.title ?? '',
    stepCount: steps.length,
    diffCount,
    diagnostics: result.diagnostics ?? [],
    steps,
    artifacts: result.artifacts ?? {},
  };
}

/**
 * 组装机读报告。completeBGate 是**算出来的**：只有 B-01…B-18 全部执行且通过才为 true。
 *
 * 两个口径要分清楚（报告里同时给出，避免互相误读）：
 *   - summary.*  这一次**实际执行**的结果（not-covered 只是登记的状态，不计入通过）；
 *   - coverage.* 以**场景表为准**的 B 门覆盖率（分母 18，与这次跑了几个无关）。
 *
 * @param {object} input
 */
export function buildReport({
  results = [],
  registry = SCENARIOS,
  generatedAt = '',
  generatedAtSource = 'harness-virtual-clock',
  seed = DEFAULT_SEED,
  artifacts = {},
} = {}) {
  const scenarios = results.map((result) => summarizeScenario(result, registry));
  const executed = scenarios.filter((item) => item.status !== 'not-covered');
  const failed = executed.filter((item) => item.status !== 'pass');
  const notCovered = scenarios.filter((item) => item.status === 'not-covered');

  const denominators = bGateIds(registry);
  const passedB = executed
    .filter((item) => item.gate === 'b' && item.status === 'pass')
    .map((item) => item.id);
  const passedSet = new Set(passedB);
  const permanentGaps = notCoveredBIds(registry);
  const coveredInRegistry = denominators.filter((id) => !permanentGaps.includes(id));
  const notExecuted = coveredInRegistry.filter((id) => !passedSet.has(id));
  const missingB = denominators.filter((id) => !passedSet.has(id));
  const completeBGate = permanentGaps.length === 0 && notExecuted.length === 0;
  const registryIds = listScenarios(registry).map((scenario) => scenario.id);
  // 整表跑（默认）还是只跑了一个场景：决定 coverage 字段该怎么读。
  const scope = results.length === registryIds.length ? 'full-registry' : 'partial';

  const reasons = [];
  if (permanentGaps.length > 0) {
    reasons.push(permanentGaps.length + ' 个完全没有离线可执行证据（' + permanentGaps.join(' ') + '）');
  }
  if (notExecuted.length > 0) reasons.push('另有 ' + notExecuted.length + ' 个本次未执行');
  if (notCovered.some((item) => item.gate === 'group')) reasons.push('C 组未覆盖');
  const gateReason = completeBGate
    ? 'B 门 ' + denominators.length + ' 项都有可执行证据，且本次全部通过。'
    : 'B 门 ' + denominators.length + ' 项尚未全部有可执行证据：' + reasons.join('；') + '。';

  return {
    version: ACCEPTANCE_VERSION,
    kind: 'offline-acceptance-report',
    mode: 'offline',
    generatedAt,
    // 生成时间来自 harness 虚拟时钟（固定起点），不是真实墙钟：这一条要显式标出来，
    // 否则报告里的时间会被当成"这次真跑的时间"。真实时间由调用方自己记录。
    generatedAtSource,
    seed,
    // 运行环境（追溯用）：同一台机器上同 seed 仍然逐字节一致；跨机器比较时看这里。
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    boundary: {
      network: false,
      realModel: false,
      realQQ: false,
      repoData: false,
      globalFetchTouched: false,
      modelTransport: MODEL_NOTE,
      note: '模型侧是脚本化替身：本 checkout 的 brain.js 直接调用全局 fetch，没有注入点。',
    },
    summary: {
      total: scenarios.length,
      executed: executed.length,
      passed: executed.filter((item) => item.status === 'pass').length,
      failed: failed.length,
      notCovered: notCovered.length,
      // B 门通过数单独给：summary.passed 里还包含 X-01/X-02 这类增补场景。
      bGatePassed: passedB.length,
      coverageDenominator: denominators.length,
      completeBGate,
      ok: failed.length === 0,
    },
    coverage: {
      // 'full-registry' = 本次跑的是整张场景表；'partial' = 只跑了子集（--scenario）。
      scope,
      denominator: denominators.length,
      // 本次通过的 B 门 id（不是"有证据"的总量，后者见 coveredInRegistry）。
      coveredBIds: denominators.filter((id) => passedSet.has(id)),
      // 没有离线可执行证据（永久缺口：依赖缺失的宿主/QQ 集成）
      notCoveredBIds: permanentGaps,
      // 有可执行证据，但这次没跑（例如 --scenario 只跑了一个）
      notExecutedBIds: notExecuted,
      missingBIds: missingB,
      // 非 B 门（X-01/X-02）里本次真正执行过的 id（通过与否都列，失败看 scenarios）。
      extraExecutedIds: executed.filter((item) => item.gate !== 'b').map((item) => item.id),
      groupIds: notCovered.filter((item) => item.gate === 'group').map((item) => item.id),
      gateReason,
    },
    artifacts: { ...artifacts },
    scenarios,
  };
}

/** --list 的文本输出：状态 + id + 标题，顺序同场景表。 */
export function formatList(registry = SCENARIOS) {
  const scenarios = listScenarios(registry);
  const lines = [];
  const covered = scenarios.filter((item) => item.status === 'covered').length;
  lines.push('场景表（' + scenarios.length + ' 项：covered ' + covered
    + ' · not-covered ' + (scenarios.length - covered) + ' · B 门分母 ' + bGateIds(registry).length + '）：');
  for (const scenario of scenarios) {
    const mark = scenario.status === 'covered' ? '[covered]    ' : '[not-covered]';
    const reason = scenario.status === 'covered' ? '' : '  ← ' + (scenario.reason ?? 'unknown');
    lines.push('  ' + mark + ' ' + scenario.id.padEnd(6) + scenario.title + reason);
  }
  lines.push('');
  lines.push('not-covered 不会被当作通过：它们没有可执行证据。真实 QQ 人工验收请用 real-qq-checklist.mjs。');
  return lines.join('\n');
}

/** 人类可读摘要。 */
export function formatHuman(report) {
  const lines = [];
  lines.push('════════ 离线验收 T4 · ' + 'v' + report.version + ' ════════');
  lines.push('  模式      offline（不发网络 / 不调模型 / 不碰仓库 data/）');
  lines.push('  生成时间  ' + report.generatedAt
    + (report.generatedAtSource === 'harness-virtual-clock' ? '（虚拟时钟，非墙钟）' : ''));
  lines.push('  种子      ' + report.seed);
  lines.push('');
  lines.push('▸ 执行结果');
  for (const scenario of report.scenarios) {
    if (scenario.status === 'not-covered') continue;
    const mark = scenario.status === 'pass' ? '✅' : '❌';
    const code = scenario.status === 'pass'
      ? ''
      : '  ← ' + scenario.diagnostics.map((item) => item.code + (item.detail ? ':' + item.detail : '')).join(',');
    lines.push('  ' + mark + ' ' + scenario.id.padEnd(6) + 'steps ' + String(scenario.stepCount).padStart(2, ' ')
      + ' · diff ' + scenario.diffCount + code);
  }
  if (report.summary.executed === 0) {
    lines.push('  （没有执行任何场景：选中的场景是 not-covered）');
  }
  const notCovered = report.scenarios.filter((scenario) => scenario.status === 'not-covered');
  lines.push('');
  lines.push('▸ 未覆盖（not-covered，不是通过）');
  for (const scenario of notCovered) {
    const reason = scenario.diagnostics.find((item) => item.code === 'not-covered')?.detail;
    lines.push('  ⚪ ' + scenario.id.padEnd(6) + scenario.title + (reason ? '  ← ' + reason : ''));
  }
  lines.push('');
  lines.push('─'.repeat(58));
  lines.push('  通过 ' + report.summary.passed + '（B 门 ' + report.summary.bGatePassed
    + ' · 增补 ' + (report.summary.passed - report.summary.bGatePassed) + '）'
    + ' · 失败 ' + report.summary.failed
    + ' · 未覆盖 ' + report.summary.notCovered + ' · B 门分母 ' + report.summary.coverageDenominator);
  lines.push('  B 门证据 ' + report.coverage.coveredBIds.length + '/' + report.coverage.denominator
    + '（永久缺口 ' + report.coverage.notCoveredBIds.length
    + ' · 本次未执行 ' + report.coverage.notExecutedBIds.length
    + ' · 口径 ' + report.coverage.scope + '）');
  lines.push('  completeBGate: ' + (report.summary.completeBGate ? 'true' : 'false'));
  lines.push('  ' + report.coverage.gateReason);
  if (report.summary.failed > 0) lines.push('  ❌ 已执行的场景有失败');
  else if (report.summary.executed > 0) lines.push('  ✅ 已执行范围全通过（未覆盖项不计入通过）');
  return lines.join('\n');
}

/* ───────────────────────── 主流程 ───────────────────────── */

/**
 * 跑一次验收。
 * @param {string[]} argv
 * @param {object} [overrides] 注入点（测试用）：registry / harnessFactory / scenarioRunner / log
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = [], overrides = {}) {
  const {
    registry = SCENARIOS,
    harnessFactory = createHarness,
    scenarioRunner = runScenario,
    log = (line) => process.stdout.write(String(line) + '\n'),
    harnessOptions = {},
  } = overrides;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log('[参数错误] ' + projectError(error).code);
    log(USAGE);
    return EXIT_USAGE;
  }

  if (options.help) {
    log(USAGE);
    return EXIT_OK;
  }
  if (options.list) {
    log(formatList(registry));
    return EXIT_OK;
  }
  if (!options.offline) {
    log('[参数错误] offline-required');
    log(USAGE);
    return EXIT_USAGE;
  }

  /**
   * 默认跑整张场景表：covered 的真跑，not-covered 的只登记状态，
   * 这样摘要里的「未覆盖列表」才是完整事实（不是「没列出来 = 通过」）。
   * @type {string[]}
   */
  const targets = [];
  if (options.scenario !== null) {
    const found = findScenario(options.scenario, registry);
    if (!found) {
      log('[参数错误] unknown-scenario');
      log(USAGE);
      return EXIT_USAGE;
    }
    targets.push(found.id);
  } else {
    for (const scenario of listScenarios(registry)) targets.push(scenario.id);
  }

  const harness = harnessFactory({ seed: DEFAULT_SEED, ...harnessOptions });
  const results = [];
  let generatedAt = '';
  // 产品代码里的 console 输出（handleTurn 会打印发送摘要）不该污染报告；
  // 只在执行期接管，并在 finally 里无条件还原。
  const consoleCapture = captureConsole();
  const originalLog = log;
  try {
    generatedAt = typeof harness.isoNow === 'function' ? harness.isoNow() : '';
    for (const id of targets) {
      try {
        results.push(await scenarioRunner(id, { harness, registry }));
      } catch (error) {
        // 框架级异常：同样只留闭合码，不写异常文本。
        results.push({
          id,
          ok: false,
          status: 'error',
          gate: findScenario(id, registry)?.gate ?? 'b',
          steps: [],
          diagnostics: [projectError(error)],
          artifacts: {},
        });
      }
    }
  } finally {
    consoleCapture.restore();
    harness.cleanup?.();
  }
  // 产品日志只留条数，正文不进报告（正文是合成内容，但也没必要留）。
  const productLogLines = consoleCapture.lines.length;

  const report = buildReport({
    results,
    registry,
    generatedAt,
    generatedAtSource: harness.injections?.now === 'injected'
      ? 'harness-injected-clock'
      : 'harness-virtual-clock',
    seed: harness.seed ?? DEFAULT_SEED,
    // 产品日志只留条数，正文不进报告（正文是合成内容，但也没必要留）。
    artifacts: { productLogLines },
  });

  if (options.jsonFile !== null) {
    let target = '';
    try {
      // 报告可以写进 CI 的 artifacts/ 或临时目录，但不许写进仓库 data/。
      target = assertSafeReportPath(options.jsonFile);
    } catch (error) {
      originalLog('[参数错误] ' + projectError(error).code);
      return EXIT_USAGE;
    }
    try {
      fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
      originalLog('[报告] 已写入 ' + target);
    } catch {
      originalLog('[框架错误] report-write-failed');
      return EXIT_USAGE;
    }
  }

  originalLog(formatHuman(report));
  return report.summary.failed === 0 ? EXIT_OK : EXIT_SCENARIO_FAILED;
}

/* ───────────────────────── CLI 入口 ───────────────────────── */

const invokedDirectly = process.argv[1]
  && samePath(process.argv[1], fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = EXIT_USAGE; },
  );
}
