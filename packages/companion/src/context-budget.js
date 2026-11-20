/**
 * 上下文预算 · 超预算时按什么顺序减、减多少、留下什么诊断
 * ─────────────────────────────────────────────────────────────
 * 这是**纯规划**模块：不拼标签、不读角色卡、不碰 Memory、不发网络、不读 `data/`。
 * 它只回答一个问题：在调用方给出的 `measure` 尺度下，这三个可减块怎么减才能在预算内，
 * 同时**永远不动**稳定人格层（BASE_RULES / 角色卡 / 人格内核）。
 *
 * 契约来源：`docs/flandre-execution-plan.md` §4.1（签名不可改，只能加字段）。
 * 对应审计缺口：B19 / M-5（按 P-3 丢弃顺序 + 可观测），以及
 * `docs/flandre-memory-contract.md` P-1（L1 永远最前）、P-3（先丢最近对话）、P-4（journal 记 memory-budget）。
 *
 * ── 调用方怎么传 measure ──────────────────────────────────────
 * `measure` 必须是**确定性、无副作用**的函数，接收「当前候选的三块文本」并返回一个可比较的规模数
 * （通常是字符数）。它必须把**稳定人格层一起算进去**，否则预算会算少：
 *
 *   import { Role } from './role.js';
 *   import { planContextBudget } from './context-budget.js';
 *
 *   const role = new Role({ cardPath });              // L1：BASE_RULES + 角色卡 + 人格内核
 *   const extra = { selfNote, platform };             // Role.build 的其它槽位（不在 parts 里）
 *   const measure = (parts) => role.build({ ...parts, ...extra }).length;
 *
 *   const plan = planContextBudget({ measure, parts: { situation, memory, recent }, maxChars });
 *   // 未超预算：plan.parts 与入参逐字节相同，plan.dropped 为空。
 *   // 超预算：plan.parts 是减量后的三块，plan.dropped 说明先丢了谁、丢了多少字符。
 *
 * 硬约束（实现必须满足，测试已固定）：
 *   1. 不修改入参；同输入同输出。
 *   2. `charsUsed` 等于最后一次 `measure` 的返回值。
 *   3. 只做减量：不重排、不改写、不交换块；稳定人格层不在 `parts` 里，因此不可能被丢。
 *   4. 超预算必须体现在 `dropped` 里，不得静默截断。
 *   5. `dropped` / `diagnostics` 只含块名、原因、字符数，**不含任何正文**。
 *
 * `diagnostics[].code`（稳定值，S2 可据此发 `memory-budget` 事件）：
 *   within-budget | over-budget | part-trimmed | part-dropped | trim-insufficient |
 *   over-budget-residual | ignored-extra-parts
 * `dropped[].reason`：`trimmed`（部分裁剪）| `over-budget`（整块丢弃）。
 */

/** 预算规划契约版本（字段增删都要改它） */
export const CONTEXT_BUDGET_VERSION = 1;

/** 默认可减块与丢弃顺序：最近对话 → 长期记忆 → 当前处境（situation 最后才动） */
export const DEFAULT_DROP_ORDER = Object.freeze(['recent', 'memory', 'situation']);

/** `parts` 里允许出现的块名；这是白名单，避免把稳定层当成可减块传进来 */
const BUDGETABLE_PARTS = Object.freeze(['situation', 'memory', 'recent']);

function assertBudgetable(name, where) {
  if (!BUDGETABLE_PARTS.includes(name)) {
    throw new TypeError(where + '只能是 ' + BUDGETABLE_PARTS.join(' / ') + '，收到：' + String(name));
  }
}

function normalizeMaxChars(value) {
  const max = Number(value);
  if (!Number.isFinite(max) || max < 0) {
    throw new TypeError('maxChars 必须是非负有限数字，收到：' + String(value));
  }
  return Math.floor(max);
}

/** 复制并规范化三块文本；缺省/null 视为空串，非字符串直接报错（不静默 coerce） */
function normalizeParts(parts) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    throw new TypeError('parts 必须是 { situation, memory, recent } 对象');
  }
  const out = {};
  for (const name of BUDGETABLE_PARTS) {
    const raw = parts[name];
    if (raw === undefined || raw === null) { out[name] = ''; continue; }
    if (typeof raw !== 'string') {
      throw new TypeError('parts.' + name + ' 必须是字符串，收到：' + typeof raw);
    }
    out[name] = raw;
  }
  return out;
}

function normalizeDropOrder(order) {
  if (order === undefined || order === null) return [...DEFAULT_DROP_ORDER];
  if (!Array.isArray(order)) throw new TypeError('dropOrder 必须是字符串数组');
  const seen = new Set();
  const out = [];
  for (const name of order) {
    assertBudgetable(name, 'dropOrder 的块名');
    const key = String(name);
    if (seen.has(key)) continue;          // 重复项只算一次，保持首现顺序
    seen.add(key);
    out.push(key);
  }
  if (!out.length) throw new TypeError('dropOrder 不能为空数组；不想减任何块就别调用本模块');
  return out;
}

function normalizeTrimMap(trim) {
  if (trim === undefined || trim === null) return {};
  if (typeof trim !== 'object' || Array.isArray(trim)) throw new TypeError('trim 必须是对象映射');
  const out = {};
  for (const [name, fn] of Object.entries(trim)) {
    assertBudgetable(name, 'trim 的块名');
    if (typeof fn === 'function') out[name] = fn;
  }
  return out;
}

function normalizeMinCharsMap(minChars) {
  if (minChars === undefined || minChars === null) return {};
  if (typeof minChars !== 'object' || Array.isArray(minChars)) throw new TypeError('minChars 必须是对象映射');
  const out = {};
  for (const [name, value] of Object.entries(minChars)) {
    assertBudgetable(name, 'minChars 的块名');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new TypeError('minChars.' + name + ' 必须是非负有限数字');
    out[name] = Math.floor(n);
  }
  return out;
}

