# 模块依赖图

> 配套图：`diagrams/module-dependency.svg`
> 范围：`@agent-harness/core` 内部模块分组 + 包级依赖

## 1. 包级依赖

```
server ──▶ core
webapp ──▶ client ──▶ server(/api/v1)
cli     ──▶ client
examples ──▶ core
```

构建拓扑：`core → client → server → webapp / cli → examples`。
跨包解析：构建期 tsconfig `paths` 指向兄弟包 `dist/index.d.ts`；运行期靠 pnpm workspace 软链 + 各包 `main`/`types`/`exports` 字段。

## 2. core 内部模块分组

### 编排层（顶层）
- **`harness.ts`** — `AgentHarness` + `run()` 主循环。依赖：`types, tools, memory, guardrails, telemetry, llm/pricing`。
- **`index.ts`** — barrel，统一再导出全部 public API。

### 基础层（leaf，无内部依赖）
- **`types.ts`** — 核心契约（`LLM` / `Message` / `ToolCall` / `ToolSchema` / `LLMResponse` / `TokenUsage` / `LLMCallOptions`）。几乎所有模块都依赖它（契约基座）。
- **`guardrails.ts`** — 输入/输出/工具参数三层护栏 + PII 脱敏。
- **`telemetry.ts`** — OTel 可选追踪/指标；`withSpan` 在无 Collector 时降级为内存快照。
- **`loadEnv.ts`** — 零依赖 `.env` 加载器。
- **`memory-store.ts`** — `MemoryStore` 接口 + `Volatile`/`File`/`Sqlite` 实现。
- **`integrations/env-platform.types.ts`** — `EnvPlatform` 共享契约类型。
- **`llm/pricing.ts`** — 单价表 / `estimateCost` / 模型价格注册。

### 中间层
- **`tools.ts`** — `ToolRegistry`（register/schemas/has/call/unregister/mergeFrom）。依赖 `types`。
- **`memory.ts`** — `Memory` 运行时（窗口 / 长期笔记 / 摘要器 `MemorySummarizer` / load·save·clear）。依赖 `types, memory-store`。
- **`llm/shared.ts`** — `toOpenAIMessage` / `callOpenAIChat` / `safeParseArgs`（共用请求与解析）。依赖 `types`。

### 适配器 / 能力层
- **`llm/openrouter.ts`** — 默认 LLM 适配器。依赖 `types, shared`。
- **`llm/openai.ts`** — OpenAI / Azure / vLLM 适配器。依赖 `types, shared`。
- **`llm/failover.ts`** — 熔断器（primary OpenRouter + secondary OpenAI）。依赖 `types, telemetry`。
- **`builtins/*`** — 内置工具（filesystem / webfetch / datetime / calculator / shell），统一 `builtin__` 前缀。依赖 `tools`。
- **`skills/*`** — `SkillRegistry` + `builtin__use_skill` 元工具 + 触发词预激活。依赖 `tools`。
- **`integrations/*`**：
  - `harness-client.ts` — Harness NG 流水线客户端（dry-run 无 key）。依赖 `harness-client.types, env-platform`。
  - `harness-tools.ts` — 把「拉起/销毁环境」注册成 agent 工具。依赖 `tools, env-platform`。
  - `env-platform.ts` — `EnvPlatform` 接口 + `createEnvPlatform()` 工厂（harness / local / k8s）。依赖 `env-platform.types, harness-client, local-env-platform, k8s-env-platform`。
  - `local-env-platform.ts` / `k8s-env-platform.ts` — 零依赖 / K8s 后端。依赖 `env-platform.types, env-platform`。
  - `mcp/placeholder.ts` — MCP 连接管理器（注册/连接/重连/断开）。依赖 `tools, telemetry` + `@modelcontextprotocol/sdk`（外部硬依赖）。
  - `mcp/presets.ts` — MCP 预设目录（Context7/GitHub/…）。仅类型依赖 `placeholder`。

## 3. 依赖边（要点）

- 几乎全部模块 → `types.ts`（契约基座）。
- `harness` → `tools, memory, guardrails, telemetry, llm/pricing`（编排核心）。
- `builtins/*` / `skills/*` → `tools`（注册进同一 `ToolRegistry`）。
- `integrations/*` → `tools` + `telemetry`（MCP 重连计入指标）+ `env-platform.types`。
- `memory` → `memory-store` → `types`。
- `llm/failover` → `telemetry`（熔断计数）。
- **leaf 模块**（无内部依赖）：`types, guardrails, telemetry, loadEnv, memory-store, env-platform.types, llm/pricing`。

## 4. server 业务层模块（核心零耦合）

`packages/server/src` 在核心之上叠加纯业务能力，均通过「接口 + 默认实现 + 组合工厂」存在，核心不感知：

| 模块 | 职责 |
|---|---|
| `server.ts` | 组合根 / HTTP+SSE 路由 / 优雅停机 |
| `runner.ts` | 按模式（mock/real/real-mcp）组装 agent |
| `run-queue.ts` + `queue-backend.ts` | 运行队列（Memory/File/Redis 后端） |
| `mcp-manager.ts` | 多 MCP server 单例（共享注册表） |
| `env-pipeline.ts` | 环境生命周期状态机 |
| `authz.ts` / `sso.ts` | RBAC + 身份源（token/oidc/proxy） |
| `approval.ts` | 审批工作流（gate + re-submit） |
| `eval.ts` | RunRecord 还原 + 可插拔评估器 |
| `retention.ts` / `openapi.ts` | 留存/出境策略 + OpenAPI 契约 |
| `secrets.ts` | 密钥装配（env > SECRETS_FILE > .env） |
| `verification.ts` | 三大能力自验证（流式事件） |

> 原则：**业务策略（鉴权/审批/评估/版本化/合规）全部在 server 业务层，核心 `@agent-harness/core` 始终零业务耦合、可插拔、可组合。**
