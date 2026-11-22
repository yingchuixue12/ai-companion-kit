# ai-companion · 让 AI 有个"人样"

> 决定一个陪聊像不像人的，不是模型，是**三件小事**：
> **记不记得你**、**打字像不像人**、**知不知道自己该不该说话**。
>
> 这个包只做这三件事。它不绑定平台，不绑定模型，不绑定 QQ。

```bash
npm install ai-companion
```

```js
import { Memory, Humanizer, Waker } from 'ai-companion';

const mem = new Memory({ dir: './data' });      // 记忆：按「人」存
const human = new Humanizer();                   // 说话：像人打字
const waker = new Waker({ names: ['小鱼'] });     // 场合：该不该理
```

---

## 先说三个真实的失败

大部分"AI 陪聊"项目栽在三个地方，跟模型强弱无关：

### ① 记忆按「会话」存 → 换个地方就不认识你了

```
私聊里：  "我叫老王，养了只猫"
（切到群里）
群里问：  "我叫什么？"
AI：      "抱歉，我不知道你的名字呢"
```

因为记忆挂在**会话**上。私聊一个桶，群 A 一个桶，群 B 一个桶。
同一个人换了桶，AI 就失忆。

**这个包的做法**：记忆挂在**人**身上（用账号 id 当 key）。
不管他在私聊还是哪个群，读写的都是同一本账。

### ② 回复"唰"一下全出来 → 一眼假

```
[对方] 在吗
[你]   在的！有什么可以帮您的吗？我随时都在哦～
                    ↑ 0.2 秒内一次性出现
```

真人不是这样的。真人会：
先"正在输入…"一两秒，然后**一句一句**发出来，中间还停顿。

**这个包的做法**：`Humanizer` 负责打字时长（跟字数相关 + 抖动 + 深夜变慢）、
自动分条、条间随机停顿、偶尔来个"长停顿"（像被什么事打断了）。

### ③ 什么时候都说话 → 很快被踢出群

```
[群友A] 中午吃啥
[AI]    我觉得可以吃麻辣烫！麻辣烫的好处有：1. …
[群友A] …
[群友B] 周末去哪玩
[AI]    推荐几个好去处：1. …
                    ↑ 五分钟后被移出群聊
```

**这个包的做法**：`Waker` 把"要不要醒"拆成独立条件——
被 @、被叫名字、被提问、被拍一拍、指定的人发言、关键词、随机概率。
任何一个命中才醒，否则**一个字都不说**。

---

## 安装

```bash
npm install ai-companion
# 想接 QQ 的话，还需要一个 OneBot 实现（下面讲）
```

---

## 三分钟上手

### 只要「像人打字」

```js
import { Humanizer } from 'ai-companion';

const human = new Humanizer({ msPerChar: 85 });

await human.say('在呢，咋了', {
  setTyping: (on) => platform.setTyping(chatId, on),   // 可选：显示"正在输入"
  send: (text) => platform.send(chatId, text),
});
```

它会自动：等 1.2 秒 → 发出去。
如果内容是 `'行\n你慢点'`，它会拆成两条，中间停 0.7~2.6 秒。

### 只要「记得住人」

```js
import { Memory } from 'ai-companion';

const mem = new Memory({ dir: './data' });

// 记一笔（不管他在哪个会话，都记到"这个人"头上）
mem.remember('10001', { name: '老王', trait: '常熬夜', fact: '养了只猫' });

// 唤醒时取出来，塞进 system prompt
console.log(mem.renderPerson('10001'));
// 【关于 老王（10001）的一本账】
// 你了解他：常熬夜
// 他告诉过你：养了只猫
// 你们互动过 1 次
```

### 只要「该不该说话」

```js
import { Waker } from 'ai-companion';

const waker = new Waker({
  names: ['小鱼'],
  ownerIds: ['10001'],          // 主人说话必醒
  probability: 0.05,            // 别人闲聊 5% 概率插一句
});
waker.setConfig('group:555', {
  atMention: true,
  nameMention: false,           // 群里只被 @ 才醒
  probability: 0,
});

const d = waker.shouldWake({
  key: 'group:555', userId: '20002', name: '小李',
  text: '@小鱼 在吗', isAtMe: true,
});
// { wake: true, reason: 'atMention' }
```

