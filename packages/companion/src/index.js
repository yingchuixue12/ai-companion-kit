/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → 私聊: ConversationWindow / 群聊: Waker.batch
 *                                        ↓
 *                                   Brain(生成回复)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run   只打印，不真发
 *   node src/index.js --check                            只检查角色卡
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { Role } from './role.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { ConversationWindow } from './conversation-window.js';
import { OneBot } from './transport-onebot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));

  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',

    roleCard: rel(cfg.roleCard, 'role.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir: rel(cfg.dataDir, 'data'),

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
    },

    names: cfg.names || [],
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 1500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 6000,
    },

    humanize: cfg.humanize || {},
    dryRun: process.argv.includes('--dry-run'),
  };
}

// ── 错误报告 ──────────────────────────────────────────────────
/** 只放行不含用户内容的常见网络错误码，其余一律固定文案。 */
const SAFE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
]);

/**
 * 统一的失败报告：固定文案 + 白名单错误码。
 * 不能转发 e.message —— Brain 的异常里可能带着原始 HTTP 响应或消息正文。
 *
 * @param {unknown} error
 * @param {string} [label] 固定短语（不要拼接外部文本）
 */
export function reportError(error, label) {
  const text = typeof label === 'string' && label ? label : '处理失败';
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code)
    ? '（' + error.code + '）'
    : '';
  console.error('[出错] ' + text + code);
}

// ── 私聊装配 ──────────────────────────────────────────────────
/**
 * 私聊这一段的最小可测试装配：造一个会话窗口，刷出时把原消息交给现有 handleTurn。
 *
 * - 消息原样进窗口（窗口会把原文冻结后原样交回）；
 * - eligible 固定 true：私聊策略本来就是“每条都理”；
 * - 窗口时长用原 cfg 的 privateWindowMs；
 * - 去重：OneBot messageId 非空时，按会话作用域放进独立命名空间；
 *   没有 id 就不传，交给模块自己按 `会话key#序号` 分配；
 * - 失败统一由窗口的 onError 报告，不在这里重复 try/catch，也不挡后续消息。
 *
 * @param {{deps: object, cfg: object, windowMs?: number, onError?: (e: unknown) => void}} opts
 */
export function createPrivateTurnWindow({ deps, cfg, windowMs, onError } = {}) {
  return new ConversationWindow({
    windowMs: windowMs ?? cfg?.wake?.privateWindowMs ?? 1500,
    onFlush: (items) => handleTurn(deps, items, cfg),
    onError: onError || reportError,
    onDrop: (reason) => console.error('[丢弃] 会话窗口已关闭（' + reason + '）'),
  });
}

/** 把一条 OneBot 私聊消息推进窗口（外部 id 与窗口自动 id 分属不同命名空间）。 */
export function pushPrivateMessage(window, msg) {
  const id = typeof msg?.messageId === 'string' ? msg.messageId.trim() : '';
  const options = { eligible: true };
  if (id) options.eventId = 'onebot:' + JSON.stringify([msg.key, id]);
  return window.push(msg.key, msg, options);
}

// ── 主程序 ────────────────────────────────────────────────────
async function main() {
  const cfgIdx = process.argv.indexOf('--config');
  const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : null);

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (process.argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, role, memory });
  const human = new Humanizer(cfg.humanize);
  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
  });

  const deps = { bot: null, brain, human, memory, waker };

  // 私聊走会话窗口（群聊仍走 Waker.batch + 定时器）
  const privateTurns = createPrivateTurnWindow({ deps, cfg, windowMs: cfg.wake.privateWindowMs });

  /** @type {Map<string, NodeJS.Timeout>} 每个群会话的合并定时器 */
  const pending = new Map();

  const bot = new OneBot({
    ...cfg.onebot,
    onMessage: (msg) => {
      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: 'diving',
              atMention: true,
              nameMention: !cfg.wake.groupAtOnly,
              question: !cfg.wake.groupAtOnly,
              poke: true,
              probability: cfg.wake.groupAtOnly ? 0 : cfg.wake.probability,
            }
          : { mode: 'active', anyMessage: true });   // 私聊每条都理
      }

      const verdict = waker.shouldWake(msg);
      const isOwner = cfg.ownerIds.includes(msg.userId);
      if (!verdict.wake && !isOwner) {
        if (msg.isGroup) console.log('[静音] ' + msg.name + '：' + msg.text.slice(0, 40));
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 私聊：交给会话窗口，等对方把话说完再生成回复
      if (!msg.isGroup) {
        pushPrivateMessage(privateTurns, msg).catch(reportError);
        return;
      }

      // 群聊合并窗口：等人把话说完
      clearTimeout(pending.get(msg.key));
      waker.batch(msg);
      pending.set(msg.key, setTimeout(() => {
        const items = waker.flush(msg.key);
        if (!items.length) return;
        handleTurn(deps, items, cfg).catch(reportError);
      }, cfg.wake.groupWindowMs));
    },
  });

  deps.bot = bot;

  process.on('unhandledRejection', (e) => reportError(e, '未处理'));
  process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

  console.log('在跑了。Ctrl+C 退出。\n');
}

/** 处理一轮（可能是合并后的多条） */
export async function handleTurn({ bot, brain, human, memory, waker }, items, cfg) {
  const last = items[items.length - 1];
  const key = last.key;
  const text = Waker.joinBatch(items);

  const situation = last.isGroup
    ? '你在一个 QQ 群里。下面是群里刚连着说的几句话，最后一条是最新的。'
    : '你在跟 ' + last.name + ' 私聊。';

  const { text: out } = await brain.reply({ key, userId: last.userId, userName: last.name, text, situation });
  if (!out) { console.log('   （没说话）'); return; }

  if (cfg.dryRun) { console.log('   [干跑] 会说：' + out); return; }

  const r = await human.say(out, {
    setTyping: (on) => bot.setTyping(key, on),
    send: (m) => bot.send(key, m),
  });
  console.log('   发出 ' + r.sent + ' 条：' + r.parts.map((p) => p.slice(0, 18)).join(' | '));
  waker.wake(key);
  memory.touch(last.userId, { name: last.name });
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { reportError(e, '启动失败'); process.exit(1); });
}
