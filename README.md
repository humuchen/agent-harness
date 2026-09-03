# agent-harness

一个**最小化、可直接运行**的 AI Agent harness 骨架：工具调用循环、短期/长期记忆、三层护栏、可选的 OpenTelemetry 追踪；在此之上已长出**多智能体基座子系统**（智能体注册/发现、能力感知路由、租户隔离、策略/配额、工作流编排、A2A、插件框架、OS 级沙箱、子智能体、团队），并通过 `access/server` 接入层叠加**账户密码登录 / OpenRouter OAuth / BYOK / 插件市场 / 多会话 Chat** 等纯业务能力，配套 `plugins/` 下的业务插件（智能客服 / 医美客资 / 备忘）与独立的 RAG 服务。

> 📚 完整文档（架构图 / 执行流 / 模块依赖 / 部署 / MCP 服务 / 多实例 Runbook）已统一整理至 **[`docs/`](./docs/README.md)**。本文件为仓库入口。

## 设计原则

- **单一可替换契约**：任何 LLM 后端只要实现 `LLM` 类型即可接入
  `（messages, toolSchemas) => Promise<{ content, tool_calls }>`。
- **零硬运行时依赖**：只用 Node 内置 API。OpenTelemetry 是可选的，
  没装就自动降级为 no-op。
- **工具错误即自愈**：工具抛错会作为 tool result 回灌模型，模型可重试或换路。
- **护栏先行**：输入 / 输出 / 工具参数三层检查，默认拦截密钥与超长输入。

## 目录结构（pnpm monorepo）

```
agent-harness/                # 根：private 包 + pnpm workspace
├─ frontend/                  # 前端应用层
│  ├─ webapp/                 # @agent-harness/webapp —— Vite+Lit SPA 前端面板（消费 /api/v1，断网可用）
│  └─ cli/                    # @agent-harness/cli —— 零依赖 CLI 客户端（消费 /api/v1）
├─ access/                    # 接入层（路由 / 鉴权 / 运行队列 / 会话 / OAuth / 账户 / 插件扩展）
│  └─ server/                 # @agent-harness/server —— HTTP+SSE 服务 / 仪表盘（依赖 core，约 45 个源文件）
├─ backend/                   # 后端工具层
│  ├─ core/                   # @agent-harness/core —— 框架库（零运行时依赖，含多智能体基座子系统）
│  ├─ client/                 # @agent-harness/client —— 跨运行时 typed HTTP 客户端（Web/Node/Edge）
│  └─ medical-ad-guard/       # @agent-harness/medical-ad-guard —— 医疗广告合规护栏（可复用领域库）
├─ plugins/                   # 业务插件（core/server/webapp 零业务耦合，业务语义 100% 留此）
│  ├─ customer-service/       # @agent-harness/customer-service —— 智能客服 Agent（会话/工单/KB/订单/转人工，SQLite）
│  ├─ medical-aesthetics-lead/ # @agent-harness/medical-aesthetics-lead —— 医美客资 Agent（获客/初筛/预约/留资，SQLite+外部RAG）
│  └─ memo/                   # @agent-harness/memo —— 备忘助手（笔记/提醒，SQLite，按 owner 隔离）
├─ services/                  # 外部集成 / 底座（独立部署）
│  └─ rag/                    # @agent-harness/rag-service —— RAG 服务（默认 HTTP，可选 MCP stdio，零运行时依赖）
├─ examples/                  # @agent-harness/examples —— CLI 示例（消费 core）
├─ skills/                    # 顶层 Skill 文档包（非 npm 包）：ah-platform-evolution / ui-design-conventions
├─ docs/                      # 完整文档（架构 / 部署 / 插件 / Agent 设计 / 分析）
├─ migrations/                # SQL 迁移（由 core db-adapter 驱动）
├─ scripts/                   # 运维脚本（备份 / 留存清理 / 回滚演练 / 负载 / 原生沙箱构建…）
├─ data/                      # 运行期数据（SQLite / 向量库，gitignore）
├─ deploy/                    # k8s（kustomize）/ docker 部署清单
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ package.json
├─ Dockerfile / docker-compose*.yml  # 自托管交付物（含 --profile redis 多副本队列）
└─ render.yaml                # Render 部署 Blueprint（部署 access/server）
```

## 业务插件（Plugins）

业务语义 100% 留在 `plugins/`，`core/server/webapp` 三层始终零业务耦合。插件经 `access/server/src/plugin-bootstrap.ts`
自动扫描 `plugins/` 目录加载（或 `AGENT_PLUGINS` 显式覆盖），每个插件以 `PluginManifest → AgentCard` 注册进
`AgentRegistry`，并通过 `PluginContext` 调用 core 公开 API（不得修改 core 源码）。当前三个插件：

| 插件 | 包名 | 作用 | 存储 |
| --- | --- | --- | --- |
| `customer-service` | `@agent-harness/customer-service` | 智能客服 Agent：会话接待 / 知识库问答 / 工单 / 订单售后查询 / 转人工 | SQLite（会话/工单/KB） |
| `medical-aesthetics-lead` | `@agent-harness/medical-aesthetics-lead` | 医美客资 Agent：多渠道获客 / 需求初筛 / 项目咨询 / 留资 / 预约到店 / 转人工，含医疗广告合规护栏 | SQLite + 外部 RAG |
| `memo` | `@agent-harness/memo` | 备忘助手：笔记记录 / 检索 / 删除 + 到点主动提醒（技能落地执行样例） | SQLite（按 owner 隔离） |

插件开发脚手架：`pnpm create:plugin`。插件架构与生命周期详见 [`docs/03-plugins/agent-plugin-er.md`](./docs/03-plugins/agent-plugin-er.md)。

## 快速开始

```bash
# 安装 dev 依赖（仅 typescript，用于编译）
pnpm install

# 编译并运行示例
pnpm --filter @agent-harness/examples run dev
# 或：先 build 再 start
pnpm -r build
```

预期输出：

```
>> 帮我算一下 3 加 5 是多少
<< 你说了：{"sum":8}（这是 mock 回复）

>> 我的 AKIA1234567890ABCDEF 密码别泄露
<< [guardrail] blocked: possible secret in input

>> 随便说点什么
<< 你说了：随便说点什么（这是 mock 回复）
```

> 说明：`add` 工具被触发并返回 `{"sum":8}`，结果作为 tool message 回灌模型；
> 由于 mock LLM 不做二次理解，最终由兜底分支原样回显工具结果。换成真实
> LLM（见下）后，模型会读取工具结果并生成正确总结（如「结果是 8」）。
> 含密钥的输入则在入口被护栏直接拦截。

要看到真实的「模型读完工具结果再总结」效果，接入真实 LLM 即可。

## 接入真实 LLM

默认内置 **OpenRouter** 适配器（`src/llm/openrouter.ts`，基于原生 `fetch`、**零额外依赖**，
实现与 OpenAI 相同的 Chat Completions 契约，但默认指向 `https://openrouter.ai/api/v1`
并带上 OpenRouter 推荐的 `HTTP-Referer` / `X-Title` 头）。OpenRouter 让你用一个 key 调
通几乎所有主流模型（OpenAI / Anthropic / Google / 国产模型等）：

```ts
import { AgentHarness, createOpenRouterLLM } from '@agent-harness/core';

// 读 OPEN_API_KEY / OPEN_MODEL / OPEN_BASE_URL
const llm = createOpenRouterLLM();
const agent = new AgentHarness({ llm, tools });
```

- 模型用 provider-prefixed slug：`openai/gpt-4o-mini`、`anthropic/claude-3.5-sonnet`…
- 还支持 OpenRouter 的 `models` 兜底数组：`createOpenRouterLLM({ models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'] })`
- 弱/免费模型偶尔返回空响应，`createOpenRouterLLM({ retries: 2 })`（默认即 2）会在无文本且无工具调用时自动重试，提升 demo 稳定性。
- 若你只用 OpenAI / Azure / 本地 vLLM，仍可用 `createOpenAILLM()`（`src/llm/openai.ts`）。

设置环境变量即可（见 `.env.example`）；不填 `OPEN_API_KEY` 时示例会
自动退回内置 mock LLM，保证零配置可运行。

## 自助环境治理闭环（可插拔 EnvPlatform）

把 agent 接入一个**可替换的环境平台后端**，让它自助拉起 / 销毁临时或预览环境。
核心只依赖 `EnvPlatform` 接口（`backend/core/src/integrations/env-platform.ts`），
具体后端由 `ENV_PLATFORM` 选择——**后端可换、主循环零改动**：

