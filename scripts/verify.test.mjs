/**
 * 统一入口与 CI 配置自身的回归测试。
 *
 * 这里只断言**机制**（发现、fail closed、跳过策略、工作流结构），不跑完整
 * `npm run verify`（那会递归调用自身）。CI 配置的断言属于结构检查：只证明
 * 工作流文件写了什么，不证明 GitHub 上真的跑过，也不证明分支保护已开启。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectTestFiles,
  discoverTests,
  groupTests,
  parseNodeTestCounts,
  parseCheckCounts,
  checkDocsStructure,
  skipViolations,
  verify,
} from './verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const readWorkflow = () => fs.readFileSync(WORKFLOW, 'utf8');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 发现机制 ───────────────────────────────────────────────────
test('仓库内发现全部测试文件，含既有测试与本测试自身', () => {
  const { files, errors } = collectTestFiles(ROOT);
  assert.deepEqual(errors, [], '当前仓库不应有读取失败');
  assert.ok(files.includes('packages/own-life/test/own-life.test.mjs'), '既有 own-life 测试必须被发现');
  assert.ok(files.includes('scripts/verify.test.mjs'), '应发现自己这个测试文件');
  assert.deepEqual([...files].sort(), files, '发现结果应稳定排序');
  assert.deepEqual(discoverTests(ROOT), files, 'discoverTests 是同一份清单的便捷包装');
});

test('新增测试文件会被动态发现（无固定清单）', (t) => {
  const dir = tempDir(t, 'verify-discover-');
  fs.mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nested', 'deep', 'brand-new.test.mjs'), '// stub\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'nested', 'deep', 'ignored.mjs'), '// stub\n', 'utf8');

  const files = discoverTests(dir);
  assert.deepEqual(files, ['nested/deep/brand-new.test.mjs']);
  assert.deepEqual(groupTests(files).map((group) => group.dir), ['nested/deep']);
});

test('node_modules / data / 本地配置不会进入发现范围', (t) => {
  const dir = tempDir(t, 'verify-skip-');
  for (const rel of ['node_modules/pkg/x.test.mjs', 'data/x.test.mjs', 'real/keep.test.mjs']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '// stub\n', 'utf8');
  }
  assert.deepEqual(discoverTests(dir), ['real/keep.test.mjs']);
});

test('非忽略目录读取失败必须上报（fail closed），不是静默漏测', (t) => {
  const dir = tempDir(t, 'verify-readfail-');
  fs.mkdirSync(path.join(dir, 'ok'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ok', 'fine.test.mjs'), '// stub\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'locked'), { recursive: true });

  const fakeFs = Object.create(fs);
  fakeFs.readdirSync = (target, options) => {
    if (path.basename(String(target)) === 'locked') {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return fs.readdirSync(target, options);
  };

  const { files, errors } = collectTestFiles(dir, { fsImpl: fakeFs });
  assert.deepEqual(files, ['ok/fine.test.mjs'], '能读的部分仍要发现');
  assert.equal(errors.length, 1, '读取失败必须被记录');
  assert.equal(errors[0].path, 'locked');
  assert.equal(errors[0].code, 'EACCES');

  const result = verify({
    root: dir,
    log: () => {},
    collect: (root) => collectTestFiles(root, { fsImpl: fakeFs }),
  });
  assert.equal(result.ok, false, '发现阶段有错误时 verify 必须失败');
  assert.equal(result.discoveryErrors.length, 1);
});

test('零发现不能让 verify 通过', (t) => {
  const dir = tempDir(t, 'verify-empty-');
  const result = verify({ root: dir, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.emptyDiscovery, true);
});

// ── 跳过策略 ───────────────────────────────────────────────────
test('跳过策略：全量模式要求 skipped/todo/cancelled 为 0', () => {
  const clean = { tests: 5, pass: 5, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  assert.deepEqual(skipViolations(clean, { fullMode: true }), []);
  assert.ok(skipViolations({ ...clean, skipped: 1 }, { fullMode: true }).some((r) => r.includes('skipped=1')));
  assert.ok(skipViolations({ ...clean, todo: 1 }, { fullMode: true }).some((r) => r.includes('todo=1')));
  assert.ok(skipViolations({ ...clean, cancelled: 1 }, { fullMode: true }).some((r) => r.includes('cancelled=1')));
  // 调试（partial）模式只报不判
  assert.deepEqual(skipViolations({ ...clean, skipped: 2 }, { fullMode: false }), []);
  // 零条目与无汇总永远算失败
  assert.ok(skipViolations({ ...clean, tests: 0 }, { fullMode: false }).some((r) => r.includes('0 条测试条目')));
  assert.ok(skipViolations({ tests: null }, { fullMode: true }).some((r) => r.includes('没有解析到')));
});

test('真实临时 skip 用例会让全量分组判失败（不是只改文案）', (t) => {
  const dir = tempDir(t, 'verify-skip-drill-');
  const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
  const write = (body) => fs.writeFileSync(path.join(dir, 'sample.test.mjs'), header + body, 'utf8');

  write("test('passes', () => { assert.equal(1, 1); });\n");
  const control = verify({ root: dir, skipCheck: true, log: () => {} });
  const controlGroup = control.groups.find((group) => group.dir === '.');
  assert.ok(controlGroup, '应发现根目录分组');
  assert.deepEqual(controlGroup.violations, [], '对照不应有策略失败');
  assert.equal(control.mode, 'partial', '--skip-check 必须标 PARTIAL');

  write("test('passes', () => { assert.equal(1, 1); });\ntest.skip('skipped one', () => {});\n");
  const drilledFull = verify({ root: dir, log: () => {} });
  const fullGroup = drilledFull.groups.find((group) => group.dir === '.');
  assert.equal(drilledFull.mode, 'full');
  assert.equal(fullGroup.counts.skipped, 1, '应解析出 skipped=1');
  assert.ok(fullGroup.violations.some((reason) => reason.includes('skipped=1')), '全量模式必须因 skip 判失败');
  assert.equal(fullGroup.ok, false, '该分组不能算通过');
  assert.equal(drilledFull.ok, false, '整体不能通过');
});

test('计数解析能识别 node --test 汇总与 check.mjs 汇总行', () => {
  const tap = 'ℹ tests 12\nℹ pass 11\nℹ fail 0\nℹ skipped 1\nℹ todo 0\nℹ cancelled 0\n';
  assert.deepEqual(parseNodeTestCounts(tap), { tests: 12, pass: 11, fail: 0, skipped: 1, todo: 0, cancelled: 0 });
  assert.deepEqual(parseCheckCounts('  通过 32 · 失败 0 · 警告 8'), { pass: 32, fail: 0, warn: 8 });
  assert.deepEqual(parseNodeTestCounts('no summary here'), {
    tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null,
  });
  assert.equal(parseCheckCounts('nothing'), null);
});

// ── 文档与脚本契约 ─────────────────────────────────────────────
test('维护文档结构在当前仓库成立（链接可解析、verify 脚本契约存在）', () => {
  const docs = checkDocsStructure(ROOT);
  assert.deepEqual(docs.problems, []);
  assert.equal(docs.ok, true, 'docs.ok 供下游（LoopForge）消费，必须存在且为布尔值');
  assert.ok(docs.files.length >= 2, `应检查到 README 与 docs 文档，实际 ${docs.files.length}`);
  assert.ok(docs.checked > 0, '应至少检查到一处引用');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.verify, 'node scripts/verify.mjs', 'LoopForge 依赖这条脚本契约');
});

test('报告结构稳定：mode / partial / groups[].ok / check.ok / docs.ok 都在', (t) => {
  const dir = tempDir(t, 'verify-shape-');
  fs.writeFileSync(
    path.join(dir, 'ok.test.mjs'),
    "import test from 'node:test';\ntest('passes', () => {});\n",
    'utf8',
  );
  const result = verify({ root: dir, skipCheck: true, log: () => {} });
  assert.equal(result.mode, 'partial', '--skip-check 属于调试模式，不能标 full');
  assert.equal(typeof result.partial, 'boolean');
  assert.equal(Array.isArray(result.groups), true);
  for (const group of result.groups) assert.equal(typeof group.ok, 'boolean', 'groups[].ok 必须是布尔值');
  assert.equal(typeof result.docs.ok, 'boolean', 'docs.ok 必须是布尔值');
  // check 被跳过时显式为 null（不伪造 ok:true）
  assert.equal(result.check, null);
});

// ── CI 配置结构 ────────────────────────────────────────────────
test('CI 工作流存在、在 Windows + Node 24 上跑统一入口', () => {
  assert.equal(fs.existsSync(WORKFLOW), true, '缺少 .github/workflows/ci.yml');
  const text = readWorkflow();
  assert.match(text, /npm run verify/, '必须调用统一入口，而不是另造命令集合');
  assert.match(text, /runs-on: windows-latest/);
  assert.match(text, /node-version: '24'/);
  assert.match(text, /permissions:\s*\n\s*contents: read/, '最小权限：只读内容');
  assert.match(text, /push:\s*\n\s*branches: \[main, 'codex\/\*\*'\]/, 'push 必须覆盖 main 与 codex/**');
  assert.match(text, /pull_request:/, '必须覆盖 PR');
  assert.doesNotMatch(text, /deploy|gh-pages|upload-artifact/i, 'CI 不部署');
});

test('聚合检查命名稳定，且取消/跳过都算失败', () => {
  const text = readWorkflow();
  assert.match(text, /name: offline verify \(windows\)/, '必需的 verify job 名字要稳定');
  assert.match(text, /aggregate:\s*\n\s*name: aggregate result/, '必须有稳定命名的聚合 job');
  assert.match(text, /needs:\s*\[verify\]/, '聚合 job 依赖 verify');
  assert.match(text, /if:\s*always\(\)/, '取消/跳过也要进聚合，否则会伪装成功');
  assert.match(text, /!= "success"/, '必须显式把取消与失败判为失败');
  assert.equal(/continue-on-error:\s*true/.test(text), false, '必需 job 不得 allow-failure');
});

test('CI 不装依赖：没有 npm ci / npm install 步骤', () => {
  const runSteps = readWorkflow()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('run:'));
  const installs = runSteps.filter((line) => /\bnpm (ci|install)\b/.test(line));
  assert.deepEqual(installs, [], '离线门禁不装依赖；要装必须同时提交锁文件');
});

// ── CLI ────────────────────────────────────────────────────────
test('--list 列出发现的测试；--list --help 只显示帮助', () => {
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/verify.mjs'), ...args], { encoding: 'utf8' });
  const help = cli('--list', '--help');
  assert.match(help, /^用法：/);
  assert.doesNotMatch(help, /verify\.test\.mjs/);
  assert.equal(cli('-h', '--list'), help);
  const list = cli('--list');
  assert.match(list, /scripts\/verify\.test\.mjs/);
  assert.match(list, /packages\/own-life\/test\/own-life\.test\.mjs/);
});
