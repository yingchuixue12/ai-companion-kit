/**
 * 提醒投递 · OneBot 私聊适配
 * ─────────────────────────────────────────────────────────────
 * 把 reminder-dispatcher 的 send({ conversationKey, text }) 接到
 * OneBot.sendPrivateText(userId, text) 这一小步上：
 *
 *   const sender = createOneBotReminderSender({ bot, window, ownerIds });
 *   await sender.send({ conversationKey: 'private:10001', text: '该喝水了' });
 *   // → 'sent' | 'failed' | 'unknown'
 *
 * 规则：
 *   - 只接受规范私聊键 private:<十进制正整数>：不接受前导零、空白、
 *     尾随换行或任何额外字符；
 *   - 键里的 userId 必须与 ownerIds 里某一项完整相等（按十进制字符串比较），
 *     不做前缀 / 大小写 / 类型放宽；
 *   - 正文必须是非空字符串；通过后原样作为一个 text 消息段交给传输层，
 *     不裁剪、不改写；
 *   - 键不合格、不在白名单或正文为空时直接返回 failed：不碰 window、
 *     不调用 bot，零网络请求；
 *   - 发送走 window.runSerial(key, job)，与普通批次共用同一条每会话串行队列；
 *   - 传输层回执 confirmed → sent，rejected → failed；其余回执（未知）、
 *     runSerial 拒绝（如窗口已关闭）和任何异常一律 unknown。
 *
 * 不启动运行入口、不读配置、不发真实消息：bot / window 均由调用方注入。
 */

/** 规范私聊键：private: + 十进制正整数，整串匹配。 */
const PRIVATE_KEY = /^private:([1-9]\d*)$/;
/** 规范十进制正整数（白名单项）。 */
const DECIMAL_ID = /^[1-9]\d*$/;

/**
 * 白名单收成字符串集合：只接受规范十进制字符串或正安全整数，
 * 其余项忽略；绝不把非法项放宽成匹配任何东西。
 * @param {Iterable<string|number>|null|undefined} ownerIds
 * @returns {Set<string>}
 */
function normalizeOwnerIds(ownerIds) {
  const owners = new Set();
  if (!ownerIds) return owners;
  const list = Array.isArray(ownerIds) ? ownerIds : (ownerIds instanceof Set ? [...ownerIds] : []);
  for (const value of list) {
    if (typeof value === 'string' && DECIMAL_ID.test(value)) owners.add(value);
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      owners.add(String(value));
    }
  }
  return owners;
}

/**
 * 创建 OneBot 私聊提醒发送器。
 *
 * @param {object} opts
 * @param {{sendPrivateText: (userId: string, text: string) => Promise<object>}} opts.bot
 *   OneBot 传输实例，必须提供 sendPrivateText
 * @param {{runSerial: (key: string, job: () => any) => Promise<any>}} opts.window
 *   会话窗口，必须提供 runSerial（与普通批次共用串行队列）
 * @param {Iterable<string|number>} [opts.ownerIds] 允许接收提醒的用户 ID 白名单
 * @returns {{send: (delivery: {conversationKey?: string, text?: string}) => Promise<'sent'|'failed'|'unknown'>}}
 */
export function createOneBotReminderSender({ bot, window, ownerIds } = {}) {
  if (!bot || typeof bot.sendPrivateText !== 'function') {
    throw new TypeError('createOneBotReminderSender: bot.sendPrivateText must be a function');
  }
  if (!window || typeof window.runSerial !== 'function') {
    throw new TypeError('createOneBotReminderSender: window.runSerial must be a function');
  }
  const owners = normalizeOwnerIds(ownerIds);

  /**
   * 投递一条提醒。
   * @param {{conversationKey?: string, text?: string}} [delivery]
   * @returns {Promise<'sent'|'failed'|'unknown'>}
   */
  async function send({ conversationKey, text } = {}) {
    const matched = typeof conversationKey === 'string' ? PRIVATE_KEY.exec(conversationKey) : null;
    // 键不合法 / 不在白名单：零网络调用。
    if (!matched || !owners.has(matched[1])) return 'failed';
    // 空白正文（含仅空白字符）同样在本地拒绝；通过后正文原样下发。
    if (typeof text !== 'string' || text.trim() === '') return 'failed';

    try {
      const result = await window.runSerial(conversationKey, async () => (
        bot.sendPrivateText(matched[1], text)
      ));
      const status = result?.receipt?.status;
      if (status === 'confirmed') return 'sent';
      if (status === 'rejected') return 'failed';
      return 'unknown';
    } catch {
      // 传输异常、窗口关闭等没有可信回执，一律 unknown。
      return 'unknown';
    }
  }

  return { send };
}

export default createOneBotReminderSender;
