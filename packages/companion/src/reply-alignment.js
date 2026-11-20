/**
 * 回复前对齐自检（outbound alignment）
 * ─────────────────────────────────────────────────────────────
 * 这个模块只回答一个问题：**这句话现在还能不能说**。
 *
 * 它不生成人格文案、不调模型、不碰网络，只做确定性的判断，因此同样的输入
 * 永远给出同样的结论（没有随机数，也没有"措辞库"）。
 *
 * 四条判断：
 * 1. 锚点是否仍然成立：如果使用者在这批消息之后又发了更新的消息，这一轮生成的
 *    回复就已经过期，必须放弃（交给更新的那批去回答），不能拿旧话题硬回；
 * 2. 猜谜是否被当成事实：`你是想说…` 这类推测如果被当成陈述句说出来，就属于
 *    没被确认的猜测，要删掉；只有作为问句（征求确认）才允许出现，且一句为限；
 * 3. 问句是不是轮次边界：一段话里只要出现了问句，后面就不能再追判断、换话题或
 *    自问自答；
 * 4. 自检/元叙述：`半拍`、`读岔`、`你说具体点` 这类把错误推回给对方、或者讲解
 *    自己机械节奏的句子一律删掉——指出错误时应该当场修正，而不是让用户来定位。
 *
 * 失败即安全：删完什么都不剩就保持安静（沉默是合法的），绝不补一句固定台词。
 */

/** send = 可以按计划发；silence = 这一轮不说话（最安全的兜底）。 */
export const ALIGNMENT_ACTIONS = Object.freeze(['send', 'silence']);

/** 自检拒绝/削减的具体原因；写进 journal 后属于稳定契约，不要随手改名。 */
export const ALIGNMENT_REASONS = Object.freeze({
  emptyReply: 'empty-reply',
  superseded: 'superseded-anchor',
  ungroundedGuess: 'ungrounded-guess',
  ungroundedQuote: 'ungrounded-quote',
  metaLine: 'meta-line',
  locateErrorQuestion: 'locate-error-question',
  questionBoundary: 'question-boundary',
  partCap: 'part-cap',
});

/** 默认上限：一个用户批次最多 1–2 条消息，条与条之间至少间隔 3 秒。 */
export const DEFAULT_ALIGNMENT = Object.freeze({
  maxParts: 2,
  repairMaxParts: 1,
  minSendGapMs: 3000,
});

/** 对方指出"你接错了/读了旧消息"的确定性特征（不是语义理解，只是显式线索）。 */
const CHALLENGE_PATTERNS = Object.freeze([
  /读错|读岔|看错|理解错|误解|搞错|接错|弄混/u,
  /(?:你|你刚刚|你刚才|你前面|你之前)[^。！？!?\n]{0,6}(?:读到|看到|翻了|串了|拿了|把.{0,4}当)/u,
  /什么情况|怎么回事/u,
  /我(?:什么时候|哪里|哪儿|啥时候)?(?:没|从未)?(?:说|讲)过/u,
  /不是(?:这个|那个)?意思/u,
  /答非所问|跑题|对不上|接不上/u,
  /(?:哪|那)(?:句|条|里)[^。！？!?\n]{0,4}(?:错|岔)/u,
]);

/** 把猜测当事实说出来的措辞。 */
const SPECULATION_PATTERN = /你是想说|你想说的是|你的意思是说|你的意思是|你的意思是不是|我猜你想|你是不是想说|是不是想说|你想表达的是/u;

/**
 * 自检式/元叙述式句子：讲自己的节奏、讲"之前的消息"，而不是回答内容。
 *
 * 注意这里**不拦"我读岔了/我接错了"这种承认错误的话**——修复路径本来就要求先承认
 * 接岔一句。要拦的是解释机械节奏（半拍）、自称在测试、以及把旧消息当话题。
 */
const META_PATTERNS = Object.freeze([
  /半拍/u,
  /自检|自测|测试一下我|在测我/u,
  /之前的?消息|以前发的消息|一次性发/u,
  /串行/u,
]);

/** 把定位错误的活儿推回给对方的反问。 */
const LOCATE_ERROR_QUESTION = /(?:哪|那)(?:句|条|里|个地方)[^。！？!?\n]{0,8}(?:读岔|读错|出错|不对|错了|走神)|你说具体点|你指一下|你告诉我是哪|哪句读岔/u;

