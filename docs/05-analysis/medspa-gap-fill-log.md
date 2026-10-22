# 医美架构差距补齐 · 落地日志

- 日期：2026-10-22
- 对应分析：`docs/05-analysis/medspa-arch-alignment-review.md`
- 范围说明：原差距清单 14 项（P0/P1/P2）。**P0（企微 SCRM、短信/电话、渠道下发适配器）需要真实平台资质与外部集成，无法在无凭据环境闭环**；本系列只落地可在仓库内真实实现、可编译、可测试的项。**P1 七项 + P2 自动策略闭环已全部落地**，仅剩 P0 渠道集成与其余 P2 增强项列入后续路线。

---

## 第一批已落地（P1 内部项，3 项）

### ⑤ 话术库 / 案例库（三层知识补齐两层）
**缺口**：原 RAG 三层知识只落地「项目知识」，话术库、案例库无表、无内容、无检索入口。
**落地**：
- 新增表 `ma_script`（场景/等级/项目/合规状态）、`ma_case`（脱敏强制 `masked=1`，绝不含 PII/精确追溯）→ `src/infra/db.ts` SCHEMA + `dbHealth` 清单。
- 仓储 `src/repo/library-repo.ts`：`searchScripts` / `searchCases` / `upsertScript` / `upsertCase` / `list*`，LIKE + JS 加权打分，案例强制 `masked` 过滤。
- 检索封装 `src/services/kb-service.ts`（`toScriptView` 合规优先 / `searchScriptsView` / `searchCasesView`）。
- 新工具 `src/tools/library.ts` → `library_search`（script/case/all，脱敏案例绝不回带 `sourceRef`），已在 `src/index.ts` 注册。

### ⑧ 客户偏好 + 成交订单表（复购率/ROI 数据底座）
**缺口**：无偏好字段、无成交/消费表，复购率与 ROI 无数据支撑。
**落地**：
- `ma_lead` 增 `preferences` JSON 列（迁移）→ `src/infra/db.ts` `runMigrations`；`LeadRecord`/`LeadPatch` 增 `LeadPreferences`（`src/repo/types.ts`）；`lead-repo.ts` 读取/合并/写入三处接入。
- 新增表 `ma_order`（订单/金额/状态/院区/来源）→ `src/infra/db.ts`。
- 仓储 `src/repo/order-repo.ts`：`upsertOrder` / `listOrdersByLead` / `orderStats`（复购客户数、复购率、分项目成交）。
- 分析层 `src/analytics/types.ts` + `analytics-service.ts`：新增 `repurchase`（复购率）、`roi`（成交金额；广告花费待 P1-⑨ 接入，`roi=null`+`spendConnected=false`，**不虚构**）；`analytics_query` 工具枚举新增 `repurchase`/`roi`。

### ⑦ 术后关怀 SOP 序列
**缺口**：到店/成交后无自动关怀与复购培育节点。
**落地**：
- `scheduler` 配置新增 `postOpEnabled`、`postOpDays`（默认 `[1,7,30]`，D+1 关怀/D+7 恢复/D+30 培育）→ `src/config.ts`。
- `buildPostOpText(day, name?, project?)` 四段式合规文案（不承诺疗效、附风险提示）→ `src/services/outreach-templates.ts`。
- `planPostOpJobs`（基于 `ma_appointment.arrived_at`，幂等 key `post_op:{leadId}:{day}`，回填护栏避免历史全量补发）、`executeJob` 分支（对已转化客户豁免 skipped、沿用防打扰）、手动排期 `post_op` 支持、`schedulerSnapshot` 展示 → `src/services/scheduler-service.ts`；路由 `POST /scheduler/jobs` 已放开 `post_op` → `src/server/routes.ts`。

---

## 第二批已落地（2 项）

