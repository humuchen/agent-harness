# 医美客资插件 · 重构交付文档

> 重构目标：**移除写死的假数据**，改为通过**真实业务调用链路**（真实 SQL 落库、真实 REST 出网、真实 webhook 验签）动态获取与填充数据。所有数据来源真实可用，**绝不模拟**。

---

## 0. 核心设计原则

| 原则 | 落地方式 |
| --- | --- |
| **零内置业务数据** | 源码不再包含任何项目语料 / 院区 / 号源 / 线索样本。`PROJECT_CORPUS` 硬编码数组已删除，知识库内容只来自运营导入接口或外部 KB 服务落库。 |
| **fail-closed（失败关闭）** | 某能力依赖的后端未配置时，对应工具 / 接口返回明确的 `NOT_CONFIGURED` 错误，**绝不退化为假数据、也绝不假装成功**。例如 CRM 未配置时线索照常落本地库，但同步状态标记为 `disabled` 并据实告知。 |
| **真实 HTTP 客户端** | 超时（`AbortSignal.timeout`）、指数退避重试（仅 429/5xx/网络错误）、幂等键（`Idempotency-Key`）、HMAC 验签、脱敏日志。无任何 mock 分支。 |
| **事务防超卖** | 号源占用走 `BEGIN IMMEDIATE` 事务 + 条件更新（`booked < capacity`）+ 唯一索引兜底，天然防并发超卖。 |
| **至少一次投递** | CRM/HIS 同步经发件箱（outbox）异步投递，失败指数退避重排，达到上限标记 `failed`，确保上游抖动不丢客资。 |
| **非侵入式** | 插件只通过 `PluginContext` 调用 core 公共 API，不修改 core 源码；server / web 宿主由运行时注入。 |

---

## 1. 目录结构（重构后）

```
plugins/medical-aesthetics-lead/
├── src/
│   ├── index.ts                 # 插件主入口：注入 ctx、注册工具/路由/看板、事件桥接、worker 生命周期
│   ├── config.ts                # 配置唯一入口（env 解析 + fail-closed 判定）
│   ├── manifest.ts              # 能力清单（→ AgentCard → 路由）
│   ├── prompts.ts               # 系统提示词（含医疗广告合规红线）
│   ├── runtime.ts               # 运行时单例：currentRunKey + pluginCtx（供路由经 A2A 触发 agent）
│   ├── infra/
│   │   ├── errors.ts            # MaError 错误分类（NOT_CONFIGURED/UPSTREAM_*/DB_ERROR…）
│   │   ├── http.ts              # 真实 REST 客户端（超时/退避/幂等/脱敏）
│   │   ├── db.ts                # node:sqlite 接入（WAL、幂等 DDL、事务、dbHealth）
│   │   └── signature.ts         # webhook HMAC 验签 + 管理令牌校验
│   ├── repo/                    # 真实数据访问层（参数化 SQL，零内置数据）
│   │   ├── types.ts             # 领域模型（LeadRecord / ProjectRecord / SlotRecord …）
│   │   ├── lead-repo.ts         # 线索 UPSERT / 消息归集 / SQL 漏斗聚合 / 认领
│   │   ├── transcript-repo.ts   # 运行期对话记录（与主线索物理隔离）
│   │   ├── kb-repo.ts           # 知识库检索（LIKE 初筛 + 加权打分，库空即空）
│   │   ├── schedule-repo.ts     # 院区/号源/预约单（事务锁号防超卖）
│   │   ├── outbox-repo.ts       # CRM/HIS 同步发件箱（至少一次投递）
│   │   └── inbound-repo.ts      # 渠道入站消息落库（UNIQUE 去重防重放）
│   ├── services/                # 业务编排层（工具 → repo + 外部客户端）
│   │   ├── lead-service.ts      # qualify/capture/handoff + CRM 同步入队
│   │   ├── schedule-service.ts  # bookConsultation（真实可用性校验 + 事务锁号 + HIS 同步）
│   │   ├── kb-service.ts        # 知识库检索出口（db / 外部 KB 服务）
│   │   ├── crm-client.ts        # CRM 真实 REST 客户端
│   │   ├── his-client.ts        # HIS 预约真实 REST 客户端
│   │   └── outbox-worker.ts     # 后台投递循环（start/stop + 指数退避）
│   ├── tools/                   # 5 个 agent 工具（薄封装，调用 services，errorResult 回灌）
│   │   ├── qualify.ts  capture.ts  book.ts  handoff.ts  kb.ts
│   ├── server/routes.ts         # HTTP 路由（统计/明细/认领/导入/webhook/health）
│   └── web/dashboard.ts         # 客资看板（读真实 SQL 聚合 + 同步健康）
├── package.json  tsconfig.json  smoke.cjs   # 构建脚本 + 端到端冒烟
```

