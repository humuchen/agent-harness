# 配置手册 · 环境变量一览

`medical-aesthetics-lead` 插件**所有**运行期与脚本参数均来自环境变量，无内置业务数据、无配置文件。本文档逐项列出全部变量、默认值与启用条件。

> 配置在**首次读取时**惰性解析并缓存（`getConfig()`）。环境变量须在插件进程启动 / 首次调用前注入；若需运行期重载，调用 `resetConfig()` 失效缓存后重新解析。

---

## 1. 数据库与数据目录

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_DB_FILE` | 否 | 见下 | 关系库（sqlite）文件路径。**相对路径会在加载时 `resolve(process.cwd(), …)` 为绝对路径**，避免 seed / export / 运行时在不同工作目录解析到不同文件。 |
| `MA_DB_BUSY_TIMEOUT_MS` | 否 | `5000` | sqlite `busy_timeout`（毫秒），多副本共享卷时降低瞬时锁冲突丢错。 |
| `MA_DATA_DIR` | 否 | 见下 | 数据目录**最高优先级**。 |
| `MEMORY_DIR` | 否 | 见下 | 数据目录第二优先级 → `MEMORY_DIR/plugins/medical-aesthetics-lead`。 |

数据目录解析优先级：`MA_DATA_DIR`（部署显式指定；配置了 `DB_BACKEND=turso` 时全部数据落云端库，本地仅兜底）> `<仓库根>/access/server/data/ma-lead`（本地兜底，锚定插件文件位置向上找仓库根，不受 cwd 影响）> `MEMORY_DIR/plugins/medical-aesthetics-lead` > `./data/ma-lead`（cwd 相对，最后手段）。
当 `MA_DB_FILE` 缺省时，库文件为 `<数据目录>/ma-lead.db`。

---

## 2. 租户

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_TENANT_ID` | 否 | `default` | 租户标识，贯穿 DB 行、CRM 请求头、A2A 信封。多机构部署时用它做数据隔离。 |

---

## 3. 外部 REST 上游（通用前缀约定）

除嵌入服务外，所有上游均遵循统一前缀约定：

- `<PREFIX>_BASE_URL` — 端点基址；**为空即视为未配置，对应能力 fail-closed**（返回 `NOT_CONFIGURED`，绝不伪造数据）。
- `<PREFIX>_TOKEN` — Bearer 令牌（日志中脱敏）。
- `<PREFIX>_TIMEOUT_MS` — 单次请求超时，默认 `8000`。
- `<PREFIX>_RETRIES` — 可重试错误（网络异常 / 429 / 5xx）重试次数，默认 `2`。

| 上游 | 前缀 | 关键额外变量 |
| --- | --- | --- |
| CRM（线索主系统） | `MA_CRM` | — |
| HIS / 预约（院区·号源·预约单） | `MA_HIS` | — |
| 知识库服务 | `MA_KB` | `MA_KB_SOURCE`（`db` \| `http`，默认 `db`） |

`MA_KB_SOURCE=db`：检索查本地 sqlite 库（运营经导入接口写入 / 外部 KB 服务同步落库）。
`MA_KB_SOURCE=http`：检索走真实出网 + 穿透缓存的外部 KB 服务（`MA_KB_BASE_URL`）。

---

## 4. 文本嵌入服务（语义 hybrid 检索）

契约：**OpenAI 兼容** embeddings 端点，可对接 OpenAI / Azure OpenAI / Ollama / vLLM / LocalAI 等。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_EMBED_BASE_URL` | 启用语义检索时必填 | 空（未配则关闭） | 端点基址，如 `https://你的网关/v1`。**为空 → 检索退化为词面+意图，绝不伪造向量。** |
| `MA_EMBED_MODEL` | 否 | `text-embedding-3-small` | 嵌入模型名，随 baseUrl 透传给端点。 |
| `MA_EMBED_TOKEN` | 否 | 空 | Bearer 令牌（日志脱敏）。 |
| `MA_EMBED_PATH` | 否 | `/v1/embeddings` | 端点路径后缀。非标准端点（如 Ollama 的 `/api/embed`）用此覆盖。 |
| `MA_EMBED_TIMEOUT_MS` | 否 | `8000` | 请求超时。 |
| `MA_EMBED_RETRIES` | 否 | `2` | 重试次数。 |

请求 / 响应契约：