### ④ 模型分级路由（架构头号缺口）
**缺口**：只有单一模型档，无「轻量↔高阶按任务路由」能力，`pricing.ts` 仅记账+预算熔断，`IntentRouter` 选 Agent 不选模型。
**落地**（`backend/core`）：
- 新模块 `src/llm/model-tier.ts`：
  - `resolveTierConfig(input?, env)` 三源解析（配置对象 → 环境变量 → 内置默认**关闭**），读 `AH_MODEL_TIERING` / `AH_LIGHT_MODEL` / `AH_TIER_LIGHT_MAX_CHARS` / `AH_TIER_GREETING_MAX_CHARS`。
  - `resolveTierModel({messages, tools, model, cfg})` 纯函数，保守分级：**仅两类低风险步降级**——
    1. 工具结果**合成步**（历史中最后一条 assistant 带 `tool_calls`）且累计 prompt 字符 ≤ `lightMaxChars`（默认 4000）；
    2. 首轮**极短问答/问候**（消息数 ≤2、无工具 schema、字符 ≤ `greetingMaxChars`，默认 256）。
    其余（首轮复杂推理、多轮推理、大 prompt）一律保持高阶，避免质量回退。
- 接入两个适配器：`src/llm/openrouter.ts`、`src/llm/openai.ts` 各加 `lightModel?` / `modelTiering?` 配置；闭包创建时解析一次，每次调用按 `resolveTierModel` 选模型写入 `body.model` 与 `modelLabel`，并发 `structLog('info','model tier route',{tier,model,reason,promptChars})` 供观测。OpenRouter 的 `models` 降级数组模式下不介入（由上游控制）。
- **harness 调用形态零变更**：仍 `opts.llm(messages, tools, opts)`；成本记账走实际响应 `resp.model`，与既有 `usage-accounting` 一致，路由到轻量模型后成本自动按轻量单价计。
- 降本幅度取决于轻量模型单价，本模块只负责**路由机制**，不对百分比做承诺（原设计文档的 ~30% 为预期区间，非保证）。

### ⑥ 经营日报定时化 + 业务异常预警
**缺口**：经营日报仅工作流注册未调度；无业务异常预警。
**落地**（`plugins/medical-aesthetics-lead`）：
- 新服务 `src/services/report-service.ts`：
  - `generateDailyReport(now)`：汇总 `runAnalyticsQuery({type:'full'})` + `orderStats()`，产出 Markdown 快照（核心指标/渠道表现/项目成交/近 7 日趋势）落库 `ma_daily_report`，并发 info 事件；**当天幂等**（重复调用返回 `null`）。
  - `latestDailyReport()`：取最近一份（看板/API 回溯）。
  - `scanAnomalies(now)`：到院率（`arrived/总线索`）、成交率（`deal/到院`）、复购率、新增线索日环比跌幅四项阈值检查；越界按 `warn`/`error` 分级，经 `getPluginContext().events.emit({type:'alert',...})` 桥接核心 `emitAlert` → Webhook/日志 sink；**同规则冷却去重**（默认 6h，存 `ma_meta`）。
  - `metaGet` / `metaSet`：`ma_meta` 键值读写（节奏守卫 + 告警去重）。
- 新表 `ma_meta`（键值元数据）、`ma_daily_report`（日报快照，主键 `(tenant_id, report_date)`）→ `src/infra/db.ts` SCHEMA + `dbHealth` 清单。
- 接入 `schedulerTick()`：SOP 之后按开关执行日报生成与异常扫描；异常扫描额外按 `max(cooldown/4, 15min)` 节流，避免每 60s 跑全量聚合。日报/异常异常被 catch 包裹，不影响 SOP 主流程。
- 配置 → `src/config.ts`：`dailyReportEnabled`、`anomalyEnabled`、`anomalyCooldownMs`、`arrivalRateMin`(0.15)、`dealRateMin`(0.20)、`repurchaseRateMin`(0.10)、`newLeadDropPct`(60)，均已进 `configSummary`。
- 新路由 `GET /report`（最新经营日报）→ `src/server/routes.ts`。

