#!/usr/bin/env node
/**
 * 统一离线校验入口 · node scripts/verify.mjs
 * ─────────────────────────────────────────────────────────────
 * 一条命令跑完「现有离线测试 + 现成自检 + 维护文档结构」。
 * 不联网、不装依赖、不调模型、不读私人配置与真实数据。
 *
 * 设计要点：
 *   1. 测试文件靠**扫描发现**，不写死清单：仓库里任何 *.test.mjs 都会被跑到，
 *      既有的 packages/own-life/test/own-life.test.mjs 因此自动纳入，不需要改动它。
 *   2. **发现失败即 fail closed**：非忽略目录读取失败会报错并让本次校验失败，
 *      不允许"读不到就当没有"。零发现同样算失败。
 *   3. **跳过策略**：全量模式下 skipped/todo/cancelled 必须为 0，某组没有汇总行
 *      或零条目也算失败——否则 test.skip 能让整仓假装全绿。
 *   4. **部分模式**：--only / --skip-check 只用于调试，输出明确标 PARTIAL，
 *      不冒充完整基线。
 *   5. 每个分组单独打印 exit code，失败整组如实报失败，不吞。
 *   6. 结构检查（scripts/check.mjs）与技术测试分开报告。
 *
 * 退出码：0 = 本次范围内的检查全部通过；1 = 有失败。
 * 参数：
 *   --list          只打印发现清单，不执行（发现出错则非零）
 *   --list --help   打印列表用法，不扫描目录（-h 同义）
 *   --json          以 JSON 输出汇总
 *   --skip-check    不跑 scripts/check.mjs（调试；产生 PARTIAL）
 *   --only <目录>   只跑某个分组（调试；产生 PARTIAL）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'data', '.cache', 'coverage']);
/** 本地配置可能含真实密钥，任何时候都不进扫描/发现范围。 */
const SKIP_FILE_PATTERNS = [/\.config\.local\.json$/i, /^config\.local\.json$/i];

/**
 * 收集测试文件，并如实报告读取失败（fail closed 的数据来源）。
 * @param {string} root
 * @param {{fsImpl?: typeof fs}} [options] fsImpl 仅用于测试注入读取失败
 * @returns {{files: string[], errors: Array<{path: string, code: string}>}}
 */
export function collectTestFiles(root = ROOT, { fsImpl = fs } = {}) {
  const files = [];
  const errors = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: path.relative(root, dir).replace(/\\/g, '/') || '.',
        code: String(error?.code || error?.message || error),
      });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (SKIP_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
      if (entry.name.endsWith('.test.mjs')) files.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return { files: files.sort(), errors };
}

/** 只要文件清单（丢弃失败信息；verify/--list 请用 collectTestFiles）。 */
export function discoverTests(root = ROOT) {
  return collectTestFiles(root).files;
}

/** 按所在目录分组：同一目录的测试文件一次 node --test 提交。 */
export function groupTests(files) {
  const groups = new Map();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, groupFiles]) => ({ dir, files: groupFiles.sort() }));
}

