# agent-harness

一个**最小化、可直接运行**的 TypeScript AI Agent harness 骨架：工具调用循环、短期/长期记忆、三层护栏、可选的 OpenTelemetry 追踪。设计目标与 Python 版 `agent-harness` 一致，但用 TS 重写。

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
├─ packages/
│  ├─ core/                   # @agent-harness/core —— 框架库（零运行时依赖）
│  │  ├─ src/
│  │  │  ├─ types.ts          // 核心契约：Message / ToolCall / ToolSchema / LLM
│  │  │  ├─ telemetry.ts       // 可选 OTel 追踪（无依赖降级）
│  │  │  ├─ memory.ts         // 滑动窗口 + 长期记忆 + 可选持久化
│  │  │  ├─ tools.ts          // 工具注册表 + JSON Schema 生成
│  │  │  ├─ guardrails.ts     // 输入/输出/工具参数三层护栏
│  │  │  ├─ harness.ts        // 编排循环（LLM ↔ 工具 ↔ 记忆）+ 事件流 HarnessEvent
│  │  │  ├─ loadEnv.ts         // 零依赖 .env 加载器
│  │  │  ├─ index.ts          // 统一导出（barrel）
│  │  │  ├─ llm/              // OpenRouter / OpenAI 适配器 + shared.ts（共用请求/解析逻辑）
│  │  │  ├─ integrations/     // Harness 平台客户端 + harness-tools + mcp/placeholder
│  │  │  └─ test/             // node:test 最小测试套件（护栏/记忆/工具/循环/适配器）
│  │  └─ tsconfig.json
│  └─ ui/                     # @agent-harness/ui —— Web Playground（依赖 core）
│     ├─ src/
│     │  ├─ server.ts         // node:http SSE 服务：/api/run、/api/verify、/api/mcp/*、/api/env、/api/state
│     │  ├─ runner.ts         // 按模式组装 agent（mock / real / real-mcp）
│     │  ├─ verification.ts   // 三大能力的可视化验证（流式事件）
│     │  ├─ mcp-manager.ts    // 多 MCP server 单例管理器（共享注册表 + 运行时添加）
│     │  └─ env-pipeline.ts   // 环境生命周期状态机 + 流式状态
│     ├─ public/index.html    // 单文件暗色仪表盘前端
│     └─ tsconfig.json
├─ examples/                  # @agent-harness/examples —— CLI 示例（消费 core）
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ package.json
└─ render.yaml                # Render 部署 Blueprint（部署 packages/ui）
```

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

// 读 OPENROUTER_API_KEY / OPENROUTER_MODEL / OPENROUTER_BASE_URL
const llm = createOpenRouterLLM();
const agent = new AgentHarness({ llm, tools });
```

- 模型用 provider-prefixed slug：`openai/gpt-4o-mini`、`anthropic/claude-3.5-sonnet`…
- 还支持 OpenRouter 的 `models` 兜底数组：`createOpenRouterLLM({ models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'] })`
- 弱/免费模型偶尔返回空响应，`createOpenRouterLLM({ retries: 2 })`（默认即 2）会在无文本且无工具调用时自动重试，提升 demo 稳定性。
- 若你只用 OpenAI / Azure / 本地 vLLM，仍可用 `createOpenAILLM()`（`src/llm/openai.ts`）。

设置环境变量即可（见 `.env.example`）；不填 `OPENROUTER_API_KEY` 时示例会
自动退回内置 mock LLM，保证零配置可运行。

## 自助环境治理闭环（agent × harness-env-platform）

把 agent 接到前面 `harness-env-platform/` 的 Harness 流水线，让 agent
**自助拉起 / 销毁 ephemeral 环境**：

- `src/integrations/harness-client.ts` — Harness NG 流水线 API 客户端，
  把「我要个环境」「拆掉它」映射为 `provision-environment` / `destroy-ephemeral`
  流水线触发 + **状态轮询**。**默认 dry-run**：无 `HARNESS_API_KEY` 时只打印
  它将发出的 API 调用并返回占位 handle，整条闭环可零凭据跑通。
  - 接真实 Harness 时，状态字段路径可配置：`statusPath`（默认
    `pipelineExecution.summary.status`）、`doneStatuses`、`successStatuses`。
    设 `HARNESS_DEBUG=1` 会打印原始 trigger / status 响应，方便对照你的实例
    调整字段映射。
- `src/integrations/harness-tools.ts` — 把上面两个能力注册成 agent 工具
  `create_ephemeral_environment` / `destroy_environment`。