---

## 2. 整段 Agent 运行调用链路（从入口触发到各节点流转）

### 入口 A — 对话中工具调用（最常见路径）

```
用户消息
  │  (LLM 决定调用工具)
  ▼
harness.run → 工具分发（plugins 工具表前缀 medical-aesthetics-lead__）
  │
  ├─ lead_qualify ─────► lead-service.qualifyLead
  │                      ├─ repo/lead-repo.upsertLead        → ma_lead (UPSERT, 阶段单调推进)
  │                      ├─ repo/transcript-repo.attachRunTranscript → ma_lead_message (归集当次对话)
  │                      └─ repo/outbox-repo.enqueue('lead.upsert') → ma_outbox (CRM 异步同步, 至少一次)
  │
  ├─ lead_capture ─────► lead-service.captureLead
  │                      ├─ repo/lead-repo.upsertLead(wechat/phone, consentAt, stage=captured)
  │                      └─ outbox.enqueue('lead.upsert') → ma_outbox
  │
  ├─ consultation_book ┺ lead-service.bookConsultation
  │                      ├─ repo/schedule-repo.searchClinics   → ma_clinic (真实院区)
  │                      ├─ repo/schedule-repo.listSlots      → ma_slot   (真实号源)
  │                      ├─ inTransaction { bookSlotWithinTx + advanceStageTx }  → ma_slot/ma_appointment/ma_lead (原子锁号+建单+推进 booked)
  │                      ├─ outbox.enqueue('appt.create') → ma_outbox (HIS 同步, 若 MA_HIS_BASE_URL 已配)
  │                      └─ outbox.enqueue('lead.upsert') → ma_outbox (CRM 同步, 若 MA_CRM_BASE_URL 已配)
  │
  ├─ lead_handoff ────► lead-service.handoffLead
  │                      ├─ repo/lead-repo.upsertLead(handedOff, stage=arrived)
  │                      └─ outbox.enqueue('lead.upsert') → ma_outbox
  │
  └─ project_kb_search ► kb-service.searchProjects
                         ├─ (MA_KB_SOURCE=http) HttpClient → 外部 KB 服务 /v1/projects/search → 写穿透缓存 ma_project
                         └─ (缺省) repo/kb-repo.searchProjects → ma_project (LIKE 初筛 + 加权打分；库空即空，无假语料)
```

> 任一真实后端不可用 / 入参非法 → `MaError` → 工具层 `errorResult()` 转结构化 JSON 回灌模型，由模型据实告知用户或转人工。

### 入口 B — 渠道 webhook（外部系统主动推送）

```
渠道网关 POST /api/plugins/medical-aesthetics-lead/webhook
  │
  ├─ infra/signature.verifyWebhook(MA_WEBHOOK_SECRET, headers, rawBody)   # HMAC-SHA256 + 时间窗 + 恒定比较
  │     └─ 失败 → 401/503，拒绝（无鉴权裸奔入口不允许）
  ├─ repo/inbound-repo.saveInbound → ma_inbound_message (UNIQUE 去重防重放)
  ├─ markInboundState('dispatched')
  └─ ctx.a2a.send(envelope, MA_A2A_BASE_URL) ──► 平台 /api/a2a/tasks
        │
        ▼
      assembleAgent(tenantId, domain=medical-aesthetics-lead)
        → tools.mergeFrom(getPluginToolRegistry())   # 注入 5 个插件工具
        → harness.run → 工具调用（见入口 A）
```

