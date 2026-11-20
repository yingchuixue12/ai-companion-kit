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
import { Role } from './role.js';
import { planContextBudget } from './context-budget.js';

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
   */
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, maxInputChars = 24000, role, memory }) {
    if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0) {
      throw new TypeError('maxInputChars 必须是正安全整数，收到：' + String(maxInputChars));
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxInputChars = maxInputChars;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
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
   * @param {Array}  [input.history]   该会话最近的消息（可选，通常靠 memory 就够）
   * @param {boolean}[input.record=true] 是否把这一轮写回记忆
   * @returns {Promise<{text:string, reasoning?:string, raw:any}>}
   */
  async reply(input) {
    const { key, userId, userName, text, situation = '', history = [], record = true } = input;

    const memLine = this.memory.renderPerson(userId);
    const recent = this.memory.renderRecent(20, { excludeWhere: key });
    // 一次装配：system prompt + 独立 history + 用户原文；预算与 fetch 共用同一份序列化结果
    const payload = (parts) => {
      const sys = this.role.build({
        situation: parts.situation,
        memory: parts.memory,
        recent: parts.recent,
        platform: input.platform || '',
      });
      const messages = [{ role: 'system', content: sys }];
      for (const h of history.slice(-20)) {
        messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
      }
      messages.push({ role: 'user', content: String(text || '') });
      return { model: this.model, messages, temperature: 1.1, stream: false };
    };

    const parts = { situation, memory: memLine, recent };
    let body = JSON.stringify(payload(parts));
    if (body.length > this.maxInputChars) {
      // 超限：按 recent → memory → situation 整块丢弃（platform / history / 用户原文不动）
      const plan = planContextBudget({
        measure: (candidate) => JSON.stringify(payload(candidate)).length,
        parts,
        maxChars: this.maxInputChars,
      });
      body = JSON.stringify(payload(plan.parts));
      if (body.length > this.maxInputChars) throw contextOverflow(this.maxInputChars, body.length);
    }

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

    if (record) {
      this.memory.remember(userId, { name: userName, topic: (text || '').slice(0, 40) + ' → ' + out.slice(0, 40) });
      this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
    }
    return { text: out, reasoning: msg?.reasoning_content, raw: json };
  }

  /**
   * 让它自己写一条记忆（对应暴露给 AI 的 remember 工具）
   */
  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
