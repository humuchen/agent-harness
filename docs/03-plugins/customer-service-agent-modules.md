# 智能客服 Agent · 模块细分设计

> 配套文档：`customer-service-agent-design.md`（总体方案与框架接入计划）、`customer-service-agent-architecture.svg`（分层架构图）、`customer-service-agent-sequence.svg`（运行时时序图）。
> 本文在架构图与总体方案之上，把 7 个模块拆到「子组件 / 关键接口（设计契约）/ 数据契约 / 框架接驳点 / 实施阶段」粒度，作为后续编码的蓝图。
> 标注 **[设计契约]** 的 TypeScript 片段是设计层面的类型约定，不是最终实现代码。

---

## 模块全景（依赖关系）

```
M1 接入与鉴权 ──▶ M2 会话编排 ──▶ M3 意图路由 ──▶ M4 智能体配置
                                          │              │
                                          └──▶ M5 工具能力 ◀┘
M2 会话编排 ──▶ M6 持久化与数据模型 ◀── M5 工具能力（落库 handoff）
M6 ──▶ M7 管理后台与统计（读 ChatSession / HandoffQueue / stats）
M3/M5 复用 M6 的 Guardrails 做 PII 与注入防护
```

M1→M2→M3→M4 是请求主链路；M5 是被 M4 调用的能力；M6 被 M2/M5 写入、被 M7 读取；M7 独立对坐席暴露。

---

## M1 · 接入与鉴权模块（API Gateway）

**职责**：所有外部流量的统一入口；建立 SSE 流式通道；基于 RBAC 的接口鉴权；把运行请求送入并发队列。

**子组件**
- `SSEChannel`：把 harness 的 `onEvent` 流翻译成 `text/event-stream`，事件类型至少含 `token` / `retrieval` / `tool` / `run:meta` / `handoff` / `done` / `error`。
- `guard(action)`：既有 `UI_AUTH_TOKEN` 校验 + 动作级 RBAC（`sessions:read` / `cs:admin` 等）。
- `RunQueue`：既有运行队列，做并发上限与去重（同 `chatSessionId` 串行）。

**关键接口 [设计契约]**
```ts
interface RunRequest {
  sessionId: string;        // = Memory key（多轮上下文）
  chatSessionId: string;    // = ChatSession 存储 key（历史持久化）
  message: string;
  agentId?: string;         // 显式指定，如 'cs-orchestrator'
  domain?: 'cs';            // 或按 domain 路由
  channel?: string;         // web / wechat / app
}
type RunEvent =
  | { type: 'token'; delta: string }
  | { type: 'retrieval'; tool: string; query: string; hits: FaqHit[] }
  | { type: 'tool'; tool: string; args: unknown; result: unknown }
  | { type: 'run:meta'; decidedBy: string; intent?: string; agentId: string }
  | { type: 'handoff'; reason: string; summary: string }
  | { type: 'done' } | { type: 'error'; message: string };
```

**框架接驳点**
- `access/server/src/server.ts`：新增 `POST /api/run`、`GET /api/cs/*`；复用 `guard()` 与既有 `/api/chat/sessions*`。
- `access/server/src/runner.ts`：由 `RunQueue` 触发 `runSession(req)`。

**阶段**：阶段 0（复用既有网关与鉴权，仅需补 `cs:admin` 动作与 `handoff` 事件转发）。

---

## M2 · 会话编排模块（Runner）

**职责**：把一次 `RunRequest` 组装成一次 `AgentHarness.run()`；按 `sessionId` 复用多轮 `Memory`；订阅 harness 事件做「桥接 + 落盘 + 启发式升级」；把事件转给 `SSEChannel`。

**子组件**
- `resolveSessionKey(req)`：由 `sessionId` 派生长键（可加 `channel` 维度）。
- `getSessionMemory(key)`：既有 LRU 复用逻辑，多副本场景需改为共享后端（见 M6）。
- `buildHarness(agentCard, memory)`：注入 systemPrompt、工具集、`Guardrails`、`onEvent`。
- `bridgeEvents(harness, chatSessionId, res)`：转发 SSE；在 `run:end` 写 ChatSession；在 `run:meta` 写 intent；在 `handoff` 写 HandoffQueue。
- `applyHeuristics(run, ctx)`：**转人工兜底**——maxSteps 耗尽 / 连续 N 次工具失败 / verify 未通过 / 命中「人工」关键词 → 强制触发 handoff。

**关键接口 [设计契约]**
```ts
interface RunnerContext {
  chatSessionId: string;
  sessionKey: string;
  agentId: string;
  intent?: string;
}
function runSession(req: RunRequest): AsyncIterable<RunEvent>;
```

**框架接驳点**
- `access/server/src/runner.ts`：扩展 `handleRun` 订阅逻辑；`backend/core/src/harness.ts`：`AgentHarness.run()` 与 `HarnessEvent` 流；`onEvent` 旁路通道。