function substitute(parts, name, value) {
  return { ...parts, [name]: value };
}

/**
 * 在 `[floor, len]` 上二分出**能放进预算的最长**裁剪长度。
 * 前提（调用方契约）：`trim(text, maxChars)` 单调不增——给的 maxChars 越小，输出不更长。
 * 返回 `null` 表示连 floor 都放不下（此时调用方应整块丢弃）。
 */
function bestFitLength(source, floor, measure, parts, name, maxChars, trimFn) {
  const render = (len) => {
    const candidate = trimFn(source, len);
    if (typeof candidate !== 'string') throw new TypeError('trim.' + name + ' 必须返回字符串');
    if (candidate.length > source.length) throw new TypeError('trim.' + name + ' 不得让文本变长');
    return candidate;
  };
  const fits = (len) => measure(substitute(parts, name, render(len))) <= maxChars;

  if (!fits(floor)) return null;
  let lo = floor;
  let hi = source.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}

/**
 * 纯预算规划：不拼接标签、不读 Role、不发网络。
 * measure 由调用方提供（通常是 `role.build(ctx).length`），必须确定性、无副作用。
 * trim 可选；没有 trim 的 part 超预算时整块丢弃。
 *
 * @param {{
 *   measure: (parts: {situation:string, memory:string, recent:string}) => number,
 *   parts: {situation:string, memory:string, recent:string},
 *   maxChars: number,
 *   dropOrder?: string[],
 *   trim?: Partial<Record<'situation'|'memory'|'recent', (text:string, maxChars:number)=>string>>,
 *   minChars?: Partial<Record<'situation'|'memory'|'recent', number>>
 * }} input
 * @returns {{
 *   parts: {situation:string, memory:string, recent:string},
 *   charsUsed: number,
 *   dropped: Array<{part:string, reason:'over-budget'|'trimmed', before:number, after:number}>,
 *   diagnostics: Array<{code:string, part?:string, detail?:string}>,
 *   maxChars: number,
 *   withinBudget: boolean,
 *   version: number
 * }}
 */
export function planContextBudget(input) {
  if (!input || typeof input !== 'object') throw new TypeError('planContextBudget 需要一个对象参数');
  const { measure } = input;
  if (typeof measure !== 'function') throw new TypeError('measure 必须是函数（通常是 role.build(ctx).length）');

  const maxChars = normalizeMaxChars(input.maxChars);
  const dropOrder = normalizeDropOrder(input.dropOrder);
  const trim = normalizeTrimMap(input.trim);
  const minChars = normalizeMinCharsMap(input.minChars);

  const read = (candidate) => {
    const value = measure(candidate);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('measure 必须返回有限数字，收到：' + String(value));
    }
    return value;
  };

  let parts = normalizeParts(input.parts);
  let chars = read(parts);

  const dropped = [];
  const diagnostics = [];
  // parts 里多出来的键不会被本模块保留：调用方必须在 measure / role.build 时自己补回去，
  // 否则 selfNote / platform 这类槽位会静默消失。这里显式提醒，不替调用方猜。
  const extraKeys = Object.keys(input.parts).filter((key) => !BUDGETABLE_PARTS.includes(key));
  if (extraKeys.length) {
    diagnostics.push({ code: 'ignored-extra-parts', detail: extraKeys.join(',') });
  }
  if (chars > maxChars) {
    diagnostics.push({ code: 'over-budget', detail: 'chars=' + chars + ' maxChars=' + maxChars });
  } else {
    diagnostics.push({ code: 'within-budget', detail: 'chars=' + chars + ' maxChars=' + maxChars });
  }

  for (const name of dropOrder) {
    if (chars <= maxChars) break;
    const source = parts[name];
    if (!source) continue;                       // 本来就空，没有可减的东西
    const before = source.length;

    const trimFn = trim[name];
    if (typeof trimFn === 'function') {
      const floor = Math.min(minChars[name] || 0, source.length);
      const candidate = bestFitLength(source, floor, read, parts, name, maxChars, trimFn);
      if (candidate !== null && candidate !== source) {
        parts = substitute(parts, name, candidate);
        chars = read(parts);
        dropped.push({ part: name, reason: 'trimmed', before, after: candidate.length });
        diagnostics.push({ code: 'part-trimmed', part: name, detail: before + '->' + candidate.length });
        continue;
      }
      // 裁剪连下限都放不下（或裁剪没起作用）：退回整块丢弃，保证预算单调收敛
      diagnostics.push({ code: 'trim-insufficient', part: name, detail: before + ' chars 无法在 minChars 内满足预算' });
    }

    parts = substitute(parts, name, '');
    chars = read(parts);
    dropped.push({ part: name, reason: 'over-budget', before, after: 0 });
    diagnostics.push({ code: 'part-dropped', part: name, detail: before + '->0' });
  }

  // charsUsed 必须是最后一次 measure 的结果（可能与循环内的 chars 相同）
  const charsUsed = read(parts);
  if (charsUsed > maxChars) {
    // 只减不增，因此只剩「稳定层 + 不在 dropOrder 里的块」本身就超预算这一种可能
    diagnostics.push({ code: 'over-budget-residual', detail: 'chars=' + charsUsed + ' maxChars=' + maxChars });
  }

  return {
    parts,
    charsUsed,
    dropped,
    diagnostics,
    maxChars,
    withinBudget: charsUsed <= maxChars,
    version: CONTEXT_BUDGET_VERSION,
  };
}

export default planContextBudget;