```
POST {MA_EMBED_BASE_URL}{MA_EMBED_PATH}
body:  { "model": "<MA_EMBED_MODEL>", "input": "<文本>" }   # model 为空时退化为 { "input" }
resp:  { "data": [ { "embedding": number[] } ] }            # OpenAI 兼容
       或自定义 { "embedding": number[] }
```

**推荐：经外部 RAG 检索（services/rag）**。`knowledge/` 静态母版已随本次迁移**下线删除**，其知识由 `scripts/rag-ingest.cjs` 一次性灌入 RAG 向量库，运行期检索源是持久化的 `rag-store.json`（默认 `MA_DATA_DIR/rag-store.json`，gitignored）。`project_kb_search` 在 `MA_RAG_BASE_URL` 已配时经该库检索；未配则回退本地库 `ma_project`。RAG 的向量化由 `RAG_EMBEDDING_API_KEY` 控制（缺省用确定性 HashEmbedding，仅演示）：

```bash
# 1) 灌库（复用 services/rag 编译产物，向量化与服务端一致）
MA_RAG_DATA_FILE=/data/ma-lead/rag-store.json \
  node scripts/rag-ingest.cjs
# 2) 启动 RAG 服务并让 harness 经 MCP_SERVERS 注册（详见仓库 .env.example）
RAG_TRANSPORT=http RAG_DATA_FILE=/data/ma-lead/rag-store.json \
  node services/rag/dist/index.js
# 3) 插件开启 RAG 检索
export MA_RAG_BASE_URL=http://localhost:8787
```

> ⚠️ **`rag-store.json` 是迁移后运行时唯一的持久化知识源，且被 gitignore（不在版本控制）。** 因 `knowledge/` 已删除，`rag-ingest.cjs` 现已无法重跑（会判定 `knowledge/` 不存在并安全退出）。新环境重建需**复制该 store 文件**，或先 `git checkout` 恢复 `knowledge/` 母版后再迁移。

**可选：本地库语义 hybrid（ma_project 回退路径）**。仅当未配 `MA_RAG_BASE_URL` 时生效；启用步骤：

```bash
export MA_EMBED_BASE_URL=https://你的端点/v1   # 或留基座，用 MA_EMBED_PATH 指定路径
export MA_EMBED_MODEL=bge-small-zh             # / text-embedding-3-small / nomic-embed-text
export MA_EMBED_TOKEN=可选
```

未配 `MA_EMBED_BASE_URL` 或嵌入调用失败时，自动降级，不影响基础召回。

---

## 5. 安全与写入控制

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_WEBHOOK_SECRET` | 生产必填 | 空 | 渠道 webhook 入口 HMAC 校验密钥。**为空则拒绝所有 webhook（避免裸奔）。** |
| `MA_ADMIN_TOKEN` | 写操作必填 | 空 | 运营数据导入 / 看板写操作的管理令牌。**为空则拒绝写入。** |

---

## 6. CRM 同步发件箱（至少一次投递）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_OUTBOX_ENABLED` | 否 | `true`（仅当显式 `=false` 才关闭） | 是否启用发件箱轮询投递。 |
| `MA_OUTBOX_INTERVAL_MS` | 否 | `15000` | 轮询间隔（毫秒）。 |
| `MA_OUTBOX_MAX_ATTEMPTS` | 否 | `8` | 单条最大投递尝试次数。 |
| `MA_OUTBOX_BATCH_SIZE` | 否 | `20` | 每批投递条数。 |

---

