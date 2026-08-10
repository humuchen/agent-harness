# agent-harness-ts

一个**最小化、可直接运行**的 TypeScript AI Agent harness 骨架：工具调用循环、短期/长期记忆、三层护栏、可选的 OpenTelemetry 追踪。设计目标与 Python 版 `agent-harness` 一致，但用 TS 重写。

## 设计原则

- **单一可替换契约**：任何 LLM 后端只要实现 `LLM` 类型即可接入
  `（messages, toolSchemas) => Promise<{ content, tool_calls }>`。
- **零硬运行时依赖**：只用 Node 内置 API。OpenTelemetry 是可选的，
  没装就自动降级为 no-op。
- **工具错误即自愈**：工具抛错会作为 tool result 回灌模型，模型可重试或换路。
- **护栏先行**：输入 / 输出 / 工具参数三层检查，默认拦截密钥与超长输入。

## 目录结构

```
agent-harness-ts/
├─ src/
│  ├─ types.ts        // 核心契约：Message / ToolCall / ToolSchema / LLM
│  ├─ telemetry.ts    // 可选 OTel 追踪（无依赖降级）
│  ├─ memory.ts       // 滑动窗口 + 长期记忆 + 可选持久化
│  ├─ tools.ts        // 工具注册表 + JSON Schema 生成
│  ├─ guardrails.ts   // 输入/输出/工具参数三层护栏
│  ├─ harness.ts      // 编排循环（LLM ↔ 工具 ↔ 记忆）
│  └─ index.ts        // 统一导出
├─ examples/
│  └─ basic.ts        // MockLLM 示例，无需 API key 即可跑
├─ package.json
└─ tsconfig.json
```

## 快速开始

```bash
# 安装 dev 依赖（仅 typescript，用于编译）
npm install

# 编译并运行示例
npm run dev
# 或：先 build 再 start
npm run build && npm start
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
import { AgentHarness, createOpenRouterLLM } from './src/index';

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
  - `examples/self-serve-env.ts` — `npm run demo:env`（无 key 用 mock；有
    `OPENROUTER_API_KEY` 则真跑；harness 始终 dry-run 直到你填 `HARNESS_API_KEY`）
  - `examples/real-loop.ts` — `npm run real-loop`：真实两轮对话闭环
    （Turn1 拉起环境 → Turn2 销毁环境），已用 OpenRouter 实测跑通
  - `examples/chat.ts` — `npm run chat`：单轮真实对话（需 `OPENROUTER_API_KEY`）

```bash
# 零凭据演示（dry-run，打印真实会发出的 Harness API 调用）
npm run demo:env

# 真实 LLM + dry-run Harness：会真正调用 OpenRouter 驱动 create→destroy 循环
export OPENROUTER_API_KEY=sk-or-...
npm run real-loop

# 真实接入 Harness：在 .env 填入 HARNESS_API_KEY / ACCOUNT / ORG / PROJECT 后重跑
```

运行示例时你会看到：用户一句话 → agent 调用 `create_ephemeral_environment`
（打印触发的流水线 YAML）→ 用完后调用 `destroy_environment` 清理 → 闭环完成。
护栏对含密钥输入依旧在入口拦截。

## MCP 接入（已实现，配即激活）

`src/integrations/mcp/placeholder.ts` 已基于 `@modelcontextprotocol/sdk` 实现
**真实 MCP 客户端**。你目前还没有自己的 MCP server，所以它默认是 no-op；
一旦你有了 server，二选一配置即可自动把 MCP 工具接进 `ToolRegistry`：

- 远程（SSE/HTTP）：`MCP_SERVER_URL=https://your-mcp.example.com/sse`
- 本地（stdio）：`MCP_COMMAND=npx`（可配 `MCP_ARGS` / `MCP_HEADERS`）

```bash
export MCP_SERVER_URL=https://your-mcp.example.com/sse
npm run demo:env   # 启动时自动连接 MCP、拉取工具列表并注册
```

MCP 工具注册后，护栏 / 记忆 / 追踪对它们**自动生效**，无需改 harness 主循环。

> 把「环境治理」与「Agent harness」串起来的关键：
> `harness-env-platform` 负责环境定义与流水线，
> `agent-harness-ts` 通过 Harness API 在对话中按需供给/回收环境，
> 两者仅通过流水线 identifier 与环境变量耦合，互不入侵。

## 自包含验证（无需真实凭据/服务）

三项核心能力都配了**零外部依赖**的验证脚本，CI 或本地可直接跑：

```bash
npm run verify            # 依次跑 #2 + #3 验证
npm run verify:harness    # #2：用 Mock fetch 验证 Harness 轮询/终态映射
npm run verify:mcp        # #3：进程内起真实 MCP Server 验证接入链路
npm run real-loop         # #1：真实 OpenRouter 两轮 create→destroy 闭环
```

- `examples/verify-harness.ts`：注入模拟 Harness 后端，覆盖 SUCCESS / FAILED
  两条终态路径，并验证自定义 `statusPath` 生效。
- `examples/verify-mcp.ts`：用 SDK `InMemoryTransport` 在进程内起 MCP Server，
  经 `registerMcpTools` 注入 transport，完整跑通「连接→list→注册→调用」。
- `examples/real-loop.ts`：需 `OPENROUTER_API_KEY`（见 `.env`）才走真实模型；
  无 key 时退回内置 mock。
