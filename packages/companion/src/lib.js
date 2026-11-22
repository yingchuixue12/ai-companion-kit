/**
 * companion · 库入口
 * ─────────────────────────────────────────────────────────────
 * 不跑服务，只想拿零件自己拼的时候用这个。
 *
 *   import { Memory, Role, Brain, Humanizer, Waker } from 'ai-companion';
 *
 *   const memory = new Memory({ dir: './data' });        // 记忆账本
 *   const role   = new Role({ cardPath: './role.md' });  // 角色卡
 *   const brain  = new Brain({ apiKey, role, memory });  // 大脑
 *   const human  = new Humanizer();                      // 拟人化发送
 *   const waker  = new Waker({ names: ['小鱼'] });        // 唤醒判定
 *   const diary  = new Diary({ dir: './data/diary' });   // 日记本
 *
 * 也可以只要一样：
 *
 *   // 只想要"像人一样分条发送"
 *   const human = new Humanizer({ msPerChar: 90 });
 *   await human.say('在呢，咋了', {
 *     setTyping: (on) => platform.setTyping(chatId, on),
 *     send: (t) => platform.send(chatId, t),
 *   });
 *
 *   // 只想要"按人存记忆"
 *   const mem = new Memory({ dir: './data' });
 *   mem.remember('123456', { trait: '常熬夜', fact: '他养了只猫' });
 *   console.log(mem.renderPerson('123456'));
 *
 *   // 只想要"该不该说话"
 *   const waker = new Waker();
 *   waker.shouldWake({ key: 'group:1', userId: '9', text: '@小鱼 在吗', isAtMe: true });
 *
 *   // 想让宿主自己决定开语音（默认关；关闭时只退文字）
 *   const voice = createVoiceRuntime({ enabled: false });   // 打开要 enabled:true + 注入 asr/tts
 */
export { Memory } from './memory.js';
export { Role } from './role.js';
export { Brain } from './brain.js';
export { Humanizer } from './humanize.js';
export { Waker } from './wake.js';
export { Diary } from './diary.js';
export { OneBot, segsToText } from './transport-onebot.js';
export { loadConfig, handleTurn } from './index.js';
export {
  createVoiceRuntime,
  VOICE_RUNTIME_VERSION,
  VOICE_DECISION,
  VOICE_RUNTIME_ERROR,
} from './media/voice-runtime.js';
export { createToolHostBridge, formatToolHostOutcome } from './tools/host-bridge.js';
/**
 * Web 在场宿主接线（本机 presence 宿主入口）。
 * 只做「活动/焦点/心跳 → 状态机 → 策略提示 → 宿主队列」这一条线，
 * 不开 HTTP、不做认证、不画界面；enabled 必须显式为 true 才工作。
 */
export {
  createPresenceWebHost,
  PRESENCE_WEB_DEFAULT_MAX_MESSAGES,
  PRESENCE_WEB_DIAGNOSTIC_CODES,
  PRESENCE_WEB_RESULT_STATUSES,
  PRESENCE_WEB_SIGNAL_FLAGS,
  PRESENCE_WEB_STATE_FILE,
  PRESENCE_WEB_STATE_TTL_MS,
  PRESENCE_WEB_STATUSES,
} from './presence/web-host.js';