### 新增回归测试
- `backend/core/test/model-tier.test.cjs`：10 例（默认关闭、env 开启、配置优先+自定义阈值、轻量=高阶不起作用、首轮极短问候降级、首轮长问题保持高阶、合成步降级、合成步超阈值保持高阶、多轮复杂推理保持高阶）。
- `plugins/medical-aesthetics-lead/test/report-anomaly.test.cjs`：4 例（日报汇总+幂等+取回、空数据 fail-closed 0 值、到院率越界告警+冷却去重、无数据不告警）。

---

## 第三批已落地（2 项）

### ⑩ 视频脚本生成
**缺口**：内容工厂只有图文平台，无短视频脚本能力。
**落地**（`plugins/medical-aesthetics-lead`）：
- `ContentPlatform` 类型与 `CONTENT_PLATFORMS` 白名单新增 `video_script` → `src/repo/content-repo.ts`、`src/services/content-service.ts`；`content_draft` 工具枚举与描述同步放开 → `src/tools/content.ts`。
- 新骨架 `buildVideoScriptBody()`：**五段式分镜**（钩子 0-3s → 科普 3-15s → 适用与恢复 15-25s → 注意事项 25-30s → 风险提示+引导面诊 30-35s），每镜头含 `画面/口播/字幕` 三要素。
- 纪律与图文模板一致：全部事实性内容来自知识库字段，**缺字段跳过该镜头绝不补写**；钩子只用疑问框架（不承诺效果）；末镜固定风险提示 + 「以面诊方案为准」收口；生成后仍过 `medicalAdRules` 合规筛查。
- `content_id = tpl_video_script_{projectId}_{YYYY-MM-DD}`，沿用既有同日幂等语义；入审状态机（draft→review→approved→published）不变。

### ⑨ 投放平台对接 + ROI 数据底座
**缺口**：ROI 只有分子（成交金额）没有分母（广告花费），`roi` 长期为 `null`。
**落地**（`plugins/medical-aesthetics-lead`）：
- 新表 `ma_ad_spend`（`spend_date` × `channel` × `campaign_id` 自然键 + `spend`/`impressions`/`clicks`/`conversions`/`source`）→ `src/infra/db.ts` SCHEMA + `dbHealth` 清单；`UNIQUE(tenant_id, spend_date, channel, campaign_id)` 保证重复导入/拉取**幂等覆盖**。
- 仓储 `src/repo/ad-spend-repo.ts`：`upsertAdSpend`（批量、fail-fast 校验日期格式/非负花费/非空渠道）、`listAdSpend`、`adSpendStats`（总花费 + 分渠道 + 分日，空数据全 0）。
- 客户端 `src/services/ad-client.ts`：可插拔契约 `POST {MA_AD_PLATFORM_BASE_URL}/v1/spend/report`（带 `advertiserId`），`pullAdSpend(startDate, endDate)` 拉取即落库；**未配置 → 返回 `pulled:false` + note，不抛错、不清空既有数据**。
- `roiAnalysis` 接入真实分母：`spend.rowCount>0 && totalSpend>0` 时 `spendConnected=true`、`adSpend` 真实值、`roi = 成交金额/花费`、`cpl = 花费/转化数`；无数据仍 `spendConnected=false` + `roi/cpl=null`，**绝不虚构**。`RoiAnalysis` 类型新增 `cpl` / `spendMetrics` / `byChannel`。
- 新路由：`POST /ad-spend/import`（管理令牌，**无 API 资质时的手动导入诚实路径**）、`GET /ad-spend`（明细+汇总）。
- 配置 → `src/config.ts`：`adPlatform`（`MA_AD_PLATFORM_*` + `MA_AD_PLATFORM_KIND` + `MA_AD_PLATFORM_ADVERTISER_ID`），已进 `configSummary`；`infra/http.ts` 的 `UpstreamName` 新增 `AD_PLATFORM`。

