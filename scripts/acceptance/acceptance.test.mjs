/**
 * T4 统一离线验收 / 故障框架 · 专项测试
 * ─────────────────────────────────────────────────────────────
 * 覆盖：
 *   1. 契约导出：ACCEPTANCE_VERSION、createHarness、runScenario、CLI 主流程；
 *   2. 确定性：同 seed 同输入 → 报告逐字节相同；虚拟时钟可推进、外部时钟拒绝推进；
 *   3. 隔离：每个 harness 一个临时目录、cleanup 幂等；临时目录所有权——调用者给的
 *      只能是「经验证的专用父目录」，只删 harness 自己 mkdtemp 出来的子目录；
 *      系统临时根 / 仓库 / 越界实路径一律拒绝；清理前按创建时锁定的身份
 *      （真实路径 + dev/ino + 所有权标记）核对，同名替换与父目录改指都拒绝删除；
 *   4. 防护：默认 fetch 直接拒绝、全局 fetch 不被改动、checklist 源码里没有 I/O；
 *   5. 事实：每个 step 的 8 个槽位齐全、期望/实际差异可机读、非合成输入被拒；
 *   6. 计数与退出码：0=全通过、1=有失败、2=参数/框架错误，not-covered 不算通过；
 *   7. 参数解析：未知参数、缺值、裸 --json、--send 全部拒绝且不回显参数原文；
 *   8. 报告：--json 写入临时文件、坏场景不泄漏异常文本；
 *   9. 真实 QQ 清单：--dry-run --json 输出占位符/记录字段/停止条件，--send 被拒；
 *  10. 报告可追溯性：generatedAt 来源、B 门通过数与分母分开、scope=full/partial、
 *      报告不得写进仓库 data/；场景期望值必须是字面量而不是产品常量；
 *  11. Windows：临时目录/仓库路径大小写不同也按同一路径判定（Git Bash / 小写盘符）；
 *  12. 增补场景：X-03 的工具审计边界（正文/凭据不进证据）、X-04 的离线媒体证据
 *      （临时音频删干净、低置信度不写记忆、TTS 失败保留文字）、X-05 的离线 QQ presence
 *      证据（只发唯一 owner、状态文件白名单无正文、重启不补发不重发）。
 *  13. B-07 模糊提醒：走 CLI 的私聊装配层，模糊只回澄清（零任务、无已创建回执、
 *      0 次生成）；同一装配用一条明确提醒作正对照（真的新建并回复任务 ID）。
 *  14. B-08 消息与到期提醒同时发生：回复在途时提醒只 claim 入队不发送；放行后
 *      回复先发、提醒后发各一次并落终态；终态再派发不重发（只证明 CLI 离线层）。
 *  15. D/E 离线契约：D-01…D-04（ASR/TTS 桩 + 语音运行入口）与
 *      E-01…E-05（fake tool + 宿主桥接）；D-05 仍显式 not-covered（缺宿主附件入口），
 *      不用增补旁证冒充 D/E 验收。
 *
 * 全程离线：只用临时目录与内存桩，不联网、不调模型、不读写仓库 data/。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE_VERSION,
  REPO_ROOT,
  TEMP_OWNER_MARKER,
  acceptanceError,
  assertSafeTempParent,
  captureConsole,
  classifyTempParent,
  createHarness,
  isOwnedHarnessTempRoot,
  isSameHarnessTempRoot,
  projectError,
  runScenario,
} from './harness.mjs';
import {
  SCENARIOS,
  bGateIds,
  cGateIds,
  coveredScenarios,
  findScenario,
  isTapAllPassed,
  listScenarios,
  notCoveredBIds,
  notCoveredCIds,
} from './scenarios.mjs';
import {
  EXIT_OK,
  EXIT_SCENARIO_FAILED,
  EXIT_USAGE,
  buildReport,
  formatList,
  main as runnerMain,
  parseArgs as runnerParseArgs,
} from './run.mjs';
import {
  PLACEHOLDERS,
  buildChecklist,
  findPositiveGroupActions,
  formatChecklist,
  main as checklistMain,
  parseArgs as checklistParseArgs,
} from './real-qq-checklist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKLIST_FILE = path.join(HERE, 'real-qq-checklist.mjs');
const RUNNER_FILE = path.join(HERE, 'run.mjs');

/** 测试自己的临时工作区（每个测试自建自删）。 */
function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-'));
}

/** 收集 log 输出，避免测试打印一大片。 */
function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)), text: () => lines.join('\n') };
}

/** 跑一次 runner 并把 --json 报告读回来。 */
async function runWithReport(argv, overrides = {}) {
  const dir = tempWorkspace();
  try {
    const reportFile = path.join(dir, 'report.json');
    const sink = collector();
    const code = await runnerMain([...argv, '--json=' + reportFile], { log: sink.log, ...overrides });
    const text = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
    const report = text === '' ? null : JSON.parse(text);
    return { code, report, text, output: sink.text(), reportFile };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ═══════════════════ 1. 契约导出 ═══════════════════ */

test('契约：版本与导出函数齐全', () => {
  assert.equal(ACCEPTANCE_VERSION, 1);
  assert.equal(typeof createHarness, 'function');
  assert.equal(typeof runScenario, 'function');
  assert.equal(typeof runnerMain, 'function');
  assert.equal(typeof buildReport, 'function');
  assert.equal(typeof runnerParseArgs, 'function');
  assert.equal(typeof checklistMain, 'function');
});

test('契约：runScenario 的返回结构固定为 {id,ok,status,steps,diagnostics,artifacts}', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('B-01', { harness });
    assert.equal(result.id, 'B-01');
    assert.equal(result.ok, true);
    assert.equal(result.status, 'pass');
    assert.ok(Array.isArray(result.steps) && result.steps.length > 0);
    assert.ok(Array.isArray(result.diagnostics));
    assert.equal(typeof result.artifacts, 'object');
    assert.deepEqual(
      Object.keys(result).sort(),
      ['artifacts', 'diagnostics', 'gate', 'id', 'ok', 'status', 'steps'],
    );
  } finally {
    harness.cleanup();
  }
});

/* ═══════════════════ 2. 确定性 ═══════════════════ */

test('确定性：虚拟时钟可推进，外部时钟拒绝推进', () => {
  const harness = createHarness({ now: 5000 });
  try {
    assert.equal(harness.now(), 5000);
    harness.advanceClock(1500);
    assert.equal(harness.now(), 6500);
    assert.throws(() => harness.advanceClock(-1), (error) => error.code === 'invalid-clock-advance');
  } finally {
    harness.cleanup();
  }
  const injected = createHarness({ now: () => 7000 });
  try {
    assert.equal(injected.now(), 7000);
    assert.throws(() => injected.advanceClock(1), (error) => error.code === 'clock-not-virtual');
  } finally {
    injected.cleanup();
  }
});

test('确定性：同 seed 的随机源序列完全一致', () => {
  const left = createHarness({ seed: 4242 });
  const right = createHarness({ seed: 4242 });
  try {
    const a = [left.random(), left.random(), left.random()];
    const b = [right.random(), right.random(), right.random()];
    assert.deepEqual(a, b);
    const other = createHarness({ seed: 4243 });
    try {
      assert.notDeepEqual(a, [other.random(), other.random(), other.random()]);
    } finally {
      other.cleanup();
    }
  } finally {
    left.cleanup();
    right.cleanup();
  }
});

test('确定性：同一 seed 两次离线运行的报告逐字节相同', async () => {
  const first = await runWithReport(['--offline']);
  const second = await runWithReport(['--offline']);
  assert.equal(first.code, EXIT_OK);
  assert.equal(second.code, EXIT_OK);
  assert.ok(first.text.length > 0);
  assert.equal(first.text, second.text);
});

/* ═══════════════════ 3. 隔离 ═══════════════════ */

test('隔离：每个 harness 一个临时目录，cleanup 幂等且互不影响', () => {
  const left = createHarness();
  const right = createHarness();
  try {
    assert.notEqual(left.tempRoot, right.tempRoot);
    assert.ok(fs.existsSync(left.tempRoot));
    assert.ok(fs.existsSync(right.tempRoot));
    // 默认行为不变：自己 mkdtemp 在系统临时目录下，父目录就是系统临时目录。
    assert.equal(left.tempRootSource, 'os-tmpdir-mkdtemp');
    assert.equal(left.tempParentRoot, path.resolve(os.tmpdir()));
    assert.equal(left.injections.tempDir, 'mkdtemp');
    assert.equal(left.ownsTempRoot, true);
    left.writeFile('nested/note.txt', 'x');
    assert.ok(fs.existsSync(path.join(left.tempRoot, 'nested', 'note.txt')));

    assert.equal(left.cleanup(), true);
    assert.equal(fs.existsSync(left.tempRoot), false);
    // 幂等：第二次不再删、也不再报错。
    assert.equal(left.cleanup(), false);
    assert.equal(left.close(), false);
    // 另一个 harness 不受影响。
    assert.ok(fs.existsSync(right.tempRoot));
  } finally {
    left.cleanup();
    right.cleanup();
  }
});

/** 系统临时目录下与验收前缀同形的条目数（用来证明"拒绝时什么都没建"）。 */
function acceptanceEntriesInTmp() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('ai-companion-acceptance-')).length;
}

