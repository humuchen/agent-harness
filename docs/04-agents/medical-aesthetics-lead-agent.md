# 真实「医美客资 Agent」落地蓝图（接入现有 agent-harness）

> 目标：把一套**能真正跑起来的医美获客/留资/预约到店 Agent** 设计成一个 `plugins/medical-aesthetics-lead` 插件，
> 完全复用现有 harness 的「非侵入插件契约」（core/server/webapp 三层零业务耦合红线不变）。
> 本文是**设计 + 实现就绪蓝图**：每个扩展点都给出对应的 `PluginContext` API 与代码骨架。

---

## 0. 这个 Agent 到底做什么（与「客服」的区别）

医美「客资」= customer lead（潜客）。客资 Agent 的核心 KPI 不是「解决售后」，而是 **漏斗转化**：

```
引流(抖音/小红书/微信/美团) → 破冰 → 需求挖掘+初筛 → 项目咨询 → 留资 → 预约到店
   → 到店接诊(转人) → 成交 → 术后回访/复购/转介绍
```

与现有 `customer-service` 插件的关系：**可并存、可二选一**。客资 Agent 偏「获客转化」，客服偏「售后答疑」；
生产上常把两者做成**不同 `domain` 的两个插件**，由意图路由（`IntentRouter`）按场景分诊。本文按独立插件设计，
结构上与 customer-service 同构，但业务语义更重（含留资、分级、到店、成交闭环）。

> 它**不做什么**（合规硬约束，见 §2）：不做诊断、不承诺疗效、不用患者形象作证明、不给固定价。

---

## 1. 真实业务域建模

### 1.1 客资生命周期（每个 stage 对应一个动作）

| Stage | 含义 | Agent 在此阶段的能力 |
| --- | --- | --- |
| `new` | 新进线（含渠道/来源广告） | 渠道识别、破冰开场 |
| `contacted` | 已沟通、需求已挖 | 项目问答（接知识库） |
| `qualified` | 已初筛分级 A/B/C/D | 抽取结构化字段、意向分级 |
| `captured` | 已留资（微信/手机） | 留资落库 + 授权提示 |
| `booked` | 已预约到店 | 选院区/时段、写预约 |
| `arrived` | 已到店接诊 | 转人工咨询师（A2A/handoff） |
| `deal` | 已成交 | 成交记录、进入回访 |
| `lost` | 流失/沉默 | 生成唤醒话术、进跟进队列 |

### 1.2 意向分级（决定动作分支）

- **A（高意向）**：明确项目+预算+时间窗 → 直接 `capture` + `book`。
- **B（中意向）**：有项目兴趣但犹豫 → 科普+案例话术（合规版）+轻留资。
- **C（低意向）**：泛咨询/比价 → 种草+进 `followup` 队列。
- **D（无效/风险）**：投诉/医疗纠纷/敏感词 → 立即 `handoff` 转人工，不走自动应答。

### 1.3 渠道来源（影响话术与归因）

抖音/小红书（内容种草，防「硬广」）、微信私域（已留资，重复购）、美团/点评（到店转化导向）、官网/落地页（表单留资）。
渠道元数据随消息一起进 `ctx.config`/会话，用于看板「渠道分布」与 ROI 归因。

---

## 2. 合规红线（必须写进架构，不是事后补丁）

医美是广告法/医疗广告法重点监管领域，Agent 的**系统提示词 + 护栏**要双重卡死：

1. **不承诺疗效/安全性**：禁用「保证不留疤」「100%成功」「绝对安全」等绝对化用语。
2. **不做诊断**：「你这是 XX 炎/XX 病」❌；只能科普+引导面诊。
3. **不用患者名义/术前术后真人对比图作证明** ❌。
4. **不贬低同业**、不虚构机构资质。
5. **价格用区间/起**（如「热玛吉约 5k–15k 起」），不给固定价。
6. **每次留资必须明示授权**（「为帮您预约，需保留您的微信，是否同意？」）。
7. **每次应答附风险提示**：「医疗美容有风险，最终以面诊方案为准」。