### 全都要（跑一个完整的）

```bash
cp config.example.json config.json     # 填 key、填你的 QQ 号
cp role.example.md role.md             # 改角色卡

npm run check     # 体检角色卡
npm run dry       # 干跑（不真发消息，只打印）
npm start         # 真跑
```

---

## 完整架构

```
                    ┌───────────────────────────────┐
   你的 QQ ─────────▶│  OneBot 实现                  │
                    │  NapCat / Lagrange / SnowLuma │
                    └───────────┬───────────────────┘
                                │ WebSocket (事件)
                    ┌───────────▼───────────────────┐
                    │  transport-onebot.js          │
                    │  翻译成统一消息格式            │
                    └───────────┬───────────────────┘
                                │
                    ┌───────────▼───────────────────┐
                    │  Waker · 该不该说话            │
                    │  @/名字/提问/拍/关键词/概率     │
                    └───────────┬───────────────────┘
                          醒了  │
                    ┌───────────▼───────────────────┐
                    │  Brain · 生成回复              │
                    │  ┌─────────────────────────┐  │
                    │  │ Role   角色卡 → 提示词   │  │
                    │  │ Memory 账本 + 最近对话   │  │
                    │  │ LLM    调模型            │  │
                    │  └─────────────────────────┘  │
                    └───────────┬───────────────────┘
                                │ 文本
                    ┌───────────▼───────────────────┐
                    │  Humanizer · 怎么发            │
                    │  打字时长 → 分条 → 停顿        │
                    └───────────┬───────────────────┘
                                │
                    ┌───────────▼───────────────────┐
                    │  OneBot → 你的 QQ             │
                    └───────────────────────────────┘
```

每一层都能单独用，也能换掉。比如你想接 Telegram，
只要照着 `transport-onebot.js` 的接口再写一个，其它三样原样能用。

---

## 五个模块

| 模块 | 干什么 | 单独用 |
|---|---|---|
| `Memory` | 记忆账本 + 跨场合对话流 | ✅ |
| `Role` | 读角色卡 → 拼 system prompt + 体检 | ✅ |
| `Brain` | 拼上下文 → 调模型 → 写回记忆 | ✅ |
| `Humanizer` | 打字时长 / 分条 / 停顿 | ✅ |
| `Waker` | 该不该说话 / 潜水管理 | ✅ |
| `OneBot` | QQ（OneBot v11）适配 | 可替换 |

### Memory · 记忆怎么存的

两个文件，都是纯文本，随便看随便改：

**`data/people.json`** —— 按人存的账本

```json
{
  "10001": {
    "name": "老王",
    "traits": ["常熬夜", "嘴上嫌我笨其实一直给我加功能"],
    "facts": ["养了只叫豆豆的猫"],
    "topics": ["他说下周要出差"],
    "pending": ["想问他那只猫叫什么来着"],
    "interactions": 37,
    "firstSeenAt": 1791407913658,
    "lastSeenAt": 1791412928131
  }
}
```

**`data/turns.jsonl`** —— 跨场合的对话流（一行一条）

```jsonl
{"t":1791409879392,"where":"private:10001","who":"老王","text":"今天加班到两点","reply":"又熬，你这身体不要了"}
{"t":1791409879393,"where":"group:555","who":"老王","text":"我回来了","reply":"哟，出差回来啦"}
```

唤醒时，把「这个人的账」+「最近 20 轮对话」一起塞进提示词。
所以它既知道**长期的事**（常熬夜、养猫），也知道**刚才发生了什么**。

### 记忆检索（默认关，可选）

提示词里的那一块记忆，默认还是 `renderPerson` 的整本账。想让它换成
**结构化检索**（已合入的两个适配器，都是纯本地、只读）时，在 `config.json` 里加：