| 后端 (`ENV_PLATFORM`) | 说明                                                                                                                      | 依赖                                                 | 是否真建环境                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `harness`（默认）     | Harness NG Pipeline 客户端，把"我要环境/拆掉它"映射为 `provision-environment` / `destroy-ephemeral` 流水线触发 + 状态轮询 | 零依赖                                               | 无 `HARNESS_API_KEY` 时 **dry-run**（只打印将发出的 API 调用），填 key 后真建 |
| `local`               | **零依赖本地后端**：真正起一个 `node:http` 预览服务（按 envId 分配端口 + TTL 自动销毁）                                   | 零依赖                                               | 是，开箱即真实可跑（适合本地验证 / 小团队 / 演示）                            |
| `k8s`                 | Kubernetes 后端：把分支部署成真实 Deployment/Service/可选 Ingress，轮询就绪                                               | 可选依赖 `@kubernetes/client-node` + 可用 kubeconfig | 是，生产级（企业落地推荐）                                                    |

- `EnvPlatform` 契约（`env-platform.ts`）：`createEphemeralEnvironment` / `destroyEnvironment` /
  `*WithEvents`（流式状态机供 UI 可视化）/ `getStatus`。`createEnvPlatform()` 按
  `ENV_PLATFORM` 装配；默认 `harness` 保持历史零凭据 dry-run 行为。
- `HarnessClient`（`harness-client.ts`）现在是 `EnvPlatform` 的默认实现：状态字段路径可配置
  （`statusPath` 默认 `pipelineExecution.summary.status`、`doneStatuses`、`successStatuses`），
  设 `HARNESS_DEBUG=1` 打印原始 trigger/status 响应以便对齐你的实例。
- `LocalEnvPlatform`（`local-env-platform.ts`）：每个 env 独立目录 `ENV_LOCAL_ROOT/<envId>`
  - 一张预览页；`ENV_LOCAL_HOST`（默认 `localhost`）决定暴露的 URL；`ttlHours` 到期自动销毁。
    闭环真实可跑——`create` 拿到可访问 URL、用户可打开、`destroy` 后 URL 下线。
- `KubernetesEnvPlatform`（`k8s-env-platform.ts`）：镜像来自 `K8S_IMAGE`（或 `create` 工具传入
  `image`），资源名 `K8S_NAME_PREFIX+envId`；设 `K8S_INGRESS_HOST_TEMPLATE` 才建 Ingress（否则返回
  集群内 Service DNS）。依赖缺失或无可用的 kubeconfig 时**构造即抛清晰错误**，不静默降级。
- `src/integrations/harness-tools.ts` — 把"拉起/销毁"注册成 agent 工具
  `create_ephemeral_environment` / `destroy_environment`（参数类型已放宽为 `EnvPlatform`）。
- 示例：
  - `examples/self-serve-env.ts` — `pnpm --filter @agent-harness/examples run demo:env`
  - `examples/real-loop.ts` — `pnpm --filter @agent-harness/examples run real-loop`：真实两轮对话闭环（拉起 → 销毁）
  - `examples/chat.ts` — `pnpm --filter @agent-harness/examples run chat`：单轮真实对话（需 `OPEN_API_KEY`）

```bash
# 零凭据演示（harness dry-run，打印将发出的 Harness API 调用）
pnpm --filter @agent-harness/examples run demo:env

# 本地后端：真正起预览服务，无需任何外部平台（ENV_PLATFORM=local）
ENV_PLATFORM=local pnpm --filter @agent-harness/examples run demo:env

# 真实接入 Harness：在 .env 填入 HARNESS_API_KEY / ACCOUNT / ORG / PROJECT
# 真实接入 K8s：先 `pnpm --filter @agent-harness/core add -D @kubernetes/client-node` 并配置 KUBECONFIG，再 ENV_PLATFORM=k8s
```

> 设计要点：原 `harness-env-platform`（外部 Harness 账号里的两条 Pipeline）只是 `EnvPlatform`
> 的一个实现。**不绑定 Harness 也能把"自助环境"跑起来**——用 `local` 验证、用 `k8s` 上生产，
> 或把 `createEnvPlatform()` 工厂换成你自己的后端（实现 `EnvPlatform` 接口即可）。护栏对含密钥输入依旧在入口拦截。

## MCP 接入（已实现，配即激活）

`src/integrations/mcp/placeholder.ts` 已基于 `@modelcontextprotocol/sdk` 实现
**真实 MCP 客户端**，支持三种传输：

- 远程 **Streamable HTTP**（默认，URL 不以 `/sse` 结尾时自动选）
- 远程 **SSE**（在 `MCP_SERVERS` 条目显式设 `transportType: 'sse'`，或 URL 以 `/sse` 结尾时自动选）
- 本地 **stdio**（`MCP_COMMAND` + `MCP_ARGS`）

配置其一即可自动把 MCP 工具接进 `ToolRegistry`，护栏 / 记忆 / 追踪对它们
**自动生效**，无需改 harness 主循环。远程认证头通过 `MCP_HEADERS`
（`KEY=VALUE` 逗号分隔，如 `MCP_HEADERS=CONTEXT7_API_KEY=xxx`）注入。

### 已接入：Context7（库文档/代码片段 MCP）

首个真实 MCP 已接上 **Context7**（`https://mcp.context7.com/mcp`，Streamable HTTP，
基础使用免 key）。三种接入方式任选其一，**主循环零改动**：

1. **声明式（部署/重启常驻）** —— 在 `MCP_SERVERS` JSON 数组加一条（render.yaml / docker-compose / `.env` 同源键）：
   ```bash
   MCP_SERVERS='[{"name":"context7","serverUrl":"https://mcp.context7.com/mcp"}]'
   # 高配额才需要：在条目加 "headers":{"CONTEXT7_API_KEY":"你的key"}
   ```
2. **运行时动态添加** —— 通过 `POST /api/mcp/add`（body `{name,serverUrl,headers?}`）或 UI 面板的
   「添加 MCP」即时接入；也可从 `GET /api/mcp/presets` 预设市场（Context7 / GitHub / Composio 等）
   一键 `POST /api/mcp/preset` 接入。**注意：动态添加是内存态、不持久化，重启即清空**，常驻 server 仍建议走方式 1。
3. **stdio 本地服务** —— 同数组加 `{"name":"x","command":"npx","args":[...]}`。

它提供两个工具：`resolve-library-id`（把库名解析成 Context7 库 ID）和
`query-docs`（按库 ID + 问题拉取最新官方文档片段）。

```bash
pnpm --filter @agent-harness/examples run verify:context7   # 连真实端点、列工具、并实打实调一次 resolve-library-id
```

> 多 server 模型由 `parseMcpServersEnv()`（`backend/core/src/integrations/mcp/placeholder.ts`）统一解析：
> `MCP_SERVERS` 数组优先；旧的 `MCP_SERVER_URL` 单 server 快捷通道已废弃并移除。
> 接下来按同样方式逐步添加更多 MCP（往 `MCP_SERVERS` 加条目，或运行时 `/api/mcp/add`），主循环零改动。

### 连接可靠性：自动重连 + 健康探测

远端 MCP server 重启、网络抖动等导致的静默失败现已可自愈，无需重启 UI：

- **懒重连**：工具调用抛错时，自动重连一次并重试该调用，对运行中的 agent 透明。
- **健康探测**：后台周期 `ping`（或 `listTools` 兜底）远端，超时即判定失活并触发重连。
- **指数退避**：重连失败按 `基础 * 2^min(尝试,4)` 后台重试（封顶 16x），达 `MCP_RECONNECT_MAX` 后停止。
- **状态可见**：`/api/mcp/list` 与 UI 面板实时展示 `status`（含 `reconnecting`）/ `health`（健康·失活·未探测）/ `reconnectAttempts`；失活时面板出现「↻ 重连」按钮可手动触发（`POST /api/mcp/reconnect`）。
- **指标**：重连成功/失败、健康探测失败计入可观测性指标（`mcp.reconnect.success` / `mcp.reconnect.fail` / `mcp.health.fail`）。

可调环境变量：`MCP_RECONNECT`、`MCP_RECONNECT_MAX`、`MCP_RECONNECT_DELAY_MS`、`MCP_HEALTH_INTERVAL_MS`、`MCP_HEALTH_TIMEOUT_MS`（详见 `.env.example`）。
内存传输（测试）不可重连，仅保活不探测。

> 把「环境治理」与「Agent harness」串起来的关键：
> `harness-env-platform` 负责环境定义与流水线，
> `agent-harness-ts` 通过 Harness API 在对话中按需供给/回收环境，
> 两者仅通过流水线 identifier 与环境变量耦合，互不入侵。

## 内置基础工具（Built-in tools）

补齐「模型自身做不到」的基础能力——**零依赖、默认常开、自动被模型调用**。
所有内置工具以 `builtin__` 前缀注册进 `ToolRegistry`，与 MCP 工具（`<server>__` 前缀）
共用同一注册表，因此护栏 / 记忆 / 追踪对它们自动覆盖，主循环零改动。

