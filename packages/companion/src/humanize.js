/**
 * 拟人化发送 · 让它打字不像机器
 * ─────────────────────────────────────────────────────────────
 * 一个真人发消息是这样的：
 *   1. 先"正在输入…"一会儿（时间跟字数成正比，但不完全成正比）
 *   2. 短句分几条发，不是一大段
 *   3. 条与条之间有停顿，偶尔停久一点（像在走神/被打断）
 *   4. 深夜和白天的节奏不一样
 *
 * 这个模块只做这件事。它不关心消息内容，只关心"怎么发出去"。
 */

/** 睡觉时段（本地时间），这段时间回复会明显变慢 */
const NIGHT = { from: 2, to: 7 };
/** 打字速度：每字毫秒。中文手打大概 80~140ms/字，这里给个偏快的值 */
const DEFAULT_MS_PER_CHAR = 85;

/**
 * 发送未被确认时的固定错误。
 * 只带固定 code、状态和已成功段数；不带原始原因、正文和未发送段。
 */
function unconfirmedError(status, sent) {
  const error = new Error('发送未确认');
  error.code = 'delivery-unconfirmed';
  error.status = status;
  error.sent = sent;
  return error;
}

export class Humanizer {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]      总开关
   * @param {number}  [opts.msPerChar=85]      每字打字时间
   * @param {number}  [opts.minMs=1200]        最短"正在输入"时长
   * @param {number}  [opts.maxMs=6000]        最长"正在输入"时长
   * @param {number}  [opts.jitter=0.2]        抖动比例（±20%）
   * @param {number}  [opts.burstMax=4]        一次最多分几条发
   * @param {[number,number]} [opts.gapRange]  条间停顿范围（毫秒）
   * @param {number}  [opts.longGapChance=0.25] 出现"长停顿"的概率
   * @param {[number,number]} [opts.longGapRange] 长停顿范围
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.msPerChar = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
    this.minMs = opts.minMs ?? 1200;
    this.maxMs = opts.maxMs ?? 6000;
    this.jitter = opts.jitter ?? 0.2;
    this.burstMax = opts.burstMax ?? 4;
    this.gapRange = opts.gapRange ?? [700, 2600];
    this.longGapChance = opts.longGapChance ?? 0.25;
    this.longGapRange = opts.longGapRange ?? [3000, 9000];
  }

  /** 按字数算"正在输入"该持续多久 */
  typingMsFor(text) {
    const n = [...String(text || '')].length;
    let ms = this.minMs + n * this.msPerChar;
    ms = Math.min(this.maxMs, Math.max(this.minMs, ms));
    // 抖动
    ms *= 1 + (Math.random() * 2 - 1) * this.jitter;
    // 深夜慢一点（半睡半醒）
    const h = new Date().getHours();
    if (h >= NIGHT.from && h < NIGHT.to) ms *= 1.6;
    return Math.round(ms);
  }

  /** 条与条之间停多久 */
  gapMs() {
    const [a, b] = this.gapRange;
    let ms = a + Math.random() * Math.max(0, b - a);
    if (Math.random() < this.longGapChance) {
      const [c, d] = this.longGapRange;
      ms += c + Math.random() * Math.max(0, d - c);
    }
    return Math.round(ms);
  }

  /**
   * 把一段长回复切成"像人打出来的"若干条
   * - 已经在换行的地方切开
   * - 太长的一句按标点再切
   * - 切完不超过 burstMax 条（多余的合并回最后一条）
   */
  split(text, max = this.burstMax) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    // 先按换行
    let parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    // 再按中文标点切过长的
    const out = [];
    for (const p of parts) {
      if ([...p].length <= 40) { out.push(p); continue; }
      const segs = p.split(/(?<=[。！？!?…~])\s*/).map((s) => s.trim()).filter(Boolean);
      out.push(...(segs.length ? segs : [p]));
    }
    // 合并太短的相邻项
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (last && [...last].length < 6 && [...last].length + [...s].length <= 24) merged[merged.length - 1] = last + s;
      else merged.push(s);
    }
    // 超量就合并
    if (merged.length > max) {
      const head = merged.slice(0, max - 1);
      head.push(merged.slice(max - 1).join(' '));
      return head;
    }
    return merged;
  }

  /**
   * 发一条并校验结果；未确认时立即抛错，不重试。
   * 有回执时只认 confirmed，rejected/unknown/无法识别都算失败；
   * 无回执时兼容旧回调，只有显式 ok:false 算失败。
   *
   * @param {(msg:string)=>Promise<any>} send
   * @param {string} part
   * @param {number} sent 此前已确认/兼容成功的段数
   */
  async #sendChecked(send, part, sent) {
    let result;
    try {
      result = await send(part);
    } catch {
      throw unconfirmedError('unknown', sent);
    }
    const receipt = result && typeof result === 'object' ? result.receipt : null;
    if (receipt != null) {
      const status = typeof receipt === 'object' ? receipt.status : undefined;
      if (status === 'confirmed') return;
      throw unconfirmedError(status === 'rejected' ? 'rejected' : 'unknown', sent);
    }
    if (result && typeof result === 'object' && result.ok === false) {
      throw unconfirmedError('unknown', sent);
    }
  }

  /**
   * 执行一次拟人化发送
   *
   * @param {string|string[]} text        要说的话（字符串会被自动切分）
   * @param {object} io
   * @param {(on:boolean)=>Promise<void>} [io.setTyping]  切换"正在输入"状态
   * @param {(msg:string)=>Promise<any>}  io.send          真正发一条
   * @param {(ms:number)=>Promise<void>}  [io.sleep]       等待（默认 setTimeout，测试时可注入）
   * @returns {Promise<{sent:number, parts:string[]}>}
   * @throws {Error & {code:'delivery-unconfirmed', status:'rejected'|'unknown', sent:number}}
   *   回执未确认时立即抛出；只带固定 code/status/sent，不带原因、正文或未发送段。
   */
  async say(text, { setTyping, send, sleep } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const parts = Array.isArray(text) ? text.map((s) => String(s)) : this.split(text);
    if (!parts.length) return { sent: 0, parts: [] };

    if (!this.enabled) {
      let sent = 0;
      for (const p of parts) {
        await this.#sendChecked(send, p, sent);
        sent++;
      }
      return { sent, parts };
    }

    let sent = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // 1) 先"正在输入"
      if (setTyping) { try { await setTyping(true); } catch { /* 有些平台不支持，忽略 */ } }
      await wait(this.typingMsFor(p));
      if (setTyping) { try { await setTyping(false); } catch {} }
      // 2) 发出去（回执不确认就立即停，不重试）
      await this.#sendChecked(send, p, sent);
      sent++;
      // 3) 条间停顿
      if (i < parts.length - 1) await wait(this.gapMs());
    }
    return { sent, parts };
  }
}

export default Humanizer;
