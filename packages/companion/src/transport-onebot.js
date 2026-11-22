/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * OneBot v11 是一个被广泛实现的机器人协议：
 *   NapCat / Lagrange / LLOneBot / go-cqhttp / SnowLuma 都实现了它。
 *
 * 这一层负责：
 *   - 连上 OneBot 的 WebSocket，收消息
 *   - 把 OneBot 的原始事件翻译成统一格式
 *   - 提供「发消息」「发图」「正在输入」等动作
 *
 * 如果你想接别的平台（微信/Telegram/自研），照着这个接口再写一个就行。
 */

/** 把 OneBot 消息段数组拼成纯文本 */
function segsToText(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': out.push('@' + (s.data?.qq || '')); break;
      case 'image': out.push('[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'reply': break;   // 引用单独处理
      default: break;
    }
  }
  return out.join('').trim();
}

/** 从消息段里找引用 */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

/**
 * 把一帧数据转成文本，解析不了就返回 null（调用方直接丢弃）。
 * 兼容 ws 的 Buffer/string，以及原生 MessageEvent.data 的字符串与二进制。
 */
function frameToText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

/** message_id 是否可用于确认：非空非零字符串，或非零安全整数 */
function usableMessageId(value) {
  if (typeof value === 'string') {
    const s = value.trim();
    return s !== '' && s !== '0';
  }
  return Number.isSafeInteger(value) && value !== 0;
}

/** 把 api() 结果规范化成发送回执，只带状态和确认的 ID */
function normalizeSendReceipt(result) {
  const unknown = { status: 'unknown' };
  const env = result.data;
  if (!env || typeof env !== 'object') return unknown;

  const id = usableMessageId(env.data?.message_id)
    ? (typeof env.data.message_id === 'string' ? env.data.message_id.trim() : String(env.data.message_id))
    : null;

  // 只有 HTTP 成功且信封合法、message_id 可用，才算确认送达
  if (result.ok === true && env.status === 'ok' && env.retcode === 0) {
    return id === null ? unknown : { status: 'confirmed', messageId: id };
  }

  // 信封明确失败、retcode 为非零整数且没有可用 ID，才算被拒绝
  if (env.status === 'failed' && Number.isInteger(env.retcode) && env.retcode !== 0 && id === null) {
    return { status: 'rejected' };
  }

  return unknown;
}

export class OneBot {
  #onStatus;
  #attempt = 0;

  /**
   * @param {object} opts
   * @param {string} opts.wsUrl       例如 ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl]   例如 http://127.0.0.1:3000（发消息用）
   * @param {string} [opts.accessToken]
   * @param {(msg:object)=>void} [opts.onMessage]
   * @param {(event:object)=>void} [opts.onStatus] Receives redacted connection events in place of legacy connection logs.
   */
  constructor({ wsUrl, httpUrl, accessToken = '', onMessage, onStatus }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.#onStatus = typeof onStatus === 'function' ? onStatus : null;
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.#connect();
  }