| 工具                        | 能力         | 说明                                                                                                                                                                         |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtin__calculator`       | 精确数学求值 | 自研 tokenizer + shunting-yard + RPN，**绝不 `eval`**；支持 `+-*/%^`、括号、一元负号、常量 `pi/e`、函数 `sqrt/abs/floor/ceil/round/exp/ln/log/sin/cos/tan/pow/atan2/min/max` |
| `builtin__datetime_now`     | 当前时间     | 返回 ISO-8601 与指定 IANA 时区的可读时间                                                                                                                                     |
| `builtin__datetime_convert` | 时区转换     | ISO 时间戳在时区间转换                                                                                                                                                       |
| `builtin__datetime_add`     | 时间偏移     | 对时间加减 seconds…years（负数即减）                                                                                                                                         |
| `builtin__web_fetch`        | 抓取网页     | 仅允许 http/https，HTML 轻量清洗为文本，带超时与大小上限                                                                                                                     |
| `builtin__fs_read`          | 读文件       | UTF-8 文本读取（限 root 内）                                                                                                                                                 |
| `builtin__fs_list`          | 列目录       | 列出目录条目                                                                                                                                                                 |
| `builtin__fs_search`        | 搜文件       | 按文件名/内容在 root 内递归搜索                                                                                                                                              |

接入点：`registerBuiltinTools(registry, options)`（`backend/core/src/builtins`）。
UI 在 `assembleAgent` 中默认注册，可用环境变量关闭单项：
`BUILTINS_FS` / `BUILTINS_WEB` / `BUILTINS_CALC` / `BUILTINS_DT` 设为 `false`；
`HARNESS_FS_ROOT` 限定文件沙箱根目录（默认 `process.cwd()`）。

## 技能编排层（Skill）

在工具之上再包一层「**可组合能力**」：每个技能 = 一组工具 + 一段执行指引 + 触发词，
打包成模型可一键选用的复合能力。模型不必裸调工具，而是先激活技能、拿到工作流提示，
再使用其关联工具——从「能用工具」升级为「会办事」。

**落地方式（主循环零改动）**：技能层不修改 Agent 主循环，只做两件事——

1. 把「技能目录」注入系统提示词，让模型知道有哪些能力可用；
2. 提供一个元工具 `builtin__use_skill`，模型调用它传入技能 `id` 即取回执行指引。

此外，运行时按用户消息的**触发词自动预激活**对应技能（其指引直接并入当次系统提示词），
让模型在无需显式调用工具的情况下也按既定流程工作。

| 默认技能 id    | 关联工具                             | 触发词示例                            |
| -------------- | ------------------------------------ | ------------------------------------- |
| `web-research` | `builtin__web_fetch`                 | 搜索 / 查一下 / 最新 / 官网 / fetch   |
| `math`         | `builtin__calculator`                | 算 / 计算 / 多少 / 百分比 / calculate |
| `files`        | `builtin__fs_read`·`_list`·`_search` | 读文件 / 看文件 / 搜索文件 / file     |
| `current-time` | `builtin__datetime_*`                | 现在几点 / 时间 / 时区 / time         |

接入点（`backend/core/src/skills`）：

- `SkillRegistry` — 注册 / 查询 / 触发匹配（`matchTriggers`）/ 生成提示词（`describeForPrompt`）。
- `defaultSkills()` — 上述 4 个默认技能。
- `registerSkillTools(tools, registry)` — 注册 `builtin__use_skill` 元工具。
- `skillBoostPrompt(text, registry)` — 按触发词生成「自动启用技能」段落。
- UI 在 `assembleAgent` 中默认构建注册表、注册元工具，并把目录 + 触发预激活注入系统提示词；
  也支持自定义技能：在 `assembleAgent` 前 `skillRegistry.register({...})` 即可。

## 可视化验证 Playground（Web UI）

除了 CLI 示例，还提供了一个**零依赖的网页仪表盘**，把 Agent 闭环与三大验证
**可视化、可交互**地跑出来：

```bash
pnpm --filter @agent-harness/server run start            # 编译并启动，默认 http://localhost:4173 （可用 UI_PORT 改端口）
```

打开后你会看到三栏布局：

- **左栏**：当前模式的工具注册表（Tool Registry，按来源 `harness` / `mcp` 分组）
  - **MCP 服务面板**（每个已接 server 的状态灯、工具数、工具列表，并可填
    URL 实时「添加 MCP」）+ 三大验证（Agent 闭环 / Harness 轮询 / MCP 接入）
    的实时状态灯。
- **中栏**：Agent 闭环的**实时时间线**（每一步 LLM 调用、工具调用的参数与
  结果都流式出现）+ 同步的「记忆 / 对话」视图 + 顶部**环境流水线**视图。
- **右栏**：护栏拦截日志（输入 / 输出 / 工具参数被拦截时高亮）+ 原始事件流。

三种运行模式（顶部切换）+ 可选模型覆盖输入框：

- **Mock（离线）**：内置 mock LLM + Harness dry-run 工具，**无需任何密钥**
  即可可视化跑通「创建 → 销毁」闭环，最适合离线验证。
- **真实 LLM**：走 OpenRouter 真实模型（需 `OPEN_API_KEY`）。
- **真实 + Context7 MCP**：在真实 LLM 基础上接入已配置的 Context7 MCP，
  可视化看到 agent 自主调用远程 MCP 工具。

点「▶ 运行 Agent」开始一轮运行；点「✓ 运行验证」则把三大能力按流式事件
在左栏验证面板里逐个点亮 ✅ / ❌（与 `pnpm --filter @agent-harness/examples run verify:*` 同一套逻辑，只是
实时可视化）。环境流水线区可点「拉起环境 / 销毁环境」触发
`PENDING → PROVISIONING → RUNNING → READY` 状态机的可视化（无
`HARNESS_API_KEY` 时走 dry-run 演示同样的状态流转）。

实现要点：

- `access/server/src/server.ts` 仅用 `node:http` / `node:fs` / `node:path`，**零额外依赖**；
  通过 SSE（`text/event-stream`）把 `HarnessEvent`、验证事件、MCP/Env 事件推给前端。
  端点：`/api/run`（模式+提示词流式推 Agent 事件）、`/api/verify`（三大验证）、
  `/api/mcp/list`（列出已接 server）、`/api/mcp/add`（运行时新增 server）、
  `/api/env`（create/destroy 流式推状态机）、`/api/state`（全局状态快照）。
- `access/server/src/mcp-manager.ts`：多 MCP server 单例管理器，启动时按 `MCP_SERVERS`
  （JSON 数组，远程 URL / 本地 stdio 均支持）自动连接，并支持运行时通过 `/api/mcp/add`
  （或预设市场 `/api/mcp/preset`）逐步添加；每个 server 的工具以 `<server>__<tool>` 前缀注册，避免命名冲突。
- `src/server/env-pipeline.ts`：环境生命周期状态机，dry-run 下用定时器模拟真实
  Harness 流水线各阶段；有 `HARNESS_API_KEY` 时可切换为调用真实 `HarnessClient`
  轮询真实状态。
- `src/harness.ts` 新增可选 `onEvent` 回调（类型 `HarnessEvent`），在循环每一步
  发出事件，**不修改任何业务逻辑**，CLI 与测试完全不受影响。
- 前端由 `frontend/webapp`（Vite+Lit SPA）构建、`access/server` 同源托管，暗色主题，
  通过 `fetch` + `ReadableStream` 解析 SSE，断网可用。

## 自包含验证（无需真实凭据/服务）

三项核心能力都配了验证脚本：

```bash
pnpm --filter @agent-harness/examples run verify            # 依次跑 #2 Harness + #3 内存 MCP + #3 Context7（真实端点）
pnpm --filter @agent-harness/examples run verify:harness    # #2：用 Mock fetch 验证 Harness 轮询/终态映射
pnpm --filter @agent-harness/examples run verify:mcp        # #3：进程内起真实 MCP Server 验证接入链路
pnpm --filter @agent-harness/examples run verify:context7   # #3：连真实 Context7 端点，端到端验证（需联网）
pnpm --filter @agent-harness/examples run real-loop         # #1：真实 OpenRouter 两轮 create→destroy 闭环
```

- `examples/verify-harness.ts`：注入模拟 Harness 后端，覆盖 SUCCESS / FAILED
  两条终态路径，并验证自定义 `statusPath` 生效。
- `examples/verify-mcp.ts`：用 SDK `InMemoryTransport` 在进程内起 MCP Server，
  经 `registerMcpTools` 注入 transport，完整跑通「连接 →list→ 注册 → 调用」。
- `examples/verify-context7.ts`：连真实 Context7 端点，列工具并实调 `resolve-library-id`。
- `examples/real-loop.ts`：需 `OPEN_API_KEY`（见 `.env`）才走真实模型；
  MCP 接入为 best-effort——`registerMcpTools` 失败只告警不中断环境闭环。

## 接口鉴权（Web Playground）

Web UI 的写操作（`/api/run`、`/api/verify`、`/api/mcp/add`、`/api/env`、`/api/mcp/list`、…）
默认在 `REQUIRE_AUTH=false` 时开放。**部署到公网前务必启用鉴权**（见下方开关）。

鉴权密钥说明：
- `OPEN_API_KEY`：统一 LLM 密钥，主要作为模型调用凭证；在 `ADMIN_API_KEY` 未设置时，也兼作站点 admin 凭证（向后兼容）。
- `ADMIN_API_KEY`（推荐）：独立的站点 admin 密钥，与 LLM 密钥职责分离。生产部署务必显式设置，使二者解耦。
- `UI_TOKENS`：多用户静态令牌（`user:token` 列表），接入后按角色鉴权。

```bash
# 方式一：独立 admin 密钥（推荐，LLM 密钥与鉴权解耦）
ADMIN_API_KEY=your-admin-secret OPEN_API_KEY=your-llm-key node access/server/dist/server.js