### 看板 / 统计链路

```
浏览器 → GET /api/plugins/medical-aesthetics-lead/stats
  → server/routes.stats → repo/lead-repo.computeStats()
      └─ SQL GROUP BY 聚合：漏斗(按 reached 累计) / 渠道 / 等级 / CRM 同步分布 / 队列
  → web/dashboard.render() 注入「客资看板」Tab（内联 SVG 漏斗/柱状图 + 同步健康）
```

### 外部同步链路（后台 worker）

```
outbox-worker（onStart 启动，interval=MA_OUTBOX_INTERVAL_MS）
  → dueBatch(limit, now) 扫描 ma_outbox 待投递
  → 按 topic 分发：
      ├─ 'lead.upsert' → services/crm-client.CrmClient.upsertLead(payload, idempotencyKey)
      │                  └─ 成功 markSent + repo/lead-repo.markCrmSync(leadId,'synced',crmId)
      │                     失败 markFailed(指数退避)；达上限 markCrmSync(leadId,'failed')
      └─ 'appt.create'  → services/his-client.HisClient.createAppointment(payload, idempotencyKey)
                         └─ 成功 markSent / 失败 markFailed
```

---

## 3. 插件配置（配置文件内容）

### 3.1 `manifest.ts`（节选）

```ts
export const leadManifest: PluginManifest = {
  id: 'medical-aesthetics-lead',
  version: '0.1.0',
  name: '医美客资顾问',
  description: '多渠道获客 / 需求初筛 / 项目咨询 / 留资 / 预约到店 / 转人工咨询师，含医疗广告合规护栏',
  domain: 'medical-aesthetics',
  transport: 'local',
  entry: 'dist/index.js',
  capabilities: [
    { id: 'chat' }, { id: 'lead' }, { id: 'consult' }, { id: 'book' }, { id: 'handoff' },
  ] as AgentCapability[],
  assembly: { systemPrompt: buildSystemPrompt() },
};
```