## 7. A2A 入站消息入口

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_A2A_BASE_URL` | 否 | 空 | 平台 A2A 任务入口。缺省时回退 `AGENT_A2A_BASE_URL`。 |
| `AGENT_A2A_BASE_URL` | 否 | 空 | `MA_A2A_BASE_URL` 的回退来源（平台统一变量）。 |
| `MA_A2A_TIMEOUT_MS` | 否 | `60000` | A2A 请求超时。 |

---

## 8. 定时调度器与对客触达（B3/B4/B5）

调度器每轮「规划 + 消费」：welcome（近期新建线索欢迎语）、recall（沉默 2h/24h 回捞）、
birthday/repurchase（经 `POST /scheduler/jobs` 手动排期，文案过合规筛查）。
到期任务产出对客消息进发件箱（topic=`outreach.send`），经渠道触达网关真实投递（至少一次）。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MA_SCHEDULER_ENABLED` | 否 | `true` | 是否启用后台调度循环。 |
| `MA_SCHEDULER_INTERVAL_MS` | 否 | `60000` | 调度轮询间隔（毫秒）。 |
| `MA_SCHEDULER_BATCH_SIZE` | 否 | `50` | 每轮消费到期任务上限。 |
| `MA_SCHEDULER_RECALL` | 否 | `true` | 沉默回捞开关。 |
| `MA_SCHEDULER_RECALL_FIRST_H` | 否 | `2` | 回捞第一节点（沉默小时数）。 |
| `MA_SCHEDULER_RECALL_SECOND_H` | 否 | `24` | 回捞第二节点（沉默小时数）。 |
| `MA_SCHEDULER_WELCOME` | 否 | `true` | 欢迎语排期开关。 |
| `MA_SCHEDULER_WELCOME_WINDOW_H` | 否 | `24` | 欢迎语仅对近 N 小时新建线索排期（避免给存量补发）。 |
| `MA_OUTREACH_BASE_URL` | 触达必填 | 空 | 渠道触达网关地址（对客主动消息出站）。未配置时消息在发件箱 pending 积压，绝不假装已发送。 |
| `MA_OUTREACH_TOKEN` | 否 | 空 | 触达网关 Bearer 令牌。 |
| `MA_OUTREACH_TIMEOUT_MS` / `MA_OUTREACH_RETRIES` | 否 | `8000` / `2` | 网关请求超时与重试。 |

**触达资格（回捞）**：未转化（new/contacted/qualified/captured）+ 非 D 级 + 未转人工 +
已留资授权（`consent_at` 非空）+ 有联系方式（phone/wechat）。线索复联后重新计时。
**网关契约**：`POST {MA_OUTREACH_BASE_URL}/v1/messages`，body
`{tenantId, leadId, topic, channel?, to?, text}`，header `Idempotency-Key`。
**相关路由**：`GET /scheduler`（快照）、`POST /scheduler/tick`（手动一轮，管理令牌）、
`POST /scheduler/jobs`（手动排期，管理令牌）。

---

## 9. 内容生产与先审后发（D8/D9）

内容流水线：知识库（真实数据）→ 模板骨架生成 / LLM 起草（`content_draft` 工具）/
运营手写 → 医疗广告合规筛查（`medicalAdRules`，命中即拒）→ 人工审核 → 过审 → 发布。

**状态机**：`draft`（手动草稿）→ `review`（送审；模板与 LLM 草稿生成后直接入审）→
`approved`（人工过审）/ `rejected`（驳回，必须给原因，可改稿重新送审）→ `published`（已发布）。

**硬约束**：
- 知识库为空 → 生成 fail-closed 报错，绝不回退内置语料；
- 模板文案只组装 KB 字段（科普 summary/compliantCopy、适合人群、恢复期、禁忌、价格区间），
  价格一律以「面诊为准」收口；
- 未过审（`approved` 之前）绝不发布；发布只能走网关，未配置 → `NOT_CONFIGURED`，
  内容保持 `approved` 可重试（`publish_error` 记录原因），绝不假装已发布；
- 每条发布文案末尾统一追加风险提示「医疗美容有风险，最终以面诊方案为准。」。

**网关契约（内容发布）**：`POST {MA_OUTREACH_BASE_URL}/v1/content/publish`，body
`{tenantId, contentId, platform, title, text, project?, topic:'content.publish'}`，
header `Idempotency-Key: content:{contentId}`（复用触达网关配置，无新增环境变量）。

**路由**：
- `GET /content?state=&platform=&limit=` —— 流水线快照（统计 + 列表，公开读）；
- `POST /content/generate` —— 知识库批量生成（`{platform?, projectName?}`，同日幂等，管理令牌）；
- `POST /content/draft` —— 运营手写草稿（`{platform, title, body, project?}`，过筛后落库 draft，管理令牌）；
- `POST /content/submit` —— 送审（draft/rejected → review，管理令牌）；
- `POST /content/approve` —— 人工过审（review → approved，`{contentId, reviewer}`，管理令牌）；
- `POST /content/reject` —— 驳回（review → rejected，必须给 reason，管理令牌）；
- `POST /content/publish` —— 发布（approved → 网关 → published，管理令牌）。