- 示例：
  - `examples/self-serve-env.ts` — `pnpm --filter @agent-harness/examples run demo:env`（无 key 用 mock；有
    `OPENROUTER_API_KEY` 则真跑；harness 始终 dry-run 直到你填 `HARNESS_API_KEY`）
  - `examples/real-loop.ts` — `pnpm --filter @agent-harness/examples run real-loop`：真实两轮对话闭环
    （Turn1 拉起环境 → Turn2 销毁环境），已用 OpenRouter 实测跑通
  - `examples/chat.ts` — `pnpm --filter @agent-harness/examples run chat`：单轮真实对话（需 `OPENROUTER_API_KEY`）

```bash
# 零凭据演示（dry-run，打印真实会发出的 Harness API 调用）
pnpm --filter @agent-harness/examples run demo:env

# 真实 LLM + dry-run Harness：会真正调用 OpenRouter 驱动 create→destroy 循环
export OPENROUTER_API_KEY=sk-or-...
pnpm --filter @agent-harness/examples run real-loop

# 真实接入 Harness：在 .env 填入 HARNESS_API_KEY / ACCOUNT / ORG / PROJECT 后重跑
```

运行示例时你会看到：用户一句话 → agent 调用 `create_ephemeral_environment`
（打印触发的流水线 YAML）→ 用完后调用 `destroy_environment` 清理 → 闭环完成。
护栏对含密钥输入依旧在入口拦截。

## MCP 接入（已实现，配即激活）

`src/integrations/mcp/placeholder.ts` 已基于 `@modelcontextprotocol/sdk` 实现
**真实 MCP 客户端**，支持三种传输：

- 远程 **Streamable HTTP**（默认，URL 不以 `/sse` 结尾时自动选）
- 远程 **SSE**（`MCP_SERVER_URL` 以 `/sse` 结尾，或显式 `transportType: 'sse'`）
- 本地 **stdio**（`MCP_COMMAND` + `MCP_ARGS`）

配置其一即可自动把 MCP 工具接进 `ToolRegistry`，护栏 / 记忆 / 追踪对它们
**自动生效**，无需改 harness 主循环。远程认证头通过 `MCP_HEADERS`
（`KEY=VALUE` 逗号分隔，如 `MCP_HEADERS=CONTEXT7_API_KEY=xxx`）注入。

### 已接入：Context7（库文档/代码片段 MCP）

首个真实 MCP 已接上 **Context7**（`https://mcp.context7.com/mcp`，Streamable HTTP，
基础使用免 key）。`.env` 已激活：

```bash
MCP_SERVER_URL=https://mcp.context7.com/mcp
# 高配额才需要：MCP_HEADERS=CONTEXT7_API_KEY=你的key
```

它提供两个工具：`resolve-library-id`（把库名解析成 Context7 库 ID）和
`query-docs`（按库 ID + 问题拉取最新官方文档片段）。

```bash
pnpm --filter @agent-harness/examples run verify:context7   # 连真实端点、列工具、并实打实调一次 resolve-library-id
```

> 你之前没有自己的 MCP，所以这块是「预留 → 激活」。接下来按同样方式逐步
> 添加更多 MCP（改 `MCP_SERVER_URL` 或加多个 `registerMcpTools` 调用即可，
> 主循环零改动）。

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

| 工具 | 能力 | 说明 |
|---|---|---|
| `builtin__calculator` | 精确数学求值 | 自研 tokenizer + shunting-yard + RPN，**绝不 `eval`**；支持 `+-*/%^`、括号、一元负号、常量 `pi/e`、函数 `sqrt/abs/floor/ceil/round/exp/ln/log/sin/cos/tan/pow/atan2/min/max` |
| `builtin__datetime_now` | 当前时间 | 返回 ISO-8601 与指定 IANA 时区的可读时间 |
| `builtin__datetime_convert` | 时区转换 | ISO 时间戳在时区间转换 |
| `builtin__datetime_add` | 时间偏移 | 对时间加减 seconds…years（负数即减） |
| `builtin__web_fetch` | 抓取网页 | 仅允许 http/https，HTML 轻量清洗为文本，带超时与大小上限 |
| `builtin__fs_read` | 读文件 | UTF-8 文本读取（限 root 内） |
| `builtin__fs_list` | 列目录 | 列出目录条目 |
| `builtin__fs_search` | 搜文件 | 按文件名/内容在 root 内递归搜索 |

接入点：`registerBuiltinTools(registry, options)`（`packages/core/src/builtins`）。
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