  #headers() {
    const h = {};
    if (this.accessToken) h.authorization = 'Bearer ' + this.accessToken;
    return h;
  }

  #connectionStatus(state, legacyLog, retryInMs = 0) {
    if (!this.#onStatus) {
      console.log(legacyLog());
      return;
    }
    try { this.#onStatus({ state, attempt: this.#attempt, retryInMs }); }
    catch { /* Diagnostics cannot interrupt transport. */ }
  }

  async #connect() {
    this.#attempt = Math.min(this.#attempt + 1, Number.MAX_SAFE_INTEGER);
    // 优先用 ws（可带 headers 鉴权）；本地没装或解析失败时退回全局 WebSocket。
    const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    const sock = new WebSocket(this.wsUrl, { headers: this.#headers() });
    this.ws = sock;

    // 连接身份：第一个 close 之后这条连接就失效（live=false），
    // 之后同一 socket 上的迟到 open/close/message/error 一律忽略——不改
    // this.connected、不再排重连、不推进业务。等待重连期间以及新连接建立之后
    // 都成立；this.ws 保持现有形状（失效连接不清空），靠 live 与 this.ws 双重判定。
    let live = true;
    const current = () => live && this.ws === sock;

    const onOpen = () => {
      if (!current()) return;
      this.connected = true;
      this.#connectionStatus('connected', () => '[onebot] 已连接 ' + this.wsUrl);
    };
    const onClose = () => {
      if (!current()) return;
      live = false;
      this.connected = false;
      this.#connectionStatus('disconnected', () => '[onebot] 断开，5 秒后重连', 5000);
      // 只有「这条连接仍是当前连接」时才重连：已经换了新连接就不再补一条。
      setTimeout(() => { if (this.ws === sock) this.#connect(); }, 5000);
    };
    const onError = (e) => {
      if (!current()) return;
      this.#connectionStatus('error', () => '[onebot] 出错 ' + (e?.message || e?.type || e));
    };
    const onFrame = (data) => {
      if (!current()) return;
      const text = frameToText(data);
      if (text === null) return;
      let ev;
      try { ev = JSON.parse(text); } catch { return; }
      this.#handle(ev);
    };

    if (typeof sock.on === 'function') {
      // ws 的 EventEmitter：数据是 Buffer 或 string。
      sock.on('open', onOpen);
      sock.on('close', onClose);
      sock.on('error', onError);
      sock.on('message', onFrame);
      return;
    }

    // 原生 EventTarget（如 Node 内置 WebSocket）：只有 addEventListener，
    // 消息在 MessageEvent.data 上，二进制按 arraybuffer 交付。
    if (typeof sock.addEventListener !== 'function') return;
    if ('binaryType' in sock) sock.binaryType = 'arraybuffer';
    sock.addEventListener('open', onOpen);
    sock.addEventListener('close', onClose);
    sock.addEventListener('error', onError);
    sock.addEventListener('message', (e) => onFrame(e?.data));
  }

  #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    if (ev.post_type !== 'message') return;
    if (ev.self_id) this.selfId = String(ev.self_id);

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const replyId = findReply(segs);
    // 有没有 @ 我
    const atMe = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === this.selfId);

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: segsToText(segs),
      raw: segs,
      isAtMe: atMe,
      isQuoteMe: false,   // 需要额外查询被引用消息的发送者，见 resolveQuote
      replyTo: replyId,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    this.onMessage?.(msg);
  }

  /** 调 OneBot 的 HTTP API */
  async api(action, params = {}) {
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers() },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok && j.status !== 'failed', data: j, error: j.message || j.wording };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /**
   * 发一条纯文本
   * @param {string} key
   * @param {string} text
   * @param {{atUserId?:string}} [opts]
   * @returns {Promise<{ok:boolean, data?:object, error?:string, receipt:{status:'confirmed'|'rejected'|'unknown', messageId?:string}}>}
   */
  async send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    let message = String(text);
    if (atUserId) message = '[CQ:at,qq=' + atUserId + '] ' + message;
    const result = await (isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message }));
    return { ...result, receipt: normalizeSendReceipt(result) };
  }

  /**
   * 发一条私聊纯文本；正文原样作为单个 text 消息段，不裁剪、不改写。
   * 与 send() 一样走 api()，回执原样复用 normalizeSendReceipt()；不影响 send()。
   * @param {string} userId 目标用户 ID
   * @param {string} text 正文
   * @returns {Promise<{ok:boolean, data?:object, error?:string, receipt:{status:'confirmed'|'rejected'|'unknown', messageId?:string}}>}
   */
  async sendPrivateText(userId, text) {
    const result = await this.api('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
    });
    return { ...result, receipt: normalizeSendReceipt(result) };
  }

  /** 发一张图（本地文件或 URL） */
  sendImage(key, file) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = '[CQ:image,file=' + file + ']';
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /**
   * 「正在输入…」
   * OneBot 扩展接口，部分实现支持（SnowLuma 是 set_input_status）
   */
  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  /** 查一条消息是谁发的（用来判断引用的是不是我） */
  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText };
export default OneBot;