```json
"memory": {
  "retrieval": {
    "enabled": true,
    "mode": "tail-window",
    "maxRecords": 20,
    "maxChars": 5000,
    "minConfidence": 0,
    "includeUnverified": true,
    "allowUnattributed": false
  }
}
```

- `mode` 只有两个值：`tail-window`（最近窗口，不按查询词打分）和 `lexical`
  （本地的词面重叠打分，CJK 二元组 + 空白切分，没有 embedding、不联网）。
  写错的值会回退 `tail-window`。
- **默认 `false`**：不打开就完全不走检索，请求体与以前逐字节一致。
- **只读**：检索只调 `dump()` / `recentTurns()`，不写账本、不迁移 v1→v2、
  不创建 `data/memory/`、不落任何真实记忆。
- **隐私**：没有主体（群聊多发送者）就不检索；只返回本人的记录；
  被删除 / 隔离 / 替代 / 脱敏 / 受限 / 缺出处的记录一律不渲染；
  适配器明确拒绝时给空块，**不退回**别人的记忆。
- **预算**：单条折叠空白后 ≤160 字，整块 ≤`maxChars`（默认 5000，与记忆槽上限同源）。
  按整条贪心取，放不下就停，绝不把半句丢给 `Role.build` 兜底裁剪。
- **降级**：启用后，检索故障或没有可用记录时，本轮省略长期记忆，仍可正常回复。
  这样不会绕开检索的隐私和预算限制。

单独的检索入口（不经配置，直接给 `Brain`）：

```js
import { Brain } from 'ai-companion';
const brain = new Brain({
  apiKey, role, memory,
  memoryBlocks: async ({ key, userId, text }) =>
    renderAllowedMemory({ key, userId, text }),
});
```

`Brain` 只认 `memoryBlocks` 这个不透明钩子：它自己不读账本、不做过滤，
检索、隐私与预算全在提供者那一侧。`memoryBlocks` 缺省为 `null`。

### 提示词预算（默认关，显式开启）

默认不设提示词预算：`Role` 保持旧版拼接顺序，`Brain` 的请求体与日志和以前逐字节一致。
想按 system prompt 的目标长度分层裁剪时，在 `config.json` 里显式加：

```json
"memory": {
  "systemBudgetChars": 8000
}
```

- 值必须是**正安全整数，且不超过 24000**（与 `Brain` 的请求体硬上限同一条契约）；
- **省略 = 旧行为**；显式提供才启用 `Role({ layered: true })` 与
  `Brain({ systemBudgetChars })`，硬上限仍由 `Brain` 的 24000 字符请求预算兜底；
- 分层模式把稳定人格层（基本规矩 / extra / 角色卡）放在最前，预算只削减
  recent → memory → situation → 任务引用，**绝不裁稳定人格层**；
- 每次模型请求前，CLI 会打印一条已有的脱敏 `memory-budget` 诊断（version 2）：
  只有块名、字符数、轮次/话题计数和配额，不含账号、对话正文、URL 或本地路径；
- 非法值（0 / 负数 / 小数 / 字符串 / null / 超过硬上限）在**读角色卡、创建 Memory、
  连接 OneBot、调用模型之前**失败，CLI 非零退出，只打印固定错误、不回显输入值；
  `--owner-private` 与宽松配置走同一份检查。

> 边界：这条 CLI 接线目前只有**合成 OneBot + fake fetch 的离线证据**，
> 尚未在真实芙兰宿主或真实 QQ 上验收。

### Waker · 潜水是怎么实现的

- `setConfig(key, {...})` 给每个会话单独配规则
- `shouldWake(msg)` 返回 `{wake, reason}`，日志里能看到因为什么醒的
- `wake(key)` / `dive(key, ms)` 管理"刚说过话 → 安静一会儿"

群里推荐配置（不被烦）：

```js
waker.setConfig('group:555', {
  mode: 'diving',          // 潜水
  infinite: true,          // 无限期，直到再次命中条件
  atMention: true,         // 被 @ 就醒
  nameMention: false,      // 叫名字不醒
  question: false,         // 被提问不醒
  poke: true,              // 被拍一拍醒
  probability: 0,          // 闲聊一律不理
  speakerIds: ['10001'],   // 但主人说话必醒
});
```

