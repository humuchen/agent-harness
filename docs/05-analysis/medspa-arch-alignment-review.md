# 医美营销 Agent 参考架构 × agent-harness 实际实现对齐分析

- 分析日期：2026-10-22
- 参考文档：`/Users/huyang/Downloads/medspa_marketing_agent_arch.html`（医美营销 / 运营 AI Agent 参考架构，6 层）
- 分析对象：`agent-harness` monorepo（通用多智能体 Agent 平台 + 医美业务插件）
- 分析方法：逐模块源码核对（非仅凭 README），所有结论附文件 / 行号证据

---

## 0. 总体判断

`agent-harness` 的本体是**通用多智能体 Agent 平台**（harness 主循环、护栏、记忆、MCP、DagEngine、A2A、插件框架、RBAC/审批等）；医美营销域能力通过三个可插拔部件落地：

| 部件 | 位置 | 角色 |
| --- | --- | --- |
| 医美客资插件 | `plugins/medical-aesthetics-lead`（src 约 9800 行） | 获客 / 初筛 / 预约 / 内容工厂 / SOP / A/B / 运营分析 |
| 医疗广告合规护栏 | `backend/medical-ad-guard` | 违禁词规则引擎（输入/输出双向） |
| RAG 服务 | `services/rag` | 混合检索知识库（HTTP + MCP 双栈） |

**对齐度总览**：输出闸门、内容工厂、私域 SOP、RAG 引擎、多模型协议五块与设计意图高度一致（部分超出设计）；**触点渠道层偏差最大**（真实集成的只有 3 个企业 IM 入口 + 一套通用 webhook/网关抽象，SCRM、短信、电话、官网留资均缺失）；**模型分级路由**与**投放优化**、**数据回流闭环**存在明确缺口。平台整体工程质量高（fail-closed、幂等、脱敏、先审后发），缺口集中在「渠道真实集成」与「业务闭环自动化」两类。

---

## 1. 触点渠道层

设计：企业微信 SCRM（私域主战场）/ 小红书·抖音（内容种草）/ 官网·小程序（留资获客）/ 电话·短信（到店确认）。

### 已实现且与设计一致

- **企业微信作为 IM 入口**：`access/server/src/im/adapter-wecom.ts` —— 验签（sha1 + 300s 时间窗）、AES-256-CBC 解密、echostr 握手、收消息（文本）、**回消息**（单聊 `message/send`、应用群 `appchat/send`，L178-206）；bridge 立即 ack + 后台执行 + 回发。飞书 / 钉钉同契约实现。
- **统一入站工程范式**：`plugins/medical-aesthetics-lead/src/server/routes.ts:297-340` —— HMAC 验签 → 落库去重（UNIQUE(tenant, channel, external_id)）→ A2A 唤起 agent；出站有发件箱（outbox-worker，至少一次投递 + 幂等键 + 退避重试）。
- **渠道归因数据模型**：`ma_lead.channel` 自由字符串（抖音/小红书/微信/美团/官网），支撑渠道效果分析。

### 存在偏差

- **「企业微信 SCRM」只做了 IM 入口，没做 SCRM**：全仓无 `externalcontact`（客户联系）、标签、客户群运营、朋友圈、获客表单任何代码；群聊还仅限「应用自建群」（adapter-wecom.ts:180-182 注释自述普通客户群不可直接发言）。
- **小红书 / 抖音只有抽象、没有官方 API 集成**：`xiaohongshu/douyin` 是 `ContentPlatform` 枚举值（content-repo.ts:14）和 channel 字符串；入站靠一套通用 HMAC webhook（signature.ts:34-64，平台侧签名由对接网关消化）；出站靠可插拔网关契约（`POST {MA_OUTREACH_BASE_URL}/v1/content/publish`）。`docs/04-agents/medical-aesthetics-rollout-checklist.md:6-9` 将「平台资质申请（抖音/小红书官方 API）」列为待办。
- **入站 → 出站下行未闭合**：WEBHOOK_INTEGRATION.md 自述「agent 文本回复推回客户所在的微信/抖音会话尚未实现——属于渠道下发适配器」。

### 设计但未实现 / 不完整

