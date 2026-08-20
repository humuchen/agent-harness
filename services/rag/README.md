# @agent-harness/rag-service — 外部 RAG 服务

独立部署的检索增强生成（RAG）服务，为 agent-harness 提供「入库 → 向量化 → 检索」能力。
对应设计文档：`docs/07-rag/external-rag-design.md`（**P0+P1+P2+P3 已落地**）。

## 特性

- **零运行时依赖**：仅用 Node 内置模块（http / crypto / fs / readline / stream），可独立 `docker run`。
- **两种传输**：HTTP REST（`RAG_TRANSPORT=http`）与 MCP stdio（`RAG_TRANSPORT=mcp`）。
- **可插拔向量化**：默认 `HashEmbedding`（确定性、零外部依赖，用于冒烟/演示）；
  设 `RAG_EMBEDDING_API_KEY` 自动切换到真实远程 embedding（OpenAI / OpenRouter 兼容）。
- **真 BM25 + 混合检索（P2）**：稠密余弦 + 真 BM25（IDF 加权）按 `RAG_FUSE_DENSE/BM25` 融合，
  替代 P0 的弱关键词代理打分；重排三档：`mmr`（默认，MMR 多样性）| `api`（真实 cross-encoder，
  兼容 Jina/Cohere Rerank，失败自动回退 MMR）| `none`。
- **完整鉴权（P2）**：静态令牌（`RAG_TOKENS`）或 **JWT（HS256，`RAG_JWT_SECRET`）**；
  `tenant_id` 由服务端从凭证重写，杜绝客户端伪造跨租户读写。
- **异步入库队列（P2）**：ingest 返回 202 + `job_id`，后台并发 worker 处理（`RAG_ASYNC_INGEST`）。
- **查询缓存（P3）**：LRU + TTL 结果缓存（`RAG_CACHE`），重复检索近 0 延迟。
- **可观测（P3）**：`GET /v1/metrics`（Prometheus 文本）、`trace_id`+`latency_ms`、
  缓存命中率与 P50/P95/P99 分位、结构化日志。
- **按租户分片（P3）**：`RAG_SHARD_BY_TENANT` 时持久化为 `<base>.<tenant>.json` 独立文件。
- **Pre-retrieval（P3）**：检索请求带 `expand: true` 返回显著查询扩展词。
- **MCP 协议级实现**：标准 MCP JSON-RPC over stdio，不耦合 agent-harness 的 SDK 版本，
  agent 侧任何标准 MCP client（含现有 `connectMcpServers`）均可对接。

## 构建

```bash
cd services/rag
node ../../packages/core/node_modules/typescript/bin/tsc -p tsconfig.json
# 产物输出到 dist/
```

> 本项目用 pnpm workspace，但本服务作为独立部署单元，构建不依赖 workspace install；
> 直接用仓库内已安装的 TypeScript 即可。生产环境执行 `npm install` 后再 `npm run build`。

## 运行

### HTTP REST 模式（默认）

```bash
RAG_TRANSPORT=http RAG_PORT=8787 \
  RAG_TOKENS="acme:s3cr3t,beta:s3cr3t2" \   # 多租户：secret->tenant 映射
  RAG_JWT_SECRET=your-hmac-secret \         # 可选：启用 JWT(HS256) 鉴权
  RAG_DATA_FILE=./rag-data.json \           # 可选：JSON 持久化（RAG_SHARD_BY_TENANT=true 时分片）
  node dist/index.js
```

### MCP Server 模式（供 agent-harness 注册）

```bash
RAG_TRANSPORT=mcp RAG_TENANT_ID=acme node dist/index.js
```

## API（HTTP 模式）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/v1/health` | 健康检查 `{ ok, chunks, dim, cache_size, ingest, metrics }` |
| GET  | `/v1/metrics` | Prometheus 文本格式指标（检索/入库计数、缓存命中率、P50/P95/P99） |
| POST | `/v1/ingest`  | 入库（默认异步 202）：`{ doc_id, title?, text, tags?, metadata? }` → `{ accepted, job_id }` |
| GET  | `/v1/ingest/:jobId` | 查询异步入库任务状态 |
| POST | `/v1/retrieve`| 检索：`{ query, top_k?, score_threshold?, filters?, expand? }` → `{ results[], trace_id, latency_ms, cache_hit, expanded_terms? }` |