### Diary · 她自己的那一天

记忆写「关于你的事」，日记写「她自己的事」。两个分开存，混在一起只会写成汇报。

```js
import { Diary } from 'ai-companion/diary';
import { composeDiary } from 'ai-companion/diary-author';

const diary = new Diary({ dir: './data/diary' });

// 让她自己写一条（读角色卡 + 记忆 + 最近日记，避开写过的角度）
const row = await composeDiary({
  apiKey, baseUrl, model,
  roleText,
  memoryText: memory.renderRecent(16),
  diaryText: diary.context(3),
  avoidText: diary.recent(4).map((r) => r.title).join('\n'),
});
diary.add(row);
```

- 存两份：`index.jsonl`（一条一行，只追加）+ `YYYY-MM-DD.md`（人可以直接翻）
- `diary.context(3)` 只喂最近 3 条进 prompt —— 日记不该长成第二本记忆账本
- 命令行：`node src/diary.js auto` 她写 · `add` 你替她记 · `list` / `day` / `stats` 翻

---

## 语音运行入口（可编程宿主 · 默认关闭）

语音**不是**开箱能力：默认 `enabled=false`，不装供应商、不发网络、不接 CLI/QQ。
宿主自己决定要不要开，并把 ASR/TTS 适配器注入进来；不要就继续纯文字。

```js
import { createVoiceRuntime, VOICE_DECISION } from 'ai-companion';

const voice = createVoiceRuntime({
  enabled: true,          // 必须显式 true；写 "true" / 1 会直接抛 TypeError
  asr,                    // { transcribe(audio, { signal, timeoutMs }) }
  tts,                    // { synthesize(request, { signal, timeoutMs }) }
  memory: {               // 可选：长期记忆端口，签名是 remember({ text, confidence, ... })
    async remember({ text }) { /* 宿主自己决定怎么存 */ },
  },
});

// 收到一段语音
const heard = await voice.ingest({ input: { kind: 'audio', mime: 'audio/ogg', size: 4096, ref: 'incoming://1' } });
switch (heard.decision) {
  case VOICE_DECISION.CHAT:    reply(heard.chat.text); break;                    // 置信度够，直接进聊天
  case VOICE_DECISION.CONFIRM: askUser(`你是说「${heard.transcript.text}」吗？`, {
    yes: () => voice.confirm(heard.pending.id),
    no: () => voice.reject(heard.pending.id),                                    // 回退打字
  }); break;
  case VOICE_DECISION.REPEAT:  askUser('没听清，再说一遍？'); break;
  default:                     askUser('还是打字吧'); break;                     // 校验失败 / 适配器缺失
}

// 把回复准备好（只准备，不发送——本入口不碰任何平台）
const said = await voice.speak({ text: '在呢，咋了' });
await send(said.prepared === 'voice' ? { audio: said.audioRef } : { text: said.fallbackText });
if (said.audioRef) voice.release(said.audioRef);                                 // 发完释放临时音频

await voice.dispose();                                                           // 退出时清干净
```

行为契约（每条都有离线用例）：

| 场景 | 行为 |
|---|---|
| ASR 置信度低于 `minConfidence`（默认 0.6） | 不写长期记忆、不进聊天；挂成待确认，只有 `confirm(id)` 能放行，`reject(id)` 回退文字 |
| 入参自带 `confirmed: true` | **不采纳**：确认只能走 `confirm(id)`，没有可绕过的前置确认 |
| TTS 失败 / 超时 / 适配器缺失 / 存储失败 | `prepared: 'text'`，`fallbackText` 一定有值，`audioRef` 与 `artifact` 都是 `null` |
| 入口关闭（默认）、或 `dispose()` 已开始 | 两个方向都只退文字；不建临时目录、不调用适配器、`code: voice-closed` |

`speak()` 的 `prepared` 只是「准备好了语音」或「只能给文字」，**不代表已投递**——
发送永远是宿主的事，本入口不发消息、不开 CLI/QQ。