**阶段**：阶段 0（多轮+持久化复用），阶段 2（启发式升级 + handoff 桥接）。

---

## M3 · 意图路由模块

**职责**：把用户语句归类到 `refund / order / tech / general` 等意图，并选定对应领域 AgentCard；结果透出供统计。

**子组件**
- `IntentRouter.classify(prompt)`：rule（关键词词典）/ llm（`INTENT_ROUTER=llm`）/ auto（有 key 用 llm，否则 rule）三种模式，输出 `{domain, intent, requiredCapabilities, source}`。
- `TaskRouter.resolve(req)`：决策优先级 `显式 agentId > domain > classify > fallback`，返回 `RouteResult{agentId, card, decidedBy, intent}`。
- `CS_INTENT_DICT`：客服领域词典，挂载到 `DOMAIN_KEYWORDS`（退款/退货/订单/物流/故障/报错/无法解决…）。

**关键接口 [设计契约]**
```ts
interface IntentResult {
  domain: string;          // 'cs-refund' | 'cs-order' | 'cs-tech' | 'cs-general'
  intent: string;          // 'refund' | 'order' | 'tech' | 'chitchat'
  requiredCapabilities: string[];
  source: 'rule' | 'llm' | 'cache';
}
interface RouteResult {
  agentId: string;
  card: AgentCard;
  decidedBy: 'agentId' | 'domain' | 'classify' | 'fallback';
  intent?: string;
}
```

**框架接驳点**
- `backend/core/src/router/intent.ts`：扩 `DOMAIN_KEYWORDS` 与 `classify()`。
- `backend/core/src/router/router.ts`：`resolveTask()` 增加 cs 分支。
- `backend/core/src/agents.ts`：`AgentCard` / `IndustryDomain`。

**阶段**：阶段 1（补词典 + 开 `INTENT_ROUTER=llm`）。

---

## M4 · 智能体配置模块

**职责**：定义客服域的 AgentCard 集合，每张卡通过 `assembly` 收窄 systemPrompt 与工具，实现「一个入口 + 多领域专营」。

**子组件（AgentCard 清单）**
- `cs-orchestrator`：接待、闲聊、意图初判；无明确意图时直接解答，明确意图时委托 `TaskRouter` 转专营卡。
- `cs-refund`：退款/退货流程，工具集含 `search_faq` + `transfer_to_human`。
- `cs-order`：订单查询，工具集含 `lookup_order` + `search_faq`。
- `cs-tech`：技术故障，工具集含 `search_faq` + 可选 `KB-MCP`。
- `cs-general`：兜底/兜底闲聊，避免误转人工。

**关键接口 [设计契约]**
```ts
interface AgentAssembly {
  systemPrompt: string;
  tools: string[];          // 工具名白名单，如 ['search_faq','transfer_to_human']
  skills?: string[];
}
interface AgentCard {
  id: string;               // 'cs-orchestrator'
  name: string;
  domain: 'cs-refund' | 'cs-order' | 'cs-tech' | 'cs-general';
  assembly: AgentAssembly;
}
```

**框架接驳点**
- `backend/core/src/agents.ts`：`getAgentRegistry().register(card)`；服务端 bootstrap `seedCsAgents()`（沿用 `initAgentRegistry` 持久后端）。

**阶段**：阶段 1（注册 4–5 张卡）。

---

## M5 · 工具能力模块

**职责**：实现 Agent 可调用的能力；命名遵循检索型约定以获前端绿色卡片；转人工工具负责把 handoff 写入队列。

**子组件**
- `search_faq(query, topK?)`：v1 查 JSON 知识库（问题/答案/关键词/可选 embedding）；命名含 `search` → 前端 `retrieval` 节点绿色高亮。后续换向量库（pgvector / 本地 embeddings）。
- `lookup_order(orderId)`：对接订单系统（v1 可为 mock 或订单 MCP）；仅 `cs-order` 装配。
- `transfer_to_human(reason, summary)`：把 handoff 写入当前 `ChatSession.handoff` 并推入 `HandoffQueue`；通过回调/事件桥接，不侵入 harness 主循环。
- `KB-MCP`（可选）：把 FAQ/文档作为远程 MCP server 接入（框架已支持多 MCP）。

**关键接口 [设计契约]**
```ts
interface FaqHit { question: string; answer: string; score: number; }
interface ToolResult { ok: boolean; data?: unknown; error?: string; }
async function search_faq(args: { query: string; topK?: number }): Promise<{ hits: FaqHit[] }>;
async function transfer_to_human(args: { reason: string; summary: string }): Promise<{ handoffId: string }>;
```

**框架接驳点**
- `backend/core/src/tools.ts`：`ToolRegistry.register(name, description, parameters, fn)`。
- `access/server/src/server.ts`：`RETRIEVAL_RE` / `chat-sessions.ts`：`isRetrievalTool` 识别与 `handoff` 落库。

