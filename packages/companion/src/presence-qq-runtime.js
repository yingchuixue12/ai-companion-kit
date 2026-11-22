/**
 * QQ 在场入口装配 · presence QQ runtime wiring
 * ─────────────────────────────────────────────────────────────
 * 位置：产品入口（index.js）与已实现的 presence 管线之间的那一层很薄的胶水。
 * 这里不重写状态机、策略、会话或适配器，只做四件事：
 *
 *   1. **配置闸门**：`presenceQQ.enabled !== true` 一律关闭（C-P2 默认关）；
 *      `--dry-run` 不建适配器、不落盘、不发送；`presenceQQ.ownerId` 必须显式配置
 *      且存在于 `config.ownerIds` 白名单里，否则 fail-closed。多人白名单不会广播：
 *      发送目标只可能是这一个 ownerId。
 *   2. **完整组合**：显式开启且闸门全过时，才创建
 *      PresenceRuntime + PresenceInteractionPolicy + PresenceStateStore
 *      （`<dataDir>/presence-qq-state.json`，7 天 TTL）+ createPresenceSession +
 *      createPresenceQQAdapter（`enabled: true`）。适配器自身缺省仍是 disabled。
 *   3. **安全恢复**：启动时显式 `session.restore()`。存档不存在/已过期按「干净启动」
 *      继续；读取失败（损坏、版本不符、超大、不可读……）则不启动发送，返回固定
 *      诊断码。恢复只带回冷却、会话锚点与投递台账，不重放旧事件、不补发旧欢迎。
 *   4. **宿主控制面**：observe / settle / tick / stop 由宿主注入合成信号（例如测试、
 *      未来的传感器接线），本模块不装定时器、不声称已接任何 Windows 传感器。
 *      选定的 owner 发来普通私聊时，invalidates 旧 pending intent 并刷新活动状态，
 *      但这一拍产生的 intent 一律不路由 —— 用户就在眼前，不自指欢迎、不重复主动文本。
 *
 * 发送路径：sendText → Humanizer.say → bot.sendPrivateText(ownerId, ...)，
 * 目标只可能是配置里的那个 ownerId。真实回执交给 qq-adapter 既有的归一化逻辑；
 * 全部段确认但拿不到 message id 时仍按 accepted（不谎称已送达）。failed / partial /
 * unknown 不重试；写前日志（attempting）落盘失败则本次不发送，语义由 adapter 保持。
 *
 * 落盘严格经过 PresenceStateStore 的白名单；本模块只传状态/时间/冷却/台账，
 * 从不把消息正文、intent.text、异常 message、密钥写进状态文件或 journal。
 */
import path from 'node:path';

import { PresenceInteractionPolicy } from './presence-interaction.js';
import { PresenceRuntime } from './presence-runtime.js';
import { PresenceStateStore } from './presence/persistence.js';
import { createPresenceQQAdapter } from './presence/qq-adapter.js';
import { createPresenceSession } from './presence/session.js';

/** C-P3：QQ 单独用一个状态文件，绝不与 Web 共用。 */
export const PRESENCE_QQ_STATE_FILE = 'presence-qq-state.json';
/** C-P3：状态文件 TTL 7 天；过期存档按「没有状态」处理。 */
export const PRESENCE_QQ_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 入口闸门的结果状态；同时也是控制面 `status` 的取值。 */
export const PRESENCE_QQ_STATUSES = Object.freeze({
  DISABLED: 'disabled',
  DRY_RUN: 'dry-run',
  NO_DATA_DIR: 'no-data-dir',
  OWNER_MISSING: 'owner-missing',
  OWNER_NOT_WHITELISTED: 'owner-not-whitelisted',
  UNAVAILABLE: 'unavailable',
  STATE_LOAD_FAILED: 'state-load-failed',
  READY: 'ready',
});

/** 固定的、可观察的诊断码；不含异常 message / 正文 / 账号。 */
export const PRESENCE_QQ_DIAGNOSTIC_CODES = Object.freeze({
  DISABLED: 'presence-qq-disabled',
  DRY_RUN: 'presence-qq-dry-run',
  NO_DATA_DIR: 'presence-qq-no-data-dir',
  OWNER_MISSING: 'presence-qq-owner-missing',
  OWNER_NOT_WHITELISTED: 'presence-qq-owner-not-whitelisted',
  UNAVAILABLE: 'presence-qq-unavailable',
  STATE_LOAD_FAILED: 'presence-qq-state-load-failed',
  STATE_SAVE_FAILED: 'presence-qq-state-save-failed',
});

