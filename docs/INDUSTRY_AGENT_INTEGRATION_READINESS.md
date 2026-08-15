# 行业智能体对接就绪度分析（当前架构实测）

> 结论先行：**现在就能对接行业智能体并让它真正干活**。基座平台的核心能力（注册发现、任务路由、跨行业隔离、A2A 协议、工作流编排）在当前代码中均已实现并接入运行链路，不再只是 P0/P1 规划。
>
> ⚠️ 校正说明：本仓库 `docs/AGENT_ORCHESTRATION_PLATFORM_ASSESSMENT.md`（2026-08-15 上午产出）的"现状/差距"评级已**过时**——当时代码里 `agents/`、`router/`、`tenant.ts`、`policy/`、`a2a/`、`workflow/`、`plugin/`、`sandbox/`、`quota/`、`audit.ts` 等子系统尚未存在或未被接入。本文基于**当前真实代码**重做判定。

---

## 一、实测：五大基座能力的当前状态

| 核心能力 | 当前状态 | 落地证据 |
|---|---|---|
| ① 智能体注册与发现 | **已实现** | `packages/core/src/agents/registry.ts`（`AgentRegistry` + 倒排索引 + 心跳 sweep）；`server.ts` 暴露 `GET /api/agents?domain=&capability=` 与 `GET /api/agents/:id` |
| ② 任务路由与分发 | **已实现且已接线** | `packages/core/src/router/{router,selector,intent}.ts`；`run-queue.ts` 的 `execute()` 第 458 行调用 `resolveTask()` 解析目标 AgentCard，再 `assembleAgent(card)` 收敛为领域 harness |
| ③ 跨行业上下文隔离与数据安全 | **已实现（按租户 opt-in）** | `packages/core/src/tenant.ts`（`tenant::session` 复合记忆 key）；`policy/engine.ts` 内置 medical-aesthetics/healthcare/finance/education 行业画像（PII 脱敏、金融 `denylist:*` 禁出网、OS 级隔离）；`runner.ts` 注入 `guardrailPolicy` |
| ④ 统一通信协议与接口规范 | **已实现（A2A + MCP 双层）** | `packages/core/src/a2a/{types,transport}.ts`（TaskEnvelope/TaskResult + HttpA2ATransport）；`server.ts` 的 `POST /api/a2a/tasks` 接收远端 agent 任务；MCP 工具级接入经 `<server>__<tool>` 前缀 |
| ⑤ 工作流编排与状态监控 | **已实现** | `packages/core/src/workflow/{engine,types}.ts` + `server.ts` 的 `POST /api/workflows`（DAG + 补偿 + SSE 直播每 step 状态） |

---

## 二、现在对接行业智能体的三种具体路径

平台已支持三种 transport（`agents/types.ts` 的 `AgentTransport = 'local' | 'mcp' | 'a2a'`），覆盖"自带 agent / 远端异构 agent / 工具型 agent"三类场景。

### 路径 A：本地行业智能体（`transport: 'local'`）—— 最常用
把一个领域 agent 收敛为"只挂该行业工具/技能/系统提示词"的领域 harness。

1. 注册 AgentCard（启动期代码或配置引导，`getAgentRegistry().register(card)`）：
   ```ts
   {
     id: 'finance-agent', domain: 'finance', transport: 'local',
     capabilities: [{ id: 'finance-lookup' }, { id: 'compliance-check' }],
     assembly: {
       mcpServers: ['finance-mcp'],          // 只合并金融 MCP（按 server 名/前缀匹配）
       skills: ['finance-skill'],            // 只启用金融技能
       systemPrompt: '你是持牌金融顾问，严守合规与不出境约束。'
     }
   }
   ```
2. 接入该行业 MCP（工具级能力）：`POST /api/mcp/add` 或在 `MCP_SERVERS` 环境变量声明，其工具以 `finance-mcp__xxx` 前缀入注册表。
3. 触发：`POST /api/run { domain:'finance', prompt:'查这只基金净值' }`
   → `run-queue.execute` 调 `resolveTask({domain:'finance'})` → 命中 `finance-agent` → `assembleAgent(card)` 按 `assembly` 收窄工具面 → `harness.run` 实跑。
   （`runner.ts` 第 211–263 行、`assembleAgent` 第 191 行 `card?: AgentCard` 参数均已打通。）

### 路径 B：远端异构行业智能体（`transport: 'a2a'` + `endpoint`）—— 跨主机/跨团队
把另一台主机上独立部署的 agent 作为"被调度节点"接入，无需把它的代码合进本仓库。

