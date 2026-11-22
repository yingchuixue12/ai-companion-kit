# 在场行为接入统一离线矩阵 · 交付报告

- 日期：2026-11-22
- 基线：fork `main` `e86ac8d`
- 工作树：`<worktree>`（分支 `codex/presence-offline-acceptance`）
- 写入范围：`scripts/acceptance/**` 与本报告；未改运行产品、未改 CI、未操作远端
- 提交状态：未提交，留给 Codex 复核与发布

## 1. 结论

本次把 QQ 在场（presence）行为接进统一离线矩阵，新增 6 个可执行 C 场景：

| 编号 | 场景 | 本次状态 | 证据范围 |
|---|---|---|---|
| C-03 | QQ presence 默认关闭 | **pass（离线）** | `main()` + 合成 bot + 临时配置；6 种配置闸门 |
| C-04 | 开启后投递与回执 | **pass（仅离线半）** | 真实 Humanizer + 合成 OneBot；sent / accepted 分离 |
| C-05 | 重启后日上限 / 冷却 / 台账 | **pass（离线）** | 同一状态文件的 host 重建 |
| C-07 | 安静时段与过期积压 | **pass（离线）** | 虚拟时钟本地 9–11 点；30 分钟 intent TTL |
| C-08 | 过时 intent 作废 | **pass（离线）** | host 层 owner 消息作废 + 同一 adapter 的 stale 守卫 |
| C-09 | 失败 / 未知不重试 | **pass（离线）** | 合成 OneBot rejected / throw；只结算一次 |

未覆盖项继续保持 `not-covered`：

| 编号 | 原因 | 说明 |
|---|---|---|
| C-01 | `requires-web-presence-host` | 本 checkout 没有 Web presence 宿主/API 路径 |
| C-02 | `requires-web-presence-restart` | 同上；QQ presence 重启由 C-05 单独覆盖，不能冒充 C-02 |

日上限和冷却跨重启按计划 §9.2 记为 **C-05**。运行器接受旧场景别名 `C-06`，机读报告一律记录为 `C-05`。C-01/C-02 仍缺 Web 宿主证据。

### 计划 §9.2 逐项对齐

| 计划项 | 矩阵证据 | 本次状态 |
|---|---|---|
| C-01 Web presence 欢迎/休息 | —（缺 Web 宿主路径） | `not-covered` |
| C-02 presence 重启恢复（Web） | —（缺 Web 宿主路径；QQ 重启见 C-05） | `not-covered` |
| C-03 QQ presence 默认关闭 | C-03 | pass（离线） |
| C-04 QQ presence 开启后投递 | C-04（投递/回执）+ C-09（失败不重试） | pass（仅离线半；真实平台属 T9） |
| C-05 主动回访重启限流 | C-05 | pass（离线） |

### 门禁语义

- **B 门语义保持不变**：分母仍为 18，通过仍为 11，永久缺口仍为 B-03/B-04/B-05/B-12/B-14/B-15/B-18，`completeBGate` 仍为 `false`。
- C 门独立计分：本次离线证据 **6/8**；C-01/C-02 未覆盖，C-04 真实平台部分仍属 T9，所以 **C 门整体不通过**，`offlineCGateComplete=false`。
- C 场景全部为 `gate: 'group'`，不进入 B 门分母、不进入 `extra` 增补计数。

## 2. 测试矩阵与逐项断言

场景实现：`scripts/acceptance/presence-scenarios.mjs`；注册：`scripts/acceptance/scenarios.mjs`；报告字段：`scripts/acceptance/run.mjs`。

### C-03 默认关闭（2 steps）

1. 用真实 `main()` 的 `createBot` 注入点跑一次 CLI 装配；配置里没有 `presenceQQ`。
   - 断言：`loadConfig` 默认 `enabled=false`、`ownerId=''`；host `status=disabled`、`enabled=false`、`ownerId=null`、`stateFile=null`；无 `presence-qq-state.json`；0 次发送；`tick` 返回 `disabled`；`close()` 不落盘。
2. 六个配置闸门：无配置 / `enabled=false` / owner 缺失 / owner 不在白名单 / 多 owner 但无显式 owner / `dry-run`。
   - 断言：状态依次为 `disabled|disabled|owner-missing|owner-not-whitelisted|owner-missing|dry-run`；诊断码对应；`observe` 同样不进入发送；0 个状态文件、0 次发送。

