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

数据目录解析优先级：`MA_DATA_DIR` > `MEMORY_DIR/plugins/medical-aesthetics-lead` > `./data/ma-lead`（cwd 相对）。
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