### 新增回归测试
- `plugins/medical-aesthetics-lead/test/video-adspend.test.cjs`：8 例
  - 视频脚本：五段式分镜结构 + 合规收口（无疗效承诺、面诊为准、末镜风险提示）、KB 缺字段跳过对应镜头不编造、手写违规脚本被拒且不落库；
  - 广告消耗/ROI：导入汇总正确 + 同日同计划幂等覆盖、有花费出真实 ROI/CPL、无花费 `null` 不虚构、非法输入 fail-fast、平台未配置时 `pullAdSpend` 不清空数据。
- 同步更新 `test/content.test.cjs`：全平台生成断言 3 → **4**（新增 video_script）。

---

## 验证

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| core 类型检查 | `tsc -p tsconfig.json` | 0 错误 |
| core 模型分级 | `node --test test/model-tier.test.cjs` | 10/10 通过 |
| core LLM 回归 | `node --test test/llm.test.cjs test/llm-failover.test.cjs test/llm-citations.test.cjs test/cost.test.cjs` | 30/30 通过 |
| 插件类型检查 | `tsc -p tsconfig.json` | 0 错误 |
| 插件全量测试 | `node --test test/*.test.cjs` | **89/89 通过**（新增 22 例） |

---

## 后续路线（未落地，附架构方案与依赖）

### P0 —— 需真实平台资质 / 外部集成（无法在无凭据环境闭环）
1. **企微 SCRM 适配器**：在 `access/server/src/im/` 范式下新增 `externalcontact`（客户联系备注/标签/客户群/获资表单），配置组 `IM_WECOM_SCRM_*`；最小闭环=标签+获资表单→webhook 入站。依赖：企业微信第三方应用凭证（corpid/secret/agentid）。
2. **渠道下发适配器**：把 `OutreachClient` 从单一网关契约扩展为内置渠道适配器注册表（企微 `message/send` 单客户文本 + 短信网关阿里云/腾讯云任一），与 outbox 至少一次投递衔接；webhook 侧按 `channel` 解析回话路由。依赖：①的 SCRM 凭证 + 短信网关密钥。
3. **到店确认自动化**：预约前 1 天/当天经短信/企微触达确认（复用 recall 范式），`markArrived` 回流到店率。依赖：②。

### P1（续）
4. **模型分级路由增强（④ 续）**：当前为规则式保守分级；后续可在登记两档单价后引入「预估成本 vs 预算」动态决策，并对「工具数量多 / 计划任务」等高复杂信号加高阶保护。

### P2
5. **自动策略闭环（已落地，见第四批）**：规则引擎基于日报真实指标产出建议 → 人工确认 → 标记执行。
6. **官网公开留资页**：webapp 增加免登录留资页（consent 强制 + 走 `/webhook` 入站）。
7. **小红书/抖音官方 API 直连**：资质落地后按 `im/` 适配器契约各写私信 adapter。
8. **小程序触点**：C 端自助立项。

---

## 第四批已落地（2 项）

### ⑨（续）广告消耗定时拉取
**缺口**：投放消耗只能手动导入，无法自动同步。
**落地**（`plugins/medical-aesthetics-lead`）：
- `schedulerTick()` 新增每日一次的 `pullAdSpend(昨日, 今日)` 调用，用 `ma_meta` 的 `scheduler:last_ad_spend_pull` 做 20h 节流守卫（避免重启后同一天重复拉取）。
- 配置 `scheduler.adSpendPullEnabled`（`MA_AD_SPEND_PULL`，默认开）→ `src/config.ts`，已进 `configSummary`。
- 平台未配置时 `pullAdSpend` 返回 `pulled:false` + note，**静默跳过、不抛错、不清空既有导入数据**。