实现：
- **系统提示词**（§4.2）把上述规则写成强约束；
- **护栏**（core `guardrails.ts` 已有 `registerInputRule` + `INJECTION_PATTERNS`）注册一条输出规则：命中绝对化疗效词/诊断句式 → 拦截并要求改写（见 §4.8）。

---

## 3. 架构映射：如何接入现有 harness

现有插件契约（`backend/core/src/plugin/context.ts`）提供以下注入面，客资 Agent 全部复用：

| 业务需求 | 复用扩展点 | 说明 |
| --- | --- | --- |
| 项目问答 / 留资 / 预约 / 转人工 | `ctx.tools.register(name, desc, schema, handler)` | 工具名自动加 `medical-aesthetics-lead__` 前缀，并入共享工具表，LLM 可调用 |
| 多轮转化流程（漏斗） | `ctx.workflow.validate(def)` + `createEngine(executor)` | DAG 编排分诊/分支 |
| 客资看板 HTTP 接口 | `ctx.server.registerExtension({id, mountRoutes})` | 路由收敛到 `/api/plugins/medical-aesthetics-lead/*` |
| 客资看板前端 Tab | `ctx.web.registerView({tabId, label, render()})` | 服务端渲染 HTML 注入内容区 |
| 对话记录/事件回填 | `ctx.events.on(e => …)` 订阅 `run:start/run:end` | 与 customer-service 同款桥接 |
| 转人工咨询师 | `ctx.a2a.send(envelope)` 或 `handoff` 工具 | 跨 agent / 跨主机派发 |
| 合规护栏 | `guardrails.registerOutputRule(...)`（在插件 setup 内调用 core API） | 输出层拦截违规 |
| 敏感操作鉴权 | `authz.ts` 新增 `lead:assign`/`lead:export` 动作 + `guard('lead:assign')` | 复用既有 RBAC |

> 关键不变量不变：`pluginId === agentId === manifest.id`（= `medical-aesthetics-lead`）；
> 业务语义**只存在于 `plugins/medical-aesthetics-lead/`**，core/server/webapp 零业务词。

---

## 4. 插件包结构与关键代码骨架

### 4.1 文件树（与 customer-service 同构）

```
plugins/medical-aesthetics-lead/
├── package.json                 # workspace: plugins/* 已覆盖
├── tsconfig.json                # paths 指 @agent-harness/core 的 dist
├── manifest.json
└── src/
    ├── index.ts                 # PluginModule 主入口（setup/onStart/onStop/onUnload）
    ├── manifest.ts              # PluginManifest（id/version/capabilities/assembly.systemPrompt）
    ├── prompts.ts               # 系统提示词（角色 + 合规红线 + 阶段话术）
    ├── store.ts                 # 客资生命周期文件存储（复用 CS_DATA_DIR/MEMORY_DIR 模式）
    ├── tools/
    │   ├── kb.ts                # project_kb_search 项目知识库检索（经外部 RAG 检索；knowledge/ 母版已迁移下线，源为 rag-store.json）
    │   ├── qualify.ts           # lead_qualify 结构化抽取+意向分级
    │   ├── capture.ts           # lead_capture 留资（带授权）
    │   ├── book.ts              # consultation_book 预约到店
    │   └── handoff.ts           # lead_handoff 转人工咨询师
    ├── workflows/
    │   └── conversation.ts      # lead-conversation DAG
    ├── server/
    │   └── routes.ts            # /stats /leads /leads/:id/assign /handoffs /followups
    └── web/
        └── dashboard.ts         # 客资看板 Tab（漏斗+到店率+渠道+跟进队列，内联 SVG）
```

### 4.2 `manifest.ts`（含合规系统提示词装配）

```ts
import type { PluginManifest, AgentCapability } from '@agent-harness/core';
import { buildSystemPrompt } from './prompts';

export const leadManifest: PluginManifest = {
  id: 'medical-aesthetics-lead',
  version: '0.1.0',
  name: '医美客资顾问',
  description: '多渠道获客/需求初筛/项目咨询/留资/预约到店/转人工咨询师，含医疗广告合规护栏',
  domain: 'medical-aesthetics',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [
    { id: 'chat' }, { id: 'lead' }, { id: 'consult' },
    { id: 'book' }, { id: 'handoff' },
  ] as AgentCapability[],
  assembly: { systemPrompt: buildSystemPrompt() },
};
```