# 方式二：复用 OPEN_API_KEY 作 admin（向后兼容，但双用途）
OPEN_API_KEY=your-key node access/server/dist/server.js
# 请求时：Authorization: Bearer <key>
```

- 前端：右上角「访问令牌」输入框填写 admin 密钥 / `UI_TOKENS` 中的某个 token，请求自动以
  `Authorization: Bearer <token>` 发送（不再依赖会泄露在日志/历史里的 `?token=`）。
  （`?token=` 仍保留为兼容写法，但建议迁移到 Bearer。）
- 未启用鉴权时服务照常启动，但会在日志给出开放模式告警；若监听在非本地回环地址，会额外输出高危告警。
- `/api/state`（供 Render 等 PaaS 健康检查）与静态页始终开放。

### 部署公网前的安全加固（必做）

除了令牌，还提供以下开箱即用开关（详见 `.env.example`）：

| 环境变量                              | 作用                                              | 默认           |
| ------------------------------------- | ------------------------------------------------- | -------------- |
| `ADMIN_API_KEY`                        | 站点 admin 密钥（推荐，与 LLM 密钥 OPEN_API_KEY 解耦）；未设则回退 OPEN_API_KEY | 空（回退 OPEN_API_KEY） |
| `UI_TOKENS`                           | 多用户静态令牌 `user:token,...`；设置后开启 RBAC 令牌鉴权 | 空（开放/降级） |
| `AUTH_PROVIDER`                       | 身份源：`token`（默认）/ `oidc` / `proxy` / `account` | `token` |
| `ACCOUNT_AUTH`                        | 账户密码身份源开关（on/off）；开则强制要求登录态   | `on` |
| `UI_CORS_ORIGIN`                      | 跨域白名单（逗号分隔）；留空=仅同源（不再回 `*`） | 空（仅同源）   |
| `MAX_BODY_BYTES`                      | 请求体上限，防大报文 DoS                          | 1048576（1MB） |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | 单 IP 限流（窗口内请求数）；≤0 关闭               | 120 / 60000    |
| `AUDIT_LOG`                           | 审计日志落盘路径；留空则仅输出 stdout（JSON 行）  | 空（stdout）   |

审计日志会记录 时间 / 方法 / 路径 / 客户端 IP / 是否鉴权 / 状态码，并对高危动作
（`agent.run`、`env.create`/`env.destroy`、`mcp.add`/`mcp.preset`、`shell.approve`）
写入**脱敏**后的关键参数；**绝不记录密钥、令牌或 MCP 认证头**。

### 内容安全护栏（guardrails）

三层防护（输入 / 输出 / 工具参数）已升级为可配置策略引擎，可通过环境变量或
`configureGuardrails()` 在运行时调整（详见 `.env.example`）：

| 环境变量                   | 作用                                   | 默认     |
| -------------------------- | -------------------------------------- | -------- |
| `GUARDRAIL_SENSITIVITY`    | 注入检测敏感度 `low`/`medium`/`high`   | `medium` |
| `GUARDRAIL_MAX_INPUT`      | 输入最大字符数，超过即拦截             | `20000`  |
| `GUARDRAIL_SECRET_SCAN`    | 是否扫描密钥类敏感串                   | `true`   |
| `GUARDRAIL_INJECTION_SCAN` | 是否做提示词注入检测                   | `true`   |
| `GUARDRAIL_PII`            | 是否在输出侧做 PII 脱敏                | `true`   |
| `GUARDRAIL_ALLOWLIST`      | 命中即跳过注入拦截的关键词（逗号分隔） | 空       |

> **误拦兜底**：若业务文本合理包含 `system prompt`、`jailbreak` 等注入特征词
> （如计划模式下「优化 system prompt」的任务描述），除代码层的结构化输出
> 弱信号豁免外，还可设 `GUARDRAIL_ALLOWLIST=system prompt,jailbreak`
> 让命中这些关键词的输入/输出跳过注入检测（归一化后子串匹配）。

关键能力：

- **归一化注入检测**：先去零宽字符、折叠空白、去标点后做子串匹配，对大小写变形、
  字符间插空格、`IGNORE␣ALL␣INSTRUCTIONS` 等常见绕过显著更鲁棒；
  并预留 `registerInjectionScorer()` 可接语义级分类模型。
- **输出侧 PII 脱敏**：`redactOutput()` 自动识别并打码邮箱、手机号、身份证、银行卡、
  IPv4、常见 API Key；模型最终返回内容在 harness 出口统一脱敏。
- 向后兼容：`checkInput`/`checkOutput`/`checkToolArgs`/`registerInputRule` 签名不变。

### 可观测性（telemetry）

- `telemetry.ts` 在 `withSpan` 基础上新增**进程内指标聚合**：token 用量、各阶段延迟、
  错误率、工具调用数、累计成本；可通过 `getMetricsSnapshot()` 拉取。
- 若进程中已安装 `@opentelemetry/api` 并注册了 Tracer/Meter，则自动发出 Span 与指标；
  也可调用 `bindOtelMeter(meter)` 把指标导出到真实 Collector。无 Collector 时退化为内存快照。
- Web Playground 暴露受保护的 `GET /api/metrics`（需 `UI_AUTH_TOKEN`），返回上述快照 JSON，
  可直接接入 Grafana / Prometheus。
- **统一错误日志与告警收口**：所有业务错误统一经 `logError(scope, err, fields)` 留结构化日志
  - 计数；`emitAlert(level, name, message, fields)` 在记录日志的同时，把错误/致命事件推送到
    可插拔的告警接收器（`setAlertSink`）。默认无接收器（仅本地日志）；可经环境变量装配：
  * `ALERT_WEBHOOK_URL`：把告警 JSON（`{level,name,message,fields,ts}`）POST 到 Webhook
    （Slack / 飞书 / 钉钉 入站 Webhook 或自研告警网关）；
  * `ALERT_LOG_PATH`：把告警以 JSON 逐行追加到文件，便于 Filebeat / Loki 采集。
  * 多个 sink 可同时启用；sink 异常被吞掉，绝不影响主流程。`/api/metrics` 含 `alerts`、
    `alerts.error`、`alerts.fatal` 等计数器。

### 运行队列与水平扩展（P1-8 架构解耦）

原先 `/api/run` 在 Web 进程内 `await harness.run()` 同步跑完整个 agent 循环，既无并发上限、
也无法横向扩展。现已把「一次 run」抽象为 Job，提交与执行彻底解耦：

- **提交即返回**：`POST /api/run` 立即入队并返回 `jobId`，真正的执行由 worker 池
  （并发上限 `RUN_CONCURRENCY`，默认 4）异步完成；超出并发的任务在队列中排队，
  worker 空闲时自动续跑。
- **事件重放 + 断线可恢复**：每个 Job 持有一个带上限（`RUN_QUEUE_BUFFER`，默认 500）
  的事件缓冲。SSE 订阅时**先重放已发生事件、再转发后续**；因此客户端中途断线可凭
  `jobId` 重新订阅续上，前端无感。前端 `realStream()` 已内置「最多 2 次」的自动重连
  （防重连风暴）。
- **运维可见**：受保护的 `GET /api/jobs` 返回排队/执行数与最近若干 Job 的脱敏概要；
  `/api/metrics` 也合并了队列快照（`queue` 字段）。
- **队列持久化（崩溃可恢复）**：提交意图默认在内存，进程重启会丢未完成任务；
  设 `RUN_QUEUE_BACKEND=file` 后，已提交但还没开始的任务会落盘到 JSONL
  （`RUN_QUEUE_FILE`，默认 `./data/queue/run-queue.jsonl`），进程崩溃 / 重启后**自动重放**，
  避免丢活（在飞任务因携带进程内状态不可恢复，客户端会自行重投）。零 npm 依赖。
- **可插拔后端（水平扩展已落地）**：持久化由 `QueueBackend` 接口
  （`access/server/src/queue-backend.ts`）抽象，内置 `MemoryQueueBackend` / `FileQueueBackend` /
  `RedisQueueBackend`。**Redis 后端已实装**，把「可插拔接口」变成真水平扩展：
  - 数据结构：`runq:pending` / `runq:processing` 双列表 + `runq:jobs` / `runq:claimedAt` 哈希。
  - **原子领取**：`claim()` 用 `LMOVE pending processing LEFT RIGHT` 原子迁移，多实例并发下
    同一任务只会被一个实例拿到——天然无重复执行，无需分布式锁。
  - **崩溃恢复**：领取时记录 `claimedAt`；实例崩溃后，其它实例周期性 `reclaimStale(QUEUE_LEASE_MS)`
    把超租约的 processing 任务迁回 pending 重新领取（`QUEUE_LEASE_MS` 默认 5 分钟）。
  - **跨实例 SSE**：执行实例经 `publishEvent` 把每个事件发到 `runq:events:<jobId>` 的 pub/sub
    通道，持有 SSE 订阅的任意实例 `subscribeEvents` 即可转发，提交/执行分处不同实例时事件不丢。
  - 多实例部署只需设 `REDIS_URL`（或 `RUN_QUEUE_BACKEND=redis`），`RunQueue` / handler / 前端协议
    均不变；`ioredis` 为可选依赖，缺失时自动降级 `memory` 并打印告警（保持「一切降级可用」）。
  - **部署提示**：多实例下建议负载均衡开启 **sticky session**（按连接把同一客户端的提交与 SSE
    固定到同一实例），以获得最低延迟与最顺滑的 SSE；即便实例崩溃，任务也会由其它实例
    领取重跑、客户端重连后续上。

### 会话 / 多租户记忆存储（P1-9 DB 化）

记忆的「存在哪」与「怎么用」已彻底解耦：运行时只认一个 `sessionKey`，后端负责按 key
隔离读写。内置三类 `MemoryStore`，均零 npm 依赖：

- **VolatileMemoryStore**（默认）：纯内存，无持久化，适合本地 / Mock。
- **FileMemoryStore**：按会话分桶的 JSON 文件目录（`MEMORY_DIR`，每个 `<key>.json` 一份），
  单节点落地零依赖；旧版单文件 `persistencePath` 模式仍向后兼容。
- **SqliteMemoryStore**：基于 Node 22+ 内置的 `node:sqlite`（无需任何 npm 包、无需启动 flag），
  多租户生产推荐；运行期 Node 不支持时自动回退到 File 并告警。

配置：设 `MEMORY_BACKEND=file|sqlite|volatile`（未配置默认 `sqlite`；配了 `MEMORY_DIR` 走 file；`volatile` 需显式指定，纯内存无持久化）。
隔离维度由调用方决定：前端 / API 携带 `x-session-id` 头或 `body.sessionId`，
记忆即按该 key 在所选后端隔离持久化；未带则归入 `anonymous`。

运维可见：受保护的 `GET /api/sessions` 列出所有已落盘会话 key 与后端类型；
`GET /api/memory?session=<key>` 查看长期笔记与窗口长度；
`DELETE /api/memory?session=<key>` 清空某会话记忆；`/api/metrics` 暴露 `memory.backend`。

> RBAC 角色权限与审批工作流已在下方落地；身份源（OIDC/LDAP）接入见 [`docs/deployment.md`](./docs/02-deployment/deployment-self-hosting.md) 第 7 节。

### RBAC 角色权限 + 审批工作流（P2-12，业务策略与核心隔离）

鉴权与审批是**纯业务层**能力（`access/server/src/authz.ts` + `approval.ts`），核心
`@agent-harness/core` 不感知任何角色 / 权限 / 票据概念 —— 这是刻意的分层：核心只提供
AgentHarness 等框架原语，所有「谁能做什么、要不要审批」都是业务策略，可插拔、可组合。

- **RBAC**：`Authorizer` 接口 + 默认 `RoleBasedAuthorizer`。角色 `admin / operator / viewer`，
  动作粒度到 `agent:run:real`、`env:create`、`mcp:add`、`memory:clear` 等（见 `.env.example`）。
  - 配置：`UI_TOKENS={"<token>":"admin",...}` 支持多令牌多角色；`UI_AUTH_TOKEN` 为兼容旧版单令牌
    （默认 `operator`）；`UI_ROLE_PERMISSIONS` 可覆盖角色-权限矩阵。
  - 统一准入网关 `guard()` = 鉴权 → 限流 → 角色授权；失败即 401/403/429，不污染业务逻辑。
- **审批工作流**：`ApprovalPolicy` 接口 + 默认 `InMemoryApprovalPolicy`（gate + re-submit 模型）。
  - 敏感动作（real 运行 / 环境创建销毁 / MCP 接入 / 记忆清空 / 验证 / shell 审批）被策略判定为需审批时，
    服务端创建工单并返回 **202 + `{ticketId}`**；审批人经 `POST /api/approvals/:id` 裁决后，原请求方
    携带 `approvalTicket` 重发同一请求即可执行（执行始终在同步调用内完成，无需挂等待回调）。
  - 可绕过审批的角色由 `UI_APPROVAL_BYPASS_ROLES`（默认 `admin`）控制；要接入外部审批系统
    （工单平台 / Slack / ITSM），只需替换 `createApprovalPolicy()` 工厂返回的 `ApprovalPolicy` 实现。
- **可插拔 / 可组合的关键约束点**：`createAuthorizer()` 与 `createApprovalPolicy()` 是两个组合工厂。
  身份源由 `AUTH_PROVIDER` 切换：`token`（静态令牌，默认）/ `oidc`（Bearer JWT，零依赖验签）/ `proxy`
  （LDAP/SSO 网关头注入）；OIDC/LDAP 与审批后端均**仅改这两个工厂，server 其余代码零改动**。

运维端点（均受 RBAC 保护）：

- `GET /api/roles`：当前权限矩阵概览（不含令牌明文）。
- `GET /api/approvals` / `GET|POST /api/approvals/:id`：工单列表 / 查看 / 裁决（approve|reject）。
- 前端 Playground 在令牌具备审批权限时显示「🛡 审批队列」面板，可一键批准 / 拒绝；
  提交敏感动作若进入审批，前端自动轮询并在批准后继续执行。

### 运行评估与配方版本化（P2-13，业务质量策略与核心隔离）

同样是**纯业务层**能力（`access/server/src/eval.ts`），核心不产出任何「评分 / 版本」概念：
核心只产出事件流，本模块负责把事件流还原为「运行配方快照（RunRecord）」再交给可替换的评估器。

- **RunRecord（运行配方快照）**：从运行队列累积的 harness 事件还原出 `prompt / model / tools / steps /
guardrailsBlocked / budgetExceeded / finalAnswer / tokens / cost`。这本身就是一次运行的「版本化配方」，
  天然支持回归比对（同一 recipe 多次跑，对比得分）。
- **Evaluator（可插拔评估器）**：`Evaluator` 接口 + 默认 `RuleBasedEvaluator`（可解释、零依赖）：
  护栏未被拦截、预算未超限、有非空最终回答为硬性通过项；再综合「是否调用工具 / 步骤数 / 成本」加权出 0~1 分。
  要接 **LLM-as-judge**，只需改 `createEvaluator()` 工厂返回实现了 `Evaluator` 的对象，**server 其余代码零改动**。
- **RecipeStore（配方版本化）**：`RecipeStore` 接口 + `VolatileRecipeStore`（内存）/ `FileRecipeStore`（按 `<id>.json`
  落盘，零依赖）。`createRecipeStore()` 按 `RECIPE_DIR` 选文件库，否则内存库。同样可替换为数据库实现。
- **端点（均受 RBAC 保护）**：
  - `POST /api/eval { jobId }`：服务端从 job 事件还原 RunRecord 并打分，返回 `{ record, result }`。
  - `POST /api/recipes { jobId, name }` 存为命名版本；`GET /api/recipes` 列表；`GET /api/recipes/:id` 查看。
- **前端**：运行面板新增「📊 评估」「💾 存配方」按钮；令牌具备权限时显示「📦 运行配方版本」面板。

### 数据留存/出境策略、版本化 API 与 OpenAPI（P2-14，业务合规层与核心隔离）

依旧是**纯业务层**能力（`access/server/src/retention.ts` + `openapi.ts`），核心不感知任何合规/契约概念：

- **留存与出境策略（RetentionPolicy）**：`RetentionPolicy` 接口 + `DefaultRetentionPolicy`。
  - 留存窗口按记录类型分化：`RETENTION_DAYS_AUDIT`(默认 90) / `RETENTION_DAYS_MEMORY`(默认 30) /
    `RETENTION_DAYS_RECIPE`(默认 365)，`<=0` 表示永久；超期记录在导出/聚合时剔除。
  - 出境/导出前 `scrubForExport()` 做 PII 脱敏（邮箱/手机号/身份证等替换为占位符），满足数据出境合规。
  - `createRetentionPolicy()` 组合工厂：要按数据主权区域差异化合规规则，**只改这一个工厂**。
- **版本化 API（/api/v1）**：所有 JSON/SSE 端点同时挂在稳定前缀 `/api/v1/*`
  （如 `/api/v1/metrics`、`/api/v1/run`、`/api/v1/approvals/{id}`），未带前缀的等价路径保留为
  向后兼容别名。服务端在路由入口把 `/api/v1/*` 重写为等价路径，**业务/前端零改造即可获得版本化契约**。
- **OpenAPI 契约**：`buildOpenApiSpec()` 在运行时拼装 OpenAPI 3.0 文档（覆盖全部版本化 JSON 端点，
  SSE 端点标注 `text/event-stream`），由 `GET /api/v1/openapi.json`（受 `policy:read` 保护）暴露，
  便于接入网关 / 客户端代码生成 / 合规审查。当前留存策略快照见 `GET /api/v1/retention`。

> 至此，原「企业落地 14 项缺口」已全部落地：安全加固（P0）→ 内容安全/可观测/MCP 可靠性/成本/
> 测试+SBOM/架构解耦/多租户记忆（P1）→ RBAC+审批/评估+版本化/留存+版本化 API（P2）。
> 贯穿原则：**业务策略（鉴权/审批/评估/版本化/合规）全部在 server 业务层以「接口 + 默认实现 + 组合工厂」
> 形式存在，核心 `@agent-harness/core` 始终零业务耦合、可插拔、可组合。**
>
> 另：**生产级交付物缺口已闭环**——新增 `Dockerfile` / `docker-compose.yml` / `deploy/k8s/`（kustomize）/ GHCR
> 镜像 CI（`.github/workflows/docker.yml`），可脱离 Render 自托管（多副本需 `REDIS_URL` 运行队列）。
> **企业身份源缺口也已闭环**：`AUTH_PROVIDER` 现支持 `token`（静态令牌，默认）/ `oidc`（Bearer JWT 资源服务器，
> 零依赖验签 RS*/PS*/ES*/HS*）/ `proxy`（LDAP/SSO 网关头注入，企业接入 LDAP 的最低成本路径），三者均可与静态令牌
> break-glass 逃生通道并存。详见 [`docs/deployment.md`](./docs/02-deployment/deployment-self-hosting.md) 第 7 节与 `.env.example` 的「身份源 / SSO」小节。
> 仍待补齐的企业级能力：多租户运营面（开通/配额/账单）、正式合规模块（SOC2/GDPR 数据主权分区）；
> 这些属于"对外 SaaS 化"范畴，内部/部门试点已可直接落地。