### P2 自动策略闭环
**缺口**：架构第六层「数据回流 → 策略与模型持续优化」只有日报/预警，无「可执行建议」环节。
**落地**（`plugins/medical-aesthetics-lead`）：
- 新表 `ma_strategy_suggestion`（规则/严重度/标题/详情/动作/证据 JSON/状态机），`suggestion_id = sug_{rule}_{YYYY-MM-DD}` **当天幂等**。
- 新服务 `src/services/strategy-service.ts`：
  - `evaluateStrategyRules()` **纯函数规则引擎**，五条规则全部基于真实指标：
    `improve_arrival`（到院率低→强化到店提醒与回捞配置）、`improve_deal`（成交率低→补话术库/案例库覆盖）、
    `improve_repurchase`（复购率低→加强术后关怀与复购培育）、`check_lead_drop`（新增日环比大跌→核查投放与留资渠道）、
    `optimize_ad_cpl`（CPL 偏高→优化投放渠道结构，仅有花费数据时触发）。
  - `generateStrategySuggestions()`：取 `full` 分析 + `orderStats` + `adSpendStats` 真实指标 → 落库；**分母为 0 的规则不产出**（没有证据就不给意见）；有 error 级建议时发一条 warn 告警提醒运营。
  - `reviewSuggestion(id, 'approved'|'rejected', operator, reason?)`：人工确认；**rejected 必须给原因**（与内容驳回同一纪律）；仅 pending 可再审。
  - `markSuggestionExecuted(id)`：标记执行；**仅 approved 可执行**——人工确认是不可绕过的硬闸门，引擎绝不自动执行经营动作。
- 接入 `schedulerTick()`（日报之后，配置 `scheduler.suggestionEnabled` / `MA_STRATEGY_SUGGESTION`）。
- 新路由：`GET /strategy`（列表+计数）、`POST /strategy/review`（管理令牌，人工确认）、`POST /strategy/execute`（管理令牌，标记执行）。

### 新增回归测试
- `plugins/medical-aesthetics-lead/test/strategy.test.cjs`：10 例
  - 规则引擎纯函数：健康指标无建议、三项比率越界各产一条（含严重度分级）、日环比大跌、CPL 偏高/无数据不触发、分母为 0 不触发；
  - 生命周期：落库+当天幂等、`pending→approved→executed` 全链、未确认直接执行被拒、终态不可再审、rejected 必须给原因、不存在明确报错；
  - `schedulerTick` 集成：平台未配置时静默跳过且不清空既有数据。

---

## 落地点检清单

- [x] ⑤ 话术库/案例库：表+repo+检索+工具
- [x] ⑧ 偏好列+订单表+复购/ROI 分析
- [x] ⑦ 术后关怀 SOP 序列
- [x] ④ 模型分级路由（core，规则式保守分级，harness 零变更）
- [x] ⑥ 经营日报定时化 + 业务异常预警（含告警冷却去重）
- [x] ⑩ 视频脚本生成（五段式分镜 + 合规收口 + 缺字段不编造）
- [x] ⑨ 投放数据底座 `ma_ad_spend` + 可插拔客户端 + 真实 ROI/CPL + 定时拉取
- [x] P2 自动策略闭环（规则引擎 → 人工确认 → 标记执行，人工硬闸门）
- [x] core + 插件类型检查 0 错误；插件全量测试 89 通过
- [ ] P0 渠道集成（企微 SCRM / 渠道下发 / 到店确认，待平台凭证）
- [ ] P2 增强（官网留资页 / 官方 API 直连 / 小程序）

---

## 环境备注（踩坑记录）

- 本机 TypeScript 为 **7.0.2（原生 Go 版）**。实测：`dbHealth()` 中 `for (const t of [ ...多行数组... ])` 在数组元素超过一定数量后会被误报 `TS1137/TS1472` 语法错误（报错行指向 `}]) {`）。规避方式：把该数组提为单行 `const tables = [...]` 再 `for (const t of tables)`。已按此改写，编译 0 错误。
- 排查此类「看似合法的语法错误」时，避免用 `grep -c ... && git stash pop` 链式命令——`grep -c` 计数为 0 时返回退出码 1，会导致后续 `stash pop` 不执行、改动滞留 stash（本次曾因此误判）。