1. 注册 AgentCard：`{ id:'remote-med-agent', domain:'medical-aesthetics', transport:'a2a', endpoint:'https://med-agent.internal' }`。
2. 触发：`POST /api/run { domain:'medical-aesthetics' }`
   → 路由选中 `remote-med-agent` → `run-queue.ts` 第 513 行检测到 `transport==='a2a' && endpoint` → `HttpA2ATransport.send()` 把 `TaskEnvelope` 投递到远端 `POST /api/a2a/tasks` → 取回 `TaskResult` 作为本轮输出；**派发失败自动降级回退本地 default harness**（第 553 行）。

### 路径 C：工具型行业能力（`transport: 'mcp'`）—— 最轻量
行业能力只暴露为 MCP 工具（如医美知识库、金融行情），挂到通用（或某领域）harness 上由 LLM 按需调用。机制同 `examples/multi-mcp.ts`：`connectMcpServers()` 顺序接入、单服务失败不影响其余、工具按 `<server>__<tool>` 前缀避免冲突、护栏/记忆/追踪自动覆盖。

---

## 三、端到端闭环示例（金融 agent）

```
客户端 → POST /api/run { domain:'finance', tenantId:'t-fin', prompt:'查基金净值' }
  └─ server.ts handleRun：guard(RBAC) → runQueue.submit(agentId=?,domain,tenantId)
       └─ run-queue.execute：
            resolveTask() → IntentRouter 分类(finance) + AgentSelector 打分 → finance-agent
            resolveTenantContext({tenantId:'t-fin'}) → 复合记忆 key 't-fin::<session>'
            policyEngine.getPolicy('t-fin') → 若已 applyIndustryProfile 则注入金融禁出网+强脱敏
            resolveIsolationBackend() → finance 画像强制 'os' 级隔离
            assembleAgent(card=finance-agent, tenantCtx, sandboxBackend) → 仅挂 finance-mcp 工具
            harness.run(prompt) → 经 finance-mcp__xxx 工具取数 → 输出
```

整条链路在当前代码中**可运行**（mock LLM 离线可验证，真实 LLM 需 `OPENROUTER_API_KEY`）。

---

## 四、投产前仍需注意的真实差距（不是"能不能"，是"稳不稳"）

以下不是阻断项，但决定"对接一个行业 demo"与"多行业生产平台"的距离：

1. **Agent 注册表是内存态**（`VolatileAgentStore`）。重启即丢、多副本不共享。要跨实例一致需实现分布式 `AgentStore`（Redis 后端，接口已预留于 `agents/store.ts`）。单实例 + 启动期注册可先跑。
2. **缺少"运行时注册 agent"的 REST 端点**。当前 `server.ts` 仅 `GET /api/agents`，没有 `POST`。新增行业 agent 需在**启动期代码/配置引导**注册，或走 A2A 自注册（仅能注册 remote 卡片）。平台化（租户自助上架 agent）前建议补 `POST /api/agents`。
3. **跨行业数据隔离是 opt-in，不是默认生效**。租户隔离 + 行业合规画像只在 `tenantId` 传入且已 `policyEngine.applyIndustryProfile(tenantId, domain)` 后才生效；不配置则全部落在 `default` 通用策略与 `default` 通用 agent。多行业混跑**必须先做租户开通 + 画像绑定**，否则医疗 PII 与金融数据会走同一默认通道。
4. **意图路由默认是关键词规则引擎**（`INTENT_ROUTER=rule`）。歧义 prompt 可能回落 `default`。生产建议设 `INTENT_ROUTER=llm`（需 API key，失败自动回退 rule）。
5. **OS/容器隔离后端成熟度需实测**。路由已按画像强制 `isolation:'os'`，但真实隔离能力取决于 `sandbox/` 执行器与 `SANDBOX_BACKEND` 配置是否真正落地容器；未落实则"强制 OS 隔离"只是声明。
6. **A2A 接收端只执行 local agent**（设计如此，防跨主机语义混淆）；远端 agent 经 `HttpA2ATransport` 派发，需带 RBAC 令牌（`a2a:receive` 动作）。

---

## 五、建议的推进顺序

- **今天就能做**：选 1 个行业（如金融/医美），按路径 A 注册 AgentCard + 接 MCP + 用 `domain` 触发，离线 mock 验证闭环。
- **本周可做**：补 `POST /api/agents` 注册端点；为试点租户 `applyIndustryProfile` 绑定合规基线；把 `AgentRegistry` 换 Redis 后端以支持多副本。
- **本月可做**：`INTENT_ROUTER=llm` 提路由精度；验证 `sandbox/` OS/容器隔离；用 `POST /api/workflows` 串起"金融→医美"跨 agent DAG 做协同验证。

> 一句话：架构层面**已经具备对接行业智能体的基座能力**，无需重写；剩余工作是"把内存态/opt-in 变成生产级持久化与默认安全"，以及补一个 agent 注册 REST 端点。