关闭契约（`dispose()` 是 async 的）：

- 一被调用就同步拒绝新操作（`voice-closed`），然后**等在途操作归零**再清理；
- 在途的转写/合成察觉到关闭后：不新增待确认、不写记忆、刚生成的音频当场删掉（删不掉时 `audioCleanupFailed: true`），
  所以关闭完成后不会再有文件或记忆冒出来；
- 自建 store 的临时目录一并删除；注入 store 只删自己的 ref。

临时文件归属（不混账）：

- **输入音频**是转写期文件：转写结束（成功或失败）就被删掉；本入口不提供"保留用户语音"的开关。
- **合成音频**是投递期文件：`speak()` 返回的 `audioRef` 归宿主发送用，发完调 `release(ref)`。
  只有真删掉或确认已不存在才停止追踪；存储报错会保留追踪（`kept: true`），留给 `dispose()` 重试并如实报告。
- `purgeExpired()` 只清**本入口自己创建**的过期条目；注入共享 store 时绝不调用 `store.purgeExpired()`，
  不会删到宿主的文件。
- 待确认条目只在内存里，`confirmTtlMs`（默认 5 分钟）到期作废，`maxPending`（默认 8）满了就回退文字——不会攒着用户语音。

`voice.status()` 是只读自述：启用/关闭状态、在途数、适配器能力（含 `offline` 标记）、临时存储归属与追踪数、待确认条数、策略值。

**边界**：这里只有供应商中立契约 + 离线桩（D0）。真实 ASR/TTS 供应商、费用、隐私留存（U1）未确认前不接入；
本入口不改 `node src/index.js` 主 CLI，也不该被当成"已经能语音聊天"。

---

## 角色卡怎么写

见 `role.example.md`。要点就三条：

1. **写清"怎么说话"** —— 长度、语气、口头禅、明确禁止什么（别说 Markdown、别每条都关心人）
2. **给边界** —— 什么不做、什么必须做
3. **别写太长** —— 超过 `roleMaxChars` 会被截断，而且模型对超长提示词的注意力会衰减

`Role.lint()` 会体检：

```js
const role = new Role({ cardPath: './role.md' });
console.log(role.lint());
// { ok: false, warn: ['没写「不做什么」——没有边界的角色容易跑偏'] }
```

---

## 接 QQ 要准备什么

你只需要一个 **OneBot v11 实现**（负责登录 QQ、收发消息）：