| 默认技能 id | 关联工具 | 触发词示例 |
|---|---|---|
| `web-research` | `builtin__web_fetch` | 搜索 / 查一下 / 最新 / 官网 / fetch |
| `math` | `builtin__calculator` | 算 / 计算 / 多少 / 百分比 / calculate |
| `files` | `builtin__fs_read`·`_list`·`_search` | 读文件 / 看文件 / 搜索文件 / file |
| `current-time` | `builtin__datetime_*` | 现在几点 / 时间 / 时区 / time |

接入点（`packages/core/src/skills`）：

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
pnpm --filter @agent-harness/ui run start            # 编译并启动，默认 http://localhost:4173 （可用 UI_PORT 改端口）
```

打开后你会看到三栏布局：

- **左栏**：当前模式的工具注册表（Tool Registry，按来源 `harness` / `mcp` 分组）
  + **MCP 服务面板**（每个已接 server 的状态灯、工具数、工具列表，并可填
  URL 实时「添加 MCP」）+ 三大验证（Agent 闭环 / Harness 轮询 / MCP 接入）
  的实时状态灯。
- **中栏**：Agent 闭环的**实时时间线**（每一步 LLM 调用、工具调用的参数与
  结果都流式出现）+ 同步的「记忆 / 对话」视图 + 顶部**环境流水线**视图。
- **右栏**：护栏拦截日志（输入 / 输出 / 工具参数被拦截时高亮）+ 原始事件流。

三种运行模式（顶部切换）+ 可选模型覆盖输入框：

- **Mock（离线）**：内置 mock LLM + Harness dry-run 工具，**无需任何密钥**
  即可可视化跑通「创建 → 销毁」闭环，最适合离线验证。
- **真实 LLM**：走 OpenRouter 真实模型（需 `OPENROUTER_API_KEY`）。
- **真实 + Context7 MCP**：在真实 LLM 基础上接入已配置的 Context7 MCP，
  可视化看到 agent 自主调用远程 MCP 工具。

点「▶ 运行 Agent」开始一轮运行；点「✓ 运行验证」则把三大能力按流式事件
在左栏验证面板里逐个点亮 ✅ / ❌（与 `pnpm --filter @agent-harness/examples run verify:*` 同一套逻辑，只是
实时可视化）。环境流水线区可点「拉起环境 / 销毁环境」触发
`PENDING → PROVISIONING → RUNNING → READY` 状态机的可视化（无
`HARNESS_API_KEY` 时走 dry-run 演示同样的状态流转）。

实现要点：

- `packages/ui/src/server.ts` 仅用 `node:http` / `node:fs` / `node:path`，**零额外依赖**；
  通过 SSE（`text/event-stream`）把 `HarnessEvent`、验证事件、MCP/Env 事件推给前端。
  端点：`/api/run`（模式+提示词流式推 Agent 事件）、`/api/verify`（三大验证）、
  `/api/mcp/list`（列出已接 server）、`/api/mcp/add`（运行时新增 server）、
  `/api/env`（create/destroy 流式推状态机）、`/api/state`（全局状态快照）。
- `src/ui/mcp-manager.ts`：多 MCP server 单例管理器，启动时按 `MCP_SERVER_URL`
  （逗号分隔可配多个）自动连接，并支持运行时通过 `/api/mcp/add` 逐步添加；
  每个 server 的工具以 `<server>__<tool>` 前缀注册，避免命名冲突。
- `src/ui/env-pipeline.ts`：环境生命周期状态机，dry-run 下用定时器模拟真实
  Harness 流水线各阶段；有 `HARNESS_API_KEY` 时可切换为调用真实 `HarnessClient`
  轮询真实状态。
- `src/harness.ts` 新增可选 `onEvent` 回调（类型 `HarnessEvent`），在循环每一步
  发出事件，**不修改任何业务逻辑**，CLI 与测试完全不受影响。
- 前端 `packages/ui/public/index.html` 是单文件（内联 CSS/JS，无 CDN 依赖），暗色主题，
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
  经 `registerMcpTools` 注入 transport，完整跑通「连接→list→注册→调用」。
- `examples/verify-context7.ts`：连真实 Context7 端点，列工具并实调 `resolve-library-id`。
- `examples/real-loop.ts`：需 `OPENROUTER_API_KEY`（见 `.env`）才走真实模型；
  MCP 接入为 best-effort——`registerMcpTools` 失败只告警不中断环境闭环。

## 接口鉴权（Web Playground）

Web UI 的写操作（`/api/run`、`/api/verify`、`/api/mcp/add`、`/api/env`、`/api/mcp/list`、…）
默认开放。**部署到公网前请设置 `UI_AUTH_TOKEN`**，此后这些端点需携带令牌：

```bash
UI_AUTH_TOKEN=your-secret node packages/ui/dist/server.js
# 请求时：Authorization: Bearer your-secret
```

- 前端：右上角「访问令牌」输入框填写 `UI_AUTH_TOKEN`，请求自动以
  `Authorization: Bearer <token>` 发送（不再依赖会泄露在日志/历史里的 `?token=`）。
  （`?token=` 仍保留为兼容写法，但建议迁移到 Bearer。）
- 未设置 `UI_AUTH_TOKEN` 时服务照常启动，但会在日志给出开放模式告警。
- `/api/state`（供 Render 等 PaaS 健康检查）与静态页始终开放。

### 部署公网前的安全加固（必做）

除了令牌，还提供以下开箱即用开关（详见 `.env.example`）：

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `UI_AUTH_TOKEN` | 接口 Bearer 鉴权；未设置则开放 | 空（开放） |
| `UI_CORS_ORIGIN` | 跨域白名单（逗号分隔）；留空=仅同源（不再回 `*`） | 空（仅同源） |
| `MAX_BODY_BYTES` | 请求体上限，防大报文 DoS | 1048576（1MB） |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW_MS` | 单 IP 限流（窗口内请求数）；≤0 关闭 | 120 / 60000 |
| `AUDIT_LOG` | 审计日志落盘路径；留空则仅输出 stdout（JSON 行） | 空（stdout） |

