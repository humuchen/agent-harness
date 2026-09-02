# 单行业智能体「完全闭环」可行性分析

> 口径说明：本文讨论"**一个行业智能体**（如金融 / 医疗 / 医美 / 教育）在当前架构下，能否在无人介入的情况下，从接收任务到产出结果自主完成端到端循环"。
> 分析基于 `backend/core` 与 `access/server` 的**真实当前代码**（非早期评估版本）。
> 结论：**执行/数据面完全自动闭环；控制面（real 模式提交）与跨 run 记忆持久化默认不闭合，但均为可配置项，非结构性缺失。**

---

## 一、结论速览

| 闭环层级 | 能否自动闭环 | 条件 |
|---|---|---|
| 单次任务推理闭环（LLM↔工具↔护栏） | ✅ 完全自动 | 无 |
| 多步骤工作流 DAG（含失败自动补偿） | ✅ 完全自动 | 无 |
| 跨 run 长期记忆闭环（学会之前的事） | ✅ 可自动 | **需** `MEMORY_BACKEND=file\|sqlite` |
| 产出自检闭环（自动验证+自愈） | ✅ 可自动 | **需** 注入 `Verifier` |
| 生产提交闭环（real 模式经 HTTP API） | ⚠️ 条件满足才自动 | **需** 审批旁路/自动化（见第四节 A） |
| 调用远端其它智能体（A2A） | ⚠️ 自动但有外部依赖 | 远端可达；失败自动降级本地 |

一句话：**把智能体直接作为 harness 调用（或 mock 模式经 API），它本身就是一个自包含闭环；只有在「生产 real 模式走审批受控的服务动作」和「要求跨进程记忆」时，闭环才需要配置或外部接力。**

---

## 二、单智能体闭环在代码层如何跑通（自动、无人）

核心执行路径：`harness.ts → AgentHarness.run()`（backend/core/src/harness.ts:141）。它是**纯自动循环**，路径如下：

```
输入
 │
 ├─ checkInput()                      输入护栏：注入/密钥/超长 自动拦截 (guardrails.ts:339)
 ├─ memory.load()                     若有持久化后端，载入历史 (hasPersistence)
 ├─ 注入长期记忆到 systemPrompt
 │
 └─ for step in 0..maxSteps:          ★ 主循环，无人工节点 ★
      ├─ llm(messages, tools)           LLM 决策（Promise.race 支持超时/取消打断）
      ├─ checkOutput()                 输出护栏：注入/密钥 自动拦截
      ├─ if 无 tool_calls → return      ✅ 最终答案，闭环收口
      └─ for each tool_call:
           ├─ checkToolArgs()          工具参数护栏（含 web_fetch 出网管控）
           └─ tools.call()             执行工具；异常作为 tool message 回灌模型自愈
 │
 ├─ verify()                          可选：产出自动验证，未过则注入自检提示重跑（自愈）
 ├─ memory.save()                     若有持久化后端，落盘
 └─ redactOutput()                    输出侧 PII 脱敏后返回
```

**关键事实**：
- 主循环（harness.ts:234-382）**没有任何 `await humanInput()` / 审批 / 确认节点**。每一步都是 LLM 或工具，错误自动回灌模型（harness.ts:357-360："将错误作为工具结果返回，以便模型自行修复"）。
- 护栏、PII 脱敏、密钥扫描全部**同步自动**执行（guardrails.ts），命中即拦截并返回提示文本，不会卡住等人工。
- `maxSteps`（默认 12）与 `timeoutMs` / `tokenBudget` / `costBudget` 是预算熔断，**超限自动中止**（harness.ts:245-294），不会无限挂起——这也是闭环"收得口"的保证。

---

## 三、多步骤工作流 DAG 的自动闭环

若一个行业智能体的任务是多步骤编排（如"医疗：初诊分诊→开检查→出报告"），走 `DagEngine`（`backend/core/src/workflow/engine.ts`）：

- **拓扑分层**：`topoWaves()` 把无依赖的 step 编入同一波次并行执行（engine.ts:107-133），遇环/缺依赖 **fail-fast 抛错**（不静默死锁）。
- **失败自动补偿**：任意 step 抛错会触发 `compensate()`，对已完成的 step **逆序**执行补偿动作（engine.ts:221-269），解决"副作用无回滚"。
- **检查点续跑**：每 step 状态落 `WorkflowStore`（engine.ts:173），`resume()` 可从断点续跑（engine.ts:272）。
- **无人工节点**：整个 DAG 执行链（含补偿）**全自动**，且 `workflow:run` 动作**不在** `SENSITIVE_ACTIONS` 中（approval.ts:48-59），连提交都不强制审批。

> 注意：`store` 默认 `VolatileWorkflowStore`（内存）。要跨重启续跑，需注入持久化 `WorkflowStore`（接口已预留）。

---

## 四、闭环的断点（需要人/外部接力之处）

### A. 控制面审批闸门（最关键的"不完全"来源）

`approval.ts` 的 `SENSITIVE_ACTIONS` 包含：
```
'agent:run:real', 'agent:run:real-mcp', 'verify',
'env:create', 'env:destroy', 'mcp:add', 'mcp:preset', 'mcp:reconnect',
'shell:approve', 'memory:clear'
```
- `agent:run:mock` **不在**其中 → mock 模式提交**全自动**（演示/开发天然闭环）。
- `agent:run:real` / `agent:run:real-mcp` **在**其中 → 经 HTTP API 提交真实模式时，**返回 202 + 需要审批工单**，必须有人/自动化 `POST /api/approvals/{id}` 裁决后才放行（server.ts:167-177）。
- 绕过条件：`requiresApproval()` 对 `bypass` 角色（默认 `admin`）返回 false（approval.ts:71-74）。