test('隔离：系统临时根本身 / 仓库 / 越界路径一律拒绝，且拒绝时一个目录都不建', () => {
  const rejected = [
    // 系统临时根本身（带不带尾分隔符都一样）：它属于操作系统和其他程序，不是专用目录。
    [os.tmpdir(), 'not-dedicated-root'],
    [os.tmpdir() + path.sep, 'not-dedicated-root'],
    // 仓库与仓库数据目录：绝不落盘到真实项目目录。
    [REPO_ROOT, 'inside-repo'],
    [path.join(REPO_ROOT, 'data'), 'inside-repo'],
    // 越出系统临时区：上级目录也不行。
    [path.dirname(os.tmpdir()), 'outside-os-tmp'],
  ];
  if (process.platform === 'win32') {
    // 盘根 / UNC 共享根：太浅，递归清理会波及整盘。
    rejected.push([path.parse(os.tmpdir()).root, 'root-path']);
  }

  const before = acceptanceEntriesInTmp();
  for (const [dir, detail] of rejected) {
    assert.throws(
      () => createHarness({ tempDir: dir }),
      (error) => error.code === 'unsafe-temp-dir' && error.detail === detail,
      '应拒绝 ' + dir + '（期望 detail ' + detail + '）',
    );
  }
  // 专门的父目录必须已经存在：不为调用者在任意位置创建目录。
  const missing = path.join(os.tmpdir(), 'acc-parent-missing-' + process.pid + '-' + Date.now());
  assert.throws(
    () => createHarness({ tempDir: missing }),
    (error) => error.code === 'unsafe-temp-dir' && error.detail === 'parent-missing',
  );
  assert.equal(fs.existsSync(missing), false, '拒绝时不该把父目录建出来');
  // 空值 / 非目录同样拒绝（这里传的是已存在的临时文件）。
  assert.throws(
    () => createHarness({ tempDir: '   ' }),
    (error) => error.code === 'unsafe-temp-dir' && error.detail === 'empty-path',
  );

  // 已存在但是文件 → 不是目录；文件里再套路径 → 解析不出真实目录（各平台码值不同，
  // 但都必须是闭合 detail，且都拒绝）。
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-notdir-'));
  try {
    const plainFile = path.join(scratch, 'plain.txt');
    fs.writeFileSync(plainFile, 'x', 'utf8');
    assert.throws(
      () => createHarness({ tempDir: plainFile }),
      (error) => error.code === 'unsafe-temp-dir' && error.detail === 'parent-not-directory',
    );
    assert.throws(
      () => createHarness({ tempDir: path.join(plainFile, 'sub') }),
      (error) => error.code === 'unsafe-temp-dir'
        && ['parent-missing', 'unresolvable-real-path'].includes(error.detail),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(acceptanceEntriesInTmp(), before, '拒绝路径时仍然建了临时目录');
});

test('隔离：调用者给的目录只当专用父目录——只删自己新建的子目录，调用者文件原样保留', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-owner-'));
  const marker = path.join(parent, 'caller-marker.txt');
  const callerDir = path.join(parent, 'caller-dir');
  fs.writeFileSync(marker, 'keep-me', 'utf8');
  fs.mkdirSync(callerDir);
  fs.writeFileSync(path.join(callerDir, 'keep.txt'), 'keep', 'utf8');

  let harness;
  try {
    harness = createHarness({ tempDir: parent });
    assert.equal(harness.tempParentRoot, path.resolve(parent));
    assert.equal(harness.tempRootSource, 'caller-parent-mkdtemp');
    assert.equal(harness.injections.tempDir, 'caller-parent-mkdtemp');
    assert.equal(harness.ownsTempRoot, true);
    // 根目录是父目录下的新建子目录，不是父目录本身。
    assert.notEqual(harness.tempRoot, path.resolve(parent));
    assert.equal(path.dirname(harness.tempRoot), path.resolve(parent));
    assert.ok(fs.existsSync(harness.tempRoot));
    assert.equal(path.basename(harness.tempRoot).startsWith('ai-companion-acceptance-'), true);

    harness.writeFile('nested/note.txt', 'x');
    assert.ok(fs.existsSync(path.join(harness.tempRoot, 'nested', 'note.txt')));

    const root = harness.tempRoot;
    assert.equal(harness.cleanup(), true);
    // 只删自己新建的那个子目录…
    assert.equal(fs.existsSync(root), false, 'harness 没删掉自己新建的目录');
    // …调用者放在父目录里的东西一个都不能少。
    assert.equal(fs.existsSync(parent), true, '调用者的父目录被删了');
    assert.equal(fs.existsSync(marker), true, '调用者的标记文件被删了');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep-me');
    assert.equal(fs.existsSync(path.join(callerDir, 'keep.txt')), true, '调用者的子目录被删了');
    // 幂等：第二次不删、不报错，调用者的文件仍在。
    assert.equal(harness.cleanup(), false);
    assert.equal(harness.close(), false);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    harness?.cleanup();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：cleanup 守卫只认自己 mkdtemp 出来的目录', () => {
  // 系统临时根、仓库、空串、相对路径都不是"自己的"。
  assert.equal(isOwnedHarnessTempRoot(os.tmpdir()), false);
  assert.equal(isOwnedHarnessTempRoot(REPO_ROOT), false);
  assert.equal(isOwnedHarnessTempRoot(''), false);
  assert.equal(isOwnedHarnessTempRoot('   '), false);
  assert.equal(isOwnedHarnessTempRoot(path.join('some', 'relative-dir')), false);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-guard-'));
  const unrelated = path.join(parent, 'not-owned');
  fs.mkdirSync(unrelated);
  const harness = createHarness({ tempDir: parent });
  try {
    // 前缀不符（调用者自己的目录）不删。
    assert.equal(isOwnedHarnessTempRoot(unrelated), false);
    // 自己新建的目录可以删。
    assert.equal(isOwnedHarnessTempRoot(harness.tempRoot), true);

    // 目录已经不在了：cleanup 不报错，也不再"删"一次。
    const root = harness.tempRoot;
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(isOwnedHarnessTempRoot(root), false);
    assert.equal(harness.cleanup(), false);
    // 父目录与调用者目录仍在。
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(fs.existsSync(parent), true);
  } finally {
    harness.cleanup();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：创建时锁定目录身份，正常 cleanup 仍成立', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ident-'));
  const harness = createHarness({ tempDir: parent });
  const root = harness.tempRoot;
  const identity = harness.tempRootIdentity;
  try {
    // 身份三件套：创建时的真实路径 / dev+ino / 写进目录的所有权 token。
    assert.equal(identity.realPath, fs.realpathSync(root));
    assert.ok(identity.token.length >= 16, '所有权 token 太短');
    // Windows 本地 NTFS 与指向 NTFS 的 UNC 都会给出真实的卷序列号 + 文件索引
    // （BigInt 十进制串）；不报告 inode 的文件系统给 '0'，由 token 兜底。
    assert.match(identity.dev, /^\d+$/u);
    assert.match(identity.ino, /^\d+$/u);
    assert.equal(isSameHarnessTempRoot(root, identity), true);

    // 所有权标记是框架账本，不是场景证据。
    assert.equal(fs.existsSync(path.join(root, TEMP_OWNER_MARKER)), true);
    assert.equal(harness.tempFiles().includes(TEMP_OWNER_MARKER), false, '所有权标记漏进了证据列表');
    harness.writeFile('nested/note.txt', 'x');
    assert.deepEqual(harness.tempFiles(), ['nested/note.txt']);

    // 正常路径：身份对得上，照常删掉自己的目录。
    assert.equal(harness.cleanup(), true);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(parent), true);
  } finally {
    harness.cleanup();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：同名目录被替换后 cleanup 拒绝删除，调用者数据必须保留', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-same-name-'));
  const harness = createHarness({ tempDir: parent });
  const root = harness.tempRoot;
  const identity = harness.tempRootIdentity;
  try {
    // 删掉自己建的那个目录，在原位重建同名目录并放入调用者数据。
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    const sentinel = path.join(root, 'caller-data.txt');
    fs.writeFileSync(sentinel, 'do-not-delete', 'utf8');

    // 路径守卫照样放行（它只确认"还在临时区里"）——这正是本条要补的口子。
    assert.equal(isOwnedHarnessTempRoot(root), true, '路径守卫本来就该放过它（否则测不到身份核对）');
    assert.equal(isSameHarnessTempRoot(root, identity), false);
    assert.equal(harness.cleanup(), false);
    assert.equal(fs.existsSync(sentinel), true, '同名替换的目录被误删');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do-not-delete');
    // 幂等：再喊一次也不删。
    assert.equal(harness.cleanup(), false);
    assert.equal(fs.existsSync(sentinel), true);

    // 连所有权标记一起照抄：底层报 inode 时（NTFS / 指向 NTFS 的 UNC）仍认得出不是同一个目录。
    if (identity.ino !== '0') {
      fs.writeFileSync(path.join(root, TEMP_OWNER_MARKER), identity.token + '\n', 'utf8');
      assert.equal(isSameHarnessTempRoot(root, identity), false, '照抄标记后仍应按 dev+ino 拒绝');
      assert.equal(fs.existsSync(sentinel), true);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：父目录联接点被改指到另一个临时目录后 cleanup 拒绝删除', () => {
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-swap-wrap-'));
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-swap-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-swap-b-'));
  const link = path.join(wrapper, 'parent-link');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const linkable = (() => {
    try {
      fs.symlinkSync(dirA, link, linkType);
      return true;
    } catch {
      return false;
    }
  })();

  try {
    if (!linkable) {
      // 建不了链的环境：验证"同名目录但真实路径不同"同样被身份核对拦住。
      const harness = createHarness({ tempDir: wrapper });
      try {
        const decoy = path.join(dirB, path.basename(harness.tempRoot));
        fs.mkdirSync(decoy);
        assert.equal(isOwnedHarnessTempRoot(decoy), true);
        assert.equal(isSameHarnessTempRoot(decoy, harness.tempRootIdentity), false);
      } finally {
        harness.cleanup();
      }
      return;
    }

    // 允许的形态：父目录本身是联接点（实路径仍在临时区里）。
    const harness = createHarness({ tempDir: link });
    const rootName = path.basename(harness.tempRoot);
    const identity = harness.tempRootIdentity;
    const realRootBefore = fs.realpathSync(harness.tempRoot);
    // 改指到 dirB，并在那里放一个同名目录（带调用者数据）。
    fs.unlinkSync(link);
    fs.symlinkSync(dirB, link, linkType);
    const decoy = path.join(dirB, rootName);
    fs.mkdirSync(decoy);
    const sentinel = path.join(decoy, 'caller-data.txt');
    fs.writeFileSync(sentinel, 'do-not-delete', 'utf8');

    // 词法路径一模一样、也仍在临时区里：路径守卫放行，只有身份核对能拦住。
    assert.equal(harness.tempRoot, path.join(path.resolve(link), rootName));
    assert.equal(isOwnedHarnessTempRoot(harness.tempRoot), true);
    assert.equal(isSameHarnessTempRoot(harness.tempRoot, identity), false);
    assert.equal(harness.cleanup(), false);
    assert.equal(fs.existsSync(sentinel), true, '改指后误删了另一个目录的内容');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do-not-delete');
    // 拒绝删除 ≠ 搬走：原来的目录还在原处。
    assert.equal(fs.existsSync(realRootBefore), true);
  } finally {
    // 先解链，再删自己的合成目录（绝不顺着链接递归）。
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch { /* 没建成就跳过 */ }
    for (const dir of [wrapper, dirA, dirB]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('隔离：ino 不可用（部分 FAT / SMB / UNC）时靠所有权标记兜底', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ino-'));
  const harness = createHarness({ tempDir: parent });
  const root = harness.tempRoot;
  const identity = harness.tempRootIdentity;
  try {
    // 模拟"文件系统不报 inode"：只剩真实路径 + token 两层。
    const noIno = Object.freeze({ ...identity, dev: '0', ino: '0' });
    assert.equal(isSameHarnessTempRoot(root, noIno), true);
    assert.equal(isSameHarnessTempRoot(root, { ...noIno, token: 'not-our-token' }), false);
    assert.equal(isSameHarnessTempRoot(root, { ...noIno, realPath: path.join(parent, 'elsewhere') }), false);
    assert.equal(isSameHarnessTempRoot(root, { ...noIno, token: '' }), false);
    assert.equal(isSameHarnessTempRoot(root, null), false);

    // 标记被删 → 身份不成立（fail closed），目录不删。
    fs.rmSync(path.join(root, TEMP_OWNER_MARKER), { force: true });
    assert.equal(isSameHarnessTempRoot(root, identity), false);
    assert.equal(harness.cleanup(), false);
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：软链接 / 联接点不得把专用父目录指到仓库或系统临时根', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-link-'));
  const linkToRepo = path.join(parent, 'link-to-repo');
  const linkToTmp = path.join(parent, 'link-to-tmp');
  const canResolve = (target) => {
    try {
      fs.realpathSync(target);
      return true;
    } catch {
      return false;
    }
  };
  // Windows 用 junction（不需要管理员权限），其它平台用目录软链接。
  // 例外：junction 只能指向本地卷，目标是 UNC 时（仓库在 \\wsl.localhost\... 下）
  // 建出来的是一条**断链**（目录项在、lstat/realpath 都报 ENOENT），不能代表
  // "指向仓库的链接"，所以 UNC 目标优先用目录符号链接。
  const repoIsUnc = String(REPO_ROOT).startsWith('\\\\');
  const junctionType = process.platform === 'win32' ? 'junction' : 'dir';
  const makeLink = (target, link, type = junctionType) => {
    try {
      fs.symlinkSync(target, link, type);
      return true;
    } catch {
      return false;
    }
  };
  const linkedRepo = repoIsUnc
    // UNC 目标：先试真正的目录链接；建不出来（无权限）就退回 junction，
    // 走下面的"断链也必须拒绝"分支。
    ? (makeLink(REPO_ROOT, linkToRepo, 'dir') || makeLink(REPO_ROOT, linkToRepo))
    : makeLink(REPO_ROOT, linkToRepo);
  const linkedTmp = makeLink(os.tmpdir(), linkToTmp);
  try {
    if (!linkedRepo && !linkedTmp) {
      // 该文件系统不支持建链：退化为直接验证"同一判定函数对实路径的结论"必须是否决。
      assert.equal(classifyTempParent(REPO_ROOT).ok, false);
      assert.equal(classifyTempParent(os.tmpdir()).ok, false);
      return;
    }
    if (linkedRepo) {
      // 词法上它就在临时区里：必须靠实路径才拦得住（或识别出断链）。
      if (classifyTempParent(REPO_ROOT).ok) {
        assert.equal(classifyTempParent(linkToRepo).ok, true, '词法判定本来就该放过它（否则这条测不到实路径守卫）');
      }
      if (canResolve(linkToRepo)) {
        // 正常情况（Windows 本地仓库 / UNC 仓库 + 目录符号链接）：实路径指向仓库，
        // 必须按实路径判成 inside-repo——这条断言不打折。
        const norm = (value) => (process.platform === 'win32' ? String(value).toLowerCase() : String(value));
        assert.equal(
          norm(fs.realpathSync(linkToRepo)).startsWith(norm(REPO_ROOT)),
          true,
          '链接没能解析到仓库：这条用例就不再证明"实路径守卫"了',
        );
        assert.throws(
          () => assertSafeTempParent(linkToRepo),
          (error) => error.code === 'unsafe-temp-dir' && error.detail === 'inside-repo',
        );
        assert.throws(
          () => createHarness({ tempDir: linkToRepo }),
          (error) => error.code === 'unsafe-temp-dir' && error.detail === 'inside-repo',
        );
      } else {
        // 降级：链接解析不出实路径（Windows 上 junction 指向 UNC 就是这种断链）。
        // 仍然是拒绝，但理由必须是"目录项在、解析不出真实路径"，不能被悄悄当成
        // "路径不存在"或别的笼统失败。
        assert.equal(
          fs.readdirSync(parent).includes(path.basename(linkToRepo)),
          true,
          '断链应当作为目录项存在，否则测的就不是"解析不出实路径"',
        );
        assert.equal(fs.existsSync(linkToRepo), false, '断链不该被 existsSync 当成存在');
        assert.throws(
          () => assertSafeTempParent(linkToRepo),
          (error) => error.code === 'unsafe-temp-dir' && error.detail === 'unresolvable-real-path',
        );
        assert.throws(
          () => createHarness({ tempDir: linkToRepo }),
          (error) => error.code === 'unsafe-temp-dir' && error.detail === 'unresolvable-real-path',
        );
      }
    }
    if (linkedTmp) {
      // 实路径等于系统临时根：同样不算专用目录。
      assert.throws(
        () => assertSafeTempParent(linkToTmp),
        (error) => error.code === 'unsafe-temp-dir' && error.detail === 'not-dedicated-root',
      );
    }
  } finally {
    // 先解链再删目录：绝不让递归删除顺着链接走进仓库 / 系统临时根。
    for (const link of [linkToRepo, linkToTmp]) {
      try {
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {
        // 断链 / 非法重解析点 lstat 会报 ENOENT，只能按目录项移除。
        try { fs.rmdirSync(link); } catch { /* 没建成就跳过 */ }
      }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(parent), false);
});

test('隔离：目录项存在但解析不出实路径（断链）按 unresolvable-real-path 拒绝', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-dangling-'));
  const target = path.join(parent, 'gone-target');
  const link = path.join(parent, 'link-to-gone');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.mkdirSync(target);
  let linked = true;
  try {
    fs.symlinkSync(target, link, linkType);
  } catch {
    linked = false;
  }
  try {
    if (!linked) {
      // 建不了链的环境：至少确认词法判定不会把链接路径当成"越界"而混淆理由。
      assert.equal(classifyTempParent(link).ok, true);
      return;
    }
    // 目标消失 → 目录项还在，但解析不出真实路径。
    fs.rmSync(target, { recursive: true, force: true });
    assert.equal(fs.readdirSync(parent).includes('link-to-gone'), true, '断链应当仍然是个目录项');
    assert.equal(fs.existsSync(link), false, '断链不该被 existsSync 当成存在');
    assert.equal(classifyTempParent(link).ok, true, '词法判定本来就该放过它');
    assert.throws(
      () => assertSafeTempParent(link),
      (error) => error.code === 'unsafe-temp-dir' && error.detail === 'unresolvable-real-path',
    );
    assert.throws(
      () => createHarness({ tempDir: link }),
      (error) => error.code === 'unsafe-temp-dir' && error.detail === 'unresolvable-real-path',
    );
    // 真正的"路径不存在"仍然是 parent-missing：两种理由不能混成一句。
    assert.throws(
      () => assertSafeTempParent(path.join(parent, 'never-existed')),
      (error) => error.code === 'unsafe-temp-dir' && error.detail === 'parent-missing',
    );
  } finally {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {
      try { fs.rmdirSync(link); } catch { /* 没建成就跳过 */ }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('隔离：writeFile 拒绝跳出临时目录的相对路径', () => {
  const harness = createHarness();
  try {
    assert.throws(() => harness.writeFile('../../escape.txt', 'x'), (error) => error.code === 'unsafe-temp-path');
    assert.throws(() => harness.writeFile(path.join(os.tmpdir(), 'abs.txt'), 'x'), (error) => error.code === 'unsafe-temp-path');
    // 所有权标记是清理时的身份凭据，场景不许覆盖。
    assert.throws(() => harness.writeFile(TEMP_OWNER_MARKER, 'x'), (error) => error.code === 'unsafe-temp-path');
  } finally {
    harness.cleanup();
  }
});

test('隔离：Windows 上大小写不同的临时目录/仓库路径仍按同一路径判定', { skip: process.platform !== 'win32' }, () => {
  // Git Bash / 小写盘符（c:/users/...）会传进来小写路径：不能因此误判"不在临时目录下"。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-case-'));
  const lower = path.resolve(dir.toLowerCase());
  const harness = createHarness({ tempDir: dir.toLowerCase() });
  try {
    assert.equal(harness.tempParentRoot, lower);
    // 根目录建在小写写法的父目录下（Windows 上同一条路径）。
    assert.equal(path.dirname(harness.tempRoot).toLowerCase(), lower);
    assert.ok(fs.existsSync(harness.tempRoot));
  } finally {
    harness.cleanup();
  }
  assert.equal(fs.existsSync(harness.tempRoot), false, '小写路径下新建的目录没被清掉');
  fs.rmSync(dir, { recursive: true, force: true });

  // 仓库路径同理：小写写法也必须被识别成"在仓库里"，不能落盘。
  assert.throws(
    () => createHarness({ tempDir: path.join(REPO_ROOT.toLowerCase(), 'data') }),
    (error) => error.code === 'unsafe-temp-dir' && error.detail === 'inside-repo',
  );
});

test('隔离：WSL UNC 临时根上的专用父目录判定（合成路径，不触盘）', () => {
  // WSL 里从 Windows 侧跑（或反过来）时临时根与仓库都可能写成 UNC：
  // 判定必须按同一套规则走，不能因为写法特殊就放行。
  const tmpRoot = String.raw`\\wsl.localhost\Ubuntu\tmp`;
  const repoRoot = String.raw`\\wsl.localhost\Ubuntu\home\user\repo`;
  const shareRoot = String.raw`\\wsl.localhost\Ubuntu` + '\\';
  const verdict = (candidate, options = {}) => classifyTempParent(candidate, { tmpRoot, repoRoot, ...options });

  // 系统临时根本身（带不带尾分隔符）→ 拒绝。
  assert.deepEqual(verdict(tmpRoot), { ok: false, detail: 'not-dedicated-root' });
  assert.deepEqual(verdict(tmpRoot + '\\'), { ok: false, detail: 'not-dedicated-root' });
  // 仓库 / 仓库 data → 拒绝。
  assert.deepEqual(verdict(repoRoot), { ok: false, detail: 'inside-repo' });
  assert.deepEqual(verdict(repoRoot + '\\data'), { ok: false, detail: 'inside-repo' });
  // UNC 共享根本身 → 太浅，拒绝（Windows 上识别为 root-path；其它平台算越界）。
  assert.deepEqual(
    verdict(shareRoot),
    { ok: false, detail: process.platform === 'win32' ? 'root-path' : 'outside-os-tmp' },
  );
  // 同前缀但不是子目录（tmp vs tmpx）→ 不算在里面。
  assert.deepEqual(
    verdict(String.raw`\\wsl.localhost\Ubuntu\tmpx`),
    { ok: false, detail: 'outside-os-tmp' },
  );
  // 另一台主机 / 本地盘符的临时目录 → 越界。
  assert.deepEqual(verdict(String.raw`\\other-host\share\tmp\acc`), { ok: false, detail: 'outside-os-tmp' });
  assert.deepEqual(verdict(String.raw`C:\Users\user\AppData\Local\Temp\acc`), { ok: false, detail: 'outside-os-tmp' });
  // 真正的子目录 → 允许（父目录只是"往哪儿放"）。
  const insideCandidate = tmpRoot + '\\acceptance-parent';
  const inside = verdict(insideCandidate);
  assert.equal(inside.ok, true);
  assert.equal(inside.path.toLowerCase(), path.resolve(insideCandidate).toLowerCase());

  // 大小写：Windows 语义（大小写不敏感）下允许，POSIX 语义下拒绝——判定不能靠运气。
  const upper = String.raw`\\WSL.LOCALHOST\Ubuntu\TMP\acceptance-parent`;
  assert.equal(verdict(upper, { caseInsensitive: true }).ok, true);
  assert.equal(verdict(upper, { caseInsensitive: false }).ok, false);
  assert.equal(verdict(upper, { caseInsensitive: false }).detail, 'outside-os-tmp');

  // Windows 本地盘符的正常路径同样是"子目录允许、根与本盘其它位置拒绝"。
  const winTmp = String.raw`C:\Users\user\AppData\Local\Temp`;
  assert.equal(classifyTempParent(winTmp + '\\acc', { tmpRoot: winTmp, repoRoot }).ok, true);
  assert.equal(
    classifyTempParent(winTmp, { tmpRoot: winTmp, repoRoot }).detail,
    'not-dedicated-root',
  );
});

/* ═══════════════════ 4. 防护：网络与全局状态 ═══════════════════ */

test('防护：默认 fetchImpl 直接拒绝，且从不改全局 fetch', async () => {
  const original = globalThis.fetch;
  const harness = createHarness();
  try {
    await assert.rejects(
      harness.fetch('https://example.invalid/chat/completions'),
      (error) => error.code === 'offline-fetch-blocked',
    );
    assert.equal(globalThis.fetch, original);
    assert.equal(harness.counters.blockedFetchCalls, 1);
    assert.equal(harness.injections.fetchImpl, 'deny');
  } finally {
    harness.cleanup();
  }
  // 跑完一整轮验收之后，全局 fetch 依旧没被替换。
  await runWithReport(['--offline']);
  assert.equal(globalThis.fetch, original);
});

test('防护：注入 fetchImpl 时走注入实现，不再默认拒绝', async () => {
  const calls = [];
  const harness = createHarness({
    fetchImpl: async (url) => { calls.push(url); return { ok: true }; },
  });
  try {
    const response = await harness.fetch('https://example.invalid/x');
    assert.equal(response.ok, true);
    assert.deepEqual(calls, ['https://example.invalid/x']);
    assert.equal(harness.counters.blockedFetchCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test('防护：captureConsole 只接管并在 restore 后还原', () => {
  const before = console.log;
  const capture = captureConsole();
  try {
    console.log('synthetic-line');
    assert.notEqual(console.log, before);
    assert.deepEqual(capture.lines, ['synthetic-line']);
  } finally {
    capture.restore();
  }
  assert.equal(console.log, before);
  // 二次 restore 不会把别的接管覆盖掉，也不报错。
  assert.deepEqual(capture.restore(), ['synthetic-line']);
});

/* ═══════════════════ 5. step 事实字段 ═══════════════════ */

test('事实：step 的 8 个槽位齐全，输入被强制标注为合成', () => {
  const harness = createHarness();
  try {
    const step = harness.step({
      title: '样例',
      input: { kind: 'private-message', items: [{ text: '在吗', userId: 'visitor-1' }] },
      model: { calls: 1, joined: '访客：在吗', deferred: true, committed: true },
      tools: [{ name: 'demo', ok: true, code: 'ok', policy: 'stop' }],
      task: { id: 't-1', status: 'queued', attempt: 1, firedAtSet: true, kind: 'queued' },
      memory: { people: 1, turns: 1, personKnown: true, interactions: 2, topics: 0, committed: true },
      delivery: { attempted: 1, sent: 1, receipts: ['confirmed'], texts: ['在呢'], channel: 'synthetic' },
      expected: { sent: 1 },
      actual: { sent: 1 },
    });
    for (const field of ['id', 'title', 'at', 'input', 'model', 'tools', 'task', 'memory', 'delivery', 'expected', 'actual', 'diff', 'ok']) {
      assert.ok(Object.hasOwn(step, field), 'step 缺少字段 ' + field);
    }
    assert.equal(step.input.synthetic, true);
    assert.equal(step.input.items[0].text, '在吗');
    assert.equal(step.model.transport, 'synthetic-scripted');
    assert.equal(step.tools[0].code, 'ok');
    assert.equal(step.task.status, 'queued');
    assert.equal(step.memory.interactions, 2);
    assert.equal(step.delivery.receipts[0], 'confirmed');
    assert.deepEqual(step.diff, []);
    assert.equal(step.ok, true);
    assert.ok(Object.isFrozen(step));
    assert.throws(
      () => harness.step({ input: { synthetic: false, kind: 'x' } }),
      (error) => error.code === 'non-synthetic-input',
    );
  } finally {
    harness.cleanup();
  }
});

test('事实：期望与实际不一致时 ok 为 false 且差异可机读', () => {
  const harness = createHarness();
  try {
    const step = harness.step({ title: '不一致', expected: { sent: 1, code: 'ok' }, actual: { sent: 2, code: 'ok' } });
    assert.equal(step.ok, false);
    assert.equal(step.diff.length, 1);
    assert.deepEqual(step.diff[0], { field: 'sent', expected: 1, actual: 2 });
  } finally {
    harness.cleanup();
  }
});

test('事实：所有 covered 场景的每一步都带齐事实字段', async () => {
  const harness = createHarness();
  // 直接调 runScenario 时没有 runner 的 console 接管：这里自己接管，别把产品日志糊进测试输出。
  const capture = captureConsole();
  try {
    for (const scenario of coveredScenarios()) {
      const result = await runScenario(scenario.id, { harness });
      assert.equal(result.status, 'pass', scenario.id + ' 未通过：' + JSON.stringify(result.diagnostics));
      assert.ok(result.steps.length > 0, scenario.id + ' 没有记录任何 step');
      for (const step of result.steps) {
        assert.equal(step.input?.synthetic, true, scenario.id + ' 的 step 输入不是合成输入');
        assert.equal(typeof step.at, 'string');
        assert.equal(step.ok, true, scenario.id + '/' + step.id + ' 期望与实际不一致');
        assert.ok(Array.isArray(step.delivery?.receipts ?? []));
        assert.ok(step.memory === null || typeof step.memory.people === 'number');
      }
    }
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

test('事实：expected / actual 不被 20 键上限截断（截断会让断言静默失效）', async () => {
  // harness 的 sanitizePlain 只保留每个对象的前 20 个键。场景一旦超了，expected 与
  // actual 会被**同时**截掉同样的尾部字段：diff 仍然为空、step 仍然 ok，那些字段
  // 就等于没断言。事后数 step.expected 的键是看不出问题的（那时已经截过了），
  // 所以在调用真实 step 之前把原始键数记下来。
  const harness = createHarness();
  const capture = captureConsole();
  const stepImpl = harness.step;
  const observed = [];
  let current = '';
  harness.step = (fields = {}) => {
    observed.push({
      scenario: current,
      expectedKeys: Object.keys(fields.expected ?? {}).length,
      actualKeys: Object.keys(fields.actual ?? {}).length,
    });
    return stepImpl(fields);
  };
  try {
    for (const scenario of coveredScenarios()) {
      current = scenario.id;
      const result = await runScenario(scenario.id, { harness });
      assert.equal(result.status, 'pass', scenario.id + ' 未通过');
      for (const step of result.steps) {
        // 通过的前提下两边键集合必须一致；不一致说明有字段被丢掉。
        assert.deepEqual(
          Object.keys(step.actual ?? {}).sort(),
          Object.keys(step.expected ?? {}).sort(),
          scenario.id + '/' + step.id + ' 的 expected / actual 键集合不一致',
        );
      }
    }
    assert.ok(observed.length > 0, '没有观察到任何 step');
    for (const item of observed) {
      assert.ok(
        item.expectedKeys <= 20 && item.actualKeys <= 20,
        item.scenario + ' 的 step 有 expected ' + item.expectedKeys + ' / actual ' + item.actualKeys
          + ' 个键，超过 sanitizePlain 的 20 键上限（会被静默截断）',
      );
    }
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

/* ═══════════════════ 6. 场景状态与 not-covered ═══════════════════ */

test('场景表：B 门分母是 18，未覆盖 id 与 covered id 不重叠', () => {
  assert.equal(bGateIds().length, 18);
  const covered = coveredScenarios().map((scenario) => scenario.id);
  const missing = notCoveredBIds();
  assert.deepEqual(
    missing,
    ['B-03', 'B-04', 'B-05', 'B-12', 'B-14', 'B-15', 'B-18'],
  );
  for (const id of missing) assert.ok(!covered.includes(id), id + ' 不该同时是 covered');
  // 增补场景只加证据，不改 B 门分母。
  for (const extra of [
    'X-01', 'X-02', 'X-03', 'X-04', 'X-05', 'X-06',
    'D-01', 'D-02', 'D-03', 'D-04', 'E-01', 'E-02', 'E-03', 'E-04', 'E-05',
  ]) {
    assert.ok(!bGateIds().includes(extra), extra + ' 不该进 B 门分母');
    assert.ok(covered.includes(extra), extra + ' 应作为增补场景被执行');
  }
  // C 门是独立门槛：只加证据，不改变 B 门分母，也不混进 extra 计数。
  for (const c of ['C-03', 'C-04', 'C-05', 'C-07', 'C-08', 'C-09']) {
    assert.ok(!bGateIds().includes(c), c + ' 不该进 B 门分母');
    assert.ok(covered.includes(c), c + ' 应作为 C 门场景被执行');
  }
  assert.equal(cGateIds().length, 8);
  assert.deepEqual(notCoveredCIds(), ['C-01', 'C-02']);
  assert.equal(
    listScenarios().filter((scenario) => scenario.gate === 'extra' && scenario.status === 'covered').length,
    15,
  );
  // covered 总数 = 11 个 B 门 + 6 个 C 门 + 15 个增补；
  // not-covered 是 7 个 B 门 + 2 个 C 门 + 1 个 D/E（D-05）。
  assert.equal(covered.length, 32);
  assert.equal(listScenarios().length, 42);
  // 缺失的宿主 / QQ 集成路径在本 checkout 里确实不存在：用场景表登记证明，
  // 不断言任何私有目录名（公开 fork 不依赖私有宿主路径）。
  assert.equal(findScenario('B-03').status, 'not-covered');
  // D-04/E-05 已有独立可执行证据；D-05 仍缺宿主附件入口，不能用桩冒充。
  for (const id of ['D-04', 'E-05']) {
    const scenario = findScenario(id);
    assert.equal(scenario.status, 'covered', id + ' 应有独立可执行证据');
    assert.equal(typeof scenario.run, 'function', id + ' 缺少 run');
  }
  const d05 = findScenario('D-05');
  assert.equal(d05.status, 'not-covered', 'D-05 应保留为未覆盖');
  assert.equal(d05.run, undefined, 'D-05 不能用桩冒充验收');
  assert.ok(d05.reason.length > 0);
});

test('场景表：每个 covered 场景都有可执行的 run，not-covered 只有说明', () => {
  for (const scenario of listScenarios()) {
    if (scenario.status === 'covered') {
      assert.equal(typeof scenario.run, 'function', scenario.id + ' 缺少 run');
    } else {
      assert.equal(scenario.run, undefined, scenario.id + ' 不该有 run（不能用桩冒充验收）');
      assert.equal(typeof scenario.reason, 'string');
      assert.ok(scenario.reason.length > 0);
    }
  }
});

test('runScenario：未知 id 抛 unknown-scenario；not-covered 返回状态且没有 steps', async () => {
  const harness = createHarness();
  try {
    await assert.rejects(runScenario('NOPE', { harness }), (error) => error.code === 'unknown-scenario');
    const result = await runScenario('B-03', { harness });
    assert.equal(result.status, 'not-covered');
    assert.equal(result.ok, false, 'not-covered 绝不能算 ok');
    assert.deepEqual(result.steps, []);
    assert.equal(result.diagnostics[0].code, 'not-covered');
    // detail 也走闭合码白名单，不接受任意文本。
    assert.equal(result.diagnostics[0].detail, 'requires-host-integration');
  } finally {
    harness.cleanup();
  }
});

test('X-06：TAP 全通过判定只要求 fail=0/skipped=0/pass>=1，不锁死用例条数', () => {
  assert.equal(isTapAllPassed('# pass 1\n# fail 0\n# skipped 0\n'), true);
  assert.equal(isTapAllPassed('# pass 2\n# fail 0\n# skipped 0\n'), true, '补一条用例不应误判失败');
  assert.equal(isTapAllPassed('# pass 2\n# fail 1\n# skipped 0\n'), false);
  assert.equal(isTapAllPassed('# pass 0\n# fail 0\n# skipped 0\n'), false);
  assert.equal(isTapAllPassed('# pass 2\n# skipped 0\n'), false, '缺 fail 行不能算通过');
  assert.equal(isTapAllPassed('# pass 2\n# fail 0\n# skipped 1\n'), false);
});

test('runScenario：not-covered 的 reason 若不是闭合码，detail 被折成 not-covered', async () => {
  const registry = [
    {
      id: 'T-NC',
      gate: 'b',
      status: 'not-covered',
      title: '注入的未覆盖场景',
      reason: 'this reason has spaces & 中文',
    },
  ];
  const harness = createHarness();
  try {
    const result = await runScenario('T-NC', { harness, registry });
    assert.equal(result.status, 'not-covered');
    assert.equal(result.diagnostics[0].code, 'not-covered');
    assert.equal(result.diagnostics[0].detail, 'not-covered');
  } finally {
    harness.cleanup();
  }
});

test('runScenario：别名可用（restart-recovery → B-09）', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('restart-recovery', { harness });
    assert.equal(result.id, 'B-09');
    assert.equal(result.status, 'pass');
  } finally {
    harness.cleanup();
  }
});

test('runScenario：场景里的断言失败只留闭合码，不带异常文本', async () => {
  const secret = 'SECRET-do-not-leak-9c1';
  const registry = [
    {
      id: 'T-01',
      gate: 'b',
      status: 'covered',
      title: '注入的失败场景',
      run: async () => { throw new Error(secret); },
    },
    {
      id: 'T-02',
      gate: 'b',
      status: 'covered',
      title: '注入的断言失败场景',
      run: async (harness) => { harness.fail('deliberate-check'); },
    },
  ];
  const harness = createHarness();
  try {
    const crashed = await runScenario('T-01', { harness, registry });
    assert.equal(crashed.status, 'fail');
    assert.equal(crashed.ok, false);
    assert.deepEqual(crashed.diagnostics[0], { code: 'unknown-error' });
    assert.ok(!JSON.stringify(crashed).includes(secret), '诊断里泄漏了异常文本');

    const asserted = await runScenario('T-02', { harness, registry });
    assert.equal(asserted.status, 'fail');
    assert.deepEqual(asserted.diagnostics[0], { code: 'assertion-failed', detail: 'deliberate-check' });
  } finally {
    harness.cleanup();
  }
});

test('projectError：任意异常折叠成闭合码', () => {
  assert.deepEqual(projectError(new Error('boom with body')), { code: 'unknown-error' });
  assert.deepEqual(projectError(acceptanceError('offline-fetch-blocked')), { code: 'offline-fetch-blocked' });
  assert.deepEqual(projectError({ code: 'Bad Code!!' }), { code: 'unknown-error' });
  assert.deepEqual(projectError(null), { code: 'unknown-error' });
});

/* ═══════════════════ 7. runner 计数与退出码 ═══════════════════ */

test('runner：默认执行整表，退出码 0，覆盖分母与未覆盖列表齐全', async () => {
  const { code, report } = await runWithReport(['--offline']);
  assert.equal(code, EXIT_OK);
  assert.equal(report.kind, 'offline-acceptance-report');
  assert.equal(report.mode, 'offline');
  assert.equal(report.version, ACCEPTANCE_VERSION);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, coveredScenarios().length);
  // summary.passed 包括 C 与增补场景，B 门通过数必须单独可读。
  assert.equal(report.summary.bGatePassed, 11);
  assert.equal(report.summary.cGatePassed, 6);
  assert.equal(report.summary.passed - report.summary.bGatePassed, 21);
  assert.equal(report.summary.coverageDenominator, 18);
  assert.equal(report.summary.cGateCoverageDenominator, 8);
  assert.equal(report.summary.completeBGate, false, 'completeBGate 必须保持 false');
  assert.equal(report.summary.offlineCGateComplete, false, 'C-01/C-02 仍是永久缺口');
  assert.equal(report.coverage.denominator, 18);
  assert.equal(report.coverage.scope, 'full-registry');
  assert.deepEqual(report.coverage.coveredBIds, [
    'B-01', 'B-02', 'B-06', 'B-07', 'B-08', 'B-09', 'B-10', 'B-11', 'B-13', 'B-16', 'B-17',
  ]);
  // C 与增补场景按执行顺序出现在 extraExecutedIds 里，且不进入 B 门的任何列表。
  assert.deepEqual(report.coverage.extraExecutedIds, [
    'C-03', 'C-04', 'C-05', 'C-07', 'C-08', 'C-09',
    'X-01', 'X-02', 'X-03', 'X-04', 'X-05', 'X-06',
    'D-01', 'D-02', 'D-03', 'D-04', 'E-01', 'E-02', 'E-03', 'E-04', 'E-05',
  ]);
  for (const extra of report.coverage.extraExecutedIds) {
    assert.ok(!report.coverage.missingBIds.includes(extra), extra + ' 混进了 missingBIds');
    assert.ok(!report.coverage.notExecutedBIds.includes(extra), extra + ' 混进了 notExecutedBIds');
  }
  assert.deepEqual(report.coverage.notCoveredBIds, notCoveredBIds());
  assert.deepEqual(report.coverage.notCoveredCIds, notCoveredCIds());
  assert.deepEqual(report.coverage.coveredCIds, [
    'C-03', 'C-04', 'C-05', 'C-07', 'C-08', 'C-09',
  ]);
  assert.deepEqual(report.coverage.missingCIds, ['C-01', 'C-02']);
  assert.deepEqual(report.coverage.notExecutedCIds, []);
  assert.ok(report.coverage.missingBIds.includes('B-03'));
  assert.deepEqual(report.coverage.groupIds, ['C-01', 'C-02']);
  assert.equal(report.summary.notCovered, report.summary.total - report.summary.executed);
  // 42 项 = 18 个 B 门 + 8 个 C 门 + 15 个增补 + 1 个 D/E 未覆盖（D-05）。
  assert.equal(report.summary.total, 42);
  assert.equal(report.summary.executed, 32);
  assert.equal(report.summary.notCovered, 10);
  // 生成时间来自虚拟时钟：必须显式标注来源，避免被当成真实墙钟。
  assert.equal(report.generatedAtSource, 'harness-virtual-clock');
  assert.equal(report.generatedAt, '2026-01-01T00:00:00.000Z');
  // 运行环境也要留档（追溯用），否则报告换台机器就无从比对。
  assert.equal(report.environment.node, process.version);
  assert.equal(report.environment.platform, process.platform);
  // 产品日志只留条数，正文不进报告。
  assert.equal(typeof report.artifacts.productLogLines, 'number');
  assert.ok(report.artifacts.productLogLines > 0, '产品日志条数应被记录');
  // 边界必须写死在报告里，避免被误读成真实环境验收。
  assert.equal(report.boundary.network, false);
  assert.equal(report.boundary.realModel, false);
  assert.equal(report.boundary.realQQ, false);
  assert.equal(report.boundary.globalFetchTouched, false);
});

test('runner：--scenario=restart-recovery 只跑一个场景', async () => {
  const { code, report } = await runWithReport(['--offline', '--scenario=restart-recovery']);
  assert.equal(code, EXIT_OK);
  assert.equal(report.scenarios.length, 1);
  assert.equal(report.scenarios[0].id, 'B-09');
  assert.equal(report.scenarios[0].status, 'pass');
  // 永久缺口（没有离线证据）与"本次没跑"必须分开报，不能混成一句。
  assert.deepEqual(report.coverage.notCoveredBIds, ['B-03', 'B-04', 'B-05', 'B-12', 'B-14', 'B-15', 'B-18']);
  assert.deepEqual(
    report.coverage.notExecutedBIds,
    ['B-01', 'B-02', 'B-06', 'B-07', 'B-08', 'B-10', 'B-11', 'B-13', 'B-16', 'B-17'],
  );
  assert.equal(report.summary.completeBGate, false);
  assert.equal(report.coverage.scope, 'partial', '子集运行必须标成 partial，避免被读成整表覆盖');
  assert.match(report.coverage.gateReason, /本次未执行/u);
});

test('runner：选中的是 not-covered 时退出码 0，但不算通过', async () => {
  const { code, report } = await runWithReport(['--offline', '--scenario=B-03']);
  assert.equal(code, EXIT_OK);
  assert.equal(report.summary.executed, 0);
  assert.equal(report.summary.passed, 0);
  assert.equal(report.summary.notCovered, 1);
  assert.equal(report.summary.completeBGate, false);
});

test('runner：场景失败 → 退出码 1', async () => {
  const registry = [
    {
      id: 'T-99',
      gate: 'b',
      status: 'covered',
      title: '注入的失败场景',
      run: async (harness) => { harness.step({ title: 'bad', expected: { sent: 1 }, actual: { sent: 2 } }); },
    },
  ];
  const { code, report } = await runWithReport(['--offline'], { registry });
  assert.equal(code, EXIT_SCENARIO_FAILED);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.ok, false);
});

test('runner：参数错误 → 退出码 2，且不回显参数原文', async () => {
  const cases = [
    [[], 'offline-required'],
    [['--offline', '--scenario=does-not-exist'], 'unknown-scenario'],
    [['--offline', '--scenario'], 'scenario-value-required'],
    [['--offline', '--json'], 'json-path-required'],
    [['--offline', '--json='], 'json-path-required'],
    [['--offline', '--send'], 'send-not-supported'],
    [['--offline', '--nope=secret-token-value'], 'unknown-argument'],
  ];
  for (const [argv, expectedCode] of cases) {
    const sink = collector();
    const code = await runnerMain(argv, { log: sink.log });
    assert.equal(code, EXIT_USAGE, 'argv ' + JSON.stringify(argv) + ' 应返回 2');
    assert.ok(sink.text().includes(expectedCode), '缺少错误码 ' + expectedCode);
    assert.ok(!sink.text().includes('secret-token-value'), '回显了参数原文');
  }
});

test('runner：--list 不需要 --offline，并列出完整状态', async () => {
  const sink = collector();
  const code = await runnerMain(['--list'], { log: sink.log });
  assert.equal(code, EXIT_OK);
  const text = sink.text();
  for (const scenario of listScenarios()) assert.ok(text.includes(scenario.id), '清单缺少 ' + scenario.id);
  assert.ok(text.includes('B 门分母 18'));
  assert.ok(text.includes('not-covered'));
  assert.equal(text, formatList());
});

test('runner：--help 与 --json 报告文件落在临时目录', async () => {
  const sink = collector();
  assert.equal(await runnerMain(['--help'], { log: sink.log }), EXIT_OK);
  assert.ok(sink.text().includes('--offline'));

  const { reportFile, text } = await runWithReport(['--offline', '--scenario=B-01']);
  assert.ok(!path.resolve(reportFile).startsWith(path.resolve(REPO_ROOT) + path.sep), '报告不该写进仓库');
  assert.equal(JSON.parse(text).scenarios[0].id, 'B-01');
});

test('runner：拒绝把报告写进仓库 data/（不碰真实数据目录的边界）', async () => {
  const forbidden = path.join(REPO_ROOT, 'data', 'acceptance-report-should-not-exist.json');
  const sink = collector();
  const code = await runnerMain(['--offline', '--scenario=B-01', '--json=' + forbidden], { log: sink.log });
  assert.equal(code, EXIT_USAGE);
  assert.ok(sink.text().includes('unsafe-report-path'), '缺少 unsafe-report-path 诊断');
  assert.equal(fs.existsSync(forbidden), false, '报告被写进了仓库 data/');
});

test('runner：报告写不出去时退出码 2（框架错误），并明确区分参数错误标签', async () => {
  const dir = tempWorkspace();
  try {
    // 目标目录不存在 → writeFileSync 直接失败。
    const sink = collector();
    const code = await runnerMain(
      ['--offline', '--scenario=B-01', '--json=' + path.join(dir, 'missing-dir', 'report.json')],
      { log: sink.log },
    );
    assert.equal(code, EXIT_USAGE);
    assert.ok(sink.text().includes('report-write-failed'));
    assert.ok(sink.text().includes('[框架错误]'), '写报告失败不是参数错误，标签不该是[参数错误]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner：坏场景的报告不含异常文本，且仍写全字段', async () => {
  const secret = 'SECRET-token-from-scenario-77f';
  const registry = [
    {
      id: 'T-11',
      gate: 'b',
      status: 'covered',
      title: '抛异常的场景',
      run: async () => { throw new Error('upstream said: ' + secret); },
    },
  ];
  const { code, report, text } = await runWithReport(['--offline'], { registry });
  assert.equal(code, EXIT_SCENARIO_FAILED);
  assert.ok(!text.includes(secret), '报告里泄漏了异常文本');
  assert.deepEqual(report.scenarios[0].diagnostics[0], { code: 'unknown-error' });
  assert.equal(report.scenarios[0].status, 'fail');
});

/* ═══════════════════ 8. 清理与残留 ═══════════════════ */

test('清理：跑完之后不留下 ai-companion-acceptance-* 临时目录', async () => {
  const prefix = 'ai-companion-acceptance-';
  const count = () => fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(prefix))
    .length;
  const before = count();
  const { code } = await runWithReport(['--offline']);
  assert.equal(code, EXIT_OK);
  assert.equal(count(), before, 'runner 泄漏了临时目录');
});

test('证据：tempFiles 按场景归属，不把上一个场景的文件算进本次', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    const first = await runScenario('B-01', { harness });
    const second = await runScenario('B-02', { harness });
    assert.deepEqual(first.artifacts.tempFiles, ['b01/people.json', 'b01/turns.jsonl']);
    // 共享临时目录：B-02 的证据只能是自己写下的文件，不能把 b01/* 也算进来。
    assert.deepEqual(second.artifacts.tempFiles, ['b02/people.json', 'b02/turns.jsonl']);
    assert.equal(second.artifacts.tempFiles.some((file) => file.startsWith('b01/')), false, '证据跨场景串了');

    // 一个文件都不落盘的场景给空数组，而不是把整棵临时树算成证据。
    const tools = await runScenario('B-10', { harness });
    assert.deepEqual(tools.artifacts.tempFiles, []);

    // not-covered 没有产物，但字段照样在（"没有证据"要能被机读区分）。
    const uncovered = await runScenario('B-03', { harness });
    assert.deepEqual(uncovered.artifacts.tempFiles, []);
    assert.ok(Array.isArray(uncovered.artifacts.requirements));
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

test('清理：runScenario 反复使用同一个 harness 时 steps 不串场', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    const first = await runScenario('B-01', { harness });
    const second = await runScenario('B-02', { harness });
    assert.equal(first.steps.length, 2);
    assert.equal(second.steps.length, 1);
    assert.equal(second.steps[0].id, 's1');
    assert.equal(harness.bot.deliveries.length, 1, '假 bot 的投递记录应随场景重置');
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

test('隔离：reset 清掉默认 Memory，场景之间不串账本', () => {
  const harness = createHarness();
  try {
    harness.memory.logTurn({ where: 'private:visitor-1', who: '访客', text: '在吗', reply: '在的' });
    assert.equal(harness.memoryFacts().turns, 1);
    harness.reset();
    assert.equal(harness.memoryFacts().turns, 0, 'reset 后仍读到了上一个场景的记忆');
  } finally {
    harness.cleanup();
  }
});

/* ═══════════════════ 9. 真实 QQ 清单 ═══════════════════ */

test('清单：默认 dry-run，纯数据带占位符与人工字段', () => {
  const checklist = buildChecklist();
  assert.equal(checklist.kind, 'real-qq-checklist');
  assert.equal(checklist.mode, 'dry-run');
  assert.equal(checklist.runner, 'manual');
  assert.equal(checklist.placeholders.recipient, '<RECIPIENT>');
  assert.equal(checklist.placeholders.message, '<MESSAGE>');
  assert.equal(checklist.placeholders.evidenceRef, '<EVIDENCE_REF>');
  assert.equal(checklist.boundary.network, false);
  assert.equal(checklist.boundary.sends, 0);
  assert.equal(checklist.boundary.reads.repoData, false);
  assert.equal(checklist.boundary.reads.config, false);
  assert.ok(checklist.steps.length >= 5);
  assert.ok(checklist.manualRecordFields.length >= 5);
  assert.ok(checklist.stopConditions.length >= 4);
  assert.ok(checklist.authorizations.length >= 3);
  for (const step of checklist.steps) {
    assert.match(step.id, /^R-\d{2}$/u);
    assert.ok(step.action.length > 0 && step.expect.length > 0);
    assert.ok(Array.isArray(step.record) && step.record.length > 0);
  }
  // 默认参数就是 dry-run（显式不写也一样）。
  assert.equal(checklistParseArgs([]).dryRun, true);
  assert.equal(checklistParseArgs(['--dry-run']).dryRun, true);
});

test('清单：--dry-run --json 输出可解析、无真实账号或密钥', () => {
  const run = spawnSync(process.execPath, [CHECKLIST_FILE, '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const checklist = JSON.parse(run.stdout);
  assert.equal(checklist.mode, 'dry-run');
  assert.equal(checklist.placeholders.recipient, '<RECIPIENT>');
  assert.ok(run.stdout.includes('<RECIPIENT>'));
  assert.ok(run.stdout.includes('<MESSAGE>'));
  assert.ok(run.stdout.includes('<EVIDENCE_REF>'));
  // 不出现真实账号数字 / 密钥形状。
  assert.equal(/\b\d{10,11}\b/u.test(run.stdout), false, '清单里出现了真实账号形状的数字');
  assert.equal(/sk-[A-Za-z0-9]{20,}/u.test(run.stdout), false, '清单里出现了密钥形状的串');
});

test('清单：--send 被显式拒绝，且不产生任何发送', () => {
  const plain = spawnSync(process.execPath, [CHECKLIST_FILE, '--send'], { encoding: 'utf8' });
  assert.equal(plain.status, EXIT_USAGE);
  assert.ok(plain.stdout.includes('不支持 --send'));

  const json = spawnSync(process.execPath, [CHECKLIST_FILE, '--send', '--json'], { encoding: 'utf8' });
  assert.equal(json.status, EXIT_USAGE);
  const refusal = JSON.parse(json.stdout);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, 'send-not-supported');
  assert.equal(refusal.sends, 0);
  // 拒绝时不能顺手把整份清单（含"可以开始"的暗示）打出来。
  assert.equal(json.stdout.includes('前置条件'), false);
});

test('清单：未知参数被拒，退出码 2', () => {
  const run = spawnSync(process.execPath, [CHECKLIST_FILE, '--please-send'], { encoding: 'utf8' });
  assert.equal(run.status, EXIT_USAGE);
  assert.ok(run.stdout.includes('只支持 --dry-run'));
});

test('清单：源码里没有任何 I/O 或网络能力', () => {
  const source = fs.readFileSync(CHECKLIST_FILE, 'utf8');
  for (const pattern of [
    /node:fs/u, /node:net/u, /node:http/u, /node:https/u, /node:dgram/u,
    /node:child_process/u, /require\(/u, /XMLHttpRequest/u, /\bfetch\(/u,
  ]) {
    assert.equal(pattern.test(source), false, '清单源码出现了被禁止的能力：' + pattern);
  }
  // runner 才允许用 fs（写报告），但它也不该联网。
  const runnerSource = fs.readFileSync(RUNNER_FILE, 'utf8');
  for (const pattern of [/node:net/u, /node:http/u, /node:https/u, /node:child_process/u, /\bfetch\(/u]) {
    assert.equal(pattern.test(runnerSource), false, 'runner 源码出现了被禁止的能力：' + pattern);
  }
});

test('清单：范围锁死为 owner 私聊，群聊只作为"必须拒绝"的边界', () => {
  const checklist = buildChecklist();
  assert.equal(checklist.scope.channel, 'owner-private');
  assert.deepEqual(checklist.scope.excluded, ['group-chat']);
  assert.equal(checklist.scope.groupOps, false, '清单不得提供任何群操作');
  assert.equal(checklist.scope.ledgerInspection, false, '清单不得通过查阅落盘账本来验收');

  for (const step of checklist.steps) {
    // 通道只有两种：owner 私聊，或"不做操作"。
    assert.ok(
      checklist.scope.channelsAllowed.includes(step.channel),
      step.id + ' 的通道不在允许集合里：' + step.channel,
    );
    assert.equal(step.channel.startsWith('group'), false, step.id + ' 指向了群聊通道');
    // 只有 owner 私聊的步骤才允许人工发消息；"不做操作"的步骤绝不能发。
    if (step.humanActionSends) {
      assert.equal(step.channel, 'owner-private', step.id + ' 在非私聊通道上要求人工发消息');
    }
    if (step.channel === 'none') {
      assert.equal(step.humanActionSends, false, step.id + ' 声明不做操作却要求人工发消息');
    }
  }

  // 群聊边界是一条"不执行"的确认步骤，不是"去群里做一遍"。
  const boundary = checklist.steps.filter((step) => step.channel === 'none');
  assert.ok(boundary.length >= 2, '应至少有一条群聊边界确认 + 一条收尾步骤不做操作');
  const groupBoundary = boundary.find((step) => step.id === 'R-07');
  assert.ok(groupBoundary, '缺少群聊边界确认步骤 R-07');
  assert.equal(groupBoundary.humanActionSends, false);
  assert.match(groupBoundary.expect, /永久排除/u);
  assert.match(groupBoundary.expect, /不要/u, '必须明确写"不要"去真实群验证');
  assert.ok(groupBoundary.record.some((entry) => entry.field === 'groupMessagesSent'));

  // 前置条件里必须写清"只做私聊 / 群聊永久排除"。
  const preconditions = checklist.preconditions.join('\n');
  assert.match(preconditions, /只做 owner 私聊/u);
  assert.match(preconditions, /群聊是永久排除项/u);
  assert.match(preconditions, /不加入任何群/u);

  // 不再要求群成员知情或参与。
  const authorizations = checklist.authorizations.join('\n');
  assert.equal(/群成员/u.test(authorizations), false);
  assert.match(authorizations, /不做任何群操作/u);
});

test('清单：任何一步都不要求读取落盘账本/记忆/日志正文', () => {
  const checklist = buildChecklist();
  for (const step of checklist.steps) {
    assert.equal(step.readsData, false, step.id + ' 要求读取落盘数据');
  }
  assert.equal(checklist.boundary.reads.repoData, false);
  assert.equal(checklist.boundary.reads.memory, false);
  assert.equal(checklist.boundary.reads.memoryFiles, false);
  assert.equal(checklist.boundary.reads.ledger, false);
  assert.equal(checklist.boundary.reads.logBody, false);
  assert.equal(checklist.boundary.reads.logs, false);

  // 记忆只按 owner 私聊里的可观察表现验收，并显式声明不查落盘。
  const recall = checklist.steps.find((step) => step.id === 'R-08');
  assert.ok(recall, '缺少记忆观察步骤 R-08');
  assert.equal(recall.channel, 'owner-private');
  assert.equal(recall.readsData, false);
  const ledger = recall.record.find((entry) => entry.field === 'ledgerOpened');
  const logBody = recall.record.find((entry) => entry.field === 'logBodyRead');
  assert.deepEqual(ledger, { field: 'ledgerOpened', expected: false });
  assert.deepEqual(logBody, { field: 'logBodyRead', expected: false });
  assert.match(recall.expect, /不靠本清单|不查阅/u);

  // 停止条件必须能兜住"翻账本/读日志正文"和"进群"。
  const stops = checklist.stopConditions.join('\n');
  assert.match(stops, /落盘账本/u);
  assert.match(stops, /进入群聊/u);

  // 边界说明里必须写清群聊排除与记忆落盘不由本清单验收。
  const notes = checklist.notAutomated.join('\n');
  assert.match(notes, /群聊永久排除/u);
  assert.match(notes, /记忆落盘/u);
});

test('清单：不是要求进群操作的文案（历史措辞不回来）', () => {
  const checklist = buildChecklist();
  const json = JSON.stringify(checklist);
  for (const forbidden of ['测试群', '群成员']) {
    assert.equal(json.includes(forbidden), false, '清单里出现了 ' + forbidden);
  }
  const source = fs.readFileSync(CHECKLIST_FILE, 'utf8');
  for (const forbidden of ['测试群', '群成员']) {
    assert.equal(source.includes(forbidden), false, '源码里出现了 ' + forbidden);
  }
});

/* ═══════ 9b. 清单：结构化 record / 群操作扫描 / sends 语义 ═══════ */

test('清单：R-07 的 record 是结构化 {field, expected}，并给出明确期望值', () => {
  const checklist = buildChecklist();

  // 所有 step 的 record 条目都必须是有 field/expected 的对象，而不是裸字符串。
  for (const step of checklist.steps) {
    assert.ok(Array.isArray(step.record) && step.record.length > 0, step.id + ' 缺少 record');
    for (const entry of step.record) {
      assert.equal(typeof entry, 'object', step.id + ' 的 record 条目仍是字符串');
      assert.notEqual(entry, null);
      assert.equal(typeof entry.field, 'string', step.id + ' 的 record 条目缺少 field');
      assert.equal(entry.field.length > 0, true);
      assert.ok(Object.hasOwn(entry, 'expected'), step.id + '/' + entry.field + ' 缺少 expected');
    }
  }

  const r07 = checklist.steps.find((step) => step.id === 'R-07');
  assert.ok(r07, '缺少群聊边界步骤 R-07');
  assert.equal(r07.channel, 'none');
  assert.equal(r07.humanActionSends, false, 'R-07 不允许要求人工发消息');
  assert.equal(r07.readsData, false);

  const byField = (field) => r07.record.find((entry) => entry.field === field);
  assert.deepEqual(byField('joinedAnyGroup'), { field: 'joinedAnyGroup', expected: false });
  assert.deepEqual(byField('groupMessagesSent'), { field: 'groupMessagesSent', expected: 0 });
  assert.deepEqual(
    byField('offlineEvidenceRef'),
    { field: 'offlineEvidenceRef', expected: PLACEHOLDERS.evidenceRef },
  );
  // 硬性期望必须是真正的类型值，不能是 "0 ..." / "false ..." 这种字符串。
  assert.equal(typeof byField('groupMessagesSent').expected, 'number');
  assert.equal(typeof byField('joinedAnyGroup').expected, 'boolean');
  assert.equal(typeof byField('offlineEvidenceRef').expected, 'string');
});

test('清单：所有步骤的 action/expect 都不含正向群操作（合成违例样本必须被识别）', () => {
  const checklist = buildChecklist();
  for (const step of checklist.steps) {
    assert.deepEqual(
      findPositiveGroupActions(step.action),
      [],
      step.id + ' 的 action 含正向群操作：' + findPositiveGroupActions(step.action).join(' | '),
    );
    assert.deepEqual(
      findPositiveGroupActions(step.expect),
      [],
      step.id + ' 的 expect 含正向群操作：' + findPositiveGroupActions(step.expect).join(' | '),
    );
  }

  // 合成违例样本：扫描器必须真的能识别，否则上面的全绿毫无意义。
  const violations = [
    '在测试群里发一条消息',
    '先在群里说一句，再 @ 他一次',
    '把群会话加入白名单',
    '去群组里发言并 @ 一次',
    '邀请对方进群再聊',
    '在群里被 @ 之后回一句',
    // 同一个分句里混着禁止词、但后半句才是真正的正向动作（转折切分必须生效）。
    '不要只在私聊而直接在群里发一条消息',
    '不要偷偷做，但要在他群里 @ 一次',
  ];
  for (const sample of violations) {
    assert.ok(
      findPositiveGroupActions(sample).length > 0,
      '扫描器漏掉了违例样本：' + sample,
    );
  }

  // 合法的禁止 / no-op / 排除说明不能被误伤。
  const allowed = [
    '群聊是永久排除项，不加入任何群',
    '本步不做任何操作：不在群里发消息',
    '不要为了验证这条去真实群里发消息或 @ 一次',
    '群聊入口必须被拒绝',
    '本轮没有发生群操作',
    '清单不提供任何群操作',
  ];
  for (const sample of allowed) {
    assert.deepEqual(
      findPositiveGroupActions(sample),
      [],
      '合法说明被扫描器误伤：' + sample,
    );
  }

  // 每个 step 的 record 字段名也不该暗示"要发群消息"。
  for (const step of checklist.steps) {
    for (const entry of step.record) {
      assert.deepEqual(findPositiveGroupActions(entry.field), [], step.id + ' 的 record 字段名像群操作');
    }
  }
});

test('清单：humanActionSends 只描述人工动作，与清单自身 sends=0 分开', () => {
  const checklist = buildChecklist();

  // 两个 "sends" 是不同维度，必须各自可读。
  assert.equal(checklist.boundary.sends, 0, '清单自身永不发送');
  assert.equal(checklist.boundary.sendsMeaning, 'checklist-itself');
  assert.equal(checklist.boundary.humanActionSendsMeaning, 'step-operator-action');
  assert.match(checklist.scope.humanActionSendsNote, /humanActionSends/u);
  assert.match(checklist.scope.humanActionSendsNote, /清单自身不会发送|恒为 0/u);

  // 步骤上不再有歧义的 sends 字段。
  for (const step of checklist.steps) {
    assert.equal(Object.hasOwn(step, 'sends'), false, step.id + ' 仍带歧义字段 sends');
    assert.equal(typeof step.humanActionSends, 'boolean', step.id + ' 缺少 humanActionSends');
  }

  // 人工发消息只发生在 owner 私聊；不做操作的步骤一律不发。
  const senders = checklist.steps.filter((step) => step.humanActionSends);
  assert.ok(senders.length > 0, '至少应有几步需要人工在私聊里发消息');
  for (const step of senders) {
    assert.equal(step.channel, 'owner-private', step.id + ' 在非私聊通道要求人工发消息');
  }
  for (const step of checklist.steps.filter((item) => item.channel === 'none')) {
    assert.equal(step.humanActionSends, false, step.id + ' 不做操作却要求人工发消息');
  }

  // 人类可读输出也要把"执行人需发消息"和清单自身不发送讲清楚。
  const text = formatChecklist(checklist);
  assert.match(text, /执行人需发消息/u);
  assert.match(text, /清单自身不会发送/u);
});


test('清单：main 的返回值语义（0 正常 / 2 拒绝）', () => {
  const sink = collector();
  assert.equal(checklistMain(['--dry-run'], { log: sink.log }), EXIT_OK);
  assert.ok(sink.text().includes('人工记录字段'));
  assert.equal(checklistMain(['--send'], { log: collector().log }), EXIT_USAGE);
  assert.equal(checklistMain([], { log: collector().log }), EXIT_OK);
});

/* ═══════════════════ 10. 场景元数据一致性 ═══════════════════ */
test('场景表：SCENARIOS 与 findScenario/coveredScenarios 口径一致', () => {
  assert.equal(listScenarios().length, SCENARIOS.length);
  for (const scenario of SCENARIOS) {
    assert.equal(findScenario(scenario.id), scenario);
    for (const alias of scenario.aliases ?? []) {
      assert.equal(findScenario(alias), scenario, '别名 ' + alias + ' 没解析到 ' + scenario.id);
    }
  }
  assert.equal(findScenario('   '), null);
  assert.equal(findScenario('b-01'), null, 'id 大小写敏感，避免歧义');
});

test('场景定义：期望值是字面量，不引用产品常量（否则产品改了就恒真）', async () => {
  const sources = ['scenarios.mjs', 'presence-scenarios.mjs']
    .map((file) => fs.readFileSync(path.join(HERE, file), 'utf8'));
  for (const constant of [
    'DEFAULT_DROP_ORDER',
    'TOOL_RESULT_CODES',
    // 媒体侧同理：错误码/置信度阈值必须是字面量，不能从 contracts.js 借。
    'MEDIA_ERROR',
    'DEFAULT_MIN_CONFIDENCE',
    // presence 侧同理：落盘字段/状态文件名/诊断码/intent kind 都得是字面量。
    'PRESENCE_STATE_KEYS',
    'PRESENCE_QQ_STATE_FILE',
    'PRESENCE_QQ_DIAGNOSTIC_CODES',
    'PRESENCE_INTERACTION_KINDS',
    'PRESENCE_LEDGER_STATUSES',
  ]) {
    // 只查"真的用上了"（import 或成员访问），注释里提到名字不算。
    const usage = new RegExp('\\b' + constant + '\\s*[.[]|import[^;\\n]*\\b' + constant + '\\b', 'u');
    for (const source of sources) {
      assert.equal(
        usage.test(source),
        false,
        '场景表引用了产品常量 ' + constant + '：期望值会跟着产品走，断言恒真',
      );
    }
  }

  const harness = createHarness();
  const capture = captureConsole();
  try {
    const b16 = await runScenario('B-16', { harness });
    assert.equal(b16.status, 'pass');
    // 丢弃顺序是契约：必须是字面量。
    assert.equal(b16.steps[2].expected.droppedParts, 'recent|memory|situation');
    // 预算内那一步不能拿自己的输出当期望（charsUsed 自己等于自己）。
    assert.equal(b16.steps[0].expected.partsUnchanged, true);
    assert.equal(Object.hasOwn(b16.steps[0].expected, 'charsUsed'), false, '预算内断言仍在自己等于自己');

    const b10 = await runScenario('B-10', { harness });
    assert.equal(b10.status, 'pass');
    assert.equal(b10.steps[0].expected.stopCode, 'handler-failed');
    assert.equal(b10.steps[0].expected.rollbackCode, 'handler-failed');

    // 增补场景同样只写闭合码字面量：确认/媒体错误码不能是产品常量的别名。
    const x03 = await runScenario('X-03', { harness });
    assert.equal(x03.status, 'pass');
    assert.equal(x03.steps[0].expected.reuse, 'confirmation-used');
    assert.equal(x03.steps[1].expected.highRiskExecute, 'risk-not-allowed');

    const x04 = await runScenario('X-04', { harness });
    assert.equal(x04.status, 'pass');
    assert.equal(x04.steps[0].expected.reason, 'low-confidence-needs-confirmation');
    assert.equal(x04.steps[3].expected.code, 'tts-failed');

    const x05 = await runScenario('X-05', { harness });
    assert.equal(x05.status, 'pass');
    // presence 侧的闭合码/intent kind/落盘字段也必须是字面量。
    assert.equal(x05.steps[1].expected.returnedKinds, 'welcome-back');
    assert.equal(x05.steps[1].expected.deliveryStatus, 'accepted');
    assert.equal(x05.steps[2].expected.insideCooldownWindow, true);
    assert.equal(x05.steps[4].expected.returnIntents, 0);
    assert.equal(x05.steps[5].expected.groupStatus, 'not-private');
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

/* ═══════════ 11. 增补场景 X-03 / X-04 / X-05 的证据边界 ═══════════ */

test('增补：X-03 的审计证据不含参数正文/凭据，只留摘要与关联标识', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    const result = await runScenario('X-03', { harness });
    assert.equal(result.status, 'pass');
    assert.ok(result.steps.length >= 2);
    const evidence = JSON.stringify(result.steps);
    // 场景里喂给工具的哨兵正文绝不能出现在证据里（审计摘要最多 16 位十六进制）。
    assert.equal(evidence.includes('SENTINEL-X03-body-must-not-leak'), false, '参数正文进了证据');
    assert.equal(evidence.includes('SENTINEL-X03-other-body'), false, '另一份参数正文进了证据');
    assert.equal(result.steps[1].actual.leakedBody, false);
    assert.equal(result.steps[1].actual.leakedActionId, false);
    assert.equal(result.steps[1].actual.digestCount, 5);
    assert.equal(result.steps[1].expected.highRiskExecute, 'risk-not-allowed');
    assert.deepEqual(result.artifacts.modules, ['tools/registry.js']);
    // 纯内存工具场景不落盘：证据里不该冒出一个临时文件。
    assert.deepEqual(result.artifacts.tempFiles, []);
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

test('增补：X-04 的离线媒体证据——只用临时目录、临时音频删干净', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    const result = await runScenario('X-04', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 4);
    const evidence = JSON.stringify(result.steps);
    assert.equal(evidence.includes('x04-synthetic-audio-bytes'), false, '音频正文进了证据');
    // 临时音频 put 两次、delete 两次，删除后不留文件（也不留 .tmp）。
    assert.equal(result.steps[2].actual.auditActions, 'put|delete|put|delete');
    assert.equal(result.steps[2].actual.filesLeft, 0);
    assert.equal(result.steps[2].actual.leakedPayload, false);
    assert.deepEqual(result.artifacts.tempFiles, []);
    assert.deepEqual(result.artifacts.modules, [
      'media/pipeline.js', 'media/offline-stub.js', 'media/store.js',
    ]);
    // 低置信度那一轮确实一条记忆都没写，TTS 失败那一轮确实保留了文字。
    assert.equal(result.steps[0].actual.memoryWrites, 0);
    assert.equal(result.steps[3].actual.fallbackKept, true);
    assert.equal(result.steps[3].actual.hasAudioRef, false);
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

test('增补：X-05 的离线 presence 证据——只发唯一 owner、状态文件无正文、重启不补发', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    const result = await runScenario('X-05', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 6);

    // ① 闸门：默认关 / owner 缺失 / 不在白名单都不发送、不落盘。
    assert.equal(result.steps[0].actual.noConfigStatus, 'disabled');
    assert.equal(result.steps[0].actual.missingStatus, 'owner-missing');
    assert.equal(result.steps[0].actual.notWhitelistedStatus, 'owner-not-whitelisted');
    assert.equal(result.steps[0].actual.notWhitelistedOwner, null);
    assert.equal(result.steps[0].actual.sends, 0);
    assert.equal(result.steps[0].actual.stateFiles, 0);

    // ② away → present 只出一条 welcome，且收件人只有一个、就是配置的 owner
    // （配置的 owner 故意不排在 ownerIds 第一位，"发给白名单第一项"会在这里露出来）。
    assert.equal(result.steps[1].actual.returnedKinds, 'welcome-back');
    assert.equal(result.steps[1].actual.distinctRecipients, 1);
    assert.equal(result.steps[1].actual.recipientIsConfiguredOwner, true);
    assert.equal(result.steps[1].actual.groupChannelSends, 0);

    // ③ 冷却窗口内再回来一次：没有第二条 intent，也没有第二条消息。
    assert.equal(result.steps[2].actual.intents, 0);
    assert.equal(result.steps[2].actual.sends, 1);
    assert.equal(result.steps[2].actual.insideCooldownWindow, true);
    assert.equal(result.steps[2].actual.ledgerEntries, 1);

    // ④ 状态文件只有白名单字段，且一个中文都没有（正文是中文兜底文案）。
    assert.equal(
      result.steps[3].actual.keys,
      'activeMs|cooldowns|deliveredIds|kind|sessionStartedAt|state|updatedAt|version',
    );
    assert.equal(result.steps[3].actual.nonAsciiChars, 0, '状态文件里出现了正文');
    assert.equal(result.steps[3].actual.leakedBody, false, '状态文件包含 intent 正文');
    assert.equal(result.steps[3].actual.ledgerStatuses, 'accepted');

    // ⑤ 重启：冷却与台账都从同一个临时目录恢复，旧欢迎不补发、重复欢迎不再发。
    assert.equal(result.steps[4].actual.restored, true);
    assert.equal(result.steps[4].actual.cooldownMs, 5400000);
    assert.equal(result.steps[4].actual.ledgerEntries, 1);
    assert.equal(result.steps[4].actual.pendingEvents, 0);
    assert.equal(result.steps[4].actual.resendAfterRestart, 0);
    assert.equal(result.steps[4].actual.returnIntents, 0);
    assert.equal(result.steps[4].actual.sendsAfterCycle, 0);
    assert.equal(result.steps[4].actual.ledgerAfterCycle, 1);

    // ⑥ owner 私聊作废旧 pending 且不自指；群聊/非 owner 不动 pending。
    // 这一步的 host 是「真的能发」的：第一次回来确实发出去一条（sendsAfterWelcome=1），
    // 第二条被 15 分钟最小间隔留在 pending；等走出最小间隔后 owner 才说话，所以
    // 「这一拍没发」不是配置决定的——真路由出去就会发。
    assert.equal(result.steps[5].actual.welcomeDelivery, 'accepted');
    assert.equal(result.steps[5].actual.sendsAfterWelcome, 1);
    assert.equal(result.steps[5].actual.gapBlockedDelivery, 'min-gap');
    assert.equal(result.steps[5].actual.pendingBeforeOwner, 1);
    assert.equal(result.steps[5].actual.ownerInvalidated, 1);
    assert.equal(result.steps[5].actual.ownerPending, 0);
    assert.equal(result.steps[5].actual.ownerSuppressedIntents, 1);
    assert.equal(result.steps[5].actual.ownerSelfSend, 0);
    assert.equal(result.steps[5].actual.ownerTickStatus, 'idle');
    assert.equal(result.steps[5].actual.groupStatus, 'not-private');
    assert.equal(result.steps[5].actual.groupPendingBefore, 1);
    assert.equal(result.steps[5].actual.groupPending, 1);
    assert.equal(result.steps[5].actual.strangerStatus, 'not-owner');
    assert.equal(result.steps[5].actual.strangerPending, 1);

    // 证据里不该出现合成账号，也不该出现任何 intent 正文。
    const evidence = JSON.stringify(result.steps);
    assert.equal(/owner-synthetic|stranger-synthetic/u.test(evidence), false, '合成账号进了证据');
    // 确实有一条合成正文被发出（否则"证据里没有正文"毫无意义），但它不进证据。
    assert.equal(result.steps[1].actual.textNonEmpty, true);
    assert.deepEqual(result.steps[1].delivery.texts, []);

    // 跑的是真实入口装配，且只在临时目录里落盘（三个状态文件都在 x05/ 下）。
    assert.deepEqual(result.artifacts.modules, [
      'presence-qq-runtime.js',
      'humanize.js',
      'presence/session.js',
      'presence/persistence.js',
      'presence/qq-adapter.js',
    ]);
    assert.deepEqual(result.artifacts.tempFiles, [
      'x05/chat/presence-qq-state.json',
      'x05/data/presence-qq-state.json',
      'x05/group/presence-qq-state.json',
    ]);
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

﻿/* ═══════════ 12. B-07 模糊提醒：澄清而不是猜时间 ═══════════ */

test('runner：B-07 模糊提醒只澄清（零任务 / 无已创建回执），明确提醒作正对照', async () => {
  const { code, report } = await runWithReport(['--offline']);
  assert.equal(code, EXIT_OK);
  const b07 = report.scenarios.find((scenario) => scenario.id === 'B-07');
  assert.equal(b07.status, 'pass', JSON.stringify(b07.diagnostics));
  assert.equal(b07.gate, 'b');
  assert.equal(b07.stepCount, 2);
  assert.equal(b07.diffCount, 0);

  const [ambiguous, explicit] = b07.steps;

  // ① 模糊：只澄清，0 次生成、0 条任务、0 次聊天发送（命令消息没掉进生成链）。
  assert.equal(ambiguous.actual.calls, 0, '模糊提醒触发了模型生成');
  assert.equal(ambiguous.actual.clarifyReplies, 2);
  assert.equal(ambiguous.actual.createdReplies, 0, '出现了"好，到点提醒你"回执');
  assert.equal(ambiguous.actual.taskIdMentions, 0, '澄清里带了任务 ID');
  assert.equal(ambiguous.actual.snapshotExists, false, '模糊提醒竟然落了盘');
  assert.equal(ambiguous.actual.records, 0);
  assert.equal(ambiguous.actual.chatSends, 0);
  assert.equal(ambiguous.task.status, 'none');

  // ② 正对照：同一装配下明确提醒确实新建 1 条 queued 并回复任务 ID。
  //    没有这一步，①的"零任务"可能只是"命令层没接线"。
  assert.equal(explicit.actual.createdReplies, 1, '明确提醒也没建任务：命令层没接线，①的零任务不算证据');
  assert.equal(explicit.actual.taskIdMentions, 1);
  assert.equal(explicit.actual.records, 1);
  assert.equal(explicit.actual.recordText, '喝水');
  assert.equal(explicit.actual.status, 'queued');
  assert.equal(explicit.task.status, 'queued');
  assert.equal(explicit.actual.calls, 0, '明确提醒不该走生成链');

  // 覆盖计数契约：B-07 不再是永久缺口，但也仍不是"B 门全绿"。
  assert.equal(report.coverage.notCoveredBIds.includes('B-07'), false);
  assert.equal(report.coverage.notExecutedBIds.includes('B-07'), false);
  assert.deepEqual(report.coverage.coveredBIds, [
    'B-01', 'B-02', 'B-06', 'B-07', 'B-08', 'B-09', 'B-10', 'B-11', 'B-13', 'B-16', 'B-17',
  ]);
  assert.equal(report.summary.bGatePassed, 11);
  assert.equal(report.summary.coverageDenominator, 18);
  assert.equal(report.summary.completeBGate, false);

  // 任务 ID 是随机 UUID：证据里一个都不能有（否则报告不再逐字节可复现）。
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/u.test(JSON.stringify(b07.steps)), false, '任务 ID 进了证据');
  // 只有正对照那一步落盘（模糊那批一个文件都没留）。
  assert.deepEqual(b07.artifacts.tempFiles, ['b07/data/reminders.json']);
  assert.equal(b07.artifacts.limitation, 'cli-assembly-offline-synthetic-transport');
});

/* ═══════════ 13. B-08 消息与到期提醒同时发生 ═══════════ */

test('runner：B-08 提醒不覆盖在途消息、消息不吞掉到期提醒，终态不重发', async () => {
  const { code, report } = await runWithReport(['--offline']);
  assert.equal(code, EXIT_OK);
  const b08 = report.scenarios.find((scenario) => scenario.id === 'B-08');
  assert.equal(b08.status, 'pass', JSON.stringify(b08.diagnostics));
  assert.equal(b08.gate, 'b');
  assert.equal(b08.stepCount, 2);
  assert.equal(b08.diffCount, 0);

  const [before, after] = b08.steps;

  // ① 回复还在生成：提醒已经 claim 并排进同一条会话队列，但一条都没发。
  assert.equal(before.actual.calls, 1);
  assert.equal(before.actual.chatSends, 0, '生成还没放行就发出了回复');
  assert.equal(before.actual.reminderSends, 0, '提醒抢在在途回复前面发了出去');
  assert.equal(before.actual.dispatchSettled, false, '派发在回复完成前就结束了');
  assert.equal(before.actual.claimStatus, 'processing');
  assert.equal(before.actual.claimAttempt, 1);
  assert.equal(before.task.status, 'processing', 'claim 没在第一次 await 之前落盘');

  // ② 放行后：回复先发、提醒后发，各一次；提醒落终态；再派发空结果、不重发。
  assert.equal(after.actual.order, 'chat|reminder', '提醒先于回复完成就发了，或者回复被提醒挤掉');
  assert.equal(after.actual.chatSends, 1, '在途消息被提醒覆盖/吞掉');
  assert.equal(after.actual.chatTexts, '在呢');
  assert.equal(after.actual.reminderSends, 1, '提醒丢了或重复发了');
  assert.equal(after.actual.reminderUserId, '10001');
  assert.equal(after.actual.resultStatus, 'sent');
  assert.equal(after.actual.status, 'sent');
  assert.equal(after.actual.attempt, 1);
  assert.equal(after.actual.firedAtSet, true);
  assert.equal(after.actual.redispatch, 'null', '终态之后又派发出一条提醒');
  assert.equal(after.actual.statusAfter, 'sent');
  assert.equal(after.actual.reminderSendsAfter, 1, '重复派发重发了提醒');

  // 覆盖计数契约：B-08 不再是永久缺口，但 B 门仍不是全绿（真实 QQ 侧没有离线证据）。
  assert.equal(report.coverage.notCoveredBIds.includes('B-08'), false);
  assert.equal(report.coverage.notExecutedBIds.includes('B-08'), false);
  assert.equal(report.summary.bGatePassed, 11);
  assert.equal(report.summary.completeBGate, false);

  // 只证明通用 CLI 组件的离线层：证据里写明边界，落盘只在 b08/ 临时目录。
  assert.equal(b08.artifacts.limitation, 'cli-assembly-offline-synthetic-transport');
  assert.match(b08.artifacts.note, /离线并发层/u);
  assert.deepEqual(b08.artifacts.tempFiles, [
    'b08/data/reminders.json', 'b08/memory/people.json', 'b08/memory/turns.jsonl',
  ]);
});

/* ═══════════ 14. C 门离线 presence（C-03/C-04/C-05…C-09） ═══════════ */

test('C 矩阵：六个离线 presence 场景全部 pass；C-01/C-02 仍 not-covered；B 门不变', async () => {
  const harness = createHarness();
  const capture = captureConsole();
  try {
    for (const id of ['C-03', 'C-04', 'C-05', 'C-07', 'C-08', 'C-09']) {
      const result = await runScenario(id, { harness });
      assert.equal(result.status, 'pass', id + ' 未通过：' + JSON.stringify(result.diagnostics));
      assert.equal(result.gate, 'group');
      assert.ok(result.steps.length >= 2, id + ' 的证据步数不足');
      assert.equal(typeof result.artifacts.limitation, 'string', id + ' 缺少合成证据范围说明');
    }
    for (const id of ['C-01', 'C-02']) {
      const result = await runScenario(id, { harness });
      assert.equal(result.status, 'not-covered', id + ' 不该被当成通过');
      assert.equal(result.ok, false);
      assert.deepEqual(result.steps, []);
      assert.equal(result.diagnostics[0].code, 'not-covered');
    }
    assert.equal(findScenario('C-06').id, 'C-05');
    assert.equal(findScenario('C-05').status, 'covered');
    // C 门独立计分，B 门分母与永久缺口都不动。
    assert.equal(bGateIds().length, 18);
    assert.equal(notCoveredBIds().length, 7);
  } finally {
    capture.restore();
    harness.cleanup();
  }
});

/* ═══════════════ 15. D/E 离线契约场景（D-01…D-03 / E-01…E-04） ═══════════════ */

test('D-01：离线 ASR 桩返回转写/置信度/元数据，且没有 memory port 时不写长期记忆', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('D-01', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 1);
    const step = result.steps[0];
    assert.equal(step.actual.ok, true);
    assert.equal(step.actual.text, '今天有点累');
    assert.equal(step.actual.confidence, 0.92);
    assert.equal(step.actual.provider, 'offline-asr-stub');
    assert.equal(step.actual.mime, 'audio/ogg');
    assert.equal(step.actual.eligible, true);
    assert.equal(step.actual.written, false);
    assert.equal(step.actual.reason, 'memory-port-missing');
    assert.equal(step.actual.hasError, false);
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('D-02：ASR 失败返回 asr-failed + ask-repeat，保留元数据', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('D-02', { harness });
    assert.equal(result.status, 'pass');
    const step = result.steps[0];
    assert.equal(step.actual.ok, false);
    assert.equal(step.actual.code, 'asr-failed');
    assert.equal(step.actual.action, 'ask-repeat');
    assert.equal(step.actual.retryable, true);
    assert.equal(step.actual.ref, 'synthetic://d02/voice-1');
    assert.equal(step.actual.transcript, null);
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('D-03：TTS 显式失败与超时都保留文字回退，不落音频', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('D-03', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 2);
    assert.deepEqual(result.steps.map((step) => step.actual.code), ['tts-failed', 'timeout']);
    for (const step of result.steps) {
      assert.equal(step.actual.ok, false);
      assert.equal(step.actual.fallbackKept, true);
      assert.equal(step.actual.fallbackChars, 6);
      assert.equal(step.actual.audioRef, null);
      assert.equal(step.actual.stored, 0);
      assert.deepEqual(step.diff, []);
    }
  } finally {
    harness.cleanup();
  }
});

test('E-01：未知工具返回 unknown-tool，不执行也不落审计', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('E-01', { harness });
    assert.equal(result.status, 'pass');
    const step = result.steps[0];
    assert.equal(step.actual.ok, false);
    assert.equal(step.actual.code, 'unknown-tool');
    assert.equal(step.actual.auditEntries, 0);
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('E-02：需确认工具拒绝后不重试，handler 不执行', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('E-02', { harness });
    assert.equal(result.status, 'pass');
    const step = result.steps[0];
    assert.equal(step.actual.withoutId, 'confirmation-required');
    assert.equal(step.actual.pending, 'confirmation-pending');
    assert.equal(step.actual.denyStatus, 'denied');
    assert.equal(step.actual.denied, 'confirmation-denied');
    assert.equal(step.actual.retry, 'confirmation-denied');
    assert.equal(step.actual.handlerRuns, 0);
    assert.equal(step.actual.requestAudit, 1);
    assert.equal(step.actual.decisionAudit, 1);
    assert.equal(step.actual.deniedAudit, 2);
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('E-03：工具超时返回 timeout 并留下 timeout 审计', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('E-03', { harness });
    assert.equal(result.status, 'pass');
    const step = result.steps[0];
    assert.equal(step.actual.ok, false);
    assert.equal(step.actual.code, 'timeout');
    assert.equal(step.actual.auditLastCode, 'timeout');
    assert.equal(step.actual.auditLastEvent, 'execute');
    assert.equal(step.actual.elapsedAtLeast15, true);
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('E-04：高风险工具默认 risk-not-allowed，handler 不执行', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('E-04', { harness });
    assert.equal(result.status, 'pass');
    const step = result.steps[0];
    assert.equal(step.actual.ok, false);
    assert.equal(step.actual.code, 'risk-not-allowed');
    assert.equal(step.actual.handlerRuns, 0);
    assert.equal(step.actual.auditLastCode, 'risk-not-allowed');
    assert.equal(step.actual.auditConfirmation, 'not-required');
    assert.deepEqual(step.diff, []);
  } finally {
    harness.cleanup();
  }
});

test('D-04：低置信度确认前不进聊天/记忆，确认后只处理一次', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('D-04', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 3);
    const [pending, confirmed, again] = result.steps;

    // ① 确认前：只挂待确认；聊天为空、记忆零写入；入参 confirmed 不能绕过。
    assert.equal(pending.actual.ok, true);
    assert.equal(pending.actual.decision, 'needs-confirmation');
    assert.equal(pending.actual.chatEntries, 0);
    assert.equal(pending.actual.memoryWrites, 0);
    assert.equal(pending.actual.memoryWritten, false);
    assert.equal(pending.actual.memoryReason, 'low-confidence-needs-confirmation');
    assert.equal(pending.actual.pendingCount, 1);
    assert.equal(pending.actual.pendingChars, 8);
    assert.equal(pending.actual.pendingExposesText, false);
    assert.equal(pending.actual.bypassRejected, true);
    assert.equal(pending.actual.sends, 0);
    assert.equal(pending.actual.storeEntries, 0);

    // ② 确认后：才进聊天，记忆只写一次。
    assert.equal(confirmed.actual.ok, true);
    assert.equal(confirmed.actual.decision, 'chat');
    assert.equal(confirmed.actual.chatText, '合成低置信度转写');
    assert.equal(confirmed.actual.chatSource, 'asr-confirmed');
    assert.equal(confirmed.actual.chatEntries, 1);
    assert.equal(confirmed.actual.memoryWrites, 1);
    assert.equal(confirmed.actual.memoryWritten, true);
    assert.equal(confirmed.actual.memoryReason, 'written');
    assert.equal(confirmed.actual.writeSource, 'asr-confirmed');
    assert.equal(confirmed.actual.pendingCount, 0);
    assert.equal(confirmed.actual.sends, 0);
    assert.equal(confirmed.actual.storeEntries, 0);

    // ③ 重复确认：同一条转写不会再次处理。
    assert.equal(again.actual.ok, false);
    assert.equal(again.actual.code, 'confirm-not-found');
    assert.equal(again.actual.decision, 'text-fallback');
    assert.equal(again.actual.chatEntries, 1);
    assert.equal(again.actual.memoryWrites, 1);
    assert.equal(again.actual.pendingCount, 0);
    assert.equal(again.actual.sends, 0);
    assert.equal(again.actual.storeEntries, 0);

    // 证据里不能出现随机待确认 id 或合成音频正文（否则报告不再可复现）。
    const evidence = JSON.stringify(result.steps);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/u.test(evidence), false, '待确认 id 进了证据');
    assert.equal(evidence.includes('d04-synthetic-audio-bytes'), false, '音频正文进了证据');
    assert.deepEqual(result.artifacts.tempFiles, []);
    assert.equal(result.artifacts.limitation, 'voice-runtime-synthetic-asr-memory-port');
    assert.match(result.artifacts.note, /合成测试/u);
  } finally {
    harness.cleanup();
  }
});

test('E-05：宿主桥接审计不含参数正文、异常原文或确认凭据', async () => {
  const harness = createHarness();
  try {
    const result = await runScenario('E-05', { harness });
    assert.equal(result.status, 'pass');
    assert.equal(result.steps.length, 2);
    const [exceptionStep, confirmStep] = result.steps;

    // ① 异常路径：只留 handler-failed、参数摘要与关联标识。
    assert.equal(exceptionStep.actual.readOk, false);
    assert.equal(exceptionStep.actual.readCode, 'handler-failed');
    assert.equal(exceptionStep.actual.auditEvents, 'execute');
    assert.equal(exceptionStep.actual.auditCode, 'handler-failed');
    assert.equal(exceptionStep.actual.digestCount, 1);
    assert.equal(exceptionStep.actual.digestShape, true);
    assert.equal(exceptionStep.actual.correlationPrefixed, true);
    assert.equal(exceptionStep.actual.hasActionIdField, false);
    assert.equal(exceptionStep.actual.hasArgsField, false);
    assert.equal(exceptionStep.actual.leakedBody, false);
    assert.equal(exceptionStep.actual.leakedException, false);
    assert.equal(exceptionStep.actual.leakedResult, false);

    // ② 确认流程：请求/批准/执行/复用之后，整条审计仍然脱敏。
    assert.equal(confirmStep.actual.modelCall, 'confirmation-required');
    assert.equal(confirmStep.actual.requestOk, true);
    assert.equal(confirmStep.actual.requestStatus, 'pending');
    assert.equal(confirmStep.actual.pending, 'confirmation-pending');
    assert.equal(confirmStep.actual.approved, true);
    assert.equal(confirmStep.actual.approvedStatus, 'approved');
    assert.equal(confirmStep.actual.executed, 'ok');
    assert.equal(confirmStep.actual.reuse, 'confirmation-used');
    assert.equal(confirmStep.actual.handlerRuns, 1);
    assert.equal(
      confirmStep.actual.auditEvents,
      'execute|execute|confirmation-request|execute|confirmation-decision|execute|execute',
    );
    assert.equal(confirmStep.actual.auditConfirmations, 'not-required|missing|pending|approved|consumed');
    assert.equal(confirmStep.actual.digestCount, 5);
    assert.equal(confirmStep.actual.digestShape, true);
    assert.equal(confirmStep.actual.correlationPrefixed, true);
    assert.equal(confirmStep.actual.safeKeysOnly, true);
    assert.equal(confirmStep.actual.leakedBody, false);
    assert.equal(confirmStep.actual.leakedException, false);
    assert.equal(confirmStep.actual.leakedActionId, false);
    assert.equal(confirmStep.actual.leakedSessionKey, false);

    // 证据本身也不能夹带这些哨兵串（只留布尔结论）。
    const evidence = JSON.stringify(result.steps);
    assert.equal(evidence.includes('E05-SYNTHETIC-ARG-BODY'), false, '参数正文进了证据');
    assert.equal(evidence.includes('E05-SYNTHETIC-EXCEPTION-TEXT'), false, '异常原文进了证据');
    assert.equal(evidence.includes('e05-act-1'), false, '确认凭据进了证据');
    assert.equal(evidence.includes('e05-synthetic-session-key'), false, '会话凭据进了证据');
    assert.deepEqual(result.artifacts.tempFiles, []);
    assert.equal(result.artifacts.limitation, 'tool-host-bridge-synthetic-fake-tools');
    assert.match(result.artifacts.note, /合成测试/u);
  } finally {
    harness.cleanup();
  }
});

test('D-05 仍明确保留为未覆盖；D-04/E-05 已有独立 run', () => {
  const d05 = findScenario('D-05');
  assert.equal(d05.status, 'not-covered', 'D-05 应保留为未覆盖');
  assert.equal(d05.run, undefined, 'D-05 不能用桩冒充验收');
  assert.ok(d05.reason.length > 0);
  for (const id of ['D-04', 'E-05']) {
    const scenario = findScenario(id);
    assert.equal(scenario.status, 'covered', id + ' 应有独立可执行证据');
    assert.equal(typeof scenario.run, 'function', id + ' 缺少 run');
  }
});

test('D/E 增补不改变 B 门：bGateIds 18，notCoveredBIds 7', () => {
  assert.equal(bGateIds().length, 18);
  assert.equal(notCoveredBIds().length, 7);
});