> 合成范围：合成 owner、临时配置、合成 bot；不连真实 QQ。
> 已知差异：本 fork 的 `PRESENCE_QQ_DEFAULTS.quietHours` 为 `null`，计划 T5 写的是 `[23,7]`。本 PR 不改产品，因此 C-03 的 pass 只覆盖“默认关闭、配置关闭、无主动消息”，不把该默认值差异算作通过。

### C-04 开启后投递（4 steps）

1. confirmed 回执：away → present 产生 welcome intent；真实 Humanizer 调用一次；合成 OneBot `sendPrivateText` 一次。
   - 断言：`status=sent`、`sent=1`、`accepted=0`、`confirmed=true`、`pending=0`、收件人=合成 owner、回执 `confirmed`、正文非空。
2. 证据边界：journal 中 `presence-intent` 在 `presence-delivery` 之前；delivery `sent/confirmed/quota=true`；journal 与状态文件都不含正文；台账状态 `sent`。
3. accepted 回执：合成 OneBot 只返回 `{ok:true}`，没有 `message_id`。
   - 断言：`status=accepted`、`sent=0`、`accepted=1`、`confirmed=false`、台账 `accepted`。
4. accepted 也占额度：同一状态再产生一条 intent，`maxPerDay=1`。
   - 断言：第二条 `daily-cap`、`sent=0`、发送次数仍为 1、pending=1、journal 只有一条 delivery、台账仍 `accepted`。

> 合成范围：真实 `Humanizer`、真实回执归一化、真实状态文件，但 OneBot 是合成的 `sendPrivateText`。
> **C-04 只证明离线半**；真实平台回执仍属 T9，不因本场景 pass 而视为 C-04 全通过。
> 计划 C-04 的“失败不重试”半由 C-09 单独覆盖；C-04 本身不重复测失败路径，避免同一证据重复计数。

### C-05 重启后额度（4 steps）

1. 重启前：away → present → confirmed 回执，`status=sent`，台账 1 条 `sent`，状态文件存在。
2. 同一 `dataDir` 新建 host，时钟前进 1 小时：`restored=true`、台账 1 条、`welcome` 与 `proactive` 冷却等于重启前发送时刻、`pendingEvents=0`、重启后 0 次发送。
3. 重启后第一轮 away → present：intent 序号从 1 重新开始，与已结算 id 相同 → 0 条 intent、0 条路由、无 delivery、0 次发送（旧欢迎不补发）。
4. 第二轮 away → present：新 id 被 `daily-cap` 拦住；`pending=1`、发送次数仍为 1、台账仍 1 条、`dailyCapSkips=1`。

> 合成范围：同一临时状态文件上的 host 重建，不是 OS 进程级重启；不是真实 QQ。

### C-07 安静时段 / 过期积压（3 steps）

1. 虚拟时钟落在本地 9–11 点；away → present 产生 welcome → `quiet-hours`；`pending=1`、0 次发送、0 条 delivery、0 条 expired。
2. 前进 10 分钟（仍在 TTL 内）：仍 `quiet-hours`、`pending=1`、0 次发送。
3. 前进 3 小时到 13 点：intent 超过 30 分钟 TTL → `idle`、`pending=0`、0 次发送、1 条 `presence-intent-expired`、0 条 delivery。

> 合成范围：虚拟时钟与本地小时判断；不证明真实平台时段，也不读系统真实时间。

### C-08 过时 intent（2 steps）

1. host 层：安静时段先留一条 pending；owner 私聊到达。
   - 断言：`ignored=false`、`invalidated=1`、`pending=0`、0 次自指发送、随后 `tick` 为 `idle`、1 条 `presence-intent-invalidated`、0 条 delivery。
2. 同一 adapter 层：host 不暴露 `adapter.onIntent`，因此用真实 `PresenceRuntime` + `createPresenceSession` + `createPresenceQQAdapter` 直接验证 stale 守卫。
   - 断言：先入队成功；`noteUserMessage` 作废 1 条；更早 intent 被 `stale-after-user-message` 拒绝；`tick` 为 `idle`；0 次发送。

> 合成范围：host 层 + adapter 层都是真实离线模块；没有真实 QQ 消息。

### C-09 失败 / 未知不重试（2 steps）

1. 平台明确拒绝：合成 OneBot 返回 `ok:false` + `receipt:rejected`。
   - 断言：`status=failed`、`confirmed=false`、`sent=0`、`accepted=0`、`pending=0`、1 次发送尝试；journal `failed/quota=false`；台账 `failed`；再 `tick` 为 `idle`、调用次数仍为 1；adapter `attempted=1`、`failed=1`。