| 实现 | 说明 |
|---|---|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 基于 QQ NT，跨平台，活跃 |
| [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | C# 实现，无需装 QQ |
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | QQ NT 插件形式 |
| SnowLuma | 同类实现，本项目的 OneBot 适配按它的行为调过 |

配好之后在它的设置里开启：
- **正向 WebSocket** → 记下端口（默认 3001），填进 `config.json` 的 `onebot.wsUrl`
- **HTTP API** → 记下端口（默认 3000），填进 `onebot.httpUrl`

然后 `npm start`。

> ⚠️ 先 `npm run dry` 干跑一遍。它会把模型生成的回复**打印出来但不真发**，
> 确认语气对了再开真发。

---

## 提醒（--reminders）

主人在私聊里说一句话，就能让它到点提醒你。整条链路只认明确命令，不做模糊理解。

### 从正确目录启动

下面的命令都假设先 `cd packages/companion`（`npm run check` / `npm run dry` /
`npm start` 定义在这个包里，仓库根目录跑不了）：

```bash
cd packages/companion
node src/index.js --config ./config.json --reminders
```

- 提醒默认关闭，必须显式加 `--reminders`；
- `ownerIds` 必须在 `config.json` 里配好（十进制 QQ 号数组）。一个有效项都
  没有时不会排任何定时器，横幅会提示「[提醒] 没有有效主人白名单，不启动调度」；
- 启动横幅里能看到当前生效的主人白名单和「提醒 开/关」状态。

### 干跑与检查模式的影响

- `--dry-run`：提醒整体不装配 —— 调度运行时不创建、命令不识别、
  不会发任何消息；横幅显示「提醒 开（干跑不启动）」；
- `--check`：只体检角色卡就退出，不连 OneBot，也不碰提醒。
- `onebot.statusDiagnostics: true`：以 JSON 记录连接、错误和断开，并提供连接尝试次数和重连间隔。启用后，连接日志不再输出 WebSocket 地址或原始异常；缺省时沿用原日志。

### 三个命令（只认主人私聊、单行整句）

| 命令 | 例子 | 说明 |
|---|---|---|
| 创建 | `5分钟后提醒我喝水` | 回「好，到点提醒你：喝水」+ 任务 ID + 取消方法；先落盘成功才回确认 |
| 查看 | `查看提醒` | 列当前会话的待提醒，按到点时间升序，最多 20 条，时间显示为 UTC |
| 取消 | `取消提醒 <完整任务 ID>` | 必须按完整 ID 精确匹配；没带 ID 会先澄清，只给一部分 ID 会按「找不到」处理 |

- 时间只认 `<数字><单位>后提醒我<内容>`：单位支持 毫秒/ms/秒/s/分/分钟/时/小时，
  范围 1 毫秒 ~ 7 天，正文 ≤500 字符；「半小时后」「明天下午」这类模糊说法
  只会收到一句固定的澄清，不会被猜；
- 只认主人的**私聊**（会话键必须是 `private:<QQ号>` 且与发送者一致），
  单行整句；群里、别人发的、或普通叙述里顺带出现「提醒我」都不算命令；
- 取消只有还没触发的提醒能成功；已经触发或正在发送的会回「不能取消了」，
  重复取消同一个 id 幂等成功。

### reminders.json

快照存在 `<dataDir>/reminders.json`（默认 `data/reminders.json`），每条记录
保存任务 ID、正文、到点时间和当前状态。写入是原子的（临时文件 + rename），
坏文件不会被一次保存抹掉。查看只显示当前会话的记录，别的会话里的同 ID
等同于不存在。

### 不会自动补发

- 到点投递后**结果未知**（回执没确认，比如传输异常或窗口已关闭）、或
  **已经尝试但结果还没确认**的提醒，都不会自动重发，等明确核查后再处理；
- 已经确认送达或明确失败的提醒是终态，重启后保持不变；
- 超过 24 小时仍未触发的提醒会直接过期，不再补发。

### 证据现状

通用 CLI（`node src/index.js` 这条完整链路，含 OneBot 收发与提醒调度）
目前只有合成离线证据：离线测试用注入的 bot / 定时器 / 时钟验证过各模块
契约，尚未在真实 OneBot 实现上端到端验证过。

---

## 常见问题

**Q: 它一次发好几条，会不会显得刷屏？**
`humanize.burstMax` 控制一次最多几条（默认 4）。
超出的会自动合并到最后一条。觉得吵就调小，或者加大 `gapRange`。

**Q: 群里它一句话都不说？**
默认 `groupAtOnly: true`，只被 @ 才醒。想活跃点就：
```json
"wake": { "groupAtOnly": false, "probability": 0.1 }
```

**Q: 记忆会不会越存越大？**
`topics` 留最近 20 条，`traits` 40 条，`facts` 60 条，对话流 400 轮。
都是自动裁剪的。想留更久就传 `new Memory({ maxTopics: 100, maxTurns: 5000 })`。

**Q: 能接别的模型吗？**
`config.json` 里改 `baseUrl` 和 `model` 就行，只要那个接口是 OpenAI 格式。
DeepSeek / Kimi / 通义 / 本地 Ollama 都行。

**Q: 能接微信 / Telegram 吗？**
能。照着 `transport-onebot.js` 实现三个方法：
`send(key, text)`、`setTyping(key, on)`、消息进来时调 `onMessage(msg)`。
其它四层原样不动。

---

## 跑一下 demo

完全离线，不需要 key，不需要 QQ：

```bash
node examples/demo.js
```

会打印出记忆账本长什么样、一次拟人化发送的真实时间轴、以及六种场景下
它选择"醒"还是"装死"。

---

## License

MIT