### 健壮性增强（与核心隔离的运行时加固）

在 14 项功能落地之后，又对「系统不裸崩、任务不挂死、资源不泄漏、重启不丢活」做了进一步加固，
绝大部分位于 server 业务/运行时层；唯一一次对核心 `backend/core` 的改动是 `FileMemoryStore` 的
**原子写加固**（纯 I/O 安全，不引入任何业务策略），已在下方明示：

- **运行队列防挂死**：每个 Job 自带 `AbortController` + 看门狗（`JOB_TIMEOUT_MS`，默认 5 分钟）。
  即使底层工具/LLM 调用意外卡住，超时后也会中止并**释放 worker 槽位**，避免任务永久占坑拖垮并发。
- **队列有界化**：`jobs` 表按 `RUN_JOBS_MAX`（默认 500）惰性淘汰「已结束且无人订阅」的最旧 Job，
  防止长生命周期内的内存膨胀。
- **同会话串行化**：共享 `sessionKey` 的并发 Job 错开执行，避免并发写记忆后端（file/sqlite）互相覆盖。
- **MCP 启动容错**：单个服务连接失败不再中断其余服务的接入，并在 `/api/state` 暴露 `error` 状态；
  引导期从未连上的服务可经 `/api/mcp/reconnect` 用保存的配置重新发起连接。