`prompts.ts` 的 `buildSystemPrompt()` 必须把 §2 的 7 条合规红线写成**不可违反的指令**，并定义阶段话术与升级触发条件
（命中投诉/医疗纠纷/绝对化需求 → 立即 handoff）。

### 4.3 `tools/qualify.ts`（LLM 抽取 + 分级，写回 store）

```ts
export function registerQualifyTool(tools: ToolRegistry, store: LeadStore): void {
  tools.register(
    'lead_qualify',
    '从对话中抽Structured字段(项目/预算/城市/到店意愿/渠道)并打意向分级 A/B/C/D。',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        transcript: { type: 'string', description: '近期对话文本' },
      },
      required: ['sessionId', 'transcript'],
    },
    async (args) => {
      // 1) LLM 抽取结构化字段（或本地规则兜底）
      const f = await extractLeadFields(String(args.transcript));
      // 2) 规则打分分级
      const grade = gradeLead(f);            // A/B/C/D
      // 3) 写回客资 store
      store.upsertLead(args.sessionId, { ...f, grade, stage: 'qualified' });
      return { ok: true, grade, field: f };
    }
  );
}
```

> 工具 handler 直接 import 自己插件的 `store.ts`（进程内同一份文件后端），与 customer-service 一致。

### 4.4 `tools/capture.ts`（留资 + 授权，合规点 6）

```ts
tools.register('lead_capture', '在用户明示授权后留存微信/手机号，进入私域。', schema, async (args) => {
  if (!args.consented) return { ok: false, needConsent: true,
    message: '为帮您预约与后续跟进，需保留您的联系方式，是否同意？' };
  store.upsertLead(args.sessionId, {
    phone: args.phone, wechat: args.wechat, name: args.name,
    stage: 'captured', capturedAt: Date.now(),
  });
  return { ok: true, stage: 'captured' };
});
```

### 4.5 `tools/book.ts` + `handoff.ts`

- `consultation_book`：参数（院区/日期/时段）→ 写 `booked` + 返回确认话术（含风险提示）。
- `lead_handoff`：参数（sessionId/原因/等级）→ 标记 `arrived` 或进 `lost`，emit `lead.handoff` 事件，
  经 `ctx.a2a.send` 派发给「咨询师 agent」（若独立部署）或直写转人工队列。

### 4.6 `workflows/conversation.ts`（漏斗 DAG，复用 DagEngine）

```ts
export const leadConversation: WorkflowDef = {
  id: 'lead-conversation',
  steps: [
    { id: 'intake',    run: 'intro+channel',            next: ['discover'] },
    { id: 'discover',  run: 'qualify',                  next: ['route'] },
    { id: 'route',     run: 'branch-by-grade',          next: ['consult','capture','handoff','nurture'] },
    { id: 'consult',   run: 'kb-qa-loop',               next: ['capture'] },
    { id: 'capture',   run: 'capture-or-nudge',         next: ['book'] },
    { id: 'book',      run: 'consultation-book',        next: ['summarize'] },
    { id: 'handoff',   run: 'human-handoff',            next: ['summarize'] },
    { id: 'nurture',   run: 'enqueue-followup',         next: ['summarize'] },
    { id: 'summarize', run: 'writeback-lead-store',     next: [] },
  ],
};
```

`ctx.workflow.validate(leadConversation)` 在 `setup` 中校验拓扑；真正执行由 `/api/run` 经核心 DagEngine 驱动。

### 4.7 `store.ts`（客资生命周期，文件后端）

复用 customer-service 的 `DATA_DIR` 取法（`CS_DATA_DIR ?? MEMORY_DIR/plugins/<id> ?? ./data/cs`），每条 lead 一个 JSON：