/** 没有存档 / 存档过期：按干净启动继续，不算「读盘失败」。 */
const FRESH_START_CODES = new Set(['absent', 'expired']);
/** 允许出现在诊断 detail 里的固定读盘码（白名单，绝不转发原始异常）。 */
const LOAD_DETAIL_CODES = new Set([
  'absent',
  'expired',
  'corrupt',
  'unreadable',
  'not-a-file',
  'oversized',
  'incompatible-version',
  'clock-unavailable',
  'no-store',
  'load-failed',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只接受字符串 / 有限数字形式的账号；其余（对象、布尔、数组）一律没有 owner。 */
function toOwnerId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function diagnostic(code, detail) {
  return detail === undefined ? { code } : { code, detail };
}

function copyDiagnostics(list) {
  return list.map((entry) => ({ ...entry }));
}

/**
 * 装配 QQ 在场控制面。
 *
 * @param {object} options
 * @param {object} options.cfg         loadConfig() 的结果（读 presenceQQ / ownerIds / dataDir / dryRun）
 * @param {object} options.bot         OneBot 形状的对象；只需要 sendPrivateText（可选 setTyping）
 * @param {object} options.human       Humanizer 实例（sendText 必须经过它）
 * @param {() => number|Date} [options.now] 时钟注入
 * @param {(event: object) => void} [options.journal] 结构化 journal（adapter 只产出不含正文的事件）
 * @param {object} [options.store]     仅供宿主/测试替换存储；必须是 PresenceStateStore
 *   实例（可以是子类），存不存在都按同一套白名单语义落盘。缺省自建实例。
 * @returns {object} 控制面：enabled / status / ownerId / stateFile / diagnostics /
 *   observe / settle / tick / onIncomingMessage / stop / close / state / pending / stats
 */
export function createPresenceQQHost({
  cfg,
  bot,
  human,
  now = () => Date.now(),
  journal = null,
  store = null,
} = {}) {
  const settings = isPlainObject(cfg?.presenceQQ) ? cfg.presenceQQ : {};
  const dryRun = cfg?.dryRun === true;
  const dataDir = typeof cfg?.dataDir === 'string' ? cfg.dataDir.trim() : '';
  const configuredOwnerId = toOwnerId(settings.ownerId);
  const ownerIds = Array.isArray(cfg?.ownerIds) ? cfg.ownerIds.map((id) => String(id)) : [];
  const canSend = Boolean(bot) && typeof bot.sendPrivateText === 'function'
    && Boolean(human) && typeof human.say === 'function';

  const diagnostics = [];
  let status = PRESENCE_QQ_STATUSES.DISABLED;
  if (settings.enabled !== true) {
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.DISABLED));
  } else if (dryRun) {
    status = PRESENCE_QQ_STATUSES.DRY_RUN;
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.DRY_RUN));
  } else if (!dataDir) {
    status = PRESENCE_QQ_STATUSES.NO_DATA_DIR;
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.NO_DATA_DIR));
  } else if (!configuredOwnerId) {
    status = PRESENCE_QQ_STATUSES.OWNER_MISSING;
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.OWNER_MISSING));
  } else if (!ownerIds.includes(configuredOwnerId)) {
    // 明确配置的 owner 必须在白名单里；绝不自动挑白名单里的其他人。
    status = PRESENCE_QQ_STATUSES.OWNER_NOT_WHITELISTED;
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.OWNER_NOT_WHITELISTED));
  } else if (!canSend) {
    status = PRESENCE_QQ_STATUSES.UNAVAILABLE;
    diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.UNAVAILABLE));
  } else {
    status = PRESENCE_QQ_STATUSES.READY;
  }

  let runtime = null;
  let session = null;
  let adapter = null;
  let stateFile = null;
  let closed = false;

  if (status === PRESENCE_QQ_STATUSES.READY) {
    const file = path.join(dataDir, PRESENCE_QQ_STATE_FILE);
    // 只认 PresenceStateStore（或其子类）：落盘永远是同一套白名单，不接受任意 store。
    const storeImpl = store instanceof PresenceStateStore
      ? store
      : new PresenceStateStore({
        file,
        now,
        maxAgeMs: PRESENCE_QQ_STATE_TTL_MS,
      });
    runtime = new PresenceRuntime({
      idleMs: settings.idleMs,
      awayMs: settings.awayMs,
      clock: now,
    });
    const policy = new PresenceInteractionPolicy({
      now,
      returnAfterMs: settings.returnAfterMs,
      workAfterMs: settings.workAfterMs,
      cooldownMs: settings.cooldownMs,
    });
    session = createPresenceSession({ runtime, policy, store: storeImpl, now });

    let restored;
    try {
      restored = session.restore();
    } catch {
      restored = { ok: false, restored: false, diagnostics: [{ code: 'load-failed' }] };
    }
    const codes = Array.isArray(restored?.diagnostics)
      ? restored.diagnostics.map((entry) => (
        isPlainObject(entry) && typeof entry.code === 'string' ? entry.code : 'load-failed'
      ))
      : ['load-failed'];
    const cleanStart = restored?.restored !== true
      && codes.every((code) => FRESH_START_CODES.has(code));
    if (restored?.restored !== true && !cleanStart) {
      // 读盘失败：不启动发送、不覆盖证据，返回固定诊断码。
      status = PRESENCE_QQ_STATUSES.STATE_LOAD_FAILED;
      const detail = codes.find((code) => LOAD_DETAIL_CODES.has(code)) || 'load-failed';
      diagnostics.push(diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_LOAD_FAILED, detail));
      runtime = null;
      session = null;
    } else {
      stateFile = file;
      const ownerId = configuredOwnerId;
      const typingKey = 'private:' + ownerId;
      // 唯一发送目标就是配置里的 ownerId：不读消息里的 key / userId。
      const sendText = async (text) => {
        let last = null;
        const said = await human.say(text, {
          setTyping: (on) => (typeof bot.setTyping === 'function' ? bot.setTyping(typingKey, on) : undefined),
          send: async (part) => {
            last = await bot.sendPrivateText(ownerId, part);
            return last;
          },
        });
        // 有真实回执就交给 adapter 的既有归一化；没有回执退回 Humanizer 的形状（最多 accepted）。
        return isPlainObject(last) && isPlainObject(last.receipt) ? last : said;
      };
      adapter = createPresenceQQAdapter({
        session,
        sendText,
        journal: typeof journal === 'function' ? journal : null,
        now,
        minGapMs: settings.minGapMs,
        maxPerDay: settings.maxPerDay,
        quietHours: settings.quietHours,
        intentTtlMs: settings.intentTtlMs,
        maxPending: settings.maxPending,
        enabled: true,
      });
    }
  }

  const ready = () => status === PRESENCE_QQ_STATUSES.READY
    && !closed && session !== null && adapter !== null;

  const emptyResult = (reason) => ({
    ok: false,
    status: typeof reason === 'string' && reason ? reason : (closed ? 'closed' : status),
    state: runtime && typeof runtime.state === 'string' ? runtime.state : 'unknown',
    intents: [],
    routed: [],
    delivery: null,
    persisted: false,
    diagnostics: [],
  });

  const inertResult = () => ({ ...emptyResult(), diagnostics: copyDiagnostics(diagnostics) });

  /** 只暴露 id / kind / at；intent.text 只留在内存里交给 adapter，绝不进返回值。 */
  const summarize = (step) => ({
    ok: step.ok === true,
    status: step.ok === true ? 'ok' : (typeof step.reason === 'string' && step.reason ? step.reason : 'rejected'),
    state: typeof step.state === 'string' ? step.state : 'unknown',
    intents: Array.isArray(step.intents)
      ? step.intents.map((intent) => ({
        id: typeof intent.id === 'string' ? intent.id : '',
        kind: typeof intent.kind === 'string' ? intent.kind : '',
        at: Number.isFinite(Number(intent.at)) ? Number(intent.at) : null,
      }))
      : [],
    persisted: step.persisted === true,
  });

  const saveFailedResult = (base) => ({
    ...base,
    ok: false,
    status: 'state-save-failed',
    routed: [],
    delivery: null,
    persisted: false,
    diagnostics: [diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_SAVE_FAILED)],
  });

  /** 一拍：session 前进 → 检查落盘失败 → 路由 intent → 尝试投递。 */
  const runStep = async (operation, at) => {
    if (!ready()) return inertResult();
    const failuresBefore = session.stats.saveFailures;
    let step;
    try {
      step = operation();
    } catch {
      // 注入的 store 可能直接抛错；按落盘失败处理，绝不发送。
      return saveFailedResult(emptyResult('state-save-failed'));
    }
    const base = summarize(step);
    if (session.stats.saveFailures > failuresBefore) return saveFailedResult(base);
    if (step.ok !== true) return { ...base, routed: [], delivery: null, diagnostics: [] };

    const routed = [];
    for (const intent of Array.isArray(step.intents) ? step.intents : []) {
      const acceptance = adapter.onIntent(intent);
      routed.push({
        id: intent.id,
        kind: intent.kind,
        accepted: acceptance.accepted === true,
        reason: typeof acceptance.reason === 'string' ? acceptance.reason : '',
      });
    }
    const delivery = routed.length ? await adapter.tick(at) : null;
    return { ...base, routed, delivery, diagnostics: [] };
  };

  const observe = (signal) => runStep(
    () => session.observe(signal),
    isPlainObject(signal) ? signal.at : undefined,
  );

  const settle = (input) => {
    const at = isPlainObject(input) ? input.at : input;
    return runStep(() => session.settle({ at }), at);
  };

  /** 宿主自己的节拍：只尝试投递队首 pending（不强行结算在场阈值）。 */
  const tick = (at) => (ready() ? adapter.tick(at) : Promise.resolve(inertResult()));

  /**
   * 普通 QQ 消息入口。只有「选定的 owner 的私聊」才会动 presence：
   * 先作废此前排队/未发出的主动 intent，再刷新活动状态；本拍 intent 不路由。
   * 群聊、非 owner 私聊、未知形状一律 ignored，不触发任何主动发送。
   */
  const onIncomingMessage = (msg) => {
    if (!ready()) return { ...inertResult(), ignored: true, invalidated: 0, pending: 0, suppressedIntents: 0 };
    const ignored = (reason) => ({
      ...emptyResult(reason),
      ignored: true,
      invalidated: 0,
      pending: adapter.pendingCount,
      suppressedIntents: 0,
    });
    if (!isPlainObject(msg) || msg.isGroup !== false) return ignored('not-private');
    if (toOwnerId(msg.userId) !== configuredOwnerId) return ignored('not-owner');

    let at;
    try {
      at = now();
    } catch {
      at = undefined;
    }
    const invalidated = adapter.noteUserMessage(at);
    const failuresBefore = session.stats.saveFailures;
    let step;
    try {
      step = session.observe({ kind: 'activity', at });
    } catch {
      return {
        ...emptyResult('state-save-failed'),
        ignored: false,
        invalidated: Number(invalidated.invalidated) || 0,
        pending: adapter.pendingCount,
        suppressedIntents: 0,
        diagnostics: [diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_SAVE_FAILED)],
      };
    }
    const suppressed = Array.isArray(step.intents) ? step.intents.length : 0;
    if (session.stats.saveFailures > failuresBefore) {
      return {
        ...emptyResult('state-save-failed'),
        ignored: false,
        invalidated: Number(invalidated.invalidated) || 0,
        pending: adapter.pendingCount,
        suppressedIntents: suppressed,
        diagnostics: [diagnostic(PRESENCE_QQ_DIAGNOSTIC_CODES.STATE_SAVE_FAILED)],
      };
    }
    return {
      ok: step.ok === true,
      status: step.ok === true ? 'ok' : (typeof step.reason === 'string' && step.reason ? step.reason : 'rejected'),
      state: typeof step.state === 'string' ? step.state : 'unknown',
      ignored: false,
      invalidated: Number(invalidated.invalidated) || 0,
      pending: adapter.pendingCount,
      // 用户刚说完话：这一拍的欢迎/提醒不路由，避免自指欢迎与重复主动文本。
      suppressedIntents: suppressed,
      diagnostics: [],
    };
  };

  /** 关停：先禁用 adapter（清 pending），再尝试 session.close() 落盘。没有定时器。 */
  const close = () => {
    if (closed) return { ok: true, persisted: false, dropped: 0, alreadyClosed: true };
    closed = true;
    if (session === null || adapter === null) {
      return { ok: true, persisted: false, dropped: 0, alreadyClosed: true };
    }
    const stopped = adapter.setEnabled(false);
    let saved;
    try {
      saved = session.close();
    } catch {
      saved = { ok: false, persisted: false };
    }
    return {
      ok: saved.ok === true,
      persisted: saved.persisted === true,
      dropped: Number(stopped?.dropped) || 0,
      alreadyClosed: false,
    };
  };

  return {
    get enabled() { return ready(); },
    get closed() { return closed; },
    get status() { return status; },
    ownerId: status === PRESENCE_QQ_STATUSES.READY ? configuredOwnerId : null,
    stateFile: adapter !== null ? stateFile : null,
    diagnostics: copyDiagnostics(diagnostics),
    observe,
    settle,
    tick,
    onIncomingMessage,
    stop: close,
    close,
    get state() { return runtime && typeof runtime.state === 'string' ? runtime.state : 'unknown'; },
    get pending() { return adapter ? adapter.pendingCount : 0; },
    get stats() {
      return {
        enabled: ready(),
        closed,
        status,
        ownerId: status === PRESENCE_QQ_STATUSES.READY ? configuredOwnerId : null,
        stateFile: adapter !== null ? stateFile : null,
        state: runtime && typeof runtime.state === 'string' ? runtime.state : 'unknown',
        pending: adapter ? adapter.pendingCount : 0,
        runtime: runtime
          ? { state: runtime.state, pendingEvents: runtime.pendingEventCount, idleMs: runtime.idleMs, awayMs: runtime.awayMs }
          : null,
        session: session ? session.stats : null,
        adapter: adapter ? adapter.stats : null,
        diagnostics: copyDiagnostics(diagnostics),
      };
    },
  };
}

export default createPresenceQQHost;