- **优雅停机**：收到 `SIGTERM/SIGINT` 时，先 `runQueue.abortAll()` 中止所有在飞/排队任务
  （经 job 级 `AbortController`，harness 在下一检查点退出），等待 `RUN_SHUTDOWN_GRACE_MS` 宽限，
  再关闭 MCP 连接与监听；停机期间 `/api/run` 直接返回 503，避免任务在退出时被强杀。
- **进程级崩溃防护**：注册 `uncaughtException`/`unhandledRejection` 兜底日志——未捕获异常记录后安全退出
  （交由 k8s/Render 重启），未处理拒绝仅记录不退出，避免单点拒绝拖垮在线服务；SSE 写操作对
  客户端断连（EPIPE）做了容错。
- **队列持久化与重启重放**：`RunQueue` 接入 `QueueBackend` 抽象（`access/server/src/queue-backend.ts`），
  设 `RUN_QUEUE_BACKEND=file` 后，未开始的任务落盘到 JSONL，进程崩溃 / 重启自动重放，避免丢活
  （详见上文「运行队列」）；Redis / BullMQ 只需实现同一接口即可作为分布式后端接入。
- **核心记忆文件原子写**：`FileMemoryStore.save` 改为「写临时文件 + 同 FS 原子 rename」——进程在写入途中
  崩溃时旧文件完好、仅残留可清理的 `.tmp`，既不丢数据也不产生半截 JSON。这是本轮**唯一一次核心改动**，
  且仅为 I/O 安全加固，未触碰任何业务语义；其余加固均在 server 层。

> 已知边界：单条工具调用（如一次阻塞的网络请求）若自身不响应取消信号，job 级看门狗只能在其返回后
> 生效；这属于底层工具的契约范畴，核心 harness 已对 LLM 调用做了 `Promise.race` + 信号兜底。

## 密钥管理（外部化）

服务**不依赖任何密钥 SDK**，所有密钥均通过 `process.env` 读取；启动早期由 `loadSecrets()`（`access/server/src/secrets.ts`）统一装配，使既有读取逻辑零改动。该设计让「真实密钥永不进仓库/镜像」，满足准生产安全要求。

**三种来源（优先级从高到低，且均不覆盖平台注入的 env）：**

1. **平台注入 env（推荐，最高优先级）** — Render / K8s / Docker / systemd 直接注入环境变量，进程启动即就绪，无需任何文件。
2. **`SECRETS_FILE`（JSON）** — 指向一个密钥文件，适配 K8s Secret 挂载、Docker secret、Render Secret Files。例如：
   ```bash
   export SECRETS_FILE=/run/secrets/app.json
   # 文件内容：{"OPEN_API_KEY":"sk-...","UI_AUTH_TOKEN":"tok-...","REDIS_URL":"redis://..."}
   ```
3. **本地 `.env`** — 仅开发便利，已被 `.gitignore` 忽略；生产环境无此文件即跳过。

**落地要点：**

- 加载在 `server.ts` 模块顶部、任何 `process.env.X` 顶层读取之前调用（`loadSecrets()` 幂等，仅首次生效）。
- 任何来源解析失败只告警不中断（`[secrets]` 日志），保证降级可用。
- `.env.example` 是本地模板，真实密钥请走来源 1/2，切勿提交 `.env`。
- 多实例部署下每个副本各自装配密钥，无共享密钥存储依赖。

## 接入层扩展能力（账户 / OAuth / BYOK / 插件市场 / 多会话）

`access/server` 在核心之上叠加的纯业务能力（核心 `@agent-harness/core` 不感知），均以「接口 + 默认实现 + 组合工厂」存在：

- **账户密码登录**（`accounts.ts`）：scrypt 哈希 + HMAC 令牌，凭据存 `auth_tokens` SQLite（7 天过期、可吊销）；端点 `/api/account/{register,login,logout,me,refresh,change-password,forgot-password,reset-password}`。
- **OpenRouter OAuth PKCE**（`oauth.ts`）：`S256` 一键授权，`/api/account/oauth/{github,google}/callback` 换得 token 后走同一加密落库链路；过渡页由 `views.ts` 渲染。
- **BYOK 凭据注入**（`provider-keys.ts`）：用户 LLM 凭据 AES-GCM 落库（`provider-keys.db`），运行时 per-run 注入到 harness，绝不写 `process.env`；`/api/account/provider-keys` 管理。
- **插件市场 Registry**（`registry-server.ts`，`pnpm registry`）：最小插件市场（列表/版本/下载/统计/发布鉴权 `REGISTRY_TOKEN`），`/api/registry/{plugins,search,stats}`。
- **多会话 Chat + 跨设备同步**（`chat-sessions.ts` + `chat-bus.ts`）：用户可见会话列表 + 消息记录（owner 隔离），经 SSE 按 owner fanout，跨标签页/设备/实例实时同步；端点 `/api/chat/sessions`、`/api/chat/stream`、`/api/history`。
- **备忘提醒总线**（`reminder-bus.ts` + 插件 `memo`）：提醒到点经服务端 bus 按 owner 推送。
- **配置热更新**（`config-hot-reload.ts`）：JSON 配置文件覆盖 env，`POST /api/config/reload` 或可选轮询；启动期 `config-schema.ts` 校验 80+ 环境变量（warn 级不阻断）。
- **健康探针**（`health.ts`）：`/health`、`/health/live`、`/health/ready` 供 K8s/Render 探针。
- **日志脱敏**（`log-scrub.ts`）：全局 JSON 日志脱敏，绝不落密钥/令牌/MCP 认证头。
- **副本选择器**（`replica-picker.ts`）：接入层 round-robin / least-load / sticky-hash 负载均衡，配合 Redis 运行队列支持多实例水平扩展。