```ts
interface LeadRecord {
  leadId: string;            // = sessionId 或 runId
  channel: string;           // 抖音/小红书/微信/美团/官网
  source?: string;           // 来源广告/落地页
  project?: string;          // 双眼皮/玻尿酸/热玛吉…
  budget?: string;
  city?: string;
  grade?: 'A'|'B'|'C'|'D';
  stage: 'new'|'contacted'|'qualified'|'captured'|'booked'|'arrived'|'deal'|'lost';
  wechat?: string; phone?: string; name?: string;
  consultedBy?: string; visitAt?: number; dealAt?: number;
  transcript?: { role: string; text: string; t: number }[];
  createdAt: number; updatedAt: number;
}
```

统计视图（看板消费）：**漏斗各 stage 计数、到店率、成交率、渠道分布、分级分布、待跟进队列、转人工队列**。
这些就是 dashboard Tab 的数据源。

### 4.8 合规护栏（在 `setup` 内注册输出规则）

```ts
import { registerOutputRule } from '@agent-harness/core'; // core 护栏 API
registerOutputRule({
  id: 'medical-ad-compliance',
  test: (text: string) => /保证|100%|(绝对|百分百)(成功|安全)|你这(是|就是).*(炎|病)/.test(text),
  onViolation: (text) => ({ blocked: true, message: '回复触发医疗广告合规红线，已拦截并要求改写。' }),
});
```

> core 的 `guardrails.ts` 已支持 `registerInputRule`；输出规则同理（若该 API 名为 `registerOutputRule` 以实际导出为准，
> 思路不变：输出层加一道合规过滤网）。

### 4.9 `server/routes.ts`（看板接口，收敛到 `/api/plugins/medical-aesthetics-lead/*`）

```ts
export const leadServerExtension: ServerExtension = {
  id: 'medical-aesthetics-lead',
  mountRoutes: {
    '/stats':            stats,        // 漏斗/到店率/成交率/渠道
    '/leads':            listLeads,    // 客资列表（guard('lead:read') 由平台侧包）
    '/leads/:id/assign': assign,       // 分配咨询师（guard('lead:assign')）
    '/handoffs':         handoffs,     // 转人工队列
    '/followups':        followups,    // 待跟进队列
  },
};
```

> 注意：宿主为**精确路径匹配**（见 `plugin-ext.ts`），所以 `assign` 用 `POST /leads/:id/assign` 时 `:id` 不是动态参数——
> 与 customer-service 一致，改用 body 传 `leadId`（`POST /leads/assign`）。

### 4.10 `web/dashboard.ts`（客资看板 Tab）

完全照搬 `customer-service` 的 `admin-panel.ts` 模式：`tabId:'ma-lead'`, `label:'客资看板'`, `render()` 服务端调 `store.fullStats()`
生成 HTML + 内联 SVG（漏斗柱状图 + 渠道饼图 + 待跟进/转人工表格 + 认领表单）。`render()` 无参数、注入经 `unsafeHTML`。

### 4.11 `index.ts`（主入口，把所有扩展点接上）

```ts
export const leadPlugin: PluginModule = {
  manifest: leadManifest,
  async setup(ctx) {
    registerKbTool(ctx.tools, store);
    registerQualifyTool(ctx.tools, store);
    registerCaptureTool(ctx.tools, store);
    registerBookTool(ctx.tools, store);
    registerHandoffTool(ctx.tools, store);
    ctx.workflow.validate(leadConversation);
    ctx.server?.registerExtension(leadServerExtension);
    ctx.web?.registerView(leadDashboard);
    // 对话记录回填（与客服同款）
    ctx.events.on((e) => {
      if (e.type === 'run:start' && typeof e.input === 'string') store.appendMessage(`run:${e.runId}`, 'user', e.input);
      if (e.type === 'run:end'   && typeof e.final === 'string') store.appendMessage(`run:${e.runId}`, 'assistant', e.final);
    });
    // 合规护栏
    registerOutputRule({ /* §4.8 */ });
  },
  onStart: async () => {}, onStop: async () => {}, onUnload: async (ctx) => { /* 注销订阅 */ },
};
export default leadPlugin;
```

---

## 5. 多通道接入（让 Agent「真实运行」的关键）

harness 的 Agent 是**通道无关**的。每个渠道只需一个轻量适配器，把消息 + 渠道元数据喂给 `/api/run`：