**Agent 工具**：`medical-aesthetics-lead__content_draft` —— LLM 起草，命中红线返回
结构化 `violations` 不落库；通过后落库 source=`llm` 并直接进入 `review` 队列。

---

## 10. 咨询师辅助简报（C6/C7，本地库版）

数据源为本地客资库（ma_lead / ma_lead_message / ma_appointment / ma_schedule_job，真实 SQL）；
CRM 选型落地后实现 CrmReader 替换/叠加数据源，简报结构不变（`source` 字段明示当前来源）。

**简报内容**：画像（渠道/项目/预算/城市/等级/阶段）、授权状态、脱敏联系方式、
最近对话摘录（正序）、预约记录、SOP 触达排期统计、规则化跟进建议（确定性规则推导，非 LLM 生成）。

**隐私纪律**：简报中 phone/wechat 一律掩码（手机前 3 后 4、微信号前 2 位）；
完整联系方式仅 `GET /assist/reveal`（管理令牌）放行。

**建议规则（按紧急度排序，最多 4 条）**：D 级/已转人工 → 人工优先接手；已预约 → 到店确认；
未授权 → 先取授权再留资；已授权有联系方式 → 与自动触达错峰或 24h 内首触；
A 级 → 尽快面诊（报价只用区间）；缺项目画像 → 优先探明；CRM 同步 pending → 检查上游。

**路由**：
- `GET /assist/briefing?leadId=` —— 简报（脱敏，公开读）；
- `GET /assist/reveal?leadId=` —— 完整联系方式（管理令牌）。

**Agent 工具**：`medical-aesthetics-lead__lead_briefing`（主卡片硬允许集 + 运营分析子代理）。

---

## 11. A/B 分流实验（E 组：自做 A/B）

针对「只看厂商宣称数据」缺口：对 SOP 触达文案自建 A/B 实验，用自有客资数据看真实转化。

**模型**：`ma_ab_experiment`（topic 精确匹配 `welcome|recall_first|recall_second|birthday|repurchase`；
metric 决定转化口径 `reply|booking|arrived`）+ `ma_ab_variant`（2~3 个变体，权重缺省 50/50）+
`ma_ab_assignment`（sticky 分流落库，UNIQUE(experiment_id, lead_id)）。

**分流机制**：sha256(experimentId:leadId) 确定性哈希按权重落桶，物化分配记录——
同一线索永远同一变体；权重后续调整不重洗已分配线索。调度器执行任务时，该 topic 有活跃实验
→ 发件箱使用变体文案（发送时补风险提示）并在载荷带 `abExperimentId/abVariant` 标注；
无实验/已停止 → 回落默认模板（零回归）。

**合规**：变体文案创建时过 `medicalAdRules` 筛查，命中红线拒绝建实验。

**转化归因（真实 SQL，无新增写路径）**：按「分配之后发生」计——
`reply` = 该线索 user 消息（ma_lead_message）；`booking` = 预约建单（ma_appointment.created_at）；
`arrived` = 到院标记（ma_appointment.arrived_at）。

**诚实纪律**：报表只给真实计数/转化率；任一变体分配数 < 30 明示「样本量小，差异不具统计学意义」，
绝不生成「显著提升 X%」类结论。

**路由**：
- `GET /ab` —— 实验清单；`GET /ab/report?experimentId=` —— 报表；
- `GET /ab/assign?experimentId=&leadId=` —— 预览/物化某线索分流；
- `POST /ab/experiments` —— 创建（`{name, topic, metric?, variants:[{key?, text, weight?}]}`，管理令牌）；
- `POST /ab/stop` —— 停止（管理令牌）。

**Agent 工具**：`medical-aesthetics-lead__ab_report`（主卡片硬允许集 + 运营分析子代理）。

---

## 8. 脚本命令行参数

脚本（`scripts/*.cjs`）复用插件编译产物（`dist/`），并通过 `MA_DB_FILE` 指定库。

| 脚本 | 关键参数 | 说明 |
| --- | --- | --- |
| `rag-ingest.cjs` | `MA_RAG_DATA_FILE` | 把（已下线的）`knowledge/` 母版一次性灌入 RAG 向量库，产出 `rag-store.json` 作为运行期检索源（gitignored）。`RAG_EMBEDDING_API_KEY` 控制向量化。 |
| `kb-smoke.cjs` | `MA_DB_FILE` 环境变量 | 口语探针，量化 ma_project 本地库召回率（仅未配 RAG 时参考）。 |