- **短信**：全仓无任何短信 SDK/网关（outreach-client.ts:8 仅为未来备注；prompts.ts:49 明令禁止模型承诺短信/电话回访）。
- **电话 / 语音**：零集成（到店确认目前是内部状态机 `markArrived`，非电话触达）。
- **官网 / 落地页留资表单**：`frontend/webapp` 全登录门控（main.ts:38,120-158），唯一开放视图是登录页；无 C 端公开表单。
- **小程序**：全仓零命中；`mobile/` 是内部控制台的 Capacitor 壳，非 C 端应用。

---

## 2. 输出闸门（违禁词规则引擎 + 人工确认 HITL）

### 已实现且与设计一致（本项目最强对齐模块）

- **违禁词规则引擎**：`backend/medical-ad-guard/src/index.ts` —— 5 组医疗广告法违规模式（疗效/安全绝对化、诊断式话术、术前术后对比、固定价承诺、贬低同业），输入/输出双向注册，`scope='medical-ad'` 隔离（未选医美 agent 不误伤）；另有**上下文感知规则**：KB 查空（`found:false`）后禁止模型自行推荐具体项目，回退「建议面诊」（超出原设计的硬保障）。
- **人工确认（先审后发）**：`content-service.ts` 状态机 `draft → review → approved → published`，送审前复跑红线、过审是发布唯一放行点、驳回必须给原因、发布失败保持 approved 可重试、统一追加风险提示。
- **平台级审批工作流**：`access/server/src/approval.ts`（202 工单 + approve/reject，可绕过角色控制），覆盖敏感动作。

### 存在偏差

- **SOP 自动触达与 A/B 变体只过规则筛查、不经人工确认**：welcome/recall 由调度器直接发送（模板预审可接受）；但运营新建的 A/B 变体文案、生日/复购手动排期文案同样仅过正则筛查即入队（ab-service.ts:61-67、scheduler-service.ts:197-203）。1v1 对话回复也只过护栏不过人工。即「对外内容先过审再发送」对**内容工厂**完全成立，对**自动触达**是规则级闸门而非人工闸门。

---

## 3. Agent 编排层

设计：话术助手 / 内容工厂 / 私域 SOP / 投放优化 / 数据洞察（Dify/LangGraph）。

### 3.1 话术助手（1v1 私聊 · 异议应对 · 候选回复生成）——偏差