```
抖音/小红书私信 ─┐
微信客服消息    ─┼─→ channel-adapter ─→ POST /api/run { agentId:'medical-aesthetics-lead', input, meta:{channel,source} }
美团/点评咨询   ─┘
```

适配器负责：鉴权、消息格式归一、把渠道回包发回原平台。Agent 本身只处理 `input` 文本与 `meta.channel`，
业务语义全在插件内。这样一套 Agent 同时吃抖音、微信、美团流量。

---

## 6. 人在回路（Human-in-the-loop）

- **转人工队列**：`handoff` 工具/A2A 把 D 级/投诉会话写进转人工队列，看板展示。
- **咨询师认领**：看板「转人工」卡片带认领表单（`POST /leads/assign`，受 `guard('lead:assign')`），
  认领后该 lead 标记 `consultedBy` + `arrived`。
- **敏感动作审批**：若 `guard('lead:export')` 配了审批策略，看板「导出客资」会走 202 + ticket 审批流（复用现有审批通道）。

---

## 7. 生产化补齐（从 demo 到真实可用）

| 维度 | demo（本蓝图） | 生产 |
| --- | --- | --- |
| 知识库 | 内置语料数组 | **RAG + 向量库**（项目科普/价格/禁忌/真实案例脱敏） |
| 留资存储 | 文件 JSON | **加密 + 脱敏 + PIPL 合规**（手机号哈希、授权留痕） |
| 多渠道 | 手动 POST /api/run | **官方平台 API 适配器**（抖音/微信/美团）+ 限流 |
| 到店闭环 | 标记 `arrived` | **对接 HIS/CRM**（到店/成交回写，真实 ROI） |
| 合规 | 提示词 + 输出护栏 | **人工抽检 + 审计日志 + 敏感词库热更新** |
| 多副本 | 文件后端共享卷 | **Redis 后端**（强一致、实时看板） |
| 可信度 | Mock LLM 演示 | **真实 LLM +  fallback + 评测集** |

---

## 8. 落地步骤与验证（复用 `../02-deployment/run-local.md`）

1. 新建 `plugins/medical-aesthetics-lead/`（package.json 加 `@agent-harness/core` 依赖 + `@types/node`）。
2. `pnpm install`（沙箱用 `../02-deployment/run-local.md` §1.1 绕过）→ `pnpm -r build`。
3. 加 `authz.ts` 动作 `lead:read/lead:assign/lead:export` 并授 admin/operator。
4. 启动（绝对 `MEMORY_DIR`）：
   ```bash
   MEMORY_DIR="$(pwd -W)/.rtdata" PORT=4173 node access/server/dist/server.js
   ```
5. 浏览器开 `http://localhost:4173/` → 侧边栏出现「**客**」Tab（展开即「客资看板」）。
6. 调 `POST /api/run`（`agentId: medical-aesthetics-lead`，模拟抖音私信）→ 看板漏斗 + 对话记录实时更新。
7. 验证合规：输入「保证我做完不留疤」→ 护栏拦截。

---

## 9. 与现有 customer-service 插件的关系

- **并存**：两者 `domain` 不同（`medical-aesthetics` vs `generic`），由 `IntentRouter` 分诊——
  售前咨询走客资 Agent，售后/退款走客服 Agent。
- **共享**：都用同一套文件后端模式、同一套插件工具表、同一套看板渲染机制——新插件几乎是「换业务语义」的复制。
- **演进**：若客资 Agent 跑通，可把 customer-service 的「转人工/满意度」能力**下沉为通用基建**，
  客资 Agent 只聚焦获客转化，避免重复造轮子。

---

### 一句话总结

把「医美客资」当成一个**新的 `plugins/medical-aesthetics-lead` 插件**：用 `ctx.tools` 做问答/留资/预约/转人工，
用 `ctx.workflow` 编排转化漏斗，用 `ctx.server`/`ctx.web` 出客资看板，用 `ctx.events` 回填对话，
用 core 护栏卡死医疗广告合规红线——**业务零侵入 core/server/webapp，结构 100% 复用现有 customer-service 范式**，
照 §4 的代码骨架即可落到能真实运行的系统。