**含义**：生产环境若用 real 模式、且调用方角色非 admin，闭环在**提交那一刻停住等人**。这是**策略选择而非架构缺陷**——要让生产 real 模式也闭环，三选一：
1. 调用方用 bypass 角色的服务账号；
2. 实现 `ApprovalPolicy`（如 `WebhookApprovalPolicy` / `TrustedAgentAutoApproval`）让受信 agent 自动过审；
3. 不走审批受控的 server action，直接在进程内调用 harness。

### B. 跨 run 记忆持久化（默认关闭）

`memory-store.ts` 提供 `VolatileMemoryStore`（默认，无持久化）、`FileMemoryStore`、`SqliteMemoryStore`。`harness` 仅在 `memory.hasPersistence` 为 true 时 `load/save`（harness.ts:195, 435）。
- 默认 `MEMORY_BACKEND` 未配 → **volatile → 每次 run 从空白开始**，智能体"学不会"历史（跨 run 不闭环）。
- 设 `MEMORY_BACKEND=sqlite`（或多副本挂 RWX 卷用 `file`）→ 长期记忆自动跨 run/重启保留，闭环成立。
- 多副本横向扩展：sqlite 在网络 FS 上文件锁不可靠，需 RWX 共享卷 + file 后端（见项目记忆）。

### C. Shell 工具确认（仅当显式开启）

`SHELL_REQUIRE_CONFIRM=true` 时，shell 内置工具每执行一次需 `POST /api/shell/approve` 人工批准（shell-approval.ts、runner.ts:222-235）。
- 仅影响 `shell` 内置工具；**行业智能体通常用 MCP 工具而非 shell**，故不受此影响。是可 deliberated 的安全开关，非默认阻断。

### D. 自检门禁 verify（可选，未配则无质量闭环）

`harness.ts:394-432` 的 `verify` 是**可选**。未注入 `Verifier` 时，智能体产出即返回，无自动质量校验。
- 要让闭环"产出可信"，需在 AgentCard/assemble 阶段注入一个 `Verifier`（按领域规则打分），未过则自动重跑（自愈）。

### E. 外部系统"最后一公里"动作

智能体可推理并调用工具，但若行业任务要**对外系统落动作**（如提交贷款、写入 HIS 病历、推送教育平台），这些靠 AgentCard 挂载的 **MCP 工具**实现；闭环在"动作层"的完成度 = 你提供的领域 MCP 工具是否齐全、幂等、无需人工二次确认。harness 默认不对 MCP 工具加人工闸门。

---

## 五、让"完全闭环"在生产成立的改造清单

| 项 | 现状 | 改造 |
|---|---|---|
| 1. real 模式自动过审 | 受 `agent:run:real` 审批闸门 | 引入 `TrustedAgentAutoApproval` 策略（白名单 agentId/domain 自动放行），不改其余代码 |
| 2. 跨 run 记忆 | 默认 volatile | 部署设 `MEMORY_BACKEND=sqlite`（或 RWX+file）；多副本走共享卷 |
| 3. 产出质量闭环 | verify 可选 | 每个行业 AgentCard 注入领域 `Verifier` |
| 4. 注册表持久化 | `AgentRegistry` 内存态，重启丢 | 换持久化存储（复用 memory-store 接口）或启动期从配置/DB 重注册；补 `POST /api/agents` 运行时注册 |
| 5. 工作流检查点持久化 | 默认 Volatile | 注入持久化 `WorkflowStore` |
| 6. 横向扩展记忆共享 | sqlite 网络 FS 不稳 | RWX PVC + file 后端；或按 tenant 分片 |

---

## 六、一个行业智能体闭环的最小配置示例（金融）

```ts
// 1) 注册一个金融领域 AgentCard（启动期，或经 A2A 自注册 / 未来 POST /api/agents）
registry.register(makeDefaultAgentCard({
  id: 'finance-agent',
  domain: 'finance',
  transport: 'local',
  assembly: { mcpServers: ['finance-tools'], skills: ['finance-compliance'], systemPrompt: '你是合规金融顾问…' },
}));

// 2) 部署时设环境变量（让跨 run 记忆 + 出网管控生效）
//    MEMORY_BACKEND=sqlite  MEMORY_SQLITE_FILE=/data/memory.db
//    GUARDRAIL_PII=true      （金融画像已内置 denylist:* 禁出网）

// 3) 提交任务（mock 模式天然闭环；real 模式需审批旁路/自动过审策略）
POST /api/run  { domain:'finance', input:'帮我评估客户 A 的风险敞口', tenantId:'t1' }
//   → run-queue 解析 domain → assembleAgent(finance-card) → harness.run()
//   → 全程自动：护栏/记忆/工具/自检/脱敏 → 返回结果
```

**判定**：上述路径在**当前代码**下已端到端打通（路由 resolveTask、assembleAgent、harness 主循环、policyEngine 金融画像均已实装并接进 server）。闭环成立的前置仅是你把第 1 步的卡片注册好、把第 2 步的记忆后端打开、并对 real 模式配好审批放行策略。

---

## 附：与前一份评估的关系

`./platform-orchestration-assessment.md`（上午写）在基座能力落地前判定"注册/路由/隔离/协议/编排缺失/部分具备"——**已过时**。本分析基于的这些能力（`agents/registry`、`router/`、`policy/engine`、`tenant.ts`、`a2a/`、`workflow/`、`guardrails` 出网+隔离）现已全部实现并接入 server 运行链路，故单智能体闭环在架构层已具备。剩余项是**生产加固（持久化、审批自动化、注册表持久化）**，非重写。
