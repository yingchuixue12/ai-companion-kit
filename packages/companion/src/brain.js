/**
 * 大脑 · 把消息变成回复
 * ─────────────────────────────────────────────────────────────
 * 这一层只做三件事：
 *   1. 组装上下文（角色卡 + 记忆 + 最近的对话 + 当前处境）
 *   2. 调模型
 *   3. 把这一轮写回记忆
 *
 * 它不关心消息从哪来（QQ / 微信 / 命令行都行），
 * 也不关心怎么发出去（那是 transport 的事）。
 */
import { Memory } from './memory.js';
import { Role, normalizeTaskReferences } from './role.js';
import { planContextBudget } from './context-budget.js';
import { planLayerQuotas } from './layer-quota.js';

/**
 * 最近对话的请求上限：既是 `renderRecent` 的条数，也是按整轮裁剪时最多考虑的轮数。
 * 结构化视图报出更多轮时按它收紧，避免对请求范围之外的轮次做无意义的尝试。
 */
const RECENT_TURN_LIMIT = 20;

/** memory-budget 诊断事件的字段版本：字段增删都要改它，消费方据此判断兼容性。 */
export const MEMORY_BUDGET_EVENT_VERSION = 1;
const LAYER_QUOTA_EVENT_VERSION = 2;

/**
 * 诊断里「被整块淘汰」的块名顺序：与 P-3 一致（recent → memory → situation → L6 任务引用），
 * 只报固定块名，不报正文。`taskReferences` 只有明确注入时才会出现，旧请求的事件形状不变。
 */
const EVICTION_ORDER = Object.freeze(['recent', 'memory', 'situation', 'taskReferences']);

/** 记忆块提供者只接受函数；其它值当作没接（保持接线前行为）。 */
function resolveMemoryBlocks(provider) {
  return typeof provider === 'function' ? provider : null;
}

/** 诊断回调同理：非函数当作没接，绝不因为要不要记日志而影响回复。 */
function resolveBudgetReporter(reporter) {
  return typeof reporter === 'function' ? reporter : null;
}

/** 块是否「空」：只有空/缺失才算被淘汰，非字符串沿用现有的真值判断。 */
function isEmptyBlock(value) {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'string' ? value.length === 0 : !value;
}

/** 请求体超预算时抛出的错误：只带计数，不带任何正文 */
function contextOverflow(maxInputChars, inputChars) {
  const error = new Error('输入超出上下文预算：请求体 ' + inputChars + ' 字符 > 上限 ' + maxInputChars);
  error.code = 'context-budget-overflow';
  error.maxInputChars = maxInputChars;
  error.inputChars = inputChars;
  return error;
}