审计日志会记录 时间 / 方法 / 路径 / 客户端 IP / 是否鉴权 / 状态码，并对高危动作
（`agent.run`、`env.create`/`env.destroy`、`mcp.add`/`mcp.preset`、`shell.approve`）
写入**脱敏**后的关键参数；**绝不记录密钥、令牌或 MCP 认证头**。

### 内容安全护栏（guardrails）

三层防护（输入 / 输出 / 工具参数）已升级为可配置策略引擎，可通过环境变量或
`configureGuardrails()` 在运行时调整（详见 `.env.example`）：

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `GUARDRAIL_SENSITIVITY` | 注入检测敏感度 `low`/`medium`/`high` | `medium` |
| `GUARDRAIL_MAX_INPUT` | 输入最大字符数，超过即拦截 | `20000` |
| `GUARDRAIL_SECRET_SCAN` | 是否扫描密钥类敏感串 | `true` |
| `GUARDRAIL_INJECTION_SCAN` | 是否做提示词注入检测 | `true` |
| `GUARDRAIL_PII` | 是否在输出侧做 PII 脱敏 | `true` |
| `GUARDRAIL_ALLOWLIST` | 命中即跳过注入拦截的关键词（逗号分隔） | 空 |

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
- **为独立 Worker 留接口**：当前是进程内内存队列（`packages/ui/src/run-queue.ts`），
  将来要横向扩展，只需把 `RunQueue` 实现替换为消息队列（Redis/BullMQ 等），
  handler 与前端协议不变。

### 会话 / 多租户记忆存储（P1-9 DB 化）

记忆的「存在哪」与「怎么用」已彻底解耦：运行时只认一个 `sessionKey`，后端负责按 key
隔离读写。内置三类 `MemoryStore`，均零 npm 依赖：

- **VolatileMemoryStore**（默认）：纯内存，无持久化，适合本地 / Mock。
- **FileMemoryStore**：按会话分桶的 JSON 文件目录（`MEMORY_DIR`，每个 `<key>.json` 一份），
  单节点落地零依赖；旧版单文件 `persistencePath` 模式仍向后兼容。
- **SqliteMemoryStore**：基于 Node 22+ 内置的 `node:sqlite`（无需任何 npm 包、无需启动 flag），
  多租户生产推荐；运行期 Node 不支持时自动回退到 File 并告警。

配置：设 `MEMORY_BACKEND=file|sqlite|volatile`（默认配了 `MEMORY_DIR` 用 file，否则 volatile）。
隔离维度由调用方决定：前端 / API 携带 `x-session-id` 头或 `body.sessionId`，
记忆即按该 key 在所选后端隔离持久化；未带则归入 `anonymous`。

运维可见：受保护的 `GET /api/sessions` 列出所有已落盘会话 key 与后端类型；
`GET /api/memory?session=<key>` 查看长期笔记与窗口长度；
`DELETE /api/memory?session=<key>` 清空某会话记忆；`/api/metrics` 暴露 `memory.backend`。

