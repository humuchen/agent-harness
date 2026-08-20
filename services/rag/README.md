# @agent-harness/rag-service — 外部 RAG 服务

独立部署的检索增强生成（RAG）服务，为 agent-harness 提供「入库 → 向量化 → 检索」能力。
对应设计文档：`docs/07-rag/external-rag-design.md`（P0+P1 已落地）。

## 特性

- **零运行时依赖**：仅用 Node 内置模块（http / crypto / fs / readline），可独立 `docker run`。
- **两种传输**：HTTP REST（`RAG_TRANSPORT=http`）与 MCP stdio（`RAG_TRANSPORT=mcp`）。
- **可插拔向量化**：默认 `HashEmbedding`（确定性、零外部依赖，用于冒烟/演示）；
  设 `RAG_EMBEDDING_API_KEY` 自动切换到真实远程 embedding（OpenAI / OpenRouter 兼容）。
- **权限隔离**：`tenant_id` 由服务端从令牌重写，杜绝客户端伪造跨租户读写。
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
  RAG_DATA_FILE=./rag-data.json \           # 可选：JSON 持久化
  node dist/index.js
```

### MCP Server 模式（供 agent-harness 注册）

```bash
RAG_TRANSPORT=mcp RAG_TENANT_ID=acme node dist/index.js
```

## API（HTTP 模式）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/v1/health` | 健康检查 `{ ok, chunks, dim }` |
| POST | `/v1/ingest`  | 入库：`{ doc_id, title?, text, tags?, metadata? }` → `{ doc_id, chunks, replaced }` |
| POST | `/v1/retrieve`| 检索：`{ query, top_k?, score_threshold?, filters? }` → `{ results[], trace_id, latency_ms }` |

检索返回每条 `results[]` 含 `chunk_id / doc_id / title / content / score / metadata`，
agent 侧用 `[n]` 引用 `chunk_id` 即可追溯来源。

## 在 agent-harness 中接入（P1，零业务改动）

在 `MCP_SERVERS` 配置加一条（或 `parseMcpServersEnv` 接受的 JSON）：

```json
{
  "name": "rag",
  "command": "node",
  "args": ["services/rag/dist/index.js"],
  "env": { "RAG_TRANSPORT": "mcp", "RAG_TENANT_ID": "acme" }
}
```

核心 loop 经 `connectMcpServers` 自动注册，ToolRegistry 生成
`rag__rag_retrieve` / `rag__rag_ingest`，交由 LLM 自主调用。
`tenant_id` 由 RAG 进程持有，agent 侧无需也不应传递，杜绝越权。

## 测试

```bash
node --test test/*.test.cjs
# 覆盖：入库分块 / 检索召回 / 租户隔离 / 幂等增量 / 阈值过滤 / MCP 端到端
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAG_TRANSPORT` | `http` | `http` 或 `mcp` |
| `RAG_PORT` | `8787` | HTTP 模式端口 |
| `RAG_TENANT_ID` | `default` | 单租户时的默认租户（无令牌开放模式） |
| `RAG_TOKENS` | 空 | 多租户：`tenant:secret` 逗号分隔 |
| `RAG_API_TOKEN` | 空 | 单租户令牌（配对 `RAG_TENANT_ID`） |
| `RAG_EMBED_DIM` | `256` | 向量维度（切换 embedding 提供方需保持一致） |
| `RAG_DATA_FILE` | 空 | JSON 持久化文件路径 |
| `RAG_EMBEDDING_API_KEY` / `RAG_EMBEDDING_BASE_URL` / `RAG_EMBEDDING_MODEL` | 空 | 真实远程 embedding（缺省降级到 HashEmbedding） |