示例：

```bash
# 迁移知识到 RAG（运行期检索源）
MA_RAG_DATA_FILE=/data/ma-lead/rag-store.json node scripts/rag-ingest.cjs
```

### 9. Seeding Demo Data for Local Testing

The plugin does **not** auto-seed on startup. For local development and testing, use the standalone seed script:

```bash
# Build plugin first
pnpm --filter @agent-harness/medical-aesthetics-lead build

# Seed demo data (2,200+ records across 11 tables)
node plugins/medical-aesthetics-lead/scripts/seed-manual.mjs

# Clean + seed (deletes DB file first, then writes fresh data)
node plugins/medical-aesthetics-lead/scripts/seed-manual.mjs --clean
```

Environment variables honored by the script:

| 变量 | 说明 |
| --- | --- |
| `MA_TENANT_ID` | 租户标识 (default: `default`) |
| `MA_DATA_DIR` | 数据目录 (决定 DB 文件位置) |
| `MA_DB_FILE` | 直接指定 DB 文件路径 (优先级最高) |

Data written: 7 clinics, 4 projects, 200 leads (8 stages: deal/contacted/qualified/booked/captured/arrived/new/lost), 490 time slots, 889 lead messages, 480 stage logs, 57 appointments, 57 outbox entries, 57 inbound messages.

### 10. Seeding Real Business Data from JSON

To insert **real business data** (e.g., from your CRM/Excel export) instead of simulated demo data:

```bash
# 1. Create a JSON file matching your business data
#    (column names use snake_case; camelCase is also accepted)
cat > my-data.json << 'EOF'
{
  "clinics": [
    {"clinic_id": "c1", "name": "北京美莱克", "city": "北京", "phone": "010-12345678"}
  ],
  "projects": [
    {"project_id": "p1", "name": "玻尿酸", "category": "注射", "price_range": "2000-4000", "summary": "用于唇部丰满"}
  ],
  "leads": [
    {"lead_id": "l1", "channel": "wechat", "name": "张三", "phone": "13800138001", "city": "北京", "stage": "contacted", "intent": "玻尿酸"}
  ],
  "slots": [...],
  "appointments": [...],
  "lead_messages": [...],
  "stage_logs": [...],
  "inbound_messages": [...],
  "outbox_entries": [...]
}
EOF

# 2. Insert into database
node plugins/medical-aesthetics-lead/scripts/seed-manual.mjs my-data.json
```

The script accepts the following top-level keys in the JSON file:

| Key | 描述 | 必填字段 |
| --- | --- | --- |
| `clinics` | 院区列表 | `name` |
| `projects` | 项目列表 | `name`, `summary` |
| `leads` | 客资线索 | `name` (others optional) |
| `slots` | 号源列表 | `slot_date`, `slot_time`, `clinic_id` |
| `appointments` | 预约单 | `lead_id`, `clinic_id`, `slot_id` |
| `lead_messages` | 对话消息 | `lead_id`, `role`, `text` |
| `stage_logs` | 阶段变更历史 | `lead_id`, `to_stage` |
| `inbound_messages` | 入站消息 | `channel`, `external_id`, `text` |
| `outbox_entries` | CRM 同步发件箱 | `topic`, `payload` |

All `tenant_id` values are automatically set to `MA_TENANT_ID` (default: `default`).

---

仅本地库 + 词面+意图检索（无需任何外部依赖）：

```bash
export MA_TENANT_ID=default
export MA_DB_FILE=/data/ma-lead.db
export MA_WEBHOOK_SECRET=换一个强随机串
export MA_ADMIN_TOKEN=换一个强随机串
```

启用语义 hybrid 检索（本地库回退路径）追加：

```bash
export MA_EMBED_BASE_URL=https://embed.example.com/v1
export MA_EMBED_MODEL=bge-small-zh
node scripts/kb-smoke.cjs   # 验证本地库召回（可选）
```

接入真实 CRM / HIS / 外部 KB：

```bash
export MA_CRM_BASE_URL=https://crm.internal
export MA_CRM_TOKEN=xxxx
export MA_HIS_BASE_URL=https://his.internal
export MA_HIS_TOKEN=xxxx
export MA_KB_SOURCE=http
export MA_KB_BASE_URL=https://kb.internal
```