- 实际落地三件套：`lead_qualify`（结构化抽取 + A/B/C/D 分级）、`lead_handoff`（转人工 + session 绑定防注入）、`lead_briefing`（咨询师简报：画像/脱敏联系方式/对话摘录/预约与触达记录/**规则化跟进建议**，assist-service.ts:105-139）。
- **缺失**：「候选回复生成」——没有为咨询师生成若干候选话术供选择/改写的 copilot 能力；异议应对依赖 prompt 纪律而非专用模块。

### 3.2 内容工厂（图文/视频脚本 · 批量生成 + 过审）——基本一致，视频缺

- 已实现：三平台模板批量生成（`generateTemplateContent`，同日幂等）、运营/LLM 手写草稿（`source: 'manual' | 'llm'`）、先审后发、经网关发布（content-service.ts:130-309）。
- **缺失**：视频脚本（仅图文笔记/口播文本）；LLM 起草无专用生成链路（仅允许手写文案标记 source=llm）。

### 3.3 私域 SOP（术后关怀 · 复购提醒 · 按周期自动触达）——基本一致，术后关怀缺

- 已实现：`scheduler-service.ts` 周期 tick 规划 + 消费；welcome（新客窗口）、recall（沉默 2h/24h 两节点回捞）、birthday/repurchase（运营手动排期，fail-closed 要文案）；执行前复查防打扰（已转化/转人工/D 级跳过）；文案过合规筛查；A/B 分流接入。
- **缺失**：**术后关怀序列**——到店（arrived/deal）后的关怀/复购培育无自动节点（repurchase 仅有手动排期一种形态；analytics 的 inactiveLeads 未接回 SOP）。

### 3.4 投放优化（素材迭代 · 人群策略 · ROI 归因建议）——部分对齐

- 已实现：A/B 实验框架（ab-service.ts）——sticky 分流（sha256 确定性分桶 + 物化）、reply/booking/arrived 三口径转化归因（按「分配之后发生」）、样本量 <30 诚实提示、变体文案合规筛查。
- **缺失**：广告平台 API 对接、投放素材迭代链路、人群策略（人群包/ lookalike）、**广告 ROI 归因**（无广告花费数据接入）。现有 A/B 作用于 SOP 触达文案，不作用于投放素材。

### 3.5 数据洞察（经营日报 · 漏斗分析 · 异常预警）——分析对齐，日报/预警缺

- 已实现：`analytics-service.ts` 七类真实 SQL 聚合（漏斗+阶段耗时、渠道性能、院区业绩+号源利用率、项目毛利、时间趋势、阶段留存、未活跃线索）、CSV 导出（含公式注入防护）、看板视图、`analytics-report` DAG 工作流（委派 operations-analyst 子 agent）。
- **缺失**：**定时经营日报**——`analyticsReportWorkflow` 仅 `validate()` 注册，无调度触发（scheduler-service 只管 SOP 触达）；**业务异常预警**——只有基础设施级告警（emitAlert/Prometheus/Grafana），无业务指标（如到店率骤降）的异常检测与推送。

### 3.6 编排技术栈

采用自研 `DagEngine` + `AgentRegistry` + `TeamManager` + `SubAgent` + A2A，而非 Dify/LangGraph——**能力等价**（DAG 依赖、并行、补偿、子 agent 派生、跨主机派发），技术选型偏差但不应视为缺口。

---

## 4. 能力层

### 4.1 RAG 知识库（话术库 · 案例库 · 项目知识）——引擎完整，内容缺两层

- **RAG 引擎（超出设计）**：`services/rag` 零运行时依赖全栈——混合检索（dense + 真 BM25，RAG_FUSE_*）、MMR + cross-encoder（Jina/Cohere 兼容）重排、multi-query RRF + HyDE、parent-child、SQLite/Memory/Qdrant 三种向量库、三种 embedding 后端、HTTP + MCP stdio 双栈、eval（Recall/Precision/NDCG/Faithfulness）+ golden 回归。
- **消费链路**：core `builtin__rag_retrieve`（配 RAG_URL 即注册）+ MCP 双路；医美侧 `project_kb_search` → 外部 RAG 或本地库（kb-service.ts，fail-closed 绝不伪造）。
- **缺口**：三层知识只落地「项目知识」一层；**话术库、案例库无表、无灌入内容、无检索入口**（仅有代码级 SOP 模板 outreach-templates.ts 与 A/B 变体表 ma_ab_variant；`docs/04-agents/medical-aesthetics-lead-agent.md:335` 把「真实案例脱敏」列为生产化目标）。

### 4.2 工具调用（企微 API · CRM · 投放平台）——大部分一致

- 已实现：CRM 同步客户端（crm-client.ts，真实 REST + fail-closed + outbox 重试 + callback 回执）、HIS 预约同步（his-client.ts）、企微 API（IM 收发）、MCP 框架（任意 server 运行时接入）。
- **缺失**：投放平台工具（与 3.4 同源）。

### 4.3 客户记忆（画像 · 偏好 · 服务履历）——画像一致，偏好缺，履历部分

- **画像**：`ma_lead` 字段齐全（渠道/意向/项目/预算/城市/等级/阶段/授权/联系方式/转人工/CRM 同步状态，types.ts:35-67）。
- **偏好**：无任何偏好字段（LeadRecord/LeadPatch 均无）。
- **服务履历**：对话（ma_lead_message，保留近 200 条）+ 预约到店（ma_appointment，arrived/completed）+ 阶段流水（ma_lead_stage_log）+ SOP 触达记录（ma_schedule_job）；**无成交后消费/订单表**，履历截至到店闭环。
- 备注：core 自身记忆（memory.ts window/longTerm/sessionKey）是纯会话向，与客户画像无代码关联——跨会话客户记忆中枢不存在（但插件内 CRM 式主表已覆盖单客户档案）。

---

## 5. 模型底座

### 已实现且与设计一致

- **OpenAI 兼容协议、不绑定单一模型**：统一 `LLM` 契约（types.ts:104-108），两个适配器均走 Chat Completions wire format；`OPEN_BASE_URL` 可整体换端点；BYOK（provider-keys.ts，AES-GCM 落库、per-run 注入）+ 自定义模型（custom-models.ts，前端可填任意 baseUrl+Key）；DeepSeek/通义/GLM/豆包可经 OpenRouter slug 或直连同源端点使用（无厂商 first-class 适配器，但与设计意图不悖）。
- **韧性**：provider 级熔断故障转移（failover.ts，OpenRouter primary + OpenAI secondary）、HTTP 级熔断（circuit-breaker.ts）、多 key 均衡（multi-key.ts）、429/5xx 指数退避。
- **token 级降本**：prompt cache、工具 schema 压缩、上下文压缩摘要、reasoning effort 收窄、成本记账 + per-run 预算熔断。

### 设计但未实现

- **「轻量 ↔ 高阶，按任务分配」的模型分级路由：完全缺失**。全仓无 tier/lightweight 等分级逻辑；一次 run 只装配一个 LLM 实例（runner.ts:512-575）；IntentRouter 选的是 Agent 不是模型（且其 llm 分类模式复用同一默认模型，intent.ts:344-345）；pricing.ts 只做成本记账与预算熔断，不做选型决策。架构宣称的「成本降约 30%」无对应实现（现有降本均为 token 级，非模型级）。
- OpenRouter 服务端 `models` 降级数组是库级能力但 server 装配路径从未配置（openrouter.ts:69-74）。

---

## 6. 数据回流闭环

设计：到店率 / 复购率 / ROI 效果数据 → 数据资产沉淀 → 策略与模型持续优化。

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| 到店率 | 已实现 | channel/clinic 分析 + markArrived + A/B arrived 口径 |
| 复购率 | 缺数据 | 无消费/订单表；repurchase 仅为手动排期任务类型 |
| ROI | 缺数据 | 无广告花费/投放数据接入 |
| 数据资产沉淀 | 已实现 | ma_* 17 表 + RAG 索引 + 记忆后端 + 运行配方版本化 |
| 策略与模型持续优化 | 部分 | 平台级：eval（RuleBasedEvaluator）+ recipe 版本化回归比对；业务级：效果→策略为人工闭环（看板/导出），无自动策略调整；「模型持续优化」无任何反馈链路 |

---

## 7. 差距清单（按优先级）

### P0 —— 主渠道与合规闭环（不补则「私域主战场」名不副实）

1. **企微 SCRM 能力缺失**：客户联系（externalcontact）、标签、客户群运营、朋友圈、获客表单均无（adapter-wecom.ts 仅 gettoken/message/send/appchat/send）。
2. **对客消息下行通道未闭合**：agent 回复推回客户所在会话的「渠道下发适配器」未实现（WEBHOOK_INTEGRATION.md 自述）；当前唯一出口是可插拔网关（默认未配置，fail-closed 积压）。
3. **短信 / 电话到店确认缺失**：架构明确列出的触点，全仓无集成。

### P1 —— 运营闭环完整性

4. **模型分级路由缺失**：轻量 ↔ 高阶按任务分配无实现，「降本 30%」无落点。
5. **话术库 / 案例库缺失**：RAG 三层知识只落一层；话术仅代码模板，案例仅规划。
6. **经营日报定时化 + 业务异常预警缺失**：analytics-report 工作流未调度；无业务指标异常检测。
7. **术后关怀 SOP 缺失**：到店/成交后无自动关怀与复购培育序列。
8. **客户偏好记忆缺失；成交后消费履历缺失**（无订单/消费表）。
9. **投放优化停留在 A/B 实验**：无广告平台对接、素材迭代、人群策略、广告 ROI 归因。
10. **视频脚本生成缺失**（内容工厂仅图文/口播文本）。

### P2 —— 增强项

11. 官网 / 落地页公开留资表单缺失（当前 webapp 全登录门控）。
12. 小红书 / 抖音官方 API 直连（目前依赖对接网关消化平台签名）。
13. 小程序触点缺失。
14. 效果数据 → 策略的自动优化闭环（当前为人工看板闭环）。

---

## 8. 补齐建议（按优先级）

### P0（建议先行）

1. **企微 SCRM 适配器**：在 `access/server/src/im/` 范式下新增 `externalcontact` 系列调用（客户联系备注/标签/客户群管理），配置组 `IM_WECOM_SCRM_*`；优先做「标签 + 获客表单留资 → webhook 入站」最小闭环，直接补上架构中「私域主战场」的入站环节。
2. **渠道下发适配器**：把 `OutreachClient` 从「单一网关契约」扩展为「内置渠道适配器注册表」——首批实现企微 `message/send`（单客户文本）与短信网关（阿里云/腾讯云任一），与 outbox worker 的至少一次投递天然衔接；webhook 侧按 `channel` 解析回话路由（IM 用户→会话映射已有先例：im/bridge.ts 的 owner 映射）。
3. **到店确认自动化**：预约日前一天/当天由 scheduler 经短信/企微触达确认（topic 已有 recall 范式可复制），`markArrived` 打卡后回流到店率。

### P1

4. **模型分级路由**：在 `runner.ts` 的 `effectiveModel` 决策点前增加分级器——按任务特征（意图复杂度/预估步数/是否含工具）选轻/重两档模型（登记两档单价后可用 pricing.ts 做成本预估）；先做规则式分级（零依赖、可解释），再演进为学习式；与现有 failover 正交叠加。
5. **话术库 / 案例库**：新增 `ma_script`（话术：场景/客户等级/合规状态）与 `ma_case`（案例：脱敏字段强制）两张表，经现有 `project_kb_search` 同款检索入口暴露；灌入走现有 RAG ingest 链路；案例库字段级脱敏复用 medical-ad-guard 审查状态位。
6. **经营日报 + 业务预警**：给 analytics-report 工作流加 cron 式调度（复用 scheduler 的 tick 范式或平台计划模式）；新增业务异常规则（到店率/留资量环比阈值）→ 接现有 `emitAlert`/ALERT_WEBHOOK_URL 推送。
7. **术后关怀 SOP**：在 planSopJobs 增加 post_op 序列节点（到店后 D+1/D+7/D+30），素材来自 KB 恢复期字段；执行前复查沿用现有防打扰逻辑。
8. **偏好与消费履历**：`ma_lead` 增偏好 JSON 列（沟通渠道偏好/项目偏好/价格敏感度）；新增 `ma_order`（成交/消费/项目/金额）——同时补上复购率与真实 ROI 的数据底座。
9. **投放优化**：先接一个广告平台（巨量/腾讯广告 API）拉取消耗与转化，ROI = 归因成交 / 消耗；素材迭代复用 A/B 框架（topic 扩展到 creative）；人群策略可后置。
10. **视频脚本**：内容工厂增加 `video_script` 平台类型与分镜模板（钩子/科普/风险提示/引导面诊四段式，字段仍只来自 KB）。

### P2

11. **公开留资表单**：webapp 增加免登录留资页（consent 强制 + 直接走 `/webhook` 入站），与登录门控并存。
12. **平台官方 API 直连**： rollout-checklist 的资质申请落地后，按 im/ 适配器契约为小红书/抖音私信各写一个 adapter。
13. **小程序**：若业务需要 C 端自助（预约/咨询），单独立项；当前 mobile 壳不变。
14. **自动策略闭环**：在日报/预警之上增加「建议动作」生成（规则式：如某渠道到店率低于阈值 → 建议下调预算/更换话术变体），人工确认后执行——与平台既有审批工作流天然衔接。

---

## 附录：核对方法与范围

- 阅读范围：backend/core/src（llm/router/memory/builtins/workflow 等）、access/server/src（im/runner/approval 等）、plugins/medical-aesthetics-lead/src 全量、backend/medical-ad-guard、services/rag、frontend/webapp 入口、docs/04-agents 相关设计文档。
- 判定口径：「已实现」= 有真实代码路径（非仅文档/枚举值）；「抽象已备」= 契约/配置/枚举存在但无真实平台集成；「缺失」= 无代码无数据。
- 未做运行时验证（未启动服务跑链路）；结论基于静态源码核对。