检索返回每条 `results[]` 含 `chunk_id / doc_id / title / content / score / rerank_score? / metadata`，
agent 侧用 `[n]` 引用 `chunk_id` 即可追溯来源。`expand: true` 时返回 `expanded_terms`（Pre-retrieval）。

## 在 agent-harness 中接入（P1，零业务改动）

在环境变量配 `MCP_SERVERS` 加一条（指向 RAG 进程），RAG 所需配置（`RAG_TRANSPORT` 等）
放**顶层 env**（由 RAG 子进程继承）：

```bash
RAG_TRANSPORT=mcp
RAG_TENANT_ID=acme
RAG_DATA_FILE=data/rag-store.json          # 可选
MCP_SERVERS='[{"name":"rag","command":"node","args":["services/rag/dist/index.js"]}]'
```

> 环境变量继承说明（重要）：MCP SDK（1.30）的 `StdioClientTransport` 默认只继承
> 「sudo 白名单」环境变量，**不继承自定义顶层 env**——若直接裸用 SDK，RAG 子进程会拿不到
> `RAG_TRANSPORT` 而落到 HTTP 模式、把日志打进 stdout 破坏 MCP 通道。agent-harness 的
> `connectMcpClient` 已兜底 `env ?? process.env`（`placeholder.ts`），顶层 env 会被完整继承；
> 也可把 `RAG_*` 显式写进条目的 `env` 字段（SDK 按 `{白名单, ...显式env}` 合并，不丢 PATH），
> 二选一。真实模型端到端示例见 `examples/rag-live-e2e.ts`。

核心 loop 经 `connectMcpServers` 自动注册，ToolRegistry 生成
`rag__rag_retrieve` / `rag__rag_ingest`，交由 LLM 自主调用。
`tenant_id` 由 RAG 进程持有，agent 侧无需也不应传递，杜绝越权。

## 测试

```bash
node --test test/*.test.cjs
# 覆盖（15 例）：入库分块 / 检索召回 / 租户隔离 / 幂等增量 / 阈值过滤 / MCP 端到端
#   / JWT 鉴权（401/403/兼容静态令牌）/ BM25 区分度 / 异步入库队列
#   / 缓存命中 / metrics / 按租户分片持久化 / 查询扩展 / MMR / cross-encoder API 重排
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAG_TRANSPORT` | `http` | `http` 或 `mcp` |
| `RAG_PORT` | `8787` | HTTP 模式端口 |
| `RAG_TENANT_ID` | `default` | 单租户时的默认租户（无令牌开放模式） |
| `RAG_TOKENS` | 空 | 多租户：`tenant:secret` 逗号分隔 |
| `RAG_API_TOKEN` | 空 | 单租户令牌（配对 `RAG_TENANT_ID`） |
| `RAG_JWT_SECRET` | 空 | 启用 JWT(HS256) 鉴权；令牌 `tenant` 声明即租户 |
| `RAG_ASYNC_INGEST` | `true` | 异步入库队列（`false` 时同步立即返回结果） |
| `RAG_CACHE` | `true` | 查询结果缓存（LRU+TTL） |
| `RAG_SHARD_BY_TENANT` | `false` | 持久化按租户分片（`<base>.<tenant>.json`） |
| `RAG_RERANK` | `mmr` | 重排：`mmr`（MMR 多样性，零依赖）\| `api`（真实 cross-encoder，需下方 3 个配置，失败回退 MMR）\| `none` |
| `RAG_RERANK_API_URL` | 空 | cross-encoder API 地址（Jina `.../v1/rerank` / Cohere `.../v2/rerank` 兼容） |
| `RAG_RERANK_API_KEY` | 空 | cross-encoder API 密钥 |
| `RAG_RERANK_MODEL` | `jina-reranker-v2-base-multilingual` | cross-encoder 模型名 |
| `RAG_FUSE_DENSE` / `RAG_FUSE_BM25` | `0.6` / `0.4` | 稠密余弦与 BM25 融合权重 |
| `RAG_EMBED_DIM` | `256` | 向量维度（切换 embedding 提供方需保持一致） |
| `RAG_DATA_FILE` | 空 | JSON 持久化文件路径 |
| `RAG_EMBEDDING_API_KEY` / `RAG_EMBEDDING_BASE_URL` / `RAG_EMBEDDING_MODEL` | 空 | 真实远程 embedding（缺省降级到 HashEmbedding） |