export class Brain {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey
   * @param {string}  [opts.baseUrl]   默认 https://api.deepseek.com/v1
   * @param {string}  [opts.model]     默认 deepseek-chat
   * @param {number}  [opts.timeoutMs] 默认 120000
   * @param {number}  [opts.maxInputChars] 序列化请求体长度上限，默认 24000（正安全整数）
   * @param {Role}    opts.role
   * @param {Memory}  opts.memory
   * @param {Function|null} [opts.memoryBlocks] 可选的记忆块提供者（默认 null）：
   *   `({ key, userId, text }) => string|null|Promise<string|null>`。
   *   配置后独占记忆槽；空结果或错误均不读取旧账本。
   *   Brain 自己不读账本、不做过滤策略：检索、隐私与预算都在提供者那一侧。
   * @param {Function|null} [opts.onMemoryBudget] 可选的 memory-budget 诊断回调（默认 null）：
   *   `(event) => void`，每次请求装配完成后（fetch 之前）调用一次。事件是**脱敏**的固定字段：
   *   `{ event:'memory-budget', version, maxChars, charsUsed, withinBudget,
   *      roundsAvailable, roundsKept, roundsDropped, topicsDropped,
   *      blocksEvicted, evictedParts }`——只有块名和纯计数，不含输入、异常原文、会话标识或任何 prompt。
   *   `evictedParts` 可能出现的固定块名：`recent` / `memory` / `situation` / `taskReferences`；
   *   只有本轮明确注入任务引用时才会出现 `taskReferences`，旧请求的字段与取值不变。
   *   回调失败（同步抛错或 reject）不影响本轮；不等待它完成，也不改网络/记忆行为。
   *   不接回调时行为与接线前完全一致。
   * @param {number|null} [opts.systemBudgetChars=null] Optional P-4 target in UTF-16 units.
   * Requires layered Role. Stable role and protocol remain intact; maxInputChars
   * still controls dispatch. The memory-budget event includes quota counts when enabled.
   */
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, maxInputChars = 24000, role, memory, memoryBlocks = null, onMemoryBudget = null, systemBudgetChars = null }) {
    if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0) {
      throw new TypeError('maxInputChars 必须是正安全整数，收到：' + String(maxInputChars));
    }
    if (systemBudgetChars !== null && (!Number.isSafeInteger(systemBudgetChars)
      || systemBudgetChars <= 0 || systemBudgetChars > maxInputChars
      || role?.layered !== true || typeof role.sections !== 'function')) {
      throw new TypeError('systemBudgetChars requires layered Role and a positive integer within maxInputChars');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxInputChars = maxInputChars;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
    this.memoryBlocks = resolveMemoryBlocks(memoryBlocks);
    this.onMemoryBudget = resolveBudgetReporter(onMemoryBudget);
    this.systemBudgetChars = systemBudgetChars;
  }

  /**
   * 可选记忆块的取值：没接提供者、返回空值或抛错都返回 null（沿用旧路径）。
   * null 表示未配置；空字符串表示本轮没有可以使用的记忆。
   */
  async #retrievedMemoryBlock({ key, userId, text }) {
    if (!this.memoryBlocks) return null;
    let block;
    try {
      block = await this.memoryBlocks({ key, userId, text });
    } catch {
      return '';
    }
    return typeof block === 'string' && block.trim() ? block : '';
  }

  /**
   * 生成一条回复
   *
   * @param {object} input
   * @param {string} input.key         会话标识
   * @param {string} input.userId      对方 id
   * @param {string} [input.userName]
   * @param {string} input.text        对方说的话（可以是合并后的一批）
   * @param {string} [input.situation] 处境描述（"你在群里，刚才在聊……"）
   * @param {string|Array<string|{text:string}>} [input.taskReferences]
   *   可选的宿主已验证 L6 任务引用（不是长期记忆）：非空时由 Role 放进独立固定块；
   *   Brain 只按预算淘汰和上报块名，不读任务文件、不推断 pending、不接宿主源。
   *   不传 / 空数组 / 全是空白时，请求体与接入前逐字节一致。
   * @param {Array}  [input.history]   该会话最近的消息（可选，通常靠 memory 就够）
   * @param {boolean|'deferred'} [input.record=true] 是否把这一轮写回记忆；
   *   'deferred' 表示此刻先不写，改在返回对象上给一个一次性 commit()，由调用方决定提交时机
   * @returns {Promise<{text:string, reasoning?:string, raw:any, commit?:() => void}>}
   */
  async reply(input) {
    const { key, userId, userName, text, situation = '', history = [], record = true } = input;
    // L6 任务引用是可选输入：只整理形状，不做持久化、不读任务文件、不猜任务状态。
    const taskReferences = normalizeTaskReferences(input.taskReferences);
    const deferred = record === 'deferred';
    const shouldRecord = record && !deferred;

    // 只有未启用检索才使用旧账本，避免绕过已启用的隐私或预算策略。
    const retrieved = await this.#retrievedMemoryBlock({ key, userId, text });
    const memLine = retrieved === null ? this.memory.renderPerson(userId) : retrieved;
    // 最近对话：能拿到结构化轮次就用它一次读盘同时给出整段文本与按整轮裁剪的能力；
    // 拿不到（只有 renderRecent 的注入 adapter / 自定义渲染）就照旧调用 renderRecent。
    const recentView = this.#recentRoundView(key);
    const recent = recentView ? recentView.text : this.memory.renderRecent(RECENT_TURN_LIMIT, { excludeWhere: key });
    // 一次装配：system prompt + 独立 history + 用户原文；预算与 fetch 共用同一份序列化结果
    const platform = input.platform || '';
    const roleContext = (parts) => {
      // 没有非空 L6 引用时保持接入前的 role.build 入参形状：自定义角色适配器可能按对象键判断，
      // 多传一个 taskReferences: [] 会改变它们看到的对象（真实 Role 的输出不受影响）。
      const ctx = {
        situation: parts.situation,
        memory: parts.memory,
        recent: parts.recent,
      };
      if (parts.taskReferences && parts.taskReferences.length) ctx.taskReferences = parts.taskReferences;
      ctx.platform = platform;
      return ctx;
    };
    const payload = (parts) => {
      const sys = this.role.build(roleContext(parts));
      const messages = [{ role: 'system', content: sys }];
      for (const h of history.slice(-20)) {
        messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
      }
      messages.push({ role: 'user', content: String(text || '') });
      return { model: this.model, messages, temperature: 1.1, stream: false };
    };

    // taskReferences 也是可减块，但排在 recent → memory → situation 之后（最后才脱落）
    const parts = { situation, memory: memLine, recent, taskReferences };
    const measure = (candidate) => JSON.stringify(payload(candidate)).length;
    // 视图报出的轮次可能超出本次请求范围，诊断里也只报范围内的轮数
    const roundsAvailable = recentView ? Math.min(recentView.roundCount, RECENT_TURN_LIMIT) : 0;
    let quota;
    let systemCharsUsed;
    let body;
    let finalParts = parts;
    let roundsDropped = 0;
    let topicsDropped = 0;
    if (this.systemBudgetChars !== null) {
      quota = planLayerQuotas({
        parts,
        systemChars: this.systemBudgetChars,
        requestCap: this.maxInputChars,
        recentView: recentView && {
          text: recentView.text,
          roundCount: roundsAvailable,
          renderFrom: (n) => recentView.renderFrom(n),
        },
        topicView: () => this.memory.personTopicView?.(userId),
        measureRequest(candidate) {
          const request = payload(candidate);
          return { system: request.messages[0].content.length, request: JSON.stringify(request).length };
        },
      });
      ({ parts: finalParts, roundsDropped, topicsDropped } = quota);
    }
    const request = payload(finalParts);
    if (quota) systemCharsUsed = request.messages[0].content.length;
    body = JSON.stringify(request);
    if (!quota && body.length > this.maxInputChars) {
      // ① 先按最近对话的记录顺序，从最旧开始移除完整轮次（按真实序列化 payload 量，能放下即停）；
      // ② 放弃最近对话后，仍超预算则按整条裁剪旧话题；
      // ③ 沿用整块丢弃 recent → memory → situation；
      // ④ 以上都放不下时，最后才脱落明确注入的 L6 任务引用。仍超限则维持拒发。
      const byRound = this.#dropOldestRounds(parts, recentView, measure);
      roundsDropped = byRound.dropped;
      let trimmed = byRound.parts;
      if (measure(trimmed) > this.maxInputChars) {
        const byTopic = this.#dropOldestTopics(trimmed, userId, measure);
        trimmed = byTopic.parts;
        topicsDropped = byTopic.dropped;
      }
      // context-budget 的白名单仍只有三个参考块：任务引用在它之外单独作为最后一级淘汰。
      const { taskReferences: keptReferences = taskReferences, ...budgetParts } = trimmed;
      // 规划器必须用**同一份 L6 引用**量真实请求体：否则会低估规模，在应先丢 situation 时
      // 错误保留 L5、删掉 L6。绑定引用后，规划结果与最终请求体用的是同一把尺子。
      const measureWithReferences = (candidate) => measure({ ...candidate, taskReferences: keptReferences });
      const planned = planContextBudget({
        measure: measureWithReferences,
        parts: budgetParts,
        maxChars: this.maxInputChars,
      }).parts;
      finalParts = { ...planned, taskReferences: keptReferences };
      // L6 是最后一级：只有 recent / memory / situation 三块全部淘汰后仍放不下，才脱落引用。
      const allBlocksEvicted = !planned.situation && !planned.memory && !planned.recent;
      if (allBlocksEvicted && measure(finalParts) > this.maxInputChars && finalParts.taskReferences.length) {
        finalParts = { ...planned, taskReferences: [] };
      }
      body = JSON.stringify(payload(finalParts));
    }
    // 诊断在 fetch 之前发出：超限时也先留一条记录，再照旧抛错。
    // 没接回调时连事件对象都不构造，默认路径没有任何额外开销。
    if (this.onMemoryBudget) {
      const quotaStats = quota && this.#quotaStats(quota, roleContext(finalParts), systemCharsUsed);
      this.#emitMemoryBudget(this.#memoryBudgetEvent({
        parts,
        finalParts,
        roundsAvailable,
        roundsDropped,
        topicsDropped,
        charsUsed: body.length,
        quotaStats,
      }));
    }
    if (body.length > this.maxInputChars) throw contextOverflow(this.maxInputChars, body.length);

    const res = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + raw.slice(0, 300));

    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('模型返回不是 JSON：' + raw.slice(0, 200)); }
    const msg = json.choices?.[0]?.message;
    const out = String(msg?.content || '').trim();

    const result = { text: out, reasoning: msg?.reasoning_content, raw: json };
    if (shouldRecord) {
      this.#recordTurn({ key, userId, userName, text, out });
    } else if (deferred) {
      // 一次性提交：首次调用即标记为已尝试，即使失败也不再重复写（错误抛给调用方日志，绝不触发重发）
      let attempted = false;
      result.commit = () => {
        if (attempted) return;
        attempted = true;
        this.#recordTurn({ key, userId, userName, text, out });
      };
    }
    return result;
  }

  /**
   * 脱敏的 memory-budget 事件：只有块名、纯计数和最终的字符规模。
   * 不含任何正文、异常原文、key/userId 或 prompt——字段集合固定，消费方可直接落 journal。
   */
  #quotaStats(quota, ctx, systemCharsUsed) {
    const sizes = Object.fromEntries(this.role.sections(ctx).map(({ name, chars }) => [name, chars]));
    const stable = sizes.baseRules + sizes.extra + sizes.card;
    const cap = this.systemBudgetChars;
    return Object.freeze({
      systemBudgetChars: cap,
      systemCharsUsed,
      l1Chars: stable,
      l1WithinTarget: stable / cap >= 0.40 && stable / cap <= 0.60,
      recentChars: sizes.recent,
      memoryChars: sizes.memory,
      situationChars: sizes.situation,
      protocolChars: sizes.platform,
      protocolOverTarget: sizes.platform > Math.floor(cap * 0.05),
      dropped: Object.freeze(quota.dropped),
    });
  }

  #memoryBudgetEvent({ parts, finalParts, roundsAvailable, roundsDropped, topicsDropped, charsUsed, quotaStats }) {
    const evictedParts = EVICTION_ORDER.filter((name) => !isEmptyBlock(parts[name]) && isEmptyBlock(finalParts[name]));
    // 整块淘汰时这一轮一条都没进请求；否则就是「范围内轮数 - 按整轮裁掉的轮数」
    const roundsKept = evictedParts.includes('recent')
      ? 0
      : Math.max(0, roundsAvailable - roundsDropped);
    return Object.freeze({
      event: 'memory-budget',
      version: quotaStats ? LAYER_QUOTA_EVENT_VERSION : MEMORY_BUDGET_EVENT_VERSION,
      maxChars: this.maxInputChars,
      charsUsed,
      withinBudget: charsUsed <= this.maxInputChars,
      roundsAvailable,
      roundsKept,
      roundsDropped: Math.max(0, roundsAvailable - roundsKept),
      topicsDropped,
      blocksEvicted: evictedParts.length,
      evictedParts: Object.freeze(evictedParts),
      ...(quotaStats ? { quotas: quotaStats } : {}),
    });
  }

  /** 诊断回调：同步调用、失败隔离、不等 Promise（绝不影响网络/记忆行为） */
  #emitMemoryBudget(diagnostics) {
    const reporter = this.onMemoryBudget;
    if (!reporter) return;
    try {
      const pending = reporter(diagnostics);
      if (pending && typeof pending.then === 'function') pending.then(null, () => {});
    } catch {
      // 诊断失败不得影响本轮回复
    }
  }

  /**
   * 取最近对话的结构化轮次视图（可选能力，见 `Memory.recentRoundView`）。
   * 拿不到就返回 null：只有 `renderRecent` 的注入 adapter、自定义渲染、或形状不对的返回值，
   * 都会退回旧的整块丢弃路径——这里不猜、也不改既有渲染语义。
   */
  #recentRoundView(key) {
    if (typeof this.memory.recentRoundView !== 'function') return null;
    let view;
    try {
      view = this.memory.recentRoundView(RECENT_TURN_LIMIT, { excludeWhere: key });
    } catch {
      return null;
    }
    if (!view || typeof view !== 'object') return null;
    if (typeof view.text !== 'string' || typeof view.renderFrom !== 'function') return null;
    if (!Number.isSafeInteger(view.roundCount) || view.roundCount < 0) return null;
    return view;
  }

  /**
   * 超预算时的第一步：按最近对话的**记录顺序**从最旧开始移除完整轮次。
   * 每丢一轮就按实际序列化 payload 量一次，能放下即停；固定人格层和当前输入不参与裁剪。
   * 结构化轮次不可用、`renderFrom` 抛错或返回非字符串、或丢到只剩最新一轮仍放不下，
   * 都原样返回（`dropped` 为 0），交给 `planContextBudget` 沿用 recent → memory → situation 整块丢弃。
   * 只兜住 adapter 调用本身：measure（含 role.build）的错误照常往上抛。
   *
   * @returns {{parts: object, dropped: number}} dropped 是按整轮裁掉的轮数（给诊断用）
   */
  #dropOldestRounds(parts, view, measure) {
    if (!view || !view.roundCount) return { parts, dropped: 0 };
    // 视图报出的轮数超过本次请求的条数时按请求上限收紧（多出来的不在请求范围内）
    const roundCount = Math.min(view.roundCount, RECENT_TURN_LIMIT);
    for (let dropped = 1; dropped < roundCount; dropped += 1) {
      let recent;
      try {
        recent = view.renderFrom(dropped);
      } catch {
        return { parts, dropped: 0 };
      }
      if (typeof recent !== 'string') return { parts, dropped: 0 };
      const candidate = { ...parts, recent };
      if (measure(candidate) <= this.maxInputChars) return { parts: candidate, dropped };
    }
    return { parts, dropped: 0 };
  }

  /**
   * 超预算时的第二步：放弃最近对话后仍放不下，就按整条裁剪旧话题。
   *
   * @returns {{parts: object, dropped: number}} dropped 是按整条裁掉的话题数（给诊断用）
   */
  #dropOldestTopics(parts, userId, measure) {
    if (!parts.memory) return { parts, dropped: 0 };
    const withoutRecent = { ...parts, recent: '' };
    if (measure(withoutRecent) <= this.maxInputChars) return { parts: withoutRecent, dropped: 0 };
    const view = this.memory.personTopicView?.(userId);
    // 自定义渲染或不同的账本快照沿用整块预算，避免替换原始记忆。
    if (!view || view.text !== parts.memory) return { parts, dropped: 0 };
    for (let dropped = 1; dropped <= view.topicCount; dropped += 1) {
      const candidate = { ...withoutRecent, memory: view.renderFrom(dropped) };
      if (measure(candidate) <= this.maxInputChars) return { parts: candidate, dropped };
    }
    return { parts, dropped: 0 };
  }

  /** 把这一轮写回记忆（默认立即记与 deferred 提交共用同一份写法） */
  #recordTurn({ key, userId, userName, text, out }) {
    this.memory.remember(userId, { name: userName, topic: (text || '').slice(0, 40) + ' → ' + out.slice(0, 40) });
    this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
  }

  /**
   * 让它自己写一条记忆（对应暴露给 AI 的 remember 工具）
   */
  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
