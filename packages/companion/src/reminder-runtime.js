/**
 * 提醒宿主 · 定时驱动派发
 * ─────────────────────────────────────────────────────────────
 * 把 reminder-dispatcher 的「推进一条」接到进程的定时器上：
 *
 *   const runtime = createReminderRuntime({
 *     bot,
 *     window: privateTurns,
 *     ownerIds,
 *     file: '/path/to/data/reminders.json',
 *   });
 *   runtime.start();   // 开始按 1 秒节奏推进
 *   runtime.stop();    // 幂等停止，停止后不再重排
 *
 * 规则：
 *   - 只有显式开启（调用方决定）才创建；本模块不读配置、不接入口；
 *   - ownerIds 必须先归一化成非空白名单：一个有效项都没有时 start()
 *     不排任何定时器（键的规范与 reminder-onebot 保持一致）；
 *   - send 走 createOneBotReminderSender，因此与普通私聊批次共用
 *     window.runSerial 的同一条每会话串行队列；也可以通过 dispatcher
 *     注入一个已装配的派发器（离线验证用），此时不要求 bot / window；
 *   - 每轮只调用一次 dispatchNext()；**等它彻底结束之后**才用
 *     一个 1 秒的 setTimeout 排下一轮，所以不会堆积、不会重叠；
 *   - 某一轮失败只报固定文案，不重试同一条、不立即重发；
 *     下一轮由 dispatcher 自己的 claim / 恢复分类挡住已触发记录；
 *   - stop() 幂等：清除已排未响的定时器，并把「已启动」置为 false，
 *     之后任何完成回调都不会再重排；
 *   - 定时器回调里不写业务逻辑，只调 tick；异常也不会逃出运行时。
 *
 * 不联网、不读真实配置、不主动发送任何消息：bot 仅由调用方注入。
 */
import path from 'node:path';

import { createReminderDispatcher } from './reminder-dispatcher.js';
import { createOneBotReminderSender } from './reminder-onebot.js';

/** 两轮之间的固定间隔。 */
const DEFAULT_INTERVAL_MS = 1000;
/** 数据目录下约定的提醒快照文件名。 */
const REMINDER_FILE_NAME = 'reminders.json';
/** 规范十进制正整数：与 reminder-onebot 的白名单判定一致。 */
const DECIMAL_ID = /^[1-9]\d*$/;
/** 失败只报这一句，不携带任何正文或外部文本。 */
const FAILURE_TEXT = '[提醒] 派发失败';

/**
 * 收集有效白名单：只接受规范十进制字符串或正安全整数。
 * 与 reminder-onebot 保持同一套规则，不把非法项放宽成任意匹配。
 *
 * @param {Iterable<string|number>|null|undefined} ownerIds
 * @returns {Set<string>}
 */
function normalizeOwnerIds(ownerIds) {
  const owners = new Set();
  if (!ownerIds) return owners;
  const list = Array.isArray(ownerIds)
    ? ownerIds
    : (ownerIds instanceof Set ? [...ownerIds] : []);
  for (const value of list) {
    if (typeof value === 'string' && DECIMAL_ID.test(value)) owners.add(value);
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      owners.add(String(value));
    }
  }
  return owners;
}

/** 默认的失败报告：固定文案，绝不拼接异常或提醒正文。 */
function reportFailure() {
  console.error(FAILURE_TEXT);
}

/**
 * 创建提醒运行时。
 *
 * @param {object} [options]
 * @param {{sendPrivateText: (userId: string, text: string) => Promise<object>}} [options.bot]
 *   OneBot 传输实例；未注入 dispatcher 时必填
 * @param {{runSerial: (key: string, job: () => any) => Promise<any>}} [options.window]
 *   会话窗口；未注入 dispatcher 时必填
 * @param {Iterable<string|number>} [options.ownerIds] 允许接收提醒的用户白名单
 * @param {string} [options.file] 提醒快照文件路径
 * @param {string} [options.dataDir] 数据目录；未给 file 时拼 reminders.json
 * @param {number} [options.intervalMs] 两轮之间的间隔，默认 1000
 * @param {{dispatchNext: () => Promise<object>}} [options.dispatcher] 已装配的派发器
 * @param {() => void} [options.onError] 失败报告回调，默认固定文案
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [options.timers]
 *   可注入的定时器（离线验证用）
 * @returns {{start: () => void, stop: () => void, active: boolean, running: boolean}}
 */
export function createReminderRuntime({
  bot,
  window,
  ownerIds,
  file,
  dataDir,
  intervalMs = DEFAULT_INTERVAL_MS,
  dispatcher,
  onError = reportFailure,
  timers = {},
} = {}) {
  const setTimer = typeof timers.setTimeout === 'function' ? timers.setTimeout : globalThis.setTimeout;
  const clearTimer = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : globalThis.clearTimeout;

  const owners = normalizeOwnerIds(ownerIds);
  const target = typeof file === 'string' && file.trim() !== ''
    ? file
    : (typeof dataDir === 'string' && dataDir.trim() !== ''
      ? path.join(dataDir, REMINDER_FILE_NAME)
      : null);

  const report = typeof onError === 'function' ? onError : reportFailure;

  // 注入 dispatcher 时不依赖文件；否则必须有白名单和快照路径才可能调度。
  const active = owners.size > 0 && (dispatcher !== undefined || target !== null);

  let engine = dispatcher;
  if (active && engine === undefined) {
    if (!bot || typeof bot.sendPrivateText !== 'function') {
      throw new TypeError('createReminderRuntime: bot.sendPrivateText must be a function');
    }
    if (!window || typeof window.runSerial !== 'function') {
      throw new TypeError('createReminderRuntime: window.runSerial must be a function');
    }
    const sender = createOneBotReminderSender({ bot, window, ownerIds: [...owners] });
    engine = createReminderDispatcher(target, { send: sender.send });
  }
  if (active && (!engine || typeof engine.dispatchNext !== 'function')) {
    throw new TypeError('createReminderRuntime: dispatcher.dispatchNext must be a function');
  }

  const delay = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : DEFAULT_INTERVAL_MS;

  let started = false;
  let stopped = false;
  let scheduled = false;
  let timer = null;
  let inFlight = false;

  /** 排下一轮；已经排过、已停止或未启动时都不重复排。 */
  function schedule() {
    if (!active || !started || stopped || scheduled) return;
    scheduled = true;
    timer = setTimer(() => {
      // 先清掉本轮记号，再进 tick；tick 完成前不会再排新定时器。
      scheduled = false;
      timer = null;
      void tick();
    }, delay);
  }

  /** 跑一轮：dispatchNext 彻底结束后才排下一轮。 */
  async function tick() {
    if (!active || !started || stopped || inFlight) return;
    inFlight = true;
    let result;
    try {
      result = await engine.dispatchNext();
    } catch {
      // 不使用异常内容：只报固定文案。
      result = { ok: false };
    } finally {
      inFlight = false;
    }

    if (result && result.ok === false) {
      try { report(); } catch { /* 报告失败不影响下一轮 */ }
    }
    if (started && !stopped) schedule();
  }

  /** 启动：幂等；没有有效白名单时什么也不排。 */
  function start() {
    if (!active || started || stopped) return;
    started = true;
    schedule();
  }

  /** 停止：幂等；清除已排定时器并阻止任何后续重排。 */
  function stop() {
    stopped = true;
    started = false;
    if (scheduled) {
      if (timer !== null) clearTimer(timer);
      scheduled = false;
      timer = null;
    }
  }

  return {
    start,
    stop,
    get active() { return active; },
    get running() { return started && !stopped; },
  };
}

export default createReminderRuntime;