> 企业落地仍待补充：RBAC 与审批流（见仓库规划任务清单）。

### RBAC 角色权限 + 审批工作流（P2-12，业务策略与核心隔离）

鉴权与审批是**纯业务层**能力（`packages/ui/src/authz.ts` + `approval.ts`），核心
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
  替换身份源（OIDC / LDAP / SPIFFE）或审批后端时，**仅改这两个工厂，server 其余代码零改动**。

运维端点（均受 RBAC 保护）：
- `GET /api/roles`：当前权限矩阵概览（不含令牌明文）。
- `GET /api/approvals` / `GET|POST /api/approvals/:id`：工单列表 / 查看 / 裁决（approve|reject）。
-   前端 Playground 在令牌具备审批权限时显示「🛡 审批队列」面板，可一键批准 / 拒绝；
  提交敏感动作若进入审批，前端自动轮询并在批准后继续执行。

### 运行评估与配方版本化（P2-13，业务质量策略与核心隔离）

同样是**纯业务层**能力（`packages/ui/src/eval.ts`），核心不产出任何「评分 / 版本」概念：
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

## 测试

核心库带一套零依赖测试（Node 内置 `node:test` + `node:assert`），覆盖护栏（含归一化注入检测 + PII 脱敏）、
记忆、工具注册表、Agent 循环（含超时/外部取消/长期记忆注入/预算熔断）、LLM 适配器（mock fetch）、
成本记账与故障转移、可观测性指标快照、内置工具与技能编排：

```bash
pnpm --filter @agent-harness/core run build   # 先构建
pnpm --filter @agent-harness/core run test    # 跑测试（100 用例）
```

Web Playground 也有集成测试：启动真实构建产物 `dist/server.js` 子进程，验证鉴权(P0-3)、
请求体上限(413)、`/api/metrics`、SSE `/api/run` 等端点：

```bash
pnpm --filter @agent-harness/ui run build     # 先构建
pnpm --filter @agent-harness/ui run test      # 跑集成测试
```

CI（`.github/workflows/ci.yml`）在 push/PR 时执行 `build → test`，并附两个安全作业：
`Dependency Audit & SBOM`（`pnpm audit --severity high` + CycloneDX SBOM 产物归档，不阻塞）
与 PR 的 `Dependency Review`（新增/升级依赖的已知漏洞与许可证合规，high 即失败）。

## 健壮性增强

- **超时与取消**：`new AgentHarness({ timeoutMs, signal })` 可对整个运行设超时或外部中止；
  取消信号已透传到 LLM 适配器（fetch 层）与工具循环阶段。
- **长期记忆接入**：`memory.remember(note)` 写入的笔记会注入系统提示词；配置
  `persistencePath` 时跨运行自动 `load`/`save`。
- **MCP 连接生命周期**：`connectMcpServer` 维护活跃客户端，进程退出（SIGINT/SIGTERM）
  时由 UI 统一 `disconnectAllMcp()` 清理，避免 stdio 子进程 / SSE 长连接泄漏。
- **MCP 自动重连与健康探测**：远端 server 重启/网络抖动时三层自愈——工具调用失败懒重连一次、
  后台周期 `ping` 探测、指数退避自动重连；状态实时回写 UI 并可手动「↻ 重连」（见前文「连接可靠性」）。
- **成本记账与配额**：每次 LLM 调用按模型单价表（`packages/core/src/llm/pricing.ts`）估算美元成本，
  累加进可观测指标（`/api/metrics` 含 `cost` 与 `costByModel`），并发出 `run:cost` 事件供 UI 实时展示。
  可设单次 run 的 `tokenBudget` / `costBudget`（`MAX_TOKENS_PER_RUN` / `MAX_COST_PER_RUN`），超限即熔断中止。
  未知模型默认不计费（保守），可用 `registerModelPrice()` 按合同价覆盖。
- **Provider 故障转移**：同时配置 `OPENAI_API_KEY` 时，自动用熔断器把 OpenRouter 作 primary、OpenAI 作 secondary；
  primary 连续失败/限流（达 `LLM_FAILOVER_THRESHOLD`）即打开电路转走 secondary，冷却后 half-open 探活恢复。
  对 harness 主循环透明；`LLM_FAILOVER=false` 可关闭。
- **Harness 环境地址可配置**：`envUrlTemplate`（或 `HARNESS_ENV_URL_TEMPLATE`）替换原硬编码占位符。
