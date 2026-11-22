# C-01/C-02 Web presence HTTP 离线矩阵 · 交付报告

- 日期：2026-11-22
- 验收基线：fork `main` `f243fc0`（已含 #96 Web host、#100 HTTP handler 和 #103 CLI 提示词预算）
- 写入范围：`scripts/acceptance/**` 与本报告；未改运行产品、CI 配置或原芙兰工作树

## 1. 结论

本次把 Web presence 宿主路径（真实公开 `presence/web-host.js` + `presence/web-http.js`）接进统一离线矩阵，C-01/C-02 从 `not-covered` 变为可执行场景：

| 编号 | 场景 | 本次状态 | 证据范围 |
|---|---|---|---|
| C-01 | Web presence HTTP：欢迎 / 休息 / 冷却限流 / 内容盲禁止正文 / 禁用清空 | **pass（离线）** | 真实 web host + 真实 web-http handler 挂临时回环 server；HTTP 客户端验证 |
| C-02 | Web presence 重启：共享状态文件、冷却/会话恢复、旧欢迎不补发、过冷却可新事件 | **pass（离线）** | 同一状态文件上的第二个 host 实例 + 同一虚拟时钟 |

### 计划 §9.2 逐项对齐（更新）

| 计划项 | 矩阵证据 | 本次状态 |
|---|---|---|
| C-01 Web presence 欢迎/休息 | C-01 | pass（离线 HTTP 回环） |
| C-02 presence 重启恢复（Web） | C-02 | pass（离线，同状态文件实例重建） |
| C-03…C-09 | 不变（见上一份报告） | pass（离线） |

### 门禁语义（只更新 C 门；B/D/E 判定与事实全部保留）

- **B 门语义保持不变**：分母仍为 18，通过仍为 11，永久缺口仍为 B-03/B-04/B-05/B-12/B-14/B-15/B-18，`completeBGate=false`。
- **C 门**：离线证据从 6/8 → **8/8**，`offlineCGateComplete=true`。注意口径：这只是「离线可执行证据齐了」；C-04 的真实平台部分仍属 T9，**C 门整体（含真实平台）仍未通过**，运行器输出原样保留这一句。
- C 场景仍全部 `gate: 'group'`：不进 B 门分母、不进 `extra` 增补计数。

## 2. 测试矩阵与逐项断言

场景实现：`scripts/acceptance/presence-scenarios.mjs`（`runC01` / `runC02`）；注册：`scripts/acceptance/scenarios.mjs`。

### 公共 fixture

- 真实 `createPresenceWebHost`（enabled:true、虚拟时钟注入、可选状态文件）+ 真实 `createPresenceHttpHandler` 挂在 `createServer` 上，`127.0.0.1` 随机端口。
- HTTP 客户端用 `node:http` request（`agent:false`），只打 `/presence/signal`（POST JSON）与 `/presence/messages`（GET）。
- 认证：`authorize` 回调核对合成 header（`x-acceptance-auth`）；不是真实部署认证。
- `settle()` / `setEnabled(false)` 由场景以**挂载方**身份调用——web-http 的文档契约就是「认证、结算拍、生命周期归挂载方」。
- 所有状态文件在 harness 临时目录；不联网（唯一"网络"是本进程回环 server）、不改全局 fetch、不读真实墙钟。

### C-01（5 steps）

1. **欢迎**：初始 GET messages 为空页（`no-store` + JSON 头）；POST activity → 虚拟时钟 31 分钟 → settle（away）→ 6 分钟 → POST activity → 带 cursor GET 得到一条 `welcome-back`（text/at 齐全）；同 cursor 复读为空（只读幂等不回放）；journal 恰 1 条 `presence-web-intent`。
2. **冷却限流**：再走一轮 away → 回来（距上次欢迎 74 分钟 < 90 分钟冷却）→ observe 返回 `ok` 但提示页为空、`pending` 仍是未读的那 1 条。
3. **休息**：独立 fixture（idleMs=60min、awayMs=120min、workAfterMs=50min）；在场 51 分钟 settle → 一条 `break-reminder`；同会话再 settle 5 分钟不再重提。
4. **内容盲 / 禁止正文**：四种非法体（多余 `text`、`url`+`title`、kind-flag 混用、未知 kind）全部 400 `invalid-signal`，响应无回显；合法 `kind+布尔量` 心跳 200。断言：secret 不进状态文件、不进 journal、欢迎文案不回显；状态文件无 `"text"` 字段；拒收不改 `pending`。
5. **禁用清空**：先在独立 fixture 交付一条欢迎，`setEnabled(false)` → `dropped=1`、`cleared=true`、状态文件被删；旧 cursor 读页为空；之后 POST signal → 409 `{ok:false,status:'disabled'}`；`pending=0`。