**阶段**：阶段 0（`search_faq`）/ 阶段 1（`lookup_order`）/ 阶段 2（`transfer_to_human`）。

---

## M6 · 持久化与数据模型模块

**职责**：会话与转人工队列的存储；多轮 `Memory` 后端；生产化前补齐「共享后端」这一唯一基础设施缺口。

**子组件**
- `ChatSessionStore`：既有 `ChatSession` 模型（id/title/createdAt/updatedAt/messages[]），**扩展字段** `intent` / `handoff` / `resolved` / `channel` / `satisfaction`。
- `HandoffQueue`：转人工队列（同进程 Map + 可选持久化，或复用 ChatSession 按 `handoff` 过滤）；字段 `status: 'pending'|'claimed'|'done'`、`claimedBy`。
- `MemoryStore`：既有 volatile/file/sqlite 三后端；多副本需共享（sqlite 在网络 FS 锁不可靠，建议 RWX 卷 + file 或 redis，参考 `deploy/k8s`）。

**数据契约 [设计契约]**
```ts
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  ts: number;
  reasoning?: string;
  tools?: unknown[];
  trace?: unknown;
  intent?: string;                       // 本条归属意图
}
interface Satisfaction { rating: 1|2|3|4|5; comment?: string; at: number; }
interface Handoff {
  at: number; reason: string; summary: string;
  status: 'pending' | 'claimed' | 'done'; claimedBy?: string;
}
interface ChatSession {
  id: string; title?: string;
  createdAt: number; updatedAt: number;
  messages: ChatMessage[];
  intent?: string;                       // 会话主意图
  handoff?: Handoff;
  resolved?: boolean;
  channel?: string;
  satisfaction?: Satisfaction;
}
```

**框架接驳点**
- `access/server/src/chat-sessions.ts`：扩模型 + 落盘逻辑。
- `backend/core/src/memory-store.ts`：共享后端实现参照。

**阶段**：阶段 0（字段就绪）/ 阶段 2（handoff）/ 阶段 3（satisfaction）/ 阶段 4（共享后端）。

---

## M7 · 管理后台与统计模块

**职责**：对坐席/管理员暴露会话记录、满意度统计、转人工队列认领；纯读取与轻量写（评分、认领）。

**子组件**
- `ah-cs-admin` 面板（LitElement，沿用 `panels.ts` 模式）：会话列表（按意图/转人工/日期筛选）、会话详情（复用 chat 渲染）、满意度概览、统计卡片（纯 SVG 柱状/饼图）。
- `StatsAggregator`：聚合查询，输出统计视图。
- `FeedbackHandler` / `HandoffClaimHandler`：评分与认领写操作。

**关键接口 [设计契约]**
```ts
interface CsStats {
  total: number; resolved: number; handedOff: number;
  intentDist: Record<string, number>;
  avgSatisfaction: number; csatPct: number;   // 4-5 星占比
  trend: { date: string; count: number; csat: number }[];
}
// 接口
GET  /api/cs/stats
POST /api/chat/sessions/:id/feedback   // body: Satisfaction
GET  /api/cs/handoffs
POST /api/cs/handoffs/:id/claim        // body: { claimedBy }
```

**框架接驳点**
- `frontend/webapp/src/panels.ts` + `app.ts`：新增 `ah-cs-admin` 与 Tab，受 `cs:admin` 角色保护。
- `access/server/src/server.ts`：新增上述接口，接入 `guard()`。

**阶段**：阶段 3。

---

## 实施阶段 ↔ 模块映射（速查）

| 阶段 | 目标 | 涉及模块 |
|------|------|----------|
| 0 | mock 跑通 多轮+FAQ+持久化 | M1, M2, M4(orchestrator), M5(search_faq), M6(字段) |
| 1 | 意图路由（退款/订单/技术）| M3, M4(全卡), M5(lookup_order) |
| 2 | 自动转人工 | M5(transfer_to_human), M2(启发式), M6(handoff), M1(handoff 事件) |
| 3 | 管理后台+满意度 | M7, M6(satisfaction), M1(接口) |
| 4 | 生产化 | M6(共享后端/向量FAQ), M5(KB-MCP), M1(企微/飞书通知), k8s 多副本 |

---

## 关键风险与契约边界
- **多副本一致性（唯一硬缺口）**：`ChatSession` 当前为内存/单文件；阶段 4 前必须升级为共享后端，否则多副本会话互相看不到。
- **意图误分**：rule 易漏，阶段 1 起用 `INTENT_ROUTER=llm` + 缓存；`cs-general` 兜底防误转人工。
- **转人工双保险**：模型调用 `transfer_to_human` + M2 服务端启发式，二者任一触发即落 handoff。
- **PII**：M6 复用 `Guardrails` 做输出脱敏与留存期限，客服对话含隐私须默认开启。