/** 「你（刚才）说「……」，」这种引用一旦引错就是无根据的锚点。 */
const QUOTE_CLAIM = /(?:你说|你说过|你刚才说|你之前说|你上一条说|你前面说)[^「『"“\n]{0,4}[「『"“]([^」』"”\n]{2,30})[」』"”]/gu;

function normalizeSequence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOf(entry) {
  return String(entry?.text ?? '').trim();
}

function timeOf(entry) {
  const raw = entry?.receivedAt ?? entry?.time ?? entry?.frozenAt;
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

/** 去掉标点与空白，用来做"引用是否真的出现在原文里"的比对。 */
function normalizeForMatch(value) {
  return String(value ?? '').replace(/[\s，。！？!?、,.…~'"“”‘’「」『』()（）]/gu, '');
}

/**
 * 这一批里最新的那条消息（序号优先，其次接收时间，最后按到达顺序取最后一条）。
 * 最新消息是下一句回复的唯一锚点。
 *
 * @param {unknown} entries 一批消息快照
 * @returns {{entry:any,index:number,sequence:number|null,time:number|null}|null}
 */
export function latestEntry(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let best = null;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    const candidate = { entry, index, sequence: normalizeSequence(entry?.receiveSequence ?? entry?.sequence), time: timeOf(entry) };
    if (!best) { best = candidate; continue; }
    if (candidate.sequence !== null && best.sequence !== null && candidate.sequence !== best.sequence) {
      if (candidate.sequence > best.sequence) best = candidate;
      continue;
    }
    if (candidate.sequence !== null && best.sequence === null) { best = candidate; continue; }
    if (candidate.time !== null && best.time !== null && candidate.time !== best.time) {
      if (candidate.time > best.time) best = candidate;
      continue;
    }
    // 序号与时间都相同/缺失：后到的更晚，按到达顺序取最后一条。
    best = candidate;
  }
  return best;
}

/** 锚点快照：最新一条消息的原文与身份（不含昵称、平台 id）。 */
export function anchorOf(entries) {
  const latest = latestEntry(entries);
  if (!latest) return null;
  const entry = latest.entry || {};
  return {
    index: latest.index,
    sequence: latest.sequence,
    receivedAt: typeof entry.receivedAt === 'string' ? entry.receivedAt : null,
    text: textOf(entry),
  };
}

/** 这条用户消息是不是在指出"你接错了/读了旧消息"。 */
export function detectRepairIntent(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(value));
}

/** 按句末标点切句（保留标点），供逐句过滤使用。 */
export function splitSentences(value) {
  return String(value ?? '')
    .split(/(?<=[。！？!?…~；;])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** 这一句是不是以问句结尾（问句 = 轮次边界）。 */
export function endsWithQuestion(value) {
  const text = String(value ?? '').trim().replace(/[。.]+$/u, '');
  if (!text) return false;
  if (/[?？]\s*$/u.test(text)) return true;
  return /(?:吗|呢)$/u.test(text);
}

/** 把没被确认的猜测当成事实说出来的句子。 */
export function isUngroundedGuess(value) {
  const text = String(value ?? '');
  if (!SPECULATION_PATTERN.test(text)) return false;
  // 作为问句征求确认是允许的（一次确认），陈述式断言则不允许。
  if (endsWithQuestion(text)) return false;
  return true;
}

/** 自检式/元叙述式句子（讲节奏、讲旧消息、讲"我在测试里"）。 */
export function isMetaLine(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return META_PATTERNS.some((pattern) => pattern.test(text));
}

/** 把"哪句读岔了"这类定位工作推回给对方的反问。 */
export function isLocateErrorQuestion(value) {
  return LOCATE_ERROR_QUESTION.test(String(value ?? ''));
}

/**
 * 引用式锚点是否站得住：`你说「X」` 里的 X 必须真的出现在本轮最新消息里。
 * @returns {string} 站不住时返回被引用的片段，站得住返回空字符串
 */
export function findUngroundedQuote(value, groundedText) {
  const grounded = normalizeForMatch(groundedText);
  for (const match of String(value ?? '').matchAll(QUOTE_CLAIM)) {
    const span = normalizeForMatch(match[1]);
    if (!span) continue;
    if (!grounded.includes(span)) return String(match[1]);
  }
  return '';
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * 发送前的对齐判定。
 *
 * @param {object} input
 * @param {string|string[]} input.parts        计划发出的分段（通常来自 Humanizer.split）
 * @param {unknown} [input.entries]            本轮用户批次的离散消息（最新一条是锚点）
 * @param {unknown} [input.latestSequence]     这个会话目前最新的用户消息序号
 * @param {unknown} [input.inputSequence]      本批消息的序号（entries 缺失时兜底）
 * @param {boolean} [input.repair]             本批是不是"你接错了"的修复轮
 * @param {object} [input.config]              maxParts / repairMaxParts / minSendGapMs
 * @returns {{action:'send'|'silence', parts:string[], reasons:string[],
 *   repair:boolean, anchorSequence:number|null, latestSequence:number|null,
 *   droppedSentences:number}}
 */
export function planOutbound({
  parts, entries, latestSequence, inputSequence, repair = false, config,
} = {}) {
  const cfg = { ...DEFAULT_ALIGNMENT, ...(config || {}) };
  const maxParts = Math.max(1, Math.floor(Number(cfg.maxParts) || DEFAULT_ALIGNMENT.maxParts));
  const repairMaxParts = Math.max(1, Math.floor(Number(cfg.repairMaxParts) || DEFAULT_ALIGNMENT.repairMaxParts));
  const reasons = [];
  const latest = normalizeSequence(latestSequence);
  const anchor = latestEntry(entries);
  const anchorSequence = anchor ? anchor.sequence : null;
  const batchSequence = anchorSequence ?? normalizeSequence(inputSequence);
  const base = { repair: Boolean(repair), anchorSequence, latestSequence: latest };

  // 1) 锚点过期：这批之后已经有更新的用户消息，旧回复一律作废。
  if (latest !== null && batchSequence !== null && latest > batchSequence) {
    return { ...base, action: 'silence', parts: [], reasons: [ALIGNMENT_REASONS.superseded], droppedSentences: 0 };
  }

  const rawParts = (Array.isArray(parts) ? parts : [parts])
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  const groundedText = Array.isArray(entries) ? entries.map(textOf).join('\n') : '';
  const kept = [];
  let droppedSentences = 0;

  for (const part of rawParts) {
    const survivors = [];
    for (const sentence of splitSentences(part)) {
      // 4) 把定位错误的活儿推回给用户 → 删。
      if (isLocateErrorQuestion(sentence)) { reasons.push(ALIGNMENT_REASONS.locateErrorQuestion); droppedSentences += 1; continue; }
      // 4) 自检/元叙述（半拍、读岔、"之前的消息"）→ 删。
      if (isMetaLine(sentence)) { reasons.push(ALIGNMENT_REASONS.metaLine); droppedSentences += 1; continue; }
      // 2) 把没被确认的猜测当事实 → 删。
      if (isUngroundedGuess(sentence)) { reasons.push(ALIGNMENT_REASONS.ungroundedGuess); droppedSentences += 1; continue; }
      // 1) 引用了最新消息里不存在的原话 → 删（不编造锚点）。
      if (groundedText && findUngroundedQuote(sentence, groundedText)) {
        reasons.push(ALIGNMENT_REASONS.ungroundedQuote);
        droppedSentences += 1;
        continue;
      }
      survivors.push(sentence);
    }
    const text = survivors.join('').trim();
    if (text) kept.push(text);
  }

  // 3) 问句是轮次边界：问句之后不再追加判断、换话题或自问自答。
  let cut = kept.length;
  for (let index = 0; index < kept.length; index += 1) {
    if (endsWithQuestion(kept[index])) { cut = index + 1; break; }
  }
  if (cut < kept.length) reasons.push(ALIGNMENT_REASONS.questionBoundary);
  const bounded = kept.slice(0, cut);

  // 4) 一个用户批次最多 1–2 条；多出来的并回最后一条，不再拆新消息。
  const cap = repair ? repairMaxParts : maxParts;
  let planned = bounded;
  if (bounded.length > cap) {
    const head = bounded.slice(0, cap - 1);
    head.push(bounded.slice(cap - 1).join(' '));
    planned = head;
    reasons.push(ALIGNMENT_REASONS.partCap);
  }

  if (!planned.length) {
    return {
      ...base,
      action: 'silence',
      parts: [],
      reasons: dedupe(reasons.length ? reasons : [ALIGNMENT_REASONS.emptyReply]),
      droppedSentences,
    };
  }
  return { ...base, action: 'send', parts: planned, reasons: dedupe(reasons), droppedSentences };
}

/**
 * 发送节拍器：保证同一会话两条消息之间至少间隔 `minGapMs`。
 *
 * 这是**下界**而不是随机抖动：不使用随机数、不按关键词改写文案，只把实际间隔
 * 抬到最低值以上，因此"三条短消息挤在 8 秒里"在结构上不可能发生（配合 ≤2 条上限）。
 *
 * @param {object} [opts]
 * @param {number} [opts.minGapMs] 最小发送间隔（毫秒）
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 等待实现（测试可注入）
 * @param {()=>number} [opts.now] 时钟（测试可注入）
 */
export function createSendPacer({ minGapMs = DEFAULT_ALIGNMENT.minSendGapMs, sleep, now } = {}) {
  const floor = Math.max(0, Number(minGapMs) || 0);
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clock = typeof now === 'function' ? now : () => Date.now();
  let lastSendAt = null;
  return {
    minGapMs: floor,
    /** 下一次发送前必须先等多久（返回实际等待的毫秒数，便于断言）。 */
    async beforeSend() {
      const at = clock();
      if (lastSendAt === null) { lastSendAt = at; return 0; }
      const waitMs = Math.max(0, lastSendAt + floor - at);
      if (waitMs > 0) await wait(waitMs);
      lastSendAt = clock();
      return waitMs;
    },
    /** 只读状态：上一次发送时间（没有发过则为 null）。 */
    get lastSendAt() { return lastSendAt; },
  };
}

export default planOutbound;