### 3.2 `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "paths": { "@agent-harness/core": ["../../packages/core/dist/index.d.ts"] }
  },
  "include": ["src"]
}
```

### 3.3 `package.json`（依赖摘要）

```json
{
  "name": "@agent-harness/medical-aesthetics-lead",
  "version": "0.1.0",
  "main": "dist/index.js",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "engines": { "node": "22.x" },
  "dependencies": {
    "@agent-harness/core": "workspace:*",
    "@agent-harness/medical-ad-guard": "workspace:*"
  },
  "devDependencies": { "@types/node": "^20.19.43", "typescript": "^5.4.5" }
}
```

---

## 4. 依赖

| 类别 | 依赖 | 说明 |
| --- | --- | --- |
| 运行时（workspace） | `@agent-harness/core` | 插件契约（ToolRegistry / PluginContext / ServerExtension / A2A / guardrails）。经 `paths` 指向 `packages/core/dist/index.d.ts`。 |
| 运行时（workspace） | `@agent-harness/medical-ad-guard` | 医疗广告合规护栏（可插拔、幂等）。 |
| 运行时（Node 内置，**零 npm 依赖**） | `node:sqlite` | Node 22+ 内置关系库；`require('node:sqlite').DatabaseSync` + 类型断言接入（@types/node@20 无声明）。 |
| 运行时（Node 内置） | `node:fs` / `node:crypto` / `node:path` / `fetch` | 文件目录、HMAC 验签、路径、真实 HTTP 客户端。 |
| 构建 | `typescript` / `@types/node` | 仅构建期。 |

> **本次重构未引入任何新的 npm 运行时依赖**——所有"真实后端"通过环境变量配置的可达 REST 地址 + 内置 `node:sqlite` 实现。

---

## 5. 环境参数表

全部以 `MA_` 前缀，由 `src/config.ts` 解析（懒解析，首次 `getConfig()` 时缓存）。

| 变量 | 必填 | 默认 | 作用 | 未配置时行为（fail-closed） |
| --- | --- | --- | --- | --- |
| `MA_TENANT_ID` | 否 | `default` | 租户标识，贯穿 DB 行 / CRM 请求头 / A2A 信封 | — |
| `MA_DATA_DIR` | 否 | `MEMORY_DIR/plugins/medical-aesthetics-lead` 或 `./data/ma-lead` | 数据目录（DB 文件所在） | — |
| `MA_DB_FILE` | 否 | `<MA_DATA_DIR>/ma-lead.db` | sqlite 库文件绝对路径 | — |
| `MA_DB_BUSY_TIMEOUT_MS` | 否 | `5000` | WAL busy_timeout（多副本共享卷防锁冲突） | — |
| `MA_CRM_BASE_URL` | 条件 | 空 | CRM REST 基址（如 `https://crm.internal`） | 置空 → CRM 同步 `disabled`（线索仍落本地库） |
| `MA_CRM_TOKEN` | 条件 | 空 | CRM Bearer 令牌 | 缺 → 鉴权失败 |
| `MA_CRM_TIMEOUT_MS` | 否 | `8000` | CRM 单次请求超时 | — |
| `MA_CRM_RETRIES` | 否 | `2` | CRM 重试次数（仅 429/5xx/网络） | — |
| `MA_HIS_BASE_URL` | 条件 | 空 | HIS/预约系统 REST 基址 | 置空 → 预约单不向 HIS 同步（`hisSync=disabled`） |
| `MA_HIS_TOKEN` | 条件 | 空 | HIS Bearer 令牌 | 缺 → 鉴权失败 |
| `MA_HIS_TIMEOUT_MS` / `MA_HIS_RETRIES` | 否 | `8000` / `2` | HIS 超时 / 重试 | — |
| `MA_KB_BASE_URL` | 条件 | 空 | 外部知识库服务基址（`MA_KB_SOURCE=http` 时必填） | 置空 + `http` 模式 → `NOT_CONFIGURED` |
| `MA_KB_TOKEN` | 条件 | 空 | KB Bearer 令牌 | 缺 → 鉴权失败 |
| `MA_KB_SOURCE` | 否 | `db` | 知识库来源：`db`（本地库，由导入接口/外部服务写入）或 `http`（真实出网检索） | `db` 缺数据→检索返回空 |
| `MA_WEBHOOK_SECRET` | 条件 | 空 | 渠道 webhook HMAC 密钥 | 置空 → 所有 webhook 拒绝（401/503） |
| `MA_ADMIN_TOKEN` | 条件 | 空 | 数据导入/写接口管理令牌 | 置空 → 导入接口拒绝 |
| `MA_OUTBOX_ENABLED` | 否 | `true` | 是否启用 CRM/HIS 同步后台投递 | `false` → 不出网同步（仅落库） |
| `MA_OUTBOX_INTERVAL_MS` | 否 | `15000` | 发件箱轮询间隔 | — |
| `MA_OUTBOX_MAX_ATTEMPTS` | 否 | `8` | 同步最大重试次数（达上限标记 failed） | — |
| `MA_OUTBOX_BATCH_SIZE` | 否 | `20` | 每轮扫描批次 | — |
| `MA_A2A_BASE_URL` | 条件 | `AGENT_A2A_BASE_URL` | webhook → agent 的 A2A 投递基址 | 置空 → webhook 仅落库不触发 agent |
| `MA_A2A_TIMEOUT_MS` | 否 | `60000` | A2A 投递超时 | — |

> 共享存储（多副本共享记忆）：所有 ui 副本挂 RWX PVC 到同一目录，`MA_DATA_DIR` 指向该挂载点，`MA_DB_FILE` 用**绝对路径**（后台任务中 `$PWD` 会偏移到错误目录）。

