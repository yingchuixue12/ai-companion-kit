/**
 * 项目自检 · node scripts/check.mjs
 * ─────────────────────────────────────────────────────────────
 * 不开服务、不连网，只检查：
 *   1. 所有 JS 文件语法能过
 *   2. 两个包的依赖能 import
 *   3. 关键功能冒烟（唤醒判定 / 记忆读写 / 拟人化切分）
 *   4. 有没有漏进来的个人数据（QQ 号 / 密钥 / 本地路径）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 用 pathToFileURL 构造 import 地址，不要手拼 file:///
// （UNC 路径如 \\wsl.localhost\...\ 手拼会把 \\ 变成 file://///，抛
//  "File URL path must be absolute"，WSL 里跑真实 Run 时必炸）。
const LIB_URL = pathToFileURL(path.join(ROOT, 'packages', 'companion', 'src', 'lib.js')).href;
let pass = 0, fail = 0, warn = 0;

function ok(msg) { console.log('  ✅ ' + msg); pass++; }
function bad(msg) { console.log('  ❌ ' + msg); fail++; }
function wrn(msg) { console.log('  ⚠️  ' + msg); warn++; }
function head(msg) { console.log('\n▸ ' + msg); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);

// ── ① 语法 ─────────────────────────────────────────────────────
head('语法检查');
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
    ok(path.relative(ROOT, f));
  } catch (e) {
    bad(path.relative(ROOT, f) + ' → ' + String(e.stderr || e.message).split('\n')[0]);
  }
}

// ── ② 能 import ────────────────────────────────────────────────
head('模块导入');
try {
  const lib = await import(LIB_URL);
  const need = ['Memory', 'Role', 'Brain', 'Humanizer', 'Waker'];
  for (const n of need) {
    if (typeof lib[n] === 'function') ok('companion 导出 ' + n);
    else bad('companion 缺 ' + n);
  }
} catch (e) {
  bad('companion import 失败：' + (e?.message || e));
}

// ── ③ 功能冒烟 ─────────────────────────────────────────────────
head('功能冒烟');
try {
  const { Memory, Humanizer, Waker } = await import(LIB_URL);

  // 唤醒
  // probability: 0 —— 关掉「普通消息按概率随机插话」。Waker 默认 probability=0.05，
  // 不关掉时「无关 → 静音」这条断言每次运行有 5% 概率假失败，CI 会随机变红
  // （随机性本身是产品特性，不是缺陷；这里只让**断言**确定化）。
  const w = new Waker({ names: ['小鱼'], ownerIds: ['10001'], probability: 0 });
  const cases = [
    ['被 @', { key: 'group:1', userId: '2', text: 'hi', isAtMe: true }, true],
    ['叫名字', { key: 'group:1', userId: '2', text: '小鱼在吗' }, true],
    ['主人', { key: 'group:1', userId: '10001', text: '在吗' }, true],
    ['无关', { key: 'group:1', userId: '2', text: '今天天气不错' }, false],
  ];
  for (const [label, msg, want] of cases) {
    const got = w.shouldWake(msg).wake;
    if (got === want) ok('唤醒「' + label + '」→ ' + (got ? '醒' : '静音'));
    else bad('唤醒「' + label + '」期望 ' + want + ' 实际 ' + got);
  }

  // 概率唤醒本身也要有确定性用例：probability=1 时无关消息也会醒（而不是靠 5% 碰运气验证）
  const wProb = new Waker({ names: ['小鱼'], ownerIds: ['10001'], probability: 1 });
  const vProb = wProb.shouldWake({ key: 'group:1', userId: '2', text: '今天天气不错' });
  if (vProb.wake && vProb.reason === 'probability') ok('随机插话（probability=1）→ 醒');
  else bad('随机插话失效：' + JSON.stringify(vProb));

  // 拟人化
  const h = new Humanizer();
  const parts = h.split('第一条。第二条。第三条。');
  if (Array.isArray(parts) && parts.length > 0) ok('切分 → ' + parts.length + ' 条');
  else bad('切分异常');
  const ms = h.typingMsFor('你好啊');
  // 抖动（±20%）和深夜 ×1.6 都是产品特性，所以断言必须按实现契约取边界，
  // 而不是拍一个 1200：'你好啊' 取到 1455ms，负向抖动后约 1164ms，旧的
  // `ms >= 1200` 会随机假失败。
  const lo = Math.round(h.minMs * (1 - h.jitter));
  const hi = Math.round(h.maxMs * (1 + h.jitter) * 1.6);
  if (ms >= lo && ms <= hi) ok('打字时长 ' + ms + 'ms（区间 ' + lo + '~' + hi + '）');
  else bad('打字时长异常：' + ms + '（应在 ' + lo + '~' + hi + '）');
  // 多次采样都要在区间内——单次采样绿不能证明抖动没跑飞。
  let outOfRange = 0;
  for (let i = 0; i < 200; i++) {
    const sample = h.typingMsFor('你好啊');
    if (sample < lo || sample > hi) outOfRange++;
  }
  if (outOfRange === 0) ok('200 次采样都在区间内');
  else bad('200 次采样有 ' + outOfRange + ' 次越界');

  // 记忆
  const tmp = path.join(ROOT, '.tmp-check');
  fs.rmSync(tmp, { recursive: true, force: true });
  const mem = new Memory({ dir: tmp });
  mem.remember('10002', { name: '张三', trait: '常熬夜', fact: '养了只猫' });
  mem.logTurn({ where: 'private:10002', who: '张三', text: '在吗', reply: '在的' });
  const block = mem.renderPerson('10002');
  if (block.includes('常熬夜') && block.includes('养了只猫')) ok('账本读写正常');
  else bad('账本异常');
  const recent = mem.renderRecent(5);
  if (recent.includes('在吗')) ok('对话流正常');
  else bad('对话流异常');
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  bad('冒烟失败：' + (e?.stack || e));
}

// ── ④ 脱敏检查 ─────────────────────────────────────────────────
head('脱敏检查（不该出现的东西）');
const PATTERNS = [
  [/\b\d{10,11}\b/, '疑似 QQ 号（10~11 位数字）'],
  [/sk-[a-zA-Z0-9]{20,}/, '疑似 API key'],
  (/[A-Z]:\\\\?(Users|ai|qq-bridge|platform-tools|Comfy)/i, '疑似本机绝对路径'),
];
const ALLOW = [
  'scripts/check.mjs',       // 本文件自己写了这些模式
  'README.md',               // 文档里可能举例
];
let dirty = 0;
for (const f of files) {
  if (!/\.(js|mjs|json|md|yml|yaml|txt)$/.test(f)) continue;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (ALLOW.includes(rel)) continue;
  const txt = fs.readFileSync(f, 'utf8');
  for (const [re, label] of PATTERNS) {
    const m = txt.match(re);
    if (m) {
      wrn(rel + ' 命中「' + label + '」：' + m[0].slice(0, 40));
      dirty++;
    }
  }
}
if (!dirty) ok('没有发现个人数据 / 密钥 / 本机路径');

// ── 汇总 ───────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log('  通过 ' + pass + ' · 失败 ' + fail + ' · 警告 ' + warn);
if (fail) { console.log('  ❌ 有失败项'); process.exit(1); }
console.log('  ✅ 全部通过');