> 这些能力全部落在 `access/server` 业务层；`core` 仅提供框架原语（harness/tools/memory/guardrails + 多智能体基座），
> 始终零业务耦合、可插拔、可组合。插件经 `plugin-bootstrap.ts` 动态 require，server 不静态 import 任何插件。

## 已知问题与设计权衡

UI 端实测反馈过两类现象，经排查均为**设计层面的真实问题**（非偶发），现将根因与本仓库已落地的优化记录如下，便于后续评估与演进决策。

### 问题 A：复杂任务时 Agent 闭环「提前结束」

闭环主循环在 `backend/core/src/harness.ts` 的 `run()` 中，有两处会导致复杂任务在中途收尾：

1. **硬上限 `maxSteps` 偏低导致中途截断**。循环以 `for (step < this.opts.maxSteps)`（`harness.ts:178`）驱动；框架默认 `maxSteps: 12`（`harness.ts:84`），早期 UI 未显式覆盖时即沿用此值。任务若需要 >12 步（多轮工具调用 / 反复试错）就会在 `reached max steps without a final answer`（`harness.ts:317`）处被强制收尾，表现就是「闭环直接结束、没拿到结果」。
2. **空响应即终止**。唯一终止条件是 `if (!resp.tool_calls || resp.tool_calls.length === 0) return resp.content;`（`harness.ts:249`）。弱 / 免费模型偶尔回空内容且无 `tool_calls`，主循环会把这段空回复当成「最终答案」直接返回，同样表现为提前结束。

**已落地优化**（均在核心层，业务层零改动）：

- 闭环步数上限从硬编码 12 提到 **默认 24**，且可在 `runner.ts:240` 经 `MAX_STEPS` 环境变量或前端「步数上限」输入框（`index.html` 的 `maxStepsInput`）按任务复杂度覆盖；`server.ts` 的 `handleRun` → `runQueue.submit` → `run-queue.ts` 的 `execute()` → `assembleAgent` 已全链路透传 `maxSteps`。
- 新增**可选完成自检** `requireCompletion`（`harness.ts:253-263`）：开启后，若模型以「空内容 + 无工具调用」收尾且未达 `maxSteps`，注入系统提示让其继续，直到产出实质结果或步数耗尽；非空回复一律视为真实最终答案，避免干扰正常收尾与额外成本。默认关闭（`AGENT_COMPLETION_CHECK` 开启）。

> 权衡：`maxSteps` 同时是防「模型死循环刷工具」的安全阀，不能无上限放开；默认值 24 是「覆盖率 / 成本 / 安全性」的折中，复杂任务建议显式调大而非全局拉满。

### 问题 B：每次对话 token 消耗偏大

token 成本呈**结构性**偏高，根因在 prompt 的组装方式，而非单一 bug：

1. **全量历史每步重发**。每一步都把整个对话窗口（所有 `user` / `assistant` / `tool` 消息）重新拼进请求体，`steps` 步累计 prompts 为 O(steps²) 增长（`harness.ts` 主循环逐轮 `callLLM`）。
2. **工具结果原文逐字重发**。工具返回（网页正文、文件内容、MCP 响应等）被原样存入 `tool` 消息并随后续每步重发，长结果迅速撑大上下文（`harness.ts:300-314` 原逻辑）。
3. **system 提示词 + 技能目录每步重发**。系统提示词、技能编排目录、触发预激活段落等长文本每段调用都带。
4. **跨运行记忆加载（若启用持久化）**。开启 `MEMORY_BACKEND` 后，`run()` 会从后端 `load()` 长期笔记并注入系统提示词，进一步加厚首步 prompt。
5. **重试放大成本**。弱模型空响应时适配器按 `retries` 自动重试；重试的 prompt 与原调用同等体量，且原实现未累计重试间的 token 用量，导致「单次 run 的用量」被低估、实际计费更高。

**已落地优化**（默认保守、可经环境变量调优，避免破坏默认行为）：

- **工具结果截断** `maxToolResultChars`（默认 16000，`runner.ts:241`，`harness.ts:300-307`）：超过阈值的工具结果截断并标注「原长 N 字符」，显著压低后续步骤的上下文体积与重发成本。复杂任务可调大，机密/长文本场景建议调小。
- **滑动窗口保留 system 消息**（`memory.ts` `add()`，约 62–101 行）：窗口溢出（`maxWindow`，默认 20，可经 `MEMORY_WINDOW` 调整，`runner.ts:232-234`）时只淘汰非 system 的历史，保留 system 提示词，避免「截断后重新注入 system」带来的重复开销与行为漂移。
- **上下文压缩（可选，根治 token 平方增长）** `CONTEXT_COMPRESSION`（`memory.ts` `MemorySummarizer` + `runner.ts` 摘要器）：开启后，滑动窗口溢出淘汰的旧轮次不再直接丢弃，而是被压缩为**一条 `system` 摘要消息固定保留**。模型仍保有早期上下文（已完成的交互数、工具调用清单），但每步重发的量从「全部历史」降为「一条有界摘要」。`MemorySummarizer` 契约已支持**异步**返回（`Promise<string>`，用于调用 LLM 做摘要），`Memory.add()` 不阻塞，摘要在 harness 循环顶部 `flushSummary()` 落地，因此对主循环同步结构零侵入。
  - **启发式摘要器**（默认，`COMPRESSION_MODE=heuristic`）：统计用户请求/工具调用，**零额外 LLM 调用**，有界 ~400 字符，行为确定。
  - **LLM 摘要器**（可选，`COMPRESSION_MODE=llm`）：把被淘汰轮次交给同一 LLM 做高质量中文压缩（≤400 字），更保真；每次压缩有一次额外 LLM 调用成本，**仅 real 模式生效**（mock/离线模式即便设为 `llm` 也自动回退启发式）。失败（限流/异常）时回退上一轮摘要，绝不会中断主运行。
- **重试 token 用量累计**（`llm/shared.ts`）：`callOpenAIChat` 跨重试累加 `usageAcc`，单次 run 的「真实总成本」不再被低估，可在 `/api/metrics` 看到准确数字。
- **提示词缓存（可选）** `PROMPT_CACHE`：设为 `true`/`1` 时给首条 system 消息打 `cache_control: { type: 'ephemeral' }`，使「每步重发的 system + 技能目录」可命中提供方缓存、不计重复输入费。默认关闭，避免个别严格校验未知字段的 provider 报错。

> 权衡：问题 B 的根因（全量历史每步重发）已通过「截断 + 窗口 + 压缩摘要 + 缓存 + 可观测」五件套在不牺牲信息完整性的前提下把成本压到可控区间。压缩摘要提供两档：`heuristic`（默认，零额外调用、行为确定）与 `llm`（调用模型做更高质量压缩，有额外成本，仅 real 模式生效）。长对话追求保真时可切 `llm`；对成本/确定性敏感时保持 `heuristic`。

### 相关环境变量（新增，详见 `.env.example`）

| 变量                     | 作用                                                                                                  | 默认                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| `MAX_STEPS`              | 单次闭环步数上限（前端也可按任务覆盖）                                                                | `24`（核心框架默认 12） |
| `MAX_TOOL_RESULT_CHARS`  | 工具结果截断阈值，压低上下文重发成本                                                                  | `16000`                 |
| `AGENT_COMPLETION_CHECK` | 开启空响应完成自检，避免空回复提前终止                                                                | 关闭                    |
| `MEMORY_WINDOW`          | 滑动窗口容量（`memory.ts` 溢出淘汰非 system 历史）                                                    | `20`                    |
| `PROMPT_CACHE`           | 给 system 打 `cache_control`，命中提示词缓存降输入费                                                  | 关闭                    |
| `CONTEXT_COMPRESSION`    | 滑动窗口溢出时把淘汰轮次压缩为 system 摘要固定保留，根治 token 平方增长                               | 关闭                    |
| `COMPRESSION_MODE`       | 压缩摘要器：`heuristic`（零额外调用）/ `llm`（调用模型做高质量压缩，仅 real 模式生效，mock 自动回退） | `heuristic`             |
| `ALERT_WEBHOOK_URL`      | 告警接收器：把告警 JSON POST 到该 Webhook（Slack/飞书/钉钉/自研网关）                                 | 未设置（仅本地日志）    |
| `ALERT_LOG_PATH`         | 告警接收器：把告警以 JSON 逐行追加到该文件，便于采集                                                  | 未设置（仅本地日志）    |