### C-02（4 steps）

1. **共享状态文件**：实例 1 在同一 `stateFile` 上产生欢迎（T+37min）并 `close()`（`persisted=true`）；实例 2 同一虚拟时钟、同一文件启动 → `restored=true`、`status=ready`、`presence-web-restored` 诊断、`cooldowns.welcome === T+37min`、台账 0 条（Web 不写投递台账）。
2. **无旧欢迎补发**：旧实例 cursor（epoch 失配）与无 cursor 首读都只拿到空页；journal 无 `"text"` 字段。
3. **冷却恢复**：T+68min settle → away；T+74min 回来（距上次欢迎 37 分钟 < 90 分钟）→ 提示页为空。**扣下它的是从状态文件恢复的 session 冷却闸门**——新实例自己的策略没有旧欢迎记忆，这正是跨重启防重复的落点。
4. **过冷却新事件**：再 settle 出 away（T+105min），T+165min 回来（距上次欢迎 128 分钟 ≥ 90 分钟，离开 60 分钟 ≥ awayMs）→ 一条新的 `welcome-back`；消息 id 与游标都换新 epoch；`cooldowns.welcome` 更新为本次时刻。

## 3. 统一矩阵结果

命令：`node scripts/acceptance/run.mjs --offline`

- 总项：43
- 执行：36（36 pass / 0 fail）
- 未覆盖：7（全部是 B 门永久缺口；C 门 0）
- B 门：11/18，永久缺口 7，`completeBGate=false`
- C 门：8/8，`offlineCGateComplete=true`（真实平台部分仍属 T9）
- 退出码：0

C-01/C-02 逐项结果：

```
✅ C-01  steps 5 · diff 0
✅ C-02  steps 4 · diff 0
```

## 4. 命令与退出码

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node scripts/acceptance/run.mjs --offline` | 43 项；36 执行 / 36 pass / 0 fail / 7 not-covered；B 11/18；C 8/8 | 0 |
| `node scripts/acceptance/run.mjs --offline --scenario=C-01` | 5 步全过 | 0 |
| `node scripts/acceptance/run.mjs --offline --scenario=C-02` | 4 步全过 | 0 |
| `node --test scripts/acceptance/acceptance.test.mjs` | 79 条测试，79 pass，0 fail | 0 |
| `node scripts/verify.mjs` | 1031 条测试、0 fail / 0 skipped / 0 todo | 0 |
| `git diff --check` | 无空白错误 | 0 |

新增/修改文件语法检查：`node --check` 通过（presence-scenarios.mjs、scenarios.mjs、run.mjs、acceptance.test.mjs）。

## 5. 失败报告

本次运行 **0 失败**。

- 统一矩阵：36 个执行场景全部 pass；7 个 not-covered 没有被算作通过，也没有新增。
- 27 条 verify/check 告警是仓库既有的文档/路径/QQ 号模式告警；本次改动未新增告警。
- 没有触发真实平台、外网、真实模型或仓库 `data/`；没有改写全局 fetch；唯一的监听 socket 是各 fixture 的临时回环 server，场景结束即关闭（`finally` 保证）。

## 6. 证据边界与不碰的东西

- **回环 HTTP**：server 与客户端在同一进程内、`127.0.0.1` 随机端口；不是真实部署（无 TLS、无真实反向代理、无浏览器）。
- **挂载方节拍**：`settle()`/`setEnabled()` 由场景直接调用——这与 web-http 的文档契约一致（认证/结算拍/生命周期归挂载方），不构成对 HTTP 层的绕过；HTTP 客户端本身只见两个公开路由。
- **重启口径**：C-02 是同一状态文件上的第二个 host 实例 + 同一虚拟时钟，不是 OS 进程级重启。
- **合成范围**：合成 authorize header、合成 secret 字符串；文案是策略确定性短兜底。**不证明**真实浏览器/页面/传感器行为，**不说** T6 芙兰页面或 T9 验收完成（T6 芙兰页面在本机源树、没有进入公开 fork）。
- **不迁移 / 不改产品**：diff 只在 `scripts/acceptance/**` 与本报告；B/D/E 的判定、分母与事实原样保留。

## 7. 剩余与后续

1. **C 门整体**：离线 8/8，但 C-04 真实平台半仍属 T9；`offlineCGateComplete=true` 不等于 C 门全通过。
2. **B 门 7 个永久缺口**：B-03/B-04/B-05/B-12/B-14/B-15/B-18 不变，`completeBGate=false`。
3. **真实浏览器/芙兰宿主**：T6 芙兰页面不在公开 fork；如需真实页面验收，仍须在拥有该源树的机器上单独执行，不能由本矩阵冒充。