/** 从 node --test 的汇总尾部读取 tests/pass/fail/skipped/todo/cancelled。 */
export function parseNodeTestCounts(output) {
  const read = (key) => {
    const m = String(output ?? '').match(new RegExp(`^\\D*${key}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    skipped: read('skipped'),
    todo: read('todo'),
    cancelled: read('cancelled'),
  };
}

/** 从 scripts/check.mjs 的汇总行读取通过/失败/警告计数。 */
export function parseCheckCounts(output) {
  const m = String(output ?? '').match(/通过\s+(\d+)\s+·\s+失败\s+(\d+)\s+·\s+警告\s+(\d+)/);
  return m ? { pass: Number(m[1]), fail: Number(m[2]), warn: Number(m[3]) } : null;
}

function runNode(args, { timeout = 15 * 60 * 1000, cwd = ROOT } = {}) {
  // 去掉 NODE_TEST_CONTEXT：本入口可能在 node --test 内部被调用（自身测试），
  // 继承该变量会让子进程换用另一种输出协议，汇总行不可解析。
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

/** verify 自身依赖的 npm 脚本契约（LoopForge 会检查这一条）。 */
export const REQUIRED_SCRIPTS = { verify: 'node scripts/verify.mjs' };

/**
 * 文档结构检查：只看「引用的东西是否真实存在」，不看内容是否正确。
 * - README.md 与 docs/*.md 的相对链接必须能解析（缺失 = 失败）
 * - 这些文档里 `npm run <x>` 引用的脚本必须存在；不存在的按**既有偏差**列进
 *   staleScripts（不因此失败，也不隐藏：会作为 ⚠️ 明示并进 JSON 结果）
 * @returns {{ok: boolean, problems: string[], warnings: string[], checked: number, files: string[], staleScripts: string[]}}
 */
export function checkDocsStructure(root = ROOT) {
  const problems = [];
  const warnings = [];
  const staleScripts = [];
  let checked = 0;
  const files = [];
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch (error) {
    problems.push('package.json 无法解析：' + (error?.message || error));
  }
  for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
    if (scripts[name] !== command) {
      problems.push(`package.json: scripts.${name} 必须是 "${command}"（实际 ${JSON.stringify(scripts[name])}）`);
    }
  }

  const candidates = ['README.md'];
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) candidates.push('docs/' + entry.name);
    }
  }

  for (const rel of candidates) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      if (rel === 'README.md') problems.push(`${rel}: 文件不存在`);
      continue;
    }
    files.push(rel);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      checked += 1;
      if (!fs.existsSync(path.resolve(path.dirname(file), clean))) {
        problems.push(`${rel}: 链接目标不存在 → ${target}`);
      }
    }
    for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      checked += 1;
      const name = match[1];
      if (!Object.hasOwn(scripts, name)) {
        const note = `${rel}: 文档引用了 package.json 里不存在的脚本 → npm run ${name}`;
        staleScripts.push(note);
        warnings.push(note + '（既有文档偏差，不在本次校验范围修复）');
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings, checked, files, staleScripts };
}

/**
 * 一个分组是否违反跳过策略。返回原因列表（空 = 合规）。
 * 无汇总行 / 零条目在任何模式下都算失败：那说明测试没真的跑起来。
 */
export function skipViolations(counts, { fullMode }) {
  const reasons = [];
  if (!counts || counts.tests === null) {
    reasons.push('没有解析到 node --test 汇总（可能崩溃或被截断），不能当作通过');
    return reasons;
  }
  if (counts.tests === 0) reasons.push('该组 0 条测试条目——零发现/零执行不能算通过');
  if (fullMode) {
    if ((counts.skipped ?? 0) > 0) reasons.push(`skipped=${counts.skipped}（全量模式要求 0）`);
    if ((counts.todo ?? 0) > 0) reasons.push(`todo=${counts.todo}（全量模式要求 0）`);
    if ((counts.cancelled ?? 0) > 0) reasons.push(`cancelled=${counts.cancelled}（全量模式要求 0）`);
  }
  return reasons;
}

/** 汇总并执行全部阶段。 */
export function verify(options = {}) {
  const {
    root = ROOT,
    skipCheck = false,
    only = null,
    log = () => {},
    collect = collectTestFiles,
  } = options;
  const partialReasons = [];
  if (only) partialReasons.push(`只跑了分组 ${only}`);
  if (skipCheck) partialReasons.push('跳过了结构检查 scripts/check.mjs');
  const partial = partialReasons.length > 0;
  const fullMode = !partial;

  const { files, errors } = collect(root);
  const groups = groupTests(files);
  const selected = only ? groups.filter((group) => group.dir === only) : groups;

  const result = {
    root,
    mode: partial ? 'partial' : 'full',
    partial,
    partialReasons,
    discoveredTestFiles: files.length,
    discoveryErrors: errors,
    groups: [],
    check: null,
    docs: null,
    ok: true,
    limitations: [
      '离线校验：不调用真实模型、不发送 QQ/Web 消息、不读私人记忆与本地真实配置。',
      '结构检查（语法/导入/脱敏/文档链接）不等于真实行为验证。',
      partial ? 'PARTIAL：本次不是完整基线，结论不能用于宣称基线通过。' : '全量模式：skipped/todo/cancelled 必须为 0。',
    ],
  };

  if (errors.length) {
    result.ok = false;
    for (const error of errors) log(`❌ 无法读取目录 ${error.path}（${error.code}）——发现阶段 fail closed`);
  }
  if (files.length === 0) {
    result.ok = false;
    result.emptyDiscovery = true;
    log('❌ 没有发现任何 *.test.mjs —— 零发现不能算通过');
    return result;
  }
  if (selected.length === 0) {
    result.ok = false;
    result.emptyDiscovery = true;
    log(`❌ --only ${only} 没有匹配的分组`);
    return result;
  }

  for (const group of selected) {
    log(`\n▸ ${group.dir} （${group.files.length} 个测试文件）`);
    const run = runNode(['--test', ...group.files], { cwd: root });
    const counts = parseNodeTestCounts(run.stdout + run.stderr);
    const violations = skipViolations(counts, { fullMode });
    const passed = run.status === 0 && violations.length === 0;
    if (!passed) result.ok = false;
    result.groups.push({
      dir: group.dir,
      files: group.files,
      fileCount: group.files.length,
      exitCode: run.status,
      signal: run.signal,
      error: run.error,
      counts,
      violations,
      ok: passed,
      tail: (run.stdout.trim().split('\n').slice(-3).join(' | ') || '').slice(0, 300),
    });
    const label = counts.tests === null
      ? '未能解析测试计数（不能当作通过）'
      : `${counts.tests} 条测试，失败 ${counts.fail}，skipped ${counts.skipped}，todo ${counts.todo}`;
    log(`  ${passed ? '✅' : '❌'} exit=${run.status} · ${label}`);
    for (const violation of violations) log(`     ↳ 策略失败：${violation}`);
    if (!passed) log(run.stdout.slice(-4000) + run.stderr.slice(-2000));
  }

  if (!skipCheck) {
    log('\n▸ 结构检查 scripts/check.mjs');
    const run = runNode([path.join(root, 'scripts', 'check.mjs')], { cwd: root });
    const counts = parseCheckCounts(run.stdout);
    const passed = run.status === 0;
    if (!passed) result.ok = false;
    result.check = { exitCode: run.status, counts, ok: passed };
    log(`  ${passed ? '✅' : '❌'} exit=${run.status} · ${counts ? `通过 ${counts.pass} / 失败 ${counts.fail} / 警告 ${counts.warn}` : '未能解析计数（不能当作通过）'}`);
    if (!passed) log(run.stdout.slice(-4000));
  }

  log('\n▸ 维护文档结构');
  const docs = checkDocsStructure(root);
  result.docs = docs;
  for (const warning of docs.warnings) log('  ⚠️  ' + warning);
  if (docs.problems.length) {
    result.ok = false;
    for (const problem of docs.problems) log('  ❌ ' + problem);
  } else {
    log(`  ✅ 已检查 ${docs.files.length} 份文档，${docs.checked} 处链接/命令引用全部存在`);
  }

  return result;
}

function main(argv) {
  const listOnly = argv.includes('--list');
  const json = argv.includes('--json');
  const skipCheck = argv.includes('--skip-check');
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;

  // --only 的后继值可能恰好叫 --list 或 -h；它不是独立的帮助选项。
  const flags = argv.filter((_, i) => onlyIndex < 0 || i !== onlyIndex + 1);
  if (flags.includes('--list') && (flags.includes('--help') || flags.includes('-h'))) {
    console.log('用法：node scripts/verify.mjs --list [--help | -h]\n--list 列出发现的测试文件，不执行测试。带 --help 或 -h 时只显示帮助，不扫描目录。');
    return 0;
  }

  if (listOnly) {
    const { files, errors } = collectTestFiles();
    const groups = groupTests(files);
    console.log(`发现 ${files.length} 个测试文件，分 ${groups.length} 组：`);
    for (const group of groups) {
      console.log(`  ${group.dir}  (${group.files.length})`);
      for (const file of group.files) console.log(`    - ${file}`);
    }
    if (errors.length) {
      for (const error of errors) console.log(`  ❌ 无法读取目录 ${error.path}（${error.code}）`);
      return 1;
    }
    return 0;
  }

  const quiet = json ? () => {} : (line) => console.log(line);
  const result = verify({ skipCheck, only, log: quiet });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const totalTests = result.groups.reduce((sum, group) => sum + (group.counts?.tests ?? 0), 0);
    const totalSkipped = result.groups.reduce((sum, group) => sum + (group.counts?.skipped ?? 0), 0);
    const totalTodo = result.groups.reduce((sum, group) => sum + (group.counts?.todo ?? 0), 0);
    console.log('\n' + '─'.repeat(56));
    if (result.partial) {
      console.log(`  ⚠️  PARTIAL（调试模式）：${result.partialReasons.join('；')}`);
      console.log('      这不是完整基线，不能据此宣称"基线通过"。');
    }
    console.log(`  测试文件 ${result.discoveredTestFiles} 个 · 测试条目 ${totalTests} 条 · skipped ${totalSkipped} · todo ${totalTodo}`);
    if (result.check?.counts) {
      console.log(`  结构检查 通过 ${result.check.counts.pass} / 失败 ${result.check.counts.fail} / 警告 ${result.check.counts.warn}`);
    }
    console.log(result.ok ? (result.partial ? '  ✅ 本次范围通过（PARTIAL）' : '  ✅ verify 通过（全量基线）') : '  ❌ verify 未通过');
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