## 基座子系统（多智能体基座）

在单智能体闭环之上，`backend/core/src` 已落地一套**多智能体基座子系统**（详见 [`docs/01-architecture/modules.md`](./docs/01-architecture/modules.md)），全部以「接口 + 默认实现 + 组合工厂」范式存在，`server` 侧已接入运行链路：

| 子系统               | 目录                                                     | 作用                                                                                                           |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **智能体注册与发现** | `agents/`                                                | `AgentCard` + `AgentRegistry` + `AgentStore`（volatile/file/redis），P0.1 注册/发现/健康度                     |
| **任务路由**         | `router/`                                                | `IntentRouter` + `AgentSelector` + LRU 缓存的 LLM 意图分类 + 规则回退（P0.2）                                  |
| **租户隔离**         | `tenant.ts`                                              | 复合记忆 key `tenant::session`、`resolveTenantContext` 认证身份优先、`REQUIRE_TENANT` 门禁（P0.3）             |
| **策略引擎**         | `policy/`                                                | 行业策略画像预选与出网管控（接入 run-queue / runner / A2A / workflow 入口）                                    |
| **配额引擎**         | `quota/`                                                 | 租户级并发准入配额（`admit`/`release`，接入 `run-queue`）                                                      |
| **工作流编排**       | `workflow/`                                              | `DagEngine` DAG 执行 + 补偿 + `WorkflowStore`（volatile/file）                                                 |
| **A2A 协议**         | `a2a/`                                                   | `LocalA2ATransport` / `HttpA2ATransport`，跨主机 `POST /api/a2a/tasks` 派发                                    |
| **插件框架**         | `plugin/`                                                | `PluginManifest` → `PluginLoader`（install/enable/disable/upgrade + 验签）→ `PluginRegistryClient`（远程市场） |
| **OS 级沙箱**        | `sandbox/` + `builtins/sandbox.ts` + `builtins/shell.ts` | Linux 命名空间/seccomp 隔离，非 Linux 自动降级为「硬化本地进程」                                               |
| **审计**             | `audit.ts`                                               | 结构化审计事件（接入 RBAC/审批/敏感动作）                                                                      |
| **特性开关**         | `feature-flags.ts`                                       | 集中管理功能开关（`/api/features` 可查询；`contextCompression` 等已接线）                                      |
| **错误日志**         | `errorlog.ts`                                            | 统一错误记录 + 计数 + 报告（`/api/errors`）                                                                    |
| **子智能体**         | `subagent/`                                              | `SubAgentManager`：在当前 run 循环内派生带独立记忆窗口的子 agent；server 侧 `subagent-tools.ts` 注册 `delegate_task` 工具 |
| **团队**             | `teams/`                                                 | `Team` + `TeamManager`：动态多 agent 团队 + 协作模式，经 `AgentRegistry.executeTeamTask()` 接 workflow 编排              |

> 说明：`core/server/webapp` 三层始终**零业务耦合**；业务语义（如医美客资、医疗广告合规）只存在于 `plugins/` 与可复用领域库（`backend/medical-ad-guard`）。

## 测试

核心库带一套零依赖测试（Node 内置 `node:test` + `node:assert`），覆盖护栏（含归一化注入检测 + PII 脱敏）、
记忆、工具注册表、Agent 循环（含超时/外部取消/长期记忆注入/预算熔断）、LLM 适配器（mock fetch）、
成本记账与故障转移、可观测性指标快照、内置工具与技能编排：

```bash
pnpm --filter @agent-harness/core run build   # 先构建
pnpm --filter @agent-harness/core run test    # 跑测试（约 371 用例，52 测试文件）
```

Web Playground 也有集成测试：启动真实构建产物 `dist/server.js` 子进程，验证鉴权(P0-3)、
请求体上限(413)、`/api/metrics`、SSE `/api/run` 等端点：

```bash
pnpm --filter @agent-harness/server run build     # 先构建
pnpm --filter @agent-harness/server run test      # 跑集成测试
```

多平台客户端 `@agent-harness/client` 分两层验证——**离线契约测试**（注入 fetch 替身，零网络，
覆盖 URL 拼装 / Bearer 鉴权 / 错误映射 / 202 审批工单 / SSE 分帧健壮性）与**端到端 smoke**
（自己在随机空闲端口拉起 `access/server/dist/server.js`，跑完自动回收，不依赖外部已运行实例）：

```bash
pnpm --filter @agent-harness/client run build      # 先构建
pnpm --filter @agent-harness/client run test       # 离线契约测试（14 用例，任何环境可跑）
pnpm -r build && \
  pnpm --filter @agent-harness/client run test:e2e # 端到端 smoke（自举 server）
```

e2e 的三种运行姿态：设 `AH_BASE_URL` 直连既有实例（不 spawn）；未设则自举 server；
server 未构建时默认跳过（exit 0），设 `AH_SMOKE_STRICT=1` 则升级为失败（CI 采用后者）。

CI（`.github/workflows/ci.yml`）在 push/PR 时执行 `lint → pnpm -r build → pnpm -r test → pnpm audit --audit-level=high`，
并附带 `cleanup-retention` 与 `backup-db` 两个运维步骤。当前**未集成**镜像推送（GHCR）、SBOM（CycloneDX）或
PR `Dependency Review` 作业——如需准生产供应链可见性，建议后续补齐。

## 健壮性增强

- **超时与取消**：`new AgentHarness({ timeoutMs, signal })` 可对整个运行设超时或外部中止；
  取消信号已透传到 LLM 适配器（fetch 层）与工具循环阶段。
- **长期记忆接入**：`memory.remember(note)` 写入的笔记会注入系统提示词；配置
  `persistencePath` 时跨运行自动 `load`/`save`。
- **MCP 连接生命周期**：`connectMcpServer` 维护活跃客户端，进程退出（SIGINT/SIGTERM）
  时由 UI 统一 `disconnectAllMcp()` 清理，避免 stdio 子进程 / SSE 长连接泄漏。
- **MCP 自动重连与健康探测**：远端 server 重启/网络抖动时三层自愈——工具调用失败懒重连一次、
  后台周期 `ping` 探测、指数退避自动重连；状态实时回写 UI 并可手动「↻ 重连」（见前文「连接可靠性」）。
- **成本记账与配额**：每次 LLM 调用按模型单价表（`backend/core/src/llm/pricing.ts`）估算美元成本，
  累加进可观测指标（`/api/metrics` 含 `cost` 与 `costByModel`），并发出 `run:cost` 事件供 UI 实时展示。
  可设单次 run 的 `tokenBudget` / `costBudget`（`MAX_TOKENS_PER_RUN` / `MAX_COST_PER_RUN`），超限即熔断中止。
  未知模型默认不计费（保守），可用 `registerModelPrice()` 按合同价覆盖。
- **Provider 故障转移**：同时配置 `OPENAI_API_KEY` 时，自动用熔断器把 OpenRouter 作 primary、OpenAI 作 secondary；
  primary 连续失败/限流（达 `LLM_FAILOVER_THRESHOLD`）即打开电路转走 secondary，冷却后 half-open 探活恢复。
  对 harness 主循环透明；`LLM_FAILOVER=false` 可关闭。
- **Harness 环境地址可配置**：`envUrlTemplate`（或 `HARNESS_ENV_URL_TEMPLATE`）替换原硬编码占位符。

## 部署（自托管）

仓库现已提供生产级交付物，可脱离 Render 独立部署：

- **`Dockerfile`**（多阶段 pnpm 构建，基础镜像锁定 Node 22，非 root 运行 + HEALTHCHECK）
- **`docker-compose.yml`**（单实例内存模式开箱即用；`--profile redis` 启用 Redis 运行队列以支持多副本）
- **`deploy/k8s/`**（Namespace / ConfigMap / Secret / Deployment / Service / Ingress / HPA，可选 Redis；用 kustomize 管理）
- **`.github/workflows/ci.yml`**（push/PR：lint → `pnpm -r build` → `pnpm -r test` → `pnpm audit --audit-level=high`；**当前未集成镜像推送 / SBOM / Dependency Review 作业**）
- **[`docs/deployment.md`](./docs/02-deployment/deployment-self-hosting.md)** —— 完整的自托管指南（本地 docker / K8s / 环境变量清单 / 密钥注入 / SSO）

> 关键约定：**所有密钥经 `process.env` 注入**（平台 env > `SECRETS_FILE` > 本地 `.env`），真实密钥永不进仓库或镜像。
> K8s 清单中的 `image`、`ingress.host`、Secret 占位值部署前必须替换为真实值（建议改用 Sealed/External Secrets）。
> 默认 `ENV_PLATFORM=harness`（无 key 即 dry-run）；要真正拉起/销毁环境，设 `ENV_PLATFORM=local`（零依赖真跑）或 `k8s`（生产级）。