2. 回执未知：合成 OneBot 直接抛传输异常。
   - 断言：`status=unknown`、`confirmed=false`、`sent=0`、`accepted=0`、`pending=0`、1 次发送尝试；journal `unknown/quota=false`；台账 `unknown`；再 `tick` 为 `idle`、调用次数仍为 1；adapter `attempted=1`、`unknown=1`。

> 合成范围：真实 Humanizer / adapter / 状态文件；合成 OneBot 的失败与异常。真实平台对账仍属 T9。
> 本场景对应计划 C-04 的“失败不重试”半；C-04 只负责投递与回执分离。

## 3. 统一矩阵结果

命令：`node scripts/acceptance/run.mjs --offline`

- 总项：42
- 执行：30（30 pass / 0 fail）
- 未覆盖：12（B 7 + C 2 + D/E 3）
- B 门：11/18，永久缺口 7，`completeBGate=false`
- C 门：6/8，未覆盖 C-01/C-02，`offlineCGateComplete=false`
- 退出码：0

新增 C 场景逐项结果：

```
✅ C-03  steps 2 · diff 0
✅ C-04  steps 4 · diff 0
✅ C-05  steps 4 · diff 0
✅ C-07  steps 3 · diff 0
✅ C-08  steps 2 · diff 0
✅ C-09  steps 2 · diff 0
```

## 4. 命令与退出码

| 命令 | 结果 | 退出码 |
|---|---|---|
| `node scripts/acceptance/run.mjs --offline` | 42 项；30 执行 / 30 pass / 0 fail / 12 not-covered；B 11/18；C 6/8 | 0 |
| `node scripts/acceptance/run.mjs --offline --json=<临时文件>` | 机读报告写入临时文件，摘要同上 | 0 |
| `node --test scripts/acceptance/acceptance.test.mjs` | 76 条测试，76 pass，0 fail | 0 |
| `node scripts/verify.mjs` | 52 个测试文件、887 条测试、0 fail / 0 skipped / 0 todo；结构检查 127 pass / 0 fail / 27 warnings | 0 |
| `node scripts/check.mjs` | 127 pass / 0 fail / 27 warnings（仓库既有告警） | 0 |
| `git diff --check` | 无空白错误 | 0 |

单场景复核（均退出 0）：`--scenario=C-03`、`--scenario=C-04`、`--scenario=C-05`、`--scenario=C-07`、`--scenario=C-08`、`--scenario=C-09`。

## 5. 失败报告

本次运行 **0 失败**。

- 统一矩阵：30 个执行场景全部 pass；12 个 not-covered 没有被算作通过。
- 仓库验证：887 条测试 0 fail；`scripts/check.mjs` 0 fail。
- 27 条 check 告警是仓库既有的文档/路径/QQ 号模式告警；新增的 `presence-scenarios.mjs` 未新增告警。
- 没有触发真实平台、网络、真实模型或仓库 `data/`；没有全局 `fetch` 改写。

## 6. 证据边界与不碰的东西

- **合成 OneBot**：只实现 `sendPrivateText` / `setTyping`，返回形状对齐 `transport-onebot.js` 的 `{ ...result, receipt }`；不建立 WebSocket/HTTP 连接。
- **虚拟时钟**：C 场景全部通过 harness 虚拟时钟推进；C-07/C-08 用本地小时判断安静时段，不读真实墙钟。
- **临时目录**：所有状态文件都在 harness 临时目录；不读写仓库 `data/`、真实配置、私密记忆或日志。
- **CLI 注入**：C-03 用 `main({ createBot, proc })` 的既有注入点；其余场景直接驱动 `createPresenceQQHost`（`main()` 使用的同一运行层），时钟通过 `now` 注入。没有修改产品注入点。
- **不迁移**：没有迁移 `examples/flandre`、宿主或私有配置；公开 fork 不依赖私有路径。
- **不改产品 / CI / 远端**：本次 diff 只在 `scripts/acceptance/**` 与本报告。

## 7. 剩余与后续

1. **C-01/C-02**：仍缺 Web presence 宿主/API 路径，保持 `not-covered`。
2. **C-04 真实平台半**：需要 T9 真实 QQ 验收；本次只 pass 离线合成半，C 门整体不通过。
4. **B 门 7 个永久缺口**：B-03/B-04/B-05/B-12/B-14/B-15/B-18 仍缺宿主/QQ 集成路径，`completeBGate=false` 不变。
5. **默认值差异**：本 fork 的 `quietHours` 默认 `null`，计划 T5 写 `[23,7]`；本 PR 不改产品，故未把该默认值纳入 C-03 通过断言。
6. **未提交**：按要求不 commit；请 Codex 复核 diff、报告与退出码后发布。