---

## 6. 部署与验证

### 6.1 构建

```bash
# 依赖 core 已构建（dist/index.d.ts 存在）；仅需 tsc 编译插件
cd plugins/medical-aesthetics-lead
pnpm build            # = tsc -p tsconfig.json
```

### 6.2 端到端冒烟（真实 sqlite，无需任何外部服务）

```bash
node smoke.cjs
# 覆盖：院区/号源导入 → qualify/capture/book/handoff 真实落库 → 事务防超卖
#      → SQL 漏斗聚合 → 空库 KB 检索返回空（fail-closed）→ 入站去重 → 发件箱入队 → dbHealth
```

### 6.3 最小可用运行（本地 sqlite + 运营导入数据）

```bash
# 1) 启动 server（启用本插件）
MA_DATA_DIR=/abs/path/data \
MA_WEBHOOK_SECRET=wh_xxx \
MA_ADMIN_TOKEN=admin_xxx \
node packages/server/dist/server.js

# 2) 导入院区 / 号源 / 知识库（管理令牌）
curl -X POST localhost:4173/api/plugins/medical-aesthetics-lead/clinics/import \
  -H "authorization: Bearer admin_xxx" -H 'content-type: application/json' \
  -d '{"clinics":[{"clinicId":"c_sh","name":"上海静安院区","city":"上海"}]}'

curl -X POST localhost:4173/api/plugins/medical-aesthetics-lead/slots/import \
  -H "authorization: Bearer admin_xxx" -H 'content-type: application/json' \
  -d '{"slots":[{"slotId":"s1","clinicId":"c_sh","date":"2026-09-01","time":"14:30","capacity":1}]}'

# 3) 看板 / 统计
curl localhost:4173/api/plugins/medical-aesthetics-lead/stats
curl localhost:4173/api/plugins/medical-aesthetics-lead/health
```

### 6.4 接入真实外部系统（可选增强）

设置 `MA_CRM_BASE_URL`/`MA_CRM_TOKEN` 与 `MA_HIS_BASE_URL`/`MA_HIS_TOKEN` 后：
- 线索变更自动经发件箱异步投递 CRM（至少一次，幂等键防重复建单）；
- 预约单自动同步 HIS；
- 看板 `CRM 同步健康` 展示 `已投/待投/失败` 分布。

---

## 7. fail-closed 行为矩阵（关键保障）

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 知识库无数据 | 返回内置 `PROJECT_CORPUS` 假语料 | 返回 `found:false` + 建议面诊（**无假数据**） |
| 号源已满/不存在 | 仍返回 `ok:true`（**假成功**） | 抛 `NOT_FOUND`/`CONFLICT`，工具据实回灌模型 |
| CRM 未配置 | 静默跳过，假装已同步 | 线索落本地库，同步状态 `disabled`，如实告知 |
| 外部服务 5xx/超时 | — | 指数退避重试；达上限标记 `failed`，发件箱保留积压待配置后 flush |
| webhook 无密钥/签名错 | — | 一律拒绝（401/503），不允许裸奔入口 |
| 重复入站消息 | — | `UNIQUE` 去重，防重放 |
| 并发锁号 | 文件覆盖，可能超卖 | 事务 + 条件更新 + 唯一索引，天然防超卖 |

---

## 8. 验收结论

- ✅ 编译通过（`tsc` 零错误）。
- ✅ 端到端冒烟 11 项全过：真实 sqlite 落库、参数化 SQL 聚合、事务防超卖、入站去重、发件箱队列、空库 fail-closed。
- ✅ 假数据已彻底移除（`PROJECT_CORPUS` 删除、`store.ts` 文件存储删除、book 假成功删除）。
- ✅ 数据来源真实可用：本地库（node:sqlite）+ 外部 CRM/HIS/KB（真实 REST）+ 渠道 webhook 验签落库。
